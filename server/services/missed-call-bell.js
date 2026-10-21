/**
 * "Customer called and we missed it" bell (owner ruling 2026-08-28: the
 * bell/push/badge are for customer communication — a missed call is one).
 *
 * Runs 5 minutes after the call's terminal status (post-call hook + the
 * 2-minute sweep), so a voicemail has had time to land: a call WITH a recording is the voicemail
 * lane's (customer_voicemail_callback) and never rings here. Rings at most
 * once per call, only for an inbound call from a customer on file that no
 * human or AI agent answered. Delivery state lives in call_log.metadata:
 *   missed_call_notified_at — a LEASE (fence token; reclaimable once stale,
 *                             so a crash mid-delivery never loses the alert)
 *   missed_call_settled_at  — terminal: delivered (or superseded)
 */
const db = require('../models/db');
const logger = require('./logger');
const { isSentinelPhone, PHONE_SENTINELS } = require('./external-phone');
const { whereNotBlockedCall, phoneKeySql } = require('../middleware/spam-block');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');

const UNANSWERED = new Set(['missed', 'voicemail', 'unknown']);
// A row with NO answered_by (the Studio-flow status_callback fallback in
// twilio-voice-webhook.js inserts terminal calls without an outcome) counts
// as missed only when Twilio's own status says nobody picked up. A
// `completed` call with no outcome may have been handled by the flow — it
// never rings (codex r4).
const UNANSWERED_STATUSES = new Set(['no-answer', 'busy', 'canceled']);
// Lease length: covers customer lookup + delivery with margin; a stale lease
// is reclaimed by the 2-minute sweep.
const LEASE_MS = 10 * 60 * 1000;
// Time after a call's terminal update before "no recording" means "no
// voicemail": ~120s recording window + Twilio's recording callback.
const VOICEMAIL_GRACE_MS = 5 * 60 * 1000;

function outcomeUnanswered(row) {
  if (row.answered_by) return UNANSWERED.has(row.answered_by);
  return UNANSWERED_STATUSES.has(row.status);
}

// An unknown number that hung up inside the first seconds (a misdial, a
// robodialer probing the line) is not a lead. Owner ruling 2026-10-05
// (replaces the 2026-09-24 25-second rule): an unknown caller who waited 15
// seconds or more and left no message counts as a missed call someone should
// return. Customers on file ring regardless of duration, as before. In the 7
// days to 2026-10-05, nine unknown callers hung up between 20 and 24 s with
// no recording and got neither the alert nor the text-back. The missed-call
// text-back lane reads this same constant, so one value sets both.
const UNKNOWN_CALLER_MIN_SECONDS = 15;

// Unknown prospects share the missed-call lease; withheld IDs, quick
// hang-ups and Nomorobo spam stay silent.
function unknownCallerAllowed(row, opts) {
  if (!opts?.unknownCallers) return false;
  if (!(Number(row.duration_seconds) >= UNKNOWN_CALLER_MIN_SECONDS)) return false;
  // Withheld caller ID ("anonymous") is not a number anyone can call back.
  if (isSentinelPhone(row.from_phone) || String(row.from_phone || '').replace(/\D/g, '').length < 10) return false;
  if (String(row.source || '') === 'voice_relay_sandbox') return false;
  const meta = parseMeta(row.metadata);
  try {
    const nomo = meta.addons?.results?.nomorobo_spamscore;
    if (nomo?.status === 'successful' && Number(nomo.result?.score) === 1) return false;
  } catch (_e) { /* fail open — an unparseable envelope is not a spam verdict */ }
  return true;
}

// What the recording processor writes when a recording holds no speech: the
// rejected-transcription sentinel (call-recording-processor.js
// TRANSCRIPTION_REJECTED_SENTINEL) or the transcriber's own dead-air markers.
const NO_SPEECH_MARKER_RE = /\[(?:VOICEMAIL|NO SPEECH)\]|\[Recording had no usable speech;[^\]]*\]/gi;

/**
 * Pure: did the caller reach the voicemail greeting, wait, and hang up
 * without saying anything? True only when a recording exists AND the
 * processor has FINISHED with it and found no speech: transcription_status
 * 'rejected' (an implausible transcript thrown out) with no real text left,
 * or a 'completed' transcript that is nothing but the no-speech markers.
 * A recording still awaiting transcription is NOT empty — its voicemail may
 * yet hold a message — so it stays the voicemail lane's.
 */
