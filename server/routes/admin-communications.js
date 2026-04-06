const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { resolveLocation } = require('../config/locations');

router.use(adminAuthenticate, requireTechOrAdmin);

// POST /api/admin/communications/sms — send an SMS from admin
router.post('/sms', async (req, res, next) => {
  try {
    const { to, body, customerId, messageType, fromNumber } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'to and body required' });

    const result = await TwilioService.sendSMS(to, body, {
      customerId, messageType: messageType || 'manual', adminUserId: req.technicianId,
      fromNumber: fromNumber || undefined,
    });

    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/communications/call — initiate an outbound call via Twilio
router.post('/call', async (req, res, next) => {
  try {
    const { to, fromNumber } = req.body;
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

    // Step 1: Call the admin first. When admin picks up and presses 1, dial the customer.
    const call = await client.calls.create({
      to: adminPhone,
      from,
      url: `https://${domain}/api/webhooks/twilio/outbound-admin-prompt?customerNumber=${encodeURIComponent(to)}&callerIdNumber=${encodeURIComponent(from)}`,
      statusCallback: `https://${domain}/api/webhooks/twilio/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });

    // Log the outbound call
    const customer = await db('customers').where({ phone: to }).first().catch(() => null);
    await db('call_log').insert({
      customer_id: customer?.id || null,
      direction: 'outbound',
      from_phone: from,
      to_phone: to,
      twilio_call_sid: call.sid,
      status: 'initiated',
    }).catch(() => {});

    res.json({ success: true, callSid: call.sid });
  } catch (err) { next(err); }
});

// GET /api/admin/communications/log — SMS history
router.get('/log', async (req, res, next) => {
  try {
    const { customerId, direction, messageType, page = 1, limit = 50 } = req.query;

    let query = db('sms_log')
      .leftJoin('customers', 'sms_log.customer_id', 'customers.id')
      .select('sms_log.*', 'customers.first_name', 'customers.last_name')
      .orderBy('sms_log.created_at', 'desc');

    if (customerId) query = query.where('sms_log.customer_id', customerId);
    if (direction) query = query.where('sms_log.direction', direction);
    if (messageType) query = query.where('sms_log.message_type', messageType);

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const messages = await query.limit(parseInt(limit)).offset(offset);

    // Resolve customer names for messages without customer_id (match by phone)
    const resolved = [];
    for (const m of messages) {
      let customerName = m.first_name ? `${m.first_name} ${m.last_name || ''}`.trim() : null;

      // If no customer match, try phone lookup
      if (!customerName && !m.customer_id) {
        const phone = m.direction === 'inbound' ? m.from_phone : m.to_phone;
        if (phone) {
          const cust = await db('customers').where({ phone }).first();
          if (cust) {
            customerName = `${cust.first_name} ${cust.last_name || ''}`.trim();
            // Backfill customer_id for future lookups
            await db('sms_log').where({ id: m.id }).update({ customer_id: cust.id }).catch(() => {});
          }
        }
      }

      resolved.push({
        id: m.id, direction: m.direction, from: m.from_phone, to: m.to_phone,
        body: m.message_body, status: m.status, messageType: m.message_type,
        customerId: m.customer_id, customerName,
        createdAt: m.created_at,
      });
    }

    res.json({ messages: resolved });
  } catch (err) { next(err); }
});

// GET /api/admin/communications/stats — channel analytics
router.get('/stats', async (req, res, next) => {
  try {
    const som = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

    // Total sent/received this month (ALL types including manual)
    const [sentTotal] = await db('sms_log').where('direction', 'outbound').where('created_at', '>=', som).count('* as count');
    const [receivedTotal] = await db('sms_log').where('direction', 'inbound').where('created_at', '>=', som).count('* as count');

    const stats = await db('sms_log')
      .where('direction', 'outbound')
      .where('created_at', '>=', som)
      .select('message_type')
      .count('* as sent')
      .groupBy('message_type')
      .orderBy('sent', 'desc');

    // Per-location counts
    const locationStats = await Promise.all(
      Object.entries(TWILIO_NUMBERS.locations).map(async ([locId, loc]) => {
        const sent = await db('sms_log').where({ from_phone: loc.number, direction: 'outbound' }).where('created_at', '>=', som).count('* as count').first();
        const received = await db('sms_log').where({ to_phone: loc.number, direction: 'inbound' }).where('created_at', '>=', som).count('* as count').first();
        return { locationId: locId, ...loc, sent: parseInt(sent?.count || 0), received: parseInt(received?.count || 0) };
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
      model: 'claude-sonnet-4-20250514',
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

// POST /api/admin/communications/schedule-sms — schedule SMS for later
router.post('/schedule-sms', async (req, res, next) => {
  try {
    const { to, from, body, scheduledFor } = req.body;
    if (!to || !body || !scheduledFor) return res.status(400).json({ error: 'to, body, scheduledFor required' });

    const sendAt = new Date(scheduledFor);
    if (sendAt <= new Date()) return res.status(400).json({ error: 'scheduledFor must be in the future' });

    // Find customer by phone
    const customer = await db('customers').where({ phone: to }).first();

    await db('sms_log').insert({
      customer_id: customer?.id || null,
      direction: 'outbound',
      from_phone: from || '+19413187612',
      to_phone: to,
      message_body: body,
      status: 'scheduled',
      message_type: 'scheduled',
      scheduled_for: sendAt,
    });

    res.json({ success: true, scheduledFor: sendAt.toISOString() });
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

module.exports = router;
