'use strict';

/**
 * "Your Multi-Home Discount is on" email (owner 2026-11-04, family build PR 3 of 3).
 * Dark behind GATE_MULTI_HOME_DISCOUNT_EMAIL (multiHomeDiscountEmailLive(), read at call time: off = return before any
 * query, nothing sent; kill = unset). The owner flips it only after approving the copy.
 *
 *   runMultiHomeDiscountEmail({ now })   right after PR 2's job in the same 15-minute scheduler tick, under runExclusive
 *
 * WHEN. For every source estimate PR 2 (services/multi-home-discount-apply.js) would work on (the same readers:
 * eachSourceEstimate + describeSource, so the same 14-day window and the same source rules; a source past the window is
 * never sent, and there is no catch-up for older multi-home customers), the email goes out only when EVERY current
 * target series of that source (the same targetsForSource PR 2 applies to) has a multi_home_discount_applications row
 * that is `applied` or `already_discounted` and NONE is `held`. The ledger is read AGAINST the current target set, never
 * alone: a dropped target's held row is deleted by PR 2 and its applied/already rows stay as history, so rows for series
 * that are no longer targets are ignored. A source with no target series at all still gets the email for its own home.
 * Needs PR 2's gate on too (the job is only run after PR 2's job).
 *
 * ONCE. One email per (source estimate, paying address), ever. The email library's own idempotency does it: the
 * idempotency key is customer.multi_home_discount_on:<estimate id>:<hash of the lower-cased address>, so a second run
 * finds the stored email_messages row and sends nothing (a `blocked` suppression row dedupes too). A provider failure
 * follows the transactional retry rail exactly as every other transactional send: a failed row with a retry scheduled
 * or in flight holds the next attempt (EMAIL_PROVIDER_RETRY_HELD), an accepted send counts even when its bookkeeping
 * failed. Nothing here re-sends on its own, so a failure can never double-send.
 *
 * WHO. Each home goes to its profile's active Bill-To payer's AP email (payers.ap_email, customers.payer_id) when it
 * has one, else to the profile's own email. Homes are grouped by paying address (case-insensitive); each group is one
 * email listing only the homes that address pays for. Greeting = the payer's display name (first word) when a home in the
 * group bills to a payer with that AP email, else the first home's profile first name. No address -> no email for that
 * group (logged). A profile whose portal-wide email switch (notification_prefs.email_enabled) is off, or whose switch
 * cannot be read, is left out of the send; suppression and the transactional stream go through sendTemplate as usual.
 *
 * AT THE PROVIDER HANDOFF (sendTemplate's withProviderHandoff), in PR 2's lock order (the family lock, each listed
 * series' maintenance lock as a try, each profile's customer-comms lock), the whole email is composed again from fresh
 * reads (the routing rows FOR SHARE; no visit or invoice row is locked). It goes only when the same homes, the same
 * series and exactly this send come out; then the address key is taken, the suppression list is read again on that
 * transaction, and every lock is held through the request.
 * Anything else (a price or discount changed, a target added or held, a family change, a new address, payer, switch
 * or greeting, a series being changed right now) refuses before the request: counted as waiting (a new suppression as
 * blocked), and a later run checks again.
 *
 * CELLS (per home; a cell that cannot be read from a stored record is left out, never guessed; the template drops the
 * row):
 *   address  the series' saved property (customer_properties), else the visit's stamped address, else the profile's
 *   service  the series' visit service_type (the exact name on the schedule, e.g. "Quarterly Pest Control Service")
 *   Regular / Per application / Starts
 *     other homes, applied:            the PR 2 ledger (price_before, price_after, first_visit_date)
 *     other homes, already_discounted: the series' next visits (price; Regular only when the visit carries the preset
 *                                      with its stored primary_line_price)
 *     the new (source) home:           Per application = the plan's stored flat visit price; Regular = that price plus
 *                                      the stored manual discount's recurring slice per visit (recurringAmount over the
 *                                      cadence's visits a year), only for a single-series percent plan whose slice is
 *                                      the stored percent of that Regular. A gross price is never divided out of a net.
 *     any home sold with the discount netted in (the new home, or another sold that way) is listed only when the sale's
 *     stored discount took the full percent off every recurring line (percent, not capped, nothing excluded, slice =
 *     percent of base); otherwise the email waits.
 *   How it is paid: the Bill-To payer -> "Invoice to you by email"; else Auto Pay on a saved card -> "Auto Pay card on
 *     file"; else a per-application customer -> "Invoice after each visit" (a bank Auto Pay or another billing basis
 *     leaves the cell out).
 */

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const db = require('../models/db');
const logger = require('./logger');
const featureGates = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');
const { propertyStreetLine } = require('../utils/property-display');
const { PLAN_LINE_SQL } = require('./rate-review');
const { PRICE_SERVICE_PRICE_KEYS, parseTemplateOverrides } = require('./recurring-template-overrides');
const { lockCustomerComms, lockCustomerEmail } = require('../utils/customer-comms-lock');
const { lockFamilyChangesShared } = require('./multi-home-family');
const apply = require('./multi-home-discount-apply');