function isEmptyVoicemailRecording(row) {
  if (!row || !(row.recording_sid || row.recording_url)) return false;
  const status = String(row.transcription_status || '').toLowerCase();
  const text = typeof row.transcription === 'string' ? row.transcription : '';
  const residue = text.replace(NO_SPEECH_MARKER_RE, '').replace(/[^\p{L}\p{N}]/gu, '');
  if (status === 'rejected') return residue === '';
  if (status === 'completed') return text.search(NO_SPEECH_MARKER_RE) !== -1 && residue === '';
  return false;
}

// Missed-call bell gaps (owner 2026-10-20). Both are admitted only through the
// opts the bell passes under its own gates, so the text-back lane, which shares
// missedCallShapeEligible, never sees them.
//   customerEmptyVoicemail (GATE_MISSED_CALL_EMPTY_VM_CUSTOMER): a customer on
//     file whose recording held no speech counts as "no message left".
//   noOutcomeCustomer (GATE_MISSED_CALL_NO_OUTCOME_CUSTOMER): a customer's
//     `completed` call with no answered_by and no recording counts as unanswered.
function emptyRecordingAdmitted(row, opts) {
  if (!isEmptyVoicemailRecording(row)) return false;
  return Boolean(opts?.emptyVoicemail || (opts?.customerEmptyVoicemail && row.customer_id));
}

const AI_OUTCOMES = new Set(['ai_handled', 'ai_transferred']);
function noOutcomeCustomerCall(row) {
  return Boolean(row.customer_id) && !row.answered_by && row.status === 'completed'
    && !(row.recording_sid || row.recording_url) && !AI_OUTCOMES.has(row.call_outcome);
}
// outcomeUnanswered stays one-argument: repeat-caller-bell passes it to Array.filter.
function outcomeUnansweredFor(row, opts) {
  return outcomeUnanswered(row) || Boolean(opts?.noOutcomeCustomer && noOutcomeCustomerCall(row));
}

// The gap options, read per call so a flip needs no restart.
function gapOptions() {
  const { isEnabled } = require('../config/feature-gates');
  return {
    customerEmptyVoicemail: isEnabled('missedCallEmptyVmCustomer'),
    noOutcomeCustomer: isEnabled('missedCallNoOutcomeCustomer'),
  };
}

// The SQL twin of outcomeUnansweredFor, shared by the claim and the sweep.
// Gate off (or B off) it is the original clause, byte for byte.
const UNANSWERED_SQL_HEAD = '(answered_by IN (?, ?, ?) OR (answered_by IS NULL AND status IN (?, ?, ?))';
function unansweredClause(gaps) {
  const sql = gaps?.noOutcomeCustomer
    ? `${UNANSWERED_SQL_HEAD} OR (answered_by IS NULL AND status = 'completed' AND customer_id IS NOT NULL AND recording_sid IS NULL AND recording_url IS NULL))`
    : `${UNANSWERED_SQL_HEAD})`;
  return [sql, [...UNANSWERED, ...UNANSWERED_STATUSES]];
}

// "No voicemail yet" in SQL. Gate A on and the call is a customer's empty
// voicemail: the claim pins the very recording and transcription state that
// was read as empty, so a newer recording or a re-transcription loses the race.
function emptyVmCustomerAdmitted(row, gaps) {
  return Boolean(gaps?.customerEmptyVoicemail && row?.customer_id && isEmptyVoicemailRecording(row));
}
function recordingFilter(row, admitted) {
  return (qb) => {
    if (!admitted) return qb.whereNull('recording_sid').whereNull('recording_url');
    return qb.whereNotNull('customer_id')
      .whereRaw('recording_sid IS NOT DISTINCT FROM ?::text', [row.recording_sid])
      .whereRaw('recording_url IS NOT DISTINCT FROM ?::text', [row.recording_url])
      .whereRaw('transcription_status IS NOT DISTINCT FROM ?::text', [row.transcription_status])
      // The text too: a markers-only transcript replaced by real speech on the
      // same recording and status is a voicemail, not an empty one.
      .whereRaw('transcription IS NOT DISTINCT FROM ?::text', [row.transcription]);
  };
}
// The sweep cannot know a row yet: with gate A on it also lists a customer's
// recording the processor finished with as rejected or as markers only; the
// JS shape check decides. Gate off it is the original two whereNull calls.
function sweepRecordingFilter(gaps) {
  return (qb) => {
    if (!gaps?.customerEmptyVoicemail) return qb.whereNull('recording_sid').whereNull('recording_url');
    return qb.where((g) => g
      .where((none) => none.whereNull('recording_sid').whereNull('recording_url'))
      .orWhere((vm) => vm.whereNotNull('customer_id')
        .where((t) => t.where('transcription_status', 'rejected')
          .orWhere((c) => c.where('transcription_status', 'completed').whereRaw("transcription LIKE '%[%'")))));
  };
}

