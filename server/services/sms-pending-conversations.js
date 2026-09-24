const db = require('../models/db');
const {
  HUMAN_REPLY_TYPES,
  DRAFT_REPLY_TYPES,
  NON_ACTIONABLE_INBOUND_TYPES,
  inboundNeedsResponse,
  phoneIdentitySql,
  draftIdSql,
  draftReplyToMessageIdSql,
} = require('./sms-response-policy');

// Shared query for the Messages needs-response badge and filtered inbox.
async function countPendingSmsConversations({
  excludePhones = [], customerId = null, includePending = false,
} = {}) {
  const eventPeer = phoneIdentitySql('base.contact_phone');
  const eventEndpoint = phoneIdentitySql('base.our_endpoint_id');
  const blockedPeer = phoneIdentitySql('b.number');
  const stopPeer = phoneIdentitySql("COALESCE(NULLIF(stop_conversation.contact_phone, ''), stop_customer.phone, '')");
  const legacyStopPeer = phoneIdentitySql('stop_log.from_phone');
  const draftId = draftIdSql("COALESCE(audit.metadata->>'draft_id', legacy.metadata->>'draft_id', s.canonical_metadata->>'draft_id')");
  const draftReplyToMessageId = draftReplyToMessageIdSql('response_draft.sms_log_id');
  const { rows = [] } = await db.raw(`
    WITH base_sms AS MATERIALIZED (
      SELECT m.id, m.direction, m.body AS message_body, m.created_at,
             m.twilio_sid, m.message_type AS canonical_message_type,
             m.delivery_status AS canonical_delivery_status,
             m.metadata AS canonical_metadata,
             COALESCE(m.media, '[]'::jsonb) AS media,
             c.customer_id,
             COALESCE(NULLIF(c.contact_phone, ''), cu.phone, '') AS contact_phone,
             COALESCE(c.our_endpoint_id, '') AS our_endpoint_id
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN customers cu ON cu.id = c.customer_id
      WHERE m.channel = 'sms'
        AND (CAST(:customerId AS uuid) IS NULL OR c.customer_id = CAST(:customerId AS uuid))
        AND NOT (COALESCE(c.our_endpoint_id, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(c.contact_phone, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(cu.phone, '') = ANY(CAST(:excludePhones AS text[])))
    ), sms_events AS MATERIALIZED (
      SELECT base.*, ${eventPeer} AS peer, ${eventEndpoint} AS endpoint
      FROM base_sms base
    ), inbound_events AS MATERIALIZED (
      SELECT s.*,
             COALESCE(legacy.message_type, s.canonical_message_type, '') AS message_type,
             COALESCE(s.canonical_metadata, '{}'::jsonb)
               || COALESCE(legacy.metadata, '{}'::jsonb) AS metadata
      FROM sms_events s
      LEFT JOIN LATERAL (
        SELECT sl.message_type, sl.metadata
        FROM sms_log sl
        WHERE sl.twilio_sid = s.twilio_sid AND sl.direction = s.direction
        ORDER BY sl.created_at DESC, sl.id DESC LIMIT 1
      ) legacy ON true
      WHERE s.direction = 'inbound'
    ), latest_inbound AS MATERIALIZED (
      SELECT DISTINCT ON (s.peer, s.endpoint)
        s.id, s.peer, s.endpoint, s.customer_id, s.message_body,
        s.message_type, s.metadata, s.media, s.created_at, s.twilio_sid
      FROM inbound_events s
      WHERE s.peer <> '' AND s.endpoint <> ''
        AND s.message_type <> ALL(CAST(:ignoredInboundTypes AS text[]))
        AND s.message_type NOT LIKE 'job\\_%'
        AND NOT EXISTS (SELECT 1 FROM blocked_numbers b WHERE ${blockedPeer} = s.peer)
      ORDER BY s.peer, s.endpoint, s.created_at DESC, s.id DESC
    ), enriched_inbound AS MATERIALIZED (
      SELECT li.*, li.metadata || COALESCE(audit.metadata, '{}'::jsonb) AS enriched_metadata
      FROM latest_inbound li
      LEFT JOIN LATERAL (
        SELECT mal.metadata
        FROM messaging_audit_log mal
        WHERE mal.provider_message_id = li.twilio_sid AND mal.channel = 'sms'
        ORDER BY mal.created_at DESC, mal.id DESC LIMIT 1
      ) audit ON true
    ), outbound_events AS MATERIALIZED (
      SELECT s.*, li.id AS inbound_id, li.created_at AS inbound_created_at,
             COALESCE(legacy.created_at, s.created_at) AS response_created_at,
             COALESCE(legacy.message_type, s.canonical_message_type, '') AS message_type,
             COALESCE(legacy.status, s.canonical_delivery_status, '') AS delivery_status,
             response_draft.intent AS draft_intent,
             ${draftReplyToMessageId} AS draft_reply_to_message_id
      FROM enriched_inbound li
      JOIN sms_events s ON s.peer = li.peer AND s.endpoint = li.endpoint
        AND s.direction = 'outbound'
        AND s.created_at > li.created_at - INTERVAL '24 hours'
      LEFT JOIN LATERAL (
        SELECT sl.message_type, sl.status, sl.metadata, sl.created_at
        FROM sms_log sl
        WHERE sl.twilio_sid = s.twilio_sid AND sl.direction = s.direction
        ORDER BY sl.created_at DESC, sl.id DESC LIMIT 1
      ) legacy ON true
      LEFT JOIN LATERAL (
        SELECT mal.metadata
        FROM messaging_audit_log mal
        WHERE mal.provider_message_id = s.twilio_sid AND mal.channel = 'sms'
        ORDER BY mal.created_at DESC, mal.id DESC LIMIT 1
      ) audit ON true
      LEFT JOIN message_drafts response_draft ON response_draft.id = ${draftId}
    ), prior_context AS MATERIALIZED (
      SELECT DISTINCT ON (prev.inbound_id) prev.inbound_id AS id, prev.message_body
      FROM outbound_events prev
      WHERE prev.delivery_status IN ('queued', 'sent', 'delivered')
        AND prev.message_type <> 'internal_alert'
        AND prev.response_created_at < prev.inbound_created_at
        AND prev.response_created_at > prev.inbound_created_at - INTERVAL '24 hours'
      ORDER BY prev.inbound_id, prev.response_created_at DESC, prev.id DESC
    ), answered_inbound AS MATERIALIZED (
      SELECT DISTINCT os.inbound_id
      FROM outbound_events os
      WHERE os.message_type = ANY(CAST(:humanReplyTypes AS text[]))
        AND os.delivery_status IN ('queued', 'sent', 'delivered')
        AND os.response_created_at > os.inbound_created_at
        AND (os.message_type <> ALL(CAST(:draftReplyTypes AS text[]))
          OR os.draft_reply_to_message_id = os.inbound_id)
        AND os.draft_intent IS DISTINCT FROM 'click_followup'
    ), all_stop_events AS MATERIALIZED (
      SELECT ${stopPeer} AS peer, stop_message.created_at
      FROM messages stop_message
      JOIN conversations stop_conversation ON stop_conversation.id = stop_message.conversation_id
      LEFT JOIN customers stop_customer ON stop_customer.id = stop_conversation.customer_id
      LEFT JOIN LATERAL (
        SELECT sl.message_type
        FROM sms_log sl
        WHERE sl.twilio_sid = stop_message.twilio_sid AND sl.direction = stop_message.direction
        ORDER BY sl.created_at DESC, sl.id DESC LIMIT 1
      ) stop_legacy ON true
      WHERE stop_message.channel = 'sms' AND stop_message.direction = 'inbound'
        AND (stop_message.message_type = 'opt_out' OR EXISTS (
          SELECT 1 FROM sms_log stop_candidate
          WHERE stop_candidate.twilio_sid = stop_message.twilio_sid
            AND stop_candidate.direction = stop_message.direction
            AND stop_candidate.message_type = 'opt_out'
        ))
        AND COALESCE(stop_legacy.message_type, stop_message.message_type, '') = 'opt_out'
        AND NOT (COALESCE(stop_conversation.our_endpoint_id, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(stop_conversation.contact_phone, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(stop_customer.phone, '') = ANY(CAST(:excludePhones AS text[])))
      UNION ALL
      SELECT ${legacyStopPeer}, stop_log.created_at
      FROM sms_log stop_log
      LEFT JOIN customers stop_log_customer ON stop_log_customer.id = stop_log.customer_id
      WHERE stop_log.direction = 'inbound' AND stop_log.message_type = 'opt_out'
        AND NOT EXISTS (
          SELECT 1 FROM messages stop_twin
          WHERE stop_twin.twilio_sid = stop_log.twilio_sid
            AND stop_twin.direction = stop_log.direction
        )
        AND NOT (COALESCE(stop_log.to_phone, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(stop_log.from_phone, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(stop_log_customer.phone, '') = ANY(CAST(:excludePhones AS text[])))
    ), latest_stop AS MATERIALIZED (
      SELECT peer, MAX(created_at) AS stopped_at
      FROM all_stop_events WHERE peer <> '' GROUP BY peer
    )
    SELECT li.id, li.peer, li.endpoint, li.message_body, li.enriched_metadata AS metadata,
           li.media, prior_context.message_body AS prior_outbound_body
    FROM enriched_inbound li
    LEFT JOIN prior_context ON prior_context.id = li.id
    LEFT JOIN answered_inbound answered ON answered.inbound_id = li.id
    LEFT JOIN latest_stop stop ON stop.peer = li.peer
    WHERE answered.inbound_id IS NULL
      AND (stop.stopped_at IS NULL OR stop.stopped_at <= li.created_at)
  `, {
    customerId: customerId || null,
    excludePhones,
    ignoredInboundTypes: NON_ACTIONABLE_INBOUND_TYPES,
    humanReplyTypes: HUMAN_REPLY_TYPES,
    draftReplyTypes: DRAFT_REPLY_TYPES,
  });

  const actionable = rows.filter((row) => inboundNeedsResponse({
    direction: 'inbound', body: row.message_body,
    priorOutboundBody: row.prior_outbound_body,
    media: row.media, metadata: row.metadata,
  }));
  const result = {
    conversations: new Set(actionable.map((row) => row.peer)).size,
    messages: actionable.length,
  };
  if (includePending) result.pendingMessageIds = actionable.map((row) => row.id);
  return result;
}

module.exports = { countPendingSmsConversations };
