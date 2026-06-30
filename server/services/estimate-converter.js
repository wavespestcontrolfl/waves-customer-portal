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
const { WAVEGUARD, ANNUAL_PREPAY_DISCOUNT_PCT } = require('./pricing-engine/constants');
const {
  inferFrequencyKeyFromEstimateData,
  resolveBillingCadence,
} = require('./billing-cadence');
const AccountMembershipEmail = require('./account-membership-email');
const {
  sendNewRecurringWelcome,
  isNewRecurringSignupCandidate,
} = require('./new-recurring-welcome-sms');
const { etDateString } = require('../utils/datetime-et');
const { normalizeGrassType } = require('./lawn-grass-context');

// Find the first grassType/grass_type string anywhere in the estimate data
// (confirmed primary path is inputs.grassType, but estimate shapes vary).
// Depth-capped to avoid pathological recursion.
function findGrassTypeDeep(node, depth = 6) {
  if (depth < 0 || node == null || typeof node !== 'object') return null;
  for (const k of ['grassType', 'grass_type']) {
    if (typeof node[k] === 'string' && node[k].trim()) return node[k];
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') {
      const found = findGrassTypeDeep(v, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

// Grass type to persist on estimate acceptance, or null. Gated on a LAWN service
// being present: the admin estimate form always saves grassType (defaulting to
// st_augustine even for pest-only accepts), so an ungated write would stamp a
// fake default turf profile on non-lawn customers.
function grassTypeToPersist(recurringServices, estimateData) {
  const hasLawn = (Array.isArray(recurringServices) ? recurringServices : [])
    .some((svc) => recurringServiceKey(svc) === 'lawn_care');
  return hasLawn ? normalizeGrassType(findGrassTypeDeep(estimateData)) : null;
}

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
  // NOT commercial — commercial_rodent_bait must reach the commercial block below
  // and keep its distinct (non-WaveGuard-discountable) key.
  if (
    !raw.includes('commercial') && (
      raw.includes('rodent_bait')
      || raw.includes('rodent_monitoring')
      || (raw.includes('rodent') && /bait|station|monitor/.test(raw))
    )
  ) return 'rodent_bait';
  // Commercial auto-priced lines keep a DISTINCT key — they must never be
  // classified as residential lawn_care/tree_shrub, which are discountable for
  // annual prepay (the flat commercial price would then get a 5% prepay cut).
  if (raw.includes('commercial')) {
    if (raw.includes('lawn') || raw.includes('turf')) return 'commercial_lawn';
    if (raw.includes('tree') || raw.includes('shrub') || raw.includes('ornamental')) return 'commercial_tree_shrub';
    if (raw.includes('mosquito')) return 'commercial_mosquito';
    if (raw.includes('termite')) return 'commercial_termite_bait';
    if (raw.includes('rodent')) return 'commercial_rodent_bait';
    if (raw.includes('pest')) return 'commercial_pest';
  }
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
    // A count that CONTRADICTS the line's resolved cadence is stale quote
    // debris — it neither blocks nor rides (an accepted quarterly plan with
    // a stale 12-visit pest line must still combine — pre-push P1).
    const primaryVisitsRaw = visitsPerYearForRecurringService(primary);
    const companionVisitsRaw = visitsPerYearForRecurringService(companion);
    const primaryVisits = primaryVisitsRaw
      && RecurringAppointmentSeeder.patternFromVisitsPerYear(primaryVisitsRaw) === primaryPattern
      ? primaryVisitsRaw
      : null;
    const companionVisits = companionVisitsRaw
      && RecurringAppointmentSeeder.patternFromVisitsPerYear(companionVisitsRaw) === companionPattern
      ? companionVisitsRaw
      : null;
    if (primaryVisits && companionVisits && primaryVisits !== companionVisits) continue;
    if (route.requireVisitsMatch && !(primaryVisits && companionVisits)) continue;
    // Remove combined lines from remaining (higher index first so the lower
    // stays valid); a supplement was never in remaining.
    const removeIdxs = [primaryIdx, companionIdx].filter((idx) => idx !== -1).sort((a, b) => b - a);
    for (const idx of removeIdxs) remaining.splice(idx, 1);
    // Only carry a visit count that AGREES with the resolved cadence — when
    // the accepted pattern overrode a stale line, that line's count would
    // over-seed follow-ups (12 visits at quarterly spacing — pre-push P1).
    // Omitted, the seeder uses the pattern's own visit default.
    const candidateVisits = firstPositiveNumber(primaryVisits, companionVisits);
    const consistentVisits = candidateVisits
      && RecurringAppointmentSeeder.patternFromVisitsPerYear(candidateVisits) === primaryPattern
      ? candidateVisits
      : null;
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
        ...(consistentVisits ? { visitsPerYear: consistentVisits } : {}),
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

function recurringServiceCadenceKey(svc = {}) {
  return String(
    svc.frequency
    || svc.frequencyKey
    || svc.frequency_key
    || svc.cadence
    || svc.planFrequency
    || svc.plan_frequency
    || svc.visitsPerYear
    || svc.appsPerYear
    || svc.visits
    || svc.apps
    || '',
  ).toLowerCase();
}

function recurringServiceIdentityKey(svc = {}) {
  const key = recurringServiceKey(svc);
  if (key) return key;
  const label = String(svc.service || svc.serviceName || svc.service_name || svc.name || svc.label || '').toLowerCase();
  return `${label}|${recurringServiceCadenceKey(svc)}`;
}

const RECURRING_DOLLAR_FIELDS = [
  'mo',
  'monthly',
  'monthlyTotal',
  'monthly_total',
  'monthlyBase',
  'monthlyAfterDiscount',
  'monthlyAfterCredits',
  'ann',
  'annual',
  'annualTotal',
  'annual_total',
  'annualAfterDiscount',
  'annualAfterCredits',
  'perTreatment',
  'perVisit',
  'perApp',
  'pa',
  'price',
];

function isBlankValue(value) {
  return value == null || value === '';
}

function coalesceRecurringServiceRows(existing = {}, next = {}) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(next)) {
    if (isBlankValue(merged[key]) && !isBlankValue(value)) {
      merged[key] = value;
    }
  }
  for (const field of RECURRING_DOLLAR_FIELDS) {
    if (firstPositiveNumber(next[field]) != null) {
      merged[field] = next[field];
    }
  }
  return merged;
}

function mergeRecurringServiceLists(...lists) {
  const byIdentity = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const svc of list) {
      if (!svc || typeof svc !== 'object') continue;
      const identity = recurringServiceIdentityKey(svc);
      const existing = byIdentity.get(identity);
      byIdentity.set(identity, existing ? coalesceRecurringServiceRows(existing, svc) : { ...svc });
    }
  }
  return [...byIdentity.values()];
}

