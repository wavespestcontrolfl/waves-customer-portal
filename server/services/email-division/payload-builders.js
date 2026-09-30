/**
 * Email division — payload builders for the automation executor
 * (email-template-automation-executor.js). One builder per seeded email-
 * division template that has a real trigger; each turns the run's ids (a
 * service record, an estimate, a customer) into the template's payload from
 * Waves' own data, following the WIRING CONTRACT in the header of
 * 20260928235000_seed_email_division_templates.js (binding):
 *
 *   lc.first_visit_pest   (B1, visit.completed_first)
 *   lc.why_91_days        (B5, service_report.ready — the second recurring visit)
 *   nurture.expired_1     (C1, estimate.expired)
 *
 * lc.rain_and_treatment (B6) has NO builder and NO automation: no rain /
 * weather event is emitted (or even catalogued) anywhere, and this lane
 * invents none.
 *
 * THE RULE EVERY BUILDER FOLLOWS: a builder that cannot meet a REQUIRED
 * condition returns a SKIP `{ ok:false, skip:true, reason, code }` — it never
 * hands back a blank, stale or assumed figure. The executor settles a skip as
 * a terminal 'skipped' run (never retried): every skip here is a fact about
 * the data, not a transient failure. A thrown error (a DB read failing) is
 * NOT a skip; it propagates so the executor's bounded retry handles it.
 * Optional sentences (each naming its own source in-line, per the contract)
 * are simply left blank when their source cannot back them.
 *
 * `mode` is 'live' or 'shadow'. Shadow NEVER writes (no short-code mint) and
 * never calls an external service (no radar, no slot probe): the readers it
 * does use are read-only DB reads.
 */

const db = require('../../models/db');
const { etDateString } = require('../../utils/datetime-et');
const { dateOnlyString } = require('../../utils/date-only');

// Required variables per template — pinned equal to the seed migration's
// required lists by the unit test (a builder that drifts from its template
// would otherwise hand the library a payload it refuses at send time).
const REQUIRED = Object.freeze({
  'lc.first_visit_pest': [
    'first_name', 'visit_date_short', 'visit_date_long', 'tech_first_name', 'areas_treated_list',
    'primary_product_name', 'primary_active_ingredient', 'primary_product_family_phrase',
    'pests_named_list', 'next_visit_date',
  ],
  'lc.why_91_days': [
    'first_name', 'plan_interval_days', 'plan_name', 'nonrepellent_product', 'contact_product',
    'activity_avg_first_visit', 'activity_avg_second_visit',
  ],
  'nurture.expired_1': [
    'first_name', 'service_quoted', 'address_short', 'expired_date_short', 'pest_or_problem_named', 'estimate_link',
  ],
});

const TAURUS_SC_FACT = 'fact-taurus-sc-non-repellent';
// The "91 days" of lc.why_91_days is the QUARTERLY plan cadence (the
// scheduler's 'quarterly' pattern, 4 visits a year). Only a quarterly series
// may say it.
const QUARTERLY_PATTERN = 'quarterly';
const QUARTERLY_INTERVAL_DAYS = '91';

function skip(reason, code) {
  return { ok: false, skip: true, reason, code };
}
function built(payload) {
  return { ok: true, payload };
}

