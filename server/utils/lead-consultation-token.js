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
//
// Codex #4737 r8 P1: this MUST be keyed with the server secret, not a bare
// sha256(phone). The page reveals the phone's last 4 digits, so an unsalted
// digest lets anyone with the claim brute-force the other 6 digits offline
// (10^6 guesses) and recover the lead's full phone number. Deriving a
// distinct HMAC key from the same secret the token signature already uses
// (rather than a new env var) keeps this fail-closed the same way `sign()`
// is: no secret configured, no channel claim.
function smsChannelFor(phone) {
  // Full phone identity (Codex #4737 r13 pre-push P0): a US number keys by
  // its ten digits, an international one keeps its country code.
  const last10 = require('./phone').phoneIdentityKey(phone);
  if (!last10 || !secret()) return null;
  const key = crypto.createHmac('sha256', secret()).update('sms-channel-key').digest();
  return `sms-${crypto.createHmac('sha256', key).update(`lead-consultation-sms:${last10}`).digest('hex').slice(0, 16)}`;
}

// A short-lived, signed waitlist ticket (Codex #4737 r15 P0): minted ONLY
// with a server-verified out_of_area answer, it binds the lead and the
// region that answer found, so POST /:token/waitlist never trusts a
// caller-supplied county or writes for a lead that was never out of area.
const WAITLIST_TICKET_TTL_SECONDS = 60 * 60;
function waitlistTicketSig(leadId, payload) {
  return crypto.createHmac('sha256', secret()).update(`lead-consultation-waitlist:${leadId}:${payload}`).digest('base64url');
}
function mintWaitlistTicket(leadId, county, nowSec = Math.floor(Date.now() / 1000)) {
  if (!leadId || !secret()) return null;
  const payload = `${nowSec + WAITLIST_TICKET_TTL_SECONDS}.${Buffer.from(String(county || '')).toString('base64url')}`;
  return `${payload}.${waitlistTicketSig(leadId, payload)}`;
}
function verifyWaitlistTicket(ticket, leadId, nowSec = Math.floor(Date.now() / 1000)) {
  if (!ticket || !leadId || !secret()) return null;
  const parts = String(ticket).split('.');
  if (parts.length !== 3) return null;
  const [expStr, countyB64, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < nowSec) return null;
  const expected = waitlistTicketSig(leadId, `${expStr}.${countyB64}`);
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return { county: Buffer.from(countyB64, 'base64url').toString() || null };
}

module.exports = {
  mintWaitlistTicket,
  verifyWaitlistTicket, mintLeadConsultationToken, verifyLeadConsultationToken, smsChannelFor, TTL_SECONDS };
