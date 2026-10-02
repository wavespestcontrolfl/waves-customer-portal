/**
 * Combined-booking check (owner request 2026-09-29; narrowed to time and
 * technician by owner ruling 2026-10-01).
 *
 * For every accepted estimate with MORE THAN ONE recurring service (pest +
 * lawn, pest + lawn + tree & shrub, pest + rodent, ...), this verifies that
 * every UPCOMING visit the booking created has a time and a technician, and
 * that every upcoming priced series visit carries the price the customer
 * accepted for it, and posts ONE admin bell when one does not (owner rulings
 * 2026-10-01: upcoming visits, whenever the estimate was accepted; 2026-10-02:
 * visit prices are back, visit prices only, no invoices). The
 * 2026-09-28 defect it guards: companion services were booked with no time and
 * no technician.
 *
 * NOT THIS CHECK'S (each has its own owner, and a second bell would conflict):
 *   - invoices, and visits with no price at all (an unpriced visit is the
 *     watchdog's unpriced-series alert's; first-application and split
 *     invoices are the sibling-split workflow's). A first visit, a prepaid
 *     visit, and any visit whose accepted price cannot be known for certain
 *     (a discounted or credited plan, monthly-dues rodent) are not
 *     price-checked: never guessed.
 *   - whether the right number of visits exist: the shared accepted-plan
 *     classifier (recurring-schedule-audit's acceptedScheduleFindings), the
 *     source of the watchdog's `accepted-schedule:*` alerts. An estimate with
 *     such a gap is never declared OK, and its schedule shape is left to that
 *     alert.
 *   - a former customer's leftover work: the churned-live-work alert's.
 *
 * WHERE IT RUNS: inside the schedule-integrity watchdog (its daily tick, under
 * that job's runExclusive and GATE_SCHEDULE_INTEGRITY_WATCHDOG), over accepted
 * estimates that settled at least SETTLE_MINUTES ago and still have an
 * upcoming visit with no time or technician (or an open bell) — not a hook in the
 * accept route (a money path: a hook could only add latency or a new way to
 * fail it, and is lost if the process dies right after the commit). The sweep
 * derives everything from committed rows: a crash just means the next run
 * checks the estimate. No state is stored beyond the bells themselves.
 *
 * WHAT IS A COMBINED BOOKING: what the customer ACCEPTED, read through the
 * converter's own scheduling units (combineRecurringServicesForScheduling, the
 * same call the classifier makes; a legacy rodent supplement counts). A family
 * the classifier did not judge (an active plan hold, a stopped series) or the
 * duplicate-series guard kept on an older series leaves the check; the rest are
 * still checked, and with none left a standing bell is left as it is.
 *
 * ALERTS follow docs/admin-notifications.md through raiseAdminAlert: one
 * needs-you Schedule bell per estimate ("Schedule — fix <name>'s combined
 * booking", a one-sentence why, the customer link, subject = the estimate,
 * done when combined_booking_verified), ringing again only when a new service
 * family joins it. A fixed problem, a cancelled plan, or a customer / estimate
 * that left for good closes the bell as DONE. An OK result is an `fyi` fact and
 * writes no row. Rings share the watchdog run's budget (at most 10 a day):
 * anything past it is simply left for a later run, where the same upcoming
 * problem is found again. An estimate with an open bell is always judged, and
 * a finding about a service that went on hold stays on its bell until that
 * service is judged again.
 */

const db = require('../models/db');
const logger = require('./logger');

const OPS_KEY = 'combined-booking-check';
// needs-you bells ring under the emitter's own category; 'alert' is the one the
// schedule-integrity watchdog's own bells use.
const CATEGORY = 'alert';
const AREA = 'Schedule';
const DONE_WHEN = 'combined_booking_verified';
const RESOLVED_FIXED = 'Fixed: the combined booking now checks out';
const RESOLVED_GONE = 'Closed: the plan was cancelled, or the estimate or customer is no longer active or current';
// Without a caller's budget (a direct run), the same 10 a day the watchdog
// keeps (docs/admin-notifications.md, Budget).
const DEFAULT_RING_BUDGET = 10;

// Let the accept transaction and its follow-on writes settle before judging.
const SETTLE_MINUTES = 3;
// A seasonal visit this close is expected to be routed (the watchdog's own
// upcoming look-ahead).
const ROUTING_HORIZON_DAYS = 14;
const addDaysET = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const PRICE_TOLERANCE_CENTS = 2;
const money = (value) => `$${(Math.round(Number(value) * 100) / 100).toFixed(2)}`;

const CANCELLED = new Set(['cancelled', 'canceled']);
// Finished or parked visits are not judged: the shared terminal set
// (completed, cancelled, rescheduled, skipped, no_show) plus the alternate
// spelling of cancelled.
const { TERMINAL_SCHEDULED_SERVICE_STATUSES } = require('./scheduled-service-statuses');
const NOT_LIVE = new Set([...TERMINAL_SCHEDULED_SERVICE_STATUSES, 'canceled']);

const FAMILY_LABELS = {
  pest_control: 'Pest',
  lawn_care: 'Lawn',
  tree_shrub: 'Tree & Shrub',
  mosquito: 'Mosquito',
  rodent_bait: 'Rodent',
  rodent: 'Rodent',
  termite_bait: 'Termite',
  foam_recurring: 'Termite foam',
  palm_injection: 'Palm',
};

function familyLabel(family) {
  return FAMILY_LABELS[family] || String(family || 'service').replace(/_/g, ' ');
}
function lowerLabel(family) {
  const label = familyLabel(family);
  return label === 'Tree & Shrub' ? 'T&S' : label.toLowerCase();
}

