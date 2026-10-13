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
 * THE NOTICE. One per visit and placement (dedupe key below), rung once: a
 * later run that is still unsure about the same visit rings nothing (it
 * rewrites the text when the proposal changed), a notice a person marked
 * done included. It is raised for an "unknown" a
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
  person: 'PROOFREADER_PERSON_HELD',
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
const STALE = Symbol('staleNotice');
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
    calls: 0, allowed: 0, held: 0, unsure: 0, notAsked: 0, grouped: 0, personHeld: 0, broke: 0, noticesFailed: 0, notices: new Map(),
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
  person: 'A person marked the held-move notice done; the visit stays on this placement',
};

function stopped(kind, answer) {
  return {
    allowed: false, reason_code: REASON_CODE[kind], reason_description: DESCRIPTION[kind], audit: auditOf(answer), broke: CHECK_BROKE.has(answer.why),
  };
}

const readFailed = (record) => record.unread.some((row) => row.reason === 'read_failed');

// Why no model is asked about a record that was built, or null to ask.
function notAskable(record, state) {
  // A source the record builder could not query (it lists the source as
  // unread and does not throw): a database fault, not a fact about the
  // customer. A broken check, and no call is spent on an answer that could
  // not be used (Codex #6313 r9).
  if (readFailed(record)) return { verdict: 'unknown', why: 'check_failed' };
  // The reads above can be slow: the deadline is asked again right before the call (r9).
  if (Date.now() >= state.deadlineAt) return { verdict: 'unknown', why: 'deadline' };
  return null;
}