/**
 * Pure: is this an inbound call nobody answered that no other lane owns?
 * The call's own shape only — never the bell's delivery state, so
 * missed-call-text-back.js (its own lease/settle keys) can share the rule
 * without the bell's settled alert hiding the call from it.
 *
 * `opts.emptyVoicemail` (text-back lane only, behind its own gate): a
 * recording that held no speech counts as "no message left". The bell never
 * passes it, so the bell's behavior is unchanged.
 */
function missedCallShapeEligible(row, opts = {}) {
  if (!row || row.direction !== 'inbound') return false;
  if (!row.customer_id && !unknownCallerAllowed(row, opts)) return false;
  if ((row.recording_sid || row.recording_url) && !emptyRecordingAdmitted(row, opts)) return false; // voicemail lane owns it
  if (row.voicemail_callback_alerted_at) return false;                // voicemail lane already rang
  if (row.call_outcome === 'ai_handled' || row.call_outcome === 'ai_transferred') return false; // Sandy handled it / handed it to a person
  if (!outcomeUnansweredFor(row, opts)) return false;                 // human / ai_agent / unknown-outcome
  return true;
}

/** Pure eligibility — exported for tests. */
function missedCallEligible(row, now = Date.now(), opts = {}) {
  if (!missedCallShapeEligible(row, opts)) return false;
  const meta = parseMeta(row.metadata);
  if (meta.missed_call_settled_at) return false;                      // delivered / superseded
  if (meta.missed_call_notified_at && !leaseStale(meta.missed_call_notified_at, now)) return false; // live lease
  return true;
}

// The caller already got through on a later call: a person or Sandy
// answered it, the voicemail lane rang for it, or we called back and their
// leg was dialed (bridged_at). A redial seconds later is the common case
// (2026-10-03 and 10-05: the redial was answered, the first attempt still
// rang). A recording alone is not proof: a dead-air voicemail rings nothing.
// Excluded in both the claim and the sweep, so such a call is never offered.
const LATER_KEY = phoneKeySql('later.from_phone');
const CALLER_KEY = phoneKeySql('call_log.from_phone');
const buildCalledBackSql = (outboundProof) => 'NOT EXISTS (SELECT 1 FROM call_log later'
  + ' WHERE later.id <> call_log.id AND later.created_at >= call_log.created_at'
  + " AND COALESCE(later.source, '') <> 'voice_relay_sandbox'"
  + ` AND ((later.direction = 'outbound' AND later.bridged_at IS NOT NULL${outboundProof} AND ${phoneKeySql('later.to_phone')} = ${CALLER_KEY})`
  + ` OR (later.direction = 'inbound' AND ${LATER_KEY} = ${CALLER_KEY}`
  + " AND (later.answered_by IN ('human', 'ai_agent') OR later.call_outcome IN ('ai_handled', 'ai_transferred')"
  + ' OR later.voicemail_callback_alerted_at IS NOT NULL))))';
const CALLED_BACK_SQL = buildCalledBackSql('');

