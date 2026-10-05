/**
 * Package follow-up auto-booking — visit 2 of a two-treatment package is put
 * on the schedule the moment visit 1 is booked (owner ruling 2026-10-04:
 * "flea treatment and cockroach treatment should be by default two
 * treatments, two weeks apart"; status confirmed; no weekend roll; bed bug
 * added the same day: "visit two should be same time, we don't want to
 * confirm, they get reminders, they can reschedule").
 *
 * Before this, the second treatment only reached the calendar through the
 * Dispatch closeout card (completion-followup-booking.js) or a phone call
 * that explicitly discussed a follow-up (call-recording-processor
 * ensureCallFollowUpVisit). Every other booking path — admin Schedule
 * create, estimate acceptance (public + one-tap), public self-book, the
 * Intelligence Bar, the Leads page — booked visit 1 alone.
 *
 * Office-review bookings (the voice agent's and the outbound-callback
 * pipeline's pending rows) get visit 2 when the office CONFIRMS visit 1
 * (job-status.js): a pending request is not a booking yet. The call
 * pipeline writes its own child (it carries the call's linkage and number
 * hold) in this same confirmed shape — see ensureCallFollowUpVisit.
 *
 * One helper, called by each primary writer INSIDE its own transaction,
 * right after the primary row exists:
 *   ensurePackageFollowUpVisit({ trx, primary, cols? })
 * It is a no-op (returns null) unless ALL of:
 *   - GATE_PACKAGE_FOLLOWUP_AUTOBOOK is exactly 'true' (call-time read);
 *   - the primary resolves to a package catalog row (service_id, else
 *     service_key_snapshot, else — for a row with neither — an exact name
 *     match on one live package row) whose service_key is in
 *     PACKAGE_FOLLOWUP_SERVICE_KEYS;
 *   - the primary is a real customer visit: customer_id set, a calendar
 *     date, not recurring, not a callback, not itself an included
 *     follow-up, not terminal, not a slot hold (reservation_expires_at).
 * Idempotent per source visit: an existing live child linked by
 * followup_source_service_id is returned as-is (the partial unique index
 * uq_scheduled_services_followup_source_open caps one live child per
 * source, so a 23505 race also resolves to the winner).
 *
 * The child row:
 *   - scheduled_date = primary date + the catalog's follow_up_interval_days
 *     (14 when unset), ET calendar days, NO weekend/blackout roll (owner);
 *   - inherits the primary's technician (unassigned when no longer
 *     assignable), window, duration, property/address/coords, payer;
 *   - status 'confirmed' (owner ruling) with customer_confirmed false —
 *     the customer can still confirm/reschedule it from the portal;
 *   - $0 + followup_included + create_invoice_on_complete false: the
 *     package price on visit 1 covers both treatments (same billing shape
 *     the closeout CTA and the call pipeline write; job-costing zeroes it,
 *     typedFollowupVerdict's included_followup_visit stop means it never
 *     owes a third visit, review-request treats the linked pair as one
 *     series);
 *   - parent_service_id + followup_source_service_id both point at visit 1
 *     (the shift/cancel hooks key on parent_service_id + source_action;
 *     the closeout pre-check, uniqueness and review logic key on
 *     followup_source_service_id);
 *   - source_action PACKAGE_FOLLOWUP_SOURCE_ACTION, so the call-pipeline
 *     shift/cancel hooks (call-booking-catalog.js) carry it with its
 *     parent and every other parent-linked flow stays untouched.
 *
 * Occupancy: ADVISORY. The child's slot is probed tech-scoped and
 * lock-free (the caller already holds rung-1 locks for the PRIMARY's date;
 * taking a second date key mid-transaction would invert the
 * scheduling/occupancy.js ORDERING CONTRACT). A clash still books — owner
 * ruling 2026-08-25, staff-side saves never block on conflicts — and rings
 * a Schedule needs-you card so the office re-spaces it. The probe runs in
 * its own savepoint (a failed probe statement must not abort the child's);
 * the card is raised only after the caller's outermost commit.
 *
 * Reminders: NOT registered here (customer comms never ride a booking
 * helper — booking contract header). The reminder self-heal sweep
 * (appointment-reminders selfHealMissingReminderRows, ≤15 min) registers
 * the row with confirmation_sent=true: 72h/24h reminders arm, no
 * confirmation text goes out for visit 2.
 *
 * Insert goes through createScheduledService (booking contract) — the
 * insert-site ratchet (booking-insert-contract.test.js) certifies it.
 */
