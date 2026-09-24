const { isCourtesyOnly, outboundAsksForReply } = require('./sms-intent');
const { phoneIdentityKey } = require('../utils/phone');

// Keep this list aligned with the unanswered-communications watcher. These
// are the outbound SMS types that represent a real answer to the customer;
// reminders, receipts, review asks, and other automated sends do not.
const HUMAN_REPLY_TYPES = Object.freeze([
  'manual',
  'ai_approved',
  'ai_revised',
  'ai_assistant',
  'ai_assistant_reply',
]);
const DRAFT_REPLY_TYPES = Object.freeze(['ai_approved', 'ai_revised']);

const NON_ACTIONABLE_INBOUND_TYPES = Object.freeze([
  'opt_out',
  'opt_in',
  'sms_reaction',
  'help_request',
  'reschedule_reply',
]);

function phoneIdentitySql(column) {
  const digits = `REGEXP_REPLACE(COALESCE(${column}, ''), '[^0-9]', '', 'g')`;
  return `(CASE WHEN ${digits} = '' THEN ''
    WHEN ${digits} ~ '^1[0-9]{10}$' THEN RIGHT(${digits}, 10)
    WHEN ${digits} ~ '^[0-9]{10}$' AND COALESCE(${column}, '') NOT LIKE '+%' THEN ${digits}
    ELSE '+' || ${digits} END)`;
}

function draftIdSql(metadataExpression) {
  const value = `(${metadataExpression})`;
  return `(CASE WHEN ${value} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN ${value}::uuid ELSE NULL END)`;
}

// Resolve a draft's legacy inbound anchor to the canonical message id used by
// the inbox. Missing or duplicate canonical twins fail closed so an approved
// draft cannot be credited to the wrong customer question.
function draftReplyToMessageIdSql(draftSmsLogIdExpression) {
  return `(SELECT CASE WHEN COUNT(canonical_inbound.id) = 1
    THEN MIN(canonical_inbound.id::text)::uuid ELSE NULL END
    FROM sms_log draft_inbound
    JOIN messages canonical_inbound
      ON canonical_inbound.twilio_sid = draft_inbound.twilio_sid
     AND canonical_inbound.channel = 'sms'
     AND canonical_inbound.direction = 'inbound'
    WHERE draft_inbound.id = (${draftSmsLogIdExpression})
      AND draft_inbound.direction = 'inbound')`;
}

// A signed STOP can commit its durable receipt before a delayed retry repairs
// the canonical inbox row. Readers must use that receipt for both command
// classification and chronology without rewriting history. Keep the
// canonical message_type available to authorization scopes (notably job_*);
// these expressions are only for the client-facing response projection.
function inboundSmsReceiptProjectionSql({
  messageAlias,
  legacyAlias,
  receiptAlias,
}) {
  for (const identifier of [messageAlias, legacyAlias, receiptAlias]) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(identifier || '')) throw new Error('Invalid SMS receipt projection alias');
  }
  const receiptMatch = `${receiptAlias}.message_sid IS NOT NULL
    AND ${messageAlias}.channel = 'sms'
    AND ${messageAlias}.direction = 'inbound'`;
  return {
    joinSql: `LEFT JOIN inbound_sms_optout_receipts ${receiptAlias}
      ON ${receiptAlias}.message_sid = ${messageAlias}.twilio_sid
     AND ${messageAlias}.channel = 'sms'
     AND ${messageAlias}.direction = 'inbound'`,
    responseMessageTypeSql: `(CASE WHEN ${receiptMatch} THEN 'opt_out'
      ELSE COALESCE(${legacyAlias}.message_type, ${messageAlias}.message_type) END)`,
    effectiveCreatedAtSql: `(CASE WHEN ${receiptMatch}
      THEN LEAST(${messageAlias}.created_at, ${receiptAlias}.applied_at)
      ELSE ${messageAlias}.created_at END)`,
  };
}

