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
 *   - the /inspection/:token page would actually offer a time: reused via
 *     inspection-public.js's `_internals.computeConsultationSlotsForLead`
 *     (the same probe and the same rule the email block uses — eligible
 *     lead, live catalog, in-area location, at least one open slot; or no
 *     address on file yet, which the page asks for). It runs last, after
 *     every cheap check, so only a strongly-linked open recurring lead on an
 *     accept-active estimate pays for the location/availability lookup,
 *     once per page load (the page does not poll /data).
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
const { streetKey, normalizeZip, unitKey, streetEmbeddedUnitKey } = require('./customer-properties');
const { parseRawAddress } = require('../utils/address-normalizer');

// The strong-linkage set the accept handler's own re-lock condition on
// (server/routes/estimate-public.js, e.g. its accept transaction and
// decline path): 'sid' (call SID) or 'stamp' (marker-stamped) — a weak or
// absent linkage is never trusted to identify a real lead for this offer.
const STRONG_LEAD_LINKAGES = ['sid', 'stamp'];

// Whether the estimate's property is the one the /inspection page would book
// at (Codex #4853 r2 P1) — the page's own profileMatchesAddress rule: same
// canonical street, same unit, and the same zip. A grouped
// estimate or a staff address revision keeps the lead link but not the
// lead's address, and must not book a consultation at another property.
function sameProperty(estimateAddress, pageAddress) {
  if (!estimateAddress || !pageAddress?.line1) return false;
  const est = parseRawAddress(String(estimateAddress));
  const estLine1 = est.line1 || String(estimateAddress).split(',')[0];
  const key = streetKey(estLine1);
  if (!key || streetKey(pageAddress.line1) !== key) return false;
  const unitOf = (line1, line2) => unitKey(line2 || '') || streetEmbeddedUnitKey(line1);
  if (unitOf(estLine1, null) !== unitOf(pageAddress.line1, pageAddress.line2)) return false;
  // Locality evidence is required (Codex #4853 r3 P0): the page's rule
  // takes an equal zip or nearby coordinates, and the estimate carries no
  // coordinates — so both zips must be present and equal. "100 Main St"
  // exists in more than one town.
  const estZip = normalizeZip(est.zip);
  return Boolean(estZip) && estZip === normalizeZip(pageAddress.zip);
}

async function buildEstimateConsultationOffer({
  leadId, leadLinkage, acceptActive, estimateAddress, fromVisit = false, grouped = false,
} = {}) {
  try {
    if (!estimateConsultationOfferLive() || !leadInspectionLinkLive()) return null;
    if (!acceptActive) return null;
    // Quote-first estimates only (Codex #4853 r2 P1): one drafted from a
    // visit (estimate_data.scheduled_service_id — the assessment pre-draft)
    // already had its look, and a grouped estimate spans properties.
    if (fromVisit || grouped) return null;
    if (!leadId || !STRONG_LEAD_LINKAGES.includes(leadLinkage)) return null;

    const lead = await db('leads').where({ id: String(leadId) }).whereNull('deleted_at')
      .first('id', 'phone', 'service_interest', 'status', 'converted_at', 'customer_id');
    if (!lead) return null;
    if (await leadLinkRefusal(lead)) return null;
    if (!leadWantsRecurringPlan(lead)) return null;

    // The /inspection/:token page's own lead-wide eligibility, so this
    // offer can never link to a page that would refuse the same lead.
    const { computeConsultationSlotsForLead } = require('../routes/inspection-public')._internals;
    const result = await computeConsultationSlotsForLead(lead.id, { count: 1 });
    // Bookable at THIS estimate's property: an open slot (Codex #4853 r1
    // P2 — out of area, retired catalog or no open times would open a page
    // with nothing to pick) at the address the page resolved, matched to
    // the estimate (r2 P1). A lead with no address on file has nothing to
    // match, so it gets no offer here.
    if (!result.ok || result.slots.length === 0) return null;
    if (!sameProperty(estimateAddress, result.address)) return null;

    const url = consultationUrlForLead(lead.id);
    if (!url) return null;
    return { url };
  } catch (err) {
    logger.warn(`[estimate-consultation-offer] build failed for lead ${leadId}: ${err.message}`);
    return null;
  }
}

module.exports = { buildEstimateConsultationOffer, _test: { sameProperty } };
