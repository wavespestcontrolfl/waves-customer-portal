import { buildMonthlyAverage } from '@estimate-monthly-average';
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
  if (recurring.length === 0) return null;
  // The unsplit "bundle" card carries no per-service price to average.
  if (recurring.some((section) => section.key === 'bundle')) return null;
  if (!planFrequency || planFrequency.quoteRequired === true || Number(planFrequency.lowConfidenceRangePct) > 0) return null;

  const rows = [];
  for (const section of recurring) {
    const frequencies = Array.isArray(section.frequencies) ? section.frequencies : [];
    const current = frequencies.find((f) => f.key === selected?.[section.key]) || frequencies[0] || null;
    if (!current || current.quoteRequired === true || Number(current.lowConfidenceRangePct) > 0) return null;
    const perApplication = perApplicationNetForFrequency(current);
    const visits = perApplicationVisitsForFrequency(current);
    if (!(perApplication > 0) || !(visits > 0)) return null;
    // A card that still bills a flat monthly ("Billed $X/mo") is not paid after
    // each application; the average would contradict it.
    if (perApplicationBilledMonthly(current, perApplication)) return null;
    rows.push({ key: section.key, label: section.label || section.key, perApplication, visits });
  }
  const model = buildMonthlyAverage({
    services: rows,
    planMonthly: Number(planFrequency.monthly),
    credit,
    bundleDiscountPct,
  });
  if (!model) return null;
  return { model, byKey: Object.fromEntries(model.services.map((s) => [s.key, s.monthly])) };
}
