/**
 * Stripe Banking & Cash Flow Service
 * server/services/stripe-banking.js
 *
 * Syncs payouts from Stripe, provides cash flow analysis,
 * reconciliation tools, and instant payout support.
 */

const Stripe = require('stripe');
const stripeConfig = require('../config/stripe-config');
const db = require('../models/db');
const logger = require('./logger');

// ═══════════════════════════════════════════════════════════════
// Lazy-init Stripe client — don't crash if key is missing
// ═══════════════════════════════════════════════════════════════
let _stripe;
function getStripe() {
  if (_stripe) return _stripe;
  if (!stripeConfig.secretKey) {
    logger.warn('[stripe-banking] STRIPE_SECRET_KEY not set — banking features disabled');
    return null;
  }
  _stripe = new Stripe(stripeConfig.secretKey, { apiVersion: '2024-12-18.acacia' });
  return _stripe;
}


// ═══════════════════════════════════════════════════════════════
// GET BALANCE
// ═══════════════════════════════════════════════════════════════

/**
 * Retrieve current Stripe balance + next pending payout info.
 * Converts cents to dollars.
 */
async function getBalance() {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');

  try {
    const balance = await stripe.balance.retrieve();

    // Convert balance amounts from cents to dollars
    const available = balance.available.map(b => ({
      currency: b.currency,
      amount: b.amount / 100,
    }));
    const pending = balance.pending.map(b => ({
      currency: b.currency,
      amount: b.amount / 100,
    }));

    // Get next pending payout
    let nextPayout = null;
    try {
      const payouts = await stripe.payouts.list({ limit: 1, status: 'in_transit' });
      if (payouts.data.length > 0) {
        const p = payouts.data[0];
        nextPayout = {
          id: p.id,
          amount: p.amount / 100,
          arrival_date: new Date(p.arrival_date * 1000).toISOString(),
          status: p.status,
          method: p.method,
        };
      }
    } catch (err) {
      logger.warn('[stripe-banking] Could not fetch next payout:', err.message);
    }

    return {
      available,
      pending,
      total_available: available.reduce((s, b) => s + b.amount, 0),
      total_pending: pending.reduce((s, b) => s + b.amount, 0),
      next_payout: nextPayout,
    };
  } catch (err) {
    logger.error('[stripe-banking] getBalance failed:', err.message);
    throw err;
  }
}


// ═══════════════════════════════════════════════════════════════
// SYNC PAYOUTS
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch payouts from Stripe and upsert into stripe_payouts table.
 * Syncs balance transactions for each payout.
 * @param {number} limit — max payouts to fetch (default 50)
 */
async function syncPayouts(limit = 50) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');

  try {
    // Check last sync cursor
    let cursor = null;
    try {
      const syncState = await db('stripe_sync_state')
        .where('sync_type', 'payouts')
        .first();
      if (syncState) cursor = syncState.cursor;
    } catch { /* table may not exist yet */ }

    const listParams = { limit };
    if (cursor) listParams.starting_after = cursor;

    const payouts = await stripe.payouts.list(listParams);
    let synced = 0;
    let lastPayoutId = null;

    for (const p of payouts.data) {
      lastPayoutId = p.id;

      // Check if payout already exists
      const existing = await db('stripe_payouts')
        .where('stripe_payout_id', p.id)
        .first();

      const record = {
        stripe_payout_id: p.id,
        amount: p.amount / 100,
        currency: p.currency,
        status: p.status,
        arrival_date: p.arrival_date ? new Date(p.arrival_date * 1000).toISOString() : null,
        created_at_stripe: p.created ? new Date(p.created * 1000).toISOString() : null,
        method: p.method,
        type: p.type,
        description: p.description,
        failure_message: p.failure_message || null,
        bank_name: p.destination ? (typeof p.destination === 'object' ? p.destination.bank_name : null) : null,
        bank_last_four: p.destination ? (typeof p.destination === 'object' ? p.destination.last4 : null) : null,
        metadata: JSON.stringify(p.metadata || {}),
        synced_at: new Date().toISOString(),
      };

      if (existing) {
        await db('stripe_payouts')
          .where('stripe_payout_id', p.id)
          .update(record);
      } else {
        await db('stripe_payouts').insert(record);
      }

      // Sync transactions for this payout (only for paid payouts)
      if (p.status === 'paid') {
        try {
          await syncPayoutTransactions(p.id);
        } catch (err) {
          logger.warn(`[stripe-banking] Transaction sync failed for ${p.id}:`, err.message);
        }
      }

      synced++;
    }

    // Update sync cursor
    if (lastPayoutId) {
      try {
        const existing = await db('stripe_sync_state')
          .where('sync_type', 'payouts')
          .first();

        if (existing) {
          await db('stripe_sync_state')
            .where('sync_type', 'payouts')
            .update({
              last_sync_at: new Date().toISOString(),
              last_payout_id: lastPayoutId,
              cursor: lastPayoutId,
            });
        } else {
          await db('stripe_sync_state').insert({
            sync_type: 'payouts',
            last_sync_at: new Date().toISOString(),
            last_payout_id: lastPayoutId,
            cursor: lastPayoutId,
          });
        }
      } catch (err) {
        logger.warn('[stripe-banking] Could not update sync state:', err.message);
      }
    }

    logger.info(`[stripe-banking] Synced ${synced} payouts`);
    return { synced, has_more: payouts.has_more };
  } catch (err) {
    logger.error('[stripe-banking] syncPayouts failed:', err.message);
    throw err;
  }
}


