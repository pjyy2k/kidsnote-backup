const JOB_KEY = "kidsnoteBackupJob";
const ALARM_NAME = "kidsnoteBackupNext";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) processNextPage().catch(failJob);
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

  const job = {
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
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: null
  };

  await saveJob(job);
  scheduleNext(100);
  return { ok: true, job };
}

async function pauseJob() {
  const job = await getJob();
  await chrome.alarms.clear(ALARM_NAME);
  if (!job) return { ok: true, job: null };
  job.status = "paused";
  job.updatedAt = new Date().toISOString();
  await saveJob(job);
  return { ok: true, job };
}

async function resumeJob() {
  const job = await getJob();
  if (!job) throw new Error("저장된 백업 작업이 없습니다.");
  if (["completed", "cancelled"].includes(job.status)) {
    throw new Error("이미 종료된 작업입니다. 새 백업을 시작하세요.");
  }
  job.status = "running";
  job.error = null;
  job.updatedAt = new Date().toISOString();
  await saveJob(job);
  scheduleNext(100);
  return { ok: true, job };
}

async function cancelJob() {
  const job = await getJob();
  await chrome.alarms.clear(ALARM_NAME);
  if (!job) return { ok: true, job: null };
  job.status = "cancelled";
  job.updatedAt = new Date().toISOString();
  await saveJob(job);
  return { ok: true, job };
}

async function processNextPage() {
  const job = await getJob();
  if (!job || job.status !== "running") return;

  try {
    const response = await chrome.tabs.sendMessage(job.tabId, {
      type: "KIDSNOTE_FETCH_PAGE",
      childId: job.childId,
      page: job.cursor
    });

    if (!response?.ok) throw new Error(response?.error || "목록 API 호출에 실패했습니다.");

    const page = response.data;
    const processed = new Set(job.processedReportIds || []);
    let reachedStart = false;

    for (const report of page.results || []) {
      const latest = await getJob();
      if (!latest || latest.status !== "running") return;

      const date = String(report.date_written || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (date > job.endDate) continue;
      if (date < job.startDate) {
        reachedStart = true;
        break;
      }
      if (processed.has(String(report.id))) continue;

      job.currentDate = date;
      await backupReport(report, job);
      processed.add(String(report.id));
      job.processedReportIds = [...processed];
      job.counts.reports += 1;
      job.updatedAt = new Date().toISOString();
      await saveJob(job);
    }

    job.counts.pages += 1;
    job.updatedAt = new Date().toISOString();

    if (reachedStart || !page.next) {
      job.status = "completed";
      job.cursor = null;
      job.currentDate = null;
      await saveJob(job);
      return;
    }

    job.cursor = page.next;
    await saveJob(job);
    scheduleNext(700);
  } catch (error) {
    await failJob(error);
  }
}

async function backupReport(report, job) {
  const child = sanitize(report.child_name || `child-${job.childId}`);
  const date = report.date_written;
  const root = `KidsNote/${child}`;

  if (job.options.photos) {
    const images = Array.isArray(report.attached_images) ? report.attached_images : [];
    let sequence = Number(job.photoSequenceByDate?.[date] || 0);

    for (const image of images) {
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
        job.counts.images += 1;
      } catch (error) {
        console.warn("Image download failed", error);
        job.counts.failed += 1;
      }
    }

    job.photoSequenceByDate = job.photoSequenceByDate || {};
    job.photoSequenceByDate[date] = sequence;
  }

  const metadata = makeMetadata(report);
  if (job.options.markdown) {
    await saveMetadata(job, `${root}/Diary/${date}.md`, makeMarkdown(metadata), "text/markdown");
  }
  if (job.options.json) {
    await saveMetadata(job, `${root}/JSON/${date}.json`, JSON.stringify(metadata, null, 2), "application/json");
  }
}

async function saveMetadata(job, filename, text, type) {
  try {
    const url = `data:${type};charset=utf-8,${encodeURIComponent(text)}`;
    await chrome.downloads.download({ url, filename, conflictAction: "overwrite", saveAs: false });
    job.counts.metadata += 1;
  } catch (error) {
    console.warn("Metadata download failed", error);
    job.counts.failed += 1;
  }
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
  return String(value).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, 100) || "unknown";
}

function extensionOf(value) {
  const match = String(value).match(/\.([a-zA-Z0-9]{1,8})(?:$|[?#])/);
  return match ? match[1].toLowerCase() : null;
}

function scheduleNext(delay) {
  chrome.alarms.create(ALARM_NAME, { when: Date.now() + delay });
}

async function failJob(error) {
  const job = await getJob();
  if (!job) return;
  job.status = "error";
  job.error = error?.message || String(error);
  job.updatedAt = new Date().toISOString();
  await chrome.alarms.clear(ALARM_NAME);
  await saveJob(job);
}

async function getJob() {
  return (await chrome.storage.local.get(JOB_KEY))[JOB_KEY] || null;
}

async function saveJob(job) {
  await chrome.storage.local.set({ [JOB_KEY]: job });
}