// Priced recurring lines persisted under engineResult.lineItems (or
// result.lineItems). The quote-wizard / engine-backed save shape stores priced
// recurring services there with NO recurring.services block, so without this a
// lawn-only/tree-only commercial (or foam) estimate would convert with zero
// recurring services — no scheduling, no first-service invoice, and the
// Commercial non-member tier missed. Recurring lines carry an annual amount;
// one-time/specialty lines (price/total) and manual quotes are excluded.
// Raw engine lineItems often omit a display name (the pricers return a service
// key but no name). The scheduler falls back to 'Service' for nameless rows,
// which breaks dispatch/profile resolution — so synthesize a name from the
// canonical service key before these rows reach conversion.
const RECURRING_SERVICE_DISPLAY_NAMES = {
  pest_control: 'Pest Control',
  lawn_care: 'Lawn Care',
  tree_shrub: 'Tree & Shrub',
  mosquito: 'Mosquito',
  termite_bait: 'Termite Bait',
  foam_recurring: 'Recurring Foam Treatment',
  rodent_bait: 'Rodent Bait Stations',
  palm_injection: 'Palm Injection',
  commercial_lawn: 'Commercial Lawn Treatment',
  commercial_tree_shrub: 'Commercial Tree & Shrub',
  commercial_pest: 'Commercial Pest Control',
  commercial_mosquito: 'Commercial Mosquito',
  commercial_termite_bait: 'Commercial Termite Bait Monitoring',
  commercial_rodent_bait: 'Commercial Rodent Bait Stations',
};

function recurringLinesFromEngineResult(data = {}) {
  const lineItems = [
    ...(Array.isArray(data.engineResult?.lineItems) ? data.engineResult.lineItems : []),
    ...(Array.isArray(data.result?.lineItems) ? data.result.lineItems : []),
  ];
  return lineItems
    .filter((li) =>
      li
      && typeof li === 'object'
      && li.quoteRequired !== true
      && li.requiresManualReview !== true
      && Number(li.annual) > 0
    )
    .map((li) => {
      if (li.name || li.label || li.displayName || li.serviceName || li.service_name) return li;
      const synthesized = RECURRING_SERVICE_DISPLAY_NAMES[recurringServiceKey(li)];
      return synthesized ? { ...li, name: synthesized } : li;
    });
}

function recurringServicesFromEstimateData(estimateData = {}) {
  const data = normalizeEstimateData(estimateData);
  return mergeRecurringServiceLists(
    data.recurring?.services,
    data.result?.recurring?.services,
    data.result?.results?.recurring?.services,
    Array.isArray(data.services) ? data.services.filter((svc) => svc.recurring || svc.frequency) : [],
    // Deduped by recurringServiceKey, so this coalesces with (never duplicates)
    // any matching recurring.services row from the admin/mapped save shape.
    recurringLinesFromEngineResult(data),
  );
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

// Service-type predicate (independent of existing-customer status): the WaveGuard
// $99 setup is a Pest/Mosquito membership fee. Lawn, termite-bait, rodent-bait,
// tree & shrub, and palm carry no setup fee — they earn the annual-prepay discount
// instead. This drives the prepay-discount decision (which must not depend on the
// existing-customer waiver); shouldIncludeWaveGuardSetupFeeForRecurring layers the
// existing-customer waiver on top for the actual setup invoice.
function recurringMixHasMembershipFeeService(recurringServices = []) {
  const keys = (Array.isArray(recurringServices) ? recurringServices : [])
    .map(recurringServiceKey)
    .filter(Boolean);
  return keys.includes('pest_control') || keys.includes('mosquito');
}

function shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices = [], estimateData = {} } = {}) {
  const recurring = Array.isArray(recurringServices) ? recurringServices : [];
  if (recurring.length === 0) return false;
  // Existing customers never pay the WaveGuard setup again — mirrors the
  // public estimate page, which shows the fee struck through as waived.
  const data = normalizeEstimateData(estimateData);
  if (data.membershipSnapshot && data.membershipSnapshot.isExistingCustomer) return false;
  // Pest/Mosquito mixes always charge the setup (no 5% stacking).
  return recurringMixHasMembershipFeeService(recurring);
}

