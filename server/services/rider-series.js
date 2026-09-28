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

function dateOnly(value) {
  if (!value) return null;
  return etCalendarDayOf(value);
}

function addDaysStr(dateStr, days) {
  const base = parseETDateTime(`${dateOnly(dateStr)}T12:00`);
  if (isNaN(base.getTime())) return null;
  return etDateString(addETDays(base, days));
}

// Pure — the horizon rule (P1 fix #3): the LATER of the host's own last
// live date and the rider's own standalone horizon (anchorDate +
// plannedVisitCountForPattern(pattern) * TARGET_GAP_DAYS — the same visit
// count the seeder would plan for that pattern in a year, spaced at the
// rider's own fallback interval). Clamping to "the host's last date,
// whenever it has any future row at all" (the pre-fix rule) lapses a rider
// the instant its host is ending, however soon — the plan comes back empty
// and every movable rider row gets cancelled as surplus. Exposed via
// _internals so tests can derive the SAME horizon a real sync would,
// rather than duplicating this formula.
function computeRiderHorizon(anchorDate, hostDates, pattern) {
  const { plannedVisitCountForPattern } = require('./recurring-appointment-seeder');
  const count = plannedVisitCountForPattern(pattern, {});
  const standaloneHorizon = addDaysStr(anchorDate, count * TARGET_GAP_DAYS);
  const sorted = Array.from(new Set((hostDates || []).map(dateOnly).filter(Boolean))).sort();
  if (!sorted.length) return standaloneHorizon;
  const hostLast = sorted[sorted.length - 1];
  return hostLast > standaloneHorizon ? hostLast : standaloneHorizon;
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

// Purposes whose delivery genuinely tells the customer THIS row's date/
// time — appointment_confirmation covers both the original booking
// confirmation AND the reschedule notice (appointment-reminders.js#
// safeSendAppointment passes 'appointment_confirmation' as the actual
// messaging_audit_log purpose for both; 'appointment_rescheduled' is only
// the SMS template key). appointment_cancellation (cancelled/no-show/
// series-cancelled notices) is deliberately excluded: those rows are
// already terminal (JOIN_INELIGIBLE_STATUSES) and never reach the movable
// set in the first place.
const MESSAGED_ROW_PURPOSES = ['appointment_confirmation', 'appointment_reminder_72h', 'appointment_reminder_24h'];

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
    .whereIn('purpose', MESSAGED_ROW_PURPOSES)
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

// ALLOWLIST, not a blocklist: scheduled_services carries dozens of
// per-visit transient/unique columns (track_view_token, reschedule_token,
// prep_token, followup_source_service_id, dispatch/auto-dispatch state,
// SMS-sent timestamps, ...) that must never ride onto a brand-new row —
// several are UNIQUE and would fail the insert outright. This list is the
// same shape buildRecurringFollowUpRows (recurring-appointment-seeder.js)
// stamps for an ordinary seeded follow-up, plus the price/discount fields
// extendSeriesOnceLocked (admin-schedule.js) additionally copies for an
// auto-extend insert — together "what the rider series would have
// produced" per the PR brief, without re-deriving either writer's pricing
// logic. A rider's own price does not vary by date the way a host's
// due-add-on rows can (owner ruling 2026-09-28: keep the per-visit pest
// price), so a flat copy of these fields from the template needs no
// per-date recomputation. annual_prepay_term_id is deliberately NOT
// copied: a prepaid series is refused before any write (the series gate in
// syncRiderSeries), and a new row must never inherit a term's coverage.
const TEMPLATE_COPY_FIELDS = [
  'customer_id', 'service_type', 'notes', 'time_window', 'zone',
  'estimated_duration_minutes', 'estimated_price', 'payment_method_preference',
  'source_estimate_id', 'source', 'is_recurring', 'recurring_pattern',
  'recurring_ongoing', 'skip_weekends', 'weekend_shift',
  'recurring_nth', 'recurring_weekday', 'recurring_interval_days',
  'appointment_type', 'create_invoice_on_complete',
  'service_id', 'service_key_snapshot', 'service_category_snapshot',
  'discount_type', 'discount_amount', 'discount_dollars',
  'line_discount_id', 'line_discount_type', 'line_discount_amount',
  'line_discount_dollars', 'line_discount_name',
  'discount_id', 'discount_name', 'discount_max_dollars',
  'discount_service_key_filter', 'discount_service_category_filter',
  'primary_line_price', 'pricing_provenance',
  'payer_id', 'po_number', 'self_pay_override',
  'property_id', 'service_address_line1', 'service_address_line2',
  'service_address_city', 'service_address_state', 'service_address_zip',
  'lat', 'lng',
];
// Builds a brand-new row scheduled at `scheduledDate`, off `template` — the
// series PARENT with recurring_template_overrides applied (see
// buildRiderSyncPlan/writeRiderPlan), the same canonical template every
// other recurring writer derives (overlayRecurringTemplateOverrides).
// `riderParentId` is always this rider's series parent id — never copied
// off the template, which may itself BE the parent (recurring_parent_id
// null). When scheduledDate is a host date, hostWindow overrides
// window_start/window_end/technician_id so the rider actually joins the
// host's stop; otherwise the template's own window/tech carry over
// unchanged (writeRiderPlan resolves a standalone date's own tech
// assignability/absence into `template.technician_id` before calling this).
function buildRiderRowFromTemplate(template, scheduledDate, hostWindow, riderParentId) {
  const row = {};
  for (const field of TEMPLATE_COPY_FIELDS) {
    if (template[field] !== undefined) row[field] = template[field];
  }
  row.recurring_parent_id = riderParentId;
  row.scheduled_date = scheduledDate;
  row.status = 'pending';
  row.customer_confirmed = false;
  row.confirmed_at = null;
  row.window_start = hostWindow ? hostWindow.window_start : template.window_start;
  row.window_end = hostWindow ? hostWindow.window_end : template.window_end;
  row.technician_id = hostWindow ? hostWindow.technician_id : template.technician_id;
  return row;
}

// --- Stage 1: locks + link eligibility (no writes) ------------------------
// Resolves and locks both parents, validates the link is a genuine,
// non-chaining, same-customer rider→host pair, and refuses a rider that is
// not a currently-ongoing series root (Fable review NEW B) or that rides a
// host at a different address (Fable review NEW C). Returns either
// { skip: reason } or { riderParent, hostParent, cols }.
async function loadLockedRiderContext(trx, riderParentId) {
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

  const livenessSkip = await riderLivenessSkipReason(trx, riderParent, hostParent, riderParentId, cols);
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
// would falsely stop most real riders. Returns a skip reason, or null.
async function riderLivenessSkipReason(trx, riderParent, hostParent, riderParentId, cols) {
  if (riderParent.recurring_parent_id) return 'not_series_root';
  if (!riderParent.is_recurring || !riderParent.recurring_pattern) return 'not_recurring';
  const riderOngoing = cols.recurring_ongoing ? !!riderParent.recurring_ongoing : false;
  if (!riderOngoing) return 'not_ongoing';
  const latestDecision = await trx('recurring_plan_alerts')
    .where({ recurring_parent_id: riderParentId })
    .whereNotNull('resolved_at')
    .orderBy('resolved_at', 'desc')
    .orderBy('id', 'desc')
    .first('resolved_action');
  if (latestDecision && ['cancel_series', 'let_lapse'].includes(latestDecision.resolved_action)) {
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

  const hostRows = await trx('scheduled_services')
    .where((q) => { q.where('id', hostParentId).orWhere('recurring_parent_id', hostParentId); })
    .whereNotIn('status', JOIN_INELIGIBLE_STATUSES)
    .where('scheduled_date', '>=', todayStr)
    .orderBy('scheduled_date', 'asc')
    .select('id', 'scheduled_date', 'window_start', 'window_end', 'technician_id');
  const hostByDate = new Map();
  for (const r of hostRows) {
    const d = dateOnly(r.scheduled_date);
    if (d && !hostByDate.has(d)) hostByDate.set(d, r);
  }
  const hostDates = Array.from(hostByDate.keys()).sort();

  const riderRows = await trx('scheduled_services')
    .where((q) => { q.where('id', riderParentId).orWhere('recurring_parent_id', riderParentId); })
    .select('*');
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
  // dated before it would drop out of the diff.
  for (const r of riderRows) {
    const liveImmovable = !JOIN_INELIGIBLE_STATUSES.includes(r.status) && isImmovable(r);
    if (r.status === 'completed' || liveImmovable) {
      const d = dateOnly(r.scheduled_date);
      if (d && (!lastRiderDate || d > lastRiderDate)) lastRiderDate = d;
    }
  }
  // No completed/immovable row yet (a brand-new rider series) — the
  // parent's own scheduled_date is the only anchor available.
  if (!lastRiderDate) lastRiderDate = dateOnly(riderParent.scheduled_date);
  if (!lastRiderDate) return { noAnchor: true };

  // Strictly AFTER the anchor (never >= it) — see the design doc "Why the
  // anchor is excluded from the movable set".
  const movableRows = riderRows.filter((r) => (
    !JOIN_INELIGIBLE_STATUSES.includes(r.status)
    && r.status !== 'completed'
    && !isImmovable(r)
    && dateOnly(r.scheduled_date) >= todayStr
    && dateOnly(r.scheduled_date) > lastRiderDate
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
  // operator's raw value (buildRiderRowFromTemplate/TEMPLATE_COPY_FIELDS).
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
function diffRiderPlan(planCtx) {
  const { hostByDate, movableRows, plan } = planCtx;
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
      const hostRow = hostByDate.get(d);
      if (hostRow && (
        (existing.window_start ?? null) !== (hostRow.window_start ?? null)
        || (existing.window_end ?? null) !== (hostRow.window_end ?? null)
        || (String(existing.technician_id ?? '') !== String(hostRow.technician_id ?? ''))
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
async function writeRiderPlan(trx, { cols, riderParent, riderParentId }, planCtx, diff) {
  const { hostByDate, riderRows, blackoutDates } = planCtx;
  const { move, refresh, insertDates, cancelRows } = diff;
  const {
    seriesCandidateDateClashes, assignableRecurringTemplateTechnicianId,
    filterAddonLinesForDate, insertRecurringChildAddons,
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

  for (const { id, to } of move) {
    const hostRow = hostByDate.get(to);
    const updates = { scheduled_date: to, updated_at: new Date() };
    if (hostRow) {
      updates.window_start = hostRow.window_start;
      updates.window_end = hostRow.window_end;
      updates.technician_id = hostRow.technician_id;
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
      const movingRow = riderRows.find((r) => r.id === id) || template;
      const standaloneTechId = await assignableRecurringTemplateTechnicianId(trx, movingRow, to);
      if (standaloneTechId !== movingRow.technician_id) updates.technician_id = standaloneTechId;
      const clashProbe = 'technician_id' in updates ? { ...movingRow, technician_id: updates.technician_id } : movingRow;
      if (await seriesCandidateDateClashes(trx, clashProbe, to)) {
        logger.warn(`[rider-series] parent=${riderParentId} standalone move of row ${id} to ${to} clashes with an existing visit — skipped this sync, retried next pass`);
        continue;
      }
    }
    await trx('scheduled_services').where({ id }).update(updates);
    await maybeGroupRow(id, { database: trx, createdBy: 'seeder' });
  }

  for (const { id, date } of refresh) {
    const hostRow = hostByDate.get(date);
    if (!hostRow) continue;
    await trx('scheduled_services').where({ id }).update({
      window_start: hostRow.window_start,
      window_end: hostRow.window_end,
      technician_id: hostRow.technician_id,
      updated_at: new Date(),
    });
    await maybeGroupRow(id, { database: trx, createdBy: 'seeder' });
  }

  // Add-ons for every insert (P1 fix #2): the PARENT's own add-on set run
  // through filterAddonLinesForDate per inserted date — the same
  // established recurring-writer path (extendSeriesOnceLocked /
  // runRecurringAlertAction), never a verbatim clone of one occurrence's
  // add-ons. FAILS CLOSED: an add-on read/insert error here throws straight
  // out of this loop, propagating out of syncRiderSeries's savepoint
  // (skipped: 'error'; the nightly reconcile retries) rather than landing a
  // rider visit missing its billable add-ons.
  const parentAddons = await trx('scheduled_service_addons').where({ scheduled_service_id: riderParentId });

  const insertedRows = [];
  const { createScheduledService } = require('./booking/create-scheduled-service');
  for (const d of insertDates) {
    const hostRow = hostByDate.get(d);
    let rowTemplate = template;
    if (!hostRow) {
      const standaloneTechId = await assignableRecurringTemplateTechnicianId(trx, template, d);
      rowTemplate = standaloneTechId === template.technician_id ? template : { ...template, technician_id: standaloneTechId };
      if (await seriesCandidateDateClashes(trx, rowTemplate, d)) {
        logger.warn(`[rider-series] parent=${riderParentId} standalone insert date ${d} clashes with an existing visit — skipped this sync, retried next pass`);
        continue;
      }
    }
    const rowData = buildRiderRowFromTemplate(rowTemplate, d, hostRow || null, riderParentId);
    const inserted = await createScheduledService({
      trx, insertData: rowData, cols, source: { sourceAction: 'recurring_series_rider_sync' },
    });
    if (inserted) {
      const dueAddons = filterAddonLinesForDate(parentAddons, riderParent.scheduled_date, d, blackoutDates, planCtx.skipRiderEffective);
      await insertRecurringChildAddons(trx, inserted.id, dueAddons);
      await maybeGroupRow(inserted.id, { database: trx, createdBy: 'seeder' });
      insertedRows.push(inserted);
    }
  }

  for (const { id } of cancelRows) {
    const fresh = await trx('scheduled_services').where({ id }).first('status');
    if (!fresh || TERMINAL_ROW_STATUSES.includes(fresh.status)) continue;
    try {
      await transitionJobStatus({
        jobId: id,
        fromStatus: fresh.status,
        toStatus: 'cancelled',
        transitionedBy: null,
        notes: 'rider_resync',
        trx,
        notifyCustomer: 'caller_suppress',
        suppressTechNotice: true,
      });
    } catch (err) {
      logger.warn(`[rider-series] cancel of surplus rider row ${id} skipped (race or guard mismatch): ${err.message}`);
    }
  }

  return insertedRows;
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
 * notifyCustomer: 'caller_suppress'.
 *
 * @param {object} conn - a knex connection or an open transaction.
 * @param {string} riderParentId
 * @param {{dryRun?: boolean, source?: string}} [opts]
 * @returns {Promise<{skipped?: string, keep: Array, move: Array,
 *   refresh: Array, insert: string[], cancel: Array, insertedRows?: Array}>}
 */
async function syncRiderSeries(conn, riderParentId, { dryRun = false, source = 'sync' } = {}) {
  const empty = () => ({
    keep: [], move: [], insert: [], cancel: [], refresh: [],
  });
  const run = async (trx) => {
    const ctx = await loadLockedRiderContext(trx, riderParentId);
    if (ctx.skip) return { ...empty(), skipped: ctx.skip };
    const { riderParent, hostParent, cols } = ctx;

    const eligibility = await resolveRiderEligibility(trx, riderParent, riderParentId, cols);
    if (eligibility.skip) return { ...empty(), skipped: eligibility.skip };

    const planCtx = await buildRiderSyncPlan(trx, cols, riderParent, hostParent, riderParentId);
    if (planCtx.noAnchor) return { ...empty(), skipped: 'no_anchor' };

    const diff = diffRiderPlan(planCtx);
    const result = {
      keep: diff.keep, move: diff.move, insert: diff.insertDates, cancel: diff.cancelRows, refresh: diff.refresh,
    };
    if (dryRun) return result;

    const insertedRows = await writeRiderPlan(trx, { cols, riderParent, riderParentId }, planCtx, diff);

    logger.info(
      `[rider-series] synced parent=${riderParentId} rides=${hostParent.id} source=${source} `
      + `keep=${diff.keep.length} move=${diff.move.length} refresh=${diff.refresh.length} `
      + `insert=${insertedRows.length} cancel=${diff.cancelRows.length}`,
    );
    return { ...result, insertedRows };
  };

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
    return await conn.transaction(run);
  } catch (err) {
    logger.error(`[rider-series] syncRiderSeries failed for parent=${riderParentId}: ${err.message}`);
    return { ...empty(), skipped: 'error' };
  }
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
    immovableByOwnFields, immovableRowIdSet, buildRiderRowFromTemplate, addDaysStr, tryLockSeriesMaintenance,
    computeRiderHorizon,
  },
};
