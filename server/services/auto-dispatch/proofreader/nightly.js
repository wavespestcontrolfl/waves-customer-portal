/**
 * MOVE PROOFREADER — the nightly call.
 *
 * Owner 2026-10-12 ("go with the better agent, and for moves it is unsure of
 * moving forward create admin notifications for these"): before the 04:10 run
 * moves a visit, one model reads the customer record (record.js) and answers
 * allow / hold / unknown (index.js is the judge of that answer).
 *
 *   allow    the move goes ahead, on the slot the model read and no other;
 *   hold     a quoted statement in the record sets when visits happen and
 *            the new slot breaks it: the visit stays, the audit row says so;
 *   unknown  the visit stays and a person is told (the notice below).
 *
 * The check can only stop a move. It runs in pass 2 only, after every free
 * rule and the per-run cap, so a move that would not happen anyway is never
 * paid for. A run asks at most config.proofreaderMaxCalls times and starts
 * no call after config.proofreaderDeadlineSeconds; past either a move waits
 * for the next run. A check that broke (the provider, a malformed answer, a
 * read) moves nothing and the run ends completed_with_errors.
 *
 * THE NOTICE. One per visit and placement (dedupe key below), written once: a
 * later run that is still unsure about the same visit writes nothing, a
 * notice a person marked done included. It is raised for an "unknown" a
 * person can settle from the record (the model was unsure, or part of the
 * record could not be read). A failed model call, or a record that changed
 * while the model read it, raises nothing: the next run asks again. The lane shares the auto-dispatch ring allowance of 24
 * hours (audit.ringsLeft), soonest date first. A notice is for the placement
 * the visit had at the check (date, arrival time, technician): it is not
 * raised when the visit left that placement before the run's end, and it
 * closes when the visit leaves it or is no longer open.
 *
 * Behind GATE_AUTO_DISPATCH_PROOFREADER (config.proofreaderEnabled).
 */
const logger = require('../../logger');
const { toDateStr } = require('../dates');

const KEY_PREFIX = 'auto-dispatch-proofreader:';
const RESOLVED_TITLE = 'Move check alert resolved';

const REASON_CODE = {
  hold: 'PROOFREADER_HOLD', unknown: 'PROOFREADER_UNSURE', not_asked: 'PROOFREADER_NOT_ASKED', grouped: 'PROOFREADER_GROUPED_STOP',
};

// The "unknown" answers a person can settle by reading the record, with the
// sentence the notice gives when there is no quote to show.
const PERSON_SETTLES = {
  model_unsure: 'A note may limit when this visit can happen.',
  hold_without_quote: 'A note may limit when this visit can happen.',
  record_incomplete: 'Part of the customer record could not be read.',
  record_too_long: 'The customer record is too long to check.',
};

// The model's own sentence and its quote have no length bound in the answer
// schema. Each gets its own budget, so the quote and the closing instruction
// are always whole inside the 2,000-character detail (Codex #6313 r1).
const REASON_MAX_CHARS = 300;
const QUOTE_MAX_CHARS = 1000;

// The placement a notice is about, as the database prints it.
const PLACEMENT_SQL = "s.scheduled_date::text = notifications.metadata->>'scheduledDate'"
  + " AND s.window_start::text IS NOT DISTINCT FROM notifications.metadata->>'windowStart'"
  + " AND s.technician_id::text IS NOT DISTINCT FROM notifications.metadata->>'technicianId'";
const OPEN_STATUSES = ['pending', 'confirmed'];
const textOrNull = (value) => (value == null || value === '' ? null : String(value));

// One notice per visit and PLACEMENT: the date, the arrival time and the
// technician. A
// notice closed because the placement changed must not swallow an unsure
// move on the new placement (Codex #6313 r5); on the same placement the key
// repeats, so a notice a person marked done is not written again.
const noticeKey = (id, date, placement) => `${KEY_PREFIX}${id}:${date}:${placement}`;
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || null;

// "Unknown" answers that say the check itself did not work (the provider, the
// answer's shape, a read): the run reports them, never a green run on a
// night the model could not be asked (Codex #6313 r7).
const CHECK_BROKE = new Set(['model_failed', 'bad_answer', 'check_failed']);

