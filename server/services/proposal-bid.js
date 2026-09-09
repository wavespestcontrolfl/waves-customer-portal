const { PROPOSAL_UNITS, COST_CATEGORIES, roundDecimal } = require('../../shared/proposal-bid.cjs');
const { validDateOnly } = require('../utils/date-only');
const { parseETDateTime } = require('../utils/datetime-et');

const FIXED_BID_VALIDITY_ABSENT_SQL = "COALESCE(estimate_data->'proposal'->>'validThrough', '') = ''";
const dataOf = (estimate) => {
  const data = estimate?.estimate_data ?? estimate?.estimateData;
  if (typeof data === 'string') { try { return JSON.parse(data) || {}; } catch { return {}; } }
  return data || {};
};
function proposalExpiry(estimate) {
  const proposal = dataOf(estimate).proposal;
  if (proposal?.enabled !== true || !proposal.validThrough) return null;
  if (!validDateOnly(proposal.validThrough)) throw Object.assign(new Error('The proposal validity date is invalid. Review it in the proposal builder.'), { statusCode: 400 });
  return new Date(parseETDateTime(`${proposal.validThrough}T23:59:59`).getTime() + 999);
}
function hasFixedBidValidity(estimate) { return Boolean(dataOf(estimate).proposal?.validThrough); }
function assertBidSendDate(estimate, at = new Date()) {
  const expiry = proposalExpiry(estimate);
  if (expiry && expiry < at) throw Object.assign(new Error('The bid validity date has passed. Update Valid through in the proposal builder before sending.'), { statusCode: 409 });
}
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
function validateBidFields(proposal, costing) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return 'A proposal must be an object.';
  if (proposal.buildings != null && !Array.isArray(proposal.buildings)) return 'Proposal buildings must be a list.';
  if (proposal.validThrough && !validDateOnly(proposal.validThrough)) return 'Valid through must be a real calendar date (YYYY-MM-DD).';
  const seenIds = new Set();
  for (const building of proposal.buildings || []) {
    if (!building || !Array.isArray(building.lineItems || building.line_items || [])) return 'Building line items must be a list.';
    for (const line of building.lineItems || building.line_items || []) {
      if (!line || typeof line !== 'object' || Array.isArray(line)) return 'Each proposal line must be an object.';
      const rawQuantity = Object.hasOwn(line, 'quantity') ? line.quantity : 1;
      const priceKey = ['unitPrice', 'unit_price', 'price'].find((key) => Object.hasOwn(line, key));
      if (!decimalValid(rawQuantity, { min: 0.0001, max: 1000000000 })) return 'Line quantities must be positive, at most one billion, and have no more than four decimal places.';
      if (!decimalValid(priceKey ? line[priceKey] : 0)) return 'Unit prices must be nonnegative dollar amounts with no more than four decimal places.';
      if (line.unit && !Object.hasOwn(PROPOSAL_UNITS, line.unit)) return 'Choose a supported unit for each proposal line.';
      if (line.id) {
        if (typeof line.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(line.id) || seenIds.has(line.id)) return 'Proposal line identifiers must be unique. Reload the proposal and try again.';
        seenIds.add(line.id);
      }
    }
  }
  if (costing == null) return null;
  if (!Array.isArray(costing.rows) || costing.rows.length > 100) return 'Project costing supports up to 100 cost rows.';
  if (!Number.isInteger(Number(costing.revenueYears)) || Number(costing.revenueYears) < 1 || Number(costing.revenueYears) > 30) return 'Cost comparison needs a revenue period of 1–30 whole years.';
  for (const row of costing.rows) {
    if (!row || typeof row.description !== 'string' || !row.description.trim() || row.description.length > 200 || String(row.phase || '').length > 120) return 'Cost rows need a description (up to 200 characters) and a phase of up to 120 characters.';
    if (!Object.hasOwn(COST_CATEGORIES, row.category) || !Object.hasOwn(PROPOSAL_UNITS, row.unit)) return 'Choose a category and unit for each cost row.';
    if (!decimalValid(row.quantity, { min: 0.0001, max: 1000000000 }) || !decimalValid(row.unitCost)) return 'Cost quantities must be positive and unit costs nonnegative, with at most four decimal places.';
    if (!Number.isInteger(Number(row.occurrences)) || row.occurrences < 1 || row.occurrences > 1000) return 'Cost occurrences must be a whole number from 1 to 1,000.';
    if (Number(row.quantity) * Number(row.unitCost) * Number(row.occurrences) > 99999999.99) return 'Each extended project cost must be at most $99,999,999.99.';
  }
  return null;
}
function normalizeProjectCosting(raw) {
  if (!raw || !Array.isArray(raw.rows)) return null;
  return {
    revenueYears: Number(raw.revenueYears),
    rows: raw.rows.map((row) => ({
      category: row.category, phase: String(row.phase || '').trim(), description: row.description.trim(),
      quantity: roundDecimal(row.quantity), unit: row.unit, unitCost: roundDecimal(row.unitCost), occurrences: Number(row.occurrences),
    })),
  };
}
module.exports = { proposalExpiry, hasFixedBidValidity, assertBidSendDate, FIXED_BID_VALIDITY_ABSENT_SQL, validateBidFields, normalizeProjectCosting };
