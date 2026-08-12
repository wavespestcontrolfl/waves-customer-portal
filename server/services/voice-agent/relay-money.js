/**
 * Voice-relay Phase D — money surfaces: get_open_estimates and
 * get_invoice_history. READ-ONLY, gated (VOICE_RELAY_CONTEXT_ENABLED, checked
 * in relay-tools before either body runs). NOTHING here moves money, mints a
 * link, or emits a token.
 *
 * SENT-PRICE DOCTRINE (owner ruling): a sent estimate is quoted at the price
 * it was SENT at. This module therefore reads ONLY persisted values — the
 * estimates row's own saved totals (monthly_total / annual_total /
 * onetime_total, written by the admin save/send flow) and the frozen
 * estimate_data.sendSnapshot.pricingBundle the send flow stamps
 * (routes/admin-estimates.js buildEstimateSendSnapshot) — and NEVER calls the
 * pricing engine or any re-derivation path. buildPricingBundle,
 * generateEstimate and friends are deliberately absent from this file; a test
 * asserts the engine is never invoked.
 *
 * TOKENS NEVER LEAVE THEIR CHANNEL (house rule): estimates.token and
 * invoices.token are permanent bearer credentials behind /estimate/:token,
 * /pay/:token and /receipt/:token. Neither is SELECTed here, so no pay link,
 * receipt link, or reservice token can ride a voice reply — the caller is
 * pointed at the portal or the office instead. Tests regex every output.
 *
 * INVOICES reuse the customer-facing loader: openBalanceInvoices /
 * openBalanceSummary (services/open-balance.js), the same self-pay,
 * payer-resolved, credit-netted set the portal's billing balance view shows
 * (routes/billing-v2.js GET /api/billing/balance), with invoiceAmountDue
 * (services/invoice-helpers.js) as the cents-authoritative amount owed.
 * Recently-PAID invoices are read with the same status/payer discipline so
 * "did my payment go through?" can be answered honestly.
 */

const INVOICE_HISTORY_LIMIT = 6;
const ESTIMATE_LIMIT = 5;

// The statuses that mean "sent and still open" — a draft was never presented,
// and accepted/declined/expired are closed. 'scheduled' is a queued send that
// has not gone out yet, so it is NOT quotable.
const OPEN_ESTIMATE_STATUSES = ['sent', 'viewed'];

function parseJson(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ── get_open_estimates ─────────────────────────────────────────────────────

/**
 * Line labels + their SENT prices, read verbatim from the frozen send
 * snapshot. No arithmetic beyond currency formatting, no engine call, no
 * live re-pricing: an outstanding quote is honoured at the number the
 * customer was actually sent.
 */
function snapshotLines(estimateData) {
  const { fmtMoney, promptSafe } = require('./relay-context');
  const bundle = estimateData && estimateData.sendSnapshot && estimateData.sendSnapshot.pricingBundle;
  const raw = (bundle && Array.isArray(bundle.lineItems) && bundle.lineItems)
    || (Array.isArray(estimateData && estimateData.lineItems) && estimateData.lineItems)
    || [];
  return raw
    .slice(0, 6)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const label = promptSafe(item.description || item.label || item.service || item.name, 60);
      if (!label) return null;
      // Only fields that EXIST on the snapshot are spoken — never a computed
      // or back-filled number.
      const price = fmtMoney(item.monthly ?? item.unitPrice ?? item.amount ?? item.price);
      if (!price) return label;
      // Owner rule: recurring pricing is "per application", never "per visit".
      const unit = item.monthly != null ? ' per month' : '';
      return `${label} at ${price}${unit}`;
    })
    .filter(Boolean);
}

/**
 * Open (sent/viewed) estimates for an account.
 *   - full tier (ANI-matched): line items + the sent prices + totals
 *   - redacted tier (looked-up ref): existence + date only, NO amounts
 */
async function openEstimatesText(customerId, { tier = 'redacted' } = {}) {
  const redacted = tier !== 'full';
  const db = require('../../models/db');
  const { fmtMoney, speakDate, promptSafe } = require('./relay-context');
  const rows = await db('estimates')
    .where({ customer_id: customerId })
    .whereIn('status', OPEN_ESTIMATE_STATUSES)
    .orderBy('created_at', 'desc')
    .limit(ESTIMATE_LIMIT)
    // NOTE the absence of `token`: the estimate view link is a bearer
    // credential and never rides a voice reply.
    .select('id', 'status', 'service_type', 'created_at', 'sent_at', 'expires_at',
      'monthly_total', 'annual_total', 'onetime_total', 'estimate_data');
  if (!rows.length) {
    return 'No open estimates on this account. Do not guess at a quote — get_pricing gives standard plan '
      + 'pricing, and a team member can put a written estimate together.';
  }

  if (redacted) {
    const lines = rows.map((row) => {
      const when = speakDate(row.sent_at || row.created_at);
      return `an estimate sent ${when || 'recently'}`;
    });
    return `There ${rows.length === 1 ? 'is' : 'are'} ${rows.length} open estimate${rows.length === 1 ? '' : 's'} `
      + `on that account (${lines.join('; ')}). Do NOT state any amounts — the account holder can see the `
      + 'estimate in their portal, or the office can go over it with them directly.';
  }

  const rendered = rows.map((row) => {
    const estimateData = parseJson(row.estimate_data);
    const when = speakDate(row.sent_at || row.created_at);
    const expires = speakDate(row.expires_at);
    const bits = [];
    const service = promptSafe(row.service_type, 60);
    bits.push(`Estimate sent ${when || 'recently'}${service ? ` for ${service}` : ''}`);
    const lines = snapshotLines(estimateData);
    if (lines.length) bits.push(`quoted lines: ${lines.join('; ')}`);
    const monthly = fmtMoney(row.monthly_total);
    const oneTime = fmtMoney(row.onetime_total);
    const annual = fmtMoney(row.annual_total);
    const totals = [];
    if (monthly) totals.push(`${monthly} per month`);
    if (annual) totals.push(`${annual} per year`);
    if (oneTime) totals.push(`${oneTime} one-time`);
    if (totals.length) bits.push(`estimate total ${totals.join(', ')}`);
    if (expires) bits.push(`good through ${expires}`);
    return bits.join('; ');
  });

  return `Open estimates on this account: ${rendered.join(' || ')}. `
    + 'These are the prices the estimate was SENT at — quote them exactly as written, never re-price, '
    + 'discount, or update them. Do not read out a link; the estimate is in their portal, or a team '
    + 'member can resend it.';
}