// The run's own tally and the notices it will raise at its end. `deadlineAt`:
// no call starts after it (config.proofreaderDeadlineSeconds from the run's
// start). The 04:10 run holds the writer lock the 04:20 route reorder needs,
// and one call can take two minutes (r7).
function newRunState({ startedAt = Date.now(), deadlineSeconds = null } = {}) {
  return {
    calls: 0, allowed: 0, held: 0, unsure: 0, notAsked: 0, grouped: 0, broke: 0, noticesFailed: 0, notices: new Map(),
    deadlineAt: Number.isFinite(deadlineSeconds) ? startedAt + deadlineSeconds * 1000 : Infinity,
  };
}

async function technicianNames(conn, ids) {
  const wanted = [...new Set(ids.filter(Boolean).map(String))];
  if (!wanted.length) return new Map();
  const rows = await conn('technicians').whereIn('id', wanted).select('id', 'name');
  return new Map(rows.map((row) => [String(row.id), firstName(row.name)]));
}

// GROUPED STOPS DO NOT MOVE while the check is on (owner 2026-10-12, "do
// whatever you recommend"). A stop of two or more services moves whole, each
// member on its own arrival time, and the model would have to judge every
// member's window and every change to the stop until the write; the owner
// ruled the same day to stop booking grouped stops. Such a visit is not asked
// about and stays where it is (PROOFREADER_GROUPED_STOP, no notice; a visit
// in conflict still gets the needs-a-person notice). The members are the unit
// mover's own read (visit-groups.js openMembers).
async function isGroupedStop(conn, service) {
  if (!service.visit_id) return false;
  return (await require('../../visit-groups').openMembers(conn, service.visit_id)).length > 1;
}

// The planned move as prompt.js moveFacts reads it.
async function plannedMove(conn, service, best, record) {
  const names = await technicianNames(conn, [service.technician_id, best.technician_id]);
  const tech = (id) => (id ? names.get(String(id)) || null : null);
  const services = record.serviceTypes || [];
  return {
    serviceType: services.length > 1 ? services.join(' + ') : (services[0] || service.service_type),
    from: {
      date: toDateStr(service.scheduled_date), windowStart: service.window_start, windowEnd: service.window_end, technician: tech(service.technician_id),
    },
    to: {
      date: best.date, windowStart: best.start_time, windowEnd: best.end_time, technician: tech(best.technician_id || service.technician_id),
    },
  };
}

// What the audit row keeps of an answer: ids and codes, never a quote or the
// model's sentence (both can hold customer words).
function auditOf(answer) {
  return {
    verdict: answer.verdict, why: answer.why, entry_id: answer.entry_id || null, model: answer.model || null, prompt_version: answer.prompt_version || null,
  };
}

const DESCRIPTION = {
  hold: 'The move proofreader stopped this move: the customer record sets when visits happen',
  unknown: 'The move proofreader could not clear this move; the visit stays',
  not_asked: 'The move proofreader had no calls or no time left this run; the next run asks',
  grouped: 'A stop of two or more services is not moved while the move proofreader is on',
};

function stopped(kind, answer) {
  return {
    allowed: false, reason_code: REASON_CODE[kind], reason_description: DESCRIPTION[kind], audit: auditOf(answer), broke: CHECK_BROKE.has(answer.why),
  };
}

async function ask({ service, best }, { conn, proofreader, state }) {
  try {
    const record = await proofreader.buildCustomerRecord(conn, { customerId: service.customer_id, serviceId: service.id, asOf: new Date() });
    const planned = await plannedMove(conn, service, best, record);
    const move = proofreader.moveFacts(planned);
    // Only a call that goes to the model spends the run's call limit: a
    // record that cannot be read, or one too long to send, asks nobody
    // (Codex #6313 r2).
    if (!record.tooLong) state.calls += 1;
    const answer = await recordStillAsRead(await proofreader.proofreadMove({ move, record }), record, { service, conn, proofreader });
    const entry = answer.entry_id ? record.entries.find((row) => row.id === answer.entry_id) : null;
    // A source the record builder could not query (it lists the source as
    // unread and does not throw) is a broken check too, whatever the verdict:
    // a database fault, not a fact about the customer.
    const readFailed = record.unread.some((row) => row.reason === 'read_failed');
    return { answer: readFailed ? { ...answer, verdict: 'unknown', why: 'check_failed' } : answer, move, entry: entry || null };
  } catch (err) {
    // Never allow on an error: the visit stays and the next run asks again.
    logger.warn(`[auto-dispatch] move proofreader failed for ${service.id}: ${err.message}`);
    return { answer: { verdict: 'unknown', why: 'check_failed' }, move: null, entry: null };
  }
}

