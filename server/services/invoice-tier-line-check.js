'use strict';
// Upcoming visits whose invoice would not print their estimate's WaveGuard tier line: the saving left unnamed, or a
// WaveGuard line that does not name the tier.
//
// Owner 2026-11-22: GATE_INVOICE_ESTIMATE_DISCOUNT_LINES went on, and the owner opened two customers' invoices to see
// the new lines. None printed: 0 of 163 upcoming estimate-booked visits named the WaveGuard tier, because the invoice
// code read the tier from the service row and saved engine estimates keep it on the estimate's recurring block (#8329,
// #8343; fixed in #8355). The owner found it himself. This detector finds that kind of miss without him. It asks the
// invoice's own decision (completion-pricing.js acceptedVisitBreakdown) about each upcoming visit, then one of three
// questions:
// - The invoice prints the line's discounts, and the line's saving has a tier share (pricedTierRow): does the printed
//   tier row name the tier the estimate's records agree on (printedLabelMiss)? A row whose own tier record names no
//   tier prints a bare "WaveGuard". Reading a label needs no rate. The tier names are written out here
//   (TIER_LINE_NAMES), so a fault in the invoice's own label code cannot pass its own output.
// - The invoice keeps the saving unnamed (reason discount_unnamed, or a breakdown with no tier share): would its own pricing
//   of the matched line name the tier, if its tier reading had found what the estimate's records hold
//   (unnamedSavingMiss)? The witness is the engine's record: the tier and the rate it applied to that line, which the
//   estimate's other records must not contradict. An estimate saved with no engine lines (the admin estimate tool's
//   mapped result) has only its saved tier and rate, so those are read here on their own. The witness never comes from
//   the invoice's own tier reading (savedEstimateTier), where the miss was. The line is then priced by the invoice's own
//   pure pricing (acceptedPricing), in the invoice's own discount context with only that tier reading replaced, so every
//   row rule that keeps one line on purpose (a service credit, a floor, a staff change to the row, a row's own net, rate
//   or flags, a service the tier percentage skips) stays that code's rule. The two estimate rules of that tier reading
//   that name no tier by design (a staff discount on recurring work, the legacy nested block) are read here: the first
//   with the invoice's own reader, the second with its one-line read.
// - The invoice cannot price the matched line (reason no_breakdown) because the reader gave it no per-visit price: an
//   engine result saved whole keeps a rated line's net only as `annual` (unpricedLineMiss). The engine's own record of
//   the line holds that net. Priced by the reader's own per-application derivation, it must be the visit's own price;
//   the line is then priced at it and asked the second question.
// A visit whose invoice keeps one line for another reason (no price of its own, its own price or discount, add-ons,
// prepaid, no single matched line, a price that moved after acceptance, no saving on the line) is not read. Off gate =
// one line by design: no finding.
//
// Read-only: no write, no customer contact, no paid call. The lead-to-cash sweep (lead-to-cash-invariants.js) runs it
// once a day. ops/agents/estimate-discount-lines-report.js reads the same visits (upcomingEstimateVisits).

const LIVE_VISIT_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'];
const DISCOUNTED_TIERS = ['silver', 'gold', 'platinum'];
// The tier line names an invoice prints (owner 2026-11-22), written out here and not read from the invoice's own label
// code (completion-pricing.js waveGuardTierName): a fault there would print and expect the same wrong name (pre-push
// audit).
const TIER_LINE_NAMES = { silver: 'WaveGuard Silver', gold: 'WaveGuard Gold', platinum: 'WaveGuard Platinum' };
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

// The engine's recurring lines of one service: each becomes a recurring row on its own (estimate-public.js
// recurringServicesWithSupplements; a one-time line such as a plan's first-visit fee does not).
function serviceEngineLines(lineItems, serviceKey) {
  const { recurringServiceKey, recurringServicesWithSupplements } = require('../routes/estimate-public');
  return lineItems.filter((item) => recurringServiceKey(item) === serviceKey && recurringServicesWithSupplements({ lineItems: [item] }).length > 0);
}

// The tier and rate the engine applied to one service of the estimate: exactly one recurring engine line of that
// service, whose only discount is the WaveGuard tier, at one rate. Else null.
function engineTierRecord(lineItems, serviceKey) {
  const items = serviceEngineLines(lineItems, serviceKey);
  if (items.length !== 1) return null;
  const priced = list(items[0].discount?.appliedDiscounts).filter((d) => Number(d?.amount) > 0);
  const [rate, ...otherRates] = [...new Set(priced.map((d) => Number(d.amount)))];
  if (otherRates.length || !(rate > 0 && rate <= 1) || priced.some((d) => d.type !== 'waveguard')) return null;
  // The engine names the tier on the applied discount (discount-engine.js getEffectiveDiscount).
  return { rate, tier: word(priced[0].tier) };
}