const dateOnly = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};
function parseJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || fallback; } catch { return fallback; }
}

/**
 * What the customer accepted: the service families the converter
 * auto-schedules (from its own scheduling units) and, per family, the accepted
 * per-visit price (`prices`: null when it cannot be known for certain). null
 * for a one-time accept or a plan the converter does not auto-schedule. Pure.
 */
function acceptedPlan(estimate) {
  const converter = require('./estimate-converter');
  const { acceptedRecurringBillingLines } = require('./plan-rate-ledger');
  const { inferFrequencyKeyFromEstimateData, legacyRodentRowPredicateFor } = require('./billing-cadence');
  const data = parseJson(estimate.estimate_data);
  if (estimate.accepted_service_mode === 'one_time') return null;
  // The converter's own service set: the termite station-rental rider folds
  // into the bait row, and legacy rodent rows leave the lines (they come back
  // below as a supplement unit), exactly as conversion does.
  const isLegacyRodentRow = legacyRodentRowPredicateFor(data);
  const lines = converter.foldTermiteRentalIntoBait(acceptedRecurringBillingLines(data))
    .filter((line) => !isLegacyRodentRow(line));
  if (converter.shouldSuppressRecurringConversion({
    monthlyRate: estimate.monthly_total, annualTotal: estimate.annual_total,
    oneTimeTotal: estimate.onetime_total, recurringServices: lines, estimateData: data,
  })) return null;
  const acceptedFrequency = data.customerSelection?.frequency || null;
  const fallback = acceptedFrequency || inferFrequencyKeyFromEstimateData(data);
  const family = (line) => converter.seedingFamilyKey(line);
  const supplements = converter.supplementalCompanionLines(data);
  const { remaining, combos, standalone } = converter.combineRecurringServicesForScheduling(lines, {
    acceptFrequency: acceptedFrequency, supplementalCompanions: supplements,
  });
  const families = new Set([
    ...[...remaining, ...standalone.map((unit) => unit.service)].map((service) => [service, [service]]),
    ...combos.map((combo) => [combo.service, combo.combinedFrom]),
  ]
    // Commercial lines, billing riders and contradictory terms are scheduled
    // by the office; they have no auto-seeded cadence to verify here.
    .filter(([service]) => converter.converterFollowUpSeedingPattern(service, {}, fallback, acceptedFrequency))
    .flatMap(([, sources]) => sources.map(family)));
  // A supplement (the legacy rodent monthly dues) counts toward the accepted
  // total only for a family no line already bills, as the combiner dedupes it.
  const lineFamilies = new Set(lines.map(family));
  const dues = supplements.filter((line) => !lineFamilies.has(family(line)));
  return { families, prices: acceptedPrices(converter, lines, families, { estimate, acceptedFrequency, family, dues }) };
}

// The accepted per-visit price of each family: the same per-line rule the
// converter's own price split uses (lineAnnualPerVisitAmount), summed over the
// family's lines. Known only when the lines add up to the accepted annual
// total EXACTLY to the cent, legacy rodent dues included (a manual discount,
// a plan credit or a cadence change breaks that, even by a cent, and a
// guessed price would alert falsely), and only for a family billed by its
// lines (a legacy rodent supplement is monthly dues: no line, no per-visit
// price, but its dues are part of the accepted total).
function acceptedPrices(converter, lines, families, { estimate, acceptedFrequency, family, dues }) {
  const annualCents = Math.round([...lines, ...dues].reduce((sum, line) => sum + converter.recurringLineAnnualAmount(line), 0) * 100);
  const reconciles = Number(estimate.annual_total) > 0 && annualCents === Math.round(Number(estimate.annual_total) * 100);
  const prices = new Map();
  for (const key of families) {
    // One line per family: a family billed through two lines (a termite bond
    // rider beside the bait) is priced by the converter as one whole-plan
    // amount per application that the per-line rule cannot reproduce, so its
    // price is unknown rather than guessed.
    const perVisits = lines.filter((line) => family(line) === key)
      .map((line) => converter.lineAnnualPerVisitAmount(line, acceptedFrequency));
    const known = reconciles && perVisits.length === 1 && perVisits[0] > 0;
    prices.set(key, known ? Math.round(perVisits.reduce((a, b) => a + b, 0) * 100) / 100 : null);
  }
  return prices;
}

/** The service families an accepted estimate auto-schedules (see acceptedPlan). */
function acceptedFamilies(estimate) {
  return acceptedPlan(estimate)?.families || null;
}

// The combined routes that perform two services (from the converter's own
// route table; the bait + bond routes are one service plus a rider), by
// catalog key and by name: when the catalog row is missing the converter
// schedules the combined route by its name alone (no service_id, no key).
function multiServiceRoutes() {
  const converter = require('./estimate-converter');
  return converter.COMBINED_SERVICE_ROUTES
    .filter((route) => converter.comboRouteFamiliesFromCatalogKey(route.catalogServiceKey).length >= 2);
}
const multiServiceRouteKeys = () => [...new Set(multiServiceRoutes().map((route) => route.catalogServiceKey))];
const multiServiceRouteNames = () => [...new Set(multiServiceRoutes().map((route) => route.name))];

/** Service families a scheduled row performs (a combined route spans two). */
function rowFamilies(row) {
  const converter = require('./estimate-converter');
  // A name-only combined route (no catalog row) is read through its route.
  const byName = multiServiceRoutes().find((route) => route.name === row.service_type);
  const identity = row.catalog_service_key || row.service_key_snapshot || byName?.catalogServiceKey;
  const families = converter.comboRouteFamiliesFromCatalogKey(identity);
  return families.length ? families
    : [converter.seedingFamilyKey({ service: identity, name: row.service_type })];
}

