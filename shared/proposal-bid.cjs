'use strict';

// Shared by the proposal editor, authoritative totals, and document renderers.
// Quantities and unit rates retain four decimals; extended charges round once
// to cents. No service rates or recommended pesticide application rates live here.
const PROPOSAL_UNITS = {
  each: 'each', sqft: 'sq ft', lf: 'linear ft', acre: 'acres', lb: 'lb',
  gal: 'gal', hour: 'hours', day: 'days', trip: 'trips', lump_sum: 'lump sum',
};
const COST_CATEGORIES = {
  material: 'Materials', labor: 'Labor', equipment: 'Equipment',
  mobilization: 'Mobilization', travel: 'Travel', monitoring: 'Monitoring',
  warranty: 'Warranty / retreatment', overhead: 'Overhead', other: 'Other',
};
const BID_FORM_PROFILES = {
  north_port_pr27_02: { label: 'North Port PR27-02 · quote form', page: 15, minimumValidThrough: '2026-12-21', rows: { product: 'Product', application: 'Application', other: 'Additional item', freight: 'Freight' } },
  cove_termite: { label: 'Cove + Willoughby · termite bid form', page: 3, rows: { apartments: 'Apartment buildings', clubhouse: 'Clubhouse', garages: 'Garages / maintenance' } },
};
// Only these units count discrete service units; every other unit (area,
// length, weight, volume, time, lump sum) is a pricing basis whose quantity
// must not multiply per-visit costs. A line with no unit keeps the legacy
// "quantity is a count" reading.
const PROPOSAL_COUNT_UNITS = ['each', 'trip'];
const proposalLineServiceCount = (line) => {
  if (line.unit && !PROPOSAL_COUNT_UNITS.includes(line.unit)) return 1;
  return Math.max(1, Number(line.quantity) || 1);
};
const roundDecimal = (value, places = 4) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  // Shift decimal notation before rounding; binary multiplication loses ties
  // such as 10.075. Match decimal half-away-from-zero rounding.
  const [coefficient, exponent = '0'] = String(Math.abs(n)).split('e');
  const scaled = Number(`${coefficient}e${Number(exponent) + places}`);
  return Math.sign(n) * Math.round(scaled) / (10 ** places);
};
const roundCents = (value) => roundDecimal(value, 2);
const proposalLineAmount = (line, occurrences = 1) => {
  // Four-decimal inputs multiply in integer hundred-millionths of a dollar, so a
  // half-cent product cannot drift below its boundary before rounding.
  const quantity = Math.round(roundDecimal(line.quantity) * 10000);
  const price = Math.round(roundDecimal(line.unitPrice) * 10000);
  if (!Number.isFinite(quantity * price) || !Number.isInteger(occurrences)) return 0;
  const product = BigInt(quantity) * BigInt(price) * BigInt(occurrences);
  return Number(((product < 0n ? -product : product) + 500000n) / 1000000n) * Math.sign(Number(product)) / 100;
};
const formatQuantity = (line) => `${Number(line.quantity).toLocaleString('en-US', { maximumFractionDigits: 4 })}${PROPOSAL_UNITS[line.unit] ? ` ${PROPOSAL_UNITS[line.unit]}` : ''}`;
const formatUnitPrice = (value) => Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const formatLineBasis = (line) => `${formatQuantity(line)} × ${formatUnitPrice(line.unitPrice)}`;
// Customer documents print the quantity × rate basis whenever the cent-rounded
// amount alone would hide a reviewed input: an explicit unit, a quantity other
// than one, or a rate with fractional cents (1 × $10.075 shows as $10.08
// otherwise). Shared by the public card, the browser document and SSR.
const showsLineBasis = (line) => Boolean(line.unit) || Number(line.quantity) !== 1 || roundDecimal(line.unitPrice) !== roundCents(line.unitPrice);

// Decimal inputs: finite, in range, at most four decimal places (string
// forms may not smuggle more precision through exponents).
function decimalValid(value, { min = 0, max = 99999999.99 } = {}) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return false;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return false;
  if (typeof value === 'string') {
    const match = /^[+-]?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value.trim());
    if (!match) return false;
    const fraction = match[2] || '';
    const digits = match[1] + fraction;
    const trailingZeros = digits.length - digits.replace(/0+$/, '').length;
    return fraction.length - Number(match[3] || 0) - trailingZeros <= 4;
  }
  return Math.abs(n - roundDecimal(n)) <= Number.EPSILON * Math.abs(n);
}
// ONE definition of a saveable cost row, shared by the server validator and
// the costing card's completeness predicate, so the UI never shows a margin
// for a cost model the save would refuse (GH codex P2 r2 on #4270).
const COST_ROW_LIMITS = { descriptionLength: 200, phaseLength: 120, quantityMax: 1000000000, occurrencesMax: 1000, extendedMax: 99999999.99, rowsMax: 100 };
function costRowIssue(row) {
  if (!row || typeof row.description !== 'string' || !row.description.trim() || row.description.length > COST_ROW_LIMITS.descriptionLength || String(row.phase || '').length > COST_ROW_LIMITS.phaseLength) return 'Cost rows need a description (up to 200 characters) and a phase of up to 120 characters.';
  if (!Object.hasOwn(COST_CATEGORIES, row.category) || !Object.hasOwn(PROPOSAL_UNITS, row.unit)) return 'Choose a category and unit for each cost row.';
  if (!decimalValid(row.quantity, { min: 0.0001, max: COST_ROW_LIMITS.quantityMax }) || !decimalValid(row.unitCost)) return 'Cost quantities must be positive and unit costs nonnegative, with at most four decimal places.';
  if (!Number.isInteger(Number(row.occurrences)) || String(row.occurrences).trim() === '' || Number(row.occurrences) < 1 || Number(row.occurrences) > COST_ROW_LIMITS.occurrencesMax) return 'Cost occurrences must be a whole number from 1 to 1,000.';
  if (Number(row.quantity) * Number(row.unitCost) * Number(row.occurrences) > COST_ROW_LIMITS.extendedMax) return 'Each extended project cost must be at most $99,999,999.99.';
  return null;
}

