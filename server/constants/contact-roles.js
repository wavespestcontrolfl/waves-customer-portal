/**
 * Contact roles — the relationship between the contact on a customer profile
 * and the properties serviced under it. Single source of truth for the
 * customers.contact_role column (migration 20260827000002); the admin client
 * mirrors the list in client/src/lib/contact-roles.js.
 *
 *  - owner            — lives at / owns the serviced property (default when NULL)
 *  - property_manager — manages the properties for owners (payer ≠ occupant;
 *                       the primary property is a default service address,
 *                       never a residence)
 *  - tenant           — occupies but does not own
 */
const CONTACT_ROLES = Object.freeze(['owner', 'property_manager', 'tenant']);

/**
 * Normalize an inbound contact role. `''`/null/undefined clear the column;
 * any other value must be a known role.
 * @returns {{ ok: true, value: string|null } | { ok: false }}
 */
function normalizeContactRole(input) {
  if (input === undefined || input === null || input === '') return { ok: true, value: null };
  if (typeof input !== 'string') return { ok: false };
  const value = input.trim().toLowerCase();
  if (value === '') return { ok: true, value: null };
  return CONTACT_ROLES.includes(value) ? { ok: true, value } : { ok: false };
}

module.exports = { CONTACT_ROLES, normalizeContactRole };
