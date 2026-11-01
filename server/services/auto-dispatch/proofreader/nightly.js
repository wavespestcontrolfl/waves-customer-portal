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
 *   unknown  the visit stays, the audit row says so, and nobody is asked.
 *
 * The check can only stop a move. It runs in pass 2 only, after every free
 * rule and the per-run cap, so a move that would not happen anyway is never
 * paid for. A run asks at most config.proofreaderMaxCalls times and starts
 * no call after config.proofreaderDeadlineSeconds; past either a move waits
 * for the next run (a night no check answered because the deadline came first
 * raises the check-down notice, check-down-notice.js). A check that broke (the
 * provider, a malformed answer, a read) moves nothing and the run ends
 * completed_with_errors.
 *
 * NO PERSON IS ASKED (owner 2026-10-29: "i dont want to have to approve every
 * move, this is insane"). Until then an "unknown" a person could settle from
 * the record (the model was unsure, or part of the record could not be read)
 * raised one admin notice per visit and placement ("Schedule — check a held
 * move"). Now such a visit stays where it is booked, like a hold, and the next
 * run asks again. Every run closes the notices still open from before
 * (closeNotices). A notice a person marked done before then still holds its
 * visit on that placement (personHeld).
 *
 * Behind GATE_AUTO_DISPATCH_PROOFREADER (config.proofreaderEnabled).
 */
const logger = require('../../logger');
// A database error's message can carry the query's bindings (a customer's
// email address, a phone number): logs get the error's code or name only
// (notification-service.js safeErrorSummary; Codex #6313 r22).
const safeError = (err) => require('../../notification-service').safeErrorSummary(err);
const { toDateStr } = require('../dates');

const KEY_PREFIX = 'auto-dispatch-proofreader:';
const RESOLVED_TITLE = 'Move check alert resolved';

const REASON_CODE = {
  hold: 'PROOFREADER_HOLD', unknown: 'PROOFREADER_UNSURE', not_asked: 'PROOFREADER_NOT_ASKED', grouped: 'PROOFREADER_GROUPED_STOP',
  person: 'PROOFREADER_PERSON_HELD',
};

// The placement a notice is about, as the database prints it.
const PLACEMENT_SQL = "s.scheduled_date::text = notifications.metadata->>'scheduledDate'"
  + " AND s.window_start::text IS NOT DISTINCT FROM notifications.metadata->>'windowStart'"
  + " AND s.technician_id::text IS NOT DISTINCT FROM notifications.metadata->>'technicianId'"
  + " AND s.customer_id::text IS NOT DISTINCT FROM notifications.metadata->>'customerId'";
const OPEN_STATUSES = ['pending', 'confirmed'];
const textOrNull = (value) => (value == null || value === '' ? null : String(value));

// The notices raised before 2026-10-29 were keyed per visit and PLACEMENT:
// the date, the arrival time and the technician (personHeld reads the key).
const noticeKey = (id, date, placement) => `${KEY_PREFIX}${id}:${date}:${placement}`;
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || null;

// "Unknown" answers that say the check itself did not work (the provider, the
// answer's shape, a read): the run reports them, never a green run on a
// night the model could not be asked (Codex #6313 r7).
const CHECK_BROKE = new Set(['model_failed', 'bad_answer', 'check_failed']);
// Answers that are not the model's: it was never asked (the deadline, a
// record too long to send) or the check broke. Every other answer is a usable
// one, the proof that the check works (check-down-notice.js reads `answered`).
const NOT_ANSWERED = new Set([...CHECK_BROKE, 'deadline', 'record_too_long']);

// A broken check, and the first cause the run saw: a failed call's reason
// (`anthropic_400`, `anthropic_timeout`, …) or the check's own why, for the
// move-check-down notice (check-down-notice.js).
function noteBroke(state, cause) {
  state.broke += 1;
  if (!state.brokeCause) state.brokeCause = String(cause || 'error');
}
const causeOf = (answer) => (answer.why === 'model_failed' ? (answer.reason || 'error') : answer.why);

// The run's own tally. `deadlineAt`:
// no call starts after it (config.proofreaderDeadlineSeconds from the run's
// start). The 04:10 run holds the writer lock the 04:20 route reorder needs,
// and one call can take two minutes (r7).
function newRunState({ startedAt = Date.now(), deadlineSeconds = null } = {}) {
  return {
    calls: 0, allowed: 0, held: 0, unsure: 0, notAsked: 0, timedOut: 0, grouped: 0, personHeld: 0, broke: 0, answered: 0, brokeCause: null,
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
    ...(answer.unread && answer.unread.length ? { unread: answer.unread } : {}),
  };
}

// Which parts of an incomplete record could not be read (owner 2026-11-01,
// "build fixes"): channel and reason codes only, so a person can fix the
// source. Never the entry's time, text or any customer word. Deduplicated,
// at most UNREAD_KEPT entries. Logging only: no verdict reads this.
const UNREAD_KEPT = 10;
const CODE = /^[a-z][a-z0-9_]{0,39}$/;
function unreadSummary(record) {
  const seen = new Set();
  const kept = [];
  for (const row of (record && record.unread) || []) {
    const channel = row && typeof row.channel === 'string' && CODE.test(row.channel) ? row.channel : 'unknown';
    const reason = row && typeof row.reason === 'string' && CODE.test(row.reason) ? row.reason : 'unknown';
    const key = `${channel}|${reason}`;
    if (!seen.has(key) && kept.length < UNREAD_KEPT) {
      seen.add(key);
      kept.push({ channel, reason });
    }
  }
  return kept;
}

// The answer with the unread summary of the record it was about, when the
// record had any unread part.
function withUnread(answer, record) {
  const unread = unreadSummary(record);
  return unread.length ? { ...answer, unread } : answer;
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
    if (skip) return { answer: withUnread(skip, record) };
    // Only a call that goes to the model spends the run's call limit: a
    // record that cannot be read, or one too long to send, asks nobody
    // (Codex #6313 r2).
    if (!record.tooLong) state.calls += 1;
    const answer = await recordStillAsRead(await proofreader.proofreadMove({ move, record }), record, { service, conn, proofreader });
    return { answer: withUnread(answer, record), recordPrint: recordPrint(record) };
  } catch (err) {
    // Never allow on an error: the visit stays and the next run asks again.
    logger.warn(`[auto-dispatch] move proofreader failed for ${service.id}: ${safeError(err)}`);
    return { answer: { verdict: 'unknown', why: 'check_failed' } };
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
// reads the new words (Codex #6313 r4). A hold or an unsure answer leaves the
// visit where it is whatever landed, so only an allow is read again.
async function recordStillAsRead(answer, record, { service, conn, proofreader }) {
  if (answer.verdict !== 'allow') return answer;
  const was = { model_verdict: 'allow' };
  const again = await proofreader.buildCustomerRecord(conn, { customerId: service.customer_id, serviceId: service.id, asOf: new Date() });
  // The second read itself failed: a broken check, not new words (r11). Asked
  // before the compare: a source already unread for another reason can fail
  // without changing the print (r13).
  if (readFailed(again)) return { ...answer, verdict: 'unknown', why: 'check_failed', ...was };
  if (recordPrint(again) === recordPrint(record)) return answer;
  return { ...answer, verdict: 'unknown', why: 'record_changed', ...was };
}

const keyFor = (service) => noticeKey(service.id, toDateStr(service.scheduled_date), `${textOrNull(service.window_start) || 'no-time'}:${textOrNull(service.technician_id) || 'no-tech'}`);

// The notices raised before 2026-10-29 told a person: "If not, mark this done
// and the visit stays." That decision is kept: while the visit is on the
// placement the notice is about, a notice a person marked done holds every
// automatic move of it, and nobody is asked (Codex #6313 r12: a later run
// could get an allow and make the move the person refused). A notice the
// system closed carries the resolved title and decides nothing.
async function personHeld(conn, service, { lock = false } = {}) {
  // The newest row of the key, open or done: with `lock` (the move
  // transaction) the row is locked FOR SHARE whatever its state, so a Done
  // cannot land on it before the move commits; the done fields are then
  // judged here, not in the WHERE that picks the row (pre-push audit r19).
  const query = conn('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [keyFor(service)])
    .orderBy('created_at', 'desc');
  if (lock) query.forShare();
  const row = await query.first('id', 'title', 'done_at', 'done_by');
  // Done by a person, never by a system close (the gate turned off, the
  // visit left the placement): notification-service.js's own rule.
  return !!row && row.done_at != null && row.title !== RESOLVED_TITLE
    && require('../../notification-service')._private.isPersonDoneBy(row.done_by);
}

// A model call takes up to two minutes: a person can mark the notice done
// meanwhile. Asked again after an allow. An unreadable store is a broken
// check (null): the visit stays and the run reports it, never a made-up
// hold by a person (r14).
async function heldSinceAsked(conn, service) {
  try {
    return await personHeld(conn, service);
  } catch (err) {
    logger.warn(`[auto-dispatch] move proofreader could not re-read the notice of ${service.id}: ${safeError(err)}`);
    return null;
  }
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
    logger.warn(`[auto-dispatch] move proofreader could not read the stop of ${service.id}: ${safeError(err)}`);
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
    if (grouped.stop.broke) noteBroke(state, 'check_failed');
    return grouped.stop;
  }
  const outOf = (state.calls >= run.config.proofreaderMaxCalls && 'call_limit') || (Date.now() >= state.deadlineAt && 'deadline');
  if (outOf) {
    state.notAsked += 1;
    // Past the deadline is a stopped check, not a spent allowance: the
    // check-down notice counts these (check-down-notice.js).
    state.timedOut += outOf === 'deadline' ? 1 : 0;
    return stopped('not_asked', { verdict: 'unknown', why: outOf });
  }
  const asked = await ask({ service, best }, { conn, proofreader: deps.proofreader || require('./index'), state });
  const { answer } = asked;
  if (answer.why === 'deadline') {
    state.notAsked += 1;
    state.timedOut += 1;
    return stopped('not_asked', answer);
  }
  const heldNow = answer.verdict === 'allow' ? await heldSinceAsked(conn, service) : false;
  if (heldNow === null) {
    state.unsure += 1;
    noteBroke(state, 'check_failed');
    return stopped('unknown', { ...answer, verdict: 'unknown', why: 'check_failed' });
  }
  // Counted only once every read the answer needs has worked (Codex #6465 r1).
  if (!NOT_ANSWERED.has(answer.why)) state.answered += 1;
  if (heldNow) {
    state.personHeld += 1;
    return stopped('person', { ...answer, verdict: 'unknown', why: 'person_held' });
  }
  if (answer.verdict === 'allow') {
    state.allowed += 1;
    return { allowed: true, audit: auditOf(answer), recordPrint: asked.recordPrint };
  }
  if (answer.verdict === 'hold') {
    state.held += 1;
    return stopped('hold', answer);
  }
  state.unsure += 1;
  if (CHECK_BROKE.has(answer.why)) noteBroke(state, causeOf(answer));
  return stopped('unknown', answer);
}

// The write options of an approved move: the slot the model read and no
// other. The SLOT_TAKEN fallback would land a slot nobody checked, so a
// checked move has none; a taken slot waits for the next run. `proofread`
// reaches the unit mover's member guard (assertNotGrouped), and with
// `approvedRecordPrint` the move guard (assertStillApproved).
function writeOptions(checked, fallback) {
  return checked ? { alternateCandidates: [], proofread: true, approvedRecordPrint: checked.recordPrint || null } : fallback;
}

// A write refusal that says the visit or its customer changed while the
// model read: marked so the run logs "superseded", not a failed write.
function changedDuringCheck(err, description) {
  return Object.assign(err, { supersededDuringCheck: description });
}

// apply.js makeMoveGuard, on the move transaction and before the write: what
// the approval stood on still stands. A model call takes up to two minutes
// and the reads after it are not atomic with the write, so each is made once
// more here (Codex #6313 r15 to r18). Only a proofread move is asked.
//   0. THE FENCE: the customer's own row is locked FOR UPDATE. Every table the
//      checks below read references that row by foreign key
//      (property_preferences, sms_log, emails, call_log,
//      customer_interactions, service_requests, reschedule_log), and an
//      insert or a re-link of a referencing row takes a key lock on it: such
//      a write waits until the move commits. This is the one fence every
//      writer observes; the preference writers' advisory lock is not (some
//      first-row writers never take it: r19). NOWAIT: the move already holds
//      the visit's row, so it never waits; a busy customer row means a
//      change is under way.
//   1. The customer's stored day, time and blackout preferences (hard rules)
//      are the ones the move was scored on.
//   2. No person marked the visit's notice done.
//   3. The customer record is the one the model was shown.
// A difference refuses the move as superseded. A read that fails throws an
// ordinary error: the move fails closed and the run reports it.
async function assertStillApproved(trx, service, config, refuse, row = service) {
  if (config.proofread !== true) return;
  const superseded = (why, description) => changedDuringCheck(refuse(service.id, why), description);
  // A customer merge (or its undo) can hand the visit to another customer
  // while the model reads: everything below was read for the old one (r21).
  if (String(row.customer_id ?? '') !== String(service.customer_id ?? '')) {
    throw superseded('belongs to another customer since the move was checked', 'The visit changed customers while the move was checked');
  }
  try {
    await trx.raw('SELECT id FROM customers WHERE id = ? FOR UPDATE NOWAIT', [service.customer_id]);
  } catch (err) {
    if (err && err.code === LOCK_NOT_AVAILABLE) throw superseded('has a customer row another write holds', 'The customer\'s record was being changed while the move was checked');
    throw err;
  }
  if (config.prefs) {
    const { getCustomerSchedulingPreferences } = require('../preferences');
    const now = await getCustomerSchedulingPreferences(service.customer_id, service.service_type, trx, { lock: true, serviceId: service.service_id, serviceKey: service.service_key_snapshot });
    if (preferencesPrint(now) !== preferencesPrint(config.prefs)) {
      throw superseded('has new customer scheduling preferences since the move was checked', 'The customer\'s scheduling preferences changed while the move was checked');
    }
  }
  if (await personHeld(trx, service, { lock: true })) {
    throw superseded('has a held-move notice a person marked done', 'A person marked the held-move notice done while the move was checked');
  }
  if (!config.approvedRecordPrint) return;
  const again = await require('./index').buildCustomerRecord(trx, { customerId: service.customer_id, serviceId: service.id, asOf: new Date() });
  if (readFailed(again)) throw new Error(`service ${service.id}: the customer record could not be read before the move`);
  if (recordPrint(again) !== config.approvedRecordPrint) {
    throw superseded('has a customer record that changed since the move was checked', 'The customer record changed while the move was checked');
  }
}

// Postgres: NOWAIT could not take the lock.
const LOCK_NOT_AVAILABLE = '55P03';

const preferencesPrint = (prefs) => JSON.stringify(prefs);

// apply.js makeMemberGuard, under the unit mover's stop lock and before any
// write: a visit that was alone when it was checked and has since joined a
// stop of two or more is not moved (see isGroupedStop). The next run sees
// the stop and leaves it.
function assertNotGrouped(members, proofread, refuse, primaryId) {
  if (proofread !== true || (members || []).length < 2) return;
  throw changedDuringCheck(refuse(primaryId, 'joined a grouped stop after the move was checked'), 'The visit joined a grouped stop while the move was checked');
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
};
function approvedSlotTaken(checked, err) {
  const nothingMoved = !!(checked && err) && !err.movedCount && !(Array.isArray(err.failedMembers) && err.failedMembers.length);
  if (nothingMoved && err.supersededDuringCheck) return { reason_code: 'SUPERSEDED_DURING_RUN', reason_description: err.supersededDuringCheck };
  const reason = nothingMoved ? NOT_A_FAILURE[err.code] : null;
  return reason ? { reason_code: reason[0], reason_description: reason[1] } : null;
}

// Run end, in every run, and on the scheduler's no-run path. Before
// 2026-10-29 an unsure move raised a notice; no run raises one now.
//   1. A notice, open or done, whose visit left the placement it is about or
//      is no longer open decides nothing: it is retired (Codex #6313 r1), so a
//      visit that later comes back to that placement is not held by an old
//      Done. With the check off nothing holds a move: every notice is retired,
//      the done ones too, and a rollback leaves none standing (r2).
//   2. With the check on, the notices still open are closed: nobody is asked,
//      so nothing waits on a person. A notice a person marked done is left as
//      it is: it still holds its visit on that placement (personHeld).
// Never throws; false = the close failed and stale notices may stand
// (statusAfterNotices).
async function closeNotices(nowDate = new Date(), { enabled = true } = {}) {
  try {
    await require('../audit').retireResolvedNotices({
      keyPattern: `${KEY_PREFIX}%`,
      stillOpen: (q) => {
        if (enabled) q.whereRaw(PLACEMENT_SQL).whereIn('s.status', OPEN_STATUSES);
        else q.whereRaw('1 = 0');
      },
      resolvedTitle: RESOLVED_TITLE,
      resolution: enabled ? 'The visit moved or is no longer open' : 'The move check is turned off',
      body: enabled ? 'This visit moved, was done or is no longer on that date.' : 'The move check is off; auto-dispatch no longer holds this move.',
    }, nowDate);
    if (!enabled) return true;
    const conn = require('../../../models/db');
    const { doneColumns } = require('../../notification-service')._private;
    await conn('notifications')
      .where({ recipient_type: 'admin', category: 'schedule_conflict' })
      .whereNot('title', RESOLVED_TITLE)
      .whereNull('done_at')
      .whereRaw("metadata->>'dedupeKey' LIKE ?", [`${KEY_PREFIX}%`])
      .update({
        ...doneColumns({ by: 'auto-dispatch', resolution: 'Auto-dispatch no longer asks a person about a move', at: nowDate, keepExisting: true, conn }),
        title: RESOLVED_TITLE,
        body: 'The visit stays where it is booked. Nothing here needs a decision.',
        detail: null,
      });
    return true;
  } catch (err) {
    logger.error(`[auto-dispatch] move-check notice close failed: ${safeError(err)}`);
    return false;
  }
}

// A close that failed (stale notices stand; after a rollback, all of them)
// is not a green run.
function statusAfterNotices(runStatus, closed = true) {
  return closed === false && runStatus === 'completed' ? 'completed_with_errors' : runStatus;
}

// For the run's log line.
function tallyOf(state) {
  return state ? `${state.calls}/${state.allowed}/${state.held}/${state.unsure}/${state.grouped}/${state.personHeld}/${state.broke}` : 'off';
}

module.exports = {
  KEY_PREFIX, RESOLVED_TITLE, REASON_CODE, noticeKey, newRunState, checkMove, writeOptions, assertNotGrouped, assertStillApproved, preferencesPrint, approvedSlotTaken, closeNotices, statusAfterNotices, tallyOf,
  _internals: { plannedMove, unreadSummary },
};
