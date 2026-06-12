/**
 * Estimate Auto-Converter — when an estimate is accepted, automatically:
 *   1. Set customer pipeline_stage to 'active_customer'
 *   2. Determine WaveGuard tier from selected services count
 *   3. Calculate monthly_rate from estimate data
 *   4. Create scheduled_services for recurring services
 *   5. Log the conversion in activity_log
 */

const db = require('../models/db');
const logger = require('./logger');
const AvailabilityEngine = require('./availability');
const { WAVEGUARD } = require('./pricing-engine/constants');
const {
  inferFrequencyKeyFromEstimateData,
  resolveBillingCadence,
} = require('./billing-cadence');
const AccountMembershipEmail = require('./account-membership-email');
const { etDateString } = require('../utils/datetime-et');
const RecurringAppointmentSeeder = require('./recurring-appointment-seeder');

const WAVEGUARD_SETUP_FEE = 99;

/**
 * Pick the first service date for a freshly-converted customer.
 *
 * Preference order:
 *   1. Earliest date from AvailabilityEngine (a day when a tech is already
 *      working the customer's zone AND zone capacity isn't full). This keeps
 *      new customers clustered onto existing routes instead of creating
 *      one-off detours.
 *   2. Fallback: today + 7 days, bumped forward off Sunday. Used when we
 *      can't resolve the customer's zone (empty city, new area) or when no
 *      tech is scheduled in that zone across the 14-day window.
 *
 * Returns a YYYY-MM-DD string ready for scheduled_services.scheduled_date.
 */
async function pickFirstServiceDate(customer, estimateId) {
  try {
    if (customer.city) {
      const avail = await AvailabilityEngine.getAvailableSlots(customer.city, estimateId);
      const first = avail?.days?.[0]?.date;
      if (first) {
        logger.info(`[estimate-converter] Snapped first service to route day ${first} (zone: ${avail.zone})`);
        return first;
      }
    }
  } catch (e) {
    logger.error(`[estimate-converter] Availability lookup failed, falling back: ${e.message}`);
  }

  // Fallback — today + 7, snap off Sunday
  const fallback = new Date(Date.now() + 7 * 86400000);
  while (fallback.getDay() === 0) fallback.setDate(fallback.getDate() + 1);
  const dateStr = fallback.toISOString().split('T')[0];
  logger.info(`[estimate-converter] No route-day match for city "${customer.city || '(empty)'}", using fallback ${dateStr}`);
  return dateStr;
}

/**
 * Determine WaveGuard tier based on the number of tier-qualifying recurring
 * services selected. Excluded recurring rows such as Palm Injection and Rodent
 * Bait Stations still schedule, but they do not move the customer into Silver+.
 *
 * Discount values + min-service thresholds are sourced from
 * `pricing-engine/constants.WAVEGUARD.tiers` — the single source of truth
 * (see docs/pricing/POLICY.md). Returns title-cased tier names because
 * `customers.waveguard_tier` and the admin UI both expect
 * 'Bronze'/'Silver'/'Gold'/'Platinum'.
 *
 * Earlier this file defined a local table with Platinum=0.18, which drifted
 * from the engine's 0.20 — Platinum customers were being activated at 2pp
 * less than they were quoted. Now derived live so any future tier change
 * lands in one place.
 */
function determineTier(serviceCount, hasRecurringServices = false) {
  const t = WAVEGUARD.tiers;
  if (serviceCount >= t.platinum.minServices) return { tier: 'Platinum', discount: t.platinum.discount };
  if (serviceCount >= t.gold.minServices)     return { tier: 'Gold',     discount: t.gold.discount };
  if (serviceCount >= t.silver.minServices)   return { tier: 'Silver',   discount: t.silver.discount };
  if (serviceCount >= t.bronze.minServices)   return { tier: 'Bronze',   discount: t.bronze.discount };
  if (hasRecurringServices)                   return { tier: 'Bronze',   discount: t.bronze.discount };
  return { tier: 'none', discount: 0 };
}

