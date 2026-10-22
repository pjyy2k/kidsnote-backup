const el = (id) => document.getElementById(id);
const statusNames = { running: "진행 중", paused: "일시정지", completed: "완료", error: "오류", cancelled: "취소됨" };
let activeTab = null;

init().catch(showError);
setInterval(refreshState, 1000);

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  setDefaultDates();
  bindEvents();
  updateFolderExample();
  await refreshState();
  if (activeTab?.url?.startsWith("https://www.kidsnote.com/")) await detectChild();
}

function bindEvents() {
  el("openReportBtn").addEventListener("click", () => openKidsNoteReport().catch(showError));
  el("detectBtn").addEventListener("click", () => detectChild().catch(showError));
  el("startBtn").addEventListener("click", () => startBackup().catch(showError));
  el("pauseBtn").addEventListener("click", () => send("PAUSE").then(refreshState).catch(showError));
  el("resumeBtn").addEventListener("click", () => send("RESUME").then(refreshState).catch(showError));
  el("cancelBtn").addEventListener("click", () => send("CANCEL").then(refreshState).catch(showError));
  el("photoModeDate").addEventListener("change", updateFolderExample);
  el("photoModeFlat").addEventListener("change", updateFolderExample);
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

async function detectChild() {
  ensureKidsNoteTab();
  clearError();
  await ensureMemoryMode();

  const response = await send("DETECT_CHILD", { tabId: activeTab.id });
  if (!response.ok) throw new Error(response.error || "Child ID 자동 감지 실패");
  if (!response.childId) throw new Error("Child ID를 찾지 못했습니다. 알림장 목록을 연 뒤 다시 시도하거나 직접 입력하세요.");
  el("childId").value = response.childId;
}

async function startBackup() {
  ensureKidsNoteTab();
  clearError();
  await ensureMemoryMode();

  const payload = {
    tabId: activeTab.id,
    childId: el("childId").value.trim(),
    startDate: el("startDate").value,
    endDate: el("endDate").value,
    options: {
      photos: el("photos").checked,
      json: el("json").checked,
      markdown: el("markdown").checked,
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
    el("folderExample").textContent = "Photos/2026-10-21-001.jpg\nPhotos/2026-10-21-002.jpg";
  } else {
    el("folderExample").textContent = "Photos/2026-10-21/2026-10-21-001.jpg\nPhotos/2026-10-21/2026-10-21-002.jpg";
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
  el("status").textContent = job ? (statusNames[job.status] || job.status) : "대기";
  el("currentDate").textContent = job?.currentDate || "-";
  el("pages").textContent = counts.pages || 0;
  el("reports").textContent = counts.reports || 0;
  el("images").textContent = counts.images || 0;
  el("failed").textContent = counts.failed || 0;

  if (job?.error) showError(job.error); else clearError();

  el("pauseBtn").disabled = job?.status !== "running";
  el("resumeBtn").disabled = !job || !["paused", "error"].includes(job.status);
  el("cancelBtn").disabled = !job || ["completed", "cancelled"].includes(job.status);
}

function ensureKidsNoteTab() {
  if (!activeTab?.id || !activeTab.url?.startsWith("https://www.kidsnote.com/")) {
    throw new Error("1단계에서 KidsNote 알림장 화면을 먼저 열어주세요.");
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
