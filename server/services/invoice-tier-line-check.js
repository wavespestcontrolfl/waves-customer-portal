'use strict';
// Upcoming visits whose invoice would leave out the WaveGuard tier saving their estimate priced.
//
// Owner 2026-11-22: GATE_INVOICE_ESTIMATE_DISCOUNT_LINES went on, and the owner opened two customers' invoices to see
// the new lines. None printed: 0 of 163 upcoming estimate-booked visits named the WaveGuard tier, because the invoice
// code read the tier from the service row and saved engine estimates keep it on the estimate's recurring block (#8329,
// #8343; fixed in #8355). The owner found it himself. This detector finds that kind of miss without him: an upcoming
// visit whose invoice keeps its saving unnamed (completion-pricing.js acceptedVisitBreakdown: reason discount_unnamed,
// or lines with no WaveGuard row) while the estimate's own engine line item for the line the invoice matched priced it
// at exactly the WaveGuard tier's rate, and the visit's saving is that rate on the line's list price.
//
// The witness is the engine's record, not the naming code it checks. A staff discount on the estimate's recurring work,
// a service credit, or a floor that moved the line's price is not the tier alone, so such a line (one line by design)
// is not a finding. Nor is a line the invoice leaves unnamed on purpose: a row kept out of percentage discounts, a
// service the tier percentage skips, a row that recorded another rate, records that name another tier or rate, or a
// legacy nested block. A visit whose invoice keeps one line for another reason (no price of its own, its own price or
// discount, add-ons, prepaid, a price that moved after acceptance, no saving on the line) is not read. Off gate = one
// line by design: no finding.
//
// Read-only: no write, no customer contact, no paid call. The lead-to-cash sweep (lead-to-cash-invariants.js) runs it
// once a day. ops/agents/estimate-discount-lines-report.js reads the same visits (upcomingEstimateVisits).

const LIVE_VISIT_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'];
const DISCOUNTED_TIERS = ['silver', 'gold', 'platinum'];
// The engine discounts the annual, so a tier-only saving can sit a few cents off rate x list price per visit
// (completion-pricing.js TIER_ROUNDING_CENTS).
const ROUNDING_CENTS = 5;
const LOOK_AHEAD_DAYS = 90;

const cents = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
  ? null : Math.round(Number(value) * 100));
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

// Whether an engine line is the pricing revision of the saved row the invoice matched: the row's per-visit list price
// (the base the invoice reads, completion-pricing.js acceptedPricing) is the line's, and so is each annual the row took
// from it (v1-legacy-mapper.js svcAdd). A reprice that replaced the row and kept an older engine result leaves them apart.
function sameRevision(row, item, listCents) {
  const base = [row.perTreatment, row.perApp, row.perVisit].map(cents).find((c) => c !== null);
  return (base === undefined || base === listCents) && [[row.annualAfterDiscount, item.annualAfterDiscount],
    [row.manualFinalAnnual, item.manualFinalAnnual]].every(([saved, engine]) => cents(saved) === null || cents(saved) === cents(engine));
}

// Whether the saved row takes the tier's percentage at the engine line's rate. The invoice names a tier the row does not
// carry only then (completion-pricing.js namingTier): no flag keeps percentage discounts off the row; its service takes
// the tier percentage (the eligibility the row saved wins over today's configuration); and no rate the row recorded for
// itself (the legacy mapper writes one on lawn rows) is another rate.
function rowTakesTierRate(row, serviceKey, rate) {
  const { lineFlagsBlockPercentDiscount } = require('./pricing-engine/discount-engine');
  const { recurringServiceReceivesTierDiscount } = require('../routes/estimate-public');
  const discount = object(row.discount);
  return !lineFlagsBlockPercentDiscount(row)
    && (row.waveGuardDiscountEligible === true || recurringServiceReceivesTierDiscount({ ...row, service: row.service || serviceKey }))
    && [discount.appliedDiscountPercent, discount.effectiveDiscount].every((recorded) => recorded == null || Number(recorded) === rate);
}

