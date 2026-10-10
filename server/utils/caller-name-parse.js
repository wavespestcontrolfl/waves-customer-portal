'use strict';

/**
 * Surname from a Twilio Lookup v2 caller name (CNAM), for ONE customer first name.
 *
 * CNAM is a carrier line-name field: upper case, cut at 15 characters, in no
 * fixed order ("SAMPLE PAT", "PAT SAMPLE", "SAMPLE,PAT", "PAT Q SAMPLE").
 * Proven on a real-data test (owner 2026-10-08): answers that pass these
 * rules matched the name on file. Rules, all strict:
 *   - no name, or "UNKNOWN": nothing;
 *   - caller_type BUSINESS: nothing;
 *   - a raw name of 15 characters or more: nothing (cut off, so the surname
 *     may be truncated);
 *   - everything but letters, apostrophe, hyphen and space becomes a space
 *     (so the comma form splits), and single-letter tokens (initials) go;
 *   - EXACTLY ONE token is the customer's first name (sameFirstName, nickname
 *     groups; both sides normalized first);
 *   - EXACTLY ONE token remains, and it is the surname.
 */

const { sameFirstName, normalizeNamePart } = require('./name-match');
const { titleCaseSurname } = require('./owner-name-parse');

const CNAM_CUT_LENGTH = 15;

/**
 * @param {{ name?: string|null, callerType?: string|null }} callerName
 * @param {string} customerFirstName
 * @returns {string|null} title-cased surname, or null
 */
function surnameFromCallerName({ name, callerType } = {}, customerFirstName) {
  const raw = typeof name === 'string' ? name.trim() : '';
  const first = normalizeNamePart(customerFirstName);
  if (!raw || !first || raw.toUpperCase() === 'UNKNOWN') return null;
  if (String(callerType || '').trim().toUpperCase() === 'BUSINESS') return null;
  if (raw.length >= CNAM_CUT_LENGTH) return null;
  const tokens = raw.replace(/[^A-Za-z'\- ]/g, ' ').split(/\s+/)
    .filter((t) => t.replace(/[^A-Za-z]/g, '').length >= 2);
  const givenHits = tokens.filter((t) => sameFirstName(normalizeNamePart(t), first));
  if (givenHits.length !== 1) return null;
  const rest = tokens.filter((t) => t !== givenHits[0]);
  return rest.length === 1 ? titleCaseSurname(rest[0]) : null;
}

module.exports = { surnameFromCallerName, CNAM_CUT_LENGTH };
