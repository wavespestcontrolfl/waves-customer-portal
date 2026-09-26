/**
 * "Rather have us come look first?" consultation-offer link inside the
 * estimate.engage_gone_quiet follow-up EMAIL (owner ruling 2026-09-26,
 * decision 2 of the estimate-email consultation-offer lane) — a link under
 * the template's existing primary CTA button ("Take another look"), never a
 * new send. Dark behind its own GATE_ESTIMATE_EMAIL_CONSULTATION_OFFER,
 * layered on top of GATE_LEAD_INSPECTION_LINK (checked inside the shared
 * estimateConsultationLead eligibility every consultation surface uses).
 *
 * `buildGoneQuietConsultationUrl` is the ONE thing this module does: turn an
 * eligible estimate + its actual recipient into a short-wrapped, email-
 * channeled consultation-booking URL, or '' when anything is off/ineligible/
 * broken. '' is what the estimate.engage_gone_quiet template's
 * `consultation_url` CTA block treats as "render nothing" — so a dark gate
 * or an ineligible send leaves that email byte-identical to before this
 * lane. Called ONLY from estimate-engagement-engine.js's viewed_gone_quiet_72h
 * send — every other engage_* rule's payload never calls this at all.
 *
 * Fail-closed and never throws: any ineligibility or error (including
 * createShortCode failing) returns '' — the caller sends the email either
 * way, this only ever adds or omits a link.
 */

const logger = require('./logger');
const { estimateEmailConsultationOfferLive } = require('../config/feature-gates');
const { estimateConsultationLead, reconfirmConsultationLead } = require('./estimate-consultation-offer');
const { consultationUrlForLead } = require('./lead-consultation-link');
// shortWrap (the same createShortCode-or-throw helper the new_lead
// consultation email block uses) and recipientIsLead (the lead's-own-inbox
// rule that block enforces) are reused verbatim — see that module's header.
const { shortWrap, recipientIsLead } = require('./lead-consultation-email-block');
const { TTL_SECONDS } = require('../utils/lead-consultation-token');

async function buildGoneQuietConsultationUrl({ estimate, estimateData, acceptActive, recipientEmail, context } = {}) {
  try {
    if (!estimateEmailConsultationOfferLive()) return '';
    // Everything else (inspection gate, quote-first/not-grouped, unambiguous
    // linked lead, open-lead/US-phone/customer-still-matches refusal,
    // recurring intent, an open slot at the estimate's own property) is the
    // ONE eligibility set every consultation surface shares — never
    // re-derived here.
    const lead = await estimateConsultationLead({ estimate, estimateData, acceptActive, context });
    if (!lead) return '';
    // The bearer link goes ONLY to the lead's own inbox (same rule the
    // new_lead consultation email enforces): the estimate's recipient can
    // differ from the linked lead's stored email (a phone-matched linkage,
    // a staff-edited estimate contact), and this must never mail that
    // lead's booking link to a different address.
    if (!recipientIsLead(recipientEmail, lead)) return '';
    // Channel 'email', never 'sms' — an email send is not phone-delivery
    // evidence (lead-consultation-link.js's channel contract).
    const longUrl = consultationUrlForLead(lead.id, 'email');
    if (!longUrl) return '';
    // FAIL CLOSED (same rule as the new_lead consultation email block and
    // lead-consultation-link.js): the long URL carries the bearer token, so
    // it must never ride an email raw. shortWrap throws on any
    // createShortCode failure; the catch below turns that into ''.
    const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);
    const shortUrl = await shortWrap(longUrl, lead.id, expiresAt);
    return shortUrl || '';
  } catch (err) {
    logger.warn(`[estimate-email-consultation-offer] build failed for estimate ${estimate?.id}: ${err.message}`);
    return '';
  }
}

// Re-run after the send claim (Codex #4918 r9 P2): the short-link mint and
// the claim both await after buildGoneQuietConsultationUrl's own final
// check, so an off-surface hold, a linkage change or a lead edit landing
// there would still ride the email. Probe-free (finalEligibility only) plus
// the same lead's-own-inbox rule against the recipient about to be mailed.
// Fail-closed: false drops the link, never the email.
async function reconfirmGoneQuietConsultation(context, recipientEmail) {
  try {
    if (!estimateEmailConsultationOfferLive()) return false;
    const lead = await reconfirmConsultationLead(context);
    return Boolean(lead) && recipientIsLead(recipientEmail, lead);
  } catch (err) {
    logger.warn(`[estimate-email-consultation-offer] reconfirm failed for estimate ${context?.estimateId}: ${err.message}`);
    return false;
  }
}

module.exports = { buildGoneQuietConsultationUrl, reconfirmGoneQuietConsultation };
