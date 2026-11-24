'use strict';

/**
 * The short typed address of one new home (mailer step 2d-2): the postcard prints "gowavesfl.com/101-example" beside
 * its QR code, and GET /nh/:slug (routes/mail-home-short-link.js) sends it to the home's page. Owner rulings 2026-11-23:
 * the house number and the street NAME only (no street type, no random code); the ZIP is added only when two homes
 * clash ("101-example-34211"); nobody minds that a slug can be guessed.
 *
 * Pure functions, no database. The store (prospect-store.js assignPageSlug) picks the first candidate the unique index
 * accepts, so "taken by another home" is decided there, race-free.
 *
 * The county writes the line in capitals: "101 EXAMPLE TRL", "4512 N RIVER OAKS DR", "123 SW 5TH AVE",
 * "88 LAKE VIEW BLVD UNIT 3".
 */

// The shape the table's CHECK and the redirect route both accept.
const SLUG_RE = /^[0-9]+-[a-z0-9]+(-[a-z0-9]+)*$/;
// "short typed address": a longer name than this gets no slug and the card prints the QR code only.
const MAX_SLUG_LENGTH = 60;
const MAX_NUMBER_DIGITS = 7;

// USPS Publication 28, appendix C1, from the shared table (property-lookup/usps-street-suffixes.js): every suffix name,
// variant and standard abbreviation. A word is a suffix only when it is the LAST word of the street (see buildBaseSlug),
// so a name such as "LAKE VIEW" keeps "LAKE".
const { USPS_STREET_SUFFIXES } = require('../property-lookup/usps-street-suffixes');
const STREET_SUFFIXES = new Set([...Object.keys(USPS_STREET_SUFFIXES), ...Object.values(USPS_STREET_SUFFIXES)]);

// A directional that follows the street type ("123 MAIN ST NW"). The suffix before it is dropped, the directional stays.
const DIRECTIONALS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

// Where the unit part of a line starts: "88 LAKE VIEW BLVD UNIT 3", "12 OAK ST APT 4B", "5 MAIN ST #7". Looked for
// after the street's first word, so a street that starts with one of these words is not cut. Words that are also street names (SPACE, OFFICE,
// BUILDING) are left out.
const UNIT_WORDS = new Set([
  'UNIT', 'APT', 'APTS', 'APARTMENT', 'STE', 'SUITE', 'BLDG', 'LOT', 'SPC', 'TRLR', 'RM', 'FLOOR',
]);

const stripMarks = (text) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function tokensOf(addressLine1) {
  return stripMarks(String(addressLine1 == null ? '' : addressLine1))
    .toUpperCase()
    .replace(/,/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
}

/**
 * The slug without a ZIP, or null when the line gives none.
 *   - the first word must be the house number, digits only: "12A", "12-14", "12B" and a fraction ("12 1/2") give null,
 *     and so does a number of more than 7 digits; leading zeros are dropped;
 *   - the unit part (UNIT, APT, STE, #, ... and everything after it) is dropped;
 *   - the last word is dropped when it is a street type (TRL, DR, BLVD, ...), also when a directional follows it
 *     ("123 MAIN ST NW" is "123-main-nw"); a street that is only its type word keeps it ("5 PARK");
 *   - the rest (directionals, numbers, the name) is lowercase, every run of other characters becomes one dash.
 * Nothing left after the number: null. A slug over 60 characters: null (the card prints the QR code only).
 */
function buildBaseSlug(addressLine1) {
  const tokens = tokensOf(addressLine1);
  if (tokens.length < 2 || !/^\d+$/.test(tokens[0])) return null;
  const number = tokens[0].replace(/^0+/, '');
  if (!number || number.length > MAX_NUMBER_DIGITS) return null;
  if (/^\d+\/\d+$/.test(tokens[1])) return null; // "12 1/2 MAIN ST": half an address is no address

  let name = tokens.slice(1);
  const unitAt = name.findIndex((token, i) => token.startsWith('#') || (i >= 1 && UNIT_WORDS.has(token)));
  if (unitAt >= 0) name = name.slice(0, unitAt);

  // Trailing directionals ("MAIN ST NW"): set aside, then the street type before them.
  const tail = [];
  while (name.length > 2 && DIRECTIONALS.has(name[name.length - 1]) && STREET_SUFFIXES.has(name[name.length - 2])) {
    tail.unshift(name.pop());
  }
  if (name.length > 1 && STREET_SUFFIXES.has(name[name.length - 1])) name.pop();
  name = name.concat(tail);

  const text = name.join(' ').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!text) return null;
  const slug = `${number}-${text}`;
  return SLUG_RE.test(slug) && slug.length <= MAX_SLUG_LENGTH ? slug : null;
}

const zip5Of = (zip) => (String(zip == null ? '' : zip).match(/\d{5}/) || [null])[0];

/**
 * The slugs a home may take, best first: the plain one, then the one with its ZIP added. The store takes the first the
 * unique index accepts; if both are taken the home has no slug. Empty when the address gives none.
 */
function slugCandidates({ addressLine1, zip } = {}) {
  const base = buildBaseSlug(addressLine1);
  if (!base) return [];
  const zip5 = zip5Of(zip);
  const withZip = zip5 ? `${base}-${zip5}` : null;
  return withZip && withZip.length <= MAX_SLUG_LENGTH && SLUG_RE.test(withZip) ? [base, withZip] : [base];
}

module.exports = { buildBaseSlug, slugCandidates, SLUG_RE, MAX_SLUG_LENGTH, STREET_SUFFIXES };