// GATE_CALLBACK_NEEDS_ANSWER (owner 2026-10-20): bridged_at is stamped when the
// STAFF leg presses 1, before the customer leg is dialed, so a callback that
// rang out counted as "called back". With the gate on an outbound call counts
// only with proof the customer answered:
//  - the customer leg the <Dial action> recorded completed with seconds > 0
//    (metadata.customer_leg; call-commitments.js reads the same shape); or
//  - no customer_leg (it is written on a minority of bridged calls) and a
//    recording of the call: the bridge records from answer
//    (record-from-answer-dual), so a recording exists only once the customer
//    leg picked up. The parent-leg duration_seconds proves nothing: it holds
//    the 8 s press-1 prompt plus the whole 30 s ring, so a callback that rang
//    out lasts longer than any sensible "answered" threshold; or
//  - (claim, sweep and push re-read only, never retire) no customer_leg and the
//    bridged call is still in flight (status stays 'bridged' until the status
//    callback ends it): it may be live now, and the sweep looks again in 2
//    minutes. Capped at 15 minutes from the bridge.
// No literal question mark: knex reads one as a binding.
const CUSTOMER_LEG_SECONDS_SQL = "CASE WHEN later.metadata->'customer_leg'->>'duration_seconds' ~ '^[0-9]+$' THEN (later.metadata->'customer_leg'->>'duration_seconds')::numeric > 0 ELSE FALSE END";
const CALLED_BACK_ANSWERED_SQL = buildCalledBackSql(
  " AND ((later.metadata->'customer_leg'->>'status' = 'completed' AND " + CUSTOMER_LEG_SECONDS_SQL + ')'
  + " OR (later.metadata->'customer_leg' IS NULL AND later.recording_duration_seconds > 0 AND (later.recording_sid IS NOT NULL OR later.recording_url IS NOT NULL)))");
// The same proof plus a bridged call still in flight. For the claim, the sweep
// and the re-read before the push ONLY (do not ring during a live callback;
// the sweep looks again in 2 minutes). Never for retiring a bell: a callback
// still ringing may go unanswered, and a retired bell does not come back.
const CALLED_BACK_DEFER_SQL = buildCalledBackSql(
  " AND ((later.metadata->'customer_leg'->>'status' = 'completed' AND " + CUSTOMER_LEG_SECONDS_SQL + ')'
  + " OR (later.metadata->'customer_leg' IS NULL AND later.recording_duration_seconds > 0 AND (later.recording_sid IS NOT NULL OR later.recording_url IS NOT NULL))"
  + " OR (later.metadata->'customer_leg' IS NULL AND later.status = 'bridged' AND later.bridged_at > now() - interval '15 minutes'))");
// Read at call time, so the claim, the sweep, the re-read before the push and
// the retire pass all follow one gate. `retire` asks for proof of an answered leg.
function calledBackSql({ retire = false } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('callbackNeedsAnswer')) return CALLED_BACK_SQL;
  return retire ? CALLED_BACK_ANSWERED_SQL : CALLED_BACK_DEFER_SQL;
}

function parseMeta(meta) {
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  return meta && typeof meta === 'object' ? meta : {};
}

function leaseStale(token, now = Date.now()) {
  const t = new Date(token).getTime();
  return !Number.isFinite(t) || now - t > LEASE_MS;
}

// Shadow for gates A and B while they are off: stamp
// metadata.missed_call_gap_shadow on a call the gate WOULD have rung, once, so
// the owner can read how many a flip changes before making it. No bell, no
// settle, no updated_at change (the sweep's voicemail grace reads updated_at).
const SHADOW_KEY = 'missed_call_gap_shadow';
const SHADOW_LIMIT = 50;
async function stampGapShadows(gaps, now) {
  try {
    if (!gaps.customerEmptyVoicemail) {
      await stampShadow('empty_vm_customer', { customerEmptyVoicemail: true }, now, (q) => q
        .where((r) => r.whereNotNull('recording_sid').orWhereNotNull('recording_url'))
        .whereIn('transcription_status', ['rejected', 'completed']));
    }
    if (!gaps.noOutcomeCustomer) {
      await stampShadow('no_outcome_customer', { noOutcomeCustomer: true }, now, (q) => q
        .whereNull('answered_by').where('status', 'completed').whereNull('recording_sid').whereNull('recording_url'));
    }
  } catch (err) {
    logger.warn(`[missed-call-bell] gap shadow failed: ${err.message}`);
  }
}

