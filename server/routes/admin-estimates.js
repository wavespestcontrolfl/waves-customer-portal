const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const smsTemplatesRouter = require('./admin-sms-templates');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');

async function renderTemplate(templateKey, vars, fallback) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars);
      if (body) return body;
    }
  } catch { /* fall through */ }
  return fallback;
}

router.use(adminAuthenticate, requireTechOrAdmin);

// POST /api/admin/estimates — create estimate
router.post('/', async (req, res, next) => {
  try {
    const { customerId, estimateData, address, customerName, customerPhone, customerEmail, monthlyTotal, annualTotal, onetimeTotal, waveguardTier, notes, satelliteUrl } = req.body;

    const shortId = crypto.randomBytes(4).toString('hex');
    const nameSlug = (customerName || 'customer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const token = `${nameSlug}-${shortId}`;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const [estimate] = await db('estimates').insert({
      customer_id: customerId || null,
      created_by_technician_id: req.technicianId,
      estimate_data: estimateData ? JSON.stringify(estimateData) : null,
      address, customer_name: customerName, customer_phone: customerPhone, customer_email: customerEmail,
      monthly_total: monthlyTotal, annual_total: annualTotal, onetime_total: onetimeTotal,
      waveguard_tier: waveguardTier, token, expires_at: expiresAt, notes, satellite_url: satelliteUrl,
    }).returning('*');

    res.status(201).json({ id: estimate.id, token, viewUrl: `https://portal.wavespestcontrol.com/estimate/${token}` });
  } catch (err) { next(err); }
});

// POST /api/admin/estimates/:id/send — send via SMS and/or email (immediate or scheduled)
router.post('/:id/send', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    const sendMethod = req.body?.sendMethod || 'both';
    const scheduledAt = req.body?.scheduledAt || null;

    if (scheduledAt) {
      const scheduledTime = new Date(scheduledAt);
      if (isNaN(scheduledTime.getTime())) {
        return res.status(400).json({ error: 'Invalid scheduledAt' });
      }
      if (scheduledTime <= new Date()) {
        return res.status(400).json({ error: 'scheduledAt must be in the future' });
      }
      await db('estimates').where({ id: estimate.id }).update({
        status: 'scheduled',
        scheduled_at: scheduledTime,
        send_method: sendMethod,
      });
      return res.json({ success: true, scheduled: true, scheduledAt: scheduledTime.toISOString() });
    }

    // Send immediately
    const channels = await sendEstimateNow(estimate, sendMethod);
    res.json({ success: true, channels });
  } catch (err) { next(err); }
});

