chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
  url.searchParams.set("page_size", "12");
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
