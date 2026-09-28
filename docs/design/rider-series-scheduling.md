# Rider series scheduling (pest rides the lawn rhythm)

Scope doc: `~/lawn-pest-rhythm-scope-20260928.md`. Owner ruling 2026-09-28:
lawn every 6 weeks + quarterly pest should ride together — pest takes every
other lawn visit instead of running its own independent quarterly series
that drifts apart over time. This doc covers PR 1: the rider-series core
engine. PR 2 (estimate accept sets the link) and PR 3 (existing-customer
backfill) are separate, later PRs — nothing in PR 1 sets the link on real
data.

## Why a shared interval alone doesn't hold

Configuring two series with the same effective interval (lawn 42 days,
pest 84 days) looks sufficient on paper, but two existing mechanisms break
it in production:

1. **Completion auto-extend** (`runRecurringSeriesMaintenanceLocked`,
   `routes/admin-schedule.js`) walks each series forward from its OWN
   latest visit, independently. A weekend shift or blackout nudge on one
   series never becomes the other's anchor, so the two series drift apart
   visit by visit.
2. **The clash probe** (`seriesCandidateDateClashes`) is tech-blind and
   reads the customer's OWN lawn visit as a scheduling conflict, so an
   aligned pest date gets skipped to the next cadence step instead of
   landing on the lawn's stop.

So the rider needs an explicit link to the host series and an engine that
derives its dates from the host's actual dates — not just a matching
interval.

## The link

`scheduled_services.rides_parent_id` (nullable, self-referencing FK,
`ON DELETE SET NULL`) — set on a series PARENT row only, pointing at
another series' parent row. When set, that series is a **rider**; the
series it points at is its **host**. Both parent and child rows are looked
up by `id = parent OR recurring_parent_id = parent`, same as every other
series-maintenance query in this codebase.

The link is one level deep. Sync refuses a series that rides itself
(`self_link`) and a host that itself rides another series
(`host_is_rider`), so links never chain or cycle.

Sync also refuses a rider that is not a genuine, currently-ongoing series
root at its own address: a non-root row (`not_series_root`), a non-recurring
row (`not_recurring`), a `recurring_ongoing`-false series (`not_ongoing`),
one whose latest resolved `recurring_plan_alerts` decision is `cancel_series`
or `let_lapse` (`plan_stopped` — a defense-in-depth check independent of the
flag, since it and `not_ongoing` normally agree), and a rider whose host sits
at a different, both-known `property_id` (`different_property` — a host at
another address must never lend its tech/window to a visit at the rider's
own address). These exist because the host-extend hook and the nightly
reconcile reach a rider with no other per-action gate: a customer who
cancels just the pest series (which clears `recurring_ongoing` and records
`cancel_series`) but keeps lawn would otherwise get fresh, billable pest
rows re-inserted the next time lawn extends.

## The date rule

`server/services/rider-series.js#planRiderDates` — pure, no DB:

- `MIN_GAP_DAYS = 77`, `TARGET_GAP_DAYS = 84`, `MAX_WAIT_DAYS = 105`.
- Repeatedly: the next rider date is the first live host date at least
  `MIN_GAP_DAYS` after the rider's last date. If no host date falls within
  `MAX_WAIT_DAYS`, the rider places its own `TARGET_GAP_DAYS` standalone
  date instead (weekend-shifted the same way the seeder shifts a normal
  seeded date).
- Continues until `horizonDate`.
- Never plans before `earliestDate`. The sync passes the day after the
  7-day near-term window, whose rows are immovable. A lapsed rider's anchor
  (its last completed visit) can be months old, and walking from it would
  otherwise plan past dates. When a step would land before the floor, the
  rider is overdue: it takes the first host date within
  `OVERDUE_WAIT_DAYS` (28) of the floor, else a standalone date on the
  floor, and the walk continues normally from there.
