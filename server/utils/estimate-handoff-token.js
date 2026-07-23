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

// Accepted-estimate /book links (customers-only gate pass). Differs from the
// quote handoff twice over, so it gets its own mint:
//  - the id is NAMESPACED (`estimate-accept:<id>`) so accept tokens and
//    pricing-handoff tokens can never substitute for each other;
//  - the TTL is a year, not 14 days — the accept-retry SMS chases
//    accepted-but-never-booked customers well past the quote window, and an
//    expired token would bounce an ALREADY-ACCEPTED customer off the gate.
// The mint time is quantized to the acceptance DAY so the fresh-accept link
// and every retry rebuild produce byte-identical URLs (the retry path dedupes
// short codes by exact target_url). Verify with
// verifyEstimateHandoffToken(`estimate-accept:<id>`, token) — the exp is
// embedded, so the verifier needs no TTL knowledge.
const ACCEPT_TTL_SECONDS = 60 * 60 * 24 * 365;
function mintEstimateAcceptToken(estimateId, acceptedAtMs = Date.now()) {
  if (!estimateId || !secret()) return null;
  const dayEpochSec = Math.floor(acceptedAtMs / 1000 / 86400) * 86400;
  const exp = dayEpochSec + ACCEPT_TTL_SECONDS;
  return `${exp}.${sign(`estimate-accept:${estimateId}`, exp)}`;
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

module.exports = {
  mintEstimateHandoffToken, mintEstimateAcceptToken, verifyEstimateHandoffToken, TTL_SECONDS,
};