async function loadPriorOutboundBodies(db, messages, {
  customerScoped = false,
  fallbackCustomerPhone = null,
} = {}) {
  const contexts = (messages || []).filter((message) => (
    message.direction === 'inbound' && (message.channel == null || message.channel === 'sms')
  )).map((message) => ({
    message_id: message.id,
    inbound_at: message.created_at,
    peer_key: phoneIdentityKey(message.contact_phone || message.customer_phone || fallbackCustomerPhone),
    endpoint_key: phoneIdentityKey(message.our_endpoint_id),
    customer_id: message.customer_id || null,
  })).filter((context) => (
    context.message_id && context.inbound_at && context.peer_key && context.endpoint_key
      && (!customerScoped || context.customer_id)
  ));
  if (!contexts.length) return new Map();

  const priorPeer = phoneIdentitySql("COALESCE(NULLIF(prior_conversation.contact_phone, ''), prior_customer.phone, '')");
  const priorEndpoint = phoneIdentitySql("COALESCE(prior_conversation.our_endpoint_id, '')");
  const customerJoin = customerScoped ? 'AND canonical_threads.customer_id = inbound_context.customer_id' : '';
  const result = await db.raw(`
    WITH inbound_context AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(?::jsonb) AS input(
        message_id uuid, inbound_at timestamptz, peer_key text, endpoint_key text, customer_id uuid
      )
    ), canonical_threads AS MATERIALIZED (
      SELECT prior_conversation.id, prior_conversation.customer_id,
             ${priorPeer} AS peer_key, ${priorEndpoint} AS endpoint_key
      FROM conversations prior_conversation
      LEFT JOIN customers prior_customer ON prior_customer.id = prior_conversation.customer_id
      WHERE prior_conversation.channel = 'sms'
    ), thread_candidates AS MATERIALIZED (
      SELECT inbound_context.message_id, inbound_context.inbound_at, canonical_threads.id AS conversation_id
      FROM inbound_context
      JOIN canonical_threads
        ON canonical_threads.peer_key = inbound_context.peer_key
       AND canonical_threads.endpoint_key = inbound_context.endpoint_key
       ${customerJoin}
    ), relevant_threads AS MATERIALIZED (
      SELECT conversation_id, min(inbound_at) - interval '24 hours' AS earliest,
             max(inbound_at) AS latest
      FROM thread_candidates GROUP BY conversation_id
    ), accepted_outbound AS MATERIALIZED (
      SELECT prior.id, prior.conversation_id, prior.body,
             COALESCE(prior_legacy.created_at, prior.created_at) AS response_created_at
      FROM relevant_threads
      JOIN messages prior ON prior.conversation_id = relevant_threads.conversation_id
        AND prior.created_at > relevant_threads.earliest
      LEFT JOIN LATERAL (
        SELECT sl.message_type, sl.status, sl.created_at
        FROM sms_log sl
        WHERE sl.twilio_sid = prior.twilio_sid AND sl.direction = prior.direction
        ORDER BY sl.created_at DESC, sl.id DESC LIMIT 1
      ) prior_legacy ON true
      WHERE prior.channel = 'sms' AND prior.direction = 'outbound'
        AND COALESCE(prior_legacy.created_at, prior.created_at) < relevant_threads.latest
        AND COALESCE(prior_legacy.status, prior.delivery_status, '') IN ('queued', 'sent', 'delivered')
        AND COALESCE(prior_legacy.message_type, prior.message_type, '') <> 'internal_alert'
    )
    SELECT DISTINCT ON (thread_candidates.message_id)
           thread_candidates.message_id, accepted_outbound.body
    FROM thread_candidates
    JOIN accepted_outbound ON accepted_outbound.conversation_id = thread_candidates.conversation_id
      AND accepted_outbound.response_created_at < thread_candidates.inbound_at
      AND accepted_outbound.response_created_at > thread_candidates.inbound_at - interval '24 hours'
    ORDER BY thread_candidates.message_id, accepted_outbound.response_created_at DESC, accepted_outbound.id DESC
  `, [JSON.stringify(contexts)]);
  return new Map((result.rows || result).map((row) => [String(row.message_id), row.body]));
}

function jsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mediaItems(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Narrow client-safe flags. Raw metadata remains server-only. Historical
// rows predate the webhook's courtesyOnly stamp, so classify their body with
// the same fail-safe detector. An attachment always keeps an inbound text
// actionable even when its caption is a courtesy phrase.
function responseFlags({
  direction,
  body,
  media,
  metadata,
  legacyMetadata,
  auditMetadata,
  priorOutboundBody,
} = {}) {
  const meta = { ...jsonObject(metadata), ...jsonObject(legacyMetadata), ...jsonObject(auditMetadata) };
  const directMedia = mediaItems(media);
  const attachments = directMedia.length ? directMedia : mediaItems(meta.media);
  const inbound = direction === 'inbound';
  const hasMedia = inbound && attachments.length > 0;
  const stampedCourtesy = typeof meta.courtesyOnly === 'boolean' ? meta.courtesyOnly : null;
  const courtesyOnly = inbound && !hasMedia && (
    stampedCourtesy === true
    || (stampedCourtesy == null
      && priorOutboundBody != null
      && isCourtesyOnly(body, { awaitingAnswer: outboundAsksForReply(priorOutboundBody) }))
  );
  const spamEnforced = inbound && !hasMedia && meta.spam_verdict?.enforced === true;
  return { courtesyOnly, spamEnforced, hasMedia };
}

function inboundNeedsResponse(message) {
  const flags = responseFlags(message);
  return flags.hasMedia || (!flags.courtesyOnly && !flags.spamEnforced);
}

function outboundIsAnswer({
  direction,
  messageType,
  status,
  isClickFollowup = false,
  replyToMessageId = null,
} = {}) {
  return direction === 'outbound'
    && HUMAN_REPLY_TYPES.includes(messageType)
    && ['queued', 'sent', 'delivered'].includes(status)
    && !isClickFollowup
    && (!DRAFT_REPLY_TYPES.includes(messageType) || Boolean(replyToMessageId));
}

module.exports = {
  HUMAN_REPLY_TYPES,
  DRAFT_REPLY_TYPES,
  NON_ACTIONABLE_INBOUND_TYPES,
  phoneIdentitySql,
  draftIdSql,
  draftReplyToMessageIdSql,
  inboundSmsReceiptProjectionSql,
  loadPriorOutboundBodies,
  responseFlags,
  inboundNeedsResponse,
  outboundIsAnswer,
  _private: { jsonObject, mediaItems },
};
