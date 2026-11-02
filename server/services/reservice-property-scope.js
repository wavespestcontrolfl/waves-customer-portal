/**
 * Re-service asks: does this account provably have ONE premises? (GATE_RESERVICE_ASKS, Codex security review on
 * #7502.)
 *
 * A customer's text, call or email names no property, so on an account with a second premises it may be about the
 * other one (a rental). reservice-asks.js marks such items `accountWide`, and the customer's report never prints them.
 * customer_properties alone is not proof: a second premises can live only in `has_multi_home`, a stamped visit
 * address or a source estimate. This reuses the codebase's one fail-closed proof
 * (service-report/visit-property-scope.js customerHasOnlyPrimaryPremises, with unresolvedFails), the same way the sod
 * sheet does: no customer row, a primary address with no locality, or an unresolvable witness is NOT proof.
 * A failed read throws; the caller decides (reservice-asks.js counts it as several premises).
 */
'use strict';

async function accountProvesSinglePremises(knex, customerId) {
  if (!customerId) return false;
  const linkage = require('./estimate-property-linkage');
  const { customerHasOnlyPrimaryPremises } = require('./service-report/visit-property-scope');
  const customer = await knex('customers').where({ id: customerId })
    .first('address_line1', 'address_line2', 'city', 'zip', 'has_multi_home');
  if (!customer) return false;
  const primary = linkage.normalizedStampedStreet(customer.address_line1, customer.address_line2, customer.city, customer.zip) || null;
  if (!primary || linkage.scopeKeyLacksLocality(primary)) return false;
  return customerHasOnlyPrimaryPremises(knex, customerId, customer, primary, { unresolvedFails: true });
}

module.exports = { accountProvesSinglePremises };
