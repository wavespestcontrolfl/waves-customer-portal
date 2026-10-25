'use strict';

/**
 * AI close of Waves' open CALL promises (owner ruling 2026-10-24, GATE_CALL_PROMISE_AI_CLOSE):
 * "open promises should close automatically ... a text is sent, the customer
 * confirms it has been resolved, or an appointment is booked or rescheduled —
 * all of these should be checked by the agent for all the communication lines
 * we have."
 *
 * The fixed rules in call-commitments.js (a booked visit for the promised
 * slot, a reached call back, a staff text, a sent estimate) leave many
 * promises open for good: "in_person" and "other" ones can never close, the
 * association window ends after 14 days, and a promise kept by an email, a
 * rescheduled visit or the customer's own "got it, thanks" is invisible to
 * them. This file asks the checker the text-follow-up lane already uses —
 * loadSmsFulfillmentEvidence (texts both ways, calls with transcripts,
 * emails, visits booked / moved / completed, estimates, payments) judged by
 * verifySmsFulfillment, and the later-thread check (sms-commitment-thread-
 * close.js) — about the promise, after the call it was made on. There is no
 * second checker: the promise is handed to those functions as a staff promise
 * (sms_context.basis 'promise') whose "source text" is the end of the call.
 *
 *   - candidates: open, untouched (no human verdict), non-stale Waves
 *     promises on a call that has a customer; oldest call first, at most
 *     maxModelCalls model calls a run (the rest wait for the next run);
 *   - a promise with no admissible later record skips the model entirely
 *     (the text lane's no-witness rule); the thread check needs a later text;
 *   - the model must cite one record and quote it exactly (groundFulfillment);
 *     for a call record the quote must also sit in Waves' own turns. Only a
 *     grounded "fulfilled" closes; open / uncertain / a failed read stays open;
 *   - a person's later text alone never closes (requireModel): it is evidence
 *     for the model to judge, as for the contact check on "other" promises;
 *   - verdicts are cached on the row by evidence hash (contact_check.ai_close),
 *     so an unchanged promise with unchanged evidence costs no second call;
 *   - the close is one transaction that locks the promise, the call and the
 *     cited record, reads the evidence again and checks it hashes as the model
 *     saw it (revalidateSmsFulfillment), then writes the same association proof
 *     every automatic close carries (closed_by promise_evidence), with the cited
 *     record and a label (never the quote) and closed_agent 'ai-check'. The Owed tab lists it with a Reopen; a
 *     reopen is a human verdict, which this job never overrides.
 *
 * refreshFulfillment's re-judge keeps such a close while its cited record
 * stands (aiCloseStands, no model) and reopens it when the call was relinked,
 * the promise was rewritten, or the record is gone. Internal ledger writes
 * only: no customer message of any kind.
 */

const crypto = require('crypto');
const logger = require('./logger');
const { isEnabled, promiseEvidenceCloseLive, callPromiseAiCloseLive, callPromiseLaterTextCheckLive } = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');
const commitments = require('./call-commitments');
const { loadSmsFulfillmentEvidence, admissibleWitness, verifySmsFulfillment, fulfillmentFingerprint, revalidateSmsFulfillment } = require('./sms-commitment-fulfillment');
const { verifyThreadCompletion, loadThreadMessages, latestHumanTextAt, THREAD_LIMIT, BASIS: THREAD_BASIS } = require('./sms-commitment-thread-close');
const { stringifySmsEvidence } = require('./sms-operational-extractor');
const laterTexts = require('./call-promise-later-text-check');

const { associationFrom, evidenceBoundary, storedProof, refreshableVerdictSql, staleAiRowSql, speakerTurns, normalizeForMatch } = commitments;

