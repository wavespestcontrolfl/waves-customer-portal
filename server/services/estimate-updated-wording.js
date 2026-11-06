'use strict';

const crypto = require('crypto');

// Owner 2026-11-04 "updated" (GATE_ESTIMATE_UPDATED_WORDING, dark): a corrected estimate says so. Before, an
// estimate the office edited and sent again went out word for word like the first send ("your Waves estimate is
// ready"), so the customer could not tell the new quote from the old one.
//
// A send is an UPDATE when the customer already received this estimate (a delivery stamped sendSnapshot.scope) and
// what this send delivers differs from that last delivery: its priced lines or address (the scope every delivery
// stamps), or its prices (sendSnapshot.priced, stamped beside the scope since this change: the totals and a digest of
// the priced engine output, every line's price and the office's manual overrides included, so two prices that move by
// offsetting amounts still count). A delivery stamped before carries no prices, so only its scope can differ. A plain resend of the same quote keeps the normal
// wording. A commercial proposal keeps its own template.

const UPDATED_SMS_TEMPLATE_KEY = 'estimate_updated';
const UPDATED_EMAIL_TEMPLATE_KEY = 'estimate.updated_delivery';

// A test that mocks config/feature-gates whole has no reader: that reads as off, never as a crash.
function updatedWordingLive() {
  const reader = require('../config/feature-gates').estimateUpdatedWordingLive;
  return typeof reader === 'function' && reader() === true;
}

// JSONB stores object keys in its own order, so compare the stamp and the live scope with sorted keys.
function canonicalJson(value) {
  return JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
    : v));
}

function parseEstimateData(estimateData) {
  if (!estimateData) return null;
  if (typeof estimateData === 'string') {
    try { return JSON.parse(estimateData); } catch { return null; }
  }
  return typeof estimateData === 'object' ? estimateData : null;
}

const money = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v).toFixed(2));

// The totals a delivery carries, as fixed cents: pg returns numeric columns as strings.
function deliveredTotals(row = {}) {
  return { monthly: money(row.monthly_total), annual: money(row.annual_total), onetime: money(row.onetime_total) };
}

// The containers that carry an estimate's prices: the engine output (result, engineResult: every line, the office's
// manual overrides such as manualFinalAnnual / manualFinalOneTime) and the manual and self-service quote lines. The
// scope keeps line names and cadence only. The customer's own selections are not the office's quote and stay out.
const PRICED_CONTAINERS = ['result', 'engineResult', 'manualQuoteLines', 'services', 'setupFeeQuote'];
// Internal signals a re-price rewrites without changing what the customer is charged (an internal cost change flips
// belowMarginFloor or minAnnualForMargin; generatedAt moves on every run): costs, margins, floors, diagnostics,
// warnings, confidence, review flags and metadata. The prices themselves (annual, monthly, perApp, price,
// manualFinalAnnual, manualFinalOneTime, ...) never match, so a re-price that lands on the same prices is the same
// quote.
const NON_PRICE_KEY = /margin|cost|floor|diagnostic|warning|confidence|metadata|manualReview|generatedAt/i;
const isNonPriceKey = (key) => NON_PRICE_KEY.test(key);

function pricedOnly(value) {
  if (Array.isArray(value)) return value.map(pricedOnly);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => !isNonPriceKey(key)).map((key) => [key, pricedOnly(value[key])]));
}

// What a delivery charged: its totals and a digest of its priced content. Stamped as sendSnapshot.priced by every
// delivery (a digest, so the stamp stays small beside the pricing bundle).
function pricedContent(row = {}) {
  const data = parseEstimateData(row.estimate_data) || {};
  const priced = Object.fromEntries(PRICED_CONTAINERS.map((key) => [key, pricedOnly(data[key] ?? null)]));
  return { totals: deliveredTotals(row), digest: crypto.createHash('sha256').update(JSON.stringify(priced)).digest('hex') };
}

const validScope = (scope) => Boolean(scope && typeof scope === 'object' && Array.isArray(scope.lines));

// sendSnapshot = the row's estimate_data.sendSnapshot, the LAST delivery's stamp. No valid stamp = never
// delivered (or delivered before the stamp existed): not an update.
function offerChangedSinceDelivery(sendSnapshot, currentScope, currentPriced) {
  if (!validScope(sendSnapshot?.scope) || !validScope(currentScope)) return false;
  if (canonicalJson(sendSnapshot.scope) !== canonicalJson(currentScope)) return true;
  const stamped = sendSnapshot.priced;
  if (!stamped || typeof stamped !== 'object') return false;
  return canonicalJson(stamped) !== canonicalJson(currentPriced);
}

// The updated email template can send: present, enabled (sendTemplate refuses any other template status) and with
// an active version. Anything else = the normal delivery email.
function updatedEmailTemplateUsable(library) {
  return Boolean(library?.template && library.activeVersion
    && String(library.template.status || 'active').toLowerCase() === 'active');
}

module.exports = {
  UPDATED_SMS_TEMPLATE_KEY,
  UPDATED_EMAIL_TEMPLATE_KEY,
  updatedWordingLive,
  canonicalJson,
  deliveredTotals,
  pricedContent,
  offerChangedSinceDelivery,
  updatedEmailTemplateUsable,
};
