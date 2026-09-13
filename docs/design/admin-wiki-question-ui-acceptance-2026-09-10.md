# Wiki question dialog — September 10, 2026

First focused Wiki migration: `/admin/knowledge` → Ask a question. The directory, source management, article reader, Health, recent queries, and separate Knowledge Base retain their current presentation in this PR.

The question flow now uses the shared comfortable Dialog, Field/Input, Button, and ActionFeedback components. Its requests use the canonical admin-fetch helper, including standard 401 redirect and 429 retry handling, while retaining bearer authentication, `VITE_API_URL`, `POST /admin/knowledge/query` with `{question}`, and conditional `POST /admin/knowledge/file-back` with `{queryId}`. Closing resets the mounted dialog's question/result as before. Escape and close restore focus to the opener.

Failed questions and filing attempts show an error and permit retry; pending requests are guarded against duplicate submission. A filing response only marks the answer associated with the submitted query ID. No server contract, permission, model, provider, or persisted data changes.

The current Q&A service omits `queryId`. The dialog therefore disables filing with an associated visible reason for that real response. The valid-ID path remains a separately tested conditional capability. Existing Good/Incomplete controls had no handlers; they remain unavailable with an explanatory title. Backend wiring for either feature is a separate task.

## Verification

Final split-specific checks passed: 5 focused tests, scoped ESLint, production build/prebuild gates, and 20 Chromium/WebKit cases across widths 390/700/820/1024/1440 and heights 900/390. Interactions verified query failure/retry, duplicate Enter suppression, no-ID filing explanation, conditional valid-ID filing failure/retry, Escape/focus return, draft reset, query context, and technician Health restrictions. Desktop/mobile screenshots were visually reviewed: readable controls, wrapping sources, visible actions, and no horizontal overflow.

The local actual-route proof (`node .tmp/wiki-question/proof.cjs`) uses fictional responses, blocks external traffic and WebSockets, and records request methods/payloads. No unexpected requests or page errors occurred. Evidence is retained under `.tmp/wiki-question/`; desktop and mobile screenshots are attached to the PR.

No live knowledge query, provider call, database mutation, or customer communication was exercised. Browser-emulated touch does not establish physical iPhone/PWA safe-area or keyboard behavior. The remaining legacy page typography is outside this focused migration.

The two relocated Q&A POST sites are recorded with exact fingerprints as `reviewed_unmapped` in the Intelligence Bar census. Their endpoints, bodies, and server guards were checked against `server/routes/admin-knowledge.js`; this preserves the unsupported/unverified capability backlog and does not claim tool parity.