// Bump on any change to what is asked or how a verdict is used: it is part of
// the stored cache key, so every cached verdict is judged again.
const VERSION = 'call-promise-ai-close-v1';
const AI_CHECK_KIND = 'ai_check';
// A record proof held because a human text came after it (judgeCandidate).
const HELD_BY_LATER_TEXT = 'contradicted_by_later_text';
const AI_CHECK_BASIS = 'ai_check';
const AGENT = 'ai-check';
// Model calls per run. The nightly watchdog pass uses MAX_MODEL_CALLS; the Owed
// queue read, which runs beside a staff member, a handful.
const MAX_MODEL_CALLS = 60;
const QUEUE_MODEL_CALLS = 5;
const CANDIDATE_LIMIT = 200;
// No new candidate starts after this long: a stalled provider never pins the watchdog's lock for the whole backlog.
const MAX_RUN_MS = 20 * 60 * 1000;
// verifyThreadCompletion needs a message to anchor on; a call has no sms row.
const NO_MESSAGE_ID = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The checker's record types in the ledger's own record_type spelling (the Owed tab reads these), and back.
// The sms_log row of a thread confirmation is cited as a plain text.
const LEDGER_RECORD_TYPE = { sms: 'sms_log', call: 'call_log', visit: 'scheduled_service', estimate: 'estimate',
  email_reply: 'email', email_delivery: 'email_message' };
const CHECKER_TYPE = Object.fromEntries(Object.entries(LEDGER_RECORD_TYPE).map(([checker, ledger]) => [ledger, checker]));

// The stored proof keeps a record type, id and short label, never the model's quote: the Owed feed
// (/commitments/auto-closed) is readable by every active technician, and a quoted line can carry a private
// link, a card number or a gate/lockbox code that no scrubber reliably catches. Staff open the record itself.
const RECORD_LABEL = { sms_log: 'text', call_log: 'call', scheduled_service: 'visit', estimate: 'estimate', email: 'email', email_message: 'email' };

const callEnd = (call) => require('./call-booking-link-text').callEndFor(call);
const CALL_TIMING = ['created_at', 'bridged_at', 'duration_seconds', 'recording_duration_seconds', 'direction', 'metadata'];
const md5 = (text) => crypto.createHash('md5').update(text, 'utf8').digest('hex');
const iso = (value) => new Date(value).toISOString();

// What the promise is, as a close rests on it: a reprocess that rewrites what
// was promised takes the close away and the next run judges the new promise.
// due_type is part of it: a floor and a deadline at the same due_at admit
// different evidence (call-commitments associationFrom), so a corrected
// interpretation must invalidate a close that rested on the old one.
const promiseMd5 = (commitment) => md5(JSON.stringify({ kind: commitment.kind, description: commitment.description,
  due_at: commitment.due_at ? iso(commitment.due_at) : null, due_type: commitment.due_type || null,
  quotes: (Array.isArray(commitment.evidence) ? commitment.evidence : []).map((e) => String(e?.quote || '').slice(0, 600)) }));

const parsed = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

// ── Candidates ──────────────────────────────────────────────────────────────

function listCandidates(conn, { callIds = null, limit = CANDIDATE_LIMIT, cursor = null } = {}) {
  return conn('call_commitments as cc')
    .join('call_log as cl', 'cl.id', 'cc.call_log_id')
    .where({ 'cc.party': 'waves', 'cc.status': 'open' })
    .whereNull('cc.human_state')
    .whereRaw(`NOT ${staleAiRowSql('cc')}`)
    .whereNotNull('cl.customer_id')
    .modify((b) => require('./voice-agent/relay-protocol').whereNotSandboxCall(b, 'cl.source'))
    .modify((b) => { if (callIds) b.whereIn('cc.call_log_id', callIds); })
    // The page after the last row read (its call start as text keeps microseconds, so a boundary never skips a row).
    .modify((b) => { if (cursor) b.whereRaw('(cl.created_at, cc.id) > (?::timestamptz, ?::uuid)', [cursor.at, cursor.id]); })
    .orderBy([{ column: 'cl.created_at', order: 'asc' }, { column: 'cc.id', order: 'asc' }])
    .limit(limit)
    .select('cc.*', 'cl.customer_id as call_customer_id', 'cl.from_phone as call_from_phone', 'cl.to_phone as call_to_phone',
      ...CALL_TIMING.map((c) => `cl.${c} as call_${c}`), conn.raw('cl.created_at::text as cursor_at'));
}

const callOf = (row) => ({ id: row.call_log_id, customer_id: row.call_customer_id,
  ...Object.fromEntries(CALL_TIMING.map((c) => [c, row[`call_${c}`]])) });

// ── The judgment ────────────────────────────────────────────────────────────