const logger = require('./logger');
const { packageFollowupAutobookLive } = require('../config/feature-gates');
const { createScheduledService } = require('./booking/create-scheduled-service');
const { FOLLOWUP_CHILD_INACTIVE_STATUSES } = require('./typed-followup-obligation');
const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');

// Owner scope 2026-10-04: cockroach, flea and bed bug — the same set as
// typed-followup-obligation TWO_TREATMENT_PACKAGE_KEYS.
const PACKAGE_FOLLOWUP_SERVICE_KEYS = Object.freeze(['cockroach_control', 'flea_tick', 'bed_bug_treatment']);
// scheduled_services.source_action is varchar(30).
const PACKAGE_FOLLOWUP_SOURCE_ACTION = 'package_followup_auto';
const DEFAULT_PACKAGE_FOLLOWUP_DAYS = 14;
const TERMINAL_PRIMARY_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];

const dateOnly = (v) => {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (v == null) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const hhmm = (v) => {
  const m = String(v || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
};

function isPackageFollowUpServiceKey(serviceKey) {
  return PACKAGE_FOLLOWUP_SERVICE_KEYS.includes(String(serviceKey || ''));
}

// Visit 2's calendar date: visit 1 + interval, ET calendar days anchored at
// noon so DST seams can't shift the day. No weekend or blackout roll.
function packageFollowUpDate(primaryDate, intervalDays) {
  const base = dateOnly(primaryDate);
  if (!base) return null;
  const days = Number(intervalDays) > 0 ? Number(intervalDays) : DEFAULT_PACKAGE_FOLLOWUP_DAYS;
  const anchor = parseETDateTime(`${base}T12:00`);
  if (Number.isNaN(anchor.getTime())) return null;
  return etDateString(addETDays(anchor, days));
}

// The catalog row the primary was sold as: service_id first (completion
// resolution trusts it before any label), then the durable key snapshot.
// A row with NEITHER (the availability confirm path writes only the
// estimate's service label) resolves on an exact, case-insensitive name
// match to exactly one live package row — never a fuzzy label read.
// Null when nothing names a live package row.
async function resolvePackageCatalogRow(trx, primary) {
  const cols = ['id', 'service_key', 'name', 'category', 'follow_up_interval_days', 'default_duration_minutes'];
  if (primary.service_id) {
    const byId = await trx('services').where({ id: primary.service_id }).first(cols);
    return byId && isPackageFollowUpServiceKey(byId.service_key) ? byId : null;
  }
  const key = String(primary.service_key_snapshot || '').trim();
  if (key) {
    if (!isPackageFollowUpServiceKey(key)) return null;
    const byKey = await trx('services').where({ service_key: key, is_active: true }).whereRaw('is_archived IS NOT TRUE').select(cols);
    return byKey.length === 1 ? byKey[0] : null;
  }
  const label = String(primary.service_type || '').trim().toLowerCase();
  if (!label) return null;
  const byName = await trx('services').whereIn('service_key', PACKAGE_FOLLOWUP_SERVICE_KEYS)
    .where({ is_active: true }).whereRaw('is_archived IS NOT TRUE').whereRaw('lower(trim(name)) = ?', [label]).select(cols);
  return byName.length === 1 ? byName[0] : null;
}

function primaryEligible(primary) {
  if (!primary || !primary.id || !primary.customer_id) return false;
  if (!dateOnly(primary.scheduled_date)) return false;
  if (primary.reservation_expires_at) return false; // an estimate slot hold, not a booking yet
  if (primary.is_recurring === true || primary.recurring_parent_id) return false;
  if (primary.is_callback === true) return false;
  if (primary.followup_included === true || primary.followup_source_service_id) return false; // never chain off visit 2
  if (TERMINAL_PRIMARY_STATUSES.includes(String(primary.status || ''))) return false;
  return true;
}

async function liveChildOf(trx, primaryId) {
  return trx('scheduled_services')
    .where({ followup_source_service_id: primaryId })
    .whereNotIn('status', FOLLOWUP_CHILD_INACTIVE_STATUSES)
    .first('id', 'scheduled_date', 'status', 'technician_id', 'source_action', 'customer_confirmed');
}

// An outbound-callback booking's visit 2 was written by the call pipeline
// while visit 1 was still a pending office-review request: pending,
// customer-hidden, "confirm the time". Once the office confirms visit 1 the
// owner ruling applies to it too (nobody confirms visit 2): flip it to
// confirmed through the canonical status writer and hand it the package
// marker, so the customer sees it and the move/cancel hooks carry it.
async function promotePendingCallChild(sp, child) {
  const { CALL_FOLLOWUP_SOURCE_ACTION } = require('./call-booking-source-actions');
  if (child.source_action !== CALL_FOLLOWUP_SOURCE_ACTION || child.status !== 'pending' || child.customer_confirmed) return child;
  await require('./job-status').transitionJobStatus({
    jobId: child.id, fromStatus: 'pending', toStatus: 'confirmed', transitionedBy: null,
    notes: 'Package visit 2 confirmed with visit 1', trx: sp,
  });
  const now = new Date();
  await sp('scheduled_services').where({ id: child.id })
    .update({ source_action: PACKAGE_FOLLOWUP_SOURCE_ACTION, confirmed_at: now, updated_at: now });
  logger.info(`[package-followup] pending call-booked visit 2 ${child.id} confirmed with its package visit 1`);
  return { ...child, status: 'confirmed', source_action: PACKAGE_FOLLOWUP_SOURCE_ACTION };
}

// Advisory, lock-free, tech-scoped: the office hears about a clash on a
// Schedule needs-you card; the booking is never blocked. The probe reads
// through its OWN savepoint so a failed statement rolls back only itself
// (a caught error would otherwise leave the child's savepoint aborted and
// lose the insert). The card waits for the caller's outermost commit: a
// later rollback must not leave a card pointing at a visit that never was.
async function warnOnOverlap(trx, { child, customerId, outerTrx }) {
  const start = hhmm(child.window_start);
  const end = hhmm(child.window_end);
  if (!start || !end) return;
  let clash = [];
  try {
    const { findConflictingVisits } = require('./scheduling/occupancy');
    clash = await trx.transaction((probeSp) => findConflictingVisits({
      db: probeSp,
      date: child.scheduled_date,
      windowStart: start,
      windowEnd: end,
      excludeServiceIds: [String(child.id)],
      excludeStatuses: ['cancelled', 'completed', 'skipped', 'no_show'],
      technicianId: child.technician_id || null,
    }));
  } catch (err) {
    logger.warn(`[package-followup] overlap probe failed for child ${child.id} (booked unprobed): ${err.message}`);
    return;
  }
  if (!clash.length) return;
  const raise = async () => {
    const { raiseAdminAlert } = require('./admin-alert-compose');
    await raiseAdminAlert('schedule_conflict', {
      area: 'Schedule',
      action: 'Second treatment overlaps another visit',
      why: 'Visit 2 was booked two weeks after visit 1 onto a slot that already has a stop.',
      severity: 'needs-you',
      who: 'person',
      subject: { type: 'visit', id: String(child.id) },
      doneWhen: 'followup_respaced',
      link: `/admin/dispatch?tab=schedule&date=${child.scheduled_date}&appointment=${encodeURIComponent(child.id)}`,
    }, { dedupeKey: `package_followup_overlap:${child.id}`, metadata: { customer_id: customerId, scheduled_service_id: child.id, parent_service_id: child.parent_service_id } });
  };
  const onFail = (err) => logger.error(`[package-followup] overlap card failed for child ${child.id}: ${err.message}`);
  const { commitPromiseOf } = require('../utils/trx-commit-promise');
  const committed = commitPromiseOf(outerTrx) || commitPromiseOf(trx);
  if (committed) {
    // A rolled-back booking has nothing to flag.
    committed.then(() => raise().catch(onFail), () => {});
    return;
  }
  await raise().catch(onFail);
}

function buildChildInsert(primary, catalogRow, cols, { date, technicianId, now }) {
  const windowStart = hhmm(primary.window_start);
  const windowEnd = hhmm(primary.window_end);
  const data = {
    customer_id: primary.customer_id,
    technician_id: technicianId,
    scheduled_date: date,
    window_start: windowStart,
    window_end: windowEnd,
    service_type: primary.service_type,
    status: 'confirmed',
    customer_confirmed: false,
    confirmed_at: now,
    is_recurring: false,
    notes: `Treatment 2 of 2 — included in the package price; booked ${Number(catalogRow.follow_up_interval_days) > 0 ? Number(catalogRow.follow_up_interval_days) : DEFAULT_PACKAGE_FOLLOWUP_DAYS} days after the initial visit.`,
    parent_service_id: primary.id,
    followup_source_service_id: primary.id,
    followup_included: true,
  };
  const copy = (col, value) => { if (cols[col] && value != null) data[col] = value; };
  copy('service_id', catalogRow.id);
  copy('service_key_snapshot', catalogRow.service_key);
  copy('service_category_snapshot', catalogRow.category);
  copy('payer_id', primary.payer_id);
  copy('property_id', primary.property_id);
  copy('lat', primary.lat);
  copy('lng', primary.lng);
  copy('service_address_line1', primary.service_address_line1);
  copy('service_address_line2', primary.service_address_line2);
  copy('service_address_city', primary.service_address_city);
  copy('service_address_state', primary.service_address_state);
  copy('service_address_zip', primary.service_address_zip);
  copy('zone', primary.zone);
  copy('time_window', primary.time_window);
  copy('window_display', primary.window_display);
  copy('estimated_duration_minutes', Number(primary.estimated_duration_minutes) > 0
    ? Number(primary.estimated_duration_minutes)
    : (Number(catalogRow.default_duration_minutes) > 0 ? Number(catalogRow.default_duration_minutes) : null));
  if (cols.estimated_price) data.estimated_price = 0;
  if (cols.create_invoice_on_complete) data.create_invoice_on_complete = false;
  if (cols.booking_source && primary.booking_source) data.booking_source = primary.booking_source;
  return data;
}

/**
 * Book visit 2 for a freshly booked package visit 1. Call INSIDE the
 * primary writer's transaction with the committed-shape primary row (the
 * insert/update RETURNING row). Returns the child row, the existing live
 * child, or null when nothing applies.
 *
 * Runs in a SAVEPOINT on the caller's transaction (same posture as the
 * call pipeline's ensureCallFollowUpVisit): a rejected child write rolls
 * back only itself — the primary booking commits, the failure is logged,
 * and dispatch's closeout card remains the fallback path for visit 2.
 */
async function ensurePackageFollowUpVisit({ trx, primary, cols = null, promotePendingCallFollowUp = false } = {}) {
  if (!packageFollowupAutobookLive()) return null;
  if (!trx || !primaryEligible(primary)) return null;
  try {
    return await trx.transaction((sp) => bookInSavepoint(sp, trx, primary, cols, { promotePendingCallFollowUp }));
  } catch (err) {
    logger.error(`[package-followup] visit 2 not booked for ${primary.id}; primary booking kept: ${err.message}`);
    return null;
  }
}

async function bookInSavepoint(sp, outerTrx, primary, cols, { promotePendingCallFollowUp = false } = {}) {
  const catalogRow = await resolvePackageCatalogRow(sp, primary);
  if (!catalogRow) return null;
  const existing = await liveChildOf(sp, primary.id);
  if (existing) return promotePendingCallFollowUp ? promotePendingCallChild(sp, existing) : existing;
  const date = packageFollowUpDate(primary.scheduled_date, catalogRow.follow_up_interval_days);
  if (!date) return null;
  const columns = cols || await sp('scheduled_services').columnInfo();
  if (!columns.followup_source_service_id || !columns.followup_included || !columns.parent_service_id || !columns.source_action) {
    logger.warn('[package-followup] scheduled_services lacks the follow-up link columns; skipping auto-book');
    return null;
  }
  // Inherit the primary's tech; one no longer assignable on the child's
  // day lands the child unassigned (same posture as the closeout CTA).
  let technicianId = primary.technician_id || null;
  if (technicianId) {
    try {
      const { assertAssignableTechnician } = require('./technician-eligibility');
      await assertAssignableTechnician(technicianId, { conn: sp, date });
    } catch (eligErr) {
      if (eligErr.code !== 'TECH_NOT_ASSIGNABLE') throw eligErr;
      logger.warn(`[package-followup] technician ${technicianId} not assignable on ${date}; booking visit 2 unassigned`);
      technicianId = null;
    }
  }
  const insertData = buildChildInsert(primary, catalogRow, columns, { date, technicianId, now: new Date() });
  let child;
  try {
    child = await createScheduledService({
      trx: sp, insertData, cols: columns,
      source: { sourceAction: PACKAGE_FOLLOWUP_SOURCE_ACTION },
    });
  } catch (insertErr) {
    // Lost the one-live-child race (uq_scheduled_services_followup_source_open)
    // to a concurrent writer: the obligation is covered either way. The
    // failed statement aborted THIS savepoint, so the winner is read on the
    // outer transaction.
    if (insertErr && insertErr.code === '23505') {
      const winner = await liveChildOf(outerTrx, primary.id);
      if (winner) return winner;
    }
    throw insertErr;
  }
  if (!child) return null;
  // Visit groups (visit-group-scope.md §2): stamp at scheduling —
  // gate-checked + best-effort + self-refusing inside maybeGroupRow.
  await require('./visit-groups').maybeGroupRow(child.id, { database: sp, createdBy: 'dispatch' });
  // Tech-facing "new visit" card: this writer inserts the assigned row
  // itself; rides the OUTER trx so it waits for the caller's commit.
  // Gate-dark, never awaited.
  if (child.technician_id) {
    void require('./tech-visit-notifications').notifyTechVisitChange({
      visitId: child.id, kind: 'assigned', technicianId: child.technician_id, actorId: null,
      snapshot: { date, windowStart: child.window_start || null, windowEnd: child.window_end || null },
      trx: outerTrx,
    });
  }
  await warnOnOverlap(sp, { child: { ...child, scheduled_date: date }, customerId: primary.customer_id, outerTrx });
  logger.info(`[package-followup] visit 2 ${child.id} booked for ${date} from ${catalogRow.service_key} visit ${primary.id}`);
  return child;
}

module.exports = {
  ensurePackageFollowUpVisit,
  warnOnOverlap,
  isPackageFollowUpServiceKey,
  packageFollowUpDate,
  buildChildInsert,
  PACKAGE_FOLLOWUP_SERVICE_KEYS,
  PACKAGE_FOLLOWUP_SOURCE_ACTION,
  DEFAULT_PACKAGE_FOLLOWUP_DAYS,
};
