const express = require('express');
const { normalizeContactRole } = require('../constants/contact-roles');
const router = express.Router();
const db = require('../models/db');
const { addETDays } = require('../utils/datetime-et');
const LeadScorer = require('../services/lead-scorer');
const PipelineManager = require('../services/pipeline-manager');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const { stageLifecycleStamps } = require('../services/customer-stages');
const { etDateString } = require('../utils/datetime-et');
const { formatAddress, normalizeUnitLine } = require('../utils/address-normalizer');
const { recordAuditEvent } = require('../services/audit-log');
const { lockCustomerComms, withCustomerCommsLock } = require('../utils/customer-comms-lock');
const { invoiceAmountDue } = require('../services/invoice-helpers');
const PhotoService = require('../services/photos');
const { acceptanceServiceLists } = require('./estimate-public');
const AccountMembershipEmail = require('../services/account-membership-email');
const { listCustomerPrepaidPlans } = require('../services/prepaid-series');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('../services/short-url');
const { publicPortalUrl } = require('../utils/portal-url');
const { documentRequiresSignature } = require('../services/contracts');
const CustomerCredit = require('../services/customer-credit');
const {
  normalizeContactName,
  normalizeContactPhone,
  normalizeContactEmail,
  normalizeContactRecord,
  clearLineTypeOnPhoneChange,
  normalizeAdminAddressInput,
} = require('../utils/intake-normalize');

router.use(adminAuthenticate, requireTechOrAdmin);

// ─── Technician scoping ─────────────────────────────────────────────────────
// requireTechOrAdmin admits technician tokens, but a tech must not be able to
// browse arbitrary customers' profiles, payment methods, or CRM state — a
// field token grants access only to the customers whose visits are assigned
// to that tech. Admin requests are unscoped. Endpoints with no tech surface
// at all (comms, timeline, credits, pipeline, CRM writes) are requireAdmin
// outright.
// Assignment currency — ONE predicate for every technician access path
// (per-customer proxy AND the directory subquery): dead statuses never
// authorize, and everything else (pending/confirmed/en_route/on_site/
// completed) must sit inside the ET date window. Completed visits stay
// accessible for post-visit paperwork; a stale never-actioned pending row
// or a years-old completion grants nothing.
const TECH_ACCESS_DEAD_STATUSES = ['cancelled', 'canceled', 'rescheduled', 'skipped', 'no_show'];
const TECH_ACCESS_WINDOW_DAYS = 7;
const techAccessCutoff = () => etDateString(addETDays(new Date(), -TECH_ACCESS_WINDOW_DAYS));

function currentAssignmentFilter(q, technicianId) {
  return q
    .where('scheduled_services.technician_id', technicianId)
    .whereNotIn('scheduled_services.status', TECH_ACCESS_DEAD_STATUSES)
    .where('scheduled_services.scheduled_date', '>=', techAccessCutoff());
}

async function technicianServicesCustomer(req, customerId) {
  if (req.techRole !== 'technician') return true;
  const assigned = await currentAssignmentFilter(
    db('scheduled_services').where({ customer_id: customerId }),
    req.technicianId,
  ).first('id');
  return !!assigned;
}

// Fields stripped from list rows for technician tokens. The field flows
// that search customers (estimate builder, project-report picker) render
// identity, contact, address, and service context — not account financials
// or CRM/marketing state.
const TECH_LIST_STRIPPED_FIELDS = [
  'lifetimeRevenue', 'balanceOwed', 'cardsOnFile', 'healthScore',
  'pipelineStage', 'leadScore', 'leadSource', 'leadSourceDetail',
  'landingPageUrl', 'lastContactDate', 'lastContactType', 'nextFollowUp',
  'lastRating', 'tags',
  // Account pricing is office-only — the field flows that search customers
  // never render plan price, and the server-priced estimate builder doesn't
  // take it from directory rows.
  'monthlyRate',
];

function techSafeListRow(mapped) {
  const out = { ...mapped };
  for (const field of TECH_LIST_STRIPPED_FIELDS) delete out[field];
  return out;
}

// Filters and sorts a technician token may drive the directory with:
// identity/service context only. CRM/financial filters (stage, tag, source,
// cards, hasBalance) and sorts over stripped fields (revenue, lead_score,
// last_contact) would otherwise leak exactly what techSafeListRow removes —
// result membership and `total` under `?hasBalance=true` IS the balance
// field.
function techSafeListFilters(filters) {
  const { search, tier, area, city, lastVisited } = filters;
  return { search, tier, area, city, lastVisited };
}

// 'rate' is NOT safe: sorting by a stripped field (monthlyRate) is the same
// inference channel as filtering by one.
const TECH_SAFE_SORTS = new Set(['name']);

function techSafeSort(sort) {
  return TECH_SAFE_SORTS.has(sort) ? sort : 'name';
}

// 360 payload keys a technician token never receives: payment instruments,
// billing/consent/contract records, comms history, and CRM/marketing state.
// /comms and /timeline are requireAdmin — the 360 endpoint must not
// re-expose the same data to an assigned tech.
const TECH_360_STRIPPED_KEYS = [
  'interactions', 'smsLog', 'payments', 'invoices', 'cards',
  'paymentMethodConsents', 'contracts', 'annualPrepayTerms', 'prepaidPlans',
  'notificationPrefs', 'referralInfo', 'customerDiscounts', 'healthScore',
  'tags',
  // Sibling properties on the account: authorization is per-customer, so an
  // assignment at ONE property must not expose the addresses of the others.
  'accountProperties',
  // Estimate rows carry permanent public bearer tokens (customer-facing
  // accept/decline actions) plus decline data — office-only. No tech
  // surface reads estimates from the 360 payload.
  'estimates',
];
const TECH_360_STRIPPED_CUSTOMER_FIELDS = [
  'payerId', 'billingMode', 'monthlyRate', 'annualValue', 'lifetimeRevenue',
  'pipelineStage', 'leadScore', 'leadSource', 'leadSourceDetail',
  'landingPageUrl', 'lastContactDate', 'nextFollowUp', 'followUpNotes',
  'crmNotes', 'referralCode', 'hasLeftGoogleReview', 'reviewMarkedAt',
  // Billing pause: a failed-autopay state and its reason. Same class as
  // monthlyRate/billingMode — office-only. A technician opening Customer 360
  // for a visit they're assigned must not see "autopay failed three times"
  // (and the Resume control is admin-gated in the client anyway, so the
  // fields would only render an alert they cannot act on).
  'servicePausedAt', 'servicePausedOn', 'servicePauseReason',
];

// Appointment history for the customer-detail payload (`scheduled`): past +
// future, all statuses, capped to the rows NEAREST ET-today (ties: newest
// first). Consumers (ScheduleCustomerSidebar, MobileCustomerDetailSheet,
// SchedulePage history) sort client-side; upcoming lists read
// `upcomingScheduled` instead. A plain ASC/DESC order under a cap returned
// only the oldest rows (long-tenured customers) or only the farthest-future
// rows (24-visit fixed series) — proximity keeps the current visit and the
// recent past in every case.
const SCHEDULED_HISTORY_LIMIT = 50;
function customerScheduledHistoryQuery(dbConn, customerId, today = etDateString()) {
  return dbConn('scheduled_services')
    .where({ customer_id: customerId })
    .orderByRaw('abs(scheduled_date - ?::date) asc', [today])
    .orderBy('scheduled_date', 'desc')
    .orderBy('window_start', 'desc')
    .limit(SCHEDULED_HISTORY_LIMIT);
}

// `?focusServiceId=` — the visit the admin has open. A customer with more
// than the cap's worth of nearer rows would otherwise drop it from
// `scheduled` and the drawer loses its "Current" row, so it is fetched
// explicitly (same customer only) and appended when the window missed it.
async function customerScheduledHistory(dbConn, customerId, { today = etDateString(), focusServiceId = null } = {}) {
  const rows = await customerScheduledHistoryQuery(dbConn, customerId, today);
  if (!focusServiceId || rows.some((r) => String(r.id) === String(focusServiceId))) return rows;
  const focus = await dbConn('scheduled_services').where({ id: focusServiceId, customer_id: customerId }).first();
  return focus ? [...rows, focus] : rows;
}

function techSafe360Payload(payload) {
  const out = { ...payload };
  for (const key of TECH_360_STRIPPED_KEYS) delete out[key];
  out.customer = { ...payload.customer };
  for (const field of TECH_360_STRIPPED_CUSTOMER_FIELDS) delete out.customer[field];
  return out;
}

function dateOnlyForApi(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).split('T')[0].slice(0, 10);
}

// Membership-state predicate lives in services/membership-state.js (one
// copy — the lawn-email gap check consults the same rule these lifecycle
// emails key off).
const { NON_MEMBERSHIP_TIER_KEYS, membershipTierKey, hasMembership } = require('../services/membership-state');

function comparableMembershipTier(value) {
  const tierKey = membershipTierKey(value);
  return NON_MEMBERSHIP_TIER_KEYS.has(tierKey) ? '' : tierKey;
}

function comparableMonthlyRate(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function membershipDetailsChanged(before = {}, after = {}) {
  return comparableMembershipTier(before.waveguard_tier ?? before.tier) !== comparableMembershipTier(after.waveguard_tier ?? after.tier)
    || comparableMonthlyRate(before.monthly_rate ?? before.monthlyRate) !== comparableMonthlyRate(after.monthly_rate ?? after.monthlyRate);
}

function membershipChangeFingerprint(before = {}, after = {}) {
  return [
    comparableMembershipTier(before.waveguard_tier ?? before.tier) || 'none',
    comparableMonthlyRate(before.monthly_rate ?? before.monthlyRate),
    comparableMembershipTier(after.waveguard_tier ?? after.tier) || 'none',
    comparableMonthlyRate(after.monthly_rate ?? after.monthlyRate),
  ].join(':');
}

function adminMembershipDailyIdempotencyKey(eventType, customerId, source, eventAt = new Date()) {
  return `${eventType}:${customerId}:${source}:${etDateString(eventAt)}`;
}

function adminMembershipStartIdempotencyKey(customerId, before = {}, after = {}, eventAt = new Date()) {
  const eventStamp = eventAt instanceof Date && !Number.isNaN(eventAt.getTime())
    ? eventAt.toISOString()
    : new Date().toISOString();
  return `membership.started:${customerId}:admin:${etDateString(eventAt)}:${eventStamp}:${membershipChangeFingerprint(before, after)}`;
}

// Full legal stage list lives in the canonical customer-stages service so
// every writer (this route, IB single+bulk) validates the same set.
const CUSTOMER_STAGES = require('../services/customer-stages').ALL_PIPELINE_STAGES;
const CUSTOMER_STAGE_SET = new Set(CUSTOMER_STAGES);

const SERVICE_KEY_ALIASES = {
  pest_control: ['pest_general_quarterly'],
  pest_initial_roach: ['pest_initial_cleanout'],
  german_roach: ['pest_initial_cleanout'],
  german_roach_initial: ['pest_initial_cleanout'],
  lawn_care: ['lawn_care_recurring'],
  tree_shrub: ['tree_shrub_program'],
  mosquito: ['mosquito_monthly'],
  termite_bait: ['termite_bait'],
  termite_bait_installation: ['termite_bait'],
  rodent_bait: ['rodent_bait_quarterly', 'rodent_monitoring'],
  rodent_bait_station: ['rodent_bait_quarterly', 'rodent_monitoring'],
  rodent_bait_stations: ['rodent_bait_quarterly', 'rodent_monitoring'],
  rodent_monitoring: ['rodent_monitoring'],
  rodent_trapping: ['rodent_exclusion'],
  rodent_exclusion: ['rodent_exclusion'],
  trenching: ['termite_liquid'],
  termite_liquid: ['termite_liquid'],
  wdo: ['wdo_inspection'],
  wdo_inspection: ['wdo_inspection'],
  flea: ['flea_tick'],
  flea_exterior: ['flea_tick'],
  fire_ant: ['fire_ant'],
  bee_wasp: ['bee_wasp_removal'],
  bee_wasp_removal: ['bee_wasp_removal'],
  palm_injection: ['palm_treatment'],
  palm_treatment: ['palm_treatment'],
};

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function moneyOrNull(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 100) / 100;
  }
  return null;
}

function normalizeServiceKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cadenceFromEstimateLine(line, fallback = 'one_time') {
  // The full shared cadence-field vocabulary (codex r18 pre-push P0):
  // reading only frequency/freq/cadence let a valid
  // { frequencyKey: 'semiannual' } palm line pass catalog validation but
  // prefill the quarterly fallback — the modal would create a quarterly
  // series on the two-application service. First non-blank wins, same
  // precedence as the converter's readers; `freq` is this reader's own
  // legacy alias.
  const frequency = String(
    line?.frequency || line?.freq || line?.cadence
    || line?.frequencyKey || line?.frequency_key
    || line?.recurringPattern || line?.recurring_pattern
    || line?.cadenceKey || line?.cadence_key
    || line?.planFrequency || line?.plan_frequency
    || ''
  ).toLowerCase();
  const frequencyKey = frequency.replace(/[-_\s]+/g, '');
  const visits = Number(line?.visitsPerYear ?? line?.visits_per_year ?? line?.visits ?? line?.apps);
  // Seasonal mosquito (9 visits): its quote rows carry frequency
  // 'every_6_weeks' (the estimate-public tier map), but nine mosquito visits
  // have exactly ONE valid cadence — the Feb–Oct walk. Without this the modal
  // pre-fill books a custom 42-day series (including winter visits), and the
  // converter's forced resolver never runs because the booking route creates
  // the series itself (skipAutoSchedule). Same rule as
  // converterFollowUpSeedingPattern / annualPrepayCoverageCadence.
  const RecurringAppointmentSeeder = require('../services/recurring-appointment-seeder');
  if (RecurringAppointmentSeeder.serviceKeyFor(line || {}) === 'mosquito' && visits === 9) {
    return RecurringAppointmentSeeder.SEASONAL_FEB_OCT;
  }
  // Before the month-based buckets: an every-6-weeks plan (9 visits/year) has
  // no month-based cadence — without this it fell to the quarterly fallback,
  // so a 6-week quote pre-filled the modal as quarterly and the prepay
  // cadence-match preflight downgraded the booking (codex P2). The caller
  // translates this to the scheduler's custom/42-day representation.
  // Explicitly one-time spellings resolve 'one_time' — never the recurring
  // fallback (codex r18 P1): a { frequency: 'one_time' } palm row in the
  // recurring list kept its one-time catalog match (r17) but then
  // prefilled cadence 'quarterly' here, and the modal trusts the server
  // cadence ahead of billingType — saving would create a quarterly series
  // linked to the one-time service. The SHARED vocabulary
  // (explicitlyOneTimeCadence) covers every cadence-field spelling
  // (frequencyKey, recurring_pattern, planFrequency, …); the local token
  // check additionally covers this reader's own `freq` alias, which the
  // converter vocabulary does not carry.
  try {
    const { explicitlyOneTimeCadence } = require('../services/estimate-converter');
    if (explicitlyOneTimeCadence(line || {})) return 'one_time';
  } catch { /* fall through to the local token check */ }
  if (['onetime', 'once', 'single'].includes(frequencyKey)) return 'one_time';
  if (frequencyKey.includes('every6week')) return 'every_6_weeks';
  if (frequencyKey.includes('bimonthly') || frequencyKey.includes('every2month') || frequencyKey.includes('everyothermonth')) return 'bimonthly';
  if (frequencyKey.includes('triannual') || frequencyKey.includes('every4month')) return 'triannual';
  if (frequencyKey.includes('semiannual') || frequencyKey.includes('biannual') || frequencyKey.includes('every6month')) return 'semiannual';
  if (frequencyKey.includes('quarter') || frequencyKey.includes('every3month')) return 'quarterly';
  if (frequencyKey.includes('monthly') || frequencyKey === 'month') return 'monthly';
  if (frequencyKey.includes('annual') || frequencyKey.includes('year')) return 'annual';
  if (visits === 12) return 'monthly';
  if (visits === 9) return 'every_6_weeks';
  if (visits === 6) return 'bimonthly';
  if (visits === 4) return 'quarterly';
  if (visits === 3) return 'triannual';
  if (visits === 2) return 'semiannual';
  if (visits === 1 && fallback !== 'one_time') return 'annual';
  return fallback;
}

function indexServicesForSchedule(rows = []) {
  const byKey = new Map();
  const byName = new Map();
  for (const row of rows) {
    if (row.service_key) byKey.set(normalizeServiceKey(row.service_key), row);
    if (row.name) byName.set(normalizeServiceKey(row.name), row);
    if (row.short_name) byName.set(normalizeServiceKey(row.short_name), row);
  }
  return { byKey, byName, rows };
}

function serviceCatalogMatch(line, serviceIndex) {
  // The explicit serviceKey is its own candidate, tried FIRST (codex r17
  // P2): an accepted seasonal selection is restamped as { service:
  // 'mosquito', serviceKey: 'mosquito_seasonal' }, and folding serviceKey
  // into a service-wins fallback made the exact seasonal row unreachable —
  // the fuzzy matcher then returned mosquito_monthly.
  // service_key (snake) joined the explicit vocabulary (codex r22
  // pre-push P0) — persisted lines carry it, and missing it bypassed the
  // fail-closed palm contradiction guards.
  const explicitKey = normalizeServiceKey(line?.serviceKey || line?.service_key || line?.key || '');
  const rawKey = normalizeServiceKey(line?.service || '');
  const labelKey = normalizeServiceKey(line?.name || line?.label || line?.displayName || '');
  const candidates = [
    explicitKey,
    rawKey,
    labelKey,
    ...(SERVICE_KEY_ALIASES[explicitKey] || []),
    ...(SERVICE_KEY_ALIASES[rawKey] || []),
    ...(SERVICE_KEY_ALIASES[labelKey] || []),
  ].filter(Boolean);

  // Recurring palm (owner ruling 2026-08-11, codex #3349 r3 P1): the
  // estimator's two-application palm line carries service 'palm_injection',
  // whose exact-key match is the active ONE-TIME row — an admin-booked
  // semiannual palm plan would inherit its one-time billing and token_only
  // completion posture. Gate on the converter's OWN seeding resolver (the
  // same gate the converter paths use) so a semiannual line routes to the
  // recurring row while 1x and cadence-less palm lines keep the one-time
  // match. No explicitKey guard needed: an explicit serviceKey selection
  // stays candidate #1 ahead of this, mirroring the seasonal-mosquito rule.
  // An EXPLICIT one-time palm selection beside recurring evidence is a
  // contradiction (codex r18 pre-push P0): the exact-key match would carry
  // the one-time id while the prefilled cadence (inferred from the visit
  // count) submits a RECURRING series on it — recurring-plan work
  // completing with one-time billing/token-only posture. Reject to
  // unmatched; the operator resolves which program was actually sold. An
  // explicit one-time key on a genuinely one-time line (1 visit,
  // count-less) keeps its exact match.
  if (explicitKey === 'palm_injection') {
    try {
      const {
        visitsPerYearForRecurringService, visitCountFieldsConflict,
        visitCountFieldsInvalid, explicitCadenceFieldForService,
        explicitlyOneTimeCadence,
      } = require('../services/estimate-converter');
      const visits = visitsPerYearForRecurringService(line || {});
      const contradictsOneTime = visitCountFieldsConflict(line || {})
        || visitCountFieldsInvalid(line || {})
        || (visits != null && visits > 1)
        || (!!explicitCadenceFieldForService(line || {}) && !explicitlyOneTimeCadence(line || {}));
      if (contradictsOneTime) {
        logger.warn('[admin-customers] explicit one-time palm key beside recurring evidence — leaving line unmatched (fail closed)');
        return null;
      }
    } catch (resolveErr) {
      logger.warn(`[admin-customers] explicit palm key validation failed (${resolveErr.message}) — leaving palm line unmatched (fail closed)`);
      return null;
    }
  }
  // The symmetric contradiction (codex r18 pre-push P0): an explicit
  // SEMIANNUAL palm key whose line data resolves anything other than a
  // valid semiannual program ({ frequency: 'monthly', visitsPerYear: 2 })
  // would pair the semiannual service id with a mismatched prefill
  // cadence — the modal trusts the cadence and could create a 12-visit
  // series on a two-application per-application program. Reject to
  // unmatched when cadence DATA is present but invalid; a bare explicit
  // selection (no line cadence data to contradict it) keeps the
  // operator's choice.
  // An explicit key that resolves NO catalog row is inert — computed here
  // (hoisted, codex r24 P1) so BOTH palm validation branches treat an
  // unresolved explicit alias ({ serviceKey: 'legacy_palm', … }) as
  // absent, exactly as the fallback matching does.
  const explicitKeyResolves = explicitKey
    && !!(serviceIndex.byKey.get(explicitKey) || serviceIndex.byName.get(explicitKey));
  // The raw `service` field carries the key too (codex r23 P1): a stored
  // { service: 'palm_injection_semiannual', frequency: 'monthly' } line
  // has no explicit key or name, but the candidate loop would match the
  // semiannual row — same validation applies, including under an
  // unresolved explicit alias (codex r24 P1).
  if (explicitKey === 'palm_injection_semiannual'
    || ((!explicitKey || !explicitKeyResolves) && rawKey === 'palm_injection_semiannual')) {
    try {
      const {
        converterFollowUpSeedingPattern, visitsPerYearForRecurringService,
        visitCountFieldsConflict, visitCountFieldsInvalid,
        explicitCadenceFieldForService,
      } = require('../services/estimate-converter');
      const lineName = line?.name || line?.label || line?.displayName || 'Palm Injection';
      const hasCadenceData = !!explicitCadenceFieldForService(line || {})
        || visitsPerYearForRecurringService(line || {}) != null
        || visitCountFieldsConflict(line || {})
        || visitCountFieldsInvalid(line || {});
      if (hasCadenceData
        && converterFollowUpSeedingPattern(line || {}, { service_type: lineName }, undefined) !== 'semiannual') {
        logger.warn('[admin-customers] explicit semiannual palm key with data that does not resolve a valid semiannual program — leaving line unmatched (fail closed)');
        return null;
      }
    } catch (resolveErr) {
      logger.warn(`[admin-customers] explicit semiannual palm key validation failed (${resolveErr.message}) — leaving palm line unmatched (fail closed)`);
      return null;
    }
  }
  // An explicit key that resolves NO catalog row is inert — the fallback
  // matching below governs the outcome, so palm validation must apply as
  // if no explicit key existed (codex r18 pre-push P0: a legacy
  // { serviceKey: 'palm' } spelling otherwise bypassed validation and the
  // candidate loop matched the one-time row for a 2-visit line). Explicit
  // keys that DO resolve are the operator's recognized choice: the two
  // palm identities are validated above, and any other resolved key wins
  // in the candidate loop as before.
  if ((!explicitKey || !explicitKeyResolves) && (rawKey === 'palm_injection' || /palm/.test(labelKey))) {
    try {
      const {
        converterFollowUpSeedingPattern, isPalmInjectionFamily,
        visitsPerYearForRecurringService, visitCountFieldsConflict,
        visitCountFieldsInvalid, explicitCadenceFieldForService,
        explicitlyOneTimeCadence,
      } = require('../services/estimate-converter');
      const lineName = line?.name || line?.label || line?.displayName || 'Palm Injection';
      if (converterFollowUpSeedingPattern(line || {}, { service_type: lineName }, undefined) === 'semiannual') {
        // FAIL CLOSED (codex #3349 r15 pre-push P0): a detected semiannual
        // palm line books the RECURRING row or nothing. Falling through to
        // the one-time palm_injection candidate would give an admin-booked
        // recurring program one-time billing and completion posture — with
        // per-application pricing on the plan, that is a money bug. An
        // unmatched line stays unmatched for the operator to resolve.
        return serviceIndex.byKey.get(normalizeServiceKey('palm_injection_semiannual'))
          || serviceIndex.byName.get(normalizeServiceKey('palm_injection_semiannual'))
          || null;
      }
      // A REAL palm line with recurring EVIDENCE that did not resolve a
      // valid semiannual program — contradictory ({ frequency: 'monthly',
      // visitsPerYear: 2 }), conflicting, unrecognized, or commercial data
      // — also fails closed (codex r16 pre-push P0): it is not
      // definitively one-time, and the one-time completion profile would
      // invoice work billed as a recurring plan. Only definitively
      // one-application (1 visit) or cadence-less+count-less lines keep
      // the one-time match. seedingFamilyKey gates this to real palm —
      // 'Palmetto…' labels (here via the bare /palm/ substring) classify
      // palm_substring_mismatch and keep their normal matching path.
      if (isPalmInjectionFamily(line || {}, { service_type: lineName })) {
        const visits = visitsPerYearForRecurringService(line || {});
        // An EXPLICITLY one-time cadence ('one_time'/'once') is not
        // recurring evidence (codex r17 P2) — the unrecognized-cadence
        // sentinel would otherwise strip a genuine one-time palm booking
        // of its catalog match (and its 60-minute catalog duration). A
        // one-time spelling beside a >1 visit count still fails closed
        // via the count check.
        const recurringEvidence = visitCountFieldsConflict(line || {})
          // Populated-but-invalid counts (0, negative, text) are malformed
          // recurring data, not definitively one-time (codex r18 pre-push
          // P1) — same reader the converter's gates use.
          || visitCountFieldsInvalid(line || {})
          || (visits != null && visits > 1)
          || (!!explicitCadenceFieldForService(line || {}) && !explicitlyOneTimeCadence(line || {}));
        if (recurringEvidence) {
          logger.warn(`[admin-customers] palm line has recurring evidence but no valid semiannual resolution — leaving unmatched (fail closed)`);
          return null;
        }
      }
    } catch (resolveErr) {
      // Resolver UNCERTAINTY also fails closed for REAL palm lines (codex
      // r15 pre-push P0): falling through would book the one-time row for
      // what may be a recurring plan. Word-boundary scope keeps
      // 'Palmetto…' labels (which reach here via the bare /palm/ substring
      // test above) on their normal matching path.
      const labelText = String(line?.name || line?.label || line?.displayName || '');
      if (rawKey === 'palm_injection' || /\bpalms?\b|palm\s*injection|palm\s*tree/i.test(labelText)) {
        logger.warn(`[admin-customers] palm catalog resolution failed (${resolveErr.message}) — leaving palm line unmatched (fail closed)`);
        return null;
      }
    }
  }

  for (const key of candidates) {
    const exact = serviceIndex.byKey.get(normalizeServiceKey(key)) || serviceIndex.byName.get(normalizeServiceKey(key));
    if (exact) return exact;
  }

  const text = `${rawKey} ${labelKey}`.replace(/_/g, ' ');
  const pick = (key) => serviceIndex.byKey.get(key);
  if (/rodent|rat|mouse/.test(text) && /monitor|monthly/.test(text)) return pick('rodent_monitoring');
  if (/rodent|rat|mouse/.test(text) && /bait|station/.test(text)) return pick('rodent_bait_quarterly') || pick('rodent_monitoring');
  if (/rodent|rat|mouse|exclusion|trapping/.test(text)) return pick('rodent_exclusion');
  if (/termite|wdo|subterranean|sentricon/.test(text) && /install|station|bait/.test(text)) return pick('termite_bait');
  if (/termite|wdo/.test(text) && /inspect|letter/.test(text)) return pick('wdo_inspection');
  if (/termite|trench|liquid/.test(text)) return pick('termite_liquid');
  if (/tree|shrub|ornamental/.test(text)) return pick('tree_shrub_program');
  if (/mosquito/.test(text)) return pick('mosquito_monthly');
  if (/lawn|turf|weed|fertil/.test(text)) return pick('lawn_care_recurring');
  // flea_tick is flea-only ("Flea Control Service") since the 2026-07 rebrand;
  // tick-only lines go to the separate tick_control service. Flea is tested
  // first so a combined "flea and tick" line keeps resolving to flea_tick.
  if (/flea/.test(text)) return pick('flea_tick');
  if (/tick/.test(text)) return pick('tick_control') || pick('flea_tick');
  if (/fire\s*ant/.test(text)) return pick('fire_ant');
  if (/bee|wasp|hornet|yellow/.test(text)) return pick('bee_wasp_removal');
  if (/pest|roach|ant|spider/.test(text)) {
    if (/monthly/.test(text)) return pick('pest_general_monthly');
    return pick('pest_general_quarterly') || pick('pest_initial_cleanout');
  }
  return null;
}

function isSchedulableOneTimeEstimateLine(line) {
  const kind = String(line?.kind || '').toLowerCase();
  const status = String(line?.status || '').toLowerCase();
  if (kind === 'discount' || kind === 'quote_required' || line?.quoteRequired === true || status === 'quote_required') return false;

  const rawAmount = [
    line?.priceAfterDiscount,
    line?.amountAfterDiscount,
    line?.totalAfterDiscount,
    line?.price,
    line?.amount,
    line?.total,
  ].find((value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)));
  if (rawAmount != null && Number(rawAmount) < 0) return false;

  const service = normalizeServiceKey(line?.service || line?.serviceKey || line?.key || '');
  const label = normalizeServiceKey(line?.displayName || line?.label || line?.name || line?.serviceName || '');
  const detail = normalizeServiceKey(line?.detail || line?.description || '');
  const text = `${service} ${label} ${detail}`;

  if (service === 'waveguard_setup') return false;
  if (text.includes('membership_setup_fee')) return false;
  return !(text.includes('waveguard') && (text.includes('setup') || text.includes('membership')));
}

