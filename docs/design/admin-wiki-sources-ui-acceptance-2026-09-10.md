# Wiki source management — September 10, 2026

Focused migration of Sources within `/admin/knowledge`: the source list is table-first per spec §5.7 on the shared `Table layout="records"` primitive (File / Description / Type / Status / Compile), which collapses to labelled records under 1100px; the add form uses the comfortable shared cards, fields, buttons, and feedback. Other Wiki panels and page headers remain separate review units.

Preserved requests: bearer-authenticated `GET /admin/knowledge/sources`, `POST /admin/knowledge/sources` with `{filename,file_path,file_type,description}`, and `POST /admin/knowledge/compile` with `{sourceId}`, followed by a source reload. The existing file types, source counts, processed state, and mounted draft lifetime remain. Cancel and failed creation retain the draft; successful creation clears it.

Synchronous guards prevent duplicate pending writes. Non-2xx action responses show errors. A successful write followed by a failed source reload reports that the change was saved and offers a GET-only retry; it does not invite repeating the POST. No backend, permission, provider, or persisted-data contract changed.

Thirteen focused tests on the stacked tree (ten inherited from the reader slice), scoped ESLint, and production build/prebuild gates passed. Actual-route browser verification passed 20 Chromium/WebKit cases across five widths (390/700/820/1024/1440) and two heights (900/390), plus draft cancel/rejection retention, creation, compilation, saved-write/reload-failure recovery, refresh, and query preservation. No unexpected API requests or page errors occurred.

Desktop/mobile source-form screenshots were visually reviewed for wrapping, readable fields, and reachable actions. The page scrolls to the form's lower actions on phones. Local runner/evidence: `.tmp/wiki-sources/`; screenshots are attached to the PR. Fictional local API fulfillment blocks external traffic and WebSockets. No real source compilation, database/provider request, or customer communication was exercised; physical iPhone/PWA keyboard/safe-area behavior remains unverified.

Existing role mismatch remains separate: technicians can see Add source, while its backend POST requires admin. No permission is widened by this UI change.

## Intelligence Bar census

Four exact request fingerprints were reviewed: the initial and post-mutation source-list GETs, source creation POST with `{filename,file_path,file_type,description}`, and compile POST with `{sourceId}`. They preserve the existing bearer-authenticated operations and server effects. The extraction adds guarded writes and GET-only recovery but no Intelligence Bar tool or verified parity, so all four remain explicitly unsupported as `reviewed_unmapped`.
