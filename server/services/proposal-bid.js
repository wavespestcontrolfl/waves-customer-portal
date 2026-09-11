const { PROPOSAL_UNITS, roundDecimal, decimalValid, costRowIssue, COST_ROW_LIMITS } = require('../../shared/proposal-bid.cjs');
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
// The date a customer is SHOWN as the estimate's expiration. A grouped
// anchor's expires_at may be widened to a sibling's later fixed hold so the
// delivered entry link stays viewable, but this property's own bid is only
// honored through its authored validThrough (manual acceptance enforces
// exactly that), so the public renderers show the earlier of the two
// (GH codex P1 r3 on #4309). Access itself still keys off expires_at.
function publicExpiresAt(estimate) {
  const shown = estimate?.expires_at ?? null;
  const authored = proposalExpiry(estimate);
  if (!authored) return shown;
  if (!shown) return authored;
  return authored < new Date(shown) ? authored : shown;
}
function hasFixedBidValidity(estimate) { return Boolean(dataOf(estimate).proposal?.validThrough); }
function assertBidSendDate(estimate, at = new Date()) {
  const expiry = proposalExpiry(estimate);
  if (expiry && expiry < at) throw Object.assign(new Error('The bid validity date has passed. Update Valid through in the proposal builder before sending.'), { statusCode: 409 });
}
// The scheduled-send worker claims due rows on five-minute wall-clock ticks
// (scheduler.js `*/5 * * * *`), so a 23:58 ET schedule is first claimed at
// 00:00 — after a fixed bid's day has ended, when the delivery-time check
// refuses it and nobody is sent anything. Scheduling therefore validates the
// earliest moment the worker can actually deliver (GH codex P2 on #4309).
const SCHEDULED_SEND_TICK_MS = 5 * 60 * 1000;
function earliestScheduledDelivery(scheduledTime, tickMs = SCHEDULED_SEND_TICK_MS) {
  return new Date(Math.ceil(new Date(scheduledTime).getTime() / tickMs) * tickMs);
}
// The latest scheduled_at whose first reachable tick still falls inside a
// hold: a pending send later than this cannot deliver before the day ends.
function latestReachableSchedule(expiry, tickMs = SCHEDULED_SEND_TICK_MS) {
  return new Date(Math.floor(new Date(expiry).getTime() / tickMs) * tickMs);
}
function assertBidScheduleDate(estimate, scheduledTime) {
  const expiry = proposalExpiry(estimate);
  if (!expiry) return;
  assertBidSendDate(estimate, scheduledTime);
  if (expiry < earliestScheduledDelivery(scheduledTime)) throw Object.assign(new Error('The scheduled time is too close to the end of the bid validity day; scheduled sends run every five minutes. Choose an earlier time or update Valid through in the proposal builder.'), { statusCode: 409 });
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
  if (!Array.isArray(costing.rows) || costing.rows.length > COST_ROW_LIMITS.rowsMax) return 'Project costing supports up to 100 cost rows.';
  if (!Number.isInteger(Number(costing.revenueYears)) || Number(costing.revenueYears) < 1 || Number(costing.revenueYears) > 30) return 'Cost comparison needs a revenue period of 1–30 whole years.';
  for (const row of costing.rows) {
    const issue = costRowIssue(row);
    if (issue) return issue;
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
module.exports = { proposalExpiry, publicExpiresAt, hasFixedBidValidity, assertBidSendDate, assertBidScheduleDate, earliestScheduledDelivery, latestReachableSchedule, SCHEDULED_SEND_TICK_MS, FIXED_BID_VALIDITY_ABSENT_SQL, validateBidFields, normalizeProjectCosting };
