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
 *     every automatic close carries (closed_by promise_evidence), with the quote
 *     and closed_agent 'ai-check'. The Owed tab lists it with a Reopen; a
 *     reopen is a human verdict, which this job never overrides.
 *
 * refreshFulfillment's re-judge keeps such a close while its cited record
 * stands (aiCloseStands, no model) and reopens it when the call was relinked,
 * the promise was rewritten, or the record is gone. Internal ledger writes
 * only: no customer message of any kind.
 */

const crypto = require('crypto');
const logger = require('./logger');
const { isEnabled, promiseEvidenceCloseLive, callPromiseAiCloseLive } = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');
const commitments = require('./call-commitments');
const { loadSmsFulfillmentEvidence, admissibleWitness, verifySmsFulfillment, fulfillmentFingerprint, revalidateSmsFulfillment } = require('./sms-commitment-fulfillment');
const { verifyThreadCompletion, BASIS: THREAD_BASIS } = require('./sms-commitment-thread-close');

const { associationFrom, evidenceBoundary, storedProof, refreshableVerdictSql, staleAiRowSql, speakerTurns, normalizeForMatch } = commitments;

// Bump on any change to what is asked or how a verdict is used: it is part of
// the stored cache key, so every cached verdict is judged again.
const VERSION = 'call-promise-ai-close-v1';
const AI_CHECK_KIND = 'ai_check';
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

// The checker's record types in the ledger's own record_type spelling (the
// lapse scan and the Owed tab read these), and the table + customer column
// each one's stand check reads (a null column: customer ownership is not a
// plain column there, the record's existence alone is read).
const LEDGER_RECORD_TYPE = { sms: 'sms_log', call: 'call_log', visit: 'scheduled_service', estimate: 'estimate',
  email_reply: 'email', email_delivery: 'email_message' };
// A visit that was cancelled, skipped or never happened after it kept a promise no longer keeps it (a
// rescheduled one still does: moving the visit is the booking act). The one exception is a promise TO
// CANCEL a visit, which the cancellation itself kept: its proof carries visit_cancel and stands only
// while the visit stays cancelled.
const CANCELLED_VISIT_STATUSES = ['cancelled', 'canceled'];
const DEAD_VISIT_STATUSES = [...CANCELLED_VISIT_STATUSES, 'skipped', 'no_show'];
const sqlList = (values) => values.map((v) => `'${v}'`).join(', ');
const RECORD_TABLES = { sms_log: ['sms_log', 'customer_id'], call_log: ['call_log', 'customer_id'],
  scheduled_service: ['scheduled_services', 'customer_id', (q, prior) => (prior?.visit_cancel
    ? q.whereIn('status', CANCELLED_VISIT_STATUSES) : q.whereNotIn('status', DEAD_VISIT_STATUSES))],
  estimate: ['estimates', null], email: ['emails', null], email_message: ['email_messages', null] };

const callEnd = (call) => require('./call-booking-link-text').callEndFor(call);
const CALL_TIMING = ['created_at', 'bridged_at', 'duration_seconds', 'recording_duration_seconds', 'direction', 'metadata'];
const md5 = (text) => crypto.createHash('md5').update(text, 'utf8').digest('hex');
const iso = (value) => new Date(value).toISOString();

