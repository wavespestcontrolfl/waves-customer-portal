// Owner ruling 2026-11-23: a caller who asks for one-time pest service gets
// BOTH options on the estimate, the plan and the one-time price.
//
// When the one-time pest job is the ONLY thing asked for, the draft is
// priced as the quarterly plan and the estimate turns on the page's
// [Recurring | One-time] choice (createDraftEstimate). The page computes the
// one-time amount from the plan's per-visit price, exactly as it does for a
// staff estimate with "Offer one-time option" on. The draft therefore
// stores ONE price basis: no second one-time row that could disagree with
// the amount the page shows and charges, and no one-time total credited to
// the lead when the customer picks the plan.
//
// Limits:
//   - a call only: the ruling is about callers, not a text thread;
//   - a pest-only ask: the page's one-time choice is not supported next to
//     other recurring services;
//   - not a current customer: the page's choice does not carry the member
//     one-time perk, so a member keeps the plain one-time draft;
//   - not a bedroom-band unit: the page's amount is not the band's own
//     one-time rate.
// Returns true when it swapped the ask for the plan.
const { validateEstimateDeliveryOptions } = require('../estimate-delivery-options');

function offerPlanWithOneTimeChoice(intent, {
  channel = null, unitBandPricing = null, currentCustomer = false, planShowsOneTimeChoice = null,
} = {}) {
  if (channel !== 'call' || unitBandPricing || currentCustomer) return false;
  const keys = Object.keys(intent?.services || {});
  if (intent?.decision !== 'draft' || intent.is_commercial === true) return false;
  if (keys.length !== 1 || keys[0] !== 'oneTimePest') return false;
  const asked = intent.services;
  intent.services = { pest: { frequency: 'quarterly' } };
  // The swap stays only when the priced plan can show the one-time choice on
  // the estimate page (a property the engine prices as commercial, or a plan
  // with no derivable price, cannot). Otherwise the caller's ask is restored.
  let shows = false;
  try { shows = planShowsOneTimeChoice ? planShowsOneTimeChoice() === true : true; } catch { shows = false; }
  if (!shows) intent.services = asked;
  return shows;
}

// Whether a priced plan can carry the [Recurring | One-time] choice: the
// engine priced one home pest line and the estimate page's own rule accepts it.
function planCanShowOneTimeChoice({ engineInputs, engineResult, totals }) {
  // The engine's own verdict: the plan must come back as the one home pest
  // line. A property it prices as commercial (office, retail, ...) returns a
  // commercial line and keeps the caller's one-time ask on the manual path.
  const lines = Array.isArray(engineResult?.lineItems) ? engineResult.lineItems : [];
  if (lines.length !== 1 || lines[0].service !== 'pest_control') return false;
  return !validateEstimateDeliveryOptions({
    showOneTimeOption: true,
    onetimeTotal: totals?.oneTime,
    monthlyTotal: totals?.monthly,
    annualTotal: totals?.annual,
    estimateData: { engineInputs, engineResult },
  });
}

module.exports = { offerPlanWithOneTimeChoice, planCanShowOneTimeChoice };
