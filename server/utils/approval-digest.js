/**
 * The Intelligence Bar's approval digest: a short hash of a value the card pinned (a phone, an email address, a message text).
 * The card hands the digest to the code that sends, which hashes what is live at dispatch the same way and refuses on a
 * difference. The preview carries the digest, never the phone or address itself.
 */
const crypto = require('crypto');

const approvalDigest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const phoneKey = (value) => String(value || '').replace(/\D/g, '') || null;
const emailKey = (value) => (value ? String(value).trim().toLowerCase() || null : null);

module.exports = { approvalDigest, phoneKey, emailKey };
