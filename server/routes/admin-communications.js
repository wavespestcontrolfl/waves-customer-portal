const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { resolveLocation } = require('../config/locations');
const logger = require('../services/logger');
const MODELS = require('../config/models');
const { normalizePhone } = require('../utils/phone');
const { mediaFromOutboundAttachments, signMediaForClient } = require('../services/sms-media');
const { alertTwilioFailure } = require('../services/twilio-failure-alerts');
const { parseETDateTime } = require('../utils/datetime-et');
const { purposeForScheduledMessageType } = require('../services/scheduler');

router.use(adminAuthenticate, requireTechOrAdmin);

const ADMIN_PHONE_RAW = '9415993489';
const ADMIN_PHONES = [
  `+1${ADMIN_PHONE_RAW}`, `1${ADMIN_PHONE_RAW}`, ADMIN_PHONE_RAW,
  ...(process.env.ADAM_PHONE ? [process.env.ADAM_PHONE] : []),
];

function notifyTwilioFailure(payload) {
  void alertTwilioFailure(payload).catch((alertErr) => {
    logger.error(`[twilio-alerts] async notification failed: ${alertErr.message}`);
  });
}

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function maskPhone(value) {
  const digits = phoneDigits(value);
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

async function findSingleCustomerForPhone(phone) {
  const digits = phoneDigits(normalizePhone(phone) || phone);
  if (!digits) return null;

  const matches = await db('customers')
    .whereNull('deleted_at')
    .whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?", [digits])
    .orderBy('updated_at', 'desc')
    .limit(2);

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    logger.warn(`[admin-call] ${matches.length} customers share outbound phone ${maskPhone(phone)}; require selected customerId to link call_log`);
  }
  return null;
}

// POST /api/admin/communications/sms — send an SMS from admin
router.post('/sms', async (req, res, next) => {
  try {
    const { to, body, customerId, messageType, fromNumber, mediaUrls, mediaAttachments } = req.body;
    const cleanBody = typeof body === 'string' ? body.trim() : '';
    const cleanMediaUrls = Array.isArray(mediaUrls) ? mediaUrls.filter((u) => typeof u === 'string' && u.trim()) : [];
    const media = mediaFromOutboundAttachments(mediaAttachments, cleanMediaUrls);
    if (!to || (!cleanBody && media.length === 0)) {
      return res.status(400).json({ error: 'to and body or media required' });
    }
    if (fromNumber && !TWILIO_NUMBERS.findByNumber(fromNumber)) {
      return res.status(400).json({ error: 'fromNumber must be a Waves Twilio number' });
    }
    let trustedCustomerId;
    if (customerId) {
      const customer = await db('customers').where({ id: customerId }).first('id', 'phone');
      if (!customer) return res.status(404).json({ error: 'customerId not found' });
      const normalizedTo = normalizePhone(to);
      const normalizedCustomerPhone = normalizePhone(customer.phone);
      if (!normalizedTo || !normalizedCustomerPhone || normalizedTo !== normalizedCustomerPhone) {
        return res.status(400).json({ error: 'to must match the selected customer phone' });
      }
      trustedCustomerId = customer.id;
    }

    const result = await sendCustomerMessage({
      to,
      body: cleanBody,
      channel: 'sms',
      audience: trustedCustomerId ? 'customer' : 'lead',
      purpose: 'conversational',
      customerId: trustedCustomerId || undefined,
      identityTrustLevel: trustedCustomerId ? 'phone_matches_customer' : 'phone_provided_unverified',
      entryPoint: 'admin_communications_manual_sms',
      metadata: {
        original_message_type: messageType || 'manual',
        adminUserId: req.technicianId,
        fromNumber: fromNumber || undefined,
        mediaUrls: cleanMediaUrls.length ? cleanMediaUrls : undefined,
        media,
      },
    });
    if (result.blocked || result.sent === false) {
      return res.status(422).json({
        ...result,
        error: result.reason || result.code || 'SMS send blocked/failed',
      });
    }

    res.json(result);
  } catch (err) {
    notifyTwilioFailure({
      channel: 'sms',
      direction: 'outbound',
      phase: 'send_api',
      status: 'failed',
      errorMessage: err.message,
      from: req.body?.fromNumber,
      to: req.body?.to,
      link: '/admin/communications',
    });
    next(err);
  }
});

