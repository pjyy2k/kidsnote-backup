# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

KidsNote Backup: a Chrome/Edge Manifest V3 extension that backs up KidsNote 알림장 (daily reports) and 앨범 (album) original photos for a date range, using the user's existing logged-in KidsNote session. Published on the Chrome Web Store and Edge Add-ons. User-facing text, docs, and commit-adjacent docs are in Korean.

## Development

There is no build step, package manager, linter, or test suite — the repo root *is* the unpacked extension.

- Run: `chrome://extensions` → Developer mode → "Load unpacked" → select the repo folder. After editing, click reload on the extension card and refresh any open `www.kidsnote.com` tab (the content script only attaches on page load).
- Debug: background logs are in the service worker inspector on the extension card; content-script logs are in the KidsNote tab's DevTools; popup logs via right-click → Inspect on the popup.
- Release: bump `version` in `manifest.json` **and** `기준 버전` in `CHROME_WEB_STORE_SUBMISSION.md` together (see commit 247d666).
- Guide pages in `instruction/` use a cache-busting query (`guide.css?v=YYYYMMDD`, `images/*.png?v=...`); bump it when changing those assets.

## Architecture

Three scripts communicating via `chrome.runtime` / `chrome.tabs` messages:

- **`popup.js` / `popup.html`** — UI only. Sends `{type: GET_STATE | DETECT_CONTEXT | START | PAUSE | RESUME | RETRY_FAILED | CANCEL}` to the background and renders job state. Strings are hardcoded Korean; `_locales/` only covers manifest name/description.
- **`content.js`** (runs on `https://www.kidsnote.com/*`) — the only place KidsNote API calls happen. It `fetch`es `kapi.kidsnote.com` from the page context so the session cookies apply. Handles `KIDSNOTE_FETCH_PAGE` (reports, `v1_2`), `KIDSNOTE_FETCH_ALBUM_PAGE` (albums, `v1_3`), and context detection (child/center/class IDs scraped from page resource URLs, with a fallback that fetches one report).
- **`background.js`** (service worker) — owns the backup job state machine. Fetches list pages by messaging a KidsNote tab (`sendToKidsNoteTab` falls back to any open KidsNote tab if the saved one is gone), filters by date, and saves files with `chrome.downloads` (photos, per-day Markdown/JSON, and a final `Reports/daily-report-{start}_{end}.html`).

### Job model (background.js)

- A single job is persisted in `chrome.storage.local` under `kidsnoteBackupJob`; always modify it through `mutateJob()`, which serializes writes.
- Work is driven one page at a time by a `chrome.alarms` alarm (`kidsnoteBackupNext`) → `processNextPage()`, so it survives MV3 service-worker shutdown. `ensureRunningJobHasAlarm()` re-arms on startup.
- Every run has a `jobId` + `runToken`. Pause/cancel/resume rotate the `runToken`; long-running loops must check `isRunActive()` / `matchesActiveRun()` after every await and bail out if the token changed. Preserve this pattern in any new async step.
- Resume relies on `cursor` (the server's `next` value, passed back verbatim as `page`), `processedItemIds`, and per-date photo sequence counters, so re-runs don't duplicate files. Lists are newest-first; iteration stops when an item's date falls before `startDate`.
- Photo downloads are throttled (`MAX_CONCURRENT_DOWNLOADS`) with retries; failed ones are recorded and re-processed by the `retry` mode (`RETRY_FAILED`, batches of `RETRY_BATCH_SIZE`).

### Conventions from README

- Never guess or rewrite API URLs, cursors, or photo URLs — use `next` and `attached_images[].original` exactly as returned. On API/auth errors, stop and surface the error rather than trying other endpoints.
- Don't hardcode center/class/child IDs; detect them.
- Output layout under the downloads folder: `KidsNote/{ChildName}/{Photos,Videos,Diary,JSON,Reports}` for reports and `KidsNote/{ChildName}/Album/{Photos,Videos}` for albums; photo names are `yyyy-mm-dd-NNN`, video names `yyyy-mm-dd-video-{id}` (from `attached_video.high`, falling back to `low`); no per-report/album-ID folders. Fallback child folder is `child-{ChildID}`.
- No external servers, analytics, or remote code (a Chrome Web Store declaration). Permissions are deliberately minimal (`storage`, `downloads`, `alarms`, `https://*.kidsnote.com/*`); adding one requires updating the justification in `CHROME_WEB_STORE_SUBMISSION.md` / `store/listing-justification.md` and `PRIVACY.md`.
