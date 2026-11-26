// Owner ruling 2026-11-23: a caller who asks for one-time pest service gets
// BOTH options on the estimate, the plan and the one-time price. When the
// one-time pest job is the ONLY thing asked for, the quarterly plan is added
// to the intent before pricing (the estimate page shows all three visit
// counts, so the count is the customer's pick). Only a pest-only ask: the
// page's one-time choice is not supported next to other recurring services.
// Returns true when it added the plan.
function addRecurringPestForOneTimeAsk(intent) {
  const keys = Object.keys(intent?.services || {});
  if (intent?.decision !== 'draft' || intent.is_commercial === true) return false;
  if (keys.length !== 1 || keys[0] !== 'oneTimePest') return false;
  intent.services.pest = { frequency: 'quarterly' };
  return true;
}

module.exports = { addRecurringPestForOneTimeAsk };