// POST /api/admin/communications/call — initiate an outbound call via Twilio
router.post('/call', async (req, res, next) => {
  try {
    const { to, fromNumber, customerId } = req.body;
    if (!to) return res.status(400).json({ error: 'to number required' });

    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('twilioVoice')) {
      return res.json({ success: false, error: 'Voice gate is disabled' });
    }

    const twilio = require('twilio');
    const config = require('../config');
    if (!config.twilio.accountSid || !config.twilio.authToken) {
      return res.status(500).json({ error: 'Twilio not configured' });
    }
    const client = twilio(config.twilio.accountSid, config.twilio.authToken);

    const from = fromNumber || TWILIO_NUMBERS.locations['lakewood-ranch'].number;
    const domain = process.env.SERVER_DOMAIN || 'portal.wavespestcontrol.com';

    const adminPhone = process.env.ADAM_PHONE || '+19415993489';

    // Prefer the explicit customer picked in the UI. Phone-only lookup is
    // ambiguous when spouses/contacts share a number, so auto-link only when
    // exactly one active customer owns the dialed number.
    let customer = null;
    if (customerId) {
      customer = await db('customers')
        .where({ id: customerId })
        .whereNull('deleted_at')
        .first();
      if (!customer) return res.status(404).json({ error: 'customerId not found' });
      const normalizedTo = normalizePhone(to);
      const normalizedCustomerPhone = normalizePhone(customer.phone);
      if (!normalizedTo || !normalizedCustomerPhone || normalizedTo !== normalizedCustomerPhone) {
        return res.status(400).json({ error: 'to must match the selected customer phone' });
      }
    } else {
      customer = await findSingleCustomerForPhone(to).catch((e) => {
        logger.warn(`[admin-call] customer lookup failed for ${maskPhone(to)}: ${e.message}`);
        return null;
      });
    }
    const leadName = customer
      ? `${customer.first_name || ''} ${customer.last_name || ''}`.trim()
      : '';

    // Insert call_log FIRST so outbound-admin-prompt / outbound-connect can
    // update the row reliably. Twilio typically fires those webhooks 2–5s
    // after calls.create() returns, but racing the insert is cheap to avoid.
    const [callLogRow] = await db('call_log')
      .insert({
        customer_id: customer?.id || null,
        direction: 'outbound',
        from_phone: from,
        to_phone: to,
        status: 'initiated',
        source: 'admin-click',
      })
      .returning(['id']);
    const callLogId = callLogRow?.id;

    const promptParams = new URLSearchParams({
      customerNumber: to,
      callerIdNumber: from,
    });
    if (callLogId) promptParams.set('callLogId', callLogId);
    if (leadName) promptParams.set('leadName', leadName);

    // Step 1: Call the admin first. When admin picks up and presses 1, dial the customer.
    const call = await client.calls.create({
      to: adminPhone,
      from,
      url: `https://${domain}/api/webhooks/twilio/outbound-admin-prompt?${promptParams.toString()}`,
      statusCallback: `https://${domain}/api/webhooks/twilio/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });

    // Backfill the Twilio CallSid now that we have it.
    if (callLogId) {
      await db('call_log').where({ id: callLogId }).update({
        twilio_call_sid: call.sid,
        updated_at: new Date(),
      }).catch(() => {});
    }
    require('../services/conversations').recordTouchpoint({
      customerId: customer?.id || null,
      channel: 'voice',
      ourEndpointId: from,
      contactPhone: customer ? null : to,
      direction: 'outbound',
      authorType: 'admin',
      adminUserId: req.technicianId,
      twilioSid: call.sid,
      deliveryStatus: 'initiated',
    }).catch(() => {});

    res.json({ success: true, callSid: call.sid, callLogId });
  } catch (err) {
    notifyTwilioFailure({
      channel: 'voice',
      direction: 'outbound',
      phase: 'send_api',
      status: 'failed',
      errorMessage: err.message,
      from: req.body?.fromNumber,
      to: req.body?.to,
      link: '/admin/communications',
    });
    next(err);
  }
});

// GET /api/admin/communications/log — SMS history (reads unified messages
// table since PR 2; sms_log still gets dual-written for legacy consumers).
router.get('/log', async (req, res, next) => {
  try {
    const { customerId, direction, messageType, page = 1, limit = 50, search } = req.query;

    let query = db('messages')
      .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
      .leftJoin('customers', 'conversations.customer_id', 'customers.id')
      .where('messages.channel', 'sms')
      .select(
        'messages.id', 'messages.conversation_id', 'messages.direction', 'messages.body',
        'messages.delivery_status as status', 'messages.message_type',
        'messages.created_at', 'messages.media', 'messages.is_read', 'messages.read_at',
        'conversations.customer_id', 'conversations.our_endpoint_id',
        'conversations.contact_phone',
        'customers.first_name', 'customers.last_name', 'customers.phone as customer_phone'
      )
      .orderBy('messages.created_at', 'desc');

    // Exclude internal admin phone messages from either side of the conversation.
    for (const phone of ADMIN_PHONES) {
      query = query
        .whereNot('conversations.our_endpoint_id', phone)
        .where(b => b.whereNot('conversations.contact_phone', phone)
          .orWhereNull('conversations.contact_phone'))
        .where(b => b.whereNot('customers.phone', phone)
          .orWhereNull('customers.phone'));
    }

    if (customerId) query = query.where('conversations.customer_id', customerId);
    if (direction) query = query.where('messages.direction', direction);
    if (messageType) query = query.where('messages.message_type', messageType);

    const searchTerm = typeof search === 'string' ? search.trim() : '';
    if (searchTerm) {
      const like = `%${searchTerm}%`;
      query = query.where(b => b
        .where('customers.first_name', 'ilike', like)
        .orWhere('customers.last_name', 'ilike', like)
        .orWhereRaw("(customers.first_name || ' ' || customers.last_name) ILIKE ?", [like])
        .orWhere('conversations.contact_phone', 'ilike', like)
        .orWhere('conversations.our_endpoint_id', 'ilike', like)
        .orWhere('customers.phone', 'ilike', like)
        .orWhere('messages.body', 'ilike', like)
      );
    }

    const effectiveLimit = searchTerm ? Math.max(parseInt(limit), 1000) : parseInt(limit);
    const offset = searchTerm ? 0 : (parseInt(page) - 1) * parseInt(limit);
    const rows = await query.limit(effectiveLimit).offset(offset);

    const messages = await Promise.all(rows.map(async (m) => {
      const customerName = m.first_name ? `${m.first_name} ${m.last_name || ''}`.trim() : null;
      const ours = m.our_endpoint_id;
      const contact = m.contact_phone || m.customer_phone;
      const from = m.direction === 'inbound' ? contact : ours;
      const to = m.direction === 'inbound' ? ours : contact;
      return {
        id: m.id, conversationId: m.conversation_id, direction: m.direction, from, to,
        body: m.body, status: m.status, messageType: m.message_type,
        customerId: m.customer_id, customerName,
        createdAt: m.created_at,
        isRead: !!m.is_read,
        readAt: m.read_at,
        media: await signMediaForClient(m.media),
      };
    }));

    res.json({ messages });
  } catch (err) { next(err); }
});

// POST /api/admin/communications/messages/read — mark inbound SMS as read
router.post('/messages/read', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.messageIds)
      ? req.body.messageIds.filter((id) => typeof id === 'string' && id.trim())
      : [];
    const conversationIds = Array.isArray(req.body?.conversationIds)
      ? req.body.conversationIds.filter((id) => typeof id === 'string' && id.trim())
      : [];
    const readBefore = req.body?.readBefore ? new Date(req.body.readBefore) : null;
    if (!ids.length && !conversationIds.length) {
      return res.status(400).json({ error: 'messageIds or conversationIds required' });
    }
    if (conversationIds.length && (!readBefore || Number.isNaN(readBefore.getTime()))) {
      return res.status(400).json({ error: 'readBefore required when marking a conversation read' });
    }

    const now = new Date();
    let q = db('messages')
      .where({ channel: 'sms', direction: 'inbound' })
      .andWhere(function unreadOnly() {
        this.where({ is_read: false }).orWhereNull('is_read');
      });
    q = q.andWhere(function byMessageOrConversation() {
      if (ids.length) this.whereIn('id', ids);
      if (conversationIds.length) {
        this.orWhere(function visibleConversationRows() {
          this.whereIn('conversation_id', conversationIds)
            .where('created_at', '<=', readBefore);
        });
      }
    });
    const updated = await q.update({
      is_read: true,
      read_at: now,
      read_by_admin_user_id: req.technicianId || null,
      updated_at: now,
    });

    res.json({ success: true, updated });
  } catch (err) { next(err); }
});

// GET /api/admin/communications/stats — channel analytics
router.get('/stats', async (req, res, next) => {
  try {
    const som = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

    // Read from unified messages joined to conversations so we can filter
    // out internal-admin-phone traffic on either endpoint side.
    const baseSms = () => db('messages')
      .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
      .leftJoin('customers', 'conversations.customer_id', 'customers.id')
      .where('messages.channel', 'sms')
      .where('messages.created_at', '>=', som);

    const excludeAdmin = (q) => {
      for (const phone of ADMIN_PHONES) {
        q = q.whereNot('conversations.our_endpoint_id', phone)
          .where(b => b.whereNot('conversations.contact_phone', phone).orWhereNull('conversations.contact_phone'))
          .where(b => b.whereNot('customers.phone', phone).orWhereNull('customers.phone'));
      }
      return q;
    };

    const [sentTotal] = await excludeAdmin(baseSms().where('messages.direction', 'outbound')).count('* as count');
    const [receivedTotal] = await excludeAdmin(baseSms().where('messages.direction', 'inbound')).count('* as count');

    const stats = await db('messages')
      .where('messages.channel', 'sms')
      .where('messages.direction', 'outbound')
      .where('messages.created_at', '>=', som)
      .select('message_type')
      .count('* as sent')
      .groupBy('message_type')
      .orderBy('sent', 'desc');

    // Per-Waves-number counts (channel-agnostic across sms+voice).
    const allNumbers = TWILIO_NUMBERS.allNumbers;
    const locationStats = await Promise.all(
      allNumbers.map(async (n) => {
        try {
          const sent = await db('messages')
            .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
            .where('messages.channel', 'sms')
            .where('messages.direction', 'outbound')
            .where('conversations.our_endpoint_id', n.number)
            .where('messages.created_at', '>=', som)
            .count('* as count').first();
          const received = await db('messages')
            .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
            .where('messages.channel', 'sms')
            .where('messages.direction', 'inbound')
            .where('conversations.our_endpoint_id', n.number)
            .where('messages.created_at', '>=', som)
            .count('* as count').first();
          const lastInboundRow = await db('messages')
            .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
            .where('messages.direction', 'inbound')
            .where('conversations.our_endpoint_id', n.number)
            .orderBy('messages.created_at', 'desc')
            .select('messages.created_at')
            .first();
          const inboundThisMonthRow = await db('messages')
            .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
            .where('messages.direction', 'inbound')
            .where('conversations.our_endpoint_id', n.number)
            .where('messages.created_at', '>=', som)
            .count('* as count').first();
          return {
            ...n,
            sent: parseInt(sent?.count || 0),
            received: parseInt(received?.count || 0),
            inboundThisMonth: parseInt(inboundThisMonthRow?.count || 0),
            lastInboundDate: lastInboundRow?.created_at ? new Date(lastInboundRow.created_at).toISOString() : null,
          };
        } catch { return { ...n, sent: 0, received: 0, inboundThisMonth: 0, lastInboundDate: null }; }
      })
    );

    res.json({
      totalSent: parseInt(sentTotal.count),
      totalReceived: parseInt(receivedTotal.count),
      channelStats: stats.map(s => ({ type: s.message_type, sent: parseInt(s.sent) })),
      locationStats,
      phoneNumbers: {
        locations: TWILIO_NUMBERS.locations,
        tracking: TWILIO_NUMBERS.tracking,
        otherVerticals: TWILIO_NUMBERS.otherVerticals,
        reserve: TWILIO_NUMBERS.reserve,
        tollFree: TWILIO_NUMBERS.tollFree,
      },
    });
  } catch (err) { next(err); }
});

// POST /api/admin/communications/ai-draft — generate AI reply for a customer message
router.post('/ai-draft', async (req, res, next) => {
  try {
    const { customerPhone, lastMessage } = req.body;
    if (!customerPhone) return res.status(400).json({ error: 'customerPhone required' });

    // Look up customer context
    const cleanPhone = customerPhone.replace(/\D/g, '').slice(-10);
    const customer = await db('customers').where('phone', 'like', `%${cleanPhone}`).first();

    // Get recent SMS history for context
    const recentSms = await db('sms_log')
      .where(function () {
        this.where('from_phone', 'like', `%${cleanPhone}`).orWhere('to_phone', 'like', `%${cleanPhone}`);
      })
      .orderBy('created_at', 'desc')
      .limit(5);

    const conversationContext = recentSms.reverse().map(s =>
      `${s.direction === 'inbound' ? 'Customer' : 'Waves'}: ${s.message_body}`
    ).join('\n');

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();

    const msg = await client.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `You are responding as Waves Pest Control via SMS. Write a short, friendly reply (under 160 characters).

About Waves Pest Control:
- Family-owned pest control and lawn care in Southwest Florida
- Services: pest control, lawn care, mosquito control, termite protection, rodent removal
- Locations: Lakewood Ranch, Sarasota, Parrish, Venice
- Phone: (941) 318-7612
- Tone: Professional but warm, neighborly, genuine. Use "we" and "our".
- Always helpful and solution-oriented

${customer ? `Customer: ${customer.first_name} ${customer.last_name}, ${customer.city || ''}, ${customer.waveguard_tier || ''} tier` : `Customer phone: ${customerPhone}`}

${conversationContext ? `Recent conversation:\n${conversationContext}` : ''}

${lastMessage ? `Customer's last message: "${lastMessage}"` : 'No specific message to reply to — write a friendly check-in.'}

Write ONLY the SMS reply text. Keep it under 160 characters. No quotes or labels.`,
      }],
    });

    const draft = (msg.content[0]?.text || '').trim();
    res.json({ draft });
  } catch (err) {
    logger.error(`AI draft failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/communications/ai-auto-reply-status
router.get('/ai-auto-reply-status', async (req, res) => {
  try {
    const row = await db('system_config').where({ key: 'ai_sms_auto_reply' }).first();
    res.json({ enabled: row?.value === 'true' });
  } catch { res.json({ enabled: false }); }
});

// POST /api/admin/communications/ai-auto-reply — toggle
router.post('/ai-auto-reply', async (req, res) => {
  try {
    const { enabled } = req.body;
    const value = enabled ? 'true' : 'false';
    const existing = await db('system_config').where({ key: 'ai_sms_auto_reply' }).first();
    if (existing) {
      await db('system_config').where({ key: 'ai_sms_auto_reply' }).update({ value, updated_at: new Date() });
    } else {
      await db('system_config').insert({ key: 'ai_sms_auto_reply', value });
    }
    res.json({ enabled: value === 'true' });
  } catch (err) { res.json({ enabled: false, error: err.message }); }
});

// Marketing/retention purposes require a real stored consent record per
// server/services/messaging/policy.js. This conversational-compose endpoint
// is not a marketing send path — reject any messageType whose scheduler
// mapping resolves to marketing or retention. Reusing the scheduler's
// mapper here (instead of a local regex) guarantees the route can't drift
// from the cron's classification.
const BLOCKED_SCHEDULED_PURPOSES = new Set(['marketing', 'retention']);

// POST /api/admin/communications/schedule-sms — schedule SMS for later.
// The /5min scheduled-sms cron in server/services/scheduler.js picks up rows
// where status='scheduled' AND scheduled_for <= now() and dispatches them
// through sendCustomerMessage (same path as the immediate /sms route).
router.post('/schedule-sms', async (req, res, next) => {
  try {
    const { to, body, scheduledFor, customerId, fromNumber, from, messageType } = req.body || {};
    const cleanBody = typeof body === 'string' ? body.trim() : '';
    if (!to || !cleanBody || !scheduledFor) {
      return res.status(400).json({ error: 'to, body, scheduledFor required' });
    }
    if (messageType && BLOCKED_SCHEDULED_PURPOSES.has(purposeForScheduledMessageType(messageType))) {
      return res.status(400).json({ error: 'marketing/retention sends are not allowed on this endpoint' });
    }

    // ET wall-clock parse — datetime-local strings without offset are
    // interpreted in ET, ISO strings pass through unchanged.
    const sendAt = parseETDateTime(scheduledFor);
    if (Number.isNaN(sendAt.getTime())) return res.status(400).json({ error: 'invalid scheduledFor' });
    if (sendAt <= new Date()) return res.status(400).json({ error: 'scheduledFor must be in the future' });

    const chosenFrom = fromNumber || from || TWILIO_NUMBERS.getOutboundNumber();
    if (!TWILIO_NUMBERS.findByNumber(chosenFrom)) {
      return res.status(400).json({ error: 'fromNumber must be a Waves Twilio number' });
    }

    let trustedCustomerId = null;
    if (customerId) {
      const customer = await db('customers').where({ id: customerId }).first('id', 'phone');
      if (!customer) return res.status(404).json({ error: 'customerId not found' });
      const normalizedTo = normalizePhone(to);
      const normalizedCustomerPhone = normalizePhone(customer.phone);
      if (!normalizedTo || !normalizedCustomerPhone || normalizedTo !== normalizedCustomerPhone) {
        return res.status(400).json({ error: 'to must match the selected customer phone' });
      }
      trustedCustomerId = customer.id;
    } else {
      const fallback = await db('customers').where({ phone: to }).first('id');
      if (fallback) trustedCustomerId = fallback.id;
    }

    const [row] = await db('sms_log')
      .insert({
        customer_id: trustedCustomerId,
        direction: 'outbound',
        from_phone: chosenFrom,
        to_phone: to,
        message_body: cleanBody,
        status: 'scheduled',
        message_type: messageType || 'manual',
        admin_user_id: req.technicianId || null,
        scheduled_for: sendAt,
      })
      .returning(['id', 'scheduled_for']);

    res.json({ success: true, id: row?.id, scheduledFor: sendAt.toISOString() });
  } catch (err) { next(err); }
});

// GET /api/admin/communications/scheduled — list scheduled messages
router.get('/scheduled', async (req, res, next) => {
  try {
    const scheduled = await db('sms_log')
      .where({ status: 'scheduled' })
      .leftJoin('customers', 'sms_log.customer_id', 'customers.id')
      .select('sms_log.*', 'customers.first_name', 'customers.last_name')
      .orderBy('scheduled_for', 'asc');

    res.json({
      messages: scheduled.map(m => ({
        id: m.id, to: m.to_phone, from: m.from_phone, body: m.message_body,
        customerName: m.first_name ? `${m.first_name} ${m.last_name || ''}`.trim() : null,
        scheduledFor: m.scheduled_for, createdAt: m.created_at,
      })),
    });
  } catch (err) { next(err); }
});

// DELETE /api/admin/communications/scheduled/:id — cancel scheduled message
router.delete('/scheduled/:id', async (req, res, next) => {
  try {
    await db('sms_log').where({ id: req.params.id, status: 'scheduled' }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

/* ── Blocked numbers (PR 4 inbox/block UX) ──
 * These are thin wrappers over the PR-1 `blocked_numbers` schema — the voice
 * rejection path reads from the same table, and admin-call-recordings.js owns
 * the call-disposition-as-spam flow. Surfaced here so the SMS inbox can block
 * without routing through the calls tab. */

// GET /api/admin/communications/blocked-numbers — list + set for client-side filter
router.get('/blocked-numbers', async (req, res, next) => {
  try {
    const rows = await db('blocked_numbers').orderBy('blocked_at', 'desc');
    res.json({
      numbers: rows.map(r => ({
        number: r.number,
        blockType: r.block_type,
        reason: r.reason,
        autoBlocked: !!r.auto_blocked,
        blockedAt: r.blocked_at,
      })),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/communications/blocked-numbers — add a number
// Body: { number, blockType?, reason? }
router.post('/blocked-numbers', async (req, res, next) => {
  try {
    const { number, blockType, reason } = req.body;
    if (!number) return res.status(400).json({ error: 'number required' });

    const existing = await db('blocked_numbers').where({ number }).first();
    if (existing) return res.json({ success: true, alreadyBlocked: true });

    await db('blocked_numbers').insert({
      number,
      block_type: blockType || 'hard_block',
      blocked_by: req.technicianId,
      reason: reason || null,
      auto_blocked: false,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/admin/communications/blocked-numbers/:number — unblock
router.delete('/blocked-numbers/:number', async (req, res, next) => {
  try {
    await db('blocked_numbers').where({ number: req.params.number }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
