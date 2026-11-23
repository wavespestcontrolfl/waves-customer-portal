'use strict';
// Upcoming visits whose invoice would leave out the WaveGuard tier saving their estimate priced.
//
// Owner 2026-11-22: GATE_INVOICE_ESTIMATE_DISCOUNT_LINES went on, and the owner opened two customers' invoices to see
// the new lines. None printed: 0 of 163 upcoming estimate-booked visits named the WaveGuard tier, because the invoice
// code read the tier from the service row and saved engine estimates keep it on the estimate's recurring block (#8329,
// #8343; fixed in #8355). The owner found it himself. This detector finds that kind of miss without him: an upcoming
// visit whose invoice keeps its saving unnamed (completion-pricing.js acceptedVisitBreakdown: reason discount_unnamed,
// or lines with no WaveGuard row), while the invoice's own pricing of the line it matched names the tier once it is
// given the tier the estimate's own engine line recorded.
//
// The witness is the engine's record: the tier and the rate it applied to that line, which the estimate's other records
// must not contradict. It never comes from the invoice's own tier reading (savedEstimateTier), where the miss was. The
// line is then priced by the invoice's own pure pricing (acceptedPricing), in the invoice's own discount context with
// only that tier reading replaced, so every row rule that keeps one line on purpose (a service credit, a floor, a staff
// change to the row, a row's own net, rate or flags, a service the tier percentage skips) stays that code's rule. The
// two estimate rules of that tier reading that name no tier by design (a staff discount on recurring work, the legacy
// nested block) are read here: the first with the invoice's own reader, the second with its one-line read. A visit whose
// invoice keeps one line for another reason (no price of its own, its own price or discount, add-ons, prepaid, no
// single matched line, a price that moved after acceptance, no saving on the line) is not read. Off gate = one line by
// design: no finding.
//
// Read-only: no write, no customer contact, no paid call. The lead-to-cash sweep (lead-to-cash-invariants.js) runs it
// once a day. ops/agents/estimate-discount-lines-report.js reads the same visits (upcomingEstimateVisits).

const LIVE_VISIT_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'];
const DISCOUNTED_TIERS = ['silver', 'gold', 'platinum'];
const LOOK_AHEAD_DAYS = 90;

const parsed = (value) => {
  if (value && typeof value === 'object') return value;
  try { return value ? JSON.parse(value) : {}; } catch { return {}; }
};
const object = (value) => (value && typeof value === 'object' ? value : {});
const list = (value) => (Array.isArray(value) ? value : []);
const word = (value) => String(value || '').trim().toLowerCase();

// Every upcoming live visit (today in Eastern time through `days` ahead, callbacks left out) of a live customer that
// traces to an estimate: its own source_estimate_id or its series parent's.
function upcomingEstimateVisits(conn, { today, days }) {
  return conn('scheduled_services as s')
    .join('customers as c', 'c.id', 's.customer_id')
    .leftJoin('scheduled_services as p', 'p.id', 's.recurring_parent_id')
    // whereLiveCustomer (services/customer-stages.js), alias-qualified.
    .where('c.active', true).whereNull('c.deleted_at').whereIn('c.pipeline_stage', ['active_customer', 'won', 'at_risk'])
    .whereIn('s.status', LIVE_VISIT_STATUSES)
    .whereRaw('s.scheduled_date >= ?::date AND s.scheduled_date < ?::date + ?::int', [today, today, days])
    .whereRaw('COALESCE(s.is_callback, false) = false')
    .whereRaw('COALESCE(s.source_estimate_id, p.source_estimate_id) IS NOT NULL')
    .orderBy([{ column: 's.scheduled_date' }, { column: 's.id' }])
    .select('s.*');
}

// The saved result the estimate's lines come from (estimate-public.js acceptanceServiceLists: result, else engineResult)
// with its recurring block, and the engine's line items for that result: its own when the engine result was saved whole,
// else the engine result saved beside the mapped one.
function pricingRecords(data) {
  const source = object(data.result || data.engineResult || data);
  const lineItems = Array.isArray(source.lineItems) ? source.lineItems : list(object(data.engineResult).lineItems);
  return { block: object(source.recurring), lineItems: lineItems.filter((item) => item && typeof item === 'object') };
}

// The tier and rate the engine applied to one service of the estimate: exactly one engine line of that service becomes a
// recurring row on its own (estimate-public.js recurringServicesWithSupplements; a one-time line such as a plan's
// first-visit fee does not), and its only discount is the WaveGuard tier, at one rate. Else null.
function engineTierRecord(lineItems, serviceKey) {
  const { recurringServiceKey, recurringServicesWithSupplements } = require('../routes/estimate-public');
  const items = lineItems.filter((item) => recurringServiceKey(item) === serviceKey
    && recurringServicesWithSupplements({ lineItems: [item] }).length > 0);
  if (items.length !== 1) return null;
  const priced = list(items[0].discount?.appliedDiscounts).filter((d) => Number(d?.amount) > 0);
  const [rate, ...otherRates] = [...new Set(priced.map((d) => Number(d.amount)))];
  if (otherRates.length || !(rate > 0 && rate <= 1) || priced.some((d) => d.type !== 'waveguard')) return null;
  // The engine names the tier on the applied discount (discount-engine.js getEffectiveDiscount).
  return { rate, tier: word(priced[0].tier) };
}

