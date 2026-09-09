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
const roundDecimal = (value, places = 4) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const scale = 10 ** places;
  return Math.round((n + Number.EPSILON) * scale) / scale;
};
const roundCents = (value) => roundDecimal(value, 2);
const proposalLineAmount = (line) => roundCents(roundDecimal(line.quantity) * roundDecimal(line.unitPrice));
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
    const amount = roundCents(roundDecimal(row.quantity) * roundDecimal(row.unitCost) * Number(row.occurrences || 1));
    byCategory[row.category] = roundCents((byCategory[row.category] || 0) + amount);
  }
  const cost = roundCents(Object.values(byCategory).reduce((sum, amount) => sum + amount, 0));
  const revenue = roundCents(Number(totals?.oneTime || 0) + Number(totals?.annualRecurring || 0) * revenueYears);
  const profit = costsComplete ? roundCents(revenue - cost) : null;
  return { cost, revenue, profit, marginPercent: costsComplete && revenue > 0 ? roundDecimal(profit / revenue * 100, 2) : null, byCategory, costsComplete };
}

module.exports = { PROPOSAL_UNITS, COST_CATEGORIES, BID_FORM_PROFILES, roundDecimal, roundCents, proposalLineAmount, formatQuantity, formatUnitPrice, formatLineBasis, computeProjectCosts };