// Time + technician on every live row, except a SEASONAL mosquito series
// (catalog mosquito_seasonal, the Feb–Oct program) whose first visit rolled
// past the booking's first day, while its visit is still beyond the routing
// horizon: the converter books it unslotted on purpose until the office
// routes that season (estimate-converter.js, the seasonalMosquito
// promotion), and once a visit is within ROUTING_HORIZON_DAYS it must have
// been routed. A monthly mosquito series is checked like any other.
// Each problem carries `earliest`, the soonest day it affects.
function checkTimeAndTech(dated, families, { firstDay, byId, todayET }) {
  const routingHorizon = todayET ? addDaysET(todayET, ROUTING_HORIZON_DAYS) : null;
  const untimed = new Map();
  const earliest = new Map();
  const seasonalUnslotted = (row) => {
    const root = byId.get(String(row.recurring_parent_id)) || row;
    return (root.catalog_service_key || root.service_key_snapshot) === 'mosquito_seasonal'
      && dateOnly(root.scheduled_date) > firstDay && (!routingHorizon || row.day > routingHorizon);
  };
  for (const row of dated) {
    if (row.window_start && row.technician_id) continue;
    if (seasonalUnslotted(row)) continue;
    for (const family of rowFamilies(row).filter((f) => families.has(f))) {
      untimed.set(family, (untimed.get(family) || 0) + 1);
      if (!earliest.has(family)) earliest.set(family, row.day); // rows arrive in date order
    }
  }
  // In the booking's own service order, so the alert reads pest, lawn, T&S.
  return [...families].filter((family) => untimed.has(family)).map((family) => ({
    code: 'missing_time_tech', families: [family], earliest: earliest.get(family),
    text: `${untimed.get(family)} ${lowerLabel(family)} visits missing time/tech`,
  }));
}

// Price on every upcoming series child that carries one (owner ruling
// 2026-10-02: visit prices only, no invoices). A child bills its own
// estimated_price at completion, so it must be the accepted per-visit price of
// the services it performs (a combined route row: their sum), within two
// cents. Skipped, never guessed: a row with no price (the unpriced-series
// alert's), a prepaid row (prepay coverage bills it), a first visit (the
// first-application invoice's), and any row whose accepted price is unknown.
function checkPrices(dated, families, prices) {
  const off = new Map();
  for (const row of dated) {
    const price = billedServicePrice(row);
    if (!row.recurring_parent_id || row.is_recurring === false || !(price > 0)) continue;
    // Fully covered by a prepayment (markPrepayCovered): its price never bills.
    if (row.prepay_covered) continue;
    // Every service the row performs must have a known accepted price (one
    // the customer did not accept, or whose price is unknown, means the row's
    // price cannot be judged); it is reported under the services being judged.
    const performs = rowFamilies(row);
    const judged = performs.filter((family) => families.has(family));
    const shares = performs.map((family) => (prices.has(family) ? prices.get(family) : null));
    if (!judged.length || shares.some((share) => share == null)) continue;
    const expected = Math.round(shares.reduce((a, b) => a + b, 0) * 100) / 100;
    // In whole cents: float subtraction makes $150.02 - $150 read as just over two cents.
    if (Math.abs(Math.round(price * 100) - Math.round(expected * 100)) <= PRICE_TOLERANCE_CENTS) continue;
    for (const family of judged) {
      const entry = off.get(family) || { count: 0, earliest: row.day, expected, prices: new Map() };
      entry.count += 1;
      entry.prices.set(money(price), (entry.prices.get(money(price)) || 0) + 1);
      off.set(family, entry);
    }
  }
  return [...families].filter((family) => off.has(family)).map((family) => {
    const { count, earliest, expected, prices: seen } = off.get(family);
    // Every distinct wrong price is named; one shared price reads plainly.
    const priced = seen.size === 1 ? [...seen.keys()][0] : [...seen].map(([amount, n]) => `${amount} x${n}`).join(', ');
    return { code: 'price_mismatch', families: [family], earliest, text: `${count} ${lowerLabel(family)} visits priced ${priced}, accepted ${money(expected)}` };
  });
}

// The service charge a visit bills, the way invoicing builds it
// (invoice.js: primary_line_price when stamped, else the visit price): null
// when that cannot be read on its own, that is, the visit carries add-ons
// (row.has_addons, so estimated_price is the appointment total) or any
// line / appointment discount (it cannot be apportioned to the service).
function billedServicePrice(row) {
  const discounted = row.line_discount_id || Number(row.line_discount_amount) > 0 || Number(row.line_discount_dollars) > 0
    || row.discount_id || Number(row.discount_amount) > 0 || Number(row.discount_dollars) > 0;
  if (row.has_addons || discounted) return null;
  const primary = row.primary_line_price;
  return primary != null && primary !== '' ? Number(primary) : Number(row.estimated_price);
}

/**
 * Pure verdict for one accepted estimate.
 *   ctx: { estimate, rows, excludedFamilies: Set, scheduleGaps,
 *          scheduleSkippedFamilies: Set, scheduleOnHoldFamilies: Set, scheduleUnjudged: bool,
 *          todayET: only visits on or after it are judged }
 * Returns null when the accept is not a multi-service recurring accept, or
 * every row of the plan was cancelled (no alert at all); else
 * { ok, deferred, heldFamilies, problems: [{ code, families, text }], labels }.
 */