// An estimate saved from its mapped result only (the admin estimate tool saves recurring.services with no line items)
// has no engine record: its witness is the tier and rate the estimate saved, read here on their own (recordsTier).
const NO_ENGINE_RECORD = { tier: '', rate: null };

// The legacy nested block (result.results.recurring), as completion-pricing.js savedEstimateTier reads it.
const legacyNestedBlock = (data) => object(object(object(data.result || data).results).recurring);

// The tier every one of these records names, when it is Silver, Gold or Platinum; records that name none are left out.
// Records that name different tiers name none.
function agreedTier(records) {
  const words = records.map(word).filter(Boolean);
  return DISCOUNTED_TIERS.includes(words[0]) && words.every((w) => w === words[0]) ? words[0] : null;
}

// The tier and rate the estimate's records name for its recurring work, when they agree with the engine's line: the
// column and the saved recurring block name no other tier (an empty column falls back to the block, as
// completion-pricing.js savedEstimateTier does), and the rate the estimate saved for it is the engine line's rate. That
// rate is the one the invoice reads (savedEstimateTier): the send snapshot's, else the rate of a block that names the
// tier. A saved 0 is a rate; an estimate that saved none leaves the engine's. With no engine record, the saved rate is
// the witness, and an estimate that saved none names no saving. Records that disagree name no saving: the invoice
// keeps one line by design.
function recordsTier(estimate, data, block, record) {
  const blockTier = word(block.waveGuardTier || block.tier);
  const tier = agreedTier([record.tier, estimate.waveguard_tier, blockTier]);
  if (!tier) return null;
  const { snapshotTierDiscount } = require('../routes/estimate-public');
  const blockRate = blockTier && block.discount != null && block.discount !== '' ? Number(block.discount) : null;
  const saved = snapshotTierDiscount(data, `${tier[0].toUpperCase()}${tier.slice(1)}`) ?? blockRate;
  if (record.rate === null) return saved === null ? null : { tier, rate: saved };
  return saved === null || Math.abs(saved - record.rate) <= 1e-9 ? { tier, rate: record.rate } : null;
}

// The service of the saved row the invoice matched: the row's own, else the key the schedule matched it to (as the
// invoice reads it, completion-pricing.js namingTier). Never the visit's label.
function matchedServiceKey(line) {
  if (!line) return null;
  const row = object(line.sourceLine);
  return require('../routes/estimate-public').recurringServiceKey({ ...row, service: row.service || line.serviceKey || undefined });
}

// The line's WaveGuard tier share: the tier row of the invoice's own pricing of the matched line, in the decision's own
// discount context (the call completion-pricing.js acceptedVisitBreakdown makes), with its place among the line's
// discount rows and its dollars. The decision prints those rows in that order (breakdown.discounts), so the place names
// the printed tier row. That row, and only that row, carries the tier's rate (acceptedDiscountRows), so a staff label
// that starts with "WaveGuard" is not one. Null when the line's saving has no tier share.
function pricedTierRow(estimate, line) {
  const { acceptedPricing, estimateDiscountContext } = require('./completion-pricing');
  const rows = acceptedPricing(line, estimateDiscountContext(estimate)).discounts;
  const index = rows.findIndex((row) => row.percent !== undefined);
  return index < 0 ? null : { index, dollars: rows[index].dollars };
}

// The tiers the WaveGuard records of these rows name. A record with no tier names none.
const waveGuardRecordTiers = (rows) => rows.flatMap((row) => list(object(object(row).discount).appliedDiscounts)
  .filter((d) => d?.type === 'waveguard').map((d) => d.tier));

// A printed breakdown of a line with a tier share must print its tier row named for the tier the estimate's records
// agree on: the engine's recurring lines of the service, the matched row's own record, the column, the saved block and
// the legacy nested block. The printed tier row is the row the invoice prints (breakdown.discounts) in the tier row's
// place, with its dollars. A bare "WaveGuard" (a row whose own tier record names no tier, pre-push audit), another
// tier's name, or no such row leaves the tier off, whatever another row is named. The name is the one written out here
// (TIER_LINE_NAMES). Reading a label needs no rate, and a staff discount beside it changes nothing. The tier left off,
// or null.
function printedLabelMiss({ estimate, line, data, block, lineItems, serviceKey }, discounts, tierRow) {
  const nested = legacyNestedBlock(data);
  const tier = agreedTier([
    ...waveGuardRecordTiers([...serviceEngineLines(lineItems, serviceKey), line.sourceLine]),
    estimate.waveguard_tier, block.waveGuardTier || block.tier, nested.waveGuardTier || nested.tier,
  ]);
  const printed = object(list(discounts)[tierRow.index]);
  const cents = (value) => Math.round(Number(value) * 100);
  return tier && !(printed.name === TIER_LINE_NAMES[tier] && cents(printed.dollars) === cents(tierRow.dollars)) ? tier : null;
}

