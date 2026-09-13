# Knowledge Base UI migration — September 10, 2026

The Knowledge Base now uses comfortable shared controls and focused components for Browse, New, Field intelligence, AI audit, Tokens, and summary statistics. Existing tab URLs, filters, request bodies, and role restrictions remain intact. This implementation is local and has not been published.

Nine focused tests, scoped ESLint, production build/prebuild gates, and the portal brand check passed. Independent review found a cross-row draft cleanup issue when approval completed during another row’s block flow; identity-scoped cleanup and a deferred-response regression fix it.

Actual-route browser proof passed 180 Chromium/WebKit cases covering five widths (390/700/820/1024/1440), two heights (900/390), five tabs, entry and field details, and delete/block dialogs. Interaction coverage includes filter and keyboard entry opening; edit/create validation, failure recovery, and duplicate guards; verify, flag, delete cancel/retry; audit and forced audit; token read/action retry; field block draft retention and notes; tier pinning, regeneration, approval; and technician restrictions. No unexpected API requests or page errors occurred.

Desktop and phone screenshots were visually reviewed for readable controls, wrapping, dialog actions, and detail content. The final phone detail screenshots were taken after responsive layout settled; longer content and lower actions remain reachable by page scrolling. Evidence is retained in `.tmp/knowledge-base-ui/`; the repeatable runner is `scripts/qa/knowledge-base-ui.cjs`.

All actions used fictional local API fixtures with external traffic and WebSockets blocked. No live token checks, provider calls, database writes, or owner/customer messages occurred. Physical iPhone/PWA keyboard and safe-area behavior remains unverified.

Existing issues outside this UI migration remain: a save finishing after switching entries can close the newer editor; overlapping detail reads can resolve out of order; some detail metadata/content refreshes on reopening. The UI’s existing admin visibility rules do not replace backend authorization. No permission or API contract changed.

## Intelligence Bar census

Seventeen relocated request fingerprints were reviewed. Browse retains list/search GETs with `limit`, `category`, `status`, and encoded `q`; verify POST with `{}`; flag POST with the fixed admin-UI reason; update PUT with `{content}`; and confirmed DELETE. Its extracted dynamic dispatcher invokes only those existing request closures and refresh reads.

Create retains POST `/admin/kb` with title, category, content, parsed tags, confidence, and `source: "manual"`. Audit retains `{maxEntries,forceAll}`. Tokens retain status GET and check POST. Field intelligence retains queue, page-list, and slug-detail GETs; review POST with `{action,notes}`; tier PUT with `{tier}`; and regeneration POST with `{}`. Authentication, authorization, projections, and server effects are unchanged. Guarded loading/error/retry behavior adds no Intelligence Bar tool or verified parity, so all 17 sites remain explicitly unsupported as `reviewed_unmapped`.
