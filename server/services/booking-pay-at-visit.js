// Booking "pay per application" — resolve a per-application price for a
// self-booking from the estimate it is EXPLICITLY linked to (estimate_id),
// bound to the booked service AND the booking's series cadence, so the visit can
// be stamped with estimated_price + payment_method_preference='pay_at_visit' +
// create_invoice_on_complete (booking.js). No charge/card capture here; billing
// rides the existing completion → invoice → /pay path.
//
// Scope: LINKED estimates only. Lighting up the common quote-wizard booking
// (which carries no estimate_id) is a separate follow-up that passes a
// server-trusted estimate reference from the quote flow into /book — inferring
// which quote a booking came from proved unsafe/ineffective (the real /book UI
// is address-prelinked and sends no phone to verify identity).
const logger = require('./logger');

// A recurring line's monthly price (any positive value across shape aliases) —
// used ONLY to identify a priced recurring line, never as the billed amount.
function lineMonthlyOf(s) {
  return Number(s.monthlyAfterCredits ?? s.monthlyAfterDiscount ?? s.monthly ?? s.mo ?? s.monthlyTotal ?? s.monthly_total);
}
function perAppOf(s) {
  return Number(s.perApp ?? s.perTreatment ?? s.perVisit ?? s.pa);
}

// Supplemental recurring programs (rodent bait, palm injection) are persisted
// OUTSIDE recurring.services (result.recurring.rodentBaitMo / palmInjectionMo)
// and NOT surfaced by recurringServicesFromEstimateData — but estimate.annual_total
// still includes them. So a pest+rodent quote could show a single pest service
// row while annual_total covers both. Fail closed when any supplemental program
// is present (in ANY recurring container) so we never divide a combined total by
// one service's cadence.
function hasSupplementalRecurring(estimate) {
  const data = estimate.estimate_data || {};
  const containers = [data.recurring, data.result?.recurring, data.results, data.result?.results].filter(Boolean);
  return containers.some((c) => Number(c.rodentBaitMo) > 0 || Number(c.palmInjectionMo) > 0 || Number(c.rodBaitMo) > 0);
}

const VISITS_PER_YEAR_BY_PATTERN = {
  weekly: 52, biweekly: 26, monthly: 12, bimonthly: 6,
  quarterly: 4, triannual: 3, semiannual: 2, biannual: 2, annual: 1, yearly: 1,
};
function resolveVisitsPerYear(s) {
  // Numeric count aliases must AGREE: a row carrying e.g. visitsPerYear 6
  // and visits 9 is contradictory, and picking one by precedence could
  // activate the wrong cadence — fail closed instead. (`visits` is read at
  // all because engine mosquito lines carry ONLY it — the gap that
  // silently kept mosquito out of per-application pricing.)
  // The converter's SHARED count vocabulary + validation (codex #3504 r3 +
  // r5): palm lines carry cadence ONLY as appsPerYear, and a POPULATED
  // count alias that is not a positive number ({ visitsPerYear: 6,
  // visits: 0 }) is malformed data, not an absent count — silently
  // dropping it could activate a cadence the row does not cleanly state.
  // Same fail-closed contract conversion applies to the same rows.
  // A fractional count (fungal palm 0.5/yr) matches no promised pattern
  // and fails closed. `frequency` stays outside the shared vocabulary
  // (it is legitimately a pattern STRING) but a numeric one must agree.
  const { visitCountAliasValues, visitCountFieldsConflict, visitCountFieldsInvalid } = require('./estimate-converter');
  if (visitCountFieldsInvalid(s) || visitCountFieldsConflict(s)) return null;
  const numericCounts = [
    ...visitCountAliasValues(s),
    s.frequency,
  ]
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (numericCounts.length > 0) {
    return numericCounts.every((v) => v === numericCounts[0]) ? numericCounts[0] : null;
  }
  const { normalizeRecurringPattern } = require('./recurring-appointment-seeder');
  const pattern = normalizeRecurringPattern(s.frequency ?? s.cadence);
  return (pattern && VISITS_PER_YEAR_BY_PATTERN[pattern]) || null;
}

