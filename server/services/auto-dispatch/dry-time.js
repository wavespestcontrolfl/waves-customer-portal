/**
 * Product dry time for auto-dispatch (owner 2026-11-01, GATE_AUTO_DISPATCH_DRY_TIME_ORDER, dark).
 *
 * Rain backtest of 440 outdoor stops (Aug-Nov 2026): stops whose products need
 * 4 dry hours were rained on 0 times when started at 8 AM and 9 times at 10 AM;
 * 2-3 hour work was the same at 8 or 10. Owner: "we dont have to do pest early,
 * forget the rule". So the service-family default time window (pest early
 * morning, lawn mid-morning; service-category.js) is replaced, all year by
 * default, by a window that follows the products' dry time:
 *   4 h or more    -> 8:00-10:00 AM  (first, so the product dries before the afternoon rain)
 *   1-3 h          -> 8:00 AM-12:00 PM  (8 and 10 AM were equally dry in the backtest)
 *   rain-proof     -> 1:00-5:00 PM   (granular, bait, gel, dust, water-in, rain-OK services)
 *
 * The window stays SOFT scoring (a customer's own time, blackouts and the
 * flex-tier freeze are untouched). For the rain-sensitive classes (long, short)
 * the credit also counts in a PLACED visit's move gain, but only for a slot on
 * the visit's current date (a same-day re-time, never a day move; owner
 * 2026-10-24: no automatic day moves for rain): prefs.dry_time.counts_in_gain,
 * read by scoring.js and move-rules.js. A rain-proof visit (class proof) never
 * gains from it, so no granular, bait or interior visit moves to sit in the
 * afternoon. Modes: 'off' (byte-identical, no database
 * read), 'shadow' (windows unchanged; the decision is logged beside what the
 * dry window would do), 'true' (the dry window replaces the family default).
 * DRY_TIME_ORDER_SEASON ('MM-DD..MM-DD', wrap-around allowed) narrows the
 * dates; empty or invalid = all year. Reads only, takes no row locks, and any
 * read error falls back to the service rule: this feeds soft scoring only.
 */
const { labelRainRuleFor } = require('../../config/label-rain-rules');
const RESCHEDULE_RULES = require('../../config/reschedule-rules');
const { driveSavingMinutes } = require('./move-rules');
const { _internals: { hhmmToMin } } = require('./scoring');

const DRY_WINDOWS = {
  long: { key: 'dry_long', startMin: 8 * 60, endMin: 10 * 60, label: '8:00–10:00 AM' },
  short: { key: 'dry_short', startMin: 8 * 60, endMin: 12 * 60, label: '8:00 AM–12:00 PM' },
  proof: { key: 'dry_proof', startMin: 13 * 60, endMin: 17 * 60, label: '1:00–5:00 PM' },
};

const MAX_PRODUCTS = 40;
const DEFAULT_LIQUID_HOURS = 2;
// Granular, bait, gel, dust, station and pellet products do not wash off.
const RAIN_PROOF_FORM = /granul|\bbait|\bgel\b|dust|station|pellet/i;

function classForHours(hours) {
  const h = Number(hours) || 0;
  if (h >= 4) return 'long';
  return h > 0 ? 'short' : 'proof';
}

// The call-time gate reader, tolerant of a suite that mocks feature-gates whole.
function dryTimeMode() {
  const { autoDispatchDryTimeOrderMode } = require('../../config/feature-gates');
  return typeof autoDispatchDryTimeOrderMode === 'function' ? autoDispatchDryTimeOrderMode() : 'off';
}

const SEASON_FORMAT = /^(\d{2})-(\d{2})\.\.(\d{2})-(\d{2})$/;

