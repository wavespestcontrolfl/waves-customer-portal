/**
 * SMS Voice-Corpus Miner — Loop 1 of the SMS brand-voice initiative (Phase A).
 *
 * Nightly, mines three sources into voice_corpus_examples — REDACTED exemplars
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
 *   3. email_human_reply — operator-reviewed outbound email IDs paired with
 *      the authenticated customer email each reply answered. Gmail SENT is
 *      never authorship evidence by itself: a versioned system_settings
 *      selection and a strict release gate are both required.
 *
 * Reader, not ingestor — never mutates source tables. All stored text is
 * double-redacted before insert: agent-decision-training redactText
 * (context names + structured PII) then the content engine's pii-redactor
 * (heuristic names the customer record doesn't know — self-introductions,
 * spouses, tenants). Raw bodies never land in the corpus. Suppressed
 * senders are excluded entirely, mirroring the insights miner.
 *
 * Outcome enrichment (not exclusion): each SMS pair records whether the
 * customer replied within 7 days, opted out, or raised a complaint — the
 * distiller weights by outcome rather than the miner deciding what
 * "good" means. SMS pairs are mined on a DELAYED band (now-10d → now-7d
 * by default) so the outcome window has closed before the row freezes
 * under insert-ignore; calls mine from the recent band.
 *
 * Idempotent: UNIQUE (source, source_id) + onConflict().ignore() lets the
 * nightly run use an overlapping lookback window with no watermark state.
 *
 * PII: never log message bodies, transcripts, or full phone numbers.
 */
const db = require('../models/db');
const logger = require('./logger');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { redactText } = require('./agent-decision-training');
const { redact: redactPii } = require('./content/pii-redactor');
const { classifyCustomerSmsTriageIntent } = require('./estimate-conversion-agent');
const { redactAccessCodes } = require('./context-aggregator');
const { exemplarLooksClean } = require('./sms-shadow-drafter');
const { extractTopReplyText, htmlReplyToText } = require('./newsletter-proof');
const { normalizeAddress, domainFromAddress } = require('./email/spam-blocker');
const { hasAlignedAuth } = require('./email/inbox-hygiene');
const { gateEnvValue } = require('../config/feature-gates');
const { savepointRead } = require('../utils/savepoint-read');
const { isInternalEmailRecipient } = require('../utils/internal-email-recipients');

