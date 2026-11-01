/**
 * ANNUAL PREPAY SEEDS: THE SERIES TECHNICIAN AND TIME (owner 2026-11-01,
 * "fix seeder"). Dark behind GATE_PREPAY_SEED_SERIES_SLOT
 * (feature-gates.js prepaySeedSeriesSlotLive, read at call time).
 *
 * ensureCoverageRowsForTerm (annual-prepay-renewals.js) seeds the visits a
 * prepaid year still owes. It wrote every one with technician_id = null and no
 * time, and the night auto-dispatch tool only places an untimed visit that has
 * a technician: a customer's 8 prepaid monthly visits sat for two months with
 * no technician and no time. Gate on, a seed copies the technician and the
 * usual start time of the customer's existing visit of the SAME service, by the
 * rules the recurring follow-up seeder applies to its follow-ups
 * (recurring-appointment-seeder.js seedFollowUpsForParent):
 *   - a technician who is not assignable (isAssignable) is not copied;
 *   - a date the technician is marked out (absentTechDays) stays unassigned;
 *   - the time is copied only while the taken-hour hand-off gate
 *     (GATE_PLAN_TAKEN_HOUR_HANDOFF) is on, and a start another stop already
 *     holds is left off with the date as recurring_dispatch_due_date
 *     (scheduling/plan-taken-hour.js), so the night tool picks a free hour.
 * Every read here is best effort: a slot read never fails a seed.
 */
const logger = require('./logger');
const { isAssignable, absentTechDays } = require('./technician-eligibility');

// The statuses that are no live visit (annual-prepay-renewals.js
// COVERAGE_EXCLUDED_STATUSES).
const NOT_A_SOURCE_STATUSES = ['cancelled', 'canceled', 'no_show', 'skipped', 'rescheduled'];