function evaluateCombinedBooking(ctx) {
  const {
    estimate, rows: allRows = [], excludedFamilies = new Set(),
    scheduleGaps = [], scheduleSkippedFamilies = new Set(), scheduleOnHoldFamilies = new Set(), scheduleUnjudged = false,
    todayET = null,
  } = ctx;
  const plan = acceptedPlan(estimate);
  if (!plan || plan.families.size < 2) return null;
  const accepted = plan.families;
  const isPlanRow = (row, scope) => !row.is_callback && !row.followup_included
    && !(row.is_recurring === false && row.recurring_parent_id)
    && rowFamilies(row).some((family) => scope.has(family));
  // Every row of the accepted plan cancelled (a cancelled plan, or every
  // series stopped for good): nothing left to verify, so nothing to say.
  const acceptedRows = allRows.filter((row) => isPlanRow(row, accepted));
  if (acceptedRows.length && acceptedRows.every((row) => CANCELLED.has(row.status))) return null;
  // Skipped by the classifier for an ACTIVE PLAN HOLD (the one temporary
  // reason): not judged now, and a standing finding about it is kept until it
  // is (the runner's heldProblems). A stopped series is skipped too, but for
  // good: its findings are not kept.
  const heldFamilies = [...accepted].filter((family) => scheduleOnHoldFamilies.has(family));
  const families = new Set([...accepted].filter((family) => !excludedFamilies.has(family) && !scheduleSkippedFamilies.has(family)));
  // Every family on hold / stopped / kept on an older series: nothing to judge
  // now. The runner keeps only the findings about families on hold.
  if (!families.size) return { ok: false, deferred: true, heldFamilies, problems: [], labels: [] };

  // The booking's first day comes from ALL its plan visits, before families on
  // hold or cancelled rows are filtered out (the seasonal exemption is judged
  // against the day the booking really started).
  const firstDay = acceptedRows.map((row) => dateOnly(row.scheduled_date)).sort()[0];
  const planRows = allRows.filter((row) => isPlanRow(row, families));
  const rows = planRows.filter((row) => !NOT_LIVE.has(row.status));
  // Rows were created and every one was cancelled: the customer or office
  // cancelled the plan. Nothing left to verify, so nothing to say.
  if (!rows.length && planRows.length && planRows.every((row) => CANCELLED.has(row.status))) {
    // The services still judged were cancelled; one on hold keeps the booking.
    return heldFamilies.length ? { ok: false, deferred: true, heldFamilies, problems: [], labels: [] } : null;
  }
  const labels = [...families].map(familyLabel);
  // No live rows: the schedule shape is the accepted-schedule alert's.
  if (!rows.length) return { ok: false, deferred: true, heldFamilies, problems: [], labels };

  // Only UPCOMING visits are judged (todayET; none given = every visit): a
  // past visit with no time or technician is history, not something to fix.
  const dated = rows.map((row) => ({ ...row, day: dateOnly(row.scheduled_date) }))
    .filter((row) => !todayET || row.day >= todayET)
    .sort((a, b) => a.day.localeCompare(b.day) || String(a.id).localeCompare(String(b.id)));
  const byId = new Map(allRows.map((row) => [String(row.id), row]));
  const problems = [
    ...checkTimeAndTech(dated, families, { firstDay, byId, todayET }),
    ...checkPrices(dated, families, plan.prices),
  ];
  // Families whose accepted price is unknown: their prices were not checked,
  // so a standing price finding about one is kept (the runner's heldProblems).
  const unpricedFamilies = [...families].filter((family) => plan.prices.get(family) == null);
  // A schedule gap, or an estimate the classifier did not judge, is never OK.
  const deferred = scheduleGaps.length > 0 || scheduleUnjudged;
  return { ok: !problems.length && !deferred, deferred, heldFamilies, unpricedFamilies, problems, labels };
}

function shortName(customer) {
  const first = String(customer?.first_name || '').trim();
  const last = String(customer?.last_name || '').trim();
  if (first && last) return `${first[0].toUpperCase()}. ${last}`;
  return last || first || 'Customer';
}

/**
 * The raiseAdminAlert spec for a verdict with problems (docs/admin-notifications.md:
 * Area, headline <= 60 "Area — what to do", one-sentence why <= 110, a record link,
 * subject, done-when, who). An OK result is an `fyi` fact and writes no row. Pure.
 */
function composeAlert(verdict, { customerName, customerId, estimateId }) {
  const { cutAtWord, MAX_HEADLINE_CHARS, MAX_WHY_CHARS } = require('./admin-alert-compose');
  const HELD_NOTE = { hold: ' (on hold)', price: ' (not re-checked)' };
  const HELD_DETAIL = {
    hold: ' (service on hold; checked again when the hold ends)',
    price: ' (its accepted price cannot be confirmed right now, so it was not re-checked)',
  };
  const texts = verdict.problems.map((problem) => `${problem.text}${HELD_NOTE[problem.held] || ''}`);
  const why = `${texts.slice(0, 2).join('; ')}${texts.length > 2 ? ` (+${texts.length - 2} more)` : ''}`;
  return {
    area: AREA,
    action: cutAtWord(`fix ${customerName || 'Customer'}'s combined booking`, MAX_HEADLINE_CHARS - `${AREA} — `.length),
    why: cutAtWord(`${why.charAt(0).toUpperCase()}${why.slice(1)}.`, MAX_WHY_CHARS),
    severity: 'needs-you',
    link: `/admin/customers?customerId=${encodeURIComponent(customerId)}`,
    subject: { type: 'estimate', id: String(estimateId) },
    doneWhen: DONE_WHEN,
    who: 'person',
    detail: [`${customerName || 'Customer'}: ${verdict.labels.join(' + ')} booking needs a look.`,
      ...verdict.problems.map((problem) => `- ${problem.text}${HELD_DETAIL[problem.held] || ''}`)].join('\n'),
  };
}