// The promise as the text lane's checker reads a staff promise: made at the end
// of the call, about the customer the call has now.
async function subjectOf(conn, row, from, cache) {
  const customerId = row.call_customer_id;
  // The customer's only active property scopes a visit or estimate witness, as
  // at an SMS ask's intake; with two or more it stays unscoped (ambiguous).
  const ids = await conn('customer_properties').where({ customer_id: customerId, active: true }).limit(2).pluck('id');
  const propertyId = ids.length === 1 ? ids[0] : null;
  const named = row.due_at && row.due_basis === 'stated' ? etDateString(new Date(row.due_at)) : null;
  const current = { id: row.id, party: row.party, kind: row.kind, description: row.description, evidence: row.evidence, due_at: row.due_at,
    sms_context: { basis: 'promise', made_on: 'phone_call', customer_id: customerId, source_at: from.toISOString(),
      property_id: propertyId, property_ambiguous: !propertyId, ...(named ? { due_date: named } : {}),
      ...(cache?.fulfillment_check ? { fulfillment_check: cache.fulfillment_check } : {}),
      ...(cache?.thread_check ? { thread_check: cache.thread_check } : {}) } };
  const outbound = String(row.call_direction || '').startsWith('outbound');
  const message = { id: NO_MESSAGE_ID, customer_id: customerId, created_at: from, direction: outbound ? 'outbound' : 'inbound',
    from_phone: row.call_from_phone, to_phone: row.call_to_phone, any_customer_phone: true };
  return { current, message };
}

// The newest HUMAN message after the promise's floor, or null: a text the customer sent (any phone) or one a person
// from Waves sent; never an automated reminder, tracker link or receipt. The record loader sees outbound texts
// only, so a record that says "done" cannot see a newer "no one came" or "the send failed, I will resend": a
// close, on a record or on the thread, must not stand over a human message that came after what it read, and
// the later conversation decides instead.
const latestHumanMessage = (conn, message) => latestHumanTextAt(conn, message);
const laterThan = (a, b) => !!a && (!b || a.getTime() > new Date(b).getTime());

// A call record proves the promise only in Waves' own words (the transcript's
// Agent turns), never the customer's.
function sayWavesWords(verdict, evidence) {
  if (verdict.verdict !== 'fulfilled' || verdict.record_type !== 'call') return verdict;
  const record = evidence.records.find((r) => r.ref === `call:${verdict.record_id}`);
  const turns = record && speakerTurns(String(record.text || ''));
  const said = normalizeForMatch(verdict.quote);
  return turns && said && turns.agent.some((turn) => turn.includes(said)) ? verdict : { verdict: 'uncertain', reason: 'not_waves_words' };
}

// The row's cached AI-close verdicts for this VERSION, or null (judgeCandidate reads them, storeCache compares).
function cachedAiClose(row) {
  const prior = parsed(row.contact_check)?.ai_close;
  return prior?.version === VERSION ? prior : null;
}

// GATE_CALL_PROMISE_LATER_TEXT_CHECK helpers. A held proof (HELD_BY_LATER_TEXT) stands without a new model call
// only while the later-text check has already answered for this proof, this newest human message and these later
// texts; otherwise its cached verdict is dropped so the record check runs again (a hold cached before the check
// existed carries no proof to test, so it is judged again once).
async function dropUnansweredHold(conn, current, message, cache, now) {
  const held = current.sms_context.fulfillment_check;
  if (held?.reason !== HELD_BY_LATER_TEXT) return;
  const proof = held.record_id && held.matched_at ? { record_type: held.record_type, record_id: held.record_id, matched_at: held.matched_at } : null;
  const answered = !!proof && !!cache?.later_text_check && await laterTexts.laterVerdictCurrent(conn, { commitment: current, message, proof,
    readThrough: await latestHumanMessage(conn, message), now, cache: cache.later_text_check });
  if (!answered) delete current.sms_context.fulfillment_check;
}

// The later-text check over a held record proof: true when it found nothing against it, so the record may close
// the promise. Keeps its answer on the judgment's cache; a spent budget (null) holds for this run, as before.
async function laterTextsAllowClose(conn, result, { verdict, cache, now, mayCall }) {
  const later = await laterTexts.checkLaterTexts(conn, { commitment: result.current, message: result.message, proof: verdict, readThrough: result.readThrough, now,
    cache: cache?.later_text_check, mayCall });
  if (later) result.cache.later_text_check = later;
  return later?.verdict === 'not_contradicted';
}