function recurringServiceKey(svc = {}) {
  const raw = String(svc.service || svc.key || svc.name || svc.label || svc.displayName || '').toLowerCase();
  const words = raw.replace(/[_-]+/g, ' ');
  if (
    raw.includes('palm_injection')
    || raw.includes('palm_treatment')
    || /\bpalm injection\b|\bpalm tree\b|\bpalms?\b/.test(words)
  ) return 'palm_injection';
  if (
    raw.includes('rodent_bait')
    || raw.includes('rodent_monitoring')
    || (raw.includes('rodent') && /bait|station|monitor/.test(raw))
  ) return 'rodent_bait';
  if (raw.includes('pest')) return 'pest_control';
  if (raw.includes('lawn')) return 'lawn_care';
  if (raw.includes('tree') || raw.includes('shrub') || raw.includes('ornamental')) return 'tree_shrub';
  if (raw.includes('mosquito')) return 'mosquito';
  if (raw.includes('termite') && raw.includes('bait')) return 'termite_bait';
  return raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Combined-service routing (combined-service-completions.md cutover): the
// owner-named pairs complete as ONE service, ONE submission, ONE report. At
// accept, when an estimate carries both lines of a pair AND their visit
// cadences match, the converter schedules ONE combined service — the
// combined catalog name resolves to the combined completion profile
// (primary flow + companion section). Mismatched cadences stay separate
// rows: a monthly pest visit can't absorb a quarterly bait check.
//
// Pricing, WaveGuard tier counting, and billing all read the ESTIMATE
// lines, which this never touches — combining is purely how the sold work
// is scheduled. Route order is precedence: a pest line combines with at
// most ONE companion (rodent bait first), the other stays standalone.
const COMBINED_SERVICE_ROUTES = [
  {
    primaryKey: 'pest_control',
    companionKey: 'rodent_bait',
    catalogServiceKey: 'pest_rodent_quarterly',
    name: 'Pest & Rodent Control',
    // Rodent bait stations are a quarterly program platform-wide
    // (rodent_bait_quarterly); server-priced estimates persist the line
    // with no cadence of its own.
    companionDefaultPattern: 'quarterly',
    // For PEST plans the accepted customerSelection.frequency IS the visit
    // cadence the customer chose (quarterly/bimonthly/monthly plan) and
    // beats stale quote-time line cadence. NOT true for lawn, where the
    // selection stores the BILLING cadence.
    primaryUsesAcceptFrequency: true,
  },
  {
    primaryKey: 'pest_control',
    companionKey: 'termite_bait',
    catalogServiceKey: 'pest_termite_bait_quarterly',
    name: 'Quarterly Pest + Termite Bait Station',
    // Termite bait station checks are quarterly (termite_active_bait_*);
    // the v1 mapper persists "Termite Bait" with no frequency/visits.
    companionDefaultPattern: 'quarterly',
    primaryUsesAcceptFrequency: true,
  },
  {
    primaryKey: 'lawn_care',
    companionKey: 'tree_shrub',
    catalogServiceKey: 'lawn_tree_shrub_combo',
    name: 'Lawn + Tree & Shrub',
    // Pattern equality is NOT enough here: the bimonthly bucket spans 6–11
    // visits/year, so a 9-app lawn and a 6-visit T&S program would pattern
    // as equal. Lawn tiers (6/9/12 apps) and the T&S visit mandate (4x/6x)
    // must agree EXACTLY — both lines need explicit, equal visits-per-year.
    requireVisitsMatch: true,
  },
];

// EXPLICIT service-level cadence only: frequency-ish fields, visit counts,
// or pattern text in the display name. Deliberately NO platform defaults —
// "pest defaults to quarterly" must not bypass the cadence gate for a
// legacy monthly program (Codex P2), and the accept-level billing fallback
// must not override an explicit 4x/6x line (pre-push P1).
function explicitServiceCadence(svc = {}) {
  const fromFields = [svc.frequency, svc.frequencyKey, svc.frequency_key, svc.recurringPattern, svc.recurring_pattern]
    .map((value) => RecurringAppointmentSeeder.normalizeRecurringPattern(value))
    .find(Boolean);
  if (fromFields) return fromFields;
  const visits = visitsPerYearForRecurringService(svc);
  if (visits) return RecurringAppointmentSeeder.patternFromVisitsPerYear(visits);
  return [svc.label, svc.name, svc.displayName, svc.service_type]
    .map((value) => RecurringAppointmentSeeder.normalizeRecurringPattern(value))
    .find(Boolean) || null;
}

// Server-priced estimates persist rodent bait OUTSIDE recurring.services —
// it rides result.recurring.rodentBaitMo / results.rodBaitMo (the same
// fields estimate-public's recurringServicesWithSupplements reads). Surface
// it to the matcher as a synthetic companion line; supplements never got
// their own scheduled row from the converter, so the combined row is
// strictly added coverage.
function supplementalCompanionLines(estimateData = {}) {
  const result = estimateData.result || {};
  const recurring = estimateData.recurring || result.recurring || {};
  const resultStats = estimateData.results || result.results || {};
  const lines = [];
  const rodentMonthly = firstPositiveNumber(recurring.rodentBaitMo, resultStats.rodBaitMo);
  if (rodentMonthly) {
    lines.push({ name: 'Rodent Bait Stations', service: 'rodent_bait', monthly: rodentMonthly });
  }
  return lines;
}

function combineRecurringServicesForScheduling(recurringServices = [], opts = {}) {
  const { acceptFrequency = null, supplementalCompanions = [] } = opts;
  const remaining = Array.isArray(recurringServices) ? recurringServices.slice() : [];
  const supplements = Array.isArray(supplementalCompanions) ? supplementalCompanions : [];
  const acceptPattern = RecurringAppointmentSeeder.normalizeRecurringPattern(acceptFrequency);
  const combos = [];
  for (const route of COMBINED_SERVICE_ROUTES) {
    const primaryIdx = remaining.findIndex((svc) => recurringServiceKey(svc) === route.primaryKey);
    if (primaryIdx === -1) continue;
    // Companion may live in recurring.services OR ride as a supplement.
    let companionIdx = remaining.findIndex((svc) => recurringServiceKey(svc) === route.companionKey);
    const companionFromSupplement = companionIdx === -1
      ? supplements.find((svc) => recurringServiceKey(svc) === route.companionKey) || null
      : null;
    const primary = remaining[primaryIdx];
    const companion = companionIdx !== -1 ? remaining[companionIdx] : companionFromSupplement;
    if (!companion) continue;
    // Cadence resolution is role-aware:
    //  - PEST PRIMARY (primaryUsesAcceptFrequency): the ACCEPTED plan
    //    selection wins — it is the customer's FINAL visit-cadence choice,
    //    and the persisted line can carry stale quote-time frequency/visits
    //    (a quarterly quote switched to monthly at accept must not combine
    //    quarterly — pre-push P1). Line cadence is the fallback.
    //  - LAWN PRIMARY: explicit line cadence/visits ONLY —
    //    customerSelection.frequency stores the BILLING cadence for lawn
    //    tiers (commonly monthly), not the visit cadence (pre-push P1).
    //  - COMPANION: explicit line cadence, else the route's program default
    //    (bait-station programs are quarterly regardless of how the pest
    //    plan bills) — NEVER the accepted selection.
    //  - nothing resolvable → no combine.
    const primaryPattern = (route.primaryUsesAcceptFrequency && acceptPattern)
      ? acceptPattern
      : explicitServiceCadence(primary);
    const companionPattern = explicitServiceCadence(companion) || route.companionDefaultPattern || null;
    if (!primaryPattern || !companionPattern || primaryPattern !== companionPattern) continue;
    // Visits-per-year guards (pre-push P1): patternFromVisitsPerYear buckets
    // are coarse, so explicit visit counts are the cadence truth when known.
    const primaryVisits = visitsPerYearForRecurringService(primary);
    const companionVisits = visitsPerYearForRecurringService(companion);
    if (primaryVisits && companionVisits && primaryVisits !== companionVisits) continue;
    if (route.requireVisitsMatch && !(primaryVisits && companionVisits)) continue;
    // Remove combined lines from remaining (higher index first so the lower
    // stays valid); a supplement was never in remaining.
    const removeIdxs = [primaryIdx, companionIdx].filter((idx) => idx !== -1).sort((a, b) => b - a);
    for (const idx of removeIdxs) remaining.splice(idx, 1);
    combos.push({
      route,
      frequency: primaryPattern,
      combinedFrom: [primary, companion],
      // The synthetic line the scheduling loop consumes: carries the
      // combined catalog name (profile resolution) and explicit frequency
      // so no downstream inference re-derives cadence from the name.
      service: {
        name: route.name,
        frequency: primaryPattern,
        combinedCatalogServiceKey: route.catalogServiceKey,
        visitsPerYear: firstPositiveNumber(
          visitsPerYearForRecurringService(primary),
          visitsPerYearForRecurringService(companion),
        ),
      },
    });
  }
  return { remaining, combos };
}

// A reserved (customer-picked) first appointment must reflect the same
// combined decision as the auto-schedule path — otherwise the slot row
// keeps the standalone primary name and every follow-up it seeds misses
// the companion section (pre-push P1). A rewrite is safe ONLY when exactly
// one reserved row maps to a combo's primary or companion key: with both
// halves separately reserved, rewriting either would double-cover the
// work, so both stay standalone.
function reservedRowComboRewrites(reservedRows = [], combos = []) {
  const rewrites = [];
  for (const combo of combos) {
    const matching = reservedRows.filter((row) => {
      const key = recurringServiceKey({ name: row.service_type });
      return key === combo.route.primaryKey || key === combo.route.companionKey;
    });
    if (matching.length === 1) rewrites.push({ row: matching[0], combo });
  }
  return rewrites;
}

function serviceCountsTowardWaveGuardTier(svc = {}) {
  if (svc.waveGuardTierEligible === false || svc.countsTowardWaveGuardTier === false) return false;
  return WAVEGUARD.qualifyingServices.includes(recurringServiceKey(svc));
}

function countTierQualifyingRecurringServices(services = []) {
  const seen = new Set();
  for (const svc of services) {
    if (!serviceCountsTowardWaveGuardTier(svc)) continue;
    const key = recurringServiceKey(svc);
    if (key) seen.add(key);
  }
  return seen.size;
}

function hasWaveGuardSetupService(services = []) {
  return shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices: services });
}

