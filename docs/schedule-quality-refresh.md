# Route-quality refresh recovery

Committed schedule changes and successful guarded geocodes use
`server/services/scheduling/quality-after-change.js`. The shared entry point
registers a request in `schedule_quality_refresh_jobs` before reading affected
dates or starting repair, measurement, and Dispatch warning reconciliation.
It still attempts the refresh immediately and never rejects an already
committed customer or appointment update because a quality check failed.

The pending request contains customer/job IDs and dates, never names or
addresses. Once date discovery succeeds, its exact sparse dates are saved for
retry. Every attempt reads the current schedule and keeps the existing future
planning horizon: tomorrow through 30 days from the attempt. Expired requests
are retired. The existing route writer keeps its locks, stale-snapshot guards,
manual-pin protections, and promised-window checks.

The scheduler retries due requests every five minutes. An atomic row claim
gives an attempt a 15-minute lease; interrupted work becomes claimable again.
Completion and retry updates require the matching attempt token so an older
attempt cannot remove a newer claim. Failures back off from five minutes to a
one-hour maximum. There is no silent terminal retry limit.

Measurement failures, alert-reconciliation failures, and returned route-repair
errors all retain the request. Retries rerun the shared refresh against current
data, so another measurement ledger row may record a later attempt. Only
successful completion or expiry removes the pending request.

## Existing controls

- Measurement: `GATE_SCHEDULE_QUALITY_MEASUREMENTS`.
- Warning cards: measurement plus `GATE_SCHEDULE_QUALITY_ALERTS`.
- Guarded repair: `GATE_ROUTE_REORDER`, `GATE_ROUTE_REORDER_REPAIR`, and
  `GATE_DRIVE_TIME_CALIBRATION`.
- Background retry scheduling: the existing `GATE_CRON_JOBS` control.

With both measurement and repair disabled, new requests do no database work
and existing requests remain pending. Re-enabling the existing gates allows
the next scheduled retry to continue. This change does not flip any gates.

Bulk Intelligence Bar refresh consolidation is tracked separately in
[PR #4846](https://github.com/wavespestcontrolfl/waves-customer-portal/pull/4846).

## Verification and limits

Successful shared refresh logs include aggregate warning creation and resolution
counts. The retry sweep logs processed, succeeded, and failed counts; request
and attempt errors contain identifiers or error codes only. Existing planning
ledger and Dispatch warning readers remain unchanged.

Durability starts when the post-commit request is registered. This is not a
transactional outbox in every appointment writer: a process exit before that
call, or a database outage that prevents registration, cannot leave a durable
request. Registration failures are logged and the source update remains
committed. Existing nightly checks and later schedule changes remain backstops.

The PostgreSQL regression suite uses a private synthetic QA database and runs
in CI with the coordinate-recovery suites. It verifies persistence, reclaim,
attempt-token fencing, current-date eligibility, and returned failure handling.
Address corrections require verified customer address evidence; rejected
partial, coarse, and out-of-area geocodes are never accepted by this recovery.
