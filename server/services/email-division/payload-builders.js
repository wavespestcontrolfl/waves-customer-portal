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

const crypto = require('node:crypto');
const db = require('../../models/db');
const { greetingFirstToken } = require('../../utils/greeting-first-name');
const { estimateFollowupBlockedReason } = require('../estimate-comms-eligibility');
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
// `evidence`: stable identities the payload does not carry as text (an estimate's
// link token, the record's own technician-chosen rating) that still belong in the
// payload fingerprint.
function built(payload, evidence = {}) {
  return { ok: true, payload, evidence };
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
    parseEstimateAddress: (...args) => require('../estimate-property-linkage').parseEstimateAddress(...args),
    isCommercialServiceRow: (...args) => require('../self-booking-plan-sync').isCommercialServiceRow(...args),
    isCommercialAccount: (...args) => require('../self-booking-plan-sync').isCommercialAccount(...args),
    get commercialPropertyTypes() { return require('../self-booking-plan-sync').COMMERCIAL_PROPERTY_TYPES; },
    addressKey: (...args) => require('../customer-properties').addressKey(...args),
    // The catalog keys that are ONE residential general-pest service: the visit-facts
    // contract's recurring-pest keys (the canonical registry of which catalog row is
    // which service line), kept only where the canonical lane parser reads the key as
    // pest (the membership umbrella key is not a single service).
    get singlePestCatalogKeys() {
      const keys = require('../../config/visit-facts-contract').VISIT_FACTS_CONTRACT.recurring_pest.catalogKeys;
      const { copyCategoryForEstimate } = require('../estimate-followup-copy');
      return keys.filter((key) => copyCategoryForEstimate({ service_interest: key }) === 'pest');
    },
    scheduledServiceColumns: (...args) => require('../recurring-appointment-seeder').scheduledServiceColumns(...args),
    overlayRecurringTemplateOverrides: (...args) => require('../recurring-template-overrides').overlayRecurringTemplateOverrides(...args),
    recurringServiceAddress: (...args) => require('../booking/visit-financial-stamps').recurringServiceAddress(...args),
    findActiveRecurringSeries: (...args) => require('../recurring-appointment-seeder').findActiveRecurringSeries(...args),
    treatmentTargetKey: (...args) => require('./visit-products').treatmentTargetKey(...args),
    targetForSentence: (...args) => require('./area-intel').targetForSentence(...args),
    copyCategoryForEstimate: (...args) => require('../estimate-followup-copy').copyCategoryForEstimate(...args),
    canonicalTargetVocabulary: (...args) => require('./area-intel').canonicalTargetVocabulary(...args),
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
    .first('id', 'first_name', 'last_name', 'email', 'latitude', 'longitude');
}

// The completed, customer-visible, PERFORMED visit a service-record trigger
// names — the same predicate the activity averages and the first-visit
// default are judged on, so an inspection-only / declined / incomplete /
// report-suppressed closeout never drives one of these emails.
async function loadPerformedVisit(conn, deps, recordId, { lock = false } = {}) {
  if (!recordId) return null;
  const query = conn('service_records').where('service_records.id', recordId);
  deps.applyPerformedVisitHistoryFilter(query, {});
  if (lock) query.forShare();
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

// "Same property" is the repo's canonical rule, never a local key: the property
// record's id when both rows carry one, else customer-properties' addressKey over
// the FULL stamped service address (street, unit line 2, city, ZIP — "Apt 1" and
// "Apt 2" at one street and ZIP are different properties). A row with neither
// has no identity.
const PROPERTY_COLUMNS = ['property_id', 'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip'];
function propertyIdentity(row, deps) {
  if (!row) return { id: '', address: '' };
  return {
    id: row.property_id ? String(row.property_id) : '',
    // The address identity needs a STREET: addressKey is nonempty for a city or ZIP
    // alone, and "Parrish" is not a property. Without line 1 the identity is unknown
    // (never a match; the ambiguity guards apply).
    address: clean(row.service_address_line1)
      ? deps.addressKey({
        address_line1: row.service_address_line1,
        address_line2: row.service_address_line2,
        city: row.service_address_city,
        zip: row.service_address_zip,
      })
      : '',
  };
}
function hasPropertyIdentity(row, deps) {
  const identity = propertyIdentity(row, deps);
  return Boolean(identity.id || identity.address);
}
function sameProperty(a, b, deps) {
  const x = propertyIdentity(a, deps);
  const y = propertyIdentity(b, deps);
  if (x.id && y.id) return x.id === y.id;
  if (x.address && y.address) return x.address === y.address;
  return false;
}
// Every row provably at ONE property (a single row is trivially one; unknown
// identities never agree with a second row).
function allSameProperty(rows, deps) {
  return rows.length <= 1 || rows.every((row) => sameProperty(rows[0], row, deps));
}
// Compatible = provably the same property, or an identity is missing on a side
// (not recorded is not "a different property").
function propertyCompatible(a, b, deps) {
  return !hasPropertyIdentity(a, deps) || !hasPropertyIdentity(b, deps) || sameProperty(a, b, deps);
}

// `lock` share-locks every row a predicate below decides on (the provider-boundary
// re-runs), so a cancellation or reclassification cannot commit between the check
// and the provider request.
function shared(query, lock) {
  return lock ? query.forShare() : query;
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
  conn, deps, record, serviceYmd, lock = false,
}) {
  const today = etDateString(deps.now());
  const lowerBound = serviceYmd && serviceYmd > today ? serviceYmd : today;
  const linked = record.scheduled_service_id
    ? await shared(conn('scheduled_services').where({ id: record.scheduled_service_id }), lock).first(...PROPERTY_COLUMNS)
    : null;
  const upcoming = await shared(conn('scheduled_services')
    .where({ customer_id: record.customer_id })
    .whereNotIn('status', CLOSED_VISIT_STATUSES)
    .where('scheduled_date', '>=', lowerBound)
    .orderBy('scheduled_date', 'asc'), lock)
    .select('id', 'scheduled_date', 'service_type', ...PROPERTY_COLUMNS);
  const pest = upcoming.filter((row) => deps.detectServiceLine(row.service_type) === 'pest');
  if (hasPropertyIdentity(linked, deps)) {
    const next = pest.find((row) => sameProperty(linked, row, deps));
    return { ymd: next ? dateOnlyString(next.scheduled_date) : '', id: next?.id || null };
  }
  if (!allSameProperty(pest, deps)) return { ambiguous: true };
  return { ymd: pest[0] ? dateOnlyString(pest[0].scheduled_date) : '', id: pest[0]?.id || null };
}