// Judges one open promise; writes nothing. `budget.left` caps model calls (a
// cached verdict costs none). Returns { outcome, ... }: skipped | deferred |
// judged, with the verdict, the cache to store and the objects a close needs.
async function judgeCandidate(conn, row, { now, budget, verify = verifySmsFulfillment, verifyThread = verifyThreadCompletion }) {
  const call = callOf(row);
  const after = await evidenceBoundary(conn, row, call, { endOf: callEnd });
  if (!after) return { outcome: 'skipped', reason: 'no_call_time' };
  const from = associationFrom(row, after);
  if (from.getTime() >= now.getTime()) return { outcome: 'skipped', reason: 'not_yet' };
  const cache = cachedAiClose(row) || {};
  const { current, message } = await subjectOf(conn, row, from, cache);
  // GATE_CALL_PROMISE_LATER_TEXT_CHECK: a held proof is judged again unless the later-text check already
  // answered for exactly these later texts (a hold cached before the check existed carries no proof to test).
  const laterLive = callPromiseLaterTextCheckLive();
  if (laterLive) await dropUnansweredHold(conn, current, message, cache, now);
  const evidence = await loadSmsFulfillmentEvidence(conn, current, message, now);
  let model = 0;
  // One model call from the run's budget; false when it is spent.
  const take = () => (budget.left > 0 ? ((budget.left -= 1), (model += 1), true) : false);
  let checked = null;
  let verdict = { verdict: 'open', reason: 'no_witness' };
  if (evidence.records.some((record) => admissibleWitness(record, current, evidence.records))) {
    const { evidenceHash } = fulfillmentFingerprint(current, evidence);
    if (!laterTexts.cacheFresh(current.sms_context.fulfillment_check, evidenceHash, now) && !take()) return { outcome: 'deferred', reason: 'budget' };
    checked = await verify(current, evidence, { now, requireModel: true });
    verdict = sayWavesWords(checked, evidence);
    // A fulfilled verdict the speaker check downgraded is cached as the downgrade, with its evidence hash: the same
    // evidence is not judged again on every pass (storeCache never keeps a fulfilled one).
    if (verdict !== checked) checked = { ...verdict, evidence_hash: checked.evidence_hash, retry_after: null };
  }
  // The later-text verdict rides along when the row has one; storeCache writes that key only then.
  const result = { outcome: 'judged', verdict, current, message, evidence, model,
    cache: { fulfillment_check: checked, thread_check: cache.thread_check ?? null, later_text_check: cache.later_text_check } };
  if (verdict.verdict === 'fulfilled') {
    // A human message after the cited record: the record alone does not close. Remember the held verdict (no
    // quote, same evidence hash) so it is not re-judged, and let the later conversation decide below.
    result.readThrough = await latestHumanMessage(conn, message);
    if (!laterThan(result.readThrough, verdict.matched_at)) return result;
    // GATE_CALL_PROMISE_LATER_TEXT_CHECK: only a clear "no later text says this promise was not kept" lets the
    // record close it.
    if (laterLive && await laterTextsAllowClose(conn, result, { verdict, cache, now, mayCall: take })) {
      return { ...result, model, laterTextChecked: true };
    }
    // With the record the hold rests on (never its quote), so the later-text check can tell whether it already
    // answered. Bookkeeping only: nothing reads these fields while that check is off.
    result.cache.fulfillment_check = { verdict: 'uncertain', reason: HELD_BY_LATER_TEXT, evidence_hash: checked.evidence_hash, retry_after: null,
      record_type: verdict.record_type, record_id: verdict.record_id, matched_at: verdict.matched_at };
    result.verdict = { verdict: 'uncertain', reason: HELD_BY_LATER_TEXT };
  } else result.readThrough = null;
  // The customer's own later "got it, thanks" (or a person's "done") closes what
  // no record shows: the thread check, which only a later text can start.
  const thread = await verifyThread(conn, current, message, now, { mayCall: take }).catch((err) => { logger.warn(`[call-promise-ai-close] thread check failed for ${row.id}: ${err.code || err.name}`); return null; });
  result.model = model;
  if (thread) {
    result.cache.thread_check = thread;
    if (thread.verdict === 'fulfilled') return { ...result, verdict: thread, readThrough: result.readThrough ?? await latestHumanMessage(conn, message) };
  }
  return result;
}

