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
function offerPlanWithOneTimeChoice(intent, {
  channel = null, unitBandPricing = null, currentCustomer = false, propertyType = null,
} = {}) {
  if (channel !== 'call' || unitBandPricing || currentCustomer) return false;
  // A property the lookup resolved as commercial keeps the manual-quote path,
  // whatever the call's own category says.
  if (/commercial/i.test(String(propertyType || ''))) return false;
  const keys = Object.keys(intent?.services || {});
  if (intent?.decision !== 'draft' || intent.is_commercial === true) return false;
  if (keys.length !== 1 || keys[0] !== 'oneTimePest') return false;
  intent.services = { pest: { frequency: 'quarterly' } };
  return true;
}

module.exports = { offerPlanWithOneTimeChoice };
