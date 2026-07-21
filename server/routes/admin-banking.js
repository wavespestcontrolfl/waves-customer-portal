const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const StripeBanking = require('../services/stripe-banking');
const BankingExport = require('../services/banking-export');
const { parseETDateTime, etWeekStart } = require('../utils/datetime-et');

router.use(adminAuthenticate, requireAdmin);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IDEMPOTENCY_KEY_RE = /^[a-zA-Z0-9._:-]{8,120}$/;

function validateDateParam(value, name) {
  if (value && !ISO_DATE_RE.test(String(value))) {
    const err = new Error(`Invalid ${name}; expected YYYY-MM-DD`);
    err.status = 400;
    throw err;
  }
}

// Stripe's arrival_date is a CALENDAR-DAY marker stored at midnight UTC —
// "the day the funds arrive" — not an instant. Filter it by its UTC calendar
// day so the range controls match what the UI displays (fmtDay renders the
// same UTC day); the old AT TIME ZONE America/New_York conversion shifted
// every midnight-UTC marker to the PREVIOUS ET day, so a payout shown as
// arriving Jul 21 only matched a Jul 20 filter.
function applyArrivalDayRange(query, column, startDate, endDate) {
  if (startDate) query = query.whereRaw(`DATE(${column}) >= ?::date`, [startDate]);
  if (endDate) query = query.whereRaw(`DATE(${column}) <= ?::date`, [endDate]);
  return query;
}

function getAdminActorId(req) {
  return String(req.technicianId || req.technician?.id || 'admin');
}

function parsePayoutAmount(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const amount = Number(raw);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function parseIdempotencyKey(value) {
  const key = String(value || '').trim();
  return IDEMPOTENCY_KEY_RE.test(key) ? key : null;
}

function summarizeCashFlowForUi(cashFlow, period) {
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const buckets = new Map();

  const addToBucket = (key, label, day) => {
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        label,
        money_in: 0,
        money_out: 0,
        net: 0,
        revenue: 0,
        expenses: 0,
        fees: 0,
        payouts: 0,
      });
    }
    const row = buckets.get(key);
    const revenue = Number(day.revenue || 0);
    const expenses = Number(day.expenses || 0);
    const fees = Number(day.fees || 0);
    const payouts = Number(day.payouts || 0);
    row.money_in += revenue;
    row.money_out += expenses + fees;
    row.net += revenue - expenses - fees;
    row.revenue += revenue;
    row.expenses += expenses;
    row.fees += fees;
    row.payouts += payouts;
  };

  for (const day of cashFlow.daily || []) {
    const date = String(day.date).slice(0, 10);
    if (period === 'monthly') {
      addToBucket(date.slice(0, 7), date.slice(0, 7), day);
    } else if (period === 'weekly') {
      const key = etWeekStart(parseETDateTime(`${date}T12:00`));
      addToBucket(key, key, day);
    } else {
      addToBucket(date, date, day);
    }
  }

  const periods = Array.from(buckets.values())
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(row => ({
      ...row,
      money_in: round2(row.money_in),
      money_out: round2(row.money_out),
      net: round2(row.net),
      revenue: round2(row.revenue),
      expenses: round2(row.expenses),
      fees: round2(row.fees),
      payouts: round2(row.payouts),
    }));

  const summary = cashFlow.summary || {};
  const totalOut = Number(summary.total_expenses || 0) + Number(summary.stripe_fees || 0);
  return {
    ...cashFlow,
    periods,
    summary: {
      ...summary,
      total_in: round2(summary.total_revenue),
      total_out: round2(totalOut),
      net: round2(summary.operating_cash_flow ?? summary.net_cash_flow),
    },
  };
}

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
    validateDateParam(start_date, 'start_date');
    validateDateParam(end_date, 'end_date');
    const parsedPage = parseInt(page, 10);
    const parsedLimit = parseInt(limit, 10);
    const pg = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
    const lim = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 20;
    const offset = (pg - 1) * lim;

    let query = db('stripe_payouts');
    let countQuery = db('stripe_payouts');

    if (status) {
      query = query.where('status', status);
      countQuery = countQuery.where('status', status);
    }
    query = applyArrivalDayRange(query, 'arrival_date', start_date, end_date);
    countQuery = applyArrivalDayRange(countQuery, 'arrival_date', start_date, end_date);

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
    res.status(err.status || 500).json({ error: err.message });
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
    const amount = parsePayoutAmount(req.body.amount);
    if (amount == null) {
      return res.status(400).json({ error: 'Invalid amount — must be a positive number' });
    }
    const idempotencyKey = parseIdempotencyKey(req.body.idempotency_key);
    if (!idempotencyKey) {
      return res.status(400).json({ error: 'A valid idempotency key is required' });
    }
    const result = await StripeBanking.createInstantPayout(amount, {
      requestedBy: getAdminActorId(req),
      idempotencyKey,
    });
    res.json(result);
  } catch (err) {
    logger.error('[banking] Instant payout failed:', err);
    res.status(err.status || err.statusCode || 500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /payouts/standard — request a standard manual payout
// ═══════════════════════════════════════════════════════════════
router.post('/payouts/standard', async (req, res) => {
  try {
    const amount = parsePayoutAmount(req.body.amount);
    if (amount == null) {
      return res.status(400).json({ error: 'Invalid amount — must be a positive number' });
    }
    const idempotencyKey = parseIdempotencyKey(req.body.idempotency_key);
    if (!idempotencyKey) {
      return res.status(400).json({ error: 'A valid idempotency key is required' });
    }
    const result = await StripeBanking.createStandardPayout(amount, {
      requestedBy: getAdminActorId(req),
      idempotencyKey,
    });
    res.json(result);
  } catch (err) {
    logger.error('[banking] Standard payout failed:', err);
    res.status(err.status || err.statusCode || 500).json({ error: err.message });
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
    validateDateParam(start_date, 'start_date');
    validateDateParam(end_date, 'end_date');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const startDate = start_date || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    const endDate = end_date || localDate(now);

    const cashFlow = await StripeBanking.getCashFlow(startDate, endDate);
    res.json(summarizeCashFlowForUi(cashFlow, period || 'daily'));
  } catch (err) {
    logger.error('[banking] Cash flow failed:', err);
    res.status(err.status || 500).json({ error: err.message });
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

    res.json({ payouts: rows });
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
    const actualAmount = Number(actual_amount);
    if (!Number.isFinite(actualAmount)) {
      return res.status(400).json({ error: 'Invalid actual_amount — must be a number' });
    }
    const result = await StripeBanking.reconcilePayout(
      req.params.payoutId,
      actualAmount,
      notes,
      getAdminActorId(req),
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
    validateDateParam(start_date, 'start_date');
    validateDateParam(end_date, 'end_date');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const rangeStart = start_date || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    const rangeEnd = end_date || todayStr;

    // Exports feed the accounting books: only payouts that actually reached
    // the bank belong in them (failed/canceled rows keep their arrival dates
    // and would sit beside their replacement payout, so OFX LEDGERBAL never
    // reconciles). Mirrors the /stats status filter.
    let query = db('stripe_payouts').where({ status: 'paid' });
    query = applyArrivalDayRange(query, 'arrival_date', start_date, end_date);
    const payouts = await query.orderBy('arrival_date', 'desc');

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
    res.status(err.status || 500).json({ error: err.message });
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

    let statsQuery = db('stripe_payouts')
      .where('status', 'paid');
    statsQuery = applyArrivalDayRange(statsQuery, 'arrival_date', mtdStart, null);
    const stats = await statsQuery
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
