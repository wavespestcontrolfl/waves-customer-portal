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
 * time may still be copied). Never throws.
 */
async function coverageSeriesSlot(conn, {
  customerId, coverageServiceType, propertyId = null, today, normalize = defaultNormalize,
} = {}) {
  try {
    if (!customerId || !coverageServiceType) return null;
    const wanted = normalize(coverageServiceType);
    const rows = await conn('scheduled_services')
      .where({ customer_id: customerId })
      .whereNotIn('status', NOT_A_SOURCE_STATUSES)
      .whereNotNull('technician_id')
      .whereNotNull('window_start')
      .select('id', 'service_type', 'property_id', 'scheduled_date', 'technician_id', 'window_start');
    const sources = (rows || []).filter((row) => normalize(row.service_type) === wanted
      && (!propertyId || row.property_id == null || String(row.property_id) === String(propertyId))
      && hhmm(row.window_start));
    const source = pickSource(sources, today);
    if (!source) return null;
    return {
      technicianId: await assignableTechnicianId(conn, source.technician_id),
      windowStart: hhmm(source.window_start),
    };
  } catch (err) {
    logger.warn(`[annual-prepay-series-slot] customer ${customerId} slot read failed (${err.message}) — seeding without a technician or time`);
    return null;
  }
}

// The `${technicianId}:${date}` keys of the dates in `dates` the slot's
// technician is marked out. Empty when the slot has no technician. Never throws.
async function seriesSlotAbsentDays(conn, slot, dates) {
  const sorted = (dates || []).map(ymd).filter(Boolean).sort();
  if (!slot?.technicianId || !sorted.length) return new Set();
  try {
    return await absentTechDays(conn, {
      dateFrom: sorted[0], dateTo: sorted[sorted.length - 1], technicianIds: [slot.technicianId],
    });
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

/**
 * The hand-off fields for a seed row that has a copied time (null when the
 * hour is free or the gate is off): the row goes windowless with its date as
 * recurring_dispatch_due_date, as the follow-up seeder does. A probe that
 * cannot answer counts as a taken hour: from the hand-off date (4 days out)
 * the row is handed off, nearer it keeps the copied hour, as every plan
 * writer keeps a nearer hour (the night tool's double-booking notice).
 */
async function seriesSlotHandoff(conn, row, { cols = null, now = new Date() } = {}) {
  if (!row?.window_start) return null;
  const planTakenHour = require('./scheduling/plan-taken-hour');
  try {
    if (!(await planTakenHour.takenHourHandoff(conn, row, { now }))) return null;
    return planTakenHour.handoffFields(row.scheduled_date, cols);
  } catch (err) {
    const day = ymd(row.scheduled_date);
    const handOff = !!day && day >= planTakenHour.firstHandoffDate(now);
    logger.warn(`[annual-prepay-series-slot] taken-hour probe failed for ${day} (${err.message}) — ${handOff
      ? 'seeding without a time for the night tool' : 'keeping the copied time (inside the hand-off window)'}`);
    return handOff ? planTakenHour.handoffFields(row.scheduled_date, cols) : null;
  }
}

module.exports = {
  coverageSeriesSlot,
  seriesSlotAbsentDays,
  seriesSlotPatch,
  seriesSlotHandoff,
  NOT_A_SOURCE_STATUSES,
};
