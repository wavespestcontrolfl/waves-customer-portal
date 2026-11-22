'use strict';
// Upcoming visits whose invoice would leave out the WaveGuard tier saving their estimate priced.
//
// Owner 2026-11-22: GATE_INVOICE_ESTIMATE_DISCOUNT_LINES went on, and the owner opened two customers' invoices to see
// the new lines. None printed: 0 of 163 upcoming estimate-booked visits named the WaveGuard tier, because the invoice
// code read the tier from the service row and saved engine estimates keep it on the estimate's recurring block (#8329,
// #8343; fixed in #8355). The owner found it himself. This detector finds that kind of miss without him: an upcoming
// visit whose invoice keeps its saving unnamed (completion-pricing.js acceptedVisitBreakdown: reason discount_unnamed,
// or lines with no WaveGuard row) while the estimate's own engine line item for that service recorded the WaveGuard
// tier as its only discount, and the visit's saving is that tier's rate on the line's list price.
//
// The witness is the engine's record, not the naming code it checks. A staff discount or a service credit beside the
// tier makes the saving larger than the tier's share, so such a line (one line by design) is not a finding. A visit
// whose invoice keeps one line for another reason (no price of its own, its own price or discount, add-ons, prepaid,
// a price that moved after acceptance, no saving on the line) is not read. Off gate = one line by design: no finding.
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

// The engine's record for one service of the estimate: its per-visit list price and the WaveGuard rate it applied, only
// when exactly one engine line item is that service and the tier is its only discount (one rate). Else null.
function engineTierRecord(data, serviceKey) {
  const { recurringServiceKey } = require('../routes/estimate-public');
  const items = (Array.isArray(data?.engineResult?.lineItems) ? data.engineResult.lineItems : [])
    .filter((item) => item && typeof item === 'object' && recurringServiceKey(item) === serviceKey);
  if (items.length !== 1) return null;
  const [item] = items;
  const applied = Array.isArray(item.discount?.appliedDiscounts) ? item.discount.appliedDiscounts : [];
  const priced = applied.filter((d) => Number(d?.amount) > 0);
  const rates = [...new Set(priced.map((d) => Number(d.amount)))];
  if (!priced.length || priced.some((d) => d.type !== 'waveguard') || rates.length !== 1 || !(rates[0] <= 1)) return null;
  const visits = [item.visitsPerYear, item.visits, item.frequency, item.appsPerYear].map(Number).find((n) => n > 0);
  const tiers = Array.isArray(item.tiers) ? item.tiers : [];
  const selected = [item.selected, ...tiers.filter((t) => t && (t.selected === true || t.isSelected === true))]
    .find((t) => t && cents(t.perApp) > 0);
  const listCents = cents(selected?.perApp) ?? cents(item.perApp ?? item.perVisit)
    ?? (visits && cents(item.annualBeforeDiscount) ? Math.round(cents(item.annualBeforeDiscount) / visits) : null);
  return listCents > 0 ? { rate: rates[0], listCents } : null;
}

async function estimateFor(conn, visit, cache) {
  let id = visit.source_estimate_id;
  if (!id && visit.recurring_parent_id) {
    const parent = await conn('scheduled_services').where({ id: visit.recurring_parent_id }).first('source_estimate_id');
    id = parent?.source_estimate_id;
  }
  if (!id) return null;
  if (!cache.has(String(id))) cache.set(String(id), await conn('estimates').where({ id }).first('id', 'waveguard_tier', 'estimate_data'));
  return cache.get(String(id)) || null;
}

const printsTier = (breakdown) => breakdown.discounts.some((row) => /^WaveGuard\b/.test(String(row.name || '')));

// One visit: a finding { visitId, estimateId, serviceKey, tier } or null.
async function visitFinding(conn, visit, cache) {
  const { acceptedVisitBreakdown } = require('./completion-pricing');
  const { breakdown, reason } = await acceptedVisitBreakdown(visit, { database: conn });
  if (breakdown ? printsTier(breakdown) : reason !== 'discount_unnamed') return null;
  const estimate = await estimateFor(conn, visit, cache);
  const tier = String(estimate?.waveguard_tier || '').trim().toLowerCase();
  if (!DISCOUNTED_TIERS.includes(tier)) return null;
  const { recurringServiceKey } = require('../routes/estimate-public');
  const serviceKey = recurringServiceKey({ name: visit.service_type });
  const record = engineTierRecord(parsed(estimate.estimate_data), serviceKey);
  // For discount_unnamed the visit bills the accepted per-visit price (acceptedVisitBreakdown checks it first).
  const amountCents = cents(breakdown ? breakdown.amount : visit.estimated_price);
  if (!record || amountCents === null) return null;
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
  const cache = new Map();
  const findings = [];
  for (const visit of visits) {
    const finding = await visitFinding(conn, visit, cache);
    if (finding) findings.push(finding);
  }
  return { checked: visits.length, findings };
}

module.exports = { tierSavingsLeftOffInvoices, upcomingEstimateVisits, LIVE_VISIT_STATUSES, _private: { engineTierRecord, visitFinding } };
