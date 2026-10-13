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
 * paid for. A run asks at most config.proofreaderMaxCalls times; past that a
 * move waits for the next run.
 *
 * THE NOTICE. One per visit (or grouped stop) and date (dedupe key below), written once: a
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

const REASON_CODE = { hold: 'PROOFREADER_HOLD', unknown: 'PROOFREADER_UNSURE', not_asked: 'PROOFREADER_NOT_ASKED' };

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

const noticeKey = (id, date) => `${KEY_PREFIX}${id}:${date}`;
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || null;

// The run's own tally and the notices it will raise at its end.
function newRunState() {
  return {
    calls: 0, allowed: 0, held: 0, unsure: 0, notAsked: 0, notices: new Map(),
  };
}

async function technicianNames(conn, ids) {
  const wanted = [...new Set(ids.filter(Boolean).map(String))];
  if (!wanted.length) return new Map();
  const rows = await conn('technicians').whereIn('id', wanted).select('id', 'name');
  return new Map(rows.map((row) => [String(row.id), firstName(row.name)]));
}

// A grouped stop moves whole, and the unit mover gives each member its own
// start (visit-groups.js predictMemberWindows, the mover's own planning). The
// members that move with the visit, each with the start it has and the one
// it would get. A stop whose plan cannot be made throws: the caller then
// never allows the move.
function openMembers(conn, visitId) {
  const { TERMINAL_ROW_STATUSES } = require('../../visit-context/statuses');
  return conn('scheduled_services').where({ visit_id: visitId })
    .whereNotIn('status', TERMINAL_ROW_STATUSES)
    .select('id', 'service_type', 'status', 'technician_id', 'scheduled_date', 'window_start', 'window_end', 'estimated_duration_minutes');
}

// Who is at the stop and where each member sits, as one comparable string.
function stopSignature(members) {
  return members
    .map((m) => [m.id, toDateStr(m.scheduled_date), textOrNull(m.window_start), textOrNull(m.technician_id)].join('|'))
    .sort().join(';');
}

async function otherServicesOf(conn, service, best, members) {
  const { predictMemberWindows } = require('../../visit-groups');
  if (members.length < 2) return [];
  const visit = await conn('service_visits').where({ id: service.visit_id }).first('window_start');
  const predicted = predictMemberWindows({
    members, primaryId: service.id, visitWindowStart: visit ? visit.window_start : null,
    requestedStart: best.start_time, requestedEnd: best.end_time, newDateStr: best.date,
  });
  if (!predicted.ok) throw new Error(`grouped stop cannot be planned (${predicted.code})`);
  return members
    .map((member, i) => ({ member, target: predicted.targets[i] }))
    .filter(({ target }) => !target.isPrimary)
    .map(({ member, target }) => ({ service: member.service_type, fromStart: member.window_start, toStart: target.start || member.window_start }));
}