const SCHEMA_VERSION = 'voice-corpus.v1';
const PAIR_WINDOW_HOURS = 48; // max gap between inbound and the manual reply answering it
const OUTCOME_WINDOW_DAYS = 7;
const MAX_TRANSCRIPT_CHARS = 12000;
const MAX_EMAIL_CHARS = 4000;
const MAX_EMAIL_SELECTION = 500;
const EMAIL_LOOKBACK_DAYS = 90;
const EMAIL_SELECTION_KEY = 'email_voice_corpus_selection';
const EMAIL_SOURCE_GATE = 'GATE_VOICE_CORPUS_EMAIL_SOURCE';
const EMAIL_INTENT_CATEGORIES = new Set(['customer_request', 'scheduling', 'complaint', 'lead_inquiry']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OFFSET_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// Outbound message types that are NOT exemplars of conversational house
// voice even though a human triggered them (internal alerts, blasts).
const EXCLUDED_REPLY_BODIES_RE = /^(yes|no|ok|okay|thanks|thank you|👍)\W*$/i;

function hasAgentCallerLabels(transcript) {
  // BOTH sides required: an Agent-only or Caller-only transcript can't
  // teach whose voice is whose — customer-only text would pollute the
  // corpus with language that isn't the brand voice.
  const text = String(transcript || '');
  return /(^|\n)\s*Agent\s*:/i.test(text) && /(^|\n)\s*Caller\s*:/i.test(text);
}

/**
 * Corpus redaction = context-name pass (shared with decision fixtures)
 * THEN the content engine's generic pii-redactor pass. The second pass
 * catches names the customer record doesn't know — self-introductions
 * ("my name is Alice Jones"), spouses, tenants — via signal-word and
 * name-pair heuristics. Staff names stay (allowlisted) — that's house
 * voice attribution, not customer PII.
 */
function redactCorpusText(text, context = {}) {
  return redactPii(redactText(text, context)).text;
}

function redactEmailCorpusText(text, context = {}) {
  // The shared redactor skips names shorter than three characters and uses
  // ASCII word boundaries. Email exemplars must mask those known names too.
  let masked = String(text || '');
  for (const value of [context.customer?.first_name, context.customer?.last_name]) {
    const name = String(value || '').trim();
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    masked = masked.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu'), '[name]');
  }
  return redactAccessCodes(redactCorpusText(masked, context));
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

function labelsOf(row) {
  if (Array.isArray(row?.label_ids)) return row.label_ids;
  try { return JSON.parse(row?.label_ids || '[]'); } catch { return []; }
}

function addressesOf(value) {
  return [...new Set((String(value || '').match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
    .map(normalizeAddress))];
}

function addSkipped(skipped, reason) {
  skipped[reason] = (skipped[reason] || 0) + 1;
}

function validOffsetIso(value) {
  if (!OFFSET_ISO_RE.test(String(value || ''))) return false;
  const parts = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  const [year, month, day, hour, minute, second] = parts.slice(1).map((part) => Number(part || 0));
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1
    && calendar.getUTCDate() === day && hour <= 23 && minute <= 59 && second <= 59
    && Number.isFinite(new Date(value).getTime());
}

function parseEmailSelection(value) {
  let selection = value;
  try { if (typeof selection === 'string') selection = JSON.parse(selection); } catch { return null; }
  if (!selection || selection.version !== 1 || !UUID_RE.test(String(selection.reviewedBy || ''))
    || !validOffsetIso(selection.reviewedAt)
    || !Array.isArray(selection.replyIds) || !Array.isArray(selection.heldOutCustomerIds)
    || !Array.isArray(selection.heldOutThreadIds)
    || selection.replyIds.length > MAX_EMAIL_SELECTION
    || selection.heldOutCustomerIds.length > MAX_EMAIL_SELECTION
    || selection.heldOutThreadIds.length > MAX_EMAIL_SELECTION
    || !selection.replyIds.every((id) => UUID_RE.test(String(id || '')))
    || !selection.heldOutCustomerIds.every((id) => UUID_RE.test(String(id || '')))
    || !selection.heldOutThreadIds.every((id) => typeof id === 'string' && id.trim() && id.length <= 500)) return null;
  return {
    version: 1,
    reviewedBy: String(selection.reviewedBy).toLowerCase(),
    reviewedAt: selection.reviewedAt,
    reviewedAtMs: new Date(selection.reviewedAt).getTime(),
    replyIds: [...new Set(selection.replyIds.map((id) => String(id).toLowerCase()))],
    heldOutCustomerIds: new Set(selection.heldOutCustomerIds.map((id) => String(id).toLowerCase())),
    heldOutThreadIds: new Set(selection.heldOutThreadIds.map((id) => id.trim())),
  };
}

// Keep only the freshly authored body. newsletter-proof owns the robust
// quoted-text/HTML handling; this final narrow pass removes common signature
// tails without treating an opening "Thanks" as a signature.
function emailTopText(row) {
  const raw = String(row?.body_text || '').trim()
    ? String(row.body_text)
    : htmlReplyToText(row?.body_html);
  const lines = extractTopReplyText(raw).split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const hasBody = kept.some((item) => item.trim());
    if (hasBody && (/^\s*--\s*$/.test(line)
      || /^\s*(?:best|best regards|kind regards|regards|sincerely|thanks|thank you)[,.!]?\s*$/i.test(line)
      || /^\s*Sent from (?:my |an |the )?(?:iphone|ipad|android|mobile|phone|tablet|device)\b/i.test(line))) break;
    kept.push(line);
  }
  const text = kept.join('\n').trim();
  return text.length <= MAX_EMAIL_CHARS ? text : null;
}

function sentByMailbox(row, mailboxAddress) {
  const labels = labelsOf(row);
  return normalizeAddress(row.from_address) === mailboxAddress
    && labels.includes('SENT') && !labels.includes('DRAFT') && !labels.includes('INBOX');
}

function eligibleInbound(row, customer, mailboxAddress) {
  const labels = labelsOf(row);
  return normalizeAddress(row.from_address) === normalizeAddress(customer.email)
    && addressesOf(row.to_address).length === 1 && addressesOf(row.to_address)[0] === mailboxAddress
    && (!row.customer_id || String(row.customer_id) === String(customer.id))
    && !labels.includes('SENT') && !labels.includes('DRAFT')
    && EMAIL_INTENT_CATEGORIES.has(String(row.classification || '').toLowerCase())
    && hasAlignedAuth(row.authentication_results, domainFromAddress(row.from_address));
}

function closestInbound(reply, threadRows, customer, mailboxAddress) {
  const replyAt = new Date(reply.received_at).getTime();
  const oldest = replyAt - PAIR_WINDOW_HOURS * 3600 * 1000;
  const prior = threadRows
    .filter((row) => String(row.id) !== String(reply.id))
    .filter((row) => {
      const at = new Date(row.received_at).getTime();
      return Number.isFinite(at) && at < replyAt && at >= oldest;
    })
    .sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
  for (const row of prior) {
    if (labelsOf(row).includes('DRAFT')) continue;
    if (sentByMailbox(row, mailboxAddress)) return null;
    return eligibleInbound(row, customer, mailboxAddress) ? row : null;
  }
  return null;
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

async function mineSmsPairs({ since, until, skipped }) {
  const suppressed = await activeSuppressedPhoneSet();
  if (suppressed === null) {
    skipped.suppression_lookup_unavailable = (skipped.suppression_lookup_unavailable || 0) + 1;
    return [];
  }

  // `until` = now - OUTCOME_WINDOW_DAYS: a pair is only inserted once its
  // 7-day outcome window has CLOSED. Insert-ignore would otherwise freeze
  // immature outcomes forever (Codex P2).
  const replies = await db('sms_log')
    .where('direction', 'outbound')
    .where('message_type', 'manual')
    .where('created_at', '>=', since)
    .where('created_at', '<', until)
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
      inbound_text: redactCorpusText(inbound.message_body, context),
      reply_text: redactCorpusText(reply.message_body, context),
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

/**
 * Mine only email replies named in the operator-reviewed v1 selection.
 * `reviewedBy` is review provenance, not proof that reviewer authored the
 * reply, so corpus admin_user_id deliberately remains NULL.
 */
async function loadEmailSelection(database, untilAt, skipped) {
  const setting = await savepointRead(database, (connection) => connection('system_settings')
    .where({ key: EMAIL_SELECTION_KEY })
    .first('value'));
  if (!setting) {
    addSkipped(skipped, 'email_selection_missing');
    return null;
  }
  const selection = parseEmailSelection(setting.value);
  if (!selection || selection.reviewedAtMs > Math.min(untilAt, Date.now())) {
    addSkipped(skipped, 'email_selection_invalid');
    return null;
  }
  return selection;
}

function reviewedEmailReplies(selected, selection, mailbox, sinceAt, untilAt) {
  return selected.filter((reply) => {
    const at = new Date(reply.received_at).getTime();
    const recipients = addressesOf(reply.to_address);
    return Number.isFinite(at) && at >= sinceAt && at < untilAt && at <= selection.reviewedAtMs
      && reply.gmail_thread_id && !selection.heldOutThreadIds.has(reply.gmail_thread_id)
      && sentByMailbox(reply, mailbox) && recipients.length === 1
      && !isInternalEmailRecipient(recipients[0]);
  });
}

function grouped(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const value = key(row);
    if (!result.has(value)) result.set(value, []);
    result.get(value).push(row);
  }
  return result;
}

async function loadEmailPairingData({ database, selection, mailbox, sinceAt, untilAt }) {
  const selected = await savepointRead(database, (connection) => connection('emails')
    .whereIn('id', selection.replyIds)
    .where('received_at', '>=', new Date(sinceAt))
    .where('received_at', '<', new Date(untilAt))
    .select('id', 'gmail_thread_id', 'from_address', 'to_address', 'body_text', 'body_html',
      'label_ids', 'received_at', 'customer_id', 'classification', 'authentication_results'));
  let replies = reviewedEmailReplies(selected, selection, mailbox, sinceAt, untilAt);
  if (!replies.length) return { replies: [] };

  const threadIds = [...new Set(replies.map((reply) => reply.gmail_thread_id))];
  const seoThreads = await savepointRead(database, (connection) => connection('seo_link_prospects')
    .whereIn('outreach_thread_ref', threadIds)
    .select('outreach_thread_ref'));
  const excludedThreads = new Set(seoThreads.map((row) => row.outreach_thread_ref).filter(Boolean));
  replies = replies.filter((reply) => !excludedThreads.has(reply.gmail_thread_id));
  if (!replies.length) return { replies: [] };

  const recipientEmails = [...new Set(replies.map((reply) => addressesOf(reply.to_address)[0]))];
  const customers = await savepointRead(database, (connection) => connection('customers')
    .where({ active: true })
    .whereNull('deleted_at')
    .whereRaw('LOWER(TRIM(email)) = ANY(?)', [recipientEmails])
    .select('id', 'first_name', 'last_name', 'email'));
  const threadRows = await savepointRead(database, (connection) => connection('emails')
    .whereIn('gmail_thread_id', threadIds)
    .where('received_at', '>=', new Date(sinceAt - PAIR_WINDOW_HOURS * 3600 * 1000))
    .where('received_at', '<', new Date(untilAt))
    .select('id', 'gmail_thread_id', 'from_address', 'to_address', 'body_text', 'body_html',
      'label_ids', 'received_at', 'customer_id', 'classification', 'authentication_results'));
  return {
    replies,
    customersByEmail: grouped(customers, (customer) => normalizeAddress(customer.email)),
    rowsByThread: grouped(threadRows, (row) => row.gmail_thread_id),
  };
}

function emailCorpusRow(reply, data, selection, mailbox, skipped) {
  const matches = data.customersByEmail.get(addressesOf(reply.to_address)[0]) || [];
  if (matches.length !== 1) { addSkipped(skipped, 'email_customer_ambiguous'); return null; }
  const customer = matches[0];
  if (selection.heldOutCustomerIds.has(String(customer.id).toLowerCase())) return null;
  if (reply.customer_id && String(reply.customer_id) !== String(customer.id)) {
    addSkipped(skipped, 'email_customer_conflict');
    return null;
  }
  const inbound = closestInbound(reply, data.rowsByThread.get(reply.gmail_thread_id) || [], customer, mailbox);
  if (!inbound) { addSkipped(skipped, 'email_inbound_unavailable'); return null; }

  const rawInbound = emailTopText(inbound);
  const rawReply = emailTopText(reply);
  if (!rawInbound || !isMinableReply(rawReply)) { addSkipped(skipped, 'email_text_unusable'); return null; }
  const context = { customer };
  const inboundText = redactEmailCorpusText(rawInbound, context);
  const replyText = redactEmailCorpusText(rawReply, context);
  if (!inboundText || !isMinableReply(replyText) || !exemplarLooksClean(inboundText, replyText)) {
    addSkipped(skipped, 'email_text_rejected');
    return null;
  }
  return {
    source: 'email_human_reply',
    source_id: reply.id,
    customer_id: customer.id,
    admin_user_id: null,
    intent: classifyCustomerSmsTriageIntent(rawInbound, context)?.intent || null,
    inbound_text: inboundText,
    reply_text: replyText,
    transcript_text: null,
    outcome: JSON.stringify({
      reviewedBy: selection.reviewedBy,
      reviewedAt: selection.reviewedAt,
      gmailThreadId: reply.gmail_thread_id,
      inboundId: inbound.id,
    }),
    occurred_at: reply.received_at,
    schema_version: SCHEMA_VERSION,
  };
}

async function mineEmailPairs({
  since,
  until = new Date(),
  skipped = {},
  database = db,
  mailboxAddress = process.env.GMAIL_USER_EMAIL || 'contact@wavespestcontrol.com',
} = {}) {
  if (!gateEnvValue(EMAIL_SOURCE_GATE)) {
    addSkipped(skipped, 'email_source_gate_disabled');
    return [];
  }
  const mailbox = normalizeAddress(mailboxAddress);
  const sinceAt = new Date(since).getTime();
  const untilAt = new Date(until).getTime();
  if (!mailbox || !Number.isFinite(sinceAt) || !Number.isFinite(untilAt) || sinceAt >= untilAt) {
    addSkipped(skipped, 'email_window_invalid');
    return [];
  }
  try {
    const selection = await loadEmailSelection(database, untilAt, skipped);
    if (!selection || !selection.replyIds.length) return [];
    const data = await loadEmailPairingData({ database, selection, mailbox, sinceAt, untilAt });
    return data.replies.map((reply) => emailCorpusRow(reply, data, selection, mailbox, skipped)).filter(Boolean);
  } catch {
    addSkipped(skipped, 'email_source_unavailable');
    logger.warn('[voice-corpus] email source read failed; email exemplars skipped');
    return [];
  }
}

/**
 * Base eligibility for CALL transcripts entering the brand-voice corpus.
 * Exported (like call-research-miner's eligibleCallsQuery) so the filter set is
 * directly assertable in SQL rather than only reachable through a live run.
 */
function eligibleCallTranscriptsQuery({ since }) {
  return db('call_log')
    .where('direction', 'inbound')
    .modify((qb) => whereNotSandboxCall(qb)) // voice-agent bake-off calls never reach a corpus
    // Recency = the call happened in the window OR its recording was just
    // re-transcribed by the backfill (old calls upgraded to diarized
    // transcripts would otherwise sit forever outside the mining window).
    .where((q) => q.where('created_at', '>=', since).orWhere('retranscribed_at', '>=', since))
    .whereNotNull('transcription')
    // NULL call_outcome must stay eligible — NOT IN evaluates UNKNOWN on
    // NULL and would drop consented calls that simply haven't been
    // assigned an outcome yet (Codex P2).
    .where((q) => q.whereNull('call_outcome').orWhereNotIn('call_outcome', ['wrong_number', 'spam']))
    // The live processor marks spam/voicemail on processing_status WITHOUT
    // stamping call_outcome — those transcripts must not train the voice.
    .where((q) => q.whereNull('processing_status').orWhereNotIn('processing_status', ['spam', 'voicemail']))
    // ⭐ SELF-TRAINING LOOP CUT. relay-transcript.js writes `Agent:` / `Caller:`
    // labels, so an AI-agent call satisfies hasAgentCallerLabels and every other
    // filter here — and this corpus feeds voice-profile-distiller, whose
    // approved output is injected straight back into the agent's own system
    // prompt. Sandy would be learning to sound like Sandy. `transcription_provider
    // = 'conversation_relay'` is the discriminator the relay already stamps.
    // NULL-safe: the column post-dates most rows, and a bare whereNot would
    // evaluate UNKNOWN on NULL and silently drop every legacy human call.
    .where((q) => q.whereNull('transcription_provider').orWhereNot('transcription_provider', 'conversation_relay'))
    // …and a TRANSFERRED call's composite (Sandy PR 2A): stored under the
    // recording's provider, but it opens with the relay's "[AI segment]".
    .whereRaw("COALESCE(transcription, '') NOT LIKE '[AI segment]%'");
}

async function mineCallTranscripts({ since, skipped }) {
  const consentColumnPresent = await hasCallConsentColumn();
  if (!consentColumnPresent) {
    logger.warn('[voice-corpus] call_log.call_recording_consent_disclaimer_played missing — all calls excluded');
    skipped.consent_column_missing = (skipped.consent_column_missing || 0) + 1;
    return [];
  }

  const calls = await eligibleCallTranscriptsQuery({ since })
    .select('id', 'customer_id', 'transcription', 'call_outcome', 'created_at',
      'retranscribed_at', 'call_recording_consent_disclaimer_played');

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
      transcript_text: redactCorpusText(String(call.transcription).slice(0, MAX_TRANSCRIPT_CHARS), context),
      outcome: JSON.stringify({ callOutcome: call.call_outcome || null }),
      // Backfilled legacy calls surface as of their RE-transcription: the
      // distiller samples the newest N by occurred_at, so keeping the
      // original call date would let a full window of newer calls starve
      // every backfilled transcript out of the prompt forever (its corpus
      // row would still bump newCorpusRows and trigger runs — pure waste).
      occurred_at: call.retranscribed_at || call.created_at,
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
  const skipped = {};
  const now = Date.now();

  // SMS band is shifted back by the outcome window: pairs are mined only
  // once their 7-day outcome window has closed, so insert-ignore freezes
  // rows with MATURE outcomes. Calls have no maturing outcome — they mine
  // from the recent band.
  const smsUntil = new Date(now - OUTCOME_WINDOW_DAYS * 86400 * 1000);
  const smsSince = new Date(smsUntil.getTime() - sinceDays * 86400 * 1000);
  const callSince = new Date(now - sinceDays * 86400 * 1000);
  const emailSince = new Date(now - EMAIL_LOOKBACK_DAYS * 86400 * 1000);

  const smsRows = await mineSmsPairs({ since: smsSince, until: smsUntil, skipped });
  const callRows = await mineCallTranscripts({ since: callSince, skipped });
  const emailRows = await mineEmailPairs({ since: emailSince, until: new Date(now), skipped });

  let inserted = 0;
  const all = [...smsRows, ...callRows, ...emailRows];
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
    emailPairsFound: emailRows.length,
    inserted,
    skipped,
    ms: Date.now() - startedAt,
  };
  logger.info(`[voice-corpus] run complete: ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = {
  mineVoiceCorpus,
  mineEmailPairs,
  eligibleCallTranscriptsQuery,
  SCHEMA_VERSION,
  // Production contract shared with the re-transcription backfill: a
  // transcript only enters the corpus with BOTH speaker labels present.
  hasAgentCallerLabels,
  _test: {
    pairRepliesWithInbound,
    isMinableReply,
    hasAgentCallerLabels,
    redactCorpusText,
    PAIR_WINDOW_HOURS,
    OUTCOME_WINDOW_DAYS,
  },
};
