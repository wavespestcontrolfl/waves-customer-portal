// Server-trusted lead → quote-wizard prefill token.
//
// The voicemail lead text-back SMS links the prospect to the public /quote
// wizard with `vlead=<leadId>&vt=<token>`. The wizard exchanges the pair for
// that lead's own contact fields (name/phone/address/service interest) so the
// form arrives prefilled, and the wizard's lead capture UPDATES the same lead
// row instead of minting a duplicate. The token grants PREFILL/attach
// authority ONLY — it must never be accepted as identity or pricing authority
// on a money path (the identity≠pricing rule; see estimate-handoff-token.js).
//
// Token format: `<expEpochSec>.<base64url(HMAC-SHA256(lead-prefill:<leadId>:<exp>))>`.
//
// A second, narrower token rides on the same format: the ATTACH token
// (purpose `lead-attach`). routes/lead-webhook.js mints it for the lead a
// quiz page submission just created, and the price page's property lookup
// accepts it to UPDATE that same lead row instead of adding a second one
// (one visitor, one lead). Its HMAC purpose differs, so it is never a
// prefill token: POST /lead-prefill answers 404 for it, and it cannot be
// exchanged for a lead's contact fields. It lives 2 hours, because the
// hand-off is one tap after the quiz.
const crypto = require('crypto');

const TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days — matches the estimate-handoff window
const ATTACH_TTL_SECONDS = 60 * 60 * 2;
const PREFILL = 'lead-prefill';
const ATTACH = 'lead-attach';

function secret() {
  // Dedicated secret if set, else fall back to JWT_SECRET (always present in prod).
  return process.env.LEAD_PREFILL_SECRET || process.env.JWT_SECRET || '';
}

function sign(leadId, exp, purpose = PREFILL) {
  return crypto.createHmac('sha256', secret())
    .update(`${purpose}:${leadId}:${exp}`)
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
  return verify(PREFILL, leadId, token, nowSec);
}

function verify(purpose, leadId, token, nowSec) {
  if (!leadId || !token || !secret()) return false;
  const dot = String(token).indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(String(token).slice(0, dot));
  const sig = String(token).slice(dot + 1);
  if (!Number.isFinite(exp) || exp < nowSec) return false;
  const expected = sign(leadId, exp, purpose);
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Mint / verify the attach token (see the header). Same fail-closed rules as
// the prefill pair: no id or no secret mints null and verifies false.
function mintLeadAttachToken(leadId, nowSec = Math.floor(Date.now() / 1000)) {
  if (!leadId || !secret()) return null;
  const exp = nowSec + ATTACH_TTL_SECONDS;
  return `${exp}.${sign(leadId, exp, ATTACH)}`;
}

function verifyLeadAttachToken(leadId, token, nowSec = Math.floor(Date.now() / 1000)) {
  return verify(ATTACH, leadId, token, nowSec);
}

module.exports = {
  mintLeadPrefillToken,
  verifyLeadPrefillToken,
  mintLeadAttachToken,
  verifyLeadAttachToken,
  TTL_SECONDS,
  ATTACH_TTL_SECONDS,
};
