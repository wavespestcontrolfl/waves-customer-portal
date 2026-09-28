/**
 * Rider-series core (pest-rides-the-lawn-rhythm PR 1).
 * Scope doc: ~/lawn-pest-rhythm-scope-20260928.md ("Date rule", "PR 1").
 *
 * A rider series (e.g. quarterly pest) derives its future visit dates from
 * a host series (e.g. lawn every 6 weeks) instead of walking its own
 * interval. Nothing in this repository SETS `scheduled_services.
 * rides_parent_id` yet (PR 2 = estimate accept, PR 3 = existing-customer
 * backfill) — this module is dark by construction: every entry point below
 * is a no-op unless that column is already set on real data.
 *
 * Date rule (MIN_GAP 77 / TARGET 84 / MAX_WAIT 105 days): repeatedly, the
 * next rider date is the first live host date at least MIN_GAP days after
 * the last rider date; if none exists within MAX_WAIT days, the rider
 * places its own TARGET-day standalone date instead. See planRiderDates.
 *
 * Locking: the per-parent recurring-series-maintenance advisory lock (key
 * derivation owned by routes/admin-schedule.js#acquireRecurringSeriesMaintenanceLock,
 * reused here — see that function's own comment: "key derivation must stay
 * byte-identical across all of them or they silently stop contending") is
 * taken for BOTH the host's parent id and the rider's parent id, and the
 * customer-comms lock for the shared customer. All three acquisitions use
 * the NON-BLOCKING (wait:false) form. This module is reached from BOTH
 * directions — a rider's own completion/top-up hook already holds the
 * RIDER's lock before calling in here, and a host's extend/seed hook
 * already holds the HOST's lock before calling in here — so a fixed
 * blocking order (host-then-rider) is not achievable without releasing and
 * re-acquiring a lock mid-transaction, which pg_advisory_xact_lock does not
 * support. Non-blocking acquisition on whichever lock is not already held
 * makes a deadlock structurally impossible (a try-lock never waits): on
 * contention this sync is skipped for this pass and the nightly reconcile
 * (server/services/rider-series-reconcile.js) retries it. The order
 * host-then-rider is still followed wherever both are being acquired fresh
 * (the nightly reconcile, the seeder's post-seed hook), matching the
 * ORDERING CONTRACT convention in scheduling/occupancy.js.
 *
 * syncRiderSeries's locked body runs in four stages, in order:
 *   loadLockedRiderContext  — locks + link/eligibility gates, no writes.
 *   resolveRiderEligibility — customer + prepay-series gates, no writes.
 *   buildRiderSyncPlan      — loads host/rider rows, computes the anchor,
 *                             horizon and plan (planRiderDates), no writes.
 *   diffRiderPlan           — pure diff of the plan against movable rows.
 *   writeRiderPlan          — the only stage that writes (skipped entirely
 *                             on dryRun).
 */
const logger = require('./logger');
const {
  parseETDateTime, etDateString, addETDays, etCalendarDayOf,
} = require('../utils/datetime-et');
const { TERMINAL_ROW_STATUSES, JOIN_INELIGIBLE_STATUSES } = require('./visit-context/statuses');
const { LIVE_COMPLETION_CLAIM_STATUSES, maybeGroupRow } = require('./visit-groups');
const { transitionJobStatus } = require('./job-status');
const { overlayRecurringTemplateOverrides } = require('./recurring-template-overrides');
const { getBlackoutLayers } = require('./scheduling/blackout-dates');
const { clearOfBlackout } = require('./scheduling/blackout-nudge');
const { recurringDispatchDuePatch } = require('./scheduling/recurring-dispatch-due');
const { commitPromiseOf } = require('../utils/trx-commit-promise');

const MIN_GAP_DAYS = 77;
const TARGET_GAP_DAYS = 84;
const MAX_WAIT_DAYS = 105;
// Owner ruling: existing customers' pest dates move with NO texts — a row
// inside this window is close enough that the customer may already be
// acting on it (packing a cooler, arranging access), so it's a fixed
// anchor regardless of what any reminder/confirmation ledger shows.
const NEAR_TERM_DAYS = 7;
// How long an overdue rider (anchor so old the next step would land before
// the plan floor) waits for a host date before taking a standalone date on
// the floor: the normal window's width, MAX_WAIT_DAYS - MIN_GAP_DAYS.
const OVERDUE_WAIT_DAYS = MAX_WAIT_DAYS - MIN_GAP_DAYS;

// In-progress statuses: a visit a tech is actively on stops being a
// candidate to move or cancel, same posture as every other series writer
// (cancellation-processor.js's LIVE_TRACK_STATES / CANCELLABLE_STATUSES).
const IN_PROGRESS_STATUSES = ['en_route', 'on_site'];

// The only statuses a MOVE/REFRESH write's own guard accepts (P1 lock rows,
// PR #5268 round 2): everything else the CHECK constraint allows is either
// terminal/join-ineligible (JOIN_INELIGIBLE_STATUSES: completed, cancelled,
// skipped, no_show, rescheduled) or in-progress (IN_PROGRESS_STATUSES) —
// both already excluded from the movable set by isImmovable — so this is
// the residual "a tech hasn't touched it yet" set. Guards every
// scheduled_date/window/technician_id UPDATE this module issues so a row a
// concurrent writer (an admin edit, a completion) changed underneath this
// sync's own read is never silently overwritten: WHERE id = ? AND status IN
// (...) AND visit_id IS NULL, and a 0-row result is treated as "changed
// underneath," never retried blindly within this pass.
const MOVABLE_ROW_STATUSES = ['pending', 'confirmed'];

function dateOnly(value) {
  if (!value) return null;
  return etCalendarDayOf(value);
}

function addDaysStr(dateStr, days) {
  const base = parseETDateTime(`${dateOnly(dateStr)}T12:00`);
  if (isNaN(base.getTime())) return null;
  return etDateString(addETDays(base, days));
}

// How far PAST the rider's own standalone horizon a host date is still
// allowed to push the plan (P1 fix #7, PR #5268 round 4): ~2 years. A host
// row seeded or hand-edited an arbitrary distance out (the fail-without-fix
// scenario this bounds: one host row 10 years out) would otherwise blow the
// rider's own insert horizon out to match it, and planRiderDates' own walk
// (bounded at 1000 steps, but each step is real work: a clash probe, a
// tech-eligibility resolve, an insert) would mint years of rows in one
// sync. Deliberately relative to the rider's OWN standaloneHorizon, never
// to a real wall-clock "today": a synthetic or deliberately-future-dated
// anchor (this module's own test fixtures use one, and so can a genuine
// long-lapsed rider revived after months away) must stay convergent
// relative to ITS OWN horizon, which a wall-clock cap would clamp out from
// under it. For an ordinary rider (anchor near today), standaloneHorizon is
// itself near today, so this reads as "never beyond ~2 years from today" in
// the common case the parenthetical in the finding names.
const MAX_HORIZON_EXTRA_DAYS = 730;

// Pure — the horizon rule (P1 fix #3): the LATER of the host's own last
// live date and the rider's own standalone horizon (anchorDate +
// plannedVisitCountForPattern(pattern) * TARGET_GAP_DAYS — the same visit
// count the seeder would plan for that pattern in a year, spaced at the
// rider's own fallback interval). Clamping to "the host's last date,
// whenever it has any future row at all" (the pre-fix rule) lapses a rider
// the instant its host is ending, however soon — the plan comes back empty
// and every movable rider row gets cancelled as surplus. Then bounded (P1
// fix #7) to at most MAX_HORIZON_EXTRA_DAYS past the standalone horizon —
// see that constant's own comment. Exposed via _internals so tests can
// derive the SAME horizon a real sync would, rather than duplicating this
// formula.
function computeRiderHorizon(anchorDate, hostDates, pattern) {
  const { plannedVisitCountForPattern } = require('./recurring-appointment-seeder');
  const count = plannedVisitCountForPattern(pattern, {});
  // plannedVisitCountForPattern is a TOTAL occurrence count that already
  // includes the anchor visit itself (e.g. quarterly = 4 visits/year, the
  // first of which IS the anchor) — count - 1 is the number of FUTURE gaps
  // to plan past it (P1 fallback count fix, PR #5268 round 2). Using the
  // raw count planned one extra TARGET_GAP_DAYS step past the real one-year
  // horizon.
  const gaps = Math.max(0, count - 1);
  const standaloneHorizon = addDaysStr(anchorDate, gaps * TARGET_GAP_DAYS);
  const sorted = Array.from(new Set((hostDates || []).map(dateOnly).filter(Boolean))).sort();
  let horizon = standaloneHorizon;
  if (sorted.length) {
    const hostLast = sorted[sorted.length - 1];
    if (hostLast > horizon) horizon = hostLast;
  }
  const maxHorizon = addDaysStr(standaloneHorizon, MAX_HORIZON_EXTRA_DAYS);
  if (maxHorizon && horizon > maxHorizon) horizon = maxHorizon;
  return horizon;
}

