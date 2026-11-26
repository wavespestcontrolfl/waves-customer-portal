// One-time pest price for NEW quotes (owner 2026-11-26: 1.8x the quarterly visit, and never less than 10% over the first
// visit of a plan; only new estimates, a quote already sent keeps its exact price).
//
//   list = max( round(newRuleMultiplier x quarterly), round((quarterly + PEST.initialFee) x (1 + firstVisitBufferPct)) )
//
// The caller applies the floor, urgency, the recurring-customer perk and the strictly-above-visit-1 clamp exactly as for every
// one-time pest price (service-pricing.js priceOneTimePest). A quote saved BEFORE the rule never reaches this module: it keeps
// the existing multiplier path (ONE_TIME.pest.multiplier, 2.2), selected by the legacyOneTimePestBuffer stamp. The estimate
// page's "both choices" amount (estimate-public.js) and the client mirror use the same two functions, so the page and the
// engine agree at any setting.
const { ONE_TIME, PEST } = require('./constants');

const cents = (n) => Math.round(n * 100) / 100;

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// The new rule's numbers are code constants (constants.js ONE_TIME.pest.newRule), never a Setting.
const NEW_RULE = ONE_TIME.pest.newRule;
function firstVisitBufferPct() {
  return NEW_RULE.firstVisitBufferPct;
}

// { multiplier, multipliedPrice, bufferPrice, bufferPct, price } for a quarterly per-app rate.
function newRuleListPrice(quarterlyPerApp) {
  const q = Number(quarterlyPerApp);
  const multiplier = NEW_RULE.multiplier;
  const multipliedPrice = Math.round(q * multiplier);
  const bufferPct = firstVisitBufferPct();
  // Cents first, then whole dollars: (q + 99) x 1.10 can land a hair under a half-dollar in floating point.
  const bufferPrice = Math.round(cents((q + (Number(PEST.initialFee) || 0)) * (1 + bufferPct)));
  return { multiplier, multipliedPrice, bufferPrice, bufferPct, price: Math.max(multipliedPrice, bufferPrice) };
}

// The amount the estimate page shows beside a plan for a new quote: the list, the one-time floor, then the strictly-above-visit-1
// clamp (the same order the engine applies them in for a customer with no perk).
function newRuleChoiceAmount(quarterlyPerApp) {
  const q = Number(quarterlyPerApp);
  const floor = NEW_RULE.floor;
  const floored = Math.max(floor, newRuleListPrice(q).price);
  const visitOne = cents(q + (Number(PEST.initialFee) || 0));
  return floored <= visitOne ? visitOne + 1 : floored;
}

module.exports = { newRuleListPrice, newRuleChoiceAmount, firstVisitBufferPct };