// What the model was shown, as one comparable value.
function recordPrint(record) {
  const hash = require('crypto').createHash('sha256');
  // The services at the stop are part of what the model judged (r5).
  hash.update(`${(record.serviceTypes || []).join('|')}\n`);
  for (const row of record.entries) hash.update(`${row.channel}|${row.from}|${row.at}|${row.text}\n`);
  return `${record.entries.length}:${record.unread.length}:${hash.digest('hex')}`;
}

// A model call takes up to two minutes. An allow stands only when the record
// read again after the answer is the record the model was shown: a text, a
// call or a note that landed meanwhile makes it "unknown", and the next run
// reads the new words (Codex #6313 r4). No notice: nobody has judged them yet.
async function recordStillAsRead(answer, record, { service, conn, proofreader }) {
  if (answer.verdict !== 'allow') return answer;
  const again = await proofreader.buildCustomerRecord(conn, { customerId: service.customer_id, serviceId: service.id, asOf: new Date() });
  if (recordPrint(again) === recordPrint(record)) return answer;
  return { ...answer, verdict: 'unknown', why: 'record_changed', model_verdict: 'allow' };
}

function collectNotice(state, service, best, { answer, move, entry }) {
  if (!move || !PERSON_SETTLES[answer.why]) return;
  const date = toDateStr(service.scheduled_date);
  const key = noticeKey(service.id, date, `${textOrNull(service.window_start) || 'no-time'}:${textOrNull(service.technician_id) || 'no-tech'}`);
  if (!date || state.notices.has(key)) return;
  state.notices.set(key, {
    key, id: String(service.id), customer_id: service.customer_id || null, date, why: answer.why, move,
    window_start: textOrNull(service.window_start), technician_id: textOrNull(service.technician_id),
    to_window_start: textOrNull(best.start_time), to_technician_id: textOrNull(best.technician_id || service.technician_id),
    quote: answer.quote || null, reason: answer.reason || null, entry: entry ? { channel: entry.channel, from: entry.from, at: entry.at } : null,
  });
}

// The stop for a grouped visit (see isGroupedStop), or for a stop that could
// not be read (never asked, never allowed); null for a visit that is alone.
async function groupedStop(conn, service) {
  try {
    if (!(await isGroupedStop(conn, service))) return null;
    return { kind: 'grouped', stop: stopped('grouped', { verdict: 'unknown', why: 'grouped_stop' }) };
  } catch (err) {
    logger.warn(`[auto-dispatch] move proofreader could not read the stop of ${service.id}: ${err.message}`);
    return { kind: 'unsure', stop: stopped('unknown', { verdict: 'unknown', why: 'check_failed' }) };
  }
}

/**
 * Ask about one planned move, right before it is applied.
 * @returns null when the check is off for this run; otherwise
 *   { allowed: true, audit } or { allowed: false, reason_code, reason_description, audit }.
 */
async function checkMove({ service, best, run }, deps = {}) {
  const state = run.proofreader;
  if (!state) return null;
  const conn = deps.conn || require('../../../models/db');
  const grouped = await groupedStop(conn, service);
  if (grouped) {
    state[grouped.kind === 'grouped' ? 'grouped' : 'unsure'] += 1;
    if (grouped.stop.broke) state.broke += 1;
    return grouped.stop;
  }
  const outOf = (state.calls >= run.config.proofreaderMaxCalls && 'call_limit') || (Date.now() >= state.deadlineAt && 'deadline');
  if (outOf) {
    state.notAsked += 1;
    return stopped('not_asked', { verdict: 'unknown', why: outOf });
  }
  const asked = await ask({ service, best }, { conn, proofreader: deps.proofreader || require('./index'), state });
  const { answer } = asked;
  if (answer.verdict === 'allow') {
    state.allowed += 1;
    return { allowed: true, audit: auditOf(answer) };
  }
  if (answer.verdict === 'hold') {
    state.held += 1;
    return stopped('hold', answer);
  }
  state.unsure += 1;
  if (CHECK_BROKE.has(answer.why)) state.broke += 1;
  collectNotice(state, service, best, asked);
  return stopped('unknown', answer);
}