// ── The close ───────────────────────────────────────────────────────────────

// What the verifier saw of the cited record, as one md5. The close and the stand check both take it from the
// same place: the evidence path that admitted the proof (witnessState), serialized the way the prompt was
// (stringifySmsEvidence). Fields that only move forward on their own (a delivery's opens and clicks, a status
// that merely progresses, a visit's later field progress) are left out, so a record that is still what it was
// does not read as changed; admissibleWitness re-decides everything else (ownership, property, recipient,
// delivery, status), so no per-type column list lives here.
const VOLATILE = ['status', 'opened_at', 'clicked_at', 'updated_at'];
const KEEP_KEYS = {
  // A visit: which visit, its state (a completion reverted to on_site still passes admissibleWitness on its
  // history), day and window, what for, and the booking/move/completion stamps. A visit that moves forward
  // re-reads as changed once: the promise reopens and the next run closes it again on the new state.
  visit: ['id', 'status', 'scheduled_date', 'window_start', 'service_type', 'property_id', 'booked_at', 'moved_at', 'cancelled_at', 'completed_at'],
  estimate: ['id', 'service_interest', 'address', 'property_id', 'text'],
};
function witnessFingerprint(record) {
  const keep = KEEP_KEYS[record.type];
  const view = {};
  for (const key of Object.keys(record).sort()) {
    if (keep ? keep.includes(key) : !VOLATILE.includes(key)) view[key] = record[key];
  }
  return md5(stringifySmsEvidence(view));
}

// The cited record as the evidence path sees it NOW, for a promise (`row`, with its call's joined fields):
// { fingerprint } when the record is still an admissible witness, { missing: true } when it is not, { unknown:
// true } when a truncated source may be hiding it. A source that failed outright throws (nothing is decided on it).
async function witnessState(conn, row, { ref, thread = false, now = new Date() }) {
  const call = await conn('call_log').where({ id: row.call_log_id }).first('id', 'customer_id', 'from_phone', 'to_phone', ...CALL_TIMING);
  if (!call?.customer_id) return { missing: true };
  const joined = { ...row, call_customer_id: call.customer_id, call_from_phone: call.from_phone, call_to_phone: call.to_phone,
    ...Object.fromEntries(CALL_TIMING.map((c) => [`call_${c}`, call[c]])) };
  const after = await evidenceBoundary(conn, joined, callOf(joined), { endOf: callEnd });
  if (!after) return { missing: true };
  const from = associationFrom(joined, after);
  if (from.getTime() >= now.getTime()) return { missing: true };
  const { current, message } = await subjectOf(conn, joined, from, null);
  // Read first: a close whose witness a truncated source hides is still reopened by a newer human message.
  const lastHuman = await latestHumanMessage(conn, message);
  if (thread) {
    const { records } = await loadThreadMessages(conn, message, null);
    const found = records.find((r) => r.ref === ref);
    if (found) return { fingerprint: md5(stringifySmsEvidence({ ref, who: found.who, at: found.created_at, text: found.text })), customerId: call.customer_id, lastHuman };
    // The thread loader keeps the newest THREAD_LIMIT texts: a full page may have pushed an older one out.
    return records.length >= THREAD_LIMIT ? { unknown: true, lastHuman } : { missing: true };
  }
  const evidence = await loadSmsFulfillmentEvidence(conn, current, message, now);
  const hard = evidence.failures.filter((f) => !f.endsWith('_truncated'));
  if (hard.length) throw Object.assign(new Error('evidence source failed'), { code: 'evidence_source_failed' });
  const found = evidence.records.find((r) => r.ref === ref);
  if (!found) return evidence.failures.includes(`${ref.split(':')[0]}_truncated`) ? { unknown: true, lastHuman } : { missing: true };
  if (!admissibleWitness(found, current, evidence.records)) return { missing: true };
  return { fingerprint: witnessFingerprint(found), customerId: call.customer_id, lastHuman };
}

const refOf = (checkerType, id) => `${checkerType}:${id}`;

