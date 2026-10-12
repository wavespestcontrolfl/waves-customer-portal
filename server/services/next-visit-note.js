/**
 * The next-visit adjustment note (owner decision 2026-10-12, "store it").
 *
 * The completion forms show the technician the customer's next scheduled visit
 * with a "Needs adjustment?" box. The note used to ride the completion body and
 * be dropped. It now lands on that NEXT visit's `scheduled_services.notes` (the
 * staff-facing appointment note: shown on the job card, never on a customer
 * surface; routes/schedule.js hides it from the customer payload by owner
 * directive 2026-07-19) as one dated line:
 *
 *   [From 10/12 visit] Gate code changed, call before arriving.
 *
 * Written inside the completion's own transaction (the same place the office
 * note lands on the completed visit), so a rolled-back completion leaves no
 * note and a resumed or replayed one never reaches this code again. A failure
 * here is logged and skipped: the note is secondary, the completion is not.
 */
const logger = require('./logger');
const { etCalendarDayOf, etDateString } = require('../utils/datetime-et');
const { savepointScope } = require('../utils/savepoint-read');

// The box is capped at 300 characters on every sheet; the server enforces it too.
const NEXT_VISIT_NOTE_MAX_CHARS = 300;
// PATCH /admin/dispatch/:serviceId/note caps scheduled_services.notes here.
const VISIT_NOTES_MAX_CHARS = 2000;
// The /admin/schedule/next-visit route's dead-status list.
const DEAD_VISIT_STATUSES = ['cancelled', 'rescheduled', 'completed', 'skipped', 'no_show'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One line: whitespace (newlines included) collapses, then the text is capped.
function cleanNextVisitNote(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, NEXT_VISIT_NOTE_MAX_CHARS);
}

// "[From M/D visit] note", M/D from the completed visit's ET calendar day.
function nextVisitNoteLine(completedDate, note) {
  const text = cleanNextVisitNote(note);
  const day = completedDate ? etCalendarDayOf(completedDate) : null;
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day || '');
  if (!text || !m) return null;
  return `[From ${Number(m[1])}/${Number(m[2])} visit] ${text}`;
}

const dayOf = (value) => (value ? etCalendarDayOf(value) : null);

// A visit may take the note only when it is the same customer's, a different
// visit, dated after the completed one, still on the books, and (for a
// technician) assigned to that technician, as the next-visit route scopes it.
function isLiveNextVisitTarget({ target, completed, actor = {}, today = etDateString() }) {
  if (!target || !completed) return false;
  if (!target.customer_id || String(target.customer_id) !== String(completed.customerId)) return false;
  if (String(target.id) === String(completed.id)) return false;
  const targetDay = dayOf(target.scheduled_date);
  const completedDay = dayOf(completed.date);
  if (!targetDay || !completedDay || targetDay <= completedDay) return false;
  // Still a FUTURE visit today (ET), as the next-visit route shows it: a backfill or a late retry
  // must not put the note on a visit whose day has come.
  if (targetDay <= today) return false;
  if (DEAD_VISIT_STATUSES.includes(target.status)) return false;
  if (actor.techRole === 'technician'
    && (!actor.technicianId || String(target.technician_id || '') !== String(actor.technicianId))) return false;
  return true;
}

// Append rule for the target's current note. Never touches existing text: a line
// already present is left alone (a retry never doubles it), and a line that would
// push the note past the field cap is not written at all.
function appendNextVisitNoteText(existing, line) {
  const current = typeof existing === 'string' ? existing : '';
  if (current.split('\n').some((l) => l.trim() === line)) return { outcome: 'present' };
  const notes = current.trim() ? `${current}\n${line}` : line;
  if (notes.length > VISIT_NOTES_MAX_CHARS) return { outcome: 'too_long' };
  return { outcome: 'append', notes };
}

const TARGET_COLUMNS = ['id', 'customer_id', 'status', 'technician_id', 'notes'];

// A row's date as an ET calendar day string (a DATE column, read literally).
const withDay = (row) => (row ? { ...row, scheduled_date: dayOf(row.scheduled_date) } : row);