// A saving the invoice leaves unnamed, that its own pricing of the matched line names, in its own discount context with
// only its tier reading (savedEstimateTier) replaced by the witness's tier and rate. Not read when the invoice names no
// tier by design (completion-pricing.js estimateDiscountContext, savedEstimateTier): a staff discount reaches recurring
// work in any saved shape, or the legacy nested block also supplies service rows. The tier row's name is compared
// through the invoice's own label code on both sides: a fault there names both alike, so it cannot hide a visit here.
// The tier left off, or null.
function unnamedSavingMiss({ estimate, line, data, block, lineItems, serviceKey }) {
  const { acceptedPricing, estimateDiscountContext, staffDiscountOnRecurring, waveGuardTierName } = require('./completion-pricing');
  if (staffDiscountOnRecurring(data, block) || list(legacyNestedBlock(data).services).length) return null;
  const record = lineItems.length ? engineTierRecord(lineItems, serviceKey) : NO_ENGINE_RECORD;
  const witness = record ? recordsTier(estimate, data, block, record) : null;
  if (!witness) return null;
  const context = estimateDiscountContext({ ...estimate, estimate_data: data });
  const quote = acceptedPricing(line, { ...context, estimateTier: { tier: witness.tier, amount: witness.rate } });
  const tierName = waveGuardTierName(witness.tier);
  const named = quote.discounts.length > 0 && quote.discounts.every((d) => d.named) && quote.discounts.some((d) => d.name === tierName);
  return named ? witness.tier : null;
}

// A line the reader could not price (reason no_breakdown): the reader (admin-customers.js formatEstimateLine) gives a
// rated row with no after-discount figure no per-visit price, and an engine result saved whole keeps the line's net only
// as `annual` (estimate-public.js recurringServicesWithSupplements), which the reader cannot tell from a legacy list
// annual (pre-push audit). The engine's own line record of the service holds that net. Priced by the reader's own
// derivation (public-quote.js perApplicationForLine), it must be the visit's own price, compared as the decision compares
// (completion-pricing.js sameMoney). The line is then priced at it and asked the unnamed-saving question, which reads
// the engine record as its witness. A line the reader priced is not repriced. The tier left off, or null.
function unpricedLineMiss(records, visit) {
  const { line, lineItems, serviceKey } = records;
  if (line.perApplicationPrice != null) return null;
  const [item] = serviceEngineLines(lineItems, serviceKey);
  const engine = item ? require('../routes/public-quote')._internals.perApplicationForLine(item) : null;
  if (!engine || !require('./completion-pricing').sameMoney(engine.amount, visit.estimated_price)) return null;
  return unnamedSavingMiss({ ...records, line: { ...line, perApplicationPrice: engine.amount } });
}

// One visit: a finding { visitId, estimateId, serviceKey, lineKey, tier } or null. `lineKey` is the schedule line the
// invoice matched (admin-customers.js scheduleLinesFromEstimate sourceLineKey): two lines of one estimate can share a
// service key (a monthly and a seasonal mosquito line), never a line key.
async function visitFinding(conn, visit) {
  const { breakdown, reason, estimate, line } = await require('./completion-pricing').acceptedVisitBreakdown(visit, { database: conn });
  if ((!breakdown && !['discount_unnamed', 'no_breakdown'].includes(reason)) || !estimate) return null;
  const serviceKey = matchedServiceKey(line);
  if (!serviceKey) return null;
  const data = parsed(estimate.estimate_data);
  const records = { estimate, line, data, serviceKey, ...pricingRecords(data) };
  const tierRow = breakdown ? pricedTierRow(estimate, line) : null;
  let tier;
  if (tierRow) tier = printedLabelMiss(records, breakdown.discounts, tierRow);
  else if (reason === 'no_breakdown') tier = unpricedLineMiss(records, visit);
  else tier = unnamedSavingMiss(records);
  return tier ? { visitId: String(visit.id), estimateId: String(estimate.id), serviceKey, lineKey: line.sourceLineKey || null, tier } : null;
}

/**
 * The upcoming visits (today through `days` ahead, Eastern) whose invoice would not print their estimate's WaveGuard
 * tier line. Returns { checked, findings: [{ visitId, estimateId, serviceKey, lineKey, tier }] }, one per visit. A visit that
 * cannot be read throws: a check that did not run proves nothing.
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
