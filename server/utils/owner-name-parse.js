'use strict';

/**
 * Surname from a county parcel-owner string, for ONE caller first name.
 *
 * The call pipeline (services/call-last-name-lookup.js) uses this to fill an
 * empty customers.last_name from the county owner record. It is deliberately
 * strict: a wrong surname on a customer is worse than a blank one, so every
 * doubtful shape returns null.
 *
 * County formats (live-probed 2026-10-08; the examples below are invented):
 *   Manatee   `LAST, FIRST M`                   "SAMPLE, PAT Q"
 *   Sarasota  `LAST FIRST MIDDLE [SUFFIX] [(note)]`  "EXAMPLE ROBIN L JR (E LIFE EST)"
 *   Charlotte `LAST FIRST M & FIRST2 [M] [LAST2]`    "SAMPLE PAT Q & ROBIN L SAMPLE"
 *
 * Rules:
 *   - Parenthetical notes and trailing suffixes (JR, SR, II, TRUSTEE, ET AL,
 *     LIFE EST ...) are dropped; an entity owner (LLC, TRUST, BANK ...) is null.
 *   - The caller's first name must be the given name right after the surname
 *     (never a middle name). Comparison is sameFirstName (nickname groups).
 *   - A multi-word surname is a run of leading particles (VAN, DE, LA ...)
 *     plus the next word: `VAN DYKE JOHN` + John is "Van Dyke". Any other
 *     unhyphenated multi-word surname does not parse (null).
 *   - Charlotte: a later `&` owner matches only when it is the caller's name
 *     alone, the name plus single-letter initials (shares the first surname),
 *     or the name plus the SAME surname.
 *   - Across all owners of one parcel the answer must be one distinct surname.
 * Casing goes through the shared properCase, except the Mac prefix: county
 * rolls are upper case, so "MACHADO" cannot be told from "MACDONALD" and
 * properCase's Mac+capital guess ("MacHado") is worse than "Machado".
 */

const { sameFirstName, normalizeNamePart } = require('./name-match');
const { properCase } = require('./name-case');

