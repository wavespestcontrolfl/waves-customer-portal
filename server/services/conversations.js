/**
 * Unified communications service — thread + message helpers for the
 * `conversations` and `messages` tables.
 *
 * Every channel (voice, sms, email, voicemail, newsletter, system_note)
 * funnels through this service. PR 1 dual-writes from the Twilio inbound
 * webhooks; PR 2 cuts the inbox read path over and backfills history.
 *
 * See docs/design/DECISIONS.md (2026-04-18 entries) for the schema rationale.
 */

const db = require('../models/db');
const logger = require('../services/logger');

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function phoneLookupKey(value) {
  const digits = phoneDigits(value);
  if (!digits) return '';
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function whereEndpoint(query, endpoint) {
  if (endpoint) return query.where('our_endpoint_id', endpoint);
  return query.whereNull('our_endpoint_id');
}

async function lockPhoneThreadKeyWith(conn, { channel, ourEndpointId, contactPhone }) {
  const key = phoneLookupKey(contactPhone);
  if (!key) return '';
  await conn.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [
    `conversation:${channel}:${ourEndpointId || ''}:${key}`,
  ]);
  return key;
}

async function findUnknownPhoneThreadWith(conn, { channel, ourEndpointId, contactPhone }) {
  const key = phoneLookupKey(contactPhone);
  if (!key) return null;

  const query = conn('conversations')
    .whereNull('customer_id')
    .where({ channel })
    .whereRaw("RIGHT(regexp_replace(COALESCE(contact_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [key]);

  whereEndpoint(query, ourEndpointId || null);
  if (typeof query.forUpdate === 'function') query.forUpdate();
  return query.first();
}

async function promoteUnknownPhoneThreadWith(conn, {
  customerId,
  channel,
  ourEndpointId,
  contactPhone,
  targetThread = null,
}) {
  if (!customerId || !contactPhone) return null;

  const unknownThread = await findUnknownPhoneThreadWith(conn, { channel, ourEndpointId, contactPhone });
  if (!unknownThread) return targetThread;

  if (targetThread) {
    await conn('messages')
      .where({ conversation_id: unknownThread.id })
      .update({ conversation_id: targetThread.id, updated_at: new Date() });

    await conn('conversations')
      .where({ id: unknownThread.id })
      .whereNull('customer_id')
      .update({
        status: 'closed',
        unknown_contact: false,
        contact_phone: null,
        contact_email: null,
        contact_label: null,
        updated_at: new Date(),
      });
    await refreshConversationStats(conn, targetThread.id);
    return targetThread;
  }

  const [promoted] = await conn('conversations')
    .where({ id: unknownThread.id })
    .whereNull('customer_id')
    .whereRaw("RIGHT(regexp_replace(COALESCE(contact_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phoneLookupKey(contactPhone)])
    .update({
      customer_id: customerId,
      unknown_contact: false,
      contact_phone: null,
      contact_email: null,
      contact_label: null,
      updated_at: new Date(),
    })
    .returning('*');

  return promoted || unknownThread;
}

/**
 * Find or create a conversation thread. Threads are unique per
 *   (customer_id, channel, our_endpoint_id) for known customers
 *   (contact_phone, channel, our_endpoint_id) for unknown contacts (phone)
 *   (contact_email, channel, our_endpoint_id) for unknown contacts (email)
 */
async function findOrCreateThreadWith(conn, {
  customerId,
  channel,
  ourEndpointId,
  contactPhone,
  contactEmail,
  contactExternalId,
  contactLabel,
}) {
  if (!channel) throw new Error('findOrCreateThread: channel is required');

  if (contactPhone) {
    await lockPhoneThreadKeyWith(conn, { channel, ourEndpointId, contactPhone });
  }

  if (customerId) {
    const existing = await conn('conversations')
      .where({ customer_id: customerId, channel, our_endpoint_id: ourEndpointId || null })
      .first();
    if (existing) {
      if (contactPhone) {
        await promoteUnknownPhoneThreadWith(conn, {
          customerId,
          channel,
          ourEndpointId,
          contactPhone,
          targetThread: existing,
        });
      }
      return existing;
    }
    if (contactPhone) {
      const promoted = await promoteUnknownPhoneThreadWith(conn, {
        customerId,
        channel,
        ourEndpointId,
        contactPhone,
      });
      if (promoted) return promoted;
    }
    const [row] = await conn('conversations').insert({
      customer_id: customerId,
      channel,
      our_endpoint_id: ourEndpointId || null,
      unknown_contact: false,
    }).returning('*');
    return row;
  }

  if (contactPhone) {
    const existing = await conn('conversations')
      .where({ contact_phone: contactPhone, channel, our_endpoint_id: ourEndpointId || null })
      .whereNull('customer_id')
      .first();
    if (existing) return existing;
    const [row] = await conn('conversations').insert({
      channel,
      our_endpoint_id: ourEndpointId || null,
      contact_phone: contactPhone,
      contact_label: contactLabel || null,
      unknown_contact: true,
    }).returning('*');
    return row;
  }

  if (contactEmail) {
    const existing = await conn('conversations')
      .where({ contact_email: contactEmail, channel, our_endpoint_id: ourEndpointId || null })
      .whereNull('customer_id')
      .first();
    if (existing) return existing;
    const [row] = await conn('conversations').insert({
      channel,
      our_endpoint_id: ourEndpointId || null,
      contact_email: contactEmail,
      contact_label: contactLabel || null,
      unknown_contact: true,
    }).returning('*');
    return row;
  }

  // External-id contact (no phone/email) — e.g. Facebook Messenger / Instagram,
  // keyed by the page-scoped address. Mirrors the email branch.
  if (contactExternalId) {
    const existing = await conn('conversations')
      .where({ contact_external_id: contactExternalId, channel, our_endpoint_id: ourEndpointId || null })
      .whereNull('customer_id')
      .first();
    if (existing) return existing;
    const [row] = await conn('conversations').insert({
      channel,
      our_endpoint_id: ourEndpointId || null,
      contact_external_id: contactExternalId,
      contact_label: contactLabel || null,
      unknown_contact: true,
    }).returning('*');
    return row;
  }

  throw new Error('findOrCreateThread: requires customerId, contactPhone, contactEmail, or contactExternalId');
}

async function findOrCreateThread(opts) {
  return db.transaction((trx) => findOrCreateThreadWith(trx, opts));
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function voiceMediaForCall(call) {
  if (!call?.recording_url) return [];
  return [{
    type: 'recording',
    url: call.recording_url,
    sid: call.recording_sid || null,
    duration_seconds: call.recording_duration_seconds || call.duration_seconds || null,
  }];
}

async function refreshConversationStats(conn, conversationId) {
  if (!conversationId) return;
  const stats = await conn('messages')
    .where({ conversation_id: conversationId })
    .select(
      conn.raw('COUNT(*)::int AS message_count'),
      conn.raw('MAX(created_at) AS last_message_at'),
      conn.raw("MAX(created_at) FILTER (WHERE direction = 'inbound') AS last_inbound_at")
    )
    .first();

  await conn('conversations')
    .where({ id: conversationId })
    .update({
      message_count: Number(stats?.message_count || 0),
      last_message_at: stats?.last_message_at || null,
      last_inbound_at: stats?.last_inbound_at || null,
      updated_at: new Date(),
    });
}

async function syncVoiceMessageForCall(callSid, extraPatch = {}) {
  if (!callSid) return null;

  try {
    const call = await db('call_log').where('twilio_call_sid', callSid).first();
    if (!call) return null;

    const media = voiceMediaForCall(call);
    const duration = call.duration_seconds || call.recording_duration_seconds || null;
    const patch = {
      body: call.transcription || null,
      recording_sid: call.recording_sid || null,
      duration_seconds: duration,
      answered_by: call.answered_by || null,
      delivery_status: call.status || null,
      ...extraPatch,
      updated_at: new Date(),
    };
    if (media.length && !patch.media) patch.media = JSON.stringify(media);

    const direction = call.direction || 'inbound';
    const ourEndpointId = direction === 'outbound' ? call.from_phone : call.to_phone;
    const contactPhone = direction === 'outbound' ? call.to_phone : call.from_phone;
    const createdAt = call.created_at || new Date();

    return await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`message:voice:${call.twilio_call_sid}`]);

      const existing = await trx('messages')
        .where({ channel: 'voice', twilio_sid: call.twilio_call_sid })
        .first();
      if (existing) {
        let sourceConversationId = null;
        let targetConversationId = null;

        if (call.customer_id) {
          const targetThread = await findOrCreateThreadWith(trx, {
            customerId: call.customer_id,
            channel: 'voice',
            ourEndpointId: ourEndpointId || null,
          });

          if (targetThread && targetThread.id !== existing.conversation_id) {
            patch.conversation_id = targetThread.id;
            sourceConversationId = existing.conversation_id;
            targetConversationId = targetThread.id;
          }
        }

        const [updated] = await trx('messages')
          .where({ id: existing.id })
          .update(patch)
          .returning('*');
        if (sourceConversationId && targetConversationId) {
          await refreshConversationStats(trx, sourceConversationId);
          await refreshConversationStats(trx, targetConversationId);
        }
        return updated || existing;
      }

      const thread = await findOrCreateThreadWith(trx, {
        customerId: call.customer_id || null,
        channel: 'voice',
        ourEndpointId: ourEndpointId || null,
        contactPhone: call.customer_id ? null : contactPhone,
      });
      if (!thread) return null;

      const messageRow = {
        conversation_id: thread.id,
        channel: 'voice',
        direction,
        body: call.transcription || null,
        media: JSON.stringify(media),
        author_type: direction === 'outbound' ? 'admin' : 'customer',
        twilio_sid: call.twilio_call_sid,
        recording_sid: call.recording_sid || null,
        duration_seconds: duration,
        answered_by: call.answered_by || null,
        delivery_status: call.status || null,
        metadata: JSON.stringify({
          ...parseMetadata(call.metadata),
          source: 'voice_message_sync',
        }),
        created_at: createdAt,
        updated_at: new Date(),
      };
      for (const [key, value] of Object.entries(patch)) {
        if (key !== 'conversation_id' && value !== undefined) messageRow[key] = value;
      }

      const [message] = await trx('messages').insert(messageRow).returning('*');

      const updates = {
        last_message_at: createdAt,
        message_count: trx.raw('message_count + 1'),
        updated_at: new Date(),
      };
      if (direction === 'inbound') updates.last_inbound_at = createdAt;
      await trx('conversations').where({ id: thread.id }).update(updates);

      return message;
    });
  } catch (err) {
    logger.error(`[conversations] syncVoiceMessageForCall failed for ${callSid}: ${err.message}`);
    return null;
  }
}

