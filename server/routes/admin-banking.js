const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const StripeBanking = require('../services/stripe-banking');
const BankingExport = require('../services/banking-export');

router.use(adminAuthenticate);

// ═══════════════════════════════════════════════════════════════
// GET /balance — current Stripe balance
// ═══════════════════════════════════════════════════════════════
router.get('/balance', async (req, res) => {
  try {
    const balance = await StripeBanking.getBalance();
    res.json(balance);
  } catch (err) {
    logger.error('[banking] Balance fetch failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /payouts — list payouts with optional filters
// ═══════════════════════════════════════════════════════════════
router.get('/payouts', async (req, res) => {
  try {
    const { status, start_date, end_date, page = 1, limit = 20 } = req.query;
    const pg = Math.max(1, parseInt(page));
    const lim = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pg - 1) * lim;

    let query = db('stripe_payouts');
    let countQuery = db('stripe_payouts');

    if (status) {
      query = query.where('status', status);
      countQuery = countQuery.where('status', status);
    }
    if (start_date) {
      query = query.where('created_at_stripe', '>=', start_date);
      countQuery = countQuery.where('created_at_stripe', '>=', start_date);
    }
    if (end_date) {
      query = query.where('created_at_stripe', '<=', end_date);
      countQuery = countQuery.where('created_at_stripe', '<=', end_date);
    }

    const [{ count }] = await countQuery.count('* as count');
    const total = parseInt(count);

    const payouts = await query
      .orderBy('created_at_stripe', 'desc')
      .limit(lim)
      .offset(offset);

    res.json({
      payouts,
      total,
      page: pg,
      pages: Math.ceil(total / lim),
    });
  } catch (err) {
    logger.error('[banking] Payouts list failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /payouts/:id — single payout with transactions
// ═══════════════════════════════════════════════════════════════
router.get('/payouts/:id', async (req, res) => {
  try {
    const payout = await db('stripe_payouts').where('id', req.params.id).first();
    if (!payout) return res.status(404).json({ error: 'Payout not found' });

    const transactions = await db('stripe_payout_transactions')
      .where('payout_id', req.params.id)
      .orderBy('created_at_stripe', 'desc');

    res.json({ payout, transactions });
  } catch (err) {
    logger.error('[banking] Payout detail failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /payouts/instant — request an instant payout
// ═══════════════════════════════════════════════════════════════
router.post('/payouts/instant', async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount — must be a positive number' });
    }
    const result = await StripeBanking.createInstantPayout(amount);
    res.json(result);
  } catch (err) {
    logger.error('[banking] Instant payout failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /sync — sync payouts from Stripe
// ═══════════════════════════════════════════════════════════════
router.post('/sync', async (req, res) => {
  try {
    const result = await StripeBanking.syncPayouts(50);
    res.json({ ...result, last_sync: new Date().toISOString() });
  } catch (err) {
    logger.error('[banking] Sync failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /cash-flow — daily/weekly/monthly cash flow
// ═══════════════════════════════════════════════════════════════
router.get('/cash-flow', async (req, res) => {
  try {
    const { period, start_date, end_date } = req.query;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const startDate = start_date || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    const endDate = end_date || localDate(now);

    const cashFlow = await StripeBanking.getCashFlow(startDate, endDate);

    if (period === 'weekly') {
      const buckets = {};
      for (const day of cashFlow.daily || []) {
        const d = new Date(day.date + 'T12:00:00');
        const weekStart = new Date(d);
        weekStart.setDate(d.getDate() - d.getDay());
        const key = weekStart.toISOString().split('T')[0];
        if (!buckets[key]) buckets[key] = { week_start: key, gross: 0, fees: 0, net: 0, count: 0 };
        buckets[key].gross += parseFloat(day.gross || 0);
        buckets[key].fees += parseFloat(day.fees || 0);
        buckets[key].net += parseFloat(day.net || 0);
        buckets[key].count += parseInt(day.count || 0);
      }
      cashFlow.weekly = Object.values(buckets).sort((a, b) => a.week_start.localeCompare(b.week_start));
    } else if (period === 'monthly') {
      const buckets = {};
      for (const day of cashFlow.daily || []) {
        const key = day.date.substring(0, 7);
        if (!buckets[key]) buckets[key] = { month: key, gross: 0, fees: 0, net: 0, count: 0 };
        buckets[key].gross += parseFloat(day.gross || 0);
        buckets[key].fees += parseFloat(day.fees || 0);
        buckets[key].net += parseFloat(day.net || 0);
        buckets[key].count += parseInt(day.count || 0);
      }
      cashFlow.monthly = Object.values(buckets).sort((a, b) => a.month.localeCompare(b.month));
    }

    res.json(cashFlow);
  } catch (err) {
    logger.error('[banking] Cash flow failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /reconciliation — paid payouts with reconciliation status
// ═══════════════════════════════════════════════════════════════
router.get('/reconciliation', async (req, res) => {
  try {
    // Use a LATERAL-style subquery to pick the latest reconciliation row per payout,
    // preventing duplicate rows when multiple bank_reconciliation records exist.
    const latest = db('bank_reconciliation as br')
      .select('br.payout_id', 'br.actual_amount', 'br.reconciled_at', 'br.reconciled_by', 'br.notes')
      .whereRaw(
        'br.id = (SELECT id FROM bank_reconciliation WHERE payout_id = br.payout_id ORDER BY reconciled_at DESC NULLS LAST, id DESC LIMIT 1)',
      )
      .as('br');

    const rows = await db('stripe_payouts')
      .where('stripe_payouts.status', 'paid')
      .leftJoin(latest, 'stripe_payouts.id', 'br.payout_id')
      .select(
        'stripe_payouts.*',
        'br.actual_amount',
        'br.reconciled_at',
        'br.reconciled_by',
        'br.notes as reconciliation_notes',
      )
      .orderBy('stripe_payouts.arrival_date', 'desc');

    res.json(rows);
  } catch (err) {
    logger.error('[banking] Reconciliation list failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /reconciliation/:payoutId — mark payout reconciled
// ═══════════════════════════════════════════════════════════════
router.post('/reconciliation/:payoutId', async (req, res) => {
  try {
    const { actual_amount, notes, status } = req.body;
    const result = await StripeBanking.reconcilePayout(
      req.params.payoutId,
      actual_amount,
      notes,
      'admin',
      status || 'confirmed',
    );
    res.json(result);
  } catch (err) {
    logger.error('[banking] Reconciliation failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /export — download payouts as CSV or OFX
// ═══════════════════════════════════════════════════════════════
router.get('/export', async (req, res) => {
  try {
    const { format = 'csv', start_date, end_date } = req.query;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const rangeStart = start_date || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    const rangeEnd = end_date || todayStr;

    let query = db('stripe_payouts');
    if (start_date) query = query.where('created_at_stripe', '>=', start_date);
    if (end_date) query = query.where('created_at_stripe', '<=', end_date);
    const payouts = await query.orderBy('created_at_stripe', 'desc');

    if (format === 'ofx') {
      const ofx = BankingExport.generateOFX(payouts, rangeStart, rangeEnd);
      res.set('Content-Type', ofx.content_type || 'application/x-ofx');
      res.set('Content-Disposition', `attachment; filename="${ofx.filename}"`);
      return res.send(ofx.content);
    }

    // CSV — include transaction detail
    const payoutIds = payouts.map(p => p.id);
    const transactions = payoutIds.length
      ? await db('stripe_payout_transactions').whereIn('payout_id', payoutIds).orderBy('created_at_stripe', 'desc')
      : [];

    const csv = BankingExport.generateCSV(payouts, transactions);
    res.set('Content-Type', csv.content_type || 'text/csv');
    res.set('Content-Disposition', `attachment; filename="${csv.filename}"`);
    res.send(csv.content);
  } catch (err) {
    logger.error('[banking] Export failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /stats — MTD banking stats
// ═══════════════════════════════════════════════════════════════
router.get('/stats', async (req, res) => {
  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const mtdStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;

    const stats = await db('stripe_payouts')
      .where('status', 'paid')
      .where('created_at_stripe', '>=', mtdStart)
      .select(
        db.raw('COALESCE(SUM(amount), 0) as mtd_deposited'),
        db.raw('COALESCE(SUM(fee_total), 0) as mtd_fees'),
        db.raw('COUNT(*) as payout_count'),
        db.raw('COALESCE(AVG(amount), 0) as avg_payout'),
      )
      .first();

    res.json({
      mtd_deposited: parseFloat(stats.mtd_deposited),
      mtd_fees: parseFloat(stats.mtd_fees),
      payout_count: parseInt(stats.payout_count),
      avg_payout: parseFloat(parseFloat(stats.avg_payout).toFixed(2)),
    });
  } catch (err) {
    logger.error('[banking] Stats failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
