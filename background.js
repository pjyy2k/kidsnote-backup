const JOB_KEY = "kidsnoteBackupJob";
const ALARM_NAME = "kidsnoteBackupNext";

let mutationQueue = Promise.resolve();
let processing = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    processNextPage().catch((error) => console.error("Backup page failed", error));
  }
});

async function handleMessage(message) {
  switch (message?.type) {
    case "GET_STATE":
      return { ok: true, job: await getJob() };
    case "DETECT_CHILD":
    case "DETECT_CONTEXT":
      return detectContext(message.tabId);
    case "START":
      return startJob(message.payload);
    case "PAUSE":
      return pauseJob();
    case "RESUME":
      return resumeJob();
    case "CANCEL":
      return cancelJob();
    default:
      throw new Error("Unknown request.");
  }
}

async function detectContext(tabId) {
  const response = await chrome.tabs.sendMessage(tabId, { type: "KIDSNOTE_DETECT_CONTEXT" });
  if (!response?.ok) throw new Error(response?.error || "KidsNote 정보를 자동 감지하지 못했습니다.");
  return {
    ok: true,
    childId: response.childId || null,
    centerId: response.centerId || null,
    classId: response.classId || null
  };
}

async function startJob(payload) {
  validatePayload(payload);
  await chrome.alarms.clear(ALARM_NAME);

  const type = payload.type === "album" ? "album" : "report";
  let albumContext = null;

  if (type === "album") {
    const response = await chrome.tabs.sendMessage(payload.tabId, {
      type: "KIDSNOTE_RESOLVE_ALBUM_CONTEXT",
      childId: String(payload.childId)
    });
    if (!response?.ok) {
      throw new Error(response?.error || "앨범 조회에 필요한 원/반 정보를 찾지 못했습니다.");
    }
    albumContext = response;
  }

  const now = new Date().toISOString();
  const job = {
    jobId: makeToken(),
    runToken: makeToken(),
    type,
    status: "running",
    tabId: payload.tabId,
    childId: String(payload.childId),
    childName: albumContext?.childName || null,
    centerId: albumContext?.centerId || null,
    classId: albumContext?.classId || null,
    startDate: payload.startDate,
    endDate: payload.endDate,
    cursor: null,
    currentDate: null,
    processedItemIds: [],
    photoSequenceByDate: {},
    dailyReportRows: [],
    counts: { pages: 0, reports: 0, albums: 0, images: 0, metadata: 0, failed: 0 },
    options: {
      photos: type === "album" ? true : payload.options?.photos !== false,
      json: type === "report" && payload.options?.json !== false,
      markdown: type === "report" && payload.options?.markdown !== false,
      photoFolderMode: payload.options?.photoFolderMode === "flat" ? "flat" : "date"
    },
    startedAt: now,
    updatedAt: now,
    error: null
  };

  await replaceJob(job);
  scheduleNext(100);
  return { ok: true, job };
}

async function pauseJob() {
  await chrome.alarms.clear(ALARM_NAME);
  const job = await mutateJob((current) => {
    if (!current) return current;
    if (["completed", "cancelled"].includes(current.status)) return current;

    current.status = "paused";
    current.runToken = makeToken();
    current.updatedAt = new Date().toISOString();
    return current;
  });
  return { ok: true, job };
}

async function resumeJob() {
  const job = await mutateJob((current) => {
    if (!current) throw new Error("저장된 백업 작업이 없습니다.");
    if (["completed", "cancelled"].includes(current.status)) {
      throw new Error("이미 종료된 작업입니다. 새 백업을 시작하세요.");
    }

    current.jobId = current.jobId || makeToken();
    current.runToken = makeToken();
    current.type = current.type === "album" ? "album" : "report";
    current.processedItemIds = current.processedItemIds || current.processedReportIds || [];
    current.photoSequenceByDate = current.photoSequenceByDate || {};
    current.dailyReportRows = current.dailyReportRows || [];
    current.counts = normalizeCounts(current.counts);
    current.status = "running";
    current.error = null;
    current.updatedAt = new Date().toISOString();
    return current;
  });

  await chrome.alarms.clear(ALARM_NAME);
  scheduleNext(100);
  return { ok: true, job };
}