function formatEstimateLine(line, { kind, estimate, serviceIndex, parentRecurringDiscounted = false }) {
  const name = String(line?.displayName || line?.label || line?.name || line?.serviceName || line?.service || '').trim();
  if (!name) return null;
  // Per-VISIT fields first; the monthly fields are a last resort and carry
  // provenance (Codex P1): a price recovered from `mo`/`monthly` is a
  // normalized monthly figure, and client copy labeling it "/application"
  // would misstate the charge (per-month copy audit rule).
  const perVisitPrice = kind === 'recurring'
    ? moneyOrNull(
        line?.perTreatment,
        line?.perApp,
        line?.perVisit,
        line?.pricePerVisit,
        line?.priceAfterDiscount,
        line?.amountAfterDiscount,
        line?.totalAfterDiscount,
        line?.price,
        line?.amount,
        line?.total,
      )
    : moneyOrNull(line?.priceAfterDiscount, line?.amountAfterDiscount, line?.totalAfterDiscount, line?.price, line?.amount, line?.total);
  const monthlyFallbackPrice = kind === 'recurring' && perVisitPrice == null
    ? moneyOrNull(line?.mo, line?.monthly)
    : null;
  const price = perVisitPrice != null ? perVisitPrice : monthlyFallbackPrice;
  if (kind !== 'recurring' && price == null) return null;

  let rawMatched = serviceCatalogMatch({ ...line, name }, serviceIndex);
  // A ONE-TIME list item must never keep the recurring palm identity
  // (codex r27 P1): the modal would submit a non-recurring visit carrying
  // the semiannual service id + recurring completion profile — completing
  // with recurring posture and skipping its one-time invoice. Route to
  // the one-time palm row when the index has it; with no one-time row the
  // line is OMITTED — a null identity is not safely unmatched here, since
  // the return below falls back to line.service/name and completion
  // resolves the semiannual profile by exact name.
  if (kind !== 'recurring' && rawMatched?.service_key === 'palm_injection_semiannual') {
    rawMatched = serviceIndex.byKey.get('palm_injection') || null;
    if (!rawMatched) return null;
  }
  // The matched catalog row's own cadence beats the hardcoded quarterly
  // fallback (codex r18 pre-push P0): a bare explicit semiannual palm
  // selection carries no line cadence data, and a quarterly prefill on a
  // two-application identity would book four visits. Preferring the
  // identity's frequency keeps service id and cadence agreeing whenever
  // the line itself is silent; lines WITH cadence data are untouched.
  const catalogCadence = kind === 'recurring' && rawMatched?.frequency
    ? cadenceFromEstimateLine({ frequency: rawMatched.frequency }, null)
    : null;
  const cadence = kind === 'recurring' ? cadenceFromEstimateLine(line, catalogCadence || 'quarterly') : 'one_time';
  // Never stamp the monthly catalog identity on a seasonal mosquito line
  // (codex r16 P2): the seasonal row is normally in the index (queried
  // explicitly despite is_active=false), but a fuzzy hit on mosquito_monthly
  // would make catalog-first consumers classify the plan as 12-visit
  // monthly. Fail to NO identity rather than the wrong one.
  const matched = cadence === 'seasonal_feb_oct' && rawMatched?.service_key === 'mosquito_monthly'
    ? null
    : rawMatched;
  // The scheduler (and Schedule modal) have no native every_6_weeks cadence —
  // they represent it as a custom 42-day interval. Translate here so the
  // modal pre-fill books the series the quote actually sold; intervalDays is
  // carried on the line because the modal's own inference can't recover it
  // once the catalog match rewrites `frequency`.
  const schedulerCadence = cadence === 'every_6_weeks' ? 'custom' : cadence;
  // Canonical service identity for the billing-unit gates (Codex #3173 r3):
  // legacy/name-only rows carry no `service` key, but the catalog match
  // resolves one — a name-only "Termite Station Rental" must still hit the
  // monthly-billed exemption, never stamp $31/application.
  // Engine key wins; the catalog key is the fallback for name-only legacy
  // rows — but catalog keys are ALIASES of engine keys (a rodent-bait line
  // matches the catalog's `rodent_bait_quarterly`, Codex #3173 r5), so they
  // are normalized back before any billing-unit decision. Unknown catalog
  // keys pass through unchanged.
  const CATALOG_TO_ENGINE_KEY = {
    rodent_bait_quarterly: 'rodent_bait',
    rodent_bait_monthly: 'rodent_bait',
    commercial_rodent_bait_quarterly: 'commercial_rodent_bait',
    termite_station_rental_quarterly: 'termite_station_rental',
    commercial_termite_bait_quarterly: 'commercial_termite_bait',
  };
  const rawServiceKey = String(line?.service || matched?.service_key || '').trim();
  const resolvedServiceKey = CATALOG_TO_ENGINE_KEY[rawServiceKey] || rawServiceKey;
  return {
    serviceId: matched?.id || null,
    serviceKey: matched?.service_key || line?.service || null,
    name: matched?.name || name,
    estimateLabel: name,
    category: matched?.category || null,
    billingType: matched?.billing_type || (kind === 'recurring' ? 'recurring' : 'one_time'),
    frequency: matched?.frequency || line?.frequency || null,
    visitsPerYear: matched?.visits_per_year || line?.visitsPerYear || null,
    duration: matched?.default_duration_minutes || null,
    price,
    cadence: schedulerCadence,
    intervalDays: cadence === 'every_6_weeks' ? 42 : null,
    source: kind,
    estimateId: estimate.id,
    ...(monthlyFallbackPrice != null ? { derived: 'estimate_totals_fallback' } : {}),
    // Accepted NET one-time price (Codex #3173 r4): a manual discount
    // allocated to one-time work leaves the row's price/priceAfterDiscount
    // GROSS and stores the accepted net in manualFinalOneTime — display
    // copy and comparisons must use the net; `price` keeps its pre-fill
    // semantics.
    ...(kind !== 'recurring' && moneyOrNull(line?.manualFinalOneTime) != null
      ? { acceptedOneTimePrice: moneyOrNull(line?.manualFinalOneTime) } : {}),
    // EXPLICIT per-application provenance (Codex P1): the canonical
    // public-quote derivation owns the rules — explicit per-app signal +
    // visit count, DISCOUNTED annual preferred over the list rate, and
    // genuinely monthly-billed keys (rodent bait, station rental) excluded
    // by design. These are ENGINE result rows, not wizard lineItems, so a
    // thin field adapter feeds the one shared derivation (never a second
    // parser): perTreatment is the engine's explicit per-application
    // signal, and priceAfterDiscount is its per-treatment-after-discount.
    // Display copy keys off THIS field; `price` above keeps its historical
    // pre-fill semantics untouched. Absent = no provable per-application
    // charge, and clients keep legacy copy.
    // Explicit MONTHLY provenance ONLY for genuinely monthly-billed service
    // keys (Codex #3173 r4): every per-application row also carries `mo` as
    // a normalized list figure — stamping it would let a discount-suppressed
    // pest row fall through to an undiscounted "$X/mo". The canonical key
    // set is public-quote's (the same one that refuses per-app for them).
    ...(kind === 'recurring' && moneyOrNull(line?.mo, line?.monthly) != null && (() => {
      try {
        // Commercial recurring bills MONTHLY by rule (AGENTS.md: commercial
        // is exempt from the per-application unit — Codex #3173 r2), on top
        // of the canonical monthly-billed key set. Resolved key covers
        // name-only legacy rows (r3).
        if (resolvedServiceKey.startsWith('commercial_')) return true;
        const { MONTHLY_BILLED_SERVICE_KEYS } = require('./public-quote')._internals;
        return MONTHLY_BILLED_SERVICE_KEYS.has(resolvedServiceKey);
      } catch { return false; }
    })()
      ? { monthlyPrice: moneyOrNull(line?.mo, line?.monthly) } : {}),
    ...(kind === 'recurring' ? (() => {
      try {
        // V1-legacy-mapper rows are PRE-discount by convention and carry no
        // discounted fields — stamping their list perTreatment would
        // overstate what a discounted customer accepted (Codex #3173 r2).
        // Refuse per-application provenance for such lines; legacy totals
        // (which ARE net) tell the truth until the mapper carries net
        // per-service amounts.
        // Commercial recurring is EXEMPT from the per-application unit rule
        // (AGENTS.md; the public quote path gates on commercialDetected the
        // same way — Codex #3173 r2): it bills monthly, so its perTreatment
        // must never stamp per-application provenance. Resolved key covers
        // name-only legacy rows (r3).
        if (resolvedServiceKey.startsWith('commercial_')) return {};
        const appliedPct = Number(line?.discount?.appliedDiscountPercent
          ?? line?.discount?.effectiveDiscount ?? 0);
        // Line-level OR parent-level (result.recurring.discount /
        // manualDiscount — Codex #3173 r3) discount with only list figures
        // on the row: refuse provenance rather than overstate.
        if ((appliedPct > 0 || parentRecurringDiscounted)
          && moneyOrNull(line?.priceAfterDiscount) == null
          && !(Number.isFinite(Number(line?.manualFinalAnnual)) && Number(line.manualFinalAnnual) >= 0)
          && !(Number(line?.annualAfterDiscount) > 0)
          && !(Number(line?.finalAnnual) > 0)) {
          return {};
        }
        const { perApplicationForLine } = require('./public-quote')._internals;
        const cadenceFields = {
          visitsPerYear: line?.visitsPerYear,
          visits: line?.visits,
          appsPerYear: line?.appsPerYear,
          frequency: line?.frequency,
        };
        // priceAfterDiscount IS per-treatment-after-discount — when present
        // it must win outright, so the LIST annual is withheld (the
        // canonical fn would otherwise prefer annual/visits and resurrect
        // the undiscounted rate).
        const discountedPerApp = moneyOrNull(line?.priceAfterDiscount);
        // manualFinalAnnual is the accepted POST-manual-discount annual —
        // annualAfterDiscount is only pre-manual/WaveGuard (Codex #3173
        // r4). It outranks every other annual in both branches.
        // PRESENCE, not positivity (Codex #3173 r5): a fixed/100% manual
        // discount that consumes the whole base stamps manualFinalAnnual: 0
        // — an accepted ZERO must win over the pre-manual annual, not be
        // rejected into it.
        const acceptedAnnual = Number.isFinite(Number(line?.manualFinalAnnual))
          && Number(line.manualFinalAnnual) >= 0
          ? Number(line.manualFinalAnnual)
          : (Number(line?.annualAfterDiscount) > 0 ? Number(line.annualAfterDiscount) : undefined);
        // An accepted annual of ZERO means the discount consumed the whole
        // base — there is no per-application CHARGE to quote, and the
        // canonical helper would fall back to the LIST rate here (its
        // discountedAnnual > 0 test). Refuse: the net totals tell the truth.
        if (acceptedAnnual === 0) return {};
        const pa = perApplicationForLine(discountedPerApp != null
          ? {
            service: resolvedServiceKey,
            perApp: discountedPerApp,
            ...cadenceFields,
            annualAfterDiscount: acceptedAnnual,
          }
          : {
            service: resolvedServiceKey,
            perApp: moneyOrNull(line?.perApp, line?.perTreatment) || undefined,
            perVisit: line?.perVisit,
            ...cadenceFields,
            annualAfterDiscount: acceptedAnnual,
            finalAnnual: line?.finalAnnual,
            annual: line?.annual ?? line?.ann,
          });
        return pa?.amount > 0 ? { perApplicationPrice: pa.amount } : {};
      } catch { return {}; }
    })() : {}),
  };
}

function scheduleLinesFromEstimate(estimate, serviceIndex) {
  const estData = parseJsonObject(estimate.estimate_data);
  let recurringSvcList = [];
  let oneTimeList = [];
  try {
    const lists = acceptanceServiceLists(estData);
    recurringSvcList = lists.recurringSvcList || [];
    oneTimeList = lists.oneTimeList || [];
  } catch {
    recurringSvcList = [];
    oneTimeList = [];
  }
  // Parent-level recurring discount (Codex #3173 r3): persisted engine
  // estimates commonly store the WaveGuard/manual discount at
  // result.recurring.discount while service rows keep LIST perTreatment
  // values — per-application provenance must be refused for those rows or
  // the UI would present undiscounted figures as the accepted price.
  let parentRecurringDiscounted = false;
  try {
    const rec = estData?.result?.recurring || estData?.recurring || {};
    // Manual discounts persist at result.manualDiscount /
    // result.totals.manualDiscount / summary.manualDiscount (Codex #3173
    // r4) — resolve them through the SAME normalizer the estimate page
    // uses, plus the recurring-scoped legacy spots.
    const { normalizeManualDiscountSummary } = require('./estimate-public');
    const recManual = rec?.manualDiscount || null;
    // Only the discount's RECURRING slice suppresses recurring provenance
    // (Codex #3173 r3): a fixed discount redirected entirely to one-time
    // work persists amount > 0 with recurringAmount: 0, and the recurring
    // lines' charges are unchanged. Same fallback rule as
    // manualDiscountMonthlyAmount: recurringAmount ?? amount.
    const manual = normalizeManualDiscountSummary(estData);
    const manualHitsRecurring = !!manual && Number(manual.recurringAmount ?? manual.amount) > 0;
    const recManualHitsRecurring = !!recManual
      && Number(recManual.recurringAmount ?? recManual.amount ?? recManual.value) > 0;
    parentRecurringDiscounted = Number(rec?.discount) > 0
      || manualHitsRecurring
      || recManualHitsRecurring;
  } catch { parentRecurringDiscounted = false; }
  const schedulableOneTimeList = oneTimeList.filter(isSchedulableOneTimeEstimateLine);
  const monthlyTotal = Number(estimate.monthly_total || 0);
  const annualTotal = Number(estimate.annual_total || 0);
  const hasRecurringEstimateTotal = monthlyTotal > 0 || annualTotal > 0;
  const onlyFilteredBillingRows = recurringSvcList.length === 0
    && oneTimeList.length > 0
    && schedulableOneTimeList.length === 0;
  const suppressFallback = onlyFilteredBillingRows && !hasRecurringEstimateTotal;

  const lines = [
    ...recurringSvcList.map((line) => formatEstimateLine(line, { kind: 'recurring', estimate, serviceIndex, parentRecurringDiscounted })),
    ...schedulableOneTimeList.map((line) => formatEstimateLine(line, { kind: 'one_time', estimate, serviceIndex })),
  ].filter(Boolean);

  if (lines.length === 1 && lines[0].price == null) {
    lines[0].price = moneyOrNull(estimate.onetime_total, estimate.monthly_total);
    // Same provenance rule as the zero-line fallback below: this price came
    // from the estimate's bare totals, not a per-visit quote line.
    if (lines[0].price != null) {
      lines[0].derived = 'estimate_totals_fallback';
      // The recovered figure is monthly when it came from monthly_total —
      // explicit monthly provenance keeps mixed-unit labels honest.
      if (lines[0].source === 'recurring' && Number(estimate.monthly_total) > 0 && lines[0].monthlyPrice == null) {
        lines[0].monthlyPrice = Number(estimate.monthly_total);
      }
    }
  }

  if (lines.length === 0 && !suppressFallback) {
    const annualMonthlyEquivalent = annualTotal > 0
      ? annualTotal / 12
      : null;
    const fallbackPrice = hasRecurringEstimateTotal
      ? moneyOrNull(monthlyTotal > 0 ? monthlyTotal : null, annualMonthlyEquivalent)
      : moneyOrNull(estimate.onetime_total, estimate.monthly_total);
    const fallbackName = estimate.service_interest || estimate.waveguard_tier || 'Accepted estimate';
    let matched = serviceCatalogMatch({ name: fallbackName }, serviceIndex);
    const fallbackIsRecurring = hasRecurringEstimateTotal;
    // Same rule as formatEstimateLine (codex r27 P1): a one-time fallback
    // line must not carry the recurring palm identity either — a
    // service_interest naming the semiannual row would otherwise resurrect
    // the exact identity the omitted line shed. With no one-time row the
    // fallback is dropped entirely (local codex P0): even a null-id line
    // keeps the semiannual NAME, and completion's exact-name lookup would
    // resolve the recurring profile from it.
    if (!fallbackIsRecurring && matched?.service_key === 'palm_injection_semiannual') {
      matched = serviceIndex.byKey.get('palm_injection') || null;
      if (!matched) return lines;
    }
    lines.push({
      serviceId: matched?.id || null,
      serviceKey: matched?.service_key || null,
      name: matched?.name || fallbackName,
      estimateLabel: fallbackName,
      category: matched?.category || null,
      billingType: matched?.billing_type || (fallbackIsRecurring ? 'recurring' : 'one_time'),
      frequency: matched?.frequency || null,
      visitsPerYear: matched?.visits_per_year || null,
      duration: matched?.default_duration_minutes || null,
      price: fallbackPrice,
      cadence: fallbackIsRecurring ? 'quarterly' : 'one_time',
      source: fallbackIsRecurring ? 'recurring' : 'one_time',
      estimateId: estimate.id,
      // This price came from the estimate's MONTHLY/one-time totals, not a
      // real per-visit quote line — client copy must not label it
      // "/application" (the per-month audit rule).
      derived: 'estimate_totals_fallback',
      ...(fallbackIsRecurring && monthlyTotal > 0 ? { monthlyPrice: monthlyTotal } : {}),
    });
  }

  const seen = new Set();
  return lines.filter((line) => {
    const key = `${line.serviceId || line.name}|${line.price ?? ''}|${line.cadence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

let healthScoreColumnsCache = null;

async function getHealthScoreColumns() {
  if (healthScoreColumnsCache) return healthScoreColumnsCache;
  try {
    const exists = await db.schema.hasTable('customer_health_scores');
    if (!exists) {
      healthScoreColumnsCache = new Set();
      return healthScoreColumnsCache;
    }
    const result = await db.raw(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'customer_health_scores'"
    );
    healthScoreColumnsCache = new Set((result.rows || []).map(r => r.column_name));
    return healthScoreColumnsCache;
  } catch (err) {
    logger.warn(`[customers] health score column detection failed: ${err.message}`);
    healthScoreColumnsCache = new Set();
    return healthScoreColumnsCache;
  }
}

function latestHealthScoreRaw(columns) {
  const scoreCol = columns.has('overall_score')
    ? 'overall_score'
    : columns.has('health_score')
      ? 'health_score'
      : null;
  if (!scoreCol) return db.raw('NULL as health_score');
  const orderCol = columns.has('scored_at')
    ? 'scored_at'
    : columns.has('score_date')
      ? 'score_date'
      : columns.has('created_at')
        ? 'created_at'
        : 'id';
  return db.raw(`(
    SELECT ${scoreCol}
    FROM customer_health_scores
    WHERE customer_health_scores.customer_id = customers.id
    ORDER BY ${orderCol} DESC
    LIMIT 1
  ) as health_score`);
}

async function latestHealthScoreForCustomer(customerId) {
  const columns = await getHealthScoreColumns();
  if (!columns.size) return null;
  const orderCol = columns.has('scored_at')
    ? 'scored_at'
    : columns.has('score_date')
      ? 'score_date'
      : columns.has('created_at')
        ? 'created_at'
        : 'id';
  return db('customer_health_scores')
    .where({ customer_id: customerId })
    .orderBy(orderCol, 'desc')
    .first()
    .catch(e => {
      logger.warn(`[customers:${customerId}] health_scores: ${e.message}`);
      return null;
    });
}

// PUT /:id fields whose change emits a `customer.update_sensitive` audit
// event (contact identity, address, money/lane, and the payer/occupant
// classification — contact_role is as operationally significant as the
// service_contact*_role slots already listed).
const SENSITIVE_CUSTOMER_FIELDS = Object.freeze([
  'email', 'phone', 'secondary_phone', 'address_line1', 'address_line2', 'city', 'state', 'zip',
  'monthly_rate', 'active', 'pipeline_stage',
  'service_contact_name', 'service_contact_phone', 'service_contact_email',
  'service_contact2_name', 'service_contact2_phone', 'service_contact2_email',
  'service_contact3_name', 'service_contact3_phone', 'service_contact3_email',
  'service_contact_role', 'service_contact2_role', 'service_contact3_role',
  'payer_id', 'billing_mode', 'contact_role',
]);

function isValidStage(stage) {
  return !stage || CUSTOMER_STAGE_SET.has(stage);
}

// Lifecycle field stamps on pipeline_stage change now live in the canonical
// customer-stages service (single source of truth for member_since /
// churned_at / active consistency, shared with the Intelligence Bar paths) —
// imported at top; still re-exported below for this route's test suite.

function mapPipelineCustomer(c, stage = c.pipeline_stage) {
  return {
    id: c.id,
    firstName: c.first_name || '',
    lastName: c.last_name || '',
    name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
    accountId: c.account_id,
    profileLabel: c.profile_label,
    address: formatAddress({
      line1: c.address_line1,
      line2: c.address_line2,
      city: c.city,
      state: c.state,
      zip: c.zip,
    }),
    phone: c.phone,
    tier: c.waveguard_tier,
    monthlyRate: parseFloat(c.monthly_rate || 0),
    leadScore: c.lead_score,
    leadSource: c.lead_source,
    pipelineStage: stage,
    stageEnteredAt: c.pipeline_stage_changed_at,
    pipelineStageChangedAt: c.pipeline_stage_changed_at,
    nextFollowUp: c.next_follow_up_date,
  };
}

function mapCustomerListRow(c) {
  return {
    id: c.id, firstName: c.first_name, lastName: c.last_name,
    accountId: c.account_id, profileLabel: c.profile_label,
    isPrimaryProfile: !!c.is_primary_profile,
    contactRole: c.contact_role || null,
    email: c.email, phone: c.phone, city: c.city,
    serviceContactName: c.service_contact_name,
    serviceContactPhone: c.service_contact_phone,
    serviceContactEmail: c.service_contact_email,
    serviceContact2Name: c.service_contact2_name,
    serviceContact2Phone: c.service_contact2_phone,
    serviceContact2Email: c.service_contact2_email,
    serviceContact3Name: c.service_contact3_name,
    serviceContact3Phone: c.service_contact3_phone,
    serviceContact3Email: c.service_contact3_email,
    address: formatAddress({ line1: c.address_line1, line2: c.address_line2, city: c.city, state: c.state, zip: c.zip }),
    tier: c.waveguard_tier, monthlyRate: parseFloat(c.monthly_rate || 0),
    memberSince: c.member_since, active: c.active,
    pipelineStage: c.pipeline_stage, leadScore: c.lead_score,
    leadSource: c.lead_source, leadSourceDetail: c.lead_source_detail,
    landingPageUrl: c.landing_page_url, companyName: c.company_name,
    propertyType: c.property_type,
    lastContactDate: c.last_contact_date, lastContactType: c.last_contact_type,
    nextFollowUp: c.next_follow_up_date,
    // lifetime_revenue_net is the payments-derived net computed by the list
    // query; the bare column is a writer-less legacy fallback for callers
    // that don't select it.
    lifetimeRevenue: parseFloat(c.lifetime_revenue_net ?? c.lifetime_revenue ?? 0),
    totalServices: parseInt(c.total_services || c.services_count || 0),
    lastServiceDate: c.last_service_date, nextServiceDate: c.next_service_date,
    serviceTypes: c.service_types || '',
    serviceCount: parseInt(c.service_type_count || 0),
    lastRating: c.last_rating != null ? parseInt(c.last_rating) : null,
    tags: (c.tags_str || '').split(',').filter(Boolean),
    balanceOwed: parseFloat(c.balance_owed || 0),
    healthScore: c.health_score != null ? parseInt(c.health_score) : null,
    cardsOnFile: parseInt(c.cards_on_file || 0),
  };
}

// role travels WITH its slot through compaction — otherwise compacting slot 2
// into slot 1 would leave slot 1 wearing slot 1's old role.
const SERVICE_CONTACT_SLOT_FIELDS = [
  ['service_contact_name', 'service_contact_phone', 'service_contact_email', 'service_contact_role'],
  ['service_contact2_name', 'service_contact2_phone', 'service_contact2_email', 'service_contact2_role'],
  ['service_contact3_name', 'service_contact3_phone', 'service_contact3_email', 'service_contact3_role'],
];

function compactServiceContactSlots(updates, before = {}) {
  const hasServiceContactUpdate = SERVICE_CONTACT_SLOT_FIELDS
    .flat()
    .some((field) => Object.prototype.hasOwnProperty.call(updates, field));
  if (!hasServiceContactUpdate) return updates;

  const normalizedValue = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    return value;
  };

  // Roles belong to PEOPLE, not slot positions. The edit form submits only
  // name/phone/email (echoing every field on every save), so each slot's
  // role is re-derived by matching the slot's resulting identity against
  // the slots stored BEFORE the save (phone, then email, then exact name):
  // the same person — even shifted to a different slot by a delete —
  // keeps their pipeline-recorded role, and a genuinely new person never
  // inherits the old one (codex rounds 2/3/5).
  const normKey = (v) => String(v == null ? '' : v).trim().toLowerCase();
  const phoneKey = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(-10);
  const beforeSlots = SERVICE_CONTACT_SLOT_FIELDS.map(([nameCol, phoneCol, emailCol, roleCol]) => ({
    name: before[nameCol], phone: before[phoneCol], email: before[emailCol], role: normalizedValue(before[roleCol]),
  }));
  const roleForIdentity = ([name, phone, email]) => {
    const match = beforeSlots.find((b) => phoneKey(phone) && phoneKey(phone) === phoneKey(b.phone))
      || beforeSlots.find((b) => normKey(email) && normKey(email) === normKey(b.email))
      || beforeSlots.find((b) => normKey(name) && normKey(name) === normKey(b.name));
    return match ? match.role : null;
  };

  const compacted = SERVICE_CONTACT_SLOT_FIELDS
    .map((fields) => {
      const identity = fields.slice(0, 3).map((field) => (
        Object.prototype.hasOwnProperty.call(updates, field)
          ? normalizedValue(updates[field])
          : normalizedValue(before[field])
      ));
      // An explicit role in the payload wins (the pipeline's own writes);
      // otherwise the role follows the person.
      const role = Object.prototype.hasOwnProperty.call(updates, fields[3])
        ? normalizedValue(updates[fields[3]])
        : roleForIdentity(identity);
      return [...identity, role];
    })
    // Survival is judged on name/phone/email only — a role with no person
    // attached must not keep a ghost slot alive.
    .filter((slot) => slot.slice(0, 3).some((value) => value !== null));

  SERVICE_CONTACT_SLOT_FIELDS.forEach((fields, index) => {
    const slot = compacted[index] || fields.map(() => null);
    fields.forEach((field, fieldIndex) => {
      updates[field] = slot[fieldIndex];
    });
  });

  // Consent artifact sync (#2948): the consent stamp describes the exact
  // people stored when it was recorded. If this save changes any slot's
  // identity (name/phone/email), the old stamp no longer describes the
  // stored list — clear it rather than leave one person's consent attached
  // to another. Admin saves have no attestation flow, so clearing (never
  // restamping) is the only honest write here; identity-preserving saves
  // (role-only updates, echoed unchanged fields) keep the stamp.
  const consentCompareValue = (value) => {
    const normalized = normalizedValue(value);
    return typeof normalized === 'string' ? normalized.trim() : normalized;
  };
  const identityChanged = SERVICE_CONTACT_SLOT_FIELDS
    .flatMap((fields) => fields.slice(0, 3))
    .some((field) => consentCompareValue(updates[field]) !== consentCompareValue(before[field]));
  if (identityChanged) {
    updates.service_contacts_consent_at = null;
    updates.service_contacts_consent_source = null;
    updates.service_contacts_consent_text_version = null;
  }

  return updates;
}

function customerSearchTerms(value) {
  return String(value || '')
    .trim()
    .match(/[a-z0-9]+/gi) || [];
}

function applyCustomerListFilters(query, filters) {
  const { search, stage, tier, tag, source, area, city, cards, hasBalance, lastVisited } = filters;
  if (search) {
    const s = `%${search}%`;
    const isPhoneLike = /^[\d\s().+\-]+$/.test(search);
    const phoneDigits = isPhoneLike ? String(search).replace(/\D/g, '') : '';
    const terms = customerSearchTerms(search);
    const searchableTextSql = `
      CONCAT_WS(' ',
        first_name,
        last_name,
        company_name,
        phone,
        email,
        address_line1,
        address_line2,
        city,
        state,
        zip,
        account_id,
        profile_label
      )
    `;
    query = query.where(function () {
      this.whereILike('first_name', s).orWhereILike('last_name', s)
        .orWhereILike('phone', s).orWhereILike('email', s)
        .orWhereILike('address_line1', s).orWhereILike('city', s)
        .orWhereILike('company_name', s)
        .orWhereILike('state', s).orWhereILike('zip', s)
        .orWhereILike('profile_label', s)
        .orWhereRaw('account_id::text ILIKE ?', [s])
        .orWhereRaw("(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) ILIKE ?", [s])
        .orWhereRaw(`${searchableTextSql} ILIKE ?`, [s]);
      if (terms.length > 1) {
        this.orWhere(function () {
          terms.forEach((term) => {
            this.whereRaw(`${searchableTextSql} ILIKE ?`, [`%${term}%`]);
          });
        });
      }
      if (phoneDigits.length >= 3) {
        this.orWhereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${phoneDigits}%`]);
      }
    });
  }
  if (stage) query = query.where('pipeline_stage', stage);
  if (tier === 'none') query = query.whereNull('waveguard_tier');
  else if (tier) query = query.where('waveguard_tier', tier);
  if (city) query = query.whereILike('city', `%${city}%`);
  if (source) query = query.where('lead_source', source);
  if (area) query = query.whereILike('city', `%${area}%`);
  if (tag) query = query.whereExists(function () {
    this.select('*').from('customer_tags').whereRaw('customer_tags.customer_id = customers.id').where('tag', tag);
  });
  if (cards === 'has') {
    query = query.whereExists(function () {
      this.select(db.raw('1')).from('payment_methods').whereRaw('payment_methods.customer_id = customers.id');
    });
  } else if (cards === 'none') {
    query = query.whereNotExists(function () {
      this.select(db.raw('1')).from('payment_methods').whereRaw('payment_methods.customer_id = customers.id');
    });
  }
  if (hasBalance === 'true' || hasBalance === true) {
    query = query.whereExists(function () {
      this.select('customer_id').from('invoices')
        .whereRaw('invoices.customer_id = customers.id')
        .whereIn('status', ['sent', 'viewed', 'overdue'])
        .groupBy('customer_id')
        .havingRaw('COALESCE(SUM(total), 0) > 0');
    });
  }
  if (lastVisited && lastVisited !== 'all') {
    if (lastVisited === 'never') {
      query = query.whereNotExists(function () {
        this.select(db.raw('1')).from('service_records').whereRaw('service_records.customer_id = customers.id');
      });
    } else {
      const days = parseInt(lastVisited, 10);
      if (Number.isFinite(days) && days >= 0) {
        query = query.whereExists(function () {
          this.select('customer_id').from('service_records')
            .whereRaw('service_records.customer_id = customers.id')
            .groupBy('customer_id')
            .havingRaw('MAX(service_date) >= ?::date - (? * INTERVAL \'1 day\')', [etDateString(), days]);
        });
      }
    }
  }
  return query;
}

async function auditCustomerMutation(req, action, customerId, metadata = {}, critical = false, trx = null) {
  await recordAuditEvent({
    actor_type: 'technician',
    actor_id: req.technicianId || null,
    action,
    resource_type: 'customer',
    resource_id: customerId,
    metadata,
    ip_address: req.ip,
    user_agent: req.get('user-agent') || null,
    critical,
    trx,
  });
}

function phoneLast10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function cleanText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function cleanOptionalText(value) {
  const cleaned = cleanText(value);
  return cleaned || null;
}

