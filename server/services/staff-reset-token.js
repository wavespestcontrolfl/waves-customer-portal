/**
 * The one-time token behind a staff set-password link, minted by the
 * password-reset request (routes/admin-auth.js issuePasswordReset) and redeemed
 * by the POST /reset-password lookup. Only the hash is stored; the token itself
 * exists in the emailed link alone.
 */
const crypto = require('crypto');

const RESET_TOKEN_BYTES = 32;
// A link an admin sends lives exactly this long (7 days); a reset request's own is shorter.
const HIRE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function mintResetToken() {
  const token = crypto.randomBytes(RESET_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashResetToken(token) };
}

// A staff row with a linked Google address and no password signs in with
// Google (owner 2026-11-21 "GOOGLE"). The email on it can be one typed on a
// job application, which nobody proved, so a reset request never creates its
// first password, whatever made the row active (the Team tab's Activate or
// its edit form).
// - The request (admin-auth issuePasswordReset) issues no link for such a row.
// - The redeem (admin-auth resetPassword) lets only a link an admin sent set
//   that first password. The stored link itself says which it is. Every
//   issuer writes the link's request time and expiry in the UPDATE that stores
//   its hash, from one clock read: an admin-sent link stores exactly
//   HIRE_LINK_TTL_MS (the Team tab no longer sends one; the rule still covers a
//   link stored by an older build), a reset request stores its own shorter
//   time. A reset request that replaced an admin's link replaced its lifetime
//   with it. Any other lifetime, and a link with no request time, reads as a
//   reset request's.
// "No password" is NULL or an empty value, as the Team tab reads it.
const resetClosed = (row) => row.google_email != null && !row.password_hash;
const adminSentLink = (row) => Boolean(row.password_reset_requested_at && row.password_reset_expires_at)
  && new Date(row.password_reset_expires_at) - new Date(row.password_reset_requested_at) === HIRE_LINK_TTL_MS;
const redeemClosed = (row) => resetClosed(row) && !adminSentLink(row);
// The same rule for the redeem's UPDATE, with its one binding (seconds).
const REDEEM_CLOSED_SQL = `(google_email IS NOT NULL AND COALESCE(password_hash, '') = ''
  AND EXTRACT(EPOCH FROM (password_reset_expires_at - password_reset_requested_at)) IS DISTINCT FROM ?)`;
const REDEEM_CLOSED_BINDINGS = [HIRE_LINK_TTL_MS / 1000];

module.exports = {
  RESET_TOKEN_BYTES, HIRE_LINK_TTL_MS, hashResetToken, mintResetToken, resetClosed, redeemClosed, REDEEM_CLOSED_SQL, REDEEM_CLOSED_BINDINGS,
};