const TEMPLATE_KEY = 'customer.multi_home_discount_on';
// Never re-sent from stored copy (constants/email-replay-exclusions.js): a failed send is retried by this job only,
// after its fresh checks, at most once per RETRY_BACKOFF_MS.
const { MULTI_HOME_DISCOUNT_CATEGORY: CATEGORY } = require('../constants/email-replay-exclusions');
const RETRY_BACKOFF_MS = 24 * 60 * 60 * 1000;
// PR 2's already_discounted reason when the series counted because its upcoming visits carried the preset.
const ALREADY_CARRIED_REASON = 'all_upcoming_visits_carry_it';
// ... and when its plan was sold with the preset netted into the price.
const ALREADY_SOLD_REASON = 'sold_with_multi_home_discount';
const MAX_HOMES = 8;
const HOME_FIELDS = ['address', 'service', 'regular', 'discount', 'price', 'starts', 'payment'];
const VISITS_PER_YEAR = Object.freeze({ monthly: 12, bimonthly: 6, quarterly: 4, semiannual: 2 });
const STATUS_APPLIED = 'applied';
const STATUS_ALREADY = 'already_discounted';
const STATUS_HELD = 'held';
const PAY_INVOICE_PAYER = 'Invoice to you by email';
const PAY_AUTOPAY_CARD = 'Auto Pay card on file';
const PAY_INVOICE_AFTER = 'Invoice after each visit';

// ── small helpers ───────────────────────────────────────────────────────

const clean = (v) => String(v == null ? '' : v).trim();
const lower = (v) => clean(v).toLowerCase();
const isEmailLike = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(v));