async function cancelJob() {
  await chrome.alarms.clear(ALARM_NAME);
  const job = await mutateJob((current) => {
    if (!current) return current;
    if (current.status === "completed") return current;

    current.status = "cancelled";
    current.runToken = makeToken();
    current.currentDate = null;
    current.updatedAt = new Date().toISOString();
    return current;
  });
  return { ok: true, job };
}

async function processNextPage() {
  if (processing) return;
  processing = true;

  let jobId = null;
  let runToken = null;

  try {
    const snapshot = await ensureRunningJobIdentity();
    if (!snapshot || snapshot.status !== "running") return;

    jobId = snapshot.jobId;
    runToken = snapshot.runToken;

    const response = snapshot.type === "album"
      ? await chrome.tabs.sendMessage(snapshot.tabId, {
          type: "KIDSNOTE_FETCH_ALBUM_PAGE",
          childId: snapshot.childId,
          centerId: snapshot.centerId,
          classId: snapshot.classId,
          page: snapshot.cursor
        })
      : await chrome.tabs.sendMessage(snapshot.tabId, {
          type: "KIDSNOTE_FETCH_PAGE",
          childId: snapshot.childId,
          page: snapshot.cursor
        });

    if (!(await isRunActive(jobId, runToken))) return;
    if (!response?.ok) throw new Error(response?.error || "목록 API 호출에 실패했습니다.");

    const page = response.data || {};
    let reachedStart = false;

    for (const item of page.results || []) {
      if (!(await isRunActive(jobId, runToken))) return;

      const current = await getJob();
      if (!matchesActiveRun(current, jobId, runToken)) return;

      const date = current.type === "album" ? albumDate(item) : String(item.date_written || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (date > current.endDate) continue;
      if (date < current.startDate) {
        reachedStart = true;
        break;
      }

      const itemId = String(item.id ?? "");
      if (!itemId || (current.processedItemIds || []).includes(itemId)) continue;

      await setCurrentDate(jobId, runToken, date);
      const result = current.type === "album"
        ? await backupAlbum(item, date, current, jobId, runToken)
        : await backupReport(item, current, jobId, runToken);

      if (!result.completed) return;

      const committed = await commitItemProgress(jobId, runToken, item, date, result);
      if (!committed) return;
    }

    if (!(await isRunActive(jobId, runToken))) return;

    if (reachedStart || !page.next) {
      const beforeFinish = await getJob();
      if (!matchesActiveRun(beforeFinish, jobId, runToken)) return;

      let reportSaved = null;
      if (beforeFinish.type === "report") {
        reportSaved = await saveDailyHtmlReport(beforeFinish);
        if (!(await isRunActive(jobId, runToken))) return;
      }

      await mutateJob((current) => {
        if (!matchesActiveRun(current, jobId, runToken)) return current;
        current.counts = normalizeCounts(current.counts);
        current.counts.pages += 1;
        if (reportSaved === true) current.counts.metadata += 1;
        if (reportSaved === false) current.counts.failed += 1;
        current.status = "completed";
        current.cursor = null;
        current.currentDate = null;
        current.updatedAt = new Date().toISOString();
        return current;
      });

      await chrome.alarms.clear(ALARM_NAME);
      return;
    }

    const updated = await mutateJob((current) => {
      if (!matchesActiveRun(current, jobId, runToken)) return current;
      current.counts = normalizeCounts(current.counts);
      current.counts.pages += 1;
      current.cursor = page.next;
      current.currentDate = null;
      current.updatedAt = new Date().toISOString();
      return current;
    });

    if (matchesActiveRun(updated, jobId, runToken)) scheduleNext(700);
  } catch (error) {
    if (jobId && runToken && (await isRunActive(jobId, runToken))) {
      await failJob(error, jobId, runToken);
    }
  } finally {
    processing = false;
    await ensureRunningJobHasAlarm();
  }
}

async function backupReport(report, job, jobId, runToken) {
  const child = sanitize(report.child_name || job.childName || `child-${job.childId}`);
  const date = String(report.date_written || "");
  const root = `KidsNote/${child}`;
  const countsDelta = { images: 0, metadata: 0, failed: 0 };
  let sequence = Number(job.photoSequenceByDate?.[date] || 0);

  if (job.options.photos) {
    const result = await downloadImages({
      images: report.attached_images,
      date,
      root: `${root}/Photos`,
      folderMode: job.options.photoFolderMode,
      sequence,
      jobId,
      runToken
    });
    if (!result.completed) return { completed: false };
    sequence = result.sequence;
    countsDelta.images += result.images;
    countsDelta.failed += result.failed;
  }

  if (!(await isRunActive(jobId, runToken))) return { completed: false };

  const metadata = makeReportMetadata(report);

  if (job.options.markdown) {
    const ok = await saveMetadataFile(`${root}/Diary/${date}.md`, makeMarkdown(metadata), "text/markdown");
    if (ok) countsDelta.metadata += 1;
    else countsDelta.failed += 1;
  }

  if (!(await isRunActive(jobId, runToken))) return { completed: false };

  if (job.options.json) {
    const ok = await saveMetadataFile(`${root}/JSON/${date}.json`, JSON.stringify(metadata, null, 2), "application/json");
    if (ok) countsDelta.metadata += 1;
    else countsDelta.failed += 1;
  }

  return {
    completed: await isRunActive(jobId, runToken),
    sequence,
    countsDelta,
    childName: report.child_name || job.childName || null
  };
}

async function backupAlbum(album, date, job, jobId, runToken) {
  const child = sanitize(job.childName || `child-${job.childId}`);
  const root = `KidsNote/${child}/Album/Photos`;
  const countsDelta = { images: 0, metadata: 0, failed: 0 };
  let sequence = Number(job.photoSequenceByDate?.[date] || 0);

  const result = await downloadImages({
    images: album.attached_images,
    date,
    root,
    folderMode: job.options.photoFolderMode,
    sequence,
    jobId,
    runToken
  });

  if (!result.completed) return { completed: false };
  sequence = result.sequence;
  countsDelta.images += result.images;
  countsDelta.failed += result.failed;

  return {
    completed: await isRunActive(jobId, runToken),
    sequence,
    countsDelta,
    childName: job.childName || null
  };
}

async function downloadImages({ images, date, root, folderMode, sequence, jobId, runToken }) {
  const list = Array.isArray(images) ? images : [];
  let imagesSaved = 0;
  let failed = 0;
  let nextSequence = Number(sequence || 0);

  for (const image of list) {
    if (!(await isRunActive(jobId, runToken))) {
      return { completed: false, sequence: nextSequence, images: imagesSaved, failed };
    }
    if (!image?.original) continue;

    nextSequence += 1;
    const ext = extensionOf(image.original_file_name || image.original) || "jpg";
    const serial = String(nextSequence).padStart(3, "0");
    const photoRoot = folderMode === "flat" ? root : `${root}/${date}`;

    try {
      await chrome.downloads.download({
        url: image.original,
        filename: `${photoRoot}/${date}-${serial}.${ext}`,
        conflictAction: "overwrite",
        saveAs: false
      });
      imagesSaved += 1;
    } catch (error) {
      console.warn("Image download failed", error);
      failed += 1;
    }
  }

  return { completed: true, sequence: nextSequence, images: imagesSaved, failed };
}

async function saveMetadataFile(filename, text, type) {
  try {
    const url = `data:${type};charset=utf-8,${encodeURIComponent(text)}`;
    await chrome.downloads.download({
      url,
      filename,
      conflictAction: "overwrite",
      saveAs: false
    });
    return true;
  } catch (error) {
    console.warn("Metadata download failed", error);
    return false;
  }
}

async function saveDailyHtmlReport(job) {
  try {
    const rows = Array.isArray(job.dailyReportRows) ? job.dailyReportRows : [];
    const child = sanitize(rows.find((row) => row.child_name)?.child_name || job.childName || `child-${job.childId}`);
    const html = makeDailyHtmlReport(rows, job);
    return saveMetadataFile(`KidsNote/${child}/Reports/daily-report.html`, html, "text/html");
  } catch (error) {
    console.warn("HTML report generation failed", error);
    return false;
  }
}

async function setCurrentDate(jobId, runToken, date) {
  await mutateJob((current) => {
    if (!matchesActiveRun(current, jobId, runToken)) return current;
    current.currentDate = date;
    current.updatedAt = new Date().toISOString();
    return current;
  });
}

async function commitItemProgress(jobId, runToken, item, date, result) {
  let committed = false;

  await mutateJob((current) => {
    if (!matchesActiveRun(current, jobId, runToken)) return current;

    const itemId = String(item.id);
    const processed = new Set(current.processedItemIds || []);
    if (!processed.has(itemId)) {
      processed.add(itemId);
      current.processedItemIds = [...processed];
      current.counts = normalizeCounts(current.counts);
      if (current.type === "album") current.counts.albums += 1;
      else current.counts.reports += 1;
      current.counts.images += result.countsDelta.images;
      current.counts.metadata += result.countsDelta.metadata;
      current.counts.failed += result.countsDelta.failed;
      current.photoSequenceByDate = current.photoSequenceByDate || {};
      current.photoSequenceByDate[date] = result.sequence;
      if (result.childName && !current.childName) current.childName = result.childName;

      if (current.type === "report") {
        current.dailyReportRows = current.dailyReportRows || [];
        current.dailyReportRows.push(makeDailyReportRow(item));
      }
    }

    current.updatedAt = new Date().toISOString();
    committed = true;
    return current;
  });

  return committed;
}

function makeReportMetadata(report) {
  return {
    id: report.id,
    created: report.created ?? null,
    modified: report.modified ?? null,
    date_written: report.date_written ?? null,
    child: report.child ?? null,
    child_name: report.child_name ?? null,
    center: report.center ?? null,
    cls: report.cls ?? null,
    class_name: report.class_name ?? null,
    author_name: report.author_name ?? null,
    author: report.author ?? null,
    content: report.content ?? "",
    weather: report.weather ?? null,
    mood_status: report.mood_status ?? null,
    health_status: report.health_status ?? null,
    temperature_status: report.temperature_status ?? null,
    bath_status: report.bath_status ?? null,
    meal_status: report.meal_status ?? null,
    sleep_hour: report.sleep_hour ?? null,
    bowel_status: report.bowel_status ?? null,
    nail_status: report.nail_status ?? null,
    outdoor_activity_status: report.outdoor_activity_status ?? null,
    food: report.food ?? [],
    nursing: report.nursing ?? [],
    sleep: report.sleep ?? [],
    bowel: report.bowel ?? [],
    temperature: report.temperature ?? null,
    num_comments: report.num_comments ?? null,
    reaction_count: report.reaction_count ?? null,
    activity_rate: report.activity_rate ?? null,
    attached_video: report.attached_video ?? null,
    attached_files: report.attached_files ?? [],
    attached_images: (report.attached_images || []).map((image, index) => ({
      index: index + 1,
      id: image.id ?? null,
      original_file_name: image.original_file_name ?? null,
      file_size: image.file_size ?? null,
      width: image.width ?? null,
      height: image.height ?? null,
      original: image.original ?? null,
      large: image.large ?? null,
      small: image.small ?? null
    }))
  };
}

function makeDailyReportRow(report) {
  return {
    id: report.id ?? null,
    date: report.date_written ?? null,
    child_name: report.child_name ?? null,
    class_name: report.class_name ?? null,
    author_name: report.author_name ?? null,
    weather: report.weather ?? null,
    mood_status: report.mood_status ?? null,
    health_status: report.health_status ?? null,
    temperature_status: report.temperature_status ?? null,
    temperature: report.temperature ?? null,
    meal_status: report.meal_status ?? null,
    sleep_hour: report.sleep_hour ?? null,
    bowel_status: report.bowel_status ?? null,
    num_comments: report.num_comments ?? 0,
    reaction_count: report.reaction_count ?? 0,
    activity_rate: report.activity_rate ?? null
  };
}

function makeMarkdown(meta) {
  const lines = [
    `# ${meta.child_name || "KidsNote"} 알림장`,
    "",
    `- 날짜: ${meta.date_written || "-"}`,
    `- 반: ${meta.class_name || "-"}`,
    `- 작성자: ${meta.author_name || "-"}`,
    `- 날씨: ${meta.weather || "-"}`,
    `- 사진: ${meta.attached_images.length}장`,
    "",
    "## 내용",
    "",
    meta.content || "",
    "",
    "## 첨부 사진",
    ""
  ];

  for (const image of meta.attached_images) {
    lines.push(`- ${String(image.index).padStart(3, "0")}: ${image.original || "-"}`);
  }

  return `${lines.join("\n")}\n`;
}

function makeDailyHtmlReport(inputRows, job) {
  const rows = [...inputRows].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const childName = rows.find((row) => row.child_name)?.child_name || job.childName || "KidsNote";
  const generatedAt = new Date().toLocaleString("ko-KR");
  const uniqueDates = new Set(rows.map((row) => row.date).filter(Boolean)).size;
  const tableRows = rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.date || "-")}</td>
      <td>${escapeHtml(displayValue("weather", row.weather))}</td>
      <td>${escapeHtml(displayValue("mood_status", row.mood_status))}</td>
      <td>${escapeHtml(displayValue("health_status", row.health_status))}</td>
      <td>${escapeHtml(formatTemperature(row.temperature))}</td>
      <td>${escapeHtml(displayValue("meal_status", row.meal_status))}</td>
      <td>${escapeHtml(displayValue("sleep_hour", row.sleep_hour))}</td>
      <td>${escapeHtml(displayValue("bowel_status", row.bowel_status))}</td>
      <td>${Number(row.num_comments || 0)}</td>
      <td>${Number(row.reaction_count || 0)}</td>
      <td>${escapeHtml(formatActivityRate(row.activity_rate))}</td>
      <td>${escapeHtml(row.class_name || "-")}</td>
      <td>${escapeHtml(row.author_name || "-")}</td>
    </tr>`).join("");

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(childName)} - KidsNote 일별 데이터 리포트</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f9;color:#17202a;margin:0;padding:24px}main{max-width:1400px;margin:auto}.card{background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:16px;margin-bottom:14px}.summary{display:flex;gap:12px;flex-wrap:wrap}.summary div{background:#f8fafc;border-radius:8px;padding:10px 14px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:8px;border-bottom:1px solid #eaecf0;text-align:left;white-space:nowrap}th{background:#f9fafb}.wrap{overflow:auto}.muted{color:#667085;font-size:12px}</style></head>
<body><main><div class="card"><h1>${escapeHtml(childName)} · 일별 데이터 리포트</h1><div class="muted">생성: ${escapeHtml(generatedAt)}</div><div class="summary"><div>기간<br><b>${escapeHtml(job.startDate)} ~ ${escapeHtml(job.endDate)}</b></div><div>기록 일수<br><b>${uniqueDates}</b></div><div>알림장 건수<br><b>${rows.length}</b></div></div></div>
<div class="card wrap"><table><thead><tr><th>날짜</th><th>날씨</th><th>기분</th><th>건강</th><th>체온</th><th>식사</th><th>수면</th><th>배변</th><th>댓글</th><th>반응</th><th>활동률</th><th>반</th><th>작성자</th></tr></thead><tbody>${tableRows || '<tr><td colspan="13">데이터 없음</td></tr>'}</tbody></table></div>
</main></body></html>`;
}

