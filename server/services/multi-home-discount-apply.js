'use strict';

/**
 * Multi-Home Discount on EVERY home of a family (owner ruling 2026-08-06: "the 10% applies to EVERY property in a
 * multi-property group"; owner 2026-11-04: homes on separate profiles linked as "Same family" count as one group).
 * Family build PR 2 of 3. Dark behind GATE_MULTI_HOME_ALL_HOMES (multiHomeAllHomesLive(), read at call time: off =
 * return before any query; kill = unset the variable, discounts already written stay). It changes prices, so the
 * owner flips it. It sends a customer nothing; the email is PR 3 and reads the ledger table written here.
 *
 *   runMultiHomeAllHomes({ now })   every 15 minutes (scheduler.js, under runExclusive)
 *
 * SOURCE EVENT. An estimate with status 'accepted', accepted in the last 14 days, whose stored manual discount is the
 * catalog preset 'multi_home': estimate_data.summary.manualDiscount.presetKey (also result.manualDiscount,
 * result.totals.manualDiscount, result.summary.manualDiscount — estimate-manual-discount-replay.js
 * storedManualDiscountCandidates). The admin estimate tool stamps presetKey from the catalog row's discount_key
 * (client/src/lib/discountCatalog.js buildManualDiscountPayload) and the pricing engine echoes it into the
 * manualDiscountInfo it persists (pricing-engine/estimate-engine.js), so the stored object is what was PRICED, not
 * what the form once held. Its recurringAmount must be above zero (the discount took a slice off the recurring
 * plan), the estimate must have booked plan visits (scheduled_services.source_estimate_id), and the profile must be
 * multi-home by its own flag (customers.has_multi_home) or by the Same family link (familyMultiHomeEligible).
 *
 * TARGETS. Every OTHER active recurring series of the family: other properties on the source profile, plus the
 * recurring series of every other active member of the source profile's Same family link
 * (multi_home_family_members, services/multi-home-family.js). The source estimate's own series and its own property
 * are never targets. A series sold with the Multi-Home Discount already netted into its price (its own accepted
 * estimate carries the preset) is recorded 'already_discounted' and left alone; a series sold with a DIFFERENT manual
 * discount holds (one discount per plan; staff decide).
 *
 * APPLY. One transaction per target series. It is what staff do with the Edit appointment "This and following" save
 * (routes/admin-schedule.js, through router._test), by the same helpers and guards the annual rate review's
 * per-application lane uses (services/rate-review-apply.js applyPerApplication): the customer comms lock, the
 * customers row, the ledger row, the series maintenance lock, then lockAndGuardFollowingSiblings (visit-row locks,
 * mint try-locks, refusal while a target holds a live invoice, prepaid money or a finishing card confirmation),
 * propagatePriceServiceToFollowingSiblings from the series' next upcoming visit, and the series parent's
 * recurring_template_overrides stamp so auto-extended visits spawn with the discount too. The written fields are the
 * catalog row's discount_id, discount_name, discount_type, discount_amount, service filters and discount_max_dollars,
 * with the visit's current price as primary_line_price (the gross the discount applies to). Only FLAT per-application
 * visits are written: one price across the series, no add-on lines, no appointment or line discount, primary_line_price
 * absent or equal to the price, no prepaid money. Anything else holds.
 *
 * GATE_DISCOUNT_STACKING. The "following" propagation prices every sibling with calculateStoredVisitFinancials (one
 * appointment-discount slot, no compounding). For a flat, add-on-free, line-discount-free visit that equals the stacking
 * engine's restackStoredVisitFinancials of the same row. This job proves it per series: with the gate on, the restack of
 * the written row must equal the written price or the series holds (stacking_price_mismatch). Later extensions go
 * through the same two engines, so the template check below repeats the proof on the template.
 *
 * HOLDS. monthly membership and prepaid-year lanes, prepaid money, a live invoice, a card confirmation in flight, a
 * plan on hold, a visit already discounted, add-on lines, a series template the helper cannot stamp, the edit-scope gate
 * off, and any shape the helper refuses. A hold is recorded in the ledger (status 'held', hold_reason) and rings ONE
 * deduped Billing bell per series and reason (the rate review's pattern); a held series is retried on every run for as
 * long as the source accept is under 14 days old.
 *
 * MONEY NOT MOVED. customers.per_application_fee and the plan rate ledger do not move: a hand edit of a visit discount
 * does not move them either, and a visit bills its own stamped price (billing-lane.js completionInvoiceAmount). A
 * prepaid visit, a live invoice, annual prepay terms and monthly membership dues are never touched.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const featureGates = require('../config/feature-gates');
const { storedManualDiscountCandidates } = require('./estimate-manual-discount-replay');
const { familyMembers, familyMultiHomeEligible, lockFamilyChangesShared } = require('./multi-home-family');
const { PLAN_LINE_SQL } = require('./rate-review');
const { seriesAgreedPropertyId } = require('./customer-properties');

const TABLE = 'multi_home_discount_applications';
const PRESET_KEY = 'multi_home';
const SOURCE_WINDOW_DAYS = 14;
const MAX_SOURCES = 200;
const UPCOMING_STATUSES = ['pending', 'confirmed'];
// Booking evidence for a source plan: at least one LIVE plan visit still to come or under way (an allow-list). A plan
// whose remaining visits were all cancelled, skipped or no-show is a cancelled plan, even when its first visit was
// completed, so 'completed' is not evidence on its own.
const LIVE_PLAN_STATUSES = Object.freeze(['pending', 'confirmed', 'en_route', 'on_site']);
const AUDIT_ACTION = 'customer.multi_home_discount_applied';
const ACTIVITY_APPLIED = 'multi_home_discount_applied';
const DONE_WHEN = 'multi_home_discount_applied';
const DAY_MS = 86400000;

const STATUS_APPLIED = 'applied';
const STATUS_HELD = 'held';
const STATUS_ALREADY = 'already_discounted';
const FAMILY_TABLE = 'multi_home_family_members';
const ALREADY_SOLD = 'sold_with_multi_home_discount';
const ALREADY_CARRIED = 'all_upcoming_visits_carry_it';

// Hold reasons (hold_reason in the ledger). Each maps to the one-sentence prose the Billing bell shows (at most 110
// characters, no codes: docs/admin-notifications.md).
const HOLD_COPY = Object.freeze({
  scope_gate_off: 'Series price changes are switched off, so the Multi-Home Discount was not added to this home.',
  preset_missing: 'The Multi-Home Discount is not an active 10 percent discount in the list, so nothing was added.',
  discount_not_eligible: 'This profile does not meet the Multi-Home Discount rules, so the discount was not added.',
  plan_on_hold: 'The plan is on hold, so the discount waits and is retried on the next check.',
  lane_monthly_membership: 'This plan bills as a monthly membership, so the discount needs a hand change to the dues.',
  lane_annual_prepay: 'This plan is prepaid for the year, so the discount needs a hand change.',
  lane_unknown: 'The billing basis of this plan is not per visit, so the discount was not added.',
  plan_has_other_discount: 'The plan was sold with a different discount, so the Multi-Home Discount was not stacked on it.',
  no_future_visit: 'No upcoming visit of this plan is on the schedule to carry the discount.',
  visit_in_reschedule: 'An upcoming visit is parked in a reschedule request, so the series was not changed.',
  visit_status_missing: 'An upcoming visit of this plan has no status on file, so the series was not changed.',
  visit_already_discounted: 'An upcoming visit already has a discount, so the series needs the Edit appointment screen.',
  visit_has_addons: 'An upcoming visit carries add-on lines, so the series needs the Edit appointment screen.',
  visit_unpriced: 'An upcoming visit of this plan has no price stamped, so the series was not changed.',
  visit_prices_differ: 'The upcoming visits of this plan are not all at one price, so the series was not changed.',
  visit_price_structure: 'An upcoming visit has a structured price this change cannot move, so nothing was changed.',
  visit_prepaid: 'An upcoming visit is prepaid, so the series was not changed.',
  annual_prepay_visit: 'An upcoming visit is covered by a prepaid year, so the series was not changed.',
  visit_card_hold: 'An upcoming visit holds a card for a late-cancel fee, so the series was not changed.',
  live_invoice: 'An upcoming visit already has an invoice, so settle or void it and the check retries.',
  card_confirmation_in_flight: 'The customer is finishing a card confirmation, so the check retries in a moment.',
  series_busy: 'The series is being updated right now, so the change is retried on the next check.',
  series_guard_refused: 'A visit in the series already holds money or is being changed, so it was not repriced.',
  series_template_complex: 'The series template carries add-ons or a discount, so later visits would not match.',
  template_not_discounted: 'The visits are discounted but the series template is not, so later visits would come in at full price.',
  target_set_changed: 'The visits of the series changed while the discount was added, so it was rolled back.',
  discount_no_effect: 'The 10 percent does not lower the price of this plan, so nothing was changed.',
  stacking_price_mismatch: 'The two price engines disagree on the discounted price, so the series was left alone.',
  reprice_mismatch: 'The discounted visits did not land on the expected price, so the change was rolled back.',
  apply_error: 'The check hit an error on this plan and will retry on the next run.',
});

// ── small helpers ───────────────────────────────────────────────────────

function cents(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
const dollars = (c) => Math.round(Number(c)) / 100;

function ymd(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value).trim());
  return m ? m[1] : null;
}

class HoldError extends Error {
  constructor(code, detail = null) {
    super(HOLD_COPY[code] || code);
    this.name = 'MultiHomeDiscountHold';
    this.holdCode = code;
    this.detail = detail;
  }
}
const hold = (code, detail) => new HoldError(code, detail);
const isHold = (err) => err instanceof HoldError;

// The series guards throw operational 409s (live invoice, prepaid visit, card confirmation, busy series). Every one is
// a hold, never a crash; the message text only picks the more useful reason.
function guardHold(err) {
  if (isHold(err)) return err;
  const status = err && (err.statusCode || err.status);
  if (status !== 409) return null;
  const msg = String(err.message || '');
  let code = 'series_guard_refused';
  if (err.code === 'VISIT_BUSY_RETRY' || err.code === 'VISIT_CHANGED_RETRY') {
    code = /card confirmation/i.test(msg) ? 'card_confirmation_in_flight' : 'series_busy';
  } else if (/invoice|payer statement/i.test(msg)) code = 'live_invoice';
  else if (/annual prepay term/i.test(msg)) code = 'annual_prepay_visit';
  else if (/already prepaid/i.test(msg)) code = 'visit_prepaid';
  else if (/late-cancel fee/i.test(msg)) code = 'visit_card_hold';
  return hold(code, msg.slice(0, 300));
}

// ── source detection (pure) ─────────────────────────────────────────────

function storedManualDiscounts(estimateData) {
  return (storedManualDiscountCandidates(estimateData || {}) || []).filter((md) => md
    && typeof md === 'object'
    && (md.type === 'PERCENT' || md.type === 'FIXED')
    && Number(md.value) > 0);
}

// The recurring slice the stored discount took off the plan; a legacy object with no split falls back to its amount.
function recurringSlice(md) {
  if (md.recurringAmount !== undefined && md.recurringAmount !== null) return Number(md.recurringAmount) || 0;
  return Number(md.amount) || 0;
}

function isMultiHomePreset(md, presetId) {
  if (md.presetKey === PRESET_KEY) return true;
  return !!(presetId && md.presetId && String(md.presetId) === String(presetId));
}

// The stored Multi-Home Discount that took a recurring slice off this estimate's plan, or null.
function multiHomeSourceDiscount(estimateData, presetId = null) {
  return storedManualDiscounts(estimateData).find((md) => isMultiHomePreset(md, presetId) && recurringSlice(md) > 0) || null;
}

// A stored manual discount on the estimate that is NOT the Multi-Home Discount (its slice is netted into the price).
function otherManualDiscount(estimateData, presetId = null) {
  return storedManualDiscounts(estimateData).find((md) => !isMultiHomePreset(md, presetId) && recurringSlice(md) > 0) || null;
}

// ── target selection (pure) ─────────────────────────────────────────────

// series: [{ customerId, rootId, propertyId, serviceKey, ... }] (every active recurring series of the family's
// profiles; propertyId is the house the app itself agrees the series is at, customer-properties.js
// seriesAgreedPropertyId, or null when the visits name none or more than one). Returns the series that are OTHER homes
// than the source's: not the source estimate's own series, and for the source profile itself only series at a
// different, known property (an unknown property can never be shown to be another home). A line the percent discount
// never touches (isExcluded, e.g. a termite bond) is not a target.
function selectTargetSeries({
  series, source, familyCustomerIds, isExcluded = () => false,
}) {
  const allowed = new Set([String(source.customerId), ...familyCustomerIds.map(String)]);
  const out = [];
  for (const s of series) {
    if (!allowed.has(String(s.customerId))) continue;
    if (source.roots.has(String(s.rootId))) continue;
    if (String(s.customerId) === String(source.customerId)
      && (!s.propertyId || !source.propertyId || String(s.propertyId) === String(source.propertyId))) continue;
    if (isExcluded(s.serviceKey)) continue;
    out.push(s);
  }
  return out;
}

// ── reads ───────────────────────────────────────────────────────────────

const sourceCutoff = (now) => new Date(now.getTime() - SOURCE_WINDOW_DAYS * DAY_MS);

// One page of in-window source candidates after the keyset (accepted_at, id). The key rides as text so microseconds
// survive the round trip (a JS Date would cut them and could re-read or skip a row).
async function loadSourcePage(dbh, cutoff, after, pageSize, presetId = null) {
  const query = dbh('estimates')
    .where({ status: 'accepted' })
    .whereNotNull('customer_id')
    .where('accepted_at', '>=', cutoff)
    // The stored discount names the preset by key, by catalog id, or both: match either string.
    .whereRaw(presetId ? "(estimate_data::text LIKE '%multi_home%' OR estimate_data::text LIKE ?)" : "estimate_data::text LIKE '%multi_home%'", presetId ? [`%${presetId}%`] : []);
  if (after) query.whereRaw('(accepted_at, id) > (?::timestamptz, ?::uuid)', [after.acceptedKey, after.id]);
  return query
    .orderBy([{ column: 'accepted_at', order: 'asc' }, { column: 'id', order: 'asc' }])
    .limit(pageSize)
    .select('id', 'customer_id', 'property_id', 'accepted_at', 'estimate_data', dbh.raw('accepted_at::text AS accepted_key'));
}

// EVERY in-window source is visited each tick: pages of `pageSize` by keyset until a short page, so a long run of
// older sources can never starve a newer accept. `visit(estimate)` runs per source.
async function eachSourceEstimate(dbh, now, visit, pageSize = MAX_SOURCES, presetId = null) {
  const cutoff = sourceCutoff(now);
  let after = null;
  for (;;) {
    const page = await loadSourcePage(dbh, cutoff, after, pageSize, presetId);
    for (const estimate of page) await visit(estimate);
    if (page.length < pageSize) return;
    const last = page[page.length - 1];
    after = { acceptedKey: last.accepted_key, id: last.id };
  }
}

// The source, or null when it is not (yet) a valid source: no Multi-Home Discount recurring slice, the profile is not
// multi-home by flag or by family, or the estimate has not booked its plan visits.
async function describeSource(dbh, estimate, presetId) {
  if (!multiHomeSourceDiscount(estimate.estimate_data, presetId)) return null;
  const customer = await dbh('customers').where({ id: estimate.customer_id }).first('id', 'active', 'deleted_at', 'has_multi_home');
  if (!customer || customer.deleted_at || customer.active !== true) return null;
  // The discount engine's own rule for a requires_multi_home discount: the profile's flag, or a live Same family.
  if (!(await require('./discount-engine').customerMeetsMultiHome(customer, dbh))) return null;
  const { PLAN_ROW_SQL } = PLAN_LINE_SQL;
  const { rows } = await dbh.raw(
    `SELECT s.id, s.recurring_parent_id, s.property_id, s.status FROM scheduled_services s WHERE s.source_estimate_id = ? AND ${PLAN_ROW_SQL}`,
    [estimate.id],
  );
  // Booked: a live plan visit still to come or under way. The roots still come from every plan row, so none of the
  // source's own series can ever be another home's target.
  if (!rows.some((r) => LIVE_PLAN_STATUSES.includes(String(r.status)))) return null;
  const roots = new Set(rows.map((r) => String(r.recurring_parent_id || r.id)));
  // The house the accept linked the estimate to, else the one the app agrees its first series is at.
  const propertyId = estimate.property_id || await seriesAgreedPropertyId([...roots][0], customer.id, dbh);
  return { estimateId: estimate.id, customerId: customer.id, propertyId: propertyId || null, roots, presetId: presetId || null };
}

// Every active recurring series of these profiles with an upcoming (or parked) plan visit, one entry per series root.
async function loadCandidateSeries(dbh, customerIds, today) {
  const { LINE_SQL, CADENCE_SQL, PLAN_ROW_SQL } = PLAN_LINE_SQL;
  const rows = await dbh('scheduled_services as s')
    .leftJoin('services as sv', 'sv.id', 's.service_id')
    .join('customers as c', 'c.id', 's.customer_id')
    .whereIn('s.customer_id', customerIds)
    .where('c.active', true)
    .whereNull('c.deleted_at')
    .where('s.scheduled_date', '>=', today)
    .whereRaw("(s.status IS NULL OR s.status IN ('pending', 'confirmed', 'rescheduled'))")
    .whereRaw(PLAN_ROW_SQL)
    .orderBy([{ column: 's.scheduled_date' }, { column: 's.id' }])
    .select('s.id', 's.customer_id', 's.property_id', 's.recurring_parent_id', 's.scheduled_date', 's.service_key_snapshot', 's.service_type',
      dbh.raw(`${LINE_SQL} AS line`), dbh.raw(`${CADENCE_SQL} AS cadence`));
  const byRoot = new Map();
  for (const r of rows) {
    const rootId = String(r.recurring_parent_id || r.id);
    const key = `${r.customer_id}:${rootId}`;
    const entry = byRoot.get(key);
    if (!entry) {
      byRoot.set(key, {
        customerId: r.customer_id, rootId, propertyId: null, serviceKey: r.service_key_snapshot || null,
        serviceType: r.service_type || null, line: r.line, cadence: r.cadence, nextDate: ymd(r.scheduled_date),
      });
    } else {
      entry.serviceKey = entry.serviceKey || r.service_key_snapshot || null;
    }
  }
  return [...byRoot.values()];
}

async function loadLedger(dbh, estimateId) {
  const rows = await dbh(TABLE).where({ source_estimate_id: estimateId }).select('series_root_id', 'status', 'hold_reason');
  return new Map(rows.map((r) => [String(r.series_root_id), r]));
}

async function loadPreset(dbh) {
  let query = dbh('discounts').where({ discount_key: PRESET_KEY, is_active: true, show_in_invoices: true });
  if (dbh.isTransaction) query = query.forShare();
  const preset = await query.first();
  const ok = preset && preset.discount_type === 'percentage' && Number(preset.amount) > 0;
  return ok ? preset : null;
}

// ── per-series checks ───────────────────────────────────────────────────

async function loadSeriesVisits(trx, rootId, today) {
  const { PLAN_ROW_SQL } = PLAN_LINE_SQL;
  const { rows } = await trx.raw(`
    SELECT s.id, s.customer_id, s.scheduled_date, s.status, s.estimated_price, s.primary_line_price,
      s.discount_type, s.discount_amount, s.discount_dollars, s.discount_id, s.line_discount_id, s.line_discount_dollars,
      s.annual_prepay_term_id, s.prepaid_amount, s.is_callback, s.is_recurring, s.recurring_parent_id,
      s.service_key_snapshot, s.service_category_snapshot, s.service_id, s.service_type
    FROM scheduled_services s
    WHERE (s.id = ? OR s.recurring_parent_id = ?)
      AND s.scheduled_date >= ?
      AND (s.status IS NULL OR s.status IN ('pending', 'confirmed', 'rescheduled'))
      AND ${PLAN_ROW_SQL}
    ORDER BY s.scheduled_date ASC, s.id ASC
  `, [rootId, rootId, today]);
  return rows.map((r) => ({ ...r, scheduled_date: ymd(r.scheduled_date) }));
}

function hasAnyDiscount(visit) {
  return !!(visit.discount_type || visit.discount_id || Number(visit.discount_dollars) > 0
    || visit.line_discount_id || Number(visit.line_discount_dollars) > 0);
}

function carriesPreset(visit, presetId) {
  return !!visit.discount_id && String(visit.discount_id) === String(presetId);
}

// The refusals read from the visit rows alone, in order. Returns { reason } | { already: true } | null.
function seriesShapeVerdict(visits, presetId) {
  const upcoming = visits.filter((v) => UPCOMING_STATUSES.includes(String(v.status)));
  if (!upcoming.length) return { reason: 'no_future_visit' };
  if (visits.some((v) => String(v.status) === 'rescheduled')) return { reason: 'visit_in_reschedule' };
  if (visits.some((v) => v.status == null)) return { reason: 'visit_status_missing' };
  const discounted = upcoming.filter(hasAnyDiscount);
  if (discounted.length === upcoming.length && upcoming.every((v) => carriesPreset(v, presetId))) return { already: true };
  if (discounted.length) return { reason: 'visit_already_discounted' };
  return null;
}

const FLAT_REFUSAL_REASON = Object.freeze({
  rate_moved_since_notice: 'visit_prices_differ',
  visit_has_discount: 'visit_already_discounted',
});

// Every upcoming visit must be a FLAT per-application visit at the first visit's price: no add-ons, no discount,
// primary_line_price absent or equal, no prepaid money (rate-review-apply flatVisitRefusal, reused as is).
function flatRefusal(visits, { addonCounts = new Map(), liveTermIds = new Set(), currentCents }) {
  const { flatVisitRefusal } = require('./rate-review-apply')._private;
  for (const visit of visits) {
    const found = flatVisitRefusal(visit, addonCounts.get(String(visit.id)) || 0, currentCents, liveTermIds);
    if (found) return { reason: FLAT_REFUSAL_REASON[found] || found, visitId: visit.id };
  }
  return null;
}

function discountFields(preset, grossDollars) {
  return {
    primary_line_price: grossDollars,
    discount_type: preset.discount_type,
    discount_amount: Number(preset.amount),
    discount_id: preset.id,
    discount_name: preset.name,
    discount_service_key_filter: preset.service_key_filter || null,
    discount_service_category_filter: preset.service_category_filter || null,
    discount_max_dollars: preset.max_discount_dollars ?? null,
  };
}

// The visit's price with the discount fields on it, by the helper's own math. With GATE_DISCOUNT_STACKING on, the
// stacking engine's restack of the same row must agree, or the series holds.
async function priceWithDiscount(trx, schedule, row, fields) {
  const merged = { ...row, ...fields };
  const scope = await schedule.loadStoredDiscountScope(trx, merged, []);
  const legacy = schedule.calculateStoredVisitFinancials(merged, [], [], scope);
  if (featureGates.discountStackingLive()) {
    const restacked = schedule.restackStoredVisitFinancials(merged, [], scope, new Map());
    if (restacked && cents(restacked.price) !== cents(legacy.price)) {
      throw hold('stacking_price_mismatch', { legacy: legacy.price, restacked: restacked.price });
    }
  }
  return legacy.price;
}

// What the next auto-extended visits of the series cost, read from PRODUCTION: seriesNextOccurrencePrices
// (routes/admin-schedule.js) walks the same dates the top-up walks and prices each through the extension writers' own
// chain: overlayRecurringTemplateOverrides, resolveSeriesExtensionPriceTemplate, the add-ons due on the date, then
// storedOccurrenceFloorPrice (the stacking restack with GATE_DISCOUNT_STACKING on, calculateStoredVisitFinancials
// off). It reads the STORED parent, so call it after the template is written. null = nothing will ever be extended
// (no pattern), so there is no spawn to price; a walk that cannot finish is unproven and holds.
// EVERY walked date's price, in cents (seriesNextOccurrencePrices: the same walk and verdicts as
// seriesNextOccurrencesPrice, which returns only the highest). A recurring add-on due on some dates only, or a line
// discount kept on the parent, makes the dates differ, so each one is proven, never just the maximum.
async function nextSpawnPrices(trx, schedule, rootId) {
  const read = schedule.seriesNextOccurrencePrices || require('../routes/admin-schedule').seriesNextOccurrencePrices;
  const next = await read(trx, rootId);
  if (next === null || next === undefined) return null;
  if (next.unverified) throw hold('series_template_complex', { unverified: true });
  return (next.prices || []).map((p) => cents(p));
}

const everyDateAt = (prices, expectedCents) => prices.every((p) => p === expectedCents);

// Refuse unless every walked date of the next spawns prices at the discounted amount.
async function assertNextSpawn(trx, schedule, { rootId, expectedCents }) {
  const prices = await nextSpawnPrices(trx, schedule, rootId);
  if (prices !== null && !everyDateAt(prices, expectedCents)) {
    throw hold('series_template_complex', { spawn: prices.map(dollars), expected: dollars(expectedCents) });
  }
}

// The sale's own estimates (any visit of the series points at one): the Multi-Home Discount netted into the price
// already, or another manual discount netted in. Returns 'already' | 'other' | null.
async function soldDiscountVerdict(trx, rootId, presetId) {
  const links = await trx('scheduled_services')
    .where(function inSeries() { this.where({ id: rootId }).orWhere({ recurring_parent_id: rootId }); })
    .whereNotNull('source_estimate_id')
    .distinct('source_estimate_id');
  const ids = links.map((r) => r.source_estimate_id);
  if (!ids.length) return null;
  const estimates = await trx('estimates').whereIn('id', ids).where({ status: 'accepted' }).select('id', 'estimate_data');
  if (estimates.some((e) => multiHomeSourceDiscount(e.estimate_data, presetId))) return 'already';
  if (estimates.some((e) => otherManualDiscount(e.estimate_data, presetId))) return 'other';
  return null;
}

// The billing lane of the series, resolved the way the annual rate review resolves it.
async function assertPerApplicationLane(trx, { customer, target, today }) {
  const { resolveLiveLane } = require('./rate-review-apply')._private;
  const lane = await resolveLiveLane(trx, { customer, familyKey: target.line, cadence: target.cadence, today });
  if (lane === 'per_application') return;
  if (lane === 'monthly_membership') throw hold('lane_monthly_membership');
  if (lane === 'annual_prepay') throw hold('lane_annual_prepay');
  throw hold('lane_unknown', { lane });
}

async function assertEligible(trx, { preset, customer, visit, priceDollars }) {
  const DiscountEngine = require('./discount-engine');
  const failures = await DiscountEngine.manualEligibilityFailures(preset, customer, {
    subtotal: priceDollars,
    serviceKey: visit.service_key_snapshot || null,
    serviceCategory: visit.service_category_snapshot || null,
  }, trx);
  if (failures.length) throw hold('discount_not_eligible', { failures });
}

// ── the write ───────────────────────────────────────────────────────────

async function lockLedgerRow(trx, { source, target }) {
  await trx.raw(
    `INSERT INTO ${TABLE} (source_estimate_id, source_customer_id, target_customer_id, target_property_id, series_root_id)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT (source_estimate_id, series_root_id) DO NOTHING`,
    [source.estimateId, source.customerId, target.customerId, target.propertyId || null, target.rootId],
  );
  return trx(TABLE).where({ source_estimate_id: source.estimateId, series_root_id: target.rootId }).forUpdate().first();
}

async function loadLiveTermIds(trx, locked, today) {
  const linked = [...new Set(locked.map((v) => v.annual_prepay_term_id).filter(Boolean))];
  if (!linked.length) return new Set();
  const { coveredTermsAsOf } = require('./annual-prepay-renewals');
  const rows = await coveredTermsAsOf(trx, today).whereIn('t.id', linked).select('t.id');
  return new Set(rows.map((t) => String(t.id)));
}

function countAddons(addonRows) {
  const counts = new Map();
  for (const a of addonRows) counts.set(String(a.scheduled_service_id), (counts.get(String(a.scheduled_service_id)) || 0) + 1);
  return counts;
}

// The series parent, the visits and the template are locked in the rate review's order and guarded exactly as the
// Edit appointment "This and following" save guards its siblings. Returns the locked target rows.
async function lockSeriesTargets(trx, schedule, { ledgerId, rootId, today, fields, expectedIds }) {
  let locked;
  try {
    await schedule.acquireRecurringSeriesMaintenanceLock(trx, rootId, false);
    locked = await schedule.lockAndGuardFollowingSiblings(trx, {
      editedId: ledgerId, editedRow: null, parentId: rootId, fromDateStr: today, serviceChanged: false, priceChanged: true, proposedFields: fields,
    });
  } catch (err) {
    throw guardHold(err) || err;
  }
  if (!locked.length) throw hold('no_future_visit', { today });
  const lockedIds = new Set(locked.map((v) => String(v.id)));
  if (lockedIds.size !== expectedIds.size || [...lockedIds].some((id) => !expectedIds.has(id))) {
    throw hold('target_set_changed', { locked: [...lockedIds], expected: [...expectedIds] });
  }
  return locked;
}

async function writeSeriesDiscount(trx, schedule, { ledgerId, rootId, today, fields, lockedIds, afterCents, preset }) {
  const cols = await trx('scheduled_services').columnInfo();
  let updatedIds;
  try {
    updatedIds = await schedule.propagatePriceServiceToFollowingSiblings(trx, {
      editedId: ledgerId, editedRow: null, parentId: rootId, fromDateStr: today, fields, serviceChanged: false, priceChanged: true, cols,
    });
  } catch (err) {
    throw guardHold(err) || err;
  }
  const updated = new Set(updatedIds.map(String));
  if (updated.size !== lockedIds.size || [...lockedIds].some((id) => !updated.has(id))) throw hold('target_set_changed', { updated: [...updated] });
  await schedule.stampRecurringTemplateOverrides(trx, rootId, fields, cols);
  const after = await trx('scheduled_services').whereIn('id', [...lockedIds]).select('id', 'estimated_price', 'discount_id');
  const off = after.filter((v) => cents(v.estimated_price) !== afterCents || String(v.discount_id) !== String(preset.id));
  if (off.length) throw hold('reprice_mismatch', { visitIds: off.map((v) => v.id) });
}

async function finalizeApplied(trx, { source, target, customer, preset, firstVisit, beforeCents, afterCents, visitCount, now, attempts }) {
  const { recordAuditEvent } = require('./audit-log');
  const detail = { presetId: preset.id, visitCount, serviceType: target.serviceType, stackingLive: featureGates.discountStackingLive() };
  await trx(TABLE).where({ source_estimate_id: source.estimateId, series_root_id: target.rootId }).update({
    status: STATUS_APPLIED,
    hold_reason: null,
    first_visit_id: firstVisit.id,
    first_visit_date: ymd(firstVisit.scheduled_date),
    price_before: dollars(beforeCents),
    price_after: dollars(afterCents),
    attempts: Number(attempts || 0) + 1,
    applied_at: now,
    detail: JSON.stringify(detail),
    updated_at: now,
  });
  await recordAuditEvent({
    actor_type: 'system',
    action: AUDIT_ACTION,
    resource_type: 'customer',
    resource_id: customer.id,
    metadata: {
      source_estimate_id: source.estimateId, source_customer_id: source.customerId, series_root_id: target.rootId,
      first_visit_id: firstVisit.id, first_visit_date: ymd(firstVisit.scheduled_date),
      price_before: dollars(beforeCents), price_after: dollars(afterCents), ...detail,
    },
    trx,
    critical: true,
  });
  await trx('activity_log').insert({
    customer_id: customer.id,
    action: ACTIVITY_APPLIED,
    description: `Multi-Home Discount (${Number(preset.amount)}%) added to ${target.serviceType || 'the recurring plan'} from ${ymd(firstVisit.scheduled_date)}: $${dollars(beforeCents).toFixed(2)} to $${dollars(afterCents).toFixed(2)} per visit.`,
    metadata: JSON.stringify({ source_estimate_id: source.estimateId, series_root_id: target.rootId, visit_count: visitCount }),
  });
}

async function markAlready(trx, { source, target, now, attempts, reason, templateStamped = false }) {
  await trx(TABLE).where({ source_estimate_id: source.estimateId, series_root_id: target.rootId }).update({
    status: STATUS_ALREADY, hold_reason: null, attempts: Number(attempts || 0) + 1, detail: JSON.stringify({ reason, templateStamped }), updated_at: now,
  });
}

// The checks that need no row lock on the series: lane, plan hold, the sale's own discount, visit shape. Returns the
// upcoming visits, or { already } when the series needs nothing.
function alreadyVerdict(visits, reason) {
  const upcoming = visits.filter((v) => UPCOMING_STATUSES.includes(String(v.status)));
  if (!upcoming.length) throw hold('no_future_visit');
  return { already: reason, upcoming };
}

async function precheckSeries(trx, { customer, target, preset, today }) {
  const activeHold = await require('./rate-review-apply')._private.activePlanHold(trx, customer.id);
  if (activeHold) throw hold('plan_on_hold', { holdId: activeHold.id });
  await assertPerApplicationLane(trx, { customer, target, today });
  const sold = await soldDiscountVerdict(trx, target.rootId, preset.id);
  if (sold === 'other') throw hold('plan_has_other_discount');
  const visits = await loadSeriesVisits(trx, target.rootId, today);
  if (sold === 'already') return alreadyVerdict(visits, ALREADY_SOLD);
  const verdict = seriesShapeVerdict(visits, preset.id);
  if (verdict && verdict.already) return alreadyVerdict(visits, ALREADY_CARRIED);
  if (verdict) throw hold(verdict.reason);
  const upcoming = visits.filter((v) => UPCOMING_STATUSES.includes(String(v.status)));
  const currentCents = cents(upcoming[0].estimated_price);
  if (currentCents == null || currentCents <= 0) throw hold('visit_unpriced');
  const refusal = flatRefusal(upcoming, { currentCents });
  if (refusal) throw hold(refusal.reason, { visitId: refusal.visitId });
  return { upcoming, currentCents };
}

// The gross a visit carrying the discount was discounted from.
function grossDollarsOf(visit) {
  const primary = Number(visit.primary_line_price);
  if (primary > 0) return primary;
  return Math.round((Number(visit.estimated_price) + (Number(visit.discount_dollars) || 0)) * 100) / 100;
}

// The visits already carry the discount (or the plan was sold with it netted in). Terminal success is only true when
// the NEXT auto-extended visit would also come in discounted, so the series template is checked under the series lock.
// Visits carrying it while the template does not: the template is stamped through the same helper the apply uses and the
// spawn is proven again. A template the stamp cannot fix, or a sold-with plan whose template spawns at another price,
// holds as template_not_discounted. Returns { templateStamped }.
async function verifyTemplateForAlready(trx, schedule, { target, preset, upcoming, reason }) {
  const netCents = cents(upcoming[0].estimated_price);
  if (netCents == null || netCents <= 0) throw hold('visit_unpriced');
  if (upcoming.some((v) => cents(v.estimated_price) !== netCents)) throw hold('visit_prices_differ');
  try {
    await schedule.acquireRecurringSeriesMaintenanceLock(trx, target.rootId, false);
  } catch (err) {
    throw guardHold(err) || err;
  }
  try {
    const current = await nextSpawnPrices(trx, schedule, target.rootId);
    if (current === null || everyDateAt(current, netCents)) return { templateStamped: false };
    if (reason !== ALREADY_CARRIED) throw hold('template_not_discounted', { reason });
    const fields = { ...discountFields(preset, grossDollarsOf(upcoming[0])), estimated_price: dollars(netCents) };
    if (cents(await priceWithDiscount(trx, schedule, upcoming[0], fields)) !== netCents) throw hold('template_not_discounted', { reason: 'visit_price_differs_from_catalog' });
    await schedule.stampRecurringTemplateOverrides(trx, target.rootId, fields, await trx('scheduled_services').columnInfo());
    const after = await nextSpawnPrices(trx, schedule, target.rootId);
    if (after !== null && !everyDateAt(after, netCents)) throw hold('template_not_discounted', { spawn: after.map(dollars), expected: dollars(netCents) });
    return { templateStamped: true };
  } catch (err) {
    if (isHold(err) && err.holdCode === 'series_template_complex') throw hold('template_not_discounted', err.detail);
    throw err;
  }
}

// ── is this still a target? (checked under the family-changes lock) ─────

// The source's house now: the accepted estimate's own property (fixed once accepted), else the agreed house of its plan
// series, read in this transaction.
async function sourceHouseNow(trx, source, estimate) {
  if (estimate && estimate.property_id) return estimate.property_id;
  const firstRoot = source.roots ? [...source.roots][0] : null;
  return firstRoot ? seriesAgreedPropertyId(firstRoot, source.customerId, trx) : null;
}

// Another active property of the same profile than the source's. Both houses are read now, never the values target
// selection saw: a series moved to the source's own house (or to no agreed house) is not another home.
async function sameProfileOtherHome(trx, { source, target, estimate }) {
  const house = await seriesAgreedPropertyId(target.rootId, target.customerId, trx);
  if (!house) return false;
  const home = await trx('customer_properties').where({ id: house, customer_id: target.customerId, active: true }).first('id');
  if (!home) return false;
  const sourceHouse = await sourceHouseNow(trx, source, estimate);
  return !!sourceHouse && String(sourceHouse) !== String(house);
}

async function sameLiveFamily(trx, { source, target }) {
  const rows = await trx(FAMILY_TABLE).whereIn('customer_id', [source.customerId, target.customerId]).select('customer_id', 'family_id');
  if (rows.length !== 2 || String(rows[0].family_id) !== String(rows[1].family_id)) return false;
  return familyMultiHomeEligible(trx, source.customerId);
}

// The source estimate still has a live plan visit (the same plan-row test and allow-list describeSource uses).
async function sourceStillBooked(trx, estimateId) {
  const { PLAN_ROW_SQL } = PLAN_LINE_SQL;
  const row = await trx('scheduled_services as s').where('s.source_estimate_id', estimateId).whereRaw(PLAN_ROW_SQL)
    .whereIn('s.status', LIVE_PLAN_STATUSES).first('s.id');
  return !!row;
}

// The relationship that made this series a target, read again under the SHARED family-changes lock (a link or unlink
// waits for it): the source estimate is still accepted, both profiles are live, and either the target is another active
// property of the same profile, or both profiles are in the SAME family that still has 2 or more live members.
async function relationshipHolds(trx, { source, target }) {
  const estimate = await trx('estimates').where({ id: source.estimateId, status: 'accepted' }).first('id', 'property_id', 'estimate_data');
  if (!estimate) return false;
  // The source itself, read again: it still carries the Multi-Home Discount's recurring slice and its plan is still
  // booked. A revise or a cancel after the scan must not hand its targets a discount.
  if (!multiHomeSourceDiscount(estimate.estimate_data, source.presetId || null)) return false;
  if (!(await sourceStillBooked(trx, source.estimateId))) return false;
  const people = await trx('customers').whereIn('id', [source.customerId, target.customerId]).select('id', 'active', 'deleted_at');
  const live = new Set(people.filter((c) => c.active === true && !c.deleted_at).map((c) => String(c.id)));
  if (!live.has(String(source.customerId)) || !live.has(String(target.customerId))) return false;
  return String(source.customerId) === String(target.customerId)
    ? sameProfileOtherHome(trx, { source, target, estimate })
    : sameLiveFamily(trx, { source, target });
}

// No longer a target: nothing changes, nothing rings. An old HELD row goes (it must not block "every target applied"
// forever); an applied or already_discounted row is history and stays.
async function dropTarget(trx, { source, target }) {
  await trx(TABLE).where({ source_estimate_id: source.estimateId, series_root_id: target.rootId, status: STATUS_HELD }).del();
  return { skipped: true, dropped: true };
}

async function applyInTransaction(trx, ctx) {
  const { source, target, now, today } = ctx;
  const schedule = ctx.schedule || require('../routes/admin-schedule')._test;
  // FIRST, before any row lock (a link or unlink takes the same lock exclusively, then customer rows): the family cannot
  // change under this transaction, and the relationship that made the series a target is read again.
  await lockFamilyChangesShared(trx);
  if (!(await relationshipHolds(trx, { source, target }))) return dropTarget(trx, { source, target });
  if (!featureGates.isEnabled('editApptPriceServiceScope')) throw hold('scope_gate_off');
  const { lockCustomerComms } = require('../utils/customer-comms-lock');
  await lockCustomerComms(trx, target.customerId);
  const customer = await trx('customers').where({ id: target.customerId }).forUpdate().first();
  if (!customer || customer.deleted_at || customer.active !== true) return { skipped: true };
  const ledger = await lockLedgerRow(trx, { source, target });
  if (ledger.status === STATUS_APPLIED || ledger.status === STATUS_ALREADY) return { skipped: true };
  const preset = await loadPreset(trx);
  if (!preset) throw hold('preset_missing');

  const pre = await precheckSeries(trx, { customer, target, preset, today });
  if (pre.already) {
    const { templateStamped } = await verifyTemplateForAlready(trx, schedule, { target, preset, upcoming: pre.upcoming, reason: pre.already });
    await markAlready(trx, { source, target, now, attempts: ledger.attempts, reason: pre.already, templateStamped });
    return { status: STATUS_ALREADY, reason: pre.already, templateStamped };
  }
  const { upcoming, currentCents } = pre;
  await assertEligible(trx, { preset, customer, visit: upcoming[0], priceDollars: dollars(currentCents) });

  const base = discountFields(preset, dollars(currentCents));
  const afterCents = cents(await priceWithDiscount(trx, schedule, upcoming[0], base));
  if (afterCents == null || afterCents <= 0 || afterCents >= currentCents) throw hold('discount_no_effect', { before: dollars(currentCents), after: dollars(afterCents) });
  const fields = { ...base, estimated_price: dollars(afterCents) };

  const expectedIds = new Set(upcoming.map((v) => String(v.id)));
  const locked = await lockSeriesTargets(trx, schedule, { ledgerId: ledger.id, rootId: target.rootId, today, fields, expectedIds });
  // Again under the visit-row locks, before any price is written: nothing target selection read is trusted (the
  // source, the family, both houses). Nothing has been written yet, so a series that stopped being a target drops.
  if (!(await relationshipHolds(trx, { source, target }))) return dropTarget(trx, { source, target });
  const addonRows = await trx('scheduled_service_addons').whereIn('scheduled_service_id', [...expectedIds, target.rootId]).select('scheduled_service_id');
  const liveTermIds = await loadLiveTermIds(trx, locked, today);
  const refusal = flatRefusal(locked, { addonCounts: countAddons(addonRows), liveTermIds, currentCents });
  if (refusal) throw hold(refusal.reason, { visitId: refusal.visitId });
  for (const visit of locked) {
    if (cents(await priceWithDiscount(trx, schedule, visit, base)) !== afterCents) throw hold('reprice_mismatch', { visitId: visit.id });
  }
  await writeSeriesDiscount(trx, schedule, { ledgerId: ledger.id, rootId: target.rootId, today, fields, lockedIds: expectedIds, afterCents, preset });
  // After the template is stamped: production prices the next extension from what is now stored. A mismatch rolls the
  // whole series back.
  await assertNextSpawn(trx, schedule, { rootId: target.rootId, expectedCents: afterCents });

  const firstVisit = locked.slice().sort((a, b) => String(ymd(a.scheduled_date)).localeCompare(String(ymd(b.scheduled_date))))[0];
  await finalizeApplied(trx, {
    source, target, customer, preset, firstVisit, beforeCents: currentCents, afterCents, visitCount: locked.length, now, attempts: ledger.attempts,
  });
  return { status: STATUS_APPLIED, firstVisitId: firstVisit.id, firstVisitDate: ymd(firstVisit.scheduled_date), priceBefore: dollars(currentCents), priceAfter: dollars(afterCents), visitCount: locked.length };
}

// One series, one transaction. Returns { status, ... } | { skipped: true } | { status: 'held', hold, detail }.
async function applyTargetSeries(source, target, { now, dbh = db, schedule = null } = {}) {
  const today = etDateString(now);
  let outcome;
  try {
    await dbh.transaction(async (trx) => {
      outcome = await applyInTransaction(trx, { source, target, now, today, schedule });
    });
  } catch (err) {
    const h = guardHold(err) || (isHold(err) ? err : null);
    if (h) return { status: STATUS_HELD, hold: h.holdCode, detail: h.detail };
    // The service catalog had not loaded yet: not the series' fault, so no hold and no bell; the next run retries.
    if (err && err.code === 'percent_exclusion_catalog_unavailable') {
      logger.warn(`[multi-home-discount] series ${target.rootId} waits: the service catalog is not loaded yet`);
      return { skipped: true };
    }
    logger.error(`[multi-home-discount] series ${target.rootId} failed: ${err.message}`);
    return { status: STATUS_HELD, hold: 'apply_error', detail: String(err.message || '').slice(0, 300) };
  }
  return outcome;
}

// ── holds: ledger + bell ────────────────────────────────────────────────

async function recordHold(dbh, { source, target, code, detail, now }) {
  await dbh.raw(
    `INSERT INTO ${TABLE} (source_estimate_id, source_customer_id, target_customer_id, target_property_id, series_root_id, status, hold_reason, attempts, detail, updated_at)
     VALUES (?, ?, ?, ?, ?, 'held', ?, 1, ?::jsonb, ?)
     ON CONFLICT (source_estimate_id, series_root_id) DO UPDATE
       SET hold_reason = EXCLUDED.hold_reason, attempts = ${TABLE}.attempts + 1, detail = EXCLUDED.detail, updated_at = EXCLUDED.updated_at
       WHERE ${TABLE}.status = 'held'`,
    [source.estimateId, source.customerId, target.customerId, target.propertyId || null, target.rootId, code, JSON.stringify(detail == null ? null : detail), now],
  );
}

const alertKey = (source, target, code) => `multi-home-discount-hold:${source.estimateId}:${target.rootId}:${code}`;

// Every hold bell of this series other than `keepCode`'s closes: all once it applies, the earlier reasons' when the
// reason changes (the bell copy is per reason).
async function closeHoldAlerts(dbh, { source, target }, reason, keepCode = null) {
  if (!featureGates.alertEpisodesLive()) return;
  try {
    const keys = Object.keys(HOLD_COPY).filter((c) => c !== keepCode).map((c) => alertKey(source, target, c));
    await require('./admin-alert-episodes').closeAdminAlertKeys(dbh, keys, reason);
  } catch (err) {
    logger.warn(`[multi-home-discount] hold alert close failed for series ${target.rootId}: ${err.message}`);
  }
}

// ONE deduped Billing bell per series and reason; the same content never re-rings (the notification dedupe).
async function raiseHoldAlert({ source, target }, code) {
  try {
    const { raiseAdminAlert, composeAdminAlert } = require('./admin-alert-compose');
    const spec = {
      area: 'Billing',
      action: 'finish a Multi-Home Discount by hand',
      why: HOLD_COPY[code] || HOLD_COPY.apply_error,
      severity: 'needs-you',
      link: `/admin/customers?customerId=${encodeURIComponent(target.customerId)}`,
      subject: { type: 'customer', id: String(target.customerId) },
      doneWhen: DONE_WHEN,
      who: 'person',
    };
    const opts = {
      dedupeKey: alertKey(source, target, code),
      refreshOnDedupe: true,
      metadata: { sourceEstimateId: source.estimateId, seriesRootId: target.rootId, reason: code },
    };
    if (!featureGates.alertEpisodesLive()) {
      await raiseAdminAlert('billing', spec, opts);
      return;
    }
    const composed = composeAdminAlert(spec);
    await require('./admin-alert-episodes').raiseAdminAlertWithReopen('billing', composed.headline, composed.why, {
      ...opts, link: composed.link, metadata: { ...opts.metadata, ...composed.metadata },
    });
  } catch (err) {
    logger.warn(`[multi-home-discount] hold alert failed for series ${target.rootId}: ${err.message}`);
  }
}

// ── the job ─────────────────────────────────────────────────────────────

async function settleTarget(dbh, source, target, result, now, out) {
  if (result.dropped) {
    out.dropped += 1;
    await closeHoldAlerts(dbh, { source, target }, 'multi_home_discount_target_dropped');
    return;
  }
  if (result.skipped) { out.skipped += 1; return; }
  if (result.status === STATUS_APPLIED) {
    out.applied += 1;
    await closeHoldAlerts(dbh, { source, target }, DONE_WHEN);
    return;
  }
  if (result.status === STATUS_ALREADY) {
    out.already += 1;
    await closeHoldAlerts(dbh, { source, target }, DONE_WHEN);
    return;
  }
  out.held += 1;
  out.holds.push({ sourceEstimateId: source.estimateId, targetCustomerId: target.customerId, seriesRootId: target.rootId, reason: result.hold });
  try {
    await recordHold(dbh, { source, target, code: result.hold, detail: result.detail, now });
  } catch (err) {
    logger.error(`[multi-home-discount] could not record hold for series ${target.rootId}: ${err.message}`);
  }
  await raiseHoldAlert({ source, target }, result.hold);
  await closeHoldAlerts(dbh, { source, target }, 'multi_home_discount_hold_reason_changed', result.hold);
}

async function targetsForSource(dbh, source, today) {
  const family = await familyMembers(dbh, source.customerId);
  const familyIds = family.members.filter((m) => !m.isSelf && m.active).map((m) => m.id);
  const customerIds = [source.customerId, ...familyIds];
  const series = await loadCandidateSeries(dbh, customerIds, today);
  const schedule = require('../routes/admin-schedule');
  // The percent-discount exclusion catalog (termite bond and the like) must be loaded before any percent price is
  // computed; the router primes it per request, this job primes it itself.
  if (typeof schedule.primePercentDiscountExclusions === 'function') await schedule.primePercentDiscountExclusions().catch(() => {});
  for (const s of series) {
    if (!source.roots.has(String(s.rootId))) s.propertyId = await seriesAgreedPropertyId(s.rootId, s.customerId, dbh);
  }
  return selectTargetSeries({
    series,
    source,
    familyCustomerIds: familyIds,
    isExcluded: (serviceKey) => !!serviceKey && schedule.lineExcludedFromPercentDiscount(serviceKey),
  });
}

// A series whose ledger row is applied or already_discounted is never applied again; a held one is retried.
async function applyTargets(dbh, source, targets, ledger, { now, apply = applyTargetSeries }, out) {
  for (const target of targets) {
    const done = ledger.get(String(target.rootId));
    if (done && (done.status === STATUS_APPLIED || done.status === STATUS_ALREADY)) continue;
    out.targets += 1;
    const result = await apply(source, target, { now, dbh });
    await settleTarget(dbh, source, target, result, now, out);
  }
}

// A HELD row whose series is no longer a target of this source (unlinked, deleted, moved) goes, with its bell.
async function pruneStaleHeld(dbh, source, targets, ledger, out) {
  const current = new Set(targets.map((t) => String(t.rootId)));
  for (const [rootId, row] of ledger.entries()) {
    if (row.status !== STATUS_HELD || current.has(rootId)) continue;
    await dbh(TABLE).where({ source_estimate_id: source.estimateId, series_root_id: rootId, status: STATUS_HELD }).del();
    await closeHoldAlerts(dbh, { source, target: { rootId } }, 'multi_home_discount_target_dropped');
    out.dropped += 1;
  }
}

const REASON_TARGET_DROPPED = 'multi_home_discount_target_dropped';

// HELD rows (and their bells) go; applied and already_discounted rows are history and stay.
async function dropHeldRows(dbh, rows, out) {
  if (!rows.length) return;
  await dbh(TABLE).whereIn('id', rows.map((r) => r.id)).where({ status: STATUS_HELD }).del();
  for (const r of rows) {
    await closeHoldAlerts(dbh, { source: { estimateId: r.source_estimate_id }, target: { rootId: r.series_root_id } }, REASON_TARGET_DROPPED);
  }
  out.dropped += rows.length;
}

// A source that no longer qualifies (no longer multi-home by flag or family, no plan visits, no recurring slice) keeps
// no held row: nothing will ever retry it, and a stale one would block "every target applied" forever.
async function dropHeldForSource(dbh, estimateId, out) {
  const rows = await dbh(TABLE).where({ source_estimate_id: estimateId, status: STATUS_HELD }).select('id', 'source_estimate_id', 'series_root_id');
  await dropHeldRows(dbh, rows, out);
}

// One pass over held rows whose source estimate left the 14-day window or stopped being 'accepted'.
// A held row's source still counts only while it is accepted, inside the window, and still carries the Multi-Home
// Discount's recurring slice. A revise can remove the discount; the source scan's text prefilter then never reads that
// estimate again, so this pass is the only place its held rows (and bells) can be cleared.
function heldSourceStillQualifies(row, cutoff, presetId) {
  if (row.estimate_status !== 'accepted' || !row.accepted_at) return false;
  if (new Date(row.accepted_at).getTime() < cutoff.getTime()) return false;
  return !!multiHomeSourceDiscount(row.estimate_data, presetId);
}

async function pruneOutOfScopeHeld(dbh, now, out, presetId = null) {
  const rows = await dbh(`${TABLE} as m`)
    .join('estimates as e', 'e.id', 'm.source_estimate_id')
    .where('m.status', STATUS_HELD)
    .select('m.id', 'm.source_estimate_id', 'm.series_root_id', 'e.status as estimate_status', 'e.accepted_at', 'e.estimate_data');
  const cutoff = sourceCutoff(now);
  const gone = rows
    .filter((row) => !heldSourceStillQualifies(row, cutoff, presetId))
    .map(({ id, source_estimate_id: sourceEstimateId, series_root_id: seriesRootId }) => ({
      id, source_estimate_id: sourceEstimateId, series_root_id: seriesRootId,
    }));
  await dropHeldRows(dbh, gone, out);
}

async function processSource(dbh, estimate, presetId, { now, today }, out) {
  const source = await describeSource(dbh, estimate, presetId);
  if (!source) {
    await dropHeldForSource(dbh, estimate.id, out);
    return;
  }
  out.sources += 1;
  const targets = await targetsForSource(dbh, source, today);
  const ledger = await loadLedger(dbh, source.estimateId);
  await pruneStaleHeld(dbh, source, targets, ledger, out);
  await applyTargets(dbh, source, targets, ledger, { now }, out);
}

/**
 * Gate off -> returns before any query. Returns
 * { ok, sources, targets, applied, already, held, skipped, dropped, holds: [{ sourceEstimateId, targetCustomerId, seriesRootId, reason }] }.
 */