// The EFFECTIVE rows of the plan a free-re-service email is judged on, read ONCE
// (share-locked in lock mode) and consumed by every predicate below — no predicate
// reads service text, a service key or a property type on its own:
//   customer — the account's commercial markers (waveguard_tier, property_type);
//   visit    — the triggering appointment, when the record has one;
//   root     — its series root (the parent, or the visit itself);
//   members  — the root and its children (same customer);
//   active   — the customer's ACTIVE pest series the canonical source
//              (findActiveRecurringSeries) names for this service.
// A series row is EFFECTIVE the way findActiveRecurringSeries reads it: the current
// recurring_template_overrides (service, service key) and the override-stamped
// service address are overlaid on the historical row, and each carries its
// property's type.
const PLAN_ROW_COLUMNS = ['id', 'service_type', 'service_key_snapshot', 'recurring_pattern', 'recurring_parent_id', 'recurring_template_overrides', ...PROPERTY_COLUMNS];
async function effectivePlanRows(conn, deps, record, { lock = false } = {}) {
  const cols = await deps.scheduledServiceColumns(conn);
  const overlay = (row) => (row ? { ...deps.overlayRecurringTemplateOverrides(row, cols), ...deps.recurringServiceAddress(row) } : null);
  const withPropertyType = async (row) => {
    if (!row) return null;
    const property = row.property_id
      ? await shared(conn('customer_properties').where({ id: row.property_id }), lock).first('property_type')
      : null;
    return { ...row, property_type: clean(property?.property_type).toLowerCase() };
  };
  const read = (id) => shared(conn('scheduled_services').where({ id }), lock).first(...PLAN_ROW_COLUMNS);

  const customer = await shared(conn('customers').where({ id: record.customer_id }), lock).first('waveguard_tier', 'property_type');
  const visitRow = record.scheduled_service_id ? await read(record.scheduled_service_id) : null;
  const rootId = visitRow ? (visitRow.recurring_parent_id || visitRow.id) : null;
  const rootRow = rootId ? (String(rootId) === String(visitRow.id) ? visitRow : await read(rootId)) : null;
  const visit = await withPropertyType(overlay(visitRow));
  const root = rootRow === visitRow ? visit : await withPropertyType(overlay(rootRow));

  const members = rootId
    ? (await shared(conn('scheduled_services').where('customer_id', record.customer_id)
      .where((qb) => qb.where('id', rootId).orWhere('recurring_parent_id', rootId)), lock)
      .select(...PLAN_ROW_COLUMNS)).map(overlay)
    : [];

  let active = [];
  const serviceType = clean(visitRow?.service_type) || clean(record.service_type);
  if (serviceType) {
    if (lock) {
      // What "active" decides on: the customer's series roots (status, ongoing flag,
      // template) and the members of the visit's own series (a live future member).
      // Locked in id order before findActiveRecurringSeries reads them.
      await conn('scheduled_services').where({ customer_id: record.customer_id })
        .where((qb) => {
          qb.where((roots) => roots.where({ is_recurring: true }).whereNull('recurring_parent_id'));
          if (rootId) qb.orWhere('recurring_parent_id', rootId);
        })
        .orderBy('id').forShare().select('id');
    }
    const found = (await deps.findActiveRecurringSeries(conn, { customerId: record.customer_id, serviceType }))
      .filter((parent) => deps.detectServiceLine(parent.service_type) === 'pest');
    active = [];
    for (const series of found) active.push(await withPropertyType(overlay(await read(series.id))));
    active = active.filter(Boolean);
  }
  return {
    customer, visit, root, members, active,
  };
}

