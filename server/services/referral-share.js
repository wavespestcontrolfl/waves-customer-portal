// Customer-facing referral share module — the ONE composer behind every
// public "Send My Referral Link" tap (service report, estimate accepted /
// just-accepted screens). Owner rulings carried over from the report card
// (2026-08-11 / 2026-08-13):
//   - the RENDER payload carries only a static headline + CTA; the customer's
//     code and share copy are composed on the TAP, because enrollPromoter
//     writes a durable referral_promoters row and a public read (staff QA
//     included) must never enroll anyone;
//   - every word and amount comes from the LIVE program settings (strict
//     read — no live row / inactive program = no card, no link), so the copy
//     never promises a benefit the referee won't receive;
//   - owner voice, no emojis, never a URL shortener; the SMS body drops the
//     URL scheme (portal-domain links preview without it), the email keeps it.
//
// Reuses the portal's own mechanism end to end: enrollPromoter +
// getPromoterReferralLink, never a parallel code generator.


const REFERRAL_CARD_COPY = Object.freeze({
  headline: 'Know someone who could use Waves?',
  cta: 'Send My Referral Link',
});

// The render-side card: static copy, shown only while the live program is
// active. Suppressed (null) on any settings failure — an unconfigured or
// broken environment must not advertise rewards it cannot honor.
async function composeReferralCard({ referralEngine = require('./referral-engine') } = {}) {
  const settings = await referralEngine.getLiveSettings();
  if (!settings?.program_active) return null;
  return { ...REFERRAL_CARD_COPY };
}

function formatRefereeAmount(cents) {
  // Cents format EXACTLY: referee_discount_cents supports arbitrary cent
  // amounts, and rounding 4999 to "$50" promises a dollar the engine never
  // credits. Whole-dollar settings keep the clean "$25".
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/**
 * The tap: enroll (or resolve) the customer's promoter row and compose the
 * share copy. Returns null when the program is inactive (callers answer the
 * generic 404), throws on failures (callers answer 503, logging err.code
 * only — PG constraint violations quote the conflicting phone number).
 *
 * Enrollment goes through referral-engine.resolvePromoter: strictly
 * per-customer, with the account-scoped household fallback for a
 * multi-property sibling whose phone already backs another sibling's
 * promoter (23505); a cross-account collision rethrows.
 */
// conn: an outer transaction (the estimate tap holds the estimate row lock
// and the call-side verdict through enrollment); every read and the enroll
// ride it when given.
async function buildReferralShareForCustomer(customerId, {
  referralEngine = require('./referral-engine'),
  conn = null,
} = {}) {
  if (!customerId) return null;
  // Under an outer transaction every read rides it (a second pool
  // connection per concurrent tap could starve the pool — GH codex P2).
  const settings = conn ? await referralEngine.getLiveSettings(conn) : await referralEngine.getLiveSettings();
  if (!settings?.program_active) return null;

  // Enroll-or-resolve: a multi-property sibling sharing the household
  // phone resolves the household promoter read-only, scoped to the account
  // (referral-engine.resolvePromoter — the savepoint + fallback live there).
  const { promoter } = await referralEngine.resolvePromoter(customerId, { conn, settings });
  const code = String(promoter?.referral_code || '').trim();
  const link = referralEngine.getPromoterReferralLink(promoter, settings);
  if (!code || !link) return { unavailable: true };

  const refereeCents = Math.max(0, Math.trunc(Number(settings.referee_discount_cents) || 0));
  const refereeAmount = formatRefereeAmount(refereeCents);
  const offerClause = refereeCents > 0
    ? `they'll take ${refereeAmount} off your first service with my code ${code}`
    : `mention my code ${code} when you book`;
  const bareLink = String(link).replace(/^https?:\/\//i, '');
  return {
    code,
    link,
    smsBody: `We use Waves Pest Control and ${offerClause}. ${bareLink}`,
    emailSubject: refereeCents > 0 ? `${refereeAmount} off Waves Pest Control` : 'Waves Pest Control',
    emailBody: `We use Waves Pest Control and ${offerClause}.\n\n${link}`,
  };
}

module.exports = {
  REFERRAL_CARD_COPY,
  composeReferralCard,
  buildReferralShareForCustomer,
};