// What the promise is, as a close rests on it: a reprocess that rewrites what
// was promised takes the close away and the next run judges the new promise.
const promiseMd5 = (commitment) => md5(JSON.stringify({ kind: commitment.kind, description: commitment.description,
  due_at: commitment.due_at ? iso(commitment.due_at) : null,
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

// A call record proves the promise only in Waves' own words (the transcript's
// Agent turns), never the customer's.
function sayWavesWords(verdict, evidence) {
  if (verdict.verdict !== 'fulfilled' || verdict.record_type !== 'call') return verdict;
  const record = evidence.records.find((r) => r.ref === `call:${verdict.record_id}`);
  const turns = record && speakerTurns(String(record.text || ''));
  const said = normalizeForMatch(verdict.quote);
  return turns && said && turns.agent.some((turn) => turn.includes(said)) ? verdict : { verdict: 'uncertain', reason: 'not_waves_words' };
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
  const cache = parsed(row.contact_check)?.ai_close?.version === VERSION ? parsed(row.contact_check).ai_close : null;
  const { current, message } = await subjectOf(conn, row, from, cache);
  const evidence = await loadSmsFulfillmentEvidence(conn, current, message, now);
  let model = 0;
  let checked = null;
  let verdict = { verdict: 'open', reason: 'no_witness' };
  if (evidence.records.some((record) => admissibleWitness(record, current, evidence.records))) {
    const previous = current.sms_context.fulfillment_check;
    const { evidenceHash } = fulfillmentFingerprint(current, evidence);
    const fresh = previous?.evidence_hash === evidenceHash && (!previous.retry_after || new Date(previous.retry_after) > now);
    if (!fresh && budget.left <= 0) return { outcome: 'deferred', reason: 'budget' };
    if (!fresh) { budget.left -= 1; model += 1; }
    checked = await verify(current, evidence, { now, requireModel: true });
    verdict = sayWavesWords(checked, evidence);
  }
  const result = { outcome: 'judged', verdict, current, message, evidence, model,
    cache: { fulfillment_check: checked, thread_check: cache?.thread_check ?? null } };
  if (verdict.verdict === 'fulfilled') return result;
  // The customer's own later "got it, thanks" (or a person's "done") closes what
  // no record shows: the thread check, which only a later text can start.
  const thread = await verifyThread(conn, current, message, now, { mayCall: () => {
    if (budget.left <= 0) return false;
    budget.left -= 1; result.model += 1; return true;
  } }).catch((err) => { logger.warn(`[call-promise-ai-close] thread check failed for ${row.id}: ${err.code || err.name}`); return null; });
  if (thread) {
    result.cache.thread_check = thread;
    if (thread.verdict === 'fulfilled') return { ...result, verdict: thread };
  }
  return result;
}

// ── The close ───────────────────────────────────────────────────────────────

function proofOf(row, verdict, evidence) {
  // The cited visit was kept by its cancellation (a promise to cancel it), not by a booking or field progress.
  const record = verdict.record_type === 'visit' && evidence?.records.find((r) => r.ref === `visit:${verdict.record_id}`);
  const visitCancel = !!record?.cancelled_at && !record.progressed_at && !record.booked_at && !record.moved_at;
  const matchedAt = verdict.matched_at ? iso(verdict.matched_at) : iso(new Date());
  return storedProof({ strength: 'association', kind: AI_CHECK_KIND, basis: AI_CHECK_BASIS, closed_agent: AGENT,
    record_type: LEDGER_RECORD_TYPE[verdict.record_type] || verdict.record_type, record_id: verdict.record_id, matched_at: matchedAt,
    quote: verdict.quote, check: verdict.basis === THREAD_BASIS ? THREAD_BASIS : 'record', ...(verdict.witness ? { witness: verdict.witness } : {}),
    promise_md5: promiseMd5(row), evidence_hash: verdict.evidence_hash, extractor_version: VERSION, ...(visitCancel ? { visit_cancel: true } : {}) }, row.call_customer_id);
}

// One transaction: the promise (never waiting: a busy row fails the close and
// the next run judges it again), the call's customer and the cited record are
// locked; the evidence is read again and must hash as the model saw it; and
// only then is the proof written, through the same guards as every automatic
// close (open, still refreshable, the snapshot it was judged from, the call
// still has that customer). A lost race writes nothing.
async function closeOnVerdict(conn, row, judged, { now }) {
  const { verdict, current, message } = judged;
  // A close must be one the stand check can read again: no record type outside
  // RECORD_TABLES closes (a payment cannot be cited here at all — a call promise
  // never sets money_answerable — and this keeps it that way).
  if (!UUID_RE.test(String(verdict.record_id)) || !RECORD_TABLES[LEDGER_RECORD_TYPE[verdict.record_type]]) return false;
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
    const proof = proofOf(row, verdict, judged.evidence);
    const written = await snapshot(trx('call_commitments'))
      .whereExists(function callStillHasThatCustomer() {
        this.select(trx.raw('1')).from('call_log').where({ id: row.call_log_id, customer_id: row.call_customer_id }).forShare();
      })
      .update({ status: 'fulfilled', fulfillment: JSON.stringify(proof), fulfilled_at: new Date(proof.matched_at), updated_at: new Date() });
    return written > 0;
  });
}

// Whether an ai-check close still stands, with no model call (called by
// refreshFulfillment's re-judge): the promise is still the one judged, the call
// still has the customer it was judged for, and the one record it rests on
// still exists (for that customer where the table says so) and, for a visit,
// was not cancelled or skipped since.
async function aiCloseStands(conn, commitment, call, prior) {
  if (prior?.basis !== AI_CHECK_BASIS || commitment.party !== 'waves' || commitment.human_state) return false;
  if (prior.promise_md5 !== promiseMd5(commitment) || !call?.customer_id || prior.judged_customer_id !== call.customer_id) return false;
  const [table, customerColumn, stillCounts] = RECORD_TABLES[prior.record_type] || [];
  if (!table || !UUID_RE.test(String(prior.record_id))) return false;
  return !!await conn(table).where({ id: prior.record_id })
    .modify((q) => { if (customerColumn) q.where(customerColumn, call.customer_id); })
    .modify((q) => { if (stillCounts) stillCounts(q, prior); }).first('id');
}

// The watchdog's lapse scan (listLapsedAssociationCloses) asks, per closed row of
// a call: has the cited record gone, changed owner or died? One CASE over the
// same table map the stand check reads, with the uuid cast inside the matching
// branch only (a text cast would defeat the primary-key index). `cc` is the
// closed row's alias (its fulfillment), `cl` its call.
function aiCheckLapsedSql(cc = 'cc', cl = 'cl') {
  const branches = Object.entries(RECORD_TABLES).map(([type, [table, customerColumn, stillCounts]]) => {
    const dead = stillCounts ? ` AND (CASE WHEN (${cc}.fulfillment ->> 'visit_cancel') = 'true' THEN r.status IN (${sqlList(CANCELLED_VISIT_STATUSES)}) ELSE r.status NOT IN (${sqlList(DEAD_VISIT_STATUSES)}) END)` : '';
    const owner = customerColumn ? ` AND r.${customerColumn} = ${cl}.customer_id` : '';
    return `WHEN '${type}' THEN NOT EXISTS (SELECT 1 FROM ${table} r WHERE r.id = (${cc}.fulfillment ->> 'record_id')::uuid${owner}${dead})`;
  });
  return `((${cc}.fulfillment ->> 'basis') = '${AI_CHECK_BASIS}' AND CASE (${cc}.fulfillment ->> 'record_type') ${branches.join(' ')} ELSE TRUE END)`;
}

// ── The run ─────────────────────────────────────────────────────────────────

// Bookkeeping only: never bumps updated_at, the version the close guards on.
async function storeCache(conn, row, cache, now) {
  const next = { version: VERSION, ...cache, checked_at: now.toISOString() };
  const prior = parsed(row.contact_check)?.ai_close;
  const same = (a, b) => (a?.evidence_hash ?? null) === (b?.evidence_hash ?? null) && (a?.retry_after ?? null) === (b?.retry_after ?? null);
  if (prior?.version === VERSION && same(prior.fulfillment_check, next.fulfillment_check) && same(prior.thread_check, next.thread_check)) return;
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

module.exports = { runCallPromiseAiClose, runInBackground, aiCheckLapsedSql, judgeCandidate, listCandidates, closeOnVerdict, aiCloseStands, promiseMd5,
  VERSION, CANDIDATE_LIMIT, AI_CHECK_KIND, AI_CHECK_BASIS, AGENT, MAX_MODEL_CALLS, QUEUE_MODEL_CALLS };
