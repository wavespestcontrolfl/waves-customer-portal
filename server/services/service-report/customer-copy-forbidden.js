/**
 * Forbidden customer-copy patterns shared by the report copy guards. Pure:
 * no I/O and no database import, so pure modules (the lawn expectations
 * engine) can use the same check without loading models/db.js.
 */

const FORBIDDEN_PATTERNS = [
  /\binfestation\b/i,
  /\beliminated\b/i,
  /\bguaranteed\b/i,
  /\bdangerous\b/i,
  /\btoxic\b/i,
  /\bpoison\b/i,
  /\bunsafe\b/i,
  /\bdeadly\b/i,
  /\bapocalypse\b/i,
  /\bwar zone\b/i,
];

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function validateCustomerCopy(text) {
  const copy = cleanText(text);
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(copy)) return false;
  }
  return true;
}

module.exports = { FORBIDDEN_PATTERNS, validateCustomerCopy };