function calculateAnnualPrepayAmount(monthlyRate) {
  return Math.round((parseFloat(monthlyRate || 0) || 0) * 12 * 100) / 100;
}

function roundMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0;
}

function resolveFirstApplicationAmount({
  firstApplicationAmount,
  billingCadence,
  monthlyRate,
  allowFallback = true,
} = {}) {
  const explicit = roundMoney(firstApplicationAmount);
  if (explicit > 0) return explicit;
  if (allowFallback === false) return 0;
  const cadenceAmount = roundMoney(billingCadence?.amount);
  if (cadenceAmount > 0) return cadenceAmount;
  return roundMoney(monthlyRate);
}

function canAutoSendDraftInvoice({ billingTerm = 'standard', annualPrepayTermId = null } = {}) {
  return billingTerm !== 'prepay_annual' || !!annualPrepayTermId;
}

function shouldAttachScheduledServiceToStandardDraftInvoice({
  firstApplicationAmount,
  firstScheduledServiceId,
} = {}) {
  return !!firstScheduledServiceId && roundMoney(firstApplicationAmount) > 0;
}

function normalizeEstimateData(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value;
}

function estimateLineItemsFromData(estimateData = {}) {
  const data = normalizeEstimateData(estimateData);
  return data.lineItems
    || data.result?.lineItems
    || data.engineResult?.lineItems
    || data.estimate?.lineItems
    || [];
}

function estimateOneTimeItemsFromData(estimateData = {}) {
  const data = normalizeEstimateData(estimateData);
  const result = data.result && typeof data.result === 'object' ? data.result : data;
  const oneTime = result.oneTime && typeof result.oneTime === 'object' ? result.oneTime : {};
  const nestedOneTime = result.results?.oneTime && typeof result.results.oneTime === 'object'
    ? result.results.oneTime
    : {};
  const rows = [
    ...(Array.isArray(oneTime.items) ? oneTime.items : []),
    ...(Array.isArray(oneTime.specItems) ? oneTime.specItems : []),
    ...(Array.isArray(nestedOneTime.items) ? nestedOneTime.items : []),
    ...(Array.isArray(nestedOneTime.specItems) ? nestedOneTime.specItems : []),
    ...(Array.isArray(result.specItems) ? result.specItems : []),
    ...(Array.isArray(data.one_time?.items) ? data.one_time.items : []),
    ...(Array.isArray(data.oneTimeItems) ? data.oneTimeItems : []),
  ].filter((item) => item && item.onProg !== true && item.includedOnProgram !== true);
  const seen = new Set();
  return rows.filter((item) => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

function oneTimeRawText(item = {}) {
  return [item.service, item.name, item.displayName, item.label]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
}

function isIgnorableSetupOneTimeItem(item = {}) {
  const service = String(item.service || '').toLowerCase();
  const raw = oneTimeRawText(item);
  return !raw
    || service === 'waveguard_setup'
    || service === 'one_time_adjustment'
    || service === 'rodent_bundle_discount'
    || raw.includes('waveguard setup')
    || raw.includes('membership');
}

function isGeneralPestOneTimeItem(item = {}) {
  const service = String(item.service || '').toLowerCase();
  if (service === 'one_time_pest' || service === 'pest_control') return true;
  if (service === 'german_roach') return false;
  const raw = oneTimeRawText(item);
  if (/roach|cockroach|wasp|bee|hornet|stinging|exclusion|flea|bed\s*bug|termite|rodent|wdo|mosquito|tree|shrub|lawn/.test(raw)) return false;
  return /pest|\bant\b/.test(raw);
}

function isLawnCareOneTimeItem(item = {}) {
  if (isIgnorableSetupOneTimeItem(item)) return true;
  return /\blawn|turf|weed|fertili[sz]|chinch|fung/.test(oneTimeRawText(item));
}

function isTermiteBaitOneTimeItem(item = {}) {
  if (isIgnorableSetupOneTimeItem(item)) return true;
  const service = String(item.service || '').toLowerCase();
  const raw = oneTimeRawText(item);
  return service === 'termite_bait'
    || service.includes('termite_bait')
    || (raw.includes('termite') && /(bait|station|install|trelona|advance)/.test(raw));
}

function shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices = [], estimateData = {} } = {}) {
  const recurring = Array.isArray(recurringServices) ? recurringServices : [];
  if (recurring.length === 0) return false;
  // Existing customers never pay the WaveGuard setup again — mirrors the
  // public estimate page, which shows the fee struck through as waived.
  const data = normalizeEstimateData(estimateData);
  if (data.membershipSnapshot && data.membershipSnapshot.isExistingCustomer) return false;
  const keys = recurring.map(recurringServiceKey).filter(Boolean);
  if (keys.includes('pest_control')) return true;

  const oneTimeItems = estimateOneTimeItemsFromData(estimateData);
  const hasPestOneTime = oneTimeItems.some(isGeneralPestOneTimeItem);
  if (hasPestOneTime) return false;

  if (keys.every((key) => key === 'lawn_care')) {
    return oneTimeItems.every(isLawnCareOneTimeItem);
  }
  if (keys.every((key) => key === 'termite_bait')) {
    return oneTimeItems.every(isTermiteBaitOneTimeItem);
  }
  return false;
}

