chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "KIDSNOTE_ENSURE_MEMORY_MODE") {
    ensureMemoryMode()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "KIDSNOTE_DETECT_CHILD") {
    sendResponse({ ok: true, childId: detectChildId() });
    return;
  }

  if (message?.type === "KIDSNOTE_FETCH_PAGE") {
    fetchReportsPage(message.childId, message.page || null)
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

function detectChildId() {
  const candidates = performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter(Boolean)
    .reverse();

  candidates.push(location.href);

  for (const value of candidates) {
    const match = String(value).match(/\/children\/(\d+)\/reports\//);
    if (match) return match[1];
  }

  return null;
}

async function fetchReportsPage(childId, page) {
  const url = new URL(`https://kapi.kidsnote.com/v1_2/children/${encodeURIComponent(childId)}/reports/`);
  if (page) url.searchParams.set("page", page);
  url.searchParams.set("page_size", "99999");
  url.searchParams.set("tz", "Asia/Seoul");
  url.searchParams.set("child", String(childId));

  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`KidsNote API request failed (${response.status}). Sign in again and retry.`);
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.results)) {
    throw new Error("Unexpected KidsNote API response: results array is missing.");
  }

  return data;
}
