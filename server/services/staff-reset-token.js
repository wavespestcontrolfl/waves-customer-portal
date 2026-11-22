/**
 * The one-time token behind a staff set-password link. Shared by the
 * password-reset request (routes/admin-auth.js issuePasswordReset) and the
 * Staff page "Hired" button (routes/admin-timetracking.js), so a token minted
 * by either one is redeemed by the same POST /reset-password lookup. Only the
 * hash is stored; the token itself exists in the emailed link alone.
 */
const crypto = require('crypto');
const { RESET_LINK_TTL_MINUTES } = require('./staff-password-reset-email');

const RESET_TOKEN_BYTES = 32;

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
//   that first password: the Team tab's Hired press or Resend link. The stored
//   link itself says which it is. Every issuer writes the link's request time
//   and expiry in the UPDATE that stores its hash: a reset request's link
//   lives RESET_LINK_TTL_MINUTES, an admin's lives days (HIRE_LINK_TTL_MS). So
//   the rule also holds for a link stored before this rule shipped or by an
//   older build, and a reset request that replaced an admin's link replaced
//   its lifetime with it. A link with no request time reads as a reset
//   request's.
// - The Team tab (admin-timetracking hireLinkState) does not call a link the
//   redeem refuses "pending".
// "No password" is NULL or an empty value, as the Team tab reads it.
const resetClosed = (row) => row.google_email != null && !row.password_hash;
const adminSentLink = (row) => Boolean(row.password_reset_requested_at && row.password_reset_expires_at)
  && new Date(row.password_reset_expires_at) - new Date(row.password_reset_requested_at) > RESET_LINK_TTL_MINUTES * 60 * 1000;
const redeemClosed = (row) => resetClosed(row) && !adminSentLink(row);
// The same rule for the redeem's UPDATE, with its one binding.
const REDEEM_CLOSED_SQL = `(google_email IS NOT NULL AND COALESCE(password_hash, '') = '' AND (password_reset_requested_at IS NULL
  OR password_reset_expires_at - password_reset_requested_at <= make_interval(mins => ?)))`;
const REDEEM_CLOSED_BINDINGS = [RESET_LINK_TTL_MINUTES];

module.exports = {
  RESET_TOKEN_BYTES, hashResetToken, mintResetToken, resetClosed, redeemClosed, REDEEM_CLOSED_SQL, REDEEM_CLOSED_BINDINGS,
};