// Extract recurring services from ANY estimate shape via the converter's
// authoritative extractor. Accepts a DB row (.estimate_data) or a live estimate
// object (.lineItems, wrapped so the engineResult path finds them).
function recurringServicesFromEstimate(estimate) {
  if (!estimate) return [];
  const { recurringServicesFromEstimateData } = require('./estimate-converter');
  const data = estimate.estimate_data
    || (Array.isArray(estimate.lineItems) ? { engineResult: { lineItems: estimate.lineItems } } : {});
  try {
    return recurringServicesFromEstimateData(data) || [];
  } catch (err) {
    logger.warn(`[booking-pay-at-visit] recurring-service extraction failed: ${err.message}`);
    return [];
  }
}

// The single per-application-billable recurring service + its cadence, or null.
// Eligibility: exactly one priced recurring line, a positive per-app caption
// (signals per-visit billing, not a monthly-only tier), and a resolvable cadence.
function pickRecurringService(services) {
  const priced = (Array.isArray(services) ? services : []).filter((s) => lineMonthlyOf(s) > 0);
  if (priced.length !== 1) return null;
  const svc = priced[0];
  if (!(perAppOf(svc) > 0)) return null;
  const visits = resolveVisitsPerYear(svc);
  if (!visits) return null;
  return { svc, visits };
}

// Per-visit NET amounts = estimate-level net recurring annual ÷ cadence,
// ANCHORED so the series sums to the quoted annual exactly (same penny-drift
// class the annual-total anchor fixed on the prepay leg): follow-up visits get
// the floored quotient and the FIRST visit absorbs the remainder cents, so a
// rounded quotient stamped across all visits can never over-/under-bill the
// year. Uses the authoritative estimate total, not line fields. Requires the
// estimate's cadence to equal the booking's series cadence (bookingVisits):
// annual_total is priced for the quote's cadence, so dividing it by a
// different number of visits (e.g. a monthly quote's annual over a quarterly
// series) would mis-bill → fail closed on any mismatch.
function perVisitAmountForEstimate(estimate, picked, bookingVisits) {
  if (!(bookingVisits > 0) || picked.visits !== bookingVisits) return null;
  const netAnnual = Number(estimate.annual_total) > 0
    ? Number(estimate.annual_total)
    : (Number(estimate.monthly_total) > 0 ? Number(estimate.monthly_total) * 12 : 0);
  if (!(netAnnual > 0)) return null;
  const annualCents = Math.round(netAnnual * 100);
  const followUpCents = Math.floor(annualCents / bookingVisits);
  const firstVisitCents = annualCents - followUpCents * (bookingVisits - 1);
  if (!(followUpCents > 0) || !(firstVisitCents > 0)) return null;
  return {
    firstVisitAmount: firstVisitCents / 100,
    followUpAmount: followUpCents / 100,
  };
}

// Exposed for tests: net per-application amount for an estimate at a cadence.
// Returns the follow-up (series) amount — the even quotient every visit after
// the remainder-absorbing first one bills.
function derivePerApplicationAmount(estimate, bookingVisits) {
  const picked = pickRecurringService(recurringServicesFromEstimate(estimate));
  const perVisit = picked ? perVisitAmountForEstimate(estimate, picked, bookingVisits) : null;
  return perVisit ? perVisit.followUpAmount : null;
}

// Cadence a pattern PROMISES — the quote's visit count must agree exactly
// or the plan is ambiguous and seeding fails closed (e.g. a numeric 9-visit
// mosquito line normalizes to 'bimonthly' by deliberate legacy rule, which
// contradicts its 9 visits: such rows stay office-scheduled).
const PATTERN_PROMISED_VISITS = {
  weekly: 52, biweekly: 26, monthly: 12, every_6_weeks: 9, seasonal_feb_oct: 9,
  bimonthly: 6, quarterly: 4, triannual: 3, semiannual: 2, annual: 1,
};