async function ask({ service, best }, { conn, proofreader, state }) {
  try {
    const record = await proofreader.buildCustomerRecord(conn, { customerId: service.customer_id, serviceId: service.id, asOf: new Date() });
    const planned = await plannedMove(conn, service, best, record);
    const move = proofreader.moveFacts(planned);
    const skip = notAskable(record, state);
    if (skip) return { answer: skip, move: null, entry: null };
    // Only a call that goes to the model spends the run's call limit: a
    // record that cannot be read, or one too long to send, asks nobody
    // (Codex #6313 r2).
    if (!record.tooLong) state.calls += 1;
    const answer = await recordStillAsRead(await proofreader.proofreadMove({ move, record }), record, { service, conn, proofreader });
    const entry = answer.entry_id ? record.entries.find((row) => row.id === answer.entry_id) : null;
    return { answer, move, entry: entry || null };
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
  for (const row of record.unread) hash.update(`unread|${row.channel}|${row.reason}|${row.at || ''}\n`);
  return `${record.entries.length}:${record.unread.length}:${hash.digest('hex')}`;
}

// A model call takes up to two minutes. An allow stands only when the record
// read again after the answer is the record the model was shown: a text, a
// call or a note that landed meanwhile makes it "unknown", and the next run
// reads the new words (Codex #6313 r4). No notice: nobody has judged them yet.
async function recordStillAsRead(answer, record, { service, conn, proofreader }) {
  // Also before a person is told: a message that settles the question while
  // the model read makes the notice stale at once (r12). A hold stays a hold.
  const matters = answer.verdict === 'allow' || (answer.verdict === 'unknown' && PERSON_SETTLES[answer.why]);
  if (!matters) return answer;
  const was = answer.verdict === 'allow' ? { model_verdict: 'allow' } : {};
  const again = await proofreader.buildCustomerRecord(conn, { customerId: service.customer_id, serviceId: service.id, asOf: new Date() });
  // The second read itself failed: a broken check, not new words (r11). Asked
  // before the compare: a source already unread for another reason can fail
  // without changing the print (r13).
  if (readFailed(again)) return { ...answer, verdict: 'unknown', why: 'check_failed', ...was };
  if (recordPrint(again) === recordPrint(record)) return answer;
  return { ...answer, verdict: 'unknown', why: 'record_changed', ...was };
}

const keyFor = (service) => noticeKey(service.id, toDateStr(service.scheduled_date), `${textOrNull(service.window_start) || 'no-time'}:${textOrNull(service.technician_id) || 'no-tech'}`);

// The notice tells a person: "If not, mark this done and the visit stays."
// That decision is kept: while the visit is on the placement the notice is
// about, a notice a person marked done holds every automatic move of it, and
// nobody is asked (Codex #6313 r12: a later run could get an allow and make
// the move the person refused). A notice the system closed (the visit left
// the placement) carries the resolved title and decides nothing.
async function personHeld(conn, service) {
  const row = await conn('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [keyFor(service)])
    .whereNotNull('done_at')
    .whereNot('title', RESOLVED_TITLE)
    // Done by a person, never by a system close (the gate turned off, the
    // visit left the placement): notification-service.js's own rule.
    .whereRaw(require('../../notification-service')._private.PERSON_DONE_BY_SQL)
    .first('id');
  return !!row;
}

// A model call takes up to two minutes: a person can mark the notice done
// meanwhile. Asked again after an allow. An unreadable store is a broken
// check (null): the visit stays and the run reports it, never a made-up
// hold by a person (r14).
async function heldSinceAsked(conn, service) {
  try {
    return await personHeld(conn, service);
  } catch (err) {
    logger.warn(`[auto-dispatch] move proofreader could not re-read the notice of ${service.id}: ${err.message}`);
    return null;
  }
}

function collectNotice(state, service, best, { answer, move, entry }) {
  if (!move || !PERSON_SETTLES[answer.why]) return;
  const date = toDateStr(service.scheduled_date);
  const key = keyFor(service);
  if (!date || state.notices.has(key)) return;
  state.notices.set(key, {
    key, id: String(service.id), customer_id: service.customer_id || null, date, why: answer.why, move,
    window_start: textOrNull(service.window_start), technician_id: textOrNull(service.technician_id),
    to_window_start: textOrNull(best.start_time), to_technician_id: textOrNull(best.technician_id || service.technician_id),
    quote: answer.quote || null, reason: answer.reason || null, entry: entry ? { channel: entry.channel, from: entry.from, at: entry.at } : null,
  });
}

// The stop for a visit nobody is asked about: a grouped visit (isGroupedStop),
// one a person holds (personHeld), or one whose reads failed (never allowed).
// Null = ask.
async function groupedStop(conn, service) {
  try {
    if (await isGroupedStop(conn, service)) return { kind: 'grouped', stop: stopped('grouped', { verdict: 'unknown', why: 'grouped_stop' }) };
    if (await personHeld(conn, service)) return { kind: 'personHeld', stop: stopped('person', { verdict: 'unknown', why: 'person_held' }) };
    return null;
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
    state[grouped.kind] += 1;
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
  if (answer.why === 'deadline') {
    state.notAsked += 1;
    return stopped('not_asked', answer);
  }
  const heldNow = answer.verdict === 'allow' ? await heldSinceAsked(conn, service) : false;
  if (heldNow === null) {
    state.unsure += 1;
    state.broke += 1;
    return stopped('unknown', { ...answer, verdict: 'unknown', why: 'check_failed' });
  }
  if (heldNow) {
    state.personHeld += 1;
    return stopped('person', { ...answer, verdict: 'unknown', why: 'person_held' });
  }
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
  if (proofread !== true || (members || []).length < 2) return;
  // Marked so the run reads it as a change during the check, not a failed write.
  throw Object.assign(refuse(primaryId, 'joined a grouped stop after the move was checked'), { joinedStopAfterCheck: true });
}

// The approved slot was taken between the check and the write. Nothing
// moved: an ordinary "not tonight", never a failed run.
// A model call takes up to two minutes, so the visit can also change under
// it (a person re-times, locks, cancels or confirms it): the write's own
// stale-placement refusal is then the ordinary "superseded during the run",
// not a failed run (r14). Returns the no-change reason, or null for a failure.
const NOT_A_FAILURE = {
  SLOT_TAKEN: ['APPROVED_SLOT_TAKEN', 'The slot the move proofreader approved was taken before the move; the next run tries again'],
  STALE_PLACEMENT: ['SUPERSEDED_DURING_RUN', 'Superseded by an operator while the move was checked'],
  JOINED_STOP: ['SUPERSEDED_DURING_RUN', 'The visit joined a grouped stop while the move was checked'],
};
function approvedSlotTaken(checked, err) {
  const nothingMoved = !!(checked && err) && !err.movedCount && !(Array.isArray(err.failedMembers) && err.failedMembers.length);
  const reason = nothingMoved ? NOT_A_FAILURE[err.joinedStopAfterCheck ? 'JOINED_STOP' : err.code] : null;
  return reason ? { reason_code: reason[0], reason_description: reason[1] } : null;
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

async function raiseOne(item, { raiseAdminAlert, names, audit, trx }) {
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
    // A later run that holds a DIFFERENT proposal for the same placement
    // rewrites the standing notice's text, so a person never judges a
    // proposal that is no longer the one held (Codex #6313 r13). Quietly for
    // a standing notice: no ring, no slot, and a person's done stays done.
    refreshOnDedupe: true,
    // A notice the SYSTEM closed (the gate went off and on again, the visit
    // left and came back) is open work again: it rings and reopens.
    ringOnRefresh: (existing) => !!existing && existing.title === RESOLVED_TITLE,
    trx,
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
    return true;
  } catch (err) {
    logger.error(`[auto-dispatch] move-check notice close failed: ${err.message}`);
    return false;
  }
}

// The visit is still open on the placement the check read. Read with a row
// lock on the transaction that writes the notice (raiseNotices), so a move or
// a cancel cannot land between this read and that write (r12). A person can move
// or cancel it between the check and the run's end; that notice would be
// stale at once and would spend a ring (Codex #6313 r1). Null = the visit
// could not be read.
async function stillAsChecked(item, conn) {
  try {
    const row = await conn('scheduled_services').where({ id: item.id }).forUpdate().first('status', 'scheduled_date', 'window_start', 'technician_id');
    return !!row && OPEN_STATUSES.includes(row.status) && toDateStr(row.scheduled_date) === item.date
      && textOrNull(row.window_start) === item.window_start && textOrNull(row.technician_id) === item.technician_id;
  } catch (err) {
    logger.warn(`[auto-dispatch] move-check notice visit ${item.id} could not be re-read: ${err.message}`);
    return null;
  }
}

// Run end, in every run: close the notices that no longer apply; all of them
// when the check is off (config.proofreaderEnabled). Never throws; false = the
// close failed and stale notices may stand (statusAfterNotices).
async function closeNotices(nowDate = new Date(), { enabled = true } = {}) {
  return closeResolved(require('../audit'), nowDate, enabled);
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
    // An open notice of this lane is rewritten without a ring, so it is
    // written with the allowance spent too (r14): its text must follow the
    // proposal the run holds now.
    const standing = await audit.standingNoticeKeys(`${KEY_PREFIX}%`, RESOLVED_TITLE);
    // Soonest date first; an internal test customer's visit takes no slot.
    for (const item of audit.withinRingBudget([...state.notices.values()], new Set(), Infinity, (row) => row.key)) {
      // Allowance spent: a new notice waits for the next run, which asks again.
      if (left <= 0 && !standing.has(item.key)) continue;
      try {
        // The re-read and the write share one transaction and the visit's row lock.
        const written = await conn.transaction(async (trx) => {
          const asChecked = await stillAsChecked(item, trx);
          // An unreadable visit (null) raises nothing, and the run reports it:
          // the visit may still be held with nobody told (Codex #6313 r10).
          if (asChecked === null) state.noticesFailed += 1;
          if (!asChecked) return STALE;
          // Only a new notice rings and spends a slot; a key that exists is left as it is.
          return raiseOne(item, { raiseAdminAlert, names, audit, trx });
        });
        if (written === STALE) continue;
        // The store answers null when its own write failed (it does not throw).
        if (!written) state.noticesFailed += 1;
        if (audit.noticeRang(written)) { left -= 1; rang += 1; }
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

// A held visit whose notice could not be written, or a close that failed
// (stale notices stand; after a rollback, all of them), is not a green run.
function statusAfterNotices(state, runStatus, closed = true) {
  const failed = closed === false || (state && state.noticesFailed > 0);
  return failed && runStatus === 'completed' ? 'completed_with_errors' : runStatus;
}

// For the run's log line.
function tallyOf(state) {
  return state ? `${state.calls}/${state.allowed}/${state.held}/${state.unsure}/${state.grouped}/${state.personHeld}/${state.broke}` : 'off';
}

module.exports = {
  KEY_PREFIX, RESOLVED_TITLE, REASON_CODE, noticeKey, newRunState, checkMove, writeOptions, assertNotGrouped, approvedSlotTaken, closeNotices, raiseNotices, statusAfterNotices, tallyOf,
  _internals: { whyFor, detailFor, plannedMove },
};