- A standalone fallback date also clears owner blackout days (the shared
  `scheduling/blackout-dates.getBlackoutLayers` lookup, forward-only —
  `planRiderDates`'s optional `blackoutDates` parameter), the same nudge
  the seeder's own generator applies to every date it walks. A host date is
  already the host series' own, already-cleared, date and is never
  re-nudged.

With lawn at a steady 42-day cadence, this lands the rider on every 2nd
lawn date (84-day gaps). A skipped, paused or ended host falls back to its
own 84-day cadence rather than lapsing.

## The reconciler

`syncRiderSeries(conn, riderParentId, { dryRun })`:

1. Loads the rider parent; no-ops unless `rides_parent_id` is set.
2. Locks the host's and the rider's per-parent recurring-series-maintenance
   advisory lock (the SAME lock `acquireRecurringSeriesMaintenanceLock` in
   `routes/admin-schedule.js` uses, key derivation copied verbatim — see
   that function's own comment on why the derivation must stay
   byte-identical), then the shared customer-comms lock — every one of the
   three is **non-blocking** (`pg_try_advisory_xact_lock` /
   `tryLockCustomerComms`; a miss on any of them skips with `host_locked` /
   `rider_locked` / `customer_locked`, writing nothing) — see "Locking"
   below.
   Before the comms lock, the locked read also runs the rider-liveness and
   different-property gates from "The link" above (`not_series_root` /
   `not_recurring` / `not_ongoing` / `plan_stopped` / `different_property`)
   — see `riderLivenessSkipReason`. After the comms lock it reads the
   customer `FOR SHARE NOWAIT` and applies the same eligibility table as
   the visit-count top-up (`services/series-customer-eligibility.js`): a
   deleted, genuinely held, inactive or churned customer skips with that
   reason, and a locked customer row skips with `customer_row_locked`.
   It then takes the annual-prepay namespace as a try-lock and applies the
   top-up's series rules to the rider (`prepayLockedSeriesSkipReason`,
   `routes/admin-schedule.js`): an annual-prepay series, a family on plan
   hold or a duplicate active series skips with that reason. A prepaid
   term owns its own visit count and dates, so a prepaid pest series does
   not ride lawn. New rider rows never copy `annual_prepay_term_id`.
3. Host dates = the host's live future rows (parent + children,
   `JOIN_INELIGIBLE_STATUSES` excluded, `>= today`).
4. `lastRiderDate` (the anchor) = the rider's latest row that is
   `completed` OR **immovable**: en_route/on_site, an invoice linked, a
   prepaid stamp, any card hold or appointment-card request that is not
   `released` / `cancelled` / `failed` / `expired` (checked by what is
   dead, so an in-flight or future status pins the row), a `visit_completion_packet_items` row, a live
   `service_completion_attempts` claim, `customer_confirmed` /
   `field_confirmed_at` set, a **non-null `visit_id`** (a grouped row's
   date is kept in sync with its `service_visits` stop only through
   visit-groups.js's own move paths — a plain UPDATE here would desync
   it), a **real, delivered customer-facing send about THIS row** (the
   `messaging_audit_log` ledger — `appointment_id` = this row's id,
   `purpose` in `appointment_confirmation` / `appointment_reminder_72h` /
   `appointment_reminder_24h`, `sent_at IS NOT NULL` — the one durable
   record of an actual send tied to a row, per
   `appointment-reminders.js#safeSend`'s own comment; never the
   `appointment_reminders` ledger's `confirmation_sent` / `reminder_72h_sent`
   / `reminder_24h_sent` flags, which are bookkeeping and get set true with
   NO send at all on a `sendConfirmation:false` registration, the cron's
   self-heal insert, or — critically — a sibling-suppressed registration,
   the exact shape a rider row takes the moment it joins its host's
   date/window; pinning on those flags made every synced rider row
   immovable within ~15 minutes and would have aligned nothing for PR 3's
   backfill), or this row's own `arrival_sms_sent_at` / `prep_sent_at`
   stamps (each genuinely claimed/confirmed around a real send —
   `track-transitions.js` / `prep-guide-sender.js`; `confirmation_sms_sent_at`
   and this row's own `scheduled_services.reminder_24h_sent` column are
   never checked — neither has a writer anywhere in server code, so both
   always read false/null — owner ruling: existing customers' pest dates
   move with NO texts, so a row the customer has actually been told about
   is fixed), or **scheduled within the next `NEAR_TERM_DAYS` (7) days**
   of today. Conservative by design — never move or cancel a row the
   business or the customer is already committed to, and the immovable
   lookups themselves **fail closed**: a query error aborts that rider's
   whole sync (logged, `skipped: 'error'`, savepoint-rolled-back) rather
   than treating an unprovable row as movable. With no completed/immovable
   row at all (a brand-new rider), the anchor falls back to the rider
   parent's own `scheduled_date`.
   A cancelled, skipped, no-show or rescheduled row is never an anchor,
   even when it is near-term or still carries a leftover `visit_id`,
   invoice or sent-reminder stamp: only a completed row or a LIVE
   immovable row counts.