// --- database side ---------------------------------------------------------

// row.prepay_covered: the visit is fully paid ahead, so its own price never
// bills and is not price-checked. An out-of-band payment (cash, check, Zelle)
// covers it only when it is at least the visit's price (completion bills the
// rest of a partial one); an annual-prepay stamp only when annualPrepayCoversVisit
// confirms it against a live, paid term, the same authority completion
// trusts (fail-closed: unverifiable reads as not covered).
async function markPrepayCovered(conn, rows) {
  const { annualPrepayCoversVisit } = require('./annual-prepay-renewals');
  const { hasOutOfBandPrepaidStamp } = require('./schedule-integrity-watchdog');
  for (const row of rows) {
    row.prepay_covered = false;
    const paid = Number(row.prepaid_amount);
    if (!(Number(row.estimated_price) > 0)) continue;
    if (paid > 0 && hasOutOfBandPrepaidStamp(row)) { row.prepay_covered = paid + 0.005 >= Number(row.estimated_price); continue; }
    // The coverage authority also covers an UNSTAMPED termite renewal visit
    // during the payment-pending grace window, so a termite visit is asked
    // even with no stamp; any other unstamped visit has nothing to ask about.
    if (!(paid > 0) && !row.annual_prepay_term_id && !rowFamilies(row).includes('termite_bait')) continue;
    try {
      row.prepay_covered = await annualPrepayCoversVisit(row, conn) === true;
    } catch (err) {
      logger.warn(`[combined-booking-check] prepay coverage unverifiable for a visit: ${err.message}`);
    }
  }
}

async function loadContext(conn, estimate) {
  const estimateId = estimate.id;
  const customerId = estimate.customer_id;
  const skipped = await conn('activity_log')
    .where({ customer_id: customerId, action: 'recurring_series_skipped' }).select('metadata');
  // The duplicate-series guard keeps a customer's existing series instead of
  // seeding a second one; that family has no rows of THIS estimate by design.
  const retainedParentIds = skipped.map((event) => parseJson(event.metadata))
    .filter((meta) => String(meta.estimateId) === String(estimateId) && meta.existingParentId)
    .map((meta) => meta.existingParentId);
  const excludedFamilies = new Set();
  if (retainedParentIds.length) {
    const retained = await conn('scheduled_services as s').leftJoin('services as catalog', 'catalog.id', 's.service_id')
      .whereIn('s.id', retainedParentIds)
      .select('s.service_type', 's.service_key_snapshot', 'catalog.service_key as catalog_service_key');
    for (const row of retained) for (const family of rowFamilies(row)) excludedFamilies.add(family);
  }
  const rows = await conn('scheduled_services as s')
    .leftJoin('services as catalog', 'catalog.id', 's.service_id')
    .where('s.customer_id', customerId)
    .where(function linkedToEstimate() {
      this.where('s.source_estimate_id', estimateId).orWhereIn('s.recurring_parent_id', function parents() {
        this.select('id').from('scheduled_services').where({ source_estimate_id: estimateId, customer_id: customerId });
      });
    })
    // Whole row: annualPrepayCoversVisit validates prepay coverage from the row itself.
    .select('s.*', 'catalog.service_key as catalog_service_key', 'catalog.billing_type as catalog_billing_type',
      conn.raw("to_char(s.scheduled_date, 'YYYY-MM-DD') as scheduled_date"));
  await markPrepayCovered(conn, rows);
  // A visit with add-ons: its estimated_price is the appointment total, not the service.
  const withAddons = rows.length ? new Set((await conn('scheduled_service_addons')
    .whereIn('scheduled_service_id', rows.map((row) => row.id)).distinct('scheduled_service_id'))
    .map((addon) => String(addon.scheduled_service_id))) : new Set();
  for (const row of rows) row.has_addons = withAddons.has(String(row.id));
  const customer = await conn('customers').where({ id: customerId }).first('first_name', 'last_name');
  return {
    estimate,
    rows: rows.filter((row) => row.catalog_billing_type !== 'one_time'),
    excludedFamilies, customerName: shortName(customer),
  };
}

// `coverage` is the classifier's { skipped, onHold } for this estimate;
// undefined when it did not judge the estimate (never declared OK then).
async function checkEstimate(conn, estimate, { scheduleGaps = [], coverage, todayET = null } = {}) {
  const ctx = {
    ...await loadContext(conn, estimate),
    scheduleGaps,
    todayET,
    scheduleSkippedFamilies: coverage ? coverage.skipped : new Set(),
    scheduleOnHoldFamilies: coverage ? coverage.onHold : new Set(),
    scheduleUnjudged: !coverage,
  };
  const verdict = evaluateCombinedBooking(ctx);
  return verdict ? { verdict, ctx } : null;
}

function dedupeKeyFor(estimateId) {
  return `${OPS_KEY}:${estimateId}`;
}

// A problem's ring identities: the service families it affects. A bell rings
// again only when a NEW family joins it (a fixed lawn problem replaced by a
// pest one), never for a second kind of problem on a family it already carries.
function problemKeys(problem) {
  return problem.families || [];
}

// A bell's stored identities as families: bells written before identities
// became family-only carry `code:family` (e.g. missing_time_tech:lawn_care).
function storedFamilies(itemKeys) {
  return new Set((Array.isArray(itemKeys) ? itemKeys : []).map((key) => String(key).split(':').pop()));
}

// A refresh rings only when a problem is new: an identity the standing row
// did not already carry.
function ringOnNewProblem(keys) {
  return (existing, existingMeta) => {
    const known = storedFamilies(existingMeta?.itemKeys);
    return keys.some((key) => !known.has(key));
  };
}