// Same weekend-shift arithmetic the seeder applies to every date it walks
// (recurring-appointment-seeder.js#shiftPastWeekend), reused verbatim
// rather than re-derived — used only for a STANDALONE fallback date (a
// host date is already the host series' own, already-shifted, date).
function shiftPastWeekend(dateStr, skip, direction = 'forward') {
  if (!skip || !dateStr) return dateStr;
  const { shiftPastWeekend: seederShift } = require('./recurring-appointment-seeder');
  return seederShift(dateStr, skip, direction);
}

/**
 * Pure date rule — no DB access. Returns a sorted array of future rider
 * dates (each strictly after the previous, all <= horizonDate).
 *
 * @param {string[]} hostDates - the host series' live future dates
 *   (YYYY-MM-DD), any order/duplicates tolerated.
 * @param {string} lastRiderDate - the anchor: the rider's latest
 *   completed-or-immovable date (YYYY-MM-DD).
 * @param {string} horizonDate - never plan a date past this (YYYY-MM-DD).
 * @param {boolean} [skipWeekends] - the rider series' own weekend
 *   preference, applied only to a standalone fallback date.
 * @param {'forward'|'back'} [weekendShift] - the rider series' own shift
 *   direction, applied only to a standalone fallback date.
 * @param {string} [earliestDate] - never plan a date before this
 *   (YYYY-MM-DD). A lapsed rider's anchor can be months old, and the walk
 *   from it would otherwise emit past dates. An overdue step takes the
 *   first host date in [earliestDate, earliestDate + OVERDUE_WAIT_DAYS],
 *   else a standalone date on earliestDate itself.
 * @param {{dates: Set, weeklyDaysOff: Set}|null} [blackoutDates] - owner
 *   blackout days (scheduling/blackout-dates.getBlackoutLayers shape),
 *   applied only to a standalone fallback date (a host date is already the
 *   host series' own, already-cleared, date) — the same nudge the seeder's
 *   own generator applies (clearOfBlackout only ever moves FORWARD, so it
 *   can never re-cross the floor the weekend-shift step already cleared).
 *   Omitted/null plans exactly as before this parameter existed.
 */
function planRiderDates({
  hostDates = [], lastRiderDate, horizonDate, skipWeekends = false, weekendShift = 'forward',
  earliestDate = null, blackoutDates = null,
} = {}) {
  const anchor = dateOnly(lastRiderDate);
  const horizon = dateOnly(horizonDate);
  const floor = dateOnly(earliestDate);
  const dates = [];
  if (!anchor || !horizon) return dates;
  const sortedHosts = Array.from(new Set((hostDates || []).map(dateOnly).filter(Boolean))).sort();
  const dir = weekendShift === 'back' ? 'back' : 'forward';

  let last = anchor;
  // Bounded: at MIN_GAP_DAYS per step this comfortably covers any
  // realistic horizon (a 20-year horizon is ~95 steps at 77 days).
  for (let guard = 0; guard < 1000; guard++) {
    let minDate = addDaysStr(last, MIN_GAP_DAYS);
    let maxDate = addDaysStr(last, MAX_WAIT_DAYS);
    if (!minDate || !maxDate) break;
    const overdue = !!floor && minDate < floor;
    if (overdue) {
      minDate = floor;
      maxDate = addDaysStr(floor, OVERDUE_WAIT_DAYS);
    }
    const hostCandidate = sortedHosts.find((d) => d >= minDate);
    let next;
    if (hostCandidate && hostCandidate <= maxDate) {
      next = hostCandidate;
    } else {
      const base = overdue ? floor : addDaysStr(last, TARGET_GAP_DAYS);
      next = shiftPastWeekend(base, skipWeekends, dir);
      // A backward weekend shift must not cross the floor.
      if (floor && next && next < floor) next = shiftPastWeekend(base, skipWeekends, 'forward');
      if (next && blackoutDates) next = clearOfBlackout(next, blackoutDates, { skipWeekends });
    }
    if (!next || next <= last) break; // malformed input guard — never stall/reverse
    if (next > horizon) break;
    dates.push(next);
    last = next;
  }
  return dates;
}

// Non-blocking acquire of the SAME per-parent maintenance advisory lock
// admin-schedule.js#acquireRecurringSeriesMaintenanceLock uses — key
// derivation copied verbatim (namespace 'recurring-series-maintenance',
// key = String(parentId)) rather than imported, because that function is
// not exported for production reuse (only via router._test) and this
// module must never risk drifting from routes/admin-schedule.js's own copy
// silently — any future change to that key derivation must be mirrored
// here by the same rule its own comment states.
async function tryLockSeriesMaintenance(trx, parentId) {
  const result = await trx.raw(
    'SELECT pg_try_advisory_xact_lock(hashtext(?), hashtext(?::text)) AS locked',
    ['recurring-series-maintenance', String(parentId)],
  );
  return result.rows[0]?.locked === true;
}

// Non-blocking, matching the module's whole deadlock-safety argument (see
// the header): every lock this module takes is a try-lock, so the ordering
// proof (no lock here ever WAITS) holds for this one too. A blocking
// lockCustomerComms would be the one exception that breaks it. Returns
// true when acquired (or no customer to fence) and false on contention.
async function tryLockCustomerCommsIfKnown(trx, customerId) {
  if (!customerId) return true;
  const { tryLockCustomerComms } = require('../utils/customer-comms-lock');
  return tryLockCustomerComms(trx, customerId);
}

// Batched "is this rider row an immovable anchor" lookup — never move,
// re-date or cancel a row a customer or the business is already committed
// to. Conservative by design (see the module header's per-condition list).
// FAILS CLOSED: any one of these queries throwing propagates straight out
// (no try/catch here) — a query failure means "can't prove this row is
// safe to touch," never "safe to touch." The caller (syncRiderSeries) runs
// this whole reconcile inside a savepoint, so the thrown error aborts and
// rolls back JUST this rider's sync (nothing moved/inserted/cancelled),
// logged as skipped: 'error'; the nightly reconcile retries later.
// Card holds and card requests are checked by what is DEAD, not by what is
// live: both tables carry several in-flight money states (pending,
// completing, charging, charge_review, charged, held, charged_completion,
// charged_no_show, satisfied, completed), and a new one must never quietly
// make a row movable. Any status outside this list — including one added
// later — keeps the row where it is.
const DEAD_CARD_STATUSES = ['released', 'cancelled', 'failed', 'expired'];

// Checked by what is EXCLUDED, not by an allowlist: a real send tied to
// this row pins it whatever its purpose. The booking confirmation and the
// reminders log as appointment_confirmation / appointment_reminder_72h /
// appointment_reminder_24h, but the reschedule text (reschedule-sms.js),
// rain-out notices and prep guides log under the generic 'appointment'
// purpose with the same appointment_id, and each of those told the
// customer this row's date. Only appointment_cancellation is excluded: a
// cancellation notice belongs to a row that is already terminal
// (JOIN_INELIGIBLE_STATUSES) and never reaches the movable set.
const NON_PINNING_MESSAGE_PURPOSES = ['appointment_cancellation'];

// FAILS CLOSED like every other lookup this function batches (see above).
// The customer message ledger (`messaging_audit_log`) is the one durable
// record of an ACTUAL customer-facing send tied to this exact row —
// appointment-reminders.js#safeSend stamps `appointmentId` on it precisely
// because "sms_log metadata does NOT survive the provider handoff... the
// audit record is the only queryable delivery evidence per visit". This
// used to read the `appointment_reminders` ledger's own confirmation_sent/
// reminder_72h_sent/reminder_24h_sent flags instead, but those are
// bookkeeping, not proof of a send: a sendConfirmation:false registration,
// the cron's self-heal insert, and — critically — a SIBLING-SUPPRESSED
// registration (the exact shape a rider row takes the moment it joins its
// host's date/window) all stamp every one of those flags true with NO send
// at all. Pinning on them made every synced rider row immovable within
// ~15 minutes of landing on a host date, and a PR 3 backfill would have
// aligned nothing. `sent_at IS NOT NULL` is the real delivery signal (null
// on a blocked/failed attempt, per messaging_audit_log's own schema).
async function messagedRowIds(trx, ids) {
  return trx('messaging_audit_log')
    .whereIn('appointment_id', ids.map(String))
    .whereNotIn('purpose', NON_PINNING_MESSAGE_PURPOSES)
    .whereNotNull('sent_at')
    .pluck('appointment_id');
}