function cleanEmail(value) {
  const cleaned = cleanText(value).toLowerCase();
  return cleaned || null;
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(value) || '');
}

function comparableEmail(value) {
  return String(value || '').trim().toLowerCase();
}

const ADMIN_NOTIFICATION_PREF_BOOLEAN_FIELDS = [
  ['autoFlipEnRoute', 'auto_flip_en_route'],
  ['paymentConfirmationSms', 'payment_confirmation_sms'],
  ['appointmentNotifyPrimary', 'appointment_notify_primary'],
  ['serviceReportNotifyPrimary', 'service_report_notify_primary'],
  ['serviceReportNotifyBilling', 'service_report_notify_billing'],
];

const ANNUAL_PREPAY_PAYMENT_METHODS = new Set(['cash', 'check', 'zelle', 'card_present', 'other']);

// Advisory-lock namespace for serializing per-customer annual-prepay creation,
// so hashtext(customerId) can't collide with locks taken elsewhere.
const ANNUAL_PREPAY_LOCK_NS = 0x4150;

// Statuses that still represent a binding annual-prepay commitment for overlap
// checks: payment_pending / active / renewal_pending / renewed / switch_plan,
// PLUS a renewal-LAPSED term (status='cancelled' with renewal_decision='cancel')
// whose already-paid coverage runs through term_end — matching
// AnnualPrepayRenewals.getActivelyCoveredCustomerIds. A refund sets
// status='cancelled' with a NULL renewal_decision and is intentionally NOT
// treated as overlapping (it re-enables a fresh prepay).
function annualPrepayOverlapStatusClause() {
  return function overlapStatus() {
    this.whereIn('status', ['payment_pending', 'active', 'renewal_pending', 'renewed', 'switch_plan'])
      .orWhere(function lapsedRenewalStillInTerm() {
        this.where('status', 'cancelled').andWhere('renewal_decision', 'cancel');
      });
  };
}

// Acquire a per-customer advisory lock (released at txn commit/rollback) and
// re-check for an overlapping annual-prepay term INSIDE the transaction. The
// pre-flight check before the txn is a fast UX path only; without this guard two
// concurrent submissions (double-click, or two admins) can both pass that check
// and create duplicate invoices/terms/payments. Throws a tagged error the route
// translates to a 409. Statuses mirror the pre-flight overlap query.
async function lockAndAssertNoAnnualPrepayOverlap(trx, customerId, termStart, allowOverlap, errorPrefix) {
  await trx.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [ANNUAL_PREPAY_LOCK_NS, String(customerId)]);
  if (allowOverlap === true) return;
  const activeTerm = await trx('annual_prepay_terms')
    .where({ customer_id: customerId })
    .where(annualPrepayOverlapStatusClause())
    .orderBy('term_end', 'desc')
    .first();
  const activeTermEnd = dateOnlyForApi(activeTerm?.term_end);
  if (activeTermEnd && termStart <= activeTermEnd) {
    const message = `${errorPrefix} ${activeTermEnd}. Use a start date after ${activeTermEnd}.`;
    const err = new Error(message);
    err.annualPrepayOverlap = { error: message, activeTermId: activeTerm.id, activeTermEnd };
    throw err;
  }
}

function parseAnnualPrepayAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: 'amount must be greater than 0' };
  }
  return { amount: Math.round((amount + 1e-9) * 100) / 100 };
}

function parseAnnualPrepayVisitCount(value) {
  const count = Number.parseInt(value, 10);
  if (!Number.isInteger(count) || count <= 0) {
    return { error: 'visitCount must be greater than 0' };
  }
  return { visitCount: Math.min(count, 24) };
}

function parseDateOnlyInput(value, field) {
  if (value === undefined || value === null || value === '') return { date: null };
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return { error: `${field} must be YYYY-MM-DD` };
  }
  const d = new Date(`${text}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) {
    return { error: `${field} must be a valid date` };
  }
  return { date: text };
}

function addDaysDateOnly(value, days) {
  const text = dateOnlyForApi(value) || etDateString();
  const d = new Date(`${text}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function addMonthsDateOnly(value, months) {
  const text = dateOnlyForApi(value) || etDateString();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const monthIndex = month - 1 + Number(months || 0);
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonthIndex = ((monthIndex % 12) + 12) % 12;
  const targetMonth = targetMonthIndex + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0, 12)).getUTCDate();
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

function defaultAnnualPrepayTermStart(activeTerm, today = etDateString()) {
  const termEnd = dateOnlyForApi(activeTerm?.term_end || activeTerm?.termEnd);
  // Mirror the client default (Customer360ProfileV2 defaultAnnualPrepayStart) on
  // the server so a direct/API call without termStart can't bypass it: a
  // payment_pending term that STILL covers today is sent-but-unpaid, so a new
  // term must cover that same window (its term_start) rather than advancing to
  // term_end + 1 — advancing past an unpaid term would slip past
  // lockAndAssertNoAnnualPrepayOverlap (which counts payment_pending) and stack a
  // second paid term beyond the open invoice. An EXPIRED pending window (term_end
  // before today) is moot, so fall through to the term_end+1/today default and
  // don't block a fresh prepay on a stale unpaid row.
  if (activeTerm && activeTerm.status === 'payment_pending' && termEnd && termEnd >= today) {
    return dateOnlyForApi(activeTerm.term_start || activeTerm.termStart) || today;
  }
  if (termEnd && termEnd >= today) return addDaysDateOnly(termEnd, 1);
  return today;
}

function mapAnnualPrepayTerm(term) {
  if (!term) return null;
  return {
    id: term.id,
    customerId: term.customer_id,
    sourceEstimateId: term.source_estimate_id,
    prepayInvoiceId: term.prepay_invoice_id,
    prepayInvoiceNumber: term.prepay_invoice_number,
    prepayInvoiceStatus: term.prepay_invoice_status,
    prepayInvoiceTotal: term.prepay_invoice_total != null ? Number(term.prepay_invoice_total) : null,
    prepayInvoiceSubtotal: term.prepay_invoice_subtotal != null ? Number(term.prepay_invoice_subtotal) : null,
    planLabel: term.plan_label,
    monthlyRate: term.monthly_rate != null ? Number(term.monthly_rate) : null,
    prepayAmount: term.prepay_amount != null ? Number(term.prepay_amount) : null,
    coverageServiceType: term.coverage_service_type || null,
    coverageVisitCount: term.coverage_visit_count != null ? Number(term.coverage_visit_count) : null,
    coverageCadence: term.coverage_cadence || null,
    termStart: dateOnlyForApi(term.term_start),
    termEnd: dateOnlyForApi(term.term_end),
    status: term.status,
    lastScheduledServiceId: term.last_scheduled_service_id,
    lastScheduledServiceDate: dateOnlyForApi(term.last_scheduled_service_date),
    lastScheduledServiceType: term.last_scheduled_service_type,
    notice30SentAt: term.notice_30_sent_at,
    notice15SentAt: term.notice_15_sent_at,
    notice7SentAt: term.notice_7_sent_at,
    renewalContactedAt: term.renewal_contacted_at,
    renewalContactedBy: term.renewal_contacted_by,
    renewalDecision: term.renewal_decision,
    renewalDecisionAt: term.renewal_decision_at,
    renewalNotes: term.renewal_notes,
    createdAt: term.created_at,
    updatedAt: term.updated_at,
  };
}

function adminNotificationPrefsDbUpdates(body = {}, existing = {}) {
  const dbUpdates = {};

  for (const [bodyField, dbField] of ADMIN_NOTIFICATION_PREF_BOOLEAN_FIELDS) {
    if (body[bodyField] === undefined) continue;
    if (typeof body[bodyField] !== 'boolean') {
      return { error: `${bodyField} must be true or false.` };
    }
    dbUpdates[dbField] = body[bodyField];
  }

  if (body.billingEmail !== undefined) {
    const billingEmail = cleanEmail(body.billingEmail);
    if (billingEmail && !isEmailLike(billingEmail)) {
      return { error: 'Enter a valid billing recipient email.' };
    }
    if (billingEmail && billingEmail.length > 200) {
      return { error: 'Billing recipient email must be 200 characters or fewer.' };
    }
    dbUpdates.billing_email = billingEmail || null;
    const emailChanged = comparableEmail(billingEmail) !== comparableEmail(existing.billing_email);
    if (!billingEmail || (emailChanged && body.billingContactName === undefined)) {
      dbUpdates.billing_contact_name = null;
    }
  }
  if (body.billingContactName !== undefined) {
    const billingContactName = cleanOptionalText(body.billingContactName);
    const effectiveBillingEmail = dbUpdates.billing_email !== undefined
      ? dbUpdates.billing_email
      : cleanEmail(existing.billing_email);
    if (effectiveBillingEmail) {
      dbUpdates.billing_contact_name = billingContactName
        ? billingContactName.slice(0, 120)
        : null;
    }
  }

  return { dbUpdates };
}

function cleanOptionalState(value) {
  const cleaned = cleanText(value).toUpperCase();
  return cleaned ? cleaned.slice(0, 2) : null;
}

// normalizeAdminAddressInput moved to utils/intake-normalize (shared with
// the contact-correction lane) — imported above; _private still exposes it.

// Canonical implementation lives in services/customer-default-rows (route
// modules re-export it for existing importers; services require it directly).
const { createDefaultCustomerRows } = require('../services/customer-default-rows');

async function attachMatchedCustomerToAccount(trx, customer) {
  if (!customer) return null;
  if (customer.account_id) return customer.account_id;

  const accountId = customer.id;
  await trx('customer_accounts')
    .insert({
      id: accountId,
      first_name: customer.first_name,
      last_name: customer.last_name,
      phone: customer.phone || null,
      email: customer.email ? String(customer.email).trim().toLowerCase() : null,
      company_name: customer.company_name || null,
      created_at: customer.created_at || new Date(),
      updated_at: new Date(),
    })
    .onConflict('id')
    .ignore();

  await trx('customers')
    .where({ id: customer.id })
    .update({
      account_id: accountId,
      is_primary_profile: customer.is_primary_profile === false ? false : true,
      profile_label: customer.profile_label || 'Primary',
      updated_at: new Date(),
    });

  return accountId;
}

// Phone-first account match (last-10 digits). `matchEmail` (default OFF —
// every existing caller stays phone-only) additionally matches a normalized
// email against live customers when the phone finds nothing; the lead→customer
// conversion opts in so a lead whose email belongs to an existing account
// attaches as an additional property instead of splitting history/autopay
// across a second primary profile. Same return shape either way.
// Email is NOT proof of account ownership (an attacker can submit a lead with
// their phone + a victim's email). An email match therefore never attaches on
// its own: it is returned with `requiresConfirmation: true` and NO write,
// and only attaches when the caller passes `confirmEmailAccountId` equal to
// the account the email resolves to RIGHT NOW (admin-confirmed selection).
function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `***-***-${digits.slice(-4)}` : '***';
}

function maskEmail(email) {
  const [local = '', domain = ''] = String(email || '').split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

// Attach-path fence (utils/customer-comms-lock.js contract): callers such as
// the lead convert already hold a lead FOR UPDATE when they reach here, and
// attachMatchedCustomerToAccount UPDATES the matched customer row — the
// merge-undo takes comms-lock/customer-row FIRST then repoints the lead, so a
// blocking lock here could deadlock. Use the NON-BLOCKING variant and fail
// closed when refused (undo in flight on that exact customer).
//
// `fenceAttach` (default false) turns the fence + re-resolve ON. Only the
// lead-convert path (routes/admin-leads.js, always inside its transaction)
// passes true. A transaction-scoped advisory lock taken via the ROOT knex
// releases at statement end, so callers that pass `db` (booking.js,
// lead-webhook.js, public-quote.js, twilio-webhook.js, ...) cannot be fenced
// this way — for them the behavior is exactly pre-#3453 (no try-lock, no
// re-resolve); that pre-existing contract gap is out of scope here.
async function fenceMatchedCustomer(trx, customer) {
  const { tryLockCustomerComms } = require('../utils/customer-comms-lock');
  return tryLockCustomerComms(trx, customer.id);
}

function assertFenceTransaction(trx) {
  // Same trx-detection idiom as services/autopay-enrollment.js /
  // service-photos.js (`isTransaction === true`). A root knex here is a
  // programming error — fail closed before any read or write.
  if (!trx || trx.isTransaction !== true) {
    throw new Error('findAccountByContact: fenceAttach requires a knex transaction (got root knex) — the comms fence would not span the attach');
  }
}

async function findAccountByContact(trx, {
  phone, email, matchEmail = false, confirmEmailAccountId = null, fenceAttach = false,
  forceNewAccount = false, ignorePhoneMatch = false,
}) {
  if (fenceAttach) assertFenceTransaction(trx);
  const digits = phoneLast10(phone);
  const lookupByPhone = () => (digits
    ? trx('customers')
      .whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${digits}`])
      .whereNull('deleted_at')
      .orderBy('is_primary_profile', 'desc')
      .orderBy('created_at', 'asc')
      .first()
    : Promise.resolve(null));

  // forceNewAccount (admin-only, lead-convert "create a SEPARATE customer"):
  // bypass BOTH phone and email matching and create a fresh account — but
  // fail closed on the phone side: a live phone match that exists right now
  // is surfaced (PHONE_MATCH_CONFIRM, trimmed payload, no write) unless the
  // admin also passed ignorePhoneMatch. Never a silent duplicate.
  if (forceNewAccount) {
    const byCustomerPhone = await lookupByPhone();
    if (byCustomerPhone && !ignorePhoneMatch) {
      return {
        accountId: null,
        existingCustomer: null,
        matchType: 'phone',
        requiresConfirmation: true,
        phoneMatch: true,
        match: {
          accountId: String(byCustomerPhone.account_id || byCustomerPhone.id),
          name: [byCustomerPhone.first_name, byCustomerPhone.last_name].filter(Boolean).join(' '),
          phoneMasked: maskPhone(byCustomerPhone.phone),
        },
      };
    }
    return null;
  }

  // Unconfirmed path: phone-first precedence, unchanged.
  if (!confirmEmailAccountId) {
    const byCustomerPhone = await lookupByPhone();
    if (byCustomerPhone) {
      const busy = () => {
        const err = new Error('That customer record is being updated — retry in a moment.');
        err.statusCode = 409;
        err.status = 409;
        err.isOperational = true;
        err.code = 'CUSTOMER_BUSY';
        return err;
      };
      let fresh = byCustomerPhone;
      if (fenceAttach) {
        if (!(await fenceMatchedCustomer(trx, byCustomerPhone))) throw busy();
        // resolve → lock → RE-RESOLVE (comms-lock contract): an undo that
        // committed between the read and the fence leaves the try-lock holding
        // a stale row. Re-run the same live lookup and require the identical
        // row + account; anything else (archived, re-pointed, different row
        // now wins) fails closed with zero writes.
        fresh = await lookupByPhone();
        if (!fresh || String(fresh.id) !== String(byCustomerPhone.id)
          || String(fresh.account_id || '') !== String(byCustomerPhone.account_id || '')) {
          throw busy();
        }
      }
      const accountId = await attachMatchedCustomerToAccount(trx, fresh);
      return { accountId, existingCustomer: { ...fresh, account_id: accountId }, matchType: 'phone' };
    }
  }

  const normalizedEmail = matchEmail ? cleanEmail(email) : null;
  if (confirmEmailAccountId && !(normalizedEmail && isEmailLike(normalizedEmail))) {
    // Confirmed retry with no usable email: the admin's selection cannot be
    // revalidated at all — never fall through to phone/creation.
    return { accountId: null, existingCustomer: null, matchType: 'email', requiresConfirmation: true, matchChanged: true, match: null };
  }
  if (normalizedEmail && isEmailLike(normalizedEmail)) {
    // Shared household/business emails are a supported shape (migration
    // 20260417000010_allow_duplicate_customer_emails). Only reuse when EVERY
    // live row with this email resolves to ONE account — if they span
    // accounts we cannot know which household this is, so fail closed (no
    // match → caller creates a fresh account) rather than attach to the
    // wrong one. Unlinked rows resolve to their own id (attach semantics).
    const resolveEmailAccountSet = async () => {
      const rows = await trx('customers')
        .whereRaw('LOWER(TRIM(COALESCE(email, \'\'))) = ?', [normalizedEmail])
        .whereNull('deleted_at')
        .orderBy('is_primary_profile', 'desc')
        .orderBy('created_at', 'asc');
      const keys = new Set((rows || []).map((row) => String(row.account_id || row.id)));
      return { rows: rows || [], keys };
    };
    const { rows: byCustomerEmail, keys: accountKeys } = await resolveEmailAccountSet();
    const keyOf = (row) => String(row.account_id || row.id);
    const trimmed = (row) => ({
      // Trimmed to what the confirm dialog shows — no customer id, label,
      // or street address (this payload can reach a tech-scoped caller).
      accountId: keyOf(row),
      name: [row.first_name, row.last_name].filter(Boolean).join(' '),
      emailMasked: maskEmail(row.email),
    });
    const sameKeySet = (a, b) => a.size === b.size && [...a].every((k) => b.has(k));
    const changedResult = (extra = {}) => ({
      accountId: null, existingCustomer: null, matchType: 'email', requiresConfirmation: true, matchChanged: true, match: null, ...extra,
    });

    let match = null;
    let resolvedAccountId = null;
    if (confirmEmailAccountId) {
      // The admin explicitly chose to ATTACH. The chosen account must be one
      // the email resolves to RIGHT NOW (the unique match, or one of the
      // ambiguous candidates); anything else — row deleted/edited, account
      // no longer in the set — is a changed world. Never let an explicit
      // attach silently become a fresh account.
      const chosen = String(confirmEmailAccountId);
      match = byCustomerEmail.find((row) => keyOf(row) === chosen) || null;
      if (!match) return changedResult();
      resolvedAccountId = chosen;
    } else if (byCustomerEmail.length && accountKeys.size === 1) {
      return {
        accountId: null,
        existingCustomer: null,
        matchType: 'email',
        requiresConfirmation: true,
        match: trimmed(byCustomerEmail[0]),
      };
    } else if (byCustomerEmail.length) {
      // Shared household/business emails are a supported shape (migration
      // 20260417000010_allow_duplicate_customer_emails). Ambiguity is NOT
      // "no match": surface one trimmed candidate per account (max 5) for
      // an admin to pick from, or to create a separate customer explicitly.
      const seen = new Set();
      const candidates = [];
      for (const row of byCustomerEmail) {
        const k = keyOf(row);
        if (seen.has(k)) continue;
        seen.add(k);
        candidates.push(trimmed(row));
        if (candidates.length >= 5) break;
      }
      return {
        accountId: null,
        existingCustomer: null,
        matchType: 'email',
        requiresConfirmation: true,
        ambiguous: true,
        match: null,
        candidates,
      };
    }

    if (match) {
      // Confirmed retry: the admin chose the EMAIL-selected account. A
      // phone match that now points at a DIFFERENT account (appeared
      // between the first request and the confirmation) means the world
      // changed under the admin — never attach to either; re-confirm.
      const byCustomerPhone = await lookupByPhone();
      if (byCustomerPhone && keyOf(byCustomerPhone) !== resolvedAccountId) {
        return changedResult({ phoneConflict: true });
      }
      let freshMatch = match;
      if (fenceAttach) {
        if (!(await fenceMatchedCustomer(trx, match))) {
          return changedResult({ busy: true });
        }
        // resolve → lock → RE-RESOLVE (comms-lock contract): re-run the whole
        // live-email account-set resolution (and the phone-conflict check)
        // under the fence. The account set must be IDENTICAL and the chosen
        // account's winning row unchanged; otherwise the world moved between
        // read and fence — reject with zero writes.
        const again = await resolveEmailAccountSet();
        freshMatch = again.rows.find((row) => keyOf(row) === resolvedAccountId) || null;
        const changed = !freshMatch
          || !sameKeySet(again.keys, accountKeys)
          || String(freshMatch.id) !== String(match.id)
          || String(freshMatch.account_id || '') !== String(match.account_id || '');
        if (changed) return changedResult();
        const phoneAgain = await lookupByPhone();
        if (phoneAgain && keyOf(phoneAgain) !== resolvedAccountId) {
          return changedResult({ phoneConflict: true });
        }
      }
      const accountId = await attachMatchedCustomerToAccount(trx, freshMatch);
      return { accountId, existingCustomer: { ...freshMatch, account_id: accountId }, matchType: 'email' };
    }
  }

  return null;
}

async function ensureCustomerAccount(trx, input) {
  const existing = await findAccountByContact(trx, input);
  if (existing?.accountId) return existing;
  if (existing?.requiresConfirmation && existing.phoneMatch) {
    const err = new Error('A customer with this phone already exists — confirm whether to create a separate customer anyway.');
    err.statusCode = 409;
    err.status = 409;
    err.isOperational = true;
    err.code = 'PHONE_MATCH_CONFIRM';
    err.match = existing.match;
    throw err;
  }
  if (existing?.requiresConfirmation && existing.ambiguous) {
    const err = new Error("This lead's email matches customers in several accounts — pick one or create a separate customer.");
    err.statusCode = 409;
    err.status = 409;
    err.isOperational = true;
    err.code = 'EMAIL_MATCH_AMBIGUOUS';
    err.candidates = existing.candidates || [];
    throw err;
  }
  if (existing?.requiresConfirmation) {
    // Fail closed: never silently create OR attach on an unconfirmed email
    // match — the caller must surface the choice to the admin.
    const err = new Error(existing.busy
      ? 'That customer record is being updated — re-open the lead and try again in a moment.'
      : existing.phoneConflict
      ? "This lead's phone now matches a customer in a DIFFERENT account than the one you confirmed — re-open the lead and try again."
      : existing.matchChanged
        ? "The customer this lead's email matched has changed since you confirmed — re-open the lead and try again."
        : "This lead's email matches an existing customer — confirm whether to attach to that account or create a separate customer.");
    err.statusCode = 409;
    err.status = 409;
    err.isOperational = true;
    err.code = 'EMAIL_MATCH_CONFIRM';
    err.match = existing.match;
    throw err;
  }

  // Canonical-format the account row here so callers that pass raw lead data
  // (e.g. admin-leads lead→customer conversion) still create a normalized
  // account, matching the linked customer row. Idempotent for callers that
  // already normalized their input (admin create / quick-add).
  const [account] = await trx('customer_accounts').insert({
    first_name: normalizeContactName(input.firstName),
    last_name: normalizeContactName(input.lastName),
    phone: normalizeContactPhone(input.phone) || null,
    email: input.email ? normalizeContactEmail(input.email) : null,
    company_name: input.companyName || null,
  }).returning('*');

  return { accountId: account.id, existingCustomer: null, matchType: null };
}

async function accountPropertySummary(accountId, excludeCustomerId = null) {
  if (!accountId) return [];
  let query = db('customers')
    .where({ account_id: accountId })
    .whereNull('deleted_at')
    .select('id', 'profile_label', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'pipeline_stage', 'monthly_rate', 'is_primary_profile')
    .orderBy('is_primary_profile', 'desc')
    .orderBy('created_at', 'asc');
  if (excludeCustomerId) query = query.whereNot({ id: excludeCustomerId });
  return query;
}

// New-customer create on a live phone match — admin-confirm gate (#3453's
// lead-convert pattern extended to the direct create paths). Before this,
// POST / and quick-add silently minted a second "Rental property" profile on
// the phone-matched account with no address comparison and no confirmation —
// an office re-key of an existing customer (same phone + same address) split
// history across two rows. Called INSIDE the create transaction, after
// ensureCustomerAccount resolved a phone match (and possibly wrote the
// legacy-row attach) — throwing here rolls that write back.
//  - submitted street key matches a live profile on the account → 409
//    DUPLICATE_PROFILE unless the admin passed confirmDuplicate:true;
//  - genuinely different (or missing) address → the attach itself still
//    requires confirmAttach:true — otherwise 409 PHONE_MATCH_CONFIRM.
// streetKey (services/customer-properties) is suffix-canonical and
// unit-stripped, so "123 Main St" keys with "123 Main Street" but not with
// "123 Main Ave". Both flags are admin-parsed at the route (requireAdmin
// already guards these routes, so the match payload never reaches a tech).
// Add-Property from a specific profile passes the originating customer id
// (admin-only, codex #3469 r3 P1): multiple live accounts can legitimately
// share a phone (admin-created separate accounts), and the phone-first
// `.first()` pick could resolve a DIFFERENT account than the profile the
// admin started from — splitting history again. The explicit origin wins,
// but only when its live row still matches the submitted phone (all inside
// the create transaction); otherwise the hint is ignored and the standard
// visible confirm flow applies.
async function resolveExplicitAttachTarget(trx, account, attachToCustomerId, submittedPhone, forceNewAccount = false) {
  // "Create separate account" outranks the origin hint (codex #3469 r4 P1):
  // Add-Property always carries attachToCustomerId, so a retry that adds
  // forceNewAccount would otherwise mint the fresh account and then
  // immediately re-pin to the origin — attaching against the admin's
  // explicit choice and committing an orphan account row.
  if (forceNewAccount) return account;
  if (!attachToCustomerId) return account;
  const origin = await trx('customers').where({ id: attachToCustomerId }).whereNull('deleted_at').first();
  if (!origin) return account;
  const digits = phoneLast10(submittedPhone);
  if (!digits || phoneLast10(origin.phone) !== digits) return account;
  const originKey = String(origin.account_id || origin.id);
  if (account?.accountId && String(account.accountId) === originKey) return account;
  const accountId = await attachMatchedCustomerToAccount(trx, origin);
  return { accountId, existingCustomer: { ...origin, account_id: accountId }, matchType: 'phone' };
}

async function assertPhoneAttachConfirmed(trx, account, { streetLine1, confirmDuplicate, confirmAttach, confirmMatchedAccountId }) {
  if (!account?.existingCustomer || account.matchType !== 'phone') return;
  // Row-lock the matched customer BEFORE relying on the match (codex #3469
  // r3 P2): the advisory comms fence only stops writers that take that lock
  // — a phone-only PUT /:id does not. FOR UPDATE serializes against any
  // update of the matched row for the rest of this transaction, and the
  // locked re-read verifies the row still carries the matched phone and
  // account; any drift fails closed with zero writes.
  const matched = account.existingCustomer;
  const lockedRow = await trx('customers').where({ id: matched.id }).whereNull('deleted_at').forUpdate().first();
  if (!lockedRow
    || String(lockedRow.account_id || lockedRow.id) !== String(account.accountId)
    || phoneLast10(lockedRow.phone) !== phoneLast10(matched.phone)) {
    const busyErr = new Error('That customer record is being updated — retry in a moment.');
    busyErr.statusCode = 409;
    busyErr.status = 409;
    busyErr.isOperational = true;
    busyErr.code = 'CUSTOMER_BUSY';
    throw busyErr;
  }
  // A confirm flag is honored only for the account the admin actually saw:
  // the 409 payload carries match.accountId, the client echoes it back as
  // confirmMatchedAccountId, and it is re-checked here against the account
  // the phone resolves to NOW (inside this transaction). A changed phone or
  // a concurrent edit that moves the match to a different account gets a
  // fresh 409 instead of silently attaching to an unapproved account.
  const confirmedThisAccount = confirmMatchedAccountId != null
    && String(confirmMatchedAccountId) === String(account.accountId);
  const { streetKey } = require('../services/customer-properties');
  const profiles = await trx('customers')
    .where({ account_id: account.accountId })
    .whereNull('deleted_at')
    .select('id', 'first_name', 'last_name', 'phone', 'address_line1', 'address_line2', 'city', 'state', 'zip')
    .orderBy('is_primary_profile', 'desc')
    .orderBy('created_at', 'asc');
  const rows = profiles.length ? profiles : [account.existingCustomer];
  const raise = (code, message, row) => {
    const err = new Error(message);
    err.statusCode = 409;
    err.status = 409;
    err.isOperational = true;
    err.code = code;
    err.match = {
      accountId: String(account.accountId),
      customerId: row.id,
      name: [row.first_name, row.last_name].filter(Boolean).join(' '),
      phoneMasked: maskPhone(row.phone || account.existingCustomer.phone),
      address: formatAddress({ line1: row.address_line1, line2: row.address_line2, city: row.city, state: row.state, zip: row.zip }) || null,
    };
    throw err;
  };
  const submittedKey = streetKey(streetLine1);
  const dupe = submittedKey ? rows.find((row) => streetKey(row.address_line1) === submittedKey) : null;
  if (dupe) {
    if (confirmDuplicate && confirmedThisAccount) return;
    raise('DUPLICATE_PROFILE', 'This phone belongs to an existing customer with a profile at this address — confirm before creating a duplicate profile.', dupe);
  }
  if (confirmAttach && confirmedThisAccount) return;
  raise('PHONE_MATCH_CONFIRM', 'This phone belongs to an existing customer — confirm attaching this as an additional property on their account, or create a separate account.', rows[0]);
}

async function findCrossAccountContactConflict(customerId, accountId, updates) {
  const normalizedAccountId = accountId ? String(accountId) : null;
  const conflicts = [];

  if (updates.phone !== undefined) {
    const digits = phoneLast10(updates.phone);
    if (digits) {
      const rows = await db('customers')
        .whereNull('deleted_at')
        .whereNot({ id: customerId })
        .whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${digits}`])
        .select('id', 'account_id', 'first_name', 'last_name', 'phone');
      const conflict = rows.find((row) => String(row.account_id || row.id) !== normalizedAccountId);
      if (conflict) conflicts.push({ field: 'phone', customer: conflict });
    }
  }

  if (updates.email !== undefined) {
    const email = cleanEmail(updates.email);
    if (email) {
      const rows = await db('customers')
        .whereNull('deleted_at')
        .whereNot({ id: customerId })
        .whereRaw('LOWER(email) = ?', [email])
        .select('id', 'account_id', 'first_name', 'last_name', 'email');
      const conflict = rows.find((row) => String(row.account_id || row.id) !== normalizedAccountId);
      if (conflict) conflicts.push({ field: 'email', customer: conflict });
    }
  }

  return conflicts[0] || null;
}

// --- Static POST routes (must be registered before /:id handlers to avoid route shadowing) ---

