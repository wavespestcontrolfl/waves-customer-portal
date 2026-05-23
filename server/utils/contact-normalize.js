const { toE164 } = require('./phone');
const { properCase } = require('./name-case');

function normalizeEmail(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  return trimmed.toLowerCase();
}

function normalizePhoneToE164(value) {
  return toE164(value);
}

function properCaseName(value) {
  return properCase(value);
}

function collapseWhitespace(value) {
  if (value === null || value === undefined) return value;
  return String(value).trim().replace(/\s+/g, ' ');
}

module.exports = {
  normalizeEmail,
  normalizePhoneToE164,
  properCaseName,
  collapseWhitespace,
};