5. Horizon = the LATER of the host's last live future date and the
   rider's own standalone horizon (the anchor, or the plan floor if later,
   plus `plannedVisitCountForPattern(pattern) * TARGET_GAP_DAYS` days — the
   same visit count the seeder would plan for that pattern in a year,
   spaced at the rider's own fallback interval), computed by
   `computeRiderHorizon` (exposed via `_internals` so tests can derive the
   same horizon a real sync would). Clamping to just the host's last date
   whenever it has any future row at all — the pre-fix rule — lapsed a
   rider the instant its host was ending, however soon: the plan came back
   empty and every movable rider row got cancelled as surplus. A host with
   a single remaining row now still leaves the rider its own fallback
   cadence for everything past that row. Since the anchor can itself
   advance between sync passes (a row landing on a host date can become
   immovable — completed, or grouped via `visit_id` — which makes IT the
   new anchor), the horizon can grow between passes too; convergence to a
   stable plan can take more than one sync, same as any other maintenance
   sweep that re-derives its state from scratch each time.
6. `planRiderDates` computes the plan; it's diffed against the rider's
   current **movable** future rows (live, non-immovable, and dated
   strictly after the anchor — the anchor row itself is never a diff
   candidate, see "Why the anchor is excluded" below):
   - A row already on a planned date: **kept**. When that date is a host
     date whose `window_start` / `window_end` / `technician_id` has since
     drifted from the kept row's own (the host was re-windowed or
     reassigned with no date change, and grouping was off or ineligible so
     the row never picked it up another way), the row is additionally
     **refreshed** onto the host's current fields — reported as its own
     `refresh` list, separate from `move` (a kept row's date never
     changes). A second sync after a refresh is a no-op: the fields now
     match.
   - An unmatched movable row and an unmatched planned date are paired in
     date order (**move** the row; when the target date is a host date,
     its `window_start` / `window_end` / `technician_id` come along so the
     rider actually joins that stop). When the target is NOT a host date
     (a standalone fallback), the destination is treated like any other
     series writer's own insert target: the row's technician is re-resolved
     for assignability/absence on that date (`assignableRecurringTemplateTechnicianId`
     — nulled, never left on someone ineligible or marked out), and the
     shared occupancy clash probe (`seriesCandidateDateClashes`) runs; a
     clash skips this ONE pairing for this sync (logged, row left where it
     is) rather than double-booking — a later sync re-diffs and retries.
     Host-date targets are exempt from both checks: they intentionally
     join the host's own already-placed, already-conflict-cleared stop.
   - A planned date with no row left to pair: a new row is **inserted**,
     built off the series PARENT with `recurring_template_overrides`
     applied (`overlayRecurringTemplateOverrides` — the same canonical
     template `extendSeriesOnceLocked` /
     `runRecurringSeriesMaintenanceLocked` derive before copying anything
     from `parent`), never the rider's own latest occurrence — an
     occurrence-only ("this only") edit on the latest row must never
     become the future template; only an "apply to following" edit
     (which writes `recurring_template_overrides`) does. The insert copies
     a field allowlist (price, discount, service identity, property — the
     same fields `buildRecurringFollowUpRows` and `extendSeriesOnceLocked`
     stamp on a normal seeded/extended child; never re-derived) through
     the `createScheduledService` booking contract, then mirrors the
     PARENT's own add-on lines run through `filterAddonLinesForDate` for
     THIS insert's date (`insertRecurringChildAddons` — the same due-date
     filter every other recurring writer applies; never a verbatim clone
     of one occurrence's add-ons, which would ignore each add-on's own
     recurrence envelope, e.g. a one-time fee). A standalone (non-host)
     insert date gets the same tech-absence resolution and occupancy clash
     probe a standalone move does, described above.
   - A movable row with no planned date left to pair: cancelled through
     `transitionJobStatus` (`notifyCustomer: 'caller_suppress'`, reason
     `rider_resync`) — never hard-deleted.
   - Every insert/move/refresh calls `visit-groups.maybeGroupRow` so a
     rider lands in the same visit as its host stop.
7. `dryRun: true` returns the same `{ keep, move, refresh, insert, cancel }`
   shape and writes nothing.

**No customer communication.** Inserted/moved rows get their reminder rows
from the existing self-heal sweep (`selfHealMissingReminderRows`, no
confirmation text) or the silent-move DB trigger
(`scheduled_services_sync_reminder`) — the same mechanisms every other
seeded or silently-moved row already relies on. Cancels go through
`transitionJobStatus` with `notifyCustomer: 'caller_suppress'`.

### Why the anchor is excluded from the movable set

Every planned date is, by construction, strictly after the anchor. If the
anchor's own row were included in the "movable" set, it could never match
a planned date and would be moved or cancelled on its own sync — a
non-idempotent, self-inflicted churn (the very next sync would need to
move it right back, or would treat wherever it landed as a NEW anchor and
drift the whole plan). Excluding it, and any other row dated on or before
it, is also the conservative choice: the plan only concerns what comes
after the anchor.

