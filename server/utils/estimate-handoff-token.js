// Server-trusted quote→book handoff token.
//
// The public quote flow mints a short-lived HMAC token bound to the draft
// estimate id and returns it alongside the estimate_id. The /book link carries
// both, and /booking/confirm verifies the token before trusting that estimate_id
// for pay-at-visit PRICING — so a client can't forge an arbitrary estimate_id to
// price a booking from someone else's quote. Identity resolution is unaffected;
// this only gates the money path.
//
// Token format: `<expEpochSec>.<base64url(HMAC-SHA256(estimateId:exp))>`.
const crypto = require('crypto');

const TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days — matches the quote→book window

function secret() {
  // Dedicated secret if set, else fall back to JWT_SECRET (always present in prod).
  return process.env.ESTIMATE_HANDOFF_SECRET || process.env.JWT_SECRET || '';
}

function sign(estimateId, exp) {
  return crypto.createHmac('sha256', secret())
    .update(`estimate-handoff:${estimateId}:${exp}`)
    .digest('base64url');
}

// Mint a token for an estimate id. `nowSec` is injectable for tests. Returns null
// if there is no id or no secret configured (fail closed — no token, no trust).
function mintEstimateHandoffToken(estimateId, nowSec = Math.floor(Date.now() / 1000)) {
  if (!estimateId || !secret()) return null;
  const exp = nowSec + TTL_SECONDS;
  return `${exp}.${sign(estimateId, exp)}`;
}

// Verify a token matches the estimate id and hasn't expired. Constant-time
// signature compare. Returns false on any malformed/expired/mismatched token.
function verifyEstimateHandoffToken(estimateId, token, nowSec = Math.floor(Date.now() / 1000)) {
  if (!estimateId || !token || !secret()) return false;
  const dot = String(token).indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(String(token).slice(0, dot));
  const sig = String(token).slice(dot + 1);
  if (!Number.isFinite(exp) || exp < nowSec) return false;
  const expected = sign(estimateId, exp);
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

module.exports = { mintEstimateHandoffToken, verifyEstimateHandoffToken, TTL_SECONDS };