// POST /api/admin/customers/fix-tiers — Recalculate tiers from service count
router.post('/fix-tiers', requireAdmin, async (req, res, next) => {
  try {
    const customers = await db('customers')
      .select('customers.id', 'customers.waveguard_tier')
      .whereIn('customers.pipeline_stage', ['active_customer', 'won'])
      .whereNull('deleted_at');

    let updated = 0;
    for (const c of customers) {
      // Never rewrite an explicit non-member tier (e.g. the flat-commercial
      // 'Commercial' sentinel, or 'One-Time') from scheduled-service count —
      // doing so would re-enable WaveGuard membership/discount behavior on a
      // customer that was intentionally marked non-member.
      if (NON_MEMBERSHIP_TIER_KEYS.has(membershipTierKey(c.waveguard_tier))) continue;
      const services = await db('scheduled_services')
        .where({ customer_id: c.id })
        .whereIn('status', ['scheduled', 'confirmed', 'completed'])
        .countDistinct('service_type as count')
        .first();

      const count = parseInt(services?.count || 0);
      let newTier = null;
      if (count === 0) newTier = null;
      else if (count === 1) newTier = 'Bronze';
      else if (count === 2) newTier = 'Silver';
      else if (count === 3) newTier = 'Gold';
      else newTier = 'Platinum';

      if (newTier !== c.waveguard_tier) {
        // Tier writes participate in the customer-comms serialization
        // (codex #3426 r5 P2): the previsit backstop sweep holds
        // `customer-comms:<id>` through its membership recheck AND the SMS
        // dispatch, so a membership-making tier write here either commits
        // before the sweep's in-lock recheck reads (excluding the customer)
        // or waits until after the send. Comms lock BEFORE the customers
        // row lock (customer-comms-lock.js contract), and the skip/no-op
        // decisions are re-derived from the LOCKED row — the pre-loop
        // snapshot may be stale by the time this customer's turn comes.
        const wrote = await withCustomerCommsLock(db, c.id, async (trx) => {
          const locked = await trx('customers')
            .where({ id: c.id })
            .whereNull('deleted_at')
            .forUpdate()
            .first();
          if (!locked) return false;
          if (NON_MEMBERSHIP_TIER_KEYS.has(membershipTierKey(locked.waveguard_tier))) return false;
          if (locked.waveguard_tier === newTier) return false;
          await trx('customers').where({ id: c.id }).update({ waveguard_tier: newTier });
          return true;
        });
        if (wrote) updated++;
      }
    }

    logger.info(`[customers] Fix tiers: ${updated} of ${customers.length} customers updated`);
    res.json({ success: true, updated, total: customers.length });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/backfill-review-status — flip has_left_google_review = true
// for any customer who already has a matched (non-_stats) row in google_reviews.
// One-shot helper for the ~170 historical reviewers; safe to re-run (idempotent —
// preserves the original review_marked_at on rows that are already true).
router.post('/backfill-review-status', requireAdmin, async (req, res, next) => {
  try {
    const dryRun = req.body?.dryRun === true;
    const matchedIds = await db('google_reviews')
      .whereNotNull('customer_id')
      .where('reviewer_name', '!=', '_stats')
      .distinct('customer_id')
      .pluck('customer_id');

    if (matchedIds.length === 0) {
      return res.json({ success: true, matched: 0, updated: 0, alreadyFlagged: 0, dryRun });
    }

    const candidates = await db('customers')
      .whereIn('id', matchedIds)
      .whereNull('deleted_at')
      .select('id', 'has_left_google_review');

    const toFlip = candidates.filter(c => !c.has_left_google_review).map(c => c.id);
    const alreadyFlagged = candidates.length - toFlip.length;

    if (!dryRun && toFlip.length > 0) {
      await db('customers')
        .whereIn('id', toFlip)
        .update({ has_left_google_review: true, review_marked_at: new Date() });
    }

    logger.info(`[customers] Review-status backfill: ${toFlip.length} flipped, ${alreadyFlagged} already flagged${dryRun ? ' (dry run)' : ''}`);
    res.json({ success: true, matched: candidates.length, updated: dryRun ? 0 : toFlip.length, alreadyFlagged, dryRun });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/quick-add — minimal customer creation from appointment modal
router.post('/quick-add', requireAdmin, async (req, res, next) => {
  try {
    const { firstName, lastName, phone, email, address, addressLine1, addressLine2, city, state, zip, profileLabel, leadSource, pipelineStage, tags, notes } = req.body;
    if (!firstName || !phone) {
      return res.status(400).json({ error: 'firstName and phone required' });
    }
    const normalizedAddress = normalizeAdminAddressInput({ address, addressLine1, addressLine2, city, state, zip });
    if (normalizedAddress.unitConflict) {
      return res.status(400).json({ error: 'Address unit conflicts with the unit included in Address Line 1' });
    }
    const normalized = {
      firstName: normalizeContactName(cleanText(firstName)),
      lastName: normalizeContactName(cleanText(lastName)),
      phone: normalizeContactPhone(cleanText(phone)),
      email: cleanEmail(email),
      address: normalizedAddress.addressLine1,
      addressLine2: normalizedAddress.addressLine2,
      city: normalizedAddress.city,
      state: normalizedAddress.state,
      zip: normalizedAddress.zip,
      profileLabel: cleanOptionalText(profileLabel),
      leadSource: cleanOptionalText(leadSource) || 'admin_manual',
      pipelineStage: cleanText(pipelineStage) || 'new_lead',
      notes: cleanOptionalText(notes),
    };
    if (!normalized.firstName || !normalized.phone) {
      return res.status(400).json({ error: 'firstName and phone required' });
    }
    if (!isValidStage(normalized.pipelineStage)) return res.status(400).json({ error: 'Invalid pipeline stage' });

    // Same admin-parsed confirm flags as POST / below (#3453's pattern).
    const isAdmin = req.techRole === 'admin';
    const confirmDuplicate = isAdmin && req.body.confirmDuplicate === true;
    const confirmAttach = isAdmin && req.body.confirmAttach === true;
    const forceNewAccount = isAdmin && req.body.forceNewAccount === true;
    const ignorePhoneMatch = isAdmin && req.body.ignorePhoneMatch === true;
    const confirmMatchedAccountId = isAdmin && typeof req.body.confirmMatchedAccountId === 'string' && req.body.confirmMatchedAccountId.trim()
      ? req.body.confirmMatchedAccountId.trim() : null;
    const attachToCustomerId = isAdmin && typeof req.body.attachToCustomerId === 'string' && req.body.attachToCustomerId.trim()
      ? req.body.attachToCustomerId.trim() : null;

    const customer = await db.transaction(async (trx) => {
      // fenceAttach: same concurrency fence as POST / below — lock + re-
      // resolve the matched row inside this transaction, CUSTOMER_BUSY on
      // any drift.
      let account = await ensureCustomerAccount(trx, { ...normalized, forceNewAccount, ignorePhoneMatch, fenceAttach: true });
      account = await resolveExplicitAttachTarget(trx, account, attachToCustomerId, normalized.phone, forceNewAccount);
      await assertPhoneAttachConfirmed(trx, account, { streetLine1: normalized.address, confirmDuplicate, confirmAttach, confirmMatchedAccountId });
      const siblingCount = await trx('customers').where({ account_id: account.accountId }).whereNull('deleted_at').count('* as count').first();
      const [created] = await trx('customers').insert({
        account_id: account.accountId,
        is_primary_profile: !account.existingCustomer,
        profile_label: normalized.profileLabel || (account.existingCustomer ? 'Rental property' : 'Primary'),
        first_name: normalized.firstName,
        last_name: normalized.lastName || null,
        phone: normalized.phone,
        email: normalized.email,
        address_line1: normalized.address,
        address_line2: normalized.addressLine2 || null,
        city: normalized.city,
        state: normalized.state,
        zip: normalized.zip,
        pipeline_stage: normalized.pipelineStage,
        pipeline_stage_changed_at: new Date(),
        lead_source: normalized.leadSource,
        crm_notes: normalized.notes,
        active: true,
      }).returning('*');
      await createDefaultCustomerRows(trx, created.id);
      if (Array.isArray(tags) && tags.length) {
        for (const tag of tags) {
          const cleanTag = cleanText(tag);
          if (cleanTag) {
            await trx('customer_tags').insert({ customer_id: created.id, tag: cleanTag }).onConflict(['customer_id', 'tag']).ignore();
          }
        }
      }
      return { ...created, _attachedToExistingAccount: !!account.existingCustomer, _existingCustomer: account.existingCustomer, _propertyCount: Number(siblingCount?.count || 0) + 1 };
    });

    logger.info(`[customers] Quick-add created customer_id=${customer.id} account_id=${customer.account_id || customer.id}`);

    res.status(201).json({
      customer: {
        id: customer.id,
        firstName: customer.first_name,
        lastName: customer.last_name,
        phone: customer.phone,
        accountId: customer.account_id,
        profileLabel: customer.profile_label,
        attachedToExistingAccount: customer._attachedToExistingAccount,
        existingCustomerId: customer._existingCustomer?.id || null,
        existingCustomerName: customer._existingCustomer ? [customer._existingCustomer.first_name, customer._existingCustomer.last_name].filter(Boolean).join(' ') : null,
        propertyCount: customer._propertyCount,
        address: formatAddress({ line1: customer.address_line1, line2: customer.address_line2, city: customer.city, state: customer.state, zip: customer.zip }),
        city: customer.city,
        state: customer.state,
        zip: customer.zip,
        tier: customer.waveguard_tier,
      },
    });
  } catch (err) {
    if (err && (err.code === 'DUPLICATE_PROFILE' || err.code === 'PHONE_MATCH_CONFIRM')) {
      return res.status(409).json({ error: err.message, code: err.code, match: err.match || null });
    }
    next(err);
  }
});

// GET /api/admin/customers — directory + pipeline
router.get('/', async (req, res, next) => {
  try {
    // Default sort: last name, then first name, ascending (phonebook
    // alphabetical). The old default was lead_score desc + limit 100,
    // which meant the client's local alphabetical re-sort only covered
    // the top-100-by-lead-score slice. Anything beyond that fell off
    // the end of the list — looked like "not alphabetical" to operators
    // working large customer bases.
    const {
      search, stage, tier, tag, source, area, city,
      cards, hasBalance, lastVisited,
      sort = 'name', order = 'asc',
    } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));

    if (stage && !isValidStage(stage)) return res.status(400).json({ error: 'Invalid pipeline stage' });

    // Technician tokens must not be able to enumerate the customer base:
    // the directory (list + count) is limited to customers with a visit
    // assigned to the requesting tech, rows are trimmed below
    // (techSafeListRow), and the drivable filters/sorts are reduced to the
    // identity/service-safe set (techSafeListFilters / techSafeSort).
    // Admin requests are unscoped.
    const isTechRequest = req.techRole === 'technician';
    const scopeTechAssigned = (q) => {
      if (isTechRequest) {
        q.whereIn('customers.id', currentAssignmentFilter(
          db('scheduled_services').select('customer_id'),
          req.technicianId,
        ));
      }
      return q;
    };

    const allFilters = { search, stage, tier, tag, source, area, city, cards, hasBalance, lastVisited };
    const filters = isTechRequest ? techSafeListFilters(allFilters) : allFilters;
    const effectiveSort = isTechRequest ? techSafeSort(sort) : sort;
    const healthScoreSelect = latestHealthScoreRaw(await getHealthScoreColumns());

    let query = scopeTechAssigned(applyCustomerListFilters(db('customers').whereNull('customers.deleted_at'), filters)).select(
      'customers.*',
      db.raw('(SELECT COUNT(*) FROM service_records WHERE service_records.customer_id = customers.id) as services_count'),
      db.raw("(SELECT MAX(service_date) FROM service_records WHERE service_records.customer_id = customers.id) as last_service_date"),
      db.raw("(SELECT MIN(scheduled_date) FROM scheduled_services WHERE scheduled_services.customer_id = customers.id AND scheduled_date >= CURRENT_DATE AND status NOT IN ('cancelled','canceled','completed','rescheduled','skipped','no_show')) as next_service_date"),
      db.raw("(SELECT string_agg(tag, ',') FROM customer_tags WHERE customer_tags.customer_id = customers.id) as tags_str"),
      db.raw("(SELECT string_agg(DISTINCT service_type, ',') FROM service_records WHERE service_records.customer_id = customers.id) as service_types"),
      db.raw("(SELECT COUNT(DISTINCT service_type) FROM scheduled_services WHERE scheduled_services.customer_id = customers.id AND status NOT IN ('cancelled')) as service_type_count"),
      // rating column may not exist — use satisfaction_rating from treatment_outcomes or skip
      db.raw("(SELECT NULL) as last_rating"),
      db.raw("(SELECT COALESCE(SUM(GREATEST(total - COALESCE(credit_applied, 0), 0)), 0) FROM invoices WHERE invoices.customer_id = customers.id AND status IN ('sent', 'viewed', 'overdue')) as balance_owed"),
      healthScoreSelect,
      db.raw("(SELECT COUNT(*) FROM payment_methods WHERE payment_methods.customer_id = customers.id) as cards_on_file"),
      // Net of all paid payments minus refunds — the same definition the
      // customer-detail endpoint computes. customers.lifetime_revenue has NO
      // production writer (only demo seeds ever set it), so reading the
      // column shows $0 for every real customer.
      db.raw("(SELECT COALESCE(SUM(amount - COALESCE(refund_amount, 0)), 0) FROM payments WHERE payments.customer_id = customers.id AND payments.status = 'paid') as lifetime_revenue_net"),
    );

    // Alphabetical by first name only — operator preference. No tie-break
    // on last name or other columns. NULLS LAST keeps blank-first-name
    // rows pinned to the end of the list instead of the top.
    const dir = order === 'desc' ? 'desc' : 'asc';
    if (effectiveSort === 'name') {
      query = query.orderByRaw(`LOWER(first_name) ${dir} NULLS LAST`);
    } else if (effectiveSort === 'revenue') {
      // Sort by the computed net, not the writer-less lifetime_revenue column.
      // `dir` is sanitized to asc/desc above.
      query = query.orderByRaw(`lifetime_revenue_net ${dir}`);
    } else {
      const sortCol = { lead_score: 'lead_score', rate: 'monthly_rate', last_contact: 'last_contact_date' }[effectiveSort] || 'first_name';
      query = query.orderBy(sortCol, dir);
    }

    const total = await scopeTechAssigned(applyCustomerListFilters(
      db('customers').whereNull('customers.deleted_at'),
      filters
    )).count('* as count').first();
    const totalCount = parseInt(total?.count || 0);
    const offset = (page - 1) * limit;
    const customers = await query.limit(limit).offset(offset);

    // Pipeline counts
    const pipelineCounts = await db('customers').whereNull('deleted_at').select('pipeline_stage').count('* as count').groupBy('pipeline_stage');
    const pipelineMap = {};
    pipelineCounts.forEach(p => { pipelineMap[p.pipeline_stage || 'unknown'] = parseInt(p.count); });

    // Available filters
    const allTags = await db('customer_tags').select('tag').groupBy('tag').orderBy('tag');
    const allSources = await db('customers').whereNull('deleted_at').select('lead_source').whereNotNull('lead_source').groupBy('lead_source');
    const allAreas = await db('customers').whereNull('deleted_at').select('city').whereNotNull('city').where('city', '!=', '').groupBy('city').orderBy('city');

    // Technician tokens get trimmed rows (no financial/CRM fields) and no
    // pipeline/marketing aggregates — same response shape so the shared
    // search UIs keep working.
    const mappedRows = customers.map(mapCustomerListRow);
    res.json({
      customers: isTechRequest ? mappedRows.map(techSafeListRow) : mappedRows,
      total: totalCount, page, limit,
      totalPages: Math.max(1, Math.ceil(totalCount / limit)),
      pipelineCounts: isTechRequest ? {} : pipelineMap,
      filters: {
        tags: isTechRequest ? [] : allTags.map(t => t.tag),
        sources: isTechRequest ? [] : allSources.map(s => s.lead_source).filter(Boolean),
        areas: allAreas.map(a => a.city).filter(Boolean),
      },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/pipeline — kanban view
router.get('/pipeline/view', requireAdmin, async (req, res, next) => {
  try {
    const limitPerStage = Math.min(500, Math.max(1, parseInt(req.query.limitPerStage) || 100));
    const result = {};
    const flatCustomers = [];

    for (const stage of CUSTOMER_STAGES) {
      const stageQuery = db('customers')
        .where({ pipeline_stage: stage })
        .whereNull('deleted_at');
      const [countRow, revenueRow] = await Promise.all([
        stageQuery.clone().count('* as count').first(),
        stageQuery.clone().sum('monthly_rate as total').first(),
      ]);
      const customers = await db('customers')
        .where({ pipeline_stage: stage })
        .whereNull('deleted_at')
        .select('*')
        .orderBy('lead_score', 'desc')
        .limit(limitPerStage);

      const mappedCustomers = customers.map(c => mapPipelineCustomer(c, stage));
      flatCustomers.push(...mappedCustomers);

      result[stage] = {
        count: parseInt(countRow?.count || 0),
        monthlyRevenue: parseFloat(revenueRow?.total || 0),
        customers: mappedCustomers,
      };
    }

    res.json({ pipeline: result, customers: flatCustomers });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/:id/cards — just the saved payment methods.
// Lightweight endpoint so the MobilePaymentSheet's Card on File picker
// doesn't have to load the full customer profile (tags, interactions,
// services, etc.) every time the tech opens the payment sheet.
router.get('/:id/cards', async (req, res, next) => {
  try {
    // Payment methods stay visible to the tech checkout/project flows, but
    // only for customers with a visit assigned to this tech.
    if (!(await technicianServicesCustomer(req, req.params.id))) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const cards = await db('payment_methods')
      .where({ customer_id: req.params.id })
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'desc');
    res.json({
      cards: cards.map((c) => ({
        id: c.id,
        method_type: c.method_type,
        brand: c.card_brand,
        last_four: c.last_four,
        exp_month: c.exp_month,
        exp_year: c.exp_year,
        bank_name: c.bank_name,
        is_default: !!c.is_default,
      })),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/:id/properties — multi-property list (Phase 1).
// Lazily backfills a primary property for customers created after the migration.
// requireAdmin: returns every active property address on the account — a
// per-customer assignment must not reveal sibling addresses, and no tech
// surface calls this (the property writes below were already admin-only).
router.get('/:id/properties', requireAdmin, async (req, res, next) => {
  try {
    const customerProperties = require('../services/customer-properties');
    await customerProperties.ensurePrimaryProperty(req.params.id).catch(() => {});
    const properties = await customerProperties.listProperties(req.params.id);
    res.json({ properties });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/:id/properties — add a second (non-primary) property.
router.post('/:id/properties', requireAdmin, async (req, res, next) => {
  try {
    const customerProperties = require('../services/customer-properties');
    const { address_line1, address_line2, city, state, zip, occupancy_type, label } = req.body || {};
    if (!String(address_line1 || '').trim()) {
      return res.status(400).json({ error: 'address_line1 is required' });
    }
    // Require city + ZIP too: the full-address dedup key includes them, so a
    // partial address (street only) would not match the existing primary's key
    // and could slip a duplicate past the 409 / unique index.
    if (!String(city || '').trim() || !String(zip || '').trim()) {
      return res.status(400).json({ error: 'city and zip are required' });
    }
    // customer_properties.state is varchar(2): reject "Florida" here with a
    // real validation error instead of letting PostgreSQL bounce the insert
    // as a generic save failure.
    const stateCode = String(state || '').trim().toUpperCase();
    if (stateCode && !/^[A-Z]{2}$/.test(stateCode)) {
      return res.status(400).json({ error: 'state must be a two-letter code' });
    }
    // If this address is the customer's OWN primary that's only PARTIAL on file
    // (same street, missing city/ZIP), complete that primary first — otherwise its
    // partial address_key wouldn't match this full address and recordCallProperty
    // would insert a duplicate of the primary. Complete → ensure → record mirrors
    // the call pipeline. completePrimaryFromCall is a no-op for a genuinely
    // different street (a real secondary).
    await customerProperties.completePrimaryFromCall(req.params.id, { address_line1, address_line2, city, zip }).catch(() => {});
    // Ensure the primary exists, so the customer's current address is represented
    // before we add a secondary. This also makes recordCallProperty's dedup reject
    // a POST of the customer's own (now-complete) primary address (409) instead of
    // creating a lone non-primary that a later read would duplicate.
    await customerProperties.ensurePrimaryProperty(req.params.id).catch(() => {});
    const result = await customerProperties.recordCallProperty({
      customerId: req.params.id,
      address_line1, address_line2, city, state: stateCode || null, zip,
      occupancyType: occupancy_type,
      label,
      source: 'manual',
    });
    if (!result.created) {
      return res.status(409).json({ error: 'A property with that street already exists for this customer' });
    }
    const properties = await customerProperties.listProperties(req.params.id);
    return res.status(201).json({ propertyId: result.propertyId, properties });
  } catch (err) { next(err); }
});

// PATCH /api/admin/customers/:id/properties/:propertyId — edit occupancy/label.
router.patch('/:id/properties/:propertyId', requireAdmin, async (req, res, next) => {
  try {
    const { OCCUPANCY_TYPES, listProperties } = require('../services/customer-properties');
    const updates = {};
    if (req.body && req.body.occupancy_type !== undefined) {
      if (!OCCUPANCY_TYPES.includes(req.body.occupancy_type)) {
        return res.status(400).json({ error: 'invalid occupancy_type' });
      }
      updates.occupancy_type = req.body.occupancy_type;
    }
    if (req.body && req.body.label !== undefined) updates.label = req.body.label || null;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'nothing to update' });
    updates.updated_at = new Date();
    const n = await db('customer_properties')
      .where({ id: req.params.propertyId, customer_id: req.params.id })
      .update(updates);
    if (!n) return res.status(404).json({ error: 'property not found' });
    const properties = await listProperties(req.params.id);
    return res.json({ properties });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/:id/timeline — unified customer timeline
router.get('/:id/timeline', requireAdmin, async (req, res, next) => {
  try {
    const customerId = req.params.id;
    const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const timeline = [];

    // customer_interactions
    const interactions = await db('customer_interactions').where({ customer_id: customerId }).select('interaction_type', 'subject', 'body', 'created_at');
    for (const i of interactions) {
      timeline.push({
        type: 'interaction', title: i.subject || `${i.interaction_type} interaction`,
        description: i.body || '', date: i.created_at,
        metadata: { interactionType: i.interaction_type },
      });
    }

    // sms + voice via unified messages (since PR 2). Joined to conversations
    // so we can attribute to this customer regardless of whether the
    // historical row had customer_id set on sms_log/call_log directly.
    try {
      const comms = await db('messages')
        .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
        .where('conversations.customer_id', customerId)
        .whereIn('messages.channel', ['sms', 'voice'])
        .select(
          'messages.channel', 'messages.direction', 'messages.body',
          'messages.ai_summary', 'messages.duration_seconds',
          'messages.created_at',
          'conversations.contact_phone', 'conversations.our_endpoint_id'
        );
      for (const m of comms) {
        if (m.channel === 'sms') {
          timeline.push({
            type: 'sms',
            title: `SMS ${m.direction === 'inbound' ? 'received' : 'sent'}`,
            description: (m.body || '').slice(0, 200),
            date: m.created_at,
            metadata: { direction: m.direction },
          });
        } else {
          const fromPhone = m.direction === 'inbound' ? m.contact_phone : m.our_endpoint_id;
          timeline.push({
            type: 'call',
            title: 'Phone call',
            description: m.ai_summary || (m.body ? m.body.slice(0, 200) : `Call from ${fromPhone || 'unknown'}`),
            date: m.created_at,
            metadata: { fromPhone, durationSeconds: m.duration_seconds },
          });
        }
      }
    } catch { /* unified comms tables may not exist in older snapshots */ }

    // service_records
    const services = await db('service_records')
      .where({ 'service_records.customer_id': customerId })
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.service_type', 'service_records.service_date', 'technicians.name as tech_name');
    for (const s of services) {
      timeline.push({
        type: 'service', title: `Service: ${s.service_type}`,
        description: s.tech_name ? `Performed by ${s.tech_name}` : 'Service completed',
        date: s.service_date, metadata: { serviceType: s.service_type, techName: s.tech_name },
      });
    }

    // payments
    const payments = await db('payments').where({ customer_id: customerId }).select('amount', 'payment_date', 'description');
    for (const p of payments) {
      timeline.push({
        type: 'payment', title: `Payment: $${parseFloat(p.amount || 0).toFixed(2)}`,
        description: p.description || 'Payment received', date: p.payment_date,
        metadata: { amount: parseFloat(p.amount || 0) },
      });
    }

    // scheduled_services
    const scheduled = await db('scheduled_services').where({ customer_id: customerId }).select('service_type', 'scheduled_date', 'status');
    for (const s of scheduled) {
      timeline.push({
        type: 'scheduled_service', title: `Scheduled: ${s.service_type}`,
        description: `Status: ${s.status}`, date: s.scheduled_date,
        metadata: { serviceType: s.service_type, status: s.status },
      });
    }

    // google_reviews
    try {
      const reviews = await db('google_reviews').where({ customer_id: customerId }).select('star_rating', 'review_text', 'review_created_at');
      for (const r of reviews) {
        timeline.push({
          type: 'review', title: `Google Review: ${'★'.repeat(r.star_rating)}${'☆'.repeat(5 - r.star_rating)}`,
          description: (r.review_text || '').slice(0, 200), date: r.review_created_at,
          metadata: { starRating: r.star_rating },
        });
      }
    } catch { /* google_reviews may not have customer_id */ }

    // activity_log
    try {
      const activities = await db('activity_log').where({ customer_id: customerId }).select('action', 'description', 'created_at');
      for (const a of activities) {
        timeline.push({
          type: 'activity', title: a.action, description: a.description || '',
          date: a.created_at, metadata: { action: a.action },
        });
      }
    } catch { /* ignore */ }

    // Sort by date descending
    timeline.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    res.json({ timeline });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/:id/comms — unified per-customer SMS + voice
// thread (PR 3 of comms unification). Replaces the SMS-only feed that
// fed the Comms tab from `data.smsLog`. Email lands in PR 5.
router.get('/:id/comms', requireAdmin, async (req, res, next) => {
  try {
    const customerId = req.params.id;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);

    const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const rows = await db('messages')
      .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
      .where('conversations.customer_id', customerId)
      .whereIn('messages.channel', ['sms', 'voice'])
      .select(
        'messages.id', 'messages.channel', 'messages.direction', 'messages.body',
        'messages.ai_summary', 'messages.message_type', 'messages.duration_seconds',
        'messages.media', 'messages.answered_by', 'messages.is_read',
        'messages.delivery_status', 'messages.recording_sid', 'messages.created_at',
        'conversations.our_endpoint_id', 'conversations.contact_phone'
      )
      .orderBy('messages.created_at', 'desc')
      .limit(limit);

    // Resolve the friendly label (location / domain) for each Waves number
    // hit by this customer, so the UI can show e.g. "Lakewood Ranch — HQ"
    // instead of a raw E.164.
    let TWILIO_NUMBERS;
    try { TWILIO_NUMBERS = require('../config/twilio-numbers'); } catch { TWILIO_NUMBERS = null; }

    const comms = rows.map(m => {
      const numberCfg = TWILIO_NUMBERS?.findByNumber?.(m.our_endpoint_id) || null;
      let media = [];
      try { media = typeof m.media === 'string' ? JSON.parse(m.media) : (m.media || []); } catch { media = []; }
      return {
        id: m.id,
        channel: m.channel,
        direction: m.direction,
        body: m.body,
        aiSummary: m.ai_summary,
        messageType: m.message_type,
        durationSeconds: m.duration_seconds,
        media,
        answeredBy: m.answered_by,
        isRead: !!m.is_read,
        deliveryStatus: m.delivery_status,
        recordingSid: m.recording_sid,
        createdAt: m.created_at,
        ourEndpointId: m.our_endpoint_id,
        ourEndpointLabel: numberCfg?.label || null,
        contactPhone: m.contact_phone || customer.phone || null,
      };
    });

    res.json({ comms, total: comms.length });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/:id/schedule-estimates — bookable estimates
// formatted for the New Appointment modal. Surfaces accepted estimates plus
// still-open quotes the customer has been sent (sent / viewed) so a phone
// acceptance ("he called and accepted") can be booked before anyone has
// formally marked the estimate accepted in the system. Each row carries its
// `status` so the UI can show whether it's accepted yet. This keeps the UI
// from guessing at estimate_data shapes and returns service-library ids when
// we can match the quoted line to a schedulable service.
// requireAdmin: office booking data — sent/accepted quote pricing, payment
// posture, and permanent estimate bearer tokens. Its only consumer is
// CreateAppointmentModal, and appointment creation is already admin-only.
router.get('/:id/schedule-estimates', requireAdmin, async (req, res, next) => {
  try {
    const customer = await db('customers')
      .where({ id: req.params.id })
      .whereNull('deleted_at')
      .first('id');
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const [estimates, serviceRows] = await Promise.all([
      db('estimates')
        .where({ customer_id: customer.id })
        .whereNull('archived_at')
        // Accepted estimates always qualify. Open quotes (sent / viewed)
        // qualify too — that's the phone-acceptance case — but only while
        // they're still live, so an expired quote's stale price doesn't show
        // up as bookable (and can't hit the doomed auto-accept path).
        .where((qb) => qb
          .where('status', 'accepted')
          .orWhere((open) => open
            .whereIn('status', ['sent', 'viewed'])
            .andWhere((live) => live
              .whereNull('expires_at')
              .orWhere('expires_at', '>=', db.fn.now()))))
        // Accepted estimates float to the top; open quotes follow, each set
        // newest-first (accepted_at is null for sent/viewed, so those fall
        // through to created_at).
        .orderByRaw("CASE WHEN status = 'accepted' THEN 0 ELSE 1 END")
        .orderBy('accepted_at', 'desc')
        .orderBy('created_at', 'desc')
        .select(
          'id', 'customer_id', 'status', 'token', 'service_interest', 'estimate_data',
          'estimate_slug', 'monthly_total', 'annual_total', 'onetime_total', 'waveguard_tier',
          'bill_by_invoice', 'show_one_time_option', 'created_at', 'accepted_at',
        ),
      db('services')
        // mosquito_seasonal is active as of 20260805000010, making the
        // orWhere idempotent — it is RETAINED as a safety net so a seasonal
        // QUOTE keeps its catalog identity even if the row is ever
        // deactivated again: without it the fuzzy match stamps
        // mosquito_monthly's service_id on a seasonal booking and
        // catalog-first consumers classify the plan as 12-visit monthly
        // (codex r16 P2). Widening here only affects the schedule-modal
        // pre-fill's identity resolution; it never makes an inactive
        // service bookable elsewhere.
        .where((q) => q.where({ is_active: true }).orWhere({ service_key: 'mosquito_seasonal' }))
        .select(
          'id', 'service_key', 'name', 'short_name', 'category', 'billing_type',
          'frequency', 'visits_per_year', 'default_duration_minutes',
          'base_price', 'price_range_min', 'price_range_max',
        )
        .catch(() => []),
    ]);

    const estimateIds = estimates.map((e) => e.id);
    const linkedByEstimate = new Map();
    if (estimateIds.length) {
      const linkedRows = await db('scheduled_services')
        .whereIn('source_estimate_id', estimateIds)
        .whereNotIn('status', ['cancelled', 'rescheduled'])
        .orderBy('scheduled_date', 'asc')
        .orderBy('window_start', 'asc')
        .select('id', 'source_estimate_id', 'scheduled_date', 'window_start', 'service_type', 'status');
      for (const row of linkedRows) {
        if (!linkedByEstimate.has(row.source_estimate_id)) linkedByEstimate.set(row.source_estimate_id, row);
      }
    }

    const serviceIndex = indexServicesForSchedule(serviceRows);
    const { summarizeEstimateDeposit } = require('../services/estimate-deposits');
    const out = await Promise.all(estimates.map(async (estimate) => {
      const lines = scheduleLinesFromEstimate(estimate, serviceIndex);
      const linked = linkedByEstimate.get(estimate.id) || null;
      const monthlyTotal = estimate.monthly_total != null ? Number(estimate.monthly_total) : null;
      const annualTotal = estimate.annual_total != null ? Number(estimate.annual_total) : null;
      const onetimeTotal = estimate.onetime_total != null ? Number(estimate.onetime_total) : null;
      // Quoted figure compared against a single visit's price: the recurring
      // period charge (monthly, or annual only when there's no monthly) plus
      // any one-time. annual_total is the annualized form of monthly_total
      // (monthly * 12), so summing both would double-count the recurring plan.
      const quotedTotal = (monthlyTotal || annualTotal || 0) + (onetimeTotal || 0);
      // Deposit read is fail-soft inside summarizeEstimateDeposit, but guard
      // the await too so one bad estimate can't 500 the whole list.
      let deposit = null;
      try {
        // Scope the deposit summary to the actual linked appointment (when one
        // exists) so the payer-billed / prepay_annual scope is recovered even
        // after the visit leaves the pending/confirmed window that the
        // linked-upcoming fallback covers.
        deposit = await summarizeEstimateDeposit(
          estimate,
          linked ? { scheduledServiceId: linked.id, useLinkedFallback: false } : {},
        );
      } catch { deposit = null; }
      // Exact payment posture (annual prepay paid/pending, setup-fee invoice)
      // for the same provenance card — fail-soft like the deposit read.
      // Deliberately NOT scoped to the linked appointment: this payload feeds
      // the New Appointment modal, which books a NEW visit — visit-level
      // coverage from an OLD linked visit must not transfer ("do not collect"
      // would be wrong for a new booking completion billing will invoice).
      // With no visit in scope, coversThisVisit stays null and the card makes
      // no collection claim.
      let payment = null;
      try {
        const { buildEstimatePaymentContext } = require('../services/estimate-payment-context');
        payment = await buildEstimatePaymentContext(estimate, {});
      } catch { payment = null; }
      // Whether the Schedule modal may offer one-step annual prepay for this
      // quote + the exact amount the prepay invoice would bill (discount +
      // floor applied). Server-derived so the modal never offers a billing
      // term the accept would reject. Fail-soft: no prepay offer on error.
      let prepay = { eligible: false, invoiceTotal: null };
      try {
        const e = await require('../services/estimate-manual-acceptance').prepayBookingEligibility(estimate);
        prepay = { eligible: !!e.eligible, invoiceTotal: e.invoiceTotal != null ? Number(e.invoiceTotal) : null };
      } catch { prepay = { eligible: false, invoiceTotal: null }; }
      return {
        id: estimate.id,
        token: estimate.token,
        // Human-facing estimate number (EST-YYYY-NNNN) — same reference the
        // customer sees on the public quote page, cited by the provenance card.
        estimateSlug: estimate.estimate_slug || null,
        status: estimate.status,
        serviceInterest: estimate.service_interest,
        acceptedAt: estimate.accepted_at,
        createdAt: estimate.created_at,
        monthlyTotal,
        annualTotal,
        onetimeTotal,
        quotedTotal,
        waveguardTier: estimate.waveguard_tier,
        lines,
        deposit,
        payment,
        prepay,
        linkedAppointment: linked ? {
          id: linked.id,
          scheduledDate: linked.scheduled_date,
          windowStart: linked.window_start,
          serviceType: linked.service_type,
          status: linked.status,
        } : null,
      };
    }));
    res.json({ estimates: out });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/:id/estimates-summary — compact payload for the
// Estimates page's customer slide-over. Returns customer basics, the full
// estimate history for that customer, aggregate conversion stats, and the
// most recent comms touchpoint. Much cheaper than /api/admin/customers/:id
// which pulls 16 parallel tables; this endpoint is the 4 we actually need.
router.get('/:id/estimates-summary', async (req, res, next) => {
  try {
    if (!(await technicianServicesCustomer(req, req.params.id))) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const customer = await db('customers')
      .where({ id: req.params.id })
      .whereNull('deleted_at')
      .select(
        'id', 'first_name', 'last_name', 'phone', 'email',
        'address_line1', 'city', 'state', 'zip',
        'waveguard_tier', 'active', 'created_at',
        'property_type', 'company_name',
        'lead_source', 'lead_source_detail',
      )
      .first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Technician tokens: the tech CreateProjectModal consumes only
    // `customer`. Office analytics — estimate history (with bearer tokens
    // and decline reasons), conversion stats, the last-SMS preview — and
    // lead attribution stay office-only, same boundary as /comms.
    if (req.techRole === 'technician') {
      const { lead_source, lead_source_detail, ...techCustomer } = customer;
      return res.json({ customer: techCustomer, estimates: [], stats: null, lastContact: null });
    }

    const [estimates, lastMessage] = await Promise.all([
      db('estimates')
        .where({ customer_id: customer.id })
        .orderBy('created_at', 'desc')
        .select(
          'id', 'status', 'token', 'service_interest', 'decline_reason',
          'monthly_total', 'annual_total', 'onetime_total', 'waveguard_tier',
          'created_at', 'sent_at', 'viewed_at', 'accepted_at', 'declined_at', 'expires_at',
        ),
      db('messages')
        .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
        .where('conversations.customer_id', customer.id)
        .whereIn('messages.channel', ['sms', 'voice'])
        .orderBy('messages.created_at', 'desc')
        .select('messages.channel', 'messages.direction', 'messages.created_at', 'messages.body')
        .first()
        .catch(() => null),
    ]);

    // Conversion math. "Decided" = accepted + declined. Pipeline count
    // includes draft/sent/viewed/expired so the rate isn't inflated by
    // still-open quotes. Accepted lifetime monthly is the sum of monthly
    // totals at acceptance time — useful proxy for recurring CLV.
    const accepted = estimates.filter((e) => e.status === 'accepted');
    const declined = estimates.filter((e) => e.status === 'declined');
    const acceptedLifetimeMonthly = accepted.reduce((s, e) => s + Number(e.monthly_total || 0), 0);
    const decided = accepted.length + declined.length;
    const stats = {
      total: estimates.length,
      accepted: accepted.length,
      declined: declined.length,
      open: estimates.filter((e) => ['draft', 'sent', 'viewed'].includes(e.status)).length,
      conversionRate: decided > 0 ? Math.round((accepted.length / decided) * 100) / 100 : null,
      acceptedLifetimeMonthly: Math.round(acceptedLifetimeMonthly * 100) / 100,
    };

    res.json({
      customer,
      estimates,
      stats,
      lastContact: lastMessage ? {
        channel: lastMessage.channel,
        direction: lastMessage.direction,
        at: lastMessage.created_at,
        preview: lastMessage.body ? String(lastMessage.body).slice(0, 140) : null,
      } : null,
    });
  } catch (err) { next(err); }
});

router.get('/:id/latest-scheduled-service', async (req, res, next) => {
  try {
    if (!(await technicianServicesCustomer(req, req.params.id))) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const service = await db('scheduled_services')
      .where({ customer_id: req.params.id })
      .whereNotIn('status', ['cancelled', 'canceled', 'rescheduled', 'skipped', 'no_show'])
      // Same predicate as the existence gate: the prefill must be the
      // TECH'S OWN latest visit — without this, an office-scheduled
      // follow-up assigned to another tech leaks into the project modal.
      .modify((q) => {
        if (req.techRole === 'technician') currentAssignmentFilter(q, req.technicianId);
      })
      .orderBy('scheduled_date', 'desc')
      .orderBy('created_at', 'desc')
      .first('id', 'service_type', 'scheduled_date', 'status');

    res.json({
      service: service ? {
        id: service.id,
        serviceType: service.service_type,
        scheduledDate: dateOnlyForApi(service.scheduled_date),
        status: service.status,
      } : null,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/:id — full detail
router.get('/:id', async (req, res, next) => {
  try {
    // The 360 payload below includes billing history, stored payment
    // methods, consents, and contracts — a technician token gets it only
    // for customers whose visits are assigned to them.
    if (!(await technicianServicesCustomer(req, req.params.id))) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const c = await db('customers').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!c) return res.status(404).json({ error: 'Customer not found' });

    const currentYear = Number(etDateString().slice(0, 4));
    const focusServiceId = typeof req.query.focusServiceId === 'string' && req.query.focusServiceId.trim() ? req.query.focusServiceId.trim() : null;
    const annualPrepayTermsPromise = db.schema.hasTable('annual_prepay_terms')
      .then((exists) => exists
        ? db('annual_prepay_terms as apt')
          .leftJoin('invoices as inv', 'apt.prepay_invoice_id', 'inv.id')
          .leftJoin('scheduled_services as ss', 'apt.last_scheduled_service_id', 'ss.id')
          .where('apt.customer_id', c.id)
          .select(
            'apt.*',
            'inv.invoice_number as prepay_invoice_number',
            'inv.status as prepay_invoice_status',
            'inv.total as prepay_invoice_total',
            'inv.subtotal as prepay_invoice_subtotal',
            'ss.service_type as last_scheduled_service_type',
          )
          .orderBy('apt.term_end', 'desc')
          .limit(5)
        : [])
      .catch(e => { logger.warn(`[customers:${c.id}] annual_prepay_terms: ${e.message}`); return []; });

    const [tags, interactions, prefs, services, estimates, payments, paymentsTotal, scheduled, upcomingScheduled, smsLog, healthScore, invoices, cards, paymentMethodConsents, contracts, photos, notificationPrefs, referralInfo, complianceRecords, customerDiscounts, nutrientLedgerRows, nutrientLedgerSummary, accountProperties, annualPrepayTerms, prepaidPlans] = await Promise.all([
      db('customer_tags').where({ customer_id: c.id }).select('tag'),
      db('customer_interactions').where({ customer_id: c.id }).orderBy('created_at', 'desc').limit(30),
      db('property_preferences').where({ customer_id: c.id }).first(),
      db('service_records')
        .where({ 'service_records.customer_id': c.id })
        .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
        .select('service_records.*', 'technicians.name as technician_name')
        .orderBy('service_records.service_date', 'desc')
        .limit(20),
      db('estimates').where({ customer_id: c.id }).orderBy('created_at', 'desc'),
      db('payments').where({ 'payments.customer_id': c.id }).leftJoin('payment_methods', 'payments.payment_method_id', 'payment_methods.id').select('payments.*', 'payment_methods.card_brand', 'payment_methods.last_four').orderBy('payment_date', 'desc').limit(20),
      db('payments').where({ customer_id: c.id, status: 'paid' }).first(db.raw('COALESCE(SUM(amount - COALESCE(refund_amount, 0)), 0)::float as net')).catch(e => { logger.warn(`[customers:${c.id}] payments_sum: ${e.message}`); return { net: 0 }; }),
      customerScheduledHistory(db, c.id, { focusServiceId }),
      // Upcoming, active-only — drives Customer 360's "next service" selection.
      db('scheduled_services')
        .where({ customer_id: c.id })
        .where('scheduled_date', '>=', etDateString())
        .whereNotIn('status', ['cancelled', 'canceled', 'completed', 'rescheduled', 'skipped', 'no_show'])
        .orderBy('scheduled_date')
        .orderBy('window_start')
        .limit(20),
      db('sms_log').where({ customer_id: c.id }).orderBy('created_at', 'desc').limit(20),
      latestHealthScoreForCustomer(c.id),
      db('invoices').where({ customer_id: c.id }).orderBy('created_at', 'desc').limit(10).catch(e => { logger.warn(`[customers:${c.id}] invoices: ${e.message}`); return []; }),
      db('payment_methods').where({ customer_id: c.id }).catch(e => { logger.warn(`[customers:${c.id}] payment_methods: ${e.message}`); return []; }),
      db('payment_method_consents as pmc')
        .leftJoin('payment_methods as pm', 'pmc.payment_method_id', 'pm.id')
        .where('pmc.customer_id', c.id)
        .select(
          'pmc.id',
          'pmc.payment_method_id',
          'pmc.stripe_payment_method_id',
          'pmc.source',
          'pmc.consent_text_version',
          'pmc.consent_text_snapshot',
          'pmc.ip',
          'pmc.user_agent',
          'pmc.created_at',
          'pm.method_type',
          'pm.card_brand',
          'pm.last_four',
          'pm.exp_month',
          'pm.exp_year',
          'pm.bank_name',
          'pm.bank_last_four',
          'pm.is_default',
          'pm.autopay_enabled'
        )
        .orderBy('pmc.created_at', 'desc')
        .limit(20)
        .catch(e => { logger.warn(`[customers:${c.id}] payment_method_consents: ${e.message}`); return []; }),
      db('customer_contracts as cc')
        .leftJoin('payment_methods as pm', 'cc.payment_method_id', 'pm.id')
        .leftJoin('document_templates as dt', 'cc.document_template_id', 'dt.id')
        .where('cc.customer_id', c.id)
        .select(
          'cc.*',
          'pm.method_type',
          'pm.card_brand',
          'pm.last_four',
          'pm.bank_name',
          'pm.bank_last_four',
          'dt.requires_signature as document_template_requires_signature',
          'dt.category as document_template_category',
          'dt.document_type as document_template_document_type'
        )
        .orderBy('cc.created_at', 'desc')
        .limit(20)
        .catch(e => { logger.warn(`[customers:${c.id}] customer_contracts: ${e.message}`); return []; }),
      db('service_photos')
        .join('service_records', 'service_photos.service_record_id', 'service_records.id')
        .where('service_records.customer_id', c.id)
        .select(
          'service_photos.id',
          'service_photos.s3_key',
          'service_photos.s3_url',
          'service_photos.caption',
          'service_photos.service_record_id',
          'service_photos.created_at'
        )
        .orderBy('service_photos.created_at', 'desc')
        .limit(12)
        .catch(e => { logger.warn(`[customers:${c.id}] service_photos: ${e.message}`); return []; }),
      db('notification_prefs').where({ customer_id: c.id }).first().catch(e => { logger.warn(`[customers:${c.id}] notification_prefs: ${e.message}`); return null; }),
      db('referral_promoters').where({ customer_id: c.id }).first().catch(e => { logger.warn(`[customers:${c.id}] referral_promoters: ${e.message}`); return null; }),
      db('property_application_history').where({ customer_id: c.id }).whereNull('retracted_at').orderBy('application_date', 'desc').limit(10).catch(e => { logger.warn(`[customers:${c.id}] property_application_history: ${e.message}`); return []; }),
      db('customer_discounts').where({ 'customer_discounts.customer_id': c.id }).leftJoin('discounts', 'customer_discounts.discount_id', 'discounts.id').select('customer_discounts.*', 'discounts.name as discount_name', 'discounts.discount_type', 'discounts.amount as discount_value').catch(e => { logger.warn(`[customers:${c.id}] customer_discounts: ${e.message}`); return []; }),
      db('property_nutrient_ledger')
        .where({ customer_id: c.id, application_year: currentYear })
        .orderBy('application_date', 'desc')
        .orderBy('created_at', 'desc')
        .limit(25)
        .catch(e => { logger.warn(`[customers:${c.id}] property_nutrient_ledger: ${e.message}`); return []; }),
      db('property_nutrient_ledger')
        .where({ customer_id: c.id, application_year: currentYear })
        .first(
          db.raw('COALESCE(SUM(n_applied_per_1000), 0)::float as "nApplied"'),
          db.raw('COALESCE(SUM(p_applied_per_1000), 0)::float as "pApplied"'),
          db.raw('COALESCE(SUM(k_applied_per_1000), 0)::float as "kApplied"'),
          db.raw('COUNT(*)::int as entries')
        )
        .catch(e => { logger.warn(`[customers:${c.id}] property_nutrient_ledger_summary: ${e.message}`); return null; }),
      accountPropertySummary(c.account_id, c.id).catch(e => { logger.warn(`[customers:${c.id}] account_properties: ${e.message}`); return []; }),
      annualPrepayTermsPromise,
      listCustomerPrepaidPlans(db, c.id).catch(e => { logger.warn(`[customers:${c.id}] prepaid_plans: ${e.message}`); return []; }),
    ]);

    // The invoices table stores the billed amount as `total`; the frontend reads
    // `amount_due`/`amount_paid`. Only collectible statuses contribute to
    // amount_due — draft/void must not inflate Balance Owed (frontend filters
    // by `status !== 'paid'`).
    const COLLECTIBLE_STATUSES = new Set(['sent', 'viewed', 'overdue', 'paid']);
    const mappedInvoices = (invoices || []).map(inv => {
      // Amount DUE / cash PAID both net out applied account credit (cents-safe
      // via invoiceAmountDue) — a partial credit reduces what's owed and the
      // cash collected, so the gross `total` would overstate both.
      const amountDue = invoiceAmountDue(inv);
      const isPaid = inv.status === 'paid' || inv.status === 'prepaid';
      const isCollectible = COLLECTIBLE_STATUSES.has(inv.status);
      return {
        ...inv,
        amount_due: isCollectible ? amountDue : 0,
        amount_paid: isPaid ? amountDue : 0,
      };
    });
    // Lifetime revenue is the net of all paid payments (Stripe + Zelle/manual),
    // minus refunds. customers.lifetime_revenue isn't kept in sync, and summing
    // paid-invoice totals from the limit(10) query above would underreport for
    // long-tenured customers and miss off-gateway payments without invoices.
    const lifetimeRevenue = parseFloat(paymentsTotal?.net || 0);

    const signedPhotos = await Promise.all((photos || []).map(async (p) => {
      if (!p.s3_key) return { ...p, url: null, s3_url: null };
      try {
        return { ...p, url: await PhotoService.getViewUrl(p.s3_key, 300), s3_url: null };
      } catch (err) {
        logger.warn(`[customers:${c.id}] service photo presign failed: ${err.message}`);
        return { ...p, url: null, s3_url: null };
      }
    }));

    const payload = {
      customer: {
        id: c.id, firstName: c.first_name, lastName: c.last_name,
        accountId: c.account_id,
        payerId: c.payer_id || null,
        profileLabel: c.profile_label,
        isPrimaryProfile: !!c.is_primary_profile,
        email: c.email, phone: c.phone, secondaryPhone: c.secondary_phone,
        secondaryContact: c.secondary_contact_name, companyName: c.company_name,
        contactRole: c.contact_role || null,
        serviceContactName: c.service_contact_name,
        serviceContactPhone: c.service_contact_phone,
        serviceContactEmail: c.service_contact_email,
        serviceContact2Name: c.service_contact2_name,
        serviceContact2Phone: c.service_contact2_phone,
        serviceContact2Email: c.service_contact2_email,
        serviceContact3Name: c.service_contact3_name,
        serviceContact3Phone: c.service_contact3_phone,
        serviceContact3Email: c.service_contact3_email,
        address: { line1: c.address_line1, line2: c.address_line2, city: c.city, state: c.state, zip: c.zip },
        property: { type: c.property_type, lawnType: c.lawn_type, sqft: c.property_sqft, lotSqft: c.lot_sqft, palmCount: c.palm_count },
        tier: c.waveguard_tier, monthlyRate: parseFloat(c.monthly_rate || 0),
        billingMode: c.billing_mode || null,
        // Billing pause. Set when autopay's 3-retry ladder exhausts
        // (billing-cron); until now nothing in the product ever showed it on
        // the customer record or cleared it, so a paused customer's dues
        // stopped permanently and the only fix was editing the row by hand.
        servicePausedAt: c.service_paused_at || null,
        // The ET calendar date the pause landed on. The raw timestamp above
        // renders in the BROWSER's timezone, which puts an evening pause on
        // the wrong day for anyone west of ET; this is the one the UI shows.
        servicePausedOn: c.service_paused_at ? etDateString(new Date(c.service_paused_at)) : null,
        servicePauseReason: c.service_pause_reason || null,
        memberSince: c.member_since, active: c.active,
        pipelineStage: c.pipeline_stage, leadScore: c.lead_score,
        leadSource: c.lead_source, leadSourceDetail: c.lead_source_detail,
        landingPageUrl: c.landing_page_url,
        assignedTo: c.assigned_to, lastContactDate: c.last_contact_date,
        nextFollowUp: c.next_follow_up_date, followUpNotes: c.follow_up_notes,
        lifetimeRevenue,
        annualValue: parseFloat(c.monthly_rate || 0) * 12,
        totalServices: c.total_services,
        referralCode: c.referral_code, crmNotes: c.crm_notes,
        satelliteUrl: c.satellite_url,
        hasLeftGoogleReview: !!c.has_left_google_review,
        reviewMarkedAt: c.review_marked_at,
      },
      accountProperties: accountProperties.map(p => ({
        id: p.id,
        profileLabel: p.profile_label,
        address: { line1: p.address_line1, line2: p.address_line2, city: p.city, state: p.state, zip: p.zip },
        pipelineStage: p.pipeline_stage,
        monthlyRate: parseFloat(p.monthly_rate || 0),
        isPrimaryProfile: !!p.is_primary_profile,
      })),
      tags: tags.map(t => t.tag),
      interactions, preferences: prefs, services, estimates, payments, scheduled, upcomingScheduled, smsLog,
      healthScore: healthScore || null,
      invoices: mappedInvoices,
      cards: cards || [],
      paymentMethodConsents: (paymentMethodConsents || []).map((consent) => ({
        id: consent.id,
        paymentMethodId: consent.payment_method_id,
        stripePaymentMethodId: consent.stripe_payment_method_id,
        source: consent.source,
        consentTextVersion: consent.consent_text_version,
        consentTextSnapshot: consent.consent_text_snapshot,
        ip: consent.ip,
        userAgent: consent.user_agent,
        createdAt: consent.created_at,
        methodType: consent.method_type,
        cardBrand: consent.card_brand,
        lastFour: consent.last_four || consent.bank_last_four,
        expMonth: consent.exp_month,
        expYear: consent.exp_year,
        bankName: consent.bank_name,
        isDefault: !!consent.is_default,
        autopayEnabled: !!consent.autopay_enabled,
      })),
      contracts: (contracts || []).map((contract) => ({
        id: contract.id,
        customerId: contract.customer_id,
        paymentMethodId: contract.payment_method_id,
        createdBy: contract.created_by,
        contractType: contract.contract_type,
        title: contract.title,
        status: contract.status,
        recipientName: contract.recipient_name,
        recipientEmail: contract.recipient_email,
        recipientPhone: contract.recipient_phone,
        serviceName: contract.service_name,
        renewalDate: contract.renewal_date,
        cancellationDeadline: contract.cancellation_deadline,
        autoRenewalNoticeRequired: !!contract.auto_renewal_notice_required,
        autoRenewalNoticeSentAt: contract.auto_renewal_notice_sent_at,
        consentTextVersion: contract.consent_text_version,
        consentTextSnapshot: contract.consent_text_snapshot,
        contractTextSnapshot: contract.contract_text_snapshot,
        esignDisclosureSnapshot: contract.esign_disclosure_snapshot,
        documentTemplateId: contract.document_template_id,
        documentTemplateVersionId: contract.document_template_version_id,
        documentTemplateKey: contract.document_template_key,
        documentTemplateCategory: contract.document_template_category,
        documentTemplateDocumentType: contract.document_template_document_type,
        // Prefer the per-contract requires_signature_snapshot (frozen when the
        // document was sent) over the live template flag, matching
        // contracts.js serialization so historical contracts don't flip if the
        // template's signature requirement later changes.
        requiresSignature: contract.contract_type === 'document_template'
          ? documentRequiresSignature(contract)
          : true,
        documentVariablesSnapshot: contract.document_variables_snapshot || {},
        documentRenderSummary: contract.document_render_summary || {},
        shareTokenExpiresAt: contract.share_token_expires_at,
        sharedAt: contract.shared_at,
        viewedAt: contract.viewed_at,
        signedAt: contract.signed_at,
        signedName: contract.signed_name,
        recipientInitials: contract.recipient_initials,
        signerIp: contract.signer_ip,
        signerUserAgent: contract.signer_user_agent,
        cancelledAt: contract.cancelled_at,
        cancelledReason: contract.cancelled_reason,
        createdAt: contract.created_at,
        updatedAt: contract.updated_at,
        methodType: contract.method_type,
        cardBrand: contract.card_brand,
        lastFour: contract.last_four || contract.bank_last_four,
        bankName: contract.bank_name,
      })),
      annualPrepayTerms: (annualPrepayTerms || []).map(mapAnnualPrepayTerm),
      prepaidPlans: (prepaidPlans || []).map((plan) => ({
        ...plan,
        paidAt: plan.paidAt instanceof Date ? plan.paidAt.toISOString() : plan.paidAt,
        nextVisitDate: dateOnlyForApi(plan.nextVisitDate),
      })),
      photos: signedPhotos,
      notificationPrefs: notificationPrefs || null,
      referralInfo: referralInfo || null,
      complianceRecords: complianceRecords || [],
      nutrientLedger: {
        year: currentYear,
        summary: {
          year: currentYear,
          nApplied: Number(Number(nutrientLedgerSummary?.nApplied || 0).toFixed(3)),
          pApplied: Number(Number(nutrientLedgerSummary?.pApplied || 0).toFixed(3)),
          kApplied: Number(Number(nutrientLedgerSummary?.kApplied || 0).toFixed(3)),
          totalN: Number(Number(nutrientLedgerSummary?.nApplied || 0).toFixed(3)),
          totalP: Number(Number(nutrientLedgerSummary?.pApplied || 0).toFixed(3)),
          totalK: Number(Number(nutrientLedgerSummary?.kApplied || 0).toFixed(3)),
          entries: Number(nutrientLedgerSummary?.entries || 0),
          source: 'property_nutrient_ledger',
        },
        rows: nutrientLedgerRows || [],
      },
      customerDiscounts: customerDiscounts || [],
    };
    res.json(req.techRole === 'technician' ? techSafe360Payload(payload) : payload);
  } catch (err) { next(err); }
});

// POST /api/admin/customers — create
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { firstName, lastName, phone, email, address, addressLine1, addressLine2, city, state, zip, tier, monthlyRate, billingMode, leadSource, pipelineStage, tags, notes, companyName, propertyType, profileLabel, contactRole } = req.body;
    if (!firstName || !phone) return res.status(400).json({ error: 'First name and phone required' });
    const normalizedAddress = normalizeAdminAddressInput({ address, addressLine1, addressLine2, city, state, zip });
    if (normalizedAddress.unitConflict) {
      return res.status(400).json({ error: 'Address unit conflicts with the unit included in Address Line 1' });
    }
    const normalized = {
      firstName: normalizeContactName(cleanText(firstName)),
      lastName: normalizeContactName(cleanText(lastName)),
      phone: normalizeContactPhone(cleanText(phone)),
      email: cleanEmail(email),
      addressLine1: normalizedAddress.addressLine1,
      addressLine2: normalizedAddress.addressLine2,
      city: normalizedAddress.city,
      state: normalizedAddress.state,
      zip: normalizedAddress.zip,
      tier: cleanOptionalText(tier),
      monthlyRate: monthlyRate === '' || monthlyRate === undefined || monthlyRate === null ? 0 : parseFloat(monthlyRate) || 0,
      leadSource: cleanOptionalText(leadSource),
      pipelineStage: cleanText(pipelineStage) || 'new_lead',
      notes: cleanOptionalText(notes),
      companyName: cleanOptionalText(companyName),
      propertyType: cleanOptionalText(propertyType),
      profileLabel: cleanOptionalText(profileLabel),
      contactRole: normalizeContactRole(contactRole),
    };
    if (!normalized.contactRole.ok) return res.status(400).json({ error: 'Invalid contact role' });
    if (!normalized.firstName || !normalized.phone) {
      return res.status(400).json({ error: 'First name and phone required' });
    }
    if (!isValidStage(normalized.pipelineStage)) return res.status(400).json({ error: 'Invalid pipeline stage' });

    // Phone-match confirm flags — parsed exactly like the lead-convert flags
    // in admin-leads.js (#3453): strict `=== true`, admin-only. requireAdmin
    // already guards this route; the predicate keeps the parse shape
    // identical to the tech-collapse pattern there.
    const isAdmin = req.techRole === 'admin';
    const confirmDuplicate = isAdmin && req.body.confirmDuplicate === true;
    const confirmAttach = isAdmin && req.body.confirmAttach === true;
    // "Create a separate account anyway" — reuses findAccountByContact's
    // existing forceNewAccount/ignorePhoneMatch lane (built for lead-convert).
    const forceNewAccount = isAdmin && req.body.forceNewAccount === true;
    const ignorePhoneMatch = isAdmin && req.body.ignorePhoneMatch === true;
    // Binds a confirm flag to the account the 409 displayed (parsed like
    // admin-leads.js's attachToAccountId).
    const confirmMatchedAccountId = isAdmin && typeof req.body.confirmMatchedAccountId === 'string' && req.body.confirmMatchedAccountId.trim()
      ? req.body.confirmMatchedAccountId.trim() : null;
    // Add-Property origin: which profile the admin pressed "Add Property"
    // on — see resolveExplicitAttachTarget.
    const attachToCustomerId = isAdmin && typeof req.body.attachToCustomerId === 'string' && req.body.attachToCustomerId.trim()
      ? req.body.attachToCustomerId.trim() : null;

    // Billing lane at create (#3140 resolution — the inferred-monthly
    // vector): a create with a real membership tier + a positive rate and
    // NO lane used to mint a NULL-mode row the lane resolver infers into
    // monthly_membership — invisible to lane audits and, for a
    // mis-created row, wrongfully dues-charged on the 1st. Callers may now
    // pass an explicit billingMode; absent one, the inference is stamped
    // explicitly (identical billing behavior, but visible and frozen) and
    // a review notification surfaces it for the owner.
    const { BILLING_MODES, impliedMonthlyStampForWrite } = require('../services/billing-lane');
    const explicitBillingMode = (billingMode === undefined || billingMode === null || billingMode === '') ? null : billingMode;
    if (explicitBillingMode) {
      if (!BILLING_MODES.includes(explicitBillingMode)) {
        return res.status(400).json({ error: 'Invalid billing mode' });
      }
      // Same lane prerequisites as the profile editor (PUT /:id): never
      // create a customer in a lane whose visits then complete unbilled.
      if (explicitBillingMode === 'monthly_membership' && !(normalized.monthlyRate > 0)) {
        return res.status(400).json({ error: 'Set a monthly rate before selecting Monthly membership — dues cannot collect at $0' });
      }
      if (explicitBillingMode === 'per_application') {
        return res.status(400).json({ error: 'Per application requires the acceptance-stamped fee — create the customer, then set the fee and lane in the profile editor (or let an estimate acceptance stamp both)' });
      }
      if (explicitBillingMode === 'annual_prepay') {
        return res.status(400).json({ error: 'Annual prepay requires a PAID term covering today — the lane stamps automatically when the annual invoice is paid' });
      }
    }
    const impliedLaneStamp = explicitBillingMode
      ? null
      : impliedMonthlyStampForWrite({}, {
          billing_mode: null,
          waveguard_tier: normalized.tier,
          monthly_rate: normalized.monthlyRate,
        });
    const billingModeForCreate = explicitBillingMode || impliedLaneStamp;

    const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

    const customer = await db.transaction(async (trx) => {
      // fenceAttach (comms-lock try-lock + re-resolve, #3453's lane): a
      // concurrent phone/account edit between lookup and insert fails closed
      // with CUSTOMER_BUSY instead of attaching on stale match data. Safe
      // here because this caller always runs inside db.transaction.
      let account = await ensureCustomerAccount(trx, { ...normalized, forceNewAccount, ignorePhoneMatch, fenceAttach: true });
      account = await resolveExplicitAttachTarget(trx, account, attachToCustomerId, normalized.phone, forceNewAccount);
      await assertPhoneAttachConfirmed(trx, account, { streetLine1: normalized.addressLine1, confirmDuplicate, confirmAttach, confirmMatchedAccountId });
      const siblingCount = await trx('customers').where({ account_id: account.accountId }).whereNull('deleted_at').count('* as count').first();
      const [created] = await trx('customers').insert({
        account_id: account.accountId,
        is_primary_profile: !account.existingCustomer,
        profile_label: normalized.profileLabel || (account.existingCustomer ? 'Rental property' : 'Primary'),
        first_name: normalized.firstName, last_name: normalized.lastName || null, phone: normalized.phone, email: normalized.email,
        address_line1: normalized.addressLine1 || null, address_line2: normalized.addressLine2 || null, city: normalized.city || null, state: normalized.state, zip: normalized.zip || null,
        waveguard_tier: normalized.tier, monthly_rate: normalized.monthlyRate,
        // Explicit lane, or the stamped inference — see the billing-lane
        // block above. NULL only when the row isn't rate-bearing-membered.
        billing_mode: billingModeForCreate,
        // Human-chosen tier at create: 'manual' provenance keeps the
        // auto-tier machinery off it (migration 20260728000001).
        waveguard_tier_source: normalized.tier ? 'manual' : null,
        member_since: etDateString(),
        referral_code: code, lead_source: normalized.leadSource,
        pipeline_stage: normalized.pipelineStage,
        pipeline_stage_changed_at: new Date(),
        assigned_to: req.technicianId,
        company_name: normalized.companyName, property_type: normalized.propertyType, contact_role: normalized.contactRole.value, crm_notes: normalized.notes,
      }).returning('*');

      if (Number(normalized.monthlyRate) > 0) {
        // A rate-bearing customer minted AFTER the one-time ledger backfill
        // must carry attribution from birth (codex #3245 r12) — an
        // unattributed component equal to the rate, so their first gate-on
        // same-family re-quote never reaches the empty-ledger whole-scalar
        // replace. Gate-aware error policy lives in the helper.
        await require('../services/plan-rate-ledger')
          .syncScalarWriteToLedger(trx, created.id, normalized.monthlyRate, { source: 'admin_create' });
      }

      await createDefaultCustomerRows(trx, created.id);

      if (tags?.length) {
        for (const tag of tags) {
          const cleanTag = cleanText(tag);
          if (cleanTag) {
            await trx('customer_tags').insert({ customer_id: created.id, tag: cleanTag }).onConflict(['customer_id', 'tag']).ignore();
          }
        }
      }
      return { ...created, _attachedToExistingAccount: !!account.existingCustomer, _existingCustomer: account.existingCustomer, _propertyCount: Number(siblingCount?.count || 0) + 1 };
    });

    // Intentional fire-and-forget: derived pipeline/score state can lag the
    // create response, and failures should not roll back the durable customer.
    void PipelineManager.onEvent(customer.id, 'lead_created')
      .catch(err => logger.warn(`[customers:${customer.id}] pipeline lead_created failed: ${err.message}`));
    void LeadScorer.calculateScore(customer.id)
      .catch(err => logger.warn(`[customers:${customer.id}] lead score failed: ${err.message}`));
    await auditCustomerMutation(req, 'customer.create', customer.id, {
      fields: ['first_name', 'last_name', 'phone', 'email', 'address', 'tier', 'monthly_rate', 'lead_source', 'pipeline_stage', 'tags', 'billing_mode'],
      // Initial billing lane + provenance (codex #3271 r2): billing_mode is
      // a sensitive audited field on updates, but the create audit omitted
      // it — once the lane later changed, the lane the customer was BORN in
      // (and whether the caller chose it or the stamp inferred it) could not
      // be reconstructed from the audit trail.
      billingMode: billingModeForCreate || null,
      billingModeSource: explicitBillingMode ? 'explicit' : (impliedLaneStamp ? 'inferred' : null),
    });

    // Fire-and-forget geocoding (don't block the create response)
    if (normalized.addressLine1) {
      require('../services/geocoder').ensureCustomerGeocoded(customer.id).catch(() => {});
    }

    if (impliedLaneStamp) {
      // The stamp changed nothing about how the customer bills — the
      // resolver already inferred this lane — but a hand-created monthly
      // member is exactly the shape a mis-keyed duplicate takes, so the
      // owner eyeballs each one before the next dues run (fire-and-forget;
      // never blocks the create).
      try {
        const NotificationService = require('../services/notification-service');
        void NotificationService.notifyAdmin(
          'billing_lane_review',
          `Billing lane stamped: ${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
          `Created with WaveGuard ${normalized.tier} and $${Number(normalized.monthlyRate).toFixed(2)}/mo but no explicit billing lane — stamped monthly_membership (the lane this combination already inferred). Verify before the next dues run; if they actually bill per application, change the lane in the profile.`,
          { icon: '\u{1F4B3}', link: `/admin/customers?customerId=${customer.id}`, bell: true, metadata: { customerId: customer.id, stamped: impliedLaneStamp, source: 'admin_customer_create' } },
        ).catch((err) => logger.warn(`[customers] billing-lane review notify failed for ${customer.id}: ${err.message}`));
      } catch (err) {
        logger.warn(`[customers] billing-lane review notify setup failed for ${customer.id}: ${err.message}`);
      }
    }

    // hasMembership is tier-only, so a one_time create with a real tier
    // passes it — sendMembershipStarted's lane gate suppresses the welcome
    // for the one_time lane (codex #3271 r2: no recurring billing
    // relationship means no "membership is active" email), and the explicit
    // billingLane below is what that gate reads.
    if (hasMembership(normalized)) {
      void AccountMembershipEmail.sendMembershipStarted({
        customerId: customer.id,
        effectiveDate: customer.member_since || new Date(),
        membershipTier: normalized.tier,
        monthlyRate: normalized.monthlyRate,
        billingLane: billingModeForCreate || null,
        sourceId: `admin_customer_create:${customer.id}`,
      }).catch(err => logger.warn(`[customers] membership.started email failed for ${customer.id}: ${err.message}`));
    }

    res.status(201).json({
      id: customer.id,
      referralCode: code,
      accountId: customer.account_id,
      profileLabel: customer.profile_label,
      attachedToExistingAccount: customer._attachedToExistingAccount,
      propertyCount: customer._propertyCount,
      existingCustomerId: customer._existingCustomer?.id || null,
      existingCustomerName: customer._existingCustomer ? `${customer._existingCustomer.first_name} ${customer._existingCustomer.last_name}` : null,
    });
  } catch (err) {
    if (err && (err.code === 'DUPLICATE_PROFILE' || err.code === 'PHONE_MATCH_CONFIRM')) {
      // Same 409 shape as admin-leads.js's convert confirms: the client
      // resubmits with the confirm flag after the admin's explicit choice.
      return res.status(409).json({ error: err.message, code: err.code, match: err.match || null });
    }
    next(err);
  }
});

// PUT /api/admin/customers/:id
router.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const fields = { firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone', profileLabel: 'profile_label', addressLine1: 'address_line1', addressLine2: 'address_line2', city: 'city', state: 'state', zip: 'zip', tier: 'waveguard_tier', monthlyRate: 'monthly_rate', active: 'active', leadSource: 'lead_source', companyName: 'company_name', propertyType: 'property_type', crmNotes: 'crm_notes', nextFollowUpDate: 'next_follow_up_date', followUpNotes: 'follow_up_notes', secondaryPhone: 'secondary_phone', secondaryContactName: 'secondary_contact_name', pipelineStage: 'pipeline_stage', serviceContactName: 'service_contact_name', serviceContactPhone: 'service_contact_phone', serviceContactEmail: 'service_contact_email', serviceContact2Name: 'service_contact2_name', serviceContact2Phone: 'service_contact2_phone', serviceContact2Email: 'service_contact2_email', serviceContact3Name: 'service_contact3_name', serviceContact3Phone: 'service_contact3_phone', serviceContact3Email: 'service_contact3_email', hasLeftGoogleReview: 'has_left_google_review', payerId: 'payer_id', billingMode: 'billing_mode', contactRole: 'contact_role' };
    const before = await db('customers').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!before) return res.status(404).json({ error: 'Customer not found' });
    if (req.body.pipelineStage !== undefined && !isValidStage(req.body.pipelineStage)) {
      return res.status(400).json({ error: 'Invalid pipeline stage' });
    }
    // contact_role: '' / null clears; anything else must be a known role.
    const contactRole = req.body.contactRole !== undefined ? normalizeContactRole(req.body.contactRole) : null;
    if (contactRole && !contactRole.ok) {
      return res.status(400).json({ error: 'Invalid contact role' });
    }
    // Shared by the explicit per-visit prerequisite AND the clear-to-NULL
    // path below: future pending/confirmed visits with no positive price,
    // which complete unbilled in a per-visit lane (completionInvoiceAmount
    // refuses the monthly-rate fallback there). Callbacks, always-free
    // service types, and prepaid-stamped visits are exempt — they complete
    // without an invoice by design in every lane. Errors return [] — fail
    // OPEN (completion logging backstops) rather than hard-locking saves.
    const unpricedFutureBillableVisits = async () => {
      try {
        const { etDateString } = require('../utils/datetime-et');
        const { isAlwaysFreeServiceType } = require('../services/no-cost-visit-types');
        const rows = await db('scheduled_services')
          .where({ customer_id: req.params.id })
          .whereIn('status', ['pending', 'confirmed'])
          .where('scheduled_date', '>=', etDateString())
          .where(function unpriced() {
            this.whereNull('estimated_price').orWhere('estimated_price', '<=', 0);
          })
          .where(function notPrepaid() {
            this.whereNull('prepaid_amount').orWhere('prepaid_amount', '<=', 0);
          })
          .select('id', 'service_type', 'is_callback', 'scheduled_date')
          .orderBy('scheduled_date', 'asc')
          .limit(100);
        return rows.filter((r) => !r.is_callback && !isAlwaysFreeServiceType(r.service_type));
      } catch { return []; }
    };
    if (req.body.billingMode !== undefined && req.body.billingMode !== null && req.body.billingMode !== '') {
      const { BILLING_MODES } = require('../services/billing-lane');
      const mode = req.body.billingMode;
      if (!BILLING_MODES.includes(mode)) {
        return res.status(400).json({ error: 'Invalid billing mode' });
      }
      // Lane prerequisites — a profile save must not move a customer into a
      // lane whose visits then complete unbilled (Codex r1): membership
      // needs a dues rate, per-application needs the acceptance fee, and
      // annual prepay needs a live (paid or pending) coverage term.
      const beforeRow = await db('customers').where({ id: req.params.id }).first('monthly_rate', 'per_application_fee');
      const effectiveRate = req.body.monthlyRate !== undefined
        ? parseFloat(req.body.monthlyRate) || 0
        : parseFloat(beforeRow?.monthly_rate) || 0;
      if (mode === 'monthly_membership' && !(effectiveRate > 0)) {
        return res.status(400).json({ error: 'Set a monthly rate before selecting Monthly membership — dues cannot collect at $0' });
      }
      if (mode === 'per_application' && !(parseFloat(beforeRow?.per_application_fee) > 0)) {
        return res.status(400).json({ error: 'Set a per-application fee before selecting Per application — visits would complete unbilled' });
      }
      if (mode === 'annual_prepay') {
        let liveTerm = null;
        try {
          // payment_pending deliberately does NOT qualify: the annual-prepay
          // service only stamps this lane once the prepay invoice is PAID —
          // pending-window visits must keep billing per application
          // (Codex r2). The term must also COVER TODAY: an expired or
          // future-dated term would park the customer in a lane the cron
          // skips while completion coverage stays false — recurring visits
          // would complete unbilled until someone noticed (Codex r8 P1).
          const { etDateString } = require('../utils/datetime-et');
          const todayEt = etDateString();
          liveTerm = await db('annual_prepay_terms')
            .where({ customer_id: req.params.id })
            .whereIn('status', ['active', 'renewal_pending'])
            .where('term_start', '<=', todayEt)
            .where('term_end', '>=', todayEt)
            .first('id');
        } catch { /* table absent — treat as no live term */ }
        if (!liveTerm) {
          return res.status(400).json({ error: 'Annual prepay requires a PAID term covering today — the lane stamps automatically when the annual invoice is paid' });
        }
      }
      if (mode === 'per_visit' || mode === 'one_time') {
        // These lanes bill each visit's OWN price, so a future visit
        // without a positive price completes uninvoiced with only a log
        // line. Same "would complete unbilled" prerequisite as the other
        // lanes (Codex r6) — see unpricedFutureBillableVisits above.
        const billable = await unpricedFutureBillableVisits();
        if (billable.length > 0) {
          const laneLabel = mode === 'one_time' ? 'One-time' : 'Per visit';
          const plural = billable.length !== 1;
          return res.status(400).json({
            error: `${laneLabel} bills each visit's own price — ${billable.length} upcoming visit${plural ? 's' : ''} (first ${billable[0].scheduled_date}) ${plural ? 'have' : 'has'} no price and would complete unbilled. Price or cancel ${plural ? 'them' : 'it'} before switching.`,
          });
        }
      }
    } else if (req.body.billingMode !== undefined) {
      // Clearing the selector to "Not set" re-enters legacy inference — a
      // tier-less or sentinel-tier customer with a lingering rate RESOLVES
      // per_visit, and completion refuses the monthly-rate fallback for
      // that lane, so the same unpriced-visit guard applies to the clear
      // (Codex r10). Resolve against the EFFECTIVE tier/rate this same
      // save produces (tier and monthlyRate may change in the same PUT).
      const { resolveBillingLane } = require('../services/billing-lane');
      const effectiveTier = req.body.tier !== undefined ? req.body.tier : before.waveguard_tier;
      const effectiveRateForClear = req.body.monthlyRate !== undefined
        ? (req.body.monthlyRate === '' ? 0 : parseFloat(req.body.monthlyRate) || 0)
        : (parseFloat(before.monthly_rate) || 0);
      const resolvedOnClear = resolveBillingLane({
        billing_mode: null, waveguard_tier: effectiveTier, monthly_rate: effectiveRateForClear,
      });
      if (resolvedOnClear.mode !== 'monthly_membership') {
        const billable = await unpricedFutureBillableVisits();
        if (billable.length > 0) {
          const plural = billable.length !== 1;
          return res.status(400).json({
            error: `Not set resolves this customer to per-visit billing — ${billable.length} upcoming visit${plural ? 's' : ''} (first ${billable[0].scheduled_date}) ${plural ? 'have' : 'has'} no price and would complete unbilled. Price or cancel ${plural ? 'them' : 'it'}, or pick an explicit lane.`,
          });
        }
      }
    }
    const updates = {};
    for (const [k, v] of Object.entries(fields)) {
      if (req.body[k] !== undefined) {
        // Handle empty strings for numeric/date fields
        if (v === 'waveguard_tier') {
          updates[v] = req.body[k];
          // A human set (or cleared) the tier: record 'manual' provenance so
          // the auto-tier machinery (GATE_AUTO_WAVEGUARD_TIER realignment +
          // label-only messaging suppression) never treats an admin-chosen
          // tier as a derived label it may move. Clearing the tier clears
          // provenance with it. Ships with migration 20260728000001.
          updates.waveguard_tier_source = req.body[k] ? 'manual' : null;
        }
        else if (v === 'monthly_rate') { updates[v] = req.body[k] === '' ? 0 : parseFloat(req.body[k]) || 0; }
        else if (v === 'next_follow_up_date') { updates[v] = req.body[k] || null; }
        else if (v === 'has_left_google_review') { updates[v] = !!req.body[k]; }
        else if (v === 'payer_id') { updates[v] = (req.body[k] === '' || req.body[k] == null) ? null : (parseInt(req.body[k], 10) || null); }
        else if (v === 'billing_mode') { updates[v] = (req.body[k] === '' || req.body[k] == null) ? null : req.body[k]; }
        else if (v === 'contact_role') { updates[v] = contactRole.value; }
        else if (v === 'email') { updates[v] = cleanEmail(req.body[k]); }
        else if (v === 'phone') { updates[v] = cleanText(req.body[k]); }
        else if (v === 'last_name') { updates[v] = cleanOptionalText(req.body[k]); }
        else if (v === 'state') { updates[v] = cleanOptionalState(req.body[k]); }
        else if (v === 'address_line2') { updates[v] = normalizeUnitLine(cleanText(req.body[k])) || null; }
        else { updates[v] = req.body[k]; }
      }
    }
    // Proper-case names, E.164 phone, abbreviated/clean street, title-case city,
    // 5-digit zip on edits too — same canonical formatting as customer creation,
    // and applied before the cross-account conflict check so dedup compares the
    // stored format.
    Object.assign(updates, normalizeContactRecord(updates));
    if (req.body.addressLine1 !== undefined || req.body.addressLine2 !== undefined) {
      const normalizedAddress = normalizeAdminAddressInput({
        addressLine1: req.body.addressLine1 !== undefined ? req.body.addressLine1 : before.address_line1,
        addressLine2: req.body.addressLine2 !== undefined ? req.body.addressLine2 : before.address_line2,
        city: req.body.city !== undefined ? req.body.city : before.city,
        state: req.body.state !== undefined ? req.body.state : before.state,
        zip: req.body.zip !== undefined ? req.body.zip : before.zip,
      });
      if (normalizedAddress.unitConflict) {
        return res.status(400).json({ error: 'Address unit conflicts with the unit included in Address Line 1' });
      }
      // Rewrite both street fields together so agreeing inline/dedicated units
      // collapse to one canonical representation and can never drift apart.
      updates.address_line1 = normalizedAddress.addressLine1 || null;
      updates.address_line2 = normalizedAddress.addressLine2;
    }
    // Stamp when the review flag flips so admins can see who/when later.
    if (updates.has_left_google_review !== undefined) {
      updates.review_marked_at = updates.has_left_google_review ? new Date() : null;
    }
    if (updates.pipeline_stage !== undefined && updates.pipeline_stage !== before.pipeline_stage) {
      // Same lifecycle stamps as PUT /:id/stage — Customers 360 saves stage
      // edits through this endpoint, so member_since/churned_at must be kept here
      // too. (member_since/churned_at aren't editable fields, so no clobber.)
      Object.assign(updates, stageLifecycleStamps(before.pipeline_stage, updates.pipeline_stage, before, { today: etDateString(), churnReason: req.body.churnReason }));
    }
    compactServiceContactSlots(updates, before);
    // If the primary phone is changing, drop the stale line_type cache so the
    // SMS landline guard re-evaluates the new number instead of acting on the
    // old number's marker.
    clearLineTypeOnPhoneChange(updates, before);
    // Close the inferred-monthly vector (#3140 resolution): a save that
    // TRANSITIONS the row into (NULL lane + real membership tier + positive
    // rate) mints an implicit monthly member the lane audits can't see —
    // the shape that wrongfully queued a mis-created duplicate for dues.
    // Stamp the inference explicitly in the SAME write (identical billing
    // behavior — the resolver already infers monthly_membership) and
    // surface a review notification after commit. A save carrying an
    // explicit billingMode (even a clear-to-NULL, which the guard above
    // already vetted) is the operator's own lane decision — never restamp.
    // The decision itself is made UNDER the row lock inside the
    // transaction below (pre-push codex P0): deciding from the
    // pre-transaction snapshot could overwrite an explicit lane a
    // concurrent save committed between our read and the lock.
    let impliedLaneStamp = null;
    // Locked pre-save snapshot, hoisted for the post-commit contact audit:
    // the timeline diff must describe the actual DB transition, and the
    // pre-lock `before` can be stale if a concurrent edit committed first.
    // (The audit only fires when slot fields are in `updates`, which
    // guarantees the locking transaction below ran and reassigned this.)
    let contactAuditBefore = before;
    let contactAuditAt = null;
    const laneStampEligible = req.body.billingMode === undefined && updates.billing_mode === undefined;
    if (Object.keys(updates).length) {
      const contactConflict = await findCrossAccountContactConflict(
        req.params.id,
        before.account_id || before.id,
        updates
      );
      if (contactConflict) {
        const c = contactConflict.customer;
        return res.status(409).json({
          error: 'contact_exists_on_another_account',
          field: contactConflict.field,
          message: `That ${contactConflict.field} is already used by ${c.first_name || ''} ${c.last_name || ''}`.trim(),
          existingCustomerId: c.id,
        });
      }

      const sensitiveFields = SENSITIVE_CUSTOMER_FIELDS;
      const changed = Object.keys(updates).filter(field => before && before[field] !== updates[field]);
      const after = { ...before, ...updates };
      // PRESENCE-triggered, not diff-triggered — matching the IB update path
      // (and the geocode block below): resaving an unchanged address must
      // still self-heal a primary-property mirror or lead/estimate snapshot
      // left stale by a pre-fix edit; both sync helpers are idempotent.
      const addressChanged = ['address_line1', 'address_line2', 'city', 'state', 'zip']
        .some((f) => updates[f] !== undefined);
      // Phase 1 multi-property: an admin address edit must reach the primary
      // customer_properties row too — ATOMICALLY, so a unique address-index
      // collision rolls back the customer edit (and surfaces a 409) instead of
      // leaving customers.address_* and the property's dedup key desynced. NOT
      // gated on GATE_CUSTOMER_PROPERTIES: the table is migration-backfilled
      // regardless of the flag; syncPrimaryAddress is a no-op when no primary
      // row exists.
      let emailSync = null;
      try {
        await db.transaction(async (trx) => {
          // Membership-affecting edits participate in the customer-comms
          // serialization (codex #3426 r4 P2): the previsit backstop sweep
          // holds `customer-comms:<id>` through its membership recheck AND
          // the SMS dispatch, so a tier/rate write that makes this customer
          // a plan member either commits before the sweep's in-lock recheck
          // reads (and excludes them) or waits until after the send. Rung-6
          // ordering: BEFORE the customers row lock below (customer-comms-
          // lock.js contract — revertMerge takes comms first, then
          // FOR-UPDATEs rows; row-lock-first-then-wait-here would deadlock).
          if (updates.waveguard_tier !== undefined || updates.monthly_rate !== undefined) {
            await lockCustomerComms(trx, req.params.id);
          }
          // Combined-session lock BEFORE the customer row lock (codex #3427
          // r16 P1): /setup acquires pay.combined.customer and then reads/
          // writes customer state on other connections — taking the row
          // lock first here and waiting on the advisory lock inside the
          // release helper forms an application-level deadlock PostgreSQL
          // can't fully see. Advisory-then-rows puts both paths in one
          // order (comms → combined → rows here); the later release call
          // re-acquires re-entrantly.
          if (updates.payer_id) {
            await require('../services/pay-combined').lockCombinedCustomers(trx, [String(req.params.id)]);
          }
          // Serialize overlapping address edits on the same customer: the row
          // lock makes a second editor WAIT, and before/after are re-derived
          // from the locked row — a pre-transaction 'before' from the losing
          // editor would no longer match snapshots the first edit already
          // moved, stranding them.
          const lockedBefore = await trx('customers').where({ id: req.params.id }).forUpdate().first() || before;
          contactAuditBefore = lockedBefore;
          contactAuditAt = new Date();
          // Implied-monthly stamp (#3140), decided from the LOCKED row: only
          // when this lane-less save still transitions the locked state into
          // the inferred-monthly shape — a concurrent explicit lane
          // committed before our lock leaves billing_mode set and the stamp
          // off. Mutating `updates` here also rides into lockedAfter and the
          // UPDATE below; `changed`/`after` are patched post-commit.
          if (laneStampEligible) {
            const { impliedMonthlyStampForWrite } = require('../services/billing-lane');
            impliedLaneStamp = impliedMonthlyStampForWrite(lockedBefore, { ...lockedBefore, ...updates });
            if (impliedLaneStamp) updates.billing_mode = impliedLaneStamp;
          }
          const lockedAfter = { ...lockedBefore, ...updates };
          // Assigning an email serializes against a customer-merge UNDO
          // checking whether that address is claimed (customer-dedupe.js
          // revertMerge — customers.email has NO unique constraint, so only
          // this shared lock keeps the check honest between its read and
          // its commit). KEY DERIVATION (must stay byte-identical to
          // customer-dedupe.js and intelligence-bar/tools.js — extend ALL
          // in the same commit): pg_advisory_xact_lock(hashtextextended(
          //   'customer-email:' || lower(trim(<email>)), 0)).
          if (updates.email) {
            const emailLc = String(updates.email).trim().toLowerCase();
            await trx.raw(
              'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
              [`customer-email:${emailLc}`],
            );
            // Serialization ONLY — deliberately NO claimant refusal (r23):
            // customers.email is intentionally non-unique (migration
            // 20260417000010 dropped the constraint so spouses and shared
            // household/business addresses work), so an operator assigning
            // a shared address is a SUPPORTED act, not a conflict. What
            // the undo needs is exactly this lock: its own claim probe
            // runs under the same key, so an assignment either commits
            // before the undo (and its probe sees it) or waits its turn.
            // The automated-intake guard keeps its drop-the-email posture
            // — unauthenticated input never gets to claim a live
            // customer's mailbox; an operator can.
          }
          // Assigning a DEFAULT payer must first release any unconfirmed
          // combined pay-page session on this customer's invoices (codex
          // #3427 r8 P1, same fence as the scheduled-service payer writer):
          // live payer resolution reads this column, and the browser can
          // confirm a combined ACH PI with no later server seam. Fail-closed
          // — an unreleasable session aborts this transaction.
          if (updates.payer_id !== undefined && updates.payer_id) {
            const payerRelease = await require('../services/pay-combined')
              .releaseUnconfirmedCombinedSessionsForCustomer(trx, req.params.id);
            // In-flight combined money DEFERS the payer edit (codex r30
            // P1, same contract as the merge fence): the eventual combined
            // settlement never re-resolves ownership, so committing now
            // would settle the homeowner's authorized debit against debt
            // this edit says belongs to third-party AP.
            if (payerRelease.inFlight > 0) {
              throw new Error('A combined bank payment for this customer is still in flight — retry the payer change after it settles or fails');
            }
          }
          await trx('customers').where({ id: req.params.id }).update(updates);
          // Only an ACTUAL rate change invalidates the attribution (codex
          // #3245 r4): the directory editor posts the whole form on every
          // save, so a presence check would wipe the seeded components on a
          // routine name/phone/stage edit and leave one unattributed blob.
          const rateActuallyChanged = updates.monthly_rate !== undefined
            && Math.round((Number(lockedBefore?.monthly_rate) || 0) * 100)
              !== Math.round((Number(updates.monthly_rate) || 0) * 100);
          if (rateActuallyChanged) {
            // A blind admin rate edit invalidates any finer per-family
            // attribution — reset the plan-rate ledger to a single
            // unattributed component matching the new scalar (cleared when
            // the rate is zeroed). Gate-aware error policy lives in the
            // helper (codex #3245 r2): advisory failures warn; failures
            // while the ledger has scalar authority FAIL the edit, because
            // committing a new scalar over stale authoritative components
            // would let the next accept resurrect the old sum.
            await require('../services/plan-rate-ledger')
              .syncScalarWriteToLedger(trx, req.params.id, updates.monthly_rate, { source: 'admin_edit' });
          }
          if (addressChanged) {
            await require('../services/customer-properties').syncPrimaryAddress(lockedAfter, trx);
            // Open leads/estimates snapshot the address at creation and never
            // re-read customers.* — sync the copies that still match the old
            // address (matching rules in the fan-out service header).
            await require('../services/customer-address-fanout').propagateCustomerAddressChange({ before: lockedBefore, after: lockedAfter }, trx);
          }
          if (updates.email !== undefined) {
            // Email has the same snapshot problem (leads.email,
            // estimates.customer_email, the newsletter subscription), and a
            // CHANGED email also answers any open email read-back card for
            // this customer's calls. Diff-gated inside the service — an
            // unchanged resave is a no-op, so an incidental full-form save
            // never resolves a review card by accident.
            emailSync = await require('../services/customer-email-fanout').propagateCustomerEmailChange(
              { before: lockedBefore, after: lockedAfter, source: 'Customer 360 edit' }, trx
            );
          }
          // Name and phone have the same snapshot problem (leads, estimates,
          // contracts, promoter, booking recovery, automation greetings) —
          // both diff-gated inside the service, so an unchanged full-form
          // resave is a no-op.
          if (updates.first_name !== undefined || updates.last_name !== undefined) {
            await require('../services/customer-contact-fanout').propagateCustomerNameChange(
              { before: lockedBefore, after: lockedAfter }, trx
            );
          }
          if (updates.phone !== undefined) {
            await require('../services/customer-contact-fanout').propagateCustomerPhoneChange(
              { before: lockedBefore, after: lockedAfter }, trx
            );
          }
        });
      } catch (e) {
        if (e && e.code === '23505') {
          return res.status(409).json({
            error: 'address_matches_existing_property',
            message: 'That address already exists as another property on this customer.',
          });
        }
        return next(e);
      }
      if (impliedLaneStamp && !changed.includes('billing_mode')) {
        // The stamp was decided under the lock, after `changed`/`after`
        // were snapshotted — patch both so the sensitive audit records the
        // lane write and the membership-email logic sees the real outcome.
        changed.push('billing_mode');
        after.billing_mode = impliedLaneStamp;
      }
      if (emailSync?.heldNewsletterResume) {
        // Deferred held-newsletter DOI (2026-07-30 lane) — execute now that
        // the edit committed. Fire-and-forget WITH an owner (Codex #3084
        // r47): the helper catches its own failures by contract, but an
        // unexpected escape must land in a logged rejection handler, never
        // an unhandled rejection. Sanitized code only.
        require('../services/lead-first-touch-resume').resumeHeldNewsletterPostCommit(emailSync.heldNewsletterResume)
          .catch((err) => logger.error(`[customers] deferred held-newsletter resume failed: ${err.code || err.name || 'resume_failed'}`));
      }
      if (emailSync?.pendingConfirmation) {
        // The moved DOI row's confirmation went to the old typo — re-send to
        // the corrected address now that the edit is committed (same
        // fire-and-forget-with-owner contract, r47).
        require('../services/customer-email-fanout').resendPendingConfirmation(emailSync.pendingConfirmation)
          .catch((err) => logger.error(`[customers] deferred DOI re-send failed: ${err.code || err.name || 'resend_failed'}`));
      }
      if (changed.some(field => sensitiveFields.includes(field))) {
        await auditCustomerMutation(req, 'customer.update_sensitive', req.params.id, {
          fields: changed,
          sensitiveFieldsChanged: changed.filter(field => sensitiveFields.includes(field)),
        }, true);
      }
      if (impliedLaneStamp) {
        // Post-commit review card for the auto-stamped lane (see the stamp
        // block above) — fire-and-forget, never blocks the save.
        try {
          const NotificationService = require('../services/notification-service');
          void NotificationService.notifyAdmin(
            'billing_lane_review',
            `Billing lane stamped: ${before.first_name || ''} ${before.last_name || ''}`.trim(),
            `A profile edit left this customer with a WaveGuard tier and a positive monthly rate but no explicit billing lane — stamped monthly_membership (the lane this combination already inferred). Verify before the next dues run; if they actually bill per application, change the lane in the profile.`,
            { icon: '\u{1F4B3}', link: `/admin/customers?customerId=${req.params.id}`, bell: true, metadata: { customerId: req.params.id, stamped: impliedLaneStamp, source: 'admin_customer_update' } },
          ).catch((err) => logger.warn(`[customers] billing-lane review notify failed for ${req.params.id}: ${err.message}`));
        } catch (err) {
          logger.warn(`[customers] billing-lane review notify setup failed for ${req.params.id}: ${err.message}`);
        }
      }
      // EFFECTIVE membership for lifecycle emails: an auto-derived tier
      // LABEL (waveguard_tier_source = 'auto', no positive rate, label-only
      // lane) is not a membership the customer knows about — deactivating,
      // reactivating, or clearing it must not send membership.canceled /
      // reactivated / started emails (Codex #3011 r8 P1: the tier stamp is
      // contractually comms-silent). A label that transitions to a REAL
      // membership in this same save (rate/lane set) correctly counts as a
      // membership start, because the label side evaluates to non-member.
      const { isAutoDerivedTierLabelRow } = require('../services/self-booking-plan-sync');
      const beforeHasMembership = hasMembership(before) && !isAutoDerivedTierLabelRow(before);
      const afterHasMembership = hasMembership(after) && !isAutoDerivedTierLabelRow(after);
      const membershipFieldChanged = membershipDetailsChanged(before, after);
      const membershipEventAt = new Date();
      if (updates.active === false && before.active !== false && beforeHasMembership) {
        void AccountMembershipEmail.sendMembershipCanceled({
          customerId: req.params.id,
          effectiveDate: membershipEventAt,
          reason: req.body.churnReason || 'Account deactivated',
          membershipTier: before.waveguard_tier,
          monthlyRate: before.monthly_rate,
          idempotencyKey: adminMembershipDailyIdempotencyKey('membership.canceled', req.params.id, 'admin', membershipEventAt),
        }).catch(err => logger.warn(`[customers] membership.canceled email failed for ${req.params.id}: ${err.message}`));
      } else if (updates.active === true && before.active === false && afterHasMembership) {
        void AccountMembershipEmail.sendMembershipReactivated({
          customerId: req.params.id,
          effectiveDate: membershipEventAt,
          idempotencyKey: adminMembershipDailyIdempotencyKey('membership.reactivated', req.params.id, 'admin', membershipEventAt),
        }).catch(err => logger.warn(`[customers] membership.reactivated email failed for ${req.params.id}: ${err.message}`));
      } else if (!beforeHasMembership && afterHasMembership) {
        // Effective-membership transition alone is the trigger (Codex #3011
        // r9): a label becoming a REAL membership can happen WITHOUT the
        // tier/rate fields changing — re-saving the same tier flips
        // provenance to 'manual', or an established billing lane is selected
        // — and membershipDetailsChanged compares only tier and rate.
        void AccountMembershipEmail.sendMembershipStarted({
          customerId: req.params.id,
          effectiveDate: membershipEventAt,
          membershipTier: after.waveguard_tier,
          monthlyRate: after.monthly_rate,
          // Explicit lane from this save's own outcome — the send is
          // fire-and-forget, so the row-fallback could race a concurrent
          // edit; null rides the resolver fallback (#3140).
          billingLane: after.billing_mode || null,
          sourceId: `admin_membership_start:${req.params.id}:${etDateString(membershipEventAt)}`,
          idempotencyKey: adminMembershipStartIdempotencyKey(req.params.id, before, after, membershipEventAt),
        }).catch(err => logger.warn(`[customers] membership.started email failed for ${req.params.id}: ${err.message}`));
      } else if (beforeHasMembership && !afterHasMembership) {
        void AccountMembershipEmail.sendMembershipCanceled({
          customerId: req.params.id,
          effectiveDate: membershipEventAt,
          reason: 'Membership removed',
          membershipTier: before.waveguard_tier,
          monthlyRate: before.monthly_rate,
          idempotencyKey: adminMembershipDailyIdempotencyKey('membership.canceled', req.params.id, 'admin_membership_removed', membershipEventAt),
        }).catch(err => logger.warn(`[customers] membership.canceled email failed for ${req.params.id}: ${err.message}`));
      } else if (membershipFieldChanged && afterHasMembership) {
        void AccountMembershipEmail.sendMembershipUpdated({
          customerId: req.params.id,
          before,
          after,
          effectiveDate: membershipEventAt,
        }).catch(err => logger.warn(`[customers] membership.updated email failed for ${req.params.id}: ${err.message}`));
      }
    }

    // If address changed, re-geocode (clear lat/lng first so ensureCustomerGeocoded refreshes)
    const addressChanged = ['address_line1', 'city', 'state', 'zip'].some(f => updates[f] !== undefined);
    if (addressChanged) {
      await db('customers').where({ id: req.params.id }).update({ latitude: null, longitude: null });
      // Re-geocode the customer, then mirror the fresh coords onto the primary
      // property — syncPrimaryAddress cleared them on the address edit, so without
      // this the property row would stay permanently null after every address edit.
      void require('../services/geocoder').ensureCustomerGeocoded(req.params.id)
        .then((coords) => coords && require('../services/customer-properties').syncPrimaryCoordsFromCustomer(req.params.id))
        .catch(() => {});
    }

    // Fire-and-forget: trigger cancellation save when deactivating a customer
    if (updates.active === false) {
      try {
        const cancellationSave = require('../services/workflows/cancellation-save');
        if (cancellationSave.initiate) {
          cancellationSave.initiate(req.params.id, 'default').catch(err =>
            logger.error(`[customers] Cancellation save on deactivation failed: ${err.message}`)
          );
        }
      } catch (err) {
        logger.error(`[customers] Cancellation save require failed: ${err.message}`);
      }
    }

    // Contact change events for the 360 timeline — post-commit, best-effort
    // (the recorder never throws). Compaction above puts every slot column in
    // `updates` whenever any contact field was touched, so merging `updates`
    // over the locked pre-save row is the full post-save slot state, and
    // diffing against that same locked row records the actual DB transition
    // even when a concurrent edit committed between the pre-lock `before`
    // read and this save's lock.
    if (SERVICE_CONTACT_SLOT_FIELDS.flat().some((field) => field in updates)) {
      const { recordServiceContactChanges } = require('../services/service-contact-events');
      // Awaited: the recorder never throws (a failure only warns), so this
      // cannot fail the save — it just guarantees the event row is committed
      // before the save reports done.
      await recordServiceContactChanges({
        customerId: req.params.id,
        before: contactAuditBefore,
        after: { ...contactAuditBefore, ...updates },
        source: 'admin',
        adminUserId: req.technicianId || null,
        occurredAt: contactAuditAt,
      });
    }

    res.json({ success: true });
  } catch (err) {
    if (err.message?.includes('customers_email_unique') || err.message?.includes('duplicate key')) {
      return res.status(400).json({ error: 'That email is already in use by another customer.' });
    }
    next(err);
  }
});

// PUT /api/admin/customers/:id/notification-prefs
//
// Admin override for a customer's notification_prefs row. Keep this narrow:
// ops needs auto-flip control and recipient-routing fields for landlord /
// tenant / AP-contact workflows.
//
// Creates the prefs row if it doesn't exist (defaults to all TRUE).
router.put('/:id/notification-prefs', requireAdmin, async (req, res, next) => {
  try {
    const existing = await db('notification_prefs')
      .where({ customer_id: req.params.id })
      .first();
    const { dbUpdates, error } = adminNotificationPrefsDbUpdates(req.body, existing || {});
    if (error) {
      return res.status(400).json({ error });
    }
    if (Object.keys(dbUpdates).length === 0) {
      return res.status(400).json({ error: 'No supported fields provided.' });
    }
    dbUpdates.updated_at = new Date();

    if (existing) {
      await db('notification_prefs')
        .where({ customer_id: req.params.id })
        .update(dbUpdates);
    } else {
      // Create through the canonical helper (marketing flags NULL), then
      // apply exactly the admin-named fields — a bare insert would take the
      // legacy true defaults and mint marketing consent as a side effect.
      await createDefaultCustomerRows(db, req.params.id);
      await db('notification_prefs')
        .where({ customer_id: req.params.id })
        .update(dbUpdates);
    }

    const prefs = await db('notification_prefs')
      .where({ customer_id: req.params.id })
      .first();
    const loggedFields = Object.keys(dbUpdates)
      .filter((field) => field !== 'updated_at')
      .sort();
    logger.info(`[customers] notification_prefs updated for ${req.params.id}: ${JSON.stringify({ fields: loggedFields })}`);
    res.json({ success: true, notificationPrefs: prefs });
  } catch (err) { next(err); }
});

// PUT /api/admin/customers/:id/stage
router.put('/:id/stage', requireAdmin, async (req, res, next) => {
  try {
    const { stage, notes } = req.body;
    if (!isValidStage(stage)) return res.status(400).json({ error: 'Invalid pipeline stage' });
    const customer = await db('customers').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const oldStage = customer.pipeline_stage;
    const stageUpdates = {
      pipeline_stage: stage,
      ...stageLifecycleStamps(oldStage, stage, customer, { today: etDateString(), churnReason: req.body.churnReason }),
    };
    await db('customers').where({ id: req.params.id }).update(stageUpdates);
    await db('customer_interactions').insert({
      customer_id: req.params.id, interaction_type: 'note',
      subject: `Stage changed: ${oldStage} → ${stage}`,
      body: notes || '', admin_user_id: req.technicianId,
    });

    // Fire-and-forget: trigger cancellation save workflow when moving to churned or at_risk
    if (stage === 'churned' || (stage === 'at_risk' && oldStage !== 'at_risk')) {
      try {
        const cancellationSave = require('../services/workflows/cancellation-save');
        if (cancellationSave.initiate) {
          const cancelReason = req.body.churnReason || 'default';
          cancellationSave.initiate(req.params.id, cancelReason).catch(err =>
            logger.error(`[customers] Cancellation save failed: ${err.message}`)
          );
        }
      } catch (err) {
        logger.error(`[customers] Cancellation save require failed: ${err.message}`);
      }
    }

    // Fire-and-forget: update health score on stage change
    try {
      const customerHealth = require('../services/customer-health');
      if (customerHealth.scoreCustomer) {
        customerHealth.scoreCustomer(req.params.id).catch(err =>
          logger.error(`[customers] Health score update on stage change failed: ${err.message}`)
        );
      }
    } catch (err) {
      logger.error(`[customers] Customer health require failed: ${err.message}`);
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

/**
 * POST /api/admin/customers/:id/resume-service — clear a billing pause.
 *
 * billing-cron sets customers.service_paused_at + service_pause_reason when
 * autopay's 3-retry ladder exhausts, and the monthly cron then skips that
 * customer (.whereNull('service_paused_at')). Migration 20260418000002
 * described an admin action to unset it — that action was never built, so
 * the pause was permanent: dues stopped for good even after the customer
 * paid and fixed their card, and the only remedy was a hand-edited row.
 *
 * Resuming does NOT bill arrears. processMonthlyBilling charges only on the
 * customer's billing_day (isBillingDayMatch) and skips anyone already
 * charged for the current month key, so a customer paused for three months
 * is charged exactly once, on their next billing day. The unpaid obligation
 * from the original failure stays where it is — dunning owns that, not this.
 *
 * Deliberately manual: no automatic resume-on-payment. Whether a payment
 * should silently restart recurring billing is an owner policy call, not a
 * default this endpoint gets to make.
 *
 * Scope: this clears the pause and says NOTHING about whether dues will now
 * collect. An earlier revision returned a `blockers` array enumerating the
 * cron's other guards (autopay, lane, annual-prepay coverage...). That was a
 * second implementation of processMonthlyBilling's guard chain, and review
 * found a further missed guard on three consecutive rounds — evidence about
 * the approach, not just the code. The response no longer claims anything
 * about future collection, so it cannot be wrong about it; the cron's own
 * autopay_log skip reasons remain the authority on why a customer was not
 * charged.
 */
router.post('/:id/resume-service', requireAdmin, async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Idempotent: clicking twice, or racing another admin, is a no-op rather
    // than a spurious audit entry.
    if (!customer.service_paused_at) {
      return res.json({ success: true, resumed: false, reason: 'not_paused', servicePausedAt: null });
    }

    const pausedAt = customer.service_paused_at;
    const pauseReason = customer.service_pause_reason || null;
    // ET, not UTC: toISOString() would file a pause applied at 8pm ET on the
    // FOLLOWING business day, and this date is what the audit trail and the
    // UI both read.
    const pausedSince = etDateString(new Date(pausedAt));

    // Clear the state and write its audit trail atomically. A money-affecting
    // admin action that succeeds with no durable record is worse than one
    // that fails loudly, so a failed insert rolls the resume back rather than
    // being swallowed.
    const resumed = await db.transaction(async (trx) => {
      // Compare-and-swap on THIS pause, not merely "some pause": billing-cron
      // runs on its own schedule, so between the SELECT above and this UPDATE
      // the original pause can be cleared and a NEWER failure applied. A
      // whereNotNull guard would silently wipe that new pause and quietly put
      // a customer with a dead card back into the billing run.
      const cleared = await trx('customers')
        .where({ id: req.params.id, service_paused_at: pausedAt })
        .whereNull('deleted_at')
        .update({ service_paused_at: null, service_pause_reason: null });
      if (!cleared) return false;

      await trx('customer_interactions').insert({
        customer_id: req.params.id,
        interaction_type: 'note',
        subject: 'Billing pause cleared',
        body: `Billing pause cleared (paused ${pausedSince}${pauseReason ? `, reason: ${pauseReason}` : ''}). `
          + 'This removes the pause block only — other billing guards (autopay state, '
          + 'plan type, prepaid coverage) still apply. The paused months are not back-billed.',
        admin_user_id: req.technicianId,
      });

      await recordAuditEvent({
        actor_type: 'admin',
        actor_id: req.technicianId || null,
        action: 'customer.billing_pause_cleared',
        resource_type: 'customer',
        resource_id: req.params.id,
        metadata: { paused_since: pausedSince, pause_reason: pauseReason },
        critical: true,
        trx,
      });

      return true;
    });

    if (!resumed) {
      // Either another admin got there first, or billing-cron re-paused this
      // customer. Both mean "the pause you saw is gone" — re-read before
      // acting again.
      return res.json({ success: true, resumed: false, reason: 'pause_changed' });
    }

    logger.info(`[customers] Billing pause cleared for customer ${req.params.id} (was paused ${pausedSince}, reason ${pauseReason || 'none'})`);

    res.json({ success: true, resumed: true, pausedSince, pauseReason, servicePausedAt: null });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/:id/tags
router.post('/:id/tags', requireAdmin, async (req, res, next) => {
  try {
    await db('customer_tags').insert({ customer_id: req.params.id, tag: req.body.tag }).onConflict(['customer_id', 'tag']).ignore();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/admin/customers/:id/tags/:tag
router.delete('/:id/tags/:tag', requireAdmin, async (req, res, next) => {
  try {
    await db('customer_tags').where({ customer_id: req.params.id, tag: req.params.tag }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/:id/interactions
router.post('/:id/interactions', requireAdmin, async (req, res, next) => {
  try {
    const { type, subject, body } = req.body;
    await db('customer_interactions').insert({
      customer_id: req.params.id, interaction_type: type || 'note',
      subject, body, admin_user_id: req.technicianId,
    });
    await db('customers').where({ id: req.params.id }).update({ last_contact_date: new Date(), last_contact_type: type || 'note' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/:id/follow-up
router.post('/:id/follow-up', requireAdmin, async (req, res, next) => {
  try {
    await db('customers').where({ id: req.params.id }).update({
      next_follow_up_date: req.body.date, follow_up_notes: req.body.notes,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/admin/customers/:id — soft-delete a customer
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Archive + newsletter relink + critical audit are one transaction: the
    // subscriber link must move to the live same-email twin (if any) in the
    // same commit that sets deleted_at, or the sender's archived-customer
    // anti-join silences the household between the two writes.
    // Keyed on the archived customer_id, not on customer.email: a subscriber's
    // stored email is a signup-time snapshot that may no longer match the
    // customer's current email, and those rows must move too (each to the
    // twin of its OWN email).
    const { relinkSubscribersFromArchivedCustomer } = require('../services/newsletter-subscribers');
    const relink = await db.transaction(async (trx) => {
      await trx('customers').where({ id: req.params.id }).update({ deleted_at: new Date() });
      const result = await relinkSubscribersFromArchivedCustomer(trx, req.params.id);
      await auditCustomerMutation(req, 'customer.archive', req.params.id, {
        previousDeletedAt: customer.deleted_at || null,
        newsletterRelinked: result.relinked,
      }, true, trx);
      return result;
    });
    logger.info(`[customers] Soft-deleted customer id=${req.params.id}` + (relink.relinked ? ` (newsletter subscribers relinked: ${relink.relinked})` : ''));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PATCH /api/admin/customers/:id/restore — restore a soft-deleted customer (admin only)
router.patch('/:id/restore', requireAdmin, async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.id }).whereNotNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found or not deleted' });

    // Symmetric to archive: restore clears deleted_at AND re-runs the
    // newsletter twin picker for this email in the same transaction, so a
    // restored primary profile takes its subscriber links back.
    const { relinkSubscribersForEmail } = require('../services/newsletter-subscribers');
    const relink = await db.transaction(async (trx) => {
      await trx('customers').where({ id: req.params.id }).update({ deleted_at: null });
      const result = await relinkSubscribersForEmail(trx, customer.email);
      await auditCustomerMutation(req, 'customer.restore', req.params.id, {
        previousDeletedAt: customer.deleted_at || null,
        newsletterRelinkedTo: result.winnerId,
        newsletterRelinked: result.relinked,
      }, true, trx);
      return result;
    });
    logger.info(`[customers] Restored customer id=${req.params.id}` + (relink.relinked ? ` (newsletter subscribers relinked: ${relink.relinked})` : ''));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/:id/deposit-credit — the customer's open
// (unapplied, unrefunded) estimate-deposit balance, if any. Used by the
// annual-prepay modal to preview the credit that will auto-apply to the
// invoice it mints, so the operator enters the FULL plan amount instead of
// hand-netting the deposit. Read-only; the authoritative read happens again
// inside the mint transaction.
router.get('/:id/deposit-credit', requireAdmin, async (req, res, next) => {
  try {
    const { pendingDepositCreditForCustomer } = require('../services/estimate-deposits');
    const credit = await pendingDepositCreditForCustomer(req.params.id);
    // InvoiceService.create deliberately skips deposit credit on payer-billed
    // invoices (wrong-party credit), so the preview must say so instead of
    // promising an application the mint will intentionally not perform
    // (Codex P2). resolveForInvoice never throws (falls back to self-pay);
    // keep the same fail-open shape here.
    let payerBilled = false;
    if (credit) {
      try {
        const PayerService = require('../services/payer');
        const resolvedPayer = await PayerService.resolveForInvoice({ customerId: req.params.id });
        payerBilled = !!resolvedPayer?.payerId;
      } catch (err) {
        logger.warn(`[customers:deposit-credit] payer resolve failed for ${req.params.id}: ${err.message}`);
      }
    }
    res.json({
      credit: credit
        ? {
          amount: credit.amount,
          estimateId: credit.estimateId,
          estimateSlug: credit.estimateSlug || null,
          payerBilled,
        }
        : null,
    });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/:id/annual-prepay-invoice - create and send an
// unpaid annual prepay invoice. The linked annual_prepay_terms row stays
// payment_pending until Stripe/manual payment marks the invoice paid; the
// payment lifecycle then activates the term and stamps covered visits prepaid.
router.post('/:id/annual-prepay-invoice', requireAdmin, async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const hasAnnualTerms = await db.schema.hasTable('annual_prepay_terms');
    if (!hasAnnualTerms) {
      return res.status(500).json({ error: 'Annual prepay terms table is not available' });
    }

    const parsedAmount = parseAnnualPrepayAmount(req.body?.amount);
    if (parsedAmount.error) return res.status(400).json({ error: parsedAmount.error });
    const amount = parsedAmount.amount;

    const parsedVisitCount = parseAnnualPrepayVisitCount(req.body?.visitCount ?? 4);
    if (parsedVisitCount.error) return res.status(400).json({ error: parsedVisitCount.error });
    const visitCount = parsedVisitCount.visitCount;

    const coverageCadence = cleanOptionalText(req.body?.coverageCadence || req.body?.cadence) || null;
    const coverageServiceType = cleanOptionalText(req.body?.serviceType) || 'Quarterly Pest Control';
    const planLabel = cleanOptionalText(req.body?.planLabel) || `${coverageServiceType} Annual Prepay`;

    const activeTerm = await db('annual_prepay_terms')
      .where({ customer_id: customer.id })
      .where(annualPrepayOverlapStatusClause())
      .orderBy('term_end', 'desc')
      .first();

    const termStartInput = parseDateOnlyInput(req.body?.termStart, 'termStart');
    if (termStartInput.error) return res.status(400).json({ error: termStartInput.error });
    const termStart = termStartInput.date || defaultAnnualPrepayTermStart(activeTerm);

    const termEndInput = parseDateOnlyInput(req.body?.termEnd, 'termEnd');
    if (termEndInput.error) return res.status(400).json({ error: termEndInput.error });
    const termEnd = termEndInput.date || addMonthsDateOnly(termStart, 12);
    if (!termEnd || termEnd <= termStart) {
      return res.status(400).json({ error: 'termEnd must be after termStart' });
    }

    const activeTermEnd = dateOnlyForApi(activeTerm?.term_end);
    if (activeTermEnd && termStart <= activeTermEnd && req.body?.allowOverlap !== true) {
      return res.status(409).json({
        error: `Customer already has an annual prepay term through ${activeTermEnd}. Use a start date after ${activeTermEnd}.`,
        activeTermId: activeTerm.id,
        activeTermEnd,
      });
    }

    // Optional first-visit intent — the date/time already promised to the
    // customer (e.g. booked on the phone). Anchors the generated coverage
    // series and gives visit 1 a real arrival window instead of the windowless
    // term_start-anchored default. Must land inside the coverage window.
    const AnnualPrepayTimes = require('../services/annual-prepay-renewals');
    const firstVisitDateInput = parseDateOnlyInput(req.body?.firstVisitDate, 'firstVisitDate');
    if (firstVisitDateInput.error) return res.status(400).json({ error: firstVisitDateInput.error });
    const firstVisitDate = firstVisitDateInput.date || null;
    if (firstVisitDate && (firstVisitDate < termStart || firstVisitDate > termEnd)) {
      return res.status(400).json({ error: `firstVisitDate must fall between ${termStart} and ${termEnd}` });
    }
    // A promised first visit anchors the whole series and is never moved
    // afterwards, so refuse one that leaves no room for the visits sold — the
    // tail would fall outside the term window and never be stamped prepaid.
    if (firstVisitDate) {
      const lastVisitDate = AnnualPrepayTimes._private.coverageScheduleDates(
        firstVisitDate, visitCount, coverageCadence, null,
      ).slice(-1)[0];
      if (lastVisitDate && lastVisitDate > termEnd) {
        return res.status(400).json({
          error: `A first visit on ${firstVisitDate} pushes visit ${visitCount} to ${lastVisitDate}, past the term end (${termEnd}). Pick an earlier first visit or extend the term.`,
        });
      }
    }
    const firstVisitWindowStartRaw = cleanOptionalText(req.body?.firstVisitWindowStart);
    const firstVisitWindowStart = firstVisitWindowStartRaw
      ? AnnualPrepayTimes.normalizeWindowStart(firstVisitWindowStartRaw)
      : null;
    if (firstVisitWindowStartRaw && !firstVisitWindowStart) {
      return res.status(400).json({ error: 'firstVisitWindowStart must be an on-the-hour 24-hour time like 08:00' });
    }
    if (firstVisitWindowStart && !firstVisitDate) {
      return res.status(400).json({ error: 'firstVisitWindowStart requires firstVisitDate' });
    }
    // window_end is duration-driven, so a start with no room for the visit
    // before midnight is refused rather than shortened.
    if (firstVisitWindowStart && !AnnualPrepayTimes._private.addMinutesHHMM(firstVisitWindowStart, 60)) {
      return res.status(400).json({ error: 'firstVisitWindowStart is too late in the day to fit a service visit' });
    }
    // ADVISORY overlap probe (owner ruling 2026-08-27 — schedule overlaps
    // never block a booking anywhere): a promised time that already collides
    // is still accepted; the warning rides the response in the SAME
    // `warnings[]` shape every other staff booking surface returns
    // (window-rules slotOverlapWarning — consumed by CreateAppointmentModal
    // and Customer 360), so the operator can eyeball the day while the
    // customer is on the phone. The seeder re-probes at payment time and
    // likewise keeps the window, filing a coverage exception. A probe
    // failure is ignored — it can only warn.
    let overlapWarning = null;
    if (firstVisitDate && firstVisitWindowStart) {
      try {
        const conflict = await AnnualPrepayTimes.findVisitWindowConflict(db, {
          scheduledDate: firstVisitDate,
          windowStart: firstVisitWindowStart,
          // A visit of this same coverage service already sitting at that hour is
          // the one coverage will adopt, not a clash. The customer's OTHER
          // services still count — they can't be performed simultaneously.
          adoptableFor: { customerId: customer.id, coverageServiceType },
        });
        if (conflict) {
          // Future tense on purpose: the promised visit is seeded when the
          // term ACTIVATES (payment / credit), not when this invoice is minted.
          overlapWarning = `Heads up: the promised ${firstVisitWindowStart} first visit on ${firstVisitDate} overlaps another appointment on the schedule. It will still be booked at that time when the invoice is paid — check the day's route.`;
        }
      } catch (probeErr) {
        logger.warn(`[annual-prepay] first-visit overlap probe failed (${probeErr.message}) — continuing without a warning`);
      }
    }

    const note = cleanOptionalText(req.body?.note);
    const dueDateInput = parseDateOnlyInput(req.body?.dueDate, 'dueDate');
    if (dueDateInput.error) return res.status(400).json({ error: dueDateInput.error });
    const dueDate = dueDateInput.date || etDateString();
    const perVisit = Math.round((amount / visitCount) * 100) / 100;
    const invoiceNotes = [
      `Annual prepaid ${coverageServiceType}.`,
      `Covers ${visitCount} service application${visitCount === 1 ? '' : 's'} from ${termStart} through ${termEnd}.`,
      `Payment of this invoice will automatically mark those scheduled visits prepaid.`,
      note,
    ].filter(Boolean).join('\n');

    // Charge-in-person (Tap to Pay) mints the invoice and creates the payment_pending
    // term up front, exactly like the send path but WITHOUT delivering a pay link —
    // the operator collects on the spot. The term reserves coverage + suppresses
    // billing immediately; the webhook flips it active on payment, and an aborted
    // charge is cleaned up by voiding the invoice (which cancels the term). Rejected
    // for payer-billed customers below (their invoices can't be tendered in person).
    const chargeInPerson = req.body?.chargeInPerson === true;
    // Open estimate-deposit balance (e.g. restored when a prior prepay invoice
    // was voided) can apply to this invoice — a paid deposit credits the
    // FIRST invoice and any remainder rolls to subsequent ones; this flow
    // previously skipped the ledger, so operators hand-netted the deposit
    // into the typed amount and the ledger credit stranded. STRICT double
    // opt-in (Codex round-2): the credit applies only when the caller sends
    // applyDepositCredit === true AND names the estimate whose ledger it saw
    // in the preview (depositCreditEstimateId) — an omitted field (stale
    // admin tab, old payload) means NO credit, so the server can never
    // subtract a credit the operator never saw. The operator enters the FULL
    // plan amount; create() appends the negative credit line (capped against
    // its own after-tax total, skipped for payer-billed invoices) and
    // consumption below must match the applied figure exactly or the whole
    // mint rolls back — same contract as the estimate-accept path.
    const applyDepositCredit = req.body?.applyDepositCredit === true;
    const requestedCreditEstimateId = cleanOptionalText(req.body?.depositCreditEstimateId) || null;
    const InvoiceService = require('../services/invoice');
    const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
    const { pendingDepositCredit, consumeDepositCredit } = require('../services/estimate-deposits');
    let invoice;
    let term = null;
    let appliedDepositCredit = 0;
    let depositCreditEstimateId = null;
    let settledByDepositCredit = false;
    await db.transaction(async (trx) => {
      await lockAndAssertNoAnnualPrepayOverlap(
        trx, customer.id, termStart, req.body?.allowOverlap === true,
        'Customer already has an annual prepay term through',
      );
      // The credit consumes ONLY the estimate the operator was shown in the
      // preview banner (echoed back as depositCreditEstimateId) — never a
      // server-side pick, so an unrelated job's rolled-forward deposit can't
      // be silently redirected onto the prepay (Codex round-2). Validation
      // fails CLOSED (409, mint aborted): minting gross when the operator
      // expected net silently un-nets the invoice they approved. The ledger
      // read failing also aborts, like the accept path.
      let pendingCredit = null;
      if (applyDepositCredit) {
        const unavailable = (message) => {
          const err = new Error(message);
          err.depositCreditUnavailable = true;
          return err;
        };
        if (!requestedCreditEstimateId) {
          throw unavailable('applyDepositCredit requires depositCreditEstimateId (the estimate shown in the preview). Refresh and retry.');
        }
        const creditEstimate = await trx('estimates')
          .where({ id: requestedCreditEstimateId, customer_id: customer.id })
          .first('id');
        if (!creditEstimate) {
          throw unavailable('The deposit-credit estimate does not belong to this customer. Refresh and retry.');
        }
        const credit = await pendingDepositCredit(requestedCreditEstimateId, trx);
        if (!credit) {
          throw unavailable('The deposit credit is no longer available (consumed or refunded since the preview). Refresh and retry.');
        }
        // The live balance must match what the operator approved in the
        // preview TO THE CENT (Codex round-3): a partial refund/consume
        // between preview and submit can leave the balance positive but
        // different, which would silently mint a different net than the
        // modal showed. Echo the previewed cents and 409 on any drift.
        const previewCents = Math.round(Number(req.body?.depositCreditAmount) * 100);
        if (!Number.isFinite(previewCents) || previewCents <= 0) {
          throw unavailable('applyDepositCredit requires depositCreditAmount (the credit shown in the preview). Refresh and retry.');
        }
        if (Math.round(Number(credit.amount) * 100) !== previewCents) {
          throw unavailable(`The deposit credit changed since the preview (previewed $${(previewCents / 100).toFixed(2)}, now $${Number(credit.amount).toFixed(2)}). Refresh and retry.`);
        }
        pendingCredit = { ...credit, estimateId: requestedCreditEstimateId };
      }
      invoice = await InvoiceService.create({
        database: trx,
        customerId: customer.id,
        title: `${coverageServiceType} - Annual Prepay`,
        lineItems: [{
          description: `${coverageServiceType} - ${visitCount} prepaid application${visitCount === 1 ? '' : 's'}`,
          quantity: 1,
          unit_price: amount,
          category: 'Annual prepay',
        }],
        notes: invoiceNotes,
        dueDate,
        ...(pendingCredit
          ? { depositCredit: { amount: pendingCredit.amount, estimateId: pendingCredit.estimateId } }
          : {}),
      });
      // Consume exactly what create() applied (it caps the request; payer-billed
      // invoices apply 0 and the ledger stays untouched). A mismatch means the
      // ledger moved under us — roll the whole mint back rather than leave a
      // credit line without dollar-for-dollar ledger backing.
      appliedDepositCredit = Number(invoice?.applied_deposit_credit) || 0;
      // A requested credit that create() DECLINED to apply (customer flipped to
      // payer-billed between preview and submit — create() zeroes deposit
      // credit on payer invoices) must NOT mint the gross invoice the operator
      // never approved; 409 and abort instead of silently sending it (Codex
      // round-3). Rolls back inside the transaction like the reads above.
      if (pendingCredit && !(appliedDepositCredit > 0)) {
        const err = new Error('This customer is now billed to a third party, so the deposit credit could not be applied. Refresh and retry.');
        err.depositCreditUnavailable = true;
        throw err;
      }
      if (appliedDepositCredit > 0) {
        depositCreditEstimateId = pendingCredit.estimateId;
        const allocated = await consumeDepositCredit({
          estimateId: pendingCredit.estimateId,
          amount: appliedDepositCredit,
          invoiceId: invoice.id,
          trx,
        });
        if (Math.round(allocated * 100) !== Math.round(appliedDepositCredit * 100)) {
          throw new Error(`deposit allocation mismatch on annual prepay invoice (applied ${appliedDepositCredit}, allocated ${allocated})`);
        }
      }
      // Credit >= the after-tax total settles the invoice outright: create()
      // capped the credit to the total, so nothing is left for Stripe /
      // Tap-to-Pay to collect and no payment webhook will EVER fire — an
      // unpaid $0 invoice would strand the term in payment_pending while
      // blocking later prepay coverage (Codex P2). Flip it paid here (the
      // deposit dollars were already collected and recorded when the deposit
      // was paid) and run the payment sync after commit, mirroring the
      // dispatch prepaid-credit path.
      settledByDepositCredit = appliedDepositCredit > 0 && !(Number(invoice.total) > 0);
      if (settledByDepositCredit) {
        const [settled] = await trx('invoices')
          .where({ id: invoice.id })
          .update({
            // 'prepaid' + paid_at — NOT 'paid', NOT payment_recorded_at
            // (Codex round-2): paid_at is what activates the term
            // (invoiceTermStatus), while 'prepaid' with no payments row and
            // no payment_recorded_at is the one settled state
            // assertInvoiceVoidable + the void money-guard accept — so an
            // operator can still void this invoice, which restores the
            // deposit ledger (restoreDepositCreditForVoidedInvoice) and
            // cancels the term. 'paid'/payment_recorded_at would weld the
            // credit to a possibly-unwanted term with no in-app undo.
            status: 'prepaid',
            paid_at: trx.fn.now(),
            payment_method: 'deposit_credit',
            updated_at: trx.fn.now(),
          })
          .returning('*');
        if (settled) invoice = { ...invoice, ...settled };
      }

      // Payer-billed customers can't be charged in person: NET third-party invoices
      // accrue to a payer statement, and due-on-receipt Bill-To invoices carry a
      // payer_id (the terminal handoff rejects any payer_id — a tech must not collect
      // the AP's invoice from the service-recipient flow). Block on EITHER payer field
      // before committing; the operator sends the invoice instead (the term below
      // suppresses billing meanwhile). Re-read the persisted row because the payer
      // accrual/stamp is applied after the insert, so create()'s return may omit them.
      if (chargeInPerson) {
        const minted = await trx('invoices').where({ id: invoice.id }).first('payer_statement_id', 'payer_id');
        if (minted?.payer_statement_id || minted?.payer_id) {
          const err = new Error("Charge in person isn't available for payer-billed customers — send the invoice instead.");
          err.chargeInPersonPayerBlocked = true;
          throw err;
        }
      }

      // Create the payment_pending term up front for BOTH paths (charge-in-person
      // only differs by skipping delivery). The term reserves the coverage window
      // (the overlap lock above dedupes concurrent mints) and suppresses monthly
      // billing while unpaid; the webhook flips it active on payment, and an aborted
      // in-person charge is cleaned up by voiding the invoice (which cancels it).
      term = await AnnualPrepayRenewals.createTermForAnnualPrepay({
        customerId: customer.id,
        prepayInvoiceId: invoice.id,
        planLabel,
        monthlyRate: Math.round((amount / 12) * 100) / 100,
        // Store what the customer actually pays for the YEAR (commercial
        // invoices add county tax via InvoiceService.create), not the pretax
        // request amount — applyPrepaidCoverageForTerm splits prepay_amount
        // across the covered visits, so a pretax value would leave the tax
        // portion uncredited and make the coverage ledger disagree with the
        // invoice/payment total. GROSS of any deposit credit, mirroring the
        // estimate-accept path: the deposit is prior payment toward the same
        // year, so the net invoice total alone would understate the plan by
        // the deposit.
        prepayAmount: Math.round((Number(invoice.total) + appliedDepositCredit) * 100) / 100,
        termStart,
        termEnd,
        coverageServiceType,
        coverageVisitCount: visitCount,
        coverageCadence,
        firstVisitDate,
        firstVisitWindowStart,
        conn: trx,
      });
      if (!term) throw new Error('Annual prepay term could not be created');

      await trx('activity_log').insert({
        customer_id: customer.id,
        action: 'annual_prepay_invoice_created',
        description: `Annual prepay invoice ${invoice.invoice_number} created for ${coverageServiceType}: $${amount.toFixed(2)} covering ${visitCount} visit(s)`
          + (appliedDepositCredit > 0 ? ` ($${appliedDepositCredit.toFixed(2)} deposit credit applied)` : '')
          + (chargeInPerson ? ' (charge in person — term activates on payment)' : ''),
        metadata: JSON.stringify({
          invoice_id: invoice.id,
          invoice_number: invoice.invoice_number,
          annual_prepay_term_id: term?.id || null,
          applied_deposit_credit: appliedDepositCredit,
          deposit_credit_estimate_id: depositCreditEstimateId,
          charge_in_person: chargeInPerson,
          coverage_service_type: coverageServiceType,
          coverage_visit_count: visitCount,
          coverage_cadence: coverageCadence,
          per_visit_amount: perVisit,
          term_start: termStart,
          term_end: termEnd,
        }),
      }).catch((err) => logger.warn(`[customers:annual-prepay-invoice] activity_log insert failed: ${err.message}`));
    });

    // A credit-settled invoice has no webhook behind it — run the payment
    // sync directly so the term activates and coverage stamps. Best-effort:
    // the daily covered-term sweep is the recovery net (same contract as the
    // dispatch prepaid-credit path).
    if (settledByDepositCredit) {
      try {
        await AnnualPrepayRenewals.syncTermForInvoicePayment(invoice);
      } catch (err) {
        logger.warn(`[customers:annual-prepay-invoice] term sync after deposit-credit settle failed for ${invoice.id}: ${err.message}`);
      }
    }

    let delivery = null;
    // Nothing to collect on a credit-settled invoice — never send a pay link
    // for $0 due.
    if (!chargeInPerson && !settledByDepositCredit) {
      try {
        delivery = await InvoiceService.sendViaSMSAndEmail(invoice.id, { operatorInitiated: true });
      } catch (err) {
        delivery = { ok: false, error: err.message };
        logger.warn(`[customers:annual-prepay-invoice] send failed for ${invoice.id}: ${err.message}`);
      }
    }

    const payUrl = delivery?.payUrl || await shortenOrPassthrough(`${publicPortalUrl()}/pay/${invoice.token}`, {
      kind: 'invoice',
      entityType: 'invoices',
      entityId: invoice.id,
      customerId: customer.id,
      codePrefix: invoiceShortCodePrefix(invoice),
    });

    await auditCustomerMutation(req, 'customer.annual_prepay.invoice_send', customer.id, {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      annualPrepayTermId: term?.id || null,
      chargeInPerson,
      appliedDepositCredit,
      depositCreditEstimateId,
      amount,
      serviceType: coverageServiceType,
      visitCount,
      coverageCadence,
      termStart,
      termEnd,
      deliveryOk: !!delivery?.ok,
    }, true);

    res.status(201).json({
      success: true,
      invoice: {
        ...invoice,
        payUrl,
      },
      appliedDepositCredit,
      settledByDepositCredit,
      annualPrepayTerm: term ? mapAnnualPrepayTerm(term) : null,
      delivery,
      ...(overlapWarning ? { warnings: [overlapWarning] } : {}),
    });
  } catch (err) {
    if (err && err.annualPrepayOverlap) return res.status(409).json(err.annualPrepayOverlap);
    if (err && err.chargeInPersonPayerBlocked) return res.status(400).json({ error: err.message });
    if (err && err.depositCreditUnavailable) return res.status(409).json({ error: err.message });
    next(err);
  }
});

// POST /api/admin/customers/:id/annual-prepay - record a 12-month prepay that
// has already been collected, create the paid invoice, and activate/extend the
// annual prepay term used by renewal alerts and Customer 360.
router.post('/:id/annual-prepay', requireAdmin, async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const hasAnnualTerms = await db.schema.hasTable('annual_prepay_terms');
    if (!hasAnnualTerms) {
      return res.status(500).json({ error: 'Annual prepay terms table is not available' });
    }

    const parsedAmount = parseAnnualPrepayAmount(req.body?.amount);
    if (parsedAmount.error) return res.status(400).json({ error: parsedAmount.error });
    const amount = parsedAmount.amount;

    const parsedVisitCount = parseAnnualPrepayVisitCount(req.body?.visitCount ?? 4);
    if (parsedVisitCount.error) return res.status(400).json({ error: parsedVisitCount.error });
    const visitCount = parsedVisitCount.visitCount;

    const coverageCadence = cleanOptionalText(req.body?.coverageCadence || req.body?.cadence) || null;
    const coverageServiceType = cleanOptionalText(req.body?.serviceType) || 'Quarterly Pest Control';
    const planLabel = cleanOptionalText(req.body?.planLabel) || `${coverageServiceType} Annual Prepay`;

    const method = cleanText(req.body?.method || 'card_present').toLowerCase();
    if (!ANNUAL_PREPAY_PAYMENT_METHODS.has(method)) {
      return res.status(400).json({
        error: `method must be one of: ${Array.from(ANNUAL_PREPAY_PAYMENT_METHODS).join(', ')}`,
      });
    }

    const activeTerm = await db('annual_prepay_terms')
      .where({ customer_id: customer.id })
      .where(annualPrepayOverlapStatusClause())
      .orderBy('term_end', 'desc')
      .first();

    const termStartInput = parseDateOnlyInput(req.body?.termStart, 'termStart');
    if (termStartInput.error) return res.status(400).json({ error: termStartInput.error });
    const termStart = termStartInput.date || defaultAnnualPrepayTermStart(activeTerm);

    const termEndInput = parseDateOnlyInput(req.body?.termEnd, 'termEnd');
    if (termEndInput.error) return res.status(400).json({ error: termEndInput.error });
    const termEnd = termEndInput.date || addMonthsDateOnly(termStart, 12);
    if (!termEnd || termEnd <= termStart) {
      return res.status(400).json({ error: 'termEnd must be after termStart' });
    }

    const activeTermEnd = dateOnlyForApi(activeTerm?.term_end);
    if (activeTermEnd && termStart <= activeTermEnd && req.body?.allowOverlap !== true) {
      return res.status(409).json({
        error: `Customer already has an active annual prepay term through ${activeTermEnd}. Use a start date after ${activeTermEnd}.`,
        activeTermId: activeTerm.id,
        activeTermEnd,
      });
    }

    const reference = cleanOptionalText(req.body?.reference);
    const note = cleanOptionalText(req.body?.note);
    const recordedBy = req.technician?.name || req.technician?.email || req.technicianId || 'admin';
    const invoiceNotes = [
      'Created from Customer 360 annual prepay.',
      `Annual prepaid ${coverageServiceType}.`,
      `Covers ${visitCount} service application${visitCount === 1 ? '' : 's'} from ${termStart} through ${termEnd}.`,
      `Payment already collected via ${method.replace(/_/g, ' ')}.`,
      reference ? `Reference: ${reference}.` : null,
      note ? `Note: ${note}` : null,
    ].filter(Boolean).join('\n');

    const InvoiceService = require('../services/invoice');
    let result;
    await db.transaction(async (trx) => {
      await lockAndAssertNoAnnualPrepayOverlap(
        trx, customer.id, termStart, req.body?.allowOverlap === true,
        'Customer already has an active annual prepay term through',
      );
      const invoice = await InvoiceService.create({
        database: trx,
        customerId: customer.id,
        // Annual prepay is created and PAID in this same transaction (below), so
        // it must never accrue to a payer's open statement — accruing an
        // already-collected invoice would keep it in the statement total and
        // double-bill it at settlement.
        skipAccrual: true,
        title: `${coverageServiceType} - Annual Prepay`,
        lineItems: [{
          description: `${coverageServiceType} - ${visitCount} prepaid application${visitCount === 1 ? '' : 's'}`,
          quantity: 1,
          unit_price: amount,
          category: 'Annual prepay',
        }],
        notes: invoiceNotes,
        dueDate: termStart,
      });

      const [updatedInvoice] = await trx('invoices')
        .where({ id: invoice.id })
        .update({
          status: 'paid',
          paid_at: trx.fn.now(),
          payment_method: method,
          payment_reference: reference || null,
          payment_recorded_by: recordedBy,
          payment_recorded_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        })
        .returning('*');
      if (!updatedInvoice) throw new Error('Annual prepay invoice could not be marked paid');

      const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
      const term = await AnnualPrepayRenewals.createTermForAnnualPrepay({
        customerId: customer.id,
        prepayInvoiceId: updatedInvoice.id,
        planLabel,
        monthlyRate: Number(customer.monthly_rate || 0) || Math.round((amount / 12) * 100) / 100,
        // Match the recorded payment (inserted below as updatedInvoice.total) and
        // the coverage ledger: commercial invoices add county tax, so the pretax
        // request amount would under-credit the prepaid visits.
        prepayAmount: Number(updatedInvoice.total),
        termStart,
        termEnd,
        coverageServiceType,
        coverageVisitCount: visitCount,
        coverageCadence,
        conn: trx,
      });
      if (!term) throw new Error('Annual prepay term could not be activated');

      const [payment] = await trx('payments').insert({
        customer_id: customer.id,
        amount: Number(updatedInvoice.total),
        status: 'paid',
        description: `Invoice ${updatedInvoice.invoice_number} - annual prepay (${method.replace(/_/g, ' ')})`,
        payment_date: etDateString(),
        metadata: JSON.stringify({
          invoice_id: updatedInvoice.id,
          annual_prepay_term_id: term.id,
          source: 'customer360_annual_prepay',
          method,
          reference: reference || null,
          term_start: termStart,
          term_end: termEnd,
          coverage_service_type: coverageServiceType,
          coverage_visit_count: visitCount,
          coverage_cadence: coverageCadence,
        }),
      }).returning('*');

      await trx('activity_log').insert({
        customer_id: customer.id,
        action: 'annual_prepay_recorded',
        description: `Annual prepay recorded for ${coverageServiceType}: $${Number(updatedInvoice.total).toFixed(2)} covering ${visitCount} visit(s) via ${method.replace(/_/g, ' ')}`,
        metadata: JSON.stringify({
          invoice_id: updatedInvoice.id,
          invoice_number: updatedInvoice.invoice_number,
          annual_prepay_term_id: term.id,
          payment_id: payment?.id || null,
          coverage_service_type: coverageServiceType,
          coverage_visit_count: visitCount,
          coverage_cadence: coverageCadence,
          term_start: termStart,
          term_end: termEnd,
        }),
      }).catch((err) => logger.warn(`[customers:annual-prepay] activity_log insert failed: ${err.message}`));

      result = { invoice: updatedInvoice, term, payment };
    });

    // A cash/check annual prepay is the customer paying — same automatic-
    // clear contract as every other receipt path. The helper owns the rules
    // (reason gate, causality, locking); settlement moment is NOW (a human
    // is holding the money). Failure logs — the operator has the button.
    try {
      const { maybeResumeBillingPauseOnPayment } = require('../services/billing-pause');
      await maybeResumeBillingPauseOnPayment(customer.id, {
        paymentIntentId: null,
        source: 'customer360_annual_prepay',
        settledAt: new Date(),
      });
    } catch (pauseErr) {
      logger.warn(`[customers:annual-prepay] billing-pause auto-clear failed: ${pauseErr.message}`);
    }

    await auditCustomerMutation(req, 'customer.annual_prepay.record', customer.id, {
      invoiceId: result.invoice.id,
      invoiceNumber: result.invoice.invoice_number,
      annualPrepayTermId: result.term.id,
      amount: Number(result.invoice.total),
      baseAmount: amount,
      method,
      serviceType: coverageServiceType,
      visitCount,
      coverageCadence,
      termStart,
      termEnd,
    }, true);

    res.status(201).json({
      success: true,
      invoice: result.invoice,
      annualPrepayTerm: {
        id: result.term.id,
        customerId: result.term.customer_id,
        prepayInvoiceId: result.term.prepay_invoice_id,
        planLabel: result.term.plan_label,
        monthlyRate: result.term.monthly_rate != null ? Number(result.term.monthly_rate) : null,
        prepayAmount: result.term.prepay_amount != null ? Number(result.term.prepay_amount) : null,
        termStart: dateOnlyForApi(result.term.term_start),
        termEnd: dateOnlyForApi(result.term.term_end),
        status: result.term.status,
        coverageServiceType: result.term.coverage_service_type || null,
        coverageVisitCount: result.term.coverage_visit_count != null ? Number(result.term.coverage_visit_count) : null,
        coverageCadence: result.term.coverage_cadence || null,
      },
    });
  } catch (err) {
    if (err && err.annualPrepayOverlap) return res.status(409).json(err.annualPrepayOverlap);
    next(err);
  }
});

// =========================================================================
// POST /api/admin/customers/:id/refund — Refund a Stripe payment
// =========================================================================
router.post('/:id/refund', requireAdmin, async (req, res, next) => {
  try {
    const { paymentId, amount, reason } = req.body;
    if (!paymentId) return res.status(400).json({ error: 'paymentId required' });

    const payment = await db('payments').where({ id: paymentId, customer_id: req.params.id }).first();
    if (!payment) return res.status(404).json({ error: 'Payment not found for this customer' });
    if (amount !== undefined && amount !== null && amount !== '') {
      const refundAmount = parseFloat(amount);
      if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
        return res.status(400).json({ error: 'Refund amount must be greater than 0' });
      }
      if (refundAmount > parseFloat(payment.amount || 0)) {
        return res.status(400).json({ error: 'Refund amount cannot exceed payment amount' });
      }
    }

    await auditCustomerMutation(req, 'customer.payment.refund', req.params.id, {
      paymentId,
      amount: amount || null,
      reason: reason || 'requested_by_customer',
    }, true);
    const StripeService = require('../services/stripe');
    const result = await StripeService.refund(paymentId, { amount, reason: reason || 'requested_by_customer' });
    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// Cancel signup & refund deposit — deposit-stage offboarding orchestration.
// GET returns the confirm-modal preview (what will void/cancel/refund, or
// why the run is blocked); POST executes. The orchestrator re-runs the
// eligibility check itself, so a stale modal can't authorize a stale run.
// =========================================================================
router.get('/:id/cancel-signup', requireAdmin, async (req, res, next) => {
  try {
    const CustomerOffboarding = require('../services/customer-offboarding');
    res.json(await CustomerOffboarding.previewCancelSignup(req.params.id));
  } catch (err) { next(err); }
});

router.post('/:id/cancel-signup', requireAdmin, async (req, res, next) => {
  try {
    const CustomerOffboarding = require('../services/customer-offboarding');
    await auditCustomerMutation(req, 'customer.cancel_signup', req.params.id, {
      reason: cleanOptionalText(req.body?.reason) || 'requested_by_customer',
    }, true);
    const result = await CustomerOffboarding.cancelSignupAndRefundDeposit(req.params.id, {
      actorId: req.technicianId || null,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.blockers) return res.status(409).json({ error: err.message, blockers: err.blockers });
    next(err);
  }
});

// GET /:id/credits — account credit balance + ledger history for Customer 360.
router.get('/:id/credits', requireAdmin, async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.id }).first('id');
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const [balance, ledger] = await Promise.all([
      CustomerCredit.getBalance(req.params.id),
      CustomerCredit.getLedger(req.params.id, { limit: 100 }),
    ]);
    res.json({ balance: balance || 0, ledger });
  } catch (err) { next(err); }
});

// POST /:id/credits — issue or adjust account credit (Customer 360).
// Body: {
//   amount: number    — non-zero; negative deducts
//   kind:   string     — 'prepayment' | 'goodwill' | 'adjustment'
//   method?: string    — cash/check/zelle/card/other (prepayment only)
//   note?:  string
// }
//
// Revenue recognition (owner decision 2026-06-17): cash arrives as a
// `prepayment` — that books a paid `payments` row HERE, at receipt, so it
// counts as collected/taxable once. `goodwill`/`adjustment` are non-cash and
// book NO payments row (they must never inflate revenue/tax). Applying credit
// to an invoice later does NOT re-book revenue (see apply-credit). Referral /
// invoice-application ledger sources are system-driven and not settable here.
// Manual prepayment methods are off-gateway tenders only. `card` is
// deliberately excluded — a card prepayment must go through Stripe (which
// also applies the required card surcharge); booking it as a manual cash-
// style payments row here would grant spendable credit + paid revenue
// without actually collecting the card.
const CREDIT_PAYMENT_METHODS = ['cash', 'check', 'zelle', 'other'];

router.post('/:id/credits', requireAdmin, async (req, res, next) => {
  try {
    const { amount, kind = 'goodwill', method = 'other', note } = req.body || {};
    const delta = Number(amount);
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ error: 'amount must be a non-zero number' });
    }
    if (!['prepayment', 'goodwill', 'adjustment'].includes(kind)) {
      return res.status(400).json({ error: "kind must be 'prepayment', 'goodwill', or 'adjustment'" });
    }
    // A prepayment is money received — it only makes sense as an addition.
    if (kind === 'prepayment' && delta < 0) {
      return res.status(400).json({ error: 'A prepayment must be a positive amount (money received)' });
    }
    if (kind === 'prepayment' && !CREDIT_PAYMENT_METHODS.includes(method)) {
      return res.status(400).json({ error: `method must be one of: ${CREDIT_PAYMENT_METHODS.join(', ')}` });
    }
    const createdBy = req.technician?.name || req.technician?.email || req.technicianId || 'admin';
    // Ledger provenance: adjustments are corrections; prepayment + goodwill
    // are both operator-issued credit ('manual').
    const ledgerSource = kind === 'adjustment' ? 'adjustment' : 'manual';
    const trimmedNote = note ? String(note).slice(0, 1000) : null;
    const ledgerNote = [kind, kind === 'prepayment' ? method : null, trimmedNote]
      .filter(Boolean).join(' · ').slice(0, 1000);

    let result;
    try {
      result = await db.transaction(async (trx) => {
        const movement = await CustomerCredit.postCreditMovement({
          customerId: req.params.id,
          delta,
          source: ledgerSource,
          note: ledgerNote || null,
          createdBy,
        }, trx);

        // Cash-backed prepayment → recognize the money at receipt. No
        // invoice link yet (the credit is held until applied). Matches the
        // off-gateway payments-ledger convention (null processor).
        if (kind === 'prepayment') {
          await trx('payments').insert({
            customer_id: req.params.id,
            amount: CustomerCredit.round2(delta),
            status: 'paid',
            description: `Account credit prepayment — ${method}`
              + (trimmedNote ? ` (${trimmedNote.slice(0, 120)})` : ''),
            payment_date: etDateString(),
            metadata: JSON.stringify({ source: 'account_credit_prepayment', method }),
          });
        }

        // Critical audit inside the same transaction as the money movement —
        // if it fails, the whole thing rolls back, so a retry can't duplicate
        // the credit/revenue (the operator never sees a committed-but-errored
        // state).
        await auditCustomerMutation(req, 'customer.credit.adjust', req.params.id, {
          amount: CustomerCredit.round2(delta),
          kind,
          method: kind === 'prepayment' ? method : null,
          balance_after: movement.balanceAfter,
          note: trimmedNote,
        }, true, trx);

        return movement;
      });
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      throw err;
    }

    // A cash-backed PREPAYMENT is real money received — same automatic-
    // clear contract. Adjustments/corrections (other kinds) move no cash
    // and must not clear anything.
    if (kind === 'prepayment') {
      try {
        const { maybeResumeBillingPauseOnPayment } = require('../services/billing-pause');
        await maybeResumeBillingPauseOnPayment(req.params.id, {
          paymentIntentId: null,
          source: 'account_credit_prepayment',
          settledAt: new Date(),
        });
      } catch (pauseErr) {
        logger.warn(`[admin-customers] billing-pause auto-clear failed: ${pauseErr.message}`);
      }
    }

    await db('activity_log').insert({
      customer_id: req.params.id,
      action: 'account_credit_adjusted',
      description: `Account credit ${delta >= 0 ? 'added' : 'deducted'} `
        + `$${Math.abs(CustomerCredit.round2(delta)).toFixed(2)} (${kind}`
        + `${kind === 'prepayment' ? ` · ${method}` : ''})`
        + ` — balance $${result.balanceAfter.toFixed(2)} · ${createdBy}`
        + (trimmedNote ? ` — ${trimmedNote.slice(0, 120)}` : ''),
    }).catch((e) => logger.warn(`[admin-customers] credit activity_log insert failed: ${e.message}`));

    res.json({ ok: true, balance: result.balanceAfter, entry: result.entry });
  } catch (err) { next(err); }
});

router._private = {
  CUSTOMER_STAGES,
  SENSITIVE_CUSTOMER_FIELDS,
  SCHEDULED_HISTORY_LIMIT,
  customerScheduledHistoryQuery,
  customerScheduledHistory,
  technicianServicesCustomer,
  techSafeListRow,
  techSafeListFilters,
  techSafeSort,
  techSafe360Payload,
  TECH_LIST_STRIPPED_FIELDS,
  TECH_360_STRIPPED_KEYS,
  TECH_360_STRIPPED_CUSTOMER_FIELDS,
  TECH_ACCESS_DEAD_STATUSES,
  adminMembershipDailyIdempotencyKey,
  adminMembershipStartIdempotencyKey,
  adminNotificationPrefsDbUpdates,
  addMonthsDateOnly,
  cadenceFromEstimateLine,
  compactServiceContactSlots,
  customerSearchTerms,
  defaultAnnualPrepayTermStart,
  hasMembership,
  indexServicesForSchedule,
  isSchedulableOneTimeEstimateLine,
  isValidStage,
  lockAndAssertNoAnnualPrepayOverlap,
  stageLifecycleStamps,
  mapCustomerListRow,
  mapPipelineCustomer,
  membershipDetailsChanged,
  normalizeAdminAddressInput,
  parseAnnualPrepayAmount,
  parseAnnualPrepayVisitCount,
  scheduleLinesFromEstimate,
  serviceCatalogMatch,
};

router.ensureCustomerAccount = ensureCustomerAccount;
router.findAccountByContact = findAccountByContact;
// Canonical membership predicate — consumers (estimate edit-source) must
// classify sentinel tiers (One-Time/Commercial/...) the same way this file
// does rather than re-deriving from raw tier truthiness.
router.hasMembership = hasMembership;

module.exports = router;
