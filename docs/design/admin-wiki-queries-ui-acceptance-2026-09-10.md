# Wiki recent queries and hub header — September 10, 2026

Recent queries use comfortable shared cards, readable metadata, and explicit loading, empty, and retry states. The Knowledge hub header uses the workspace variant inside its own comfortable surface; the Knowledge Base child remains outside that scope.

The canonical admin request helper loads `GET /admin/knowledge/queries`. Retry repeats only the read. Query text, answer, author, date, rating, and filing status retain their existing meanings. Hub area and child tab changes preserve unrelated URL parameters.

Eight combined Wiki/Hub tests passed after canonical helper integration. Scoped ESLint and production build/prebuild gates passed. Actual-route proof passed 20 Chromium/WebKit cases at widths 390/700/820/1024/1440 and heights 900/390, plus rejected-read recovery, empty results, refresh, and URL preservation.

Desktop query and phone error screenshots were visually reviewed for readable metadata, wrapping, and reachable retry controls. Local proof and screenshots are retained in `.tmp/wiki-queries/`. All requests used fictional local fixtures; external traffic and WebSockets were blocked. Physical iPhone/PWA behavior remains unverified. No backend, permission, provider, or persisted-data contract changed.

## Intelligence Bar census

One changed request fingerprint was reviewed: the existing `GET /admin/knowledge/queries` now runs in a dedicated active-guarded effect through the canonical helper alias. It retains the same bearer-authenticated endpoint, no inputs, query-list projection, and read-only effect. Retry support adds no Intelligence Bar tool or verified parity, so the site remains explicitly unsupported as `reviewed_unmapped`.
