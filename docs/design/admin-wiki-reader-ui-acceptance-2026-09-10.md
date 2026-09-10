# Wiki article reader and Health — September 10, 2026

Focused migration of the selected article and Health panels within `/admin/knowledge`. Each panel owns a comfortable `UiSurface`, shared cards/badges/feedback, readable text, and responsive wrapping. The directory, recent queries, Sources, and page headers are separate review units.

Requests remain `GET /admin/knowledge/article/:id` and `GET /admin/knowledge/health` with the existing bearer token and `VITE_API_URL`. Article selection remains local state; All articles returns to the existing filters. Health remains hidden from technicians. No server, endpoint, permission, metric, or persisted-data changes.

Failed reads show an error with GET-only retry instead of a blank panel or success-looking data. Stale/unmounted requests cannot overwrite the current read. Missing articles and unavailable issue data remain explicit. Valid article tags and dates retain their display; malformed tag JSON no longer crashes the reader. Health retains the first 15 issues and remainder count.

## Verification

Seven focused tests, scoped ESLint, and production build/prebuild gates passed. Actual-route verification passed 40 Chromium/WebKit cases: article and Health at five widths (390/700/820/1024/1440) and two heights (900/390). Read failure/retry, article return, refresh/query context, and technician Health deep-link restrictions passed; all knowledge requests were GETs, with no unexpected requests or page errors.

Desktop/mobile article, Health, and read-error screenshots were visually inspected for readable text, wrapping, and reachable retry controls. Local runner and evidence: `.tmp/wiki-reader/`; screenshots are attached to the PR. Fixtures are fictional and external traffic/WebSockets are blocked. No database/provider/customer action was exercised. Physical iPhone/PWA safe-area and keyboard behavior remain unverified.
