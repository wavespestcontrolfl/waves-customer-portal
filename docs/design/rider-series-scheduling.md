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

## The date rule

`server/services/rider-series.js#planRiderDates` — pure, no DB:

- `MIN_GAP_DAYS = 77`, `TARGET_GAP_DAYS = 84`, `MAX_WAIT_DAYS = 105`.
- Repeatedly: the next rider date is the first live host date at least
  `MIN_GAP_DAYS` after the rider's last date. If no host date falls within
  `MAX_WAIT_DAYS`, the rider places its own `TARGET_GAP_DAYS` standalone
  date instead (weekend-shifted the same way the seeder shifts a normal
  seeded date).
- Continues until `horizonDate`.

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
3. Host dates = the host's live future rows (parent + children,
   `JOIN_INELIGIBLE_STATUSES` excluded, `>= today`).
4. `lastRiderDate` (the anchor) = the rider's latest row that is
   `completed` OR **immovable**: en_route/on_site, an invoice linked, a
   prepaid stamp, an active/charged card hold or an approved appointment-
   card request, a `visit_completion_packet_items` row, a live
   `service_completion_attempts` claim, `customer_confirmed` /
   `field_confirmed_at` set, a **non-null `visit_id`** (a grouped row's
   date is kept in sync with its `service_visits` stop only through
   visit-groups.js's own move paths — a plain UPDATE here would desync
   it), a **reminder or confirmation already sent** (the authoritative
   `appointment_reminders` ledger's `confirmation_sent` /
   `reminder_72h_sent` / `reminder_24h_sent`, or this row's own
   `confirmation_sms_sent_at` / `reminder_24h_sent` / `arrival_sms_sent_at`
   / `prep_sent_at` stamps — owner ruling: existing customers' pest dates
   move with NO texts, so a row the customer has already been told about
   is fixed), or **scheduled within the next `NEAR_TERM_DAYS` (7) days**
   of today. Conservative by design — never move or cancel a row the
   business or the customer is already committed to, and the immovable
   lookups themselves **fail closed**: a query error aborts that rider's
   whole sync (logged, `skipped: 'error'`, savepoint-rolled-back) rather
   than treating an unprovable row as movable. With no completed/immovable
   row at all (a brand-new rider), the anchor falls back to the rider
   parent's own `scheduled_date`.
5. Horizon = the host's last live future date, or (host has none) the
   anchor plus `plannedVisitCountForPattern(pattern) * TARGET_GAP_DAYS`
   days — the same visit count the seeder would plan for that pattern in a
   year, spaced at the rider's own fallback interval.
6. `planRiderDates` computes the plan; it's diffed against the rider's
   current **movable** future rows (live, non-immovable, and dated
   strictly after the anchor — the anchor row itself is never a diff
   candidate, see "Why the anchor is excluded" below):
   - A row already on a planned date: kept, untouched.
   - An unmatched movable row and an unmatched planned date are paired in
     date order (move the row; when the target date is a host date, its
     `window_start` / `window_end` / `technician_id` come along so the
     rider actually joins that stop).
   - A planned date with no row left to pair: a new row is inserted, built
     off the rider's own most recently dated row (a field allowlist —
     price, discount, service identity, property — the same fields
     `buildRecurringFollowUpRows` and `extendSeriesOnceLocked` stamp on a
     normal seeded/extended child; never re-derived), through the
     `createScheduledService` booking contract.
   - A movable row with no planned date left to pair: cancelled through
     `transitionJobStatus` (`notifyCustomer: 'caller_suppress'`, reason
     `rider_resync`) — never hard-deleted.
   - Every insert/move calls `visit-groups.maybeGroupRow` so a rider lands
     in the same visit as its host stop.
7. `dryRun: true` returns the same `{ keep, move, insert, cancel }` shape
   and writes nothing.

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
- A rider's plan-ending alert action (`runRecurringAlertAction`).
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
  run, idempotence, and the real completion auto-extend path.
