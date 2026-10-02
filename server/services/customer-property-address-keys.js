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
  // USPS forms added 2026-10-01: a call re-recorded a "... Gln" signup address
  // as "... Glen" and minted a second property for one house. Changing this
  // map changes stored keys: migration 20261002090000 recomputes them.
  gln: 'glen', glen: 'glen', cv: 'cove', cove: 'cove', trce: 'trace', trace: 'trace',
  xing: 'crossing', crossing: 'crossing', lndg: 'landing', landing: 'landing',
  rdg: 'ridge', ridge: 'ridge', crk: 'creek', creek: 'creek', holw: 'hollow', hollow: 'hollow',
  sq: 'square', square: 'square', bnd: 'bend', bend: 'bend', aly: 'alley', alley: 'alley',
  vw: 'view', view: 'view', vis: 'vista', vista: 'vista', cswy: 'causeway', causeway: 'causeway',
  plz: 'plaza', plaza: 'plaza', pt: 'point', point: 'point', mdw: 'meadow', meadow: 'meadow',
  mdws: 'meadows', meadows: 'meadows', hts: 'heights', heights: 'heights', psge: 'passage', passage: 'passage',
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
 * Normalized key for the FULL service address — street + unit + locality — so
 * two units at one street ("100 Main Unit A" vs "Unit B") stay DISTINCT.
 * Suffix-canonical ("123 Main St" == "123 Main Street", "Gln" == "Glen") and
 * ZIP+4-insensitive. Only the STREET words are suffix-mapped; the unit keeps
 * unitKey's normalization, so a unit "PT" is never rewritten.
 *
 * Locality is the 5-digit ZIP when there is one, else the city: one ZIP
 * carries several mailing names (Parrish / Duette 34219, Bradenton /
 * Lakewood Ranch 34211), so the same house arrives under either, while
 * "100 Main St, Bradenton" vs "100 Main St, Sarasota" with no ZIP stay
 * distinct. Stored in customer_properties.address_key and uniquely indexed,
 * so the DB uniqueness uses this same normalization (no JS/SQL drift); any
 * change here needs a migration that recomputes the stored keys.
 */
const INLINE_UNIT_TAIL_RE = /\s(?:(?:apt|apartment|unit|ste|suite)\b|#)\s*(\S.*)$/i;

function addressKey({ address_line1, address_line2, city, zip } = {}) {
  // Punctuation first, so the unit is found the same way however it was
  // typed: "Apt 4." / "St#4" / "St, #4" all read as "St #4".
  const line1 = String(address_line1 || '').replace(/[.,]/g, ' ').replace(/#/g, ' #').replace(/\s+/g, ' ').trim();
  // The unit typed in line 1 is everything from its first designator on
  // ("Apt 4 Building A" / "Unit PT Building A" key like the same text in
  // line 2), so no unit is ever dropped or suffix-mapped. A street that is
  // itself named "Unit ..." reads as a unit too; both spellings of it then
  // still key alike, and the worst case is a second property, never a merge.
  const inline = line1.match(INLINE_UNIT_TAIL_RE);
  const street = streetKey(inline ? line1.slice(0, inline.index) : line1);
  // Both unit sources count ("100 Main St Apt 4" + "Building A" is not Apt
  // 5 in Building A); the same unit given twice counts once.
  const embedded = inline ? unitKey(inline[1]) : '';
  const line2 = unitKey(address_line2);
  const unit = embedded && line2 && embedded !== line2 ? `${embedded}${line2}` : (embedded || line2);
  const locality = normalizeZip(zip) || normStreet(city);
  return `${street}${unit}${locality}`;
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