// The tier the estimate's records name for its recurring work, when they agree with the engine's line: the column and
// the saved recurring block name no other tier (an empty column falls back to the block, as completion-pricing.js
// savedEstimateTier does), and the rate the estimate saved for it is the engine line's rate. That rate is the one the
// invoice reads (savedEstimateTier): the send snapshot's, else the rate of a block that names the tier. A saved 0 is a
// rate; an estimate that saved none leaves the engine's. Records that disagree name no saving: the invoice keeps one
// line by design. Null unless Silver, Gold or Platinum.
function recordsTier(estimate, data, block, record) {
  const blockTier = word(block.waveGuardTier || block.tier);
  const words = [record.tier, word(estimate.waveguard_tier), blockTier].filter(Boolean);
  const [tier] = words;
  if (!DISCOUNTED_TIERS.includes(tier) || words.some((w) => w !== tier)) return null;
  const { snapshotTierDiscount } = require('../routes/estimate-public');
  const blockRate = blockTier && block.discount != null && block.discount !== '' ? Number(block.discount) : null;
  const saved = snapshotTierDiscount(data, `${tier[0].toUpperCase()}${tier.slice(1)}`) ?? blockRate;
  return saved === null || Math.abs(saved - record.rate) <= 1e-9 ? tier : null;
}

const printsTier = (breakdown) => list(breakdown?.discounts).some((row) => /^WaveGuard\b/.test(String(row.name || '')));

// One visit: a finding { visitId, estimateId, serviceKey, tier } or null.
async function visitFinding(conn, visit) {
  const { acceptedVisitBreakdown, acceptedPricing, estimateDiscountContext, staffDiscountOnRecurring } = require('./completion-pricing');
  const { breakdown, reason, estimate, line } = await acceptedVisitBreakdown(visit, { database: conn });
  if (breakdown ? printsTier(breakdown) : reason !== 'discount_unnamed') return null;
  const row = object(line?.sourceLine);
  // The service of the saved row the invoice matched: the row's own, else the key the schedule matched it to (as the
  // invoice reads it, completion-pricing.js namingTier). Never the visit's label.
  const serviceKey = line ? require('../routes/estimate-public').recurringServiceKey({ ...row, service: row.service || line.serviceKey || undefined }) : null;
  if (!estimate || !serviceKey) return null;
  const data = parsed(estimate.estimate_data);
  const { block, lineItems } = pricingRecords(data);
  // The invoice names no tier by design (completion-pricing.js estimateDiscountContext, savedEstimateTier) when a staff
  // discount reaches recurring work in any saved shape, or when the legacy nested block also supplies service rows.
  const nested = object(object(object(data.result || data).results).recurring);
  if (staffDiscountOnRecurring(data, block) || list(nested.services).length) return null;
  const record = engineTierRecord(lineItems, serviceKey);
  const tier = record ? recordsTier(estimate, data, block, record) : null;
  if (!tier) return null;
  // The invoice's own pricing of the matched line, in the invoice's own discount context, with only its tier reading
  // (savedEstimateTier) replaced by the engine's tier at the engine's rate.
  const context = estimateDiscountContext({ ...estimate, estimate_data: data });
  const quote = acceptedPricing(line, { ...context, estimateTier: { tier, amount: record.rate } });
  const named = quote.discounts.length > 0 && quote.discounts.every((d) => d.named) && printsTier(quote);
  return named ? { visitId: String(visit.id), estimateId: String(estimate.id), serviceKey, tier } : null;
}

/**
 * The upcoming visits (today through `days` ahead, Eastern) whose invoice would leave out the WaveGuard tier saving
 * their estimate priced. Returns { checked, findings: [{ visitId, estimateId, serviceKey, tier }] }. A visit that cannot
 * be read throws: a check that did not run proves nothing.
 */
async function tierSavingsLeftOffInvoices(conn, { today, days = LOOK_AHEAD_DAYS } = {}) {
  if (!require('../config/feature-gates').invoiceEstimateDiscountLinesLive()) return { checked: 0, findings: [] };
  const visits = await upcomingEstimateVisits(conn, { today, days });
  const findings = [];
  for (const visit of visits) {
    const finding = await visitFinding(conn, visit);
    if (finding) findings.push(finding);
  }
  return { checked: visits.length, findings };
}

module.exports = { tierSavingsLeftOffInvoices, upcomingEstimateVisits, LIVE_VISIT_STATUSES, _private: { engineTierRecord, pricingRecords, visitFinding } };