function cents(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function money(c) {
  if (c == null) return '';
  return `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ymd(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value).trim());
  return m ? m[1] : null;
}

// "Sat, Nov 14" from a calendar date (no time zone shift: the date is formatted as UTC noon).
function weekdayDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

const firstWord = (v) => clean(v).split(/\s+/)[0] || '';

// ── readiness ───────────────────────────────────────────────────────────

async function loadLedgerRows(dbh, estimateId) {
  const rows = await dbh(apply.TABLE).where({ source_estimate_id: estimateId })
    .select('series_root_id', 'status', 'price_before', 'price_after', 'first_visit_date', 'detail');
  return new Map(rows.map((r) => [String(r.series_root_id), r]));
}

// null when every CURRENT target is applied or already_discounted; else the code of what is still open.
function openTargetReason(targets, ledger) {
  for (const t of targets) {
    const row = ledger.get(String(t.rootId));
    if (!row) return 'target_not_recorded';
    if (row.status === STATUS_HELD) return 'target_held';
    if (row.status !== STATUS_APPLIED && row.status !== STATUS_ALREADY) return 'target_unknown_status';
  }
  return null;
}

// ── per-home facts (stored records only) ────────────────────────────────

// The series' upcoming plan visits (pending or confirmed, from today on), oldest first.
async function loadSeriesFacts(dbh, { customerId, rootId }, today) {
  const { PLAN_ROW_SQL, CADENCE_SQL } = PLAN_LINE_SQL;
  const { rows } = await dbh.raw(
    `SELECT s.id, s.scheduled_date, s.estimated_price, s.primary_line_price, s.discount_id, s.service_type, s.property_id,
            s.service_address_line1, s.service_address_line2, ${CADENCE_SQL} AS cadence
       FROM scheduled_services s LEFT JOIN services sv ON sv.id = s.service_id
      WHERE (s.id = ? OR s.recurring_parent_id = ?) AND s.customer_id = ? AND s.scheduled_date >= ?
        AND s.status IN ('pending', 'confirmed') AND ${PLAN_ROW_SQL}
      ORDER BY s.scheduled_date ASC, s.id ASC`,
    [rootId, rootId, customerId, today],
  );
  const upcoming = rows.map((r) => ({ ...r, date: ymd(r.scheduled_date), priceCents: cents(r.estimated_price) }));
  const first = upcoming[0] || null;
  const flat = first && first.priceCents > 0 && upcoming.every((v) => v.priceCents === first.priceCents);
  return {
    first,
    serviceName: clean(first?.service_type),
    cadence: first?.cadence || null,
    flatPriceCents: flat ? first.priceCents : null,
    startsDate: first?.date || null,
  };
}

async function homeAddress(dbh, { customerId, propertyId, visit, profile }) {
  const lookup = async (id) => (id
    ? dbh('customer_properties').where({ id, customer_id: customerId }).first('address_line1', 'address_line2')
    : null);
  const property = (await lookup(propertyId)) || (await lookup(visit?.property_id));
  return propertyStreetLine(property || {})
    || propertyStreetLine({ address_line1: visit?.service_address_line1, address_line2: visit?.service_address_line2 })
    || propertyStreetLine(profile || {})
    || '';
}

// The new (source) home's Regular and discount, from the stored manual discount and the stored visit price only.
function sourcePrices({ estimateData, presetId, facts, seriesCount }) {
  const out = { priceCents: facts.flatPriceCents, regularCents: null, discountCents: null, provable: false };
  const md = apply.multiHomeSourceDiscount(estimateData, presetId);
  const visits = VISITS_PER_YEAR[facts.cadence];
  const slice = md ? Number(md.recurringAmount) : NaN;
  // The arithmetic proof applies only to a single-series percent plan on a cadence with a known visit count.
  if (!md || seriesCount !== 1 || !visits || md.type !== 'PERCENT' || !(slice > 0)) return out;
  out.provable = true;
  if (out.priceCents == null) return out;
  const discountCents = Math.round((slice * 100) / visits);
  const regularCents = out.priceCents + discountCents;
  // The stored discount must be the stored percent of that Regular to the cent (one cent of rounding), or the figure is
  // not trusted and left out. A plan repriced or stripped of its discount after the sale fails this, so the email for
  // it waits (buildHome marks the new home unproven).
  if (Math.abs(discountCents - Math.round((regularCents * Number(md.value)) / 100)) > 1) return out;
  return { ...out, regularCents, discountCents };
}

function targetPrices({ row, facts, presetId }) {
  if (row.status === STATUS_APPLIED) {
    const before = cents(row.price_before);
    const after = cents(row.price_after);
    const ok = before != null && after != null && before > after;
    return { priceCents: after, regularCents: ok ? before : null, discountCents: ok ? before - after : null, startsDate: ymd(row.first_visit_date) };
  }
  // already_discounted: the next visits' stored price; Regular only when the visit carries the Multi-Home preset.
  const first = facts.first;
  const gross = first ? cents(first.primary_line_price) : null;
  const carries = !!(first && presetId && first.discount_id && String(first.discount_id) === String(presetId));
  const ok = carries && gross != null && facts.flatPriceCents != null && gross > facts.flatPriceCents;
  return {
    priceCents: facts.flatPriceCents,
    regularCents: ok ? gross : null,
    discountCents: ok ? gross - facts.flatPriceCents : null,
    startsDate: facts.startsDate,
  };
}

// Every next visit the series' top-up would mint, priced by PRODUCTION (seriesNextOccurrencePrices: every walked date),
// must be at the price the email states. null = nothing will be extended; a walk that cannot finish is unproven.
async function nextSpawnsAt(dbh, rootId, expectedCents, nextPrices) {
  const read = nextPrices || require('../routes/admin-schedule').seriesNextOccurrencePrices;
  const next = await read(dbh, rootId);
  if (next === null || next === undefined) return true;
  if (next.unverified) return false;
  return (next.prices || []).every((p) => cents(p) === expectedCents);
}

const detailOf = (row) => {
  if (!row || !row.detail) return {};
  if (typeof row.detail === 'object') return row.detail;
  try { return JSON.parse(row.detail); } catch { return {}; }
};

// The ledger is history: staff can remove the discount or reprice a series before this email goes (a held home or a
// failed send can delay it). Another home counts only while its upcoming visits are flat at the price the row
// recorded (applied), still carry the preset when that is how it counted (already discounted, visits carried it),
// carry no other appointment discount, and every next extension prices the same.
async function targetStillCurrent(dbh, { row, facts, presetId, rootId, nextPrices }) {
  if (!row || !facts.first || facts.flatPriceCents == null) return false;
  const visitDiscount = facts.first.discount_id ? String(facts.first.discount_id) : null;
  const carries = !!(presetId && visitDiscount === String(presetId));
  if (visitDiscount && !carries) return false;
  if (row.status === STATUS_APPLIED && facts.flatPriceCents !== cents(row.price_after)) return false;
  if (row.status === STATUS_ALREADY && detailOf(row).reason === ALREADY_CARRIED_REASON && !carries) return false;
  return nextSpawnsAt(dbh, rootId, facts.flatPriceCents, nextPrices);
}

// How many series the sold estimate booked (its plan rows), so a several-series sale is never proven per series.
async function soldSeriesCount(dbh, estimateId) {
  const { PLAN_ROW_SQL } = PLAN_LINE_SQL;
  const { rows } = await dbh.raw(
    `SELECT s.id, s.recurring_parent_id FROM scheduled_services s WHERE s.source_estimate_id = ? AND ${PLAN_ROW_SQL}`,
    [estimateId],
  );
  return new Set((rows || []).map((r) => String(r.recurring_parent_id || r.id))).size;
}

// A home that counted because its plan was SOLD with the Multi-Home Discount netted in is proven now the way the new
// home is: its own (single) accepted sold estimate's stored slice, exact to the cent, over the current flat price
// (sourcePrices; `provable` false when that arithmetic does not apply), or null when no single sold estimate exists.
// The one accepted sale this series was booked from: its stored data and how many plan series it booked.
async function soldTargetSale(dbh, rootId) {
  const links = await dbh('scheduled_services')
    .where(function inSeries() { this.where({ id: rootId }).orWhere({ recurring_parent_id: rootId }); })
    .whereNotNull('source_estimate_id')
    .distinct('source_estimate_id');
  const ids = [...new Set((links || []).map((r) => String(r.source_estimate_id)))];
  if (ids.length !== 1) return null;
  const estimate = await dbh('estimates').where({ id: ids[0], status: 'accepted' }).first('id', 'estimate_data');
  if (!estimate) return null;
  return { estimateData: estimate.estimate_data, seriesCount: await soldSeriesCount(dbh, estimate.id) };
}

// The sale's stored Multi-Home Discount took the full percent off EVERY recurring line of the sale: a percent discount,
// not capped (no lawn floor, no base cap), no recurring line excluded (palm injection, rodent bait, termite bait...), and
// its recurring slice the stored percent of its stored discountable base (one cent of rounding). Only then does each
// series of the sale carry it. Missing fields fail closed.
function saleDiscountCoversEveryLine(md) {
  if (!md || md.type !== 'PERCENT' || md.capped !== false) return false;
  if (!Array.isArray(md.excludedServices) || md.excludedServices.length) return false;
  const baseCents = cents(md.recurringDiscountableBase);
  const sliceCents = cents(md.recurringAmount);
  if (!(baseCents > 0) || !(sliceCents > 0)) return false;
  return Math.abs(sliceCents - Math.round((baseCents * Number(md.value)) / 100)) <= 1;
}

// One series of a sale made with the Multi-Home Discount netted in (the new home's, or another home's sold that way).
// Listed only when that discount covered every recurring line of the sale (pre-push audit P1: an excluded or capped
// line must never sit under "10% off"); then proven by the arithmetic (one series, a known cadence: Regular and 10%
// shown) or, where the arithmetic cannot apply, while unchanged since the sale (current price only).
async function saleSeriesVerdict(dbh, { estimateData, presetId, facts, seriesCount, rootId, nextPrices }) {
  const prices = { ...sourcePrices({ estimateData, presetId, facts, seriesCount }), startsDate: facts.startsDate };
  if (!saleDiscountCoversEveryLine(apply.multiHomeSourceDiscount(estimateData, presetId))) {
    return { prices: currentPriceOnly(prices), stale: true };
  }
  if (prices.provable) {
    const proven = provenCells(prices) && await nextSpawnsAt(dbh, rootId, prices.priceCents, nextPrices);
    return { prices, stale: !proven };
  }
  const unchanged = await unchangedSinceSale(dbh, { rootId, priceCents: prices.priceCents, nextPrices });
  return { prices: currentPriceOnly(prices), stale: !unchanged };
}

const provenCells = (prices) => prices.priceCents != null && prices.regularCents != null && prices.discountCents != null;

// A plan the arithmetic cannot prove (several series in one sale, or a cadence whose visit count the slice cannot be
// read for, e.g. a lawn program) counts only while it is UNCHANGED since the sale: flat upcoming visits, no price key
// stamped on its series template (every Edit-appointment "this and following" price change stamps one; a "this only"
// change breaks flatness), and every next extension at that price. Shown with its current price only.
async function unchangedSinceSale(dbh, { rootId, priceCents, nextPrices }) {
  if (priceCents == null) return false;
  const root = await dbh('scheduled_services').where({ id: rootId }).first('recurring_template_overrides');
  const overrides = parseTemplateOverrides(root && root.recurring_template_overrides) || {};
  if (PRICE_SERVICE_PRICE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(overrides, k))) return false;
  return nextSpawnsAt(dbh, rootId, priceCents, nextPrices);
}

const currentPriceOnly = (prices) => ({ ...prices, regularCents: null, discountCents: null });

// The new home must prove its discount now (its current flat price plus the stored slice, exact to the cent) and every
// next extension must price the same; the email never claims 10% off for a home it cannot show.
async function sourceHomeVerdict(dbh, ctx, facts, rootId) {
  return saleSeriesVerdict(dbh, {
    estimateData: ctx.estimate.estimate_data, presetId: ctx.presetId, facts, seriesCount: ctx.source.roots.size, rootId, nextPrices: ctx.nextPrices,
  });
}

// Another home, read now: sold with the discount -> proven from its own sold estimate; applied or carried -> the
// ledger row checked against the current visits (targetStillCurrent). Both also prove every next extension.
async function targetHomeVerdict(dbh, ctx, facts, rootId) {
  const row = ctx.ledger.get(String(rootId));
  if (row && row.status === STATUS_ALREADY && detailOf(row).reason === ALREADY_SOLD_REASON) {
    const sale = facts.first && !facts.first.discount_id ? await soldTargetSale(dbh, rootId) : null;
    if (!sale) return { prices: targetPrices({ row, facts, presetId: ctx.presetId }), stale: true };
    return saleSeriesVerdict(dbh, { ...sale, presetId: ctx.presetId, facts, rootId, nextPrices: ctx.nextPrices });
  }
  const prices = targetPrices({ row, facts, presetId: ctx.presetId });
  const current = await targetStillCurrent(dbh, { row, facts, presetId: ctx.presetId, rootId, nextPrices: ctx.nextPrices });
  return { prices, stale: !current };
}

async function buildHome(dbh, { customerId, rootId, propertyId, isSource }, ctx) {
  const facts = await loadSeriesFacts(dbh, { customerId, rootId }, ctx.today);
  // A series of the sale with no upcoming visit (cancelled after it) is neither listed nor judged. It stays in the
  // source's roots, so it is never another home's target, and the sale still counts it (seriesCount below).
  if (isSource && !facts.first) return null;
  const profile = ctx.customers.get(String(customerId));
  const { prices, stale } = isSource
    ? await sourceHomeVerdict(dbh, ctx, facts, rootId)
    : await targetHomeVerdict(dbh, ctx, facts, rootId);
  return {
    customerId: String(customerId),
    rootId: String(rootId),
    isSource,
    stale,
    address: await homeAddress(dbh, { customerId, propertyId, visit: facts.first, profile }),
    service: facts.serviceName,
    ...prices,
  };
}

async function buildHomes(dbh, ctx) {
  const homes = [];
  for (const rootId of ctx.source.roots) {
    const home = await buildHome(dbh, { customerId: ctx.source.customerId, rootId, propertyId: ctx.source.propertyId, isSource: true }, ctx);
    if (home) homes.push(home);
  }
  for (const t of ctx.targets) {
    homes.push(await buildHome(dbh, { customerId: t.customerId, rootId: t.rootId, propertyId: t.propertyId, isSource: false }, ctx));
  }
  return homes;
}

// ── who pays, who may be emailed ────────────────────────────────────────

// `lock` (the provider handoff) reads the routing rows FOR SHARE: an edit of a profile's email or Bill-To payer, its
// email switch, or a payer's AP email either committed first (and is read) or waits until the request is made.
async function loadCustomers(dbh, ids, { lock = false } = {}) {
  const query = dbh('customers').whereIn('id', ids).whereNull('deleted_at').select(
    'id', 'first_name', 'last_name', 'email', 'payer_id', 'billing_mode', 'autopay_enabled', 'autopay_paused_until',
    'autopay_payment_method_id', 'ach_status', 'address_line1', 'address_line2',
  );
  const rows = lock ? await query.orderBy('id').forShare() : await query;
  return new Map(rows.map((r) => [String(r.id), r]));
}

// The ACTIVE Bill-To payers of those profiles that have a usable AP email, by payer id. `lock` reads them FOR SHARE.
async function loadPayers(dbh, customers, { lock = false } = {}) {
  const payerIds = [...new Set([...customers.values()].map((c) => c.payer_id).filter((v) => v != null))];
  if (!payerIds.length) return new Map();
  const query = dbh('payers').whereIn('id', payerIds).select('id', 'display_name', 'company_name', 'ap_email', 'active');
  const rows = lock ? await query.orderBy('id').forShare() : await query;
  return new Map(rows.filter((p) => p.active !== false && isEmailLike(p.ap_email)).map((p) => [String(p.id), p]));
}

// Profiles whose portal-wide email switch is off. A read that fails throws: the source waits for the next tick.
async function loadEmailOptOuts(dbh, ids, { lock = false } = {}) {
  const query = dbh('notification_prefs').whereIn('customer_id', ids).select('customer_id', 'email_enabled');
  const rows = lock ? await query.orderBy('customer_id').forShare() : await query;
  return new Set(rows.filter((r) => r.email_enabled === false).map((r) => String(r.customer_id)));
}

async function paymentCell(dbh, customer, payer) {
  if (payer) return PAY_INVOICE_PAYER;
  if (customer.billing_mode !== 'per_application') return '';
  try {
    const autopay = require('./autopay-eligibility');
    if (!(await autopay.customerOnAutopay(customer, { db: dbh, failClosed: true }))) return PAY_INVOICE_AFTER;
    const method = await autopay.getChargeableAutopayMethod(customer, dbh);
    return method && !autopay.isBankMethodType(method.method_type) ? PAY_AUTOPAY_CARD : '';
  } catch (err) {
    logger.warn(`[multi-home-discount-email] Auto Pay unreadable for a profile, payment cell left out: ${err.message}`);
    return '';
  }
}

// Where a profile's homes are emailed: its active Bill-To payer's AP email when it has one, else its own email.
function routeFor(customer, payers) {
  const payer = customer.payer_id != null ? payers.get(String(customer.payer_id)) || null : null;
  const address = payer ? clean(payer.ap_email) : clean(customer.email);
  return { payer, address, key: lower(address) };
}

// Groups the homes by paying address. A home with no usable address is returned in `noAddress`.
async function groupByPayingAddress(dbh, homes, { customers, payers, optedOut }) {
  const groups = new Map();
  const noAddress = [];
  for (const home of homes) {
    if (optedOut.has(home.customerId)) continue;
    const customer = customers.get(home.customerId);
    if (!customer) continue;
    const { payer, address, key } = routeFor(customer, payers);
    if (!isEmailLike(address)) { noAddress.push(home); continue; }
    if (!groups.has(key)) groups.set(key, { key, address, payer: null, homes: [] });
    const group = groups.get(key);
    if (payer && !group.payer) group.payer = payer;
    group.homes.push({ ...home, payerId: payer ? String(payer.id) : null, payment: await paymentCell(dbh, customer, payer) });
  }
  return { groups: [...groups.values()], noAddress };
}

function greetingFor(group, customers) {
  if (group.payer) return firstWord(group.payer.display_name) || 'there';
  const first = customers.get(group.homes[0].customerId);
  return firstWord(first?.first_name) || 'there';
}

// ── the email ───────────────────────────────────────────────────────────

function homeCells(home) {
  return {
    address: home.address,
    service: home.service,
    regular: money(home.regularCents),
    discount: home.discountCents != null ? `-${money(home.discountCents)}` : '',
    price: money(home.priceCents),
    starts: weekdayDate(home.startsDate),
    payment: home.payment,
  };
}

function payloadFor(group, customers) {
  const payload = { greeting_name: greetingFor(group, customers), company_phone: WAVES_SUPPORT_PHONE_DISPLAY };
  group.homes.forEach((home, idx) => {
    const cells = homeCells(home);
    for (const field of HOME_FIELDS) payload[`home_${idx + 1}_${field}`] = cells[field];
  });
  return payload;
}

// New (source) homes first, then the others by address.
function sortHomes(homes) {
  return [...homes].sort((a, b) => (Number(b.isSource) - Number(a.isSource)) || a.address.localeCompare(b.address) || a.rootId.localeCompare(b.rootId));
}

function idempotencyKeyFor(estimateId, groupKey) {
  return `${TEMPLATE_KEY}:${estimateId}:${crypto.createHash('sha256').update(groupKey).digest('hex').slice(0, 32)}`;
}

// The fields of one group's send, compared again at the provider handoff.
function sendArgs(estimateId, group, customers) {
  const payer = !!group.payer;
  return {
    to: group.address,
    payload: payloadFor(group, customers),
    recipientType: payer ? 'payer' : 'customer',
    recipientId: payer ? String(group.payer.id) : group.homes[0].customerId,
    triggerEventId: `multi_home_discount_on:${estimateId}`,
    idempotencyKey: idempotencyKeyFor(estimateId, group.key),
  };
}

// Each group's email (homes sorted), or why it is not sent.
function sendsFor(estimateId, groups, customers) {
  return groups.map((group) => {
    const homes = sortHomes(group.homes);
    if (homes.length > MAX_HOMES) return { key: group.key, skip: 'too_many_homes', count: homes.length };
    if (homes.some((h) => !h.address)) return { key: group.key, skip: 'no_street' };
    return { key: group.key, args: sendArgs(estimateId, { ...group, homes }, customers) };
  });
}

function tally(out, result) {
  if (result?.sent && result.deduped) out.deduped += 1;
  else if (result?.sent) out.sent += 1;
  else if (result?.blocked) out.blocked += 1;
  else out.failed += 1;
}

// Never logs the address: a provider error can echo it.
function redact(err) {
  return String(err?.code || err?.status || 'send_error');
}

// An earlier attempt to this address that FAILED (it is never re-sent from stored copy) is tried again only after
// RETRY_BACKOFF_MS, so a send the provider keeps refusing is tried about once a day inside the 14-day window, each
// time after this job's fresh checks.
async function failedRecently(dbh, key) {
  if (!dbh) return false;
  // The database's own clock on both sides (the row's updated_at is written by it), never the job's `now`.
  const row = await dbh('email_messages').where({ idempotency_key: key })
    .whereRaw("lower(coalesce(status, '')) = 'failed'")
    .whereRaw('updated_at > now() - make_interval(secs => ?)', [RETRY_BACKOFF_MS / 1000])
    .first('id');
  return !!row;
}

// What an earlier attempt to this address allows now. The email library re-sends a failed row only when it was
// definitely never handed to the provider; a failure that may have been delivered (or that a provider retry owns) is
// held there forever, so this job skips it quietly instead of trying it again every tick. A definitely-unsent failure
// is tried again only after RETRY_BACKOFF_MS, each time after this job's fresh checks.
async function earlierAttemptVerdict(dbh, key, holdsEarlier) {
  if (!dbh) return 'send';
  const row = await dbh('email_messages').where({ idempotency_key: key }).first();
  if (!row || String(row.status || '').toLowerCase() !== 'failed') return 'send';
  const holds = holdsEarlier || require('./email-template-library').providerRetryHoldErrorForExistingMessage;
  if (holds(row)) return 'never';
  return (await failedRecently(dbh, key)) ? 'wait' : 'send';
}

const REFUSALS = Object.freeze({
  series_busy: 'a listed plan is being changed right now',
  not_ready: 'a home\'s discount or price, or another home of the family, changed',
  homes_changed: 'the family\'s homes changed',
  content_changed: 'what this email states, or who it goes to, changed',
  suppressed: 'the address went on the suppression list',
});

async function sendGroups(dbh, run, estimate, composed, out) {
  for (const one of composed.sends) {
    if (one.skip === 'too_many_homes') {
      logger.error(`[multi-home-discount-email] estimate ${estimate.id}: ${one.count} homes pay to one address, more than the ${MAX_HOMES} the email holds; not sent`);
      out.skipped += 1;
      continue;
    }
    if (one.skip) {
      logger.warn(`[multi-home-discount-email] estimate ${estimate.id}: a home has no street address on file; email to its paying address not sent`);
      out.skipped += 1;
      continue;
    }
    const earlier = await earlierAttemptVerdict(dbh, one.args.idempotencyKey, run.holdsEarlier);
    if (earlier === 'wait') { out.waiting += 1; continue; }
    if (earlier === 'never') { out.skipped += 1; continue; }
    const state = { refused: null };
    try {
      const result = await run.send({
        templateKey: TEMPLATE_KEY,
        ...one.args,
        categories: [CATEGORY],
        suppressProviderErrorLog: true,
        withProviderHandoff: sendTimeHandoff(dbh, run, estimate, composed, one, state),
      });
      if (state.refused) {
        logger.info(`[multi-home-discount-email] estimate ${estimate.id}: ${REFUSALS[state.refused]} just before the send; nothing sent, the next run checks again`);
        if (state.refused === 'suppressed') out.blocked += 1;
        else out.waiting += 1;
        continue;
      }
      tally(out, result);
    } catch (err) {
      out.failed += 1;
      logger.warn(`[multi-home-discount-email] estimate ${estimate.id}: send not completed (${redact(err)}); the next run retries through the email library`);
    }
  }
}

// ── the job ─────────────────────────────────────────────────────────────

// Everything one source's email states, from fresh reads on `conn`: { none } when the estimate is not a source,
// { wait } when it is not ready to send, else the sends. `lock` is the provider handoff's read (see loadCustomers).
async function composeSource(conn, estimate, run, { lock = false } = {}) {
  const source = await apply._private.describeSource(conn, estimate, run.presetId);
  if (!source) return { none: true };
  const targets = await apply._private.targetsForSource(conn, source, run.today);
  const roots = [...new Set([...source.roots, ...targets.map((t) => t.rootId)].map(String))].sort();
  const ids = [...new Set([source.customerId, ...targets.map((t) => t.customerId)].map(String))].sort();
  const ledger = await loadLedgerRows(conn, estimate.id);
  if (openTargetReason(targets, ledger)) return { wait: 'target_open', roots, ids };
  const customers = await loadCustomers(conn, ids, { lock });
  const ctx = { estimate, source, targets, ledger, presetId: run.presetId, today: run.today, customers, dbh: conn, nextPrices: run.nextPrices };
  const homes = await buildHomes(conn, ctx);
  // Every series of the sale gone (only a visit under way today): nothing to say about the new home yet.
  if (!homes.some((h) => h.isSource)) return { wait: 'no_source_home', roots, ids };
  if (homes.some((h) => h.stale)) return { wait: 'home_stale', roots, ids };
  const payers = await loadPayers(conn, customers, { lock });
  const optedOut = await loadEmailOptOuts(conn, ids, { lock });
  const { groups, noAddress } = await groupByPayingAddress(conn, homes, { customers, payers, optedOut });
  return { roots, ids, noAddress, sends: sendsFor(estimate.id, groups, customers) };
}

// The source estimate as the scan read it: still accepted, same profile, same accept time (so still in the window).
async function sourceEstimateNow(trx, estimate) {
  const row = await trx('estimates').where({ id: estimate.id, status: 'accepted' })
    .first('id', 'customer_id', 'property_id', 'accepted_at', 'estimate_data');
  const sameAccept = row && new Date(row.accepted_at).getTime() === new Date(estimate.accepted_at).getTime();
  return row && sameAccept && String(row.customer_id) === String(estimate.customer_id) ? row : null;
}

// The provider-boundary recheck (pre-push audit P1s, rounds 7 and 8). In PR 2's lock order: the family lock first (a
// link or unlink takes it exclusively), then each listed series' maintenance lock (every series price writer takes it;
// a try, so a series being changed refuses instead of waiting), then each profile's customer-comms lock. Under them the
// whole email is composed again from fresh reads, and it goes only when the same homes, the same series and exactly this
// send come out; then the address key is taken and every lock is held through the request. Otherwise nothing is sent
// and a later run checks again. No visit or invoice row is locked: the series lock fences the price writers.
function sendTimeHandoff(dbh, run, estimate, composed, one, state) {
  return (dispatch) => dbh.transaction(async (trx) => {
    const refuse = (reason) => { state.refused = reason; return { ok: false, reason }; };
    await lockFamilyChangesShared(trx);
    for (const rootId of composed.roots) {
      // Byte-identical key to admin-schedule.js acquireRecurringSeriesMaintenanceLock (a service cannot import a route).
      const res = await trx.raw('SELECT pg_try_advisory_xact_lock(hashtext(?), hashtext(?::text)) AS locked',
        ['recurring-series-maintenance', rootId]);
      if (res?.rows?.[0]?.locked !== true) return refuse('series_busy');
    }
    for (const id of composed.ids) await lockCustomerComms(trx, id);
    const current = await sourceEstimateNow(trx, estimate);
    const fresh = current ? await composeSource(trx, current, run, { lock: true }) : { none: true };
    if (fresh.none || fresh.wait) return refuse('not_ready');
    if (!isDeepStrictEqual(fresh.roots, composed.roots) || !isDeepStrictEqual(fresh.ids, composed.ids)) return refuse('homes_changed');
    const now = fresh.sends.find((s) => s.key === one.key);
    if (!now || now.skip || !isDeepStrictEqual(now.args, one.args)) return refuse('content_changed');
    await lockCustomerEmail(trx, one.args.to);
    // The suppression list again, on this transaction after the address key (suppression writers take it): sendTemplate
    // read it before this handoff, so a bounce or opt-out that committed while these locks were awaited refuses here.
    const library = require('./email-template-library');
    const loaded = await library.loadTemplateByKey(TEMPLATE_KEY, trx);
    if (!loaded?.template) return refuse('not_ready');
    if (await library.activeSuppressionFor(loaded.template, one.args.to, null, trx)) return refuse('suppressed');
    await dispatch(trx);
    return { ok: true };
  });
}

async function processSource(dbh, estimate, run, out) {
  const composed = await composeSource(dbh, estimate, run);
  if (composed.none) return;
  out.sources += 1;
  if (composed.wait) {
    if (composed.wait === 'home_stale') {
      logger.info(`[multi-home-discount-email] estimate ${estimate.id}: a home's discount or price is not proven now (changed, or not shown); the email waits`);
    }
    out.waiting += 1;
    return;
  }
  if (composed.noAddress.length) {
    logger.info(`[multi-home-discount-email] estimate ${estimate.id}: ${composed.noAddress.length} home(s) have no email address to send to`);
    out.noAddress += composed.noAddress.length;
  }
  await sendGroups(dbh, run, estimate, composed, out);
}