// The engine's record for the saved row the invoice matched: its per-visit list price, the WaveGuard rate it applied and
// the tier it named. Only when the engine priced that line at exactly the tier's rate off its list: exactly one
// recurring engine line is that service (a one-time line, such as a plan's first-visit fee, has no annual); it is the
// row's pricing revision; the tier is its only discount, at one rate, and the row takes that rate; no service credit
// shares the saving (serviceSpecificDiscounts, on the row or the line); its own annuals are that rate apart (no lawn
// floor or other guard moved the price); and no engine line carries manualFinalAnnual (a staff discount reached
// recurring work). Else null.
function engineTierRecord(lineItems, row, serviceKey) {
  const { recurringServiceKey } = require('../routes/estimate-public');
  if (lineItems.some((item) => cents(item.manualFinalAnnual) !== null)) return null;
  const items = lineItems.filter((item) => cents(item.annualBeforeDiscount) > 0 && recurringServiceKey(item) === serviceKey);
  if (items.length !== 1) return null;
  const [item] = items;
  const priced = list(item.discount?.appliedDiscounts).filter((d) => Number(d?.amount) > 0);
  const [rate, ...otherRates] = [...new Set(priced.map((d) => Number(d.amount)))];
  if (otherRates.length || !(rate <= 1) || priced.some((d) => d.type !== 'waveguard') || !rowTakesTierRate(row, serviceKey, rate)) return null;
  const credited = [row, item].some((r) => list(r.serviceSpecificDiscounts).some((credit) => Number(credit?.amount) > 0));
  const before = cents(item.annualBeforeDiscount);
  const after = cents(item.annualAfterDiscount);
  if (credited || after === null || Math.abs(after - Math.round(before * (1 - rate))) > 1) return null;
  const visits = [item.visitsPerYear, item.visits, item.frequency, item.appsPerYear].map(Number).find((n) => n > 0);
  // The line's own per-visit price (the one the saved row copies; the engine keeps it equal to the selected program's),
  // else its list annual over its visits (no visit count: NaN, skipped).
  const listCents = [cents(item.perApp), cents(item.perVisit), Math.round(before / visits)].find((c) => c > 0);
  // The engine names the tier on the applied discount (discount-engine.js getEffectiveDiscount).
  return listCents && sameRevision(row, item, listCents) ? { rate, listCents, tier: word(priced[0].tier) } : null;
}

// The tier the estimate's records name for its recurring work, when they agree with the engine's line: the column and
// the saved recurring block name no other tier (an empty column falls back to the block, as completion-pricing.js
// savedEstimateTier does), and no rate the estimate saved for it (the send snapshot, the block's) is another rate.
// Records that disagree name no saving: the invoice keeps one line by design. Null unless Silver, Gold or Platinum.
function recordsTier(estimate, data, block, record) {
  const words = [record.tier, estimate.waveguard_tier, block.waveGuardTier || block.tier].map(word).filter(Boolean);
  const [tier] = words;
  if (!DISCOUNTED_TIERS.includes(tier) || words.some((w) => w !== tier)) return null;
  const { tierDiscountForEstimate } = require('../routes/estimate-public');
  // Fallback 0: the snapshot's rate or none, never today's tier table.
  const savedRates = [tierDiscountForEstimate(data, `${tier[0].toUpperCase()}${tier.slice(1)}`, 0), Number(block.discount)];
  return savedRates.some((rate) => rate > 0 && Math.abs(rate - record.rate) > 1e-9) ? null : tier;
}

const printsTier = (breakdown) => breakdown.discounts.some((row) => /^WaveGuard\b/.test(String(row.name || '')));

// One visit: a finding { visitId, estimateId, serviceKey, tier } or null.
async function visitFinding(conn, visit) {
  const { acceptedVisitBreakdown, staffDiscountOnRecurring } = require('./completion-pricing');
  const { breakdown, reason, estimate, line } = await acceptedVisitBreakdown(visit, { database: conn });
  if (breakdown ? printsTier(breakdown) : reason !== 'discount_unnamed') return null;
  // The service of the saved row the invoice matched the visit to (by service id or key, never by the visit's label).
  const serviceKey = line ? require('../routes/estimate-public').recurringServiceKey(line) : null;
  if (!estimate || !serviceKey) return null;
  const data = parsed(estimate.estimate_data);
  const { block, lineItems } = pricingRecords(data);
  // The invoice infers no tier, by design (completion-pricing.js estimateDiscountContext, savedEstimateTier), when a staff
  // discount reaches recurring work in any saved shape (it shares each line's saving), and when the legacy nested block
  // (result.results.recurring) also supplies service rows (which block priced a line is then unknown).
  const nested = object(object(object(data.result || data).results).recurring);
  if (staffDiscountOnRecurring(data, block) || list(nested.services).length) return null;
  const record = engineTierRecord(lineItems, line, serviceKey);
  const tier = record ? recordsTier(estimate, data, block, record) : null;
  // For discount_unnamed the visit bills the accepted per-visit price (acceptedVisitBreakdown checks it first).
  const amountCents = cents(breakdown ? breakdown.amount : visit.estimated_price);
  if (!tier || amountCents === null) return null;
  const savingCents = record.listCents - amountCents;
  const tierCents = Math.round(record.listCents * record.rate);
  if (!(savingCents > 0) || Math.abs(savingCents - tierCents) > ROUNDING_CENTS) return null;
  return { visitId: String(visit.id), estimateId: String(estimate.id), serviceKey, tier };
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
