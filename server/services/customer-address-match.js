// Customers at a street address — the ONE query behind every "who else is at
// this address" question: the estimate builder's link suggestions, the
// Customer 360 "Others at this address" block, and the save-time
// member-linkage warning in admin-estimate-persistence.
//
// Two legs, both narrowed cheaply by house-number prefix and decided by the
// canonical street comparator (`sameStreetAddress`, the same one the
// membership snapshot uses): primary addresses on `customers`, and
// non-primary addresses on `customer_properties` (a member's second house
// lives there, not in customers.address_line1). Unit-aware: the candidate
// string carries address_line2, so with the comparator's default semantics
// a typed "Unit 4" excludes "Apt 7" at the same building while a typed
// address with no unit still matches every unit there.
//
// Bounded (50 per leg, deterministic order — codex #3338 r17) so a common
// house number cannot blow up the scan. Read-only. The property leg is
// best-effort (environments without the table skip it); the primary leg's
// errors propagate so callers choose fail-soft or fail-loud.
const logger = require('./logger');
const { sameStreetAddress, canonicalizeLeadingUnit } = require('./estimator-engine/address-compare');

const PER_LEG_LIMIT = 50;

// The complete leading house-number token, read from the street-first form
// the comparator uses. "123A Main St", "123-125 Main St", "123/2 Main St"
// and "Unit 7, 123 Main St" all yield the token stored rows begin with, so
// the ILIKE prefix cannot drop what the comparator would accept.
const HOUSE_NUMBER_RE = /^(\d{1,6}[a-z]?(?:[-\/]\d{1,6}[a-z]?)?)(?=\s)/i;

function houseNumberOf(address) {
  const street = canonicalizeLeadingUnit(String(address || '')).split(',')[0].trim();
  const houseNumber = (street.match(HOUSE_NUMBER_RE) || [])[1];
  if (!houseNumber || street.length < 6) return null;
  return houseNumber;
}

function candidateAddressString(row) {
  return [row.address_line1, row.address_line2, row.city, row.zip].filter(Boolean).join(', ');
}

/**
 * @returns {Promise<Array<object>>} customer rows (deduped by id) whose
 *   primary or property address is the same street address, each with
 *   `matchedVia: 'primary' | 'property'` and the matched address columns.
 */
async function findCustomersAtAddress(database, address, { excludeCustomerId = null } = {}) {
  const houseNumber = houseNumberOf(address);
  if (!houseNumber) return [];

  const primary = await database('customers')
    .where((q) => q.where('active', true).orWhereNull('active'))
    .whereNull('deleted_at')
    .where('address_line1', 'ilike', `${houseNumber} %`)
    .orderBy('id')
    .limit(PER_LEG_LIMIT)
    .select(
      'id', 'account_id', 'first_name', 'last_name', 'phone', 'email',
      'address_line1', 'address_line2', 'city', 'state', 'zip',
      'waveguard_tier', 'monthly_rate', 'pipeline_stage',
    );
  const candidates = primary.map((row) => ({ ...row, matchedVia: 'primary' }));

  try {
    const property = await database('customer_properties as cp')
      .join('customers as c', 'cp.customer_id', 'c.id')
      .where('cp.active', true)
      .where((q) => q.where('c.active', true).orWhereNull('c.active'))
      .whereNull('c.deleted_at')
      .where('cp.address_line1', 'ilike', `${houseNumber} %`)
      .orderBy('cp.id')
      .limit(PER_LEG_LIMIT)
      .select(
        'c.id', 'c.account_id', 'c.first_name', 'c.last_name', 'c.phone', 'c.email',
        'c.waveguard_tier', 'c.monthly_rate', 'c.pipeline_stage',
        'cp.address_line1', 'cp.address_line2', 'cp.city', 'cp.state', 'cp.zip',
      );
    candidates.push(...property.map((row) => ({ ...row, matchedVia: 'property' })));
  } catch (propErr) {
    logger.warn(`[customer-address-match] property-address leg skipped: ${propErr.message}`);
  }

  const seen = new Set();
  const matches = [];
  for (const row of candidates) {
    if (!row.address_line1) continue;
    if (excludeCustomerId != null && String(row.id) === String(excludeCustomerId)) continue;
    if (seen.has(String(row.id))) continue;
    if (!sameStreetAddress(candidateAddressString(row), address)) continue;
    seen.add(String(row.id));
    matches.push(row);
  }
  return matches;
}

module.exports = { findCustomersAtAddress, _private: { houseNumberOf, candidateAddressString } };