// ═══════════════════════════════════════════════════════════════
// SYNC PAYOUT TRANSACTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch balance transactions for a specific payout and store them.
 * Attempts to match transactions to local payments/customers/invoices.
 * @param {string} stripePayoutId — Stripe payout ID (po_xxx)
 */
async function syncPayoutTransactions(stripePayoutId) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');

  // Find local payout record
  const payout = await db('stripe_payouts')
    .where('stripe_payout_id', stripePayoutId)
    .first();
  if (!payout) throw new Error(`Payout not found: ${stripePayoutId}`);

  try {
    // Fetch all balance transactions for this payout
    const transactions = await stripe.balanceTransactions.list({
      payout: stripePayoutId,
      limit: 100,
    });

    let totalFees = 0;
    let txnCount = 0;

    // Clear existing transactions for this payout before re-syncing
    await db('stripe_payout_transactions')
      .where('payout_id', payout.id)
      .del();

    for (const txn of transactions.data) {
      // Attempt to match to local records
      let customerId = null;
      let customerName = null;
      let invoiceId = null;
      let paymentId = null;

      // If this is a charge, try to find the matching local payment
      if (txn.source && typeof txn.source === 'string' && txn.source.startsWith('ch_')) {
        try {
          const payment = await db('payments')
            .where('stripe_charge_id', txn.source)
            .orWhere('stripe_payment_intent_id', txn.source)
            .first();

          if (payment) {
            paymentId = payment.id;
            customerId = payment.customer_id;

            // Get customer name
            if (customerId) {
              const customer = await db('customers')
                .where('id', customerId)
                .select('first_name', 'last_name')
                .first();
              if (customer) {
                customerName = `${customer.first_name} ${customer.last_name}`;
              }
            }

            // Check if payment is linked to an invoice
            try {
              const meta = typeof payment.metadata === 'string'
                ? JSON.parse(payment.metadata)
                : payment.metadata;
              if (meta && meta.invoice_id) {
                invoiceId = meta.invoice_id;
              }
            } catch { /* metadata parse failure — non-critical */ }
          }
        } catch { /* matching failure — non-critical */ }
      }

      await db('stripe_payout_transactions').insert({
        payout_id: payout.id,
        stripe_txn_id: txn.id,
        type: txn.type,
        amount: txn.amount / 100,
        fee: txn.fee / 100,
        net: txn.net / 100,
        description: txn.description,
        customer_name: customerName,
        customer_id: customerId,
        invoice_id: invoiceId,
        payment_id: paymentId,
        available_on: txn.available_on ? new Date(txn.available_on * 1000).toISOString() : null,
        created_at_stripe: txn.created ? new Date(txn.created * 1000).toISOString() : null,
      });

      totalFees += txn.fee / 100;
      txnCount++;
    }

    // Update payout with fee total and transaction count
    await db('stripe_payouts')
      .where('id', payout.id)
      .update({
        fee_total: totalFees,
        transaction_count: txnCount,
      });

    logger.info(`[stripe-banking] Synced ${txnCount} transactions for payout ${stripePayoutId}`);
    return { transaction_count: txnCount, fee_total: totalFees };
  } catch (err) {
    logger.error(`[stripe-banking] syncPayoutTransactions failed for ${stripePayoutId}:`, err.message);
    throw err;
  }
}


