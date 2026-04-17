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
const BankingExport = require('./banking-export');

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
  _stripe = new Stripe(stripeConfig.secretKey, { apiVersion: stripeConfig.apiVersion });
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
    // Watermark: only fetch payouts newer than what we've already seen.
    // (Stripe returns newest-first, so `starting_after` is the wrong tool here —
    // it walks backwards in time and skips new payouts forever.)
    let watermark = 0;
    try {
      const syncState = await db('stripe_sync_state')
        .where('sync_type', 'payouts')
        .first();
      if (syncState?.last_created_at) {
        watermark = Math.floor(new Date(syncState.last_created_at).getTime() / 1000);
      }
    } catch { /* table may not exist yet */ }

    let synced = 0;
    let lastPayoutId = null;
    let newestCreated = watermark;
    let hasMore = true;
    let startingAfter = null;
    const MAX_PAGES = 20; // Safety cap: 20 × limit payouts per sync run

    for (let pageIdx = 0; pageIdx < MAX_PAGES && hasMore; pageIdx++) {
      const listParams = { limit };
      if (watermark > 0) listParams.created = { gt: watermark };
      if (startingAfter) listParams.starting_after = startingAfter;

      const page = await stripe.payouts.list(listParams);
      hasMore = page.has_more;
      startingAfter = page.data.length ? page.data[page.data.length - 1].id : null;
      if (!page.data.length) break;

      for (const p of page.data) {
        lastPayoutId = p.id;
        if (p.created && p.created > newestCreated) newestCreated = p.created;

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

        // Atomic upsert — eliminates race between webhook and periodic sync.
        await db('stripe_payouts')
          .insert(record)
          .onConflict('stripe_payout_id')
          .merge();

        if (p.status === 'paid') {
          try {
            await syncPayoutTransactions(p.id);
          } catch (err) {
            logger.warn(`[stripe-banking] Transaction sync failed for ${p.id}:`, err.message);
          }
        }

        synced++;
      }
    }

    // Persist watermark (highest `created` timestamp seen)
    if (newestCreated > watermark) {
      try {
        const existing = await db('stripe_sync_state')
          .where('sync_type', 'payouts')
          .first();

        const newestISO = new Date(newestCreated * 1000).toISOString();
        const patch = {
          last_sync_at: new Date().toISOString(),
          last_payout_id: lastPayoutId,
          last_created_at: newestISO,
          cursor: newestISO,
        };

        if (existing) {
          await db('stripe_sync_state').where('sync_type', 'payouts').update(patch);
        } else {
          await db('stripe_sync_state').insert({ sync_type: 'payouts', ...patch });
        }
      } catch (err) {
        logger.warn('[stripe-banking] Could not update sync state:', err.message);
      }
    }

    if (synced > 0) logger.info(`[stripe-banking] Synced ${synced} payouts across ${Math.min(MAX_PAGES, Math.ceil(synced / limit) || 1)} page(s)`);
    return { synced, has_more: hasMore };
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
    // Fetch all balance transactions from Stripe BEFORE touching local DB.
    // If the API call fails, the existing local rows are left intact.
    const transactions = await stripe.balanceTransactions.list({
      payout: stripePayoutId,
      limit: 100,
    });

    let totalFees = 0;
    let txnCount = 0;

    // Batch-resolve local payments/customers to avoid N+1.
    const chargeSources = transactions.data
      .map(t => (typeof t.source === 'string' && t.source.startsWith('ch_')) ? t.source : null)
      .filter(Boolean);

    let paymentsBySource = new Map();
    let customersById = new Map();
    if (chargeSources.length) {
      try {
        const payments = await db('payments')
          .whereIn('stripe_charge_id', chargeSources)
          .orWhereIn('stripe_payment_intent_id', chargeSources);
        for (const pay of payments) {
          if (pay.stripe_charge_id) paymentsBySource.set(pay.stripe_charge_id, pay);
          if (pay.stripe_payment_intent_id) paymentsBySource.set(pay.stripe_payment_intent_id, pay);
        }

        const customerIds = [...new Set(payments.map(p => p.customer_id).filter(Boolean))];
        if (customerIds.length) {
          const customers = await db('customers')
            .whereIn('id', customerIds)
            .select('id', 'first_name', 'last_name');
          for (const c of customers) customersById.set(c.id, c);
        }
      } catch (err) {
        logger.warn('[stripe-banking] Batch payment/customer lookup failed:', err.message);
      }
    }

    const txnInserts = [];
    for (const txn of transactions.data) {
      let customerId = null;
      let customerName = null;
      let invoiceId = null;
      let paymentId = null;

      const payment = (typeof txn.source === 'string') ? paymentsBySource.get(txn.source) : null;
      if (payment) {
        paymentId = payment.id;
        customerId = payment.customer_id;

        if (customerId) {
          const customer = customersById.get(customerId);
          if (customer) customerName = `${customer.first_name} ${customer.last_name}`;
        }

        try {
          const meta = typeof payment.metadata === 'string'
            ? JSON.parse(payment.metadata)
            : payment.metadata;
          if (meta && meta.invoice_id) invoiceId = meta.invoice_id;
        } catch { /* metadata parse failure — non-critical */ }
      }

      txnInserts.push({
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

    // Atomic swap: delete + insert + update payout inside a single DB transaction
    await db.transaction(async (trx) => {
      await trx('stripe_payout_transactions').where('payout_id', payout.id).del();
      if (txnInserts.length) {
        await trx('stripe_payout_transactions').insert(txnInserts);
      }
      await trx('stripe_payouts')
        .where('id', payout.id)
        .update({
          fee_total: totalFees,
          transaction_count: txnCount,
        });
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

    // Idempotency key: collapses retries within the same minute for the same amount.
    // Stripe honors this for 24h; duplicate submissions in that window return the original payout.
    const minuteBucket = Math.floor(Date.now() / 60000);
    const idempotencyKey = `ipo_${amountCents}_${minuteBucket}`;

    const payout = await stripe.payouts.create(
      { amount: amountCents, currency: 'usd', method: 'instant' },
      { idempotencyKey },
    );

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
      .catch((e) => { logger.error('[stripe-banking] cash-flow revenue query failed:', e); return []; });

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
      .catch((e) => { logger.error('[stripe-banking] cash-flow expense query failed:', e); return []; });

    // Stripe fees from payout transactions
    const feeRows = await db('stripe_payout_transactions')
      .whereBetween('created_at_stripe', [startDate, endDate + 'T23:59:59'])
      .select(db.raw('COALESCE(SUM(fee), 0) as total_fees'))
      .first()
      .catch((e) => { logger.error('[stripe-banking] cash-flow fee query failed:', e); return { total_fees: 0 }; });

    // Payouts — bucket by business-local day (ET) so late-evening payouts
    // don't roll into "tomorrow" under a UTC session timezone.
    const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE || 'America/New_York';
    const payoutRows = await db('stripe_payouts')
      .whereBetween('arrival_date', [startDate, endDate + 'T23:59:59'])
      .select(
        db.raw("DATE(arrival_date AT TIME ZONE ?) as date", [BUSINESS_TZ]),
        db.raw('SUM(amount) as total'),
        db.raw('COUNT(*) as count'),
      )
      .groupBy(db.raw("DATE(arrival_date AT TIME ZONE ?)", [BUSINESS_TZ]))
      .orderBy('date')
      .catch((e) => { logger.error('[stripe-banking] cash-flow payout query failed:', e); return []; });

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

    // Summary totals — compute in SQL with NUMERIC to avoid float accumulation drift,
    // then parse once at the edge.
    const [revTot, expTot, payTot] = await Promise.all([
      db('payments')
        .where('status', 'paid')
        .whereBetween('payment_date', [startDate, endDate])
        .select(db.raw("COALESCE(SUM(amount)::text, '0') as total, COUNT(*)::int as count"))
        .first()
        .catch(() => ({ total: '0', count: 0 })),
      db('expenses')
        .whereBetween('expense_date', [startDate, endDate])
        .select(db.raw("COALESCE(SUM(amount)::text, '0') as total"))
        .first()
        .catch(() => ({ total: '0' })),
      db('stripe_payouts')
        .whereBetween('arrival_date', [startDate, endDate + 'T23:59:59'])
        .select(db.raw("COALESCE(SUM(amount)::text, '0') as total, COUNT(*)::int as count"))
        .first()
        .catch(() => ({ total: '0', count: 0 })),
    ]);

    const totalRevenue = parseFloat(revTot?.total ?? '0');
    const totalExpenses = parseFloat(expTot?.total ?? '0');
    const totalFees = parseFloat(feeRows?.total_fees ?? 0);
    const totalPayouts = parseFloat(payTot?.total ?? '0');
    const paymentCount = parseInt(revTot?.count ?? 0);
    const payoutCount = parseInt(payTot?.count ?? 0);

    // Two views of "cash flow":
    //   operating_cash_flow = revenue earned − expenses paid − Stripe fees
    //     (how much the business generated this period, ignoring bank-transfer timing)
    //   bank_balance_delta  = payouts deposited − expenses paid
    //     (how much the bank balance actually changed this period)
    const operatingCashFlow = totalRevenue - totalExpenses - totalFees;
    const bankBalanceDelta = totalPayouts - totalExpenses;

    return {
      period: { start: startDate, end: endDate },
      summary: {
        total_revenue: Math.round(totalRevenue * 100) / 100,
        total_expenses: Math.round(totalExpenses * 100) / 100,
        stripe_fees: Math.round(totalFees * 100) / 100,
        total_payouts: Math.round(totalPayouts * 100) / 100,
        operating_cash_flow: Math.round(operatingCashFlow * 100) / 100,
        bank_balance_delta: Math.round(bankBalanceDelta * 100) / 100,
        // Back-compat alias — prefer the two explicit fields above.
        net_cash_flow: Math.round(operatingCashFlow * 100) / 100,
        payment_count: paymentCount,
        payout_count: payoutCount,
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
async function reconcilePayout(payoutId, actualAmount, notes, reconciledBy, status = 'confirmed') {
  try {
    const payout = await db('stripe_payouts').where('id', payoutId).first();
    if (!payout) throw new Error('Payout not found');

    const allowedStatuses = ['draft', 'confirmed', 'rejected'];
    if (!allowedStatuses.includes(status)) {
      throw new Error(`Invalid reconciliation status: ${status}`);
    }

    const expectedAmount = parseFloat(payout.amount || 0);
    const discrepancy = Math.round((actualAmount - expectedAmount) * 100) / 100;
    const matched = Math.abs(discrepancy) < 0.01;
    const now = new Date().toISOString();

    await db.transaction(async (trx) => {
      const existing = await trx('bank_reconciliation').where('payout_id', payoutId).first();
      const reconRow = {
        expected_amount: expectedAmount,
        actual_amount: actualAmount,
        matched,
        discrepancy,
        notes,
        status,
        reconciled_at: now,
        reconciled_by: reconciledBy,
      };
      if (existing) {
        await trx('bank_reconciliation').where('payout_id', payoutId).update(reconRow);
      } else {
        await trx('bank_reconciliation').insert({ payout_id: payoutId, ...reconRow });
      }

      // Only 'confirmed' flips the payout flag; 'rejected' un-reconciles it.
      await trx('stripe_payouts').where('id', payoutId).update({
        reconciled: status === 'confirmed',
        reconciled_at: status === 'confirmed' ? now : null,
        reconciled_by: status === 'confirmed' ? reconciledBy : null,
      });
    });

    logger.info(`[stripe-banking] Payout ${payoutId} reconciliation=${status}: expected=$${expectedAmount}, actual=$${actualAmount}, matched=${matched}`);

    return {
      payout_id: payoutId,
      expected_amount: expectedAmount,
      actual_amount: actualAmount,
      discrepancy,
      matched,
      status,
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


/**
 * Upsert a single payout directly from a Stripe webhook event object.
 * Used by webhook handler to guarantee the specific payout is recorded
 * without depending on page ordering in a generic sync.
 */
async function upsertPayoutFromEvent(p) {
  if (!p || !p.id) throw new Error('upsertPayoutFromEvent: missing payout');

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
    bank_name: p.destination && typeof p.destination === 'object' ? p.destination.bank_name : null,
    bank_last_four: p.destination && typeof p.destination === 'object' ? p.destination.last4 : null,
    metadata: JSON.stringify(p.metadata || {}),
    synced_at: new Date().toISOString(),
  };

  await db('stripe_payouts').insert(record).onConflict('stripe_payout_id').merge();

  if (p.status === 'paid') {
    try { await syncPayoutTransactions(p.id); }
    catch (err) { logger.warn(`[stripe-banking] Txn sync failed for ${p.id}:`, err.message); }
  }

  return { stripe_payout_id: p.id, status: p.status };
}

module.exports = {
  getBalance,
  syncPayouts,
  syncPayoutTransactions,
  upsertPayoutFromEvent,
  getPayoutDetails,
  createInstantPayout,
  getCashFlow,
  reconcilePayout,
  generateExport,
};
