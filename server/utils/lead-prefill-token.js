// Server-trusted lead → quote-wizard prefill token.
//
// The voicemail lead text-back SMS links the prospect to the public /estimate
// wizard with `vlead=<leadId>&vt=<token>`. The wizard exchanges the pair for
// that lead's own contact fields (name/phone/address/service interest) so the
// form arrives prefilled, and the wizard's lead capture UPDATES the same lead
// row instead of minting a duplicate. The token grants PREFILL/attach
// authority ONLY — it must never be accepted as identity or pricing authority
// on a money path (the identity≠pricing rule; see estimate-handoff-token.js).
//
// Token format: `<expEpochSec>.<base64url(HMAC-SHA256(lead-prefill:<leadId>:<exp>))>`.
const crypto = require('crypto');

const TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days — matches the estimate-handoff window

function secret() {
  // Dedicated secret if set, else fall back to JWT_SECRET (always present in prod).
  return process.env.LEAD_PREFILL_SECRET || process.env.JWT_SECRET || '';
}

function sign(leadId, exp) {
  return crypto.createHmac('sha256', secret())
    .update(`lead-prefill:${leadId}:${exp}`)
    .digest('base64url');
}

// Mint a token for a lead id. `nowSec` is injectable for tests. Returns null
// if there is no id or no secret configured (fail closed — no token, no link).
function mintLeadPrefillToken(leadId, nowSec = Math.floor(Date.now() / 1000)) {
  if (!leadId || !secret()) return null;
  const exp = nowSec + TTL_SECONDS;
  return `${exp}.${sign(leadId, exp)}`;
}

// Verify a token matches the lead id and hasn't expired. Constant-time
// signature compare. Returns false on any malformed/expired/mismatched token.
function verifyLeadPrefillToken(leadId, token, nowSec = Math.floor(Date.now() / 1000)) {
  if (!leadId || !token || !secret()) return false;
  const dot = String(token).indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(String(token).slice(0, dot));
  const sig = String(token).slice(dot + 1);
  if (!Number.isFinite(exp) || exp < nowSec) return false;
  const expected = sign(leadId, exp);
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

module.exports = { mintLeadPrefillToken, verifyLeadPrefillToken, TTL_SECONDS };
