chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "KIDSNOTE_ENSURE_MEMORY_MODE") {
    ensureMemoryMode()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "KIDSNOTE_DETECT_CHILD") {
    sendResponse({ ok: true, childId: detectKidsNoteContext().childId });
    return;
  }

  if (message?.type === "KIDSNOTE_DETECT_CONTEXT") {
    sendResponse({ ok: true, ...detectKidsNoteContext() });
    return;
  }

  if (message?.type === "KIDSNOTE_RESOLVE_ALBUM_CONTEXT") {
    resolveAlbumContext(message.childId)
      .then((context) => sendResponse({ ok: true, ...context }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "KIDSNOTE_FETCH_PAGE") {
    fetchReportsPage(message.childId, message.page || null)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "KIDSNOTE_FETCH_ALBUM_PAGE") {
    fetchAlbumsPage({
      childId: message.childId,
      centerId: message.centerId,
      classId: message.classId,
      page: message.page || null
    })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
});

function normalizedText(node) {
  return String(node?.textContent || "").replace(/\s+/g, " ").trim();
}

function findMemoryViewButton() {
  const buttons = [...document.querySelectorAll('button[type="button"], button')];

  return buttons.find((button) => {
    if (normalizedText(button) !== "추억보기") return false;
    const style = getComputedStyle(button);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (button.disabled) return false;
    return button.getClientRects().length > 0;
  }) || null;
}

async function ensureMemoryMode() {
  const button = findMemoryViewButton();
  if (!button) {
    return { switched: false, alreadyMemoryMode: true };
  }

  button.click();

  const switched = await waitUntil(() => !findMemoryViewButton(), 8000, 200);
  if (!switched) {
    throw new Error("추억보기 전환을 확인하지 못했습니다. 화면에서 추억보기를 직접 선택한 뒤 다시 시도하세요.");
  }

  await sleep(500);
  return { switched: true, alreadyMemoryMode: false };
}

function waitUntil(predicate, timeoutMs, intervalMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let done = false;
      try {
        done = Boolean(predicate());
      } catch (_) {
        done = false;
      }

      if (done || Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        resolve(done);
      }
    }, intervalMs);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resourceCandidates() {
  const candidates = performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter(Boolean)
    .reverse();

  candidates.push(location.href);
  return candidates;
}

function detectKidsNoteContext() {
  const context = { childId: null, centerId: null, classId: null };

  for (const value of resourceCandidates()) {
    const text = String(value);

    if (!context.childId) {
      const pathMatch = text.match(/\/children\/(\d+)\/(?:reports|albums)\//);
      if (pathMatch) context.childId = pathMatch[1];
    }

    try {
      const url = new URL(text, location.href);
      context.childId ||= url.searchParams.get("child");
      context.centerId ||= url.searchParams.get("center");
      context.classId ||= url.searchParams.get("cls");
    } catch (_) {}

    if (context.childId && context.centerId && context.classId) break;
  }

  return context;
}

async function resolveAlbumContext(childId) {
  const context = detectKidsNoteContext();
  const resolvedChildId = String(childId || context.childId || "").trim();
  if (!/^\d+$/.test(resolvedChildId)) {
    throw new Error("앨범 조회에 사용할 Child ID를 찾지 못했습니다.");
  }

  if (context.centerId && context.classId) {
    return {
      childId: resolvedChildId,
      centerId: String(context.centerId),
      classId: String(context.classId),
      childName: null
    };
  }

  const reports = await fetchReportsPage(resolvedChildId, null, 1);
  const sample = reports.results?.[0];
  if (!sample?.center || !sample?.cls) {
    throw new Error("앨범 조회에 필요한 원/반 정보를 자동으로 찾지 못했습니다. KidsNote 알림장 또는 앨범 화면을 한 번 연 뒤 다시 시도하세요.");
  }

  return {
    childId: resolvedChildId,
    centerId: String(sample.center),
    classId: String(sample.cls),
    childName: sample.child_name || null
  };
}

async function fetchReportsPage(childId, page, pageSize = 99999) {
  const url = new URL(`https://kapi.kidsnote.com/v1_2/children/${encodeURIComponent(childId)}/reports/`);
  if (page) url.searchParams.set("page", page);
  url.searchParams.set("page_size", String(pageSize));
  url.searchParams.set("tz", "Asia/Seoul");
  url.searchParams.set("child", String(childId));

  return fetchKidsNoteJson(url);
}

async function fetchAlbumsPage({ childId, centerId, classId, page }) {
  if (!/^\d+$/.test(String(childId || ""))) throw new Error("앨범 Child ID가 올바르지 않습니다.");
  if (!/^\d+$/.test(String(centerId || ""))) throw new Error("앨범 Center ID가 올바르지 않습니다.");
  if (!/^\d+$/.test(String(classId || ""))) throw new Error("앨범 Class ID가 올바르지 않습니다.");

  const url = new URL(`https://kapi.kidsnote.com/v1_3/children/${encodeURIComponent(childId)}/albums/`);
  if (page) url.searchParams.set("page", page);
  url.searchParams.set("tz", "Asia/Seoul");
  url.searchParams.set("page_size", "99999");
  url.searchParams.set("center", String(centerId));
  url.searchParams.set("cls", String(classId));
  url.searchParams.set("child", String(childId));

  return fetchKidsNoteJson(url);
}

async function fetchKidsNoteJson(url) {
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`KidsNote API request failed (${response.status}). 로그인 상태를 확인한 뒤 다시 시도하세요.`);
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.results)) {
    throw new Error("Unexpected KidsNote API response: results array is missing.");
  }

  return data;
}
