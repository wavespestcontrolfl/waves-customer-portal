import { CONTEXT_LINE, aboutMonth, buildMonthlyAverage } from '@estimate-monthly-average';
import { perApplicationBilledMonthly, perApplicationNetForFrequency, perApplicationVisitsForFrequency } from '../components/estimate/PriceCard';

/**
 * GATE_ESTIMATE_MONTHLY_AVERAGE (owner 2026-10-20): the monthly average the
 * estimate page prints beside its per-application prices. Pure; the page
 * resolves its own state (selected cadences, combined frequency, mode) and
 * passes it in.
 *
 * It reuses what each card already shows: the card's net per-application
 * price (perApplicationNetForFrequency) and application count, and the
 * SELECTED combined monthly the page already prices the plan at. It prices
 * nothing. The shared builder returns null when the per-service averages
 * cannot be made to add up to the plan monthly (or a declared credit explains
 * the gap), and then the page shows nothing new.
 *
 * @param {object} args
 * @param {boolean} args.enabled  server switch AND page-level eligibility
 *   (recurring mode, per-application billing, not commercial/quote-required,
 *   not the annual-prepay choice)
 * @param {Array} args.services  pricing.services (sections)
 * @param {object} args.selected  selected frequency key by section key
 * @param {object|null} args.planFrequency  the selected combined frequency (multi) or the lone section's frequency
 * @param {number} args.bundleDiscountPct  pricing.combinedRecurring.waveGuardDiscountPct (fraction)
 * @param {{label?: string, monthly: number}|null} args.credit  a declared plan credit, per month
 * @returns {null | {model: object, byKey: Record<string, number>}}
 */
export function pageMonthlyAverage({ enabled, services, selected, planFrequency, bundleDiscountPct = 0, credit = null } = {}) {
  if (!enabled || !Array.isArray(services)) return null;
  const recurring = services.filter((section) => section?.isRecurring);
  // The unsplit "bundle" card carries no per-service price to average.
  if (recurring.length === 0 || recurring.some((section) => section.key === 'bundle')) return null;
  if (!planIsAveragable(planFrequency)) return null;
  const rows = recurring.map((section) => rowForSection(section, selected));
  if (rows.some((row) => row === null)) return null;
  const model = buildMonthlyAverage({
    services: rows,
    planMonthly: Number(planFrequency.monthly),
    credit,
    bundleDiscountPct,
  });
  if (!model) return null;
  return { model, byKey: Object.fromEntries(model.services.map((s) => [s.key, s.monthly])) };
}

// A quote-required or ranged (low-confidence) price is never averaged.
function isRangedOrQuote(frequency) {
  return !frequency || frequency.quoteRequired === true || Number(frequency.lowConfidenceRangePct) > 0;
}

const planIsAveragable = (planFrequency) => !isRangedOrQuote(planFrequency);

// One recurring section's selected cadence as an averaging row, or null when it
// has no single unambiguous per-application price.
function rowForSection(section, selected) {
  const frequencies = Array.isArray(section.frequencies) ? section.frequencies : [];
  const current = frequencies.find((f) => f.key === selected?.[section.key]) || frequencies[0] || null;
  if (isRangedOrQuote(current)) return null;
  const perApplication = perApplicationNetForFrequency(current);
  const visits = perApplicationVisitsForFrequency(current);
  if (!(perApplication > 0) || !(visits > 0)) return null;
  // A card that still bills a flat monthly ("Billed $X/mo") is not paid after
  // each application; the average would contradict it.
  if (perApplicationBilledMonthly(current, perApplication)) return null;
  return { key: section.key, label: section.label || section.key, perApplication, visits };
}

const liveCredit = (discount) => (discount && Number(discount.amount) > 0 ? discount : null);

