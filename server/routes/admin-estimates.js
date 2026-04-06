const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');

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

// POST /api/admin/estimates/:id/send — send via SMS and email
router.post('/:id/send', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    const viewUrl = `https://portal.wavespestcontrol.com/estimate/${estimate.token}`;
    const firstName = estimate.customer_name?.split(' ')[0] || 'there';

    // Send SMS
    if (estimate.customer_phone) {
      try {
        await TwilioService.sendSMS(estimate.customer_phone,
          `Hi ${firstName}! Your Waves Pest Control estimate is ready 🌊\n\n${viewUrl}\n\nQuestions? Reply to this text or call (941) 318-7612.`
        );
      } catch (e) { logger.error(`Estimate SMS failed: ${e.message}`); }
    }

    // Send Email via Google Workspace SMTP
    if (estimate.customer_email && process.env.GOOGLE_SMTP_PASSWORD) {
      try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          auth: {
            user: process.env.GOOGLE_SMTP_USER || 'contact@wavespestcontrol.com',
            pass: process.env.GOOGLE_SMTP_PASSWORD,
          },
        });
        await transporter.sendMail({
          from: `"Waves Pest Control" <${process.env.GOOGLE_SMTP_USER || 'contact@wavespestcontrol.com'}>`,
          to: estimate.customer_email,
          subject: 'Your Waves Pest Control Estimate is Ready',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #0ea5e9;">Waves Pest Control</h2>
              <p>Hi ${firstName},</p>
              <p>Your customized service estimate is ready for review.</p>
              ${monthlyLine ? `<p style="font-size: 18px; font-weight: bold; color: #10b981;">${monthlyLine}</p>` : ''}
              <p><a href="${viewUrl}" style="display: inline-block; padding: 14px 28px; background: #0ea5e9; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">View Your Estimate</a></p>
              <p style="color: #666; font-size: 14px;">Questions? Call us at (941) 318-7612 or reply to this email.</p>
              <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
              <p style="color: #999; font-size: 12px;">Waves Pest Control &amp; Lawn Care | Lakewood Ranch, FL</p>
            </div>
          `,
        });
      } catch (e) { logger.error(`Estimate email failed: ${e.message}`); }
    }

    await db('estimates').where({ id: estimate.id }).update({ status: 'sent', sent_at: db.fn.now() });
    res.json({ success: true });
  } catch (err) { next(err); }
});

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
        createdAt: e.created_at,
        source: e.source || 'manual',
        serviceInterest: e.service_interest,
        leadSource: e.lead_source,
        leadSourceDetail: e.lead_source_detail,
        isPriority: e.is_priority,
        description: e.service_interest || e.notes,
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

module.exports = router;
