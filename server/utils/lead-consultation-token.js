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

function sign(leadId, exp, channel) {
  const payload = channel
    ? `lead-consultation:${leadId}:${exp}:${channel}`
    : `lead-consultation:${leadId}:${exp}`;
  return crypto.createHmac('sha256', secret())
    .update(payload)
    .digest('base64url');
}

// Mint a token for a lead id. `nowSec` is injectable for tests. `channel`
// (round 11, Codex pre-push P1, 2026-09-24) is an OPTIONAL delivery-channel
// claim — undefined by default, so every existing caller keeps minting the
// same 3-segment `<leadId>.<exp>.<sig>` token byte-for-byte. When a caller
// (the PR4 SMS send) passes `channel: 'sms'`, it becomes part of the SIGNED
// payload and rides as a 4th segment (`<leadId>.<exp>.<channel>.<sig>`) —
// signed in, not just appended, so it can be neither spliced onto an
// existing token (the signature wouldn't match) nor stripped off a
// channeled one to downgrade it (same reason). inspection-public.js's
// leadContactVerified reads `channel === 'sms'` as proof this exact link
// was delivered by text to the lead's own phone, one of the two ways an
// unlinked lead's phone match is trusted enough to reuse an existing
// customer. Returns null if there is no id or no secret configured (fail
// closed — no token, no link).
function mintLeadConsultationToken(leadId, nowSec = Math.floor(Date.now() / 1000), channel) {
  if (!leadId || !secret()) return null;
  const exp = nowSec + TTL_SECONDS;
  const sig = sign(leadId, exp, channel);
  return channel ? `${leadId}.${exp}.${channel}.${sig}` : `${leadId}.${exp}.${sig}`;
}

// Verify a token, returning `{ leadId }` (or `{ leadId, channel }` for a
// channel-carrying token) on success, or null on any malformed/expired/
// mismatched token. Constant-time signature compare.
function verifyLeadConsultationToken(token, nowSec = Math.floor(Date.now() / 1000)) {
  if (!token || !secret()) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const leadId = parts[0];
  const exp = Number(parts[1]);
  const channel = parts.length === 4 ? parts[2] : undefined;
  const sig = parts[parts.length - 1];
  if (!leadId || !Number.isFinite(exp) || exp < nowSec) return null;
  const expected = sign(leadId, exp, channel);
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return channel ? { leadId, channel } : { leadId };
}

// The SMS delivery claim, bound to the number the link was texted to
// (Codex #4737 r1 P1): `sms-<digest of the last ten digits>`. A lead whose
// phone is corrected after the text no longer matches, so an old link can
// never vouch for the new number. Hex digest — no '.' to break the token's
// segment split.
function smsChannelFor(phone) {
  const last10 = String(phone || '').replace(/\D/g, '').slice(-10);
  if (last10.length !== 10) return null;
  return `sms-${crypto.createHash('sha256').update(`lead-consultation-sms:${last10}`).digest('hex').slice(0, 16)}`;
}

module.exports = { mintLeadConsultationToken, verifyLeadConsultationToken, smsChannelFor, TTL_SECONDS };