async function immovableRowIdSet(trx, rowIds) {
  const ids = (rowIds || []).filter(Boolean);
  const immovable = new Set();
  if (!ids.length) return immovable;
  const [
    invoiced, cardHeld, cardRequested, packeted, completionClaims, messagedRows,
  ] = await Promise.all([
    trx('invoices').whereIn('scheduled_service_id', ids).pluck('scheduled_service_id'),
    trx('estimate_card_holds').whereIn('scheduled_service_id', ids)
      .whereNotIn('status', DEAD_CARD_STATUSES).pluck('scheduled_service_id'),
    trx('appointment_card_requests').whereIn('scheduled_service_id', ids)
      .whereNotIn('status', DEAD_CARD_STATUSES).pluck('scheduled_service_id'),
    trx('visit_completion_packet_items').whereIn('scheduled_service_id', ids).pluck('scheduled_service_id'),
    trx('service_completion_attempts').whereIn('service_id', ids)
      .whereIn('status', LIVE_COMPLETION_CLAIM_STATUSES).pluck('service_id'),
    messagedRowIds(trx, ids),
  ]);
  for (const id of [...invoiced, ...cardHeld, ...cardRequested, ...packeted, ...completionClaims, ...messagedRows]) immovable.add(id);
  return immovable;
}

// Status/attribute-only immovability (no DB) — combined with
// immovableRowIdSet's attribute lookups by the caller. Includes visit_id: a
// grouped row's date is kept in sync with its service_visits stop only
// through visit-groups.js's own move paths (handleChildStopChanged runs on
// the pool, not this module's trx) — a plain UPDATE here would silently
// desync the row from its stop's base key, so a grouped row is never a
// move/cancel candidate; the visit's own move (or ungrouping) is what
// relocates it. arrival_sms_sent_at (track-transitions.js#
// maybeSendArrivalSms) and prep_sent_at (prep-guide-sender.js#
// stampPrepSent) are each genuinely claimed/confirmed around a real
// customer send, so they stay. confirmation_sms_sent_at and this row's OWN
// reminder_24h_sent column are deliberately NOT checked here (Fable review
// NEW A): neither has a writer anywhere in server code — every
// reminder_24h_sent write in this codebase targets the SEPARATE
// `appointment_reminders` table's own column of the same name, never this
// one on `scheduled_services` — so both would always read false/null and
// checking them was dead weight, not a real signal.
function immovableByOwnFields(row) {
  return IN_PROGRESS_STATUSES.includes(row.status)
    || row.prepaid_amount != null
    || row.customer_confirmed === true
    || row.field_confirmed_at != null
    || row.visit_id != null
    || row.arrival_sms_sent_at != null
    || row.prep_sent_at != null;
}

// --- Stage 1: locks + link eligibility (no writes) ------------------------
// Resolves and locks both parents, validates the link is a genuine,
// non-chaining, same-customer rider→host pair, and refuses a rider that is
// not a currently-ongoing series root (Fable review NEW B) or that rides a
// host at a different address (Fable review NEW C). Returns either
// { skip: reason } or { riderParent, hostParent, cols }.
async function loadLockedRiderContext(trx, riderParentId, revive = false, allowNotOngoing = false) {
  const cols = await trx('scheduled_services').columnInfo();
  if (!cols.rides_parent_id) return { skip: 'no_column' };

  const riderParentPeek = await trx('scheduled_services').where({ id: riderParentId }).first();
  if (!riderParentPeek || !riderParentPeek.rides_parent_id) return { skip: 'not_a_rider' };
  const hostParentId = riderParentPeek.rides_parent_id;
  if (String(hostParentId) === String(riderParentId)) {
    logger.warn(`[rider-series] parent=${riderParentId} rides itself — refusing to sync`);
    return { skip: 'self_link' };
  }

  // Non-blocking, in this fixed order — see the module header for why a
  // blocking host-then-rider order is not achievable from every call
  // site, and why non-blocking makes that safe.
  if (!(await tryLockSeriesMaintenance(trx, hostParentId))) return { skip: 'host_locked' };
  if (!(await tryLockSeriesMaintenance(trx, riderParentId))) return { skip: 'rider_locked' };

  const riderParent = await trx('scheduled_services').where({ id: riderParentId }).first();
  const hostParent = await trx('scheduled_services').where({ id: hostParentId }).first();
  if (!riderParent || !riderParent.rides_parent_id) return { skip: 'not_a_rider' };
  // TOCTOU: hostParentId was read from the pre-lock peek, before either
  // lock was held — a concurrent admin edit could repoint rides_parent_id
  // to a DIFFERENT host between that peek and here. Re-check the LOCKED
  // row rather than trusting the peek: a mismatch means we locked and are
  // about to read/write against the WRONG host. Never write on a stale
  // link — return and let the nightly reconcile (or the next in-band
  // trigger) pick up the fresh link with its own fresh locks.
  if (String(riderParent.rides_parent_id) !== String(hostParentId)) {
    logger.warn(`[rider-series] parent=${riderParentId} rides_parent_id changed between the pre-lock peek (${hostParentId}) and the locked read (${riderParent.rides_parent_id}) — deferring to the next sync`);
    return { skip: 'host_changed' };
  }
  if (!hostParent) return { skip: 'host_missing' };
  if (String(riderParent.customer_id) !== String(hostParent.customer_id)) {
    logger.warn(`[rider-series] parent=${riderParentId} rides_parent=${hostParentId} but the two series belong to different customers — refusing to sync`);
    return { skip: 'cross_customer' };
  }

  // One level only: a host that itself rides another series would chain
  // (or, pointed back at this rider, cycle) and neither would ever walk on
  // its own dates. Refuse rather than follow the chain.
  if (hostParent.rides_parent_id) {
    logger.warn(`[rider-series] parent=${riderParentId} rides ${hostParentId}, which itself rides ${hostParent.rides_parent_id} — refusing to sync`);
    return { skip: 'host_is_rider' };
  }

  const livenessSkip = await riderLivenessSkipReason(trx, riderParent, hostParent, riderParentId, cols, revive, allowNotOngoing);
  if (livenessSkip) return { skip: livenessSkip };

  return { riderParent, hostParent, cols };
}

// Rider liveness + address scope (Fable review NEW B/NEW C), split out of
// loadLockedRiderContext to keep each function's own decision count small.
// A rider that is not a genuine, currently-ongoing series root at the
// rider's own address must never be synced — resyncing it would insert
// fresh billable dates on a plan the office already stopped (e.g. a scoped
// series cancel of the pest series alone, which clears recurring_ongoing
// and records a cancel_series decision, while the lawn host keeps
// extending and re-syncing every rider that still points at it), or lend
// a host at another address its technician/window. Mirrors the top-up's
// own not_series_root/not_ongoing gates (topUpRecurringSeriesLocked) plus
// the alert-refresh path's own decision check (recurringAlertTemplate).
// Deliberately does NOT also refuse on the parent row's own `status` — a
// completed (or rescheduled) PARENT row is the normal, healthy shape of an
// ongoing series whose first occurrence has already happened; gating on it
// would falsely stop most real riders. `revive` (P1 revival, PR #5268
// round 2): a convert_ongoing on a rider whose LATEST resolved decision is
// still let_lapse (the very decision convert_ongoing exists to undo)
// otherwise always hits this same plan_stopped gate, because the alert row
// convert_ongoing resolves is a NEW one — the old let_lapse decision is
// still the latest by resolved_at until this call resolves the new alert,
// which never happens because the sync it depends on refuses first.
// runRecurringAlertAction's convert_ongoing rider branch passes revive:true
// to skip ONLY this check; every other liveness gate above and below still
// applies (not_series_root, not_recurring, not_ongoing, different_property)
// — a genuinely non-root, non-recurring, still-not-ongoing, or cross-
// property rider is refused exactly as before.
//
// `allowNotOngoing` (P1 fix #5, PR #5268 round 4): skips ONLY the
// not_ongoing gate — runRecurringAlertAction's own `extend` action (never
// `convert_ongoing`, which already flips the flag true before syncing, and
// never any other caller) passes it for this one explicit office action, so
// a FIXED (non-ongoing) rider can still be extended by a fixed count the
// same way a fixed HOST series can, rather than always refusing with
// not_ongoing the way an unattended sync correctly does. Every other gate —
// not_series_root, not_recurring, plan_stopped, different_property — still
// applies unchanged: a genuinely stopped or cross-property rider is refused
// exactly as before.
async function riderLivenessSkipReason(trx, riderParent, hostParent, riderParentId, cols, revive = false, allowNotOngoing = false) {
  if (riderParent.recurring_parent_id) return 'not_series_root';
  if (!riderParent.is_recurring || !riderParent.recurring_pattern) return 'not_recurring';
  const riderOngoing = cols.recurring_ongoing ? !!riderParent.recurring_ongoing : false;
  if (!riderOngoing && !allowNotOngoing) return 'not_ongoing';
  const latestDecision = await trx('recurring_plan_alerts')
    .where({ recurring_parent_id: riderParentId })
    .whereNotNull('resolved_at')
    .orderBy('resolved_at', 'desc')
    .orderBy('id', 'desc')
    .first('resolved_action');
  // revive (convert_ongoing) undoes an office let_lapse only. A
  // cancel_series decision is the customer's own cancellation of this
  // series and always refuses.
  const stoppedBy = latestDecision?.resolved_action;
  if (stoppedBy === 'cancel_series' || (stoppedBy === 'let_lapse' && !revive)) {
    return 'plan_stopped';
  }
  if (cols.property_id && hostParent.property_id && riderParent.property_id
    && String(hostParent.property_id) !== String(riderParent.property_id)) {
    return 'different_property';
  }
  return null;
}