// Closes the standing bells for these estimates as DONE (docs/admin-notifications.md
// section 4: read is not done; a system close spreads doneColumns and selects
// openToCloser's rows). The dedupeKey is dropped, like resolveOpsDigest does, so a
// problem that comes back posts a fresh bell that rings instead of refreshing a
// closed one in silence.
async function retireStanding(conn, estimateIds, resolution) {
  if (!estimateIds.length) return 0;
  const { doneColumns, openToCloser } = require('./notification-service')._private;
  const query = conn('notifications').where({ recipient_type: 'admin', category: CATEGORY })
    .whereRaw("metadata->>'dedupeKey' = ANY(?)", [estimateIds.map(dedupeKeyFor)]);
  return openToCloser(query, OPS_KEY).update({
    ...doneColumns({ by: OPS_KEY, resolution, keepExisting: true, conn }),
    metadata: conn.raw("(COALESCE(metadata, '{}'::jsonb) - 'dedupeKey') || ?::jsonb", [JSON.stringify({
      resolved: true, resolvedAt: new Date().toISOString(), resolvedBy: OPS_KEY,
    })]),
  });
}

async function postAlert(estimate, verdict, ctx, { raise } = {}) {
  const raiseAdminAlert = raise || require('./admin-alert-compose').raiseAdminAlert;
  const { detail, ...spec } = composeAlert(verdict, {
    customerName: ctx.customerName, customerId: estimate.customer_id, estimateId: estimate.id,
  });
  const keys = [...new Set(verdict.problems.flatMap(problemKeys))];
  return raiseAdminAlert(CATEGORY, spec, {
    // Under GATE_ADMIN_BELL_POLICY the 'alert' category is denied unless the
    // call site tags it (the schedule-integrity watchdog's own bells do too).
    bell: true,
    detail,
    dedupeKey: dedupeKeyFor(estimate.id),
    refreshOnDedupe: true,
    ringOnRefresh: ringOnNewProblem(keys),
    metadata: {
      opsKey: OPS_KEY,
      alertClass: OPS_KEY,
      estimateId: estimate.id,
      customerId: estimate.customer_id,
      problemCodes: verdict.problems.map((problem) => problem.code),
      // The findings themselves, so a later run can keep one about a service
      // that went on hold (heldProblems).
      problems: verdict.problems.map(({ code, families, text }) => ({ code, families, text })),
      // count + itemKeys are the ring-stamps notifyAdmin compares on a
      // refresh, so a changed problem set is treated as a real change.
      count: keys.length,
      itemKeys: keys,
    },
  });
}

// Standing bells whose estimate has left the sweep for good (the customer was
// deactivated, deleted or moved to a former-customer stage, the estimate
// archived or no longer accepted): nothing is left to act on, so they close.
// A bell that only aged past the lookback stays open for a person.
async function retireAbandoned(conn) {
  const { FORMER_CUSTOMER_STAGES } = require('./customer-stages');
  const gone = await conn('notifications as n')
    .leftJoin('estimates as e', conn.raw("e.id::text = n.metadata->>'estimateId'"))
    .leftJoin('customers as c', 'c.id', 'e.customer_id')
    .where({ 'n.recipient_type': 'admin', 'n.category': CATEGORY })
    .whereRaw("starts_with(n.metadata->>'dedupeKey', ?)", [`${OPS_KEY}:`])
    .whereRaw("n.metadata->>'estimateId' IS NOT NULL")
    .where(function goneForGood() {
      this.whereNull('e.id').orWhereNot('e.status', 'accepted').orWhereNotNull('e.archived_at')
        .orWhereNot('c.active', true).orWhereNotNull('c.deleted_at').orWhereIn('c.pipeline_stage', FORMER_CUSTOMER_STAGES);
    })
    .select(conn.raw("n.metadata->>'estimateId' as estimate_id"));
  return retireStanding(conn, [...new Set(gone.map((row) => row.estimate_id))], RESOLVED_GONE);
}

// A standing bell's findings this run could not re-judge stay on the bell
// (marked) instead of closing as fixed: any finding about a service now on
// hold, and a price finding about a service whose accepted price is unknown.
function heldProblems(verdict, standingProblems = []) {
  const onHold = new Set(verdict.heldFamilies || []);
  const unpriced = new Set(verdict.unpricedFamilies || []);
  const reasonFor = (problem) => {
    const families = problem?.families || [];
    if (families.some((family) => onHold.has(family))) return 'hold';
    if (problem?.code === 'price_mismatch' && families.some((family) => unpriced.has(family))) return 'price';
    return null;
  };
  return standingProblems.filter(reasonFor)
    .map((problem) => ({ code: problem.code, families: problem.families, text: problem.text, held: reasonFor(problem) }));
}

// What a sweep does with one verdict, given the standing bell's findings:
//   skipped  — not a combined booking any more (the plan was cancelled): close
//   problems — post / refresh the bell (current findings plus held ones)
//   ok       — verified: close a standing bell as fixed
//   deferred — nothing of this check's own to say: close
function outcomeOf(verdict, standingProblems = []) {
  if (!verdict) return { outcome: 'skipped', problems: [] };
  const problems = [...verdict.problems, ...heldProblems(verdict, standingProblems)];
  if (problems.length) return { outcome: 'problems', problems };
  return { outcome: verdict.ok ? 'ok' : 'deferred', problems };
}

