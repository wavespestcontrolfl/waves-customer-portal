// Returning customer WaveGuard setup fee rule (owner 2026-11-24, GATE_RETURNING_SETUP_FEE_GAP).
//
// A customer who cancelled and comes back owes the $99 WaveGuard setup fee again ONLY when the gap
// from their last completed visit of the same plan family to now is longer than one plan cycle plus
// 30 days. Quarterly: up to 91 + 30 = 121 days is waived; bi-monthly up to 91; monthly up to 60.
//
// The existing-member waiver (membershipSnapshot.isExistingCustomer) covers accounts with an ACTIVE
// qualifying plan only. This covers the account whose plan lapsed.
//
// How it reaches a price (owner 2026-11-25: automatic, no staff step):
//   1. The history read (loadReturningVisitHistory) runs once, before pricing, from the verified customer.
//   2. The decision runs on the SERVER-priced plan (mapWithReturningWaiver), inside the one pricing step a
//      save and the estimate tool's preview share. It marks the raw engine result, so the mapper leaves the
//      fee out of the totals for pest and mosquito alike, and a technician's price digest sees it.
//   3. The answer is stored as the operator waiver every setup-fee reader already honors
//      (operatorPriceAdjustment.waiveSetupFee), with the evidence beside it (returningCustomerGap).
// Every write that re-prices a quote decides again (dropReturningSetupWaiver, then the history): a stored or
// posted copy of the rule's answer is never carried to a new price, so it never reaches a plan it was not
// decided for. A read-only replay (the page, a reconcile) honors the stored answer for the plan family it names.
//
// Where the rule decides: the staff save and its preview (admin-estimate-persistence, property-lookup-v2), a
// customer's own service change on the estimate page (estimate-public applyServiceMixChange), the plan-restart
// quote (cancellation-resolution/restart) and the website quote with its self-booking (public-quote, as a zero
// setupFeeQuote with waived: 'returning_customer'). Every other quote writer charges the fee as before.

const logger = require('./logger');
const { dateOnlyString } = require('../utils/date-only');

const GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function returningSetupFeeGapLive() {
  return process.env.GATE_RETURNING_SETUP_FEE_GAP === 'true';
}

// Days in one plan cycle for a visit count a year (quarterly 4 -> 91).
function cycleDaysForVisitsPerYear(visitsPerYear) {
  const visits = Number(visitsPerYear);
  if (!Number.isFinite(visits) || visits <= 0) return null;
  return Math.round(365 / visits);
}

function windowDaysForVisitsPerYear(visitsPerYear) {
  const cycle = cycleDaysForVisitsPerYear(visitsPerYear);
  return cycle == null ? null : cycle + GRACE_DAYS;
}

// Days in an OLD series' cycle. A month-walk plan (the scheduler's MONTH_RECURRENCE_INTERVALS, plus
// monthly_nth_weekday) uses the owner's fixed cycle, months x 365 / 12 (owner 2026-11-24: monthly 30,
// bi-monthly 61, quarterly 91, so the windows are 60 / 91 / 121), never a weekday-aligned projection. Every other
// pattern the scheduler places (daily, weekly, biweekly, every_6_weeks, custom, the Feb-Oct season, lawn rounds)
// reads the next date the scheduler itself would place (nextRecurringDate; a custom series with no interval takes
// the scheduler's fallback gap). Null when the scheduler does not place it: the caller then falls back to the new
// plan's cadence.
function oldSeriesCycleDays(visit = {}) {
  // A legacy child with no pattern of its own follows its parent series' cadence.
  const row = visit.recurring_pattern || !visit.parent_pattern ? visit : {
    ...visit, recurring_pattern: visit.parent_pattern, recurring_interval_days: visit.parent_interval_days,
    recurring_nth: visit.parent_nth, recurring_weekday: visit.parent_weekday,
  };
  const seeder = require('./recurring-appointment-seeder');
  // Legacy spellings (bi-monthly, Quarterly, 6x) read as the scheduler reads them; monthly_nth_weekday and the
  // other canonical names the scheduler places stay as stored.
  const raw = String(row.recurring_pattern || '').trim();
  if (!raw || raw === 'one_time') return null;
  const pattern = raw === 'monthly_nth_weekday' || seeder.schedulerPlacesPattern(raw)
    ? raw : (seeder.normalizeRecurringPattern(raw) || raw);
  const months = pattern === 'monthly_nth_weekday' ? 1 : seeder.MONTH_RECURRENCE_INTERVALS[pattern];
  if (months) return Math.round((months * 365) / 12);
  if (!seeder.schedulerPlacesPattern(pattern)) return null;
  // The series slot the visit holds (a moved visit keeps its original slot), as the scheduler walks it.
  const last = seeder.seriesCadencePosition(row) || dateOnlyString(row.scheduled_date);
  if (!last) return null;
  // A lawn-rounds walk places from its series anchor (the parent's, as the scheduler reads it), never the visit's day.
  const series = row.recurring_parent_id ? {
    recurring_round_anchor_date: row.parent_round_anchor, scheduled_date: row.parent_scheduled_date,
    recurring_dispatch_due_date: row.parent_dispatch_due_date, date_exception: row.parent_date_exception,
    date_exception_cadence_date: row.parent_date_exception_cadence_date,
  } : row;
  const next = seeder.nextRecurringDate(last, pattern, 1, {
    nth: row.recurring_nth, weekday: row.recurring_weekday, intervalDays: row.recurring_interval_days,
    roundAnchor: seeder.seriesRoundAnchor(series) || undefined,
  });
  const days = next ? daysBetween(last, next) : null;
  return days != null && days > 0 ? days : null;
}

