/**
 * SMS Voice-Corpus Miner — Loop 1 of the SMS brand-voice initiative (Phase A).
 *
 * Nightly, mines two sources into voice_corpus_examples — REDACTED exemplars
 * of the Waves house voice that the Loop 2 distiller will read:
 *
 *   1. sms_human_reply — outbound sms_log rows with message_type='manual'
 *      (Virginia/Adam's real replies, sent through the comms UI), each paired
 *      with the most recent inbound customer message it answered. Intent
 *      comes from classifyCustomerSmsTriageIntent — the same classes the
 *      shadow judge and the graduation ladder key on.
 *
 *   2. call_transcript — inbound call_log rows whose transcription carries
 *      diarized Agent:/Caller: speaker labels (the high-quality
 *      re-transcription output of call-recording-processor). Consent gate is
 *      IDENTICAL to customer-insights-miner: strict
 *      call_recording_consent_disclaimer_played === true, degrade CLOSED
 *      when the column is missing.
 *
 * Reader, not ingestor — never mutates source tables. All stored text is
 * redacted via agent-decision-training redactText ([name]/[phone]/[email]/
 * [address]/[url]) before insert; raw bodies never land in the corpus.
 * Suppressed senders are excluded entirely, mirroring the insights miner.
 *
 * Outcome enrichment (not exclusion): each SMS pair records whether the
 * customer replied within 7 days, opted out, or raised a complaint — the
 * distiller weights by outcome rather than the miner deciding what
 * "good" means.
 *
 * Idempotent: UNIQUE (source, source_id) + onConflict().ignore() lets the
 * nightly run use an overlapping lookback window with no watermark state.
 *
 * PII: never log message bodies, transcripts, or full phone numbers.
 */
const db = require('../models/db');
const logger = require('./logger');
const { redactText } = require('./agent-decision-training');
const { classifyCustomerSmsTriageIntent } = require('./estimate-conversion-agent');

const SCHEMA_VERSION = 'voice-corpus.v1';
const PAIR_WINDOW_HOURS = 48; // max gap between inbound and the manual reply answering it
const OUTCOME_WINDOW_DAYS = 7;
const MAX_TRANSCRIPT_CHARS = 12000;

// Outbound message types that are NOT exemplars of conversational house
// voice even though a human triggered them (internal alerts, blasts).
const EXCLUDED_REPLY_BODIES_RE = /^(yes|no|ok|okay|thanks|thank you|👍)\W*$/i;

function hasAgentCallerLabels(transcript) {
  return /(^|\n)\s*(Agent|Caller)\s*:/i.test(String(transcript || ''));
}

/**
 * Pair each manual outbound reply with the latest inbound message from the
 * same customer that precedes it within PAIR_WINDOW_HOURS. Pure — takes
 * pre-sorted arrays, returns [{ reply, inbound }] with unpaired replies
 * dropped (a reply with no stimulus teaches voice but not call-and-response,
 * and the distiller needs pairs).
 */
function pairRepliesWithInbound(replies = [], inbounds = [], { windowHours = PAIR_WINDOW_HOURS } = {}) {
  const windowMs = windowHours * 3600 * 1000;
  const byCustomer = new Map();
  for (const m of inbounds) {
    if (!m.customer_id) continue;
    if (!byCustomer.has(m.customer_id)) byCustomer.set(m.customer_id, []);
    byCustomer.get(m.customer_id).push(m);
  }
  for (const list of byCustomer.values()) {
    list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }

  const pairs = [];
  for (const reply of replies) {
    if (!reply.customer_id || !reply.message_body) continue;
    const candidates = byCustomer.get(reply.customer_id) || [];
    const replyAt = new Date(reply.created_at).getTime();
    let match = null;
    for (const inbound of candidates) {
      const inboundAt = new Date(inbound.created_at).getTime();
      if (inboundAt >= replyAt) break;
      if (replyAt - inboundAt <= windowMs) match = inbound;
    }
    if (match) pairs.push({ reply, inbound: match });
  }
  return pairs;
}