// The planned move as prompt.js moveFacts reads it. A grouped stop moves
// whole, so it names every member's service and each other member's windows.
async function plannedMove(conn, service, best, record) {
  const names = await technicianNames(conn, [service.technician_id, best.technician_id]);
  const tech = (id) => (id ? names.get(String(id)) || null : null);
  const services = record.serviceTypes || [];
  const members = service.visit_id ? await openMembers(conn, service.visit_id) : [];
  return {
    // The stop as the model was told it, for the run-end re-read (stillAsChecked).
    stop: members.length > 1 ? stopSignature(members) : null,
    otherServices: await otherServicesOf(conn, service, best, members),
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
  not_asked: 'The move proofreader had no calls left this run; the next run asks',
};

function stopped(kind, answer) {
  return {
    allowed: false, reason_code: REASON_CODE[kind], reason_description: DESCRIPTION[kind], audit: auditOf(answer),
  };
}

async function ask({ service, best }, { conn, proofreader, state }) {
  try {
    const record = await proofreader.buildCustomerRecord(conn, { customerId: service.customer_id, serviceId: service.id, asOf: new Date() });
    const planned = await plannedMove(conn, service, best, record);
    const move = proofreader.moveFacts(planned);
    // Only a call that goes to the model spends the run's call limit: a
    // record or a stop that cannot be read, or a record too long to send,
    // asks nobody (Codex #6313 r2).
    if (!record.tooLong) state.calls += 1;
    const answer = await recordStillAsRead(await proofreader.proofreadMove({ move, record }), record, { service, conn, proofreader });
    const entry = answer.entry_id ? record.entries.find((row) => row.id === answer.entry_id) : null;
    return { answer, move, entry: entry || null, stop: planned.stop };
  } catch (err) {
    // Never allow on an error: the visit stays and the next run asks again.
    logger.warn(`[auto-dispatch] move proofreader failed for ${service.id}: ${err.message}`);
    return { answer: { verdict: 'unknown', why: 'check_failed' }, move: null, entry: null, stop: null };
  }
}

// What the model was shown, as one comparable value.
function recordPrint(record) {
  const hash = require('crypto').createHash('sha256');
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

function collectNotice(state, service, { answer, move, entry, stop }) {
  if (!move || !PERSON_SETTLES[answer.why]) return;
  const date = toDateStr(service.scheduled_date);
  // A grouped stop is one notice, whichever member the run tried to move: two
  // members that both qualify describe the same stop (Codex #6313 r3).
  const key = noticeKey(stop && service.visit_id ? `visit-${service.visit_id}` : service.id, date);
  if (!date || state.notices.has(key)) return;
  state.notices.set(key, {
    key, id: String(service.id), customer_id: service.customer_id || null, date, why: answer.why, move,
    window_start: textOrNull(service.window_start), technician_id: textOrNull(service.technician_id),
    visit_id: service.visit_id || null, stop,
    quote: answer.quote || null, reason: answer.reason || null, entry: entry ? { channel: entry.channel, from: entry.from, at: entry.at } : null,
  });
}

/**
 * Ask about one planned move, right before it is applied.
 * @returns null when the check is off for this run; otherwise
 *   { allowed: true, audit } or { allowed: false, reason_code, reason_description, audit }.
 */
async function checkMove({ service, best, run }, deps = {}) {
  const state = run.proofreader;
  if (!state) return null;
  if (state.calls >= run.config.proofreaderMaxCalls) {
    state.notAsked += 1;
    return stopped('not_asked', { verdict: 'unknown', why: 'call_limit' });
  }
  const asked = await ask({ service, best }, {
    conn: deps.conn || require('../../../models/db'), proofreader: deps.proofreader || require('./index'), state,
  });
  const { answer } = asked;
  if (answer.verdict === 'allow') {
    state.allowed += 1;
    return { allowed: true, audit: auditOf(answer), stop: asked.stop };
  }
  if (answer.verdict === 'hold') {
    state.held += 1;
    return stopped('hold', answer);
  }
  state.unsure += 1;
  collectNotice(state, service, asked);
  return stopped('unknown', answer);
}

// The write options of an approved move: the slot the model read and no
// other. The SLOT_TAKEN fallback would land a slot nobody checked, so a
// checked move has none; a taken slot waits for the next run. `approvedStop`
// is the grouped stop as the model was told it (null = the visit was alone):
// the unit mover's member guard compares it under the stop lock
// (assertApprovedStop).
function writeOptions(checked, fallback) {
  return checked ? { alternateCandidates: [], approvedStop: checked.stop ?? null } : fallback;
}

// apply.js makeMemberGuard, under the unit mover's stop lock and before any
// write: the members the mover is about to move are the ones the model read,
// each on the placement it read. A member that joined, left or moved while
// the model worked refuses the move; the next run asks again. `approved`
// undefined = the move was not proofread.
function assertApprovedStop(members, approved, refuse, primaryId) {
  if (approved === undefined) return;
  const now = (members || []).length > 1 ? stopSignature(members) : null;
  if (now !== approved) throw refuse(primaryId, 'changed since the move was checked');
}

// The approved slot was taken between the check and the write. Nothing
// moved: an ordinary "not tonight", never a failed run.
function approvedSlotTaken(checked, err) {
  return !!(checked && err && err.code === 'SLOT_TAKEN' && !err.movedCount && !(Array.isArray(err.failedMembers) && err.failedMembers.length));
}

const slotWords = (slot, shortDateET) => `${slot.weekday} ${shortDateET(`${slot.date}T12:00:00Z`)}, ${slot.arrival_window}`;

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

function whyFor(item, { shortDateET, redactedWords, whyWithQuote }) {
  const from = shortDateET(`${item.date}T12:00:00Z`);
  const to = shortDateET(`${item.move.to.date}T12:00:00Z`);
  const lead = item.move.from.date === item.move.to.date ? `New time on ${from} held` : `Move from ${from} to ${to} held`;
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
      // A grouped stop as the model was told it, for the close (staleStopVisits).
      ...(item.stop ? { visitId: item.visit_id, stop: item.stop } : {}),
      kind: item.why, proposedDate: item.move.to.date,
    },
  });
}

