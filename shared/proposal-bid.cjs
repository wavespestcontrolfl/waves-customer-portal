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

function computeProjectCosts(costing, totals) {
  const rows = Array.isArray(costing?.rows) ? costing.rows : [];
  const revenueYears = Number(costing?.revenueYears) || 1;
  const costsComplete = rows.length > 0 && rows.every((row) => String(row.description || '').trim()
    && [row.quantity, row.unitCost, row.occurrences].every((value) => value != null && String(value).trim() !== '' && Number.isFinite(Number(value)))
    && Number(row.quantity) > 0 && Number(row.unitCost) >= 0 && Number.isInteger(Number(row.occurrences)) && Number(row.occurrences) > 0);
  const byCategory = {};
  for (const row of rows) {
    const amount = proposalLineAmount({ quantity: row.quantity, unitPrice: row.unitCost }, Number(row.occurrences || 1));
    byCategory[row.category] = roundCents((byCategory[row.category] || 0) + amount);
  }
  const cost = roundCents(Object.values(byCategory).reduce((sum, amount) => sum + amount, 0));
  const revenue = roundCents(Number(totals?.oneTime || 0) + Number(totals?.annualRecurring || 0) * revenueYears);
  const profit = costsComplete ? roundCents(revenue - cost) : null;
  return { cost, revenue, profit, marginPercent: costsComplete && revenue > 0 ? roundDecimal(profit / revenue * 100, 2) : null, byCategory, costsComplete };
}

module.exports = { PROPOSAL_UNITS, PROPOSAL_COUNT_UNITS, proposalLineServiceCount, COST_CATEGORIES, BID_FORM_PROFILES, roundDecimal, roundCents, proposalLineAmount, formatQuantity, formatUnitPrice, formatLineBasis, computeProjectCosts };