/** Trivial acknowledgements teach nothing about the house voice. */
function isMinableReply(body) {
  const text = String(body || '').trim();
  if (text.length < 12) return false;
  if (EXCLUDED_REPLY_BODIES_RE.test(text)) return false;
  return true;
}

async function hasCallConsentColumn() {
  return db.schema.hasColumn('call_log', 'call_recording_consent_disclaimer_played');
}

async function activeSuppressedPhoneSet() {
  try {
    const rows = await db('messaging_suppression').where({ active: true }).select('phone');
    return new Set(rows.map((r) => String(r.phone || '').replace(/\D/g, '').slice(-10)).filter(Boolean));
  } catch (err) {
    logger.warn(`[voice-corpus] suppression read failed (${err.message}); degrading closed`);
    return null; // null = lookup unavailable → exclude all SMS (degrade closed)
  }
}

function last10(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

async function mineSmsPairs({ since, skipped }) {
  const suppressed = await activeSuppressedPhoneSet();
  if (suppressed === null) {
    skipped.suppression_lookup_unavailable = (skipped.suppression_lookup_unavailable || 0) + 1;
    return [];
  }

  const replies = await db('sms_log')
    .where('direction', 'outbound')
    .where('message_type', 'manual')
    .where('created_at', '>=', since)
    .whereNotNull('customer_id')
    .whereNotIn('status', ['failed', 'undelivered', 'scheduled'])
    .select('id', 'customer_id', 'admin_user_id', 'message_body', 'to_phone', 'created_at')
    .orderBy('created_at', 'asc');

  if (!replies.length) return [];

  const customerIds = [...new Set(replies.map((r) => r.customer_id))];
  const lookback = new Date(new Date(since).getTime() - PAIR_WINDOW_HOURS * 3600 * 1000);
  const inbounds = await db('sms_log')
    .where('direction', 'inbound')
    .whereIn('customer_id', customerIds)
    .where('created_at', '>=', lookback)
    .whereNotIn('message_type', ['opt_out', 'opt_in', 'sms_reaction'])
    .select('id', 'customer_id', 'message_body', 'from_phone', 'created_at');

  const customers = await db('customers').whereIn('id', customerIds)
    .select('id', 'first_name', 'last_name', 'phone');
  const customerById = new Map(customers.map((c) => [c.id, c]));

  const pairs = pairRepliesWithInbound(replies, inbounds);

  // Outcome signals, batched per customer
  const followups = await db('sms_log')
    .where('direction', 'inbound')
    .whereIn('customer_id', customerIds)
    .where('created_at', '>=', since)
    .select('customer_id', 'message_type', 'created_at');
  const complaints = await db('customer_interactions')
    .whereIn('customer_id', customerIds)
    .where('interaction_type', 'complaint')
    .where('created_at', '>=', since)
    .select('customer_id', 'created_at');

  const rows = [];
  for (const { reply, inbound } of pairs) {
    const customer = customerById.get(reply.customer_id);
    if (!customer) { skipped.customer_missing = (skipped.customer_missing || 0) + 1; continue; }
    if (suppressed.has(last10(customer.phone)) || suppressed.has(last10(reply.to_phone))) {
      skipped.suppressed_sender = (skipped.suppressed_sender || 0) + 1;
      continue;
    }
    if (!isMinableReply(reply.message_body)) {
      skipped.trivial_reply = (skipped.trivial_reply || 0) + 1;
      continue;
    }

    const replyAt = new Date(reply.created_at).getTime();
    const horizon = replyAt + OUTCOME_WINDOW_DAYS * 86400 * 1000;
    const after = (list) => list.filter((x) => x.customer_id === reply.customer_id)
      .filter((x) => {
        const t = new Date(x.created_at).getTime();
        return t > replyAt && t <= horizon;
      });
    const followupsAfter = after(followups);

    const context = { customer };
    const triage = classifyCustomerSmsTriageIntent(inbound.message_body, context);

    rows.push({
      source: 'sms_human_reply',
      source_id: reply.id,
      customer_id: reply.customer_id,
      admin_user_id: reply.admin_user_id || null,
      intent: triage?.intent || null,
      inbound_text: redactText(inbound.message_body, context),
      reply_text: redactText(reply.message_body, context),
      transcript_text: null,
      outcome: JSON.stringify({
        customerReplied: followupsAfter.length > 0,
        optedOut: followupsAfter.some((m) => m.message_type === 'opt_out'),
        complaintWithin7d: after(complaints).length > 0,
      }),
      occurred_at: reply.created_at,
      schema_version: SCHEMA_VERSION,
    });
  }
  return rows;
}

async function mineCallTranscripts({ since, skipped }) {
  const consentColumnPresent = await hasCallConsentColumn();
  if (!consentColumnPresent) {
    logger.warn('[voice-corpus] call_log.call_recording_consent_disclaimer_played missing — all calls excluded');
    skipped.consent_column_missing = (skipped.consent_column_missing || 0) + 1;
    return [];
  }

  const calls = await db('call_log')
    .where('direction', 'inbound')
    .where('created_at', '>=', since)
    .whereNotNull('transcription')
    .whereNotIn('call_outcome', ['wrong_number', 'spam'])
    .select('id', 'customer_id', 'transcription', 'call_outcome', 'created_at',
      'call_recording_consent_disclaimer_played');

  const customerIds = [...new Set(calls.map((c) => c.customer_id).filter(Boolean))];
  const customers = customerIds.length
    ? await db('customers').whereIn('id', customerIds).select('id', 'first_name', 'last_name', 'phone')
    : [];
  const customerById = new Map(customers.map((c) => [c.id, c]));

  const rows = [];
  for (const call of calls) {
    if (call.call_recording_consent_disclaimer_played !== true) {
      skipped.consent_not_played = (skipped.consent_not_played || 0) + 1;
      continue;
    }
    if (!hasAgentCallerLabels(call.transcription)) {
      // Unlabeled = legacy Twilio-native transcript; speaker attribution is
      // unreliable, so it can't teach whose voice is whose. Counted so the
      // re-transcription backlog stays visible in the run summary.
      skipped.transcript_unlabeled = (skipped.transcript_unlabeled || 0) + 1;
      continue;
    }
    const context = { customer: customerById.get(call.customer_id) || null };
    rows.push({
      source: 'call_transcript',
      source_id: call.id,
      customer_id: call.customer_id || null,
      admin_user_id: null,
      intent: null,
      inbound_text: null,
      reply_text: null,
      transcript_text: redactText(String(call.transcription).slice(0, MAX_TRANSCRIPT_CHARS), context),
      outcome: JSON.stringify({ callOutcome: call.call_outcome || null }),
      occurred_at: call.created_at,
      schema_version: SCHEMA_VERSION,
    });
  }
  return rows;
}

/**
 * Nightly entry point. Overlapping lookback + insert-ignore = idempotent.
 */
async function mineVoiceCorpus({ sinceDays = 3 } = {}) {
  const startedAt = Date.now();
  const since = new Date(Date.now() - sinceDays * 86400 * 1000);
  const skipped = {};

  const smsRows = await mineSmsPairs({ since, skipped });
  const callRows = await mineCallTranscripts({ since, skipped });

  let inserted = 0;
  const all = [...smsRows, ...callRows];
  for (let i = 0; i < all.length; i += 100) {
    const chunk = all.slice(i, i + 100);
    const result = await db('voice_corpus_examples')
      .insert(chunk)
      .onConflict(['source', 'source_id'])
      .ignore()
      .returning('id');
    inserted += result.length;
  }

  const summary = {
    smsPairsFound: smsRows.length,
    callTranscriptsFound: callRows.length,
    inserted,
    skipped,
    ms: Date.now() - startedAt,
  };
  logger.info(`[voice-corpus] run complete: ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = {
  mineVoiceCorpus,
  SCHEMA_VERSION,
  _test: {
    pairRepliesWithInbound,
    isMinableReply,
    hasAgentCallerLabels,
    PAIR_WINDOW_HOURS,
  },
};