/**
 * Append a message to a thread. Updates last_message_at, last_inbound_at
 * (when applicable), and the message_count counter.
 */
async function appendMessage(opts) {
  if (!opts.conversationId) throw new Error('appendMessage: conversationId required');
  if (!opts.channel) throw new Error('appendMessage: channel required');
  if (!opts.direction) throw new Error('appendMessage: direction required');
  if (!opts.authorType) throw new Error('appendMessage: authorType required');

  const createdAt = opts.createdAt || new Date();
  const row = {
    conversation_id: opts.conversationId,
    channel: opts.channel,
    direction: opts.direction,
    body: opts.body || null,
    subject: opts.subject || null,
    media: opts.media ? JSON.stringify(opts.media) : '[]',
    author_type: opts.authorType,
    admin_user_id: opts.adminUserId || null,
    agent_name: opts.agentName || null,
    twilio_sid: opts.twilioSid || null,
    recording_sid: opts.recordingSid || null,
    duration_seconds: opts.durationSeconds || null,
    answered_by: opts.answeredBy || null,
    delivery_status: opts.deliveryStatus || null,
    template_id: opts.templateId || null,
    coach_session_id: opts.coachSessionId || null,
    message_type: opts.messageType || null,
    ai_summary: opts.aiSummary || null,
    is_read: opts.isRead === true,
    read_at: opts.isRead === true ? (opts.readAt || new Date()) : null,
    read_by_admin_user_id: opts.readByAdminUserId || null,
    metadata: opts.metadata ? JSON.stringify(opts.metadata) : '{}',
    created_at: createdAt,
    updated_at: new Date(),
  };

  const appendWith = async (conn) => {
    const [msg] = await conn('messages').insert(row).returning('*');

    const update = {
      last_message_at: createdAt,
      message_count: conn.raw('message_count + 1'),
      updated_at: createdAt,
    };
    if (opts.direction === 'inbound') update.last_inbound_at = createdAt;

    await conn('conversations').where({ id: opts.conversationId }).update(update);
    return msg;
  };

  if (!opts.twilioSid) return appendWith(db);

  return await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`message:${opts.channel}:${opts.twilioSid}`]);

    const existing = await trx('messages')
      .where({ channel: opts.channel, twilio_sid: opts.twilioSid })
      .first();
    if (!existing) return appendWith(trx);

    const patch = { updated_at: new Date() };
    if (opts.body) patch.body = opts.body;
    if (opts.subject) patch.subject = opts.subject;
    if (opts.media) {
      const media = Array.isArray(opts.media) ? opts.media : [];
      if (media.length) patch.media = JSON.stringify(media);
    }
    if (opts.recordingSid) patch.recording_sid = opts.recordingSid;
    if (opts.durationSeconds) patch.duration_seconds = opts.durationSeconds;
    if (opts.answeredBy) patch.answered_by = opts.answeredBy;
    if (opts.deliveryStatus) patch.delivery_status = opts.deliveryStatus;
    if (opts.templateId) patch.template_id = opts.templateId;
    if (opts.coachSessionId) patch.coach_session_id = opts.coachSessionId;
    if (opts.messageType) patch.message_type = opts.messageType;
    if (opts.aiSummary) patch.ai_summary = opts.aiSummary;
    if (opts.isRead === true) {
      patch.is_read = true;
      patch.read_at = opts.readAt || new Date();
      patch.read_by_admin_user_id = opts.readByAdminUserId || null;
    }
    if (opts.metadata) patch.metadata = JSON.stringify(opts.metadata);

    const [updated] = await trx('messages')
      .where({ id: existing.id })
      .update(patch)
      .returning('*');
    return updated || existing;
  });
}

