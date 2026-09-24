// Server-trusted lead → consultation-booking token.
//
// Modeled on lead-prefill-token.js (same HMAC-SHA256 base64url shape, same
// secret resolution, same 14-day TTL, same constant-time compare) but a
// DIFFERENT namespace ("lead-consultation:" vs "lead-prefill:") so the two
// tokens are never interchangeable — a leaked/reused prefill token must not
// unlock the consultation booking page, and vice versa.
//
// The consultation link (buildLeadConsultationLink / the /inspection/:token
// page) carries the lead id IN the token, so the public token format is
// `<leadId>.<exp>.<sig>` — unlike the prefill token, which is exchanged
// alongside a separately-supplied lead id.
//
// The token grants BOOKING-PAGE authority ONLY — it must never be accepted
// as identity or pricing authority on a money path (the identity≠pricing
// rule; see estimate-handoff-token.js).
const crypto = require('crypto');

const TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days — owner decision (scope doc §7)

function secret() {
  // Dedicated secret if set, else fall back to JWT_SECRET (always present in prod).
  return process.env.LEAD_PREFILL_SECRET || process.env.JWT_SECRET || '';
}

function sign(leadId, exp) {
  return crypto.createHmac('sha256', secret())
    .update(`lead-consultation:${leadId}:${exp}`)
    .digest('base64url');
}

// Mint a token for a lead id. `nowSec` is injectable for tests. Returns null
// if there is no id or no secret configured (fail closed — no token, no link).
function mintLeadConsultationToken(leadId, nowSec = Math.floor(Date.now() / 1000)) {
  if (!leadId || !secret()) return null;
  const exp = nowSec + TTL_SECONDS;
  return `${leadId}.${exp}.${sign(leadId, exp)}`;
}

// Verify a token, returning `{ leadId }` on success or null on any
// malformed/expired/mismatched token. Constant-time signature compare.
function verifyLeadConsultationToken(token, nowSec = Math.floor(Date.now() / 1000)) {
  if (!token || !secret()) return null;
  const raw = String(token);
  const firstDot = raw.indexOf('.');
  const lastDot = raw.lastIndexOf('.');
  if (firstDot <= 0 || lastDot <= firstDot) return null;
  const leadId = raw.slice(0, firstDot);
  const exp = Number(raw.slice(firstDot + 1, lastDot));
  const sig = raw.slice(lastDot + 1);
  if (!leadId || !Number.isFinite(exp) || exp < nowSec) return null;
  const expected = sign(leadId, exp);
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return { leadId };
}

module.exports = { mintLeadConsultationToken, verifyLeadConsultationToken, TTL_SECONDS };