// The plan-wide credit the server did NOT itemize into the sections: the one
// declared difference between the cards and the plan's monthly. It comes from the
// SELECTED cadence combo's own credit state (a combo carries its own
// manualDiscount and suppression marker; the base row's is stale for it), and
// from the base frequency only when no combo is selected.
export function planCreditSource({ renderFlags, selectedCombo, combinedFrequency, pricing }) {
  if (renderFlags?.manualDiscountItemizedInSections === true) return null;
  if (selectedCombo) {
    return selectedCombo.manualDiscountSuppressed === true ? null : liveCredit(selectedCombo.manualDiscount);
  }
  if (combinedFrequency?.manualDiscountSuppressed === true) return null;
  return [combinedFrequency?.manualDiscount, pricing?.combinedRecurring?.manualDiscount, pricing?.manualDiscount]
    .map(liveCredit).find(Boolean) || null;
}

// An open, recurring, per-application plan: not one-time, commercial, billed
// monthly, quote-required, accepted/declined, or the annual-prepay choice.
export function pageAverageEligible({ data, serviceMode, estimate, billsMonthly, isCommercialEstimate, cta, paymentPreference }) {
  if (data?.monthlyAverageEnabled !== true) return false;
  if (serviceMode !== 'recurring' || estimate?.isOneTimeOnly === true) return false;
  if (billsMonthly || isCommercialEstimate) return false;
  return cta?.terminalState == null && cta?.quoteRequired !== true && paymentPreference !== 'prepay_annual';
}

/**
 * The page's whole monthly-average decision in one pure call: eligibility, the
 * plan frequency (combined for several services, the lone section's otherwise),
 * the declared credit, then the shared builder. `monthlyAmountOf` turns a
 * manualDiscount into its monthly slice (the page's own helper).
 */
export function resolvePageMonthlyAverage(input, monthlyAmountOf) {
  if (!pageAverageEligible(input)) return null;
  const { services, selected, combinedFrequency, pricing } = input;
  const recurringSections = services.filter((section) => section?.isRecurring);
  const planFrequency = recurringSections.length > 1
    ? combinedFrequency
    : selectedFrequencyOf(recurringSections[0], selected);
  const creditSource = planCreditSource(input);
  const creditMonthly = creditSource ? monthlyAmountOf(creditSource) : 0;
  return pageMonthlyAverage({
    enabled: true,
    services,
    selected,
    planFrequency,
    bundleDiscountPct: Number(pricing?.combinedRecurring?.waveGuardDiscountPct) || 0,
    credit: creditMonthly > 0 ? { label: creditSource.label, monthly: creditMonthly } : null,
  });
}

function selectedFrequencyOf(section, selected) {
  const frequencies = Array.isArray(section?.frequencies) ? section.frequencies : [];
  return frequencies.find((frequency) => frequency.key === selected?.[section?.key]) || frequencies[0] || null;
}

const ONE_TIME_NOTICE = ' One-time charges are not in the average.';

/**
 * Charges that sit beside the plan and never enter the average: a setup /
 * first-visit fee, or an ADDITIVE one-time breakdown row (a flea treatment).
 * When the estimate offers a one-time option, the breakdown rows are the
 * either/or alternative to the plan, not an extra charge, so they do not count.
 */
export function oneTimeBesidePlan({ feeList, estimate, pricing }) {
  if ((feeList || []).some((fee) => Number(fee?.amount) > 0)) return true;
  if (estimate?.showOneTimeOption) return false;
  const rows = Array.isArray(pricing?.oneTimeBreakdown?.items) ? pricing.oneTimeBreakdown.items : [];
  return rows.some((item) => item && item.kind === 'charge' && Number(item.amount) > 0 && item.quoteRequired !== true);
}

/** The "about $X a month" line for one section, or null. */
export function sectionAverageLine(monthlyAverage, sectionKey) {
  const amount = monthlyAverage?.byKey?.[sectionKey];
  return amount == null ? null : aboutMonth(amount);
}

/** The context sentence a single-service card carries (the plan summary carries it otherwise). */
export function singleServiceAverageContext(monthlyAverage, hasOneTime) {
  if (!monthlyAverage || monthlyAverage.model.showPlan) return null;
  return `${CONTEXT_LINE}${hasOneTime ? ONE_TIME_NOTICE : ''}`;
}