function isNonDiscountableRecurringLine(item = {}) {
  const annual = Number(item.annualAfterDiscount ?? item.annualAfterCredits ?? item.annual ?? item.ann ?? 0);
  if (recurringServiceKey(item) === 'lawn_care') return false;
  return annual > 0 && (
    item.discountable === false ||
    item.discount?.discountable === false ||
    item.discount?.policy === 'LAWN_V2_NET_55_FLOOR_PRICE'
  );
}

function nonDiscountableRecurringAnnualFloor(estimateData = {}) {
  return Math.round(estimateLineItemsFromData(estimateData)
    .filter(isNonDiscountableRecurringLine)
    .reduce((sum, item) => {
      const amount = Number(item.annualAfterDiscount ?? item.annualAfterCredits ?? item.annual ?? item.ann ?? 0);
      return sum + (Number.isFinite(amount) && amount > 0 ? amount : 0);
    }, 0) * 100) / 100;
}

function resolveAnnualPrepayDraftAmount({ prepayInvoiceAmount, annualTotal, monthlyRate } = {}) {
  const explicit = parseFloat(prepayInvoiceAmount);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit * 100) / 100;
  const annual = parseFloat(annualTotal);
  if (Number.isFinite(annual) && annual > 0) return Math.round(annual * 100) / 100;
  return calculateAnnualPrepayAmount(monthlyRate);
}