// ═══════════════════════════════════════════════════════════════
// GET PAYOUT DETAILS
// ═══════════════════════════════════════════════════════════════

/**
 * Get a payout with all its transactions.
 * @param {string} payoutId — local UUID or stripe payout ID
 */
async function getPayoutDetails(payoutId) {
  try {
    // Try as local UUID first, then as Stripe payout ID
    let payout = await db('stripe_payouts').where('id', payoutId).first();
    if (!payout) {
      payout = await db('stripe_payouts').where('stripe_payout_id', payoutId).first();
    }
    if (!payout) return { error: 'Payout not found' };

    const transactions = await db('stripe_payout_transactions')
      .where('payout_id', payout.id)
      .orderBy('created_at_stripe', 'desc');

    return {
      payout: {
        id: payout.id,
        stripe_payout_id: payout.stripe_payout_id,
        amount: parseFloat(payout.amount || 0),
        currency: payout.currency,
        status: payout.status,
        arrival_date: payout.arrival_date,
        created_at_stripe: payout.created_at_stripe,
        method: payout.method,
        type: payout.type,
        description: payout.description,
        bank_name: payout.bank_name,
        bank_last_four: payout.bank_last_four,
        fee_total: parseFloat(payout.fee_total || 0),
        transaction_count: payout.transaction_count,
        reconciled: payout.reconciled,
        reconciled_at: payout.reconciled_at,
      },
      transactions: transactions.map(t => ({
        id: t.id,
        stripe_txn_id: t.stripe_txn_id,
        type: t.type,
        amount: parseFloat(t.amount || 0),
        fee: parseFloat(t.fee || 0),
        net: parseFloat(t.net || 0),
        description: t.description,
        customer_name: t.customer_name,
        customer_id: t.customer_id,
        invoice_id: t.invoice_id,
        payment_id: t.payment_id,
        created_at_stripe: t.created_at_stripe,
      })),
      summary: {
        gross: transactions.reduce((s, t) => s + parseFloat(t.amount || 0), 0),
        fees: parseFloat(payout.fee_total || 0),
        net: parseFloat(payout.amount || 0),
        charges: transactions.filter(t => t.type === 'charge').length,
        refunds: transactions.filter(t => t.type === 'refund').length,
        adjustments: transactions.filter(t => t.type === 'adjustment').length,
      },
    };
  } catch (err) {
    logger.error('[stripe-banking] getPayoutDetails failed:', err.message);
    throw err;
  }
}


// ═══════════════════════════════════════════════════════════════
// CREATE INSTANT PAYOUT
// ═══════════════════════════════════════════════════════════════

/**
 * Request an instant payout from Stripe.
 * @param {number} amountDollars — amount in dollars
 */
async function createInstantPayout(amountDollars) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');

  try {
    const amountCents = Math.round(amountDollars * 100);

    const payout = await stripe.payouts.create({
      amount: amountCents,
      currency: 'usd',
      method: 'instant',
    });

    // Store in local DB
    await db('stripe_payouts').insert({
      stripe_payout_id: payout.id,
      amount: payout.amount / 100,
      currency: payout.currency,
      status: payout.status,
      arrival_date: payout.arrival_date ? new Date(payout.arrival_date * 1000).toISOString() : null,
      created_at_stripe: payout.created ? new Date(payout.created * 1000).toISOString() : null,
      method: 'instant',
      type: payout.type,
      description: payout.description || 'Instant payout',
      synced_at: new Date().toISOString(),
    });

    logger.info(`[stripe-banking] Instant payout created: $${amountDollars}, payout ${payout.id}`);

    return {
      payout_id: payout.id,
      amount: payout.amount / 100,
      status: payout.status,
      arrival_date: payout.arrival_date ? new Date(payout.arrival_date * 1000).toISOString() : null,
      method: 'instant',
      fee_estimate: amountDollars * 0.01, // Stripe instant payout fee is ~1%
    };
  } catch (err) {
    logger.error('[stripe-banking] createInstantPayout failed:', err.message);
    throw err;
  }
}