/**
 * Gate off -> returns before any query. Returns
 * { ok, sources, waiting, sent, deduped, blocked, failed, skipped, noAddress }.
 */
async function runMultiHomeDiscountEmail({ now = new Date(), dbh = db, send = null, nextPrices = null } = {}) {
  if (!featureGates.multiHomeDiscountEmailLive()) return { ok: false, reason: 'gate_off' };
  if (!featureGates.multiHomeAllHomesLive()) return { ok: false, reason: 'discount_job_off' };
  const sender = send || ((args) => require('./email-template-library').sendTemplate(args));
  const out = { ok: true, sources: 0, waiting: 0, sent: 0, deduped: 0, blocked: 0, failed: 0, skipped: 0, noAddress: 0 };
  const preset = await dbh('discounts').where({ discount_key: apply._private.PRESET_KEY }).first('id');
  const run = { presetId: preset ? preset.id : null, today: etDateString(now), send: sender, nextPrices };
  await apply._private.eachSourceEstimate(dbh, now, async (estimate) => {
    try {
      await processSource(dbh, estimate, run, out);
    } catch (err) {
      out.failed += 1;
      logger.error(`[multi-home-discount-email] source estimate ${estimate.id} failed: ${err.message}`);
    }
  }, apply._private.MAX_SOURCES, run.presetId);
  if (out.sent || out.failed || out.blocked) {
    logger.info(`[multi-home-discount-email] ${out.sources} source(s): ${out.sent} sent, ${out.deduped} already sent, ${out.blocked} blocked, ${out.failed} failed, ${out.waiting} waiting on a home`);
  }
  return out;
}

module.exports = {
  runMultiHomeDiscountEmail,
  TEMPLATE_KEY,
  _private: {
    openTargetReason, sourcePrices, targetPrices, groupByPayingAddress, greetingFor, payloadFor, homeCells, idempotencyKeyFor,
    weekdayDate, money, sortHomes, paymentCell, processSource, loadLedgerRows, sendGroups, failedRecently, earlierAttemptVerdict, targetStillCurrent, soldTargetSale, saleDiscountCoversEveryLine, sourceHomeVerdict, targetHomeVerdict, unchangedSinceSale, MAX_HOMES, HOME_FIELDS,
    routeFor, sendsFor, composeSource, sendTimeHandoff,
    RETRY_BACKOFF_MS, CATEGORY,
  },
};
