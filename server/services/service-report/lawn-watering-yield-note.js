/**
 * Staff note on the customer's next lawn visit when a bait's no-water hold gave
 * way to a water-in its label requires (owner ruling 2026-10-24).
 *
 * The write gate freezes the watering instruction with an optional
 * `yielded: { holds: [names], waterIns: [names] }`, present only when a bait's
 * own no-water hold (Advion Insect Granule) yielded to a water-in the label
 * requires on the same visit. The bait then got watered in, so it may need to
 * go down again. This appends ONE dated line to the next live LAWN visit's
 * staff-only job-card note (next-visit-note.js; never shown to the customer):
 *
 *   [From 10/24 visit] The customer was told to water Advion Insect Granule in
 *   with Dylox 6.2 G, whose label needs it. The bait may need to go down again.
 *
 * Best-effort: never throws, never blocks or fails the completion. No lawn
 * visit ahead, or no `yielded` field, writes nothing.
 */
const logger = require('../logger');
const { etCalendarDayOf, etDateString } = require('../../utils/datetime-et');
const { detectServiceLine } = require('./service-line-configs');
const { storeNextVisitNote, isLiveNextVisitTarget, DEAD_VISIT_STATUSES } = require('../next-visit-note');

const names = (list) => (Array.isArray(list) ? list.filter((n) => typeof n === 'string' && n.trim() !== '') : []);

function yieldNoteText(yielded) {
  const holds = names(yielded && yielded.holds);
  if (!holds.length) return null;
  const waterIns = names(yielded.waterIns).join(' and ') || 'another product';
  return `The customer was told to water ${holds.join(' and ')} in with ${waterIns}, whose label needs it. The bait may need to go down again.`;
}

// The customer's live future visits after the completed visit's day (the
// next-visit fallback rule), earliest first; the first LAWN one is the target.
async function findNextLawnVisitId(k, completed) {
  const floor = [etCalendarDayOf(completed.date), etDateString()].sort().pop();
  const rows = await k('scheduled_services')
    .where({ customer_id: completed.customerId })
    .whereNot('id', completed.id)
    .where('scheduled_date', '>', floor)
    .whereNotIn('status', DEAD_VISIT_STATUSES)
    .orderBy('scheduled_date', 'asc')
    .orderBy('id', 'asc')
    .select('id', 'customer_id', 'status', 'technician_id', 'service_type', 'scheduled_date');
  const target = rows.find((row) => detectServiceLine(row.service_type) === 'lawn'
    && isLiveNextVisitTarget({
      target: { ...row, scheduled_date: etCalendarDayOf(row.scheduled_date) },
      completed,
      actor: {},
    }));
  return target ? target.id : null;
}

/**
 * @param {object} args
 * @param {object} args.svc          the completed scheduled_services row (id, customer_id, scheduled_date)
 * @param {object} args.instruction  the frozen watering instruction (may carry `yielded`)
 * @param {object} [deps]            { db, storeNote } for tests
 * @returns {Promise<{status: string}>} never throws
 */
async function storeLawnWateringYieldNote({ svc, instruction }, deps = {}) {
  try {
    const note = yieldNoteText(instruction && instruction.yielded);
    if (!note || !svc || !svc.customer_id || !svc.scheduled_date) return { status: 'skipped' };
    const database = deps.db || require('../../models/db');
    const storeNote = deps.storeNote || storeNextVisitNote;
    const completed = { id: svc.id, customerId: svc.customer_id, date: svc.scheduled_date };
    return await database.transaction(async (trx) => {
      const nextVisitId = await findNextLawnVisitId(trx, completed);
      if (!nextVisitId) return { status: 'no_lawn_visit' };
      return storeNote(trx, { completed, note, nextVisitId, actor: {} });
    });
  } catch (err) {
    logger.warn(`[completion] watering yield note not stored for service ${svc && svc.id}: ${(err && (err.code || err.name)) || 'error'}`);
    return { status: 'error' };
  }
}

module.exports = { storeLawnWateringYieldNote, yieldNoteText, findNextLawnVisitId };
