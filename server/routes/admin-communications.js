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

    res.json({
      messages: messages.map(m => ({
        id: m.id, direction: m.direction, from: m.from_phone, to: m.to_phone,
        body: m.message_body, status: m.status, messageType: m.message_type,
        customerName: m.first_name ? `${m.first_name} ${m.last_name}` : null,
        createdAt: m.created_at,
      })),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/communications/stats — channel analytics
router.get('/stats', async (req, res, next) => {
  try {
    const som = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

    const stats = await db('sms_log')
      .where('direction', 'outbound')
      .where('created_at', '>=', som)
      .whereNot('message_type', 'manual')
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

module.exports = router;
