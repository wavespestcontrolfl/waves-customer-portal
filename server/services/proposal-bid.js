const { PROPOSAL_UNITS, roundDecimal } = require('../../shared/proposal-bid.cjs');
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
// Group-link viewability. Two concepts, two storage locations (owner ruling
// 2026-09-11 on #4309 round 7): `estimates.expires_at` is ALWAYS this row's
// own offer deadline and is never widened by a sibling, while the window
// during which the delivered group entry link keeps resolving lives here, in
// `estimate_data.groupLinkViewableThrough`, on the anchor whose token went out.
//
// This is navigation state ONLY. It exists because the delivered link is the
// anchor's token: an ordinary anchor's offer ends after its seven-day window,
// and without a separate window the customer could no longer REACH a fixed
// sibling valid for months — the fixed property would "drop out early", which
// docs/commercial-bid-builder.md forbids.
//
// Nothing actionable may read it. Acceptance, voice quoting, reminder
// eligibility, reminder copy, the CTA and every displayed deadline read
// `expires_at`, which now already carries the right meaning. That is why the
// old `publicExpiresAt` narrowing helper is gone: it existed only to undo the
// widening, and it could not undo it for an ordinary row at all, because such
// a row has no authored date to recover.
function groupLinkViewableThrough(estimate) {
  const at = dataOf(estimate).groupLinkViewableThrough;
  if (!at) return null;
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
// True while the delivered group link should still resolve even though this
// row's own offer has already expired.
function groupLinkStillViewable(estimate, at = new Date()) {
  const until = groupLinkViewableThrough(estimate);
  return Boolean(until && until >= at);
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
module.exports = { proposalExpiry, groupLinkViewableThrough, groupLinkStillViewable, hasFixedBidValidity, assertBidSendDate, assertBidScheduleDate, earliestScheduledDelivery, latestReachableSchedule, SCHEDULED_SEND_TICK_MS, FIXED_BID_VALIDITY_ABSENT_SQL, validateBidFields };
