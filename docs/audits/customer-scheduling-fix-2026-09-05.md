**Customer scheduling fixes — implemented locally**

Branch: `fix/customer-scheduling-availability`.
Worktree: `/private/tmp/waves-customer-scheduling-fix`, based on `a2bb0bc49`.
The original checkout's unrelated edits were preserved. No push, merge, deployment, production access, customer message, or appointment mutation was performed.

All ten findings from the September 5 availability audit are addressed:

| Finding | Implemented behavior |
| --- | --- |
| F1 expired holds | Route enumeration uses the same live-reservation expiry predicate as occupancy checks. |
| F2 inactive rows | Offer and commit occupancy checks share the existing non-route status list. Weather alternatives agree. Skipped series occurrences retain their cadence position; freeing time does not compress the series. Linked legacy booking copies defer to their scheduled visit instead of retaining its former window. |
| F3 search/confirmation cap | Per-day results retain every feasible start. Recommendations remain curated separately, so an afternoon search result survives unfiltered confirmation. |
| F4 estimate retiming | Removed `spreadWindowsAcrossDay`; selection no longer rewrites collision-checked windows. |
| F5 global estimate overlap | Committed visits block overlapping estimate offers regardless of the travel gate, technician, or zone. Existing hold coexistence policy remains. |
| F6 own day-cap count | Rescheduling excludes its own linked booking and voice-origin visit from the counts; actual new bookings still consume the cap. |
| F7 untimed rows | Untimed placeholders do not become invented morning appointments in either route or legacy zone availability. |
| F8 early candidate limit | Enumerates the bounded estimate horizon before filtering and choosing display results. |
| F9 misleading label | Non-nearby reschedule recommendations say “Available appointment.” |
| F10 lookup errors | Date-browse failures show an explicit error and retry button. Old/default results stay hidden until the requested lookup succeeds or is cleared. |

Working hours, closures, travel buffers, seasonal restrictions, south-zone policy, token guards, signed offers, transaction locks, and communication behavior are preserved. The public-route contract describes complete day lists and replacement counting. No new dependency, schema change, migration, or feature flag was introduced.

Verification:

- 33 server suites, 729 tests passed. Includes reservations, voice booking, rebooking, weather alternatives, booking caps, occupancy, estimate filtering, and new lifecycle regressions.
- 10 estimate picker client tests passed, including HTTP/network failure and retry.
- Production client build passed, including blog-schema/affiliate vendor verification, portal-brand and domain-rule gates.
- ESLint passed with zero errors; existing large-function/depth warnings remain in touched legacy modules. Whitespace checks passed.
- Desktop (1440) and mobile (390) browser verification used the actual reschedule page and estimate picker with synthetic API responses. Checked truthful recommendation labels, 1 PM selection and confirmation request, lookup failure, retry recovery, and mobile layout. Screenshots were inspected visually. The estimate component fixture used the application's reset and typography, not the complete estimate/payment page.
- External networking was blocked in test/browser fixtures; no live account was exercised. Knex compiled the correlated legacy-copy exclusion without a connection.
- No verified dev/preview database was available. Migrations were not run and database-backed end-to-end behavior is not claimed. The actual cause of each production screenshot date remains a separate production-side diagnosis.

Local visual evidence (not included in a production bundle):

- [Reschedule mobile](../../.verification/reschedule-390.png), [desktop](../../.verification/reschedule-1440.png).
- [Estimate error mobile](../../.verification/estimate-error-390.png), [desktop](../../.verification/estimate-error-1440.png).
- [Estimate retry mobile](../../.verification/estimate-retry-390.png), [desktop](../../.verification/estimate-retry-1440.png).

Release remains unperformed. This is a local implementation, not a claim that the live portal has changed.
