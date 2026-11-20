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
// Set-wide form for the duplicates review queue: `pairCustomersAtSameAddress`
// runs the SAME comparator over a flat list of address candidates (every
// live customer's own address plus its active property rows) instead of one
// typed address, bucketed by house number so the work stays near-linear in
// the customers table. It is stricter on units on purpose — a unit on one
// side only is NOT the same premise there (requireExactUnit), because a
// merge candidate must name one household, where the finder above leans
// toward over-suggesting. Pairwise form, for two customer rows already in
// hand: `sameHouseholdAddress` (the same rule; the customer merge reads its
// sprinkler-timer premise with it).
//
// Bounded (50 per leg, deterministic order — codex #3338 r17) so a common
// house number cannot blow up the scan. Read-only. The property leg is
// best-effort (environments without the table skip it); the primary leg's
// errors propagate so callers choose fail-soft or fail-loud.
const logger = require('./logger');
const { sameStreetAddress, addressPremiseKey, addressUnitKey, canonicalizeLeadingUnit } = require('./estimator-engine/address-compare');

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

// The pairwise household rule on two premises ({ text, unit, multiUnit }) that
// each have a house number: a stacked building (multiUnit on either side) needs
// a named unit on both, and the canonical comparator must match with an exact
// unit. pairCustomersAtSameAddress confirms each bucketed pair with it;
// sameHouseholdAddress applies it to two customer rows.
function samePremise(x, y) {
  if ((x.multiUnit || y.multiUnit) && !(x.unit && y.unit)) return false;
  return sameStreetAddress(x.text, y.text, { requireExactUnit: true });
}

/**
 * Pure. `candidates` = [{ customerId, matchedVia, address_line1, address_line2,
 * city, zip, multiUnit? }] — one row per address a customer is known at.
 * `multiUnit` (set by the caller from the record's property type) means the
 * address belongs to a stacked building: such a row matches only a row that
 * names the SAME unit — two records with no unit at all are a building, not a
 * household (null === null is not a match). If either side is multi-unit the
 * pair is. Returns one entry
 * per unordered CUSTOMER pair with at least one address at the same premise:
 * `{ a, b, via: { a, b }, matched: { a: {...address, via}, b: {...} } }` (a < b
 * as strings; `matched` is the address row each side matched on). Rows with no
 * street line never pair. No I/O.
 *
 * Linear in the rows: candidates are bucketed by the comparator's own premise
 * key (house number + normalized street + unit, `addressPremiseKey`, from the
 * same parse `sameStreetAddress` uses), so a 300-unit building is 300 buckets
 * of one, not 45,000 comparisons. Only rows sharing a key are confirmed
 * pairwise with the comparator (which still decides ZIP and city).
 */
function pairCustomersAtSameAddress(candidates) {
  const buckets = new Map();
  for (const c of candidates) {
    if (!c || !c.customerId || !c.address_line1) continue;
    const text = candidateAddressString(c);
    // No leading house number = no parseable street address (PO boxes, bare
    // street names): never a household candidate.
    const key = houseNumberOf(text) ? addressPremiseKey(text) : null;
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({
      customerId: String(c.customerId),
      matchedVia: c.matchedVia || 'primary',
      text,
      multiUnit: c.multiUnit === true,
      unit: addressUnitKey(text),
      address: { address_line1: c.address_line1, address_line2: c.address_line2 || null, city: c.city || null, zip: c.zip || null },
    });
  }
  const pairs = new Map();
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const x = bucket[i];
        const y = bucket[j];
        if (x.customerId === y.customerId) continue;
        const [lo, hi] = x.customerId < y.customerId ? [x, y] : [y, x];
        const pairId = `${lo.customerId}:${hi.customerId}`;
        if (pairs.has(pairId)) continue;
        // Same bucket = same unit key; samePremise asks a multi-unit pair for a NAMED one.
        if (!samePremise(x, y)) continue;
        pairs.set(pairId, {
          a: lo.customerId,
          b: hi.customerId,
          via: { a: lo.matchedVia, b: hi.matchedVia },
          matched: { a: { ...lo.address, via: lo.matchedVia }, b: { ...hi.address, via: hi.matchedVia } },
        });
      }
    }
  }
  return [...pairs.values()];
}

/**
 * Pure. Two address rows ({ address_line1, address_line2, city, zip,
 * multiUnit? }) name one household by the duplicates queue's rule: both have a
 * street line with a leading house number ("123/2" and "123-125" count; a PO
 * box or a bare street name has none and is never a household), and
 * samePremise holds (a named, equal unit for a stacked building; the canonical
 * comparator with an exact unit).
 */
function sameHouseholdAddress(rowA, rowB) {
  if (!rowA?.address_line1 || !rowB?.address_line1) return false;
  const premise = (row) => {
    const text = candidateAddressString(row);
    return { text, unit: addressUnitKey(text), multiUnit: row.multiUnit === true };
  };
  const [x, y] = [premise(rowA), premise(rowB)];
  return !!(houseNumberOf(x.text) && houseNumberOf(y.text)) && samePremise(x, y);
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

module.exports = { findCustomersAtAddress, rankByContact, pairCustomersAtSameAddress, sameHouseholdAddress, _private: { houseNumberOf, candidateAddressString } };
