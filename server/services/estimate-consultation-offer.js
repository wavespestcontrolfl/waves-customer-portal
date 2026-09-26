/**
 * "Want us to come look first?" consultation offer on estimates
 * (consultation-first lane, owner ruling 2026-09-23: for recurring-plan
 * leads a free on-site consultation is the preferred path and the estimate
 * is the fallback). Links to the SAME /inspection/:token self-booking page
 * the recurring-lead new_lead email offers (lead-consultation-email-block.js).
 *
 * buildEstimateConsultationOffer is the estimate PAGE's offer,
 * dark behind GATE_ESTIMATE_CONSULTATION_OFFER plus the /inspection page's
 * GATE_LEAD_INSPECTION_LINK: the long URL with no channel claim and no
 * write of any kind (a public GET stays read-only). It never throws — any
 * ineligibility or error is null and the page renders without the section.
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

// The slot probe can resolve an address through the geocoder and a county
// lookup (tens of seconds when a provider is slow). The offer is optional,
// so it never waits past this budget (Codex #4918 r1 P2): the estimate
// page's first load and the gone-quiet email send — one job in a
// sequential batch holding the follow-up lock — go ahead without it. The
// probe is read-only, so letting it finish in the background is harmless.
const PROBE_BUDGET_MS = 3000;
const PROBE_TIMED_OUT = Symbol('probe-timed-out');
function withinProbeBudget(promise) {
  let timer;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve(PROBE_TIMED_OUT), PROBE_BUDGET_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, budget]).finally(() => clearTimeout(timer));
}

// The lead an estimate belongs to. The link the admin estimate tool writes
// is the lead-side pointer leads.estimate_id (estimate-lead-linkage.js reads
// it for attribution); only estimator-engine call drafts and commercial
// proposals stamp estimate_data.lead_id with a strong lead_linkage — none of
// the 234 estimates sent in the 90 days to 2026-09-26 carried one, so the
// stamp alone left the offer inert. Both sources count; more than one live
// lead pointing at the estimate, or a pointer and a stamp naming different
// leads, is ambiguous and yields none.
async function linkedLeadIdFor(estimateId, estimateData) {
  const candidates = new Set();
  if (estimateId) {
    const pointing = await db('leads').where({ estimate_id: estimateId }).whereNull('deleted_at').limit(2).pluck('id');
    pointing.forEach((id) => candidates.add(String(id).toLowerCase()));
  }
  // Lowercased on both sides: uuids compare case-insensitively in Postgres,
  // so one lead written in two cases is still one candidate.
  if (estimateData?.lead_id && STRONG_LEAD_LINKAGES.includes(estimateData?.lead_linkage)) {
    candidates.add(String(estimateData.lead_id).toLowerCase());
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

// The lead a consultation offer on this estimate may invite, or null. The
// caller checks its own gate first; this checks the /inspection page's gate
// and everything else:
//   - accept-active (the caller's verdict) and quote-first: not drafted
//     from a visit (estimate_data.scheduled_service_id — the assessment
//     pre-draft already had its look, Codex #4853 r2 P1) and not grouped
//     (estimate_group_id spans properties);
//   - an unambiguous linked lead (linkedLeadIdFor) that is still the
//     estimate's contact, passes leadLinkRefusal and wants a recurring plan;
//   - the page's probe finds an open slot (#4853 r1 P2) at the address it
//     resolved, which must be this estimate's property (r2 P1, r3 P0);
//   - AFTER the probe (up to PROBE_BUDGET_MS), a fresh re-read of the
//     estimate and lead re-judged against the same rules (finalEligibility,
//     Codex #4918 r5 P2) — the caller's acceptActive and every row read
//     above can go stale during the probe.
// Throws on unexpected errors — callers fail soft.
async function estimateConsultationLead({ estimate, estimateData, acceptActive } = {}) {
  if (!leadInspectionLinkLive() || !acceptActive || !estimate) return null;
  if (estimateData?.scheduled_service_id || estimate.estimate_group_id) return null;
  const leadId = await linkedLeadIdFor(estimate.id, estimateData);
  if (!leadId) return null;

  const lead = await db('leads').where({ id: leadId }).whereNull('deleted_at')
    .first('id', 'phone', 'email', 'service_interest', 'status', 'converted_at', 'customer_id');
  if (!lead) return null;
  // The pointer is editable on its own (PUT /api/admin/leads/:id), so the
  // lead must still be the estimate's contact (Codex #4906 r1 P1): the
  // same customer, or the same phone or email — the rule attaching a lead
  // to an estimate uses (lead-estimate-link.js).
  const { leadMatchesEstimateContact } = require('./lead-estimate-link');
  if (!leadMatchesEstimateContact(lead, estimate)) return null;
  if (await leadLinkRefusal(lead)) return null;
  if (!leadWantsRecurringPlan(lead)) return null;

  const { computeConsultationSlotsForLead } = require('../routes/inspection-public')._internals;
  const result = await withinProbeBudget(computeConsultationSlotsForLead(lead.id, { count: 1 }));
  if (result === PROBE_TIMED_OUT) {
    logger.warn(`[estimate-consultation-offer] slot probe exceeded ${PROBE_BUDGET_MS}ms for lead ${lead.id} — no offer`);
    return null;
  }
  if (!result.ok || result.slots.length === 0) return null;
  if (!sameProperty(estimate.address, result.address)) return null;

  // Recheck estimate state after the availability probe (Codex #4918 r5
  // P2): the probe above can take up to PROBE_BUDGET_MS, during which the
  // estimate can be accepted/declined/expired, or gain a linkage/reprice/
  // address hold (estimateOffCustomerSurface markers), and the lead's own
  // contact fields (email included) can change — every snapshot this
  // function was handed or has read so far (`estimate`, `estimateData`,
  // `acceptActive`, `lead`) is now stale. Re-read the estimate and lead
  // fresh and re-run the SAME eligibility this function already checked
  // above, single-sourced in finalEligibility, before returning anything a
  // caller will mint a bearer token for (the page) or email one (the
  // gone-quiet follow-up) — both consultation surfaces share this helper
  // and never re-derive eligibility themselves. No further await runs
  // between this check and the mint/send that follows in either caller.
  return finalEligibility(estimate.id, leadId, result.address);
}

// The final, post-probe eligibility re-check — a fresh read of the
// estimate and lead rows, re-judged against the same rules
// estimateConsultationLead applies above. Kept single-sourced so a rule
// added to either check never drifts between the pre-probe and post-probe
// passes.
async function finalEligibility(estimateId, leadId, probedAddress) {
  const { isEstimateAcceptActive } = require('../routes/estimate-public');
  const freshEstimate = await db('estimates').where({ id: estimateId }).first();
  if (!freshEstimate || !isEstimateAcceptActive(freshEstimate)) return null;
  let freshEstimateData = freshEstimate.estimate_data;
  if (typeof freshEstimateData === 'string') {
    try { freshEstimateData = JSON.parse(freshEstimateData); } catch { freshEstimateData = null; }
  }
  if (freshEstimateData?.scheduled_service_id || freshEstimate.estimate_group_id) return null;
  // The estimate's address can change during the probe too; the slot the
  // probe found must still be at the estimate's own property.
  if (!sameProperty(freshEstimate.address, probedAddress)) return null;

  const freshLead = await db('leads').where({ id: leadId }).whereNull('deleted_at')
    .first('id', 'phone', 'email', 'service_interest', 'status', 'converted_at', 'customer_id');
  if (!freshLead) return null;
  const { leadMatchesEstimateContact } = require('./lead-estimate-link');
  if (!leadMatchesEstimateContact(freshLead, freshEstimate)) return null;
  if (await leadLinkRefusal(freshLead)) return null;
  if (!leadWantsRecurringPlan(freshLead)) return null;
  return freshLead;
}

// The estimate page's offer: its own gate, then the shared eligibility. The
// long URL with NO channel claim (unverified delivery) and no write — a
// public GET stays read-only.
async function buildEstimateConsultationOffer({ estimate, estimateData, acceptActive } = {}) {
  try {
    if (!estimateConsultationOfferLive()) return null;
    const lead = await estimateConsultationLead({ estimate, estimateData, acceptActive });
    if (!lead) return null;
    const url = consultationUrlForLead(lead.id);
    return url ? { url } : null;
  } catch (err) {
    logger.warn(`[estimate-consultation-offer] build failed for estimate ${estimate?.id}: ${err.message}`);
    return null;
  }
}

// estimateConsultationLead is exported for its SECOND caller
// (server/services/estimate-email-consultation-offer.js, the
// estimate.engage_gone_quiet follow-up email's own consultation-offer
// link, owner ruling 2026-09-26) — the same shared eligibility this
// module's own page offer above already uses, never re-derived.
module.exports = {
  buildEstimateConsultationOffer,
  estimateConsultationLead,
  _test: { sameProperty, linkedLeadIdFor, finalEligibility, PROBE_BUDGET_MS },
};
