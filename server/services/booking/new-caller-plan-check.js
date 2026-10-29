'use strict';

// D8 "bell first" (owner 2026-10-27, decision page XEdKkCdk): the call that a
// visit booked by address links to may agree a plan price. The office still
// sets the plan up by hand, as today; PR 1's check bell
// (new-caller-link-from-call.js) shows it the plan the call agreed: the booked
// service, the price per visit, the yearly total, the prepay choice, whether
// the setup fee was said, the call's own words, and which of the six checks
// pass. Nothing here writes a price, a plan or a message. The six checks are
// the ones that blocked every misread price in the past-call test (126 calls,
// 2026-10-25); after two months a count of the calls that passed all six
// (notifications.metadata.plan_check) decides whether the agent sets plans up
// itself (option B).

const { resolveCallAgreedPrice, formatAgreedPriceLabel } = require('../../utils/call-agreed-price');
const { isAssessmentVisit } = require('../assessment-booking');
const { findServiceByName } = require('../call-booking-catalog');

const SERVICE_COLUMNS = ['id', 'service_key', 'name', 'short_name', 'billing_type', 'frequency', 'visits_per_year'];
// A plan unit as the call reader spells it, and its count in a year; a price
// per application counts the booked service's own visits a year. Any other
// unit but one_time (unknown, none) has no yearly total.
const PER_YEAR = Object.freeze({ per_application: null, per_quarter: 4, per_month: 12, per_year: 1 });
// Two plan prices agree when their yearly totals are within 3%: "$107 a visit" and "$428 a year".
const YEARLY_TOLERANCE = 0.03;
const QUOTE_CHARS = 160;
const MAX_QUOTES = 3;

// The six checks, in the order the bell names one that fails.
const CHECK_WORDS = Object.freeze({
  booked_on_call: 'the office booked the first visit on this call',
  staff_offered_caller_accepted: 'staff said the price and the caller accepted it in their own words',
  final_price: 'it was the last price said, not a range, and no estimate was promised',
  one_yearly_total: 'every accepted plan price gives the same yearly total',
  not_assessment: 'the first visit is not a Waves Assessment',
  same_schedule: 'the service the call names has the same schedule as the booked visit',
});
// The call reader's prepay_term on an accepted price, first match wins.
const PREPAY_WORDS = { annual: 'annual prepay', none: 'pays per visit' };
const SETUP_FEE_WORDS = { accepted: 'said and accepted', not_accepted: 'said, not accepted', not_said: 'not said' };

const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => `$${n.toFixed(2)}`;

// The six checks, each true or false. `terms` are the agreed price's terms (call-agreed-price.js) and
// `totals` the yearly total of each term that is not a one-time price (null when it has none).
function sixChecks({ request, terms, totals, bookedService, namedService }) {
  const known = totals.filter((n) => n != null);
  return {
    // The link step found this visit by the call stamped on it at Book.
    booked_on_call: true,
    staff_offered_caller_accepted: request.price_offered_by_staff === true && request.price_accepted_by_caller === true,
    final_price: request.price_is_final === true && request.quote_promised !== true && !terms.some((t) => t.amountMax != null),
    one_yearly_total: known.length > 0 && known.length === totals.length
      && Math.max(...known) - Math.min(...known) <= YEARLY_TOLERANCE * Math.max(...known),
    // planCheck returns before any check for an assessment.
    not_assessment: true,
    same_schedule: Boolean(bookedService?.frequency) && namedService?.frequency === bookedService.frequency,
  };
}

/**
 * The plan a call agreed, or null when there is none to set up: no price agreed on the
 * call (the plan comes from an estimate, as today), a Waves Assessment first (the price
 * follows the walkthrough), or a one-time job with no price a month, a quarter or a year.
 *   extraction     the pass's v2 extraction (the one reader of an agreed price reads v2 only)
 *   visit          the linked visit; bookedService its catalog row
 *   namedService   the catalog row the call reader named (service_request.specific_service_name)
 *   setupFee       the WaveGuard setup fee amount (estimate-converter's WAVEGUARD_SETUP_FEE)
 */