// The estimates with an open bell of this check: always judged, so a bell is
// only ever closed by a run that looked at its booking.
async function standingEstimateIds(conn) {
  const rows = await conn('notifications').where({ recipient_type: 'admin', category: CATEGORY })
    .whereRaw("starts_with(metadata->>'dedupeKey', ?)", [`${OPS_KEY}:`])
    .whereRaw("metadata->>'estimateId' IS NOT NULL")
    .select(conn.raw("metadata->>'estimateId' as estimate_id"));
  return rows.map((row) => String(row.estimate_id));
}

// Accepted estimates to judge: every one that still has an UPCOMING live
// visit with no time or no technician, or (daily run) an upcoming priced
// series child to price-check, whenever it was accepted (a problem still ahead
// is worth a bell; one in the past is history), plus every one with an open
// bell (so a fix or a cancelled plan closes it).
// `lastDay` (urgent pass) limits the untimed visits that make a candidate to
// today and tomorrow.
function candidateQuery(conn, { now, todayET, standing, lastDay = null }) {
  const { FORMER_CUSTOMER_STAGES } = require('./customer-stages');
  const settled = new Date(now.getTime() - SETTLE_MINUTES * 60 * 1000);
  return conn('estimates as e')
    .join('customers as c', 'c.id', 'e.customer_id')
    .where('e.status', 'accepted').whereNull('e.archived_at')
    .where('e.accepted_at', '<=', settled)
    .where(function upcomingGapOrOpenBell() {
      this.whereIn('e.id', standing).orWhereExists(function untimedUpcoming() {
        this.select(conn.raw('1')).from('scheduled_services as s')
          .whereRaw('s.customer_id = e.customer_id')
          .where(function linkedToEstimate() {
            this.whereRaw('s.source_estimate_id = e.id').orWhereExists(function parentLinked() {
              this.select(conn.raw('1')).from('scheduled_services as p')
                .whereRaw('p.id = s.recurring_parent_id AND p.source_estimate_id = e.id AND p.customer_id = e.customer_id');
            });
          })
          .where('s.scheduled_date', '>=', todayET)
          .modify((query) => { if (lastDay) query.where('s.scheduled_date', '<=', lastDay); })
          .whereNotIn('s.status', [...NOT_LIVE])
          .where(function untimedOrPriced() {
            this.whereNull('s.window_start').orWhereNull('s.technician_id');
            // The daily run also judges every upcoming PRICED series child
            // (checkPrices), but only on a booking whose series come from two or
            // more services, or one combined route that performs two (pest +
            // termite bait, lawn + T&S), or that kept another service's existing
            // series (the duplicate-series guard), decided in SQL so the large
            // single-service population is never loaded; the urgent pass is
            // about time and technician only.
            if (!lastDay) {
              this.orWhere((priced) => priced.whereNotNull('s.recurring_parent_id').where('s.estimated_price', '>', 0)
                .whereRaw(`((SELECT COUNT(DISTINCT COALESCE(r.service_id::text, r.service_type)) FROM scheduled_services r
                  WHERE r.source_estimate_id = e.id AND r.customer_id = e.customer_id AND r.recurring_parent_id IS NULL) >= 2
                  OR EXISTS (SELECT 1 FROM scheduled_services r LEFT JOIN services cat ON cat.id = r.service_id
                    WHERE r.source_estimate_id = e.id AND r.customer_id = e.customer_id AND r.recurring_parent_id IS NULL
                      AND (COALESCE(cat.service_key, r.service_key_snapshot) = ANY(?) OR r.service_type = ANY(?)))
                  OR EXISTS (SELECT 1 FROM activity_log a WHERE a.customer_id = e.customer_id
                    AND a.action = 'recurring_series_skipped' AND a.metadata->>'estimateId' = e.id::text))`, [multiServiceRouteKeys(), multiServiceRouteNames()]));
            }
          });
      });
    })
    .where('c.active', true).whereNull('c.deleted_at')
    // A former customer's leftover work is the churned-live-work alert's
    // (cancel it), never a repair bell here; the shared classifier skips the
    // same stages.
    .where(function currentCustomer() {
      this.whereNotIn('c.pipeline_stage', FORMER_CUSTOMER_STAGES).orWhereNull('c.pipeline_stage');
    })
    .where(function recurringAccept() {
      this.whereNull('e.accepted_service_mode').orWhereNot('e.accepted_service_mode', 'one_time');
    })
    .select('e.id', 'e.customer_id', 'e.property_id', 'e.estimate_data', 'e.accepted_service_mode', 'e.accepted_at',
      'e.monthly_total', 'e.annual_total', 'e.onetime_total')
    .orderBy('e.accepted_at', 'asc');
}

// The soonest day a booking's problems affect (a held finding has none, so it
// sorts last).
const earliestDay = (problems) => problems.map((problem) => problem.earliest).filter(Boolean).sort()[0] || '9999-12-31';

// A bell that actually rang this run (created, or a refresh that rang): what
// the budget counts. A silent refresh or a suppressed test row costs nothing.
const rang = (row) => !!row && !row.suppressed && (!row.deduped || row.rung === true);

/**
 * One sweep. Returns counts; never throws for a single bad estimate.
 * `conn` and `raise` are injectable for tests. `ringBudget` is what is left
 * of the run's shared budget (the watchdog passes its remainder): anything
 * not time-critical that would ring past it is left for a later run, where
 * the same upcoming problem is found again (nothing to persist, nothing ages
 * out). A TIME-CRITICAL problem (a visit today or tomorrow) always rings:
 * docs/admin-notifications.md, Budget, owner ruling 2026-10-01.
 * `urgentOnly` is the hourly pass (scheduler.js): only bookings with an
 * untimed visit today or tomorrow, so a booking made or changed after the
 * daily run, or a write that failed, is caught the same day.
 */