// The recurring-series plan a wizard quote itself defines for the booked
// service — the QUOTE is the cadence authority, never the client's
// recurring_pattern. Non-null only when the estimate has exactly one priced
// per-application recurring line, it matches the booked service family, no
// supplemental program rides the annual total, and the line's cadence
// pattern and visit count agree. Drives non-pest funnel series seeding
// (owner GO 2026-08-26); every ambiguity = null = today's single-visit
// office-scheduled behavior.
// Families the wizard self-book path may ACTIVATE a series for. Termite
// and rodent bait are deliberately EXCLUDED (codex #3504 r5): their
// activation is inseparable from converter accept machinery this route
// must not re-implement — the signable termite program agreement
// (maybeCreateTermiteProgramAgreement keys off accepted estimates),
// station install/ownership stamping, the termite_station_rental billing
// rider folded into bait pricing, and the catalog's own visit durations
// (termite_bait reserves 180min; the coarse funnel books 90). Those
// quotes fail closed to today's behavior: a single office-scheduled
// visit, with the office converting the draft through the accept path
// where all of that already runs.
const WIZARD_SEEDABLE_FAMILIES = new Set(['mosquito', 'lawn_care', 'tree_shrub', 'palm_injection']);

function resolveWizardSeriesPlan(estimate, serviceKey) {
  if (!WIZARD_SEEDABLE_FAMILIES.has(serviceKey)) return null;
  const picked = pickRecurringService(recurringServicesFromEstimate(estimate));
  if (!picked || !serviceKey) return null;
  if (serviceKeyOf(picked.svc) !== serviceKey) return null;
  if (hasSupplementalRecurring(estimate)) return null;
  // Family-aware cadence via the converter's authoritative resolver — the
  // same rules the accept/seeding flows use (lawn/tree numeric-nine reads
  // every_6_weeks, never the generic bimonthly bucket; codex #3504 r1).
  const { explicitServiceCadence } = require('./estimate-converter');
  let pattern = explicitServiceCadence(picked.svc) || null;
  if (serviceKey === 'mosquito') {
    // Engine tier truth outranks the persisted label for mosquito
    // (MOSQUITO.tierVisits): 12 = monthly12; 9 = the seasonal9 Feb-Oct
    // program — the real wizard producer stamps seasonal9 rows with
    // frequency 'every_6_weeks' (estimate-public selectedMosquitoServiceRow),
    // an approximation that would seed billable treatments YEAR-ROUND and
    // bypass the winter-start guard (codex #3504 P0). And ONLY those two
    // programs exist: any other mosquito count fails closed HERE, never
    // through the generic buckets — pricing_config.mosquito_visits is
    // runtime-configurable, so a seasonal program tuned to e.g. 6 visits
    // would otherwise read as 'bimonthly', pass the generic promise check,
    // and seed billable treatments year-round (codex #3504 r6).
    if (picked.visits !== 9 && picked.visits !== 12) return null;
    pattern = picked.visits === 12 ? 'monthly' : 'seasonal_feb_oct';
  }
  if (!pattern) return null;
  // The converter's family-specific seeding eligibility is the cadence
  // authority (codex #3504 r7): the generic promise table alone accepts
  // internally consistent but RETIRED combinations — 4-visit quarterly
  // lawn (owner-retired 2026-08-04), 12-visit monthly tree/shrub — that
  // every accept path rejects, and a still-valid handoff whose mutable
  // draft drifted into one would bypass those protections. It also brings
  // the per-family data checks (cadence-field disagreement, nutritional/
  // commercial palm, count conflicts) this resolver must match.
  // Present the validated count under a RECOGNIZED alias for the shared
  // gate (codex #3504 r13): the lawn pricer emits its visit count only as
  // numeric `frequency` (LAWN_TIERS freq), which the converter's count
  // vocabulary deliberately excludes — the gate's lawn branch would read
  // no count and reject every valid 6/9/12 plan. picked.visits already
  // passed the agreement + invalid-alias checks, so this adds nothing new.
  const { supportsConverterFollowUpSeeding } = require('./estimate-converter');
  const gateLine = { ...picked.svc, visitsPerYear: picked.visits };
  if (!supportsConverterFollowUpSeeding(gateLine, {}, pattern)) return null;
  if (PATTERN_PROMISED_VISITS[pattern] !== picked.visits) return null;
  // Palm: ONLY the two-visit semiannual injection program is a recurring
  // plan (converter doctrine, codex #3504 r5) — the engine also emits
  // appsPerYear 1 (annual preventative) and fractional fungal shapes,
  // which conversion deliberately keeps in the one-time lane; activating
  // them would mark the visit recurring and stamp the semiannual catalog
  // identity onto a program that is not it.
  if (serviceKey === 'palm_injection' && !(pattern === 'semiannual' && picked.visits === 2)) return null;
  return { pattern, visits: picked.visits };
}