// Annual amount of a recurring line, tolerant of both the raw engine lineItem
// shape (annual/ann) and the mapped recurring.services shape (mo/monthly only —
// saved estimates persist the mapped blob, which has no annual field).
function recurringLineAnnualAmount(item = {}) {
  const direct = Number(item.annualAfterDiscount ?? item.annualAfterCredits ?? item.annual ?? item.ann ?? 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const monthly = Number(item.mo ?? item.monthly ?? 0);
  if (Number.isFinite(monthly) && monthly > 0) return Math.round(monthly * 12 * 100) / 100;
  return 0;
}

// FL nonresidential sales tax DEFAULT (6% state + 1% surtax). Used only as the
// fallback when the customer's effective rate can't be resolved (e.g. the
// pre-accept estimate display before the customer row exists). The actual
// invoice resolves the rate via TaxCalculator (exemptions + county) — see
// resolveCommercialPrepayBaseRate.
const FL_COMMERCIAL_TAX_RATE = 0.07;

// Commercial prepay tax rate. The single-line annual-prepay invoice can't carry
// per-service taxability, and InvoiceService taxes the whole invoice at ONE
// rate — but a commercial plan mixes TAXABLE pest (nonresidential_pest_control)
// with NON-TAXABLE lawn/tree (lawn_spraying_or_treatment). Return a BLENDED rate
// (taxAmount = invoiceTotal × rate) that taxes only the taxable share: pest-only
// → baseRate, lawn/tree-only → 0, mixed → proportional. `baseRate` is the
// customer's EFFECTIVE commercial rate (0 if tax-exempt, county rate otherwise),
// resolved by the caller via TaxCalculator — NOT hardcoded, so exemptions and
// county-rate changes flow through. Keyed off the service (commercial_pest) as
// well as the taxable flag so a dropped flag on a save-path still taxes
// correctly. Computed against POST-DISCOUNT line allocations: the prepay
// discount hits only discountable lines (a non-discountable line like
// foam_recurring stays full price), so a pre-discount ratio would mis-tax a
// mixed plan that includes one.
function resolveCommercialPrepayTaxRate(recurringServices = [], { prepayDiscountApplied = false, baseRate = FL_COMMERCIAL_TAX_RATE } = {}) {
  const rows = Array.isArray(recurringServices) ? recurringServices : [];
  const effectiveBaseRate = Number.isFinite(baseRate) ? baseRate : FL_COMMERCIAL_TAX_RATE;
  if (!(effectiveBaseRate > 0)) return 0;
  const discountRate = prepayDiscountApplied ? ANNUAL_PREPAY_DISCOUNT_PCT : 0;
  // Taxable commercial pest-FAMILY keys (pest / mosquito / termite-bait /
  // rodent-bait → nonresidential_pest_control). Keyed off the service as well as
  // the row's taxable flag so a save-path that drops the flag still taxes
  // correctly. Commercial lawn/tree are NON-taxable (lawn_spraying_or_treatment)
  // and are intentionally excluded.
  const TAXABLE_COMMERCIAL_KEYS = new Set([
    'commercial_pest', 'commercial_mosquito', 'commercial_termite_bait', 'commercial_rodent_bait',
  ]);
  const isTaxableCommercial = (svc) =>
    svc?.taxable === true || TAXABLE_COMMERCIAL_KEYS.has(recurringServiceKey(svc));
  // Each line's contribution to the post-discount invoice total: discountable
  // lines take the prepay discount, non-discountable lines stay full price.
  const postDiscount = (svc) => {
    const annual = recurringLineAnnualAmount(svc);
    return isNonDiscountableRecurringLine(svc) ? annual : annual * (1 - discountRate);
  };
  const invoiceTotal = rows.reduce((sum, svc) => sum + postDiscount(svc), 0);
  if (!(invoiceTotal > 0)) return 0;
  const taxableTotal = rows.filter(isTaxableCommercial).reduce((sum, svc) => sum + postDiscount(svc), 0);
  // FULL precision — InvoiceService multiplies invoiceTotal by this rate and
  // rounds the resulting tax DOLLARS to cents. Rounding the rate here (e.g. to 4
  // dp) would drop the tax to $0 or drift by dollars when the taxable pest share
  // is small, so don't.
  return (taxableTotal * effectiveBaseRate) / invoiceTotal;
}

// Resolve a commercial customer's EFFECTIVE per-dollar tax rate for taxable
// commercial pest (0 if tax-exempt, else their county rate / FL default). Pass
// the transaction connection when resolving inside the accept trx so the
// just-written property_type='commercial' is visible. Fails soft to the FL
// default so a lookup hiccup never blocks acceptance.
async function resolveCommercialPrepayBaseRate(customerId, { database, forceCommercial = true } = {}) {
  if (!customerId) return FL_COMMERCIAL_TAX_RATE;
  try {
    const TaxCalculator = require('./tax-calculator');
    // forceCommercial: we KNOW this is a commercial accept; resolve the commercial
    // rate even if the customer row isn't marked commercial yet (pre-accept
    // display, or a residential→commercial upgrade), so display == invoice.
    const result = await TaxCalculator.calculateTax(customerId, 'nonresidential_pest_control', 1, { database, isCommercial: forceCommercial });
    if (result && result.taxable === false) return 0; // exemption / non-taxable
    const rate = Number(result?.rate);
    return Number.isFinite(rate) && rate >= 0 ? rate : FL_COMMERCIAL_TAX_RATE;
  } catch (_) {
    return FL_COMMERCIAL_TAX_RATE;
  }
}

function isNonDiscountableRecurringLine(item = {}) {
  const key = recurringServiceKey(item);
  // Commercial auto-priced programs EARN the annual-prepay discount (owner
  // directive 2026-06-29: commercial prepay = 5%, same as residential lawn/tree;
  // there is no WaveGuard setup fee on commercial). They remain NON-MEMBERS —
  // excluded from the WaveGuard TIER % via excludeFromPctDiscount (see
  // recurringServiceReceivesTierDiscount), which is a separate path from this
  // prepay floor. So they are discountable HERE (return false) just like
  // lawn_care. (commercial pest/mosquito/termite/rodent are auto-priced too.)
  if (key === 'commercial_lawn' || key === 'commercial_tree_shrub' || key === 'commercial_pest'
    || key === 'commercial_mosquito' || key === 'commercial_termite_bait' || key === 'commercial_rodent_bait') return false;
  if (key === 'lawn_care') return false;
  const annual = recurringLineAnnualAmount(item);
  if (!(annual > 0)) return false;
  // foam_recurring is non-discountable by owner directive — the cadence
  // multiplier is its only discount. Engine-backed / quote-wizard save paths
  // persist the foam line without the discountable:false flag (e.g.
  // public-quote.js maps a lineItems subset), so key off the service itself so
  // annual prepay never stacks the generic 5% on foam regardless of row flags.
  if (recurringServiceKey(item) === 'foam_recurring') return true;
  return (
    item.discountable === false ||
    item.discount?.discountable === false ||
    item.discount?.policy === 'LAWN_V2_NET_55_FLOOR_PRICE'
  );
}

function nonDiscountableRecurringAnnualFloor(estimateData = {}) {
  // Saved estimates persist recurring lines under recurring.services (the mapped
  // shape), NOT lineItems — so scan both and dedupe by service key, otherwise a
  // non-discountable recurring service (e.g. foam_recurring) is invisible to the
  // floor and the annual-prepay calculator discounts it anyway.
  const lineItems = estimateLineItemsFromData(estimateData).filter(isNonDiscountableRecurringLine);
  const seen = new Set(lineItems.map((i) => recurringServiceKey(i)).filter(Boolean));
  const serviceRows = recurringServicesFromEstimateData(estimateData)
    .filter(isNonDiscountableRecurringLine)
    .filter((svc) => {
      const key = recurringServiceKey(svc);
      return !key || !seen.has(key);
    });
  return Math.round([...lineItems, ...serviceRows]
    .reduce((sum, item) => sum + recurringLineAnnualAmount(item), 0) * 100) / 100;
}

function resolveAnnualPrepayDraftAmount({ prepayInvoiceAmount, annualTotal, monthlyRate } = {}) {
  const explicit = parseFloat(prepayInvoiceAmount);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit * 100) / 100;
  const annual = parseFloat(annualTotal);
  if (Number.isFinite(annual) && annual > 0) return Math.round(annual * 100) / 100;
  return calculateAnnualPrepayAmount(monthlyRate);
}