async function stampShadow(kind, shapeOpts, now, narrow) {
  const rows = await db('call_log')
    .modify((q) => whereNotSandboxCall(q))
    .modify(whereNotBlockedCall)
    .where({ direction: 'inbound' })
    .whereNotNull('customer_id')
    .whereIn('status', TERMINAL_STATUSES)
    .whereNull('voicemail_callback_alerted_at')
    .whereRaw("COALESCE(call_outcome, '') NOT IN ('ai_handled', 'ai_transferred')")
    .whereRaw("COALESCE(metadata->>'missed_call_settled_at','') = ''")
    .whereRaw(`COALESCE(metadata->>'${SHADOW_KEY}','') = ''`)
    .whereRaw(calledBackSql())
    .where('created_at', '>', new Date(now - 24 * 60 * 60 * 1000))
    .whereRaw('COALESCE(updated_at, created_at) < ?', [new Date(now - VOICEMAIL_GRACE_MS)])
    .modify(narrow)
    .orderBy('created_at', 'desc')
    .limit(SHADOW_LIMIT);
  const ids = rows.filter((r) => missedCallEligible(r, now, shapeOpts)).map((r) => r.id);
  if (!ids.length) return 0;
  return db('call_log').whereIn('id', ids).modify((q) => whereNotSandboxCall(q))
    .whereRaw(`COALESCE(metadata->>'${SHADOW_KEY}','') = ''`)
    .update({ metadata: db.raw(`COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('${SHADOW_KEY}', ?::text)`, [kind]) });
}

// GATE_MISSED_CALL_PUSH_CHECK (owner 2026-10-20): the bell used to settle as
// soon as its row was written, even when the push reached no phone. Pass 1
// that finds the push dead (a subscription existed, none was sent, none was
// merely skipped) releases the lease and records missed_call_push_retries, so
// the 2-minute sweep offers the call once more, push only. Pass 2 settles
// whatever happens and, when the push is dead again, raises one admin alert
// per ET day.
// firstPassSubs: on the retry pass, how many subscriptions pass 1 found. Expired
// ones are deactivated by the push service, so the retry can find none left;
// that still means the push reached no phone either time.
function pushReachedNoPhone(stats, firstPassSubs = 0) {
  const push = stats?.push;
  return Boolean(push) && (Number(push.subscriptions || 0) > 0 || firstPassSubs > 0)
    && Number(push.sent || 0) === 0 && Number(push.skipped || 0) === 0;
}

async function raisePushDeadAlert(row) {
  const { raiseAdminAlert } = require('./admin-alert-compose');
  const { etDateString } = require('../utils/datetime-et');
  return raiseAdminAlert('alert', {
    area: 'System',
    action: 'Missed-call push reached no phone',
    why: 'A missed-call alert rang the bell, but no phone received the push after two tries.',
    severity: 'needs-you',
    link: `/admin/communications#tab=calls&call=${encodeURIComponent(row.id)}`,
    subject: { type: 'check', id: 'missed_call_push' },
    doneWhen: 'push_reaches_a_phone',
    who: 'person',
  }, {
    bell: true,
    dedupeKey: `missed-call-push-no-phone:${etDateString()}`,
    metadata: { callLogId: row.id },
  });
}

// The push-retry state a claim won: whether pass 1 left a retry pending and how
// many subscriptions it found.
function pushRetryState(metadata) {
  const meta = parseMeta(metadata);
  return {
    pushRetry: Number(meta.missed_call_push_retries || 0) >= 1,
    firstPassSubs: Number(meta.missed_call_push_first_subs || 0),
  };
}

async function holdForPushRetry({ row, stats, fenced, pushRetry, firstPassSubs }) {
  if (pushRetry) {
    if (pushReachedNoPhone(stats, firstPassSubs)) await raisePushDeadAlert(row).catch((err) => logger.warn(`[missed-call-bell] push alert failed: ${err.message}`));
    return false;
  }
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('missedCallPushCheck') || !stats?.bellWritten || !pushReachedNoPhone(stats)) return false;
  await fenced().update({ metadata: db.raw("(metadata - 'missed_call_notified_at') || jsonb_build_object('missed_call_push_retries', 1, 'missed_call_push_first_subs', ?::int)", [Number(stats.push.subscriptions)]) });
  return true;
}

// True when the bell write was suppressed only because a callback is in flight
// (GATE_CALLBACK_NEEDS_ANSWER defer arm): the call is still missed by the
// answered-proof test. If that callback rings out, nothing rang, so the call
// must not settle; the sweep retries after the callback ends. Gate off, both
// tests are the same SQL and this is always false.
const deferredOnlyCheck = (stillMissed, stillMissedFinal) => async () => !(await stillMissed()) && Boolean(await stillMissedFinal());

