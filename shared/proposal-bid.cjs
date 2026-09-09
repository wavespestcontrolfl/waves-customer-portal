'use strict';

// Shared by the proposal editor, authoritative totals, and document renderers.
// Quantities and unit rates retain four decimals; extended charges round once
// to cents. No service rates or recommended pesticide application rates live here.
const PROPOSAL_UNITS = {
  each: 'each', sqft: 'sq ft', lf: 'linear ft', acre: 'acres', lb: 'lb',
  gal: 'gal', hour: 'hours', day: 'days', trip: 'trips', lump_sum: 'lump sum',
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

module.exports = { PROPOSAL_UNITS, roundDecimal, roundCents, proposalLineAmount, formatQuantity, formatUnitPrice, formatLineBasis };
