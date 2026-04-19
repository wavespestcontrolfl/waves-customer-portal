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

/**
 * Find or create a conversation thread. Threads are unique per
 *   (customer_id, channel, our_endpoint_id) for known customers
 *   (contact_phone, channel, our_endpoint_id) for unknown contacts (phone)
 *   (contact_email, channel, our_endpoint_id) for unknown contacts (email)
 */
async function findOrCreateThread({
  customerId,
  channel,
  ourEndpointId,
  contactPhone,
  contactEmail,
  contactLabel,
}) {
  if (!channel) throw new Error('findOrCreateThread: channel is required');

  if (customerId) {
    const existing = await db('conversations')
      .where({ customer_id: customerId, channel, our_endpoint_id: ourEndpointId || null })
      .first();
    if (existing) return existing;
    const [row] = await db('conversations').insert({
      customer_id: customerId,
      channel,
      our_endpoint_id: ourEndpointId || null,
      unknown_contact: false,
    }).returning('*');
    return row;
  }

  if (contactPhone) {
    const existing = await db('conversations')
      .where({ contact_phone: contactPhone, channel, our_endpoint_id: ourEndpointId || null })
      .whereNull('customer_id')
      .first();
    if (existing) return existing;
    const [row] = await db('conversations').insert({
      channel,
      our_endpoint_id: ourEndpointId || null,
      contact_phone: contactPhone,
      contact_label: contactLabel || null,
      unknown_contact: true,
    }).returning('*');
    return row;
  }

  if (contactEmail) {
    const existing = await db('conversations')
      .where({ contact_email: contactEmail, channel, our_endpoint_id: ourEndpointId || null })
      .whereNull('customer_id')
      .first();
    if (existing) return existing;
    const [row] = await db('conversations').insert({
      channel,
      our_endpoint_id: ourEndpointId || null,
      contact_email: contactEmail,
      contact_label: contactLabel || null,
      unknown_contact: true,
    }).returning('*');
    return row;
  }

  throw new Error('findOrCreateThread: requires customerId, contactPhone, or contactEmail');
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

  const [msg] = await db('messages').insert({
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
    metadata: opts.metadata ? JSON.stringify(opts.metadata) : '{}',
  }).returning('*');

  const now = new Date();
  const update = {
    last_message_at: now,
    message_count: db.raw('message_count + 1'),
    updated_at: now,
  };
  if (opts.direction === 'inbound') update.last_inbound_at = now;

  await db('conversations').where({ id: opts.conversationId }).update(update);

  return msg;
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
};
