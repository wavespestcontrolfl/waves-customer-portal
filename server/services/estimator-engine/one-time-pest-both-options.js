// Owner ruling 2026-11-23: a caller who asks for one-time pest service gets
// BOTH options on the estimate, the plan and the one-time price. When the
// one-time pest job is the ONLY thing asked for, the quarterly plan is added
// to the intent before pricing (the estimate page shows all three visit
// counts, so the count is the customer's pick).
// Limits:
//   - a call only: the ruling is about callers, not a text thread;
//   - a pest-only ask: the page's one-time choice is not supported next to
//     other recurring services;
//   - not a bedroom-band unit: the page computes its one-time choice from
//     the plan's per-visit price, which equals the engine's one-time price
//     for a footprint-priced home but not for a band rate.
// Returns true when it added the plan. The caller then marks the context
// (ownerRuleServices), which keeps the one-time price free of the
// recurring-customer perk (buildEngineInput) and turns the choice on
// (createDraftEstimate).
function addRecurringPestForOneTimeAsk(intent, { channel = null, unitBandPricing = null } = {}) {
  if (channel !== 'call' || unitBandPricing) return false;
  const keys = Object.keys(intent?.services || {});
  if (intent?.decision !== 'draft' || intent.is_commercial === true) return false;
  if (keys.length !== 1 || keys[0] !== 'oneTimePest') return false;
  intent.services.pest = { frequency: 'quarterly' };
  return true;
}

module.exports = { addRecurringPestForOneTimeAsk };
