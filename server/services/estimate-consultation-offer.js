/**
 * "Want us to come look first?" section on the public estimate page
 * (consultation-first lane, owner ruling 2026-09-23: for recurring-plan
 * leads a free on-site consultation is the preferred path and the estimate
 * is the fallback). Offers the SAME /inspection/:token self-booking page
 * the recurring-lead new_lead email offers (lead-consultation-email-block.js)
 * — this covers the estimate PAGE only, not the email.
 *
 * Dark behind BOTH GATE_ESTIMATE_CONSULTATION_OFFER (this feature) and
 * GATE_LEAD_INSPECTION_LINK (the /inspection/:token page itself, and the
 * one long-URL builder every consultation link shares) — both must be live.
 *
 * Renders `{ url }` only when ALL of the following hold, and null on ANY
 * other outcome (fail closed — never breaks the estimate page, never
 * throws):
 *   - both gates live;
 *   - the estimate is in an open, customer-actionable state (the caller
 *     passes `acceptActive`, computed the same way as every other
 *     accept-active-gated section on this page — never re-derived here, so
 *     this module can't drift from the route's own accepted/declined/
 *     expired/staff-preview verdict);
 *   - the estimate carries a STRONG lead linkage (`lead_linkage` 'sid' or
 *     'stamp' — the same strong-linkage set the accept handler's own
 *     lead/call-log re-lock uses) — a weak or absent linkage never offers;
 *   - the linked lead passes leadLinkRefusal (open lead, US phone, and — if
 *     a customer is linked — that customer is live and still on the lead's
 *     phone): the SAME chokepoint every consultation-link caller shares;
 *   - the lead wants a recurring plan (leadWantsRecurringPlan);
 *   - the /inspection/:token page's own lead-wide eligibility (booked
 *     already / converted / gone) says ok — reused via
 *     inspection-public.js's `_internals.computeConsultationSlotsForLead`,
 *     the ONE production-safe reuse surface that route exports (same
 *     function the email block reuses), so this can never offer a link the
 *     page itself would refuse. Only `result.ok` is required — a bookable-
 *     slots check is the email's own narrower need, not this page's.
 *
 * NO writes: no createShortCode, no DB insert. The long URL only
 * (consultationUrlForLead with NO channel — unverified delivery; this is
 * neither an SMS send, which channel:'sms' asserts phone delivery for, nor
 * an email send). A public GET must stay read-only.
 */

const db = require('../models/db');
const logger = require('./logger');
const { estimateConsultationOfferLive, leadInspectionLinkLive } = require('../config/feature-gates');
const { leadLinkRefusal, consultationUrlForLead } = require('./lead-consultation-link');
const { leadWantsRecurringPlan } = require('./lead-recurring-intent');

// The strong-linkage set the accept handler's own re-lock condition on
// (server/routes/estimate-public.js, e.g. its accept transaction and
// decline path): 'sid' (call SID) or 'stamp' (marker-stamped) — a weak or
// absent linkage is never trusted to identify a real lead for this offer.
const STRONG_LEAD_LINKAGES = ['sid', 'stamp'];

async function buildEstimateConsultationOffer({ leadId, leadLinkage, acceptActive } = {}) {
  try {
    if (!estimateConsultationOfferLive() || !leadInspectionLinkLive()) return null;
    if (!acceptActive) return null;
    if (!leadId || !STRONG_LEAD_LINKAGES.includes(leadLinkage)) return null;

    const lead = await db('leads').where({ id: String(leadId) }).whereNull('deleted_at')
      .first('id', 'phone', 'service_interest', 'status', 'converted_at', 'customer_id');
    if (!lead) return null;
    if (await leadLinkRefusal(lead)) return null;
    if (!leadWantsRecurringPlan(lead)) return null;

    // Reused verbatim from the /inspection/:token page's own lead-wide
    // eligibility (already_booked / converted / gone) so this offer can
    // never link to a page that would refuse the same lead — the ONE
    // production-safe reuse surface that route exports.
    const { computeConsultationSlotsForLead } = require('../routes/inspection-public')._internals;
    const result = await computeConsultationSlotsForLead(lead.id);
    if (!result.ok) return null;

    const url = consultationUrlForLead(lead.id);
    if (!url) return null;
    return { url };
  } catch (err) {
    logger.warn(`[estimate-consultation-offer] build failed for lead ${leadId}: ${err.message}`);
    return null;
  }
}

module.exports = { buildEstimateConsultationOffer };
