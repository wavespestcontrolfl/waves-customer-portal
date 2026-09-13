# Wiki article reader and Health — September 10, 2026

Focused migration of the selected article and Health panels within `/admin/knowledge`. Each panel owns a comfortable `UiSurface`, shared cards/badges/feedback, readable text, and responsive wrapping. Per spec §5.7 the reader is an in-page table of contents plus the article body at max 720px: ATX headings (`#`–`###`) in the stored Markdown become anchored `h2`/`h3` elements and TOC entries that scroll to and focus their heading; all other lines stay pre-wrapped text, since this route has no Markdown renderer. The directory, recent queries, Sources, and page headers are separate review units.

Requests remain `GET /admin/knowledge/article/:id` and `GET /admin/knowledge/health` with the existing bearer token and `VITE_API_URL`. Article selection remains local state; All articles returns to the existing filters. Health remains hidden from technicians, and a 403 from its `requireAdmin` endpoint (stale cached role) renders the panel blank per spec §5.7 rather than an error with a retry that cannot succeed. No server, endpoint, permission, metric, or persisted-data changes.

Failed reads show an error with GET-only retry instead of a blank panel or success-looking data. Stale/unmounted requests cannot overwrite the current read. Missing articles and unavailable issue data remain explicit. Valid article tags and dates retain their display; malformed tag JSON and non-string tag elements no longer crash the reader (only string tags render). Health retains the first 15 issues and remainder count. Issue rows carry the spec §3.3 dot chip per linter severity — `high` alert, `medium` filled primary, `low` neutral — and the score box keeps its three bands (<60 alert, 60–79 primary border, ≥80 neutral), so medium findings keep a distinct marker after the amber palette fold.

## Verification

Eleven focused tests, scoped ESLint, and production build/prebuild gates passed. Actual-route verification passed 40 Chromium/WebKit cases: article and Health at five widths (390/700/820/1024/1440) and two heights (900/390). Read failure/retry, article return, refresh/query context, and technician Health deep-link restrictions passed; all knowledge requests were GETs, with no unexpected requests or page errors.

Desktop/mobile article, Health, and read-error screenshots were visually inspected for readable text, wrapping, and reachable retry controls. Local runner and evidence: `.tmp/wiki-reader/`; screenshots are attached to the PR. Fixtures are fictional and external traffic/WebSockets are blocked. No database/provider/customer action was exercised. Physical iPhone/PWA safe-area and keyboard behavior remain unverified.

## Intelligence Bar census

Two exact request fingerprints were reviewed: `GET /admin/knowledge/article/:id` with the selected article ID and the admin-only `GET /admin/knowledge/health`. Both retain their bearer authentication, response projections, and read-only effects. Extraction adds explicit failure and GET-only retry behavior but no Intelligence Bar tool or verified parity, so both remain explicitly unsupported as `reviewed_unmapped`.
