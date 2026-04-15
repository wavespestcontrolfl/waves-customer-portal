/**
 * Admin Referral Routes v2 — Unified referral program (no Clicki)
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const engine = require('../services/referral-engine');

router.use(adminAuthenticate, requireTechOrAdmin);

// =========================================================================
// GET /stats — program KPIs
// =========================================================================
router.get('/stats', async (req, res, next) => {
  try {
    const [promoters, referrals, payouts] = await Promise.all([
      db('referral_promoters').select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE status = 'active') as active"),
      ).first(),
      db('referrals').select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE status = 'pending' OR status = 'contacted') as pending"),
        db.raw("COUNT(*) FILTER (WHERE status = 'signed_up' OR status = 'credited') as converted"),
        db.raw("COALESCE(SUM(CASE WHEN referrer_reward_status IN ('earned','paid') THEN referrer_reward_amount ELSE 0 END), 0) as total_rewards"),
        db.raw("COALESCE(SUM(CASE WHEN status IN ('signed_up','credited') THEN converted_monthly_value ELSE 0 END), 0) as total_monthly_value"),
      ).first(),
      db('referral_payouts').select(
        db.raw("COUNT(*) FILTER (WHERE status = 'pending') as pending"),
        db.raw("COALESCE(SUM(CASE WHEN status = 'applied' THEN amount_cents ELSE 0 END), 0) as total_paid"),
      ).first(),
    ]);

    const totalRewards = parseFloat(referrals.total_rewards || 0);
    const totalMonthlyValue = parseFloat(referrals.total_monthly_value || 0);
    const roi = totalRewards > 0
      ? Math.round(((totalMonthlyValue * 12 - totalRewards) / totalRewards) * 100)
      : 0;

    res.json({
      activePromoters: parseInt(promoters.active),
      totalPromoters: parseInt(promoters.total),
      totalReferrals: parseInt(referrals.total),
      pendingReferrals: parseInt(referrals.pending),
      convertedReferrals: parseInt(referrals.converted),
      totalRewardsDollars: totalRewards,
      totalPaidOutCents: parseInt(payouts.total_paid || 0),
      pendingPayouts: parseInt(payouts.pending),
      programROI: roi,
    });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /promoters — list with search/filter
// =========================================================================
router.get('/promoters', async (req, res, next) => {
  try {
    const { status = 'active', search, page = 1, limit = 50 } = req.query;

    let query = db('referral_promoters')
      .leftJoin('customers', 'referral_promoters.customer_id', 'customers.id')
      .select(
        'referral_promoters.*',
        'customers.waveguard_tier',
        'customers.city'
      )
      .orderBy('referral_promoters.total_referrals_converted', 'desc');

    if (status !== 'all') query = query.where('referral_promoters.status', status);

    if (search) {
      const s = `%${search}%`;
      query = query.where(function () {
        this.whereILike('referral_promoters.first_name', s)
          .orWhereILike('referral_promoters.last_name', s)
          .orWhereILike('referral_promoters.customer_phone', s)
          .orWhereILike('referral_promoters.referral_code', s);
      });
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const promoters = await query.limit(parseInt(limit)).offset(offset);

    res.json({ promoters });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /enroll — enroll a customer as promoter
// =========================================================================
router.post('/enroll', async (req, res, next) => {
  try {
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId is required' });

    const result = await engine.enrollPromoter(customerId);
    res.json(result);
  } catch (err) {
    if (err.message === 'Customer not found') return res.status(404).json({ error: err.message });
    next(err);
  }
});

// =========================================================================
// GET /queue — pending referrals
// =========================================================================
router.get('/queue', async (req, res, next) => {
  try {
    const { status } = req.query;
    let query = db('referrals')
      .leftJoin('referral_promoters', 'referrals.promoter_id', 'referral_promoters.id')
      .select(
        'referrals.*',
        'referral_promoters.first_name as promoter_first',
        'referral_promoters.last_name as promoter_last',
        'referral_promoters.customer_phone as promoter_phone',
        'referral_promoters.referral_code as promoter_code'
      )
      .orderBy('referrals.created_at', 'desc');

    if (status) {
      query = query.where('referrals.status', status);
    } else {
      query = query.whereIn('referrals.status', ['pending', 'contacted', 'estimated']);
    }

    const referrals = await query;
    res.json({ referrals });
  } catch (err) { next(err); }
});

// =========================================================================
// PATCH /:id/status — update referral status
// =========================================================================
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status, adminNotes, lostReason } = req.body;
    const upd = { status, updated_at: new Date() };
    if (adminNotes) upd.admin_notes = adminNotes;
    if (status === 'rejected' || lostReason) upd.lost_reason = lostReason || 'Rejected by admin';

    await db('referrals').where({ id: req.params.id }).update(upd);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /:id/convert — convert referral
// =========================================================================
router.post('/:id/convert', async (req, res, next) => {
  try {
    const { customerId, tier, monthlyValue } = req.body;
    const result = await engine.convertReferral(req.params.id, { customerId, tier, monthlyValue });
    res.json(result);
  } catch (err) {
    if (err.message === 'Referral not found') return res.status(404).json({ error: err.message });
    next(err);
  }
});

// =========================================================================
// POST /submit — admin submits referral on behalf of customer
// =========================================================================
router.post('/submit', async (req, res, next) => {
  try {
    const { promoterId, customerId, name, phone, email, address, notes } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });

    let pid = promoterId;

    // If customerId provided instead of promoterId, find/create promoter
    if (!pid && customerId) {
      const result = await engine.enrollPromoter(customerId);
      pid = result.promoter.id;
    }

    if (!pid) return res.status(400).json({ error: 'promoterId or customerId required' });

    const referral = await engine.submitReferral(pid, { name, phone, email, address, notes, source: 'admin' });
    res.json({ referral });
  } catch (err) {
    if (err.message.includes('limit') || err.message.includes('already') || err.message.includes('Cannot') || err.message.includes('already a Waves')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// =========================================================================
// PAYOUTS
// =========================================================================

// GET /payouts
router.get('/payouts', async (req, res, next) => {
  try {
    const { status } = req.query;
    let query = db('referral_payouts')
      .leftJoin('referral_promoters', 'referral_payouts.promoter_id', 'referral_promoters.id')
      .select(
        'referral_payouts.*',
        'referral_promoters.first_name',
        'referral_promoters.last_name',
        'referral_promoters.customer_phone'
      )
      .orderBy('referral_payouts.requested_at', 'desc');

    if (status) query = query.where('referral_payouts.status', status);
    const payouts = await query;
    res.json({ payouts });
  } catch (err) { next(err); }
});

// POST /payouts/:id/approve
router.post('/payouts/:id/approve', async (req, res, next) => {
  try {
    const { payoutMethod, adminNotes } = req.body;
    const adminAuditor = req.admin?.email || req.admin?.id || 'admin';

    // Wrap the read+balance-check+update in a transaction with row-level locks
    // so two concurrent approvals can't both succeed and overdraw the balance.
    const result = await db.transaction(async (trx) => {
      const payout = await trx('referral_payouts')
        .where({ id: req.params.id })
        .forUpdate()
        .first();
      if (!payout) {
        const err = new Error('Payout not found');
        err.statusCode = 404;
        throw err;
      }
      if (payout.status === 'applied') {
        const err = new Error('Payout already applied');
        err.statusCode = 409;
        throw err;
      }

      const promoter = await trx('referral_promoters')
        .where({ id: payout.promoter_id })
        .forUpdate()
        .first();
      if (!promoter) {
        const err = new Error('Promoter not found');
        err.statusCode = 404;
        throw err;
      }
      if ((promoter.available_balance_cents || 0) < payout.amount_cents) {
        const err = new Error('Insufficient promoter balance for this payout');
        err.statusCode = 400;
        throw err;
      }

      // Calculate YTD for 1099 tracking inside the txn
      const year = new Date().getFullYear();
      const ytd = await trx('referral_payouts')
        .where({ promoter_id: payout.promoter_id, status: 'applied' })
        .whereRaw('EXTRACT(YEAR FROM processed_at) = ?', [year])
        .sum('amount_cents as total')
        .first();
      const ytdTotal = parseInt(ytd?.total || 0) + payout.amount_cents;

      await trx('referral_payouts').where({ id: req.params.id }).update({
        status: 'applied',
        payout_method: payoutMethod || payout.method || 'service_credit',
        admin_notes: adminNotes,
        processed_at: new Date(),
        processed_by: adminAuditor,
        tax_year: year,
        ytd_total_at_payout: ytdTotal,
        requires_1099: ytdTotal >= 60000, // $600 threshold in cents
      });

      // Deduct exact balance — no GREATEST() floor since we already verified it.
      await trx('referral_promoters').where({ id: payout.promoter_id }).update({
        total_paid_out_cents: db.raw('total_paid_out_cents + ?', [payout.amount_cents]),
        available_balance_cents: db.raw('available_balance_cents - ?', [payout.amount_cents]),
        referral_balance_cents: db.raw('referral_balance_cents - ?', [payout.amount_cents]),
        updated_at: new Date(),
      });

      return { ok: true };
    });

    res.json({ success: true, ...result });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  }
});

// POST /payouts/:id/request — promoter requests payout (admin can also trigger)
router.post('/payouts/:id/request', async (req, res, next) => {
  try {
    const promoterId = req.params.id;
    const { amount, method } = req.body;

    const promoter = await db('referral_promoters').where({ id: promoterId }).first();
    if (!promoter) return res.status(404).json({ error: 'Promoter not found' });

    const settings = await engine.getSettings();
    const requestAmount = amount || promoter.available_balance_cents;

    if (requestAmount < settings.min_payout_cents) {
      return res.status(400).json({ error: `Minimum payout is $${(settings.min_payout_cents / 100).toFixed(2)}` });
    }
    if (requestAmount > (promoter.available_balance_cents || 0)) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const [payout] = await db('referral_payouts').insert({
      promoter_id: promoterId,
      amount_cents: requestAmount,
      method: method || 'service_credit',
      status: 'pending',
    }).returning('*');

    res.json({ payout });
  } catch (err) { next(err); }
});

// =========================================================================
// SETTINGS
// =========================================================================

// GET /settings
router.get('/settings', async (req, res, next) => {
  try {
    const settings = await engine.getSettings();
    res.json({ settings });
  } catch (err) { next(err); }
});

// PUT /settings
router.put('/settings', async (req, res, next) => {
  try {
    const settings = await engine.updateSettings(req.body);
    res.json({ settings });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /analytics — program analytics
// =========================================================================
router.get('/analytics', async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;
    const analytics = await engine.getProgramAnalytics(start, end);
    res.json(analytics);
  } catch (err) { next(err); }
});

module.exports = router;