function ymd(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const m = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

// 'HH:MM' from a time column ('08:00:00' or '08:00'); null for anything else.
function hhmm(value) {
  const m = String(value || '').match(/^(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : null;
}

// The start a seed may copy: whole hours only (AGENTS.md: window_start is always HH:00:00).
function wholeHourStart(value) {
  const start = hhmm(value);
  return start && start.endsWith(':00') ? start : null;
}

// A best-effort read on a transaction runs in a savepoint: a failed query rolls back only the
// savepoint, so the caller's transaction (the seed insert, a payment activation) stays usable.
function inSavepoint(conn, read) {
  return conn && conn.isTransaction && typeof conn.transaction === 'function' ? conn.transaction((sp) => read(sp)) : read(conn);
}

function defaultNormalize(value) {
  return require('./annual-prepay-renewals').normalizeCoverageServiceType(value);
}

// The visit whose technician and time the seeds copy: the latest source dated
// on or before `today` (a completed one counts), else the earliest future one.
function pickSource(rows, today) {
  const dated = rows
    .map((row) => ({ row, date: ymd(row.scheduled_date) }))
    .filter((entry) => entry.date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.row.id).localeCompare(String(b.row.id))));
  const past = dated.filter((entry) => entry.date <= today);
  if (past.length) return past[past.length - 1].row;
  return dated.length ? dated[0].row : null;
}

async function assignableTechnicianId(conn, technicianId) {
  let query = conn('technicians').where({ id: technicianId });
  if (conn.isTransaction) query = query.forShare();
  const tech = await query.first('id', 'employment_status', 'field_dispatchable');
  return isAssignable(tech) ? technicianId : null;
}

/**
 * The slot a term's seeded visits copy, or null. `{ technicianId, windowStart }`:
 * technicianId is null when the source's technician is not assignable (the
 * time may still be copied); windowStart is null when the source starts off the
 * hour (the technician is still copied). Null when the seed's property is not
 * resolved: coverageSeedPropertyId gives null for a customer with several active
 * properties (or a deactivated primary), and those seeds stay office-placed;
 * another property's visit must never supply their technician or time. A
 * customer with no property row gets its primary backfilled by
 * soleActivePropertyId, so it resolves. Reads in a savepoint. Never throws.
 */
async function coverageSeriesSlot(conn, {
  customerId, coverageServiceType, propertyId = null, today, normalize = defaultNormalize,
} = {}) {
  try {
    if (!customerId || !coverageServiceType || !propertyId) return null;
    const wanted = normalize(coverageServiceType);
    return await inSavepoint(conn, async (q) => {
      const rows = await q('scheduled_services')
        .where({ customer_id: customerId })
        .whereNotIn('status', NOT_A_SOURCE_STATUSES)
        .whereNotNull('technician_id')
        .whereNotNull('window_start')
        .select('id', 'service_type', 'property_id', 'scheduled_date', 'technician_id', 'window_start');
      const sources = (rows || []).filter((row) => normalize(row.service_type) === wanted
        && (row.property_id == null || String(row.property_id) === String(propertyId))
        && hhmm(row.window_start));
      const source = pickSource(sources, today);
      if (!source) return null;
      return {
        technicianId: await assignableTechnicianId(q, source.technician_id),
        windowStart: wholeHourStart(source.window_start),
      };
    });
  } catch (err) {
    logger.warn(`[annual-prepay-series-slot] customer ${customerId} slot read failed (${err.message}) — seeding without a technician or time`);
    return null;
  }
}

/**
 * The slot technician rechecked on the seed's own transaction (FOR SHARE, so an
 * offboarding's FOR UPDATE cannot commit under the insert), in a savepoint: the
 * recurring seeder's rule (seedFollowUpsForParent reads the inherited
 * technician FOR SHARE on the writing transaction). Null when the technician is
 * no longer assignable or the read fails. Never throws.
 */
async function recheckTechnician(trx, technicianId) {
  if (!technicianId) return null;
  try {
    return await inSavepoint(trx, (q) => assignableTechnicianId(q, technicianId));
  } catch (err) {
    logger.warn(`[annual-prepay-series-slot] technician ${technicianId} recheck failed (${err.message}) — seeding without a technician`);
    return null;
  }
}

// The `${technicianId}:${date}` keys of the dates in `dates` the slot's
// technician is marked out. Empty when the slot has no technician. Reads in a savepoint. Never throws.
async function seriesSlotAbsentDays(conn, slot, dates) {
  const sorted = (dates || []).map(ymd).filter(Boolean).sort();
  if (!slot?.technicianId || !sorted.length) return new Set();
  try {
    return await inSavepoint(conn, (q) => absentTechDays(q, {
      dateFrom: sorted[0], dateTo: sorted[sorted.length - 1], technicianIds: [slot.technicianId],
    }));
  } catch (err) {
    logger.warn(`[annual-prepay-series-slot] technician ${slot.technicianId} absence read failed (${err.message}) — seeding without a technician`);
    return new Set([...sorted].map((d) => `${slot.technicianId}:${d}`));
  }
}

/**
 * What one seeded visit takes from the slot: `{ technicianId, windowStart }`.
 * The technician is null on a day they are out. An untimed seed takes the
 * time only while the taken-hour hand-off gate is on; a timed seed (the
 * promised first visit) keeps its own window and takes the technician only.
 */
function seriesSlotPatch(slot, { scheduledDate, absentDays = new Set(), timed = false } = {}) {
  const techId = slot.technicianId && !absentDays.has(`${slot.technicianId}:${ymd(scheduledDate)}`)
    ? slot.technicianId
    : null;
  const copyTime = !timed && require('./scheduling/plan-taken-hour').handoffEnabled();
  return { technicianId: techId, windowStart: copyTime ? slot.windowStart : null };
}

// The fields that drop a copied time and nothing else (the seed is written as before the gate).
function clearedWindow(cols) {
  const fields = { window_start: null, window_end: null };
  return cols ? Object.fromEntries(Object.entries(fields).filter(([key]) => cols[key])) : fields;
}

/**
 * Whether a seed row with a copied time keeps it, read under the occupancy date
 * lock (scheduling/occupancy.js ordering contract: the date lock, the hour read
 * and the timed INSERT sit in ONE transaction). Null = the seed keeps the copied
 * time; otherwise the fields that replace it:
 *   - under 4 days out (before the hand-off date) a copied time is never
 *     written, since the taken-hour rule does not look there: the cleared window;
 *   - from the hand-off date the TRY-lock is taken in a savepoint of the seed's
 *     transaction (held by that transaction through the insert, as
 *     seedTimedFirstVisit does) and the taken-hour rule reads the hour; taken ->
 *     the hand-off fields (windowless + recurring_dispatch_due_date: the night
 *     tool picks a free hour);
 *   - a busy lock, a failed read, or a connection that is not a transaction
 *     (it cannot fence the insert) counts as a taken hour.
 */
async function seriesSlotHandoff(conn, row, { cols = null, now = new Date() } = {}) {
  if (!row?.window_start) return null;
  const planTakenHour = require('./scheduling/plan-taken-hour');
  const day = ymd(row.scheduled_date);
  if (!day || day < planTakenHour.firstHandoffDate(now)) return clearedWindow(cols);
  const handOff = () => planTakenHour.handoffFields(row.scheduled_date, cols);
  if (!conn?.isTransaction || typeof conn.transaction !== 'function') return handOff();
  try {
    const taken = await conn.transaction(async (sp) => {
      const { tryAcquireOccupancyLock } = require('./scheduling/occupancy');
      if (!(await tryAcquireOccupancyLock(sp, day))) throw new Error('occupancy date lock unavailable');
      return planTakenHour.takenHourHandoff(sp, row, { now });
    });
    return taken ? handOff() : null;
  } catch (err) {
    logger.warn(`[annual-prepay-series-slot] ${day}: ${err.message} — seeding without the copied time for the night tool`);
    return handOff();
  }
}

module.exports = {
  inSavepoint,
  recheckTechnician,
  coverageSeriesSlot,
  seriesSlotAbsentDays,
  seriesSlotPatch,
  seriesSlotHandoff,
  NOT_A_SOURCE_STATUSES,
};
