# Bug Identifier — Waves Chrome extension

A Chrome extension (Manifest V3) that identifies a bug, spider or other pest
from a photo, built to rank in Chrome Web Store search for "bug identifier"
(owner 2026-10-31). Answers come from the same v2 species-catalog engine as
the customer app's Photo ID, through a public, gated portal endpoint:
`POST /api/public/bug-id-extension/identify`
(`server/routes/public-bug-id-extension.js`; contract in
`docs/public-route-contracts.md`, gate in `docs/gates-and-env.md`).

## How it works

- **Toolbar button** opens the side panel (`panel.html`, `panel.js`): choose,
  drop or paste a photo.
- **Right-click an image → "Identify this bug"** (`background.js`): the
  service worker fetches the image. If the image host refuses (no CORS), it
  captures the visible tab and crops the image out. If it can't find the
  image (inside a frame, or swapped out), it falls back to the box selector.
- **Right-click a page → "Select a bug on this page to identify"**, or the
  panel's button: `content/select-region.js` lets the user drag a box, removes
  itself, and the service worker captures and crops that box.
- The service worker never calls the API. It hands the photo to the panel of
  the same window through `chrome.storage.session` (key `job`), and the panel
  POSTs it and renders the answer (`lib/render.js`, same order and copy as
  the app's `PhotoId.jsx` V2 result).
- Every photo is resized to JPEG, at most 1600 px on the long side
  (`lib/image.js`); at most 3 photos per request (the "Add this photo" flow
  when the engine asks for one more).

Permissions are the minimum for that: `activeTab` (capture only after the
user invokes it), `contextMenus`, `scripting`, `sidePanel`, `storage` (the
in-memory session hand-off), and one host permission for the portal API.
The extension reads the API answer under that host permission, so the
endpoint sends no CORS headers and ordinary web pages can't use it.

## Server side (already in this repo)

- Dark until `GATE_BUG_ID_EXTENSION=true` on Railway. While dark, the
  extension shows "Bug identification isn't available yet."
- Spend guards: 6 an hour and 15 a day per IP, plus one worldwide daily cap
  of 100 (`PUBLIC_LLM_DAILY_CAP_BUG_ID_EXTENSION`) in its own
  `bug-id-extension` bucket. The cap counts whatever
  `GATE_PUBLIC_LLM_SHARED_CAP` says and fails closed, and it never touches
  the website funnels' photo budget.
- No lead capture, no pricing, no stored photo, no database row except the
  daily counter. Cost lands on the model switchboard's `pest_id_app` lane.

## Launch checklist (owner)

1. Merge the portal change. The endpoint ships dark.
2. Add the privacy section in `PRIVACY.md` to the website's privacy policy
   (astro repo).
3. Set `GATE_BUG_ID_EXTENSION=true` on Railway (and
   `PUBLIC_LLM_DAILY_CAP_BUG_ID_EXTENSION` if 100 a day should change). Do
   this before submitting: store reviewers try the extension, and a dark
   endpoint reads as broken.
4. Register a Chrome Web Store developer account (one-time fee) under the
   Waves Google account. Verifying wavespestcontrol.com as the publisher
   domain is optional and adds trust.
5. `node extensions/bug-identifier/scripts/package.mjs`, then upload
   `extensions/bug-identifier/dist/bug-identifier-<version>.zip`.
6. Fill in the listing and privacy tabs from `store/listing.md`, upload the
   images in `store/screenshots/`, and submit for review.
7. After approval, link the listing from the website's `/pest-identifier/`
   page.
8. Edge Add-ons (Partner Center, free): upload the same zip; listing notes in
   `store/listing.md`.
9. Firefox Add-ons (needs a Mozilla account with two-step sign-in):
   `node extensions/bug-identifier/scripts/package.mjs --firefox`, then upload
   `dist/bug-identifier-firefox-<version>.zip`. Firefox has no side panel, so
   that build shows the panel in the Firefox sidebar.

## Develop and test

- Load it: `chrome://extensions` → Developer mode → Load unpacked → select
  `extensions/bug-identifier`. To point it at a local portal, change
  `API_URL` in `lib/config.js` and the `host_permissions` entry in
  `manifest.json` (don't commit that).
- Smoke test plus store images:
  `node extensions/bug-identifier/scripts/screenshots.mjs`. It loads the
  real extension in Chromium, answers its API calls with answers built by the
  engine's real answer builder (no model call), checks every panel state, the
  page selector and the crop math, and rewrites `store/screenshots/`.
- Icons: edit `icons/icon.svg`, then
  `node extensions/bug-identifier/scripts/render-icons.mjs`.
- Both scripts accept `CHROMIUM_PATH` to use a Chromium other than the one
  Playwright installed.
- Release: bump `version` in `manifest.json`, run `scripts/package.mjs`, and
  upload the zip as a new version (and the `--firefox` zip to Firefox).
- Firefox: build with `--firefox`, unzip it, then `about:debugging` → This
  Firefox → Load Temporary Add-on → pick the unzipped `manifest.json`. The
  toolbar button and both menu items open the sidebar.