// --- Stage 2: customer + series eligibility (no writes) -------------------
async function resolveRiderEligibility(trx, riderParent, riderParentId, cols) {
  if (!(await tryLockCustomerCommsIfKnown(trx, riderParent.customer_id))) return { skip: 'customer_locked' };

  // Same customer gate as the visit-count top-up: never add or move visits
  // for a deleted, held, inactive or churned customer. The nightly reconcile
  // reaches this with no other customer check. FOR SHARE blocks a
  // concurrent stage save until commit; NOWAIT keeps every wait in this
  // module non-blocking (a held row skips and the next sync retries).
  const { SERIES_CUSTOMER_COLUMNS, seriesCustomerSkipReason } = require('./series-customer-eligibility');
  let customer;
  try {
    customer = await trx('customers').where({ id: riderParent.customer_id })
      .forShare().noWait().first(SERIES_CUSTOMER_COLUMNS);
  } catch (err) {
    if (err.code === '55P03') return { skip: 'customer_row_locked' };
    throw err;
  }
  const customerSkip = seriesCustomerSkipReason(customer);
  if (customerSkip) return { skip: customerSkip };

  // Same series gate as the top-up and the cancel reseed: an annual-prepay
  // series (its term owns the visit count and dates), a family on plan
  // hold, or a duplicate active series is never re-dated here. The
  // annual-prepay namespace is a try-lock, so this stays non-blocking.
  const { prepayLockedSeriesSkipReason } = require('../routes/admin-schedule');
  const seriesSkip = await prepayLockedSeriesSkipReason(trx, riderParent, riderParentId, cols);
  if (seriesSkip) return { skip: seriesSkip };

  return {};
}

// --- Stage 3: planning (no writes) -----------------------------------------
// Loads host/rider rows, computes the anchor, the horizon and the plan.
// Returns { noAnchor: true } or the planning context every later stage
// reads from.
async function buildRiderSyncPlan(trx, cols, riderParent, hostParent, riderParentId) {
  const hostParentId = hostParent.id;
  const todayStr = etDateString();

  // Host dates come from the BASE recurring series only (P1 fix #3, PR
  // #5268 round 4) — is_recurring = true, the SAME predicate
  // latestLiveSeriesVisit (admin-schedule.js) applies to every other
  // extension anchor in this codebase. Without it, a host BOOSTER row
  // (is_recurring = false — a one-off extra visit riding the host's own
  // recurring_parent_id, never part of its cadence) was picked up as a
  // "host date" here: the rider would join a booster's one-off stop as if
  // it were a real cadence step, and a host booster inside the 77-105 day
  // window could pull the rider onto it instead of the host's own next
  // cadence date. The whereNotIn(status, ...) below is null-safe (P2 fix
  // #4): a bare `whereNotIn` on a nullable column drops every NULL-status
  // row from the result (SQL's `col NOT IN (...)` evaluates to NULL, not
  // true, when col is NULL), silently excluding a legacy base row with no
  // stamped status from ever being read as a host date — the same
  // null-status hazard MOVABLE_ROW_STATUSES' own comment documents for the
  // RIDER side of this module, mirrored here for the host side.
  const hostRows = await trx('scheduled_services')
    .where((q) => { q.where('id', hostParentId).orWhere('recurring_parent_id', hostParentId); })
    .where('is_recurring', true)
    .where((q) => { q.whereNull('status').orWhereNotIn('status', JOIN_INELIGIBLE_STATUSES); })
    .where('scheduled_date', '>=', todayStr)
    .orderBy('scheduled_date', 'asc')
    .select('id', 'scheduled_date', 'window_start', 'window_end', 'technician_id', 'estimated_duration_minutes');
  const hostByDate = new Map();
  for (const r of hostRows) {
    const d = dateOnly(r.scheduled_date);
    if (d && !hostByDate.has(d)) hostByDate.set(d, r);
  }
  const hostDates = Array.from(hostByDate.keys()).sort();

  // Row-locked read (P1 lock rows, PR #5268 round 2): FOR UPDATE NOWAIT,
  // non-blocking like every other lock this module takes (see the module
  // header) — a concurrent writer already holding one of these rows (an
  // admin edit, a completion, another pass) means this whole sync defers to
  // the next pass rather than reading a snapshot a write-in-flight could
  // invalidate. Every downstream computation (the immovability lookups,
  // the anchor, the diff) reads from THIS locked snapshot, and every write
  // in writeRiderPlan below is additionally guarded by MOVABLE_ROW_STATUSES
  // + visit_id IS NULL for defense in depth against a writer that does not
  // take this same advisory-adjacent row lock.
  let riderRows;
  try {
    riderRows = await trx('scheduled_services')
      .where((q) => { q.where('id', riderParentId).orWhere('recurring_parent_id', riderParentId); })
      .forUpdate()
      .noWait()
      .select('*');
  } catch (err) {
    if (err.code === '55P03') return { skip: 'rider_rows_locked' };
    throw err;
  }
  const attributeImmovable = await immovableRowIdSet(trx, riderRows.map((r) => r.id));
  const nearTermCutoff = addDaysStr(todayStr, NEAR_TERM_DAYS);
  const isImmovable = (r) => immovableByOwnFields(r)
    || attributeImmovable.has(r.id)
    || (dateOnly(r.scheduled_date) != null && dateOnly(r.scheduled_date) <= nearTermCutoff);

  let lastRiderDate = null;
  // Only a visit that happened (completed) or a live fixed visit anchors
  // the plan. A cancelled, skipped, no-show or rescheduled row never does,
  // even when it sits in the near-term window or still carries a leftover
  // visit_id, invoice or sent-reminder stamp: anchoring on it would
  // restart the plan from a visit that never happened, and every live row
  // dated before it would drop out of the diff. is_recurring === true (P1
  // boosters, PR #5268 round 2) excludes booster rows from anchoring — the
  // SAME exclusion latestLiveSeriesVisit (admin-schedule.js) and the
  // upcoming-visit counter apply; a booster's own one-off date is never the
  // series' cadence phase.
  for (const r of riderRows) {
    const liveImmovable = !JOIN_INELIGIBLE_STATUSES.includes(r.status) && isImmovable(r);
    if (r.is_recurring === true && (r.status === 'completed' || liveImmovable)) {
      const d = dateOnly(r.scheduled_date);
      if (d && (!lastRiderDate || d > lastRiderDate)) lastRiderDate = d;
    }
  }
  // No completed/immovable row yet (a brand-new rider series) — the
  // parent's own scheduled_date is the only anchor available.
  if (!lastRiderDate) lastRiderDate = dateOnly(riderParent.scheduled_date);
  if (!lastRiderDate) return { noAnchor: true };

  // Strictly AFTER the anchor (never >= it) — see the design doc "Why the
  // anchor is excluded from the movable set". is_recurring === true (P1
  // boosters) — a booster is never moved or cancelled by this sync; it
  // stays wherever the series' own booster machinery placed it.
  // Movable set is an explicit ALLOWLIST (P1 fix #5, PR #5268 round 3):
  // MOVABLE_ROW_STATUSES, the SAME set the write guards below already
  // require. The previous exclusion-based check (JOIN_INELIGIBLE_STATUSES
  // + a redundant 'completed' check) let a legacy row with a NULL status
  // through as movable — MOVE/REFRESH's own write guard then rejected it
  // (pending/confirmed only) while the cancel loop's TERMINAL_ROW_STATUSES
  // check accepted a null fromStatus and could cancel it. A null-status
  // future base row is a live row this codebase already treats as a real
  // visit for other purposes (the recurring-plan counters) — never moved
  // or cancelled here, but still eligible to anchor like any other live
  // immovable row above.
  const movableRows = riderRows.filter((r) => (
    MOVABLE_ROW_STATUSES.includes(r.status)
    && !isImmovable(r)
    && dateOnly(r.scheduled_date) >= todayStr
    && dateOnly(r.scheduled_date) > lastRiderDate
    && r.is_recurring === true
  ));

  // Never plan into the past or into the near-term window, whose rows are
  // immovable: a lapsed rider's anchor (its last completed visit) can be
  // months old, and walking from it would insert past-dated rows or move
  // a future row backward.
  const planFloor = addDaysStr(nearTermCutoff, 1);

  const { customerPrefersNoWeekends } = require('./recurring-appointment-seeder');
  const standaloneAnchor = lastRiderDate > planFloor ? lastRiderDate : planFloor;
  // Horizon (P1 fix #3) — see computeRiderHorizon's own comment.
  const horizonDate = computeRiderHorizon(standaloneAnchor, hostDates, riderParent.recurring_pattern);

  // B6: the date WALK honors the customer's live weekday preference (OR'd
  // with the rider's own stamped flag), same as every other series
  // extension walk; the STAMPED flag copied onto new rows stays the
  // operator's raw value (writeRiderPlan's own skipParentStamp opt into
  // insertSeriesOccurrenceLocked, admin-schedule.js).
  const skipRiderStamp = !!riderParent.skip_weekends;
  const skipRiderEffective = skipRiderStamp || await customerPrefersNoWeekends(trx, riderParent.customer_id);
  const weekendShift = riderParent.weekend_shift === 'back' ? 'back' : 'forward';

  // Owner blackout days (Fable review addendum) — same shared lookup every
  // other series generator uses, bounded to [today-or-anchor, horizon].
  // Fails open (null) on a read error, same posture as every other
  // blackout consumer in this codebase: a lookup outage must not block
  // scheduling. Reused below for the add-on due-date walk too (one read).
  let blackoutDates = null;
  try {
    const from = standaloneAnchor < todayStr ? standaloneAnchor : todayStr;
    const to = horizonDate > from ? horizonDate : from;
    blackoutDates = await getBlackoutLayers(from, to, trx);
  } catch { blackoutDates = null; }

  const plan = planRiderDates({
    hostDates,
    lastRiderDate,
    horizonDate,
    earliestDate: planFloor,
    skipWeekends: skipRiderEffective,
    weekendShift,
    blackoutDates,
  });

  return {
    hostByDate, riderRows, movableRows, lastRiderDate, plan, blackoutDates, skipRiderEffective,
  };
}