// ═══════════════════════════════════════════════════════════════
// GET CASH FLOW
// ═══════════════════════════════════════════════════════════════

/**
 * Aggregate cash flow: payments in, expenses out, fees, payouts.
 * @param {string} startDate — YYYY-MM-DD
 * @param {string} endDate — YYYY-MM-DD
 */
async function getCashFlow(startDate, endDate) {
  try {
    // Revenue (payments received)
    const revenueRows = await db('payments')
      .where('status', 'paid')
      .whereBetween('payment_date', [startDate, endDate])
      .select(
        db.raw("payment_date as date"),
        db.raw('SUM(amount) as total'),
        db.raw('COUNT(*) as count'),
      )
      .groupBy('payment_date')
      .orderBy('payment_date')
      .catch(() => []);

    // Expenses
    const expenseRows = await db('expenses')
      .whereBetween('expense_date', [startDate, endDate])
      .select(
        db.raw("expense_date as date"),
        db.raw('SUM(amount) as total'),
        db.raw('COUNT(*) as count'),
      )
      .groupBy('expense_date')
      .orderBy('expense_date')
      .catch(() => []);

    // Stripe fees from payout transactions
    const feeRows = await db('stripe_payout_transactions')
      .whereBetween('created_at_stripe', [startDate, endDate + 'T23:59:59'])
      .select(db.raw('COALESCE(SUM(fee), 0) as total_fees'))
      .first()
      .catch(() => ({ total_fees: 0 }));

    // Payouts
    const payoutRows = await db('stripe_payouts')
      .whereBetween('arrival_date', [startDate, endDate + 'T23:59:59'])
      .select(
        db.raw("DATE(arrival_date) as date"),
        db.raw('SUM(amount) as total'),
        db.raw('COUNT(*) as count'),
      )
      .groupBy(db.raw('DATE(arrival_date)'))
      .orderBy('date')
      .catch(() => []);

    // Build daily aggregates
    const dailyMap = {};
    revenueRows.forEach(r => {
      const d = typeof r.date === 'string' ? r.date : new Date(r.date).toISOString().split('T')[0];
      if (!dailyMap[d]) dailyMap[d] = { date: d, revenue: 0, expenses: 0, payouts: 0 };
      dailyMap[d].revenue += parseFloat(r.total || 0);
    });
    expenseRows.forEach(r => {
      const d = typeof r.date === 'string' ? r.date : new Date(r.date).toISOString().split('T')[0];
      if (!dailyMap[d]) dailyMap[d] = { date: d, revenue: 0, expenses: 0, payouts: 0 };
      dailyMap[d].expenses += parseFloat(r.total || 0);
    });
    payoutRows.forEach(r => {
      const d = typeof r.date === 'string' ? r.date : new Date(r.date).toISOString().split('T')[0];
      if (!dailyMap[d]) dailyMap[d] = { date: d, revenue: 0, expenses: 0, payouts: 0 };
      dailyMap[d].payouts += parseFloat(r.total || 0);
    });

    const daily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

    // Summary totals
    const totalRevenue = revenueRows.reduce((s, r) => s + parseFloat(r.total || 0), 0);
    const totalExpenses = expenseRows.reduce((s, r) => s + parseFloat(r.total || 0), 0);
    const totalFees = parseFloat(feeRows?.total_fees || 0);
    const totalPayouts = payoutRows.reduce((s, r) => s + parseFloat(r.total || 0), 0);

    return {
      period: { start: startDate, end: endDate },
      summary: {
        total_revenue: Math.round(totalRevenue * 100) / 100,
        total_expenses: Math.round(totalExpenses * 100) / 100,
        stripe_fees: Math.round(totalFees * 100) / 100,
        total_payouts: Math.round(totalPayouts * 100) / 100,
        net_cash_flow: Math.round((totalRevenue - totalExpenses - totalFees) * 100) / 100,
        payment_count: revenueRows.reduce((s, r) => s + parseInt(r.count || 0), 0),
        payout_count: payoutRows.reduce((s, r) => s + parseInt(r.count || 0), 0),
      },
      daily,
    };
  } catch (err) {
    logger.error('[stripe-banking] getCashFlow failed:', err.message);
    throw err;
  }
}


