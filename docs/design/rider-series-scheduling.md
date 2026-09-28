# Rider-series scheduling — read-only preview

Owner GO 2026-09-28 (scope doc `~/lawn-pest-rhythm-scope-20260928.md`): for
customers with lawn every 6 weeks plus quarterly pest, pest should ride every
other lawn visit (every ~12 weeks) instead of running its own independent
quarterly series — one trip per lawn visit, no solo pest trips.

**This document covers the READ-ONLY PREVIEW only.** The write engine that
would actually set `scheduled_services.rides_parent_id` and reschedule real
visits is **PR #5268**, now a paused draft after five non-converging Codex
review rounds. Owner decision 2026-09-28: ship this preview first so the
office can see what the rule would do to real customers before any write
engine ships. See "Why a preview first" below.

## The date rule

Repeatedly: the next pest date is the first live lawn (host) date at least
`MIN_GAP_DAYS` (77) after the last pest date. If no host date falls within
`MAX_WAIT_DAYS` (105) of the last pest date — the host is skipped, paused, or
ended — pest places its own standalone date `TARGET_GAP_DAYS` (84) out
instead, so it never lapses waiting on a host that isn't coming.

With lawn on its real ~42–44 day cadence, this lands pest on every 2nd lawn
date, 84–88 days apart — close to its current ~91-day quarterly cadence, but
now locked to a real lawn stop instead of walking an independent interval
that drifts apart from it over time (see "Why configuration alone will not
hold" in the scope doc: completion auto-extend walks each series from its own
latest date, so weekend/blackout nudges become anchors and the two series
drift; and the candidate-date clash probe reads the customer's own lawn visit
as a conflict, pushing pest off the aligned date).

An overdue (lapsed) rider never plans before `planFloor` — the day after the
near-term cutoff (`NEAR_TERM_DAYS` = 7 days from today). A stale anchor takes
the first host date within `OVERDUE_WAIT_DAYS` (= `MAX_WAIT_DAYS` -
`MIN_GAP_DAYS` = 28 days) of the floor, else a standalone date on the floor
itself — so a rider revived after a long gap never inserts past-dated rows
and never waits an extra normal cycle before catching up.

`computeRiderHorizon` bounds how far out the plan reaches: the later of the
host's own last live date and the rider's own standalone horizon (anchor +
(planned-visit-count − 1) × `TARGET_GAP_DAYS`, the same count the seeder
plans for the pattern in a year), capped at `MAX_HORIZON_EXTRA_DAYS` (730)
past the standalone horizon — a host row seeded or hand-edited an arbitrary
distance out can never blow the plan's horizon out to match it.

