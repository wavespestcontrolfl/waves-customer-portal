'use strict';

// Owner 2026-11-04 "updated" (GATE_ESTIMATE_UPDATED_WORDING, dark): a corrected estimate says so. Before, an
// estimate the office edited and sent again went out word for word like the first send ("your Waves estimate is
// ready"), so the customer could not tell the new quote from the old one.
//
// A send is an UPDATE when the customer already received this estimate (a delivery stamped sendSnapshot.scope) and
// what this send delivers differs from that last delivery: its priced lines or address (the scope every delivery
// stamps), or its totals (stamped beside the scope since this change; a delivery stamped before carries no totals,
// so only its scope can differ). A plain resend of the same quote keeps the normal wording. A commercial proposal
// keeps its own template.

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

// The totals a delivery carries, as fixed cents: pg returns numeric columns as strings.
function deliveredTotals(row = {}) {
  const money = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v).toFixed(2));
  return { monthly: money(row.monthly_total), annual: money(row.annual_total), onetime: money(row.onetime_total) };
}

const validScope = (scope) => Boolean(scope && typeof scope === 'object' && Array.isArray(scope.lines));

// sendSnapshot = the row's estimate_data.sendSnapshot, the LAST delivery's stamp. No valid stamp = never
// delivered (or delivered before the stamp existed): not an update.
function offerChangedSinceDelivery(sendSnapshot, currentScope, currentTotals) {
  if (!validScope(sendSnapshot?.scope) || !validScope(currentScope)) return false;
  if (canonicalJson(sendSnapshot.scope) !== canonicalJson(currentScope)) return true;
  const stamped = sendSnapshot.totals;
  if (!stamped || typeof stamped !== 'object') return false;
  return canonicalJson(stamped) !== canonicalJson(currentTotals);
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
  offerChangedSinceDelivery,
  updatedEmailTemplateUsable,
};
