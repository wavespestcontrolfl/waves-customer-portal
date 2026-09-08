/**
 * "Use a different payment method" after a capture SetupIntent already
 * SUCCEEDED — shared by every capture surface that mints with a
 * deterministic idempotency key (recurring accept, secure-appointment card,
 * standalone Auto Pay link).
 *
 * Stripe will not cancel a succeeded SetupIntent and the deterministic key
 * replays it on every reopen, so retirement rides the intent's own metadata
 * (`retired='true'`, `replaced_by=<new id>`, stamped by
 * StripeService.retireSetupIntent). Every trust decision reads these stamps
 * from Stripe — the same source the accept/complete gates already re-derive
 * trust from — so a retired capture is never enrolled, and a mint that
 * replays a retired intent follows `replaced_by` to the live head.
 */

// A retired capture: the customer replaced it with a different payment method.
function isRetiredSetupIntent(setupIntent) {
  return setupIntent?.metadata?.retired === 'true';
}

// Stripe's "No such setupintent" (HTTP 404, code resource_missing) — the id
// was never minted, so there is nothing to retire and nothing to retry.
function isStripeResourceMissing(err) {
  return err?.code === 'resource_missing' || err?.statusCode === 404;
}

// Follow a retired replay's `replaced_by` chain to the live head (a
// replacement can itself be replaced). `readLive(id)` performs the Stripe
// read the caller wants (payment_method expanded or not). Returns null on a
// broken chain, a canceled head, a head that is itself retired at the hop
// cap, or when the chain leaves the caller's own capture family (the
// `belongs(head)` predicate — never hand back another purpose's intent).
const MAX_REPLACEMENT_HOPS = 10;
async function followReplacementChain(setupIntent, readLive, belongs = () => true) {
  let current = setupIntent;
  for (let hop = 0; hop < MAX_REPLACEMENT_HOPS && current && isRetiredSetupIntent(current); hop += 1) {
    const nextId = current.metadata?.replaced_by;
    if (!nextId) return null;
    current = await readLive(nextId);
  }
  if (!current || isRetiredSetupIntent(current) || current.status === 'canceled' || !belongs(current)) return null;
  return current;
}

module.exports = {
  MAX_REPLACEMENT_HOPS,
  isRetiredSetupIntent,
  isStripeResourceMissing,
  followReplacementChain,
};