function displayValue(field, value) {
  if (value === null || value === undefined || value === "") return "-";
  const key = String(value);
  const maps = {
    weather: { sunny: "맑음", mostly_cloudy: "구름 많음", cloudy: "흐림", overcast: "흐림", rain: "비", rainy: "비", snow: "눈" },
    mood_status: { good: "좋음", normal: "보통", bad: "나쁨" },
    health_status: { good: "좋음", normal: "보통", bad: "나쁨" },
    meal_status: { fixed: "정량", more: "많이", less: "적게", none: "안 먹음" },
    sleep_hour: { none: "안 잠", below_1: "1시간 미만", between_1_2: "1~2시간", above_2: "2시간 이상" },
    bowel_status: { none: "안 함", normal: "보통", hard: "딱딱함", loose: "묽음" }
  };
  return maps[field]?.[key] || key;
}

function formatTemperature(value) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") return `${value}℃`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatActivityRate(value) {
  if (value === null || value === undefined || value === "") return "-";
  const n = Number(value);
  if (Number.isFinite(n)) return n <= 1 ? `${Math.round(n * 100)}%` : `${n}%`;
  return String(value);
}

function albumDate(album) {
  const value = album?.created;
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function validatePayload(payload) {
  if (!payload || !Number.isInteger(payload.tabId)) throw new Error("KidsNote 탭을 먼저 열어주세요.");
  if (!["report", "album"].includes(payload.type || "report")) throw new Error("백업 종류를 확인하세요.");
  if (!/^\d+$/.test(String(payload.childId || ""))) throw new Error("숫자로 된 Child ID를 입력하세요.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.startDate || "")) throw new Error("시작일을 확인하세요.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.endDate || "")) throw new Error("종료일을 확인하세요.");
  if (payload.startDate > payload.endDate) throw new Error("시작일은 종료일보다 늦을 수 없습니다.");
  if (payload.options?.photoFolderMode && !["date", "flat"].includes(payload.options.photoFolderMode)) {
    throw new Error("사진 저장 방식을 확인하세요.");
  }
}