function validMonthDay(month, day) {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

// Whether 'YYYY-MM-DD' falls in the season ('MM-DD..MM-DD', read at call time
// from DRY_TIME_ORDER_SEASON unless passed). Empty or invalid = all year.
function inSeason(dateStr, raw = process.env.DRY_TIME_ORDER_SEASON) {
  const m = SEASON_FORMAT.exec(String(raw || '').trim());
  if (!m || !validMonthDay(Number(m[1]), Number(m[2])) || !validMonthDay(Number(m[3]), Number(m[4]))) return true;
  const day = String(dateStr || '').slice(5, 10);
  if (!/^\d{2}-\d{2}$/.test(day)) return true;
  const start = `${m[1]}-${m[2]}`;
  const end = `${m[3]}-${m[4]}`;
  return start <= end ? day >= start && day <= end : day >= start || day <= end;
}

// Dry hours one product asks for. `serviceHours` is the service rule's figure,
// used for a liquid the label table does not know.
function productDryHours(product, serviceHours) {
  const rule = labelRainRuleFor({ epa_reg_number: product?.epa_reg_number, name: product?.name });
  if (rule?.waterIn) return 0;
  if (rule?.dryBeforeRain) return Number(rule.dryBeforeRain.hours) || 0;
  const form = [product?.application_method, product?.product_category, product?.name].join(' ').replace(/_/g, ' ');
  if (RAIN_PROOF_FORM.test(form)) return 0;
  return Number(serviceHours) > 0 ? Number(serviceHours) : DEFAULT_LIQUID_HOURS;
}

// reschedule-rules.js serviceSensitivity key for a visit's name / catalog key.
function sensitivityKeyFor(serviceType, serviceKey) {
  const text = `${serviceKey || ''} ${serviceType || ''}`.toLowerCase().replace(/_/g, ' ');
  if (/mosquito/.test(text)) return 'mosquito';
  if (/\btrees?\b|shrub|\bpalms?\b/.test(text)) return 'tree_shrub_spray';
  if (/lawn|turf|weed|fertil/.test(text)) return 'lawn_spray';
  if (/termite/.test(text) && /bait|monitor/.test(text)) return 'termite_bait';
  if (/rodent|\brats?\b|trap/.test(text)) return 'rodent';
  if (/interior/.test(text) && !/exterior/.test(text)) return 'pest_interior';
  return 'pest_exterior';
}

// Rain-free hours the service rule asks for (0 when it needs none).
function serviceRuleHours(serviceType, serviceKey) {
  const rule = RESCHEDULE_RULES.serviceSensitivity[sensitivityKeyFor(serviceType, serviceKey)];
  return rule && rule.needs_rain_free ? Number(rule.rain_free_hours) || 0 : 0;
}

// A read inside a transaction runs in a savepoint, so a failed read cannot
// abort the caller's transaction (the proofreader's locked re-read).
function guarded(conn, fn) {
  return conn && conn.isTransaction ? conn.transaction(fn) : fn(conn);
}

function sameServiceFilter(serviceType, serviceKey) {
  return (q) => (serviceKey ? q.where('ss.service_key_snapshot', serviceKey) : q.where('ss.service_type', serviceType));
}

// Products of this customer's latest completed visit of the same service.
async function lastVisitProducts(conn, { customerId, serviceType, serviceKey }) {
  const visit = await conn('scheduled_services as ss')
    .join('service_records as sr', 'sr.scheduled_service_id', 'ss.id')
    .join('service_products as sp', 'sp.service_record_id', 'sr.id')
    .where('ss.customer_id', customerId)
    .where('ss.status', 'completed')
    .where(sameServiceFilter(serviceType, serviceKey))
    .orderBy('ss.scheduled_date', 'desc')
    .first('sr.id');
  if (!visit) return [];
  const rows = await conn('service_products as sp')
    .leftJoin('products_catalog as pc', 'pc.id', 'sp.product_id')
    .where('sp.service_record_id', visit.id)
    .limit(MAX_PRODUCTS)
    .select('sp.product_name', 'sp.product_category', 'sp.application_method', 'sp.epa_reg_number', 'pc.epa_reg_number as catalog_epa');
  return rows.map((r) => ({
    name: r.product_name,
    product_category: r.product_category,
    application_method: r.application_method,
    epa_reg_number: r.epa_reg_number || r.catalog_epa,
  }));
}

// The products the cost mapping lists for this service type.
async function catalogProducts(conn, serviceType) {
  return conn('service_product_usage as u')
    .join('products_catalog as pc', 'pc.id', 'u.product_id')
    .where('u.service_type', serviceType)
    .limit(MAX_PRODUCTS)
    .select('pc.name', 'pc.category as product_category', 'pc.application_method', 'pc.epa_reg_number');
}

function maxDryHours(products, ruleHours) {
  return Math.max(...products.map((p) => productDryHours(p, ruleHours)));
}

// Dry hours for a visit: { hours, source }. Never throws.
async function resolveDryHours(conn, { customerId, serviceType, serviceKey }) {
  const ruleHours = serviceRuleHours(serviceType, serviceKey);
  try {
    const { rainClassOf } = require('../scheduling/rain-fit');
    if (rainClassOf({ name: serviceType, serviceKey }) === 'ok') return { hours: 0, source: 'rain_ok_service' };
    const last = await guarded(conn, (c) => lastVisitProducts(c, { customerId, serviceType, serviceKey }));
    if (last.length) return { hours: maxDryHours(last, ruleHours), source: 'last_visit_products' };
    const mapped = await guarded(conn, (c) => catalogProducts(c, serviceType));
    if (mapped.length) return { hours: maxDryHours(mapped, ruleHours), source: 'service_products' };
  } catch { /* soft scoring only: the service rule answers */ }
  return { hours: ruleHours, source: 'service_rule' };
}

// prefs with the dry window as the soft default (null window = neutral time score).
function withWindow(prefs, window) {
  return { ...prefs, default_time_window: window, effective_time_window: window };
}

// The credit counts in a placed visit's same-day move gain: a rain-sensitive
// class with a window and no customer-set time.
function countsInGain(cls, window, customerTime) {
  return !!window && cls !== 'proof' && !customerTime;
}

async function withDryTime(prefs, conn, { customerId, serviceType, serviceKey, runDate }) {
  const mode = dryTimeMode();
  if (mode === 'off') return prefs;
  const { hours, source } = await resolveDryHours(conn, { customerId, serviceType, serviceKey });
  const cls = classForHours(hours);
  const window = inSeason(runDate) ? DRY_WINDOWS[cls] : null;
  const customerTime = !!prefs.preferred_time_window;
  const out = {
    ...prefs,
    dry_time: { mode, hours, class: cls, source, window_key: window ? window.key : null, customer_time: customerTime },
  };
  if (mode !== 'true' || customerTime) return out;
  if (countsInGain(cls, window, customerTime)) out.dry_time.counts_in_gain = true;
  return withWindow(out, window);
}

function windowByKey(key) {
  return Object.values(DRY_WINDOWS).find((w) => w.key === key) || null;
}

// Shadow mode: the prefs the dry window would score with. Others: unchanged.
function shadowPrefs(prefs) {
  const info = prefs.dry_time;
  if (!info || info.mode !== 'shadow' || info.customer_time) return prefs;
  const window = windowByKey(info.window_key);
  const out = withWindow(prefs, window);
  // The same gain rule mode 'true' would score with.
  if (countsInGain(info.class, window, false)) out.dry_time = { ...info, counts_in_gain: true };
  return out;
}

const startOf = (p) => (p ? { date: p.date, start: p.start_time } : null);

const inWindow = (window, startMin) => startMin >= window.startMin && startMin < window.endMin;

// Among the visit's same-date candidates that start inside its dry window, the
// one that adds the least drive: { date, start, added_drive_min }, or null.
function cheapestDryOnly(window, current, candidates) {
  let best = null;
  for (const cand of candidates || []) {
    const startMin = hhmmToMin(cand.start_time);
    if (String(cand.date) !== String(current.date) || startMin == null || !inWindow(window, startMin)) continue;
    const added = 0 - driveSavingMinutes(current, cand);
    if (!best || added < best.added_drive_min) best = { date: cand.date, start: cand.start_time, added_drive_min: added };
  }
  return best;
}

// Information only (never changes a ranking): for a rain-sensitive class with
// a dry window and no customer time, whether a PLACED visit starts outside the
// window and, if so, the cheapest same-day slot inside it.
function dryWindowFacts(info, { current, candidates, placed }) {
  const window = windowByKey(info.window_key);
  if (info.class === 'proof' || info.customer_time || !window) return {};
  const startMin = hhmmToMin(current && current.start_time);
  const outside = !!placed && startMin != null && !inWindow(window, startMin);
  return { outside_window: outside, dry_only: outside ? cheapestDryOnly(window, current, candidates) : null };
}

const sameSlot = (a, b) => !!a && !!b && a.date === b.date && a.start === b.start;

// constraints_checked.dry_time for a decision: the visit's dry class and, in
// shadow mode, where the dry window would have put it beside where today's
// window put it. `live` / `shadow` are the qualifying best candidates (or null).
function auditNote(prefs, {
  current, live, shadow, candidates = [], placed = false,
}) {
  const info = prefs.dry_time;
  if (!info) return null;
  const shadowBest = startOf(shadow);
  return {
    ...info,
    current: startOf(current),
    live_best: startOf(live),
    ...(info.mode === 'shadow' ? {
      shadow_best: shadowBest,
      would_move: !!shadowBest && !sameSlot(shadowBest, startOf(current)),
      ...dryWindowFacts(info, { current, candidates, placed }),
    } : {}),
  };
}

module.exports = {
  DRY_WINDOWS, classForHours, inSeason, productDryHours, serviceRuleHours, resolveDryHours, withDryTime, shadowPrefs, auditNote, dryTimeMode,
};