// ONE definition of the revenue-side limits the proposal save enforces on
// the itemization computeTotals sums, so the costing card never presents a
// margin over revenue that cannot be saved as entered — a 4.5-visit program
// rounds to five in the sidebar and is refused by the PUT (GH codex P2 r8
// on #4270). The server validator uses the same predicates.
const PROGRAM_FREQUENCY_MAX = 52;
const wholeCents = (n) => Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) <= 1e-6;
function programRevenueIssue(program) {
  const freq = Number(program?.frequencyPerYear ?? program?.visitsPerYear);
  if (!Number.isInteger(freq) || freq < 1 || freq > PROGRAM_FREQUENCY_MAX) return 'Each program needs a whole-number service frequency between 1 and 52 visits per year.';
  const price = Number(program?.pricePerApplication ?? program?.perApplication);
  if (!wholeCents(price) || price < 0.01) return 'Each program needs a per-application price of at least $0.01, in whole cents.';
  return null;
}
function proposalRevenueIssue({ buildings = [], programs = [], correctiveWork = [] } = {}) {
  for (const program of programs) { const issue = programRevenueIssue(program); if (issue) return issue; }
  const lines = buildings.flatMap((b) => (Array.isArray(b?.lineItems || b?.line_items) ? (b.lineItems || b.line_items) : []));
  if (lines.some((i) => Number(i?.unitPrice ?? i?.unit_price ?? i?.price) < 0 || Number(i?.quantity) < 0)) return 'Proposal line items cannot have negative quantities or unit prices.';
  if (correctiveWork.some((w) => Number(w?.amount ?? w?.price) < 0)) return 'Corrective work amounts cannot be negative.';
  if (correctiveWork.some((w) => !wholeCents(Number(w?.amount ?? w?.price ?? 0)))) return 'Corrective work amounts must be whole-cent dollar values.';
  return null;
}

function computeProjectCosts(costing, totals, { revenueIssue = null } = {}) {
  const rows = Array.isArray(costing?.rows) ? costing.rows : [];
  // An absent period keeps the one-year default; a PRESENT blank or invalid
  // period is incomplete, never silently one year (GH codex P2 on #4270).
  const rawYears = costing?.revenueYears;
  const revenueYears = rawYears == null ? 1
    : (String(rawYears).trim() !== '' && Number.isInteger(Number(rawYears)) && Number(rawYears) >= 1 && Number(rawYears) <= 30 ? Number(rawYears) : null);
  const costsComplete = !revenueIssue && revenueYears != null && rows.length > 0 && rows.length <= COST_ROW_LIMITS.rowsMax && rows.every((row) => !costRowIssue(row));
  const byCategory = {};
  for (const row of rows) {
    const amount = proposalLineAmount({ quantity: row.quantity, unitPrice: row.unitCost }, Number(row.occurrences || 1));
    byCategory[row.category] = roundCents((byCategory[row.category] || 0) + amount);
  }
  const cost = roundCents(Object.values(byCategory).reduce((sum, amount) => sum + amount, 0));
  const revenue = revenueYears == null ? null : roundCents(Number(totals?.oneTime || 0) + Number(totals?.annualRecurring || 0) * revenueYears);
  const profit = costsComplete ? roundCents(revenue - cost) : null;
  return { cost, revenue, revenueYears, profit, marginPercent: costsComplete && revenue > 0 ? roundDecimal(profit / revenue * 100, 2) : null, byCategory, costsComplete };
}

module.exports = { PROPOSAL_UNITS, PROPOSAL_COUNT_UNITS, proposalLineServiceCount, COST_CATEGORIES, BID_FORM_PROFILES, roundDecimal, roundCents, proposalLineAmount, formatQuantity, formatUnitPrice, formatLineBasis, showsLineBasis, decimalValid, COST_ROW_LIMITS, costRowIssue, programRevenueIssue, proposalRevenueIssue, computeProjectCosts };