function proofOf(row, verdict, witnessFp, readThrough, laterTextChecked = false) {
  const matchedAt = verdict.matched_at ? iso(verdict.matched_at) : iso(new Date());
  const recordType = LEDGER_RECORD_TYPE[verdict.record_type] || verdict.record_type;
  return storedProof({ strength: 'association', kind: AI_CHECK_KIND, basis: AI_CHECK_BASIS, closed_agent: AGENT,
    record_type: recordType, record_id: verdict.record_id, label: RECORD_LABEL[recordType] || 'record', matched_at: matchedAt,
    check: verdict.basis === THREAD_BASIS ? THREAD_BASIS : 'record', ...(verdict.witness ? { witness: verdict.witness } : {}),
    promise_md5: promiseMd5(row), witness_fp: witnessFp, read_through: readThrough ? iso(readThrough) : null, evidence_hash: verdict.evidence_hash, extractor_version: VERSION,
    // Closed over later human texts that the later-text check found say nothing against it.
    ...(laterTextChecked ? { later_text_check: laterTexts.VERSION } : {}) }, row.call_customer_id);
}

// One transaction: the promise (never waiting: a busy row fails the close and
// the next run judges it again), the call's customer and the cited record are
// locked; the evidence is read again and must hash as the model saw it; and
// only then is the proof written, through the same guards as every automatic
// close (open, still refreshable, the snapshot it was judged from, the call
// still has that customer). A lost race writes nothing.
async function closeOnVerdict(conn, row, judged, { now }) {
  const { verdict, current, message } = judged;
  // A close must be one the stand check can read again: only a record type the evidence path returns (a payment
  // cannot be cited here at all — a call promise never sets money_answerable — and this keeps it that way).
  const thread = verdict.basis === THREAD_BASIS;
  if (!UUID_RE.test(String(verdict.record_id)) || !LEDGER_RECORD_TYPE[verdict.record_type]) return false;
  return conn.transaction(async (trx) => {
    const snapshot = (q) => q.where({ id: row.id, status: 'open' }).whereNull('human_state')
      .whereRaw(...refreshableVerdictSql()).whereRaw("date_trunc('milliseconds', updated_at) = ?", [row.updated_at]);
    if (!await snapshot(trx('call_commitments')).forUpdate().skipLocked().first('id')) return false;
    const lockedCall = await trx('call_log').where({ id: row.call_log_id, customer_id: row.call_customer_id }).forShare()
      .first('id', 'customer_id', ...CALL_TIMING);
    if (!lockedCall) return false;
    // The evidence floor, from the call's timing as locked now: a corrected duration or customer-leg end that
    // moved it takes the verdict away (the next run judges from the new floor).
    const after = await evidenceBoundary(trx, row, lockedCall, { endOf: callEnd });
    if (!after || associationFrom(row, after).getTime() !== new Date(message.created_at).getTime()) return false;
    if (!await revalidateSmsFulfillment(trx, current, message, verdict, now)) return false;
    // The same function the stand check uses, so the stamp and the later comparison can never disagree.
    const state = await witnessState(trx, row, { ref: refOf(verdict.record_type, verdict.record_id), thread, now });
    if (!state.fingerprint) return false;
    // A human message that arrived since the verdict was judged changes the answer: the next run judges again.
    if ((state.lastHuman?.getTime() ?? null) !== (judged.readThrough?.getTime() ?? null)) return false;
    const proof = proofOf(row, verdict, state.fingerprint, judged.readThrough, judged.laterTextChecked === true);
    const written = await snapshot(trx('call_commitments'))
      .whereExists(function callStillHasThatCustomer() {
        this.select(trx.raw('1')).from('call_log').where({ id: row.call_log_id, customer_id: row.call_customer_id }).forShare();
      })
      .update({ status: 'fulfilled', fulfillment: JSON.stringify(proof), fulfilled_at: new Date(proof.matched_at), updated_at: new Date() });
    return written > 0;
  });
}