async function runCombinedBookingCheck({ now = new Date(), conn = db, raise, ringBudget = DEFAULT_RING_BUDGET, urgentOnly = false } = {}) {
  const { etDateString } = require('../utils/datetime-et');
  const todayET = etDateString(now);
  const tomorrowET = addDaysET(todayET, 1);
  const result = { candidates: 0, checked: 0, ok: 0, problems: 0, deferred: 0, skipped: 0, failed: 0, closed: 0, held: 0 };
  result.closed += await retireAbandoned(conn);
  // An internal test / demo customer never gets an admin artifact (the
  // notification service suppresses its bells): left out up front.
  const { isInternalTestCustomerId } = require('./internal-test-customers');
  const candidates = (await candidateQuery(conn, {
    now, todayET, standing: urgentOnly ? [] : await standingEstimateIds(conn), lastDay: urgentOnly ? tomorrowET : null,
  }))
    .filter((estimate) => !isInternalTestCustomerId(estimate.customer_id));
  result.candidates = candidates.length;

  // A standing bell's itemKeys say what it already rang for; its problems are
  // what a service on hold keeps (heldProblems).
  const standing = new Map((await conn('notifications')
    .where({ recipient_type: 'admin', category: CATEGORY })
    .whereRaw("metadata->>'dedupeKey' = ANY(?)", [candidates.map((estimate) => dedupeKeyFor(estimate.id))])
    .select(conn.raw("metadata->>'estimateId' as estimate_id"), conn.raw("metadata->'itemKeys' as item_keys"),
      conn.raw("metadata->'problems' as problems")))
    .map((row) => [String(row.estimate_id), {
      keys: storedFamilies(row.item_keys),
      problems: Array.isArray(row.problems) ? row.problems : [],
    }]));
  // No longer a combined booking (the accepted snapshot was corrected to one
  // service, or no longer converts): an open bell for it is closed.
  const notCombined = [];
  const work = candidates.filter((estimate) => {
    try {
      if ((acceptedFamilies(estimate)?.size || 0) >= 2) return true;
      result.skipped += 1;
      if (standing.has(String(estimate.id))) notCombined.push(String(estimate.id));
    } catch (err) {
      result.failed += 1;
      logger.warn(`[combined-booking-check] estimate ${estimate.id} could not be read: ${err.message}`);
    }
    return false;
  });
  result.closed += await retireStanding(conn, notCombined, RESOLVED_GONE);

  // The shared accepted-plan classifier, with no 24h wait: the same findings
  // the watchdog's accepted-schedule alerts are built from, plus which
  // estimates it judged and which families it skipped on each.
  const coverage = new Map();
  const gaps = work.length ? await require('./recurring-schedule-audit')
    .acceptedRecurringScheduleGaps(conn, { now, cutoff: now, estimateIds: work.map((estimate) => estimate.id), coverage }) : [];

  // Judge everything first, then post the problems soonest-first, so the
  // budget is spent where a visit is closest.
  const toPost = [];
  for (const estimate of work) {
    const id = String(estimate.id);
    const known = standing.get(id);
    try {
      const checked = await checkEstimate(conn, estimate, {
        scheduleGaps: gaps.filter((gap) => String(gap.estimateId) === id),
        coverage: coverage.get(id),
        todayET,
      });
      const { outcome, problems } = outcomeOf(checked?.verdict, known?.problems);
      if (outcome !== 'problems') {
        result[outcome] += 1;
        if (known) result.closed += await retireStanding(conn, [id], outcome === 'skipped' ? RESOLVED_GONE : RESOLVED_FIXED);
        continue;
      }
      result.checked += 1;
      toPost.push({ estimate, known, verdict: { ...checked.verdict, problems }, ctx: checked.ctx, earliest: earliestDay(problems) });
    } catch (err) {
      result.failed += 1;
      logger.warn(`[combined-booking-check] estimate ${id} check failed: ${err.message}`);
    }
  }

  await postInUrgencyOrder(toPost, result, { raise, ringBudget, urgentOnly, tomorrowET });
  return result;
}

// Posts the judged problems soonest-first, so the budget goes where a visit
// is closest. Anything that would ring (a new bell, or a standing one gaining
// a family it did not carry) spends the budget; past it the booking is left
// as it is and found again on a later run. A TIME-CRITICAL problem (a visit
// today or tomorrow) always rings. The urgent pass posts nothing else.
async function postInUrgencyOrder(toPost, result, { raise, ringBudget, urgentOnly, tomorrowET }) {
  let rings = 0;
  for (const { estimate, known, verdict, ctx, earliest } of toPost.sort((a, b) => a.earliest.localeCompare(b.earliest))) {
    const timeCritical = earliest <= tomorrowET;
    const wouldRing = !known || verdict.problems.flatMap(problemKeys).some((key) => !known.keys.has(key));
    if (!timeCritical && (urgentOnly || (wouldRing && rings >= ringBudget))) {
      result.held += 1;
      continue;
    }
    const row = await postAlert(estimate, verdict, ctx, { raise });
    if (!row) { result.failed += 1; logger.warn(`[combined-booking-check] alert write failed for estimate ${estimate.id}`); continue; }
    if (rang(row)) rings += 1;
    result.problems += 1;
  }
}

module.exports = {
  runCombinedBookingCheck,
  checkEstimate,
  evaluateCombinedBooking,
  composeAlert,
  postAlert,
  ringOnNewProblem,
  problemKeys,
  outcomeOf,
  heldProblems,
  acceptedFamilies,
  acceptedPlan,
  markPrepayCovered,
  shortName,
  OPS_KEY,
  DONE_WHEN,
};
