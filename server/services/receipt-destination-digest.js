/**
 * The digest of a receipt destination (an email address or a phone), so the Intelligence Bar's record_payment card can hand the
 * settlement the destinations it approved without carrying a raw address or number in the card's pins. Email: trimmed, lowercased.
 * Phone: its last 10 digits. null when there is no destination.
 */
const crypto = require('crypto');

const hash = (kind, value) => crypto.createHash('sha256').update(`${kind}:${value}`).digest('hex').slice(0, 32);
const emailDigest = (email) => {
  const v = String(email || '').trim().toLowerCase();
  return v ? hash('email', v) : null;
};
const phoneDigest = (phone) => {
  const v = String(phone || '').replace(/\D/g, '').slice(-10);
  return v ? hash('phone', v) : null;
};

module.exports = { emailDigest, phoneDigest };