// Commercial plans are not this email's audience: commercial copy stays
// terms-neutral (AGENTS.md: estimate follow-up truth scope), and both templates
// promise a free re-service between visits. detectServiceLine calls a
// "Commercial Quarterly Pest Control" plan 'pest', so the FULL canonical rule
// from self-booking-plan-sync is applied to the plan's effective rows: the account
// ('commercial' tier sentinel, or customers.property_type commercial/business:
// isCommercialAccount), the service text (isCommercialServiceRow) of the record,
// the appointment, its series root and — for a record tied to no series — every
// active pest series the fallback would accept, and the property type
// (commercial/business) of each of those rows.
function isCommercialPlan({ deps, record, rows }) {
  const asRow = (row) => ({ service_type: row.service_type, service_key: row.service_key_snapshot });
  if (deps.isCommercialServiceRow({ service_type: record.service_type })) return true;
  if (deps.isCommercialAccount(rows.customer)) return true;
  const planRows = record.scheduled_service_id ? [rows.visit, rows.root] : rows.active;
  return planRows.filter(Boolean).some((row) => deps.isCommercialServiceRow(asRow(row))
    || deps.commercialPropertyTypes.includes(row.property_type));
}

// Is the visit part of an ACTIVE recurring pest plan? Series membership in the
// past is not a plan: the canonical active-series source decides (the root is not
// cancelled, and it is flagged ongoing or has a live future member), and the
// visit's own series root must be one of its active pest series. An unlinked
// record cannot be tied to a series, so it counts only when the customer's active
// pest series are all at ONE property.
function activeRecurringPestPlan({ deps, record, rows }) {
  if (record.scheduled_service_id) {
    if (!rows.visit) return false;
    const rootId = String(rows.visit.recurring_parent_id || rows.visit.id);
    return rows.active.some((parent) => String(parent.id) === rootId);
  }
  return rows.active.length > 0 && allSameProperty(rows.active, deps);
}

// THE eligibility for the free-re-service promise both templates make ("a re-service
// between visits is free"), as ONE ALLOW-LIST — not a growing blocklist. Only a plan
// that the canonical service-lane parser (estimate-followup-copy
// copyCategoryForEstimate: the rule behind AGENTS.md's "estimate follow-up truth
// scope", where rodent / termite / commercial / bundle / unknown lanes stay
// terms-neutral) classifies as a SINGLE, residential, general-PEST lane passes, and
// only when it is also an active recurring series and not commercial. Anything the
// parser cannot classify (a bundle such as "Pest + Termite Bait Station", "Pest &
// Lawn", an unknown label) is NOT eligible. Every label the plan carries — the
// record's, and its EFFECTIVE appointment, series root or inferred series — must
// parse as that one lane. Pure over the rows effectivePlanRows returned. Returns
// null when eligible, else the skip.
function freeReserviceEligible({ deps, record, rows }) {
  if (isCommercialPlan({ deps, record, rows })) return skip('commercial plans are not sent this residential email', 'not_residential_plan');
  const planRows = record.scheduled_service_id ? [rows.visit, rows.root] : rows.active;
  const isPestLabel = (label) => deps.copyCategoryForEstimate({ service_interest: label }) === 'pest';
  // The catalog KEY is a row's primary identity. A row that carries a snapshot is a
  // single pest service only when the snapshot is an allow-listed pest key AND its
  // label (when it has one) reads as pest too; any disagreement fails closed. A row
  // with no snapshot is judged on its label alone.
  const rowIsSinglePest = (row) => {
    const key = clean(row.service_key_snapshot).toLowerCase();
    const label = clean(row.service_type);
    if (key) return deps.singlePestCatalogKeys.includes(key) && (!label || isPestLabel(label));
    return Boolean(label) && isPestLabel(label);
  };
  const recordLabel = clean(record.service_type);
  const rowsToJudge = planRows.filter(Boolean);
  if ((!recordLabel && !rowsToJudge.length) || (recordLabel && !isPestLabel(recordLabel)) || !rowsToJudge.every(rowIsSinglePest)) {
    return skip('the plan is not a single residential general-pest service (bundles, other lanes and unrecognised labels stay terms-neutral)', 'not_single_pest_lane');
  }
  if (!activeRecurringPestPlan({ deps, record, rows })) {
    return skip('the visit does not belong to an active recurring pest plan', 'not_recurring_plan');
  }
  return null;
}