// Whether an ai-check close still stands, with no model call (called by refreshFulfillment's re-judge): the
// promise is still the one judged, the call still has the customer it was judged for, and — by re-running the
// SAME evidence path that admitted the proof — the cited record is still an admissible witness and still reads
// as the verifier saw it. A source that cannot answer (a truncated channel hiding an old record) keeps the
// close; one that failed throws, and the caller leaves the row as it is.
async function aiCloseStands(conn, commitment, call, prior) {
  if (prior?.basis !== AI_CHECK_BASIS || commitment.party !== 'waves' || commitment.human_state) return false;
  if (prior.promise_md5 !== promiseMd5(commitment) || !call?.customer_id || prior.judged_customer_id !== call.customer_id) return false;
  const checkerType = prior.check === THREAD_BASIS ? 'sms' : CHECKER_TYPE[prior.record_type];
  if (!checkerType || !UUID_RE.test(String(prior.record_id))) return false;
  const state = await witnessState(conn, commitment, { ref: refOf(checkerType, prior.record_id), thread: prior.check === THREAD_BASIS });
  // A human message after the cited record (and after everything the close read) reopens it: the later
  // conversation is judged again, which closes it once more if the customer confirms.
  const contradicted = laterThan(state.lastHuman, new Date(Math.max(new Date(prior.matched_at).getTime() || 0, new Date(prior.read_through).getTime() || 0)));
  const stands = (state.unknown === true || (!!state.fingerprint && state.fingerprint === prior.witness_fp)) && !contradicted;
  // Bookkeeping only (never bumps updated_at): when this close was last read again, for the recheck selector.
  if (stands) {
    await conn('call_commitments').where({ id: commitment.id }).update({
      contact_check: conn.raw("COALESCE(contact_check, '{}'::jsonb) || jsonb_build_object('ai_close', COALESCE(contact_check -> 'ai_close', '{}'::jsonb) || jsonb_build_object('rechecked_at', ?::text))", [new Date().toISOString()]),
    }).catch(() => {});
  }
  return stands;
}

// The lapse scan's AI arm: not a field list but a bounded periodic recheck. The AI-closed promises of the last
// 30 days that were last read (closed, or rechecked) more than RECHECK_AFTER_MS ago, oldest first, at most
// `limit` a run; the call goes through refreshFulfillment, whose re-judge asks aiCloseStands. A close that is
// read on the Owed queue is rechecked at once, whatever this says.
const RECHECK_AFTER_MS = 12 * 60 * 60 * 1000;
const RECHECK_LIMIT = 100;
const LAPSE_DAYS = 30;
async function listRecheckCallIds(conn, { now = new Date(), limit = RECHECK_LIMIT } = {}) {
  const rows = await conn.raw(
    `SELECT DISTINCT call_log_id FROM (
       SELECT cc.call_log_id, COALESCE(cc.contact_check -> 'ai_close' ->> 'rechecked_at', cc.fulfillment ->> 'closed_at') AS last_read
         FROM call_commitments cc
        WHERE cc.human_state IS NULL AND cc.status = 'fulfilled'
          AND (cc.fulfillment ->> 'closed_by') = 'promise_evidence' AND (cc.fulfillment ->> 'basis') = '${AI_CHECK_BASIS}'
          AND (cc.fulfillment ->> 'closed_at') > ?
          AND COALESCE(cc.contact_check -> 'ai_close' ->> 'rechecked_at', cc.fulfillment ->> 'closed_at') < ?
        ORDER BY last_read ASC LIMIT ?) due`,
    [new Date(now.getTime() - LAPSE_DAYS * 24 * 60 * 60 * 1000).toISOString(), new Date(now.getTime() - RECHECK_AFTER_MS).toISOString(), limit]);
  return (rows?.rows || []).map((r) => r.call_log_id);
}

// ── The run ─────────────────────────────────────────────────────────────────

