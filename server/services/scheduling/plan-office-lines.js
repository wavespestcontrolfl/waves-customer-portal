/**
 * GATE_TECH_SHIFT_HOURS (D4 part 3c): the office's Edit save is told about the
 * plan's OTHER visits from the rows it leaves.
 *
 * One Edit save can change the other visits of a plan in several steps: the
 * assignment's scope (this and following, the whole plan), the cadence rewrite
 * that re-dates them after it, the hours it copies to them, the visits it
 * adds. A line read at any one of those steps can name a day or a technician
 * the visit no longer has when the save ends. So no step answers. The save
 * reads the plan's open rows before its first write (planRowsBefore) and after
 * its last (planOfficeLines), and asks about each other visit whose row is not
 * the row it was:
 *   - a visit the save added, or left on another day or another technician:
 *     the day-off line, or the shift line when the shift does not hold it;
 *   - a visit that kept its day and its technician and has another block (the
 *     hours and the stored length, rowBlockMinutes): the shift line alone, as
 *     an hours-only save of one visit is told;
 *   - the same day, technician and block: not asked. A visit with no
 *     technician gets no line (the line reader's own rule).
 * The edited visit is told by the save itself, from the values it writes
 * (routes/admin-schedule.js), and is left out here. Each line comes back once.
 *
 * Both reads are savepoint reads on the save's transaction: a read that fails
 * is logged and gives no line. An advisory line never fails a save.
 * Gate off: no read and no line.
 *
 * The two reads take no row lock: an advisory line is not worth a lock that can
 * hold or fail another writer. So another writer (a move of one other visit,
 * an assignment from the board) can commit a change to one of the plan's
 * visits between the reads. That change is not this save's: of the visits whose
 * row is not the row it was, only those whose row THIS transaction wrote are
 * asked about (writtenHere).
 */
const { techShiftHoursLive } = require('../../config/feature-gates');
const { failSoftRead } = require('../../utils/savepoint-read');
const { rowBlockMinutes } = require('./window-rules');

// A visit in one of these is closed: the save does not place it, and no line is about it.
const CLOSED = ['completed', 'cancelled', 'rescheduled', 'skipped', 'no_show'];
const FAILED = Symbol('read failed');

const same = (a, b) => String(a || '') === String(b || '');

function sameBlock(was, row) {
  const [a, b] = [rowBlockMinutes(was), rowBlockMinutes(row)];
  return a.startMin === b.startMin && a.endMin === b.endMin;
}

async function read(conn, what, query) {
  const out = await failSoftRead(conn, query, FAILED);
  if (out === FAILED) require('../logger').warn(`[plan-office-lines] the plan's rows ${what} the save were not read: no line for the plan's other visits`);
  return out === FAILED ? null : out;
}

// The id of the transaction that wrote a row, as pg_xact_status takes it. The row holds 32 bits of it (xmin)
// and the function takes 64: of the ids that end in those 32 bits, the one nearest this transaction's own.
const ROW_WRITER = `(pg_current_xact_id()::text::bigint
  + ((xmin::text::bigint - (pg_current_xact_id()::text::bigint & 4294967295) + 6442450944) % 4294967296) - 2147483648)::text::xid8`;

// The ids among `ids` whose row THIS transaction wrote. A statement sees a row that a committed transaction
// wrote, or that its own transaction wrote (inside a savepoint too). So a row it sees whose writer is not
// committed yet is its own, and a row another writer changed and committed meanwhile is not.
const writtenHere = (c, ids) => c('scheduled_services').whereIn('id', ids)
  .whereRaw(`pg_xact_status(${ROW_WRITER}) = 'in progress'`).pluck('id');

const openRows = (c, planIds) => c('scheduled_services')
  .where((q) => q.whereIn('id', planIds).orWhereIn('recurring_parent_id', planIds))
  .whereNotIn('status', CLOSED)
  .orderBy('scheduled_date')
  .orderBy('id')
  .select('id', 'technician_id', 'window_start', 'window_end', 'estimated_duration_minutes', c.raw("to_char(scheduled_date, 'YYYY-MM-DD') as day"));

/**
 * The plan's open rows as the save finds them: `{ planIds, rows: Map(id -> row) }`.
 * `planIds` is the edited visit and its plan's first visit: the plan is those
 * two and every visit that names either as its plan. null (and no read) with
 * the gate off; null when the visit is gone or the read fails.
 */
async function planRowsBefore(conn, visitId) {
  if (!techShiftHoursLive()) return null;
  return read(conn, 'before', async (c) => {
    const visit = await c('scheduled_services').where({ id: visitId }).first('id', 'recurring_parent_id');
    if (!visit) return null;
    const planIds = [...new Set([visit.id, visit.recurring_parent_id].filter(Boolean))];
    return { planIds, rows: new Map((await openRows(c, planIds)).map((row) => [String(row.id), row])) };
  });
}

/**
 * The lines about the plan's other visits, from the rows the save leaves.
 * `before` is planRowsBefore's answer from before the save's first write.
 * [] (and no read) when it is null.
 */
async function planOfficeLines(conn, visitId, before) {
  if (!before) return [];
  const rows = await read(conn, 'after', (c) => openRows(c, before.planIds));
  const changed = [];
  for (const row of (rows || []).filter((other) => !same(other.id, visitId))) {
    // `was`: the visit's row before the save; none for a visit the save added.
    const was = before.rows.get(String(row.id));
    const kept = !!was && was.day === row.day && same(was.technician_id, row.technician_id);
    if (!(kept && sameBlock(was, row))) changed.push({ row, kept });
  }
  if (!changed.length) return [];
  const mine = new Set(await read(conn, 'written by', (c) => writtenHere(c, changed.map(({ row }) => row.id))));
  // One question per technician, block and kind of change: a plan's visits share them, so a plan is one or two reads.
  const asks = new Map();
  for (const { row, kept } of changed.filter((visit) => mine.has(visit.row.id))) {
    const { startMin, endMin } = rowBlockMinutes(row);
    const key = [row.technician_id, kept, startMin, endMin].join('|');
    const ask = asks.get(key) || { technicianId: row.technician_id, shiftOnly: kept, block: row, days: [] };
    ask.days.push(row.day);
    asks.set(key, ask);
  }
  const { dayWarningsFor } = require('../technician-eligibility');
  const lines = new Set();
  for (const { technicianId, days, block, shiftOnly } of asks.values()) {
    for (const line of await dayWarningsFor(technicianId, days, { conn, block, shiftOnly })) lines.add(line);
  }
  return [...lines];
}

module.exports = { planRowsBefore, planOfficeLines };
