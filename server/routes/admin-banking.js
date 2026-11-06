const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { requireFullAccess } = require('../services/intelligence-bar/ib-access');
const logger = require('../services/logger');
const StripeBanking = require('../services/stripe-banking');
const BankingExport = require('../services/banking-export');
const plaidSync = require('../services/plaid-sync');
const CashForecastInputs = require('../services/cash-forecast/inputs');
const { loadForecastInput } = require('../services/cash-forecast/load');
const { computeForecast } = require('../services/cash-forecast/engine');
const featureGates = require('../config/feature-gates');
const { parseETDateTime, etWeekStart, etMonthStart, etDateString } = require('../utils/datetime-et');

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
    // Missing STRIPE_SECRET_KEY is a recognized configuration state, not a
    // fault — answer 503 without the error-level log/stack a real failure gets.
    if (err.message === 'Stripe not configured') {
      return res.status(503).json({ error: 'Stripe not configured', message: 'STRIPE_SECRET_KEY is not set — banking balance is unavailable.' });
    }
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
router.post('/payouts/instant', requireFullAccess, async (req, res) => {
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
router.post('/payouts/standard', requireFullAccess, async (req, res) => {
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
    // Defaults follow the Eastern calendar, not the UTC server clock.
    const startDate = start_date || etMonthStart();
    const endDate = end_date || etDateString();

    const cashFlow = await StripeBanking.getCashFlow(startDate, endDate);
    res.json(summarizeCashFlowForUi(cashFlow, period || 'daily'));
  } catch (err) {
    logger.error('[banking] Cash flow failed:', err);
    // A failed source query fails the whole report (getCashFlow). The page
    // shows the reason in its "unavailable, not zero" notice, so send a
    // plain one instead of the SQL text; a 400 keeps its own reason.
    res.status(err.status || 500).json({ error: err.status ? err.message : 'the cash-flow read failed' });
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
    const rangeStart = start_date || etMonthStart();
    const rangeEnd = end_date || etDateString();

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
    // The Eastern month: on the UTC server clock the month turns over at
    // 8 PM ET (7 PM in winter) on its last day.
    const mtdStart = etMonthStart();

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

// ═══════════════════════════════════════════════════════════════
// GET /cash-today — owner-only Cash today card (GATE_CASH_FORECAST)
// ═══════════════════════════════════════════════════════════════
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isUsd = (currency) => String(currency || 'USD').toUpperCase() === 'USD';

// Bank cash is the available balance, else the current one; a card's balance
// is money owed. Entries in another currency stay listed but never total.
function bankCash(entry) {
  return entry.available != null ? entry.available : entry.current;
}

function sumUsd(entries, pick) {
  return round2(entries.reduce((sum, e) => (
    isUsd(e.currency) ? sum + (Number(pick(e)) || 0) : sum
  ), 0));
}

// Stripe payouts still on the way. arrival_date is a midnight-UTC calendar-day
// marker (see applyArrivalDayRange), so arrival_day is its UTC day, never an
// Eastern-time conversion. A failed read answers { error } and the rest of the
// card still returns.
async function readInTransit() {
  try {
    const rows = await db('stripe_payouts')
      .whereIn('status', ['pending', 'in_transit'])
      .select('amount', 'currency', 'status', 'arrival_date', 'bank_last_four')
      .orderBy('arrival_date', 'asc');
    const payouts = rows.map((r) => ({
      amount: round2(r.amount),
      arrival_day: r.arrival_date ? new Date(r.arrival_date).toISOString().slice(0, 10) : null,
      status: r.status,
      bank_last_four: r.bank_last_four || null,
      currency: String(r.currency || 'usd').toUpperCase(),
    }));
    return { total: sumUsd(payouts, (p) => p.amount), payouts };
  } catch (err) {
    logger.error('[banking] Cash today in-transit read failed:', err);
    return { error: 'unavailable' };
  }
}

router.get('/cash-today', requireFullAccess, async (req, res) => {
  if (!featureGates.cashForecastLive()) return res.status(404).json({ error: 'Not found' });
  try {
    const { accounts, cards, unavailable } = await plaidSync.readCashBalances();
    const inTransit = await readInTransit();
    const bankEntries = accounts.map((a) => ({ ...a, cash: bankCash(a) }));
    res.json({
      fetched_at: new Date().toISOString(),
      accounts,
      cards,
      unavailable,
      in_transit: inTransit,
      totals: {
        bank_usd: sumUsd(bankEntries, (a) => a.cash),
        owed_usd: sumUsd(cards, (c) => c.current),
        in_transit_usd: inTransit.error ? 0 : inTransit.total,
      },
    });
  } catch (err) {
    logger.error('[banking] Cash today failed:', err);
    res.status(500).json({ error: 'the cash read failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// /cash-forecast — owner-only 13-week cash forecast (GATE_CASH_FORECAST, step 2)
// ═══════════════════════════════════════════════════════════════
// Owner 2026-11-04 "A A A A" (Banking decision page). The read works only from data the portal already
// has (services/cash-forecast/load.js reads; engine.js computes; the free Plaid /accounts/get and
// Stripe's balance read). The input routes store what the owner types: planned items, and the settings
// (floor, last year's receipts by month). Owner only; 404 while the gate is off.
function cashForecastGate(req, res, next) {
  if (!featureGates.cashForecastLive()) return res.status(404).json({ error: 'Not found' });
  return next();
}

router.get('/cash-forecast', requireFullAccess, cashForecastGate, async (req, res) => {
  try {
    const input = await loadForecastInput();
    res.json({ fetched_at: new Date().toISOString(), ...computeForecast(input) });
  } catch (err) {
    logger.error('[banking] Cash forecast failed:', err);
    res.status(500).json({ error: 'the forecast read failed' });
  }
});

router.get('/cash-forecast/inputs', requireFullAccess, cashForecastGate, async (req, res) => {
  try {
    const [items, settings] = await Promise.all([CashForecastInputs.listItems(db), CashForecastInputs.getSettings(db)]);
    res.json({ items, settings, kinds: CashForecastInputs.KINDS, cadences: CashForecastInputs.CADENCES });
  } catch (err) {
    logger.error('[banking] Cash forecast inputs read failed:', err);
    res.status(500).json({ error: 'the forecast inputs read failed' });
  }
});

// A plain 400 for input the owner can fix, 404 for an unknown item, else a plain 500 (no SQL text).
function cashForecastWrite(handler, { created = false } = {}) {
  return async (req, res) => {
    try {
      const out = await handler(req);
      if (out === null) return res.status(404).json({ error: 'No planned item has that id' });
      return res.status(created ? 201 : 200).json(out);
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message });
      logger.error('[banking] Cash forecast input write failed:', err);
      return res.status(500).json({ error: 'the forecast inputs write failed' });
    }
  };
}

router.post('/cash-forecast/items', requireFullAccess, cashForecastGate,
  cashForecastWrite((req) => CashForecastInputs.createItem(db, req.body, req.technicianId), { created: true }));
router.patch('/cash-forecast/items/:id', requireFullAccess, cashForecastGate,
  cashForecastWrite((req) => CashForecastInputs.updateItem(db, req.params.id, req.body, req.technicianId)));
router.delete('/cash-forecast/items/:id', requireFullAccess, cashForecastGate,
  cashForecastWrite((req) => CashForecastInputs.deactivateItem(db, req.params.id, req.technicianId)));
router.put('/cash-forecast/settings', requireFullAccess, cashForecastGate,
  cashForecastWrite((req) => CashForecastInputs.saveSettings(db, req.body, req.technicianId)));

module.exports = router;
