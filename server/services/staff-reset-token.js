/**
 * The one-time token behind a staff set-password link. Shared by the
 * password-reset request (routes/admin-auth.js issuePasswordReset) and the
 * Staff page "Hired" button (routes/admin-timetracking.js), so a token minted
 * by either one is redeemed by the same POST /reset-password lookup. Only the
 * hash is stored; the token itself exists in the emailed link alone.
 */
const crypto = require('crypto');

const RESET_TOKEN_BYTES = 32;

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function mintResetToken() {
  const token = crypto.randomBytes(RESET_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashResetToken(token) };
}

module.exports = { RESET_TOKEN_BYTES, hashResetToken, mintResetToken };
