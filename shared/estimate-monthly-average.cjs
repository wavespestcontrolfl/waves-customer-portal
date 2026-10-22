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

// GATE_ESTIMATE_APPLICATION_MONTHS (owner 2026-10-21, EST-2026-1185: "Which is
// it? $113 a month or $189 a month?"): what the customer pays in the months a
// service is applied, beside the average. Only for the one shape whose months
// are certain without a schedule: exactly ONE service on an even cadence that
// divides the year (every 2, 3, 4 or 6 months, or once a year) plus services
// applied every month. Two non-monthly services could land in the same month
// or not, and a 9-application cadence has no fixed months, so those plans keep
// today's summary. A plan credit has no fixed month either. The two amounts,
// weighted by their month counts, must land on the plan average to the cent
// band the average itself allows, or nothing new shows. Pure; the page, the
// PDF document and the emails all call this one function.
const CADENCE_TEXT = { 1: 'once a year', 2: 'every 6 months', 3: 'every 4 months', 4: 'every 3 months', 6: 'every 2 months', 12: 'every month' };

function cadenceText(visits) {
  return CADENCE_TEXT[visits] || null;
}

// The proposal's per-application lines read "Pest Control — 4 applications/yr" (or carry a
// "(12 visits)" in the name); the month rows name the service and say the cadence themselves, so
// the suffix is dropped. A label without
// it (the page's section labels) is unchanged.
const CADENCE_SUFFIX = /\s+[—–-]\s+\d+\s+applications?\s*\/\s*(?:yr|year)\s*$/i;
const VISITS_PAREN = /\s*\(\s*\d+\s+(?:visits?|applications?)[^)]*\)\s*$/i;
const plainServiceName = (label) => String(label || '').replace(CADENCE_SUFFIX, '').replace(VISITS_PAREN, '').trim();

function applicationMonthsBreakdown(model) {
  if (!model || !model.multi || model.credit) return null;
  const services = Array.isArray(model.services) ? model.services : [];
  if (services.length < 2 || services.some((s) => !cadenceText(s.visits))) return null;
  const spaced = services.filter((s) => s.visits !== 12);
  const monthly = services.filter((s) => s.visits === 12);
  if (spaced.length !== 1 || monthly.length === 0) return null;
  const anchor = { ...spaced[0], label: plainServiceName(spaced[0].label) };
  const named = (list) => list.map((s) => plainServiceName(s.label));
  const cents = (n) => Math.round(Number(n) * 100);
  const monthlyCents = monthly.reduce((sum, s) => sum + cents(s.perApplication), 0);
  const applicationCents = monthlyCents + cents(anchor.perApplication);
  const appliedMonths = anchor.visits;
  const otherMonths = 12 - appliedMonths;
  const averageCents = (applicationCents * appliedMonths + monthlyCents * otherMonths) / 12;
  if (Math.abs(averageCents - cents(model.planMonthly)) > 5) return null;
  return {
    services: services.map((s) => ({ key: s.key, label: plainServiceName(s.label), perApplication: s.perApplication, cadence: cadenceText(s.visits) })),
    applicationMonths: {
      label: `Months with ${anchor.label}`,
      count: appliedMonths,
      amount: applicationCents / 100,
      detail: named(services).join(' + '),
    },
    otherMonths: {
      label: 'Other months',
      count: otherMonths,
      amount: monthlyCents / 100,
      detail: `${named(monthly).join(' + ')} only`,
    },
    planMonthly: model.planMonthly,
  };
}

// The breakdown as two plain sentences for the emails, in front of the average
// sentence: "Months with Pest Control (4 a year): $189.90. Other months (8 a
// year): $74.70, Mosquito only."
function applicationMonthsSentence(breakdown) {
  if (!breakdown) return '';
  const a = breakdown.applicationMonths;
  const o = breakdown.otherMonths;
  return `${a.label} (${a.count} a year): ${money(a.amount)}. ${o.label} (${o.count} a year): ${money(o.amount)}, ${o.detail}.`;
}

/**
 * The delivery email's two pieces. `priceLine` replaces the "Estimated price"
 * row value; `note` is the second line, which rides in front of the existing
 * next-step paragraph (the template needs no new block).
 *
 * @param {object} model  buildMonthlyAverage() output
 * @param {{amount: number, setup: boolean}|null} [oneTime]  one-time charges, never in the average
 * @param {{applicationMonths?: boolean}} [options]  applicationMonths: put the month-by-month amounts
 *   (applicationMonthsBreakdown) in front of the note when the plan has that shape
 */
function emailParts(model, oneTime = null, { applicationMonths = false } = {}) {
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
  const months = applicationMonths ? applicationMonthsSentence(applicationMonthsBreakdown(model)) : '';
  const parts = [...(months ? [months] : []), averaged, 'You pay after each application.'];
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
  cadenceText,
  applicationMonthsBreakdown,
  applicationMonthsSentence,
};