// --- Stage 4: diff (pure) ---------------------------------------------------
// Grouped by date (an array, not a single row) so a genuine duplicate — two
// movable rows sharing one date — is diffed correctly (see the in-repo
// history for why "is my date in the plan" alone silently orphans a
// duplicate). Claiming by row id, at most one per planned date, makes every
// OTHER movable row on that date (or any row a plan date never reaches)
// unmatched — a move or cancel candidate like any other unmatched row.
// Host tech/window resolution shared by MOVE and REFRESH onto a host date
// (P1 host tech / P1 windows, PR #5268 round 2): a host row's own
// technician_id/window must never ride onto a rider row unvalidated — the
// SAME eligibility rules assignableRecurringTemplateTechnicianId applies
// to every other writer's insert (a marked-out or offboarded host tech
// nulls the rider's own assignment rather than joining them to it), and
// the SAME off-hour normalization the top-up applies (normalizeTopUpWindow)
// — the rider path normalizes UNCONDITIONALLY, never behind an opt-in
// flag, since it always joins an already-live host stop. The (normalized)
// host window's own START drives the join — the rider takes the host's
// slot on the calendar — but the END is derived from the RIDER'S OWN
// estimated_duration_minutes (the template's), never the host's (P1 fix
// #8, PR #5268 round 4): a rider whose own service runs a different length
// than its host (e.g. a 60-minute pest visit riding a 120-minute lawn stop)
// must keep its OWN duration's end, not silently adopt the host's — the
// host's own row is untouched either way; only the RIDER'S window is being
// computed here. (Round 2/3 read the host's own duration for this, on the
// reasoning that a floored HOST window should re-derive from the HOST's
// own span — correct for the host's own row, but this function computes
// the RIDER's window, never the host's.) Returns { unplaceable: true } (never writes) or
// { technicianId, windowStart, windowEnd }. Resolved once per host date
// BEFORE the diff (resolveHostJoins), so the kept-row refresh check compares
// a rider row against the values a write would actually produce, never the
// host row's raw fields: a pinned rider's own technician or an off-hour host
// window would otherwise read as drift on every sync and never converge.
async function resolveHostJoinFields(trx, template, hostRow, date) {
  const { assignableRecurringTemplateTechnicianId, normalizeTopUpWindow } = require('../routes/admin-schedule');
  // Host tech semantics (P1 fix #4, PR #5268 round 3): a pinned rider
  // (recurring_technician_override true) keeps its OWN template tech,
  // validated exactly as before — it never joins the host's tech. An
  // unpinned rider joins the host stop instead. Spreading only
  // `technician_id: hostRow.technician_id` onto `template` is not enough:
  // recurringTemplateTechnicianId (admin-schedule.js) prefers
  // `recurring_technician_id` over `technician_id` regardless of the
  // override flag, so the rider's OWN recurring_technician_id would still
  // win and the host tech would be silently ignored (or a host with no
  // tech would leave the rider on its old assignment instead of going
  // unassigned). Setting recurring_technician_id to the SAME host tech,
  // with override forced false, closes that fallback so the resolved id
  // can only be the host's. The underlying eligibility check (active,
  // field-dispatchable, not absent that date) still runs unchanged, and
  // an ineligible or unassigned host tech nulls the rider's own
  // assignment exactly like any other writer's.
  const pinned = !!template.recurring_technician_override;
  const preferredTechParent = pinned ? template : {
    ...template,
    technician_id: hostRow.technician_id,
    recurring_technician_id: hostRow.technician_id,
    recurring_technician_override: false,
  };
  const technicianId = await assignableRecurringTemplateTechnicianId(trx, preferredTechParent, date);
  // P1 fix #8: the RIDER's own duration drives the end, not the host's —
  // see this function's own header comment.
  const normalizedWindow = normalizeTopUpWindow(hostRow.window_start, template.estimated_duration_minutes, hostRow.window_end);
  if (normalizedWindow?.unplaceable) return { unplaceable: true };
  return {
    technicianId,
    windowStart: normalizedWindow ? normalizedWindow.start : hostRow.window_start,
    windowEnd: normalizedWindow ? normalizedWindow.end : hostRow.window_end,
  };
}

// Stage 3b: the resolved host-join fields for every planned date that is a
// host date. Pure reads; runs on dry runs too, so a dry run reports the
// same refreshes a real sync would write.
async function resolveHostJoins(trx, template, planCtx) {
  const joins = new Map();
  for (const d of planCtx.plan) {
    const hostRow = planCtx.hostByDate.get(d);
    if (hostRow) joins.set(d, await resolveHostJoinFields(trx, template, hostRow, d));
  }
  return joins;
}


// A TIME column reads back as 'HH:MM:SS'; resolved windows are 'HH:MM'.
function hhmm(value) {
  return value == null ? null : String(value).slice(0, 5);
}

function diffRiderPlan(planCtx) {
  const { hostJoinByDate, movableRows, plan } = planCtx;
  const movableByDate = new Map();
  for (const r of movableRows) {
    const d = dateOnly(r.scheduled_date);
    if (!d) continue;
    if (!movableByDate.has(d)) movableByDate.set(d, []);
    movableByDate.get(d).push(r);
  }
  // Stable choice among same-date duplicates: lowest id.
  for (const rows of movableByDate.values()) rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const claimedIds = new Set();
  const keep = [];
  // Kept rows vs host stop (P2 fix #6): a kept, movable, ungrouped rider
  // row already on a host date whose window_start/window_end/technician_id
  // has since drifted from the host's own current row (a re-window or
  // reassignment with no date change) never picks those changes up on its
  // own — only a MOVE onto that date copies the host's window/tech. Every
  // row reaching here is ungrouped by construction (a grouped row carries
  // visit_id, which immovableByOwnFields already excludes from
  // movableRows) — a grouped sibling stays in sync through its own move
  // paths instead.
  const refresh = [];
  const unmatchedPlanned = [];
  for (const d of plan) {
    const candidates = movableByDate.get(d) || [];
    const existing = candidates.find((r) => !claimedIds.has(r.id));
    if (existing) {
      claimedIds.add(existing.id);
      keep.push({ id: existing.id, date: d });
      const joined = hostJoinByDate.get(d);
      if (joined && !joined.unplaceable && (
        hhmm(existing.window_start) !== hhmm(joined.windowStart)
        || hhmm(existing.window_end) !== hhmm(joined.windowEnd)
        || (String(existing.technician_id ?? '') !== String(joined.technicianId ?? ''))
      )) {
        refresh.push({ id: existing.id, date: d });
      }
    } else {
      unmatchedPlanned.push(d);
    }
  }
  const unmatchedMovable = movableRows
    .filter((r) => !claimedIds.has(r.id))
    .sort((a, b) => dateOnly(a.scheduled_date).localeCompare(dateOnly(b.scheduled_date)));

  const pairCount = Math.min(unmatchedMovable.length, unmatchedPlanned.length);
  const move = [];
  for (let i = 0; i < pairCount; i++) {
    const row = unmatchedMovable[i];
    const to = unmatchedPlanned[i];
    move.push({ id: row.id, from: dateOnly(row.scheduled_date), to });
  }
  const insertDates = unmatchedPlanned.slice(pairCount);
  const cancelRows = unmatchedMovable.slice(pairCount)
    .map((r) => ({ id: r.id, date: dateOnly(r.scheduled_date) }));

  return {
    keep, refresh, move, insertDates, cancelRows,
  };
}

