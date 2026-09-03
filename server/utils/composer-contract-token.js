// Server-trusted composer contract signing token.
//
// The SMS composer's "Contract signing link" insert (admin-only
// /customer-link) mints a token IN MEMORY and persists nothing; the /sms
// send (tech-or-admin) activates it — writes its hash to the contract —
// before the provider call. The send therefore needs proof that the token
// in the body was minted by the server for THAT contract, recently, and not
// chosen by the caller: an HMAC over the contract id and an expiry, the
// same shape as the quote→book handoff token (estimate-handoff-token.js).
// No separator — the public contract route and the composer's link seam
// read tokens as one [A-Za-z0-9_-] run.
//
// Token format: `<expEpochSec (10 digits)><base64url(HMAC-SHA256(composer-contract:contractId:exp))>`.
// The embedded expiry gates ACTIVATION only (an insert must be sent within
// the window); once activated, the delivered link lives by the contract's
// own share_token_expires_at.
const crypto = require('crypto');

const TTL_SECONDS = 60 * 60 * 12; // an open composer, not a delivery window
const EXP_DIGITS = 10;

function secret() {
  return process.env.CONTRACT_LINK_SECRET || process.env.JWT_SECRET || '';
}

function sign(contractId, exp) {
  return crypto.createHmac('sha256', secret())
    .update(`composer-contract:${contractId}:${exp}`)
    .digest('base64url');
}

// Returns null with no id or no secret (fail closed — no token, no insert).
function mintComposerContractToken(contractId, nowSec = Math.floor(Date.now() / 1000)) {
  if (!contractId || !secret()) return null;
  const exp = nowSec + TTL_SECONDS;
  return `${String(exp).padStart(EXP_DIGITS, '0')}${sign(contractId, exp)}`;
}

// Constant-time compare; false on anything malformed, expired, or minted for
// another contract.
function verifyComposerContractToken(contractId, token, nowSec = Math.floor(Date.now() / 1000)) {
  if (!contractId || !token || !secret()) return false;
  const value = String(token);
  const expPart = value.slice(0, EXP_DIGITS);
  if (!/^\d{10}$/.test(expPart)) return false;
  const exp = Number(expPart);
  if (!Number.isFinite(exp) || exp < nowSec) return false;
  const sig = value.slice(EXP_DIGITS);
  const expected = sign(contractId, exp);
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

module.exports = { mintComposerContractToken, verifyComposerContractToken, TTL_SECONDS };