// Single source of truth for the annual-prepay invoice amount, shared by the
// converter (billing), the public estimate render, and the accept response so the
// displayed/messaged total always equals the invoice the converter creates.
// Non-pest/mosquito mixes take ANNUAL_PREPAY_DISCOUNT_PCT off the recurring annual;
// the non-discountable recurring floor (margin-protected non-lawn lines) still
// clamps the result, so callers never quote a total below what is actually billed.
function resolveAnnualPrepayInvoiceTotal({ baseAnnual, recurringServices = [], estimateData = {} } = {}) {
  const base = Math.round((Number(baseAnnual) || 0) * 100) / 100;
  if (!(base > 0)) return { amount: 0, discount: 0, rate: 0 };
  const discountRate = recurringMixHasMembershipFeeService(recurringServices) ? 0 : ANNUAL_PREPAY_DISCOUNT_PCT;
  // Apply the prepay % ONLY to the discountable portion. Non-discountable
  // recurring lines (e.g. foam_recurring, whose cadence multiplier is its only
  // discount) are split out first and added back at full price — otherwise a
  // mixed plan (foam + lawn) would still bleed part of the 5% onto foam because
  // a simple max(discounted, floor) clamp only protects foam-heavy mixes.
  const floor = Math.min(base, nonDiscountableRecurringAnnualFloor(estimateData));
  const discountableBase = Math.max(0, Math.round((base - floor) * 100) / 100);
  const amount = Math.round((floor + discountableBase * (1 - discountRate)) * 100) / 100;
  const discount = Math.max(0, Math.round((base - amount) * 100) / 100);
  return { amount, discount, rate: Math.round((discount / base) * 10000) / 10000 };
}

function shouldCreateDraftInvoiceForRecurring({ billingTerm = 'standard', recurringServices = [] } = {}) {
  if (!Array.isArray(recurringServices) || recurringServices.length === 0) return false;
  if (billingTerm === 'prepay_annual') return true;
  return true;
}

function recurringRowRequiresQuote(row = {}) {
  return row.quoteRequired === true
    || row.requiresCustomQuote === true
    || row.quote_required === true
    || row.requires_custom_quote === true;
}

function recurringRowHasDollarAmount(row = {}) {
  return RECURRING_DOLLAR_FIELDS.some((field) => firstPositiveNumber(row[field]) != null);
}

function recurringObjectsFromEstimateData(estimateData = {}) {
  const data = normalizeEstimateData(estimateData);
  const result = data.result && typeof data.result === 'object' ? data.result : data;
  return [
    result.recurring && typeof result.recurring === 'object' ? result.recurring : {},
    result.results?.recurring && typeof result.results.recurring === 'object'
      ? result.results.recurring
      : {},
  ];
}

function recurringObjectHasDollarTotal(obj = {}) {
  return firstPositiveNumber(
    obj.monthlyTotal,
    obj.grandTotal,
    obj.annualAfterDiscount,
    obj.annualTotal,
    obj.monthly,
    obj.annual,
  ) != null;
}

function oneTimeObjectFromEstimateData(estimateData = {}) {
  const data = normalizeEstimateData(estimateData);
  const result = data.result && typeof data.result === 'object' ? data.result : data;
  return {
    oneTime: result.oneTime && typeof result.oneTime === 'object' ? result.oneTime : {},
    nestedOneTime: result.results?.oneTime && typeof result.results.oneTime === 'object'
      ? result.results.oneTime
      : {},
  };
}

function oneTimeItemHasDollarAmount(item = {}) {
  return firstPositiveNumber(
    item.price,
    item.amount,
    item.total,
    item.priceAfterDiscount,
    item.totalAfterDiscount,
  ) != null;
}

function hasOneTimeDollarEvidence({ oneTimeTotal = 0, estimateData = {} } = {}) {
  const { oneTime, nestedOneTime } = oneTimeObjectFromEstimateData(estimateData);
  return firstPositiveNumber(oneTimeTotal, oneTime.total, nestedOneTime.total) != null
    || estimateOneTimeItemsFromData(estimateData).some(oneTimeItemHasDollarAmount);
}