// --- Stage 5: writes (only stage that writes; never called on dryRun) -----
async function writeRiderPlan(trx, {
  cols, riderParent, riderParentId, allowNotOngoing = false,
}, planCtx, diff) {
  const { hostByDate, hostJoinByDate, riderRows, blackoutDates } = planCtx;
  const { move, refresh, insertDates, cancelRows } = diff;
  const {
    seriesCandidateDateClashes, assignableRecurringTemplateTechnicianId,
    insertSeriesOccurrenceLocked, normalizeTopUpWindow,
    buildSeriesOccurrenceForDate, insertRecurringChildAddons,
  } = require('../routes/admin-schedule');

  // Template for every insert (P1 fix #1): the series PARENT with
  // recurring_template_overrides applied — the same canonical derivation
  // extendSeriesOnceLocked / runRecurringSeriesMaintenanceLocked use
  // (overlayRecurringTemplateOverrides) before deriving anything from
  // `parent`, never the rider's own latest occurrence. Before this fix, an
  // occurrence-only "this only" price/service edit on the latest rider row
  // became every future insert's template; now only an "apply to
  // following" edit (which writes recurring_template_overrides) changes
  // what new rows carry.
  const template = overlayRecurringTemplateOverrides(riderParent, cols);
  const skipRiderStamp = !!riderParent.skip_weekends;
  const dirRider = riderParent.weekend_shift === 'back' ? 'back' : 'forward';


  // Combines the two "this row's dispatch/route state must never survive a
  // rider MOVE or REFRESH unexamined" rules every other series move path
  // already applies (P1 fix #1 + P2 fix #2, PR #5268 round 3) — building
  // ONE helper both call sites share means they can't independently drift
  // the way the hand-patched updates below already had:
  //   - recurringDispatchDuePatch (scheduling/recurring-dispatch-due.js):
  //     a moved/refreshed row keeps a STALE recurring_dispatch_due_date
  //     otherwise, and auto-dispatch (auto-dispatch/candidate-slots.js)
  //     then constrains placement to +/-3 days around that stale date. The
  //     SAME helper rebooker.js:1354/3095, admin-schedule.js:10060 and
  //     annual-prepay-renewals.js:1754 apply to their own move/refresh
  //     writes.
  //   - route_order: null on a DATE or TECHNICIAN change, never on a
  //     window-only refresh — the same rule rebooker.js's own single-move
  //     and series-sibling paths apply (rebooker.js:2824/2891/3099): a
  //     day or tech change invalidates the stop's route sequence (every
  //     consumer sorts COALESCE(route_order, 999), so a stale number
  //     interleaves it into the OLD day/tech's order instead of appending
  //     it); a same-day, same-tech window drift keeps its sequence.
  // `row` is the PRE-write DB row (recurringDispatchDuePatch reads its
  // current scheduled_date/window_start/recurring_dispatch_due_date;
  // route_order compares against its current scheduled_date/technician_id).
  function riderMovePatch(row, changes) {
    const dateChanged = changes.scheduled_date !== undefined
      && dateOnly(changes.scheduled_date) !== dateOnly(row?.scheduled_date);
    const techChanged = changes.technician_id !== undefined
      && String(changes.technician_id || '') !== String(row?.technician_id || '');
    return {
      ...changes,
      ...recurringDispatchDuePatch(row || {}, changes),
      ...((dateChanged || techChanged) ? { route_order: null } : {}),
    };
  }

  for (const { id, to } of move) {
    const row = riderRows.find((r) => r.id === id) || template;
    const hostRow = hostByDate.get(to);
    const updates = { scheduled_date: to, updated_at: new Date() };
    if (hostRow) {
      const joined = hostJoinByDate.get(to);
      if (joined.unplaceable) {
        logger.warn(`[rider-series] parent=${riderParentId} move of row ${id} to host date ${to} has an unplaceable window after normalization — skipped this sync, retried next pass`);
        continue;
      }
      updates.window_start = joined.windowStart;
      updates.window_end = joined.windowEnd;
      updates.technician_id = joined.technicianId;
    } else {
      // Standalone destination (P1 fix #5 + Fable review addendum): never
      // joins a host stop, so resolve OUR OWN tech's assignability/absence
      // for this date — the same helper extendSeriesOnceLocked's own child
      // insert uses, nulling the tech exactly like a fresh seeded child
      // would rather than leaving it on someone absent or ineligible — then
      // probe the SAME shared occupancy clash every other series writer's
      // insert/move probes. On a clash, skip this ONE pairing: log and move
      // on, same posture the cancel loop below already takes on a race —
      // the row is left where it is and a later sync re-diffs and retries.
      // A standalone date is the rider's OWN visit, so tech and window come
      // from the series template, exactly as a standalone insert's do. The
      // moved row may still carry a host stop's borrowed window/tech, which
      // would otherwise stick (a kept standalone row is never refreshed) and
      // would feed the clash probe the wrong window.
      const standaloneTechId = await assignableRecurringTemplateTechnicianId(trx, template, to);
      updates.technician_id = standaloneTechId;
      updates.window_start = template.window_start;
      updates.window_end = template.window_end;
      const clashProbe = {
        ...row, technician_id: standaloneTechId, window_start: template.window_start, window_end: template.window_end,
      };
      if (await seriesCandidateDateClashes(trx, clashProbe, to)) {
        logger.warn(`[rider-series] parent=${riderParentId} standalone move of row ${id} to ${to} clashes with an existing visit — skipped this sync, retried next pass`);
        continue;
      }
    }
    // P1 fix #1 (PR #5268 round 4): a MOVE changes WHICH date the row
    // sits on — every date-dependent field must be recomputed for the NEW
    // date, the SAME way a fresh insert for that date would
    // (buildSeriesOccurrenceForDate, the builder insertSeriesOccurrenceLocked
    // itself now shares — see its own header). Never tech/window/date,
    // which the host-join/standalone branch above already resolved for
    // THIS move. A build failure (e.g. a required add-on scope read error)
    // skips this ONE pairing, same posture as an unplaceable window or a
    // clash above — logged, retried next pass, never a half-written move.
    let moveBuilt;
    try {
      moveBuilt = await buildSeriesOccurrenceForDate(trx, template, riderParentId, cols, {
        date: to, blackoutDates, skipParent: planCtx.skipRiderEffective,
      });
    } catch (err) {
      logger.warn(`[rider-series] parent=${riderParentId} move of row ${id} to ${to} could not recompute its financials — skipped this sync, retried next pass: ${err.message}`);
      continue;
    }
    Object.assign(updates, moveBuilt.data);
    // Guarded write (P1 lock rows): this sync already locked every rider
    // row FOR UPDATE NOWAIT (buildRiderSyncPlan), so a row here cannot have
    // changed status/visit_id from a DIFFERENT transaction since without
    // contending that lock — the guard is defense in depth against a
    // writer that does not take it. A 0-row update means the row changed
    // underneath this sync's own plan; never overwrite blind.
    const updated = await trx('scheduled_services')
      .where({ id })
      .whereIn('status', MOVABLE_ROW_STATUSES)
      .whereNull('visit_id')
      .update(riderMovePatch(row, updates));
    if (!updated) {
      logger.warn(`[rider-series] parent=${riderParentId} row ${id} changed underneath this sync (status/visit_id) — move to ${to} skipped, retried next pass`);
      continue;
    }
    // Only once the guarded write above actually landed (never on a
    // skipped/raced move): replace the row's due add-on set to match the
    // NEW date — insertRecurringChildAddons only ever ADDS, so the row's
    // stale set (from wherever it used to sit) is cleared first.
    await trx('scheduled_service_addons').where({ scheduled_service_id: id }).del();
    await insertRecurringChildAddons(trx, id, moveBuilt.dueAddons, moveBuilt.restackedAddonDollars);
    await maybeGroupRow(id, { database: trx, createdBy: 'dispatch' });
  }

  for (const { id, date } of refresh) {
    const hostRow = hostByDate.get(date);
    if (!hostRow) continue;
    const joined = hostJoinByDate.get(date);
    if (joined.unplaceable) {
      logger.warn(`[rider-series] parent=${riderParentId} refresh of row ${id} onto host date ${date} has an unplaceable window after normalization — skipped this sync, retried next pass`);
      continue;
    }
    const row = riderRows.find((r) => r.id === id) || {};
    const updated = await trx('scheduled_services')
      .where({ id })
      .whereIn('status', MOVABLE_ROW_STATUSES)
      .whereNull('visit_id')
      .update(riderMovePatch(row, {
        window_start: joined.windowStart,
        window_end: joined.windowEnd,
        technician_id: joined.technicianId,
        updated_at: new Date(),
      }));
    if (!updated) {
      logger.warn(`[rider-series] parent=${riderParentId} row ${id} changed underneath this sync (status/visit_id) — refresh onto ${date} skipped, retried next pass`);
      continue;
    }
    await maybeGroupRow(id, { database: trx, createdBy: 'dispatch' });
  }

  // Every insert (P1 fix #1/#2, and the PR #5268 round-3 structural fix):
  // goes through the SAME canonical occurrence writer extendSeriesOnceLocked
  // uses (insertSeriesOccurrenceLocked, admin-schedule.js) — template
  // resolution, technician eligibility, price/discount computation and
  // add-on due-date filtering can never drift from that path again. The
  // rider decides DATES ONLY (see the design doc "the rider decides DATES
  // ONLY"); every occurrence it creates goes through this same writer.
  const insertedRows = [];
  for (const d of insertDates) {
    const hostRow = hostByDate.get(d);
    let windowStart = template.window_start;
    let windowEnd = template.window_end;
    let preferredTechnicianId;
    if (hostRow) {
      // Host window (P1 windows): always normalize, unconditionally (never
      // behind an opt-in flag the way the top-up's own
      // opts.normalizeOffHourStart is) — a rider joining a host's already-
      // live stop must never carry an off-hour window onto its own new row
      // unfloored. The RIDER's own duration drives the end (P1 fix #8 — see
      // resolveHostJoinFields's identical comment above); the START still
      // comes from the host's own (normalized) window.
      const normalizedWindow = normalizeTopUpWindow(hostRow.window_start, template.estimated_duration_minutes, hostRow.window_end);
      if (normalizedWindow?.unplaceable) {
        logger.warn(`[rider-series] parent=${riderParentId} host date ${d} has an unplaceable window after normalization — insert skipped this sync, retried next pass`);
        continue;
      }
      windowStart = normalizedWindow ? normalizedWindow.start : hostRow.window_start;
      windowEnd = normalizedWindow ? normalizedWindow.end : hostRow.window_end;
      preferredTechnicianId = hostRow.technician_id;
    } else {
      // Standalone destination: resolve + clash-probe OUR OWN template tech
      // first, same as a standalone move — insertSeriesOccurrenceLocked
      // below re-derives the SAME id from `template` with no
      // preferredTechnicianId (its own "no preferred tech" path, byte-
      // identical to what this probe just computed), so this only decides
      // whether to attempt the insert at all.
      const standaloneTechId = await assignableRecurringTemplateTechnicianId(trx, template, d);
      const clashProbe = standaloneTechId === template.technician_id ? template : { ...template, technician_id: standaloneTechId };
      if (await seriesCandidateDateClashes(trx, clashProbe, d)) {
        logger.warn(`[rider-series] parent=${riderParentId} standalone insert date ${d} clashes with an existing visit — skipped this sync, retried next pass`);
        continue;
      }
    }
    // checkUnbillable (P1 fix #6, PR #5268 round 4): the SAME shared verdict
    // every OFFICE series writer consults (seriesExtensionUnbillable) before
    // adding a visit — the rider sync is an unattended writer exactly like
    // the nightly top-up (no human reviews each date it lands on), so it
    // belongs with that OFFICE-writer class rather than the completion
    // path's own owner-ruling exemption (warn at completion, never block a
    // tech closing out today's job). Refuses (never inserts) a candidate
    // date whose real due add-ons make it $0 or non-invoiceable; a later
    // sync re-diffs and retries.
    const inserted = await insertSeriesOccurrenceLocked(trx, template, riderParentId, cols, {
      date: d,
      windowStart,
      windowEnd,
      preferredTechnicianId,
      blackoutDates,
      skipParent: planCtx.skipRiderEffective,
      skipParentStamp: skipRiderStamp,
      dirParent: dirRider,
      checkUnbillable: true,
      // See insertSeriesOccurrenceLocked's own opts.ignoreOngoingRace
      // comment (P1 fix #5): only when THIS sync was explicitly authorized
      // to run on a not-yet-ongoing rider (an office extend on a fixed
      // plan) does its own post-insert "series stopped mid-write" re-check
      // stand down — every ordinary (ongoing) rider sync keeps that race
      // guard.
      ignoreOngoingRace: allowNotOngoing,
      onSkip: (reason) => {
        logger.warn(`[rider-series] parent=${riderParentId} insert date ${d} skipped by insertSeriesOccurrenceLocked: ${reason}`);
      },
    });
    if (inserted) {
      await maybeGroupRow(inserted.id, { database: trx, createdBy: 'dispatch' });
      insertedRows.push(inserted);
    }
  }

  // Rows this call's own transitionJobStatus actually flipped to cancelled
  // (never a raced/skipped id) — the caller runs the cancellation
  // follow-through (P1 fix #3) against exactly this list, once this
  // transaction has committed.
  const cancelledIds = [];
  for (const { id } of cancelRows) {
    const fresh = await trx('scheduled_services').where({ id }).first('status');
    if (!fresh || TERMINAL_ROW_STATUSES.includes(fresh.status)) continue;
    try {
      // afterCommit (P1 fix #2, PR #5268 round 4): transitionJobStatus
      // defaults to trx.executionPromise for its own broadcasts and terminal
      // hooks (visit-group seam, follow-up re-park, invoice-void seam, tech
      // cancel notice) — correct only when `trx` is a real transaction. Here
      // `trx` is syncRiderSeries's own conn.transaction(run), which is a
      // SAVEPOINT for every in-band caller (a rider/host hook already holds
      // an outer transaction before calling in) — its executionPromise
      // resolves at savepoint RELEASE, well before the caller's own outer
      // commit. commitPromiseOf(trx) walks to the outermost transaction (or
      // returns trx's own executionPromise when trx has no parent, i.e. this
      // sync IS the top-level transaction) — same fix shape as this
      // function's own cancellation follow-through below.
      await transitionJobStatus({
        jobId: id,
        fromStatus: fresh.status,
        toStatus: 'cancelled',
        transitionedBy: null,
        notes: 'rider_resync',
        trx,
        afterCommit: commitPromiseOf(trx),
        notifyCustomer: 'caller_suppress',
        suppressTechNotice: true,
      });
      cancelledIds.push(id);
    } catch (err) {
      logger.warn(`[rider-series] cancel of surplus rider row ${id} skipped (race or guard mismatch): ${err.message}`);
    }
  }

  return { insertedRows, cancelledIds };
}

