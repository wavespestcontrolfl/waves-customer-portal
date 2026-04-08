// DEPRECATED — replaced by admin-referrals-v2.js (Clicki integration + promoter payouts)
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// Helper
const cents = (c) => (c / 100).toFixed(2);
const fmtDollars = (c) => `$${cents(c)}`;

// GET /api/admin/referrals/stats — dashboard KPIs
router.get('/stats', async (req, res, next) => {
  try {
    const [promoters, referrals, clicks, payouts, settings] = await Promise.all([
      db('referral_promoters').where({ status: 'active' }).count('* as c').first(),
      db('referrals').select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE status = 'pending') as pending"),
        db.raw("COUNT(*) FILTER (WHERE status = 'converted') as converted"),
        db.raw("SUM(CASE WHEN status = 'converted' THEN reward_amount_cents ELSE 0 END) as total_rewards"),
      ).first(),
      db('referral_clicks').count('* as c').sum('reward_amount_cents as total').first(),
      db('referral_payouts').select(
        db.raw("COUNT(*) FILTER (WHERE status = 'pending') as pending"),
        db.raw("SUM(CASE WHEN status = 'applied' THEN amount_cents ELSE 0 END) as total_paid"),
      ).first(),
      db('referral_settings'),
    ]);

    const settingsMap = {};
    settings.forEach(s => { settingsMap[s.key] = s.value; });

    res.json({
      activePromoters: parseInt(promoters.c),
      totalReferrals: parseInt(referrals.total),
      pendingReferrals: parseInt(referrals.pending),
      convertedReferrals: parseInt(referrals.converted),
      totalReferralRewards: parseInt(referrals.total_rewards || 0),
      totalClicks: parseInt(clicks.c),
      totalClickRewards: parseInt(clicks.total || 0),
      pendingPayouts: parseInt(payouts.pending),
      totalPaidOut: parseInt(payouts.total_paid || 0),
      settings: settingsMap,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/referrals/promoters — list promoters
router.get('/promoters', async (req, res, next) => {
  try {
    const { status = 'active', search, page = 1, limit = 50 } = req.query;
    let query = db('referral_promoters')
      .leftJoin('customers', 'referral_promoters.customer_id', 'customers.id')
      .select('referral_promoters.*', 'customers.waveguard_tier', 'customers.city')
      .orderBy('referral_promoters.enrolled_at', 'desc');
    if (status !== 'all') query = query.where('referral_promoters.status', status);
    if (search) {
      const s = `%${search}%`;
      query = query.where(function () {
        this.whereILike('referral_promoters.first_name', s)
          .orWhereILike('referral_promoters.last_name', s)
          .orWhereILike('referral_promoters.customer_phone', s);
      });
    }
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const promoters = await query.limit(parseInt(limit)).offset(offset);
    res.json({ promoters });
  } catch (err) { next(err); }
});

// POST /api/admin/referrals/enroll — enroll a customer as promoter
router.post('/enroll', async (req, res, next) => {
  try {
    const { customerPhone, customerEmail, firstName, lastName, customerId, campaign } = req.body;
    if (!customerPhone || !firstName) return res.status(400).json({ error: 'Phone and first name required' });

    // Check duplicate
    const existing = await db('referral_promoters').where({ customer_phone: customerPhone }).first();
    if (existing) return res.json({ promoter: existing, alreadyEnrolled: true });

    // Try Clicki enrollment if configured
    let clickiLink = null, clickiId = null;
    if (process.env.CLICKI_WEBHOOK_ADD_PROMOTER) {
      try {
        const params = new URLSearchParams({
          email: customerEmail || '',
          phone: customerPhone,
          first_name: firstName,
          last_name: lastName || '',
        });
        const r = await fetch(`${process.env.CLICKI_WEBHOOK_ADD_PROMOTER}?${params}`);
        const data = await r.json();
        clickiLink = data.referral_link || data.link || null;
        clickiId = data.promoter_id || data.id || null;
      } catch (e) { logger.error(`Clicki enrollment failed: ${e.message}`); }
    }

    // If no Clicki, generate internal referral link
    if (!clickiLink) {
      const code = firstName.toLowerCase().replace(/[^a-z]/g, '') + Math.random().toString(36).slice(2, 6);
      clickiLink = `https://portal.wavespestcontrol.com/refer/${code}`;
    }

    const [promoter] = await db('referral_promoters').insert({
      customer_phone: customerPhone,
      customer_email: customerEmail,
      first_name: firstName,
      last_name: lastName || '',
      customer_id: customerId || null,
      clicki_referral_link: clickiLink,
      clicki_promoter_id: clickiId,
      campaign: campaign || 'customer',
    }).returning('*');

    // Send enrollment SMS
    try {
      const TwilioService = require('../services/twilio');
      await TwilioService.sendSMS(customerPhone,
        `Hey ${firstName}! You're now enrolled in the Waves Referral Program. Share your link and earn $50 for every new customer: ${clickiLink}`,
        { messageType: 'referral_enrollment' }
      );
    } catch (e) { logger.error(`Enrollment SMS failed: ${e.message}`); }

    res.json({ promoter });
  } catch (err) { next(err); }
});

// GET /api/admin/referrals/queue — pending referrals
router.get('/queue', async (req, res, next) => {
  try {
    const referrals = await db('referrals')
      .leftJoin('referral_promoters', 'referrals.promoter_id', 'referral_promoters.id')
      .select('referrals.*',
        'referral_promoters.first_name as promoter_first',
        'referral_promoters.last_name as promoter_last')
      .whereIn('referrals.status', ['pending', 'contacted', 'estimated'])
      .orderBy('referrals.created_at', 'desc');
    res.json({ referrals });
  } catch (err) { next(err); }
});

// PATCH /api/admin/referrals/:id/status — update referral status
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status, adminNotes, rewardAmountCents } = req.body;
    const upd = { status, updated_at: new Date() };
    if (adminNotes) upd.admin_notes = adminNotes;
    if (status === 'converted') {
      upd.converted_at = new Date();
      const settings = await db('referral_settings').where({ key: 'reward_per_referral_cents' }).first();
      upd.reward_amount_cents = rewardAmountCents || parseInt(settings?.value || '5000');

      // Credit the promoter
      const referral = await db('referrals').where({ id: req.params.id }).first();
      if (referral?.promoter_id) {
        await db('referral_promoters').where({ id: referral.promoter_id }).increment({
          referral_balance_cents: upd.reward_amount_cents,
          total_earned_cents: upd.reward_amount_cents,
          total_referrals_converted: 1,
        });
      }
    }
    if (status === 'rejected') {
      upd.admin_notes = adminNotes || 'Rejected by admin';
    }
    await db('referrals').where({ id: req.params.id }).update(upd);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/referrals/submit — submit a referral (admin or customer)
router.post('/submit', async (req, res, next) => {
  try {
    const { promoterPhone, referralFirstName, referralLastName, referralPhone, referralEmail, referralAddress, referralNotes, source } = req.body;
    if (!referralPhone || !referralFirstName) return res.status(400).json({ error: 'Referral phone and name required' });

    const promoter = promoterPhone ? await db('referral_promoters').where({ customer_phone: promoterPhone }).first() : null;

    const [referral] = await db('referrals').insert({
      referral_first_name: referralFirstName,
      referral_last_name: referralLastName || '',
      referral_phone: referralPhone,
      referral_email: referralEmail,
      referral_address: referralAddress,
      referral_notes: referralNotes,
      promoter_id: promoter?.id || null,
      promoter_phone: promoterPhone,
      promoter_name: promoter ? `${promoter.first_name} ${promoter.last_name}` : null,
      source: source || 'admin',
    }).returning('*');

    // Update promoter stats
    if (promoter) {
      await db('referral_promoters').where({ id: promoter.id }).increment({ total_referrals_sent: 1 });
    }

    // Notify admin
    try {
      const TwilioService = require('../services/twilio');
      await TwilioService.sendSMS(process.env.ADAM_PHONE || '+19415993489',
        `New referral: ${referralFirstName} ${referralLastName || ''} (${referralPhone}) from ${promoter ? promoter.first_name : 'unknown'}`,
        { messageType: 'internal_alert' }
      );
    } catch { /* non-critical */ }

    res.json({ referral });
  } catch (err) { next(err); }
});

// =========================================================================
// PAYOUTS
// =========================================================================

// GET /api/admin/referrals/payouts — list payouts
router.get('/payouts', async (req, res, next) => {
  try {
    const { status } = req.query;
    let query = db('referral_payouts')
      .leftJoin('referral_promoters', 'referral_payouts.promoter_id', 'referral_promoters.id')
      .select('referral_payouts.*',
        'referral_promoters.first_name', 'referral_promoters.last_name',
        'referral_promoters.customer_phone')
      .orderBy('referral_payouts.requested_at', 'desc');
    if (status) query = query.where('referral_payouts.status', status);
    const payouts = await query;
    res.json({ payouts });
  } catch (err) { next(err); }
});

// POST /api/admin/referrals/payouts/:id/approve — approve payout
router.post('/payouts/:id/approve', async (req, res, next) => {
  try {
    const { method, adminNotes } = req.body;
    await db('referral_payouts').where({ id: req.params.id }).update({
      status: 'applied', method: method || undefined,
      admin_notes: adminNotes, processed_at: new Date(), processed_by: 'admin',
    });

    // Deduct from promoter balance
    const payout = await db('referral_payouts').where({ id: req.params.id }).first();
    if (payout) {
      await db('referral_promoters').where({ id: payout.promoter_id }).increment({
        total_paid_out_cents: payout.amount_cents,
      }).decrement({
        referral_balance_cents: Math.min(payout.amount_cents, 999999),
        click_balance_cents: 0, // handled separately if needed
      });
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// WEBHOOKS (from Clicki)
// =========================================================================

// POST /api/admin/referrals/webhook/clicki-click
router.post('/webhook/clicki-click', async (req, res) => {
  try {
    const data = req.body;
    const promoterId = data.promoter_id || data.promoterId;

    const promoter = promoterId
      ? await db('referral_promoters').where({ clicki_promoter_id: String(promoterId) }).first()
      : null;

    const rewardSetting = await db('referral_settings').where({ key: 'reward_per_click_cents' }).first();
    const reward = parseInt(rewardSetting?.value || '50');

    await db('referral_clicks').insert({
      promoter_id: promoter?.id || null,
      click_ip: data.ip || data.click_ip || null,
      click_geo: data.geo || data.city || null,
      click_source: data.referrer || data.source || null,
      raw_payload: JSON.stringify(data),
      reward_amount_cents: reward,
    });

    if (promoter) {
      await db('referral_promoters').where({ id: promoter.id }).increment({
        click_balance_cents: reward,
        total_earned_cents: reward,
        total_clicks: 1,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    logger.error(`Clicki click webhook error: ${err.message}`);
    res.json({ ok: false });
  }
});

// POST /api/admin/referrals/webhook/clicki-referral
router.post('/webhook/clicki-referral', async (req, res) => {
  try {
    const data = req.body;
    const promoterId = data.promoter_id || data.promoterId;
    const promoter = promoterId
      ? await db('referral_promoters').where({ clicki_promoter_id: String(promoterId) }).first()
      : null;

    await db('referrals').insert({
      referral_first_name: data.first_name || data.name || 'Unknown',
      referral_last_name: data.last_name || '',
      referral_phone: data.phone || '',
      referral_email: data.email || '',
      referral_notes: data.notes || data.message || '',
      promoter_id: promoter?.id || null,
      promoter_phone: promoter?.customer_phone || null,
      promoter_name: promoter ? `${promoter.first_name} ${promoter.last_name}` : null,
      source: 'clicki',
      clicki_referral_id: data.referral_id || null,
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error(`Clicki referral webhook error: ${err.message}`);
    res.json({ ok: false });
  }
});

// GET /api/admin/referrals/settings
router.get('/settings', async (req, res, next) => {
  try {
    const rows = await db('referral_settings');
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json({ settings });
  } catch (err) { next(err); }
});

// PUT /api/admin/referrals/settings
router.put('/settings', async (req, res, next) => {
  try {
    const { settings } = req.body;
    for (const [key, value] of Object.entries(settings || {})) {
      await db('referral_settings').where({ key }).update({ value: String(value), updated_at: new Date() });
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
