const el = (id) => document.getElementById(id);
const statusNames = { running: "진행 중", paused: "일시정지", completed: "완료", error: "오류", cancelled: "취소됨" };
const LATEST_MANIFEST_URL = "https://raw.githubusercontent.com/pjyy2k/kidsnote-backup/main/manifest.json";
const REPOSITORY_URL = "https://github.com/pjyy2k/kidsnote-backup";
let activeTab = null;

init().catch(showError);
setInterval(refreshState, 1000);

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  setDefaultDates();
  bindEvents();
  updateFolderExample();
  showInstalledVersion();
  checkLatestVersion().catch((error) => console.debug("Version check failed", error));
  await refreshState();
  if (activeTab?.url?.startsWith("https://www.kidsnote.com/")) {
    detectChild({ quiet: true }).catch(() => {});
  }
}

function bindEvents() {
  el("openReportBtn").addEventListener("click", () => openKidsNoteReport().catch(showError));
  el("detectBtn").addEventListener("click", () => detectChild().catch(showError));
  el("startReportBtn").addEventListener("click", () => startBackup("report").catch(showError));
  el("startAlbumBtn").addEventListener("click", () => startBackup("album").catch(showError));
  el("pauseBtn").addEventListener("click", () => send("PAUSE").then(refreshState).catch(showError));
  el("resumeBtn").addEventListener("click", () => send("RESUME").then(refreshState).catch(showError));
  el("cancelBtn").addEventListener("click", () => send("CANCEL").then(refreshState).catch(showError));
  el("photoModeDate").addEventListener("change", updateFolderExample);
  el("photoModeFlat").addEventListener("change", updateFolderExample);
  el("updateBtn").addEventListener("click", () => openRepository().catch(showError));
}

function showInstalledVersion() {
  const version = chrome.runtime.getManifest().version;
  el("versionText").textContent = `v${version}`;
}

async function checkLatestVersion() {
  const currentVersion = chrome.runtime.getManifest().version;
  const response = await fetch(`${LATEST_MANIFEST_URL}?t=${Date.now()}`, {
    method: "GET",
    cache: "no-store",
    headers: { Accept: "application/json" }
  });

  if (!response.ok) throw new Error(`GitHub version check failed (${response.status})`);

  const manifest = await response.json();
  const latestVersion = String(manifest?.version || "").trim();
  if (!latestVersion) throw new Error("Latest manifest version is missing.");

  if (compareVersions(latestVersion, currentVersion) > 0) {
    el("latestVersion").textContent = `v${latestVersion}`;
    el("currentVersion").textContent = `v${currentVersion}`;
    el("updateNotice").hidden = false;
  } else {
    el("updateNotice").hidden = true;
  }
}