/**
 * Reconciles ONE rider parent's future movable rows against its host.
 * No-op (returns { skipped: <reason> }) unless the rider has
 * rides_parent_id set and points at a real, currently-ongoing host series.
 * Never sends any customer communication: inserted/moved rows get their
 * reminder rows from the existing self-heal sweep (appointment-reminders.js
 * selfHealMissingReminderRows) or the silent-move DB trigger
 * (scheduled_services_sync_reminder) — the exact same mechanism every other
 * seeder-built or silently-moved row already relies on — never a fresh
 * confirmation text, and cancels go through transitionJobStatus with
 * notifyCustomer: 'caller_suppress'. A cancel also settles what the status
 * flip alone never does — the tracker transition and card-fee/invoice
 * money — through the SAME post-commit follow-through every other cancel
 * surface shares (runVisitCancellationFollowThrough); still no customer
 * message (see this function's own cancellation-follow-through comment
 * below).
 *
 * @param {object} conn - a knex connection or an open transaction.
 * @param {string} riderParentId
 * @param {{dryRun?: boolean, source?: string, revive?: boolean,
 *   allowNotOngoing?: boolean, maxNewInserts?: number}} [opts]
 *   revive (P1 revival) - skips ONLY the plan_stopped liveness check (a
 *   convert_ongoing reviving a lapsed rider); every other gate still
 *   applies. See riderLivenessSkipReason's own comment.
 *   allowNotOngoing (P1 fix #5) - skips ONLY the not_ongoing liveness check
 *   (runRecurringAlertAction's own `extend` action on a fixed rider). See
 *   riderLivenessSkipReason's own comment.
 *   maxNewInserts (P1 fix #5) - caps this call's own NEW inserts at this
 *   count (never below the module-wide TOPUP_MAX_INSERTS_PER_SERIES_PER_RUN
 *   cap, P1 fix #7 below) — the office's own explicit `extend` count. Dates
 *   still come from the plan; the earliest N (plan order) are kept, the
 *   rest deferred to the next sync. Moves and cancels of EXISTING rows are
 *   never capped by this — the office asked for N more visits, not for the
 *   rest of the plan to stop reconciling.
 * @returns {Promise<{skipped?: string, keep: Array, move: Array,
 *   refresh: Array, insert: string[], cancel: Array, insertedRows?: Array,
 *   cancelledIds?: string[]}>} cancelledIds is the subset of `cancel`'s ids
 *   this call's own transitionJobStatus actually flipped (never a raced or
 *   guard-mismatched id) — what the post-commit cancellation follow-through
 *   ran against.
 */