function shouldSuppressRecurringConversion({
  billingTerm = 'standard',
  monthlyRate = 0,
  annualTotal = 0,
  oneTimeTotal = 0,
  recurringServices = [],
  estimateData = {},
} = {}) {
  const services = mergeRecurringServiceLists(
    Array.isArray(recurringServices) ? recurringServices : [],
    recurringServicesFromEstimateData(estimateData),
  );
  const monthly = Number(monthlyRate);
  const annual = Number(annualTotal);
  const hasTopLevelRecurringAmount = (Number.isFinite(monthly) && monthly > 0)
    || (Number.isFinite(annual) && annual > 0);
  const hasRecurringEvidence = hasTopLevelRecurringAmount
    || services.some(recurringRowHasDollarAmount)
    || recurringObjectsFromEstimateData(estimateData).some(recurringObjectHasDollarTotal);

  return billingTerm !== 'prepay_annual'
    && hasOneTimeDollarEvidence({ oneTimeTotal, estimateData })
    && !hasRecurringEvidence
    && !services.some(recurringRowRequiresQuote);
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
  if (key === 'pest_control') return pattern === 'quarterly';
  // Recurring foam is offered on all three cadences (quarterly/bimonthly/
  // monthly), so seed follow-ups for whichever pattern the customer accepted —
  // otherwise the accepted plan would stop after the first visit.
  if (key === 'foam_recurring') return ['quarterly', 'bimonthly', 'monthly'].includes(pattern);
  return false;
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
  if (opts.registerReminders !== false) {
    await registerSeededFollowUpReminders(seedResult.insertedRows, parentRow.customer_id);
  }
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
    const deferFollowUpReminderRegistration = opts.deferFollowUpReminderRegistration === true;
    const usingCallerDatabase = !!opts.database;
    const database = opts.database || db;
    const estimate = await database('estimates').where({ id: estimateId }).first();
    if (!estimate) throw new Error(`Estimate ${estimateId} not found`);
    if (estimate.status !== 'accepted') throw new Error(`Estimate ${estimateId} is not accepted (status: ${estimate.status})`);
    if (!estimate.customer_id) throw new Error(`Estimate ${estimateId} has no linked customer`);

    const customerId = estimate.customer_id;
    const customer = await database('customers').where({ id: customerId }).first();
    if (!customer) throw new Error(`Customer ${customerId} not found`);

    // Snapshot new-recurring candidacy BEFORE the conversion creates
    // scheduled_services rows. isNewRecurringSignupCandidate checks for any
    // prior recurring series, so once this conversion inserts its rows the
    // check would always return false. Captured here, it gates the welcome
    // SMS to genuinely new recurring signups (no prior series or completed
    // service) — existing customers accepting an add-on estimate don't
    // re-trigger the welcome. Reads committed prior state via the shared db.
    const wasNewRecurringSignup = await isNewRecurringSignupCandidate(customerId);

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
    const recurringServices = recurringServicesFromEstimateData(estimateData);
    const monthlyRate = parseFloat(estimate.monthly_total || 0);
    const suppressRecurringConversion = shouldSuppressRecurringConversion({
      billingTerm,
      monthlyRate,
      annualTotal: estimate.annual_total,
      oneTimeTotal: estimate.onetime_total,
      recurringServices,
      estimateData,
    });
    const recurringServicesForConversion = suppressRecurringConversion ? [] : recurringServices;
    const serviceCount = countTierQualifyingRecurringServices(recurringServicesForConversion);
    // Commercial auto-priced programs are FLAT and never a WaveGuard membership.
    // Used both to flag manual scheduling (the follow-up seeder doesn't support
    // their cadence) and to keep them off the Bronze tier fallback.
    const hasCommercialRecurring = recurringServicesForConversion.some(
      (svc) => String(recurringServiceKey(svc) || '').startsWith('commercial_')
    );
    // A plan is commercial-only (non-member) when it has a commercial recurring
    // line and NO WaveGuard-qualifying recurring service. Commercial keys are
    // never qualifying, so serviceCount===0 means there is no qualifying
    // non-commercial service — and a flat non-qualifying add-on (e.g. recurring
    // foam) must NOT promote the flat commercial plan to a Bronze membership.
    const commercialOnlyRecurring = hasCommercialRecurring && serviceCount === 0;
    const shouldCreateDraftInvoice = shouldCreateDraftInvoiceForRecurring({
      billingTerm,
      recurringServices: recurringServicesForConversion,
    });

    // Determine tier
    const { tier, discount } = suppressRecurringConversion
      ? { tier: 'One-Time', discount: 0 }
      : commercialOnlyRecurring
        ? { tier: 'none', discount: 0 } // written as the non-member 'Commercial' sentinel below
        : determineTier(serviceCount, recurringServicesForConversion.length > 0);
    const inferredFrequencyKey = estimateData.customerSelection?.frequency
      || inferFrequencyKeyFromEstimateData(estimateData);
    // Combined routing only trusts the customer's REAL accepted selection —
    // inferFrequencyKeyFromEstimateData is a guess that can derive from a
    // companion or unrelated line, and must never be treated as the pest
    // plan cadence (pre-push P1). Absent a real selection, explicit line
    // cadence decides and cadence-less pest lines don't combine.
    const acceptedPlanFrequency = estimateData.customerSelection?.frequency || null;
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
    const customerUpdates = suppressRecurringConversion
      ? {
          waveguard_tier: 'One-Time',
          monthly_rate: null,
          deleted_at: null,
        }
      : {
          pipeline_stage: 'active_customer',
          pipeline_stage_changed_at: new Date(),
          // member_since = the conversion date. If the row was already a
          // customer (or a former one), keep its real start; if it was a lead,
          // overwrite the lead-intake date with today. Uses the already-loaded
          // row, not database.raw, to stay mock-friendly.
          member_since: ['active_customer', 'won', 'at_risk', 'churned', 'dormant'].includes(customer.pipeline_stage)
            ? (customer.member_since || etDateString())
            : etDateString(),
          // An all-commercial recurring plan is NOT a WaveGuard membership. Store
          // the explicit non-member 'Commercial' tier (in the CHECK + every
          // membership predicate's NON_MEMBERSHIP set) rather than NULL — a NULL
          // tier with a positive monthly_rate falls through those predicates'
          // legacy rate>0 fallback and would be treated/rendered as Bronze.
          waveguard_tier: commercialOnlyRecurring ? 'Commercial' : (tier === 'none' ? null : tier),
          // A commercial recurring plan means the property is commercial — mark
          // it so InvoiceService applies FL sales tax to taxable commercial
          // services (e.g. commercial pest = nonresidential_pest_control 7%).
          // Without this the customer reads residential and tax is forced to $0.
          // Only SET it for commercial; never downgrade a residential customer.
          ...(hasCommercialRecurring ? { property_type: 'commercial' } : {}),
          monthly_rate: monthlyRate,
          active: true,
          deleted_at: null,
          // Reactivating to active_customer — clear any churn stamp so a former
          // (churned/dormant) customer who accepts a recurring estimate isn't
          // still counted as churned by churned_at-based queries (e.g. MRR trend).
          churned_at: null,
          churn_reason: null,
        };
    await database('customers').where({ id: customerId }).update(customerUpdates);

    // 1b. Persist grass type captured during the estimate so lawn reports use
    //     the real turf instead of the St. Augustine default. ONLY for estimates
    //     with a lawn service — the admin estimate form always saves grassType
    //     (defaulting to st_augustine even for pest-only accepts), so an
    //     ungated write would stamp a fake default on non-lawn customers.
    //     Fail-soft + COALESCE — never clobber an admin-set value, never break
    //     acceptance.
    try {
      const grass = grassTypeToPersist(recurringServices, estimateData);
      if (grass) {
        await database('customer_turf_profiles')
          .insert({ customer_id: customerId, grass_type: grass })
          .onConflict('customer_id')
          .merge({
            grass_type: database.raw('COALESCE(customer_turf_profiles.grass_type, ?)', [grass]),
            updated_at: new Date(),
          });
      }
    } catch (grassErr) {
      logger.warn?.(`[estimate-converter] grass-type persist skipped for customer ${customerId}: ${grassErr.message}`);
    }

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
    const deferredFollowUpReminderRows = [];
    const existingFromReservation = await database('scheduled_services')
      .where({ source_estimate_id: estimateId })
      .whereNotNull('customer_id')
      .whereNull('reservation_expires_at')
      .count('id as count')
      .first();
    const reservationRowsExist = Number(existingFromReservation?.count || 0) > 0;

    if (suppressRecurringConversion) {
      logger.info(
        `[estimate-converter] Skipping recurring conversion for estimate ${estimateId} — ` +
        `$${monthlyRate}/mo standard accept is treated as one-time fallback`
      );
    } else if (reservationRowsExist) {
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
        const { combos } = combineRecurringServicesForScheduling(recurringServicesForConversion, {
          acceptFrequency: acceptedPlanFrequency,
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
          // Mirror EVERY rewritten field onto the in-memory row —
          // follow-up seeding copies service_id and duration from the
          // parent OBJECT, not the DB (pre-push P1). reservedStart is the
          // same object reference when ids match.
          row.service_type = combo.route.name;
          if (update.service_id) row.service_id = update.service_id;
          if (update.estimated_duration_minutes) row.estimated_duration_minutes = update.estimated_duration_minutes;
          if (reservedStart && row.id === reservedStart.id) {
            reservedSeedSvc = combo.service;
          }
          logger.info(`[estimate-converter] reserved row ${row.id} combined → "${combo.route.name}" (picked slot preserved)`);
        }
      } catch (comboErr) {
        logger.warn(`[estimate-converter] combined routing on reserved rows failed: ${comboErr.message}`);
      }

      if (reservedStart) {
        try {
          const seedSvc = reservedSeedSvc || recurringServiceForScheduledRow(recurringServicesForConversion, reservedStart);
          const seedResult = await seedRecurringFollowUpsForParent(database, reservedStart, seedSvc, {
            fallbackFrequency: inferredFrequencyKey,
            registerReminders: !deferFollowUpReminderRegistration,
          });
          if (deferFollowUpReminderRegistration && Array.isArray(seedResult.insertedRows)) {
            deferredFollowUpReminderRows.push(...seedResult.insertedRows);
          }
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
      const { remaining, combos } = combineRecurringServicesForScheduling(recurringServicesForConversion, {
        acceptFrequency: acceptedPlanFrequency,
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
        const estimatedPrice = billingCadence && recurringServicesForConversion.length === 1
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
              registerReminders: !deferFollowUpReminderRegistration,
            });
            if (deferFollowUpReminderRegistration && Array.isArray(seedResult.insertedRows)) {
              deferredFollowUpReminderRows.push(...seedResult.insertedRows);
            }
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
      // Base recurring annual (undiscounted): resolveAnnualPrepayInvoiceAmount never
      // applies the prepay discount, so this is always the pre-discount figure.
      const annualPrepayBase = resolveAnnualPrepayDraftAmount({
        prepayInvoiceAmount: opts.prepayInvoiceAmount,
        annualTotal: estimate.annual_total,
        monthlyRate,
      });
      // Mixes without a WaveGuard setup fee (lawn/termite/rodent/tree/palm) take
      // the prepay discount off the recurring annual instead of the setup waiver;
      // pest/mosquito keep the waiver and no extra discount. Shared with the public
      // render + accept response so all three quote the same (floor-clamped) total.
      const prepayResolved = resolveAnnualPrepayInvoiceTotal({
        baseAnnual: annualPrepayBase,
        recurringServices: recurringServicesForConversion,
        estimateData,
      });
      const annualPrepayAmount = billingTerm === 'prepay_annual'
        ? prepayResolved.amount
        : annualPrepayBase;
      const prepayDiscountApplied = prepayResolved.discount > 0;
      const standardFirstApplicationAmount = billingTerm === 'standard'
        ? resolveFirstApplicationAmount({
          firstApplicationAmount: opts.firstApplicationAmount,
          billingCadence,
          monthlyRate,
          allowFallback: opts.allowFirstApplicationFallback !== false,
        })
        : 0;
      const setupFeeApplies = billingTerm === 'standard'
        ? shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices: recurringServicesForConversion, estimateData })
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
          const prepayDiscountPctLabel = `${Math.round(ANNUAL_PREPAY_DISCOUNT_PCT * 100)}%`;
          // Commercial plans are not a WaveGuard membership and tier is the
          // non-member 'none'; label them 'Commercial' rather than letting the
          // truthy 'none' render as "WaveGuard none".
          const prepayPlanPrefix = commercialOnlyRecurring
            ? 'Commercial'
            : `WaveGuard ${tier && tier !== 'none' ? tier : 'Bronze'}`;
          const prepayLineDescription = commercialOnlyRecurring
            ? `${prepayPlanPrefix} — 12 months prepaid`
            : prepayDiscountApplied
              ? `${prepayPlanPrefix} — 12 months prepaid (${prepayDiscountPctLabel} prepay discount)`
              : `WaveGuard Membership — 12 months prepaid (setup fee waived)`;
          const prepayNotes = prepayDiscountApplied
            ? `Auto-generated from accepted estimate #${estimateId}. Customer selected "Pay the year upfront" — ${prepayDiscountPctLabel} annual-prepay discount applied to the recurring annual.`
            : `Auto-generated from accepted estimate #${estimateId}. Customer selected "Pay the year upfront" — $99 setup fee waived per WaveGuard membership policy.`;
          // Commercial prepay tax: pass an explicit BLENDED rate (see
          // resolveCommercialPrepayTaxRate) so only the taxable pest share of a
          // mixed commercial plan is taxed. Non-commercial prepay passes no rate
          // → stays residential-exempt ($0). The customer was marked
          // property_type='commercial' above, so InvoiceService honors this rate.
          // Resolve the customer's EFFECTIVE commercial tax rate (exemptions +
          // county) on the SAME connection so the just-written
          // property_type='commercial' is visible — then blend by the taxable
          // pest share. Never hardcode 7%.
          const prepayTaxRate = hasCommercialRecurring
            ? resolveCommercialPrepayTaxRate(recurringServicesForConversion, {
              prepayDiscountApplied,
              baseRate: await resolveCommercialPrepayBaseRate(customerId, { database }),
            })
            : undefined;
          const inv = await InvoiceService.create({
            database,
            customerId,
            title: `${prepayPlanPrefix} — Annual Prepay (12 months)`,
            lineItems: [{
              description: prepayLineDescription,
              quantity: 1,
              unit_price: annualAmount,
            }],
            notes: prepayNotes,
            dueDate: etDateString(),
            ...(prepayTaxRate !== undefined ? { taxRate: prepayTaxRate } : {}),
          });
          draftInvoiceId = inv?.id || null;
          // Quote the amount actually invoiced/charged (tax-inclusive) so the
          // customer/admin messaging matches the PaymentIntent. For residential
          // (untaxed) inv.total === annualAmount, so this is a no-op there.
          draftInvoiceAmount = inv?.total != null ? Number(inv.total) : annualAmount;
          draftInvoicePayUrl = inv?.token ? `/pay/${inv.token}` : null;

          try {
            const AnnualPrepayRenewals = require('./annual-prepay-renewals');
            const annualPrepayTerm = await AnnualPrepayRenewals.createTermForAnnualPrepay({
              customerId,
              sourceEstimateId: estimateId,
              prepayInvoiceId: draftInvoiceId,
              planLabel: `${prepayPlanPrefix} Annual Prepay`,
              monthlyRate: termMonthlyRate,
              // The TAX-INCLUSIVE invoice total (what the customer actually pays).
              // Admin/portal read the term's prepayAmount as the paid amount and
              // coverage stamping splits it across visits. Residential is untaxed
              // so draftInvoiceAmount === annualAmount there.
              prepayAmount: draftInvoiceAmount,
              termStart: termStartDate || null,
              conn: database,
            });
            if (!annualPrepayTerm?.id) {
              throw new Error('Annual prepay term was not created');
            }
            annualPrepayTermId = annualPrepayTerm.id;
          } catch (termErr) {
            logger.error(`[estimate-converter] Annual prepay term creation failed for estimate ${estimateId}: ${termErr.message}`);
            if (draftInvoiceId && !usingCallerDatabase) {
              try {
                await InvoiceService.voidInvoice(draftInvoiceId);
              } catch (voidErr) {
                logger.error(`[estimate-converter] Annual prepay invoice void failed for estimate ${estimateId}: ${voidErr.message}`);
              }
            }
            draftInvoiceId = null;
            draftInvoiceAmount = null;
            draftInvoicePayUrl = null;
            throw termErr;
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
      if (billingTerm === 'prepay_annual') {
        logger.error(`[estimate-converter] Annual prepay invoice/term creation failed for estimate ${estimateId}: ${err.message}`);
        if (draftInvoiceId && !usingCallerDatabase) {
          try {
            const InvoiceService = require('./invoice');
            await InvoiceService.voidInvoice(draftInvoiceId);
          } catch (voidErr) {
            logger.error(`[estimate-converter] Failed to void incomplete annual prepay invoice ${draftInvoiceId}: ${voidErr.message}`);
          }
        }
        throw err;
      }
      // Don't let standard setup invoice creation block the conversion.
      // Virginia can manually draft the setup invoice if this misfires.
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
      includedServices: recurringServicesForConversion
        .map((svc) => svc.name || svc.serviceName || svc.service_name || svc.label)
        .filter(Boolean)
        .join(', '),
    };

    if (opts.skipMembershipEmail !== true && !suppressRecurringConversion && !commercialOnlyRecurring) {
      void AccountMembershipEmail.sendMembershipStarted(membershipEmail)
        .catch((err) => logger.warn(`[estimate-converter] membership.started email failed for customer ${customerId}: ${err.message}`));
    }

    // Commercial recurring follow-ups aren't auto-scheduled yet — surface it so
    // the team sets up the schedule manually (fire-and-forget; never blocks the
    // accept). Only the initial visit was scheduled above.
    if (hasCommercialRecurring && !suppressRecurringConversion) {
      // skipAutoSchedule (manual Mark Won) schedules NOTHING; the normal path
      // schedules only the initial visit. Reflect what actually happened so
      // dispatch knows whether the first appointment also needs creating.
      const nothingScheduled = skipAutoSchedule || scheduledCount === 0;
      const scheduleNote = nothingScheduled
        ? 'No visits were auto-scheduled — set up the full commercial visit schedule (including the first visit) manually.'
        : 'Initial visit scheduled — set up the remaining recurring commercial visits manually.';
      logger.warn(`[estimate-converter] Commercial recurring estimate ${estimateId} (customer ${customerId}) accepted — ${scheduleNote} (commercial cadence auto-scheduling not yet supported).`);
      try {
        const NotificationService = require('./notification-service');
        void NotificationService.notifyAdmin(
          'estimate_converted',
          `Commercial schedule needed: ${customer.first_name} ${customer.last_name}`,
          `Accepted commercial recurring estimate #${estimateId} — ${scheduleNote} (auto-scheduling for commercial cadences is pending).`,
          { icon: '\u{1F4C5}', link: '/admin/dispatch', metadata: { estimateId, customerId } }
        ).catch((err) => logger.warn(`[estimate-converter] commercial-schedule admin notify failed: ${err.message}`));
      } catch (err) {
        logger.warn(`[estimate-converter] commercial-schedule admin notify setup failed: ${err.message}`);
      }
    }

    // Welcome SMS for new recurring signups — unified across every accept
    // path (public self-accept, manual Mark Won, annual prepay). Previously
    // this text only fired when an admin scheduled the recurring appointment,
    // so customers who self-accepted online got the membership email but no
    // welcome text. sendNewRecurringWelcome is idempotent (sms_sequences
    // guard), so it won't double-send if the admin-schedule path also runs.
    // wasNewRecurringSignup gates it to genuinely new customers; all tiers are
    // included (Bronze too).
    const welcomeSms = (opts.skipWelcomeSms !== true && !suppressRecurringConversion && wasNewRecurringSignup && !commercialOnlyRecurring)
      ? {
          customer: {
            id: customerId,
            first_name: customer.first_name,
            last_name: customer.last_name,
            phone: customer.phone,
          },
          scheduledServiceId: firstScheduledServiceId,
          recurringPattern: acceptedPlanFrequency || inferredFrequencyKey || null,
          entryPoint: 'estimate_converter_welcome',
        }
      : null;

    // Only send inline when we own the connection. When a caller runs the
    // conversion inside its own transaction (opts.database), the customer /
    // notification_prefs rows may be uncommitted — sendCustomerMessage reads
    // them through the global pool and would block as NO_CONSENT_RECORD, and a
    // later rollback would strand the SMS + audit side effects. Those callers
    // get `welcomeSms` back in the result and fire it after commit.
    if (welcomeSms && !usingCallerDatabase) {
      void sendNewRecurringWelcome(welcomeSms)
        .catch((err) => logger.warn(`[estimate-converter] welcome SMS failed for customer ${customerId}: ${err.message}`));
    }

    return {
      customerId,
      tier,
      discount,
      monthlyRate,
      serviceCount,
      scheduledCount,
      requiresManualRecurringScheduling: hasCommercialRecurring,
      firstScheduledServiceId,
      billingTerm,
      draftInvoiceId,
      draftInvoiceAmount,
      draftInvoicePayUrl,
      invoiceDelivery,
      // A flat commercial-only plan is NOT a WaveGuard membership — don't hand
      // back a membership-started payload (callers like manual Mark Won fire the
      // returned email post-commit, which would send WaveGuard copy with a
      // non-member 'none'/'Commercial' tier).
      membershipEmail: commercialOnlyRecurring ? null : membershipEmail,
      welcomeSms,
      deferredFollowUpReminderRows,
      serviceMode: suppressRecurringConversion ? 'one_time' : 'recurring',
      recurringConversionSkipped: suppressRecurringConversion,
    };
  },
};

