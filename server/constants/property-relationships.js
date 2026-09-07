/**
 * Property relationships — how the CUSTOMER relates to one of their service
 * addresses. Distinct from customer_properties.occupancy_type (who lives
 * there / how the property is used) and from customers.contact_role (the
 * contact's role across the whole profile). Single source of truth for the
 * customer_properties.relationship column (migration 20260906000020); the
 * admin client mirrors the list in client/src/lib/contact-roles.js.
 *
 *  - own_home           — the customer's own residence
 *  - rental_owned       — an investment / rental the customer owns
 *  - family_home        — a family member's home the customer pays for
 *                         (parent's house, adult child's condo); the resident
 *                         is neither a tenant nor the payer
 *  - managed_for_client — serviced on behalf of a property-management client
 *
 * NULL = not recorded (legacy rows the backfill could not classify).
 */
const PROPERTY_RELATIONSHIPS = Object.freeze(['own_home', 'rental_owned', 'family_home', 'managed_for_client']);

/**
 * Normalize an inbound relationship. `''`/null/undefined clear the column;
 * any other value must be a known relationship.
 * @returns {{ ok: true, value: string|null } | { ok: false }}
 */
function normalizeRelationship(input) {
  if (input === undefined || input === null || input === '') return { ok: true, value: null };
  if (typeof input !== 'string') return { ok: false };
  const value = input.trim().toLowerCase();
  if (value === '') return { ok: true, value: null };
  return PROPERTY_RELATIONSHIPS.includes(value) ? { ok: true, value } : { ok: false };
}

module.exports = { PROPERTY_RELATIONSHIPS, normalizeRelationship };