function shouldCreateDraftInvoiceForRecurring({ billingTerm = 'standard', recurringServices = [] } = {}) {
  if (!Array.isArray(recurringServices) || recurringServices.length === 0) return false;
  if (billingTerm === 'prepay_annual') return true;
  return true;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function visitsPerYearForRecurringService(svc = {}) {
  return firstPositiveNumber(
    svc.visitsPerYear,
    svc.appsPerYear,
    svc.visits,
    svc.apps,
    svc.treatmentsPerYear,
  );
}

function durationMinutesForRecurringService(svc = {}, pattern = null, parentRow = {}) {
  // Combined synthetic lines carry the catalog row's duration explicitly
  // (e.g. Pest + Termite Bait at 75min) — that beats the pest-quarterly
  // default so combined follow-ups inherit the right visit length.
  const explicit = firstPositiveNumber(svc.estimatedDurationMinutes, svc.estimated_duration_minutes);
  if (explicit) return explicit;
  const serviceKey = RecurringAppointmentSeeder.serviceKeyFor(svc);
  const parentKey = RecurringAppointmentSeeder.serviceKeyFor({ service_type: parentRow.service_type });
  const key = serviceKey && serviceKey !== 'service' ? serviceKey : parentKey;
  if (key === 'pest_control' && pattern === 'quarterly') return 60;
  return null;
}

function recurringServiceForScheduledRow(recurringServices = [], scheduledRow = {}) {
  const rowKey = RecurringAppointmentSeeder.serviceKeyFor({ service_type: scheduledRow.service_type });
  return recurringServices.find((svc) => RecurringAppointmentSeeder.serviceKeyFor(svc) === rowKey)
    || recurringServices.find((svc) => recurringServiceKey(svc) === 'pest_control')
    || recurringServices[0]
    || { service_type: scheduledRow.service_type };
}

function supportsConverterFollowUpSeeding(svc = {}, parentRow = {}, pattern = null) {
  const serviceKey = RecurringAppointmentSeeder.serviceKeyFor(svc);
  const parentKey = RecurringAppointmentSeeder.serviceKeyFor({ service_type: parentRow.service_type });
  const key = serviceKey && serviceKey !== 'service' ? serviceKey : parentKey;
  return key === 'pest_control' && pattern === 'quarterly';
}

function scheduledDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function registerSeededFollowUpReminders(rows = [], customerId) {
  const followUps = Array.isArray(rows) ? rows.filter((row) => row?.id) : [];
  if (!followUps.length || !customerId) return;
  try {
    const AppointmentReminders = require('./appointment-reminders');
    for (const row of followUps) {
      const scheduledDate = scheduledDateOnly(row.scheduled_date);
      if (!scheduledDate || !row.window_start) continue;
      const windowStart = String(row.window_start).slice(0, 5);
      await AppointmentReminders.registerAppointment(
        row.id,
        customerId,
        `${scheduledDate}T${windowStart}`,
        row.service_type || 'Quarterly Pest Control',
        'estimate_followup',
        { sendConfirmation: false },
      );
    }
  } catch (err) {
    logger.error(`[estimate-converter] Failed to register follow-up reminders: ${err.message}`);
  }
}

async function seedRecurringFollowUpsForParent(database, parentRow, svc = {}, opts = {}) {
  const pattern = RecurringAppointmentSeeder.inferRecurringPattern({
    service: { ...svc, service_type: parentRow?.service_type },
    fallbackFrequency: opts.fallbackFrequency,
  });
  if (!pattern) return { pattern: null, insertedCount: 0, insertedRows: [] };
  if (!supportsConverterFollowUpSeeding(svc, parentRow, pattern)) {
    return { pattern, insertedCount: 0, insertedRows: [] };
  }
  const visitsPerYear = visitsPerYearForRecurringService(svc);
  const serviceDurationMinutes = durationMinutesForRecurringService(svc, pattern, parentRow);
  const seedResult = await RecurringAppointmentSeeder.seedFollowUpsForParent(database, parentRow, {
    pattern,
    visitsPerYear,
    skipWeekends: true,
    weekendShift: 'forward',
    durationMinutes: serviceDurationMinutes || parentRow?.estimated_duration_minutes || undefined,
  });
  await registerSeededFollowUpReminders(seedResult.insertedRows, parentRow.customer_id);
  return seedResult;
}

const EstimateConverter = {
  /**
   * Convert an accepted estimate into an active customer with scheduled services.
   * @param {number} estimateId - The ID of the accepted estimate
   * @param {object} [opts]
   * @param {'standard'|'prepay_annual'} [opts.billingTerm='standard'] — when
   *   'prepay_annual', an invoice is created for the accepted annual total and
   *   the $99 WaveGuard setup fee is WAIVED. When 'standard', an invoice is
   *   created for the setup fee plus the accepted first application amount.
   *   Public accepts auto-send the invoice unless opts.autoSendInvoice is false.
   * @returns {object} Conversion result summary
   */
  async convertEstimate(estimateId, opts = {}) {
    const billingTerm = opts.billingTerm === 'prepay_annual' ? 'prepay_annual' : 'standard';
    const skipSetupInvoice = opts.skipSetupInvoice === true;
    const autoSendInvoice = opts.autoSendInvoice !== false;
    // Manual Mark Won path passes skipAutoSchedule=true — Adam wants to
    // schedule the visit himself on the calendar rather than have the
    // converter auto-pick the next feasible zone date. Self-accept paths
    // still auto-schedule when there's no reservation row.
    const skipAutoSchedule = opts.skipAutoSchedule === true;
    const database = opts.database || db;
    const estimate = await database('estimates').where({ id: estimateId }).first();
    if (!estimate) throw new Error(`Estimate ${estimateId} not found`);
    if (estimate.status !== 'accepted') throw new Error(`Estimate ${estimateId} is not accepted (status: ${estimate.status})`);
    if (!estimate.customer_id) throw new Error(`Estimate ${estimateId} has no linked customer`);

    const customerId = estimate.customer_id;
    const customer = await database('customers').where({ id: customerId }).first();
    if (!customer) throw new Error(`Customer ${customerId} not found`);

    // Parse estimate data
    let estimateData = estimate.estimate_data;
    if (typeof estimateData === 'string') {
      try { estimateData = JSON.parse(estimateData); } catch { estimateData = {}; }
    }
    estimateData = estimateData || {};

    // Count recurring services for scheduling, but only tier-qualifying rows
    // for WaveGuard tier activation. Palm Injection and Rodent Bait Stations
    // are recurring services, but they are excluded from WaveGuard tier count
    // and percentage discounts in the pricing engine.
    // V2 pricing-engine estimates store services at estimate_data.result.recurring.services,
    // while older shapes use estimate_data.recurring.services or a flat estimate_data.services.
    // Without the result.* fallback, V2 estimates resolved to 0 services → tier='none' →
    // CHECK constraint violation on customers.waveguard_tier and the whole accept rolled back.
    const recurringServices =
      estimateData.recurring?.services
      || estimateData.result?.recurring?.services
      || estimateData.services?.filter(s => s.recurring || s.frequency)
      || [];
    const serviceCount = countTierQualifyingRecurringServices(recurringServices);
    const shouldCreateDraftInvoice = shouldCreateDraftInvoiceForRecurring({
      billingTerm,
      recurringServices,
    });

    // Determine tier
    const { tier, discount } = determineTier(serviceCount, recurringServices.length > 0);

    // Calculate monthly rate from estimate
    const monthlyRate = parseFloat(estimate.monthly_total || 0);
    const inferredFrequencyKey = estimateData.customerSelection?.frequency
      || inferFrequencyKeyFromEstimateData(estimateData);
    const billingCadence = inferredFrequencyKey
      ? resolveBillingCadence({
          monthlyRate,
          frequencyKey: inferredFrequencyKey,
          estimateData,
          fallbackFrequencyKey: inferredFrequencyKey,
        })
      : null;

    // 1. Update customer to active. Clear deleted_at: admin screens filter
    //    on whereNull('deleted_at'), so reactivating a soft-deleted customer
    //    without clearing it would create an actively-billed customer no
    //    admin screen can display.
    await database('customers').where({ id: customerId }).update({
      pipeline_stage: 'active_customer',
      pipeline_stage_changed_at: new Date(),
      waveguard_tier: tier,
      monthly_rate: monthlyRate,
      active: true,
      deleted_at: null,
    });

    // 2. Create scheduled_services for recurring services — but ONLY if
    //    the accept path didn't already create one via slot reservation
    //    (PR B.1). The reservation path commits a scheduled_services row
    //    inside the accept transaction with source_estimate_id set to
    //    this estimate. When that row exists, the customer has already
    //    picked + committed a specific slot — overwriting with our
    //    auto-picked "first available date" would destroy their choice
    //    and silently re-slot them.
    //
    //    All recurring services for this new customer bundle onto the same
    //    first date — they'll be done on one visit. Pick a date where a tech
    //    is already working the zone (falls back safely if we can't resolve).
    let scheduledCount = 0;
    let termStartDate = null;
    let firstScheduledServiceId = null;
    const existingFromReservation = await database('scheduled_services')
      .where({ source_estimate_id: estimateId })
      .whereNotNull('customer_id')
      .whereNull('reservation_expires_at')
      .count('id as count')
      .first();
    const reservationRowsExist = Number(existingFromReservation?.count || 0) > 0;

    if (reservationRowsExist) {
      logger.info(
        `[estimate-converter] Skipping auto-schedule for estimate ${estimateId} — ` +
        `reservation path already created ${existingFromReservation.count} scheduled_services row(s)`
      );
      const reservedRows = await database('scheduled_services')
        .where({ source_estimate_id: estimateId })
        .whereNotNull('customer_id')
        .whereNull('reservation_expires_at')
        .orderBy('scheduled_date', 'asc');
      const reservedStart = reservedRows[0] || null;
      termStartDate = reservedStart?.scheduled_date || null;
      firstScheduledServiceId = reservedStart?.id || null;
      scheduledCount = Number(existingFromReservation?.count || 0);

      // Combined routing reaches reserved rows too: rewrite the slot row to
      // the combined service (type/service_id/duration — the customer's
      // picked date and window are untouched) so the first visit and every
      // follow-up it seeds resolve the companion profile.
      //
      // ADJUDICATED (pre-push P1, 2026-06-12): non-combined `remaining`
      // lines are NOT scheduled here. The reservation branch has never
      // auto-scheduled lines beyond the reserved row (see the "Skipping
      // auto-schedule" log above — established platform semantic predating
      // combined routing); combining strictly improves coverage by making
      // the rewritten row span two lines. Aligning multi-service reserved
      // accepts with the auto-schedule path is a separate owner decision.
      let reservedSeedSvc = null;
      try {
        const { combos } = combineRecurringServicesForScheduling(recurringServices, {
          acceptFrequency: inferredFrequencyKey,
          supplementalCompanions: supplementalCompanionLines(estimateData),
        });
        for (const { row, combo } of reservedRowComboRewrites(reservedRows, combos)) {
          const update = { service_type: combo.route.name, updated_at: new Date() };
          try {
            const catalogRow = await database('services')
              .where({ service_key: combo.route.catalogServiceKey })
              .first('id', 'default_duration_minutes');
            if (catalogRow) {
              update.service_id = catalogRow.id;
              if (catalogRow.default_duration_minutes) {
                update.estimated_duration_minutes = catalogRow.default_duration_minutes;
                combo.service.estimatedDurationMinutes = catalogRow.default_duration_minutes;
              }
            }
          } catch (lookupErr) {
            logger.warn(`[estimate-converter] combined catalog lookup failed for ${combo.route.catalogServiceKey}: ${lookupErr.message}`);
          }
          await database('scheduled_services').where({ id: row.id }).update(update);
          // The public accept route registers the 72h/24h reminder BEFORE
          // convertEstimate runs and appointment_reminders persists its own
          // service_type — relabel it too or the reminder texts the
          // standalone name (pre-push P1). Fail-soft: a reminder row may
          // legitimately not exist yet.
          try {
            await database('appointment_reminders')
              .where({ scheduled_service_id: row.id })
              .update({ service_type: combo.route.name, updated_at: new Date() });
          } catch (reminderErr) {
            logger.warn(`[estimate-converter] reminder relabel failed for reserved row ${row.id}: ${reminderErr.message}`);
          }
          row.service_type = combo.route.name;
          if (reservedStart && row.id === reservedStart.id) {
            reservedStart.service_type = combo.route.name;
            reservedSeedSvc = combo.service;
          }
          logger.info(`[estimate-converter] reserved row ${row.id} combined → "${combo.route.name}" (picked slot preserved)`);
        }
      } catch (comboErr) {
        logger.warn(`[estimate-converter] combined routing on reserved rows failed: ${comboErr.message}`);
      }

      if (reservedStart) {
        try {
          const seedSvc = reservedSeedSvc || recurringServiceForScheduledRow(recurringServices, reservedStart);
          const seedResult = await seedRecurringFollowUpsForParent(database, reservedStart, seedSvc, {
            fallbackFrequency: inferredFrequencyKey,
          });
          scheduledCount += seedResult.insertedCount || 0;
        } catch (seedErr) {
          logger.error(`[estimate-converter] Failed to seed recurring follow-ups for estimate ${estimateId}: ${seedErr.message}`);
        }
      }
    } else if (skipAutoSchedule) {
      logger.info(
        `[estimate-converter] Skipping auto-schedule for estimate ${estimateId} — ` +
        `skipAutoSchedule=true (manual Mark Won)`,
      );
    } else {
      const firstServiceDate = await pickFirstServiceDate(customer, estimateId);
      termStartDate = firstServiceDate;

      // Combined-service routing: matching-cadence pairs schedule as ONE
      // combined service; everything else flows through unchanged.
      const { remaining, combos } = combineRecurringServicesForScheduling(recurringServices, {
        acceptFrequency: inferredFrequencyKey,
        supplementalCompanions: supplementalCompanionLines(estimateData),
      });
      const scheduleUnits = [
        ...combos.map((combo) => ({ svc: combo.service, combo })),
        ...remaining.map((svc) => ({ svc })),
      ];
      for (const unit of scheduleUnits) {
        const svc = unit.svc;
        let combinedServiceId = null;
        if (unit.combo) {
          // service_id makes profile resolution sturdy against later
          // renames; name-based resolution still works without it, so a
          // missing catalog row (env not yet migrated) degrades safely.
          try {
            const catalogRow = await database('services')
              .where({ service_key: unit.combo.route.catalogServiceKey })
              .first('id', 'default_duration_minutes');
            if (catalogRow) {
              combinedServiceId = catalogRow.id;
              if (catalogRow.default_duration_minutes) {
                svc.estimatedDurationMinutes = catalogRow.default_duration_minutes;
              }
            } else {
              logger.warn(`[estimate-converter] combined catalog row ${unit.combo.route.catalogServiceKey} absent — scheduling by name only`);
            }
          } catch (lookupErr) {
            logger.warn(`[estimate-converter] combined catalog lookup failed for ${unit.combo.route.catalogServiceKey}: ${lookupErr.message}`);
          }
        }
        const serviceName = svc.name || svc.serviceName || svc.service_name || 'Service';
        const pattern = RecurringAppointmentSeeder.inferRecurringPattern({
          service: svc,
          fallbackFrequency: inferredFrequencyKey,
        });
        const frequency = svc.frequency || pattern || 'monthly';
        const estimatedPrice = billingCadence && recurringServices.length === 1
          ? billingCadence.amount
          : null;
        const durationMinutes = durationMinutesForRecurringService(svc, pattern);

        try {
          const combinedNote = unit.combo
            ? ` Combined service: ${unit.combo.combinedFrom
              .map((s) => s.name || s.serviceName || s.service_name || recurringServiceKey(s))
              .join(' + ')} — one visit, one report.`
            : '';
          const row = {
            customer_id: customerId,
            scheduled_date: firstServiceDate,
            service_type: serviceName,
            status: 'pending',
            notes: `Auto-scheduled from estimate #${estimateId}. Frequency: ${frequency}.${combinedNote}`,
            source_estimate_id: estimateId,
          };
          if (combinedServiceId) row.service_id = combinedServiceId;
          if (estimatedPrice) row.estimated_price = estimatedPrice;
          if (durationMinutes) row.estimated_duration_minutes = durationMinutes;
          const inserted = await database('scheduled_services').insert(row).returning('*');
          const insertedId = Array.isArray(inserted)
            ? (typeof inserted[0] === 'object' ? inserted[0]?.id : inserted[0])
            : (typeof inserted === 'object' ? inserted?.id : inserted);
          if (!firstScheduledServiceId && insertedId) firstScheduledServiceId = insertedId;
          const parentRow = Array.isArray(inserted) && typeof inserted[0] === 'object'
            ? inserted[0]
            : { ...row, id: insertedId };
          let insertedFollowUps = 0;
          try {
            const seedResult = await seedRecurringFollowUpsForParent(database, parentRow, svc, {
              fallbackFrequency: inferredFrequencyKey,
            });
            insertedFollowUps = seedResult.insertedCount || 0;
          } catch (seedErr) {
            logger.error(`[estimate-converter] Failed to seed recurring follow-ups for estimate ${estimateId}: ${seedErr.message}`);
          }
          scheduledCount += 1 + insertedFollowUps;
        } catch (e) {
          logger.error(`[estimate-converter] Failed to create scheduled_service: ${e.message}`);
        }
      }
    }

    // 3. Log conversion in activity_log
    await database('activity_log').insert({
      customer_id: customerId,
      action: 'estimate_converted',
      description: `Estimate #${estimateId} converted: ${customer.first_name} ${customer.last_name} → WaveGuard ${tier} at $${monthlyRate.toFixed(2)}/mo (${serviceCount} services, ${scheduledCount} scheduled)`,
      metadata: JSON.stringify({
        estimateId, tier, discount, monthlyRate, serviceCount, scheduledCount, firstScheduledServiceId,
      }),
    });

    // 4. Create the setup/prepay invoice. Public accepts auto-send it and
    //    return the pay URL; admin/manual conversion can disable auto-send.
    //    Standard pay-per-application invoices include first app and the
    //    setup line only when the public estimate displayed that setup fee.
    let draftInvoiceId = null;
    let draftInvoiceAmount = null;
    let draftInvoicePayUrl = null;
    let invoiceDelivery = null;
    let annualPrepayTermId = null;
    try {
      const annualPrepayAmountRaw = resolveAnnualPrepayDraftAmount({
        prepayInvoiceAmount: opts.prepayInvoiceAmount,
        annualTotal: estimate.annual_total,
        monthlyRate,
      });
      const nonDiscountableFloor = nonDiscountableRecurringAnnualFloor(estimateData);
      const annualPrepayAmount = billingTerm === 'prepay_annual'
        ? Math.max(annualPrepayAmountRaw, nonDiscountableFloor)
        : annualPrepayAmountRaw;
      const standardFirstApplicationAmount = billingTerm === 'standard'
        ? resolveFirstApplicationAmount({
          firstApplicationAmount: opts.firstApplicationAmount,
          billingCadence,
          monthlyRate,
          allowFallback: opts.allowFirstApplicationFallback !== false,
        })
        : 0;
      const setupFeeApplies = billingTerm === 'standard'
        ? shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices, estimateData })
        : false;
      const hasDraftAmount = billingTerm === 'prepay_annual'
        ? annualPrepayAmount > 0
        : setupFeeApplies || standardFirstApplicationAmount > 0;
      if (hasDraftAmount && !skipSetupInvoice && shouldCreateDraftInvoice) {
        const InvoiceService = require('./invoice');
        if (billingTerm === 'prepay_annual') {
          const annualAmount = annualPrepayAmount;
          const termMonthlyRate = monthlyRate > 0
            ? monthlyRate
            : Math.round((annualAmount / 12) * 100) / 100;
          const inv = await InvoiceService.create({
            customerId,
            title: `WaveGuard ${tier || 'Bronze'} — Annual Prepay (12 months)`,
            lineItems: [{
              description: `WaveGuard Membership — 12 months prepaid (setup fee waived)`,
              quantity: 1,
              unit_price: annualAmount,
            }],
            notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected "Pay the year upfront" — $99 setup fee waived per WaveGuard membership policy.`,
            dueDate: etDateString(),
          });
          draftInvoiceId = inv?.id || null;
          draftInvoiceAmount = annualAmount;
          draftInvoicePayUrl = inv?.token ? `/pay/${inv.token}` : null;

          try {
            const AnnualPrepayRenewals = require('./annual-prepay-renewals');
            const annualPrepayTerm = await AnnualPrepayRenewals.createTermForAnnualPrepay({
              customerId,
              sourceEstimateId: estimateId,
              prepayInvoiceId: draftInvoiceId,
              planLabel: `WaveGuard ${tier || 'Bronze'} Annual Prepay`,
              monthlyRate: termMonthlyRate,
              prepayAmount: annualAmount,
              termStart: termStartDate || null,
            });
            if (!annualPrepayTerm?.id) {
              throw new Error('annual prepay term was not created');
            }
            annualPrepayTermId = annualPrepayTerm.id;
          } catch (termErr) {
            logger.error(`[estimate-converter] Annual prepay term creation failed for estimate ${estimateId}: ${termErr.message}`);
            if (draftInvoiceId) {
              try {
                await InvoiceService.voidInvoice(draftInvoiceId);
              } catch (voidErr) {
                logger.error(`[estimate-converter] Annual prepay invoice void failed for estimate ${estimateId}: ${voidErr.message}`);
              }
            }
            draftInvoiceId = null;
            draftInvoiceAmount = null;
            draftInvoicePayUrl = null;
          }
        } else {
          const firstApplicationAmount = standardFirstApplicationAmount;
          const includesFirstApplicationLine = firstApplicationAmount > 0;
          const scheduledServiceId = shouldAttachScheduledServiceToStandardDraftInvoice({
            firstApplicationAmount,
            firstScheduledServiceId,
          }) ? firstScheduledServiceId : undefined;
          const lineItems = [];
          if (setupFeeApplies) {
            lineItems.push({
              description: 'WaveGuard Membership — one-time setup fee',
              quantity: 1,
              unit_price: WAVEGUARD_SETUP_FEE,
            });
          }
          if (firstApplicationAmount > 0) {
            lineItems.push({
              description: 'First service application',
              quantity: 1,
              unit_price: firstApplicationAmount,
            });
          }
          // Acceptance deposit credits against this first invoice through
          // create()'s depositCredit param — create() caps the request
          // against its own post-discount, after-tax total (a pre-tax cap
          // here under-applied the credit on taxed or discounted invoices
          // and stranded the difference on the ledger) and reports the
          // effective amount back; any remainder stays on the deposit
          // ledger. ATOMIC: the credit line exists IFF the ledger consumed
          // exactly that amount in the same transaction — a consumption
          // failure or an allocation mismatch (a refund landed between read
          // and consume) rolls the invoice back, and one retry re-reads the
          // fresh, possibly shrunken balance. Never a discounted invoice
          // beside an unconsumed deposit row.
          const { pendingDepositCredit, consumeDepositCredit } = require('./estimate-deposits');
          const invoiceSubtotal = (setupFeeApplies ? WAVEGUARD_SETUP_FEE : 0) + firstApplicationAmount;
          const invoiceTitle = setupFeeApplies && includesFirstApplicationLine
            ? 'WaveGuard Membership Setup + First Application'
            : (setupFeeApplies ? 'WaveGuard Membership Setup' : 'First Service Application');
          const invoiceNotes = setupFeeApplies && includesFirstApplicationLine
            ? `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — $99 setup fee plus first application.`
            : (setupFeeApplies
                ? `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — $99 setup fee only.`
                : `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`);
          let inv = null;
          let appliedDepositCredit = 0;
          for (let attempt = 0; attempt < 2 && !inv; attempt += 1) {
            const depositCredit = await pendingDepositCredit(estimateId).catch(() => null);
            const requestedDepositCredit = depositCredit ? Number(depositCredit.amount) : 0;
            try {
              inv = await db.transaction(async (trx) => {
                const created = await InvoiceService.create({
                  database: trx,
                  customerId,
                  scheduledServiceId,
                  title: invoiceTitle,
                  lineItems,
                  notes: invoiceNotes,
                  dueDate: etDateString(),
                  ...(requestedDepositCredit > 0
                    ? { depositCredit: { amount: requestedDepositCredit, estimateId } }
                    : {}),
                });
                const effectiveDepositCredit = Number(created?.applied_deposit_credit) || 0;
                if (created?.id && effectiveDepositCredit > 0) {
                  const allocated = await consumeDepositCredit({
                    estimateId,
                    amount: effectiveDepositCredit,
                    invoiceId: created.id,
                    trx,
                  });
                  if (Math.round(allocated * 100) !== Math.round(effectiveDepositCredit * 100)) {
                    throw new Error(`deposit allocation mismatch (applied ${effectiveDepositCredit}, allocated ${allocated})`);
                  }
                }
                appliedDepositCredit = effectiveDepositCredit;
                return created;
              });
              if (inv && appliedDepositCredit > 0 && appliedDepositCredit < requestedDepositCredit) {
                logger.warn(`[estimate-converter] deposit partially applied for estimate ${estimateId}`, {
                  applied: appliedDepositCredit,
                  remainder: Math.round((requestedDepositCredit - appliedDepositCredit) * 100) / 100,
                });
              }
            } catch (err) {
              appliedDepositCredit = 0;
              if (attempt === 0) {
                logger.warn(`[estimate-converter] invoice+deposit transaction failed for estimate ${estimateId} — retrying with a fresh ledger read: ${err.message}`);
              } else {
                // The surrounding invoice block is best-effort (its outer
                // catch logs and continues), so a paid deposit could end up
                // accepted with no credit and no signal. Gate on the ledger
                // balance (not the applied amount — create() may have thrown
                // before reporting one) and raise an explicit reconciliation
                // hold for a human before this throw is swallowed.
                if (requestedDepositCredit > 0) {
                  try {
                    const { triggerNotification } = require('./notification-triggers');
                    await triggerNotification('estimate_deposit_reconcile_needed', { estimateId });
                  } catch (notifyErr) {
                    logger.error(`[estimate-converter] failed to raise deposit reconciliation alert for estimate ${estimateId}: ${notifyErr.message}`);
                  }
                }
                throw err;
              }
            }
          }
          draftInvoiceId = inv?.id || null;
          // The customer-facing amount is the invoice's actual after-tax,
          // after-credit total — the same figure the /pay page collects.
          draftInvoiceAmount = inv ? (Number(inv.total) || 0) : invoiceSubtotal;
          draftInvoicePayUrl = inv?.token ? `/pay/${inv.token}` : null;
        }
      }
      if (draftInvoiceId && autoSendInvoice && canAutoSendDraftInvoice({ billingTerm, annualPrepayTermId })) {
        try {
          const InvoiceService = require('./invoice');
          invoiceDelivery = await InvoiceService.sendViaSMSAndEmail(draftInvoiceId, {
            payUrlParams: {
              source: 'estimate',
              saveCard: '1',
              billingTerm,
            },
          });
        } catch (deliveryErr) {
          invoiceDelivery = {
            ok: false,
            sms: { ok: false },
            email: { ok: false },
            error: deliveryErr.message,
          };
          logger.error(`[estimate-converter] Draft invoice delivery failed for estimate ${estimateId}: ${deliveryErr.message}`);
        }
      }
    } catch (err) {
      // Don't let an invoice-creation failure block the conversion.
      // The accept route will fall back to office follow-up if this misfires.
      logger.error(`[estimate-converter] Draft invoice creation failed for estimate ${estimateId}: ${err.message}`);
    }

    logger.info(`[estimate-converter] Estimate ${estimateId} converted: customer ${customerId} → ${tier} tier, $${monthlyRate}/mo, ${scheduledCount} services scheduled, billingTerm=${billingTerm}, draftInvoiceId=${draftInvoiceId || 'none'}`);

    const membershipEmail = {
      customerId,
      effectiveDate: termStartDate || new Date(),
      sourceId: `estimate:${estimateId}`,
      membershipTier: tier,
      monthlyRate,
      billingCadence: billingCadence?.periodLabel || (billingTerm === 'prepay_annual' ? 'annual prepay' : 'monthly'),
      includedServices: recurringServices
        .map((svc) => svc.name || svc.serviceName || svc.service_name || svc.label)
        .filter(Boolean)
        .join(', '),
    };

    if (opts.skipMembershipEmail !== true) {
      void AccountMembershipEmail.sendMembershipStarted(membershipEmail)
        .catch((err) => logger.warn(`[estimate-converter] membership.started email failed for customer ${customerId}: ${err.message}`));
    }

    return {
      customerId,
      tier,
      discount,
      monthlyRate,
      serviceCount,
      scheduledCount,
      firstScheduledServiceId,
      billingTerm,
      draftInvoiceId,
      draftInvoiceAmount,
      draftInvoicePayUrl,
      invoiceDelivery,
      membershipEmail,
    };
  },
};

module.exports = EstimateConverter;
module.exports.calculateAnnualPrepayAmount = calculateAnnualPrepayAmount;
module.exports.countTierQualifyingRecurringServices = countTierQualifyingRecurringServices;
module.exports.determineTier = determineTier;
module.exports.hasWaveGuardSetupService = hasWaveGuardSetupService;
module.exports.nonDiscountableRecurringAnnualFloor = nonDiscountableRecurringAnnualFloor;
module.exports.recurringServiceKey = recurringServiceKey;
module.exports.combineRecurringServicesForScheduling = combineRecurringServicesForScheduling;
module.exports.reservedRowComboRewrites = reservedRowComboRewrites;
module.exports.explicitServiceCadence = explicitServiceCadence;
module.exports.supplementalCompanionLines = supplementalCompanionLines;
module.exports.COMBINED_SERVICE_ROUTES = COMBINED_SERVICE_ROUTES;
module.exports.durationMinutesForRecurringService = durationMinutesForRecurringService;
module.exports.resolveFirstApplicationAmount = resolveFirstApplicationAmount;
module.exports.resolveAnnualPrepayDraftAmount = resolveAnnualPrepayDraftAmount;
module.exports.canAutoSendDraftInvoice = canAutoSendDraftInvoice;
module.exports.shouldAttachScheduledServiceToStandardDraftInvoice = shouldAttachScheduledServiceToStandardDraftInvoice;
module.exports.serviceCountsTowardWaveGuardTier = serviceCountsTowardWaveGuardTier;
module.exports.shouldIncludeWaveGuardSetupFeeForRecurring = shouldIncludeWaveGuardSetupFeeForRecurring;
module.exports.shouldCreateDraftInvoiceForRecurring = shouldCreateDraftInvoiceForRecurring;