// Bookkeeping only: never bumps updated_at, the version the close guards on.
async function storeCache(conn, row, cache, now) {
  // contact_check rides on the staff-readable commitment row: keep the cached verdicts free of quotes. A
  // fulfilled verdict is not cached at all (it closes the promise in the same run; a lost race asks again).
  const bare = (v) => (v && v.verdict !== 'fulfilled' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'quote')) : null);
  const next = { version: VERSION, fulfillment_check: bare(cache.fulfillment_check), thread_check: bare(cache.thread_check),
    // Only when there is a later-text verdict (GATE_CALL_PROMISE_LATER_TEXT_CHECK): with the check off, no key.
    ...(cache.later_text_check != null ? { later_text_check: bare(cache.later_text_check) } : {}), checked_at: now.toISOString() };
  const prior = cachedAiClose(row);
  // record_id: a held proof that gains the record it rests on is written once, so the later-text check can test it.
  const same = (a, b) => (a?.evidence_hash ?? null) === (b?.evidence_hash ?? null) && (a?.retry_after ?? null) === (b?.retry_after ?? null)
    && (a?.record_id ?? null) === (b?.record_id ?? null);
  if (prior && same(prior.fulfillment_check, next.fulfillment_check) && same(prior.thread_check, next.thread_check)
    && (next.later_text_check === undefined || same(prior.later_text_check, next.later_text_check))) return;
  await conn('call_commitments').where({ id: row.id }).update({
    contact_check: conn.raw("COALESCE(contact_check, '{}'::jsonb) || jsonb_build_object('ai_close', ?::jsonb)", [JSON.stringify(next)]),
  });
}

async function runCallPromiseAiClose({ conn = require('../models/db'), now = new Date(), maxModelCalls = MAX_MODEL_CALLS, callIds = null, pageSize = CANDIDATE_LIMIT, verify, verifyThread } = {}) {
  if (!callPromiseAiCloseLive() || !isEnabled('callCommitments') || !promiseEvidenceCloseLive()) return { skipped: true, reason: 'gated_off' };
  const budget = { left: maxModelCalls };
  const tally = { candidates: 0, model_calls: 0, closed: 0, lost: 0, deferred: 0, skipped: 0, failed: 0 };
  const stopAt = Date.now() + MAX_RUN_MS;
  // Every page, oldest first, inside the run's time and model bounds: promises already judged cost only reads,
  // so a full page of them never crowds a newer promise out.
  for (let cursor = null; ;) {
    const rows = await listCandidates(conn, { callIds, cursor, limit: pageSize });
    tally.candidates += rows.length;
    for (const row of rows) await checkRow(conn, row, { now, budget, stopAt, tally, verify, verifyThread });
    if (rows.length < pageSize || Date.now() > stopAt) break;
    const last = rows[rows.length - 1];
    cursor = { at: last.cursor_at, id: last.id };
  }
  logger.info(`[call-promise-ai-close] run: ${JSON.stringify(tally)}`);
  return tally;
}

async function checkRow(conn, row, { now, budget, stopAt, tally, verify, verifyThread }) {
  if (Date.now() > stopAt) { tally.deferred += 1; return; }
  try {
    const judged = await judgeCandidate(conn, row, { now, budget, verify, verifyThread });
    if (judged.outcome === 'deferred') { tally.deferred += 1; return; }
    if (judged.outcome === 'skipped') { tally.skipped += 1; return; }
    tally.model_calls += judged.model;
    await storeCache(conn, row, judged.cache, now);
    if (judged.verdict.verdict !== 'fulfilled') return;
    if (await closeOnVerdict(conn, row, judged, { now })) tally.closed += 1; else tally.lost += 1;
  } catch (err) {
    tally.failed += 1;
    // The code only: a query error's message can carry its bound values.
    logger.warn(`[call-promise-ai-close] check failed for commitment ${row.id}: ${err.code || err.name}`);
  }
}

// The Owed queue read: a small run behind the response, never two at once in
// this process (a second pod's overlap is safe — the close is guarded — and its
// repeat call is the cache's to absorb).
let backgroundRun = null;
function runInBackground({ conn, callIds }) {
  if (!callPromiseAiCloseLive() || backgroundRun || !callIds?.length) return null;
  backgroundRun = runCallPromiseAiClose({ conn, callIds, maxModelCalls: QUEUE_MODEL_CALLS })
    .catch((err) => { logger.warn(`[call-promise-ai-close] background run failed: ${err.code || err.name}`); })
    .finally(() => { backgroundRun = null; });
  return backgroundRun;
}

module.exports = { runCallPromiseAiClose, runInBackground, listRecheckCallIds, witnessFingerprint, judgeCandidate, listCandidates, closeOnVerdict, aiCloseStands, promiseMd5,
  VERSION, CANDIDATE_LIMIT, AI_CHECK_KIND, AI_CHECK_BASIS, AGENT, MAX_MODEL_CALLS, QUEUE_MODEL_CALLS };