// The write options of an approved move: the slot the model read and no
// other. The SLOT_TAKEN fallback would land a slot nobody checked, so a
// checked move has none; a taken slot waits for the next run. `proofread`
// reaches the unit mover's member guard (assertNotGrouped).
function writeOptions(checked, fallback) {
  return checked ? { alternateCandidates: [], proofread: true } : fallback;
}

// apply.js makeMemberGuard, under the unit mover's stop lock and before any
// write: a visit that was alone when it was checked and has since joined a
// stop of two or more is not moved (see isGroupedStop). The next run sees
// the stop and leaves it.
function assertNotGrouped(members, proofread, refuse, primaryId) {
  if (proofread === true && (members || []).length > 1) throw refuse(primaryId, 'joined a grouped stop after the move was checked');
}

// The approved slot was taken between the check and the write. Nothing
// moved: an ordinary "not tonight", never a failed run.
function approvedSlotTaken(checked, err) {
  return !!(checked && err && err.code === 'SLOT_TAKEN' && !err.movedCount && !(Array.isArray(err.failedMembers) && err.failedMembers.length));
}

const slotWords = (slot, shortDateET) => `${slot.weekday} ${shortDateET(`${slot.date}T12:00:00Z`)}, ${slot.arrival_window}, technician ${slot.technician}`;

// Cut at a word, with a visible mark that words are missing.
function bounded(text, max) {
  const { cutAtWord } = require('../../admin-alert-compose');
  return text.length > max ? cutAtWord(text, max) : text;
}

function detailFor(item, { shortDateET, redactedWords }) {
  const lines = [
    `Auto-dispatch wanted to move this ${item.move.service} visit from ${slotWords(item.move.from, shortDateET)} to ${slotWords(item.move.to, shortDateET)}.`,
    'It did not move the visit.',
  ];
  if (item.reason) lines.push(`The check said: ${bounded(redactedWords(item.reason), REASON_MAX_CHARS)}`);
  if (item.quote) {
    const where = item.entry ? ` (${[item.entry.channel, item.entry.from, item.entry.at].filter(Boolean).join(', ')})` : '';
    lines.push(`From the customer record${where}: “${bounded(redactedWords(item.quote), QUOTE_MAX_CHARS)}”`);
  } else {
    lines.push(PERSON_SETTLES[item.why]);
  }
  lines.push('If the move is right, move the visit in dispatch. If not, mark this done and the visit stays.');
  return lines.join('\n');
}

// What kind of change was held (prompt.js changeOf names the three kinds).
function leadFor(move, from, to) {
  if (move.from.date !== move.to.date) return `Move from ${from} to ${to} held`;
  return move.from.arrival_window === move.to.arrival_window ? `Technician change on ${from} held` : `New time on ${from} held`;
}

function whyFor(item, { shortDateET, redactedWords, whyWithQuote }) {
  const from = shortDateET(`${item.date}T12:00:00Z`);
  const to = shortDateET(`${item.move.to.date}T12:00:00Z`);
  const lead = leadFor(item.move, from, to);
  if (item.quote) return whyWithQuote({ lead: `${lead}; the record says `, quote: redactedWords(item.quote) });
  return `${lead}: ${PERSON_SETTLES[item.why].replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())}.`;
}

async function raiseOne(item, { raiseAdminAlert, names, audit }) {
  return raiseAdminAlert('schedule_conflict', {
    area: 'Schedule',
    action: await audit.namedVisitAction(item.customer_id, [(who) => `check a held move of ${who}'s visit`, (who) => `check ${who}'s held move`], 'check a visit move auto-dispatch held'),
    why: whyFor(item, names),
    severity: 'needs-you',
    link: `/admin/dispatch?tab=schedule&date=${item.date}&appointment=${encodeURIComponent(item.id)}`,
    subject: { type: 'visit', id: item.id },
    doneWhen: 'visit_moved_or_done',
    who: 'person',
  }, {
    bell: true,
    dedupeKey: item.key,
    detail: detailFor(item, names),
    metadata: {
      scheduledServiceId: item.id, customerId: item.customer_id, scheduledDate: item.date, windowStart: item.window_start, technicianId: item.technician_id,
      kind: item.why, proposedDate: item.move.to.date, proposedWindowStart: item.to_window_start, proposedTechnicianId: item.to_technician_id,
    },
  });
}

