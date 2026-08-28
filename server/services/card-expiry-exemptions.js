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

const BANK_METHOD_TYPES = new Set(['ach', 'us_bank_account', 'bank', 'bank_account']);

// A charged method that gives the operator nothing to act on: a bank row
// (no card expiry), or a card whose well-formed expiry is strictly LATER
// than the (year, month) the caller's warning window ends on. Malformed or
// missing expiry → actionable (fail toward the alert staying open).
function chargedMethodBeyondWindow(row, year, month) {
  if (!row) return false;
  if (BANK_METHOD_TYPES.has(String(row.method_type || '').toLowerCase())) return true;
  const expMonth = Number(row.exp_month);
  const rawYear = Number(row.exp_year);
  const expYear = Number.isFinite(rawYear) && rawYear > 0 && rawYear < 100 ? rawYear + 2000 : rawYear;
  if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12 || !Number.isInteger(expYear)) return false;
  return expYear > year || (expYear === year && expMonth > month);
}

/**
 * Customers whose open payment_expiry alerts have nothing left to act on:
 * the fully exempt ones, plus covered customers with a charge coming
 * (resolved methods) EVERY one of whose charged methods is a bank row or a
 * card valid beyond the warning window's last (year, month). Judged from
 * the charged methods' own rows (`chargedMethodRows`: payment_methods
 * { id, method_type, exp_month, exp_year }) — never from absence in an
 * expiring-cards query, which cannot see a card that expired before the
 * window (hook P1). A charged method with no row, an unresolved vector
 * (null), or any malformed expiry keeps the customer's alerts open.
 * Alerts carry no payment-method identity, so this is all-or-nothing per
 * customer (fail toward the operator seeing it).
 */
function cardExpiryAlertResolvableCustomerIds(exemptions, chargedMethodRows = [], { year, month } = {}) {
  const out = new Set(exemptions?.customerIds instanceof Set ? [...exemptions.customerIds].map(String) : []);
  if (!(exemptions?.chargeMethodIdsByCustomer instanceof Map)) return out;
  if (!Number.isInteger(year) || !Number.isInteger(month)) return out;
  const rowById = new Map((chargedMethodRows || []).filter((r) => r?.id != null).map((r) => [String(r.id), r]));
  for (const [customerId, methodIds] of exemptions.chargeMethodIdsByCustomer) {
    if (!(methodIds instanceof Set) || !methodIds.size) continue;
    if ([...methodIds].every((id) => chargedMethodBeyondWindow(rowById.get(String(id)), year, month))) out.add(String(customerId));
  }
  return out;
}

module.exports = { emptyCardExpiryExemptions, isCardExpiryExemptMethod, cardExpiryAlertResolvableCustomerIds };
