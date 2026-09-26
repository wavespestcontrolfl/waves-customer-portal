/**
 * "Rather have us come look first?" consultation-offer link inside the
 * estimate.engage_gone_quiet follow-up EMAIL (owner ruling 2026-09-26,
 * decision 2 of the estimate-email consultation-offer lane) — a link under
 * the template's existing primary CTA button ("Take another look"), never a
 * new send. Dark behind its own GATE_ESTIMATE_EMAIL_CONSULTATION_OFFER,
 * layered on top of GATE_LEAD_INSPECTION_LINK (checked inside the shared
 * estimateConsultationLead eligibility every consultation surface uses).
 *
 * Two steps, split around the engine's own send checks (Codex #4918
 * r7–r13). The shared eligibility includes a slot probe that can take up to
 * 3 s, and every read the engine judges or sends from must be taken AFTER
 * it — so the slow step runs before the engine's fresh re-read, and only
 * fast, probe-free work (this link's mint and re-judge, then the engine's
 * own last re-read of the estimate) sits between the engine's claim and its
 * send:
 *
 *   - probeGoneQuietConsultation(estimateId) — the slow step, called BEFORE
 *     the engine re-reads the estimate. Returns the context the second step
 *     needs (the eligible lead and the property its probe resolved), or null
 *     for no offer. Mints nothing and judges no recipient.
 *   - finalizeGoneQuietConsultationUrl(context, recipientEmail) — after the
 *     engine's claim, right before its send (only the engine's own final
 *     re-read of the estimate follows): mints the short link, then re-runs
 *     the probe-free shared eligibility (reconfirmConsultationLead) and the
 *     lead's-own-inbox rule (the bearer goes ONLY to the lead's own inbox,
 *     as in the new_lead consultation email) against the recipient this
 *     email is about to go to. Returns the short URL, or '' to drop the link.
 *
 * '' is what the estimate.engage_gone_quiet template's `consultation_url`
 * CTA block treats as "render nothing" — so a dark gate or an ineligible
 * send leaves that email byte-identical to before this lane. Called ONLY
 * for the engine's viewed_gone_quiet_72h send — every other engage_* rule
 * never calls either step.
 *
 * Fail-closed and never throws: any ineligibility or error (including
 * createShortCode failing) yields null / '' — the caller sends the email
 * either way; this only ever adds or omits a link.
 */

const db = require('../models/db');
const logger = require('./logger');
const { estimateEmailConsultationOfferLive } = require('../config/feature-gates');
const { estimateConsultationLead, reconfirmConsultationLead } = require('./estimate-consultation-offer');
const { consultationUrlForLead } = require('./lead-consultation-link');
const { parseEstimateData } = require('./estimate-service-lines');
// shortWrap (the same createShortCode-or-throw helper the new_lead
// consultation email block uses) and recipientIsLead (the lead's-own-inbox
// rule that block enforces) are reused verbatim — see that module's header.
const { shortWrap, recipientIsLead } = require('./lead-consultation-email-block');
const { TTL_SECONDS } = require('../utils/lead-consultation-token');

async function probeGoneQuietConsultation(estimateId) {
  try {
    if (!estimateEmailConsultationOfferLive() || !estimateId) return null;
    const estimate = await db('estimates').where({ id: estimateId }).first();
    // No recipient, no link (and the engine skips the send) — spend no probe.
    if (!estimate?.customer_email) return null;
    // The page's own accept-active verdict (status, expiry, and every
    // off-customer-surface hold), lazily required like the shared helper
    // does — this step runs before the engine's own status checks.
    const { isEstimateAcceptActive } = require('../routes/estimate-public');
    const context = {};
    // Everything else (inspection gate, quote-first/not-grouped, unambiguous
    // linked lead, open-lead/US-phone/customer-still-matches refusal,
    // recurring intent, an open slot at the estimate's own property, and the
    // post-probe fresh re-judge) is the ONE eligibility set every
    // consultation surface shares — never re-derived here.
    const lead = await estimateConsultationLead({
      estimate,
      estimateData: parseEstimateData(estimate.estimate_data),
      acceptActive: isEstimateAcceptActive(estimate),
      context,
    });
    // The lead's-own-inbox rule is judged once, in the second step, against
    // the recipient of the actual send — never against this pre-probe row.
    return lead ? context : null;
  } catch (err) {
    logger.warn(`[estimate-email-consultation-offer] probe failed for estimate ${estimateId}: ${err.message}`);
    return null;
  }
}

async function finalizeGoneQuietConsultationUrl(context, recipientEmail) {
  try {
    if (!context?.leadId || !estimateEmailConsultationOfferLive()) return '';
    // Channel 'email', never 'sms' — an email send is not phone-delivery
    // evidence (lead-consultation-link.js's channel contract).
    const longUrl = consultationUrlForLead(context.leadId, 'email');
    if (!longUrl) return '';
    // FAIL CLOSED (same rule as the new_lead consultation email block and
    // lead-consultation-link.js): the long URL carries the bearer token, so
    // it must never ride an email raw. shortWrap throws on any
    // createShortCode failure; the catch below turns that into ''.
    const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);
    const shortUrl = await shortWrap(longUrl, context.leadId, expiresAt);
    if (!shortUrl) return '';
    // Minted FIRST, re-judged LAST (Codex #4918 r9): nothing of this step
    // awaits after the re-judge — only the engine's own final re-read of the
    // estimate follows before its send. A failed check leaves one unsent
    // short code behind (it expires with the token) — never a sent link.
    const lead = await reconfirmConsultationLead(context);
    if (!lead || !recipientIsLead(recipientEmail, lead)) return '';
    return shortUrl;
  } catch (err) {
    logger.warn(`[estimate-email-consultation-offer] finalize failed for estimate ${context?.estimateId}: ${err.message}`);
    return '';
  }
}

module.exports = { probeGoneQuietConsultation, finalizeGoneQuietConsultationUrl };
