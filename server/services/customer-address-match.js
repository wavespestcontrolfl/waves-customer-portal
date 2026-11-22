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
// toward over-suggesting.
//
// Bounded (50 per leg, deterministic order — codex #3338 r17) so a common
// house number cannot blow up the scan. Read-only. The property leg is
// best-effort (environments without the table skip it); the primary leg's
// errors propagate so callers choose fail-soft or fail-loud.
const logger = require('./logger');
const { sameStreetAddress, addressPremiseKey, addressUnitKey, canonicalizeLeadingUnit } = require('./estimator-engine/address-compare');

const PER_LEG_LIMIT = 50;
// strict: a far higher cap, and a leg that fills it throws (the search did
// not see every row, so "no match" would not be an answer).
const STRICT_LEG_LIMIT = 2000;
// strict: an address the search can never answer for (no readable house
// number, a leg that fills its cap). Its code tells it from a database error,
// which a caller may try again.
const UNCHECKABLE = 'ADDRESS_UNCHECKABLE';
const uncheckable = (why) => Object.assign(new Error(`customer-address-match: ${why}; the search is not complete`), { code: UNCHECKABLE });

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
 * `strict: true` throws when the property-address leg fails, instead of
 *   returning the primary leg alone (the primary leg always throws), and
 *   reads up to STRICT_LEG_LIMIT rows a leg, throwing when a leg fills it.
 *   An address it can never answer for throws with code ADDRESS_UNCHECKABLE.
 *   strict also keeps the NEAR rows: the same leading house digits and the
 *   same `zip` (a 5-digit option), but not the same street address to the
 *   comparator. Each row then carries `exactMatch: true | false`. A caller
 *   that must not miss a match treats a near row as "cannot tell": stored
 *   spellings the comparator does not read (a compound number written
 *   another way, a bare unit in line 2) land there instead of vanishing.
 * @returns {Promise<Array<object>>} customer rows (deduped by id) whose
 *   primary or property address is the same street address, each with
 *   `matchedVia: 'primary' | 'property'` and the matched address columns.
 */
async function findCustomersAtAddress(database, address, { excludeCustomerId = null, strict = false, zip = null } = {}) {
  const houseNumber = houseNumberOf(address);
  if (!houseNumber) {
    if (strict) throw uncheckable('no house number the search can read');
    return [];
  }
  const legLimit = strict ? STRICT_LEG_LIMIT : PER_LEG_LIMIT;
  // The candidate filter. Default: the line starts with the house number and a space. strict: the house number's
  // leading digits are a whole digit run anywhere in the line (a tab after it, a unit before it, "123/2" for
  // "123-2"), so the comparator and the near test see every row they could keep; the wider set is why strict has
  // the higher cap.
  const leadingDigits = houseNumber.match(/^\d+/)[0];
  const houseNumberFilter = (column) => (q) => (strict
    ? q.whereRaw('?? ~ ?', [column, `(^|[^0-9])${leadingDigits}([^0-9]|$)`])
    : q.where(column, 'ilike', `${houseNumber} %`));
  const nearZip = strict && /^\d{5}$/.test(String(zip || '')) ? String(zip) : null;
  const zip5 = (value) => String(value || '').trim().slice(0, 5);
  const complete = (rows, leg) => {
    if (strict && rows.length >= legLimit) throw uncheckable(`the ${leg} leg filled its ${legLimit}-row cap`);
    return rows;
  };

  const primary = await database('customers')
    .where((q) => q.where('active', true).orWhereNull('active'))
    .whereNull('deleted_at')
    .where(houseNumberFilter('address_line1'))
    .orderBy('id')
    .limit(legLimit)
    .select(
      'id', 'account_id', 'first_name', 'last_name', 'phone', 'email',
      'address_line1', 'address_line2', 'city', 'state', 'zip',
      'waveguard_tier', 'monthly_rate', 'pipeline_stage',
    );
  const candidates = complete(primary, 'primary').map((row) => ({ ...row, matchedVia: 'primary' }));

  try {
    const property = await database('customer_properties as cp')
      .join('customers as c', 'cp.customer_id', 'c.id')
      .where('cp.active', true)
      .where((q) => q.where('c.active', true).orWhereNull('c.active'))
      .whereNull('c.deleted_at')
      .where(houseNumberFilter('cp.address_line1'))
      .orderBy('cp.id')
      .limit(legLimit)
      .select(
        'c.id', 'c.account_id', 'c.first_name', 'c.last_name', 'c.phone', 'c.email',
        'c.waveguard_tier', 'c.monthly_rate', 'c.pipeline_stage',
        'cp.address_line1', 'cp.address_line2', 'cp.city', 'cp.state', 'cp.zip',
      );
    candidates.push(...complete(property, 'property-address').map((row) => ({ ...row, matchedVia: 'property' })));
  } catch (propErr) {
    // strict: a caller that must not read a partial list as "nobody else is here" gets the error instead.
    if (strict) throw propErr;
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
    matches.push(strict ? { ...row, exactMatch: true } : row);
  }
  if (!nearZip) return matches;
  for (const row of candidates) {
    if (!row.address_line1 || seen.has(String(row.id))) continue;
    if (excludeCustomerId != null && String(row.id) === String(excludeCustomerId)) continue;
    // A row with no zip on file cannot be told apart: near too.
    if (zip5(row.zip) && zip5(row.zip) !== nearZip) continue;
    seen.add(String(row.id));
    matches.push({ ...row, exactMatch: false });
  }
  return matches;
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
        // Same bucket = same unit key; a multi-unit pair needs a NAMED one.
        if ((x.multiUnit || y.multiUnit) && !(x.unit && y.unit)) continue;
        if (!sameStreetAddress(x.text, y.text, { requireExactUnit: true })) continue;
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

module.exports = { findCustomersAtAddress, rankByContact, pairCustomersAtSameAddress, ADDRESS_UNCHECKABLE: UNCHECKABLE, _private: { houseNumberOf, candidateAddressString } };