## Locking

The recurring-series-maintenance advisory lock is taken for BOTH the
host's and the rider's parent id, then the shared customer-comms lock —
all three **non-blocking** (`pg_try_advisory_xact_lock` /
`tryLockCustomerComms`, never the blocking `lockCustomerComms` — the whole
deadlock-safety argument below depends on EVERY lock this module takes
being a try-lock, so a blocking exception would quietly break it).
`syncRiderSeries` is reached from both directions — a rider's own
completion/top-up/alert hook already holds the RIDER's lock before calling
in, and a host's seed/extend hook already holds the HOST's lock before
calling in — so a fixed blocking order (host-then-rider, matching the
`scheduling/occupancy.js` ORDERING CONTRACT convention) isn't achievable
from every call site without releasing and re-acquiring a lock mid-
transaction, which `pg_advisory_xact_lock` doesn't support. Non-blocking
acquisition on whichever lock isn't already held makes a deadlock
structurally impossible (a try-lock never waits): on contention, this sync
is skipped for that pass (`skipped: 'host_locked'` / `'rider_locked'` /
`'customer_locked'`) and the nightly reconcile retries it.

## Hooked paths vs the nightly reconcile

**Hooked (sync fires in-band):**
- A rider's own visit completing (`runRecurringSeriesMaintenanceLocked`).
- A rider's own horizon top-up (`topUpRecurringSeriesLocked`).
- A rider's plan-ending alert action, but only for `extend` /
  `convert_ongoing` (`runRecurringAlertAction`) — `let_lapse` deliberately
  does NOT take the rider-sync detour: it falls through to the SAME
  series-wide `recurring_ongoing = false` clear + alert-resolution logic
  every other series gets. The rider branch used to run for every action
  and return before that clear ever executed, so "let this rider lapse"
  resynced (extended) it instead of stopping it. `convert_ongoing` on a
  rider flips `recurring_ongoing = true` series-wide BEFORE syncing (the
  same series-wide flip the non-rider `convert_ongoing` branch does) —
  syncRiderSeries refuses a not-yet-ongoing rider (see "The link" above),
  and reviving a lapsed plan needs the flag set first.
- A host gaining rows via the seeder (`seedFollowUpsForParent`), auto-
  extend, or top-up (`extendSeriesOnceLocked`, shared by both) — every
  rider whose `rides_parent_id` points at that host is synced in the same
  breath, best-effort (a sync failure is logged and never fails the host
  write).

**Left to the nightly reconcile** (`server/services/rider-series-
reconcile.js`, registered in `scheduler.js` under `GATE_CRON_JOBS`, same
convention as `recurring-series-topup.js`): the admin "make recurring" /
cadence-rewrite spawn paths in `routes/admin-schedule.js`'s update-details
handler. Those paths are deliberately not hooked in PR 1 — they're rare,
manual, admin-initiated edits (not the steady-state automated maintenance
loops), and the diff/pricing logic they carry is large enough that forcing
a rider-aware branch through it risked more than PR 1's scope justified.
The nightly sweep resyncs every parent with `rides_parent_id` set, so any
drift from an un-hooked path is caught within 24 hours.

## Tests

- `server/tests/rider-series-plan.test.js` — the pure date rule.
- `server/tests/rider-series-sync-postgres.test.js` — the reconciler
  against real migrated PostgreSQL: a lawn every_6_weeks + quarterly pest
  pair seeded through the real seeder, an immovable (invoiced) anchor, dry
  run, idempotence, and the real completion auto-extend path. Also covers:
  the parent+overrides insert template (never the latest occurrence), the
  due-date-filtered add-on copy, `let_lapse` clearing `recurring_ongoing`
  instead of resyncing, `convert_ongoing` flipping the flag before syncing,
  `not_ongoing`, the standalone-date occupancy clash and tech-absence
  checks, the kept-row window/tech refresh, the `messaging_audit_log`-based
  immovability (including the sibling-suppressed-registration
  fail-without-fix case), and the `not_series_root` / `plan_stopped` /
  `different_property` liveness gates.
- `server/tests/rider-series-lock-parity.test.js` — the shared advisory
  lock's key derivation stays byte-identical to
  `acquireRecurringSeriesMaintenanceLock`.
- `server/tests/rider-series-reconcile.test.js` — the nightly sweep's job-
  health summary: a per-rider `skipped: 'error'` counts toward
  `summary.errors`, never `summary.skipped`, so a run where every rider
  genuinely failed cannot read as a quietly healthy `skipped: N`.
