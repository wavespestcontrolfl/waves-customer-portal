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

Constants (`server/services/rider-series-preview.js`, same values as the
write engine's own `server/services/rider-series.js`):

| constant | value | meaning |
|---|---|---|
| `MIN_GAP_DAYS` | 77 | earliest a host date can be picked |
| `TARGET_GAP_DAYS` | 84 | the standalone fallback gap |
| `MAX_WAIT_DAYS` | 105 | latest a host date can be picked before falling back |
| `NEAR_TERM_DAYS` | 7 | a window this close is a fixed anchor, never planned into |
| `OVERDUE_WAIT_DAYS` | 28 | `MAX_WAIT_DAYS - MIN_GAP_DAYS` |
| `MAX_HORIZON_EXTRA_DAYS` | 730 | horizon cap past the standalone horizon |

Gaps per rider cadence (`RIDER_GAPS`, owner ruling 2026-10-01, second batch).
The three constants above are the quarterly row. On a monthly lawn host (28 to
35 days between visits) `min` sits between k−1 and k lawn gaps, so the rider
takes every k-th lawn visit:

| rider cadence | min | target | max | lawn visit taken |
|---|---|---|---|---|
| `monthly` | 21 | 28 | 49 | every visit |
| `bimonthly` | 49 | 56 | 77 | every 2nd |
| `quarterly` | 77 | 84 | 105 | every 3rd (every 2nd on a 6-week lawn) |
| `semiannual` | 161 | 182 | 196 | every 6th |
| `seasonal_feb_oct` | 21 | 28 | 49 | every Feb–Oct visit |

A seasonal rider never takes a Nov–Jan lawn date. Its wait does not run
through the winter: a window that starts off season starts on the season's
first day, and one that only ends off season stays open the same number of
days into the next season. With no lawn date to take it stands alone on its
own Feb–Oct walk date. A cadence with no row is planned with the quarterly
gaps. Which host may carry which rider is `RIDER_PAIRINGS`; its `gated` rows
(bi-monthly pest or tree & shrub, monthly pest, semiannual pest and seasonal
mosquito, all on a monthly lawn) are open only while
`GATE_RIDER_PAIRS_MONTHLY_LAWN` is on.

`planRiderDates` (pure, no DB) and `computeRiderHorizon` apply the SAME rule
the write engine uses — copied, not re-derived, so the preview and the
eventual write engine can never silently disagree about "what the plan is."
`server/tests/rider-series-preview-plan.test.js` is the write engine's own
`rider-series-plan.test.js` (branch `feat/pest-rides-lawn-core-20260928`, PR
#5268), copied verbatim except its require path — all 19 cases pass
unchanged.

**Not byte-identical to PR #5268 any more** (Codex P2 round, this repo's PR
#5290): `planRiderDates`' own decision count was over this repo's complexity
warning ceiling (20; AGENTS.md), so its per-step candidate-selection logic
(the min/max/overdue window, the host-date-vs-standalone-fallback choice, the
weekend shift, the blackout clear) is factored into a helper, `nextRiderDate`
— same operations, same order, called once per loop iteration, so the RESULT
is identical (proved by the same 19 tests) even though the source is no
longer a literal copy of `rider-series.js#planRiderDates`. Unresolved: when
PR #5268 resumes, either it adopts the same split or this note is corrected
to "same rule, not same source" for good.

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
- `different_property` — the rider's and the host's resolved property scope
  (below) disagree — never guessed from a raw `property_id` compare alone.
- `not_series_root` — the id given is a child row, not a series parent.
- `not_recurring` — the rider has no `recurring_pattern`.
- `not_ongoing` — the rider's `recurring_ongoing` flag is false.
- `plan_stopped` — the rider's latest resolved `recurring_plan_alerts`
  decision is `cancel_series` or `let_lapse`.
- `property_unresolved` — the rider's or the host's resolved property scope
  (below) couldn't be resolved at all: no `property_id`, no parseable
  address anywhere, not even the customer's own primary address. Refuses
  conservatively rather than guessing the pair shares a property.
- `rider_reschedule_pending` — at least one live rider row (parent or child)
  is `status = 'rescheduled'`: a visit awaiting re-placement, not history.
  See "Rider rows and movability" below — the conservative choice is to
  block eligibility (so the office can't plan an insert that would
  duplicate that row) rather than silently skip past it; the plan still
  shows.

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
table-driven rule set the nightly visit-count top-up applies:
`customer_deleted`, `customer_service_held` (a genuine hand-set hold;
`autopay_final_failure` alone never holds scheduling — see that file's own
comment), `customer_inactive`, `customer_churned`. The top-up itself keeps
calling the original first-hit `seriesCustomerSkipReason` (byte-identical —
a write path only ever needs ONE reason to skip). The preview calls the
all-hits twin, `seriesCustomerSkipReasons`, added alongside it: same table,
same order, never short-circuited, so `reasons` can list every applicable
customer gate rather than hiding a second one behind the first.

### Series gates

Reused **read-only** from `routes/admin-schedule.js` — the same annual-prepay
/ family-plan-hold / duplicate-active-series checks the nightly top-up
applies before adding a visit: `plan_hold` and `duplicate_series`. The
top-up's `annual_prepay_series` refusal does not apply to a rider (owner
ruling 2026-09-29): a prepaid pest series rides too, its prepaid visits stay
pinned (`prepaid`), and only the visits after them join lawn dates. The write engine (and the nightly top-up itself) takes a
per-customer advisory try-lock before calling this — the preview does
**not**: a lock is meaningless (and would silently no-op) for a read that
commits nothing. As with the customer gates, the top-up's own first-hit
`topupSeriesSkipReason` is untouched; the preview calls the all-hits twin,
`topupAllSeriesSkipReasons` (same `TOPUP_SERIES_INELIGIBILITY_RULES` table,
looped without the early return). `admin-schedule.js` gained these exports
— see "What changed in admin-schedule.js" below.

**Reads the OVERLAID rider parent (Codex P2 round #2 on PR #5290):** these
gates are called with `overlayRecurringTemplateOverrides(riderParent, cols)`,
not the raw row — the same overlay `topUpRecurringSeriesLocked` applies to
`parent` BEFORE calling `topupSeriesSkipReason` itself. `isFamilyOnPlanHold`
and `isDuplicateActiveSeries` both classify the series' family straight off
whichever `parent` object they're handed (`service_id`/`service_type`); a
series-scope price/service edit (`recurring_template_overrides`, gated by
`GATE_EDIT_APPT_PRICE_SERVICE_SCOPE`) redirects those fields, so reading the
raw, pre-override row here would classify the series by a service it no
longer is — the one thing this preview exists to never disagree with the
top-up about.

### Property scope

`different_property` and `property_unresolved` (above) are decided by
`resolveSeriesPropertyScope(conn, parent)` + `seriesPropertyVerdict(a, b)`
(`services/rider-series-preview.js`, exported for the report script to reuse
— see "What the preview reports" below), not by a raw `property_id` compare.
Each root's scope is resolved with the SAME address resolution the
duplicate-series guard scopes on (`admin-schedule.js#topUpScopeInput`: the
override-aware stamped address, else an unstamped root's own source
estimate, else the customer's primary address), then reduced to a
comparable key with `estimate-property-linkage.js`'s canonical
`normalizedEstimatePropertyKey` / `samePropertyKey` ("identical street+unit
in different cities/ZIPs are DISTINCT properties" — the same primitive the
duplicate-series guard's own street compare is built from). `property_id`
decides when BOTH sides carry one (authoritative, no street compare); else
the normalized key decides; either side unresolved (no `property_id`, no
parseable address anywhere) reports `property_unresolved` rather than
guessing a match. This replaces the earlier, narrower rule ("only checked
when BOTH parents already had a stamped `property_id`") — a pair where one
or both sides are unstamped now actually resolves an address instead of
silently passing the gate.

### Host dates

Base rows only (`is_recurring = true`), null-safe status (a legacy row with
no stamped status still counts as a live host date — a bare `whereNotIn` on
a nullable column silently drops every NULL-status row otherwise), same
EFFECTIVE property scope as the host parent per row, future
(`scheduled_date >= today`), not join-ineligible (completed / cancelled /
skipped / no_show / rescheduled). A host **booster** row (`is_recurring =
false` — a one-off extra visit riding the host's cadence, never part of it)
is never read as a host date.

**"Same EFFECTIVE property scope" (Codex P1 round #2 on PR #5290):** the
host's own resolved scope (`hostScope` — the SAME `resolveSeriesPropertyScope`
call the pair's own `different_property` gate makes, computed once in
`evaluatePairGates` and handed to `loadHostDates`) is compared against each
CANDIDATE ROW's own resolved scope (`rowPropertyScope` — the row's own
`property_id` + stamped `service_address_*` columns, reduced with the same
normalized key, but never falling back to an estimate or the customer's
primary address the way a series ROOT's own scope resolution does) via the
same `seriesPropertyVerdict` comparator. The host PARENT's own row always
matches — it IS the effective scope, however stale its own raw columns are.
A candidate row with no resolved scope of its own (no `property_id`, no
stamped address — the ordinary case for most child rows) still inherits the
host's scope, exactly as the old null-safe rule did; only a row whose OWN
resolved scope actively disagrees is dropped. This replaces the earlier rule
(compare each child row's raw `property_id` against the host PARENT's own
raw `property_id` column), which was stale the moment the host moved via
`recurring_template_overrides.appointment_address` (the parent's own column
never changes; only its effective, override-aware scope does) and skipped
filtering entirely whenever the parent's raw column happened to be null (a
drifted child row on ANY other property still counted as a host date).

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
| `messaged` | a `messaging_audit_log` row with `sent_at` set, any purpose except `appointment_cancellation` (the one durable record of an actual customer-facing send; `appointment_reminders`' own `*_sent` flags are bookkeeping, not proof of a send — a sibling-suppressed registration stamps them true with no send at all), **or** a delivered promise event from `no-show-detector.js#loadPromiseEvents` (below) |
| `rescheduled_pending` | the row's status is `rescheduled` — a live visit awaiting re-placement, not history |
| `null_status` | the row has no stamped status — a legacy live row, never movable, but still a real row |
| `near_term` | within `NEAR_TERM_DAYS` of today — close enough the customer may already be acting on it |
| `other_status` | any other non-terminal, non-movable status |

A terminal row (completed / cancelled / skipped / no_show) is never reported
in `pinned` — it's history, not a movability question. A `rescheduled` row
is the one exception: it is LIVE (awaiting re-placement, not history), so it
reports `pinned`/`rescheduled_pending` instead — see "Anchor" below for why
it still never anchors.

**`messaged` evidence (Codex P1 round, PR #5290):** a plain
`messaging_audit_log` scan keyed on `appointment_id` alone misses three real
"the customer was told" cases — a pre-2026-08-06 row linked only by
`metadata.scheduled_service_id` (that sender didn't start stamping
`appointment_id` until that date), a delivered appointment EMAIL (no SMS row
at all), and a call-derived promise (an applied phone reschedule, or the
call that booked the visit — neither ever sends a text of its own). Rather
than re-deriving that unification, the preview calls
`no-show-detector.js#loadPromiseEvents(conn, ids)` — the SAME canonical
"was the customer told" evidence the no-show detector alerts against — and
pins any row it returns an event for, alongside the existing
`messaging_audit_log` scan (either source pins; same `why: 'messaged'`).
Read-only, same posture as every other lookup here. A cancellation notice
still never pins: `loadPromiseEvents` only reads scheduling-notice purposes
(confirmation/reminder tiers) and call-derived events, never
`appointment_cancellation`.

### Anchor

Only a `completed` row, or a live pinned (immovable) row, anchors the plan —
never a movable (pending/confirmed, unpinned) row, and **never** a
cancelled/skipped/no_show row, however recent or however many
immovable-looking stamps it still carries (a leftover invoice or sent-message
stamp on a cancelled row must never restart the plan from a visit that never
happened). A NULL-status row **can** anchor (it's a real live row) even
though it can never move. A `rescheduled` row is the one case that is
`pinned` (see "Rider rows and movability" above) but **still never
anchors**: it's a live row, but its `scheduled_date` is the STALE date it's
waiting to be moved off of, not "when this last actually happened" — reading
it as the anchor would plan the next date from a date that was never really
kept. No completed/pinned-and-anchor-eligible row at all falls back to the
rider parent's own `scheduled_date` — **unless the rider PARENT ROW ITSELF is
the one awaiting reschedule** (Codex P2 round #2 on PR #5290): its own
`scheduled_date` is exactly the stale date it's waiting to be moved off of,
the same reason a rescheduled CHILD row never anchors, so falling back to it
here would silently reintroduce that stale date as "when this last actually
happened." With no other anchor-eligible row at all, this case reports no
anchor at all (`anchor: null`, empty plan) and `previewRiderPair` adds
`no_anchor` to `reasons` alongside `rider_reschedule_pending`.

## What the preview reports

`scripts/rider-series-preview-report.js` — read-only, `--json` for
machine-readable output, `--eligible-only` to filter. Finds every candidate
pair (same customer, an active ongoing lawn `every_6_weeks` series + an
active ongoing pest `quarterly` series, matched by the shared
`familyOfServiceRow` classifier — never by reading `rides_parent_id`, since
nothing sets it) inside one `SET TRANSACTION READ ONLY` snapshot, then
prints `previewRiderPair`'s answer for each: eligible or not (and every
reason), the anchor/horizon/plan, and the keep/move/insert/cancel/pinned
breakdown. Prints customer and series **ids only, never a customer name** —
same convention as `server/scripts/dunning-adopt-orphans-dry-run.js`.

**Candidate discovery excludes cancelled roots (Codex P2 round #2 on PR
#5290)**: the candidate query applies
`recurring-appointment-seeder.js#EXCLUDED_ROOT_STATUSES` (the exact
status list `findActiveRecurringSeries` excludes on ITS own candidate
roots, exported and reused rather than hand-rolled here) — a cancelled
root's `recurring_ongoing` flag is never cleared on cancel, so without this
a cancelled series still surfaced as a candidate pair.

**Candidate projection selects every field the shared resolver reads (Codex
P2 round #2 on PR #5290)**: the query now also selects
`service_address_line1/2/city/state/zip` — `resolveSeriesPropertyScope`
(via `admin-schedule.js#topUpScopeInput`) reads these stamped fields on an
already-stamped root, not just `property_id`; without them, every root with
a distinct visit-level address stamp (never an unstamped root's own
estimate/customer fallback, which reads from the DB directly) collapsed
onto the primary/customer address and mis-bucketed distinct properties as
one.

**Candidate classification (Codex P2 round, PR #5290) reads the CURRENT
template**: `overlayRecurringTemplateOverrides`
(`services/recurring-template-overrides.js`, the same function
`findActiveRecurringSeries`'s own duplicate-series scan applies to both
sides of its compare) is applied to each candidate root before
`familyOfServiceRow` classifies it, so a series reassigned via
`recurring_template_overrides.service_id` (an admin edit, gated by
`GATE_EDIT_APPT_PRICE_SERVICE_SCOPE` — the overlay is a no-op when that gate
is off, same as everywhere else it's used) is classified by its FUTURE
service, not its original one. When the override redirects `service_id`,
the catalog identity (`service_key`/`name`) is re-resolved from the new
service via a small in-memory `services` map rather than the row's original
join.

**Pairing and ambiguity (Codex P1/P2 rounds, PR #5290):** candidate pairs
are found pairwise, not by grouping roots into property buckets first. A
lawn root and a pest root of the same customer pair when their scopes,
resolved with the same resolver and comparator as the preview's
`different_property` gate (`resolveSeriesPropertyScope` /
`seriesPropertyVerdict`), match. Two roots that both fail to resolve pair
too, flagged `property_unresolved`. An unresolved root never pairs with a
resolved one. A street-only scope treats a missing city or ZIP as a
wildcard, so compatibility isn't transitive: grouping into buckets either
merged incompatible roots or lost valid pairs, depending on order.
Pairwise matching avoids both. A root compatible with more than one
counterpart flags every pair it's in as `host_ambiguous` or
`rider_ambiguous` (not eligible), so the office resolves it rather than the
report picking one. Output is ordered by customer id, then root id.

## Where the link is written

`scheduled_services.rides_parent_id` (migration
`20260928220000_scheduled_services_rides_parent`) is nullable,
self-referencing, `ON DELETE SET NULL`. It is written in ONE place: estimate
accept, behind `GATE_PEST_RIDES_LAWN_AT_ACCEPT` (`rider-accept-seeding.js`).
A quarterly rider (pest, tree & shrub, termite bait) accepted with a 6-week
or monthly lawn is seeded on lawn dates and linked only when every rider date
is a real lawn date AND the two first visits group into one stop under the
canonical visit-group rules. Nothing reads the link yet: series extension
riding the lawn is a follow-up PR, and the gate stays off until it lands. The
ops report still finds candidate pairs by its own heuristic and previews them
with an explicit `hostParentId`.

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

No behavior change to any existing exported function — every new export is
additive, and the two functions the nightly top-up itself calls
(`topupSeriesSkipReason`, `topupCustomerSkipReason`) are unchanged (round 2
below aside, which is itself a read-only refactor to a shared table, not a
rule change). Four edits:

- `module.exports.topupSeriesSkipReason = topupSeriesSkipReason`: the
  existing series-eligibility function the nightly top-up already uses,
  now reachable read-only from `services/rider-series-preview.js`. No
  lock is taken on that path.
- `topupCustomerSkipReason` now calls
  `services/series-customer-eligibility.js#seriesCustomerSkipReason`
  instead of an inline copy of the same four rules (identical rows, in the
  same order), so the preview and the top-up read one table and can't drift.
- `module.exports.topupAllSeriesSkipReasons`: an all-hits twin of
  `topupSeriesSkipReason` added for the preview (Codex P2 round, PR #5290)
  — same `TOPUP_SERIES_INELIGIBILITY_RULES` table, looped without the early
  return, so the preview's `reasons` can list every applicable series gate
  instead of only the first. `topupSeriesSkipReason` itself is untouched.
- `module.exports.topUpScopeInput`: the override-aware address resolver the
  duplicate-series guard already scopes on, now reachable read-only for the
  preview's AND the report script's own property-scope resolution
  (`resolveSeriesPropertyScope`, `services/rider-series-preview.js` — see
  "Property scope" above).

No hook, no new call site, no lock added or removed.

## Not in scope (this PR)

No hook in `admin-schedule.js`, the seeder, or the scheduler. No nightly
reconcile. No job-status changes. No write of any kind. See PR #5268 for all
of the above.

## Visits beyond the lawn schedule

The plan runs to the horizon: the host's last scheduled date or the rider's
own bounded horizon, whichever is later. A movable rider visit dated after
the horizon isn't surplus. It would join a lawn date once lawn is extended,
so the preview reports it in `beyondSchedule` and never in `cancel`.