function daysBetween(fromKey, toKey) {
  const from = Date.parse(`${fromKey}T00:00:00Z`);
  const to = Date.parse(`${toKey}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / DAY_MS);
}

// The visit's CURRENT closeout outcome (a reopened visit is judged by its newest record, as paf-prepay-release
// reads it). inspection_only / customer_declined / incomplete performed no application.
// The day the visit was performed: the newest closeout's service_date, the scheduled day only when no record has one.
const PERFORMED_DATE_SQL = `(SELECT r3.service_date FROM service_records r3
  WHERE r3.scheduled_service_id = s.id ORDER BY r3.created_at DESC, r3.id DESC LIMIT 1) as performed_date`;
const completedMs = (row) => {
  const ms = row.completed_at ? new Date(row.completed_at).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
};
const performedKey = (row) => dateOnlyString(row.performed_date) || dateOnlyString(row.scheduled_date);
// The series columns a lawn-rounds walk needs (seriesRoundAnchor): the parent's, joined as p.
const SERIES_COLUMNS = ['s.recurring_round_anchor_date', 's.recurring_dispatch_due_date', 's.date_exception',
  's.date_exception_cadence_date', 'p.recurring_round_anchor_date as parent_round_anchor',
  'p.scheduled_date as parent_scheduled_date', 'p.recurring_dispatch_due_date as parent_dispatch_due_date',
  'p.date_exception as parent_date_exception', 'p.date_exception_cadence_date as parent_date_exception_cadence_date',
  'p.recurring_pattern as parent_pattern', 'p.recurring_interval_days as parent_interval_days',
  'p.recurring_nth as parent_nth', 'p.recurring_weekday as parent_weekday', 's.id as visit_id', 's.completed_at'];

const LATEST_OUTCOME_SQL = `(SELECT r2.structured_notes ->> 'visitOutcome' FROM service_records r2
  WHERE r2.scheduled_service_id = s.id ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1) as visit_outcome`;
// What the visit's newest closeout froze (complete-scheduled-service.js, pest-recap.js): the service it completed
// (completedServiceKey with the label of that day; a frozen null key is a visit with no catalog service), its
// add-on lines (completedAddonLines) and its place in a plan series (completedSeries). The schedule row and its
// lines can be edited after the visit; the closeout holds what was performed. On a closeout from before each
// freeze, `primary` is false and `addonLines` / `series` are null.
const FROZEN_IDENTITY_SQL = `(SELECT jsonb_build_object(
    'primary', (r4.service_data -> 'completedServiceKey') IS NOT NULL,
    'key', r4.service_data ->> 'completedServiceKey',
    'name', r4.service_data ->> 'completedServiceName',
    'addonLines', r4.service_data -> 'completedAddonLines',
    'series', r4.service_data -> 'completedSeries')
  FROM service_records r4 WHERE r4.scheduled_service_id = s.id ORDER BY r4.created_at DESC, r4.id DESC LIMIT 1) as frozen`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const frozenPrimary = (visit) => (visit.frozen && visit.frozen.primary ? visit.frozen : null);
// The frozen add-on lines a plan read can classify: by the frozen catalog key, else by the catalog id (as
// pest-insider/home.js reads a line), else by the saved label alone. The schedule takes a line typed with no
// catalog service ("Mosquito Control", monthly), and the schedule read classifies that line by its label too.
// Null when the closeout froze no list.
const lineLabel = (value) => (typeof value === 'string' ? value.trim() : '');
const frozenAddonLines = (visit) => (Array.isArray(visit.frozen && visit.frozen.addonLines)
  ? visit.frozen.addonLines.filter((line) => line && typeof line === 'object'
    && (line.serviceKey || UUID_RE.test(line.serviceId) || lineLabel(line.serviceName)))
  : null);

// The catalog rows the frozen identities name: one read, and none when no closeout froze a service.
async function frozenCatalogRows(database, visitRows) {
  const lines = visitRows.flatMap((visit) => frozenAddonLines(visit) || []);
  const keys = [...new Set([
    ...visitRows.map((visit) => frozenPrimary(visit) && visit.frozen.key),
    ...lines.map((line) => line.serviceKey),
  ].filter(Boolean))];
  const ids = [...new Set(lines.map((line) => line.serviceId).filter((id) => UUID_RE.test(id)))];
  if (!keys.length && !ids.length) return [];
  return database('services').whereIn('service_key', keys).orWhereIn('id', ids)
    .select('id', 'service_key', 'name', 'billing_type');
}

// The series columns of one visit, as oldSeriesCycleDays and the plan-series classifier read them.
const VISIT_SERIES_COLUMNS = ['s.scheduled_date', 's.is_recurring', 's.recurring_parent_id', 's.recurring_pattern',
  's.recurring_interval_days', 's.recurring_nth', 's.recurring_weekday', 's.is_callback', 's.followup_included'];

// A completed visit's place in a plan series: whether it was a plan application (the shared classifier:
// isPlanSeriesRow drops one-time visits, boosters, callbacks and included follow-ups, and keeps legacy children
// whose is_recurring is null), and its series' cycle in days. The closeout freezes both (completedSeries, below):
// a frequency change rewrites the series root's schedule row after its visits completed. A closeout from before
// the freeze reads the schedule row.
function seriesFacts(row) {
  const frozen = row.frozen && row.frozen.series;
  if (frozen && typeof frozen === 'object') return { plan_visit: frozen.planVisit === true, cycle_days: frozen.cycleDays ?? null };
  return { plan_visit: require('./recurring-series-cancel-reseed').isPlanSeriesRow(row), cycle_days: oldSeriesCycleDays(row) };
}

// The cycle of an add-on line that has a cadence of its own, walked from the series slot its visit holds: a
// September seasonal round performed in October still runs September to October, never October to February.
// The performed day only measures the gap. Null for a line that rides its visit's cadence, and for one
// application (one_time).
function addonLineCycleDays(visitRow, { pattern, intervalDays, nth, weekday }) {
  return pattern ? oldSeriesCycleDays({
    ...visitRow, recurring_pattern: pattern, recurring_interval_days: intervalDays, recurring_nth: nth, recurring_weekday: weekday,
  }) : null;
}

// What a visit's completion freezes for this rule, from one read of the visit's schedule row in a savepoint of
// the completion's transaction:
//   series      service_data.completedSeries (seriesFacts reads it)
//   addonLines  the completion's frozen add-on lines (frozenAddonLinesForCompletion), each line that has a
//               cadence of its own with that cadence's cycle (recurrence.cycleDays); null when no list was frozen
// Both completion writers call it, fail-soft: with no frozen facts the history read falls back to the schedule.
async function frozenPlanSeriesForCompletion(scheduledServiceId, trx, addonLines = null) {
  const row = await require('../utils/savepoint-read').savepointRead(trx, (k) => k('scheduled_services as s')
    .leftJoin('scheduled_services as p', 's.recurring_parent_id', 'p.id')
    .where({ 's.id': scheduledServiceId })
    .first(...VISIT_SERIES_COLUMNS, ...SERIES_COLUMNS));
  if (!row) return null;
  const withCycle = (line) => (line && line.recurrence && line.recurrence.pattern
    ? { ...line, recurrence: { ...line.recurrence, cycleDays: addonLineCycleDays(row, line.recurrence) } }
    : line);
  return {
    series: {
      planVisit: require('./recurring-series-cancel-reseed').isPlanSeriesRow(row),
      pattern: row.recurring_pattern || row.parent_pattern || null,
      cycleDays: oldSeriesCycleDays(row),
    },
    addonLines: Array.isArray(addonLines) ? addonLines.map(withCycle) : null,
  };
}

// A completed visit as the plan classifier reads it. The closeout's frozen service is what was performed: its
// catalog key with that catalog row's facts, and the label of that day (a frozen null key reads by the label). A
// closeout from before the freeze reads the schedule row: the linked service, then the stored key, then the label.
function completedVisitRow(visit, catalog) {
  const frozen = frozenPrimary(visit);
  if (!frozen) return { ...visit, service_key: visit.service_key || visit.service_key_snapshot, ...seriesFacts(visit) };
  const entry = (frozen.key && catalog.find((svc) => svc.service_key === frozen.key)) || {};
  return {
    ...visit,
    ...seriesFacts(visit),
    service_type: frozen.name || null,
    service_key: frozen.key || null,
    service_key_snapshot: null,
    service_name: entry.name || null,
    catalog_billing_type: entry.billing_type || null,
  };
}

// The schedule line a frozen line was frozen from: the same service on the same visit (the catalog id, else the
// stored key, else the label of a line saved with neither).
function sameAddonLine(row, line) {
  if (UUID_RE.test(line.serviceId)) return String(row.addon_service_id) === String(line.serviceId);
  if (row.addon_service_id) return false;
  return line.serviceKey ? row.service_key_snapshot === line.serviceKey
    : !row.service_key_snapshot && lineLabel(row.service_type) === lineLabel(line.serviceName);
}

// How a frozen add-on line was sold: its own cadence (no pattern rides the visit's; one_time is one application).
// The closeout freezes it (recurrence, with the cadence's cycle). An older closeout did not: the cadence is then
// the schedule line of the same visit and service, while that line exists. With neither there is no proof the
// line was a plan line (one application of a recurring catalog service is sold as a one_time line), so it is
// never evidence.
function frozenLineCadence(line, visit, scheduleRows) {
  const frozen = line.recurrence && typeof line.recurrence === 'object' ? line.recurrence : null;
  if (frozen) {
    return {
      line_pattern: frozen.pattern || null, line_interval_days: frozen.intervalDays, line_nth: frozen.nth,
      line_weekday: frozen.weekday, line_cycle_days: frozen.cycleDays,
    };
  }
  const scheduled = scheduleRows.find((row) => row.visit_id === visit.visit_id && sameAddonLine(row, line));
  return scheduled ? {
    line_pattern: scheduled.line_pattern, line_interval_days: scheduled.line_interval_days,
    line_nth: scheduled.line_nth, line_weekday: scheduled.line_weekday,
  } : null;
}

// An add-on line as the plan classifier reads it: its visit's series facts, with the line's own cycle when the
// line has its own cadence (a line with none rides the visit's, frozen or not). The cycle is the one the closeout
// froze (line_cycle_days; a frozen null is a cadence the scheduler does not place). A closeout that froze none
// walks the schedule row's slot.
function addonLineRow(row) {
  const walked = () => addonLineCycleDays(row, {
    pattern: row.line_pattern, intervalDays: row.line_interval_days, nth: row.line_nth, weekday: row.line_weekday,
  });
  const own = row.line_pattern ? { cycle_days: row.line_cycle_days !== undefined ? row.line_cycle_days : walked() } : {};
  return { ...row, service_key: row.service_key || row.service_key_snapshot, ...seriesFacts(row), ...own };
}

// The add-on lines of the completed visits, as rows the plan classifier reads. A closeout that froze its lines is
// read from that list, so a schedule line added, removed or pointed at another service after the visit never
// changes what was performed. A closeout from before the frozen list reads the schedule's rows.
function completedAddonLineRows(visitRows, scheduleRows, catalog) {
  const frozenVisits = visitRows.filter((visit) => frozenAddonLines(visit));
  const frozenVisitIds = new Set(frozenVisits.map((visit) => visit.visit_id));
  const rows = scheduleRows.filter((row) => !frozenVisitIds.has(row.visit_id));
  for (const visit of frozenVisits) {
    for (const line of frozenAddonLines(visit)) {
      const cadence = frozenLineCadence(line, visit, scheduleRows);
      const entry = catalog.find((svc) => (line.serviceKey
        ? svc.service_key === line.serviceKey : String(svc.id) === String(line.serviceId))) || {};
      if (cadence) {
        rows.push({
          ...visit,
          service_type: line.serviceName || entry.name || null,
          service_key: line.serviceKey || entry.service_key || null,
          service_key_snapshot: null,
          service_name: entry.name || null,
          catalog_billing_type: entry.billing_type || null,
          ...cadence,
        });
      }
    }
  }
  return rows;
}

// Pure decision. lastVisitKey / todayKey are YYYY-MM-DD; visitsPerYear is the new plan's count.
function decideReturningSetupFeeWaiver({ lastVisitKey, todayKey, visitsPerYear, cycleDays, family }) {
  if (!lastVisitKey || !todayKey) return null;
  const cycle = Number(cycleDays) > 0 ? Math.round(Number(cycleDays)) : cycleDaysForVisitsPerYear(visitsPerYear);
  if (cycle == null) return null;
  const windowDays = cycle + GRACE_DAYS;
  const gapDays = daysBetween(lastVisitKey, todayKey);
  if (gapDays == null || gapDays < 0) return null;
  if (gapDays > windowDays) return null;
  return {
    rule: 'returning_customer_gap',
    family,
    lastCompletedVisitDate: lastVisitKey,
    decidedOn: todayKey,
    gapDays,
    windowDays,
  };
}

const VISIT_PROPERTY_COLUMNS = [
  's.property_id', 's.source_estimate_id',
  's.service_address_line1', 's.service_address_line2', 's.service_address_city', 's.service_address_zip',
  'p.property_id as parent_property_id', 'p.source_estimate_id as parent_source_estimate_id',
  'p.service_address_line1 as parent_service_address_line1',
  'p.service_address_line2 as parent_service_address_line2',
  'p.service_address_city as parent_service_address_city',
  'p.service_address_zip as parent_service_address_zip',
];

async function resolveQuotedPropertyScope(database, customer, { address, propertyId }) {
  const { normalizedEstimateStreet, normalizedStampedStreet } = require('./estimate-property-linkage');
  const customerPrimaryStreet = customer
    ? normalizedStampedStreet(customer.address_line1, customer.address_line2, customer.city, customer.zip)
    : null;
  let estimateStreet = address ? normalizedEstimateStreet(address) : null;
  if (!estimateStreet && propertyId) {
    const prop = await database('customer_properties').where({ id: propertyId })
      .first('address_line1', 'address_line2', 'city', 'zip');
    if (prop) estimateStreet = normalizedStampedStreet(prop.address_line1, prop.address_line2, prop.city, prop.zip);
  }
  if (!estimateStreet && !propertyId) return null;
  return {
    propertyId: propertyId ? String(propertyId) : null,
    estimateStreet: estimateStreet || null,
    customerPrimaryStreet: customerPrimaryStreet || null,
  };
}

async function cachedPropertyStreet(database, propertyId, cache) {
  const key = String(propertyId);
  if (!cache.props.has(key)) {
    const { normalizedStampedStreet } = require('./estimate-property-linkage');
    const prop = await database('customer_properties').where({ id: propertyId })
      .first('address_line1', 'address_line2', 'city', 'zip');
    cache.props.set(key, prop
      ? normalizedStampedStreet(prop.address_line1, prop.address_line2, prop.city, prop.zip) : null);
  }
  return cache.props.get(key) || null;
}

async function cachedEstimateRow(database, estimateId, cache) {
  const key = String(estimateId);
  if (!cache.ests.has(key)) {
    const est = await database('estimates').where({ id: estimateId }).first('address', 'property_id');
    cache.ests.set(key, est || null);
  }
  return cache.ests.get(key);
}

function stampedStreetForVisitOrParent(row) {
  const { normalizedStampedStreet } = require('./estimate-property-linkage');
  return normalizedStampedStreet(
    row.service_address_line1, row.service_address_line2, row.service_address_city, row.service_address_zip,
  ) || normalizedStampedStreet(
    row.parent_service_address_line1, row.parent_service_address_line2, row.parent_service_address_city, row.parent_service_address_zip,
  );
}

async function resolveRowPropertyEvidence(database, row, cache) {
  const { normalizedEstimateStreet } = require('./estimate-property-linkage');
  const directPropId = row.property_id || row.parent_property_id || null;
  let street = stampedStreetForVisitOrParent(row);
  if (!street && directPropId) street = await cachedPropertyStreet(database, directPropId, cache);
  const sourceEstimateId = row.source_estimate_id || row.parent_source_estimate_id || null;
  if (street || !sourceEstimateId) return { propId: directPropId, street };
  const est = await cachedEstimateRow(database, sourceEstimateId, cache);
  return {
    propId: directPropId || est?.property_id || null,
    street: est?.address ? normalizedEstimateStreet(est.address) : null,
  };
}

async function rowMatchesQuotedProperty(database, row, scope, cache, opts = {}) {
  const { sameScopeKey, scopeKeysShareLocality } = require('./estimate-property-linkage');
  const requirePositiveMatch = Boolean(opts && opts.requirePositiveMatch);
  const directPropId = row.property_id || row.parent_property_id;
  if (scope.propertyId && directPropId) return String(directPropId) === scope.propertyId;
  const { propId, street } = await resolveRowPropertyEvidence(database, row, cache);
  if (scope.propertyId && propId) return String(propId) === scope.propertyId;
  const candidateStreet = street || (!requirePositiveMatch ? scope.customerPrimaryStreet : null);
  if (!candidateStreet) return !street && !requirePositiveMatch;
  return Boolean(
    scope.estimateStreet
    && sameScopeKey(candidateStreet, scope.estimateStreet)
    && scopeKeysShareLocality(candidateStreet, scope.estimateStreet),
  );
}

async function filterRowsToQuotedProperty(database, rows, scope, cache, opts) {
  if (!scope) return rows;
  const kept = [];
  for (const row of rows) {
    if (await rowMatchesQuotedProperty(database, row, scope, cache, opts)) kept.push(row);
  }
  return kept;
}

async function hasActivePlanAtQuotedAddress(database, customer, { address = null, propertyId = null } = {}) {
  if (!customer?.id) return false;
  const scope = await resolveQuotedPropertyScope(database, customer, { address, propertyId });
  if (!scope) {
    const { isMembershipCustomerRow } = require('./waveguard-existing-services');
    return customer.active !== false && isMembershipCustomerRow(customer);
  }
  const cache = { props: new Map(), ests: new Map() };
  return hasActivePlanAtQuotedProperty(database, customer.id, customer, scope, cache);
}

// Property-scoped active-plan check (B-21): an active plan on Property A must NOT block a lapsed
// Property B from the returning-customer waiver, while an active plan on the quoted property itself
// still defers to the existing-member waiver.
async function hasActivePlanAtQuotedProperty(database, customerId, customer, scope, cache) {
  const { isMembershipCustomerRow, isLiveObligationRow, TERMINAL_STATUSES } = require('./waveguard-existing-services');
  const { sameScopeKey, scopeKeysShareLocality } = require('./estimate-property-linkage');
  const { etDateString } = require('../utils/datetime-et');
  const today = etDateString();
  const accountHasActiveTier = Boolean(customer && customer.active !== false && isMembershipCustomerRow(customer));
  const rawActiveRows = await database('scheduled_services')
    .where({ customer_id: customerId, is_recurring: true })
    .whereNotIn('status', TERMINAL_STATUSES)
    .select(
      'id', 'status', 'scheduled_date', 'is_callback', 'followup_included', 'source',
      'property_id', 'source_estimate_id',
      'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip',
    );
  const activeRows = (rawActiveRows || []).filter((r) => isLiveObligationRow(r, today));
  const matchingActive = await filterRowsToQuotedProperty(database, activeRows, scope, cache);
  if (matchingActive.length > 0) return true;
  if (activeRows.length > 0) return false; // active plan rows exist only on other property(ies)
  if (!accountHasActiveTier) return false;
  if (scope.customerPrimaryStreet && scope.estimateStreet
    && !(sameScopeKey(scope.customerPrimaryStreet, scope.estimateStreet)
      && scopeKeysShareLocality(scope.customerPrimaryStreet, scope.estimateStreet))) {
    return false;
  }
  return true;
}

// The customer's newest performed plan visit of each plan family, as of today (ET): the rule's evidence. Null while
// the gate is off, with no customer, or when the quoted property has an active plan. When address or propertyId
// is provided, BOTH the active-plan check and completed visit history are scoped to that property (B-21).
// THROWS on a read failure: the caller decides.
async function loadReturningVisitHistory(database, { customerId, now = new Date(), address = null, propertyId = null } = {}) {
  if (!returningSetupFeeGapLive() || !customerId) return null;
  const { ownershipKeysForRow, isActivePlanCustomer } = require('./waveguard-existing-services');
  const propertyCache = { props: new Map(), ests: new Map() };
  let propertyScope = null;
  if (address || propertyId) {
    const customer = await database('customers').where({ id: customerId }).first();
    propertyScope = await resolveQuotedPropertyScope(database, customer, { address, propertyId });
    if (propertyScope) {
      if (await hasActivePlanAtQuotedProperty(database, customerId, customer, propertyScope, propertyCache)) return null;
    } else if (await isActivePlanCustomer(database, customerId, { strict: true })) {
      return null;
    }
  } else if (await isActivePlanCustomer(database, customerId, { strict: true })) {
    return null;
  }
  const { etDateString } = require('../utils/datetime-et');
  const todayKey = etDateString(now);
  // No lower date bound and no row limit: a custom series can run longer than a year, and the decision
  // applies each series' own window. One customer's completed visits are a small set.
  // The catalog join is the one loadCatalogFieldsByRowId reads: qualifyingKeysForRow lets the linked catalog
  // identity outrank a stale service_type label ("Pest Control" linked to lawn_care_monthly is lawn).
  const rawVisitRows = await database('scheduled_services as s')
    .leftJoin('services as svc', 's.service_id', 'svc.id')
    .leftJoin('scheduled_services as p', 's.recurring_parent_id', 'p.id')
    .where({ 's.customer_id': customerId, 's.status': 'completed' })
    .select(...VISIT_SERIES_COLUMNS, ...VISIT_PROPERTY_COLUMNS, 's.service_type', 's.source', 's.service_key_snapshot', 'svc.service_key',
      'svc.name as service_name', 'svc.billing_type as catalog_billing_type', ...SERIES_COLUMNS,
      database.raw(LATEST_OUTCOME_SQL), database.raw(PERFORMED_DATE_SQL), database.raw(FROZEN_IDENTITY_SQL));
  const rawScheduleLines = await database('scheduled_service_addons as a')
    .join('scheduled_services as s', 'a.scheduled_service_id', 's.id')
    .leftJoin('services as svc', 'a.service_id', 'svc.id')
    .leftJoin('scheduled_services as p', 's.recurring_parent_id', 'p.id')
    .where({ 's.customer_id': customerId, 's.status': 'completed' })
    .select(...VISIT_SERIES_COLUMNS, ...VISIT_PROPERTY_COLUMNS, 'a.service_name as service_type', 'a.recurring_pattern as line_pattern',
      'a.recurring_interval_days as line_interval_days', 'a.recurring_nth as line_nth',
      'a.recurring_weekday as line_weekday', 's.source', 'a.service_key_snapshot', 'svc.service_key',
      'svc.name as service_name', 'svc.billing_type as catalog_billing_type', 'a.service_id as addon_service_id',
      ...SERIES_COLUMNS, database.raw(LATEST_OUTCOME_SQL), database.raw(PERFORMED_DATE_SQL),
      database.raw(FROZEN_IDENTITY_SQL));
  const visitRows = await filterRowsToQuotedProperty(database, rawVisitRows, propertyScope, propertyCache, { requirePositiveMatch: true });
  const scheduleLines = await filterRowsToQuotedProperty(database, rawScheduleLines, propertyScope, propertyCache, { requirePositiveMatch: true });
  const catalog = await frozenCatalogRows(database, visitRows);
  // A plan application can also ride as a recurring add-on line on another plan visit (mosquito on a lawn
  // visit). As the schedule reads a line (admin-schedule lineDueOnRecurringDate): an explicit one_time line is
  // one application, never a plan; a line with no pattern rides every parent visit, so it takes the parent's
  // cadence. The parent visit carries the plan-series, callback and outcome facts.
  const addonRows = completedAddonLineRows(visitRows, scheduleLines, catalog)
    .filter((row) => row.line_pattern !== 'one_time')
    .map(addonLineRow);
  // A plan application only (seriesFacts). The live-plan loader's catalog exclusions too
  // (loadExistingRecurringQualifyingRows): commercial and non-bait rodent work, a one-time catalog entry, and a
  // one-time booking source are never plan evidence.
  const {
    isCommercialServiceRow, isNonBaitRodentServiceRow, isOneTimeBookingSource, catalogBillingTypeIsOneTime,
  } = require('./self-booking-plan-sync');
  const { isPerformedVisitOutcome } = require('./pest-pressure/first-visit');
  const isPlanEvidence = (row) => row.plan_visit && isPerformedVisitOutcome(row.visit_outcome)
    && !isCommercialServiceRow(row) && !isNonBaitRodentServiceRow(row)
    && !catalogBillingTypeIsOneTime(row) && !isOneTimeBookingSource(row.source);
  const visits = visitRows.map((row) => completedVisitRow(row, catalog));
  const performed = [...visits, ...addonRows]
    .filter((row) => isPlanEvidence(row) && !!performedKey(row) && performedKey(row) <= todayKey)
    // Newest performed day first; on the same day, the later completion, then the visit id, so the pick never
    // depends on row order.
    .sort((x, y) => performedKey(y).localeCompare(performedKey(x))
      || completedMs(y) - completedMs(x)
      || String(y.visit_id || '').localeCompare(String(x.visit_id || '')));
  // The cycle is the customer's OLD plan (the last visit's own series, as its closeout froze it): the fee covers a
  // restart, and a customer back within about one of their own rounds missed at most one. A new cadence picked
  // later never moves the window.
  const lastByFamily = {};
  for (const row of performed) {
    for (const family of ownershipKeysForRow(row)) {
      if (!lastByFamily[family]) lastByFamily[family] = { lastVisitKey: performedKey(row), cycleDays: row.cycle_days };
    }
  }
  return propertyScope ? { todayKey, lastByFamily, propertyScoped: true } : { todayKey, lastByFamily };
}

// A customer's own quote (the restart tap, the website quote): the read runs in a savepoint of the caller's
// transaction, so a failed statement leaves that transaction usable, and a failed read answers null. The fee
// stays: never a refusal on the customer's own tap, never a waiver on a failure.
async function loadReturningVisitHistoryInSavepoint(trx, { customerId, now, address = null, propertyId = null } = {}, logTag = '') {
  if (!returningSetupFeeGapLive() || !customerId) return null;
  try {
    return await trx.transaction((sp) => loadReturningVisitHistory(sp, { customerId, now, address, propertyId }));
  } catch (err) {
    logger.warn(`${logTag} returning setup fee read skipped: ${err.message}`);
    return null;
  }
}

// The plan family whose setup fee these recurring lines carry, or null. Only a solo pest or solo mosquito plan
// carries the fee (recurringMixHasMembershipFeeService).
function feeLineOfPlan(recurringLines) {
  const converter = require('./estimate-converter');
  const lines = Array.isArray(recurringLines) ? recurringLines : [];
  if (!converter.recurringMixHasMembershipFeeService(lines)) return null;
  return lines.find((svc) => !(svc && (svc.quoteRequired === true || svc.requiresCustomQuote === true))
    && converter.recurringServiceKey(svc)) || null;
}

// Pure. The waiver for the plan these recurring lines sell, or null (charge as before). Only a solo pest or solo
// mosquito plan carries the fee (recurringMixHasMembershipFeeService), so only that family's visits count. The
// plan's new visit count is the fallback cycle only when the old visit's series has none the scheduler places.
function decideReturningSetupFeeWaiverForPlan(recurringLines, history) {
  if (!history || !history.lastByFamily) return null;
  const converter = require('./estimate-converter');
  const line = feeLineOfPlan(recurringLines);
  const family = line && converter.recurringServiceKey(line);
  const last = family && history.lastByFamily[family];
  if (!last) return null;
  return decideReturningSetupFeeWaiver({
    lastVisitKey: last.lastVisitKey,
    cycleDays: last.cycleDays,
    todayKey: history.todayKey,
    visitsPerYear: converter.visitsPerYearForRecurringService(line),
    family,
  });
}

// The mark on a RAW engine result: the setup fee comes off the pest line (initialFee is only that fee), and the
// mapper reads the flag for a solo mosquito plan, whose fee has no line. On the raw result so a technician's
// price digest (agentEngineResultDigest) differs with and without the waiver.
function waiveSetupFeeOnEngineResult(v1) {
  if (!v1 || typeof v1 !== 'object') return;
  for (const li of Array.isArray(v1.lineItems) ? v1.lineItems : []) {
    if (li && Number(li.initialFee) > 0) li.initialFee = 0;
  }
  v1.membershipSetupFeeWaived = true;
}

// One priced result with the rule applied: map, find the answer for the server's own plan, and when the rule
// waives, mark the engine result and map again. The save-time recompute and the estimate tool's preview both
// call it, so the two cannot drift.
//   history  a write that re-prices: the rule decides from the customer's visits.
//   stored   a read-only replay of a stored answer: it holds only for the plan family it names, so a replay of
//            another mix (a customer's service change, an offered option) never borrows it.
// Neither (gate off, no customer, an active member, no stored answer) = one plain map. A plan priced with no fee
// has nothing to waive, so the rule leaves no answer on it.
function mapWithReturningWaiver(v1, mapResult, { history = null, stored = null } = {}) {
  const mapped = mapResult(v1);
  if (!(history || stored) || !(Number(mapped?.oneTime?.membershipFee) > 0)) return { mapped, waiver: null };
  const converter = require('./estimate-converter');
  const lines = converter.recurringServicesFromEstimateData({ result: mapped });
  const feeLine = feeLineOfPlan(lines);
  const storedCovers = !!feeLine && !!stored && converter.recurringServiceKey(feeLine) === stored.family;
  const waiver = history ? decideReturningSetupFeeWaiverForPlan(lines, history) : (storedCovers ? stored : null);
  if (!waiver) return { mapped, waiver: null };
  waiveSetupFeeOnEngineResult(v1);
  return { mapped: mapResult(v1), waiver };
}

// The stored answer: the operator waiver (the field the page, the bundle and the accept bill already read) with
// the rule's evidence beside it. One shape home for a fee-waiving adjustment: customer-moves withMoveSetupWaiver.
const WAIVER_REASON = 'Returning customer: back inside one plan cycle + 30 days (owner 2026-11-24)';
// The website quote's frozen decision names the rule this way (setupFeeQuote.waived).
const FROZEN_WAIVED_REASON = 'returning_customer';
function withReturningSetupWaiver(base, waiver) {
  const adj = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  return {
    ...require('./customer-moves').withMoveSetupWaiver({ ...adj, internalReason: adj.internalReason || WAIVER_REASON }),
    returningCustomerGap: waiver,
  };
}

// Store the rule's answer on an estimate's data (the staff save, the restart quote). No answer = no change.
function storeReturningSetupWaiver(estimateData, waiver) {
  if (!waiver || !estimateData) return;
  estimateData.operatorPriceAdjustment = withReturningSetupWaiver(estimateData.operatorPriceAdjustment, waiver);
}

// The rule's stored evidence on an estimate, or null (no waiver, or a staff / move waiver).
function returningSetupFeeWaiverOf(estimateData) {
  const adj = estimateData && typeof estimateData === 'object' ? estimateData.operatorPriceAdjustment : null;
  const stamp = adj && typeof adj === 'object' && adj.waiveSetupFee === true ? adj.returningCustomerGap : null;
  return stamp && typeof stamp === 'object' && stamp.rule === 'returning_customer_gap' ? stamp : null;
}

// An adjustment that names the rule, without the rule's waiver (whoever sent it). Its discount, when it has
// one, stays. Undefined = nothing is left to store.
function withoutReturningSetupWaiver(adjustment) {
  if (!adjustment || typeof adjustment !== 'object' || adjustment.returningCustomerGap === undefined) return adjustment;
  const { returningCustomerGap: _rule, waiveSetupFee: _waived, ...rest } = adjustment;
  if (rest.internalReason === WAIVER_REASON) delete rest.internalReason;
  return Number(rest.value) > 0 ? rest : undefined;
}

// A write that re-prices decides again: before pricing, the estimate's data loses the rule's answer in both
// stored shapes, the operator waiver above and the website quote's frozen zero (setupFeeQuote with
// waived: 'returning_customer'). A staff or move waiver and every other frozen decision stay.
function dropReturningSetupWaiver(estimateData) {
  if (!estimateData || typeof estimateData !== 'object') return;
  const kept = withoutReturningSetupWaiver(estimateData.operatorPriceAdjustment);
  if (kept === undefined) delete estimateData.operatorPriceAdjustment;
  else estimateData.operatorPriceAdjustment = kept;
  if (estimateData.setupFeeQuote && estimateData.setupFeeQuote.waived === FROZEN_WAIVED_REASON) delete estimateData.setupFeeQuote;
}

// True when any of these estimate data (a quote's stored row, the posted copy) holds the rule's answer, in either
// stored shape.
function holdsReturningSetupWaiver(...estimateDatas) {
  return estimateDatas.some((data) => !!data && typeof data === 'object'
    && (!!returningSetupFeeWaiverOf(data) || !!(data.setupFeeQuote && data.setupFeeQuote.waived === FROZEN_WAIVED_REASON)));
}

// A save the server could not price keeps the client's totals, so the rule may only confirm what those totals
// already say. The totals leave the fee out BY THE RULE when the plan carries the fee, the result does not, and
// the rule's answer was claimed for it: the estimate tool's preview marked the result
// (result.returningSetupFeeWaiver), or the quote being saved held the answer (answerHeld: a reopened estimate
// posts its stored result back, and a save strips the preview's mark from it).
//   the rule still waives     -> the waiver is stored: totals and bill agree.
//   the rule no longer waives -> stale: the totals leave out a fee the accept would bill. The caller refuses.
// Everything else stores nothing and refuses nothing: the totals carry the fee (so does the bill), or they
// leave it out for a reason that is not the rule's (a bundle, a member, a staff or move waiver, an older result).
function returningWaiverForUnpricedSave(estimateData, history, { answerHeld = false } = {}) {
  const none = { waiver: null, stale: false };
  const data = estimateData && typeof estimateData === 'object' ? estimateData : {};
  const result = data.result && typeof data.result === 'object' ? data.result : null;
  if (!result || !(answerHeld || result.returningSetupFeeWaiver)) return none;
  if (data.operatorPriceAdjustment && data.operatorPriceAdjustment.waiveSetupFee === true) return none;
  if (Number(result.oneTime && result.oneTime.membershipFee) > 0) return none;
  const lines = require('./estimate-converter').recurringServicesFromEstimateData({ result });
  if (!feeLineOfPlan(lines)) return none;
  const waiver = decideReturningSetupFeeWaiverForPlan(lines, history);
  return { waiver, stale: !waiver };
}

function parseEstimateDataObject(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return structuredClone(raw);
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

function addFeeToTotals(holder, fee) {
  const year1 = Number(holder?.totals?.year1);
  if (Number.isFinite(year1)) holder.totals.year1 = Math.round((year1 + fee) * 100) / 100;
}

function restoreFallbackSetupFeeOnData(data, row) {
  const converter = require('./estimate-converter');
  const lines = converter.recurringServicesFromEstimateData(data);
  if (!feeLineOfPlan(lines)) return {};
  const fee = Number(converter.WAVEGUARD_SETUP_FEE) || 99;
  // Legacy estimates store recurring services at the top level with no
  // `data.result`: keep oneTime/totals at the top level rather than creating
  // an empty `data.result` that would hide `data.recurring` on display.
  const holder = data.result && typeof data.result === 'object' ? data.result : data;
  const oneTime = holder.oneTime && typeof holder.oneTime === 'object' ? holder.oneTime : null;
  if (oneTime && Number(oneTime.membershipFee) > 0) return {};
  const hasNestedTotal = oneTime && oneTime.total != null && oneTime.total !== '' && Number.isFinite(Number(oneTime.total));
  const priorTotal = hasNestedTotal ? Number(oneTime.total) : Number(row?.onetime_total || 0);
  const nextTotal = Math.round((priorTotal + fee) * 100) / 100;
  holder.oneTime = oneTime
    ? Object.assign(oneTime, { membershipFee: fee, total: nextTotal })
    : { membershipFee: fee, total: nextTotal };
  addFeeToTotals(holder, fee);
  return { onetime_total: nextTotal };
}

async function returningWaiverStillValidAt(trx, row, data, now) {
  const { etDateString } = require('../utils/datetime-et');
  const todayKey = etDateString(now);
  const storedGap = returningSetupFeeWaiverOf(data);
  const converter = require('./estimate-converter');
  const lines = converter.recurringServicesFromEstimateData(data);
  if (returningSetupFeeGapLive() && row?.customer_id) {
    const history = await loadReturningVisitHistoryInSavepoint(
      trx,
      { customerId: row.customer_id, now, address: row.address || null, propertyId: row.property_id || null },
      '[estimate-extension]',
    );
    if (history) return Boolean(decideReturningSetupFeeWaiverForPlan(lines, history));
  }
  // Gate off, no linked customer, active member, or lookup skipped: only a stored gap
  // that is still inside its own window AND with the gate live can stay valid.
  if (!returningSetupFeeGapLive()) return false;
  if (storedGap?.lastCompletedVisitDate && Number.isFinite(Number(storedGap.windowDays))) {
    const gapNow = daysBetween(storedGap.lastCompletedVisitDate, todayKey);
    return gapNow != null && gapNow >= 0 && gapNow <= Number(storedGap.windowDays);
  }
  return false;
}

async function recomputeTotalsAfterWaiverStrip(data, row, now) {
  try {
    const { serverRecomputeFromEstimateData } = require('./admin-estimate-persistence');
    const reprice = await serverRecomputeFromEstimateData(data, {
      now,
      replaySavedPricingKnobs: true,
      priorQualifyingServices: Array.isArray(data.priorQualifyingServices) ? data.priorQualifyingServices : [],
      recurringCustomer: data.membershipSnapshot?.isExistingCustomer === true,
    });
    if (!reprice?.recomputed) return restoreFallbackSetupFeeOnData(data, row);
    data.result = reprice.serverResult;
    if (reprice.rawEngineResult) data.engineResult = reprice.rawEngineResult;
    const totals = reprice.serverTotals || {};
    const patch = {};
    if (totals.monthlyTotal != null) patch.monthly_total = totals.monthlyTotal;
    if (totals.annualTotal != null) patch.annual_total = totals.annualTotal;
    const nextOneTime = totals.onetimeTotal ?? totals.oneTimeTotal;
    if (nextOneTime != null) patch.onetime_total = nextOneTime;
    return patch;
  } catch (err) {
    if (err?.status || err?.statusCode || err?.failClosed) throw err;
    logger.warn(`[estimate-extension] recompute after stripping stale returning waiver failed for ${row?.id}: ${err.message}`);
    return restoreFallbackSetupFeeOnData(data, row);
  }
}

// Re-evaluate a returning-customer setup-fee waiver when an estimate is extended (B-41):
// if the customer is now past the plan-cycle + 30-day window (e.g. > 121 days for quarterly),
// strip the stale waiver, clear cached snapshot bundles, and recompute/restore the $99 fee.
async function refreshReturningWaiverOnExtend(trx, row, { now = new Date() } = {}) {
  const data = parseEstimateDataObject(row?.estimate_data);
  if (!data || !holdsReturningSetupWaiver(data)) return { stripped: false, patch: null };
  if (await returningWaiverStillValidAt(trx, row, data, now)) return { stripped: false, patch: null };
  dropReturningSetupWaiver(data);
  if (data.engineResult && typeof data.engineResult === 'object') delete data.engineResult.membershipSetupFeeWaived;
  if (data.sendSnapshot && typeof data.sendSnapshot === 'object') delete data.sendSnapshot.pricingBundle;
  const totalsPatch = await recomputeTotalsAfterWaiverStrip(data, row, now);
  return { stripped: true, patch: { estimate_data: JSON.stringify(data), ...totalsPatch } };
}

module.exports = {
  GRACE_DAYS,
  returningSetupFeeGapLive,
  cycleDaysForVisitsPerYear,
  windowDaysForVisitsPerYear,
  oldSeriesCycleDays,
  decideReturningSetupFeeWaiver,
  loadReturningVisitHistory,
  frozenPlanSeriesForCompletion,
  loadReturningVisitHistoryInSavepoint,
  decideReturningSetupFeeWaiverForPlan,
  waiveSetupFeeOnEngineResult,
  mapWithReturningWaiver,
  withReturningSetupWaiver,
  storeReturningSetupWaiver,
  returningSetupFeeWaiverOf,
  withoutReturningSetupWaiver,
  dropReturningSetupWaiver,
  holdsReturningSetupWaiver,
  returningWaiverForUnpricedSave,
  refreshReturningWaiverOnExtend,
  restoreFallbackSetupFeeOnData,
  hasActivePlanAtQuotedAddress,
  FROZEN_WAIVED_REASON,
};
