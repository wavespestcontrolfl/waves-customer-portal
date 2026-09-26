/**
 * "Rather have us come look first?" consultation-offer link inside the
 * estimate.engage_gone_quiet follow-up EMAIL (owner ruling 2026-09-26,
 * decision 2 of the estimate-email consultation-offer lane) — a link under
 * the template's existing primary CTA button ("Take another look"), never a
 * new send. Dark behind its own GATE_ESTIMATE_EMAIL_CONSULTATION_OFFER,
 * layered on top of GATE_LEAD_INSPECTION_LINK (checked inside the shared
 * estimateConsultationLead eligibility every consultation surface uses).
 *
 * Two steps, placed by the engine around its own send checks (Codex #4918
 * r7–r14). The shared eligibility includes a slot probe that can take up to
 * 3 s: the engine probes a job only once it has passed every check, then
 * judges the whole job again from the top on state read after the probe,
 * and only fast, probe-free work (this link's mint, then the final checks)
 * sits between its claim and its send:
 *
 *   - probeGoneQuietConsultation(estimateId) — the slow step, once a
 *     gone-quiet job has passed every engine check. Returns the context the
 *     second step needs (the eligible lead and the property its probe
 *     resolved), or null for no offer. Mints nothing and judges no
 *     recipient.
 *   - mintGoneQuietConsultationUrl(context) — after the engine's claim:
 *     mints the short link (the one write the offer adds). Returns the short
 *     URL, or '' for no link.
 *   - goneQuietConsultationStillValid(context, recipientEmail) — the
 *     probe-free shared eligibility (reconfirmConsultationLead) and the
 *     lead's-own-inbox rule (the bearer goes ONLY to the lead's own inbox,
 *     as in the new_lead consultation email) against the recipient this
 *     email is about to go to. The engine runs it TOGETHER with its own last
 *     reads of the estimate and the opt-out, as the final step before its
 *     send; false drops the link.
 *
 * '' is what the estimate.engage_gone_quiet template's `consultation_url`
 * CTA block treats as "render nothing" — so a dark gate or an ineligible
 * send leaves that email byte-identical to before this lane. Called ONLY
 * for the engine's viewed_gone_quiet_72h send — every other engage_* rule
 * never calls either step.
 *
 * Fail-closed and never throws: any ineligibility or error (including
 * createShortCode failing) yields null / '' / false — the caller sends the
 * email either way; this only ever adds or omits a link.
 */

const db = require('../models/db');
const logger = require('./logger');
const { estimateEmailConsultationOfferLive } = require('../config/feature-gates');
const { estimateConsultationLead, reconfirmConsultationLead, PROBE_BUDGET_MS } = require('./estimate-consultation-offer');
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
    // does — the offer's eligibility is judged on this row, not the
    // engine's.
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
    // Ids and the error's name only — the probe resolves addresses, and a
    // geocoder message can carry one.
    logger.warn(`[estimate-email-consultation-offer] probe failed for estimate ${estimateId} (${err?.name || 'Error'})`);
    return null;
  }
}

async function mintGoneQuietConsultationUrl(context) {
  try {
    if (!context?.leadId || !estimateEmailConsultationOfferLive()) return '';
    // Channel 'email', never 'sms' — an email send is not phone-delivery
    // evidence (lead-consultation-link.js's channel contract).
    const longUrl = consultationUrlForLead(context.leadId, 'email');
    if (!longUrl) return '';
    // FAIL CLOSED (same rule as the new_lead consultation email block and
    // lead-consultation-link.js): the long URL carries the bearer token, so
    // it must never ride an email raw. shortWrap throws on any
    // createShortCode failure; the catch below turns that into ''. A code
    // minted for a send whose final checks then drop the link is never sent
    // (it expires with the token).
    const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);
    return (await shortWrap(longUrl, context.leadId, expiresAt)) || '';
  } catch (err) {
    logger.warn(`[estimate-email-consultation-offer] mint failed for estimate ${context?.estimateId} (${err?.name || 'Error'})`);
    return '';
  }
}

async function goneQuietConsultationStillValid(context, recipientEmail) {
  try {
    if (!context?.leadId || !estimateEmailConsultationOfferLive()) return false;
    const lead = await reconfirmConsultationLead(context);
    return Boolean(lead) && recipientIsLead(recipientEmail, lead);
  } catch (err) {
    logger.warn(`[estimate-email-consultation-offer] final check failed for estimate ${context?.estimateId} (${err?.name || 'Error'})`);
    return false;
  }
}

module.exports = {
  probeGoneQuietConsultation,
  mintGoneQuietConsultationUrl,
  goneQuietConsultationStillValid,
  // The per-probe ceiling, so the engine can reserve it against its batch budget.
  PROBE_BUDGET_MS,
};