// ═══════════════════════════════════════════════════════════════
// RECONCILE PAYOUT
// ═══════════════════════════════════════════════════════════════

/**
 * Record bank-side reconciliation for a payout.
 * @param {string} payoutId — local UUID
 * @param {number} actualAmount — amount that hit the bank
 * @param {string} notes — reconciliation notes
 * @param {string} reconciledBy — who reconciled
 */
async function reconcilePayout(payoutId, actualAmount, notes, reconciledBy) {
  try {
    const payout = await db('stripe_payouts').where('id', payoutId).first();
    if (!payout) throw new Error('Payout not found');

    const expectedAmount = parseFloat(payout.amount || 0);
    const discrepancy = Math.round((actualAmount - expectedAmount) * 100) / 100;
    const matched = Math.abs(discrepancy) < 0.01;
    const now = new Date().toISOString();

    // Check if reconciliation record exists
    const existing = await db('bank_reconciliation').where('payout_id', payoutId).first();

    if (existing) {
      await db('bank_reconciliation')
        .where('payout_id', payoutId)
        .update({
          expected_amount: expectedAmount,
          actual_amount: actualAmount,
          matched,
          discrepancy,
          notes,
          reconciled_at: now,
          reconciled_by: reconciledBy,
        });
    } else {
      await db('bank_reconciliation').insert({
        payout_id: payoutId,
        expected_amount: expectedAmount,
        actual_amount: actualAmount,
        matched,
        discrepancy,
        notes,
        reconciled_at: now,
        reconciled_by: reconciledBy,
      });
    }

    // Mark payout as reconciled
    await db('stripe_payouts')
      .where('id', payoutId)
      .update({
        reconciled: true,
        reconciled_at: now,
        reconciled_by: reconciledBy,
      });

    logger.info(`[stripe-banking] Payout ${payoutId} reconciled: expected=$${expectedAmount}, actual=$${actualAmount}, matched=${matched}`);

    return {
      payout_id: payoutId,
      expected_amount: expectedAmount,
      actual_amount: actualAmount,
      discrepancy,
      matched,
      reconciled_at: now,
      reconciled_by: reconciledBy,
    };
  } catch (err) {
    logger.error('[stripe-banking] reconcilePayout failed:', err.message);
    throw err;
  }
}


// ═══════════════════════════════════════════════════════════════
// GENERATE EXPORT
// ═══════════════════════════════════════════════════════════════

/**
 * Generate an export file (OFX or CSV) for payouts in a date range.
 * Delegates to banking-export.js
 * @param {string} format — 'ofx' or 'csv'
 * @param {string} startDate — YYYY-MM-DD
 * @param {string} endDate — YYYY-MM-DD
 */
async function generateExport(format, startDate, endDate) {
  try {
    const payouts = await db('stripe_payouts')
      .whereBetween('arrival_date', [startDate, endDate + 'T23:59:59'])
      .orderBy('arrival_date');

    const transactions = await db('stripe_payout_transactions')
      .whereIn('payout_id', payouts.map(p => p.id))
      .orderBy('created_at_stripe');

    const BankingExport = require('./banking-export');

    if (format === 'ofx') {
      return BankingExport.generateOFX(payouts, startDate, endDate);
    } else {
      return BankingExport.generateCSV(payouts, transactions);
    }
  } catch (err) {
    logger.error('[stripe-banking] generateExport failed:', err.message);
    throw err;
  }
}


module.exports = {
  getBalance,
  syncPayouts,
  syncPayoutTransactions,
  getPayoutDetails,
  createInstantPayout,
  getCashFlow,
  reconcilePayout,
  generateExport,
};
