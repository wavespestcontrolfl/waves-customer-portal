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
// is not a finding. A visit whose invoice keeps one line for another reason (no price of its own, its own price or
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

// The engine's record for one service of the estimate: its per-visit list price, the WaveGuard rate it applied and the
// tier it named. Only when the engine priced that line at exactly the tier's rate off its list: exactly one engine line
// item is that service; the tier is its only discount, at one rate; no service credit shares the saving
// (serviceSpecificDiscounts); its own annuals are that rate apart (no lawn floor or other guard moved the price); and no
// staff discount reached the estimate's recurring work (the engine then stamps manualFinalAnnual on each line it can
// reach, and completion-pricing.js infers no tier from the estimate). Else null.
function engineTierRecord(data, serviceKey) {
  const { recurringServiceKey } = require('../routes/estimate-public');
  const lineItems = list(data?.engineResult?.lineItems).filter((item) => item && typeof item === 'object');
  if (!serviceKey || lineItems.some((item) => cents(item.manualFinalAnnual) !== null)) return null;
  const items = lineItems.filter((item) => recurringServiceKey(item) === serviceKey);
  if (items.length !== 1) return null;
  const [item] = items;
  const priced = list(item.discount?.appliedDiscounts).filter((d) => Number(d?.amount) > 0);
  const [rate, ...otherRates] = [...new Set(priced.map((d) => Number(d.amount)))];
  if (otherRates.length || !(rate <= 1) || priced.some((d) => d.type !== 'waveguard')) return null;
  const credited = list(item.serviceSpecificDiscounts).some((credit) => Number(credit?.amount) > 0);
  const before = cents(item.annualBeforeDiscount);
  const after = cents(item.annualAfterDiscount);
  if (credited || before === null || after === null || Math.abs(after - Math.round(before * (1 - rate))) > 1) return null;
  const visits = [item.visitsPerYear, item.visits, item.frequency, item.appsPerYear].map(Number).find((n) => n > 0);
  const selected = [item.selected, ...list(item.tiers).filter((t) => t && (t.selected === true || t.isSelected === true))]
    .find((t) => t && cents(t.perApp) > 0);
  // The selected frequency's price, else the item's own, else its list annual over its visits (none: NaN, skipped).
  const listCents = [cents(selected?.perApp), cents(item.perApp), cents(item.perVisit), Math.round(before / visits)].find((c) => c > 0);
  // The engine names the tier on the applied discount (discount-engine.js getEffectiveDiscount).
  return listCents ? { rate, listCents, tier: word(priced[0].tier) } : null;
}

// The tier the estimate's records name for its recurring work: the engine record's, the estimate's column and its saved
// recurring block's (the two completion-pricing.js savedEstimateTier reads; an empty column falls back to the block).
// Records that name different tiers name none: the invoice cannot name a saving from them, by design. Null unless
// Silver, Gold or Platinum.
function recordsTier(estimate, data, engineTier) {
  const block = object(object(data.result || data.engineResult || data).recurring);
  const words = [engineTier, estimate.waveguard_tier, block.waveGuardTier || block.tier].map(word).filter(Boolean);
  return words.length && words.every((w) => w === words[0]) && DISCOUNTED_TIERS.includes(words[0]) ? words[0] : null;
}

const printsTier = (breakdown) => breakdown.discounts.some((row) => /^WaveGuard\b/.test(String(row.name || '')));

// One visit: a finding { visitId, estimateId, serviceKey, tier } or null.
async function visitFinding(conn, visit) {
  const { acceptedVisitBreakdown } = require('./completion-pricing');
  const { breakdown, reason, estimate, line } = await acceptedVisitBreakdown(visit, { database: conn });
  if (breakdown ? printsTier(breakdown) : reason !== 'discount_unnamed') return null;
  // The service of the saved row the invoice matched the visit to (by service id or key, never by the visit's label).
  const serviceKey = line ? require('../routes/estimate-public').recurringServiceKey(line) : null;
  if (!estimate || !serviceKey) return null;
  const data = parsed(estimate.estimate_data);
  const record = engineTierRecord(data, serviceKey);
  const tier = record ? recordsTier(estimate, data, record.tier) : null;
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

module.exports = { tierSavingsLeftOffInvoices, upcomingEstimateVisits, LIVE_VISIT_STATUSES, _private: { engineTierRecord, visitFinding } };