function clean(value) {
  return String(value ?? '').trim();
}
function normalizeEmail(value) {
  return clean(value).toLowerCase();
}
function firstToken(value) {
  return clean(value).split(/\s+/)[0] || '';
}
// A DATE column (service_date, next visit) as 'Sep 24' / 'September 24, 2026'.
// Formatted in UTC off the date-only string so the machine's zone never
// shifts the day.
function dateFromYmd(ymd) {
  return ymd ? new Date(`${ymd}T12:00:00Z`) : null;
}
function shortDate(ymd) {
  const d = dateFromYmd(ymd);
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
}
function longDate(ymd) {
  const d = dateFromYmd(ymd);
  return d ? d.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }) : '';
}
function addDaysYmd(ymd, days) {
  const d = dateFromYmd(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function missingRequired(templateKey, payload) {
  return REQUIRED[templateKey].filter((key) => !clean(payload[key]));
}

// "a, b and c" — the list style the templates' fixtures use.
function listSentence(items) {
  const list = items.map(clean).filter(Boolean);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function defaultDeps() {
  return {
    readVisitProducts: (...args) => require('./visit-products').readVisitProducts(...args),
    readVisitSummary: (...args) => require('./visit-products').readVisitSummary(...args),
    getActivityRatingAverages: (...args) => require('./visit-products').getActivityRatingAverages(...args),
    productLabels: () => require('./visit-products').PRODUCT_LABELS,
    getAreaIntelSentence: (...args) => require('./area-intel').getAreaIntelSentence(...args),
    fetchMrmsDailyRain: (...args) => require('../mrms-qpe').fetchMrmsDailyRain(...args),
    applyPerformedVisitHistoryFilter: (...args) => require('../pest-pressure/first-visit').applyPerformedVisitHistoryFilter(...args),
    probeGoneQuietConsultation: (...args) => require('../estimate-email-consultation-offer').probeGoneQuietConsultation(...args),
    mintGoneQuietConsultationUrl: (...args) => require('../estimate-email-consultation-offer').mintGoneQuietConsultationUrl(...args),
    goneQuietConsultationStillValid: (...args) => require('../estimate-email-consultation-offer').goneQuietConsultationStillValid(...args),
    mintEstimateLink: (...args) => require('../estimate-follow-up')._private.mintStageLinks(...args),
    inferEstimateServiceInterest: (...args) => require('../estimate-service-lines').inferEstimateServiceInterest(...args),
    inferEstimateServiceLines: (...args) => require('../estimate-service-lines').inferEstimateServiceLines(...args),
    parsePestsNamed: (...args) => require('./visit-products').parsePestsNamed(...args),
    linkedLeadIdFor: (...args) => require('../estimate-consultation-offer').linkedLeadIdFor(...args),
    normalizeRecurringPattern: (...args) => require('../recurring-appointment-seeder').normalizeRecurringPattern(...args),
    parseRawAddress: (...args) => require('../../utils/address-normalizer').parseRawAddress(...args),
    detectServiceLine: (...args) => require('../service-report/service-line-configs').detectServiceLine(...args),
    now: () => new Date(),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function loadCustomer(conn, customerId) {
  // A lead-type recipient id that is not a customers row is "no customer",
  // never a thrown uuid-cast error (nothing a retry could change).
  if (!UUID_RE.test(clean(customerId))) return null;
  return conn('customers').where({ id: customerId }).whereNull('deleted_at')
    .first('id', 'first_name', 'email', 'latitude', 'longitude');
}

// The completed, customer-visible, PERFORMED visit a service-record trigger
// names — the same predicate the activity averages and the first-visit
// default are judged on, so an inspection-only / declined / incomplete /
// report-suppressed closeout never drives one of these emails.
async function loadPerformedVisit(conn, deps, recordId) {
  if (!recordId) return null;
  const query = conn('service_records').where('service_records.id', recordId);
  deps.applyPerformedVisitHistoryFilter(query, {});
  return query.first('service_records.*');
}

async function technicianFirstName(conn, technicianId) {
  if (!technicianId) return '';
  const row = await conn('technicians').where({ id: technicianId }).first('name');
  return firstToken(row?.name);
}

function taurusProduct(product) {
  return Array.isArray(product?.factSlugs) && product.factSlugs.includes(TAURUS_SC_FACT);
}

// ---------------------------------------------------------------------------
// B1 — lc.first_visit_pest
// ---------------------------------------------------------------------------

function activityRatingSentence(record, byVisit, serviceLine) {
  // The visit's OWN rating is shown only when a technician chose it: the
  // untouched first-visit default 5 (owner ruling 2026-09-24) is not a
  // measurement, and a customer-submitted or legacy unsourced rating is not
  // "recorded at this visit" by us. Explicit `defaulted === false` only — a
  // NULL flag (a row written before the column) cannot prove it was chosen.
  const own = record.client_pest_rating;
  const technicianChose = own != null
    && clean(record.client_pest_rating_source).toLowerCase() === 'technician'
    && record.client_pest_rating_defaulted === false;
  const first = byVisit?.[serviceLine]?.[1];
  const second = byVisit?.[serviceLine]?.[2];
  // Cohort floor: getActivityRatingAverages omits a (line, visit) cohort under
  // 20 rated visits, so a missing figure IS "cohort below 20" — the averages
  // clause is dropped, never estimated.
  const haveAverages = first != null && second != null;
  const averagesClause = `Across Waves visit records, that rating averages ${Number(first).toFixed(1)} at a first visit and ${Number(second).toFixed(1)} at the second.`;
  if (technicianChose && haveAverages) {
    return `The pest activity rating recorded at this visit was ${Number(own)}, on a scale from 0 (none) to 5 (high). ${averagesClause}`;
  }
  if (technicianChose) {
    return `The pest activity rating recorded at this visit was ${Number(own)}, on a scale from 0 (none) to 5 (high).`;
  }
  if (haveAverages) {
    return `Across Waves visit records, the pest activity rating (0 none to 5 high) averages ${Number(first).toFixed(1)} at a first visit and ${Number(second).toFixed(1)} at the second.`;
  }
  return '';
}

// The coordinates of the property the VISIT was at: the triggering appointment's
// property record. Never customers.latitude/longitude (a multi-property
// account's other property). null when the appointment has no property record
// or its coordinates are missing or not real (a null is not zero).
async function visitPropertyCoordinates(conn, record) {
  if (!record.scheduled_service_id) return null;
  const visit = await conn('scheduled_services').where({ id: record.scheduled_service_id }).first('property_id');
  if (!visit?.property_id) return null;
  const property = await conn('customer_properties').where({ id: visit.property_id }).first('latitude', 'longitude');
  if (property?.latitude == null || property?.longitude == null) return null;
  const latitude = Number(property.latitude);
  const longitude = Number(property.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || (latitude === 0 && longitude === 0)) return null;
  return { latitude, longitude };
}

async function rainSinceVisitSentence({ coordinates, visitYmd, deps, mode }) {
  // Only whole days after the visit through yesterday: today's MRMS value is
  // a partial accumulation, and the visit day itself straddles the visit.
  // Shadow makes no external call.
  if (mode !== 'live' || !coordinates || !visitYmd) return '';
  const { latitude, longitude } = coordinates;
  const start = addDaysYmd(visitYmd, 1);
  const end = addDaysYmd(etDateString(deps.now()), -1);
  if (start > end) return '';
  const rain = await deps.fetchMrmsDailyRain({
    latitude, longitude, start, end,
  });
  // A gap is not a zero (mrms-qpe.js): an incomplete read says nothing.
  if (!rain || !rain.complete) return '';
  const total = rain.days.reduce((sum, day) => sum + (Number.isFinite(day.inches) ? day.inches : 0), 0);
  if (!(total >= 0.1)) return '';
  return `NOAA radar shows about ${total.toFixed(1)} inches of rain near your address since the visit; local totals may vary.`;
}

// Statuses that are no longer an upcoming visit (the same set the visit
// reader's next-visit lookup excludes).
const CLOSED_VISIT_STATUSES = ['cancelled', 'rescheduled', 'completed', 'skipped', 'no_show'];

// A row's property, as a comparable key: its property record, else its service
// address (line 1 + zip). '' = not recorded.
function propertyKeyOf(row) {
  if (!row) return '';
  if (row.property_id) return `p:${row.property_id}`;
  const line1 = clean(row.service_address_line1).toLowerCase();
  return line1 ? `a:${line1}|${clean(row.service_address_zip)}` : '';
}

// The customer's next upcoming PEST appointment AT THE VISIT'S PROPERTY, as
// { ymd } or { ambiguous: true } or { ymd: '' }. readVisitSummary's own next-
// visit read spans every service line and every property (a pest email could
// name tomorrow's lawn visit, or another property's pest visit), so a builder
// resolves it here: each candidate's service type is classified the way the
// completion flow classifies the line, and it must be at the triggering visit's
// property. When the visit's property cannot be established, candidates are
// accepted only if they all agree on ONE property; otherwise the answer is
// ambiguous and the caller skips.
async function nextPestVisit({
  conn, deps, record, serviceYmd,
}) {
  const today = etDateString(deps.now());
  const lowerBound = serviceYmd && serviceYmd > today ? serviceYmd : today;
  const linked = record.scheduled_service_id
    ? await conn('scheduled_services').where({ id: record.scheduled_service_id })
      .first('property_id', 'service_address_line1', 'service_address_zip')
    : null;
  const visitKey = propertyKeyOf(linked);
  const upcoming = await conn('scheduled_services')
    .where({ customer_id: record.customer_id })
    .whereNotIn('status', CLOSED_VISIT_STATUSES)
    .where('scheduled_date', '>=', lowerBound)
    .orderBy('scheduled_date', 'asc')
    .select('scheduled_date', 'service_type', 'property_id', 'service_address_line1', 'service_address_zip');
  const pest = upcoming.filter((row) => deps.detectServiceLine(row.service_type) === 'pest');
  if (visitKey) {
    const next = pest.find((row) => propertyKeyOf(row) === visitKey);
    return { ymd: next ? dateOnlyString(next.scheduled_date) : '' };
  }
  if (new Set(pest.map(propertyKeyOf)).size > 1) return { ambiguous: true };
  return { ymd: pest[0] ? dateOnlyString(pest[0].scheduled_date) : '' };
}

// Every condition that makes this THE customer's first performed pest visit
// for this recipient: returns a skip, or { record, customer }.
async function firstVisitGate({ run, conn, deps }) {
  const customerId = run.recipient_id;
  const record = await loadPerformedVisit(conn, deps, run.entity_id);
  if (!record) return skip('visit is not a completed, customer-visible, performed service record', 'visit_not_eligible');
  if (!customerId || clean(record.customer_id) !== clean(customerId)) {
    return skip('the visit does not belong to the recipient customer', 'recipient_not_visit_customer');
  }
  if (record.service_line !== 'pest') return skip('not a pest-line visit', 'not_pest_line');

  // First performed visit on the line, judged against records that existed
  // BEFORE this one (a delayed run must not read a later visit as "prior").
  const earlier = conn('service_records').where('service_records.customer_id', customerId)
    .whereNot('service_records.id', record.id)
    .where('service_records.created_at', '<', record.created_at);
  deps.applyPerformedVisitHistoryFilter(earlier, { serviceLine: 'pest' });
  if (await earlier.first('service_records.id')) return skip('not the customer\'s first performed pest visit', 'not_first_visit');

  const customer = await loadCustomer(conn, customerId);
  if (!customer) return skip('customer not found', 'customer_missing');
  return { record, customer };
}

// The optional sentences: each is blank unless its own source backs it.
function secondaryProductsSentence(secondary) {
  if (!secondary?.productName) return '';
  return secondary.phrase
    ? `We also applied ${clean(secondary.productName)}: ${clean(secondary.phrase)}.`
    : `We also applied ${clean(secondary.productName)}.`;
}
function nonrepellentBandNote(primary, deps) {
  // Manufacturer wording ONLY, and ONLY when the primary product is Taurus SC
  // (its label entry's own phrase, never restated).
  if (!taurusProduct(primary)) return '';
  return `Its manufacturer describes ${clean(primary.productName)} as ${deps.productLabels().taurus_sc.phrase}.`;
}
function petAdvisorySentence(summary) {
  // AGENTS.md compliance rule: never a fixed re-entry / drying minute figure
  // — the visit report carries the technician's own timing.
  return summary.advisory?.petAdvisory
    ? 'Keep pets and kids off the treated areas until they are dry; your visit report has the technician\'s timing for your visit.'
    : '';
}

async function buildFirstVisitPest({
  run, conn = db, deps = defaultDeps(), mode = 'live',
}) {
  const gate = await firstVisitGate({ run, conn, deps });
  if (gate.skip) return gate;
  const { record, customer } = gate;

  const { primary, secondary } = await deps.readVisitProducts(record.id, { conn });
  if (!primary) return skip('no customer-visible primary product recorded for the visit', 'no_primary_product');
  const summary = await deps.readVisitSummary(record.id, { conn });
  if (!summary) return skip('visit summary unavailable', 'visit_summary_missing');

  const visitYmd = dateOnlyString(summary.visitDate || record.service_date);
  const { byVisit } = await deps.getActivityRatingAverages({ conn });
  const nextVisit = await nextPestVisit({
    conn, deps, record, serviceYmd: visitYmd,
  });
  if (nextVisit.ambiguous) return skip('the customer has pest appointments at more than one property and this visit\'s property cannot be established', 'next_visit_property_ambiguous');
  const payload = {
    first_name: clean(customer.first_name),
    visit_date_short: shortDate(visitYmd),
    visit_date_long: longDate(visitYmd),
    tech_first_name: await technicianFirstName(conn, record.technician_id),
    areas_treated_list: listSentence(summary.areasTreated || []),
    primary_product_name: clean(primary.productName),
    primary_active_ingredient: clean(primary.activeIngredient),
    primary_product_family_phrase: clean(primary.phrase),
    pests_named_list: listSentence(summary.pestsNamed || []),
    next_visit_date: longDate(nextVisit.ymd || ''),
    secondary_products_sentence: secondaryProductsSentence(secondary),
    nonrepellent_band_note: nonrepellentBandNote(primary, deps),
    activity_rating_sentence: activityRatingSentence(record, byVisit, 'pest'),
    rain_since_visit_sentence: await rainSinceVisitSentence({
      coordinates: mode === 'live' ? await visitPropertyCoordinates(conn, record) : null, visitYmd, deps, mode,
    }),
    pet_advisory_sentence: petAdvisorySentence(summary),
  };
  if (!payload.next_visit_date) return skip('the customer has no upcoming pest appointment', 'no_upcoming_pest_visit');
  const missing = missingRequired('lc.first_visit_pest', payload);
  if (missing.length) return skip(`required payload missing: ${missing.join(', ')}`, 'missing_required');
  return built(payload);
}

// ---------------------------------------------------------------------------
// B5 — lc.why_91_days
// ---------------------------------------------------------------------------

// The plan the visit belongs to: its cadence (normalized by the scheduler's own
// alias table, for the visit and then its parent) and the visit's FROZEN service
// city. The city is the appointment's own (scheduled_services.service_address_*);
// never customers.city, which belongs to a different property on a
// multi-property customer. Empty strings mean "unknown".
async function planService(conn, deps, record) {
  const none = { pattern: '', city: '' };
  if (!record.scheduled_service_id) return none;
  const visit = await conn('scheduled_services').where({ id: record.scheduled_service_id })
    .first('recurring_pattern', 'recurring_parent_id', 'service_type', 'service_address_city', 'property_id');
  // The plan is the PEST series: a visit that is not a pest appointment says
  // nothing about the pest plan's cadence.
  if (!visit || deps.detectServiceLine(visit.service_type) !== 'pest') return none;
  // The series this appointment belongs to: its root (the parent, or itself when
  // it is the root) and its property, so plan evidence can be held to them.
  const identity = {
    city: clean(visit.service_address_city),
    rootId: visit.recurring_parent_id || record.scheduled_service_id,
    propertyId: visit.property_id || null,
  };
  const own = deps.normalizeRecurringPattern(visit.recurring_pattern);
  if (own) return { pattern: own, ...identity };
  if (!visit.recurring_parent_id) return { pattern: '', ...identity };
  const parent = await conn('scheduled_services').where({ id: visit.recurring_parent_id })
    .first('recurring_pattern', 'service_type');
  const inherited = parent && deps.detectServiceLine(parent.service_type) === 'pest'
    ? deps.normalizeRecurringPattern(parent.recurring_pattern) : null;
  return { pattern: inherited || '', ...identity };
}

// Once-per-customer (B5) / once-per-estimate (C1) is a SEND-TIME rule, not the
// automation's idempotency key (which is per event). Two layers share ONE
// reader, `priorSends`:
//   - the builder skips terminally only on a DELIVERED send by ANOTHER
//     operation (before building anything or minting a link);
//   - the ATOMIC decision is `onceGuardFor`, run by the ledger inside
//     reserveWithCap under the customer's advisory lock, so two concurrent
//     eligible runs serialize and exactly one reserves: a sibling that is
//     delivered is a terminal skip (ONCE_ALREADY_DELIVERED), a sibling whose
//     reservation is live is IN FLIGHT (ONCE_IN_FLIGHT — the executor defers
//     the run through its bounded retry, never a terminal skip).
// What counts: only a delivery or a live RESERVATION of another operation. A
// queued / scheduled / running sibling run that has not reserved anything never
// blocks (it may never qualify: the first visit's report is skipped by the
// builder), and THIS run's own run row and ledger row (same idempotency key)
// never count — a reclaimed crashed run must reach the ledger so its own
// abandoned reservation is settled or its accepted delivery recovered.
const ONCE_ALREADY_DELIVERED = 'ONCE_ALREADY_DELIVERED';
const ONCE_IN_FLIGHT = 'ONCE_IN_FLIGHT';

async function priorSends({
  conn, run, customerId = null, estimateId = null,
}) {
  const others = (query, column) => (run.idempotency_key ? query.whereNot(column, run.idempotency_key) : query);
  const sentRuns = conn('email_template_automation_runs').where({ template_key: run.template_key, status: 'sent' });
  if (run.id) sentRuns.whereNot({ id: run.id });
  if (estimateId) sentRuns.where({ entity_type: 'estimate', entity_id: String(estimateId) });
  else sentRuns.where({ recipient_id: String(customerId) });
  if (await sentRuns.first('id')) return 'sent';

  // The ledger, by the other operation's own reservation key.
  const ledger = others(conn('marketing_email_ledger as l')
    .where('l.email_key', run.template_key)
    .whereIn('l.status', ['sent', 'reserved']), 'l.idempotency_key');
  if (estimateId) {
    ledger.join('email_template_automation_runs as r', 'r.idempotency_key', 'l.idempotency_key')
      .where({ 'r.entity_type': 'estimate', 'r.entity_id': String(estimateId) });
  } else {
    ledger.where('l.customer_id', customerId);
  }
  const rows = await ledger.select('l.status');
  if (rows.some((row) => row.status === 'sent')) return 'sent';
  return rows.length ? 'in_flight' : null;
}

const ESTIMATE_RECIPIENT_CHANGED = 'ESTIMATE_RECIPIENT_CHANGED';
const ESTIMATE_NOT_EXPIRED = 'ESTIMATE_NOT_EXPIRED';
const ESTIMATE_EXPIRY_SUPERSEDED = 'ESTIMATE_EXPIRY_SUPERSEDED';

// The expiry date (ET, YYYY-MM-DD) the run was created for: the emitter's
// expires_on, carried on the run's stored payload (and context).
function runExpiresOn(run) {
  const parse = (value) => {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value) || {}; } catch { return {}; }
  };
  const on = clean(parse(run.payload).expires_on || parse(run.context).expires_on);
  return /^\d{4}-\d{2}-\d{2}$/.test(on) ? on : '';
}

// The ledger's hooks for a run, or null when the template has no rule:
//   guard         — inside reserveWithCap (under the customer's advisory lock):
//                   for C1 the estimate's current addressing, then the once rule;
//                   for B5 the once rule.
//   boundaryGuard — inside the provider-boundary transaction, immediately before
//                   the provider request (C1 only): the estimate's addressing is
//                   re-read with a share lock that lasts to the end of that
//                   transaction, so an ownership or email update cannot land
//                   between the check and the request.
function ledgerGuardsFor(run) {
  const scope = { 'lc.why_91_days': 'customer', 'nurture.expired_1': 'estimate' }[run.template_key];
  if (!scope) return { guard: null, boundaryGuard: null };
  const once = async (trx) => {
    const state = await priorSends({
      conn: trx,
      run,
      customerId: scope === 'customer' ? run.recipient_id : null,
      estimateId: scope === 'estimate' ? run.entity_id : null,
    });
    if (state === 'sent') return { reason: ONCE_ALREADY_DELIVERED };
    return state ? { reason: ONCE_IN_FLIGHT } : null;
  };
  if (scope !== 'estimate') return { guard: once, boundaryGuard: null };
  return {
    guard: async (trx) => (await estimateAddressingVerdict(trx, run)) || once(trx),
    boundaryGuard: (trx) => estimateAddressingVerdict(trx, run, { lock: true }),
  };
}

// The visit, customer and plan this email may be sent for: a skip, or
// { record, customer, planName }.
async function whyPlanGate({ run, conn, deps }) {
  const customerId = run.recipient_id;
  const record = await loadPerformedVisit(conn, deps, run.entity_id);
  if (!record) return skip('visit is not a completed, customer-visible, performed service record', 'visit_not_eligible');
  if (!customerId || clean(record.customer_id) !== clean(customerId)) {
    return skip('the visit does not belong to the recipient customer', 'recipient_not_visit_customer');
  }
  // The plan's service line: this email's cohort figures are that line's.
  if (record.service_line !== 'pest') return skip('not a pest-line visit', 'not_pest_line');
  // Sent once, after the first RECURRING visit (visit 2). A later visit never
  // re-qualifies: the averages the email quotes are "first visit" and "second
  // visit".
  if (Number(record.visit_number) !== 2) return skip('not the customer\'s second pest visit', 'not_second_visit');
  const plan = await planService(conn, deps, record);
  if (plan.pattern !== QUARTERLY_PATTERN) return skip('the customer\'s plan is not the quarterly cadence', 'plan_not_quarterly');
  const planName = clean(record.service_type);
  if (!planName) return skip('the visit carries no plan / service name', 'no_plan_name');
  const customer = await loadCustomer(conn, customerId);
  if (!customer) return skip('customer not found', 'customer_missing');
  return {
    record, customer, planName, city: plan.city, series: plan,
  };
}

// The plan's products: every performed pest visit of THIS appointment's recurring
// pest series (and property) up to visit 2 — never the customer's other
// properties' visits, where a Taurus application elsewhere would otherwise
// qualify a Talak-only plan here. The non-repellent must be Taurus SC (the
// product whose manufacturer statement the copy quotes) and nothing else
// non-repellent. A series that cannot be established skips.
async function whyPlanProducts({
  record, series, conn, deps,
}) {
  if (!series?.rootId) return skip('the visit\'s recurring pest series cannot be established', 'plan_series_unknown');
  const members = await conn('scheduled_services').where('customer_id', record.customer_id)
    .where((qb) => qb.where('id', series.rootId).orWhere('recurring_parent_id', series.rootId))
    .select('id', 'property_id', 'service_type');
  const memberIds = members
    .filter((row) => deps.detectServiceLine(row.service_type) === 'pest')
    // Same property as the triggering appointment (a NULL on either side is
    // "not recorded", not a different property).
    .filter((row) => !series.propertyId || !row.property_id || String(row.property_id) === String(series.propertyId))
    .map((row) => row.id);
  if (!memberIds.includes(record.scheduled_service_id)) {
    return skip('the visit is not part of a recurring pest series at its property', 'plan_series_unknown');
  }
  const planVisits = conn('service_records').where('service_records.customer_id', record.customer_id)
    .whereIn('service_records.scheduled_service_id', memberIds)
    .where('service_records.visit_number', '<=', 2);
  deps.applyPerformedVisitHistoryFilter(planVisits, { serviceLine: 'pest' });
  const visitIds = (await planVisits.select('service_records.id')).map((row) => row.id);
  if (!visitIds.includes(record.id)) visitIds.push(record.id);
  const products = [];
  for (const id of visitIds) products.push(...(await deps.readVisitProducts(id, { conn })).products);
  const nonRepellents = products.filter((p) => p.family === 'non_repellent');
  if (!nonRepellents.some(taurusProduct) || nonRepellents.some((p) => !taurusProduct(p))) {
    return skip('the plan\'s non-repellent is not (only) Taurus SC', 'nonrepellent_not_taurus');
  }
  const contact = products.find((p) => p.family === 'contact_residual' && clean(p.productName));
  if (!contact) return skip('no contact product recorded on the plan', 'no_contact_product');
  return { taurus: nonRepellents.find(taurusProduct), contact };
}

async function buildWhy91Days({
  run, conn = db, deps = defaultDeps(),
}) {
  const gate = await whyPlanGate({ run, conn, deps });
  if (gate.skip) return gate;
  const {
    record, customer, planName, city, series,
  } = gate;
  if ((await priorSends({ conn, run, customerId: customer.id })) === 'sent') {
    return skip('this customer already has a sent lc.why_91_days email', 'already_delivered');
  }
  const plan = await whyPlanProducts({
    record, series, conn, deps,
  });
  if (plan.skip) return plan;

  // Cohort floor: getActivityRatingAverages already omits a (line, visit)
  // cohort under 20 rated visits, so a missing figure is "cohort below 20".
  const { byVisit } = await deps.getActivityRatingAverages({ conn });
  const first = byVisit?.pest?.[1];
  const second = byVisit?.pest?.[2];
  if (first == null || second == null) return skip('fewer than 20 rated visits on the pest line for a first or second visit', 'cohort_below_20');

  // The visit's own frozen city; unknown -> the optional sentence is dropped.
  const areaIntel = city ? await deps.getAreaIntelSentence({ city, month: deps.now(), conn }) : null;
  const payload = {
    first_name: clean(customer.first_name),
    plan_interval_days: QUARTERLY_INTERVAL_DAYS,
    plan_name: planName,
    nonrepellent_product: clean(plan.taurus.productName),
    contact_product: clean(plan.contact.productName),
    activity_avg_first_visit: Number(first).toFixed(1),
    activity_avg_second_visit: Number(second).toFixed(1),
    area_intel_sentence: areaIntel || '',
  };
  const missing = missingRequired('lc.why_91_days', payload);
  if (missing.length) return skip(`required payload missing: ${missing.join(', ')}`, 'missing_required');
  return built(payload);
}

// ---------------------------------------------------------------------------
// C1 — nurture.expired_1
// ---------------------------------------------------------------------------

const GENERIC_PROBLEM_BY_LINE = Object.freeze({
  pest: 'pest problem', lawn: 'lawn problem', mosquito: 'mosquito problem', tree_shrub: 'tree and shrub problem', rodent: 'rodent problem',
});

function parsedEstimateData(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// Negation-aware reading of CUSTOMER-TYPED text ("no termites, ants only" names
// ants, never termites). service_interest arrives through a free-text field
// (lead forms, the admin lead editor, the quote wizard), so a pest named inside
// a negation is not a pest the customer has. Text is read sentence by sentence,
// comma segment by comma segment: a negator ("no", "not", "without", "never",
// "none", "don't", "except", "other than", "ruled out" ...) turns the rest of the
// sentence off (and cuts a segment at the negator: "ants not termites" keeps
// ants), until a later segment says "only" / "just" / "but" / "instead", which
// turns it back on. Anything ambiguous reads as negated: the email then falls
// back to the plain service label instead of naming a pest the customer may not
// have.
const NEGATOR_RE = /\b(no|not|without|never|none|nothing|neither|nor|zero|don'?t|doesn'?t|didn'?t|isn'?t|aren'?t|wasn'?t|weren'?t|haven'?t|hasn'?t|except|excluding|other than|ruled? out|free of)\b/i;
const RESTORE_RE = /\b(only|just|but|instead|mainly|however)\b/i;
function positiveText(text) {
  const kept = [];
  for (const sentence of String(text || '').split(/[.;!?\n]+/)) {
    let negating = false;
    for (const segment of sentence.split(/,/)) {
      const negator = NEGATOR_RE.exec(segment);
      if (negator) {
        if (!negating) kept.push(segment.slice(0, negator.index));
        negating = true;
      } else if (negating && RESTORE_RE.test(segment)) {
        negating = false;
        kept.push(segment);
      } else if (!negating) {
        kept.push(segment);
      }
    }
  }
  return kept.join(' ');
}

function pestOrProblemNamed(estimate, lead, deps) {
  // A pest the customer themselves named (canonical names only — the same
  // keyword list the visit reader uses); else the quoted line's plain label.
  // Customer-authored service-interest fields ONLY: a model-written summary
  // (lead_synopsis) names a pest even when it negates it, and staff notes are not
  // the customer's words.
  const text = [estimate.service_interest, lead?.service_interest].map(clean).map(positiveText).join(' ');
  const pests = deps.parsePestsNamed(text).slice(0, 2);
  if (pests.length) return listSentence(pests);
  const line = deps.inferEstimateServiceLines({ ...estimate, estimateData: estimate.estimate_data })[0];
  return GENERIC_PROBLEM_BY_LINE[line?.key] || 'problem';
}

async function consultationUrlFor({
  estimate, run, deps, mode,
}) {
  // Dark-safe by construction: shadow never probes or mints, and the live
  // path is the existing consultation eligibility end to end (its own gates,
  // channel 'email', short-wrapped bearer, the lead's own inbox). An expired
  // estimate is not accept-active, so today's eligibility yields no offer —
  // the URL is blank until that shared eligibility says otherwise.
  if (mode !== 'live') return '';
  const recipient = normalizeEmail(run.recipient_email);
  if (!recipient || recipient !== normalizeEmail(estimate.customer_email)) return '';
  const context = await deps.probeGoneQuietConsultation(estimate.id);
  if (!context) return '';
  const minted = await deps.mintGoneQuietConsultationUrl(context);
  if (!minted) return '';
  return (await deps.goneQuietConsultationStillValid(context, run.recipient_email)) ? minted : '';
}

// The date the estimate's expiry is shown and keyed under: the expiry that
// triggered this run (the emitter's expires_on, which already falls back to the
// flip's own date for an aged-out estimate with no expires_at), else the row's
// expires_at, else the flip's own instant — never blank for a flipped estimate.
function effectiveExpiryYmd(estimate, payload = {}) {
  const on = clean(payload.expires_on);
  if (/^\d{4}-\d{2}-\d{2}$/.test(on)) return on;
  const instant = estimate.expires_at || estimate.disposition_at || estimate.updated_at;
  return instant ? etDateString(new Date(instant)) : '';
}

// The estimate's OWN property city (its property record, else its own address);
// never customers.city (a multi-property customer's other property).
async function estimateCity(conn, deps, estimate) {
  if (estimate.property_id) {
    const property = await conn('customer_properties').where({ id: estimate.property_id }).first('city');
    if (clean(property?.city)) return clean(property.city);
  }
  return clean(deps.parseRawAddress(clean(estimate.address)).city);
}

// Who this estimate is CURRENTLY addressed to, and whether it is still an
// expired one. Used at build time, at the ledger reservation and again at the
// provider boundary (where the row is share-locked for the rest of the handoff
// transaction): a reassignment or an email change, or an extension, between
// the build and the send must never deliver this estimate's bearer link.
async function estimateAddressingVerdict(conn, run, { lock = false, expiresOn = runExpiresOn(run) } = {}) {
  const query = conn('estimates').where({ id: run.entity_id });
  if (lock) query.forShare();
  const estimate = await query.first('id', 'status', 'customer_id', 'customer_email', 'expires_at');
  if (!estimate) return { reason: ESTIMATE_RECIPIENT_CHANGED };
  if (estimate.status !== 'expired') return { reason: ESTIMATE_NOT_EXPIRED };
  // A delayed run belongs to the EXPIRY that triggered it: an estimate extended
  // during the delay and expired again has a newer expiry (and a newer run), so
  // this one is superseded — it must neither send nor use up the estimate's
  // once-only allowance. Compared only when both sides are recorded (an aged-out
  // estimate with no expires_at has no expiry date to compare).
  if (expiresOn && estimate.expires_at && etDateString(new Date(estimate.expires_at)) !== expiresOn) {
    return { reason: ESTIMATE_EXPIRY_SUPERSEDED };
  }
  if (clean(estimate.customer_id) !== clean(run.recipient_id)
    || normalizeEmail(estimate.customer_email) !== normalizeEmail(run.recipient_email)) {
    return { reason: ESTIMATE_RECIPIENT_CHANGED };
  }
  return null;
}

async function buildExpiredNurture({
  run, payload: basePayload = {}, conn = db, deps = defaultDeps(), mode = 'live',
}) {
  const templateKey = 'nurture.expired_1';
  const estimate = await conn('estimates').where({ id: run.entity_id }).first();
  if (!estimate) return skip('linked estimate no longer exists', 'estimate_missing');
  if (estimate.status !== 'expired') return skip(`linked estimate is no longer expired (status is ${estimate.status})`, 'estimate_not_expired');
  // The run was addressed when the trigger fired; the estimate's CURRENT owner
  // and email must still be that recipient, or the old recipient would receive
  // the current estimate's bearer link. Same normalization as the ledger's
  // recipient check (trim + lowercase); skips the whole send, never retargets.
  const addressing = await estimateAddressingVerdict(conn, run, { expiresOn: clean(basePayload.expires_on) || runExpiresOn(run) });
  if (addressing?.reason === ESTIMATE_RECIPIENT_CHANGED) {
    return skip('the estimate\'s customer or email changed since this run was created; not sent to the old recipient', 'estimate_recipient_changed');
  }
  if (addressing?.reason === ESTIMATE_EXPIRY_SUPERSEDED) {
    return skip('the estimate was extended and expired again since this run was created; a newer run owns the touch', 'estimate_expiry_superseded');
  }
  if ((await priorSends({ conn, run, estimateId: estimate.id })) === 'sent') {
    return skip('this estimate already has a sent expired-estimate touch', 'already_delivered');
  }
  if (!estimate.token) return skip('the estimate has no page token to link to', 'no_estimate_token');
  if (!run.recipient_id) return skip('no customer record on the estimate (the ledger needs one)', 'no_customer');
  const customer = await loadCustomer(conn, run.recipient_id);
  if (!customer) return skip('customer not found', 'customer_missing');
  // The lead THIS estimate belongs to, by the estimate's own linkage (the same
  // rule the consultation offer uses) — never "the customer's newest lead",
  // which can be about something else entirely.
  const leadId = await deps.linkedLeadIdFor(estimate.id, parsedEstimateData(estimate.estimate_data), conn);
  const lead = leadId
    ? await conn('leads').where({ id: leadId }).whereNull('deleted_at').first('service_interest')
    : null;

  const serviceQuoted = clean(deps.inferEstimateServiceInterest({ ...estimate, estimateData: estimate.estimate_data }));
  let estimateLink = `https://portal.wavespestcontrol.com/estimate/${estimate.token}`;
  if (mode === 'live') {
    // The same tracked short link the estimate follow-ups mint (email leg
    // only). A mint failure degrades to the long URL inside the helper.
    const links = await deps.mintEstimateLink(estimate, 'estimate_expired_nurture_1', { emailOnly: true });
    estimateLink = clean(links?.emailUrl) || estimateLink;
  }
  // The estimate's own property city; unknown -> the optional sentence is dropped.
  const city = await estimateCity(conn, deps, estimate);
  const areaIntel = city ? await deps.getAreaIntelSentence({ city, month: deps.now(), conn }) : null;

  const payload = {
    first_name: firstToken(estimate.customer_name) || clean(customer.first_name) || 'there',
    service_quoted: serviceQuoted,
    address_short: clean(estimate.address).split(',')[0].trim(),
    expired_date_short: shortDate(effectiveExpiryYmd(estimate, basePayload)),
    pest_or_problem_named: pestOrProblemNamed(estimate, lead, deps),
    estimate_link: estimateLink,
    area_intel_sentence: areaIntel || '',
    consultation_url: await consultationUrlFor({
      estimate, run, deps, mode,
    }),
  };
  const missing = missingRequired(templateKey, payload);
  if (missing.length) return skip(`required payload missing: ${missing.join(', ')}`, 'missing_required');
  return built(payload);
}

const BUILDERS = Object.freeze({
  'lc.first_visit_pest': buildFirstVisitPest,
  'lc.why_91_days': buildWhy91Days,
  'nurture.expired_1': buildExpiredNurture,
});

/**
 * `{ handled:false }` for a template with no builder; otherwise the builder's
 * verdict with `handled:true`. `payload` (the run's stored + live payload) is
 * the base; the builder's keys win, so a stale stored value can never survive
 * into a send.
 */
async function buildEmailDivisionPayload({
  run, payload = {}, mode = 'live', conn = db, deps = undefined,
}) {
  const builder = BUILDERS[run.template_key];
  if (!builder) return { handled: false };
  const result = await builder({
    run, payload, conn, mode, deps: deps ? { ...defaultDeps(), ...deps } : defaultDeps(),
  });
  if (result.skip) return { handled: true, ...result };
  return { handled: true, ok: true, payload: { ...payload, ...result.payload } };
}

module.exports = {
  buildEmailDivisionPayload,
  hasPayloadBuilder: (templateKey) => Object.prototype.hasOwnProperty.call(BUILDERS, templateKey),
  BUILDER_TEMPLATE_KEYS: Object.freeze(Object.keys(BUILDERS)),
  REQUIRED,
  ledgerGuardsFor,
  positiveText,
  ONCE_ALREADY_DELIVERED,
  ONCE_IN_FLIGHT,
  ESTIMATE_RECIPIENT_CHANGED,
  ESTIMATE_NOT_EXPIRED,
  ESTIMATE_EXPIRY_SUPERSEDED,
  buildFirstVisitPest,
  buildWhy91Days,
  buildExpiredNurture,
};
