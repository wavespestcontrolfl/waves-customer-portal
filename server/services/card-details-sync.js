/**
 * Card details sync (GATE_CARD_DETAILS_SYNC).
 *
 * Stripe's card account updater renews saved cards (new expiry, sometimes a
 * new last four) without telling the portal. payment_methods.exp_month,
 * exp_year, last_four, card_brand and card_funding are written once, at save
 * time (stripe.js savePaymentMethod), so a renewed card kept its old expiry
 * and Auto Pay refused it as expired.
 *
 *   applyStripeCardDetails(pm, { source })  one Stripe PaymentMethod -> every
 *                                           card row that holds it
 *   syncNearExpiryCards()                   daily safety net for the cards
 *                                           the portal reads as expired or
 *                                           expiring soon
 *
 * Sends nothing to a customer. Never log a PaymentMethod object: log row ids
 * and the names of the fields that changed.
 */

const defaultDb = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { isBankMethodType } = require('./autopay-eligibility');
const { auditCardDetailsSynced } = require('./audit-log');

// Expiry within this many months of the current ET month is inside the
// 60-day warning window (and the Auto Pay walk), so it is worth re-reading.
const WINDOW_MONTHS = 2;

// Gate read lazily: several suites mock feature-gates wholesale, and a
// missing property just means "off".
function gateOn() {
  return require('../config/feature-gates').gates?.cardDetailsSync === true;
}

// Same normalization isExpiredCardMethod uses: legacy rows hold 2-digit years.
function normalizedExpiry(month, year) {
  const m = Number(month);
  const rawYear = Number(year);
  const y = Number.isFinite(rawYear) && rawYear > 0 && rawYear < 100 ? rawYear + 2000 : rawYear;
  if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y)) return null;
  return { month: m, year: y };
}

function expiryLabel(expiry) {
  if (!expiry) return null;
  return `${String(expiry.month).padStart(2, '0')}/${expiry.year}`;
}

function cardPatch(pm, row) {
  const card = pm.card;
  const patch = {};
  const fields = [];
  const stored = normalizedExpiry(row.exp_month, row.exp_year);
  const next = normalizedExpiry(card.exp_month, card.exp_year);
  if (next && (!stored || stored.month !== next.month || stored.year !== next.year)) {
    patch.exp_month = String(card.exp_month).padStart(2, '0');
    patch.exp_year = String(card.exp_year);
    fields.push('expiry');
  }
  if (card.last4 && String(row.last_four || '') !== String(card.last4)) {
    patch.last_four = card.last4;
    fields.push('last_four');
  }
  const brand = card.brand ? String(card.brand).toUpperCase() : null;
  if (brand && String(row.card_brand || '').toUpperCase() !== brand) {
    patch.card_brand = brand;
    fields.push('brand');
  }
  // Funding drives the card surcharge (credit only). Follow Stripe, but never
  // null a stored value because Stripe returned none.
  if (card.funding && row.card_funding !== card.funding) {
    patch.card_funding = card.funding;
    patch.card_funding_checked_at = new Date();
    fields.push('funding');
  }
  return { patch, fields, stored, next };
}

// The account updater can replace the card NUMBER. Payment history shows each payment's own brand and last-four
// snapshot first (StripeService.getPaymentHistory, Customer 360), so before a saved card's brand or last four changes,
// a linked payment that never got a snapshot is given the details it was made with. Fill-only, like the payment_methods
// delete trigger (migration 20260924000032, payments_snapshot_removed_method): a value a payment carries stays.
async function preservePaymentSnapshots(knex, row) {
  const fill = {};
  if (row.last_four) fill.card_last_four = knex.raw('COALESCE(card_last_four, ?)', [row.last_four]);
  if (row.card_brand) fill.card_brand = knex.raw('COALESCE(card_brand, ?)', [row.card_brand]);
  if (!Object.keys(fill).length) return;
  await knex('payments')
    .where({ payment_method_id: row.id })
    .where((q) => q.whereNull('card_last_four').orWhereNull('card_brand'))
    .update(fill);
}

async function applyStripeCardDetails(pm, { source = 'webhook', database } = {}) {
  if (!pm || pm.type !== 'card' || !pm.card || !pm.id) return { updated: 0 };
  const knex = database || defaultDb;
  const rows = await knex('payment_methods')
    .where({ stripe_payment_method_id: pm.id })
    .select('id', 'method_type', 'exp_month', 'exp_year', 'last_four', 'card_brand', 'card_funding');
  let updated = 0;
  for (const row of rows) {
    if (isBankMethodType(row.method_type)) continue;
    const { patch, fields, stored, next } = cardPatch(pm, row);
    if (!fields.length) continue;
    // updated_at stays as it is: the Auto Pay fallback walk (stripe.js, autopay-eligibility.js) orders duplicate
    // default cards by it, and the unanswered-reply check reads it as an account change. A detail refresh must not
    // move either; the audit row records when it ran.
    if (patch.last_four || patch.card_brand) await preservePaymentSnapshots(knex, row);
    const count = await knex('payment_methods')
      .where({ id: row.id, stripe_payment_method_id: pm.id })
      .update(patch);
    if (!count) continue;
    updated += 1;
    logger.info(`[card-details-sync] row ${row.id} refreshed from Stripe (${source}): ${fields.join(', ')}`);
    try {
      await auditCardDetailsSynced({
        payment_method_row_id: row.id,
        source,
        changed_fields: fields,
        old_expiry: expiryLabel(stored),
        new_expiry: expiryLabel(next),
      });
    } catch (err) {
      logger.warn(`[card-details-sync] audit write failed for row ${row.id}: ${err.message}`);
    }
  }
  return { updated };
}

function inRefreshWindow(row, now) {
  const expiry = normalizedExpiry(row.exp_month, row.exp_year);
  if (!expiry) return true;
  const [curYear, curMonth] = etDateString(now).split('-').map(Number);
  return expiry.year * 12 + expiry.month <= curYear * 12 + curMonth + WINDOW_MONTHS;
}

// One Stripe card. Returns { updated, detached, error } counters.
async function syncOneCard(pmId, knex) {
  const pm = await require('./stripe').retrievePaymentMethod(pmId);
  if (!pm) return { error: 1 };
  if (!pm.customer) return { detached: 1 };
  const { updated } = await applyStripeCardDetails(pm, { source: 'daily_sync', database: knex });
  return { updated };
}

async function syncNearExpiryCards({ now = new Date(), database } = {}) {
  if (!gateOn()) return { skipped: 'gate_off' };
  const knex = database || defaultDb;
  const rows = await knex('payment_methods')
    .where({ processor: 'stripe' })
    .whereNotNull('stripe_payment_method_id')
    .select('id', 'method_type', 'stripe_payment_method_id', 'exp_month', 'exp_year');
  const ids = new Set();
  for (const row of rows) {
    if (!isBankMethodType(row.method_type) && inRefreshWindow(row, now)) {
      ids.add(row.stripe_payment_method_id);
    }
  }
  const totals = { checked: 0, updated: 0, detached: 0, errors: 0 };
  for (const pmId of ids) {
    totals.checked += 1;
    try {
      const result = await syncOneCard(pmId, knex);
      totals.updated += result.updated || 0;
      totals.detached += result.detached || 0;
      totals.errors += result.error || 0;
    } catch (err) {
      totals.errors += 1;
      logger.warn(`[card-details-sync] Stripe lookup failed: ${err.message}`);
    }
  }
  return totals;
}

module.exports = { applyStripeCardDetails, syncNearExpiryCards };
