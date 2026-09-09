# Callback review follow-up

Scope: the seven P2 findings on callback API PR #4235 at `3babe5d8550a2b5cd5244320d354982f7b195f55`. This follow-up addresses four local defects; the three structural findings below remain deferred.

## Local fixes

- Individual callback bells are marked read when their promise is fulfilled, closed, removed, or superseded by a later extraction. Cleanup also catches promises fulfilled by a feed read before the next notification sweep. Open current promises retain their bells.
- Calling an unlinked source record preserves its null customer link, even if the phone now uniquely matches a customer. Original caller, explicit customer, row-version and active-bridge guards remain in force.
- The end-of-day card total counts only callbacks whose effective deadline has arrived and whose snooze has expired. Future and undated callbacks stay out of that exception total.
- Commitment responses expose `effective_due_at` for display. The Owed tab, lead view, customer summary and call-intelligence panel use it. `due_at` retains its stated-date meaning, so editing a description does not silently turn a calculated deadline into a stated promise. The combined callback/commitment gate controls fallback exposure.

## Deferred structural findings

| Finding | Location | Reason for deferral |
| --- | --- | --- |
| Callback call route branching | `server/routes/admin-communications.js`, `POST /call` and its claim transaction | Consolidating caller identity, staff bridging, version checks and provider interlocks is broader than these four fixes. Keep the guards explicit; moving them into single-use helpers would not remove decisions. |
| Commitment patch branching | `server/routes/admin-call-recordings.js`, `PATCH /commitments/:id` | Consolidating source/action dispatch requires coverage across both callback and existing commitment paths. No restructuring in this follow-up. |
| Dial-complete webhook branching | `server/routes/twilio-voice-webhook.js`, `POST /outbound-dial-complete` | Simplifying evidence dispatch requires preserving signed-provider validation, parent/child binding and first-evidence behavior together. No restructuring in this follow-up. |

These are acknowledged P2 quality debt, not fixed findings. The earlier recipient-specific notification and shared-main-line throughput deferrals in the PR remain unchanged.

## Validation

- 271 server tests passed across 13 callback, commitment, call-intelligence, route, digest and voicemail suites.
- 40 client tests passed across the four affected staff surfaces. The Owed suite fixes its clock so an elapsed fixture deadline cannot change the expected overdue count.
- Three PostgreSQL regression tests passed in `server/tests/callback-review-postgres.test.js` against the existing managed synthetic QA database. They cover automatic fulfillment and bell retirement, due/snooze digest counts, and an unlinked source whose phone now matches a customer. Each test rolls back its transaction. Bridge/provider and notification delivery are mocked; no customer communications are sent.
- The PostgreSQL suite is opt-in with `CALLBACK_REVIEW_POSTGRES=1`. Run it through the managed QA `childEnvironment(context, { database: true })`, which supplies `WAVES_LOCAL_DEV=1` and the verified synthetic `waves_qa_*` database. An ordinary Jest run skips it. No migrations were needed or run.
- Domain rules, portal-brand and `git diff --check` passed. Targeted ESLint reported no errors; structural warnings remain, including the deferred route complexity.

This records implementation verification; the PR review and CI results are tracked on PR #4235.
