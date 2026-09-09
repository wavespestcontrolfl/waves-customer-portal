const { PROPOSAL_UNITS } = require('../../shared/proposal-bid.cjs');
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
  return Number.isFinite(n) && n >= min && n <= max && Math.abs(n * 10000 - Math.round(n * 10000)) < 0.001;
}
function validateBidFields(proposal) {
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
  return null;
}
module.exports = { proposalExpiry, hasFixedBidValidity, assertBidSendDate, FIXED_BID_VALIDITY_ABSENT_SQL, validateBidFields };