// A notice stays open while its visit is still open on the placement the
// notice is about. A person who gives the visit a new time or technician on
// the same date has decided (Codex #6313 r1).
// With the check turned off nothing holds a move any more, so no notice
// stays open: a rollback leaves none standing (Codex #6313 r2).
async function closeResolved(audit, nowDate, enabled) {
  try {
    await audit.retireResolvedNotices({
      keyPattern: `${KEY_PREFIX}%`,
      stillOpen: (q) => {
        if (enabled) q.whereRaw(PLACEMENT_SQL).whereIn('s.status', OPEN_STATUSES);
        else q.whereRaw('1 = 0');
      },
      resolvedTitle: RESOLVED_TITLE,
      resolution: enabled ? 'The visit moved or is no longer open' : 'The move check is turned off',
      body: enabled ? 'This visit moved, was done or is no longer on that date.' : 'The move check is off; auto-dispatch no longer holds this move.',
    }, nowDate);
  } catch (err) {
    logger.error(`[auto-dispatch] move-check notice close failed: ${err.message}`);
  }
}

// The visit is still open on the placement the check read. A person can move
// or cancel it between the check and the run's end; that notice would be
// stale at once and would spend a ring (Codex #6313 r1). An unreadable visit
// raises nothing: the next run asks again.
async function stillAsChecked(item, conn) {
  try {
    const row = await conn('scheduled_services').where({ id: item.id }).first('status', 'scheduled_date', 'window_start', 'technician_id');
    return !!row && OPEN_STATUSES.includes(row.status) && toDateStr(row.scheduled_date) === item.date
      && textOrNull(row.window_start) === item.window_start && textOrNull(row.technician_id) === item.technician_id;
  } catch (err) {
    logger.warn(`[auto-dispatch] move-check notice visit ${item.id} could not be re-read: ${err.message}`);
    return false;
  }
}

// Run end, in every run: close the notices that no longer apply; all of them
// when the check is off (config.proofreaderEnabled). Never throws.
async function closeNotices(nowDate = new Date(), { enabled = true } = {}) {
  await closeResolved(require('../audit'), nowDate, enabled);
}

/**
 * Run end, after the needs-a-person lane (a visit in conflict outranks a
 * held move for the shared allowance): raise this run's notices. Returns how
 * many writes rang. Never throws.
 */
async function raiseNotices(state, { conn = require('../../../models/db') } = {}) {
  const audit = require('../audit');
  if (!state || state.notices.size === 0) return 0;
  let rang = 0;
  try {
    const { raiseAdminAlert } = require('../../admin-alert-compose');
    const names = require('../../admin-alert-names');
    let left = await audit.ringsLeft();
    // Soonest date first; an internal test customer's visit takes no slot.
    for (const item of audit.withinRingBudget([...state.notices.values()], new Set(), Infinity, (row) => row.key)) {
      // Allowance spent: the rest wait for the next run, which asks again.
      if (left <= 0) break;
      if (!(await stillAsChecked(item, conn))) continue;
      try {
        // Only a new notice rings and spends a slot; a key that exists is left as it is.
        if (audit.noticeRang(await raiseOne(item, { raiseAdminAlert, names, audit }))) { left -= 1; rang += 1; }
      } catch (err) {
        // A visit held for a person and nobody told: the run reports it
        // (state.noticesFailed, read by index.js; Codex #6313 r8).
        state.noticesFailed += 1;
        logger.error(`[auto-dispatch] move-check notice failed for ${item.id}: ${err.message}`);
      }
    }
  } catch (err) {
    state.noticesFailed += 1;
    logger.error(`[auto-dispatch] move-check notices failed: ${err.message}`);
  }
  return rang;
}

// A held visit whose notice could not be written is not a green run.
function statusAfterNotices(state, runStatus) {
  return state && state.noticesFailed > 0 && runStatus === 'completed' ? 'completed_with_errors' : runStatus;
}

// For the run's log line.
function tallyOf(state) {
  return state ? `${state.calls}/${state.allowed}/${state.held}/${state.unsure}/${state.grouped}/${state.broke}` : 'off';
}

module.exports = {
  KEY_PREFIX, RESOLVED_TITLE, REASON_CODE, noticeKey, newRunState, checkMove, writeOptions, assertNotGrouped, approvedSlotTaken, closeNotices, raiseNotices, statusAfterNotices, tallyOf,
  _internals: { whyFor, detailFor, plannedMove },
};
