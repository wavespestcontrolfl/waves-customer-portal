# Wiki article directory and workspace — September 10, 2026

The final Wiki migration replaces the remaining page-local styles and request helper with the shared comfortable workspace, category buttons, labeled search, and keyboard-accessible article cards. Category/search values and unrelated URL parameters retain their existing behavior. Read failures show a retry; stale requests cannot replace newer filter results.

Twenty-four focused Wiki tests, scoped ESLint, and `check:ib-coverage` passed on the rebuilt branch. The slice was re-applied by hand onto `main` rather than replayed from its prepared snapshot: that snapshot predates the review rounds on slices 2-4, so replaying it would have reverted their fixes. On the prepared snapshot, the combined Wiki UI passed 60 Chromium/WebKit viewport cases at widths 390/700/820/1024/1440 and heights 900/390 for the directory, source form, and Q&A dialog. Interactions cover filtering, keyboard article opening/back, source creation/compilation and GET-only refresh recovery, Health/recent queries, question/file-back error recovery, duplicate guards, focus/draft lifetime, URL preservation, and technician Health restrictions.

Desktop and phone directory screenshots and the phone Q&A screenshot were visually reviewed for readable labels, content wrapping, focus visibility, and usable actions. Local proof and screenshots are retained in `.tmp/wiki-final/`. The complete UI was validated against the other prepared Wiki slices; final publishing excludes the local prerequisite snapshot.

All requests used fictional local fixtures with external traffic and WebSockets blocked. No live provider/database/customer action occurred. Physical iPhone/PWA behavior remains unverified. The current Q&A response still omits queryId, so filing is unavailable for that response; its retained valid-ID path is tested conditionally. No backend, permission, or persisted-data contract changed.

## Intelligence Bar census

One changed request fingerprint was reviewed: the final root removes the Queries slice's temporary `fetchKnowledge` alias and directly calls canonical `adminFetch` for the same `GET /admin/knowledge/queries`. Its endpoint, inputs, projection, and read-only effect are unchanged. The article-list `GET /admin/knowledge` and its dynamic query-string request site retain exact existing baseline fingerprints; the new ArticleDirectory component performs no requests. No Intelligence Bar tool or verified parity is claimed, so the changed site remains explicitly unsupported as `reviewed_unmapped`.