function compareVersions(a, b) {
  const left = String(a).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function openRepository() {
  await chrome.tabs.create({ url: REPOSITORY_URL, active: true });
  window.close();
}

async function openKidsNoteReport() {
  clearError();
  const url = "https://www.kidsnote.com/service/report";

  if (activeTab?.id && activeTab.url?.startsWith("https://www.kidsnote.com/")) {
    activeTab = await chrome.tabs.update(activeTab.id, { url, active: true });
  } else {
    activeTab = await chrome.tabs.create({ url, active: true });
  }

  window.close();
}

function setDefaultDates() {
  const today = new Date();
  const yearAgo = new Date(today);
  yearAgo.setFullYear(today.getFullYear() - 1);
  el("endDate").value = localDate(today);
  el("startDate").value = localDate(yearAgo);
}

async function ensureMemoryMode() {
  ensureKidsNoteTab();

  let response;
  try {
    response = await chrome.tabs.sendMessage(activeTab.id, { type: "KIDSNOTE_ENSURE_MEMORY_MODE" });
  } catch (error) {
    throw new Error("KidsNote 페이지와 연결할 수 없습니다. 페이지를 새로고침한 뒤 다시 시도하세요.");
  }

  if (!response?.ok) {
    throw new Error(response?.error || "추억보기 상태 확인에 실패했습니다.");
  }

  return response;
}

async function detectChild({ quiet = false } = {}) {
  ensureKidsNoteTab();
  if (!quiet) clearError();

  let response = await send("DETECT_CONTEXT", { tabId: activeTab.id });
  if (response?.ok && response.childId) {
    el("childId").value = response.childId;
    return response;
  }

  try {
    await ensureMemoryMode();
    response = await send("DETECT_CONTEXT", { tabId: activeTab.id });
  } catch (error) {
    if (!quiet) throw error;
  }

  if (!response?.ok || !response.childId) {
    if (quiet) return null;
    throw new Error("Child ID를 찾지 못했습니다. 알림장 목록을 연 뒤 다시 시도하거나 직접 입력하세요.");
  }

  el("childId").value = response.childId;
  return response;
}

async function startBackup(type) {
  ensureKidsNoteTab();
  clearError();

  if (!el("childId").value.trim()) {
    await detectChild();
  }

  if (type === "report") {
    await ensureMemoryMode();
  }

  const payload = {
    type,
    tabId: activeTab.id,
    childId: el("childId").value.trim(),
    startDate: el("startDate").value,
    endDate: el("endDate").value,
    options: {
      photos: type === "album" ? true : el("photos").checked,
      json: type === "report" ? el("json").checked : false,
      markdown: type === "report" ? el("markdown").checked : false,
      photoFolderMode: selectedPhotoFolderMode()
    }
  };

  const response = await send("START", { payload });
  if (!response.ok) throw new Error(response.error || "백업 시작 실패");
  render(response.job);
}

function selectedPhotoFolderMode() {
  return document.querySelector('input[name="photoFolderMode"]:checked')?.value || "date";
}

function updateFolderExample() {
  if (selectedPhotoFolderMode() === "flat") {
    el("folderExample").textContent = "알림장: Photos/2026-10-21-001.jpg\n앨범: Album/Photos/2026-10-21-001.jpg";
  } else {
    el("folderExample").textContent = "알림장: Photos/2026-10-21/2026-10-21-001.jpg\n앨범: Album/Photos/2026-10-21/2026-10-21-001.jpg";
  }
}

async function refreshState() {
  try {
    const response = await send("GET_STATE");
    if (response.ok) render(response.job);
  } catch (error) {
    console.debug(error);
  }
}

function render(job) {
  const counts = job?.counts || {};
  const type = job?.type || null;
  el("jobType").textContent = type === "album" ? "앨범" : type === "report" ? "알림장" : "-";
  el("status").textContent = job ? (statusNames[job.status] || job.status) : "대기";
  el("currentDate").textContent = job?.currentDate || "-";
  el("pages").textContent = counts.pages || 0;
  el("itemsLabel").textContent = type === "album" ? "앨범" : "알림장";
  el("items").textContent = type === "album" ? (counts.albums || 0) : (counts.reports || 0);
  el("images").textContent = counts.images || 0;
  el("failed").textContent = counts.failed || 0;

  if (job?.error) showError(job.error); else clearError();

  const running = job?.status === "running";
  el("startReportBtn").disabled = running;
  el("startAlbumBtn").disabled = running;
  el("pauseBtn").disabled = !running;
  el("resumeBtn").disabled = !job || !["paused", "error"].includes(job.status);
  el("cancelBtn").disabled = !job || ["completed", "cancelled"].includes(job.status);
}

function ensureKidsNoteTab() {
  if (!activeTab?.id || !activeTab.url?.startsWith("https://www.kidsnote.com/")) {
    throw new Error("1단계에서 KidsNote 화면을 먼저 열어주세요.");
  }
}

function showError(error) {
  el("error").hidden = false;
  el("error").textContent = error?.message || String(error);
}

function clearError() {
  el("error").hidden = true;
  el("error").textContent = "";
}

function localDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
}