function serviceKeyOf(svc) {
  const { serviceKeyFor } = require('./recurring-appointment-seeder');
  return serviceKeyFor(svc);
}

// The family key wizard plan/pricing binds to for a signed funnel key:
// normally the signed key itself — except palm. A palm-only quote
// deliberately rides the `tree_shrub` funnel service for availability
// (public-quote's bookingServiceId mapping) while quoting Palm Injections,
// so binding the plan to the signed tree_shrub key would exclude palm from
// series seeding entirely (codex #3504 r2 P1: bookedServiceKey mismatch →
// plan never resolves). The palm identity comes from the TRUSTED handoff
// estimate's own single priced line — never from a client label — so the
// trust boundary is unchanged; every non-palm shape keeps the signed key.
function wizardPlanServiceKey(estimate, signedFunnelKey) {
  if (signedFunnelKey !== 'tree_shrub') return signedFunnelKey;
  const picked = pickRecurringService(recurringServicesFromEstimate(estimate));
  return picked && serviceKeyOf(picked.svc) === 'palm_injection'
    ? 'palm_injection'
    : signedFunnelKey;
}

// Price from a single estimate, only when its recurring service matches the
// booked service key AND cadence, and it carries no supplemental program.
// Returns { amount, followUpAmount, sourceEstimateId, serviceKey } or null —
// `amount` is the FIRST (parent) visit's remainder-absorbing price,
// `followUpAmount` the even price every seeded follow-up bills.
function priceFromEstimate(estimate, serviceKey, bookingVisits) {
  const picked = pickRecurringService(recurringServicesFromEstimate(estimate));
  if (!picked) return null;
  if (!serviceKey || serviceKeyOf(picked.svc) !== serviceKey) return null;
  // annual_total (the amount basis) would also cover any supplemental recurring
  // program, so pricing a single service off it would overbill → fail closed.
  if (hasSupplementalRecurring(estimate)) return null;
  const perVisit = perVisitAmountForEstimate(estimate, picked, bookingVisits);
  return perVisit
    ? {
        amount: perVisit.firstVisitAmount,
        followUpAmount: perVisit.followUpAmount,
        sourceEstimateId: estimate.id || null,
        serviceKey,
      }
    : null;
}

// Resolve a per-application price from the estimate the booking is LINKED to
// (estimate_id), bound to the booked service + series cadence. Never throws.
function resolveBookingVisitPrice({ estimate = null, serviceKey = null, bookingVisits = null } = {}) {
  try {
    if (estimate) return priceFromEstimate(estimate, serviceKey, bookingVisits);
  } catch (err) {
    logger.warn(`[booking-pay-at-visit] price resolution failed: ${err.message}`);
  }
  return null;
}