Constants (`server/services/rider-series-preview.js`, byte-identical to the
write engine's own `server/services/rider-series.js`):

| constant | value | meaning |
|---|---|---|
| `MIN_GAP_DAYS` | 77 | earliest a host date can be picked |
| `TARGET_GAP_DAYS` | 84 | the standalone fallback gap |
| `MAX_WAIT_DAYS` | 105 | latest a host date can be picked before falling back |
| `NEAR_TERM_DAYS` | 7 | a window this close is a fixed anchor, never planned into |
| `OVERDUE_WAIT_DAYS` | 28 | `MAX_WAIT_DAYS - MIN_GAP_DAYS` |
| `MAX_HORIZON_EXTRA_DAYS` | 730 | horizon cap past the standalone horizon |

`planRiderDates` (pure, no DB) and `computeRiderHorizon` are the exact same
functions the write engine uses — copied, not re-derived, so the preview and
the eventual write engine can never silently disagree about "what the plan
is." `server/tests/rider-series-preview-plan.test.js` is the write engine's
own `rider-series-plan.test.js` (branch `feat/pest-rides-lawn-core-20260928`,
PR #5268), copied verbatim except its require path.

## The read rules (`previewRiderPair`)

`previewRiderPair(conn, { riderParentId, hostParentId })` — read-only, no
locks of any kind, never writes. `hostParentId` is optional: pass it
explicitly to preview a **candidate** pairing that has no
`rides_parent_id` link in the database at all (the normal case today — see
"Why nothing is linked yet" below), or omit it to read a rider's own
already-stamped link (for a future PR 2/3 world). Returns:

```
{
  eligible, reasons,                // reasons is an ARRAY — every applicable
                                     // gate, not just the first, so an office
                                     // list can show every reason a pair is
                                     // blocked, not just one
  anchor, planFloor, horizon, plan, // the date rule's output
  keep, move, insert, cancel,       // the diff against the rider's existing rows
  pinned,                           // [{id, date, why}] — every live rider row
                                     // that cannot move, and why
}
```

### Pair gates

- `self_link` — a series riding itself.
- `host_is_rider` — the host itself rides another series (one level of
  chaining only; never followed).
- `cross_customer` — rider and host belong to different customers.
- `different_property` — rider and host are stamped to different
  `customer_properties` rows.
- `not_series_root` — the id given is a child row, not a series parent.
- `not_recurring` — the rider has no `recurring_pattern`.
- `not_ongoing` — the rider's `recurring_ongoing` flag is false.
- `plan_stopped` — the rider's latest resolved `recurring_plan_alerts`
  decision is `cancel_series` or `let_lapse`.

`rider_not_found`, `not_a_rider` (no `hostParentId` given and no
`rides_parent_id` stamped), and `host_missing` are added when the ids
themselves don't resolve.

`self_link`, `host_is_rider`, `cross_customer`, `host_missing`, `not_a_rider`,
`rider_not_found`, and `not_recurring` are **structural blockers** — the plan
is uncomputable, not merely "the office wouldn't act on it today," so plan
computation is skipped entirely for these. Every other reason (a policy gate:
customer held, duplicate series, a stopped decision, a different property,
…) still lets the plan compute and display — a blocked pair still shows the
office what it WOULD do.

### Customer gates

Reused from `server/services/series-customer-eligibility.js` — the same
table-driven rule set the nightly visit-count top-up applies
(`seriesCustomerSkipReason`): `customer_deleted`, `customer_service_held` (a
genuine hand-set hold; `autopay_final_failure` alone never holds scheduling —
see that file's own comment), `customer_inactive`, `customer_churned`.

### Series gates

Reused **read-only** from `routes/admin-schedule.js#topupSeriesSkipReason` —
the same annual-prepay / family-plan-hold / duplicate-active-series checks
the nightly top-up applies before adding a visit: `annual_prepay_series`,
`plan_hold`, `duplicate_series`. The write engine (and the nightly top-up
itself) takes a per-customer advisory try-lock before calling this — the
preview does **not**: a lock is meaningless (and would silently no-op) for a
read that commits nothing. `admin-schedule.js` gained one export for this —
see "What changed in admin-schedule.js" below.

### Host dates

Base rows only (`is_recurring = true`), null-safe status (a legacy row with
no stamped status still counts as a live host date — a bare `whereNotIn` on
a nullable column silently drops every NULL-status row otherwise), same
property as the host parent per row (a host recurring-child row whose own
`property_id` has drifted from the parent's is never read as a host date —
the per-row twin of the `different_property` pair gate), future
(`scheduled_date >= today`), not join-ineligible (completed / cancelled /
skipped / no_show / rescheduled). A host **booster** row (`is_recurring =
false` — a one-off extra visit riding the host's cadence, never part of it)
is never read as a host date.

### Rider rows and movability

Base rows only. **Movable** = `status IN (pending, confirmed)` AND not
immovable. **Immovable** (each reported in `pinned[].why`):

| why | condition |
|---|---|
| `in_progress` | status is `en_route` or `on_site` |
| `prepaid` | `prepaid_amount` is set |
| `customer_confirmed` | `customer_confirmed = true` |
| `field_confirmed` | `field_confirmed_at` is set |
| `visit_id` | grouped onto a visit |
| `arrival_sms_sent` | `arrival_sms_sent_at` is set |
| `prep_sent` | `prep_sent_at` is set |
| `invoice` | an `invoices` row references this service |
| `card_hold` | an `estimate_card_holds` row, status not in `released/cancelled/failed/expired` |
| `card_request` | an `appointment_card_requests` row, same DEAD-status exclusion |
| `closeout_packet` | a `visit_completion_packet_items` row |
| `completion_claim` | a live `service_completion_attempts` row |
| `messaged` | a `messaging_audit_log` row with `sent_at` set, any purpose except `appointment_cancellation` — the one durable record of an actual customer-facing send; `appointment_reminders`' own `*_sent` flags are bookkeeping, not proof of a send (a sibling-suppressed registration stamps them true with no send at all) |
| `null_status` | the row has no stamped status — a legacy live row, never movable, but still a real row |
| `near_term` | within `NEAR_TERM_DAYS` of today — close enough the customer may already be acting on it |
| `other_status` | any other non-terminal, non-movable status |

A terminal row (completed / cancelled / skipped / no_show / rescheduled) is
never reported in `pinned` — it's history, not a movability question.

### Anchor

Only a `completed` row, or a live pinned (immovable) row, anchors the plan —
never a movable (pending/confirmed, unpinned) row, and **never** a
cancelled/skipped/no_show/rescheduled row, however recent or however many
immovable-looking stamps it still carries (a leftover invoice or sent-message
stamp on a cancelled row must never restart the plan from a visit that never
happened). A NULL-status row **can** anchor (it's a real live row) even
though it can never move. No completed/pinned row at all falls back to the
rider parent's own `scheduled_date`.

## What the preview reports

`scripts/rider-series-preview-report.js` — read-only, `--json` for
machine-readable output, `--eligible-only` to filter. Finds every candidate
pair (same customer, same `customer_properties` row, an active ongoing lawn
`every_6_weeks` series + an active ongoing pest `quarterly` series, matched
by the shared `familyOfServiceRow` classifier — never by reading
`rides_parent_id`, since nothing sets it) inside one `SET TRANSACTION READ
ONLY` snapshot, then prints `previewRiderPair`'s answer for each: eligible or
not (and every reason), the anchor/horizon/plan, and the keep/move/insert/
cancel/pinned breakdown. Prints customer and series **ids only, never a
customer name** — same convention as
`server/scripts/dunning-adopt-orphans-dry-run.js`.

## Why nothing is linked yet

`scheduled_services.rides_parent_id` (migration
`20260928220000_scheduled_services_rides_parent`, copied verbatim from the
write engine branch — it was already pushed and run against a preview
database) is schema-only: nullable, self-referencing, `ON DELETE SET NULL`.
Nothing in this repository sets or reads it on real data. The ops report
finds candidate pairs by its own heuristic and previews them with an
explicit `hostParentId`, exactly as PR 2 (estimate accept) and PR 3 (existing
customers) would once they exist.

## Why a preview first

The write engine (rider link core + `syncRiderSeries`, moving/inserting/
cancelling real rows) went through five Codex review rounds on PR #5268
without converging on a clean round — locking order across two directions of
entry (a rider's own hook vs. a host's own hook), the cancellation
follow-through's after-commit timing through a savepoint, the horizon's
runaway-growth bound, host-tech/window join semantics — real correctness
issues, each fixed, each round finding the next one. Owner decision
2026-09-28: split the read side out first. Every rule above was settled
across those five rounds; this PR reuses the exact same pure functions
(`planRiderDates`, `computeRiderHorizon`) and the exact same reused
eligibility checks, so nothing here re-litigates a settled rule — it only
removes every write, lock, and transaction boundary the write engine needed
and none of which a preview does. The write engine resumes as PR #5268 once
the office has seen what the rule actually does to real customers.

## What changed in `admin-schedule.js`

No behavior change. Two edits:

- `module.exports.topupSeriesSkipReason = topupSeriesSkipReason`: the
  existing series-eligibility function the nightly top-up already uses,
  now reachable read-only from `services/rider-series-preview.js`. No
  lock is taken on that path.
- `topupCustomerSkipReason` now calls
  `services/series-customer-eligibility.js#seriesCustomerSkipReason`
  instead of an inline copy of the same four rules (identical rows, in the
  same order), so the preview and the top-up read one table and can't drift.

No hook, no new call site, no lock added or removed.

## Not in scope (this PR)

No hook in `admin-schedule.js`, the seeder, or the scheduler. No nightly
reconcile. No job-status changes. No write of any kind. See PR #5268 for all
of the above.