async function readVisit(k, id, { lock = false } = {}) {
  const q = k('scheduled_services').where({ id });
  if (lock) q.forUpdate().skipLocked();
  return withDay(await q.first(...TARGET_COLUMNS, 'scheduled_date'));
}

// The customer's earliest live future visit: the next-visit route's rule, after
// the later of the completed visit's day and today (ET).
async function findFallbackTargetId(k, { completed, actor }) {
  const floor = [dayOf(completed.date), etDateString()].sort().pop();
  const q = k('scheduled_services')
    .where({ customer_id: completed.customerId })
    .whereNot('id', completed.id)
    .where('scheduled_date', '>', floor)
    .whereNotIn('status', DEAD_VISIT_STATUSES);
  if (actor.techRole === 'technician') {
    if (!actor.technicianId) return null;
    q.where('technician_id', actor.technicianId);
  }
  const row = await q.orderBy('scheduled_date', 'asc').orderBy('id', 'asc').first('id');
  return row ? row.id : null;
}

async function candidateTargetId(k, { completed, nextVisitId, actor }) {
  if (typeof nextVisitId === 'string' && UUID_RE.test(nextVisitId)) {
    const posted = await readVisit(k, nextVisitId);
    if (isLiveNextVisitTarget({ target: posted, completed, actor })) return posted.id;
  }
  return findFallbackTargetId(k, { completed, actor });
}

// The write, on the completion's transaction. The target is locked SKIP LOCKED:
// this transaction already holds the customer and completed-visit locks, so
// waiting on a future visit another transaction holds could close a lock cycle.
// A busy row means the note is not written (logged), never a wait. The locked row
// is re-checked and appended to in one step.
async function writeLockedNote(k, { completed, line, actor, targetId }) {
  const target = await readVisit(k, targetId, { lock: true });
  if (!target) return { status: 'busy' };
  if (!isLiveNextVisitTarget({ target, completed, actor })) return { status: 'no_target' };
  const next = appendNextVisitNoteText(target.notes, line);
  if (next.outcome !== 'append') return { status: next.outcome, targetId };
  await k('scheduled_services').where({ id: targetId }).update({ notes: next.notes });
  return { status: 'written', targetId };
}

/**
 * @param {object} trx          the completion transaction
 * @param {object} args
 * @param {object} args.completed { id, customerId, date } of the visit being completed
 * @param {*} args.note         body.nextVisitAdjustmentNote
 * @param {*} args.nextVisitId  body.nextVisitId (the visit the card showed)
 * @param {object} args.actor   { techRole, technicianId }
 * @returns {Promise<{status: string, targetId?: string}>} never throws
 */
async function storeNextVisitNote(trx, { completed, note, nextVisitId = null, actor = {} }) {
  const line = nextVisitNoteLine(completed && completed.date, note);
  if (!line) return { status: 'skipped' };
  try {
    const result = await savepointScope(trx, async (k) => {
      const targetId = await candidateTargetId(k, { completed, nextVisitId, actor });
      if (!targetId) return { status: 'no_target' };
      return writeLockedNote(k, { completed, line, actor, targetId });
    });
    if (result.status === 'too_long' || result.status === 'busy') {
      logger.warn(`[completion] next-visit note not stored for service ${completed.id}: ${result.status === 'busy' ? 'the next visit is locked by another change' : `the next visit's note would pass ${VISIT_NOTES_MAX_CHARS} characters`}`);
    }
    return result;
  } catch (err) {
    // The error's code only: a database error message can carry the statement and the note's text.
    logger.warn(`[completion] next-visit note not stored for service ${completed.id}: ${(err && (err.code || err.name)) || 'error'}`);
    return { status: 'error' };
  }
}

module.exports = {
  storeNextVisitNote,
  cleanNextVisitNote,
  nextVisitNoteLine,
  isLiveNextVisitTarget,
  appendNextVisitNoteText,
  NEXT_VISIT_NOTE_MAX_CHARS,
  VISIT_NOTES_MAX_CHARS,
  DEAD_VISIT_STATUSES,
};