// A whole-string match on any of these means the owner is not a person.
const ENTITY_WORDS = new Set([
  'LLC', 'INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LP', 'LLP', 'PARTNERSHIP', 'PARTNERS',
  'TRUST', 'TRUSTS', 'LIVING', 'REVOCABLE', 'IRREVOCABLE', 'ESTATE', 'EST',
  'BANK', 'ASSOCIATION', 'ASSN', 'ASSOC', 'HOA', 'CONDOMINIUM', 'CONDO', 'HOMEOWNERS', 'COMMUNITY',
  'CHURCH', 'MINISTRIES', 'MINISTRY', 'FOUNDATION', 'SCHOOL', 'DISTRICT', 'AUTHORITY', 'BOARD',
  'COUNTY', 'CITY', 'STATE',
  'HOLDINGS', 'PROPERTIES', 'INVESTMENTS', 'APARTMENTS', 'HOMES',
]);
// Dropped from the END of a name segment (a trailing run, in any order).
const SUFFIX_WORDS = new Set(['JR', 'SR', 'II', 'III', 'IV', 'TRUSTEE', 'TRUSTEES', 'TTEE', 'TTEES', 'ETAL']);
// A leading run of these belongs to the surname with the word after it.
const SURNAME_PARTICLES = new Set([
  'VAN', 'VON', 'DE', 'DEL', 'DELLA', 'DI', 'DA', 'DOS', 'DAS', 'LA', 'LE', 'DER', 'DEN', 'DU', 'ST', 'SAN', 'SANTA', 'MC', 'MAC', 'AL', 'EL', 'BIN', 'IBN',
]);
const COUNTY_KEYS = { manatee: 'Manatee', sarasota: 'Sarasota', charlotte: 'Charlotte' };
const TOKEN_RE = /^[A-Z](?:[A-Z'-]*[A-Z])?$/;
const PLAIN_CHARS_RE = /^[A-Z ,&'-]+$/;

function titleCaseSurname(text) {
  return properCase(text).replace(/(^|[ '-])Mac([A-Z])/g, (m, lead, c) => `${lead}Mac${c.toLowerCase()}`);
}

// Upper case, notes and legal tails removed, or null when the string is not
// a plain personal-name shape (digits, slashes, an address line, an entity).
function cleanOwnerString(raw) {
  const text = String(raw || '').toUpperCase().replace(/\./g, '')
    .replace(/\([^)]*\)?/g, ' ')
    .replace(/\bLIFE\s+EST(?:ATE)?\b/g, ' ')
    .replace(/\bET\s*(?:AL|UX|VIR)\b/g, ' ')
    .replace(/\bAS\s+TRUSTEES?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || !PLAIN_CHARS_RE.test(text)) return null;
  if (/\bL\s?L\s?C\b|\bL\s?L\s?P\b|\bL\s?P\b/.test(text)) return null;
  const words = text.split(/[^A-Z']+/).filter(Boolean);
  return words.some((w) => ENTITY_WORDS.has(w)) ? null : text;
}

// Name words of one segment, trailing suffixes dropped; null when any word is
// not a plain name word.
function segmentTokens(segment) {
  const tokens = String(segment || '').split(/[\s,]+/).filter(Boolean);
  while (tokens.length && SUFFIX_WORDS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.length && tokens.every((t) => TOKEN_RE.test(t)) ? tokens : null;
}

// `SURNAME... GIVEN [MIDDLE...]` -> { surname: [...], given: [...] }.
function splitSurnameFirst(tokens) {
  if (!tokens) return null;
  let run = 0;
  while (run < tokens.length - 1 && SURNAME_PARTICLES.has(tokens[run])) run += 1;
  run += 1;
  return run < tokens.length ? { surname: tokens.slice(0, run), given: tokens.slice(run) } : null;
}

const sameGiven = (token, callerFirst) => sameFirstName(normalizeNamePart(token), callerFirst);

function manateeSurname(text, callerFirst) {
  const comma = text.indexOf(',');
  if (comma < 0) return null;
  const left = segmentTokens(text.slice(0, comma));
  const right = segmentTokens(text.slice(comma + 1).split('&')[0]);
  return left && right && sameGiven(right[0], callerFirst) ? left : null;
}

// Sarasota reads the primary owner only (before any `&`).
function sarasotaSurname(text, callerFirst) {
  const parts = splitSurnameFirst(segmentTokens(text.split('&')[0]));
  return parts && sameGiven(parts.given[0], callerFirst) ? parts.surname : null;
}

function laterOwnerMatches(tokens, surname, callerFirst) {
  if (!tokens || !sameGiven(tokens[0], callerFirst)) return false;
  if (tokens.slice(1).every((t) => t.length === 1)) return true; // name alone, or name + initials
  const tail = tokens.slice(-surname.length);
  return tokens.length > surname.length && tail.every((t, i) => t === surname[i]);
}

function charlotteSurname(text, callerFirst) {
  const [head, ...later] = text.split('&');
  const parts = splitSurnameFirst(segmentTokens(head));
  if (!parts) return null;
  if (sameGiven(parts.given[0], callerFirst)) return parts.surname;
  return later.some((seg) => laterOwnerMatches(segmentTokens(seg), parts.surname, callerFirst))
    ? parts.surname : null;
}

const COUNTY_PARSERS = { Manatee: manateeSurname, Sarasota: sarasotaSurname, Charlotte: charlotteSurname };

/**
 * @param {string} ownerString one raw owner string from the county layer
 * @param {string} callerFirstName
 * @param {string} county 'Manatee' | 'Sarasota' | 'Charlotte' ("Manatee County" accepted)
 * @returns {string|null} title-cased surname, or null
 */
function surnameForFirstName(ownerString, callerFirstName, county) {
  const countyKey = COUNTY_KEYS[String(county || '').trim().replace(/\s+county$/i, '').toLowerCase()];
  const callerFirst = normalizeNamePart(callerFirstName);
  if (!countyKey || !callerFirst) return null;
  const text = cleanOwnerString(ownerString);
  if (!text) return null;
  const surname = COUNTY_PARSERS[countyKey](text, callerFirst);
  const joined = surname ? surname.join(' ') : '';
  return normalizeNamePart(joined).length >= 2 ? titleCaseSurname(joined) : null;
}

/**
 * Every owner string of ONE parcel: exactly one distinct surname (compared
 * case-insensitively) or null.
 */
function surnameFromOwnerNames(ownerStrings, callerFirstName, county) {
  const found = new Map();
  for (const owner of Array.isArray(ownerStrings) ? ownerStrings : []) {
    const surname = surnameForFirstName(owner, callerFirstName, county);
    if (surname) found.set(surname.toLowerCase(), surname);
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

module.exports = { surnameForFirstName, surnameFromOwnerNames, titleCaseSurname };
