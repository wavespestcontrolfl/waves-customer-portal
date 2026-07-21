/**
 * Stripe Banking & Cash Flow Service
 * server/services/stripe-banking.js
 *
 * Syncs payouts from Stripe, provides cash flow analysis,
 * reconciliation tools, and manual payout support.
 */

const Stripe = require('stripe');
const stripeConfig = require('../config/stripe-config');
const db = require('../models/db');
const logger = require('./logger');
const BankingExport = require('./banking-export');

const INSTANT_PAYOUT_FEE_RATE_US = 0.015;
const PAYOUT_ATTEMPT_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

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

function nonPiiActorId(value) {
  const actor = String(value || '').trim();
  if (!actor) return null;
  if (actor.includes('@') || /\s/.test(actor)) return 'admin';
  return actor.slice(0, 120);
}

function payoutAmountError() {
  const err = new Error('Payout amount must be a positive dollar amount with at most 2 decimal places');
  err.status = 400;
  return err;
}

function parsePayoutAmountCents(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw payoutAmountError();
  }

  const [dollarPart, centPart = ''] = raw.split('.');
  const amountCents = (Number(dollarPart) * 100) + Number(centPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw payoutAmountError();
  }
  return amountCents;
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
    // `instant_available` is only populated for accounts with Instant Payouts
    // enabled and is a separate, typically-smaller bucket than `available`.
    const instantAvailable = (balance.instant_available || []).map(b => ({
      currency: b.currency,
      amount: b.amount / 100,
    }));

    // Get next active payout. Stripe's list filter accepts `pending`, but not
    // `in_transit`, so query pending directly and page through recent payouts
    // for in-transit rows.
    let nextPayout = null;
    try {
      const activePayouts = [];
      const seenPayoutIds = new Set();
      const addActivePayout = (p) => {
        if (!p || seenPayoutIds.has(p.id)) return;
        if (!['pending', 'in_transit'].includes(p.status)) return;
        seenPayoutIds.add(p.id);
        activePayouts.push(p);
      };

      const pendingPayouts = await stripe.payouts.list({ limit: 100, status: 'pending' });
      pendingPayouts.data.forEach(addActivePayout);

      let startingAfter = null;
      for (let page = 0; page < 5; page += 1) {
        const params = { limit: 100 };
        if (startingAfter) params.starting_after = startingAfter;
        const payouts = await stripe.payouts.list(params);
        payouts.data.forEach(addActivePayout);
        if (!payouts.has_more || !payouts.data.length) break;
        startingAfter = payouts.data[payouts.data.length - 1].id;
      }

      const p = activePayouts
        .sort((a, b) => (a.arrival_date || 0) - (b.arrival_date || 0))[0];
      if (p) {
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
      instant_available: instantAvailable,
      total_available: available.reduce((s, b) => s + b.amount, 0),
      total_pending: pending.reduce((s, b) => s + b.amount, 0),
      total_instant_available: instantAvailable.reduce((s, b) => s + b.amount, 0),
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

        // Per-payout transaction listing ONLY works for automatic payouts —
        // Stripe rejects it for manual ones ("can only be filtered on
        // automatic transfers"), and every payout on this account is manual.
        // Manual-payout transactions arrive via syncBalanceTransactions.
        if (p.status === 'paid' && p.automatic === true) {
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

    // Refresh payouts stuck in a non-terminal LOCAL status: the forward-only
    // watermark never revisits a payout first observed as pending/in-transit,
    // so without this its local row would stay non-paid forever.
    try {
      const REFRESH_PER_RUN = 25;
      const nonTerminal = await db('stripe_payouts')
        .whereNotIn('status', ['paid', 'canceled', 'failed'])
        .orderBy('created_at_stripe', 'desc')
        .limit(REFRESH_PER_RUN)
        .select('stripe_payout_id');
      for (const row of nonTerminal) {
        try {
          const p = await stripe.payouts.retrieve(row.stripe_payout_id);
          await db('stripe_payouts')
            .where('stripe_payout_id', row.stripe_payout_id)
            .update({
              status: p.status,
              arrival_date: p.arrival_date ? new Date(p.arrival_date * 1000).toISOString() : null,
              failure_message: p.failure_message || null,
              synced_at: new Date().toISOString(),
            });
        } catch (err) {
          logger.warn(`[stripe-banking] Status refresh failed for ${row.stripe_payout_id}:`, err.message);
        }
      }
    } catch (err) {
      logger.warn('[stripe-banking] Payout status refresh pass failed:', err.message);
    }

    // The refund/dispute/fee ledger itself syncs GLOBALLY (see
    // syncBalanceTransactions) — the old per-payout backfill pass could
    // never work here because Stripe refuses per-payout transaction listing
    // for manual payouts, which is all this account creates.
    const balance = await syncBalanceTransactions();

    return { synced, balance, has_more: hasMore };
  } catch (err) {
    logger.error('[stripe-banking] syncPayouts failed:', err.message);
    throw err;
  }
}


// ═══════════════════════════════════════════════════════════════
// SYNC PAYOUT TRANSACTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Batch-resolve local payments/customers for a set of Stripe balance
 * transactions (avoids N+1). Shared by the per-payout and global syncs.
 * Returns { paymentsBySource, customersById }.
 */
async function resolveTxnLinkMaps(transactionRows) {
  const chargeSources = transactionRows
    .map(t => (typeof t.source === 'string' && t.source.startsWith('ch_')) ? t.source : null)
    .filter(Boolean);
  const paymentsBySource = new Map();
  const customersById = new Map();
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
  return { paymentsBySource, customersById };
}

/** One insertable stripe_payout_transactions row from a Stripe balance txn. */
function txnRowFromStripe(txn, { paymentsBySource, customersById }, payoutId = null) {
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
  return {
    payout_id: payoutId,
    stripe_txn_id: txn.id,
    type: txn.type,
    // Canonical classification — required to tell dispute movements
    // (reporting_category dispute/dispute_reversal, carried under the
    // umbrella type 'adjustment') apart from unrelated adjustments.
    reporting_category: txn.reporting_category || null,
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
  };
}

/**
 * GLOBAL balance-transaction sync — the authoritative feed for the
 * refund/dispute/fee ledger. Stripe refuses per-payout transaction listing
 * for MANUAL payouts (all this account creates), so the ledger syncs from
 * the account's balance-transaction stream instead: watermarked on the
 * transaction `created` timestamp, upserted by stripe_txn_id (unique index
 * from migration 20260721000002), payout_id left NULL (manual payouts carry
 * no linkage). Rows therefore appear as soon as the money moves — not when
 * a payout later settles.
 */
async function syncBalanceTransactions(limit = 100) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');

  // Coverage honesty: the P&L treats last_sync_at as "the ledger is current
  // through this moment", so it must be the time the sync STARTED — pages
  // are read from that instant's view of the stream, and a run that
  // straddles ET midnight would otherwise claim a day it never re-read.
  const syncStartedAt = new Date();

  let watermark = 0;
  let resumeCursor = null;
  try {
    const syncState = await db('stripe_sync_state')
      .where('sync_type', 'balance_transactions')
      .first();
    if (syncState?.last_created_at) {
      watermark = Math.floor(new Date(syncState.last_created_at).getTime() / 1000);
    }
    // A prior run that hit the page cap left a resume cursor (a Stripe txn
    // id): continue paging DEEPER from it instead of refetching the same
    // newest pages forever.
    if (syncState?.cursor && String(syncState.cursor).startsWith('txn_')) {
      resumeCursor = String(syncState.cursor);
    }
  } catch { /* table may not exist yet */ }

  const rows = [];
  let startingAfter = resumeCursor;
  let hasMore = true;
  const MAX_PAGES = 200;
  for (let pageIdx = 0; pageIdx < MAX_PAGES && hasMore; pageIdx++) {
    const page = await stripe.balanceTransactions.list({
      limit,
      // gte, not gt: Stripe timestamps are second-granular, so a later
      // transaction can share the watermark second — an exclusive filter
      // would skip it forever. The 1-second overlap is deduped by the
      // stripe_txn_id upsert.
      ...(watermark > 0 ? { created: { gte: watermark } } : {}),
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    rows.push(...(page.data || []));
    hasMore = !!page.has_more;
    startingAfter = page.data?.length ? page.data[page.data.length - 1].id : null;
    if (!startingAfter) break;
  }

  let upserted = 0;
  let newestCreated = watermark;
  if (rows.length) {
    const linkMaps = await resolveTxnLinkMaps(rows);
    // Merge every column EXCEPT payout_id: the global stream carries no
    // payout linkage (null), and blindly merging null would erase linkage
    // previously written by the per-payout sync for automatic payouts.
    const MERGE_COLS = [
      'type', 'reporting_category', 'amount', 'fee', 'net', 'description',
      'customer_name', 'customer_id', 'invoice_id', 'payment_id',
      'available_on', 'created_at_stripe',
    ];
    for (const txn of rows) {
      if (txn.created && txn.created > newestCreated) newestCreated = txn.created;
      await db('stripe_payout_transactions')
        .insert(txnRowFromStripe(txn, linkMaps, null))
        .onConflict('stripe_txn_id')
        .merge(MERGE_COLS);
      upserted++;
    }
  }

  // Persist state. Pages arrive newest-first, so:
  // - EXHAUSTED run: the range is fully covered — advance the watermark,
  //   stamp last_sync_at (as the START time, see above), clear any cursor.
  // - CAP-HIT run: the OLDEST part of the range is still unfetched. Never
  //   advance the watermark or last_sync_at (coverage must keep saying
  //   "not done"), but SAVE the deep-page cursor so the next run resumes
  //   where this one stopped instead of refetching the same newest pages
  //   forever. Upserted rows are kept either way (idempotent).
  try {
    const existing = await db('stripe_sync_state')
      .where('sync_type', 'balance_transactions')
      .first();
    const patch = hasMore
      ? { cursor: startingAfter }
      : {
        last_sync_at: syncStartedAt.toISOString(),
        cursor: null,
        ...(newestCreated > watermark
          ? { last_created_at: new Date(newestCreated * 1000).toISOString() }
          : {}),
      };
    if (existing) {
      await db('stripe_sync_state').where('sync_type', 'balance_transactions').update(patch);
    } else {
      await db('stripe_sync_state').insert({ sync_type: 'balance_transactions', ...patch });
    }
  } catch (err) {
    logger.warn('[stripe-banking] Could not update balance-transaction sync state:', err.message);
  }
  if (hasMore) {
    logger.warn(`[stripe-banking] Balance-transaction sync hit the ${MAX_PAGES}-page cap — resume cursor saved; run Sync again to continue`);
  }

  if (upserted > 0) logger.info(`[stripe-banking] Balance-transaction sync upserted ${upserted} row(s)`);
  return { upserted, has_more: hasMore };
}

/**
 * Fetch balance transactions for a specific payout and store them.
 * AUTOMATIC payouts only — Stripe rejects the payout filter for manual
 * payouts; those flow through syncBalanceTransactions instead.
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
    const transactionRows = [];
    let startingAfter = null;
    let hasMore = true;
    const MAX_PAGES = 100;
    for (let pageIdx = 0; pageIdx < MAX_PAGES && hasMore; pageIdx++) {
      const page = await stripe.balanceTransactions.list({
        payout: stripePayoutId,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      transactionRows.push(...(page.data || []));
      hasMore = !!page.has_more;
      startingAfter = page.data?.length ? page.data[page.data.length - 1].id : null;
      if (!startingAfter) break;
    }
    if (hasMore) {
      logger.warn(`[stripe-banking] Payout ${stripePayoutId} transaction sync hit ${MAX_PAGES} page safety cap`);
    }

    const linkMaps = await resolveTxnLinkMaps(transactionRows);
    const txnInserts = transactionRows.map(txn => txnRowFromStripe(txn, linkMaps, payout.id));
    const totalFees = txnInserts.reduce((s, r) => s + (Number(r.fee) || 0), 0);
    const txnCount = txnInserts.length;

    // Atomic swap: delete + upsert + update payout inside one DB transaction.
    // The insert is an UPSERT on stripe_txn_id (unique index): the global
    // balance sync may already hold these rows with payout_id NULL — a plain
    // insert would conflict, and the delete-by-payout_id above can't see
    // unlinked rows. The full merge here (payout_id included) RESTORES the
    // payout linkage for automatic payouts.
    await db.transaction(async (trx) => {
      await trx('stripe_payout_transactions').where('payout_id', payout.id).del();
      if (txnInserts.length) {
        for (const row of txnInserts) {
          await trx('stripe_payout_transactions')
            .insert(row)
            .onConflict('stripe_txn_id')
            .merge();
        }
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
// CREATE MANUAL PAYOUTS
// ═══════════════════════════════════════════════════════════════

function validatePayoutAttemptMatches(row, { method, amountCents }) {
  if (!row) return;
  if (String(row.method) !== method || Number(row.amount_cents) !== amountCents) {
    const err = new Error('Idempotency key reused with a different payout request');
    err.status = 409;
    throw err;
  }
}

function stalePayoutAttemptError() {
  const err = new Error('Payout idempotency key has an unresolved prior attempt; verify Stripe before retrying');
  err.status = 409;
  return err;
}

function isPayoutAttemptRetryable(row) {
  if (!row?.created_at) return false;
  const createdAt = new Date(row.created_at).getTime();
  return Number.isFinite(createdAt) && Date.now() - createdAt <= PAYOUT_ATTEMPT_RETRY_WINDOW_MS;
}

async function getPayoutIdempotencyAttempt(idempotencyKey) {
  return db('stripe_payout_idempotency_attempts')
    .where({ idempotency_key: idempotencyKey })
    .first();
}

async function recordPayoutIdempotencyAttempt({ idempotencyKey, method, amountCents, requestedBy }) {
  const now = new Date();
  const [created] = await db('stripe_payout_idempotency_attempts')
    .insert({
      idempotency_key: idempotencyKey,
      method,
      amount_cents: amountCents,
      requested_by: nonPiiActorId(requestedBy),
      status: 'attempted',
      created_at: now,
      updated_at: now,
    })
    .onConflict('idempotency_key')
    .ignore()
    .returning('*');

  if (created) return created;

  const existing = await getPayoutIdempotencyAttempt(idempotencyKey);
  validatePayoutAttemptMatches(existing, { method, amountCents });
  return existing;
}

async function markPayoutIdempotencyAttemptSucceeded(idempotencyKey, payout) {
  await db('stripe_payout_idempotency_attempts')
    .where({ idempotency_key: idempotencyKey })
    .update({
      status: 'succeeded',
      stripe_payout_id: payout.id,
      updated_at: new Date(),
    });
}

async function persistPayoutRecord(payout, method, description) {
  await db('stripe_payouts').insert({
    stripe_payout_id: payout.id,
    amount: payout.amount / 100,
    currency: payout.currency,
    status: payout.status,
    arrival_date: payout.arrival_date ? new Date(payout.arrival_date * 1000).toISOString() : null,
    created_at_stripe: payout.created ? new Date(payout.created * 1000).toISOString() : null,
    method: payout.method || method,
    type: payout.type,
    description: payout.description || description,
    metadata: JSON.stringify(payout.metadata || {}),
    synced_at: new Date().toISOString(),
  }).onConflict('stripe_payout_id').merge();
}

function payoutResponse(payout, method) {
  const amountDollars = payout.amount / 100;
  return {
    payout_id: payout.id,
    amount: amountDollars,
    status: payout.status,
    arrival_date: payout.arrival_date ? new Date(payout.arrival_date * 1000).toISOString() : null,
    method: payout.method || method,
    fee_estimate: method === 'instant' ? amountDollars * INSTANT_PAYOUT_FEE_RATE_US : 0,
  };
}

/**
 * Request a manual payout from Stripe.
 * @param {number} amountDollars — amount in dollars
 * @param {object} opts
 * @param {'standard'|'instant'} opts.method — payout speed
 */
async function createPayout(amountDollars, opts = {}) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');

  try {
    const method = String(opts.method || 'standard').toLowerCase();
    if (!['standard', 'instant'].includes(method)) {
      throw new Error(`Invalid payout method: ${method}`);
    }

    const amountCents = parsePayoutAmountCents(amountDollars);
    const amountDollarsNormalized = amountCents / 100;

    // Idempotency key: collapses retries within the same minute for the same amount.
    // Stripe honors this for 24h; duplicate submissions in that window return the original payout.
    const minuteBucket = Math.floor(Date.now() / 60000);
    const idempotencyPrefix = method === 'instant' ? 'ipo' : 'spo';
    const providedIdempotencyKey = opts.idempotencyKey && /^[a-zA-Z0-9._:-]{8,120}$/.test(String(opts.idempotencyKey))
      ? String(opts.idempotencyKey)
      : null;
    const idempotencyKey = providedIdempotencyKey || `${idempotencyPrefix}_${amountCents}_${minuteBucket}`;
    const existingAttempt = providedIdempotencyKey
      ? await getPayoutIdempotencyAttempt(idempotencyKey)
      : null;
    validatePayoutAttemptMatches(existingAttempt, { method, amountCents });

    const description = method === 'instant' ? 'Instant payout' : 'Standard payout';
    if (existingAttempt?.status === 'succeeded') {
      if (!existingAttempt.stripe_payout_id) {
        throw stalePayoutAttemptError();
      }
      const payout = await stripe.payouts.retrieve(existingAttempt.stripe_payout_id);
      await persistPayoutRecord(payout, method, description);
      return payoutResponse(payout, method);
    }
    if (existingAttempt && !isPayoutAttemptRetryable(existingAttempt)) {
      throw stalePayoutAttemptError();
    }

    const balance = await stripe.balance.retrieve();
    const sumUsdCents = (entries) => (entries || [])
      .filter(b => String(b.currency || '').toLowerCase() === 'usd')
      .reduce((sum, b) => sum + Number(b.amount || 0), 0);
    // Instant payouts draw from `instant_available`, which is a separate bucket
    // from `available` and is typically smaller. Standard payouts draw from `available`.
    // Checking the wrong bucket here lets requests slip through to Stripe and come
    // back as a 400 `balance_insufficient`, surfaced as an opaque HTTP 500 in the UI.
    const guardCents = method === 'instant'
      ? sumUsdCents(balance.instant_available)
      : sumUsdCents(balance.available);
    if (amountCents > guardCents && !existingAttempt) {
      const label = method === 'instant' ? 'Instant payout' : 'Standard payout';
      const bucketLabel = method === 'instant' ? 'instant-available Stripe balance' : 'available Stripe balance';
      const err = new Error(`${label} amount exceeds ${bucketLabel} ($${(guardCents / 100).toFixed(2)})`);
      err.status = 400;
      throw err;
    }

    const actorId = nonPiiActorId(opts.requestedBy);
    const createParams = {
      amount: amountCents,
      currency: 'usd',
      method,
      description,
    };
    if (actorId) {
      createParams.metadata = { waves_requested_by: actorId };
    }

    if (providedIdempotencyKey && !existingAttempt) {
      await recordPayoutIdempotencyAttempt({
        idempotencyKey,
        method,
        amountCents,
        requestedBy: opts.requestedBy,
      });
    }
    const payout = await stripe.payouts.create(createParams, { idempotencyKey });
    if (providedIdempotencyKey) {
      await markPayoutIdempotencyAttemptSucceeded(idempotencyKey, payout);
    }

    await persistPayoutRecord(payout, method, description);

    logger.info(`[stripe-banking] ${method} payout created: $${amountDollarsNormalized}, payout ${payout.id}, requestedBy=${actorId || 'unknown'}`);

    return payoutResponse(payout, method);
  } catch (err) {
    logger.error('[stripe-banking] createPayout failed:', err.message);
    // Stripe SDK errors expose `statusCode`; copy onto `.status` so route
    // handlers (which read `err.status`) propagate 4xx instead of falling
    // back to 500.
    if (err && err.status == null && Number.isFinite(err.statusCode)) {
      err.status = err.statusCode;
    }
    throw err;
  }
}

async function createInstantPayout(amountDollars, opts = {}) {
  return createPayout(amountDollars, { ...opts, method: 'instant' });
}

async function createStandardPayout(amountDollars, opts = {}) {
  return createPayout(amountDollars, { ...opts, method: 'standard' });
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
    // Same status rule as the export: failed/canceled payouts never reached
    // the bank, so counting them under-/over-states daily cash.
    const payoutRows = await db('stripe_payouts')
      .where({ status: 'paid' })
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
      if (!dailyMap[d]) dailyMap[d] = { date: d, revenue: 0, expenses: 0, fees: 0, payouts: 0 };
      dailyMap[d].revenue += parseFloat(r.total || 0);
    });
    expenseRows.forEach(r => {
      const d = typeof r.date === 'string' ? r.date : new Date(r.date).toISOString().split('T')[0];
      if (!dailyMap[d]) dailyMap[d] = { date: d, revenue: 0, expenses: 0, fees: 0, payouts: 0 };
      dailyMap[d].expenses += parseFloat(r.total || 0);
    });
    const feeDailyRows = await db('stripe_payout_transactions')
      .whereBetween('created_at_stripe', [startDate, endDate + 'T23:59:59'])
      .select(
        db.raw("DATE(created_at_stripe AT TIME ZONE ?) as date", [process.env.BUSINESS_TIMEZONE || 'America/New_York']),
        db.raw('COALESCE(SUM(fee), 0) as total'),
      )
      .groupBy(db.raw("DATE(created_at_stripe AT TIME ZONE ?)", [process.env.BUSINESS_TIMEZONE || 'America/New_York']))
      .orderBy('date')
      .catch((e) => { logger.error('[stripe-banking] cash-flow daily fee query failed:', e); return []; });
    feeDailyRows.forEach(r => {
      const d = typeof r.date === 'string' ? r.date : new Date(r.date).toISOString().split('T')[0];
      if (!dailyMap[d]) dailyMap[d] = { date: d, revenue: 0, expenses: 0, fees: 0, payouts: 0 };
      dailyMap[d].fees = (dailyMap[d].fees || 0) + parseFloat(r.total || 0);
    });
    payoutRows.forEach(r => {
      const d = typeof r.date === 'string' ? r.date : new Date(r.date).toISOString().split('T')[0];
      if (!dailyMap[d]) dailyMap[d] = { date: d, revenue: 0, expenses: 0, fees: 0, payouts: 0 };
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
        // Same status='paid' rule as the daily rows above — summary totals
        // and the daily breakdown must reconcile.
        .where({ status: 'paid' })
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
    if (!Number.isFinite(Number(actualAmount))) {
      throw new Error('Invalid actual amount');
    }

    const expectedAmount = parseFloat(payout.amount || 0);
    const normalizedActual = Number(actualAmount);
    const discrepancy = Math.round((normalizedActual - expectedAmount) * 100) / 100;
    const matched = Math.abs(discrepancy) < 0.01;
    const now = new Date().toISOString();

    await db.transaction(async (trx) => {
      const reconRow = {
        payout_id: payoutId,
        expected_amount: expectedAmount,
        actual_amount: normalizedActual,
        matched,
        discrepancy,
        notes,
        status,
        reconciled_at: now,
        reconciled_by: reconciledBy,
      };
      await trx('bank_reconciliation').insert(reconRow);

      // Only 'confirmed' flips the payout flag; 'rejected' un-reconciles it.
      await trx('stripe_payouts').where('id', payoutId).update({
        reconciled: status === 'confirmed',
        reconciled_at: status === 'confirmed' ? now : null,
        reconciled_by: status === 'confirmed' ? reconciledBy : null,
      });
    });

    logger.info(`[stripe-banking] Payout ${payoutId} reconciliation=${status}: expected=$${expectedAmount}, actual=$${normalizedActual}, matched=${matched}`);

    return {
      payout_id: payoutId,
      expected_amount: expectedAmount,
      actual_amount: normalizedActual,
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
    // Only payouts that actually reached the bank: failed/canceled payouts
    // carry arrival dates too, and OFX sums LEDGERBAL with no status field —
    // exporting a failed payout beside its replacement makes the books
    // unreconcilable. Mirrors the /stats status filter.
    const payouts = await db('stripe_payouts')
      .where({ status: 'paid' })
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
  syncBalanceTransactions,
  upsertPayoutFromEvent,
  getPayoutDetails,
  createPayout,
  createInstantPayout,
  createStandardPayout,
  getCashFlow,
  reconcilePayout,
  generateExport,
};
