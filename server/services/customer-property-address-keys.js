// Pure address keys for customer properties. No database: split out of
// customer-properties.js so callers that only need a key (the lawn history
// resolver, and through it the read-only P13 replay) never load models/db.

/** Case/space/punctuation-insensitive street key — "12338 Amber Creek" ≠ "12398 Amber Creek". */
const normStreet = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Canonical street-suffix forms. We EXPAND abbreviations to one canonical spelling
// (st -> street) so "123 Main St" and "123 Main Street" key identically — but we
// never STRIP the suffix, so "Main St" and "Main Ave" stay DISTINCT streets.
const STREET_SUFFIX_CANON = {
  st: 'street', street: 'street', ave: 'avenue', avenue: 'avenue', rd: 'road', road: 'road',
  dr: 'drive', drive: 'drive', ln: 'lane', lane: 'lane', ct: 'court', court: 'court',
  blvd: 'boulevard', boulevard: 'boulevard', cir: 'circle', circle: 'circle',
  pl: 'place', place: 'place', ter: 'terrace', terrace: 'terrace', way: 'way',
  trl: 'trail', trail: 'trail', pkwy: 'parkway', parkway: 'parkway', hwy: 'highway', highway: 'highway',
};
const canonicalizeAddress = (s) => String(s || '').toLowerCase().replace(/[.,#]/g, ' ')
  .split(/\s+/).map((w) => STREET_SUFFIX_CANON[w] || w).join(' ');

/** First 5 ZIP digits, so "34205" and "34205-1234" (ZIP+4) key identically. */
const normalizeZip = (z) => (String(z || '').match(/\d{5}/) || [''])[0];

// Strip a trailing unit designator so a STREET-ONLY comparison ignores units
// (units are compared separately and preserved in the full addressKey): a legacy
// "100 Main St Apt 4" and a later "100 Main St" share the same street key.
const stripTrailingUnit = (s) => String(s || '').replace(/\s+(?:apt|apartment|unit|ste|suite|#)\.?\s*[a-z0-9-]+\s*$/i, '').trim();

/** Suffix-canonical, unit-stripped street key — "123 Main St" == "123 Main Street", but != "123 Main Ave". */
const streetKey = (s) => canonicalizeAddress(stripTrailingUnit(s)).replace(/[^a-z0-9]/g, '');

// Interchangeable unit designators are written loosely for the SAME unit, so
// strip the designator WORD wherever it appears (in line2 OR embedded in line1) —
// "Apt 4" / "Unit 4" / "Ste 4" / "#4" / "4", and "100 Main St Apt 4" vs
// "100 Main St" + "Apt 4", all key identically. The bare unit id is preserved so
// different units stay distinct. Same designator set stripTrailingUnit recognizes.
const stripUnitDesignators = (s) => String(s || '')
  .replace(/[.,#]/g, ' ')
  .replace(/\b(?:apt|apartment|unit|ste|suite)\b\.?/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Normalized key for the FULL service address — street + unit + city + ZIP — so
 * "100 Main St, Bradenton" and "100 Main St, Sarasota" are DISTINCT, and so are
 * two units at one street ("100 Main Unit A" vs "Unit B"). Suffix-canonical
 * ("123 Main St" == "123 Main Street") and ZIP+4-insensitive. Stored in the
 * customer_properties.address_key column and uniquely indexed, so the DB
 * uniqueness uses the SAME normalization as this helper (no JS/SQL drift).
 */
function addressKey({ address_line1, address_line2, city, zip } = {}) {
  // Strip unit designators across the COMBINED street + unit so an embedded unit
  // ("100 Main St Apt 4") keys the same as the split form ("100 Main St" + "Apt 4").
  const streetUnit = stripUnitDesignators([address_line1, address_line2].filter(Boolean).join(' '));
  return canonicalizeAddress([streetUnit, city, normalizeZip(zip)].filter(Boolean).join(' ')).replace(/[^a-z0-9]/g, '');
}

/**
 * The bare unit token from a UNIT string (a line2 like "Apt 4" / "Unit 4" / "#4" /
 * "4"), with interchangeable designators stripped, so they all collapse to "4" —
 * the SAME normalization addressKey applies. Use this (not a raw normStreet, which
 * keeps the designator word) when comparing two units for equality, so the
 * classifier can't disagree with the dedup key. Pass a unit string, NOT a street.
 */
function unitKey(s) {
  return normStreet(stripUnitDesignators(s));
}

/**
 * The trailing unit embedded in a ONE-LINE street ("100 Main St Apt 4" → "4"),
 * anchored to a designator + end-of-string so a bare number is NOT pulled out of a
 * house number ("14 Main St" → ""). '#' is kept OUT of the \b group — \b is a word
 * boundary and '#' is a non-word char, so "\b#" never matches "St #4".
 */
function streetEmbeddedUnitKey(s) {
  const m = String(s || '').match(/(?:\b(?:apt|apartment|unit|ste|suite)|#)\.?\s*([a-z0-9-]+)\s*$/i);
  return m ? normStreet(m[1]) : '';
}

module.exports = {
  normStreet,
  STREET_SUFFIX_CANON,
  canonicalizeAddress,
  normalizeZip,
  stripTrailingUnit,
  streetKey,
  stripUnitDesignators,
  addressKey,
  unitKey,
  streetEmbeddedUnitKey,
};