// Every condition that makes this THE customer's first performed pest visit
// for this recipient: returns a skip, or { record, customer }.
async function firstVisitGate({
  run, conn, deps, lock = false,
}) {
  const customerId = run.recipient_id;
  const record = await loadPerformedVisit(conn, deps, run.entity_id, { lock });
  if (!record) return skip('visit is not a completed, customer-visible, performed service record', 'visit_not_eligible');
  if (!customerId || clean(record.customer_id) !== clean(customerId)) {
    return skip('the visit does not belong to the recipient customer', 'recipient_not_visit_customer');
  }
  if (record.service_line !== 'pest') return skip('not a pest-line visit', 'not_pest_line');
  const rows = await effectivePlanRows(conn, deps, record, { lock });
  const ineligible = freeReserviceEligible({ deps, record, rows });
  if (ineligible) return ineligible;

  // First performed visit on the line, judged against records that existed
  // BEFORE this one (a delayed run must not read a later visit as "prior").
  // Ordered by (created_at, id): two records created at the same instant tie-break
  // on id, so exactly one of them is "first".
  const earlier = conn('service_records').where('service_records.customer_id', customerId)
    .whereNot('service_records.id', record.id)
    .where((qb) => qb.where('service_records.created_at', '<', record.created_at)
      .orWhere((tie) => tie.where('service_records.created_at', record.created_at).where('service_records.id', '<', record.id)));
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

// The pests recorded at the visit. The technician's STRUCTURED treatment targets
// (the chips committed per applied product; never a nutrition or adjuvant
// product's) are preferred; only without them do the technician's notes count, and
// then through the negation-aware reader ("no ghost ants found; treated spiders"
// names spiders only). readVisitSummary's own pestsNamed is negation-blind, so it
// is not used here.
async function pestsRecorded({
  products, record, deps, conn,
}) {
  // Only targets in the CANONICAL vocabulary (the picker's suggestion lists ∪
  // products_catalog.target_pests, as area-intel reads it) may render: the picker
  // also accepts free text, and a hand-typed chip ("technicians treated no pests -
  // prevention") is not a pest.
  const vocabulary = await deps.canonicalTargetVocabulary(conn);
  const targets = [];
  for (const product of products || []) {
    if (product.family === 'nutrition' || product.family === 'adjuvant') continue;
    for (const target of product.targets || []) {
      const key = deps.treatmentTargetKey(target);
      if (key && vocabulary.has(key) && !targets.includes(key)) targets.push(key);
    }
  }
  if (targets.length) return targets.map((key) => deps.targetForSentence(key));
  return deps.parsePestsNamed(positiveText(record.technician_notes));
}

async function buildFirstVisitPest({
  run, conn = db, deps = defaultDeps(), mode = 'live', lock = false,
}) {
  const gate = await firstVisitGate({
    run, conn, deps, lock,
  });
  if (gate.skip) return gate;
  const { record, customer } = gate;
  if ((await priorSends({
    conn, run, customerId: customer.id, byProperty: true,
  })) === 'sent') {
    return skip('this customer already has a sent first-visit email for this property', 'already_delivered');
  }

  const { primary, secondary, products } = await deps.readVisitProducts(record.id, { conn });
  if (!primary) return skip('no customer-visible primary product recorded for the visit', 'no_primary_product');
  const summary = await deps.readVisitSummary(record.id, { conn });
  if (!summary) return skip('visit summary unavailable', 'visit_summary_missing');

  const visitYmd = dateOnlyString(summary.visitDate || record.service_date);
  const { byVisit } = await deps.getActivityRatingAverages({ conn });
  const nextVisit = await nextPestVisit({
    conn, deps, record, serviceYmd: visitYmd, lock,
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
    pests_named_list: listSentence(await pestsRecorded({
      products, record, deps, conn,
    })),
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
  return built(payload, {
    own_rating: [record.client_pest_rating ?? null, clean(record.client_pest_rating_source), record.client_pest_rating_defaulted ?? null],
  });
}

// ---------------------------------------------------------------------------
// B5 — lc.why_91_days
// ---------------------------------------------------------------------------

// The plan the visit belongs to: its cadence (normalized by the scheduler's own
// alias table, for the visit and then its parent) and the visit's FROZEN service
// city. The city is the appointment's own (scheduled_services.service_address_*);
// never customers.city, which belongs to a different property on a
// multi-property customer. Empty strings mean "unknown".
function planService(deps, rows) {
  const none = { pattern: '', city: '' };
  const visit = rows.visit;
  // The plan is the PEST series: a visit that is not a pest appointment says
  // nothing about the pest plan's cadence.
  if (!visit || deps.detectServiceLine(visit.service_type) !== 'pest') return none;
  // The series this appointment belongs to: its root (the parent, or itself when
  // it is the root) and its property, so plan evidence can be held to them.
  const identity = {
    city: clean(visit.service_address_city),
    rootId: visit.recurring_parent_id || visit.id,
    visitRow: visit,
  };
  const own = deps.normalizeRecurringPattern(visit.recurring_pattern);
  if (own) return { pattern: own, ...identity };
  if (!visit.recurring_parent_id) return { pattern: '', ...identity };
  const parent = rows.root;
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

// The appointment identity (property columns) behind a service record, or null.
async function recordPropertyRow(conn, recordId) {
  if (!recordId) return null;
  const row = await conn('service_records as sr')
    .leftJoin('scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id')
    .where('sr.id', recordId)
    .first(...PROPERTY_COLUMNS.map((column) => `ss.${column} as ${column}`));
  return row || null;
}

// `byProperty`: the once-rule is per customer AND PROPERTY (B1): a sibling counts
// only when its record's appointment is at a compatible property (an unrecorded
// identity is conservatively the same property).
async function priorSends({
  conn, run, customerId = null, estimateId = null, byProperty = false,
}) {
  const deps = defaultDeps();
  const others = (query, column) => (run.idempotency_key ? query.whereNot(column, run.idempotency_key) : query);
  const sentRuns = conn('email_template_automation_runs').where({ template_key: run.template_key, status: 'sent' });
  if (run.id) sentRuns.whereNot({ id: run.id });
  if (estimateId) sentRuns.where({ entity_type: 'estimate', entity_id: String(estimateId) });
  else sentRuns.where({ recipient_id: String(customerId) });
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
  if (!byProperty) {
    if (await sentRuns.first('id')) return 'sent';
    const rows = await ledger.select('l.status');
    if (rows.some((row) => row.status === 'sent')) return 'sent';
    return rows.length ? 'in_flight' : null;
  }
  const mine = await recordPropertyRow(conn, run.entity_id);
  const sameScope = async (entityId) => propertyCompatible(mine, await recordPropertyRow(conn, entityId), deps);
  for (const row of await sentRuns.select('entity_id')) {
    if (await sameScope(row.entity_id)) return 'sent';
  }
  const rows = await ledger.leftJoin('email_template_automation_runs as lr', 'lr.idempotency_key', 'l.idempotency_key')
    .select('l.status', 'lr.entity_id');
  let inFlight = false;
  for (const row of rows) {
    if (row.entity_id && !(await sameScope(row.entity_id))) continue;
    if (row.status === 'sent') return 'sent';
    inFlight = true;
  }
  return inFlight ? 'in_flight' : null;
}

const ESTIMATE_RECIPIENT_CHANGED = 'ESTIMATE_RECIPIENT_CHANGED';
const ESTIMATE_NOT_EXPIRED = 'ESTIMATE_NOT_EXPIRED';
const ESTIMATE_EXPIRY_SUPERSEDED = 'ESTIMATE_EXPIRY_SUPERSEDED';
const ESTIMATE_FOLLOWUP_BLOCKED = 'ESTIMATE_FOLLOWUP_BLOCKED';
const VISIT_NOT_ELIGIBLE = 'VISIT_NOT_ELIGIBLE';
const BUILDER_SKIPPED = 'BUILDER_SKIPPED';
const PAYLOAD_CHANGED = 'PAYLOAD_CHANGED';
const ESTIMATE_VERDICT_REASONS = new Set([ESTIMATE_RECIPIENT_CHANGED, ESTIMATE_NOT_EXPIRED, ESTIMATE_EXPIRY_SUPERSEDED, ESTIMATE_FOLLOWUP_BLOCKED]);

// The expiry date (ET, YYYY-MM-DD) the run was created for: the emitter's
// expires_on, carried on the run's stored payload (and context).
function runExpiresOn(run) {
  const on = clean(runStoredPayloadValue(run, 'expires_on'));
  return /^\d{4}-\d{2}-\d{2}$/.test(on) ? on : '';
}
// A value from the run's STORED payload (or context): what the trigger carried, not
// the live-refreshed copy livePayloadForRun puts on the execution payload.
function runStoredPayloadValue(run, key) {
  const parse = (value) => {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value) || {}; } catch { return {}; }
  };
  return parse(run.payload)[key] ?? parse(run.context)[key];
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
// Shadow's once-rule for B1 (per customer AND property): does any rival run's record
// sit at a compatible property?
async function anyRivalAtSameProperty(conn, run, rivals) {
  const deps = defaultDeps();
  const mine = await recordPropertyRow(conn, run.entity_id);
  for (const rival of rivals) {
    if (propertyCompatible(mine, await recordPropertyRow(conn, rival.entity_id), deps)) return true;
  }
  return false;
}

// THE generic provider-boundary recheck for the three builder-backed templates.
// At build, the executor fingerprints the payload (a stable hash of the builder's
// variables, volatile inputs excluded) and keeps it on the run. At the boundary the
// SAME builder is re-run against the locked rows (mode 'boundary': read-only, no
// radar, no minted links, no consultation probe) and the fingerprint recomputed:
//   - the builder now skips: a terminal refusal with the builder's own code;
//   - it passes with a different fingerprint (the evidence changed since the
//     build): PAYLOAD_CHANGED, retryable — the executor defers the run budget-
//     neutrally so the next attempt rebuilds from fresh data;
//   - it passes with the same fingerprint: send.
// Excluded as volatile (they differ between two reads of identical evidence, or are
// minted per call): rain_since_visit_sentence (radar read), the cohort statistics
// activity_rating_sentence / activity_avg_first_visit / activity_avg_second_visit
// (live aggregates over every customer's ratings; the record's OWN rating is
// fingerprinted as evidence instead), estimate_link and consultation_url (minted
// short links; the estimate's token is fingerprinted as evidence instead, and the
// consultation offer is not fingerprinted).
const VOLATILE_PAYLOAD_KEYS = new Set([
  'rain_since_visit_sentence', 'activity_rating_sentence', 'activity_avg_first_visit', 'activity_avg_second_visit',
  'estimate_link', 'consultation_url',
]);
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
function payloadFingerprint(payload, evidence = {}) {
  const stable = Object.fromEntries(Object.entries(payload || {}).filter(([key]) => !VOLATILE_PAYLOAD_KEYS.has(key)));
  return crypto.createHash('sha256').update(stableStringify({ payload: stable, evidence })).digest('hex');
}

// The rows the builders read to render a visit email, share-locked for the rest of
// the boundary transaction (the gates lock their own rows): the record's products
// (a recap resubmission replaces them), the technician, the customer.
async function lockVisitEvidence(trx, record, recordIds) {
  await trx('service_records').whereIn('id', recordIds).orderBy('id').forShare().select('id');
  await trx('service_products').whereIn('service_record_id', recordIds).orderBy('id').forShare().select('id');
  if (record.technician_id) await trx('technicians').where({ id: record.technician_id }).forShare().select('id');
  await trx('customers').where({ id: record.customer_id }).forShare().select('id');
}
async function lockEstimateEvidence(trx, run) {
  const estimate = await trx('estimates').where({ id: run.entity_id }).first('id', 'property_id');
  if (!estimate) return;
  await trx('customers').where({ id: run.recipient_id }).forShare().select('id');
  if (estimate.property_id) await trx('customer_properties').where({ id: estimate.property_id }).forShare().select('id');
  await trx('leads').where({ estimate_id: estimate.id }).orderBy('id').forShare().select('id');
}

async function boundaryRebuildVerdict({
  trx, run, payload, fingerprint,
}) {
  if (!fingerprint) return null; // no build fingerprint (shadow): nothing to compare
  const result = await buildEmailDivisionPayload({
    run, payload, mode: 'boundary', conn: trx, lock: true,
  });
  if (result.skip) return { reason: `${BUILDER_SKIPPED}:${result.code}` };
  return result.fingerprint === fingerprint ? null : { reason: PAYLOAD_CHANGED, retryable: true };
}

// A boundary refusal the executor settles terminally with its own guard (the
// estimate verdicts, the visit gate, or a builder that now skips).
function isBoundaryRefusal(reason) {
  return ESTIMATE_VERDICT_REASONS.has(reason) || reason === VISIT_NOT_ELIGIBLE || String(reason || '').startsWith(`${BUILDER_SKIPPED}:`);
}

// Which once-rule (if any) a template has: per customer (B5), per customer and
// property (B1), or per estimate (C1).
function onceScopeFor(run) {
  return { 'lc.why_91_days': 'customer', 'lc.first_visit_pest': 'property', 'nurture.expired_1': 'estimate' }[run.template_key] || null;
}

function ledgerGuardsFor(run, payload = {}, fingerprint = null) {
  const scope = onceScopeFor(run);
  const visitGate = { 'lc.first_visit_pest': firstVisitGate, 'lc.why_91_days': whyPlanGate }[run.template_key];
  if (!scope && !visitGate) return { guard: null, boundaryGuard: null };
  const once = scope && (async (trx) => {
    const state = await priorSends({
      conn: trx,
      run,
      customerId: scope === 'estimate' ? null : run.recipient_id,
      estimateId: scope === 'estimate' ? run.entity_id : null,
      byProperty: scope === 'property',
    });
    if (state === 'sent') return { reason: ONCE_ALREADY_DELIVERED };
    return state ? { reason: ONCE_IN_FLIGHT } : null;
  });
  if (scope === 'estimate') {
    return {
      guard: async (trx) => (await estimateAddressingVerdict(trx, run)) || once(trx),
      boundaryGuard: async (trx) => {
        const verdict = await estimateAddressingVerdict(trx, run, { lock: true });
        if (verdict) return verdict;
        await lockEstimateEvidence(trx, run);
        return boundaryRebuildVerdict({
          trx, run, payload, fingerprint,
        });
      },
    };
  }
  // B1 / B5: the builder's own visit gate (the same function), re-run on the
  // boundary transaction with the service record share-locked to its end: a
  // record that was reassigned, suppressed from the customer report, or
  // renumbered after the build is not sent on stale evidence.
  return {
    guard: once || null,
    boundaryGuard: async (trx) => {
      const gate = await visitGate({
        run, conn: trx, deps: defaultDeps(), lock: true,
      });
      if (gate.skip) return { reason: VISIT_NOT_ELIGIBLE, detail: gate.reason };
      const recordIds = [gate.record.id, ...(gate.planRecordIds || []).slice(0, 2)];
      await lockVisitEvidence(trx, gate.record, [...new Set(recordIds)]);
      return boundaryRebuildVerdict({
        trx, run, payload, fingerprint,
      });
    },
  };
}

// The visit, customer and plan this email may be sent for: a skip, or
// { record, customer, planName }.
async function whyPlanGate({
  run, conn, deps, lock = false,
}) {
  const customerId = run.recipient_id;
  const record = await loadPerformedVisit(conn, deps, run.entity_id, { lock });
  if (!record) return skip('visit is not a completed, customer-visible, performed service record', 'visit_not_eligible');
  if (!customerId || clean(record.customer_id) !== clean(customerId)) {
    return skip('the visit does not belong to the recipient customer', 'recipient_not_visit_customer');
  }
  // The plan's service line: this email's cohort figures are that line's.
  if (record.service_line !== 'pest') return skip('not a pest-line visit', 'not_pest_line');
  const rows = await effectivePlanRows(conn, deps, record, { lock });
  const ineligible = freeReserviceEligible({ deps, record, rows });
  if (ineligible) return ineligible;
  const plan = planService(deps, rows);
  if (plan.pattern !== QUARTERLY_PATTERN) return skip('the customer\'s plan is not the quarterly cadence', 'plan_not_quarterly');
  // Sent once, after the plan's SECOND performed visit. The ordinal is the
  // visit's place among the PERFORMED, non-callback visits of THIS plan's
  // recurring series at its property — not service_records.visit_number, which
  // counts every completed record of the customer and line across properties and
  // callbacks. A later visit never re-qualifies (the email quotes "first visit"
  // and "second visit" averages).
  const memberIds = planSeriesMemberIds({ deps, record, rows, series: plan });
  if (!memberIds) return skip('the visit is not part of a recurring pest series at its property', 'plan_series_unknown');
  const planRecordIds = await performedSeriesRecordIds({ conn, deps, record, memberIds });
  if (planRecordIds.indexOf(record.id) !== 1) return skip('not the plan\'s second performed pest visit', 'not_second_visit');
  const planName = clean(record.service_type);
  if (!planName) return skip('the visit carries no plan / service name', 'no_plan_name');
  const customer = await loadCustomer(conn, customerId);
  if (!customer) return skip('customer not found', 'customer_missing');
  return {
    record, customer, planName, city: plan.city, planRecordIds,
  };
}

// The appointments of the visit's recurring pest series at its property: the
// root and its children, pest only, at the triggering appointment's property (a
// NULL property on either side is "not recorded", not a different one). null when
// the series cannot be established or does not contain the visit's appointment.
function planSeriesMemberIds({
  deps, record, rows, series,
}) {
  if (!series?.rootId) return null;
  const memberIds = rows.members
    .filter((row) => deps.detectServiceLine(row.service_type) === 'pest')
    // The canonical same-property rule (an unrecorded identity is compatible).
    .filter((row) => propertyCompatible(series.visitRow, row, deps))
    .map((row) => row.id);
  return memberIds.includes(record.scheduled_service_id) ? memberIds : null;
}

// The series' PERFORMED, non-callback service records in the order they happened
// (service date, then creation). A callback is a re-service, not a plan visit.
async function performedSeriesRecordIds({
  conn, deps, record, memberIds,
}) {
  const query = conn('service_records').where('service_records.customer_id', record.customer_id)
    .whereIn('service_records.scheduled_service_id', memberIds)
    .where((qb) => qb.whereNull('service_records.is_callback').orWhere('service_records.is_callback', false))
    .orderBy([
      { column: 'service_records.service_date', order: 'asc' },
      { column: 'service_records.created_at', order: 'asc' },
      { column: 'service_records.id', order: 'asc' },
    ]);
  deps.applyPerformedVisitHistoryFilter(query, { serviceLine: 'pest' });
  return (await query.select('service_records.id')).map((row) => row.id);
}

// The plan's products: every performed pest visit of THIS appointment's recurring
// pest series (and property) up to visit 2 — never the customer's other
// properties' visits, where a Taurus application elsewhere would otherwise
// qualify a Talak-only plan here. The non-repellent must be Taurus SC (the
// product whose manufacturer statement the copy quotes) and nothing else
// non-repellent. A series that cannot be established skips.
async function whyPlanProducts({
  record, planRecordIds, conn, deps,
}) {
  const visitIds = planRecordIds.slice(0, 2);
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
  run, conn = db, deps = defaultDeps(), lock = false,
}) {
  const gate = await whyPlanGate({
    run, conn, deps, lock,
  });
  if (gate.skip) return gate;
  const {
    record, customer, planName, city, planRecordIds,
  } = gate;
  if ((await priorSends({ conn, run, customerId: customer.id })) === 'sent') {
    return skip('this customer already has a sent lc.why_91_days email', 'already_delivered');
  }
  const plan = await whyPlanProducts({
    record, planRecordIds, conn, deps,
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
  return clean(deps.parseEstimateAddress(clean(estimate.address))?.city);
}

// Who this estimate is CURRENTLY addressed to, and whether it is still an
// expired one. Used at build time, at the ledger reservation and again at the
// provider boundary (where the row is share-locked for the rest of the handoff
// transaction): a reassignment or an email change, or an extension, between
// the build and the send must never deliver this estimate's bearer link.
// THE eligibility predicate for sending nurture.expired_1 about an estimate row:
// used by the builder (on the row it loaded) AND by the ledger's reservation and
// provider-boundary guards (on a row re-read under a share lock) — one function,
// so what the builder checked is exactly what the boundary re-checks. It covers
// everything the send depends on that can change after the build: the row's
// existence, the shared follow-up rule (archived, noEngagementAutomation), that it
// is still an expired estimate, that it is still the expiry that triggered this
// run (an estimate extended and expired again has a newer run), and that it is
// still addressed to this run's recipient (owner and normalized email).
const ESTIMATE_VERDICT_COLUMNS = ['id', 'status', 'customer_id', 'customer_email', 'expires_at', 'archived_at', 'estimate_data'];
function estimateSendVerdict(estimate, run, expiresOn = runExpiresOn(run)) {
  if (!estimate) return { reason: ESTIMATE_RECIPIENT_CHANGED };
  const blocked = estimateFollowupBlockedReason(estimate);
  if (blocked) return { reason: ESTIMATE_FOLLOWUP_BLOCKED, detail: blocked };
  if (estimate.status !== 'expired') return { reason: ESTIMATE_NOT_EXPIRED, detail: `status is ${estimate.status}` };
  // Compared only when both sides are recorded (an aged-out estimate with no
  // expires_at has no expiry date to compare).
  // The expiry recorded at trigger time (payload expires_at) is what the estimate's
  // CURRENT expires_at must still be; the ET-date compare is the fallback for a run
  // that carries only expires_on. (The effective expires_on can be the earlier FLIP
  // date for an estimate aged out before its stored expiry, so it is not compared to
  // expires_at directly.)
  if (estimate.expires_at) {
    const triggered = runStoredPayloadValue(run, 'expires_at');
    const triggeredTime = triggered ? new Date(triggered).getTime() : NaN;
    if (Number.isFinite(triggeredTime)) {
      if (new Date(estimate.expires_at).getTime() !== triggeredTime) return { reason: ESTIMATE_EXPIRY_SUPERSEDED };
    } else if (expiresOn && etDateString(new Date(estimate.expires_at)) !== expiresOn) {
      return { reason: ESTIMATE_EXPIRY_SUPERSEDED };
    }
  }
  if (clean(estimate.customer_id) !== clean(run.recipient_id)
    || normalizeEmail(estimate.customer_email) !== normalizeEmail(run.recipient_email)) {
    return { reason: ESTIMATE_RECIPIENT_CHANGED };
  }
  return null;
}

// The same predicate on the row as it stands NOW; `lock` share-locks it to the
// end of the caller's transaction (the provider-boundary transaction).
async function estimateAddressingVerdict(conn, run, { lock = false, expiresOn = runExpiresOn(run) } = {}) {
  const query = conn('estimates').where({ id: run.entity_id });
  if (lock) query.forShare();
  return estimateSendVerdict(await query.first(...ESTIMATE_VERDICT_COLUMNS), run, expiresOn);
}

async function buildExpiredNurture({
  run, payload: basePayload = {}, conn = db, deps = defaultDeps(), mode = 'live',
}) {
  const templateKey = 'nurture.expired_1';
  const estimate = await conn('estimates').where({ id: run.entity_id }).first();
  if (!estimate) return skip('linked estimate no longer exists', 'estimate_missing');
  // The run was addressed when the trigger fired: the estimate must still be an
  // expired, follow-up-eligible estimate, at the expiry that triggered this run,
  // addressed to this recipient — or the old recipient would receive the current
  // estimate's bearer link. The SAME predicate the ledger re-runs at the
  // reservation and at the provider boundary. Skips the whole send, never retargets.
  const verdict = estimateSendVerdict(estimate, run, clean(basePayload.expires_on) || runExpiresOn(run));
  if (verdict) {
    return skip({
      [ESTIMATE_RECIPIENT_CHANGED]: 'the estimate\'s customer or email changed since this run was created; not sent to the old recipient',
      [ESTIMATE_EXPIRY_SUPERSEDED]: 'the estimate was extended and expired again since this run was created; a newer run owns the touch',
      [ESTIMATE_NOT_EXPIRED]: `linked estimate is no longer expired (${verdict.detail})`,
      [ESTIMATE_FOLLOWUP_BLOCKED]: `the estimate may not receive automated follow-up: ${verdict.detail}`,
    }[verdict.reason], {
      [ESTIMATE_RECIPIENT_CHANGED]: 'estimate_recipient_changed',
      [ESTIMATE_EXPIRY_SUPERSEDED]: 'estimate_expiry_superseded',
      [ESTIMATE_NOT_EXPIRED]: 'estimate_not_expired',
      [ESTIMATE_FOLLOWUP_BLOCKED]: 'estimate_followup_blocked',
    }[verdict.reason]);
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
    // A linked customer with no first name is greeted 'there', never by the surname the
    // estimate name starts with (shared greeting rule, utils/greeting-first-name).
    first_name: firstToken(greetingFirstToken({ customerName: estimate.customer_name, customer })) || clean(customer.first_name) || 'there',
    service_quoted: serviceQuoted,
    // The street half of the estimate's address, by the canonical parse (a leading
    // unit, "Unit 4, 100 Beach Rd, ...", survives as the unit, not as the street).
    address_short: clean(deps.parseEstimateAddress(clean(estimate.address))?.address_line1),
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
  return built(payload, { estimate_token: clean(estimate.token) });
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
  run, payload = {}, mode = 'live', conn = db, deps = undefined, lock = false,
}) {
  const builder = BUILDERS[run.template_key];
  if (!builder) return { handled: false };
  const result = await builder({
    run, payload, conn, mode, lock, deps: deps ? { ...defaultDeps(), ...deps } : defaultDeps(),
  });
  if (result.skip) return { handled: true, ...result };
  return {
    handled: true,
    ok: true,
    payload: { ...payload, ...result.payload },
    // Of the builder's OWN variables (a stored value never enters it).
    fingerprint: payloadFingerprint(result.payload, result.evidence),
  };
}

module.exports = {
  buildEmailDivisionPayload,
  hasPayloadBuilder: (templateKey) => Object.prototype.hasOwnProperty.call(BUILDERS, templateKey),
  BUILDER_TEMPLATE_KEYS: Object.freeze(Object.keys(BUILDERS)),
  REQUIRED,
  ledgerGuardsFor,
  onceScopeFor,
  anyRivalAtSameProperty,
  positiveText,
  ONCE_ALREADY_DELIVERED,
  ONCE_IN_FLIGHT,
  ESTIMATE_RECIPIENT_CHANGED,
  ESTIMATE_NOT_EXPIRED,
  ESTIMATE_EXPIRY_SUPERSEDED,
  ESTIMATE_FOLLOWUP_BLOCKED,
  VISIT_NOT_ELIGIBLE,
  BUILDER_SKIPPED,
  PAYLOAD_CHANGED,
  isBoundaryRefusal,
  payloadFingerprint,
  ESTIMATE_VERDICT_REASONS,
  buildFirstVisitPest,
  buildWhy91Days,
  buildExpiredNurture,
};
