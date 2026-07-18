const TWILIO_NUMBERS = require('../config/twilio-numbers');

function last10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// Twilio/carrier caller-ID sentinels. These values identify suppressed calls,
// not deliverable customer phones.
const PHONE_SENTINELS = new Set(['266696687', '7378742833', '86282452253']);
const PHONE_SENTINEL_WORDS = /^(anonymous|restricted|unavailable|unknown|blocked)$/i;

function isSentinelPhone(value) {
  const text = String(value || '').trim();
  if (PHONE_SENTINEL_WORDS.test(text)) return true;
  const digits = text.replace(/\D/g, '');
  return PHONE_SENTINELS.has(digits) || PHONE_SENTINELS.has(digits.replace(/^1/, ''));
}

function firstExternalPhone(...candidates) {
  for (const candidate of candidates) {
    const value = candidate && String(candidate).trim();
    if (value && last10(value) && !TWILIO_NUMBERS.isInternalNumber(value) && !isSentinelPhone(value)) {
      return value;
    }
  }
  return null;
}

module.exports = { firstExternalPhone, isSentinelPhone, last10 };