// ── get_invoice_history ────────────────────────────────────────────────────

/**
 * Itemized invoices for the ANI-matched caller ONLY (enforced in
 * relay-tools): numbers, dates, amounts, paid/unpaid, and the open-balance
 * total. Reuses open-balance.js for the open set — the same loader the
 * portal's billing balance view uses.
 */
async function invoiceHistoryText(customerId, { tier = 'redacted' } = {}) {
  // Itemized billing detail is FULL-TIER ONLY, and the tier defaults to
  // redacted so an exported helper cannot fail open. relay-tools already
  // refuses the looked-up case; this is the in-body backstop that also covers
  // a caller recognised on a secondary contact slot (spouse/tenant/prior
  // occupant), whose voice authenticates nothing.
  if (tier !== 'full') {
    return 'Invoice detail is only available for the account whose own phone number the caller is '
      + 'calling from. Do NOT state any invoice numbers, dates, or amounts. Tell the caller the account '
      + 'holder can see their billing in the Waves portal, or a team member can go over it with them.';
  }
  const db = require('../../models/db');
  const { fmtMoney, speakDate, promptSafe } = require('./relay-context');
  const { openBalanceSummary } = require('../open-balance');
  const { invoiceAmountDue } = require('../invoice-helpers');

  const summary = await openBalanceSummary(customerId, { displayLimit: INVOICE_HISTORY_LIMIT })
    .catch(() => null);

  // Recently settled invoices, same self-pay discipline as the open set
  // (payer-owned statements belong to the payer, not this caller). No token
  // column is selected, so no receipt or pay link can leak.
  const paidRows = await db('invoices')
    .where({ customer_id: customerId })
    .whereIn('status', ['paid', 'processing', 'prepaid'])
    .whereNull('payer_id')
    .whereNull('payer_statement_id')
    .orderBy('created_at', 'desc')
    .limit(INVOICE_HISTORY_LIMIT)
    .select('invoice_number', 'status', 'service_type', 'service_date', 'created_at', 'total');

  const parts = [];
  const openRows = (summary && Array.isArray(summary.invoices) ? summary.invoices : []);
  if (openRows.length) {
    const lines = openRows.map((inv) => {
      const number = promptSafe(inv.invoice_number, 30);
      const due = fmtMoney(invoiceAmountDue(inv));
      const when = speakDate(inv.service_date || inv.created_at);
      const service = promptSafe(inv.service_type, 40);
      return `${number ? `Invoice ${number}` : 'An invoice'}${when ? ` from ${when}` : ''}`
        + `${service ? ` for ${service}` : ''}${due ? `, ${due} still owed` : ''}`;
    });
    parts.push(`UNPAID: ${lines.join(' | ')}.`);
    const total = fmtMoney(summary.total);
    if (total) {
      parts.push(`Total open balance: ${total} across ${summary.count} invoice${summary.count === 1 ? '' : 's'}.`);
    }
    if (summary.moreCount > 0) parts.push(`(${summary.moreCount} older open invoice${summary.moreCount === 1 ? '' : 's'} not listed.)`);
  } else if (summary) {
    parts.push('UNPAID: none — the account is paid up.');
  } else {
    parts.push('The open balance could not be checked right now — do not guess at what is owed.');
  }

  if (paidRows.length) {
    const lines = paidRows.map((inv) => {
      const number = promptSafe(inv.invoice_number, 30);
      const amount = fmtMoney(inv.total);
      const when = speakDate(inv.service_date || inv.created_at);
      const state = String(inv.status) === 'processing' ? 'payment processing' : 'paid';
      return `${number ? `Invoice ${number}` : 'An invoice'}${when ? ` from ${when}` : ''}`
        + `${amount ? `, ${amount}` : ''} — ${state}`;
    });
    parts.push(`RECENTLY SETTLED: ${lines.join(' | ')}.`);
  }

  parts.push('You may state these amounts to the matched caller about their own account. Never read out a '
    + 'payment link, receipt link, or any code — they can pay in the Waves customer portal, or a team member '
    + 'can help them directly. Never take a card number over this call.');
  return parts.join(' ');
}

module.exports = {
  openEstimatesText,
  invoiceHistoryText,
  snapshotLines,
  OPEN_ESTIMATE_STATUSES,
  INVOICE_HISTORY_LIMIT,
  ESTIMATE_LIMIT,
};
