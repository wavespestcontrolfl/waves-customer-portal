'use strict';

// Shared by the proposal editor, authoritative totals, and document renderers.
// Quantities and unit rates retain four decimals; extended charges round once
// to cents. No service rates or recommended pesticide application rates live here.
const PROPOSAL_UNITS = {
  each: 'each', sqft: 'sq ft', lf: 'linear ft', acre: 'acres', lb: 'lb',
  gal: 'gal', hour: 'hours', day: 'days', trip: 'trips', lump_sum: 'lump sum',
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
const proposalLineAmount = (line) => {
  // Four-decimal inputs multiply in integer hundred-millionths of a dollar, so a
  // half-cent product cannot drift below its boundary before rounding.
  const quantity = Math.round(roundDecimal(line.quantity) * 10000);
  const price = Math.round(roundDecimal(line.unitPrice) * 10000);
  if (!Number.isFinite(quantity * price)) return 0;
  const product = BigInt(quantity) * BigInt(price);
  return Number(((product < 0n ? -product : product) + 500000n) / 1000000n) * Math.sign(Number(product)) / 100;
};
const formatQuantity = (line) => `${Number(line.quantity).toLocaleString('en-US', { maximumFractionDigits: 4 })}${PROPOSAL_UNITS[line.unit] ? ` ${PROPOSAL_UNITS[line.unit]}` : ''}`;
const formatUnitPrice = (value) => Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const formatLineBasis = (line) => `${formatQuantity(line)} × ${formatUnitPrice(line.unitPrice)}`;

module.exports = { PROPOSAL_UNITS, PROPOSAL_COUNT_UNITS, proposalLineServiceCount, roundDecimal, roundCents, proposalLineAmount, formatQuantity, formatUnitPrice, formatLineBasis };
