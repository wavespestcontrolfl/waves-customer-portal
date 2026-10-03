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
//
// `complete: true` is the strict mode for a caller that must claim "exactly one"
// (the call booker's household hold): NO row limit (a limit could hide a second
// household), the unit must be EXACTLY equal (a unit on one side only is another
// door), EVERY error propagates (a failed property leg is not "no match"), every
// matching address source is returned (a customer can appear once per source, so
// the caller can judge the source that matched), and each row also carries
// `active`, `customer_property_type`, `source_property_type` and
// `source_occupancy_type`. The default mode is unchanged.
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
async function findCustomersAtAddress(database, address, { excludeCustomerId = null, complete = false } = {}) {
  const houseNumber = houseNumberOf(address);
  if (!houseNumber) return [];
  const limit = complete ? null : PER_LEG_LIMIT;

  const primaryQuery = database('customers')
    .where((q) => q.where('active', true).orWhereNull('active'))
    .whereNull('deleted_at')
    .where('address_line1', 'ilike', `${houseNumber} %`)
    .orderBy('id');
  const primary = await (limit ? primaryQuery.limit(limit) : primaryQuery)
    .select(
      'id', 'account_id', 'first_name', 'last_name', 'phone', 'email',
      'address_line1', 'address_line2', 'city', 'state', 'zip',
      'waveguard_tier', 'monthly_rate', 'pipeline_stage',
      ...(complete ? ['active', 'property_type as customer_property_type', 'property_type as source_property_type'] : []),
    );
  const candidates = primary.map((row) => ({ ...row, matchedVia: 'primary' }));

  const propertyLeg = async () => {
    const propertyQuery = database('customer_properties as cp')
      .join('customers as c', 'cp.customer_id', 'c.id')
      .where('cp.active', true)
      .where((q) => q.where('c.active', true).orWhereNull('c.active'))
      .whereNull('c.deleted_at')
      .where('cp.address_line1', 'ilike', `${houseNumber} %`)
      .orderBy('cp.id');
    const property = await (limit ? propertyQuery.limit(limit) : propertyQuery)
      .select(
        'c.id', 'c.account_id', 'c.first_name', 'c.last_name', 'c.phone', 'c.email',
        'c.waveguard_tier', 'c.monthly_rate', 'c.pipeline_stage',
        'cp.address_line1', 'cp.address_line2', 'cp.city', 'cp.state', 'cp.zip',
        ...(complete ? ['c.active', 'c.property_type as customer_property_type',
          'cp.property_type as source_property_type', 'cp.occupancy_type as source_occupancy_type'] : []),
      );
    candidates.push(...property.map((row) => ({ ...row, matchedVia: 'property' })));
  };
  if (complete) {
    // Fail closed: an unreadable property leg must fail the caller, not read as "no match".
    await propertyLeg();
  } else {
    try {
      await propertyLeg();
    } catch (propErr) {
      logger.warn(`[customer-address-match] property-address leg skipped: ${propErr.message}`);
    }
  }

  const seen = new Set();
  const matches = [];
  for (const row of candidates) {
    if (!row.address_line1) continue;
    if (excludeCustomerId != null && String(row.id) === String(excludeCustomerId)) continue;
    // complete mode keeps one row per matching SOURCE (the caller judges the source that matched).
    if (!complete && seen.has(String(row.id))) continue;
    if (!sameStreetAddress(candidateAddressString(row), address, complete ? { requireExactUnit: true } : undefined)) continue;
    seen.add(String(row.id));
    matches.push(row);
  }
  return matches;
}

const phoneKey = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const emailKey = (v) => String(v || '').trim().toLowerCase();

/**
 * Same-address matches, contact matches first. When the operator already
 * has a phone or email on the form (lead prefill, typed before lookup), the
 * row whose phone (last 10) or email equals it is the person they mean —
 * it leads the list with `contactMatch: 'phone' | 'email'`; everyone else
 * keeps the query order with `contactMatch: null`. Pure; stable.
 */
function rankByContact(rows, { phone = null, email = null } = {}) {
  const p = phoneKey(phone);
  const e = emailKey(email);
  const tagged = rows.map((row) => {
    let contactMatch = null;
    if (p.length === 10 && phoneKey(row.phone) === p) contactMatch = 'phone';
    else if (e && emailKey(row.email) === e) contactMatch = 'email';
    return { ...row, contactMatch };
  });
  return [...tagged.filter((r) => r.contactMatch), ...tagged.filter((r) => !r.contactMatch)];
}

module.exports = { findCustomersAtAddress, rankByContact, _private: { houseNumberOf, candidateAddressString } };