/**
 * Convenience: find-or-create thread + append message in one call. The
 * webhook dual-writes use this; it never throws past the caller — DB
 * errors are logged and swallowed so a bug here cannot break inbound
 * delivery (Virginia's lifeline).
 */
async function recordTouchpoint(opts) {
  try {
    const thread = await findOrCreateThread({
      customerId: opts.customerId,
      channel: opts.channel,
      ourEndpointId: opts.ourEndpointId,
      contactPhone: opts.contactPhone,
      contactEmail: opts.contactEmail,
      contactExternalId: opts.contactExternalId,
      contactLabel: opts.contactLabel,
    });
    const message = await appendMessage({
      ...opts,
      conversationId: thread.id,
    });
    return { thread, message };
  } catch (err) {
    logger.error(`[conversations] recordTouchpoint failed: ${err.message}`, { stack: err.stack });
    return null;
  }
}

/**
 * Update the message row matching a Twilio SID. Used when recording or
 * transcription callbacks arrive after the initial message was logged.
 */
async function updateByTwilioSid(twilioSid, patch) {
  if (!twilioSid) return null;
  try {
    const updated = await db('messages').where({ twilio_sid: twilioSid }).update(patch).returning('*');
    return updated[0] || null;
  } catch (err) {
    logger.error(`[conversations] updateByTwilioSid failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  findOrCreateThread,
  appendMessage,
  recordTouchpoint,
  updateByTwilioSid,
  syncVoiceMessageForCall,
};