async function syncRiderSeries(conn, riderParentId, {
  dryRun = false, source = 'sync', revive = false, allowNotOngoing = false, maxNewInserts = null,
} = {}) {
  const empty = () => ({
    keep: [], move: [], insert: [], cancel: [], refresh: [],
  });
  const run = async (trx) => {
    const ctx = await loadLockedRiderContext(trx, riderParentId, revive, allowNotOngoing);
    if (ctx.skip) return { ...empty(), skipped: ctx.skip };
    const { riderParent, hostParent, cols } = ctx;

    const eligibility = await resolveRiderEligibility(trx, riderParent, riderParentId, cols);
    if (eligibility.skip) return { ...empty(), skipped: eligibility.skip };

    const planCtx = await buildRiderSyncPlan(trx, cols, riderParent, hostParent, riderParentId);
    if (planCtx.skip) return { ...empty(), skipped: planCtx.skip };
    if (planCtx.noAnchor) return { ...empty(), skipped: 'no_anchor' };

    planCtx.hostJoinByDate = await resolveHostJoins(trx, overlayRecurringTemplateOverrides(riderParent, cols), planCtx);
    const diff = diffRiderPlan(planCtx);
    // Runaway-horizon insert cap (P1 fix #7, PR #5268 round 4): the SAME
    // per-run cap the nightly top-up applies to its own insert loop
    // (TOPUP_MAX_INSERTS_PER_SERIES_PER_RUN, admin-schedule.js — imported,
    // never copied, so the two can't silently drift). A runaway pattern or
    // a horizon misconfiguration (see computeRiderHorizon's own
    // MAX_HORIZON_EXTRA_DAYS bound above) can still never mint an unbounded
    // number of rows in one sync. maxNewInserts (opts, P1 fix #5) further
    // tightens this — never loosens it — to the office's own explicit
    // `extend` count. Only NEW inserts are capped: move/refresh/cancel of
    // rows the plan already accounts for are untouched, and the dropped
    // insert dates are simply retried by the next sync (in plan order, so
    // the EARLIEST dates always land first).
    const { TOPUP_MAX_INSERTS_PER_SERIES_PER_RUN } = require('../routes/admin-schedule');
    const insertCap = Number.isFinite(maxNewInserts)
      ? Math.min(TOPUP_MAX_INSERTS_PER_SERIES_PER_RUN, maxNewInserts)
      : TOPUP_MAX_INSERTS_PER_SERIES_PER_RUN;
    if (diff.insertDates.length > insertCap) diff.insertDates = diff.insertDates.slice(0, insertCap);
    const result = {
      keep: diff.keep, move: diff.move, insert: diff.insertDates, cancel: diff.cancelRows, refresh: diff.refresh,
    };
    if (dryRun) return result;

    const { insertedRows, cancelledIds } = await writeRiderPlan(trx, {
      cols, riderParent, riderParentId, allowNotOngoing,
    }, planCtx, diff);

    logger.info(
      `[rider-series] synced parent=${riderParentId} rides=${hostParent.id} source=${source} `
      + `keep=${diff.keep.length} move=${diff.move.length} refresh=${diff.refresh.length} `
      + `insert=${insertedRows.length} cancel=${diff.cancelRows.length}`,
    );
    return { ...result, insertedRows, cancelledIds };
  };

  let result;
  try {
    // ALWAYS goes through .transaction() — when `conn` is already an open
    // transaction (every in-band hook: a rider's own completion/top-up/
    // alert path, or a host's extend/seed hook), Knex makes this a SAVEPOINT
    // rather than a nested independent transaction (same idiom
    // visit-groups.js#maybeGroupRow uses for the identical reason): a
    // failure inside `run` rolls back only to the savepoint, never poisons
    // the caller's whole transaction (25P02) — "best-effort, never fails
    // the host/rider write it rides behind" would otherwise be false the
    // moment any query in here threw. A plain (non-transaction) `conn`
    // opens a real transaction as usual.
    result = await conn.transaction(run);
  } catch (err) {
    logger.error(`[rider-series] syncRiderSeries failed for parent=${riderParentId}: ${err.message}`);
    return { ...empty(), skipped: 'error' };
  }

  // Cancellation follow-through (P1 fix #3, PR #5268 round 3): the surplus
  // cancel above only flips scheduled_services.status — it never ran the
  // customer-visible tracker transition or the money settlement (card fee
  // rails, invoice void) every OTHER cancellation surface runs through
  // runVisitCancellationFollowThrough (admin-dispatch.js:2451/2820,
  // admin-schedule.js:15329, intelligence-bar/tools.js). That module's own
  // header is explicit: it MUST run AFTER the cancelling transaction
  // commits — every step reads the visit's committed state on ITS OWN
  // connection (db, not this trx), so calling it before commit would read
  // stale (pre-cancel) rows on every other connection. `conn` is often
  // already an open transaction here (every in-band hook holds one before
  // calling in) — `conn.transaction(run)` above then ran as a SAVEPOINT,
  // which releases long before the CALLER's own outer commit, so awaiting
  // that release is not "after commit" for this purpose. commitPromiseOf
  // (utils/trx-commit-promise.js) walks to the OUTERMOST transaction and
  // queues the follow-through on ITS settle instead — same idiom
  // tech-visit-notifications.js#afterCommit uses for the identical hazard —
  // rather than awaiting it inline here, which would deadlock: this code
  // runs on the caller's own call stack, before they ever reach their own
  // commit. When `conn` is NOT itself a transaction (the nightly reconcile,
  // any bare caller), `conn.transaction(run)` already performed a REAL
  // commit by the time this line runs, so the follow-through is awaited
  // inline — no caller is waiting on an outer commit that hasn't happened
  // yet. Never sends a customer message either way: invoice void, the card
  // fee rails and trackTransitions.cancel (which sees the row already
  // status='cancelled' from writeRiderPlan's own transitionJobStatus call,
  // so it only advances track_state) have no send path of their own — the
  // one internal admin alert (an unresolved fee) and the tracker's
  // socket.io refresh are not customer sends.
  if (result?.cancelledIds?.length) {
    const doFollowThrough = async () => {
      const { runVisitCancellationFollowThrough } = require('./visit-cancellation-followthrough');
      try {
        // Defense in depth against Knex's own doNotRejectOnRollback default
        // (transaction.js: true unless a caller opts out) — a BARE
        // `.rollback()` with no error ALSO resolves executionPromise, not
        // only a real commit (annual-prepay-renewals.js's own
        // fileCoverageExceptionAfterCommit comment names this exact hazard
        // and works around it the other way, by forcing an explicit-error
        // reject at ITS OWN dry-run rollback site). This module has no
        // control over what a caller two levels up does with ITS outer
        // transaction, so a resolved commitPromise alone is necessary but
        // not sufficient proof these ids actually committed as cancelled —
        // re-read their real, current status and settle only the ones that
        // did. Never a partial illusion: a target that rolled back is
        // silently skipped here (not an error — a discarded preview/aborted
        // caller transaction is an ordinary, expected outcome), and
        // whichever ids remain get the SAME follow-through every other
        // cancel surface runs.
        const db = require('../models/db');
        const stillCancelled = await db('scheduled_services')
          .whereIn('id', result.cancelledIds).where('status', 'cancelled').pluck('id');
        if (!stillCancelled.length) return;
        await runVisitCancellationFollowThrough({
          targetIds: stillCancelled,
          reason: 'rider_resync',
          source: 'rider-series',
        });
      } catch (err) {
        logger.error(`[rider-series] cancellation follow-through failed for parent=${riderParentId}: ${err.message}`);
      }
    };
    const commitPromise = conn?.isTransaction ? commitPromiseOf(conn) : null;
    if (commitPromise) {
      // Fire-and-forget from THIS call's perspective (never blocks the
      // caller's own commit); a rolled-back outer transaction has nothing
      // to follow through on, so a rejection is swallowed rather than
      // running against cancels that never actually committed.
      commitPromise.then(doFollowThrough).catch(() => {});
    } else {
      await doFollowThrough();
    }
  }
  return result;
}

/**
 * Best-effort: sync every rider whose rides_parent_id points at
 * `hostParentId`. Called after a host series gains new future rows
 * (seeder seeding, auto-extend, top-up) — see the call sites in
 * recurring-appointment-seeder.js and routes/admin-schedule.js. Never
 * throws: a sync failure for one rider (or all of them) must never fail
 * the host write it rides behind.
 */
async function syncRidersOfHost(conn, hostParentId, opts = {}) {
  if (!hostParentId) return;
  try {
    const cols = await conn('scheduled_services').columnInfo();
    if (!cols.rides_parent_id) return;
    const riders = await conn('scheduled_services')
      .where({ rides_parent_id: hostParentId })
      .pluck('id');
    for (const riderId of riders) {
      await syncRiderSeries(conn, riderId, { ...opts, source: opts.source || 'host_extend' });
    }
  } catch (err) {
    logger.warn(`[rider-series] syncRidersOfHost failed for host=${hostParentId}: ${err.message}`);
  }
}

module.exports = {
  MIN_GAP_DAYS,
  TARGET_GAP_DAYS,
  MAX_WAIT_DAYS,
  NEAR_TERM_DAYS,
  OVERDUE_WAIT_DAYS,
  planRiderDates,
  syncRiderSeries,
  syncRidersOfHost,
  _internals: {
    immovableByOwnFields, immovableRowIdSet, addDaysStr, tryLockSeriesMaintenance,
    computeRiderHorizon,
  },
};
