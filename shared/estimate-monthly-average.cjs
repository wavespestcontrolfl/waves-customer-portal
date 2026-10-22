'use strict';

// Monthly AVERAGE beside per-application prices on residential estimates
// (owner ruling 2026-10-20, GATE_ESTIMATE_MONTHLY_AVERAGE).
//
// The per-application price STAYS the price. This module only derives the
// smaller "$X a month" line that sits under it. It never prices anything:
// every figure comes from numbers a surface already shows (per-application
// price and visit count per recurring service) and from the estimate's stored
// monthly total, which is the authority the plan average must equal.
//
// One definition for the email (server), the PDF document and the estimate
// page (browser), so the three can never disagree by a cent.
//
// Rules (owner HARD RULES):
//  1. The plan average equals the stored monthly total.
//  2. The per-service averages add up to the plan average to the cent. The
//     per-application prices a surface shows are already NET of the WaveGuard
//     bundle discount, so each service's raw average is price x visits / 12.
//     The raw averages differ from the stored total only by rounding (a cent or
//     two), which is allocated one cent at a time, largest line first. A larger
//     gap is accepted only when a declared plan credit explains it, and then it
//     prints as its own explicit negative line so the arithmetic is visible.
//     Any other gap means the figures do not describe the same plan: the whole
//     average is withheld (null) and the surface renders exactly as before.
//  3. One-time charges never enter the average (callers pass recurring
//     services only).

// Rounding noise allowed between the sum of the per-service averages and the
// stored total. The same budget estimate-proposal.js uses to reconcile lines
// against the stored annual total.
const RECONCILE_TOLERANCE = 0.05;

const CONTEXT_LINE = 'Averaged over the year. You pay after each application.';

const toCents = (n) => Math.round(Number(n) * 100);

function money(n) {
  const v = Math.round(Number(n) * 100) / 100;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * @param {object} input
 * @param {Array<{key?: string, label?: string, perApplication: number, visits: number}>} input.services
 *   Recurring services only, in display order.
 * @param {number} input.planMonthly  The stored monthly total (net of every discount).
 * @param {{label?: string, monthly: number}|null} [input.credit]  A declared plan-level credit, per month.
 * @param {number} [input.bundleDiscountPct]  The WaveGuard bundle discount as a fraction (0.1 = 10%).
 * @returns {null | {
 *   planMonthly: number,
 *   services: Array<{key: string, label: string, perApplication: number, visits: number, monthly: number}>,
 *   credit: null | {label: string, monthly: number},
 *   bundlePct: number,
 *   multi: boolean,
 * }}
 */
function buildMonthlyAverage({ services, planMonthly, credit = null, bundleDiscountPct = 0 } = {}) {
  if (!Array.isArray(services) || services.length === 0) return null;
  const planCents = toCents(planMonthly);
  if (!Number.isFinite(planCents) || planCents <= 0) return null;

  const raws = [];
  for (const service of services) {
    const perApplication = Number(service?.perApplication);
    const visits = Number(service?.visits);
    if (!(perApplication > 0) || !(visits > 0) || !Number.isFinite(perApplication) || !Number.isFinite(visits)) return null;
    raws.push((perApplication * visits) / 12);
  }
  const rawSum = raws.reduce((a, b) => a + b, 0);
  const gap = rawSum - Number(planMonthly);

  let cents = raws.map((raw) => toCents(raw));
  let creditOut = null;

  if (Math.abs(gap) <= RECONCILE_TOLERANCE) {
    // Rounding only: move the total onto the planned cents, largest line first.
    let diff = planCents - cents.reduce((a, b) => a + b, 0);
    const order = raws.map((raw, i) => i).sort((a, b) => raws[b] - raws[a] || a - b);
    const step = diff > 0 ? 1 : -1;
    for (let k = 0; diff !== 0; k += 1, diff -= step) {
      cents[order[k % order.length]] += step;
    }
  } else if (gap > RECONCILE_TOLERANCE) {
    // The services add up to MORE than the plan pays. Only a declared credit
    // can explain that; anything else withholds the average.
    const declared = Number(credit?.monthly);
    if (!(declared > 0) || Math.abs(gap - declared) > RECONCILE_TOLERANCE) return null;
    const creditCents = cents.reduce((a, b) => a + b, 0) - planCents;
    if (creditCents <= 0) return null;
    creditOut = { label: String(credit?.label || '').trim() || 'Discount', monthly: creditCents / 100 };
  } else {
    // The services add up to LESS than the plan pays: something is missing.
    return null;
  }
  if (cents.some((c) => c <= 0)) return null;

  const pct = Number(bundleDiscountPct);
  return {
    planMonthly: planCents / 100,
    services: services.map((service, i) => ({
      key: String(service.key ?? i),
      label: String(service.label || '').trim(),
      perApplication: Math.round(Number(service.perApplication) * 100) / 100,
      visits: Math.round(Number(service.visits)),
      monthly: cents[i] / 100,
    })),
    credit: creditOut,
    // Named only when the plan has two or more services, the only plans a
    // bundle discount applies to.
    bundlePct: services.length > 1 && pct > 0 ? Math.round(pct * 100) : 0,
    multi: services.length > 1,
    // A plan line is needed whenever the service lines alone do not equal the
    // plan: several services, or one service with a plan credit.
    showPlan: services.length > 1 || creditOut !== null,
  };
}

const monthlyText = (amount) => `${money(amount)} a month`;

// "Your plan averages" label, with the bundle clause when one applies.
function planLabel(model) {
  return model.bundlePct > 0
    ? `Your plan averages (${model.bundlePct}% bundle savings included)`
    : 'Your plan averages';
}

/**
 * The delivery email's two pieces. `priceLine` replaces the "Estimated price"
 * row value; `note` is the second line, which rides in front of the existing
 * next-step paragraph (the template needs no new block).
 *
 * @param {object} model  buildMonthlyAverage() output
 * @param {{amount: number, setup: boolean}|null} [oneTime]  one-time charges, never in the average
 */
function emailParts(model, oneTime = null) {
  if (!model) return null;
  let priceLine;
  if (model.multi) {
    // The per-application prices stay the prices (they sit on each card and in
    // the PDF); the average never stands alone as THE price (owner 2026-10-20).
    priceLine = `Priced per application · plan averages ${monthlyText(model.planMonthly)}`;
  } else {
    const only = model.services[0];
    priceLine = `${money(only.perApplication)} per application · ${monthlyText(model.planMonthly)}`;
  }
  const included = [];
  if (model.bundlePct > 0) included.push('bundle savings');
  if (model.credit) included.push(`${model.credit.label.toLowerCase()}`);
  const averaged = included.length
    ? `Averaged over the year, ${included.join(' and ')} included.`
    : 'Averaged over the year.';
  const parts = [averaged, 'You pay after each application.'];
  if (oneTime && Number(oneTime.amount) > 0) {
    parts.push(oneTime.setup
      ? `One-time setup ${money(oneTime.amount)}, not in the average.`
      : `One-time charges ${money(oneTime.amount)}, not in the average.`);
  }
  return { priceLine, note: parts.join(' ') };
}

module.exports = {
  CONTEXT_LINE,
  RECONCILE_TOLERANCE,
  buildMonthlyAverage,
  planLabel,
  monthlyText,
  emailParts,
  money,
};