module.exports = EstimateConverter;
module.exports.findGrassTypeDeep = findGrassTypeDeep;
module.exports.grassTypeToPersist = grassTypeToPersist;
module.exports.calculateAnnualPrepayAmount = calculateAnnualPrepayAmount;
module.exports.countTierQualifyingRecurringServices = countTierQualifyingRecurringServices;
module.exports.determineTier = determineTier;
module.exports.hasWaveGuardSetupService = hasWaveGuardSetupService;
module.exports.nonDiscountableRecurringAnnualFloor = nonDiscountableRecurringAnnualFloor;
module.exports.recurringServiceKey = recurringServiceKey;
module.exports.recurringServicesFromEstimateData = recurringServicesFromEstimateData;
module.exports.combineRecurringServicesForScheduling = combineRecurringServicesForScheduling;
module.exports.reservedRowComboRewrites = reservedRowComboRewrites;
module.exports.explicitServiceCadence = explicitServiceCadence;
module.exports.supplementalCompanionLines = supplementalCompanionLines;
module.exports.COMBINED_SERVICE_ROUTES = COMBINED_SERVICE_ROUTES;
module.exports.durationMinutesForRecurringService = durationMinutesForRecurringService;
module.exports.resolveFirstApplicationAmount = resolveFirstApplicationAmount;
module.exports.resolveAnnualPrepayDraftAmount = resolveAnnualPrepayDraftAmount;
module.exports.resolveAnnualPrepayInvoiceTotal = resolveAnnualPrepayInvoiceTotal;
module.exports.resolveCommercialPrepayTaxRate = resolveCommercialPrepayTaxRate;
module.exports.resolveCommercialPrepayBaseRate = resolveCommercialPrepayBaseRate;
module.exports.canAutoSendDraftInvoice = canAutoSendDraftInvoice;
module.exports.shouldSuppressRecurringConversion = shouldSuppressRecurringConversion;
module.exports.shouldAttachScheduledServiceToStandardDraftInvoice = shouldAttachScheduledServiceToStandardDraftInvoice;
module.exports.serviceCountsTowardWaveGuardTier = serviceCountsTowardWaveGuardTier;
module.exports.shouldIncludeWaveGuardSetupFeeForRecurring = shouldIncludeWaveGuardSetupFeeForRecurring;
module.exports.shouldCreateDraftInvoiceForRecurring = shouldCreateDraftInvoiceForRecurring;
