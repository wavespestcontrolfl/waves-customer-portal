/**
 * Card-expiry exemption — the PER-METHOD verdict shared by the three warning
 * surfaces (dashboard cards_expiring_7d, the Monday autopay warning job, the
 * daily payment-expiry workflow).
 *
 * annual-prepay-renewals.getCardExpiryExemptions(horizon) computes, for every
 * customer whose paid coverage spans [today, horizon]:
 *   - customerIds: customers with NO card charge coming inside the window —
 *     every method of theirs is exempt (the customer-level exemption #3533
 *     shipped);
 *   - chargeMethodIdsByCustomer: covered customers who DO have a charge coming,
 *     mapped to the payment_methods.id each forthcoming charge will use
 *     (the Auto Pay pointer/default walk for the retry sweep and every
 *     completion Auto Pay lane; the hold's own frozen card for the estimate
 *     hold rail), or null when a charge is coming but its method could not
 *     be resolved (no chargeable method, unmatched hold card) — then every
 *     method keeps its warning.
 * A customer in neither structure is not covered at all: warn as before.
 *
 * Pure and dependency-free so consumers (and their tests) use it directly;
 * the expensive scan stays behind the memoized getter in
 * annual-prepay-renewals.js.
 */

function emptyCardExpiryExemptions() {
  return { customerIds: new Set(), chargeMethodIdsByCustomer: new Map() };
}

/**
 * Should the warning about `paymentMethodId` (a payment_methods.id) for
 * `customerId` be suppressed? True only when the customer is covered AND no
 * forthcoming charge inside the window will use that method. Unknown method
 * (null id) or an unresolved charge vector → false (warn — noise, never a
 * missed charge).
 */
function isCardExpiryExemptMethod(exemptions, customerId, paymentMethodId) {
  if (!exemptions || customerId == null) return false;
  const key = String(customerId);
  if (exemptions.customerIds instanceof Set && exemptions.customerIds.has(key)) return true;
  const charged = exemptions.chargeMethodIdsByCustomer instanceof Map
    ? exemptions.chargeMethodIdsByCustomer.get(key)
    : undefined;
  if (!(charged instanceof Set)) return false; // not covered (undefined) or unresolved (null)
  if (paymentMethodId == null) return false;
  return !charged.has(String(paymentMethodId));
}

/**
 * Customers whose open payment_expiry alerts have nothing left to act on:
 * the fully exempt ones, plus covered customers with a charge coming
 * (resolved methods) none of whose CURRENTLY expiring cards will be
 * charged. `expiringCards` = this run's expiring rows ({ id, customer_id }).
 * An unresolved charge vector (null) never qualifies — every card warns.
 * Alerts carry no payment-method identity, so a customer with ANY
 * expiring card still to be charged keeps every alert (fail toward the
 * operator seeing it).
 */
function cardExpiryAlertResolvableCustomerIds(exemptions, expiringCards = []) {
  const out = new Set(exemptions?.customerIds instanceof Set ? [...exemptions.customerIds].map(String) : []);
  if (!(exemptions?.chargeMethodIdsByCustomer instanceof Map)) return out;
  const chargedExpiring = new Set();
  for (const card of expiringCards || []) {
    if (card?.customer_id == null) continue;
    if (!isCardExpiryExemptMethod(exemptions, card.customer_id, card.id)) chargedExpiring.add(String(card.customer_id));
  }
  for (const [customerId, methodIds] of exemptions.chargeMethodIdsByCustomer) {
    if (!(methodIds instanceof Set)) continue;
    if (!chargedExpiring.has(String(customerId))) out.add(String(customerId));
  }
  return out;
}

module.exports = { emptyCardExpiryExemptions, isCardExpiryExemptMethod, cardExpiryAlertResolvableCustomerIds };
