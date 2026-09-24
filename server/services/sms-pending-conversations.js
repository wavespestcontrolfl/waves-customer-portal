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

// Shared source for the Messages needs-response badge, filtered inbox, and
// unanswered-text watcher. The watcher opts into legacy-only rows so a failed
// canonical write cannot erase historical work; badge IDs remain canonical.
async function loadPendingSmsConversations({
  excludePhones = [],
  customerId = null,
  includeLegacyOnly = false,
  cutoff = null,
  includeExpired = true,
  limit = null,
} = {}) {
  const projectedContactPhone = `(CASE WHEN s.source = 'canonical' THEN
    CASE WHEN s.direction = 'inbound'
      THEN COALESCE(NULLIF(legacy.from_phone, ''), s.contact_phone)
      ELSE COALESCE(NULLIF(legacy.to_phone, ''), s.contact_phone) END
    ELSE s.contact_phone END)`;
  const projectedEndpoint = `(CASE WHEN s.source = 'canonical' THEN
    CASE WHEN s.direction = 'inbound'
      THEN COALESCE(NULLIF(legacy.to_phone, ''), s.our_endpoint_id)
      ELSE COALESCE(NULLIF(legacy.from_phone, ''), s.our_endpoint_id) END
    ELSE s.our_endpoint_id END)`;
  const eventPeer = phoneIdentitySql(projectedContactPhone);
  const eventEndpoint = phoneIdentitySql(projectedEndpoint);
  const blockedPeer = phoneIdentitySql('b.number');
  const customerPeer = phoneIdentitySql('candidate_customer.phone');
  const duplicateCustomerPeer = phoneIdentitySql('duplicate_customer.phone');
  // An uncertain historical STOP must never migrate to a customer's changed
  // primary phone. Legacy/receipt events still suppress their original peer.
  const stopPeer = phoneIdentitySql("COALESCE(NULLIF(stop_receipt.phone, ''), NULLIF(stop_legacy.from_phone, ''), NULLIF(stop_message.metadata->>'sms_contact_phone', ''), NULLIF(stop_conversation.contact_phone, ''), '')");
  const legacyStopPeer = phoneIdentitySql('stop_log.from_phone');
  const receiptStopPeer = phoneIdentitySql('receipt_stop.phone');
  const draftId = draftIdSql("COALESCE(audit.metadata->>'draft_id', s.metadata_draft_id)");
  const draftReplyToMessageId = draftReplyToMessageIdSql('response_draft.sms_log_id');
  // The original communications backfill copied no source id for null-SID
  // rows. Match its exact copied event fields, accepting only one legacy
  // candidate; matching NULL SIDs alone would join unrelated messages.
  const legacyEndpoint = phoneIdentitySql("CASE WHEN sl.direction = 'inbound' THEN sl.to_phone ELSE sl.from_phone END");
  const legacyPeer = phoneIdentitySql("CASE WHEN sl.direction = 'inbound' THEN sl.from_phone ELSE sl.to_phone END");
  const { rows = [] } = await db.raw(`
    WITH canonical_sms AS MATERIALIZED (
      SELECT 'canonical'::text AS source, m.id, m.direction, m.body AS message_body,
             m.created_at, m.twilio_sid, m.message_type AS canonical_message_type,
             m.delivery_status AS canonical_delivery_status,
             m.metadata AS canonical_metadata, COALESCE(m.media, '[]'::jsonb) AS media,
             c.customer_id,
             COALESCE(NULLIF(m.metadata->>'sms_contact_phone', ''), NULLIF(c.contact_phone, ''), cu.phone, '') AS contact_phone,
             COALESCE(NULLIF(m.metadata->>'sms_our_endpoint_id', ''), c.our_endpoint_id, '') AS our_endpoint_id
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN customers cu ON cu.id = c.customer_id
      WHERE m.channel = 'sms'
        AND (CAST(:customerId AS uuid) IS NULL OR c.customer_id = CAST(:customerId AS uuid))
        AND NOT (COALESCE(c.our_endpoint_id, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(c.contact_phone, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(cu.phone, '') = ANY(CAST(:excludePhones AS text[])))
    ), canonical_legacy_links AS MATERIALIZED (
      SELECT s.id AS message_id, legacy.*
      FROM messages s
      JOIN conversations original_thread ON original_thread.id = s.conversation_id
      LEFT JOIN LATERAL (
        SELECT candidates.* FROM (
          SELECT sl.*, 1::bigint AS match_count
          FROM sms_log sl
          WHERE s.twilio_sid IS NOT NULL AND sl.twilio_sid = s.twilio_sid
            AND sl.direction = s.direction
          UNION ALL
          SELECT sl.*, count(*) OVER () AS match_count
          FROM sms_log sl
          WHERE s.twilio_sid IS NULL AND sl.twilio_sid IS NULL
              AND sl.direction = s.direction
              AND sl.created_at = s.created_at
              AND NULLIF(sl.message_body, '') IS NOT DISTINCT FROM s.body
              AND sl.customer_id IS NOT DISTINCT FROM original_thread.customer_id
              AND ${legacyEndpoint} = ${phoneIdentitySql("COALESCE(NULLIF(s.metadata->>'sms_our_endpoint_id', ''), original_thread.our_endpoint_id)")}
              AND (original_thread.customer_id IS NOT NULL
                OR ${legacyPeer} = ${phoneIdentitySql('original_thread.contact_phone')})
        ) candidates
        WHERE s.twilio_sid IS NOT NULL OR candidates.match_count = 1
        ORDER BY candidates.created_at DESC, candidates.id DESC LIMIT 1
      ) legacy ON true
      WHERE s.channel = 'sms'
    ), legacy_only_sms AS MATERIALIZED (
      SELECT 'legacy'::text AS source, sl.id, sl.direction, sl.message_body,
             sl.created_at, sl.twilio_sid, sl.message_type AS canonical_message_type,
             sl.status AS canonical_delivery_status, sl.metadata AS canonical_metadata,
             '[]'::jsonb AS media, sl.customer_id,
             CASE WHEN sl.direction = 'inbound' THEN sl.from_phone ELSE sl.to_phone END AS contact_phone,
             CASE WHEN sl.direction = 'inbound' THEN sl.to_phone ELSE sl.from_phone END AS our_endpoint_id
      FROM sms_log sl
      LEFT JOIN customers cu ON cu.id = sl.customer_id
      WHERE (CAST(:customerId AS uuid) IS NULL OR sl.customer_id = CAST(:customerId AS uuid))
        AND NOT EXISTS (
          SELECT 1 FROM messages twin
          WHERE twin.channel = 'sms' AND twin.twilio_sid = sl.twilio_sid
            AND twin.direction = sl.direction
        )
        AND NOT EXISTS (
          SELECT 1 FROM canonical_legacy_links twin
          WHERE sl.twilio_sid IS NULL AND twin.id = sl.id
        )
        AND NOT (COALESCE(sl.to_phone, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(sl.from_phone, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(cu.phone, '') = ANY(CAST(:excludePhones AS text[])))
    ), base_sms AS MATERIALIZED (
      SELECT * FROM canonical_sms
      UNION ALL
      SELECT * FROM legacy_only_sms
    ), projected_events AS MATERIALIZED (
      SELECT s.*, ${eventPeer} AS peer, ${eventEndpoint} AS endpoint,
             CASE WHEN s.source = 'legacy' THEN s.id ELSE legacy.id END AS legacy_id,
             CASE WHEN optout_receipt.message_sid IS NOT NULL THEN 'opt_out'
               ELSE COALESCE(legacy.message_type, s.canonical_message_type, '') END AS message_type,
             COALESCE(legacy.status, s.canonical_delivery_status, '') AS delivery_status,
             COALESCE(s.canonical_metadata, '{}'::jsonb)
               || COALESCE(legacy.metadata, '{}'::jsonb) AS metadata,
             COALESCE(legacy.metadata->>'draft_id',
               s.canonical_metadata->>'draft_id') AS metadata_draft_id,
             CASE WHEN s.source = 'legacy' THEN s.created_at
               ELSE COALESCE(legacy.created_at, s.created_at) END AS response_created_at
      FROM base_sms s
      LEFT JOIN canonical_legacy_links legacy
        ON s.source = 'canonical' AND legacy.message_id = s.id
      LEFT JOIN inbound_sms_optout_receipts optout_receipt
        ON s.direction = 'inbound' AND optout_receipt.message_sid = s.twilio_sid
    ), inbound_events AS MATERIALIZED (
      SELECT * FROM projected_events s
      WHERE s.direction = 'inbound'
        AND (CAST(:cutoff AS timestamptz) IS NULL OR s.created_at <= CAST(:cutoff AS timestamptz))
        AND (CAST(:includeExpired AS boolean) OR s.created_at >= now() - interval '30 days')
    ), latest_inbound AS MATERIALIZED (
      SELECT DISTINCT ON (s.peer, s.endpoint)
        s.id, s.source, s.legacy_id, s.peer, s.endpoint, s.customer_id,
        s.message_body, s.message_type, s.metadata, s.media, s.created_at, s.twilio_sid
      FROM inbound_events s
      WHERE s.peer <> '' AND s.endpoint <> ''
        AND s.message_type <> ALL(CAST(:ignoredInboundTypes AS text[]))
        AND s.message_type NOT LIKE 'job\\_%'
        AND NOT EXISTS (SELECT 1 FROM blocked_numbers b WHERE ${blockedPeer} = s.peer)
      ORDER BY s.peer, s.endpoint, s.created_at DESC, (s.source = 'canonical') DESC, s.id DESC
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
             response_draft.intent AS draft_intent,
             CASE WHEN li.source = 'legacy' THEN response_draft.sms_log_id
               WHEN li.twilio_sid IS NULL AND response_draft.sms_log_id = li.legacy_id THEN li.id
               ELSE ${draftReplyToMessageId} END AS draft_reply_to_event_id
      FROM enriched_inbound li
      JOIN projected_events s ON s.peer = li.peer AND s.endpoint = li.endpoint
        AND s.direction = 'outbound'
        AND s.created_at > li.created_at - INTERVAL '24 hours'
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
          OR os.draft_reply_to_event_id = os.inbound_id)
        AND os.draft_intent IS DISTINCT FROM 'click_followup'
    ), all_stop_events AS MATERIALIZED (
      SELECT ${stopPeer} AS peer,
             CASE WHEN stop_receipt.message_sid IS NOT NULL
               THEN LEAST(stop_message.created_at, stop_receipt.applied_at)
               ELSE stop_message.created_at END AS created_at
      FROM messages stop_message
      JOIN conversations stop_conversation ON stop_conversation.id = stop_message.conversation_id
      LEFT JOIN customers stop_customer ON stop_customer.id = stop_conversation.customer_id
      LEFT JOIN canonical_legacy_links stop_legacy ON stop_legacy.message_id = stop_message.id
      LEFT JOIN inbound_sms_optout_receipts stop_receipt
        ON stop_receipt.message_sid = stop_message.twilio_sid
      WHERE stop_message.channel = 'sms' AND stop_message.direction = 'inbound'
        AND (stop_receipt.message_sid IS NOT NULL
          OR COALESCE(stop_legacy.message_type, stop_message.message_type, '') = 'opt_out')
        AND NOT (COALESCE(stop_conversation.our_endpoint_id, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(stop_conversation.contact_phone, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(stop_customer.phone, '') = ANY(CAST(:excludePhones AS text[])))
      UNION ALL
      SELECT ${legacyStopPeer},
             CASE WHEN stop_receipt.message_sid IS NOT NULL
               THEN LEAST(stop_log.created_at, stop_receipt.applied_at)
               ELSE stop_log.created_at END
      FROM sms_log stop_log
      LEFT JOIN customers stop_log_customer ON stop_log_customer.id = stop_log.customer_id
      LEFT JOIN inbound_sms_optout_receipts stop_receipt
        ON stop_receipt.message_sid = stop_log.twilio_sid
      WHERE stop_log.direction = 'inbound'
        AND (stop_log.message_type = 'opt_out' OR stop_receipt.message_sid IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM messages stop_twin
          WHERE stop_twin.channel = 'sms' AND stop_twin.twilio_sid = stop_log.twilio_sid
            AND stop_twin.direction = stop_log.direction
        )
        AND NOT (COALESCE(stop_log.to_phone, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(stop_log.from_phone, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(stop_log_customer.phone, '') = ANY(CAST(:excludePhones AS text[])))
      UNION ALL
      SELECT ${receiptStopPeer}, receipt_stop.applied_at
      FROM inbound_sms_optout_receipts receipt_stop
      WHERE NOT (COALESCE(receipt_stop.phone, '') = ANY(CAST(:excludePhones AS text[])))
        AND NOT EXISTS (
          SELECT 1 FROM messages receipt_message
          WHERE receipt_message.channel = 'sms' AND receipt_message.direction = 'inbound'
            AND receipt_message.twilio_sid = receipt_stop.message_sid
        )
        AND NOT EXISTS (
          SELECT 1 FROM sms_log receipt_log
          WHERE receipt_log.direction = 'inbound'
            AND receipt_log.twilio_sid = receipt_stop.message_sid
        )
    ), latest_stop AS MATERIALIZED (
      SELECT peer, MAX(created_at) AS stopped_at
      FROM all_stop_events WHERE peer <> '' GROUP BY peer
    )
    SELECT li.id, li.source, li.peer, li.endpoint, li.message_body, li.created_at,
           li.enriched_metadata AS metadata, li.media,
           prior_context.message_body AS prior_outbound_body,
           customer_match.id AS customer_id,
           NULLIF(TRIM(COALESCE(customer_match.first_name, '') || ' '
             || COALESCE(customer_match.last_name, '')), '') AS customer_name
    FROM enriched_inbound li
    LEFT JOIN prior_context ON prior_context.id = li.id
    LEFT JOIN answered_inbound answered ON answered.inbound_id = li.id
    LEFT JOIN latest_stop stop ON stop.peer = li.peer
    LEFT JOIN LATERAL (
      SELECT candidate_customer.id, candidate_customer.first_name, candidate_customer.last_name
      FROM customers candidate_customer
      WHERE candidate_customer.deleted_at IS NULL
        AND ${customerPeer} = li.peer
        AND NOT EXISTS (
          SELECT 1 FROM customers duplicate_customer
          WHERE duplicate_customer.deleted_at IS NULL
            AND duplicate_customer.id <> candidate_customer.id
            AND ${duplicateCustomerPeer} = li.peer
        )
      LIMIT 1
    ) customer_match ON true
    WHERE answered.inbound_id IS NULL
      AND (stop.stopped_at IS NULL OR stop.stopped_at <= li.created_at)
      AND (CAST(:includeLegacyOnly AS boolean) OR li.source = 'canonical')
  `, {
    customerId: customerId || null,
    excludePhones,
    includeLegacyOnly,
    cutoff: cutoff || null,
    includeExpired,
    ignoredInboundTypes: NON_ACTIONABLE_INBOUND_TYPES,
    humanReplyTypes: HUMAN_REPLY_TYPES,
    draftReplyTypes: DRAFT_REPLY_TYPES,
  });

  const actionable = rows.filter((row) => inboundNeedsResponse({
    direction: 'inbound', body: row.message_body,
    priorOutboundBody: row.prior_outbound_body,
    media: row.media, metadata: row.metadata,
  })).sort((left, right) => new Date(right.created_at) - new Date(left.created_at));
  const totalCount = actionable.length;
  const capped = Number.isInteger(limit) && limit >= 0 ? actionable.slice(0, limit) : actionable;
  return capped.map((row) => ({ ...row, total_count: String(totalCount) }));
}

async function countPendingSmsConversations({
  excludePhones = [], customerId = null, includePending = false,
} = {}) {
  const actionable = await loadPendingSmsConversations({ excludePhones, customerId });
  const result = {
    conversations: new Set(actionable.map((row) => row.peer)).size,
    messages: actionable.length,
  };
  if (includePending) {
    result.pendingMessageIds = actionable
      .filter((row) => row.source === 'canonical')
      .map((row) => row.id);
  }
  return result;
}

module.exports = { loadPendingSmsConversations, countPendingSmsConversations };
