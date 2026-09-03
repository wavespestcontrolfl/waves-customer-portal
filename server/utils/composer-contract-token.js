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
// Token format: `<expEpochSec (10 digits)><nonce (16 base64url)><base64url(HMAC-SHA256(composer-contract:contractId:exp:nonce))>`.
// The embedded expiry gates ACTIVATION only (an insert must be sent within
// the window); once activated, the delivered link lives by the contract's
// own share_token_expires_at. The nonce makes every insert its own token:
// two composers minting for one contract in the same second must not share
// a bearer, or the second send would find the first's activated hash and
// read its own stale insert as the delivered link (GH Codex #3844 r4 P1) —
// distinct tokens reach activation as unwritten and the row lock refuses.
const crypto = require('crypto');

const TTL_SECONDS = 60 * 60 * 12; // an open composer, not a delivery window
const EXP_DIGITS = 10;
const NONCE_BYTES = 12; // 16 base64url chars
const NONCE_CHARS = 16;

function secret() {
  return process.env.CONTRACT_LINK_SECRET || process.env.JWT_SECRET || '';
}

function sign(contractId, exp, nonce) {
  return crypto.createHmac('sha256', secret())
    .update(`composer-contract:${contractId}:${exp}:${nonce}`)
    .digest('base64url');
}

// Returns null with no id or no secret (fail closed — no token, no insert).
function mintComposerContractToken(contractId, nowSec = Math.floor(Date.now() / 1000)) {
  if (!contractId || !secret()) return null;
  const exp = nowSec + TTL_SECONDS;
  const nonce = crypto.randomBytes(NONCE_BYTES).toString('base64url');
  return `${String(exp).padStart(EXP_DIGITS, '0')}${nonce}${sign(contractId, exp, nonce)}`;
}

// Constant-time compare; false on anything malformed, expired, minted for
// another contract, or carrying a nonce the signature does not cover.
function verifyComposerContractToken(contractId, token, nowSec = Math.floor(Date.now() / 1000)) {
  if (!contractId || !token || !secret()) return false;
  const value = String(token);
  const expPart = value.slice(0, EXP_DIGITS);
  if (!/^\d{10}$/.test(expPart)) return false;
  const exp = Number(expPart);
  if (!Number.isFinite(exp) || exp < nowSec) return false;
  const nonce = value.slice(EXP_DIGITS, EXP_DIGITS + NONCE_CHARS);
  if (!/^[A-Za-z0-9_-]{16}$/.test(nonce)) return false;
  const sig = value.slice(EXP_DIGITS + NONCE_CHARS);
  const expected = sign(contractId, exp, nonce);
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

module.exports = { mintComposerContractToken, verifyComposerContractToken, TTL_SECONDS };
