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

    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

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

// POST /api/admin/estimates/:id/send — send via SMS
router.post('/:id/send', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    const viewUrl = `https://portal.wavespestcontrol.com/estimate/${estimate.token}`;

    try {
      await TwilioService.sendSMS(estimate.customer_phone,
        `🌊 Hi ${estimate.customer_name?.split(' ')[0]}! Your Waves Pest Control estimate is ready: ${viewUrl}\n\nMonthly: $${estimate.monthly_total}/mo${estimate.waveguard_tier ? ` (${estimate.waveguard_tier} WaveGuard)` : ''}. Questions? Reply to this text or call (941) 318-7612.`
      );
    } catch (e) { logger.error(`Estimate SMS failed: ${e.message}`); }

    await db('estimates').where({ id: estimate.id }).update({ status: 'sent', sent_at: db.fn.now() });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/admin/estimates — list
router.get('/', async (req, res, next) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    let query = db('estimates')
      .leftJoin('technicians', 'estimates.created_by_technician_id', 'technicians.id')
      .select('estimates.*', 'technicians.name as created_by_name')
      .orderBy('estimates.created_at', 'desc');

    if (status) query = query.where('estimates.status', status);
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
      })),
    });
  } catch (err) { next(err); }
});

module.exports = router;
