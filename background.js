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
      return detectChild(message.tabId);
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

async function detectChild(tabId) {
  const response = await chrome.tabs.sendMessage(tabId, { type: "KIDSNOTE_DETECT_CHILD" });
  return { ok: true, childId: response?.childId || null };
}

async function startJob(payload) {
  validatePayload(payload);
  await chrome.alarms.clear(ALARM_NAME);

  const now = new Date().toISOString();
  const job = {
    jobId: makeToken(),
    runToken: makeToken(),
    status: "running",
    tabId: payload.tabId,
    childId: String(payload.childId),
    startDate: payload.startDate,
    endDate: payload.endDate,
    cursor: null,
    currentDate: null,
    processedReportIds: [],
    photoSequenceByDate: {},
    counts: { pages: 0, reports: 0, images: 0, metadata: 0, failed: 0 },
    options: {
      photos: payload.options?.photos !== false,
      json: payload.options?.json !== false,
      markdown: payload.options?.markdown !== false,
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

    const response = await chrome.tabs.sendMessage(snapshot.tabId, {
      type: "KIDSNOTE_FETCH_PAGE",
      childId: snapshot.childId,
      page: snapshot.cursor
    });

    if (!(await isRunActive(jobId, runToken))) return;
    if (!response?.ok) throw new Error(response?.error || "목록 API 호출에 실패했습니다.");

    const page = response.data || {};
    let reachedStart = false;

    for (const report of page.results || []) {
      if (!(await isRunActive(jobId, runToken))) return;

      const current = await getJob();
      if (!current || current.jobId !== jobId || current.runToken !== runToken || current.status !== "running") return;

      const date = String(report.date_written || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (date > current.endDate) continue;
      if (date < current.startDate) {
        reachedStart = true;
        break;
      }
      if ((current.processedReportIds || []).includes(String(report.id))) continue;

      await setCurrentDate(jobId, runToken, date);
      const result = await backupReport(report, current, jobId, runToken);
      if (!result.completed) return;

      const committed = await commitReportProgress(jobId, runToken, report, result);
      if (!committed) return;
    }

    if (!(await isRunActive(jobId, runToken))) return;

    if (reachedStart || !page.next) {
      await mutateJob((current) => {
        if (!matchesActiveRun(current, jobId, runToken)) return current;
        current.counts.pages += 1;
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
  const child = sanitize(report.child_name || `child-${job.childId}`);
  const date = report.date_written;
  const root = `KidsNote/${child}`;
  const countsDelta = { images: 0, metadata: 0, failed: 0 };
  let sequence = Number(job.photoSequenceByDate?.[date] || 0);

  if (job.options.photos) {
    const images = Array.isArray(report.attached_images) ? report.attached_images : [];

    for (const image of images) {
      if (!(await isRunActive(jobId, runToken))) {
        return { completed: false };
      }
      if (!image?.original) continue;

      sequence += 1;
      const ext = extensionOf(image.original_file_name || image.original) || "jpg";
      const serial = String(sequence).padStart(3, "0");
      const photoRoot = job.options.photoFolderMode === "flat"
        ? `${root}/Photos`
        : `${root}/Photos/${date}`;

      try {
        await chrome.downloads.download({
          url: image.original,
          filename: `${photoRoot}/${date}-${serial}.${ext}`,
          conflictAction: "overwrite",
          saveAs: false
        });
        countsDelta.images += 1;
      } catch (error) {
        console.warn("Image download failed", error);
        countsDelta.failed += 1;
      }
    }
  }

  if (!(await isRunActive(jobId, runToken))) return { completed: false };

  const metadata = makeMetadata(report);

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
    countsDelta
  };
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

async function setCurrentDate(jobId, runToken, date) {
  await mutateJob((current) => {
    if (!matchesActiveRun(current, jobId, runToken)) return current;
    current.currentDate = date;
    current.updatedAt = new Date().toISOString();
    return current;
  });
}

async function commitReportProgress(jobId, runToken, report, result) {
  let committed = false;

  await mutateJob((current) => {
    if (!matchesActiveRun(current, jobId, runToken)) return current;

    const reportId = String(report.id);
    const processed = new Set(current.processedReportIds || []);
    if (!processed.has(reportId)) {
      processed.add(reportId);
      current.processedReportIds = [...processed];
      current.counts.reports += 1;
      current.counts.images += result.countsDelta.images;
      current.counts.metadata += result.countsDelta.metadata;
      current.counts.failed += result.countsDelta.failed;
      current.photoSequenceByDate = current.photoSequenceByDate || {};
      current.photoSequenceByDate[report.date_written] = result.sequence;
    }

    current.updatedAt = new Date().toISOString();
    committed = true;
    return current;
  });

  return committed;
}

function makeMetadata(report) {
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
    num_comments: report.num_comments ?? null,
    reaction_count: report.reaction_count ?? null,
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

function validatePayload(payload) {
  if (!payload || !Number.isInteger(payload.tabId)) throw new Error("KidsNote 탭을 먼저 열어주세요.");
  if (!/^\d+$/.test(String(payload.childId || ""))) throw new Error("숫자로 된 child ID를 입력하세요.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.startDate || "")) throw new Error("시작일을 확인하세요.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.endDate || "")) throw new Error("종료일을 확인하세요.");
  if (payload.startDate > payload.endDate) throw new Error("시작일은 종료일보다 늦을 수 없습니다.");
  if (payload.options?.photoFolderMode && !["date", "flat"].includes(payload.options.photoFolderMode)) {
    throw new Error("사진 저장 방식을 확인하세요.");
  }
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

function makeToken() {
  return crypto.randomUUID();
}

function matchesActiveRun(job, jobId, runToken) {
  return Boolean(
    job &&
    job.status === "running" &&
    job.jobId === jobId &&
    job.runToken === runToken
  );
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
