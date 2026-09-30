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
    .first('id', 'first_name', 'email', 'city', 'latitude', 'longitude');
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

async function rainSinceVisitSentence({ customer, visitYmd, deps, mode }) {
  // Only whole days after the visit through yesterday: today's MRMS value is
  // a partial accumulation, and the visit day itself straddles the visit.
  // Shadow makes no external call.
  if (mode !== 'live') return '';
  const latitude = Number(customer?.latitude);
  const longitude = Number(customer?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !visitYmd) return '';
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

// The customer's next upcoming PEST appointment, as a date string, or '' when
// there is none. readVisitSummary's own next-visit read spans every service
// line (a pest email could name tomorrow's lawn visit), so a builder resolves
// it here, classifying each candidate's service type the way the completion
// flow classifies the service line.
async function nextPestVisitYmd({ conn, deps, customerId, serviceYmd }) {
  const today = etDateString(deps.now());
  const lowerBound = serviceYmd && serviceYmd > today ? serviceYmd : today;
  const upcoming = await conn('scheduled_services')
    .where({ customer_id: customerId })
    .whereNotIn('status', CLOSED_VISIT_STATUSES)
    .where('scheduled_date', '>=', lowerBound)
    .orderBy('scheduled_date', 'asc')
    .select('scheduled_date', 'service_type');
  const next = upcoming.find((row) => deps.detectServiceLine(row.service_type) === 'pest');
  return next ? dateOnlyString(next.scheduled_date) : '';
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
    next_visit_date: longDate(await nextPestVisitYmd({
      conn, deps, customerId: record.customer_id, serviceYmd: visitYmd,
    })),
    secondary_products_sentence: secondaryProductsSentence(secondary),
    nonrepellent_band_note: nonrepellentBandNote(primary, deps),
    activity_rating_sentence: activityRatingSentence(record, byVisit, 'pest'),
    rain_since_visit_sentence: await rainSinceVisitSentence({
      customer, visitYmd, deps, mode,
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

async function planPattern(conn, deps, record) {
  if (!record.scheduled_service_id) return '';
  const visit = await conn('scheduled_services').where({ id: record.scheduled_service_id })
    .first('recurring_pattern', 'recurring_parent_id', 'service_type');
  // The plan is the PEST series: a visit that is not a pest appointment says
  // nothing about the pest plan's cadence.
  if (!visit || deps.detectServiceLine(visit.service_type) !== 'pest') return '';
  if (clean(visit.recurring_pattern)) return clean(visit.recurring_pattern).toLowerCase();
  if (!visit.recurring_parent_id) return '';
  const parent = await conn('scheduled_services').where({ id: visit.recurring_parent_id })
    .first('recurring_pattern', 'service_type');
  return parent && deps.detectServiceLine(parent.service_type) === 'pest' ? clean(parent.recurring_pattern).toLowerCase() : '';
}

// Once-per-customer / once-per-estimate is enforced HERE, at send time, not by
// the automation's idempotency key (which is per event): a run other than this
// one that already SENT this template, or is live in flight, for the same
// customer (or estimate) means this run must not send a second copy. Skipped,
// failed and shadow runs never count — only a delivery or a live attempt.
const IN_FLIGHT_RUN_STATUSES = ['queued', 'scheduled', 'retry_scheduled', 'running'];
async function alreadyDelivered({ conn, run, customerId = null, estimateId = null }) {
  const runs = conn('email_template_automation_runs')
    .where({ template_key: run.template_key })
    .whereNot({ id: run.id })
    .whereIn('status', ['sent', ...IN_FLIGHT_RUN_STATUSES]);
  if (estimateId) runs.where({ entity_type: 'estimate', entity_id: String(estimateId) });
  else runs.where({ recipient_id: String(customerId) });
  if (await runs.first('id')) return true;
  if (!customerId || estimateId) return false;
  const ledger = await conn('marketing_email_ledger')
    .where({ customer_id: customerId, email_key: run.template_key })
    .whereIn('status', ['sent', 'reserved'])
    .first('id');
  return Boolean(ledger);
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
  if ((await planPattern(conn, deps, record)) !== QUARTERLY_PATTERN) return skip('the customer\'s plan is not the quarterly cadence', 'plan_not_quarterly');
  const planName = clean(record.service_type);
  if (!planName) return skip('the visit carries no plan / service name', 'no_plan_name');
  const customer = await loadCustomer(conn, customerId);
  if (!customer) return skip('customer not found', 'customer_missing');
  return { record, customer, planName };
}

// The plan's products: every performed pest visit of this customer up to
// visit 2. The non-repellent must be Taurus SC (the product whose
// manufacturer statement the copy quotes) and nothing else non-repellent.
async function whyPlanProducts({ record, conn, deps }) {
  const planVisits = conn('service_records').where('service_records.customer_id', record.customer_id)
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
  const { record, customer, planName } = gate;
  if (await alreadyDelivered({ conn, run, customerId: customer.id })) {
    return skip('this customer already has a sent or in-flight lc.why_91_days email', 'already_delivered');
  }
  const plan = await whyPlanProducts({ record, conn, deps });
  if (plan.skip) return plan;

  // Cohort floor: getActivityRatingAverages already omits a (line, visit)
  // cohort under 20 rated visits, so a missing figure is "cohort below 20".
  const { byVisit } = await deps.getActivityRatingAverages({ conn });
  const first = byVisit?.pest?.[1];
  const second = byVisit?.pest?.[2];
  if (first == null || second == null) return skip('fewer than 20 rated visits on the pest line for a first or second visit', 'cohort_below_20');

  const areaIntel = customer.city
    ? await deps.getAreaIntelSentence({ city: customer.city, month: deps.now(), conn })
    : null;
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

function pestOrProblemNamed(estimate, lead, deps) {
  // A pest the customer themselves named (canonical names only — the same
  // keyword list the visit reader uses); else the quoted line's plain label.
  const text = [estimate.service_interest, lead?.service_interest, lead?.lead_synopsis, estimate.notes].map(clean).join(' ');
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

async function buildExpiredNurture({
  run, conn = db, deps = defaultDeps(), mode = 'live',
}) {
  const templateKey = 'nurture.expired_1';
  const estimate = await conn('estimates').where({ id: run.entity_id }).first();
  if (!estimate) return skip('linked estimate no longer exists', 'estimate_missing');
  if (estimate.status !== 'expired') return skip(`linked estimate is no longer expired (status is ${estimate.status})`, 'estimate_not_expired');
  if (await alreadyDelivered({ conn, run, estimateId: estimate.id })) {
    return skip('this estimate already has a sent or in-flight expired-estimate touch', 'already_delivered');
  }
  if (!estimate.token) return skip('the estimate has no page token to link to', 'no_estimate_token');
  if (!run.recipient_id) return skip('no customer record on the estimate (the ledger needs one)', 'no_customer');
  const customer = await loadCustomer(conn, run.recipient_id);
  if (!customer) return skip('customer not found', 'customer_missing');
  const lead = await conn('leads').where({ customer_id: customer.id }).whereNull('deleted_at')
    .orderBy('created_at', 'desc').first('service_interest', 'lead_synopsis');

  const serviceQuoted = clean(deps.inferEstimateServiceInterest({ ...estimate, estimateData: estimate.estimate_data }));
  let estimateLink = `https://portal.wavespestcontrol.com/estimate/${estimate.token}`;
  if (mode === 'live') {
    // The same tracked short link the estimate follow-ups mint (email leg
    // only). A mint failure degrades to the long URL inside the helper.
    const links = await deps.mintEstimateLink(estimate, 'estimate_expired_nurture_1', { emailOnly: true });
    estimateLink = clean(links?.emailUrl) || estimateLink;
  }
  const areaIntel = customer.city
    ? await deps.getAreaIntelSentence({ city: customer.city, month: deps.now(), conn })
    : null;

  const payload = {
    first_name: firstToken(estimate.customer_name) || clean(customer.first_name) || 'there',
    service_quoted: serviceQuoted,
    address_short: clean(estimate.address).split(',')[0].trim(),
    expired_date_short: estimate.expires_at
      ? new Date(estimate.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
      : '',
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
    run, conn, mode, deps: deps ? { ...defaultDeps(), ...deps } : defaultDeps(),
  });
  if (result.skip) return { handled: true, ...result };
  return { handled: true, ok: true, payload: { ...payload, ...result.payload } };
}

module.exports = {
  buildEmailDivisionPayload,
  hasPayloadBuilder: (templateKey) => Object.prototype.hasOwnProperty.call(BUILDERS, templateKey),
  BUILDER_TEMPLATE_KEYS: Object.freeze(Object.keys(BUILDERS)),
  REQUIRED,
  buildFirstVisitPest,
  buildWhy91Days,
  buildExpiredNurture,
};
