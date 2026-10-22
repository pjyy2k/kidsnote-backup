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
    dailyReportRows: [],
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
    current.dailyReportRows = current.dailyReportRows || [];
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
      const beforeReport = await getJob();
      if (!matchesActiveRun(beforeReport, jobId, runToken)) return;

      const htmlSaved = await saveDailyHtmlReport(beforeReport);
      if (!(await isRunActive(jobId, runToken))) return;

      await mutateJob((current) => {
        if (!matchesActiveRun(current, jobId, runToken)) return current;
        current.counts.pages += 1;
        if (htmlSaved) current.counts.metadata += 1;
        else current.counts.failed += 1;
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

async function saveDailyHtmlReport(job) {
  try {
    const rows = Array.isArray(job.dailyReportRows) ? job.dailyReportRows : [];
    const child = sanitize(rows.find((row) => row.child_name)?.child_name || `child-${job.childId}`);
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
      current.dailyReportRows = current.dailyReportRows || [];
      current.dailyReportRows.push(makeDailyReportRow(report));
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
    bath_status: report.bath_status ?? null,
    meal_status: report.meal_status ?? null,
    sleep_hour: report.sleep_hour ?? null,
    bowel_status: report.bowel_status ?? null,
    nail_status: report.nail_status ?? null,
    outdoor_activity_status: report.outdoor_activity_status ?? null,
    food: compactValue(report.food),
    nursing: compactValue(report.nursing),
    sleep: compactValue(report.sleep),
    bowel: compactValue(report.bowel),
    num_comments: report.num_comments ?? 0,
    reaction_count: report.reaction_count ?? 0,
    activity_rate: report.activity_rate ?? null,
    has_video: Boolean(report.attached_video || report.material_video),
    attached_file_count: Array.isArray(report.attached_files) ? report.attached_files.length : 0,
    is_sent_from_center: report.is_sent_from_center ?? null,
    read_by_me: report.read_by_me ?? null,
    read_date: report.read_by_parent?.date_read ?? null
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
  const childName = rows.find((row) => row.child_name)?.child_name || "KidsNote";
  const months = summarizeMonths(rows);
  const generatedAt = new Date().toLocaleString("ko-KR");
  const uniqueDates = new Set(rows.map((row) => row.date).filter(Boolean)).size;
  const classNames = [...new Set(rows.map((row) => row.class_name).filter(Boolean))].join(", ") || "-";

  const monthRows = months.map((m) => `
    <tr>
      <td>${escapeHtml(m.month)}</td>
      <td>${m.days}</td>
      <td>${escapeHtml(displayValue("weather", m.weather))}</td>
      <td>${escapeHtml(displayValue("mood_status", m.mood))}</td>
      <td>${escapeHtml(displayValue("health_status", m.health))}</td>
      <td>${escapeHtml(displayValue("meal_status", m.meal))}</td>
      <td>${escapeHtml(displayValue("sleep_hour", m.sleep))}</td>
      <td>${escapeHtml(displayValue("bowel_status", m.bowel))}</td>
    </tr>`).join("");

  const dailyRows = rows.map((row) => `
    <tr data-month="${escapeHtml(String(row.date || "").slice(0, 7))}">
      <td class="date">${escapeHtml(row.date || "-")}</td>
      <td>${escapeHtml(displayValue("weather", row.weather))}</td>
      <td>${escapeHtml(displayValue("mood_status", row.mood_status))}</td>
      <td>${escapeHtml(displayValue("health_status", row.health_status))}</td>
      <td>${escapeHtml(displayValue("temperature_status", row.temperature_status))}</td>
      <td>${escapeHtml(formatTemperature(row.temperature))}</td>
      <td>${escapeHtml(displayValue("meal_status", row.meal_status))}</td>
      <td>${escapeHtml(displayValue("sleep_hour", row.sleep_hour))}</td>
      <td>${escapeHtml(displayValue("bowel_status", row.bowel_status))}</td>
      <td>${escapeHtml(displayValue("bath_status", row.bath_status))}</td>
      <td>${escapeHtml(displayValue("nail_status", row.nail_status))}</td>
      <td>${escapeHtml(displayValue("outdoor_activity_status", row.outdoor_activity_status))}</td>
      <td>${escapeHtml(row.food || "-")}</td>
      <td>${escapeHtml(row.nursing || "-")}</td>
      <td>${escapeHtml(row.sleep || "-")}</td>
      <td>${escapeHtml(row.bowel || "-")}</td>
      <td>${Number(row.num_comments || 0)}</td>
      <td>${Number(row.reaction_count || 0)}</td>
      <td>${escapeHtml(formatActivityRate(row.activity_rate))}</td>
      <td>${row.has_video ? "있음" : "-"}</td>
      <td>${Number(row.attached_file_count || 0)}</td>
      <td>${escapeHtml(row.class_name || "-")}</td>
      <td>${escapeHtml(row.author_name || "-")}</td>
    </tr>`).join("");

  const monthOptions = months.map((m) => `<option value="${escapeHtml(m.month)}">${escapeHtml(m.month)}</option>`).join("");

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(childName)} - KidsNote 일별 데이터 리포트</title>
<style>
:root{font-family:Inter,Pretendard,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17202a;background:#f6f7f9}*{box-sizing:border-box}body{margin:0;padding:28px}main{max-width:1600px;margin:auto}.hero{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;margin-bottom:18px}.hero h1{font-size:28px;margin:0 0 6px}.muted{color:#667085;font-size:13px}.cards{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:12px;margin:18px 0}.card{background:white;border:1px solid #e4e7ec;border-radius:14px;padding:16px}.card span{display:block;color:#667085;font-size:12px}.card strong{display:block;font-size:22px;margin-top:5px}.panel{background:white;border:1px solid #e4e7ec;border-radius:14px;padding:18px;margin-top:14px}.panel h2{font-size:18px;margin:0 0 12px}.controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:12px}.controls input,.controls select{padding:9px 10px;border:1px solid #d0d5dd;border-radius:8px;background:white;font:inherit}.table-wrap{overflow:auto;border:1px solid #eaecf0;border-radius:10px}table{border-collapse:collapse;width:100%;min-width:900px;font-size:12px}th,td{padding:9px 10px;border-bottom:1px solid #eaecf0;text-align:left;white-space:nowrap}th{position:sticky;top:0;background:#f9fafb;color:#475467;z-index:1}tbody tr:hover{background:#fcfcfd}.date{font-weight:700}.empty{padding:28px;text-align:center;color:#667085}.foot{margin-top:16px;color:#98a2b3;font-size:11px}@media(max-width:760px){body{padding:14px}.hero{display:block}.cards{grid-template-columns:repeat(2,1fr)}}@media print{body{padding:0;background:white}.controls{display:none}.panel,.card{break-inside:avoid}th{position:static}}
</style>
</head>
<body>
<main>
  <div class="hero">
    <div><h1>${escapeHtml(childName)} · 일별 데이터 리포트</h1><div class="muted">사진과 알림장 본문은 제외하고 생활기록 및 상태 데이터만 정리했습니다.</div></div>
    <div class="muted">생성: ${escapeHtml(generatedAt)}</div>
  </div>
  <section class="cards">
    <div class="card"><span>기록 일수</span><strong>${uniqueDates}</strong></div>
    <div class="card"><span>백업 기간</span><strong style="font-size:15px">${escapeHtml(job.startDate)} ~ ${escapeHtml(job.endDate)}</strong></div>
    <div class="card"><span>알림장 건수</span><strong>${rows.length}</strong></div>
    <div class="card"><span>반</span><strong style="font-size:15px">${escapeHtml(classNames)}</strong></div>
  </section>

  <section class="panel">
    <h2>월별 요약</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>월</th><th>기록일</th><th>주요 날씨</th><th>주요 기분</th><th>주요 건강</th><th>주요 식사</th><th>주요 수면</th><th>주요 배변</th></tr></thead>
        <tbody>${monthRows || '<tr><td colspan="8" class="empty">데이터 없음</td></tr>'}</tbody>
      </table>
    </div>
  </section>

  <section class="panel">
    <h2>일별 기록</h2>
    <div class="controls">
      <label>월 <select id="monthFilter"><option value="">전체</option>${monthOptions}</select></label>
      <label>검색 <input id="search" type="search" placeholder="날씨, 상태, 반, 작성자…"></label>
      <span id="visibleCount" class="muted"></span>
    </div>
    <div class="table-wrap">
      <table id="dailyTable">
        <thead><tr><th>날짜</th><th>날씨</th><th>기분</th><th>건강</th><th>체온상태</th><th>체온</th><th>식사</th><th>수면시간</th><th>배변</th><th>목욕</th><th>손발톱</th><th>야외활동</th><th>식사상세</th><th>간호</th><th>수면상세</th><th>배변상세</th><th>댓글</th><th>반응</th><th>활동률</th><th>영상</th><th>첨부파일</th><th>반</th><th>작성자</th></tr></thead>
        <tbody>${dailyRows || '<tr><td colspan="23" class="empty">데이터 없음</td></tr>'}</tbody>
      </table>
    </div>
  </section>
  <div class="foot">KidsNote Backup · 사진 URL 및 알림장 본문은 이 리포트에 포함하지 않습니다.</div>
</main>
<script>
(() => {
  const month = document.getElementById('monthFilter');
  const search = document.getElementById('search');
  const count = document.getElementById('visibleCount');
  const rows = [...document.querySelectorAll('#dailyTable tbody tr[data-month]')];
  function apply(){
    const m = month.value;
    const q = search.value.trim().toLowerCase();
    let visible = 0;
    for(const row of rows){
      const okMonth = !m || row.dataset.month === m;
      const okSearch = !q || row.textContent.toLowerCase().includes(q);
      const show = okMonth && okSearch;
      row.hidden = !show;
      if(show) visible += 1;
    }
    count.textContent = visible + '건 표시';
  }
  month.addEventListener('change', apply);
  search.addEventListener('input', apply);
  apply();
})();
</script>
</body>
</html>`;
}

function summarizeMonths(rows) {
  const groups = new Map();
  for (const row of rows) {
    const month = String(row.date || "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(row);
  }

  return [...groups.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, items]) => ({
      month,
      days: new Set(items.map((row) => row.date).filter(Boolean)).size,
      weather: mode(items.map((row) => row.weather)),
      mood: mode(items.map((row) => row.mood_status)),
      health: mode(items.map((row) => row.health_status)),
      meal: mode(items.map((row) => row.meal_status)),
      sleep: mode(items.map((row) => row.sleep_hour)),
      bowel: mode(items.map((row) => row.bowel_status))
    }));
}

function mode(values) {
  const counts = new Map();
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const key = String(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

function displayValue(field, value) {
  if (value === null || value === undefined || value === "") return "-";
  const key = String(value);
  const maps = {
    weather: { sunny: "맑음", mostly_cloudy: "구름 많음", cloudy: "흐림", overcast: "흐림", rain: "비", rainy: "비", snow: "눈" },
    mood_status: { good: "좋음", normal: "보통", bad: "나쁨" },
    health_status: { good: "좋음", normal: "보통", bad: "나쁨" },
    temperature_status: { normal: "정상", high: "높음", low: "낮음" },
    meal_status: { fixed: "정량", more: "많이", less: "적게", none: "안 먹음" },
    sleep_hour: { none: "안 잠", below_1: "1시간 미만", between_1_2: "1~2시간", above_2: "2시간 이상" },
    bowel_status: { none: "안 함", normal: "보통", hard: "딱딱함", loose: "묽음" },
    bath_status: { done: "함", none: "안 함" },
    nail_status: { good: "양호", need: "정리 필요" },
    outdoor_activity_status: { done: "함", none: "안 함" }
  };
  return maps[field]?.[key] || key;
}

function formatTemperature(value) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") return `${value}℃`;
  if (typeof value === "object") return compactValue(value) || "-";
  return String(value);
}

function formatActivityRate(value) {
  if (value === null || value === undefined || value === "") return "-";
  const n = Number(value);
  if (Number.isFinite(n)) return n <= 1 ? `${Math.round(n * 100)}%` : `${n}%`;
  return String(value);
}

function compactValue(value) {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) {
    return value.map(compactValue).filter(Boolean).join(" / ");
  }
  if (typeof value === "object") {
    return Object.entries(value)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}: ${compactValue(v)}`)
      .join(", ");
  }
  return String(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    current.dailyReportRows = current.dailyReportRows || [];
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
