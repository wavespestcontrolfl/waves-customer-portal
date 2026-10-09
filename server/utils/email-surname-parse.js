'use strict';

/**
 * Surname from a caller's email address, for ONE caller first name.
 *
 * Only the separated forms `first.last@`, `first_last@` and `first-last@`
 * count, with the first part matching the caller's first name. An address
 * that runs the words together (`elizabethrealty@`) is never split: there is
 * no way to tell a surname from a business word, so it yields nothing.
 */

const { sameFirstName, normalizeNamePart } = require('./name-match');
const { titleCaseSurname } = require('./owner-name-parse');

// A last part made of (or ending in) one of these is a mailbox, not a person.
const BUSINESS_WORDS = new Set([
  'realty', 'realtor', 'realtors', 'realestate', 'homes', 'home', 'group', 'team', 'properties', 'property', 'sales',
  'office', 'info', 'admin', 'inc', 'llc', 'pest', 'lawn', 'mail', 'contact', 'support', 'service', 'services',
  'billing', 'accounting', 'hello', 'customer', 'marketing', 'management', 'mgmt', 'rentals', 'rental', 'leasing',
  'investments', 'construction', 'roofing', 'plumbing', 'electric', 'hvac', 'pool', 'pools', 'landscaping',
  'associates', 'agency', 'estate', 'listings', 'broker', 'orders', 'assistant', 'noreply',
]);
const SEPARATORS = ['.', '_', '-'];
const GIVEN_RE = /^[a-z]+$/;
const SURNAME_RE = /^[a-z](?:[a-z'-]*[a-z])?$/;

function surnameFromEmail(email, callerFirstName) {
  const callerFirst = normalizeNamePart(callerFirstName);
  const text = String(email || '').trim().toLowerCase();
  const at = text.lastIndexOf('@');
  if (!callerFirst || at < 1 || at === text.length - 1) return null;
  const local = text.slice(0, at).split('+')[0];
  const separator = SEPARATORS.find((s) => local.includes(s));
  const parts = separator ? local.split(separator) : [];
  if (parts.length !== 2) return null;
  const [given, surname] = parts;
  if (!GIVEN_RE.test(given) || !sameFirstName(normalizeNamePart(given), callerFirst)) return null;
  if (surname.length < 2 || !SURNAME_RE.test(surname)) return null;
  if (surname.split('-').some((piece) => BUSINESS_WORDS.has(piece))) return null;
  return titleCaseSurname(surname);
}

module.exports = { surnameFromEmail, BUSINESS_WORDS };