// The end of one delivery pass: settle it, release the lease for the next
// sweep, or (gate D) hold the call for the push retry.
async function finishDelivery({ row, stats, fenced, settle, pushRetry, firstPassSubs, deferredOnly }) {
  const deferred = !pushRetry && Boolean(stats?.suppressed) && !stats.bellWritten
    && await deferredOnly().catch(() => false);
  const delivered = !deferred && (pushRetry || Boolean(stats && !stats.error
    && (stats.bellWritten || Number(stats.push?.sent || 0) > 0 || stats.suppressed || stats.policySilenced)));
  if (!delivered) {
    await fenced().update({ metadata: db.raw("metadata - 'missed_call_notified_at'") }).catch(() => {});
    return;
  }
  const held = await holdForPushRetry({ row, stats, fenced, pushRetry, firstPassSubs }).catch(() => false);
  if (!held) await settle().catch(() => {});
}

async function ringMissedCallIfUnanswered(callSid) {
  if (!callSid) return false;
  try {
    const row = await db('call_log').where('twilio_call_sid', callSid).modify(whereNotBlockedCall).first();
    const { isEnabled } = require('../config/feature-gates');
    const gaps = gapOptions();
    if (!missedCallEligible(row, Date.now(), { unknownCallers: isEnabled('missedCallUnknownCallers'), ...gaps })) return false;
    const recording = recordingFilter(row, emptyVmCustomerAdmitted(row, gaps));
    const calledBack = calledBackSql();
    // Atomic claim: first writer wins across retries / pods. The mutable
    // eligibility predicates are re-checked IN the claim so a voicemail
    // recording or an answered outcome that landed between the read above
    // and this write loses the race (codex r4).
    const token = new Date().toISOString();
    const reclaimed = Boolean(parseMeta(row.metadata).missed_call_notified_at);
    const [claimed] = await db('call_log')
      .where({ id: row.id })
      .modify(whereNotBlockedCall)
      .whereRaw("COALESCE(metadata->>'missed_call_settled_at','') = ''")
      .whereRaw("(COALESCE(metadata->>'missed_call_notified_at','') = '' OR (metadata->>'missed_call_notified_at')::timestamptz < ?)", [new Date(Date.now() - LEASE_MS)])
      .modify(recording)
      .whereNull('voicemail_callback_alerted_at')
      .whereRaw("COALESCE(call_outcome,'') NOT IN ('ai_handled', 'ai_transferred')")
      .whereRaw(...unansweredClause(gaps))
      .whereRaw(calledBack)
      // RETURNING: the push-retry state below is read from the row this very
      // claim won, never from the snapshot read before it (a concurrent pass
      // may have released its lease with a retry recorded in between).
      .update({ metadata: db.raw("COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('missed_call_notified_at', ?::text)", [token]) }, ['metadata']);
    if (!claimed) return false;
    // Every later write is fenced on the token: a stale owner waking up
    // late can't settle or release a lease someone else now holds.
    const fenced = () => db('call_log').where({ id: row.id }).whereRaw("metadata->>'missed_call_notified_at' = ?", [token]);
    const settle = () => fenced().update({ metadata: db.raw("metadata || jsonb_build_object('missed_call_settled_at', ?::text)", [new Date().toISOString()]) });
    // Reclaimed a stale lease: the previous owner may have died after the
    // bell was written. A bell row for this call means it delivered. A
    // push-only delivery leaves no row; a re-send is coalesced by the
    // per-call push tag (browser replaces same-tag notifications), whereas
    // settling before dispatch would make the crash a permanent loss.
    // A push-only retry (GATE_MISSED_CALL_PUSH_CHECK, pass 2): the bell row from
    // pass 1 stands. Keyed on the stored counter, not the gate, so a gate flipped
    // off between the passes can never write a second bell.
    const { pushRetry, firstPassSubs } = pushRetryState(claimed.metadata);
    // A pending push retry skips the shortcut: its bell row is expected, and a
    // pass 2 that crashed before dispatch must still send the push.
    if (reclaimed && !pushRetry) {
      const prior = await db('notifications').where({ recipient_type: 'admin', category: 'missed_call' })
        .whereRaw("metadata->>'triggerKey' = 'customer_missed_call'")
        .whereRaw("metadata->'payload'->>'callLogId' = ?", [String(row.id)]).first('id');
      if (prior) { await settle(); return false; }
    }
    const customer = row.customer_id
      ? await db('customers').where('id', row.customer_id).first('first_name', 'last_name', 'phone')
      : null;
    const lineLabel = row.customer_id ? null : (parseMeta(row.metadata).location || null);
    const { triggerNotification } = require('./notification-triggers');
    // Is this call still the missed-call lane's? False once a recording
    // persisted or the voicemail lane claimed it.
    // False too once a later call got through (calledBackSql).
    const stillMissedWith = (calledBackClause) => async () => Boolean(await db('call_log').where({ id: row.id }).modify(whereNotBlockedCall)
      .modify(recording).whereNull('voicemail_callback_alerted_at')
      .whereRaw(calledBackClause)
      .first('id'));
    const stillMissed = stillMissedWith(calledBack);
    // The post-check below retires the bell for good, so it needs proof of an
    // answered callback, not a callback that may still be ringing.
    const stillMissedFinal = stillMissedWith(calledBackSql({ retire: true }));
    const deferredOnly = deferredOnlyCheck(stillMissed, stillMissedFinal);
    let stats = null;
    try {
      stats = await triggerNotification('customer_missed_call', {
        customerId: row.customer_id || null,
        name: row.customer_id
          ? ([customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Customer')
          : `unknown caller${lineLabel ? ` (${lineLabel})` : ''}`,
        phone: row.from_phone,
        callLogId: row.id,
        at: row.created_at,
      }, {
        // Re-read right before the push (same supersession pattern as the
        // SMS bell): a recording that landed while the badge was computing
        // must not produce a contradictory missed-call push (hook P1).
        beforePush: stillMissed,
        // And right before the bell row is written: a redial answered while
        // preferences loaded must not leave a missed-call bell.
        shouldContinue: stillMissed,
        ...(pushRetry ? { pushOnly: true } : {}),
      });
    } finally {
      await finishDelivery({ row, stats, fenced, settle, pushRetry, firstPassSubs, deferredOnly });
    }
    // Post-check (hook P1): a recording that persisted between the claim
    // and here makes this call the voicemail lane's — retire the bell just
    // written. The voicemail path runs the same supersede when IT claims, so
    // both orderings converge on one alert per call.
    if (!(await stillMissedFinal().catch(() => true))) {
      const NotificationService = require('./notification-service');
      await NotificationService.supersedeMissedCallAdmin({ callLogId: row.id }).catch(() => {});
    }
    return true;
  } catch (err) {
    logger.warn(`[missed-call-bell] failed for call ${String(callSid).slice(-6)}: ${err.message}`);
    return false;
  }
}

const TERMINAL_STATUSES = ['completed', 'no-answer', 'busy', 'canceled', 'failed'];

/**
 * Durable retry (runs on the 2-minute scheduler): re-offer unanswered,
 * unsettled (unclaimed or stale-leased) customer calls from the last 24h
 * whose terminal update is ≥5 minutes old (so the voicemail recording has
 * had its chance to land). Idempotent — the
 * atomic claim inside ringMissedCallIfUnanswered makes a re-offer a no-op.
 */
async function sweepMissedCalls({ limit = 50 } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  const unknownCallers = isEnabled('missedCallUnknownCallers');
  const gaps = gapOptions();
  const calledBack = calledBackSql();
  const now = Date.now();
  await stampGapShadows(gaps, now);
  let rung = 0;
  let offered = 0;
  let cursor = null;
  // Page past permanently ineligible rows using the same eligibility rule
  // as delivery, so spam/withheld IDs cannot monopolize the oldest batch.
  while (offered < limit) {
    const rows = await db('call_log')
      .where({ direction: 'inbound' })
      .modify(whereNotBlockedCall)
      .modify((q) => {
        if (!unknownCallers) q.whereNotNull('customer_id');
        else {
          q.whereRaw("COALESCE(source, '') <> 'voice_relay_sandbox'");
          q.where(group => group.whereNotNull('customer_id').orWhere(unknown => unknown
            .where('duration_seconds', '>=', UNKNOWN_CALLER_MIN_SECONDS)
            .whereRaw("LENGTH(regexp_replace(COALESCE(from_phone, ''), '[^0-9]', '', 'g')) >= 10")
            .whereRaw("NOT (regexp_replace(COALESCE(from_phone, ''), '[^0-9]', '', 'g') = ANY(?))", [[...PHONE_SENTINELS].flatMap(value => [value, `1${value}`])])
            .whereRaw("NOT COALESCE(jsonb_path_exists(COALESCE(metadata, '{}'::jsonb), ?::jsonpath, '{}'::jsonb, true), false)",
              ['strict $.addons.results.nomorobo_spamscore ? (@.status == "successful" && (@.result.score == true || @.result.score.double() == 1))'])));
        }
      })
      .whereIn('status', TERMINAL_STATUSES)
      .modify(sweepRecordingFilter(gaps))
      .whereNull('voicemail_callback_alerted_at')
      .whereRaw("COALESCE(call_outcome, '') NOT IN ('ai_handled', 'ai_transferred')")
      .whereRaw(...unansweredClause(gaps))
      .whereRaw("COALESCE(metadata->>'missed_call_settled_at','') = ''")
      .whereRaw(calledBack)
      // Unclaimed, or a lease that went stale (crash mid-delivery) — hook P1.
      .whereRaw("(COALESCE(metadata->>'missed_call_notified_at','') = '' OR (metadata->>'missed_call_notified_at')::timestamptz < ?)", [new Date(Date.now() - LEASE_MS)])
      .where('created_at', '>', new Date(now - 24 * 60 * 60 * 1000))
      // Grace runs from the TERMINAL update, not call creation: the no-answer
      // status lands before the caller records up to 120s of voicemail and
      // the recording callback persists it (codex r6).
      .whereRaw('COALESCE(updated_at, created_at) < ?', [new Date(now - VOICEMAIL_GRACE_MS)])
      .modify(q => {
        if (cursor) q.whereRaw('(created_at, id) > (?, ?)', [cursor.sweep_created_at, cursor.id]);
      })
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      // A text cursor preserves PostgreSQL microseconds across tied dates.
      .select('*', db.raw('created_at::text AS sweep_created_at'));
    for (const r of rows) {
      if (!r.twilio_call_sid || !missedCallEligible(r, now, { unknownCallers, ...gaps })) continue;
      offered += 1;
      if (await ringMissedCallIfUnanswered(r.twilio_call_sid)) rung += 1;
      if (offered === limit) return rung;
    }
    if (rows.length < limit) break;
    cursor = rows[rows.length - 1];
  }
  return rung;
}

// How far back an open missed-call bell is still retired when the caller
// gets through later. Older bells are the office's to close by hand.
const RETIRE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Retire open missed-call bells whose caller got through AFTER the bell rang
 * (owner 2026-10-05): a later answered call, an alerted voicemail, or our
 * dialed callback — the same called-back SQL (calledBackSql) that keeps a bell from ringing.
 * Runs on the 2-minute call-alert cron; idempotent (a done bell is not
 * selected again). Never re-opens: a retired bell stays done.
 */
async function retireCalledBackMissedCalls({ limit = 100 } = {}) {
  const rows = await db('notifications')
    .join('call_log', db.raw("call_log.id::text = notifications.metadata->'payload'->>'callLogId'"))
    .where({ 'notifications.recipient_type': 'admin', 'notifications.category': 'missed_call' })
    .whereRaw("notifications.metadata->>'triggerKey' = 'customer_missed_call'")
    .whereNull('notifications.done_at')
    .where('notifications.created_at', '>', new Date(Date.now() - RETIRE_WINDOW_MS))
    .whereRaw(`NOT ${calledBackSql({ retire: true })}`)
    .distinct('call_log.id')
    .limit(limit);
  if (!rows.length) return 0;
  const NotificationService = require('./notification-service');
  let retired = 0;
  for (const { id } of rows) {
    retired += Number(await NotificationService.supersedeMissedCallAdmin({
      callLogId: id,
      resolution: 'The caller got through on a later call',
    })) || 0;
  }
  return retired;
}

module.exports = {
  retireCalledBackMissedCalls,
  missedCallEligible,
  missedCallShapeEligible,
  isEmptyVoicemailRecording,
  ringMissedCallIfUnanswered,
  sweepMissedCalls,
  outcomeUnanswered,
  calledBackSql,
  CALLED_BACK_SQL,
  UNKNOWN_CALLER_MIN_SECONDS,
  // Exported so missed-call-text-back.js shares the exact same "what counts
  // as a missed call" shape in its SQL pre-filter instead of re-deriving it.
  UNANSWERED,
  UNANSWERED_STATUSES,
  TERMINAL_STATUSES,
  VOICEMAIL_GRACE_MS,
};