// Whether a STORED wizard estimate row is, in its CURRENT shape, one the
// quote→book handoff may act on. The wizard refreshes drafts in place, so a
// handoff token minted while the quote was a self-bookable shape can outlive
// that shape (recalculated into commercial / manual-review / mixed-billing /
// bed-bug — all office-scheduled). /booking/confirm therefore re-checks the
// row TWICE with this one predicate: before accepting the token as the
// customers-only GATE PASS, and again before pay-at-visit pricing (Codex
// #2964 r2: pricing-only re-checks left the gate honoring stale links).
// Row-shape mirror of public-quote's mint conditions (!quoteRequired &&
// !commercialDetected && !estimateBlocksSelfBookLink) — keep the two in sync.
//  - status must still be 'draft': once staff promote the estimate
//    (sent/accepted/declined) the customer's live links are the estimate's
//    own share/accept links, not the old quote handoff.
//  - mixed recurring + one-time and bed-bug shapes are office-scheduled;
//    their pricing would also drop one-time add-ons from billing.
// Recurring engine service keys the /book funnel can actually host — the
// union of every branch in public-quote's bookingServiceId mapping (pest,
// lawn, tree/palm, mosquito, termite, rodent; commercial_* variants are
// blocked upstream by commercialEstimatedPricing but listed for parity).
// Keep in sync with that mapping: a recurring shape outside this set gets NO
// self-book link at mint time, so a stale token for it must not gate-pass
// either (Codex #2964 r3 — foam_recurring drift).
const RECURRING_FUNNEL_MAPPABLE_SERVICES = new Set([
  'pest_control',
  'lawn_care', 'commercial_lawn',
  'tree_shrub', 'commercial_tree_shrub', 'palm_injection',
  'mosquito',
  'termite_bait', 'termite_bond',
  'rodent_bait',
]);

// ONE mixed-billing predicate for every self-serve surface (codex #3504
// r18): the quote page's handoff/link mint and the confirm-time draft
// gate must agree, or the CTA offers a slot the confirmation then refuses.
// Specialty-priced add-ons (lawn plugging, top dressing, lawn-pest work)
// and installation charges ride the engine summary as their OWN totals,
// not oneTimeTotal (r12) — a recurring line beside any of them is mixed
// billing: activating the recurring plan alone would archive the draft
// with the add-on's dollars neither scheduled nor billed nor left for
// office conversion.
function engineSummaryHasMixedBilling(summary = {}, data = {}) {
  const recurringAnnual = Number(summary.recurringAnnualAfterDiscount ?? summary.recurringAnnual ?? data.annual ?? 0);
  const oneTimeTotal = Number(summary.oneTimeTotal ?? data.oneTimeTotal ?? 0);
  const specialtyTotal = Number(summary.specialtyTotal ?? data.specialtyTotal ?? 0);
  const installationTotal = Number(summary.installationTotal ?? data.installationTotal ?? 0);
  return recurringAnnual > 0 && (oneTimeTotal > 0 || specialtyTotal > 0 || installationTotal > 0);
}

function wizardDraftSelfServeBookable(row) {
  if (!row || row.source !== 'quote_wizard' || row.status !== 'draft') return false;
  // A retired (archived) draft was consumed — by a self-booked series that
  // stamped its setup fee, or by staff. Its handoff token dies with it; a
  // fresh wizard run revives the draft (/calculate clears archived_at).
  if (row.archived_at) return false;
  const data = row.estimate_data || {};
  if (data.commercialEstimatedPricing || data.quoteRequired) return false;
  const summary = data.engineResult?.summary || {};
  const recurringAnnual = Number(summary.recurringAnnualAfterDiscount ?? summary.recurringAnnual ?? data.annual ?? 0);
  if (engineSummaryHasMixedBilling(summary, data)) return false;
  const lineItems = data.engineResult?.lineItems || [];
  if (lineItems.some((l) => l && l.service === 'bed_bug')) return false;
  // A recurring draft must contain at least one funnel-mappable recurring
  // line; one-time-only drafts route via bookingServiceFor instead and are
  // not held to this. Fail closed on a recurring draft with no line items.
  if (recurringAnnual > 0
      && !lineItems.some((l) => l && RECURRING_FUNNEL_MAPPABLE_SERVICES.has(l.service))) {
    return false;
  }
  return true;
}

module.exports = { derivePerApplicationAmount, resolveBookingVisitPrice, resolveWizardSeriesPlan, wizardDraftSelfServeBookable, wizardPlanServiceKey, engineSummaryHasMixedBilling };