// Shared send logic — used by both immediate send and scheduled cron
async function sendEstimateNow(estimate, sendMethod) {
  const viewUrl = `https://portal.wavespestcontrol.com/estimate/${estimate.token}`;
  const firstName = estimate.customer_name?.split(' ')[0] || 'there';
  const monthlyTotal = parseFloat(estimate.monthly_total || 0);
  const annualTotal = parseFloat(estimate.annual_total || 0);
  const priceLine = monthlyTotal > 0 ? `$${monthlyTotal.toFixed(0)}/mo · $${annualTotal.toLocaleString()}/yr` : '';

  const channels = {};

  // Send SMS
  if (sendMethod === 'sms' || sendMethod === 'both') {
    if (!estimate.customer_phone) {
      channels.sms = { ok: false, error: 'No phone on file' };
    } else {
      const digits = String(estimate.customer_phone).replace(/\D/g, '');
      const normalized = digits.length === 11 && digits.startsWith('1') ? `+${digits}`
        : digits.length === 10 ? `+1${digits}`
        : null;
      if (!normalized) {
        channels.sms = { ok: false, error: `Invalid phone format: ${estimate.customer_phone}` };
      } else {
        try {
          const fallback = `Hello ${firstName}! Your Waves estimate is ready: ${viewUrl}\n\nQuestions or requests? Reply to this message. Thank you for considering Waves!`;
          const smsBody = await renderTemplate('estimate_sent', { first_name: firstName, estimate_url: viewUrl }, fallback);
          const result = await TwilioService.sendSMS(normalized, smsBody);
          if (result && result.success === false) {
            channels.sms = { ok: false, error: result.error || 'Twilio send failed' };
            logger.error(`Estimate SMS failed: ${result.error || 'unknown'}`);
          } else {
            channels.sms = { ok: true };
          }
        } catch (e) {
          logger.error(`Estimate SMS failed: ${e.message}`);
          channels.sms = { ok: false, error: e.message };
        }
      }
    }
  }

  // Send Email via Google Workspace SMTP
  if (sendMethod === 'email' || sendMethod === 'both') {
    if (!estimate.customer_email) {
      channels.email = { ok: false, error: 'No email on file' };
    } else if (!process.env.GOOGLE_SMTP_PASSWORD) {
      channels.email = { ok: false, error: 'Email not configured (GOOGLE_SMTP_PASSWORD missing)' };
    } else {
      try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          auth: {
            user: 'contact@wavespestcontrol.com',
            pass: process.env.GOOGLE_SMTP_PASSWORD,
          },
        });
        await transporter.sendMail({
          from: '"Waves Pest Control, LLC" <contact@wavespestcontrol.com>',
          to: estimate.customer_email,
          subject: 'Your Waves Pest Control Estimate is Ready',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #0ea5e9;">Waves Pest Control, LLC</h2>
              <p>Hi ${firstName},</p>
              <p>Your customized service estimate is ready for review.</p>
              ${priceLine ? `<p style="font-size: 18px; font-weight: bold; color: #10b981;">${priceLine}</p>` : ''}
              <p><a href="${viewUrl}" style="display: inline-block; padding: 14px 28px; background: #0ea5e9; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">View Your Estimate</a></p>
              <p style="color: #666; font-size: 14px;">Questions? Call us at (941) 318-7612 or reply to this email.</p>
              <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
              <p style="color: #999; font-size: 12px;">Waves Pest Control, LLC | Lakewood Ranch, FL</p>
              <p style="color: #999; font-size: 11px;">contact@wavespestcontrol.com</p>
            </div>
          `,
        });
        channels.email = { ok: true };
      } catch (e) {
        logger.error(`Estimate email failed: ${e.message}`);
        channels.email = { ok: false, error: e.message };
      }
    }
  }

  await db('estimates').where({ id: estimate.id }).update({ status: 'sent', sent_at: db.fn.now(), scheduled_at: null, send_method: null });
  return channels;
}

// Export for cron usage
router.sendEstimateNow = sendEstimateNow;

// GET /api/admin/estimates — list
router.get('/', async (req, res, next) => {
  try {
    const { status, search, source, page = 1, limit = 50 } = req.query;
    let query = db('estimates')
      .leftJoin('technicians', 'estimates.created_by_technician_id', 'technicians.id')
      .select('estimates.*', 'technicians.name as created_by_name')
      .orderBy('estimates.created_at', 'desc');

    if (status) query = query.where('estimates.status', status);
    if (source) {
      const sources = source.split(',');
      query = query.whereIn('estimates.source', sources);
    }
    if (search) {
      const s = `%${search}%`;
      query = query.where(function () {
        this.whereILike('customer_name', s).orWhereILike('customer_phone', s).orWhereILike('address', s);
      });
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const estimates = await query.limit(parseInt(limit)).offset(offset);

    res.json({
      estimates: estimates.map(e => ({
        id: e.id, status: e.status, customerName: e.customer_name,
        customerPhone: e.customer_phone, address: e.address,
        monthlyTotal: parseFloat(e.monthly_total || 0),
        tier: e.waveguard_tier, createdBy: e.created_by_name,
        sentAt: e.sent_at, viewedAt: e.viewed_at, acceptedAt: e.accepted_at,
        declinedAt: e.declined_at,
        createdAt: e.created_at,
        source: e.source || 'manual',
        serviceInterest: e.service_interest,
        leadSource: e.lead_source,
        leadSourceDetail: e.lead_source_detail,
        isPriority: e.is_priority,
        description: e.service_interest || e.notes,
        notes: e.notes,
        followUpCount: e.follow_up_count || 0,
        lastFollowUpAt: e.last_follow_up_at,
        declineReason: e.decline_reason,
        token: e.token,
      })),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/estimates/:id/follow-up — manually send a follow-up SMS
router.post('/:id/follow-up', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (!estimate.customer_phone) return res.status(400).json({ error: 'No phone on file' });
    if (estimate.status === 'accepted') return res.status(400).json({ error: 'Already accepted' });

    const viewUrl = `https://portal.wavespestcontrol.com/estimate/${estimate.token}`;
    const firstName = estimate.customer_name?.split(' ')[0] || 'there';

    const msg = req.body.message || (
      `Hey ${firstName}! Just following up on your Waves Pest Control estimate 🌊\n\n` +
      `You can review it anytime here: ${viewUrl}\n\n` +
      `We'd love to help protect your home. Reply here or call (941) 318-7612 with any questions!`
    );

    await TwilioService.sendSMS(estimate.customer_phone, msg);
    await db('estimates').where({ id: estimate.id }).update({
      follow_up_count: db.raw('COALESCE(follow_up_count, 0) + 1'),
      last_follow_up_at: db.fn.now(),
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// PATCH /api/admin/estimates/:id — update priority, decline reason, status
router.patch('/:id', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    const updates = {};
    if (req.body.isPriority !== undefined) updates.is_priority = req.body.isPriority;
    if (req.body.declineReason !== undefined) updates.decline_reason = req.body.declineReason;
    if (req.body.status !== undefined) {
      updates.status = req.body.status;
      if (req.body.status === 'declined') updates.declined_at = db.fn.now();
    }

    if (Object.keys(updates).length === 0) return res.json({ success: true });

    await db('estimates').where({ id: req.params.id }).update(updates);
    logger.info(`[estimates] Updated estimate ${req.params.id}: ${JSON.stringify(updates)}`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/admin/estimates/:id — delete an estimate
router.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await db('estimates').where({ id: req.params.id }).del();
    if (!deleted) return res.status(404).json({ error: 'Estimate not found' });
    logger.info(`[estimates] Deleted estimate ${req.params.id}`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/estimates/cleanup-demo — remove seed/demo estimates
router.post('/cleanup-demo', async (req, res, next) => {
  try {
    const demoNames = ['James Kowalski', 'Karen White', 'Robert Niles', 'Linda Chen', 'Tom Perez', 'Susan Park', 'Dave Richardson', 'Maria Santos'];
    let deleted = 0;
    for (const name of demoNames) {
      const count = await db('estimates').where('customer_name', name).del();
      deleted += count;
    }
    logger.info(`[estimates] Cleaned up ${deleted} demo estimates`);
    res.json({ success: true, deleted });
  } catch (err) { next(err); }
});

module.exports = router;