async function runMultiHomeAllHomes({ now = new Date(), dbh = db } = {}) {
  if (!featureGates.multiHomeAllHomesLive()) return { ok: false, reason: 'gate_off' };
  const out = { ok: true, sources: 0, targets: 0, applied: 0, already: 0, held: 0, skipped: 0, dropped: 0, holds: [] };
  const today = etDateString(now);
  const preset = await dbh('discounts').where({ discount_key: PRESET_KEY }).first('id');
  const presetId = preset ? preset.id : null;
  await eachSourceEstimate(dbh, now, async (estimate) => {
    try {
      await processSource(dbh, estimate, presetId, { now, today }, out);
    } catch (err) {
      logger.error(`[multi-home-discount] source estimate ${estimate.id} failed: ${err.message}`);
    }
  }, MAX_SOURCES, presetId);
  try {
    await pruneOutOfScopeHeld(dbh, now, out, presetId);
  } catch (err) {
    logger.error(`[multi-home-discount] out-of-window cleanup failed: ${err.message}`);
  }
  if (out.applied || out.held || out.already || out.dropped) {
    logger.info(`[multi-home-discount] ${out.sources} source(s), ${out.targets} series: ${out.applied} applied, ${out.already} already discounted, ${out.held} held, ${out.dropped} no longer a target`);
  }
  return out;
}

module.exports = {
  runMultiHomeAllHomes,
  applyTargetSeries,
  selectTargetSeries,
  multiHomeSourceDiscount,
  otherManualDiscount,
  HOLD_COPY,
  AUDIT_ACTION,
  TABLE,
  _private: {
    guardHold, seriesShapeVerdict, flatRefusal, discountFields, describeSource, loadCandidateSeries, hold, HoldError,
    soldDiscountVerdict, relationshipHolds, verifyTemplateForAlready, pruneStaleHeld, recordHold, raiseHoldAlert, processSource, applyTargets, settleTarget, eachSourceEstimate, dropHeldForSource, pruneOutOfScopeHeld,
  },
};