function normalizeCounts(counts = {}) {
  return {
    pages: Number(counts.pages || 0),
    reports: Number(counts.reports || 0),
    albums: Number(counts.albums || 0),
    images: Number(counts.images || 0),
    metadata: Number(counts.metadata || 0),
    failed: Number(counts.failed || 0)
  };
}

function sanitize(value) {
  return String(value)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 100) || "unknown";
}

function extensionOf(value) {
  const match = String(value).match(/\.([a-zA-Z0-9]{1,8})(?:$|[?#])/);
  return match ? match[1].toLowerCase() : null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function makeToken() {
  return crypto.randomUUID();
}

function matchesActiveRun(job, jobId, runToken) {
  return Boolean(job && job.status === "running" && job.jobId === jobId && job.runToken === runToken);
}

function scheduleNext(delay) {
  chrome.alarms.create(ALARM_NAME, { when: Date.now() + delay });
}

async function ensureRunningJobHasAlarm() {
  const job = await getJob();
  if (!job || job.status !== "running") return;

  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) scheduleNext(150);
}

async function failJob(error, jobId, runToken) {
  let changed = false;

  await mutateJob((current) => {
    if (!matchesActiveRun(current, jobId, runToken)) return current;
    current.status = "error";
    current.error = error?.message || String(error);
    current.updatedAt = new Date().toISOString();
    changed = true;
    return current;
  });

  if (changed) await chrome.alarms.clear(ALARM_NAME);
}

async function isRunActive(jobId, runToken) {
  const job = await getJob();
  return matchesActiveRun(job, jobId, runToken);
}

async function ensureRunningJobIdentity() {
  return mutateJob((current) => {
    if (!current || current.status !== "running") return current;
    current.jobId = current.jobId || makeToken();
    current.runToken = current.runToken || makeToken();
    current.type = current.type === "album" ? "album" : "report";
    current.processedItemIds = current.processedItemIds || current.processedReportIds || [];
    current.photoSequenceByDate = current.photoSequenceByDate || {};
    current.dailyReportRows = current.dailyReportRows || [];
    current.counts = normalizeCounts(current.counts);
    return current;
  });
}

async function getJobRaw() {
  return (await chrome.storage.local.get(JOB_KEY))[JOB_KEY] || null;
}

async function getJob() {
  await mutationQueue.catch(() => {});
  return getJobRaw();
}

async function replaceJob(job) {
  return mutateJob(() => job);
}

function mutateJob(mutator) {
  const task = mutationQueue.then(async () => {
    const current = await getJobRaw();
    const next = await mutator(current);
    if (next === undefined) return current;
    await chrome.storage.local.set({ [JOB_KEY]: next });
    return next;
  });

  mutationQueue = task.catch(() => {});
  return task;
}