// A notice stays open while its visit is still open on the placement the
// notice is about. A person who gives the visit a new time or technician on
// the same date has decided (Codex #6313 r1).
// The visits of open grouped-stop notices whose stop is no longer the one
// the notice describes: a member left, joined or moved while the tapped visit
// stayed. The stop is compared here, with the same signature the raise uses,
// because the close's SQL sees the tapped visit alone. A stop that cannot be
// read keeps its notice.
async function staleStopVisits(conn) {
  const rows = await conn('notifications')
    .where({ recipient_type: 'admin', category: 'schedule_conflict' })
    .whereNot('title', RESOLVED_TITLE)
    .whereRaw("metadata->>'dedupeKey' LIKE ?", [`${KEY_PREFIX}%`])
    .whereRaw("metadata->>'stop' IS NOT NULL")
    .select('metadata');
  const stale = [];
  for (const row of rows) {
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    if (!meta.stop || !meta.visitId) continue;
    try {
      if (stopSignature(await openMembers(conn, meta.visitId)) !== meta.stop) stale.push(String(meta.scheduledServiceId));
    } catch (err) {
      logger.warn(`[auto-dispatch] move-check notice stop ${meta.visitId} could not be re-read: ${err.message}`);
    }
  }
  return stale;
}

// With the check turned off nothing holds a move any more, so no notice
// stays open: a rollback leaves none standing (Codex #6313 r2).
async function closeResolved(audit, nowDate, enabled, conn) {
  try {
    const stale = enabled ? await staleStopVisits(conn) : [];
    await audit.retireResolvedNotices({
      keyPattern: `${KEY_PREFIX}%`,
      stillOpen: (q) => {
        if (enabled) q.whereRaw(PLACEMENT_SQL).whereIn('s.status', OPEN_STATUSES);
        else q.whereRaw('1 = 0');
        if (stale.length) q.whereNotIn('s.id', stale);
      },
      resolvedTitle: RESOLVED_TITLE,
      resolution: enabled ? 'The visit moved or is no longer open' : 'The move check is turned off',
      body: enabled ? 'This visit moved, was done or is no longer on that date.' : 'The move check is off; auto-dispatch no longer holds this move.',
    }, nowDate);
  } catch (err) {
    logger.error(`[auto-dispatch] move-check notice close failed: ${err.message}`);
  }
}

// The visit (and, for a grouped stop, every member) is still open on the placement the check read. A person can move
// or cancel it between the check and the run's end; that notice would be
// stale at once and would spend a ring (Codex #6313 r1). An unreadable visit
// raises nothing: the next run asks again.
async function stillAsChecked(item, conn) {
  try {
    const row = await conn('scheduled_services').where({ id: item.id }).first('status', 'scheduled_date', 'window_start', 'technician_id');
    const same = !!row && OPEN_STATUSES.includes(row.status) && toDateStr(row.scheduled_date) === item.date
      && textOrNull(row.window_start) === item.window_start && textOrNull(row.technician_id) === item.technician_id;
    // A grouped stop: the notice describes every member, so a member that
    // left, joined or moved since the check makes it stale too (r2).
    if (!same || !item.stop) return same;
    return stopSignature(await openMembers(conn, item.visit_id)) === item.stop;
  } catch (err) {
    logger.warn(`[auto-dispatch] move-check notice visit ${item.id} could not be re-read: ${err.message}`);
    return false;
  }
}

// Run end, in every run: close the notices that no longer apply; all of them
// when the check is off (config.proofreaderEnabled). Never throws.
async function closeNotices(nowDate = new Date(), { enabled = true, conn = require('../../../models/db') } = {}) {
  await closeResolved(require('../audit'), nowDate, enabled, conn);
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
        logger.error(`[auto-dispatch] move-check notice failed for ${item.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[auto-dispatch] move-check notices failed: ${err.message}`);
  }
  return rang;
}

// For the run's log line.
function tallyOf(state) {
  return state ? `${state.calls}/${state.allowed}/${state.held}/${state.unsure}` : 'off';
}

module.exports = {
  KEY_PREFIX, RESOLVED_TITLE, REASON_CODE, noticeKey, newRunState, checkMove, writeOptions, assertApprovedStop, stopSignature, approvedSlotTaken, closeNotices, raiseNotices, tallyOf,
  _internals: { whyFor, detailFor, plannedMove },
};
