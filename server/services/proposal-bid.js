const { PROPOSAL_UNITS, roundDecimal } = require('../../shared/proposal-bid.cjs');
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
function validateBidFields(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return 'A proposal must be an object.';
  if (proposal.buildings != null && !Array.isArray(proposal.buildings)) return 'Proposal buildings must be a list.';
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
module.exports = { validateBidFields };