function planCheck({ extraction, visit, bookedService = null, namedService = null, setupFee }) {
  const agreed = resolveCallAgreedPrice(extraction);
  if (!agreed) return null;
  if (isAssessmentVisit({ service_type: visit?.service_type, catalog_service_key: bookedService?.service_key, catalog_service_name: bookedService?.name })) return null;
  const terms = [agreed, ...(agreed.additionalTerms || [])];
  // On a one-time job only a price a month, a quarter or a year makes a plan; a price per application is the job's own.
  if (bookedService?.billing_type !== 'recurring' && !terms.some((t) => PER_YEAR[t.unit])) return null;

  const visitsPerYear = Number(bookedService?.visits_per_year) > 0 ? Number(bookedService.visits_per_year) : null;
  // Every term but a one-time price is part of the plan; one with no plan unit has no yearly total.
  const planTerms = terms.filter((t) => t.unit !== 'one_time');
  const totals = planTerms.map((t) => {
    const count = t.unit === 'per_application' ? visitsPerYear : PER_YEAR[t.unit];
    return count ? round2(t.amount * count) : null;
  });
  const request = extraction.service_request || {};
  const prices = (Array.isArray(request.prices) && request.prices.length ? request.prices : [request.price])
    .filter((p) => p && typeof p === 'object');
  const accepted = prices.filter((p) => p.accepted === true);
  const setup = prices.find((p) => p.unit === 'one_time' && p.amount_usd === setupFee);
  const checks = sixChecks({ request, terms, totals, bookedService, namedService });
  const failed = Object.keys(CHECK_WORDS).filter((key) => !checks[key]);
  // A price per visit and a yearly total only when the call's terms give one answer.
  const yearly = checks.one_yearly_total && checks.final_price ? totals[0] : null;
  const [primary] = planTerms;
  let perVisit = null;
  if (yearly != null && primary.unit === 'per_application') perVisit = primary.amount;
  else if (yearly != null && visitsPerYear) perVisit = round2(yearly / visitsPerYear);

  return {
    service: bookedService?.name || visit?.service_type || null,
    agreed: formatAgreedPriceLabel(agreed),
    perVisit,
    yearly,
    prepay: Object.keys(PREPAY_WORDS).find((term) => accepted.some((p) => p.prepay_term === term)) || null,
    setupFee: { amount: setupFee, said: (setup && (setup.accepted === true ? 'accepted' : 'not_accepted')) || 'not_said' },
    quotes: [...new Set([...accepted, setup].filter(Boolean)
      .map((p) => String(p.evidence_quote || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean))]
      .slice(0, MAX_QUOTES)
      .map((q) => (q.length > QUOTE_CHARS ? `${q.slice(0, QUOTE_CHARS - 1).trimEnd()}…` : q)),
    checks,
    failed,
    allPass: failed.length === 0,
  };
}

// Reads nothing when the call agreed no price (most calls).
async function loadPlanCheck(conn, visit, extraction) {
  if (!resolveCallAgreedPrice(extraction)) return null;
  const services = await conn('services').where({ is_active: true }).select(SERVICE_COLUMNS);
  return planCheck({
    extraction,
    visit,
    bookedService: services.find((s) => String(s.id) === String(visit.service_id)) || null,
    namedService: findServiceByName(services, extraction?.service_request?.specific_service_name),
    setupFee: require('../estimate-converter').WAVEGUARD_SETUP_FEE,
  });
}

// The plan's lines in the check bell's detail: every agreed term as said, then what they
// come to when they give one answer.
function planCheckDetail(plan) {
  const perVisit = plan.perVisit != null ? `${money(plan.perVisit)} a visit, ` : '';
  const comesTo = plan.yearly == null ? '' : ` That is ${perVisit}${money(plan.yearly)} a year${plan.allPass ? '' : ', if the call is right'}.`;
  return [
    `Plan from the call: ${plan.service || 'the booked service'}. Agreed on the call: ${plan.agreed}.${comesTo}`,
    `Prepay: ${PREPAY_WORDS[plan.prepay] || 'not said'}. $${plan.setupFee.amount} setup fee: ${SETUP_FEE_WORDS[plan.setupFee.said]}.`,
    ...(plan.quotes.length ? [`Said on the call: ${plan.quotes.map((q) => `"${q}"`).join('; ')}`] : []),
    plan.allPass ? 'Checks: all six pass.' : `Checks not passed: ${plan.failed.map((key) => CHECK_WORDS[key]).join('; ')}.`,
    'The plan is not set up. Set it up by hand, as today.',
  ].join('\n  ');
}

// What the two-month count reads (notifications.metadata.plan_check).
function planCheckRecord(plan) {
  return {
    all_pass: plan.allPass,
    failed: plan.failed,
    per_visit: plan.perVisit,
    yearly: plan.yearly,
    prepay: plan.prepay,
    setup_fee_said: plan.setupFee.said,
  };
}

module.exports = {
  loadPlanCheck,
  planCheckDetail,
  planCheckRecord,
  _private: { planCheck, CHECK_WORDS },
};
