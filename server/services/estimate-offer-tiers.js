/**
 * Good / Better / Best on a pest + lawn estimate (owner 2026-10-05).
 *
 * The picker is a VIEW over the service opt-out rail
 * (PUT /api/estimates/:token/service-opt-out), never a second pricing path:
 *
 *   best   — the estimate as quoted: pest + lawn.
 *   better — lawn removed through the rail. The canonical engine re-prices
 *            the whole estimate (tier, setup fee, per-application prices).
 *   good   — the one-time choice on that pest-only row, which the one-time
 *            option has always supported.
 *
 * So the stored row is always an ordinary, valid estimate, and no other
 * surface (accept, slots, card holds, the text agent, admin, emails) needs
 * to know tiers exist. Two small things make it work: the office marks a
 * row for tiers (`estimate_data.offerTiersRequested`, stamped at save), and
 * the rail turns the one-time option on when lawn is removed from a marked
 * row and off when it is added back — the option is never on while a
 * companion program is on the estimate.
 *
 * Tree & shrub is not a companion here: the rail refuses its removal (its
 * pricing knobs cannot be replayed on add-back).
 *
 * Dark behind GATE_ESTIMATE_OFFER_TIERS; needs GATE_ESTIMATE_SERVICE_OPT_OUT.
 */

const COMPANION_KEY = 'lawn_care';
const COMPANION_LABEL = 'Lawn Care';

function offerTiersGateLive() {
  try {
    const gates = require('../config/feature-gates');
    return typeof gates.estimateOfferTiersLive === 'function'
      ? gates.estimateOfferTiersLive()
      : process.env.GATE_ESTIMATE_OFFER_TIERS === 'true';
  } catch (_) {
    return false;
  }
}

function offerTiersRequested(estData) {
  return !!estData && typeof estData === 'object' && estData.offerTiersRequested === true;
}

// Recurring service keys on the STORED result (v1 admin-tool shape).
function storedRecurringKeys(estData) {
  const rows = Array.isArray(estData?.result?.recurring?.services) ? estData.result.recurring.services : [];
  const { recurringServiceKey } = require('./estimate-converter');
  return Array.from(new Set(rows.map((row) => recurringServiceKey(row)).filter(Boolean)));
}

/**
 * May the office mark this estimate for tiers? Residential, recurring
 * program is exactly pest + lawn, and no member evidence (a member's offers
 * are the office's). Stored facts only — the save and the tool's preview
 * judge the same thing. Reasons are stable strings for tests and logs.
 */
function optOutRailGateLive() {
  return process.env.GATE_ESTIMATE_SERVICE_OPT_OUT === 'true';
}

function offerTiersSaveEligibility({
  gateOn = offerTiersGateLive(), railGateOn = optOutRailGateLive(), estData = {}, commercial = false, memberEvidence = false,
} = {}) {
  if (!gateOn) return { eligible: false, reason: 'gate_off' };
  // The picker is a view over the opt-out rail: without it the customer page
  // can never show the tiles, so the office must not be told it offered them.
  if (!railGateOn) return { eligible: false, reason: 'opt_out_gate_off' };
  if (commercial) return { eligible: false, reason: 'not_residential' };
  let keys;
  let member = !!memberEvidence || !!estData?.membershipSnapshot?.isExistingCustomer;
  try {
    keys = storedRecurringKeys(estData);
    member = member || !!require('./estimate-service-opt-out').memberEvidenceInEstimateData(estData);
  } catch (_) {
    return { eligible: false, reason: 'unreadable' };
  }
  if (member) return { eligible: false, reason: 'member' };
  if (!keys.includes('pest_control')) return { eligible: false, reason: 'no_recurring_pest' };
  if (!keys.includes(COMPANION_KEY)) return { eligible: false, reason: 'no_lawn' };
  if (keys.length !== 2) return { eligible: false, reason: 'other_recurring_services' };
  return { eligible: true, reason: null };
}

/**
 * The rail's commit asks this what to do with the one-time option. On a row
 * the office marked for tiers the option FOLLOWS THE LAWN LINE:
 *  - lawn removed → the row is pest-only, where the option is valid: turn it
 *    on, when the gate is on and the delivery validator allows it on the
 *    repriced row;
 *  - lawn added back (the customer's add-back, or the send path's
 *    compensation after a failed send) → turn it off, gate or no gate. The
 *    option must never
 *    sit on an estimate that carries a companion program, because the
 *    one-time toggle drops companions at accept.
 * Returns the column patch for the rail's guarded UPDATE ({} = leave as is).
 */
function oneTimeOptionUpdateForMixChange({
  actor, serviceKey, mode, estData, next = {}, gateOn = offerTiersGateLive(), validate,
} = {}) {
  // Customer moves AND the staff send-time park ("lead with one service",
  // GATE_ESTIMATE_LEAD_SERVICE_SEND, live): a marked pest + lawn estimate
  // whose lawn is parked at send arrives pest-only — Better preselected, Best
  // one tap away — and the one-time option must be on for Good to work.
  if (!['customer', 'staff'].includes(actor) || serviceKey !== COMPANION_KEY || !offerTiersRequested(estData)) return {};
  if (mode === 'restore') return { show_one_time_option: false };
  if (mode !== 'remove' || !gateOn) return {};
  const validateOption = typeof validate === 'function'
    ? validate
    : require('./estimate-delivery-options').validateEstimateDeliveryOptions;
  const optionError = validateOption({
    showOneTimeOption: true,
    billByInvoice: false,
    onetimeTotal: next.onetimeTotal,
    monthlyTotal: next.monthlyTotal,
    annualTotal: next.annualTotal,
    estimateData: estData,
  });
  return optionError ? {} : { show_one_time_option: true };
}

/**
 * A marked row that already moved to the pest plan (lawn removed through
 * the rail, by the customer or the send-time park). Its stored rows no longer
 * say "pest + lawn", but the row is in the model's own second state, so the
 * mark stays valid: the office reopening it must still see (and keep) the
 * Good / Better / Best choice.
 */
function offerTiersMarkedPestOnlyState(estData) {
  if (!offerTiersRequested(estData)) return false;
  try {
    const OptOut = require('./estimate-service-opt-out');
    if (!OptOut.currentlyOptedOutKeys(estData).includes(COMPANION_KEY)) return false;
    const keys = storedRecurringKeys(estData);
    return keys.length === 1 && keys[0] === 'pest_control';
  } catch (_) {
    return false;
  }
}

module.exports = {
  offerTiersMarkedPestOnlyState,
  optOutRailGateLive,
  oneTimeOptionUpdateForMixChange,
  COMPANION_KEY,
  COMPANION_LABEL,
  offerTiersGateLive,
  offerTiersRequested,
  storedRecurringKeys,
  offerTiersSaveEligibility,
};
