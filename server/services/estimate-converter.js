/**
 * Estimate Auto-Converter — when an estimate is accepted, automatically:
 *   1. Set customer pipeline_stage to 'active_customer'
 *   2. Determine WaveGuard tier from selected services count
 *   3. Calculate monthly_rate from estimate data
 *   4. Create scheduled_services for recurring services
 *   5. Log the conversion in activity_log
 */

const db = require('../models/db');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const logger = require('./logger');
const AvailabilityEngine = require('./availability');
const { WAVEGUARD, ANNUAL_PREPAY_DISCOUNT_PCT, LAWN_PRICING_V2 } = require('./pricing-engine/constants');
// Canonical service-key tier membership (aliased: this module's local
// serviceCountsTowardWaveGuardTier is the svc-shaped, line-flag-aware form).
const { serviceCountsTowardWaveGuardTier: serviceKeyCountsTowardTier } = require('./pricing-engine/discount-engine');
const {
  customerPreservesMonthlyMembership,
  inferFrequencyKeyFromEstimateData,
  perApplicationChargeAmount,
  resolveBillingCadence,
} = require('./billing-cadence');
const AccountMembershipEmail = require('./account-membership-email');
const {
  sendNewRecurringWelcome,
  isNewRecurringSignupCandidate,
} = require('./new-recurring-welcome-sms');
const { etDateString } = require('../utils/datetime-et');
const { FORMER_CUSTOMER_STAGES } = require('./customer-stages');
const { normalizeGrassType } = require('./lawn-grass-context');
const { loadExistingQualifyingServiceKeys } = require('./waveguard-existing-services');

// Find the first grassType/grass_type string anywhere in the estimate data
// (confirmed primary path is inputs.grassType, but estimate shapes vary).
// Depth-capped to avoid pathological recursion.
// The billing lane THIS acceptance leaves the customer in — passed
// explicitly into the membership.started email (#3140 resolution): the email
// is fire-and-forget and can race the still-uncommitted accept transaction,
// so the email service's own loadCustomer may read the PRE-accept row and
// resolve the wrong lane. Mirrors the customers-row stamp exactly: annual
// prepay is re-stamped 'annual_prepay' at the term choke point; a current
// monthly member accepting an add-on keeps their model; everyone else
// converts to per-application (owner ruling 2026-07-09).
function acceptedBillingLaneForConversion({
  billingTerm,
  preservesExistingMembership,
  customerBillingMode,
  waveguardTier,
  monthlyRate,
}) {
  if (billingTerm === 'prepay_annual') return 'annual_prepay';
  const { resolveBillingLane } = require('./billing-lane');
  return resolveBillingLane({
    billing_mode: preservesExistingMembership ? (customerBillingMode || null) : 'per_application',
    waveguard_tier: waveguardTier,
    monthly_rate: monthlyRate,
  }).mode;
}

// The per-application figure the WELCOME EMAIL quotes — the price that
// applies to WHAT WAS JUST ACCEPTED (codex #3271 r2). This deliberately
// DIVERGES from stampedPerApplicationFee for one audience: an
// already-per_application customer accepting an add-on keeps their
// customer-level fee (preserving it is intentional — the fee is the
// completion fallback for EVERY per-app visit without a row price, so
// overwriting it would re-price the ORIGINAL series), but the add-on's own
// scheduled rows carry THIS estimate's amount, and the email lists exactly
// the newly accepted services — quoting them at the OLD plan's fee told the
// customer the wrong price. Same derivation as the stamp's new-customer
// branch: a single-recurring-unit accept quotes this estimate's exact
// cadence amount (monthly-rate fallback when no cadence resolved); a
// multi-service accept returns an EXPLICIT null — no single per-application
// figure exists, and sendMembershipStarted keeps an explicit null blank so
// the row drops (round-1 fix) instead of resurrecting a stale row fee.
function emailPerApplicationAmountForConversion({
  recurringUnitCount,
  billingCadence,
  perApplicationAmount,
  monthlyRate,
}) {
  if (recurringUnitCount === 1 && billingCadence && Number(billingCadence.amount) > 0) {
    return Number(perApplicationAmount);
  }
  return (recurringUnitCount === 1 && Number(monthlyRate) > 0) ? Number(monthlyRate) : null;
}

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

  // Fallback — today + 7, nudged off closed days (weekly days off + one-off
  // blackouts) via the shared helper; was a Sunday-only snap before the
  // weekly-days-off setting existed. Bounded walk, fail-open like the helper.
  const fallback = new Date(Date.now() + 7 * 86400000);
  let dateStr = fallback.toISOString().split('T')[0];
  try {
    const { isBlackoutDate } = require('./scheduling/blackout-dates');
    for (let i = 0; i < 14 && (await isBlackoutDate(dateStr)); i++) {
      fallback.setDate(fallback.getDate() + 1);
      dateStr = fallback.toISOString().split('T')[0];
    }
  } catch (e) {
    logger.warn(`[estimate-converter] closed-day nudge failed (failing open): ${e.message}`);
  }
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
    // Only the recurring BAIT/monitoring/station programs get the bait key —
    // commercial termite trenching/WDO or rodent trapping/exclusion are one-time
    // specialty work and must not inherit the recurring line's prepay/tax/schedule
    // behavior (mirrors the residential rodent_bait gate).
    if (raw.includes('termite') && /bait|station|monitor/.test(raw)) return 'commercial_termite_bait';
    if (raw.includes('rodent') && /bait|station|monitor/.test(raw)) return 'commercial_rodent_bait';
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
  // The pest+rodent route ("Pest & Rodent Control" / pest_rodent_quarterly)
  // was REMOVED by owner decision 2026-07-12: rodent bait stations ride
  // their own standalone visit instead of combining into the pest visit —
  // see STANDALONE_SUPPLEMENT_ROUTES below. The catalog row + completion
  // profile are retired by 20260712600000.
  {
    primaryKey: 'pest_control',
    companionKey: 'termite_bait',
    catalogServiceKey: 'pest_termite_bait_quarterly',
    name: 'Quarterly Pest + Termite Bait Station',
    // Termite bait station checks are quarterly (termite_active_bait_*);
    // the v1 mapper persists "Termite Bait" with no frequency/visits.
    companionDefaultPattern: 'quarterly',
    // For PEST plans the accepted customerSelection.frequency IS the visit
    // cadence the customer chose (quarterly/bimonthly/monthly plan) and
    // beats stale quote-time line cadence. NOT true for lawn, where the
    // selection stores the BILLING cadence.
    primaryUsesAcceptFrequency: true,
  },
  // Termite bait + bond (owner 2026-07-20): the warranty rides the SAME
  // quarterly station check — one visit, one scheduled row. The route NAME
  // is load-bearing twice over: it carries "%Termite Bond%" so the
  // termite_bonds lifecycle sync recognizes the completed visit, and the
  // "(N-Year Term)" fragment so termYearsFrom mints the RIGHT term (a
  // term-less combined label would mint every bond as 1-year). No combined
  // catalog row exists — catalogServiceKey resolves the BAIT row so the
  // visit closes out under the bait-station completion profile (the bond
  // itself is an internal-only billing rider). Listed AFTER pest+termite:
  // when pest consumes the bait line, the bond schedules standalone (its
  // own internal rider series) — known v1 limitation, documented in the PR.
  {
    primaryKey: 'termite_bait',
    companionKey: 'termite_bond_1yr',
    catalogServiceKey: 'termite_bait',
    name: 'Quarterly Termite Bait Station + Termite Bond Service (1-Year Term)',
    companionDefaultPattern: 'quarterly',
  },
  {
    primaryKey: 'termite_bait',
    companionKey: 'termite_bond_5yr',
    catalogServiceKey: 'termite_bait',
    name: 'Quarterly Termite Bait Station + Termite Bond Service (5-Year Term)',
    companionDefaultPattern: 'quarterly',
  },
  {
    primaryKey: 'termite_bait',
    companionKey: 'termite_bond_10yr',
    catalogServiceKey: 'termite_bait',
    name: 'Quarterly Termite Bait Station + Termite Bond Service (10-Year Term)',
    companionDefaultPattern: 'quarterly',
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

// Sold lines/supplements that schedule as their OWN standalone visit when
// no combined route consumes them. Without this, server-priced estimates
// that persist rodent bait OUTSIDE recurring.services (rodentBaitMo — see
// supplementalCompanionLines) would schedule NOTHING for the bait stations
// after the pest+rodent route removal. The catalog identity is used for
// the scheduled row so completion resolves the typed rodent_bait_station
// profile by service_id/name.
const STANDALONE_SUPPLEMENT_ROUTES = {
  rodent_bait: {
    name: 'Quarterly Rodent Bait Station Service',
    catalogServiceKey: 'rodent_bait_quarterly',
    defaultPattern: 'quarterly',
  },
};

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
  // Standalone rewrites (owner decision 2026-07-12): sold rodent bait that
  // no route consumed schedules as its own catalog visit — both when it is
  // a recurring.services line (in `remaining`) and when it rides only as a
  // server-priced supplement (never in `remaining` at all). The catalog
  // identity replaces the raw line name so the scheduled row resolves the
  // typed profile instead of the generic fallback.
  const standalone = [];
  const consumedSupplementKeys = new Set(
    combos.flatMap((combo) => combo.combinedFrom.map((line) => recurringServiceKey(line))),
  );
  for (let i = remaining.length - 1; i >= 0; i -= 1) {
    const line = remaining[i];
    const key = recurringServiceKey(line);
    const standaloneRoute = STANDALONE_SUPPLEMENT_ROUTES[key];
    if (!standaloneRoute) continue;
    remaining.splice(i, 1);
    // A recurring LINE covering this program also consumes any duplicate
    // supplement below — legacy payloads can carry rodent bait in BOTH
    // places (a lineItems row plus the rodentBaitMo scalar), and scheduling
    // both would double-book the same sold program (Codex P2).
    consumedSupplementKeys.add(key);
    standalone.push({
      catalogServiceKey: standaloneRoute.catalogServiceKey,
      service: {
        name: standaloneRoute.name,
        frequency: explicitServiceCadence(line) || standaloneRoute.defaultPattern,
      },
    });
  }
  for (const supplement of supplements) {
    const key = recurringServiceKey(supplement);
    const standaloneRoute = STANDALONE_SUPPLEMENT_ROUTES[key];
    if (!standaloneRoute || consumedSupplementKeys.has(key)) continue;
    consumedSupplementKeys.add(key);
    standalone.push({
      catalogServiceKey: standaloneRoute.catalogServiceKey,
      // fromSupplement: this unit exists ONLY because of the scalar — a
      // line-sourced unit was already counted in the recurring lines, so
      // unit counting (prepay block, deposit-intent helper) adds only these.
      fromSupplement: true,
      service: {
        name: standaloneRoute.name,
        frequency: explicitServiceCadence(supplement) || standaloneRoute.defaultPattern,
      },
    });
  }
  return { remaining, combos, standalone };
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
  return serviceKeyCountsTowardTier(recurringServiceKey(svc));
}

function tierQualifyingRecurringServiceKeys(services = []) {
  const seen = new Set();
  for (const svc of services) {
    if (!serviceCountsTowardWaveGuardTier(svc)) continue;
    const key = recurringServiceKey(svc);
    if (key) seen.add(key);
  }
  return [...seen];
}

function countTierQualifyingRecurringServices(services = []) {
  return tierQualifyingRecurringServiceKeys(services).length;
}

// Rank order for upgrade detection ONLY (notification gating) — non-member
// sentinels (none/One-Time/Commercial/null) rank below every membership tier
// so a first real membership tier counts as an upgrade.
const WAVEGUARD_TIER_RANK = { bronze: 1, silver: 2, gold: 3, platinum: 4 };

function isMembershipTierUpgrade(previousTier, nextTier) {
  const prev = WAVEGUARD_TIER_RANK[String(previousTier || '').trim().toLowerCase()] || 0;
  const next = WAVEGUARD_TIER_RANK[String(nextTier || '').trim().toLowerCase()] || 0;
  return next > prev;
}

// Frozen prior qualifying families from the estimate's membership snapshot
// (codex #3228 r6): the quote deliberately freezes existingServiceKeys at
// save time, and the customer accepts the tier that snapshot priced — a live
// lookup at accept time can diverge when qualifying visits are added,
// completed, or cancelled between save and accept (a saved Silver add-on
// quote must not activate Bronze because its prior visit completed). Returns
// null when the estimate has no snapshot (legacy) — callers fall back to the
// live lookup. An EMPTY snapshot array is meaningful ("no priors at quote
// time") and is honored as-is.
function priorQualifyingKeysFromSnapshot(estimateData) {
  const keys = estimateData?.membershipSnapshot?.existingServiceKeys;
  if (!Array.isArray(keys)) return null;
  return keys.filter((k) => serviceKeyCountsTowardTier(k));
}

// Distinct qualifying-family count across the customer's EXISTING plans plus
// this estimate's additions — the number the combined membership tier is
// determined from. Same union the quote side advertises (estimate-membership-
// context feeds determineWaveGuardTier([...existingKeys, ...addedKeys]) from
// the shared waveguard-existing-services keys), so the ACTIVATED tier can
// never disagree with the QUOTED tier. Both sides emit the same key
// vocabulary (pest_control / lawn_care / tree_shrub / mosquito /
// termite_bait), so a plain set-union dedups overlap.
function combinedTierQualifyingCount(estimateKeys = [], priorKeys = []) {
  return new Set([...estimateKeys, ...priorKeys]).size;
}

function hasWaveGuardSetupService(services = []) {
  return shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices: services });
}

// ── Existing-service tier extension (owner decision 2026-08-10) ──────────
// Applies the FROZEN membershipSnapshot.existingServices plan when an accept
// raises the membership tier: upcoming qualifying visit rows are repriced to
// the frozen per-visit figure (or proportionally, when the contracted price
// moved between save and accept), and annual-prepaid families are credited
// the difference instead of being repriced (their paid term is never
// touched). The frozen plan is the SAME data the estimate page displayed
// (ExistingPlanUpgradeCard), so what was shown is exactly what applies —
// legacy estimates without a frozen plan (or plans frozen while
// GATE_WAVEGUARD_EXTEND_EXISTING was off) apply nothing and keep the
// 2026-08-05 review-bell behavior.
//
// Monthly-lane members are NOT auto-adjusted here: the scalar's interplay
// with this accept's own ledger write is exactly where a silent double-count
// hides, so the extension surfaces a parked exception naming the manual
// adjustment instead (rule 14) — per-application members, the dominant lane,
// bill from the row prices this function updates.
//
// Money invariants honored: unpriced rows stay NULL (never $0, never an
// invented price); a repriced figure only ever goes DOWN; the audit row
// commits atomically with the writes (same savepoint) — extension-with-audit
// or clean rollback, never one without the other. Callers wrap this in a
// nested transaction: a failure rolls back only the extension, never the
// accept.
async function applyFrozenExistingServiceExtension({
  database, customerId, estimateId, estimateData, activatedTier,
  monthlyLaneMember = false, priorQualifyingKeys = [],
}) {
  const summary = {
    applied: false,
    repricedRowCount: 0,
    families: [],
    familyLines: [],
    creditAmount: 0,
    creditLines: [],
    skippedFamilies: [],
    reviewFamilies: [],
    // Families whose frozen plan was only PARTIALLY honored (drift, parked
    // rows, allocation gaps) — the committed recap projects only families
    // absent from this list (codex #3338 r26).
    dirtyFamilies: [],
    monthlyRateReviewNeeded: false,
  };
  const snapshot = estimateData?.membershipSnapshot;
  const plan = (Array.isArray(snapshot?.existingServices) ? snapshot.existingServices : [])
    .filter((svc) => Number(svc?.currentPerVisit) > 0
      && Number(svc?.newPerVisit) > 0
      && Number(svc?.perVisitSavings) > 0
      && Array.isArray(svc?.keys) && svc.keys.length > 0);
  if (!plan.length) return summary;
  // The frozen plan belongs to the tier the snapshot advertised — a stale
  // snapshot whose tier disagrees with the activated tier must not apply
  // its numbers.
  if (String(snapshot?.tierLabel || '').trim().toLowerCase()
    !== String(activatedTier || '').trim().toLowerCase()) {
    return summary;
  }
  // Kill switch off but a tier-matching frozen plan exists (saved while it
  // was on): an already-open estimate tab can still promise the extension
  // — projection-time hiding can't reach a rendered page (codex #3338
  // r15) — so the accept parks the plan for review instead of going
  // silent. No plan (every legacy accept) returns above and stays a
  // silent no-op; no money moves either way with the gate off.
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('waveguardExtendExisting')) {
    for (const svc of plan) {
      summary.reviewFamilies.push(`${svc.label || svc.key} (extension gate off at accept — not applied)`);
    }
    return summary;
  }
  const plannedKeys = new Set(plan.flatMap((svc) => svc.keys));
  summary.reviewFamilies = (priorQualifyingKeys || []).filter((key) => !plannedKeys.has(key));

  // Monthly-lane members bill customers.monthly_rate — row writes and
  // prepaid credits would not deliver the displayed reduction (codex #3338
  // r9), so NOTHING is mutated for them: the whole frozen plan parks as a
  // manual rate adjustment BEFORE any write runs. Snapshots now exclude
  // monthly-lane members at save time; this guards mode changes between
  // save and accept and snapshots frozen before that exclusion.
  if (monthlyLaneMember === true) {
    summary.monthlyRateReviewNeeded = true;
    for (const svc of plan) {
      summary.reviewFamilies.push(`${svc.label || svc.key} (monthly-billed — adjust the monthly rate manually)`);
    }
    return summary;
  }

  const { loadExistingRecurringQualifyingRows, qualifyingKeysForRow } = require('./waveguard-existing-services');
  const rows = await loadExistingRecurringQualifyingRows(database, customerId);
  const today = etDateString();
  // DATE-column convention: read the stored calendar day directly.
  const rowDay = (value) => (value instanceof Date
    ? value.toISOString().slice(0, 10)
    : (typeof value === 'string' ? value.split('T')[0] : null));
  const isCallbackRow = (row) => row.is_callback === true || row.is_callback === 1
    || row.is_callback === '1' || row.is_callback === 'true';
  // Extension evidence is ALWAYS the strict predicate (upcoming, not a
  // callback, not created by THIS accept) regardless of the enroll gate —
  // a new rule with no legacy behavior to preserve, same posture as the
  // ownership loader.
  const liveRows = rows.filter((row) => {
    const day = rowDay(row.scheduled_date);
    if (!day || day < today) return false;
    if (isCallbackRow(row)) return false;
    if (row.source_estimate_id && String(row.source_estimate_id) === String(estimateId)) return false;
    return true;
  });

  // At-most-once per family (codex #3338 r7 dedup): a SECOND tier-raising
  // estimate saved before the first was accepted freezes the same
  // Bronze-origin plan, and accepting both must not reprice or credit the
  // same applications twice. Row reprices self-park on the second pass (the
  // frozen-price check no longer matches the already-lowered price) but the
  // prepaid credit has no natural guard — prepaid_amount is untouched by
  // design. The applied-extension audit row commits atomically with the
  // writes, so it is the reliable at-most-once marker: any prior applied
  // extension covering a family parks that family for owner review instead
  // of re-applying. FAIL CLOSED: if the audit probe cannot run, every
  // family parks.
  let previouslyExtended = new Map();
  try {
    const priorAudits = await database('activity_log')
      .where({ customer_id: customerId, action: 'waveguard_tier_extension_applied' })
      .select('metadata');
    for (const auditRow of priorAudits) {
      let meta;
      try {
        meta = typeof auditRow.metadata === 'string' ? JSON.parse(auditRow.metadata) : auditRow.metadata;
      } catch { meta = null; }
      if (!meta || String(meta.estimateId) === String(estimateId)) continue;
      for (const key of (Array.isArray(meta.families) ? meta.families : [])) {
        if (!previouslyExtended.has(key)) previouslyExtended.set(key, meta.estimateId);
      }
    }
  } catch (probeErr) {
    logger.warn(`[estimate-converter] prior-extension audit probe failed — parking the plan: ${probeErr.message}`);
    previouslyExtended = null;
  }

  let creditTotal = 0;
  const creditTermIds = new Set();
  for (const svc of plan) {
    if (previouslyExtended === null) {
      summary.reviewFamilies.push(`${svc.label || svc.key} (could not verify prior extensions — apply manually)`);
      summary.dirtyFamilies.push(svc.key);
      continue;
    }
    const priorExtensionEstimate = svc.keys.map((key) => previouslyExtended.get(key)).find(Boolean);
    if (priorExtensionEstimate) {
      summary.reviewFamilies.push(
        `${svc.label || svc.key} (already extended via estimate #${priorExtensionEstimate} — verify before applying again)`,
      );
      summary.dirtyFamilies.push(svc.key);
      continue;
    }
    // ID-pinned apply (codex #3338 r10): only the appointments frozen at
    // save time — a same-family visit created between save and accept was
    // never shown on the card and must not be repriced or credited. Ids
    // survive reschedules (dates don't). A frozen row without identities
    // parks for review rather than falling back to family-wide matching.
    const frozenRowIds = Array.isArray(svc.rowIds) ? svc.rowIds.map(String) : [];
    if (!frozenRowIds.length) {
      summary.reviewFamilies.push(`${svc.label || svc.key} (no frozen appointment identities — apply manually)`);
      continue;
    }
    let familyRows = liveRows.filter((row) => frozenRowIds.includes(String(row.id))
      && qualifyingKeysForRow(row).some((key) => svc.keys.includes(key)));
    if (!familyRows.length) {
      summary.skippedFamilies.push(svc.label || svc.key);
      continue;
    }
    // A frozen appointment missing from the live set (cancelled, moved into
    // the past, reclassified) was advertised on the card but will not be
    // honored — the family is PARTIAL and must not project as fully covered
    // (codex #3338 r7, sibling of r26: an all-missing family skips above and
    // never enters `families`, but a partially-missing one would otherwise
    // ride its applied sibling into appliedFamilies). Matched siblings
    // still apply.
    const matchedFrozenIds = new Set(familyRows.map((row) => String(row.id)));
    const missingFrozenRows = frozenRowIds.filter((id) => !matchedFrozenIds.has(id)).length;
    if (missingFrozenRows > 0) {
      summary.reviewFamilies.push(
        `${svc.label || svc.key} (${missingFrozenRows} frozen visit${missingFrozenRows === 1 ? '' : 's'} no longer eligible — verify manually)`,
      );
      summary.dirtyFamilies.push(svc.key);
    }
    // Composite visits and pre-minted invoices park (codex #3338 r24+r25):
    // a row with scheduled_service_addons nets the primary + add-ons into
    // one estimated_price (discounting the whole figure would discount the
    // non-qualifying add-ons too), and a row whose invoice was already
    // minted (Charge Now / pre-completion mint — the shared mint path
    // REUSES an existing invoice rather than rebuilding it) would keep
    // billing the old amount after a row-only reprice. Both are manual
    // territory. FAIL CLOSED: if either probe cannot run, the whole family
    // parks rather than risking a write the probe would have blocked.
    let compositeOrInvoicedIds;
    try {
      const rowIds = familyRows.map((row) => row.id);
      const [addonRows, invoiceRows] = await Promise.all([
        database('scheduled_service_addons').whereIn('scheduled_service_id', rowIds).select('scheduled_service_id'),
        database('invoices').whereIn('scheduled_service_id', rowIds)
          .whereNot('status', 'void').select('scheduled_service_id'),
      ]);
      compositeOrInvoicedIds = new Set([
        ...addonRows.map((row) => String(row.scheduled_service_id)),
        ...invoiceRows.map((row) => String(row.scheduled_service_id)),
      ]);
    } catch (probeErr) {
      logger.warn(`[estimate-converter] extension addon/invoice probe failed — parking ${svc.label || svc.key}: ${probeErr.message}`);
      summary.reviewFamilies.push(`${svc.label || svc.key} (could not verify add-ons/invoices — apply manually)`);
      summary.dirtyFamilies.push(svc.key);
      continue;
    }
    const parkedComposite = familyRows.filter((row) => compositeOrInvoicedIds.has(String(row.id)));
    if (parkedComposite.length > 0) {
      summary.reviewFamilies.push(
        `${svc.label || svc.key} (${parkedComposite.length} visit${parkedComposite.length === 1 ? '' : 's'} with add-ons or an already-minted invoice — apply manually)`,
      );
      summary.dirtyFamilies.push(svc.key);
      familyRows = familyRows.filter((row) => !compositeOrInvoicedIds.has(String(row.id)));
      if (!familyRows.length) continue;
    }
    const prepaidRows = familyRows.filter((row) => !!row.annual_prepay_term_id);
    const repriceRows = familyRows.filter((row) => !row.annual_prepay_term_id);
    let repriced = 0;
    let driftRows = 0;
    const repricedApplied = [];
    for (const row of repriceRows) {
      const price = Number(row.estimated_price);
      // Unpriced = NULL stays NULL (billing invariant 8) — but a FROZEN row
      // was priced at the basis when the card displayed it (the snapshot
      // never freezes unpriced rows), so a blank price now means the price
      // moved after save: park as drift (codex #3338 r26 — a silently
      // skipped appointment must not leave its family reading as fully
      // repriced). Never a $0 or invented write either way.
      if (!(price > 0)) {
        driftRows += 1;
        continue;
      }
      // FROZEN figure or nothing (codex #3338 r5): a row whose contracted
      // price moved after the estimate was saved gets NO automatic write —
      // a proportional delta would bill a figure the customer never saw,
      // and stamping the frozen figure could undo a legitimate post-save
      // price change. Drifted rows park for the owner (named in the
      // notification's review clause below).
      const matchesFrozen = Math.abs(price - Number(svc.currentPerVisit)) <= 0.01;
      if (!matchesFrozen) {
        driftRows += 1;
        continue;
      }
      const next = Number(svc.newPerVisit);
      if (!(next > 0) || next >= price) continue;
      // Concurrency guard (codex #3338 r14): the frozen-or-review invariant
      // must hold against a price edit landing between the row read and
      // this write — the predicate re-asserts the exact price the match
      // was computed on (raw value, so pg numeric comparison is exact).
      // Zero rows updated = the price moved underneath us = drift.
      const changed = await database('scheduled_services')
        .where({ id: row.id, estimated_price: row.estimated_price })
        .update({ estimated_price: next });
      if (!changed) {
        driftRows += 1;
        continue;
      }
      repriced += 1;
      repricedApplied.push(row);
    }
    // Mint race (codex #3338 r7): Charge Now reads the visit without a row
    // lock, so an invoice built from the OLD price can commit between the
    // probe above and the row updates. Re-probe after the writes and REVERT
    // any repriced row whose invoice appeared mid-apply — the recap must
    // not read a visit as repriced while its collectible invoice carries
    // the old amount. The residual window (a mint committing after this
    // re-probe) closes only when the mint path itself serializes on the
    // row — named pre-enable fast-follow. FAIL CLOSED: a failed re-probe
    // reverts every row this family repriced.
    if (repricedApplied.length > 0) {
      let lateMintedIds = null;
      try {
        const lateRows = await database('invoices')
          .whereIn('scheduled_service_id', repricedApplied.map((row) => row.id))
          .whereNot('status', 'void').select('scheduled_service_id');
        lateMintedIds = new Set(lateRows.map((row) => String(row.scheduled_service_id)));
      } catch (probeErr) {
        logger.warn(`[estimate-converter] post-apply invoice re-probe failed — reverting ${svc.label || svc.key}: ${probeErr.message}`);
      }
      const revertRows = lateMintedIds === null
        ? repricedApplied
        : repricedApplied.filter((row) => lateMintedIds.has(String(row.id)));
      if (revertRows.length > 0) {
        for (const row of revertRows) {
          const reverted = await database('scheduled_services')
            .where({ id: row.id, estimated_price: Number(svc.newPerVisit) })
            .update({ estimated_price: row.estimated_price });
          if (!reverted) {
            // Our own in-transaction write is gone — nothing sane can
            // continue; the caller's catch parks the whole extension.
            throw new Error(`extension revert failed for scheduled service ${row.id}`);
          }
          repriced -= 1;
        }
        summary.reviewFamilies.push(
          `${svc.label || svc.key} (${revertRows.length} visit${revertRows.length === 1 ? '' : 's'} invoiced during apply — reverted, adjust manually)`,
        );
        summary.dirtyFamilies.push(svc.key);
      }
    }
    if (driftRows > 0) {
      summary.reviewFamilies.push(
        `${svc.label || svc.key} (${driftRows} visit${driftRows === 1 ? '' : 's'} priced differently than quoted — apply manually)`,
      );
      summary.dirtyFamilies.push(svc.key);
    }
    if (repriced > 0) {
      summary.repricedRowCount += repriced;
      svc.keys.forEach((key) => { if (!summary.families.includes(key)) summary.families.push(key); });
      // "/application" is the one price unit on every rendered discount
      // (owner 2026-08-10, same ruling as the customer card) — "visits"
      // stays schedule language only.
      summary.familyLines.push(
        `${svc.label || svc.key} $${Number(svc.currentPerVisit).toFixed(2)} → $${Number(svc.newPerVisit).toFixed(2)}/application (${repriced} upcoming)`,
      );
    }
    if (prepaidRows.length > 0) {
      // The credit derives from the PAID allocation, never the list row
      // price (codex #3338 r21): a prepaid visit's prepaid_amount is the
      // DISCOUNTED splitCoverageAmount slice, so pct × estimated_price
      // would stack the tier delta on top of the prepay incentive and
      // overcredit every covered application. Within that, FROZEN figure
      // or nothing (same doctrine as the reprice path): the per-row credit
      // is the exact perVisitSavings the card displayed — recomputed pct
      // math can land a half-cent boundary a penny off the displayed
      // figure — and it applies only while the row's paid allocation still
      // equals the frozen basis. A re-split term, like a drifted price,
      // parks; a row without a usable allocation parks. Never a guessed
      // credit.
      const frozenBasis = Number(svc.currentPerVisit);
      const frozenSavings = Number(svc.perVisitSavings);
      let familyCredit = 0;
      let creditedRows = 0;
      let allocationGaps = 0;
      let allocationDrift = 0;
      // The allocations are RE-READ under FOR UPDATE inside this
      // transaction (codex #3338 r7): annual-prepay cancellation, refund,
      // and window edits mutate prepaid_amount, and a credit computed from
      // the earlier unlocked read could pay applications that are no longer
      // prepaid. The row lock makes those writers wait until this accept
      // commits; a row whose term or allocation no longer matches the
      // frozen basis parks. FAIL CLOSED: if the locked read cannot run, the
      // family parks uncredited.
      let lockedById;
      try {
        const lockedRows = await database('scheduled_services')
          .whereIn('id', prepaidRows.map((row) => row.id))
          .forUpdate()
          .select('id', 'prepaid_amount', 'annual_prepay_term_id');
        lockedById = new Map(lockedRows.map((row) => [String(row.id), row]));
      } catch (lockErr) {
        logger.warn(`[estimate-converter] prepaid allocation lock failed — parking ${svc.label || svc.key}: ${lockErr.message}`);
        summary.reviewFamilies.push(`${svc.label || svc.key} (could not verify paid allocations — credit manually)`);
        summary.dirtyFamilies.push(svc.key);
        lockedById = null;
      }
      if (lockedById === null) continue;
      for (const row of prepaidRows) {
        const locked = lockedById.get(String(row.id));
        if (!locked || !locked.annual_prepay_term_id) {
          // Row vanished or its prepay term was cleared since the read —
          // no longer a prepaid application; the frozen figure no longer
          // describes it.
          allocationDrift += 1;
          continue;
        }
        const allocation = Number(locked.prepaid_amount);
        if (!(frozenSavings > 0) || !(allocation > 0)) {
          allocationGaps += 1;
          continue;
        }
        if (Math.abs(allocation - frozenBasis) > 0.01) {
          allocationDrift += 1;
          continue;
        }
        familyCredit = Math.round((familyCredit + frozenSavings) * 100) / 100;
        creditedRows += 1;
        // Term breadcrumb for the credit note (codex #3338 r27): the
        // annual-prepay refund flow claws back only its own credit class,
        // so the ledger note must name the term(s) this credit rode on —
        // the manual refund review subtracts it from there. Automated
        // integration with the refund reversal is a named fast-follow.
        creditTermIds.add(String(locked.annual_prepay_term_id));
      }
      if (allocationGaps > 0) {
        summary.reviewFamilies.push(
          `${svc.label || svc.key} (${allocationGaps} prepaid visit${allocationGaps === 1 ? '' : 's'} without a usable paid allocation — credit manually)`,
        );
        summary.dirtyFamilies.push(svc.key);
      }
      if (allocationDrift > 0) {
        summary.reviewFamilies.push(
          `${svc.label || svc.key} (${allocationDrift} prepaid visit${allocationDrift === 1 ? '' : 's'} whose paid allocation changed since the estimate — credit manually)`,
        );
        summary.dirtyFamilies.push(svc.key);
      }
      if (familyCredit > 0) {
        creditTotal = Math.round((creditTotal + familyCredit) * 100) / 100;
        summary.creditLines.push(
          `${svc.label || svc.key} $${familyCredit.toFixed(2)} (${creditedRows} prepaid application${creditedRows === 1 ? '' : 's'} × $${frozenSavings.toFixed(2)}/application off the paid allocation)`,
        );
        svc.keys.forEach((key) => { if (!summary.families.includes(key)) summary.families.push(key); });
      }
    }
  }

  if (creditTotal > 0) {
    const { postCreditMovement } = require('./customer-credit');
    await postCreditMovement({
      customerId,
      delta: creditTotal,
      source: 'adjustment',
      note: `WaveGuard ${activatedTier} extension — prepaid-term difference (estimate #${estimateId}${creditTermIds.size ? `; terms: ${[...creditTermIds].sort().join(', ')}` : ''})`,
      createdBy: 'system:waveguard_tier_extension',
    }, database.isTransaction ? database : null);
    summary.creditAmount = creditTotal;
  }

  summary.applied = summary.repricedRowCount > 0 || summary.creditAmount > 0;
  summary.monthlyRateReviewNeeded = summary.applied && monthlyLaneMember === true;
  if (summary.applied) {
    // Audit rides the same savepoint as the writes — extension-with-audit
    // or clean rollback, never one without the other.
    await database('activity_log').insert({
      customer_id: customerId,
      action: 'waveguard_tier_extension_applied',
      description: `WaveGuard ${activatedTier} extension: ${summary.repricedRowCount} upcoming visit(s) repriced${summary.creditAmount > 0 ? `, $${summary.creditAmount.toFixed(2)} prepaid-difference credit` : ''} (estimate #${estimateId})`,
      metadata: JSON.stringify({
        estimateId,
        tier: activatedTier,
        families: summary.families,
        repricedRowCount: summary.repricedRowCount,
        familyLines: summary.familyLines,
        creditAmount: summary.creditAmount,
        creditLines: summary.creditLines,
        skippedFamilies: summary.skippedFamilies,
        reviewFamilies: summary.reviewFamilies,
        monthlyRateReviewNeeded: summary.monthlyRateReviewNeeded,
      }),
    });
  }
  return summary;
}

// An ADD-ON accept (existing recurring customer buying a NEW service family)
// must not clobber monthly_rate with just the add-on's monthly: for a monthly
// member the billing cron charges monthly_rate directly, so the overwrite
// silently swaps their whole bill for the add-on's slice; for per-application
// customers the rate feeds MRR, LTV, and every membership predicate. The
// customer's total becomes existing + add-on (the combined-tier quote card
// promises exactly that: additions are discounted "without repricing current
// service"). A SAME-family accept (re-quote/reprice — the #3228 adoption
// path, which stamps source_estimate_id on the adopted row before conversion
// runs) keeps the replace semantic: the new quote IS that plan's new price.
//
// Returns the existing rate to SUM onto when this accept is a true add-on;
// 0 in every other case (fail-safe: any classification doubt → replace,
// the pre-existing behavior). Live pipeline stages only — a churned/dormant
// re-signup's stale rate must never be summed back in.
// Full classification context for an accept against the customer's existing
// billed plans. addOnBase carries the #3241 sum semantics (existing rate for
// a proven-disjoint add-on, else 0); hadOtherLiveFamilies feeds the
// plan-rate ledger's review signal (a legacy multi-plan customer whose
// un-splittable scalar is being replaced — the owner hand-fix case, now
// surfaced instead of silent).
async function classifyAddOnAcceptContext({
  database, estimateId, estimate, estimateData, customer,
  adoptedExistingAppointmentId = null,
} = {}) {
  const none = { addOnBase: 0, hadOtherLiveFamilies: false };
  const existingMonthlyRate = Number(customer?.monthly_rate);
  if (!['active_customer', 'won', 'at_risk'].includes(customer?.pipeline_stage)
    || !Number.isFinite(existingMonthlyRate) || !(existingMonthlyRate > 0)) {
    return none;
  }
  try {
    // Lazy require — estimate-public requires this module inline only, so a
    // function-scope require cannot create a load cycle. Same classifier
    // spine as the adoption gate (one taxonomy, #3228 r5).
    // EVERY recurring line's family, not the adoption helper's primary-only
    // set (codex #3241 r2 P1): estimateFamilyKeysForAdoption deliberately
    // narrows a mixed estimate to its primary family (pest whenever
    // present), so an active T&S customer accepting a pest+T&S estimate
    // would look cross-family and get the old rate summed onto a total
    // that already re-prices T&S. Overlap must see the full family union.
    const {
      serviceFamilyKeyForAdoption,
      appointmentMatchesEstimateFamily,
    } = require('../routes/estimate-public');
    // ONE canonical line source shared with the ledger slicer (codex #3245
    // r18, superseding the #3241 r4 rodent-only supplement union): the
    // acceptance path's recurringServicesWithSupplements — recurring rows,
    // engine lineItems, rodent AND palm supplement reconstruction across
    // every container shape — so classification and slicing can never
    // disagree about which services an accept carries.
    const { acceptedRecurringBillingLines } = require('./plan-rate-ledger');
    const familyKeys = new Set(
      acceptedRecurringBillingLines(estimateData)
        .map((svc) => serviceFamilyKeyForAdoption(svc))
        .filter(Boolean),
    );
    if (familyKeys.size === 0) return none;
    // The customer's BILLED plan rows: live recurring rows, using the SAME
    // coverage semantics as loadActiveRecurringServiceRows (waveguard-
    // existing-services): NOT IN TERMINAL_STATUSES and NO future-only date
    // cutoff (codex #3241 r5 — a visit still en_route/on_site across ET
    // midnight is the customer's plan all the same). is_recurring=true is
    // the billed-plan evidence: ad-hoc one-time bookings never contribute
    // to monthly_rate. Callbacks never represent a plan.
    //
    // Rows sourced from THIS estimate are excluded — the picker path's
    // committed reservation row is this accept's OWN new booking — EXCEPT
    // the genuinely ADOPTED pre-existing appointment (codex r4/r5): it
    // carries this estimate's source_estimate_id since the adoption stamp,
    // but it existed before this accept, so it re-enters BY ID and stands
    // on its own evidence — a billed-plan (is_recurring) same-family row
    // forces replace, while an adopted ad-hoc visit (is_recurring=false,
    // filtered here) proves nothing and a disjoint billed plan still sums.
    // Savepoint-confined (codex #3241 r1, mirroring the prior-services
    // lookup): a SQL error on the caller's accept transaction would abort
    // the whole transaction — the catch below could then only return 0
    // while the customer update still failed, turning this optional lookup
    // into an acceptance-killer instead of the advertised replace fallback.
    const { TERMINAL_STATUSES } = require('./waveguard-existing-services');
    const otherPlanRows = await database.transaction((sp) => sp('scheduled_services')
      .leftJoin('services', 'scheduled_services.service_id', 'services.id')
      .select(
        'scheduled_services.service_type',
        'scheduled_services.is_callback',
        'scheduled_services.service_address_line1',
        'scheduled_services.service_address_line2',
        'scheduled_services.service_address_city',
        'scheduled_services.service_address_zip',
        'scheduled_services.source_estimate_id',
        'services.service_key as catalog_service_key',
        'services.name as catalog_service_name',
      )
      .where('scheduled_services.customer_id', customer.id)
      .whereNotIn('scheduled_services.status', TERMINAL_STATUSES)
      .where('scheduled_services.is_recurring', true)
      .where((builder) => {
        builder
          .whereNull('scheduled_services.source_estimate_id')
          .orWhereNot('scheduled_services.source_estimate_id', estimateId);
        if (adoptedExistingAppointmentId) {
          builder.orWhere('scheduled_services.id', adoptedExistingAppointmentId);
        }
      }));
    let planRows = (Array.isArray(otherPlanRows) ? otherPlanRows : [])
      .filter((row) => row && row.is_callback !== true);
    if (planRows.length === 0) return none;
    // Fail CLOSED on unclassifiable plan rows (codex #3241 r3): a legacy/
    // generic row that resolves to NO family can't prove it's a different
    // family — treating it as disjoint would sum the old rate onto an
    // estimate that may re-price that very plan. Unknown → replace.
    // The REVIEW signal (hadOtherLiveFamilies) reads ALL live plan rows
    // first — an unclassifiable or other-family row anywhere on the
    // account is other live plan money the owner should eyeball when a
    // replace lands.
    const rowFamilyFor = (row) => serviceFamilyKeyForAdoption({
      service: row.catalog_service_key || null,
      name: row.catalog_service_name || null,
      service_type: row.service_type,
    });
    const allRowFamilies = planRows.map(rowFamilyFor);
    const hadOtherLiveFamilies = allRowFamilies.some((family, i) => !family
      || !appointmentMatchesEstimateFamily(planRows[i], familyKeys));
    // Street scope FIRST (codex #3244 r8): an unclassifiable row stamped to
    // ANOTHER property can't be replacement evidence for this one — letting
    // it trip the fail-closed check would replace an account-level
    // monthly_rate with just this property's price. The fail-closed
    // classifiability bar then applies only to rows that could actually be
    // replacement evidence (this property's).
    planRows = await scopePlanRowsToEstimateProperty(planRows);
    if (planRows.length === 0) return { addOnBase: existingMonthlyRate, hadOtherLiveFamilies };
    const everyRowClassifiable = planRows.every(rowFamilyFor);
    if (!everyRowClassifiable) {
      return { addOnBase: 0, hadOtherLiveFamilies };
    }
    // Grouped accept (codex #3244 r2): a same-family plan at ANOTHER property
    // is a true ADD-ON — property #1's pest plan must not classify property
    // #2's pest plan as a re-quote (which would REPLACE monthly_rate with
    // one property's rate and under-bill a monthly member). Replace evidence
    // is scoped to rows at THIS estimate's address: stamped rows compare by
    // service_address_line1, unstamped rows resolve via their creating
    // estimate's address, then the customer's primary street; rows that
    // still can't be located keep their replace vote (fail closed). Only
    // grouped estimates take this path — ungrouped accepts are byte-identical.
    async function scopePlanRowsToEstimateProperty(rows) {
      if (!(estimate?.estimate_group_id && estimate.address)) return rows;
      const { normalizedEstimateStreet, normalizedStampedStreet, sameScopeKey, scopeKeyLacksLocality } = require('./estimate-property-linkage');
      const estimateStreet = normalizedEstimateStreet(estimate.address);
      if (!estimateStreet) return rows;
      return database.transaction(async (sp) => {
        const customerPrimaryStreet = normalizedStampedStreet(customer?.address_line1, customer?.address_line2, customer?.city, customer?.zip);
        const kept = [];
        for (const row of rows) {
          let street = normalizedStampedStreet(row.service_address_line1, row.service_address_line2, row.service_address_city, row.service_address_zip);
          if ((!street || scopeKeyLacksLocality(street)) && row.source_estimate_id) {
            const src = await sp('estimates').where({ id: row.source_estimate_id }).first('address');
            street = normalizedEstimateStreet(src?.address);
          }
          street = street || customerPrimaryStreet;
          if (!street || sameScopeKey(street, estimateStreet)) kept.push(row);
        }
        return kept;
      });
    }
    if (!planRows.some((row) => appointmentMatchesEstimateFamily(row, familyKeys))) {
      return { addOnBase: existingMonthlyRate, hadOtherLiveFamilies };
    }
    return { addOnBase: 0, hadOtherLiveFamilies };
  } catch (addOnErr) {
    logger.warn(`[estimate-converter] add-on rate classification failed for customer ${customer?.id} (monthly_rate keeps replace semantics): ${addOnErr.message}`);
    return none;
  }
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
  perApplicationAmount,
  monthlyRate,
  allowFallback = true,
} = {}) {
  const explicit = roundMoney(firstApplicationAmount);
  if (explicit > 0) return explicit;
  if (allowFallback === false) return 0;
  // The plan's true per-visit price outranks the cadence amount — the two
  // differ exactly when the billing display cadence isn't the visit cadence
  // (see perApplicationChargeAmount in billing-cadence.js).
  const perApp = roundMoney(perApplicationAmount);
  if (perApp > 0) return perApp;
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

function estimateOneTimeItemsFromData(estimateData = {}, { collapseMirrored = false } = {}) {
  const data = normalizeEstimateData(estimateData);
  const result = data.result && typeof data.result === 'object' ? data.result : data;
  const oneTime = result.oneTime && typeof result.oneTime === 'object' ? result.oneTime : {};
  const nestedOneTime = result.results?.oneTime && typeof result.results.oneTime === 'object'
    ? result.results.oneTime
    : {};
  const keepRow = (item) => item && item.onProg !== true && item.includedOnProgram !== true;
  const containers = [
    Array.isArray(oneTime.items) ? oneTime.items.filter(keepRow) : [],
    Array.isArray(oneTime.specItems) ? oneTime.specItems.filter(keepRow) : [],
    Array.isArray(nestedOneTime.items) ? nestedOneTime.items.filter(keepRow) : [],
    Array.isArray(nestedOneTime.specItems) ? nestedOneTime.specItems.filter(keepRow) : [],
    Array.isArray(result.specItems) ? result.specItems.filter(keepRow) : [],
    Array.isArray(data.one_time?.items) ? data.one_time.items.filter(keepRow) : [],
    Array.isArray(data.oneTimeItems) ? data.oneTimeItems.filter(keepRow) : [],
  ];
  const rows = containers.flat();
  const seen = new Set();
  const objectDeduped = rows.filter((item) => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
  if (!collapseMirrored) return objectDeduped;
  // Mapped estimates mirror the SAME specialty row into several containers
  // as distinct objects (oneTime.specItems + root specItems). Collapse
  // those mirrors by content identity WITHOUT erasing legitimate repeated
  // charges (two identical unit treatments in ONE container): each
  // identity's final count = the MAX occurrences seen within any single
  // container (slice 1A-ii, codex r3c).
  const identityOf = (item) => [
    String(item.service || '').toLowerCase(),
    String(item.name || item.label || '').toLowerCase(),
    String(item.price ?? item.amount ?? item.total ?? ''),
  ].join('|');
  const maxPerContainer = new Map();
  for (const container of containers) {
    const counts = new Map();
    for (const item of container) {
      const key = identityOf(item);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const [key, count] of counts) {
      maxPerContainer.set(key, Math.max(maxPerContainer.get(key) || 0, count));
    }
  }
  const emitted = new Map();
  return objectDeduped.filter((item) => {
    const key = identityOf(item);
    const already = emitted.get(key) || 0;
    if (already >= (maxPerContainer.get(key) || 0)) return false;
    emitted.set(key, already + 1);
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
  commercial_lawn: 'Commercial Turf Treatment Program',
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
      // Raw engine bond lines carry service 'termite_bond' + bondTerm —
      // normalize to the term-keyed service so the combined bait+bond
      // scheduling routes match exactly like mapped saves (codex #2915 r2).
      const base = li.service === 'termite_bond' && li.bondTerm
        ? { ...li, service: `termite_bond_${li.bondTerm}` }
        : li;
      if (base.name || base.label || base.displayName || base.serviceName || base.service_name) return base;
      const synthesized = RECURRING_SERVICE_DISPLAY_NAMES[recurringServiceKey(base)];
      return synthesized ? { ...base, name: synthesized } : base;
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
// $99 setup applies ONLY to single-service recurring plans — recurring pest
// only, or recurring mosquito only (owner directive 2026-07-10 evening,
// supersedes the same-day pest-mixes rule). Any multi-service recurring
// bundle carries no setup fee (the bundle is the incentive), and lawn /
// termite-bait / rodent-bait / T&S / palm solo plans never carry it — all of
// those earn the annual-prepay % discount instead. This drives the
// prepay-discount decision (which must not depend on the existing-customer
// waiver); shouldIncludeWaveGuardSetupFeeForRecurring layers the
// existing-customer waiver on top for the actual setup invoice.
const MEMBERSHIP_FEE_SOLO_KEYS = new Set(['pest_control', 'mosquito']);
function recurringMixHasMembershipFeeService(recurringServices = []) {
  const keys = Array.from(new Set(
    (Array.isArray(recurringServices) ? recurringServices : [])
      .map(recurringServiceKey)
      .filter(Boolean),
  ));
  return keys.length === 1 && MEMBERSHIP_FEE_SOLO_KEYS.has(keys[0]);
}

// Operator-stated setup-fee waiver (agent adjustment channel, owner decision
// 2026-07-23): a per-estimate TRUE waiver — the fee is removed from the
// customer-facing estimate AND never invoiced. Distinct from the
// existing-member waiver (struck-through display) and the annual-prepay
// waiver (fee shown, waived on prepay selection). Set only through the
// confirm-gated operatorPriceAdjustment tool param.
function estimateOperatorSetupFeeWaived(estimateData = {}) {
  const data = normalizeEstimateData(estimateData);
  return data?.operatorPriceAdjustment?.waiveSetupFee === true;
}

function shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices = [], estimateData = {} } = {}) {
  const recurring = Array.isArray(recurringServices) ? recurringServices : [];
  if (recurring.length === 0) return false;
  // Existing customers never pay the WaveGuard setup again — mirrors the
  // public estimate page, which shows the fee struck through as waived.
  const data = normalizeEstimateData(estimateData);
  if (data.membershipSnapshot && data.membershipSnapshot.isExistingCustomer) return false;
  // Operator-stated waiver: removed from display and never invoiced.
  if (data?.operatorPriceAdjustment?.waiveSetupFee === true) return false;
  // A standalone-scheduling supplement (rodent bait scalar after the
  // pest+rodent route removal) makes the plan a multi-service bundle even
  // with one recurring LINE — and the owner rule says bundles carry no
  // setup fee (the bundle is the incentive). A scalar duplicating a real
  // line doesn't count (the mix check below already handles that shape).
  const recurringKeys = new Set(recurring.map(recurringServiceKey).filter(Boolean));
  const hasStandaloneSupplement = supplementalCompanionLines(data).some((supplement) => {
    const key = recurringServiceKey(supplement);
    return !!STANDALONE_SUPPLEMENT_ROUTES[key] && !recurringKeys.has(key);
  });
  if (hasStandaloneSupplement) return false;
  // Solo pest / solo mosquito plans charge the setup (no 5% stacking).
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

// The lawn program minimum's floor-protected annual (owner directive
// 2026-07-09): the first $50/mo × 12 of each recurring lawn line that no
// discount — including the annual-prepay % — may cut into. Scans the same
// dual sources as nonDiscountableRecurringAnnualFloor (mapped service rows +
// lineItems) and dedupes by key so a lawn line is only protected once.
// Per-estimate lawn program minimum (pre-push codex P0s, round 9 on #2827) —
// the SINGLE resolution shared by the converter's prepay protection and
// estimate-public's ladder/bundle clamps (the route delegates here), so
// billing and render can never disagree about which floor a quote carries:
// 1. pricingMetadata stamp — the engine (and client fallback engine) record
//    the RESOLVED minimum on every pricing run; a later global re-arm or
//    disarm must never re-price a sent quote (0 = priced disarmed).
// 2. Legacy row evidence — pre-stamp estimates saved while the minimum was
//    armed carry it on the stored rows: priceLawnCare stamps
//    programMinimumMonthly whenever armed (v1 mapper mirrors it at
//    prov/lawnMeta), and clamped rows carry programMinimumApplied /
//    PROGRAM_MINIMUM source (client-fallback rows are value-less — their
//    clamped monthly IS the minimum they were held at). Without this, a
//    pre-disarm $600 quote falls to the now-0 global and renders/accepts
//    below what was saved.
// 3. Live global — estimates with no stamp and no row evidence
//    (post-ruling and pre-#2540 saves): their existing behavior.
function legacyLawnProgramMinimumMonthly(estimateData = {}) {
  const result = estimateData?.result && typeof estimateData.result === 'object'
    ? estimateData.result
    : (estimateData || {});
  const rows = [];
  if (Array.isArray(result?.results?.lawn)) rows.push(...result.results.lawn);
  if (result?.lawnMeta && typeof result.lawnMeta === 'object') rows.push(result.lawnMeta);
  // v1 saves nest the selected-lawn provenance at results.lawnMeta.
  if (result?.results?.lawnMeta && typeof result.results.lawnMeta === 'object') {
    rows.push(result.results.lawnMeta);
  }
  const lineItemSources = [
    ...(Array.isArray(result?.lineItems) ? result.lineItems : []),
    // Admin V2 saves persist the raw engine result separately.
    ...(Array.isArray(estimateData?.engineResult?.lineItems) ? estimateData.engineResult.lineItems : []),
  ];
  for (const li of lineItemSources) {
    if ((li?.service || '') !== 'lawn_care') continue;
    rows.push(li);
    if (Array.isArray(li.tiers)) rows.push(...li.tiers);
  }
  // Explicit value stamps are exact — prefer them outright. Value-less
  // applied rows (client-fallback saves) only bound the minimum from above:
  // each clamped annual is ceil'd to a whole per-application multiple, so a
  // $50 minimum produces rows at $50 (6x/12x) and $50.25 (9x). The MIN over
  // applied rows recovers the tightest cadence-rounding-free estimate and
  // never raises any saved row (every applied row's own price ≥ the min, and
  // the ladder clamp only lifts below-minimum values) — max would over-infer
  // $50.25 and re-price $50 tiers (pre-push codex P0, round 9 on #2827).
  let stampedMax = null;
  let appliedMin = null;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const stampedValue = Number(row.programMinimumMonthly ?? row.prov?.programMinimumMonthly);
    if (Number.isFinite(stampedValue) && stampedValue > 0) {
      stampedMax = Math.max(stampedMax ?? 0, stampedValue);
      continue;
    }
    const applied = row.programMinimumApplied === true
      || row.prov?.programMinimumApplied === true
      || row.pricingSource === 'PROGRAM_MINIMUM'
      || row.prov?.pricingSource === 'PROGRAM_MINIMUM'
      || row.programMinimumGuardApplied === true;
    if (!applied) continue;
    let monthly = Number(row.mo ?? row.monthly);
    if (!(Number.isFinite(monthly) && monthly > 0)) {
      const annual = Number(row.annualAfterDiscount ?? row.annual ?? row.ann);
      monthly = Number.isFinite(annual) && annual > 0 ? Math.round((annual / 12) * 100) / 100 : NaN;
    }
    if (Number.isFinite(monthly) && monthly > 0) {
      appliedMin = appliedMin == null ? monthly : Math.min(appliedMin, monthly);
    }
  }
  return stampedMax ?? appliedMin;
}

// Signal-only variant: stamp → legacy row evidence → NULL (no live-global
// fallback). estimate-public's engine-input replay uses this to decide
// whether to thread a saved minimum into generateEstimate — a silent
// estimate must replay under the live global, not a frozen copy of it.
function estimateLawnProgramMinimumSignal(estimateData = {}) {
  const stamped = estimateData?.result?.pricingMetadata?.lawnProgramMinimumMonthly
    ?? estimateData?.engineResult?.pricingMetadata?.lawnProgramMinimumMonthly
    ?? estimateData?.pricingMetadata?.lawnProgramMinimumMonthly
    ?? estimateData?.result?.routingMetadata?.lawnProgramMinimumMonthly;
  const stampedN = Number(stamped);
  if (stamped != null && Number.isFinite(stampedN) && stampedN >= 0) return stampedN;
  return legacyLawnProgramMinimumMonthly(estimateData);
}

// Operator-acknowledged manual-discount floor breach (owner decision
// 2026-07-23). The engine only stamps this when a confirmed operator
// adjustment actually cut below the lawn floors; every per-estimate floor
// consumer (program-minimum resolver below, estimate-public's arm state,
// prepay protection) must treat the breach as a per-estimate disarm, or
// view/accept/billing would clamp the authorized sub-floor price back UP.
// Same stamp locations as estimateLawnProgramMinimumSignal, plus the stored
// discount summary as fallback evidence for shapes that keep summary but
// drop pricingMetadata.
function estimateManualDiscountFloorBreachAcknowledged(estimateData = {}) {
  const stamped = estimateData?.result?.pricingMetadata?.manualDiscountFloorBreach
    ?? estimateData?.engineResult?.pricingMetadata?.manualDiscountFloorBreach
    ?? estimateData?.pricingMetadata?.manualDiscountFloorBreach
    ?? estimateData?.result?.routingMetadata?.manualDiscountFloorBreach;
  if (stamped?.acknowledged === true) return true;
  const summaryDiscount = estimateData?.result?.manualDiscount
    ?? estimateData?.result?.totals?.manualDiscount
    ?? estimateData?.result?.summary?.manualDiscount
    ?? estimateData?.engineResult?.summary?.manualDiscount
    ?? estimateData?.summary?.manualDiscount;
  return summaryDiscount?.floorBreach?.acknowledged === true;
}

// Pre-breach resolution (stamp → legacy evidence → live global). The
// breach-aware resolver below layers the per-estimate disarm on top; prepay
// protection deliberately uses THIS one — see lawnProgramMinimumProtectedAnnual.
function resolveLawnProgramMinimumMonthlyIgnoringBreach(estimateData = {}) {
  const signal = estimateLawnProgramMinimumSignal(estimateData);
  if (signal != null) return signal;
  const live = Number(LAWN_PRICING_V2.programMinimumMonthly);
  return Number.isFinite(live) && live > 0 ? live : 0;
}

function resolveLawnProgramMinimumMonthlyForEstimate(estimateData = {}) {
  if (estimateManualDiscountFloorBreachAcknowledged(estimateData)) return 0;
  return resolveLawnProgramMinimumMonthlyIgnoringBreach(estimateData);
}

function lawnProgramMinimumProtectedAnnual(estimateData = {}) {
  // Deliberately IGNORES an acknowledged floor breach (codex P2 on #2947
  // round 4): the breach disarm exists so render/accept never clamp the
  // authorized sub-floor price back UP — but this protection only ever CAPS
  // the annual-prepay discount (callers Math.min against it, never raise).
  // Dropping it on a breached estimate would let a customer-selected prepay
  // % stack a further cut below the number the confirmation card authorized.
  const minMonthly = resolveLawnProgramMinimumMonthlyIgnoringBreach(estimateData);
  if (!Number.isFinite(minMonthly) || minMonthly <= 0) return 0;
  const floorAnnual = Math.round(minMonthly * 12 * 100) / 100;
  const protectedSum = (rows) => Math.round(rows.reduce((sum, item) => {
    const annual = recurringLineAnnualAmount(item);
    // Protect the FULL floor per line, not min(annual, floor): the floor is
    // what the customer is actually billed — public render/accept clamp every
    // recurring lawn line up to the program minimum, so a stale pre-floor
    // stored annual (e.g. $408 on an outstanding link whose bundle re-clamps
    // to $600) must not leave the clamped-up slice discountable, or the
    // prepay % lands the invoice below the minimum. Over-protection is the
    // safe direction: the caller's Math.min(base, floor) cap means it can
    // only shrink the prepay discount, never raise the invoice above base.
    return annual > 0 ? sum + floorAnnual : sum;
  }, 0) * 100) / 100;
  // Acceptance restamps recurring.services (NOT engine lineItems), so a
  // stale source must never shrink the protection below what the accepted
  // rows warrant — take the larger of the two sources. Both protect exactly
  // the floor per line, so a source disagreement (differing line counts) can
  // only over-protect (shrinking the prepay discount), never under-protect.
  const fromLineItems = protectedSum(estimateLineItemsFromData(estimateData)
    .filter((i) => recurringServiceKey(i) === 'lawn_care'));
  const fromRecurringRows = protectedSum(recurringServicesFromEstimateData(estimateData)
    .filter((svc) => recurringServiceKey(svc) === 'lawn_care'));
  return Math.max(fromLineItems, fromRecurringRows);
}

// Single source of truth for the annual-prepay invoice amount, shared by the
// converter (billing), the public estimate render, and the accept response so the
// displayed/messaged total always equals the invoice the converter creates.
// Non-pest/mosquito mixes take ANNUAL_PREPAY_DISCOUNT_PCT off the recurring annual;
// the non-discountable recurring floor (margin-protected non-lawn lines) still
// clamps the result, so callers never quote a total below what is actually billed.
// The two inputs the prepay math needs for ANY base annual: the configured
// discount % for this service mix, and the floor-protected slice no discount
// may cut into. Exposed so the SSR page's client-side refresh
// (refreshBillingAmounts) can re-derive the SAME floor-aware total this
// module invoices when the annual changes — multiplying a new annual by a
// previously-computed flat "effective rate" goes stale immediately, because
// the effective rate is itself a function of the annual.
function annualPrepayDiscountComponents({ recurringServices = [], estimateData = {} } = {}) {
  // Solo pest/mosquito mixes normally earn NO prepay % — their incentive is
  // the fee-waived-with-prepay. Owner ruling 2026-07-23: when the operator
  // has already waived the setup fee outright, the mix converts to the
  // standard 5% prepay path (the waiver replaced the fee incentive, so
  // prepay keeps a real reward instead of disappearing).
  const discountRate = recurringMixHasMembershipFeeService(recurringServices)
    && !estimateOperatorSetupFeeWaived(estimateData)
    ? 0
    : ANNUAL_PREPAY_DISCOUNT_PCT;
  const protectedFloor = Math.round((
    nonDiscountableRecurringAnnualFloor(estimateData)
    + lawnProgramMinimumProtectedAnnual(estimateData)
  ) * 100) / 100;
  return { discountRate, protectedFloor };
}

function resolveAnnualPrepayInvoiceTotal({ baseAnnual, recurringServices = [], estimateData = {} } = {}) {
  const base = Math.round((Number(baseAnnual) || 0) * 100) / 100;
  if (!(base > 0)) return { amount: 0, discount: 0, rate: 0 };
  // Apply the prepay % ONLY to the discountable portion. Non-discountable
  // recurring lines (e.g. foam_recurring, whose cadence multiplier is its only
  // discount) are split out first and added back at full price — otherwise a
  // mixed plan (foam + lawn) would still bleed part of the 5% onto foam because
  // a simple max(discounted, floor) clamp only protects foam-heavy mixes.
  // The lawn program minimum's protected slice (owner directive 2026-07-09:
  // prepay is NOT exempt from the floor) joins the same non-discountable
  // floor — only lawn's above-floor headroom earns the prepay %.
  const { discountRate, protectedFloor } = annualPrepayDiscountComponents({ recurringServices, estimateData });
  const floor = Math.min(base, protectedFloor);
  const discountableBase = Math.max(0, Math.round((base - floor) * 100) / 100);
  const amount = Math.round((floor + discountableBase * (1 - discountRate)) * 100) / 100;
  const discount = Math.max(0, Math.round((base - amount) * 100) / 100);
  return { amount, discount, rate: Math.round((discount / base) * 10000) / 10000 };
}

// Human label for the EFFECTIVE annual-prepay rate on invoice copy. The lawn
// program minimum's protected floor can cap the discount well below the
// configured 5% (only above-floor headroom is discountable), so the invoice
// must never claim the configured rate. Mirrors the estimate-public SSR label
// rules — integer percent at ≥1%, one decimal below — and renders '<0.1%'
// instead of a misleading '0%' when a nonzero discount rounds away.
function annualPrepayDiscountPctLabel(rate) {
  const r = Number(rate) || 0;
  if (r >= 0.01) return `${Math.round(r * 100)}%`;
  if (r <= 0) return '0%';
  const oneDecimal = Math.round(r * 1000) / 10;
  return oneDecimal > 0 ? `${oneDecimal}%` : '<0.1%';
}

function shouldCreateDraftInvoiceForRecurring({ billingTerm = 'standard', recurringServices = [], standaloneUnitCount = 0 } = {}) {
  const hasRecurringLines = Array.isArray(recurringServices) && recurringServices.length > 0;
  if (!hasRecurringLines) {
    // A supplemental-only accept (bait scalar, no recurring lines) still
    // schedules a real recurring series — an annual prepay for it needs its
    // term + invoice or the paid prepay never stamps the visits (Codex r2
    // on the pest+rodent removal). Standard supplemental-only accepts keep
    // the pre-existing no-draft shape.
    return billingTerm === 'prepay_annual' && standaloneUnitCount > 0;
  }
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
  // Tree & Shrub visits book flat 60-minute slots (owner directive — the
  // same value estimate-slot-availability uses), so seeded follow-ups match
  // what a self-booked T&S slot would reserve.
  if (key === 'tree_shrub') return 60;
  return null;
}

// Restamped Tree & Shrub tier rows carry their real catalog service_key
// (tree_shrub_program / tree_shrub_quarterly / tree_shrub_6week) — pass it
// through so the scheduled row links service_id and typed-profile
// resolution survives catalog renames (audit 2026-07-18 P2: converted T&S
// rows had no service_id and rode an exact name-string match). Other lines
// keep name-based resolution until their keys are verified against the
// catalog — an absent key would only add lookup-warn noise.
function remainingUnitCatalogKey(svc = {}) {
  const key = String(svc.serviceKey || svc.service_key || '').trim();
  if (/^tree_shrub(_program|_quarterly|_6week)$/.test(key)) return key;
  // Recurring foam: key verified against the catalog 2026-08-08 — the
  // foam_recurring row ships in the same PR (20260808070000). The seeder
  // normalizer matches both the engine key (priceRecurringFoam returns
  // service 'foam_recurring') and the "Recurring Foam Treatment" display
  // name, so legacy name-only lines link too. Absent row (env not yet
  // migrated) degrades to the existing name-only warn path.
  if (RecurringAppointmentSeeder.serviceKeyFor(svc) === 'foam_recurring') return 'foam_recurring';
  // NOTE (2026-08-09): trap_only_retainer deliberately has NO branch
  // here. The v1 mapper persists retainers under oneTime.specItems (not
  // RECURRING_SERVICES) and the pricer rows carry no `annual`, so this
  // function never receives them — a branch would be dead code. Making
  // the retainer a first-class recurring service (cadence, monthly_rate,
  // prepay interactions) is an owner-gated billing design queued with
  // the link-at-write lane.
  return null;
}

function recurringServiceForScheduledRow(recurringServices = [], scheduledRow = {}) {
  const rowKey = RecurringAppointmentSeeder.serviceKeyFor({ service_type: scheduledRow.service_type });
  return recurringServices.find((svc) => RecurringAppointmentSeeder.serviceKeyFor(svc) === rowKey)
    || recurringServices.find((svc) => recurringServiceKey(svc) === 'pest_control')
    || recurringServices[0]
    || { service_type: scheduledRow.service_type };
}

// Termite billing riders ride the bait visit instead of being units of
// their own: the bond via its combined route, the station rental with no
// row at all. Both must stay out of every unit count, or a bait+rider plan
// reads as multi-unit and nulls the whole-plan per-application fee.
function isTermiteStationRentalLine(svc = {}) {
  return recurringServiceKey(svc) === 'termite_station_rental';
}

function isTermiteBillingRiderLine(svc = {}) {
  const key = String(recurringServiceKey(svc) || '');
  return key.startsWith('termite_bond') || key === 'termite_station_rental';
}

// Drop the rental rider from the conversion set WITHOUT losing its money
// (codex P1, round 4). The rider is never a scheduling unit — but on a
// multi-unit plan (pest + termite) the whole-plan per_application_fee and
// row prices go per-row/manual, and a silently-dropped rental line left no
// billing carrier for the uplift: termite completions could never collect
// the hardware-recovery charge. Fold the rider's amounts into the bait
// line's billing fields FIRST (per-application, monthly, exact annual), so
// every downstream reader of the bait unit — row pricing, manual
// allocation, seeding — sees the true bait+rental amount, then drop the
// rider row. Single-unit plans are unaffected: their fee derives from the
// plan-level totals, which always included the uplift.
function foldTermiteRentalIntoBait(services = []) {
  const rental = services.find(isTermiteStationRentalLine);
  const rest = services.filter((svc) => !isTermiteStationRentalLine(svc));
  if (!rental) return rest;
  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  const upliftPerApp = Number(rental.perTreatment ?? rental.perApp) || 0;
  const upliftAnnual = Number(rental.annual)
    || round2(upliftPerApp * (Number(rental.visitsPerYear) || 4));
  const upliftMonthly = Number(rental.mo ?? rental.monthly) || 0;
  return rest.map((svc) => {
    if (recurringServiceKey(svc) !== 'termite_bait') return svc;
    return {
      ...svc,
      perTreatment: round2((Number(svc.perTreatment) || 0) + upliftPerApp),
      mo: round2((Number(svc.mo ?? svc.monthly) || 0) + upliftMonthly),
      monthly: round2((Number(svc.monthly ?? svc.mo) || 0) + upliftMonthly),
      // Exact-annual sum (the rider's annual is exact even when its rounded
      // monthly is not — same drift the mapper's annualTotal fix addresses).
      annual: round2((Number(svc.annual) || 0) + upliftAnnual),
      // Audit breadcrumb: how much of this line is hardware recovery.
      termiteStationRentalFoldedPerApp: upliftPerApp,
    };
  });
}

// The customers.termite_stations_rented patch for an accept (owner
// 2026-07-26; codex P1 rounds 1+2). Three-way, evidence-driven:
//   rental line present        → true  (the accepted agreement is the only
//                                place that knows Waves keeps title; the
//                                install visit that creates the pins can't
//                                see it)
//   purchased bait, no rental  → false (a former renter buying outright must
//                                not keep the renter flag — new pins would
//                                stamp owned_by='waves' and mark customer
//                                hardware for "recovery")
//   no termite line at all     → {}    (an unrelated accept is not an owner
//                                action on station title)
// Read from the UNfiltered recurring lines — conversion drops the rental
// rider from its service set before scheduling, so this must run first.
function termiteStationsRentedUpdate(recurringServices = [], { suppressRecurringConversion = false } = {}) {
  if (suppressRecurringConversion) return {};
  if (recurringServices.some(isTermiteStationRentalLine)) return { termite_stations_rented: true };
  if (recurringServices.some((svc) => recurringServiceKey(svc) === 'termite_bait')) {
    return { termite_stations_rented: false };
  }
  return {};
}

// The per-application charge divides the plan annual by the SINGLE unit's
// visit count. Termite riders are unit-count-exempt, so the single unit is
// the non-rider line set (codex #2915 r6) — bait+bond derives 4 from the
// bait line; true multi-unit plans still return null.
function riderAwareSingleUnitVisits(recurringLines = [], supplementUnitCount = 0) {
  const nonRider = (Array.isArray(recurringLines) ? recurringLines : [])
    .filter((svc) => !isTermiteBillingRiderLine(svc));
  if (nonRider.length !== 1 || supplementUnitCount !== 0) return null;
  return visitsPerYearForRecurringService(nonRider[0]);
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
  // Standalone rodent bait (owner 2026-07-12, pest+rodent combined route
  // removed): the quarterly bait-station program seeds its own series — the
  // old combined row keyed as pest_control and seeded; a standalone row
  // keying rodent_bait must not stop after the first check (Codex P1).
  if (key === 'rodent_bait') return pattern === 'quarterly';
  // Standalone termite bait (owner 2026-07-20, billed per application):
  // new estimates persist visitsPerYear=4, so the line infers quarterly and
  // must seed its series — per-application billing on one lone visit would
  // collect a quarter of the accepted annual. The explicit-visits check is
  // the legacy gate (codex P2): a legacy row can still reach here with
  // pattern 'quarterly' inherited from the accept flow's selected/inferred
  // frequency (not from the row), and seeding those would break the
  // legacy-preservation contract — no visitsPerYear, no series; office
  // schedules follow-ups and the flat-monthly-derived fee stands.
  if (key === 'termite_bait') {
    return pattern === 'quarterly' && visitsPerYearForRecurringService(svc) === 4;
  }
  // Tree & Shrub programs (owner six-visit mandate; T&S audit 2026-07-18 P1:
  // a sold program produced ONE visit and no series). The 6x Standard accept
  // restamps to the bi-monthly catalog row and the 4x Light downsell to
  // quarterly — seed those. The un-retired 9x Enhanced (2026-07-24) restamps
  // frequency 'every_6_weeks' + visitsPerYear 9 and seeds 42-day gaps; the
  // explicit-visits check keeps LEGACY 9-visit rows (no every_6_weeks
  // frequency text — they infer bimonthly and would seed 2-month gaps) with
  // office scheduling exactly as before.
  if (key === 'tree_shrub') {
    const visits = visitsPerYearForRecurringService(svc);
    if (pattern === 'every_6_weeks') return visits === 9;
    if (pattern === 'bimonthly') return visits == null || visits === 6;
    if (pattern === 'quarterly') return visits == null || visits === 4;
    return false;
  }
  // Mosquito (owner 2026-07-27). Neither program seeded before this, so a sold
  // plan booked its FIRST visit and never created the rest — the customer was
  // billed monthly for a series they did not get. Same failure the T&S audit
  // found; monthly mosquito was already live and bookable when this shipped.
  //
  // Seasonal is gated on the EXPLICIT seasonal cadence, never on a bare
  // 9-visit count: numeric 9-visit inference resolves to 'bimonthly', and
  // seeding a 9-visit seasonal plan at 2-month gaps would be the wrong cadence
  // AND the wrong dates. A legacy row that reaches here as bimonthly keeps
  // office scheduling, exactly as before.
  if (key === 'mosquito') {
    const visits = visitsPerYearForRecurringService(svc);
    if (pattern === RecurringAppointmentSeeder.SEASONAL_FEB_OCT) return visits === 9;
    if (pattern === 'monthly') return visits == null || visits === 12;
    return false;
  }
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

// The pattern seedRecurringFollowUpsForParent would actually seed for this
// service/parent pair, or null when seeding would no-op. The guarded seeding
// paths use it to decide whether the duplicate-series lock + re-check is
// warranted at all — running the guard for a row that would never seed a
// series would write misleading "series skipped" notes (and take a lock) for
// nothing.
// Termite bait rows carry their cadence ONLY as explicit visitsPerYear (no
// frequency text), and inferRecurringPattern checks text candidates —
// including the plan-level fallback — BEFORE it reads visits. A monthly or
// bimonthly plan cadence would therefore win over the row's own quarterly
// visits, and the billed-per-application termite program would seed nothing
// (codex #2911 r3 P1). Suppress the fallback when the row's own visits
// speak; every other service keeps the fallback semantics unchanged.
function cadenceFallbackForSeeding(svc = {}, fallbackFrequency) {
  if (RecurringAppointmentSeeder.serviceKeyFor(svc) === 'termite_bait'
    && visitsPerYearForRecurringService(svc)) {
    return null;
  }
  return fallbackFrequency;
}

function converterFollowUpSeedingPattern(svc = {}, parentRow = {}, fallbackFrequency) {
  // A 9-visit mosquito line has exactly ONE valid cadence, so resolve it before
  // generic inference rather than as a fallback. Inference reads cadence FIELDS
  // and display text first, so any stray or legacy frequency on the row —
  // 'bimonthly' from the numeric rule, an every_6_weeks copied from the T&S
  // restamp, anything — would otherwise win and then be rejected by the gate
  // below, silently leaving the plan with no series at all. Nine visits at any
  // other cadence is wrong by construction, so there is nothing to preserve.
  if (RecurringAppointmentSeeder.serviceKeyFor(svc) === 'mosquito'
    && visitsPerYearForRecurringService(svc) === 9) {
    return RecurringAppointmentSeeder.SEASONAL_FEB_OCT;
  }
  const pattern = RecurringAppointmentSeeder.inferRecurringPattern({
    service: { ...svc, service_type: parentRow?.service_type },
    fallbackFrequency: cadenceFallbackForSeeding(svc, fallbackFrequency),
  });
  if (!pattern || !supportsConverterFollowUpSeeding(svc, parentRow, pattern)) return null;
  return pattern;
}

// The cadence an annual-prepay term would record for its coverage. MUST apply
// the same forced-mosquito rule as converterFollowUpSeedingPattern above:
// seasonal quote rows carry frequencyKey 'every_6_weeks' (the estimate-public
// tier map), which raw inference would return — a cadence the prepay layer
// SUPPORTS — while the actual series seeds seasonal_feb_oct. The term would
// then hold a 42-day cadence and the payment-time coverage refresh would seed
// mismatched winter visits over the real series. The caller rejects
// SEASONAL_FEB_OCT (annual-prepay renewal doesn't support the season walk yet)
// so seasonal prepay fails closed on every acceptance path, matching the
// prepay-on-book and /secure lanes (prepayCoverageCadenceForPattern → null).
function annualPrepayCoverageCadence(svc = {}, fallbackFrequency) {
  if (RecurringAppointmentSeeder.serviceKeyFor(svc) === 'mosquito'
    && visitsPerYearForRecurringService(svc) === 9) {
    return RecurringAppointmentSeeder.SEASONAL_FEB_OCT;
  }
  return RecurringAppointmentSeeder.inferRecurringPattern({
    service: svc,
    fallbackFrequency,
  }) || null;
}

// Roll a seasonal first visit into Feb–Oct and re-nudge it off closed days
// and weekends (bounded, fail-open — codex r8 P2). Shared by the
// auto-schedule loop and the reserved-bundle mosquito promotion; in-season
// bases pass through untouched.
async function rolledSeasonalFirstDate(baseDateStr) {
  let out = RecurringAppointmentSeeder.firstInSeasonDate(baseDateStr);
  if (out === baseDateStr) return out;
  try {
    const { isBlackoutDate } = require('./scheduling/blackout-dates');
    const { parseETDateTime, etParts, addETDays } = require('../utils/datetime-et');
    for (let nudge = 0; nudge < 14; nudge++) {
      const at = parseETDateTime(`${out}T12:00`);
      const { dayOfWeek } = etParts(at);
      const closed = dayOfWeek === 0 || dayOfWeek === 6 || (await isBlackoutDate(out));
      if (!closed) break;
      out = etDateString(addETDays(at, 1));
    }
  } catch (nudgeErr) {
    logger.warn(`[estimate-converter] rolled-date closed-day nudge failed (failing open): ${nudgeErr.message}`);
  }
  return out;
}

async function seedRecurringFollowUpsForParent(database, parentRow, svc = {}, opts = {}) {
  const pattern = converterFollowUpSeedingPattern(svc, parentRow, opts.fallbackFrequency);
  if (!pattern) return { pattern: null, insertedCount: 0, insertedRows: [] };
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
    // Prepay-on-book (admin-schedule accept-on-book): the caller books the
    // first visit itself under skipAutoSchedule, so the converter can't see
    // that row and would otherwise anchor the renewal term to today — a
    // future-dated booking could then renew before its first service. The
    // caller passes the booked first date here (date-only 'YYYY-MM-DD').
    const annualPrepayTermStart = typeof opts.annualPrepayTermStart === 'string' && opts.annualPrepayTermStart
      ? opts.annualPrepayTermStart
      : null;
    // Coverage override for a prepay accept made WHILE booking: the booked
    // scheduled_services rows are the coverage series, so the term's
    // coverage_service_type must equal the BOOKED service_type (and the visit
    // count/cadence the booked series') for attach/stamp to find them. Only
    // honored as a pair — a service type without a positive visit count would
    // create a term applyPrepaidCoverageForTerm can't stamp, so an incomplete
    // override falls back to the converter's own derivation instead.
    const annualPrepayCoverageOverride = (
      typeof opts.coverageServiceType === 'string' && opts.coverageServiceType
      && Number.isInteger(opts.coverageVisitCount) && opts.coverageVisitCount > 0
    )
      ? {
        serviceType: opts.coverageServiceType,
        visitCount: opts.coverageVisitCount,
        cadence: typeof opts.coverageCadence === 'string' && opts.coverageCadence ? opts.coverageCadence : undefined,
      }
      : null;
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
    // Station rental (owner 2026-07-26) is a pure BILLING rider, and unlike
    // the bond rider it is NOT a scheduling unit under any route. The bond
    // needs a visit identity — its "%Termite Bond% (N-Year Term)" name is
    // the termite_bonds lifecycle-sync contract — so it rides a combined
    // route. The rental has no lifecycle table and no name contract: the
    // stations it pays for are checked on the bait visit that already
    // exists, so there is nothing for a second row to do.
    //
    // Leaving the line in the conversion set breaks billing three ways
    // (codex P0 on this PR): scheduling turns it into a phantom "Termite
    // Station Rental" appointment, the plan reads as multi-unit so
    // riderAwareSingleUnitVisits returns null, and per_application_fee +
    // both rows' estimated_price go null — completion then invoices
    // NOTHING, monitoring included. But a bare drop loses the uplift on
    // MULTI-unit plans (codex P1 round 4), so the rider's amounts are
    // folded into the bait line's billing fields before the row goes —
    // single-unit fees still derive from the rental-inclusive plan totals.
    const recurringServicesForConversion = suppressRecurringConversion
      ? []
      : foldTermiteRentalIntoBait(recurringServices);
    // Read BEFORE the filter drops the line — this is the only signal that
    // the sold program rents its stations, and it has to outlive conversion
    // (see the customers.termite_stations_rented stamp below).
    const stationsRentedPatch = termiteStationsRentedUpdate(recurringServices, { suppressRecurringConversion });
    // FAIL-CLOSED money guard: annual-prepay coverage is a per-TERM fact and an
    // annual_prepay_terms row carries exactly ONE coverage service
    // (coverage_service_type / coverage_visit_count / coverage_cadence). A
    // multi-recurring-service annual prepay cannot stamp prepaid_amount for every
    // covered service, so the un-stamped services' visits complete-bill again
    // (double bill). This counts BOTH the recurring.services lines AND any
    // supplemental companion (e.g. rodentBaitMo) that rides OUTSIDE
    // recurring.services yet combines with a matching primary into ONE visit
    // relabelled combo.route.name (e.g. "Pest & Rodent Control"): single-service
    // coverage keyed on the raw primary name ("Pest Control") can't match that
    // combined service_type, so the combined visit would go unstamped (and a
    // duplicate primary series would be seeded) → the same double bill. Refuse the
    // automatic conversion up front — BEFORE any customer/visit/term/invoice write
    // — and route to manual until the price-free coverage redesign (Phase 2)
    // supports multi-service. Blocking here (not at the term-creation site
    // downstream) guarantees no partial rows are created; all three convertEstimate
    // entrypoints run inside a transaction, so a throw rolls back cleanly.
    const supplementalCompanions = supplementalCompanionLines(estimateData);
    // ONE scheduling decision for the whole accept (Codex r2 on the
    // pest+rodent removal): the auto-schedule loop, the reservation branch,
    // unit counting, and prepay coverage all read this same result, so the
    // count can never disagree with what actually schedules. Only
    // fromSupplement standalone units add to the count — a line-sourced
    // standalone unit was already counted among the recurring lines, and
    // the combine dedupes a line + duplicate scalar to one unit.
    const combinedScheduling = combineRecurringServicesForScheduling(recurringServicesForConversion, {
      acceptFrequency: estimateData.customerSelection?.frequency || null,
      supplementalCompanions,
    });
    const supplementStandaloneUnits = combinedScheduling.standalone.filter((unit) => unit.fromSupplement);
    // Termite bond lines are RIDERS, not units (owner 2026-07-20): the bond
    // folds into the bait visit via its combined route, so counting it would
    // flip a bait+bond plan to "multi-unit" and null out the whole-plan
    // per-application fee/row price that the single combined visit must
    // carry ($150/application = monitoring + bond, whole plan ÷ 4).
    // (Station-rental lines are already filtered out of
    // recurringServicesForConversion above — they are never units.)
    const isTermiteBondLine = (svc) => String(recurringServiceKey(svc) || '').startsWith('termite_bond');
    const hasTermiteBondLine = recurringServicesForConversion.some(isTermiteBondLine);
    const recurringUnitCount = recurringServicesForConversion.filter((svc) => !isTermiteBondLine(svc)).length
      + supplementStandaloneUnits.length;
    // FAIL-CLOSED (same posture as the multi-service prepay guard below): an
    // annual_prepay_terms row carries ONE coverage service keyed on the
    // primary name — the combined "…+ Termite Bond Service" service_type
    // can't be stamped, so its completions would bill again on top of the
    // prepaid amount. Route bond + annual-prepay to manual conversion.
    if (billingTerm === 'prepay_annual' && hasTermiteBondLine) {
      const err = new Error(
        'Annual prepay isn\'t supported with a termite bond rider yet — convert this estimate as per-application billing, or bill the prepay manually.'
      );
      err.code = 'ANNUAL_PREPAY_TERMITE_BOND_UNSUPPORTED';
      err.isOperational = true;
      err.status = 422;
      err.statusCode = 422;
      throw err;
    }
    if (billingTerm === 'prepay_annual' && recurringUnitCount > 1) {
      const err = new Error(
        `Annual prepay isn't supported for multi-service plans (${recurringUnitCount} recurring services) yet — convert this estimate as monthly, or bill the annual prepay manually.`
      );
      err.code = 'ANNUAL_PREPAY_MULTI_SERVICE_UNSUPPORTED';
      err.isOperational = true;
      err.status = 422;
      err.statusCode = 422;
      throw err;
    }
    const estimateQualifyingKeys = tierQualifyingRecurringServiceKeys(recurringServicesForConversion);
    const serviceCount = estimateQualifyingKeys.length;
    // Combined-tier activation (owner case 2026-08-05): the QUOTE prices and
    // advertises an add-on estimate at the COMBINED tier — the customer's
    // existing qualifying plans plus this estimate's additions — but
    // activation counted only THIS estimate's lines, so an existing
    // quarterly-pest customer accepting a tree & shrub add-on activated
    // Bronze/0% instead of the quoted Silver/10%. Load the same shared prior
    // keys the quote side uses. Fail-soft to the estimate-only count: a
    // lookup error must not block the acceptance — it just reverts to the
    // old (under-counting) tier for this accept. Savepoint-confined (codex
    // #3228 r1): `database` is the caller's acceptance transaction on the
    // public/manual accept paths, and a failed SQL statement would leave
    // that transaction aborted — the JS catch alone couldn't deliver the
    // advertised fallback because every later conversion query would fail.
    // The nested transaction rolls back only the savepoint.
    let priorQualifyingKeys = [];
    if (!suppressRecurringConversion && serviceCount > 0) {
      // The FROZEN snapshot wins (codex r6) — activation must match what the
      // quote priced and displayed; the live lookup covers only legacy
      // estimates saved before snapshots existed.
      const snapshotKeys = priorQualifyingKeysFromSnapshot(estimateData);
      if (snapshotKeys) {
        priorQualifyingKeys = snapshotKeys;
      } else {
        try {
          priorQualifyingKeys = await database.transaction(
            (sp) => loadExistingQualifyingServiceKeys(sp, customerId),
          );
        } catch (priorErr) {
          logger.warn(`[estimate-converter] prior qualifying-services lookup failed for customer ${customerId} (tier falls back to estimate-only count): ${priorErr.message}`);
          priorQualifyingKeys = [];
        }
      }
    }
    const combinedServiceCount = combinedTierQualifyingCount(estimateQualifyingKeys, priorQualifyingKeys);
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
      standaloneUnitCount: supplementStandaloneUnits.length,
    });

    // Determine tier
    const { tier, discount } = suppressRecurringConversion
      ? { tier: 'One-Time', discount: 0 }
      : commercialOnlyRecurring
        ? { tier: 'none', discount: 0 } // written as the non-member 'Commercial' sentinel below
        : determineTier(combinedServiceCount, recurringServicesForConversion.length > 0);
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
          annualRate: parseFloat(estimate.annual_total || 0),
          frequencyKey: inferredFrequencyKey,
          estimateData,
          fallbackFrequencyKey: inferredFrequencyKey,
        })
      : null;
    // True per-visit charge for per_application billing. billingCadence.amount
    // is the per-CHARGE amount at the accepted billing cadence — identical to
    // the per-visit price only when the billing interval matches the visit
    // cadence (quarterly pest). Tier plans present a monthly price but deliver
    // a different visit count (tree & shrub 6x/4x, lawn ladders, mosquito
    // seasonal); stamping the monthly rate on per-visit billing collects only
    // visits/12 of the accepted annual (T&S audit 2026-07-18 P1). Single
    // recurring unit only — the same gate the fee and estimated_price writers
    // use; a standalone supplement beside it means the plan annual isn't this
    // unit's annual, so the cadence fallback (status quo) applies.
    // Rider-aware (codex #2915 r6): the bond is carved out of the unit
    // count, so the "single unit" whose visits drive the per-application
    // division is the NON-bond line set. Without this, a raw engine-backed
    // bait+bond accept (no recurring.services for the cadence inference to
    // read → monthly fallback) would stamp the monthly total as the
    // per-visit fee ($50) instead of plan-annual ÷ visits ($600/4 = $150).
    const singleRecurringUnitVisits = riderAwareSingleUnitVisits(
      recurringServicesForConversion,
      supplementStandaloneUnits.length,
    );
    const perApplicationAmount = billingCadence
      ? perApplicationChargeAmount({
          billingCadence,
          annualRate: parseFloat(estimate.annual_total || 0),
          monthlyRate,
          visitsPerYear: singleRecurringUnitVisits,
        })
      : null;

    // A CURRENT monthly member accepting an add-on/upgrade estimate keeps
    // their membership model — an unconditional per_application stamp would
    // stop the monthly cron for them and start billing every completion per
    // visit (Codex round-7 P1). "Current member" = live pipeline stage + a
    // positive monthly_rate + not already an estimate-flow mode. Everyone
    // else (new signups, leads, churned/dormant re-signups) converts to
    // per-visit billing per the owner ruling; annual-prepay accepts are
    // re-stamped at the term choke point either way.
    // Shared predicate (billing-cadence.js) — the estimate display surfaces
    // read the same function so the "Billed $X/mo" disclosure can never
    // drift from the billing behavior decided here.
    const preservesExistingMembership = customerPreservesMonthlyMembership(customer);
    // An ADD-ON accept (existing recurring customer buying a NEW service
    // family) must not clobber monthly_rate with just the add-on's monthly:
    // for a monthly member the cron charges monthly_rate directly, so the
    // overwrite silently swaps their whole bill for the add-on's slice; for
    // per-application customers the rate feeds MRR, LTV, and every
    // membership predicate. The customer's total becomes existing + add-on
    // (the combined-tier quote card promises exactly that: additions are
    // discounted "without repricing current service"). A SAME-family accept
    // (re-quote/reprice — the #3228 adoption path, which stamps
    // source_estimate_id on the adopted row before conversion runs) keeps
    // the replace semantic: the new quote IS that plan's new price.
    // Fail-safe: any classification doubt → 0 → replace (status quo).
    // Lock BEFORE reading the rate the classification and ledger derive
    // from (codex #3245 r5): an admin rate clear committing mid-accept
    // could otherwise be read stale, parked as unattributed, and undone.
    // The same lock serializes concurrent accepts and the pre-flip
    // backfill (which takes customers FOR UPDATE). Locks taken here
    // persist to the end of the caller's transaction.
    let effectiveCustomer = customer;
    if (!suppressRecurringConversion && database.isTransaction) {
      const lockedCustomerRow = await database('customers')
        .where({ id: customerId })
        .forUpdate()
        .first();
      if (lockedCustomerRow) effectiveCustomer = lockedCustomerRow;
    }
    const addOnContext = suppressRecurringConversion
      ? { addOnBase: 0, hadOtherLiveFamilies: false }
      : await classifyAddOnAcceptContext({
        database, estimateId, estimate, estimateData, customer: effectiveCustomer,
        adoptedExistingAppointmentId: opts.adoptedExistingAppointmentId || null,
      });
    const addOnPreservedRateBase = addOnContext.addOnBase;
    // Plan-rate ledger (owner ruling 2026-08-06, GATE_PLAN_RATE_LEDGER):
    // per-family slices of this accept. With the gate ON and a seeded
    // ledger, the scalar becomes the LEDGER SUM — a same-family re-quote
    // replaces only its own family's slice and every other plan's slice
    // survives (the multi-plan fix). Gate OFF (or any ledger failure): the
    // legacy #3241 scalar semantics below stand byte-for-byte and the
    // ledger only dual-writes advisorily. Savepoint-confined + fail-soft:
    // a ledger defect must never block an acceptance.
    let ledgerScalar = null;
    let ledgerAdvisoryScalar = null;
    let planRateReviewNeeded = false;
    // GROUPED estimates (#3244 multi-property) bypass ledger ATTRIBUTION
    // entirely (codex #3245 r12): same-family plans at different properties
    // share one (customer, family) component key, and no marker scheme can
    // split a merged component when one property later re-quotes. The
    // SCALAR keeps #3244's correct legacy math (property-scoped add-on sum
    // / replace); the ledger resets to a single unattributed component
    // matching the committed scalar after the update below, with the
    // review alert when attribution existed. Per-property components are
    // the follow-up build gated on multi-property going live.
    const groupedEstimateAccept = !!estimate?.estimate_group_id;
    if (!suppressRecurringConversion && !groupedEstimateAccept) {
      try {
        const PlanRateLedger = require('./plan-rate-ledger');
        const slices = PlanRateLedger.estimateFamilySlices({ estimateData, monthlyRate });
        // The customer row lock was taken BEFORE classification above
        // (codex r3/r5) — it serializes concurrent accepts and the
        // pre-flip backfill, and every derived figure below reads the
        // LOCKED snapshot (effectiveCustomer), never the pre-lock row.
        const ledgerOutcome = await database.transaction((sp) => PlanRateLedger.applyAcceptToLedger(sp, {
          customerId,
          estimateId,
          slices,
          previousScalar: Number(effectiveCustomer.monthly_rate) || 0,
          addOnBase: addOnPreservedRateBase,
          hadOtherLiveFamilies: addOnContext.hadOtherLiveFamilies,
          customerIsLive: ['active_customer', 'won', 'at_risk'].includes(effectiveCustomer.pipeline_stage),
        }));
        // ZERO is a legitimate authoritative scalar (codex #3245 r8): a
        // fully comped recurring accept deletes every component and must
        // write 0, not fall back to a legacy figure over live components.
        // But NULL is the no-slices sentinel, not a zero (codex #3245 r22
        // — Number(null) coerces to 0): treating it as authoritative would
        // clear the scalar while stale components survive, AND its
        // non-null advisory echo would block the unsliced_accept ledger
        // reset below from reconciling them.
        if (ledgerOutcome && ledgerOutcome.scalar != null && Number.isFinite(Number(ledgerOutcome.scalar))) {
          ledgerAdvisoryScalar = Math.round(Number(ledgerOutcome.scalar) * 100) / 100;
        }
        if (PlanRateLedger.planRateLedgerEnabled() && ledgerAdvisoryScalar != null && ledgerAdvisoryScalar >= 0) {
          ledgerScalar = ledgerAdvisoryScalar;
          planRateReviewNeeded = ledgerOutcome.reviewNeeded === true;
        }
      } catch (ledgerErr) {
        ledgerScalar = null;
        // With the gate ON the ledger has scalar authority — the ACCEPT
        // ABORTS (codex #3245 r12): falling back to legacy whole-scalar
        // replacement for a seeded multi-plan customer is the exact
        // underbilling the ledger exists to prevent, and it would commit
        // with no review signal. The customer gets a retryable error.
        // Gate OFF, the write is advisory — log and proceed.
        const PlanRateLedger = require('./plan-rate-ledger');
        if (PlanRateLedger.planRateLedgerEnabled()) {
          logger.error(`[estimate-converter] plan-rate ledger apply failed for customer ${customerId} under scalar authority — aborting acceptance: ${ledgerErr.message}`);
          throw ledgerErr;
        }
        logger.warn(`[estimate-converter] advisory plan-rate ledger apply failed for customer ${customerId}: ${ledgerErr.message}`);
      }
    }
    // Provisional figure for the audit outputs below — the WRITE itself is
    // ledger-derived (gate on) or an atomic in-database increment (legacy
    // add-on path), and the actual post-update value is re-read after the
    // update for logs/email/return.
    let convertedMonthlyRate = ledgerScalar != null
      ? ledgerScalar
      : (addOnPreservedRateBase > 0
        ? Math.round((addOnPreservedRateBase + monthlyRate) * 100) / 100
        : monthlyRate);
    // Pre-migration compatibility (Codex round-8): billing_mode +
    // per_application_fee ship in migration 20260709000010 — on a database
    // that hasn't run it (preview env, deploy window) the update keys would
    // fail the whole acceptance with "column does not exist". One probe
    // covers both columns (same migration).
    let billingModeColumnsExist = false;
    try {
      billingModeColumnsExist = await database.schema.hasColumn('customers', 'billing_mode');
    } catch { /* keep false — legacy update shape */ }
    // Exact per-visit charge at the accepted billing cadence (quarterly
    // derives from the exact annual: $98.00, not 3 x rounded-monthly
    // $98.01 — resolveBillingCadence). SINGLE-recurring-service accepts
    // only — the same gate the scheduled-row estimated_price writer
    // uses: a multi-service plan creates one row per service, and a
    // customer-level whole-plan fee would bill the full package on
    // EVERY row's completion (Codex P1). Multi-service plans leave the
    // fee NULL so completion keeps its existing per-row precedence.
    // An already-per_application customer accepting an ADD-ON keeps
    // their established fee (Codex round-10): the customer-level fee
    // is the fallback for EVERY per-app visit without a row price,
    // so overwriting it with the add-on's cadence amount would
    // re-price the ORIGINAL series; the add-on's own rows carry
    // their explicit estimated_price (single-service writer).
    // recurringUnitCount, not raw line count (Codex P1 on the
    // pest+rodent removal): a standalone-scheduling supplement
    // (rodent bait) makes the plan multi-row even with ONE
    // recurring line — a customer-level whole-plan fee would bill
    // the full package on BOTH rows' completions.
    // CUSTOMER-LEVEL fee only (the completion-billing fallback). The
    // membership.started email quotes THIS acceptance's own amount instead
    // (emailPerApplicationAmountForConversion, codex #3271 r2): for an
    // established per-application customer's add-on accept the two
    // deliberately differ — the stamp preserves the original series' fee,
    // the email prices what was just accepted.
    const stampedPerApplicationFee = preservesExistingMembership
      ? (customer.per_application_fee ?? null)
      : ((customer.billing_mode === 'per_application' && Number(customer.per_application_fee) > 0)
        ? Number(customer.per_application_fee)
        : ((recurringUnitCount === 1
          && billingCadence && Number(billingCadence.amount) > 0)
          ? Number(perApplicationAmount)
          : (recurringUnitCount === 1 && Number(monthlyRate) > 0
            ? Number(monthlyRate)
            : null)));
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
          member_since: ['active_customer', 'won', 'at_risk', ...FORMER_CUSTOMER_STAGES].includes(customer.pipeline_stage)
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
          // Ledger authority (gate on + seeded): the scalar is the ledger
          // SUM — a same-family re-quote touches only its own family's
          // slice (the customer row lock above serializes concurrent
          // accepts). Legacy path: add-on accepts SUM via an atomic
          // in-database increment (codex #3241 r2 P1 — two concurrent
          // add-on accepts each computing old + own slice in JS would lose
          // one increment); everything else replaces.
          monthly_rate: ledgerScalar != null
            ? ledgerScalar
            : (addOnPreservedRateBase > 0
              ? database.raw('COALESCE(monthly_rate, 0) + ?', [monthlyRate])
              : convertedMonthlyRate),
          // Estimate-flow recurring customers bill PER VISIT (owner ruling
          // 2026-07-09), never as a monthly membership subscription: the
          // monthly billing cron skips non-membership modes and completion
          // collects per_application_fee each visit. Annual-prepay accepts are
          // re-stamped 'annual_prepay' at their term choke point
          // (createTermForAnnualPrepay), which every prepay path runs through.
          // CURRENT monthly members accepting an add-on keep their existing
          // model (see preservesExistingMembership above). Column-guarded —
          // pre-migration accepts keep the legacy update shape.
          ...(billingModeColumnsExist ? {
            billing_mode: preservesExistingMembership
              ? (customer.billing_mode || null)
              : 'per_application',
            // Fee semantics documented on stampedPerApplicationFee above —
            // shared with the membership.started email payload.
            per_application_fee: stampedPerApplicationFee,
          } : {}),
          active: true,
          deleted_at: null,
          // Station rental (owner 2026-07-26): the accepted agreement is the
          // only place that knows Waves keeps title to the hardware, and the
          // stations themselves are not created until the install visit — a
          // completion-sync/office code path with no view of this estimate.
          // Stamping the customer here is what lets upsertStationsForCustomer
          // default new stations to owned_by='waves' (codex P1). See
          // termiteStationsRentedUpdate for the three-way rule (rental →
          // true, purchased bait → false, no termite line → untouched).
          ...stationsRentedPatch,
          // Reactivating to active_customer — clear any churn stamp so a former
          // (churned/dormant) customer who accepts a recurring estimate isn't
          // still counted as churned by churned_at-based queries (e.g. MRR trend).
          churned_at: null,
          churn_reason: null,
        };
    // Rung 6 (scheduling/occupancy.js ORDERING CONTRACT) — BEFORE this
    // customers-row write, preserving the #3011 customer-row →
    // series-advisory order relative to admin-schedule. Only meaningful
    // inside a caller transaction (public accept); the standalone path's
    // seeding steps take it per-step in runSeedingStep below.
    if (database.isTransaction) await lockCustomerComms(database, customerId);
    // RETURNING carries the atomic increment's actual result for the audit
    // outputs below (activity log, converter log, membership email, return
    // value) — a separate follow-up read could raise on the caller's accept
    // transaction and leave it aborted despite a catch (codex #3241 r3),
    // and the provisional JS sum can be stale under the concurrent-accept
    // race the increment exists to survive. Fakes/mocks that ignore the
    // returning arg fall through to the provisional figure.
    const customerUpdateResult = await database('customers')
      .where({ id: customerId })
      .update(customerUpdates, ['monthly_rate']);
    // Ledger-authority writes are plain values (row-lock serialized), so
    // RETURNING reconciliation is only needed on the legacy atomic-increment
    // path.
    if (ledgerScalar == null && addOnPreservedRateBase > 0 && Array.isArray(customerUpdateResult)) {
      const returnedRate = Number(customerUpdateResult[0]?.monthly_rate);
      if (Number.isFinite(returnedRate) && returnedRate > 0) {
        convertedMonthlyRate = Math.round(returnedRate * 100) / 100;
      }
    }
    // Kill-switch consistency (codex #3245 r8): a GATE-OFF accept whose
    // dual-written component sum diverges from the committed legacy scalar
    // (a seeded multi-plan re-quote under legacy replace semantics) must
    // reset the ledger to match — otherwise re-enabling the gate jumps the
    // next bill to the divergent component sum. Attribution collapses to a
    // single unattributed component equal to the billed figure; fail-soft
    // (advisory mode by definition).
    if (ledgerScalar == null && !suppressRecurringConversion && !groupedEstimateAccept
      && ledgerAdvisoryScalar != null
      && Math.round(ledgerAdvisoryScalar * 100) !== Math.round(convertedMonthlyRate * 100)) {
      try {
        const PlanRateLedger = require('./plan-rate-ledger');
        await database.transaction((sp) => PlanRateLedger
          .resetLedgerToScalar(sp, customerId, convertedMonthlyRate, { source: 'gate_off_divergence' }));
      } catch (divergenceErr) {
        logger.warn(`[estimate-converter] gate-off ledger divergence reset failed for customer ${customerId}: ${divergenceErr.message}`);
      }
    }
    // UNSLICED authoritative accepts (codex #3245 r16): a recurring accept
    // whose estimate carries a positive total but NO priced recurring rows
    // yields empty slices — applyAcceptToLedger returned null and the
    // legacy scalar committed above. Under the gate that scalar must not
    // disagree with surviving components: reset the ledger to match
    // (single unattributed component; the helper THROWS on failure under
    // authority, failing the accept).
    if (!suppressRecurringConversion && !groupedEstimateAccept
      && ledgerScalar == null && ledgerAdvisoryScalar == null) {
      const PlanRateLedger = require('./plan-rate-ledger');
      if (PlanRateLedger.planRateLedgerEnabled()) {
        await PlanRateLedger.syncScalarWriteToLedger(database, customerId, convertedMonthlyRate, { source: 'unsliced_accept' });
      }
    }
    // Grouped accepts (bypassed above): the committed scalar is #3244's
    // legacy math; the ledger resets to a single unattributed component
    // matching it, and the owner reviews once when finer attribution
    // existed (codex #3245 r12). Gate-aware policy: authoritative reset
    // failure fails the accept (the helper throws); advisory warns.
    if (groupedEstimateAccept && !suppressRecurringConversion) {
      const PlanRateLedger = require('./plan-rate-ledger');
      let hadComponents = false;
      try {
        const existingComponents = await database.transaction((sp) => PlanRateLedger.loadComponents(sp, customerId));
        hadComponents = existingComponents.some((row) => row.family_key !== PlanRateLedger.UNATTRIBUTED);
      } catch { hadComponents = false; }
      await PlanRateLedger.syncScalarWriteToLedger(database, customerId, convertedMonthlyRate, { source: 'grouped_accept' });
      if (PlanRateLedger.planRateLedgerEnabled() && hadComponents) {
        planRateReviewNeeded = true;
      }
    }
    // A one-time accept CLEARS the scalar (waveguard_tier 'One-Time',
    // monthly_rate null) — the attribution clears with it (codex #3245 r8),
    // or a later recurring accept would sum obsolete components back in.
    // Gate-aware error policy lives in the helper. (`=== true` keeps this
    // branch textually distinct from the unit-processing branch the
    // series-lock pre-pass source guard anchors on.)
    if (suppressRecurringConversion === true) {
      await require('./plan-rate-ledger')
        .syncScalarWriteToLedger(database, customerId, null, { source: 'one_time_accept' });
    }

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
    // Per-property duplicate-series scope (codex #3244 r1): a grouped
    // estimate's accept resolves to the same customer as its siblings, so the
    // customer+family guard alone would read the FIRST property's series as a
    // duplicate and skip seeding the second property's schedule. Scoped to
    // grouped estimates only — ungrouped accepts keep the exact legacy guard.
    let seriesAddressScope = null;
    if (estimate?.estimate_group_id && estimate.address) {
      // normalizedEstimateStreet keeps the whole street portion (unit lines
      // survive) — a naive split(',')[0] mis-scoped "Unit 4, 100 Beach Rd"
      // (codex #3244 r5).
      const { normalizedEstimateStreet, normalizedStampedStreet } = require('./estimate-property-linkage');
      const estimateStreet = normalizedEstimateStreet(estimate.address);
      let customerPrimaryStreet = '';
      try {
        const custRow = await database('customers').where({ id: customerId }).first('address_line1', 'address_line2', 'city', 'zip');
        customerPrimaryStreet = normalizedStampedStreet(custRow?.address_line1, custRow?.address_line2, custRow?.city, custRow?.zip);
      } catch { /* scope falls back to stamped addresses only */ }
      if (estimateStreet) seriesAddressScope = { estimateStreet, customerPrimaryStreet };
    }
    // Series-seeding transaction wrapper (P0: check-then-insert race). Every
    // converter path that can CREATE a recurring series runs its duplicate-
    // series re-check (checkActiveSeriesLocked — advisory lock per
    // customer + service family) and its series inserts inside ONE
    // transaction, so a concurrent creator blocks on the lock and then sees
    // the committed series. A caller-provided transaction (public accept,
    // manual Mark Won) is reused as-is — the lock then holds until THEIR
    // commit; otherwise a transaction is opened per seeding step.
    //
    // Reminder registration goes through a SEPARATE connection
    // (appointment-reminders), which cannot see rows this transaction hasn't
    // committed — so when we open our own transaction the seed calls pass
    // registerReminders:false and the wrapper's caller registers post-commit.
    // Inside a caller transaction the pre-existing registerReminders
    // semantics are preserved unchanged (those callers defer registration).
    const seedsInOwnTransaction = !database.isTransaction;
    // Rung 6 first in each per-step transaction (a caller trx took it before
    // the customers-row write above): every step inserts scheduled_services,
    // and the comms lock precedes the series advisory lock everywhere
    // (scheduling/occupancy.js ORDERING CONTRACT).
    const runSeedingStep = (fn) => (seedsInOwnTransaction
      ? database.transaction(async (trx) => { await lockCustomerComms(trx, customerId); return fn(trx); })
      : fn(database));
    const registerSeededRowsInline = !seedsInOwnTransaction && !deferFollowUpReminderRegistration;
    const existingFromReservation = await database('scheduled_services')
      .where({ source_estimate_id: estimateId })
      .whereNotNull('customer_id')
      .whereNull('reservation_expires_at')
      .count('id as count')
      .first();
    const reservationRowsExist = Number(existingFromReservation?.count || 0) > 0;
    // Loaded here rather than inside the reservation branch so the multi-unit
    // lock pre-pass below can read the reserved row's service identity before
    // any seeding unit processes.
    const reservedRows = reservationRowsExist
      ? await database('scheduled_services')
        .where({ source_estimate_id: estimateId })
        .whereNotNull('customer_id')
        .whereNull('reservation_expires_at')
        .orderBy('scheduled_date', 'asc')
      : [];

    // ——— Multi-unit lock-order pre-pass (P1: cross-conversion deadlock) ———
    // Only the CALLER-TRANSACTION path needs it: with a caller-provided trx
    // every runSeedingStep reuses that trx, so each unit's series-create
    // advisory locks are held to the OUTER commit — two concurrent
    // multi-service conversions processing the same families in different
    // unit order each hold one family's locks while waiting on the other's,
    // and Postgres aborts one acceptance (deadlock detected). The fix is the
    // total-order discipline: collect every unit's lock keys up front and
    // acquire the sorted union (same canonical sort checkActiveSeriesLocked
    // applies within a unit) before any unit processes; the per-unit guard
    // calls then merely re-acquire held keys, which pg advisory xact locks
    // allow without waiting (re-entrant within the owning transaction — see
    // acquireSeriesCreateLocks).
    //
    // When seedsInOwnTransaction, each seeding step opens and COMMITS its own
    // transaction, releasing its locks before the next unit starts — no step
    // ever waits while holding another unit's locks, so the sequential
    // acquisition is already deadlock-free AND a pre-pass would be inert
    // anyway (its xact locks would die with whichever step transaction ran
    // it). The pre-pass therefore applies to the caller-trx path only.
    //
    // The collected union is a SUPERSET of what the units will lock: reserved
    // rows contribute their current identity plus every combo-route rewrite
    // target, and catalog ids resolve through the same services.service_key
    // lookups the units run. Extra keys only over-serialize a touch; a MISSED
    // key is what would reopen a mid-hold wait. Single-service conversions
    // (<2 units) skip the pre-pass entirely — their one sorted key-pair
    // already conforms to the global order — keeping them behaviorally
    // identical. Fail-open like the guard: a pre-pass failure degrades to
    // today's per-unit locking and never blocks the acceptance.
    if (!seedsInOwnTransaction && !suppressRecurringConversion && !skipAutoSchedule) {
      try {
        // SAVEPOINT (knex nested transaction): a pre-pass failure must not
        // abort the caller's accept transaction, and the advisory xact locks
        // taken inside survive savepoint release and hold to the outer
        // commit — the same isolation trick checkActiveSeriesLocked uses.
        await database.transaction(async (lockTrx) => {
          const lockUnits = [];
          const catalogIdByKey = new Map();
          const catalogIdFor = async (serviceKey) => {
            if (!serviceKey) return null;
            if (!catalogIdByKey.has(serviceKey)) {
              const catalogRow = await lockTrx('services').where({ service_key: serviceKey }).first('id');
              catalogIdByKey.set(serviceKey, catalogRow?.id || null);
            }
            return catalogIdByKey.get(serviceKey);
          };
          const addUnit = async (serviceType, catalogServiceKey, knownServiceId = null) => {
            const serviceId = knownServiceId != null ? knownServiceId : await catalogIdFor(catalogServiceKey);
            if (!serviceType && serviceId == null) return;
            lockUnits.push({ customerId, serviceType: serviceType || null, serviceId });
          };
          const { remaining, combos, standalone } = combinedScheduling;
          if (reservationRowsExist) {
            for (const unit of standalone) await addUnit(unit.service.name, unit.catalogServiceKey);
            const reservedStart = reservedRows[0] || null;
            if (reservedStart) {
              await addUnit(reservedStart.service_type, null, reservedStart.service_id || null);
              for (const combo of combos) await addUnit(combo.route.name, combo.route.catalogServiceKey);
            }
            // Promoted `remaining` units (termite/bond + mosquito) take their
            // series locks inside the reservation loop — they must join this
            // sorted pre-pass union or two concurrent accepts can invert
            // family lock order and deadlock (codex r17 P2: one reserves
            // termite and promotes mosquito while the other does the
            // reverse). Mirrors the loop's own name/key derivations.
            for (const svc of remaining) {
              const key = String(recurringServiceKey(svc) || '');
              if ((key === 'termite_bait' || key.startsWith('termite_bond'))
                && visitsPerYearForRecurringService(svc) === 4) {
                const isBond = key.startsWith('termite_bond');
                await addUnit(
                  svc.name || svc.serviceName || svc.service_name || (isBond ? 'Termite Bond' : 'Termite Bait'),
                  isBond ? (svc.service || null) : 'termite_bait',
                );
                continue;
              }
              if (RecurringAppointmentSeeder.serviceKeyFor(svc) === 'mosquito') {
                const svcName = svc.name || svc.serviceName || svc.service_name || 'Mosquito';
                const mosquitoPattern = converterFollowUpSeedingPattern(
                  svc, { service_type: svcName }, inferredFrequencyKey,
                );
                if (mosquitoPattern) {
                  await addUnit(
                    svcName,
                    mosquitoPattern === RecurringAppointmentSeeder.SEASONAL_FEB_OCT
                      ? 'mosquito_seasonal'
                      : 'mosquito_monthly',
                  );
                }
              }
            }
          } else {
            for (const combo of combos) await addUnit(combo.route.name, combo.route.catalogServiceKey);
            for (const unit of standalone) await addUnit(unit.service.name, unit.catalogServiceKey);
            for (const svc of remaining) {
              await addUnit(svc.name || svc.serviceName || svc.service_name || 'Service', remainingUnitCatalogKey(svc));
            }
          }
          if (lockUnits.length > 1) {
            await RecurringAppointmentSeeder.acquireSeriesCreateLocks(lockTrx, lockUnits);
          }
        });
      } catch (preLockErr) {
        logger.warn(`[estimate-converter] series-lock pre-pass failed (per-unit locking still applies): ${preLockErr.message}`);
      }
    }

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
      // reservedRows hoisted above the branch (lock pre-pass needs it).
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
        const { combos, standalone: reservedStandalone, remaining } = combinedScheduling;
        // Standalone units (sold rodent bait) must schedule in reserved
        // accepts too (Codex P1): before the pest+rodent route removal the
        // combo REWRITE covered the bait on the reserved row; now the bait
        // is its own visit, so insert it (anchored to the reserved date —
        // same-trip check) and seed its quarterly series. This preserves
        // the coverage the rewrite used to provide; it does NOT auto-
        // schedule other `remaining` lines (adjudicated semantic intact) —
        // EXCEPT promoted termite below.
        //
        // Termite promotion (codex #2911 r3 P1): a quarterly termite line
        // beside a monthly/bimonthly plan can't combine, and per the owner
        // 2026-07-20 directive it is a billed-per-application program — an
        // accept that billed it while scheduling nothing would sell a
        // program that silently doesn't exist. Same remedy shape as the
        // rodent promotion above; all other remaining lines keep the
        // adjudicated 2026-06-12 semantic (owner decision).
        const promotedTermiteUnits = (remaining || [])
          .filter((line) => {
            const key = String(recurringServiceKey(line) || '');
            // Bond riders promote too (codex #2915 r2): when the pest route
            // consumed the bait line, the bond stays in `remaining` — billed
            // but otherwise never scheduled, so no visit ever carries
            // "Termite Bond" and the lifecycle sync never mints the warranty.
            return (key === 'termite_bait' || key.startsWith('termite_bond'))
              && visitsPerYearForRecurringService(line) === 4;
          })
          .map((line) => {
            const isBond = String(recurringServiceKey(line) || '').startsWith('termite_bond');
            return {
              service: {
                name: line.name || line.serviceName || line.service_name || (isBond ? 'Termite Bond' : 'Termite Bait'),
                frequency: 'quarterly',
                visitsPerYear: 4,
              },
              // Bond rows resolve their own catalog identity (internal-only
              // billing-rider completion profile); bait resolves the station
              // service.
              catalogServiceKey: isBond ? (line.service || null) : 'termite_bait',
            };
          });
        // Mosquito promotion (codex r16 P1): a recurring mosquito line beside
        // a non-combining plan (pest + mosquito share no cadence route) sits
        // in `remaining` and — per the adjudicated 2026-06-12 semantic — was
        // never scheduled on the reservation path, even though the plan
        // bills it monthly. Same remedy shape as the termite/bond
        // promotions: a billed program must schedule. Monthly rides the
        // reserved visit's slot (same trip); seasonal anchors its own first
        // visit rolled into Feb–Oct — a reserved winter pest date must not
        // seed a winter mosquito treatment.
        const promotedMosquitoUnits = (remaining || [])
          .filter((line) => {
            if (RecurringAppointmentSeeder.serviceKeyFor(line) !== 'mosquito') return false;
            const lineName = line.name || line.serviceName || line.service_name || 'Mosquito';
            return !!converterFollowUpSeedingPattern(line, { service_type: lineName }, inferredFrequencyKey);
          })
          .map((line) => {
            const lineName = line.name || line.serviceName || line.service_name || 'Mosquito';
            const seasonal = converterFollowUpSeedingPattern(line, { service_type: lineName }, inferredFrequencyKey)
              === RecurringAppointmentSeeder.SEASONAL_FEB_OCT;
            return {
              // Normalized name ON the unit (codex r17 P1): the insert below
              // reads only unit.service.name, and a line carrying its label in
              // serviceName/service_name would insert a NULL service_type —
              // an error the per-unit catch swallows, completing an accept
              // that bills mosquito while scheduling nothing.
              service: { ...line, name: lineName },
              catalogServiceKey: seasonal ? 'mosquito_seasonal' : 'mosquito_monthly',
              seasonalMosquito: seasonal,
              noteKind: 'mosquito program',
            };
          });
        for (const unit of [...(reservedStandalone || []), ...promotedTermiteUnits, ...promotedMosquitoUnits]) {
          if (!reservedStart?.scheduled_date) break;
          // A reserved row already covering this program means nothing to add.
          const unitKey = recurringServiceKey({ name: unit.service.name });
          const alreadyReserved = reservedRows.some((row) => recurringServiceKey({ name: row.service_type }) === unitKey);
          if (alreadyReserved) continue;
          try {
            // Copy the customer's picked slot onto the added row (Codex r2):
            // same trip, same window, same tech/zone — otherwise dispatch
            // sees an un-slotted job floating on that day. A SEASONAL
            // mosquito unit whose first visit rolled into Feb–Oct is a
            // different day, so it keeps only the zone and books unslotted
            // (office assigns the window when February routing exists).
            const unitDate = unit.seasonalMosquito
              ? await rolledSeasonalFirstDate(scheduledDateOnly(reservedStart.scheduled_date))
              : scheduledDateOnly(reservedStart.scheduled_date);
            const sameTrip = unitDate === scheduledDateOnly(reservedStart.scheduled_date);
            // Row notes are customer-visible — a seasonal line's raw
            // every_6_weeks frequency must not leak into them.
            const unitFrequencyLabel = unit.seasonalMosquito
              ? 'seasonal (Feb–Oct)'
              : (unit.service.frequency || 'recurring');
            const standaloneRow = {
              customer_id: customerId,
              scheduled_date: unitDate,
              ...(sameTrip && reservedStart.window_start ? { window_start: reservedStart.window_start } : {}),
              ...(sameTrip && reservedStart.window_end ? { window_end: reservedStart.window_end } : {}),
              ...(sameTrip && reservedStart.technician_id ? { technician_id: reservedStart.technician_id } : {}),
              ...(reservedStart.zone ? { zone: reservedStart.zone } : {}),
              service_type: unit.service.name,
              status: 'pending',
              notes: `Auto-scheduled from estimate #${estimateId} (${unit.noteKind || 'standalone bait program'} alongside reserved visit). Frequency: ${unitFrequencyLabel}.`,
              source_estimate_id: estimateId,
            };
            try {
              const catalogRow = await database('services')
                .where({ service_key: unit.catalogServiceKey })
                .first('id', 'default_duration_minutes');
              if (catalogRow) {
                standaloneRow.service_id = catalogRow.id;
                if (catalogRow.default_duration_minutes) standaloneRow.estimated_duration_minutes = catalogRow.default_duration_minutes;
              }
            } catch (lookupErr) {
              logger.warn(`[estimate-converter] catalog lookup failed for ${unit.catalogServiceKey}: ${lookupErr.message}`);
            }
            // Duplicate-series guard (P0): this standalone creator was the
            // third unguarded converter seeding path — a customer already
            // holding an active bait-station series would get a second
            // parent + quarterly series. Guard + insert + seed share one
            // locked transaction (runSeedingStep); a hit skips the WHOLE
            // unit (no orphan first visit) with the standard skip note.
            const outcome = await runSeedingStep(async (trx) => {
              const { matches, guardError } = await RecurringAppointmentSeeder.checkActiveSeriesLocked(trx, {
                customerId,
                serviceId: standaloneRow.service_id || null,
                serviceType: standaloneRow.service_type,
                serviceAddressScope: seriesAddressScope,
              });
              if (guardError) logger.warn(`[estimate-converter] duplicate-series guard failed (scheduling proceeds): ${guardError.message}`);
              if (matches.length > 0) return { kept: matches[0] };
              const inserted = await trx('scheduled_services').insert(standaloneRow).returning('*');
              const parentRow = Array.isArray(inserted) && typeof inserted[0] === 'object'
                ? inserted[0]
                : { ...standaloneRow, id: Array.isArray(inserted) ? inserted[0] : inserted };
              // Held-slot acceptance is a booking too (Codex #3178 r3 P1)
              // — the auto-schedule path below is not the only way an
              // accepted estimate becomes an appointment.
              try {
                await require('./inspection-credit').markBookingForInspectionCredit(trx, {
                  customerId: standaloneRow.customer_id,
                  scheduledServiceId: parentRow.id,
                  source: 'estimate_accept',
                });
              } catch { /* never blocks a conversion */ }
              let seedResult = null;
              try {
                seedResult = await seedRecurringFollowUpsForParent(trx, parentRow, unit.service, {
                  fallbackFrequency: unit.service.frequency,
                  registerReminders: registerSeededRowsInline,
                });
              } catch (seedErr) {
                logger.error(`[estimate-converter] standalone bait follow-up seeding failed for estimate ${estimateId}: ${seedErr.message}`);
              }
              return { parentRow, seedResult };
            });
            if (outcome.kept) {
              logger.warn(`[estimate-converter] Estimate ${estimateId}: existing active recurring series kept for "${unit.service.name}" (series ${outcome.kept.id}) — skipped scheduling a duplicate standalone series`);
              try {
                await database('activity_log').insert({
                  customer_id: customerId,
                  action: 'recurring_series_skipped',
                  description: `Estimate #${estimateId}: existing recurring series kept (${outcome.kept.service_type}, series #${outcome.kept.id}${outcome.kept.next_upcoming_date ? `, next visit ${outcome.kept.next_upcoming_date}` : ''}) — no duplicate ${unit.service.name} series was scheduled. Review the existing series against the new agreement.`,
                  metadata: JSON.stringify({ estimateId, existingParentId: outcome.kept.id, skippedService: unit.service.name }),
                });
              } catch (noteErr) {
                logger.warn(`[estimate-converter] duplicate-series skip note failed: ${noteErr.message}`);
              }
              continue;
            }
            const { parentRow, seedResult } = outcome;
            scheduledCount += 1;
            // The reserved row's reminders were registered by the public
            // accept route; this added row needs its own (Codex r2) —
            // same fail-soft registration the seeded follow-ups use.
            // Post-commit relative to the seeding transaction above: the
            // reminder writer must only ever see a committed visit row.
            if (!deferFollowUpReminderRegistration && parentRow.id && standaloneRow.window_start) {
              await registerSeededFollowUpReminders([parentRow], customerId);
            } else if (deferFollowUpReminderRegistration && parentRow.id) {
              deferredFollowUpReminderRows.push(parentRow);
            }
            if (seedResult) {
              if (deferFollowUpReminderRegistration && Array.isArray(seedResult.insertedRows)) {
                deferredFollowUpReminderRows.push(...seedResult.insertedRows);
              } else if (seedsInOwnTransaction) {
                await registerSeededFollowUpReminders(seedResult.insertedRows, customerId);
              }
              scheduledCount += seedResult.insertedCount || 0;
            }
            logger.info(`[estimate-converter] standalone "${unit.service.name}" scheduled alongside reserved accept for estimate ${estimateId}`);
          } catch (standaloneErr) {
            logger.error(`[estimate-converter] standalone bait scheduling failed for estimate ${estimateId}: ${standaloneErr.message}`);
          }
        }
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
        // Codex r8 P1 (last hole in the class): the slot list and reserve
        // are season-filtered for seasonal selections, but the reservation
        // is not re-validated when the FREQUENCY changes after reserving —
        // a slot held under monthly12 (winter dates legitimately offered)
        // then accepted as seasonal9 would seed the series from a Nov–Jan
        // parent, counting a prohibited winter visit toward the nine.
        // Refuse and roll the accept back; the customer re-picks a date
        // (the hold expires on its own). Office/admin bookings never come
        // through the reservation path. OUTSIDE the seeding try below — its
        // catch is deliberately fail-soft (log and keep the acceptance),
        // which would swallow this refusal and complete the accept anyway
        // (pre-push P0 r9).
        const reservedGuardSvc = reservedSeedSvc
          || recurringServiceForScheduledRow(recurringServicesForConversion, reservedStart);
        const reservedSeedingPattern = converterFollowUpSeedingPattern(
          reservedGuardSvc || {}, reservedStart, inferredFrequencyKey,
        );
        if (reservedSeedingPattern === RecurringAppointmentSeeder.SEASONAL_FEB_OCT) {
          const reservedMonth = Number(String(scheduledDateOnly(reservedStart.scheduled_date) || '').slice(5, 7));
          if (reservedMonth < 2 || reservedMonth > 10) {
            const err = new Error('This seasonal program runs February through October — pick an in-season visit date to finish accepting.');
            err.code = 'SEASONAL_RESERVATION_OFF_SEASON';
            err.isOperational = true;
            err.status = 409;
            err.statusCode = 409;
            throw err;
          }
        }
        try {
          const seedSvc = reservedGuardSvc;
          // Duplicate-series guard on the RESERVED-slot path (P0): this
          // branch — the common public-accept path — seeded with NO guard,
          // so a customer already holding an active series of the family
          // still got a second one minted here. Same skip-with-note behavior
          // as the auto-schedule guard below; the reserved row itself (the
          // visit the customer picked and committed) is excluded from
          // matching and is always kept — only the follow-up series is
          // skipped. Gated on the seeding pattern so accepts that would
          // never seed a series don't take the lock or write skip notes.
          // Guard re-check + seeding share one locked transaction
          // (runSeedingStep) so concurrent creators serialize.
          if (reservedSeedingPattern) {
            const outcome = await runSeedingStep(async (trx) => {
              const { matches, guardError } = await RecurringAppointmentSeeder.checkActiveSeriesLocked(trx, {
                customerId,
                serviceId: reservedStart.service_id || null,
                serviceType: reservedStart.service_type || null,
                excludeParentId: reservedStart.id,
                serviceAddressScope: seriesAddressScope,
              });
              if (guardError) logger.warn(`[estimate-converter] duplicate-series guard failed (scheduling proceeds): ${guardError.message}`);
              if (matches.length > 0) return { kept: matches[0] };
              const seedResult = await seedRecurringFollowUpsForParent(trx, reservedStart, seedSvc, {
                fallbackFrequency: inferredFrequencyKey,
                registerReminders: registerSeededRowsInline,
              });
              return { seedResult };
            });
            if (outcome.kept) {
              logger.warn(`[estimate-converter] Estimate ${estimateId}: existing active recurring series kept for "${reservedStart.service_type}" (series ${outcome.kept.id}) — reserved visit ${reservedStart.id} kept, duplicate follow-up series skipped`);
              try {
                await database('activity_log').insert({
                  customer_id: customerId,
                  action: 'recurring_series_skipped',
                  description: `Estimate #${estimateId}: existing recurring series kept (${outcome.kept.service_type}, series #${outcome.kept.id}${outcome.kept.next_upcoming_date ? `, next visit ${outcome.kept.next_upcoming_date}` : ''}) — the reserved visit stays, but no duplicate ${reservedStart.service_type} follow-up series was seeded. Review the existing series against the new agreement.`,
                  metadata: JSON.stringify({ estimateId, existingParentId: outcome.kept.id, skippedService: reservedStart.service_type, reservedServiceId: reservedStart.id }),
                });
              } catch (noteErr) {
                logger.warn(`[estimate-converter] duplicate-series skip note failed: ${noteErr.message}`);
              }
            } else {
              const seedResult = outcome.seedResult;
              if (deferFollowUpReminderRegistration && Array.isArray(seedResult.insertedRows)) {
                deferredFollowUpReminderRows.push(...seedResult.insertedRows);
              } else if (seedsInOwnTransaction) {
                await registerSeededFollowUpReminders(seedResult.insertedRows, customerId);
              }
              scheduledCount += seedResult.insertedCount || 0;
            }
          }
        } catch (seedErr) {
          logger.error(`[estimate-converter] Failed to seed recurring follow-ups for estimate ${estimateId}: ${seedErr.message}`);
        }
      }
    } else if (skipAutoSchedule) {
      logger.info(
        `[estimate-converter] Skipping auto-schedule for estimate ${estimateId} — ` +
        `skipAutoSchedule=true (manual Mark Won)`,
      );
      // Prepay-on-book: the caller booked the first visit itself — align the
      // annual-prepay renewal term to that booked date (else it defaults to
      // today in createTermForAnnualPrepay).
      if (annualPrepayTermStart) termStartDate = annualPrepayTermStart;
    } else {
      const firstServiceDate = await pickFirstServiceDate(customer, estimateId);
      termStartDate = firstServiceDate;
      // Earliest date actually inserted by the loop below — replaces the
      // picked date when a seasonal roll moved the real first visit.
      let earliestScheduledUnitDate = null;

      // Combined-service routing: matching-cadence pairs schedule as ONE
      // combined service; standalone rewrites (e.g. rodent bait) schedule
      // as their own catalog visit; everything else flows through unchanged.
      // Shares the hoisted combinedScheduling so scheduling can never
      // disagree with the unit count / prepay coverage derivation.
      const { remaining, combos, standalone } = combinedScheduling;
      const scheduleUnits = [
        ...combos.map((combo) => ({ svc: combo.service, combo, catalogServiceKey: combo.route.catalogServiceKey })),
        ...standalone.map((unit) => ({ svc: unit.service, catalogServiceKey: unit.catalogServiceKey })),
        ...remaining.map((svc) => ({ svc, catalogServiceKey: remainingUnitCatalogKey(svc) })),
      ];
      for (const unit of scheduleUnits) {
        const svc = unit.svc;
        let combinedServiceId = null;
        if (unit.catalogServiceKey) {
          // service_id makes profile resolution sturdy against later
          // renames; name-based resolution still works without it, so a
          // missing catalog row (env not yet migrated) degrades safely.
          try {
            // Deliberately NOT filtered on is_active/is_archived (codex
            // 2026-08-08 r5): this link is identity durability, not
            // activation policy. An accepted estimate must schedule, and
            // completion's name fallback resolves the SAME row (inactive
            // or not — cf. termite_inspection, inactive in prod with
            // name-resolved typed completions), so skipping the id here
            // would only sever rename-safety while changing nothing else.
            // Deactivation posture is governed where it's enforceable:
            // the completion profile's own active flag and delivery_mode
            // kill switches, and the booking/picker catalog filters.
            const catalogRow = await database('services')
              .where({ service_key: unit.catalogServiceKey })
              .first('id', 'default_duration_minutes');
            if (catalogRow) {
              combinedServiceId = catalogRow.id;
              if (catalogRow.default_duration_minutes) {
                svc.estimatedDurationMinutes = catalogRow.default_duration_minutes;
              }
            } else {
              logger.warn(`[estimate-converter] catalog row ${unit.catalogServiceKey} absent — scheduling by name only`);
            }
          } catch (lookupErr) {
            logger.warn(`[estimate-converter] catalog lookup failed for ${unit.catalogServiceKey}: ${lookupErr.message}`);
          }
        }
        const serviceName = svc.name || svc.serviceName || svc.service_name || 'Service';
        const pattern = RecurringAppointmentSeeder.inferRecurringPattern({
          service: svc,
          // Same explicit-visits override as the seeding path: a termite row
          // beside a monthly/bimonthly plan must schedule quarterly, not at
          // the plan cadence (codex #2911 r3 P1).
          fallbackFrequency: cadenceFallbackForSeeding(svc, inferredFrequencyKey),
        });
        // The pattern the seeder will ACTUALLY use — for seasonal mosquito the
        // forced rule diverges from raw inference (the row carries
        // every_6_weeks). Resolved against the prospective parent's
        // service_type, which is exactly what seedRecurringFollowUpsForParent
        // sees after the insert below.
        const seedingPattern = converterFollowUpSeedingPattern(
          svc, { service_type: serviceName }, inferredFrequencyKey,
        );
        const seasonalUnit = seedingPattern === RecurringAppointmentSeeder.SEASONAL_FEB_OCT;
        // Row notes are customer-visible — say "seasonal (Feb–Oct)", not the
        // raw every_6_weeks the quote row carries or the internal token.
        const frequency = seasonalUnit ? 'seasonal (Feb–Oct)' : (svc.frequency || pattern || 'monthly');
        // recurringUnitCount, not raw line count (Codex P1): with a
        // standalone bait unit beside one pest line, stamping the whole
        // plan amount on BOTH rows would double-charge at completion.
        // Multi-unit plans leave rows unpriced for manual allocation.
        const estimatedPrice = billingCadence && recurringUnitCount === 1
          ? perApplicationAmount
          : null;
        const durationMinutes = durationMinutesForRecurringService(svc, pattern);

        try {
          const combinedNote = unit.combo
            ? ` Combined service: ${unit.combo.combinedFrom
              .map((s) => s.name || s.serviceName || s.service_name || recurringServiceKey(s))
              .join(' + ')} — one visit, one report.`
            : '';
          // Codex r5 P1: an auto-picked Nov–Jan first date on a seasonal plan
          // would put a winter treatment on a Feb–Oct program AND count toward
          // the nine, leaving only eight in-season visits. Roll it to February;
          // every other unit keeps the picked date. (Office-booked off-season
          // parents are the operator's choice and are not moved.) Codex r8 P2:
          // pickFirstServiceDate's blackout/weekday validation ran on the
          // ORIGINAL date, so re-nudge the rolled date off closed days and
          // weekends — bounded and fail-open like the fallback nudge, and a
          // February date + 14 days can never leave the season.
          const unitFirstDate = seasonalUnit
            ? await rolledSeasonalFirstDate(firstServiceDate)
            : firstServiceDate;
          const row = {
            customer_id: customerId,
            scheduled_date: unitFirstDate,
            service_type: serviceName,
            status: 'pending',
            notes: `Auto-scheduled from estimate #${estimateId}. Frequency: ${frequency}.${combinedNote}`,
            source_estimate_id: estimateId,
          };
          if (combinedServiceId) row.service_id = combinedServiceId;
          if (estimatedPrice) row.estimated_price = estimatedPrice;
          if (durationMinutes) row.estimated_duration_minutes = durationMinutes;
          // Duplicate-series guard: the customer may ALREADY hold an active
          // recurring series of this service family (a prior estimate, a
          // self-booking, an admin booking). Seeding another parent+children
          // here is the verified cause of customers carrying two live
          // series — keep the existing series and surface the skip to the
          // office instead. Fail-open: a guard failure must not block the
          // conversion (checkActiveSeriesLocked never throws). The guard
          // re-check runs INSIDE the same locked transaction as the parent
          // insert + follow-up seeding (P0: check-then-insert race), so two
          // concurrent accepts serialize per customer + service family and
          // the loser skips instead of minting a second series.
          const outcome = await runSeedingStep(async (trx) => {
            if (pattern) {
              const { matches, guardError } = await RecurringAppointmentSeeder.checkActiveSeriesLocked(trx, {
                customerId,
                serviceId: combinedServiceId,
                serviceType: serviceName,
                serviceAddressScope: seriesAddressScope,
              });
              if (guardError) logger.warn(`[estimate-converter] duplicate-series guard failed (scheduling proceeds): ${guardError.message}`);
              if (matches.length > 0) return { kept: matches[0] };
            }
            const inserted = await trx('scheduled_services').insert(row).returning('*');
            const insertedId = Array.isArray(inserted)
              ? (typeof inserted[0] === 'object' ? inserted[0]?.id : inserted[0])
              : (typeof inserted === 'object' ? inserted?.id : inserted);
            // Accepting an estimate IS a real customer booking, so it
            // qualifies for an open inspection-credit promise. Marked
            // in-transaction (dark behind the gate): the marker commits
            // with the booking, and the hourly sweep turns it into credit.
            try {
              await require('./inspection-credit').markBookingForInspectionCredit(trx, {
                customerId: row.customer_id,
                scheduledServiceId: insertedId,
                source: 'estimate_accept',
              });
            } catch { /* never blocks a conversion */ }
            const parentRow = Array.isArray(inserted) && typeof inserted[0] === 'object'
              ? inserted[0]
              : { ...row, id: insertedId };
            let seedResult = null;
            try {
              seedResult = await seedRecurringFollowUpsForParent(trx, parentRow, svc, {
                fallbackFrequency: inferredFrequencyKey,
                registerReminders: registerSeededRowsInline,
              });
            } catch (seedErr) {
              logger.error(`[estimate-converter] Failed to seed recurring follow-ups for estimate ${estimateId}: ${seedErr.message}`);
            }
            return { insertedId, seedResult };
          });
          if (outcome.kept) {
            const kept = outcome.kept;
            logger.warn(`[estimate-converter] Estimate ${estimateId}: existing active recurring series kept for "${serviceName}" (series ${kept.id}) — skipped scheduling a duplicate series`);
            try {
              await database('activity_log').insert({
                customer_id: customerId,
                action: 'recurring_series_skipped',
                description: `Estimate #${estimateId}: existing recurring series kept (${kept.service_type}, series #${kept.id}${kept.next_upcoming_date ? `, next visit ${kept.next_upcoming_date}` : ''}) — no duplicate ${serviceName} series was scheduled. Review the existing series against the new agreement.`,
                metadata: JSON.stringify({ estimateId, existingParentId: kept.id, skippedService: serviceName }),
              });
            } catch (noteErr) {
              logger.warn(`[estimate-converter] duplicate-series skip note failed: ${noteErr.message}`);
            }
            continue;
          }
          if (!firstScheduledServiceId && outcome.insertedId) firstScheduledServiceId = outcome.insertedId;
          if (outcome.insertedId && unitFirstDate
            && (!earliestScheduledUnitDate || unitFirstDate < earliestScheduledUnitDate)) {
            earliestScheduledUnitDate = unitFirstDate;
          }
          let insertedFollowUps = 0;
          if (outcome.seedResult) {
            if (deferFollowUpReminderRegistration && Array.isArray(outcome.seedResult.insertedRows)) {
              deferredFollowUpReminderRows.push(...outcome.seedResult.insertedRows);
            } else if (seedsInOwnTransaction) {
              await registerSeededFollowUpReminders(outcome.seedResult.insertedRows, customerId);
            }
            insertedFollowUps = outcome.seedResult.insertedCount || 0;
          }
          scheduledCount += 1 + insertedFollowUps;
        } catch (e) {
          logger.error(`[estimate-converter] Failed to create scheduled_service: ${e.message}`);
        }
      }
      // The membership term/email start must reflect what was ACTUALLY
      // scheduled: a solo seasonal plan accepted in Nov–Jan rolls its first
      // visit to February, so the pre-roll firstServiceDate would tell the
      // customer their membership starts on a winter date with no service
      // (codex r15 P2). A mixed plan keeps its earliest real visit date;
      // if nothing inserted (duplicate-series keeps), the picked date stands.
      if (earliestScheduledUnitDate) termStartDate = earliestScheduledUnitDate;
    }

    // 3. Log conversion in activity_log
    await database('activity_log').insert({
      customer_id: customerId,
      action: 'estimate_converted',
      // Combined count in the operator-visible line (codex #3228 r2): the
      // tier is activated from prior + added families, and the timeline
      // reads this description without the metadata — an estimate-only
      // count beside a combined tier reads as a contradiction.
      // Post-conversion CUSTOMER rate, not just this estimate's slice
      // (codex #3241 r1): an add-on accept sums onto the existing rate, and
      // staff reading the timeline must see the figure the customer is
      // actually billed. The estimate's own slice stays in the metadata.
      description: `Estimate #${estimateId} converted: ${customer.first_name} ${customer.last_name} → WaveGuard ${tier} at $${convertedMonthlyRate.toFixed(2)}/mo (${combinedServiceCount} combined qualifying services, ${serviceCount} from this estimate, ${scheduledCount} scheduled)`,
      metadata: JSON.stringify({
        estimateId, tier, discount, monthlyRate, serviceCount, scheduledCount, firstScheduledServiceId,
        priorQualifyingKeys, combinedServiceCount,
        convertedMonthlyRate, addOnPreservedRateBase,
      }),
    });

    // Inspection credit: redeem after the bookings above committed and
    // BEFORE the setup/prepay invoice mints (pre-push P0), so the credit
    // sits in the balance and the invoice machinery auto-applies it —
    // otherwise the customer can receive or pay the full invoice before
    // the promised $75 exists. Global-pool conversions only: when this
    // conversion rides a caller's transaction (the public accept), the
    // booking is not yet visible to the redeemer's own transaction — that
    // path redeems post-commit in estimate-public, before delivery.
    if (firstScheduledServiceId && !usingCallerDatabase) {
      try {
        await require('./inspection-credit').redeemInspectionCreditForBooking({
          customerId,
          scheduledServiceId: firstScheduledServiceId,
          createdBy: 'system:inspection_credit_estimate_accept',
        });
      } catch (creditErr) {
        logger.warn(`[estimate-converter] inspection credit redemption deferred to sweep: ${creditErr.message}`);
      }
    }

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
          perApplicationAmount,
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
          // Label the EFFECTIVE prepay rate, not the configured 5% — the lawn
          // program minimum's protected floor can cap the discount to a sliver
          // of the annual, and the invoice must claim the same rate the public
          // page showed at approval.
          const prepayDiscountPctLabel = annualPrepayDiscountPctLabel(prepayResolved.rate);
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
            : `Auto-generated from accepted estimate #${estimateId}. Customer selected "Pay the year upfront" — $99.00 setup fee waived per WaveGuard membership policy.`;
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
          // Acceptance deposit credits against this prepay invoice through
          // create()'s depositCredit param, exactly like the standard branch
          // below — prepay-annual accepts owe the $49 deposit (owner decision
          // 2026-07-05), and this invoice is the only one a prepay estimate
          // ever mints, so a credit missed here would strand on the ledger
          // (covered visits invoice nothing at completion, and the
          // required-path sweep never refunds it). That is also why the
          // ledger read fails CLOSED: the accept gate may have just verified
          // a real deposit, so a read error must abort the accept
          // (retryable) rather than mint the year with the credit silently
          // dropped. A clean null read is the legitimate no-deposit path
          // (legacy/manual conversions). Ledger read and consumption both
          // ride `database` (the accept transaction when called from
          // accept): the credit line exists IFF the ledger consumed exactly
          // that amount, or the whole accept rolls back — never an accepted
          // prepay beside an unconsumed deposit row.
          let appliedPrepayDepositCredit = 0;
          const { pendingDepositCredit, consumeDepositCredit } = require('./estimate-deposits');
          let prepayDepositCredit;
          try {
            prepayDepositCredit = await pendingDepositCredit(estimateId, database);
          } catch (ledgerErr) {
            throw new Error(`deposit ledger read failed for annual prepay invoice (estimate ${estimateId}): ${ledgerErr.message}`);
          }
          const requestedPrepayDepositCredit = prepayDepositCredit ? Number(prepayDepositCredit.amount) : 0;
          // Labeled manual discount on the prepay invoice (owner 2026-07-11):
          // DESCRIPTION-level only — the prepay line stays at the NET
          // annualAmount because annual-prepay-renewals seeds each covered
          // visit's fallback estimated_price from invoices.subtotal
          // (annual-prepay-renewals.js ~375-379); a grossed subtotal would
          // rebill voided/refunded prepay visits at the pre-credit rate
          // (codex 2652 r1). The prepay % discount is already communicated
          // the same way (in the line description), so the manual credit
          // rides beside it. The standard (per-application) leg keeps the
          // real labeled discount line — its invoice subtotal feeds nothing.
          const prepayManualLabel = opts.manualDiscountItemization
            && Number(opts.manualDiscountItemization.annualAmount) > 0
            ? String(opts.manualDiscountItemization.label || '').trim()
            : '';
          const inv = await InvoiceService.create({
            database,
            customerId,
            title: `${prepayPlanPrefix} — Annual Prepay (12 months)`,
            lineItems: [{
              description: prepayManualLabel
                ? `${prepayLineDescription} — ${prepayManualLabel} applied`
                : prepayLineDescription,
              quantity: 1,
              unit_price: annualAmount,
            }],
            notes: prepayNotes,
            dueDate: etDateString(),
            ...(prepayTaxRate !== undefined ? { taxRate: prepayTaxRate } : {}),
            ...(requestedPrepayDepositCredit > 0
              ? { depositCredit: { amount: requestedPrepayDepositCredit, estimateId } }
              : {}),
          });
          // Assign the id BEFORE consuming the credit: an allocation-mismatch
          // throw below must leave draftInvoiceId set so the outer cleanup can
          // void the just-created invoice on a no-caller-transaction run
          // (accept-path runs ride the caller trx and roll back wholesale).
          draftInvoiceId = inv?.id || null;
          appliedPrepayDepositCredit = Number(inv?.applied_deposit_credit) || 0;
          if (inv?.id && appliedPrepayDepositCredit > 0) {
            const allocated = await consumeDepositCredit({
              estimateId,
              amount: appliedPrepayDepositCredit,
              invoiceId: inv.id,
              trx: database,
            });
            if (Math.round(allocated * 100) !== Math.round(appliedPrepayDepositCredit * 100)) {
              throw new Error(`deposit allocation mismatch on annual prepay invoice (applied ${appliedPrepayDepositCredit}, allocated ${allocated})`);
            }
          }
          // Quote the amount actually invoiced/charged (tax-inclusive, net of
          // the deposit credit) so the customer/admin messaging matches what
          // the pay link collects. For residential (untaxed, no deposit)
          // inv.total === annualAmount, so this is a no-op there.
          draftInvoiceAmount = inv?.total != null ? Number(inv.total) : annualAmount;
          draftInvoicePayUrl = inv?.token ? `/pay/${inv.token}` : null;

          // Coverage config so the paid-invoice → webhook → refreshTermSnapshot
          // pipeline STAMPS the recurring visits prepaid (prevents the completion
          // double-bill). A term carries ONE coverage service, so only derive it
          // for a single recurring service; multi-service prepay coverage is
          // Phase 2 (left legacy, warned). Derive from the SAME svc / cadence /
          // visit-count the recurring series is built from (serviceName below at
          // the series loop, inferRecurringPattern, visitsPerYearForRecurringService)
          // so ensureCoverageRowsForTerm attaches the EXISTING visits instead of
          // seeding a duplicate series.
          let coverageServiceType;
          let coverageVisitCount;
          let coverageCadence;
          let seasonalPrepayCoverageUnsupported = false;
          if (annualPrepayCoverageOverride && recurringServicesForConversion.length === 1) {
            // Prepay-on-book: the caller (admin-schedule accept-on-book) already
            // created the coverage series with the BOOKED service_type/cadence
            // and the operator's visit count — those rows, not a derived label,
            // are what attach/stamp must match, so the override wins. Gated to
            // the single-recurring case like the derivation below, so the
            // (0-recurring) prepay edge keeps its no-coverage/no-seeding shape
            // and can't grow phantom seeded visits from an override.
            coverageServiceType = annualPrepayCoverageOverride.serviceType;
            coverageVisitCount = annualPrepayCoverageOverride.visitCount;
            coverageCadence = annualPrepayCoverageOverride.cadence;
          } else if (recurringServicesForConversion.length === 1) {
            const coverageSvc = recurringServicesForConversion[0];
            const svcType = coverageSvc.name || coverageSvc.serviceName || coverageSvc.service_name || null;
            const cadence = annualPrepayCoverageCadence(coverageSvc, inferredFrequencyKey);
            if (cadence === RecurringAppointmentSeeder.SEASONAL_FEB_OCT) {
              // seasonal_feb_oct is UNSUPPORTED as a prepay coverage cadence
              // (see prepayCoverageCadenceForPattern): the coverage seeder fills
              // remaining visits with same-day-of-month math from one stored
              // cadence and would place prepaid visits in Nov–Jan, which then
              // complete-bill again. The seeded series meanwhile IS seasonal
              // (converterFollowUpSeedingPattern forces it), so recording the
              // raw inferred cadence here would diverge from the real series.
              // Fail closed via the guard in the term-creation try below.
              seasonalPrepayCoverageUnsupported = true;
            } else {
              // Visits/year: prefer the line's explicit count (the series' own
              // source); else map from cadence. Values mirror inferCoverageCadence
              // (annual-prepay-renewals.js) so coverage aligns with the seeded series.
              const CADENCE_VISITS = {
                monthly: 12, bimonthly: 6, every_6_weeks: 9, quarterly: 4, triannual: 3, semiannual: 2, annual: 1,
              };
              const visits = visitsPerYearForRecurringService(coverageSvc) || CADENCE_VISITS[cadence] || null;
              if (svcType && visits > 0) {
                coverageServiceType = svcType;
                coverageVisitCount = visits;
                coverageCadence = cadence || undefined; // absent → applyPrepaidCoverageForTerm infers from visit count
              } else {
                // Coverage service type / visit count could not be derived (e.g. a
                // sparse line with no name/serviceName/service_name — the seeded
                // visits then fall back to the generic 'Service' label). We must NOT
                // create an unstampable term; the guard at the top of the
                // term-creation try fails closed (routes to manual).
                logger.warn(`[estimate-converter] annual-prepay coverage underivable for estimate ${estimateId} (serviceType=${svcType}, visits=${visits}) — will fail closed`);
              }
            }
          } else if (recurringServicesForConversion.length === 0 && supplementStandaloneUnits.length === 1) {
            // Supplemental-only accept (Codex r2 on the pest+rodent removal):
            // a server-priced bait-only estimate carries just the scalar —
            // the standalone unit schedules a real quarterly series (the
            // auto-schedule loop uses this same combinedScheduling), so the
            // prepay term MUST carry its coverage or those visits complete-
            // bill again on top of the prepaid amount. The unit's catalog
            // name is exactly the scheduled rows' service_type, so
            // ensureCoverageRowsForTerm attaches the existing visits.
            const unit = supplementStandaloneUnits[0];
            const CADENCE_VISITS = {
              monthly: 12, bimonthly: 6, every_6_weeks: 9, quarterly: 4, triannual: 3, semiannual: 2, annual: 1,
            };
            coverageServiceType = unit.service.name;
            coverageCadence = unit.service.frequency || undefined;
            coverageVisitCount = CADENCE_VISITS[unit.service.frequency] || 4;
          } else if (recurringServicesForConversion.length > 1) {
            // Unreachable — multi-service prepay_annual is hard-blocked at the top
            // of convertEstimate. Re-assert fail-closed so a future refactor that
            // moves or drops that guard can never silently create an under-stamped
            // (double-billing) multi-service prepay term + invoice here.
            const err = new Error(
              `Annual prepay isn't supported for multi-service plans (${recurringServicesForConversion.length} recurring services) yet — convert as monthly or bill manually.`
            );
            err.code = 'ANNUAL_PREPAY_MULTI_SERVICE_UNSUPPORTED';
            err.isOperational = true;
            err.status = 422;
            err.statusCode = 422;
            throw err;
          }

          try {
            // FAIL-CLOSED: a single-service annual prepay whose coverage service
            // type couldn't be derived (a sparse line → its seeded visits fall
            // back to the generic 'Service' label) would create a term + invoice
            // that refreshTermSnapshot can't stamp → the visits complete-bill
            // again (double bill). coverage_service_type is derived from the SAME
            // name expression the recurring visits use for service_type, so when
            // it IS set stamping matches; when it can't be, refuse and route to
            // manual rather than ship an unstampable term. The catch below voids
            // the draft invoice; the enclosing transaction rolls back the rest.
            if (seasonalPrepayCoverageUnsupported) {
              const err = new Error(
                `Annual prepay isn't supported for the seasonal (Feb–Oct) mosquito program yet — the renewal seeder can't represent its cadence and would place prepaid visits in winter. Convert as monthly or bill the prepay manually.`
              );
              err.code = 'ANNUAL_PREPAY_SEASONAL_CADENCE_UNSUPPORTED';
              err.isOperational = true;
              err.status = 422;
              err.statusCode = 422;
              throw err;
            }
            if ((recurringServicesForConversion.length === 1
              || (recurringServicesForConversion.length === 0 && supplementStandaloneUnits.length === 1))
              && !coverageServiceType) {
              const err = new Error(
                `Couldn't derive annual-prepay coverage for estimate ${estimateId} (the recurring service line has no resolvable name) — convert as monthly or bill the prepay manually.`
              );
              err.code = 'ANNUAL_PREPAY_COVERAGE_UNDERIVABLE';
              err.isOperational = true;
              err.status = 422;
              err.statusCode = 422;
              throw err;
            }
            const AnnualPrepayRenewals = require('./annual-prepay-renewals');
            const annualPrepayTerm = await AnnualPrepayRenewals.createTermForAnnualPrepay({
              customerId,
              sourceEstimateId: estimateId,
              prepayInvoiceId: draftInvoiceId,
              planLabel: `${prepayPlanPrefix} Annual Prepay`,
              monthlyRate: termMonthlyRate,
              // The GROSS tax-inclusive prepay value (what the customer pays in
              // total for the year): the net invoice total PLUS the acceptance
              // deposit already collected and credited against it. Admin/portal
              // read the term's prepayAmount as the paid amount and coverage
              // stamping splits it across visits — recording the net would
              // understate the year by the deposit. Residential with no deposit
              // is untaxed so this stays === annualAmount there.
              prepayAmount: draftInvoiceAmount != null
                ? Math.round((draftInvoiceAmount + appliedPrepayDepositCredit) * 100) / 100
                : draftInvoiceAmount,
              termStart: termStartDate || null,
              // Coverage config for the single recurring service → visits get
              // stamped on payment. A single service that couldn't be derived
              // fails closed above, so a single-service term always ships WITH
              // coverage; these are undefined only for the (0-recurring) prepay
              // edge, which seeds no visits to double-bill.
              coverageServiceType,
              coverageVisitCount,
              coverageCadence,
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
            ? `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — $99.00 setup fee plus first application.`
            : (setupFeeApplies
                ? `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — $99.00 setup fee only.`
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
              // Recurring accepts require a method on file — keeps this
              // inline param set in lockstep with estimateInvoicePayUrlParams
              // (Codex #2507 P1). Display hint only: the pay endpoints
              // enforce the requirement server-side from billing_mode.
              saveRequired: '1',
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

    logger.info(`[estimate-converter] Estimate ${estimateId} converted: customer ${customerId} → ${tier} tier, $${convertedMonthlyRate}/mo customer rate ($${monthlyRate}/mo from this estimate), ${scheduledCount} services scheduled, billingTerm=${billingTerm}, draftInvoiceId=${draftInvoiceId || 'none'}`);

    const membershipEmail = {
      customerId,
      effectiveDate: termStartDate || new Date(),
      sourceId: `estimate:${estimateId}`,
      membershipTier: tier,
      // The email describes the customer's membership — the post-conversion
      // customer rate (summed on add-on accepts), not this estimate's slice.
      monthlyRate: convertedMonthlyRate,
      billingCadence: billingCadence?.periodLabel || (billingTerm === 'prepay_annual' ? 'annual prepay' : 'monthly'),
      // Explicit lane + fee (#3140): sendMembershipStarted gates its rate
      // rows on the lane, and the explicit params are REQUIRED here — this
      // send can race the uncommitted accept transaction, so the email
      // service's row-fallback could resolve the stale pre-accept lane.
      // The fee is THIS acceptance's per-application amount (codex #3271
      // r2), which may deliberately differ from the preserved customer-level
      // stamp on an add-on accept — see
      // emailPerApplicationAmountForConversion. NULL on multi-service
      // accepts (the email row blanks and drops).
      billingLane: acceptedBillingLaneForConversion({
        billingTerm,
        preservesExistingMembership,
        customerBillingMode: customer.billing_mode || null,
        waveguardTier: commercialOnlyRecurring ? 'Commercial' : (tier === 'none' ? null : tier),
        monthlyRate: convertedMonthlyRate,
      }),
      perApplicationAmount: emailPerApplicationAmountForConversion({
        recurringUnitCount,
        billingCadence,
        perApplicationAmount,
        monthlyRate,
      }),
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
    let commercialScheduleNotification = null;
    if (hasCommercialRecurring && !suppressRecurringConversion) {
      // skipAutoSchedule (manual Mark Won) schedules NOTHING; the normal path
      // schedules only the initial visit. Reflect what actually happened so
      // dispatch knows whether the first appointment also needs creating.
      const nothingScheduled = skipAutoSchedule || scheduledCount === 0;
      const scheduleNote = nothingScheduled
        ? 'No visits were auto-scheduled — set up the full commercial visit schedule (including the first visit) manually.'
        : 'Initial visit scheduled — set up the remaining recurring commercial visits manually.';
      logger.warn(`[estimate-converter] Commercial recurring estimate ${estimateId} (customer ${customerId}) accepted — ${scheduleNote} (commercial cadence auto-scheduling not yet supported).`);
      const notificationPayload = {
        type: 'estimate_converted',
        title: `Commercial schedule needed: ${customer.first_name} ${customer.last_name}`,
        body: `Accepted commercial recurring estimate #${estimateId} — ${scheduleNote} (auto-scheduling for commercial cadences is pending).`,
        // bell: true — an accepted estimate needing a commercial schedule must
        // ring even under GATE_ADMIN_BELL_POLICY. Covers both dispatch paths:
        // the direct notify below and the deferred post-commit send in
        // estimate-manual-acceptance (both pass these options through).
        options: { icon: '\u{1F4C5}', link: '/admin/dispatch', bell: true, metadata: { estimateId, customerId } },
      };
      if (opts.deferCommercialScheduleNotification === true) {
        // In-transaction callers (public accept, manual Mark Won) dispatch this
        // post-commit from the returned payload — notifyAdmin writes through the
        // GLOBAL pool, so firing it here would alert staff about a commercial
        // schedule even when the outer transaction rolls the acceptance back.
        commercialScheduleNotification = notificationPayload;
      } else {
        try {
          const NotificationService = require('./notification-service');
          void NotificationService.notifyAdmin(
            notificationPayload.type,
            notificationPayload.title,
            notificationPayload.body,
            notificationPayload.options
          ).catch((err) => logger.warn(`[estimate-converter] commercial-schedule admin notify failed: ${err.message}`));
        } catch (err) {
          logger.warn(`[estimate-converter] commercial-schedule admin notify setup failed: ${err.message}`);
        }
      }
    }

    // Combined-tier upgrade review (owner case 2026-08-05): when this
    // accept RAISED the customer's membership tier by combining with existing
    // plans, staff must decide whether the new tier's discount also extends
    // to the EXISTING series' contracted per-visit rates. The quote card
    // promises the combined tier "discounts additions without repricing
    // current service", so nothing here reprices automatically — the owner
    // rules per customer. Same deferral contract as the commercial-schedule
    // notification: in-transaction callers dispatch post-commit so a
    // rolled-back accept can't page staff.
    let tierUpgradeNotification = null;
    // Existing-service extension (owner 2026-08-10): apply the frozen
    // snapshot plan the estimate displayed. Runs on SNAPSHOT/ACTIVATED tier
    // agreement, NOT on the persisted-tier upgrade check below (codex #3338
    // r2): a stale-stamped Silver customer whose rows only re-earn Silver
    // still displayed the extension card, and gating the apply on the
    // stored tier rising would leave that advertised discount unapplied.
    // The helper itself no-ops without a tier-matching frozen plan, so
    // legacy estimates and non-upgrades stay untouched. Savepoint-confined
    // — a failed extension rolls back only itself (writes + audit
    // together) and the accept falls back to the 2026-08-05 review copy;
    // the accepted plan is never lost to its discount extension.
    let extension = null;
    if (!suppressRecurringConversion && !commercialOnlyRecurring
      && priorQualifyingKeys.length > 0
      && tier && tier !== 'none') {
      try {
        extension = await database.transaction((sp) => applyFrozenExistingServiceExtension({
          database: sp,
          customerId,
          estimateId,
          estimateData,
          activatedTier: tier,
          monthlyLaneMember: preservesExistingMembership === true,
          priorQualifyingKeys,
        }));
      } catch (extErr) {
        logger.warn(`[estimate-converter] existing-service tier extension failed (falling back to review notice): ${extErr.message}`);
        // A throw here means the gate/plan/tier preconditions all passed
        // (the plan-less paths return before the first await), so the
        // customer accepted an ADVERTISED extension — a failed apply must
        // page staff, never vanish with the rolled-back savepoint (codex
        // #3338 r16: on a tier-equal customer neither notification operand
        // would otherwise be true).
        extension = {
          applied: false,
          repricedRowCount: 0,
          families: [],
          familyLines: [],
          creditAmount: 0,
          creditLines: [],
          skippedFamilies: [],
          reviewFamilies: ['existing-service extension failed at accept — apply manually'],
          dirtyFamilies: [],
          monthlyRateReviewNeeded: false,
        };
      }
    }
    const extensionApplied = extension?.applied === true;
    // A frozen plan that applied NOTHING but parked work (all rows drifted,
    // monthly-lane snapshot, missing identities) must still page staff
    // (codex #3338 r10 sibling): the customer accepted a card that
    // advertised automatic application, so silence is not an option even
    // when the persisted tier didn't move.
    const extensionNeedsReview = !!extension && !extensionApplied
      && (extension.reviewFamilies.length > 0
        || extension.skippedFamilies.length > 0
        || extension.monthlyRateReviewNeeded === true);
    // Upgrade REVIEW alert = the activated tier outranks the customer's
    // PERSISTED tier (codex #3228 r2) — not the tier the prior rows alone
    // would derive. A stale-stamped Gold customer whose rows only support
    // Silver is a downgrade (no "upgrade" alert), while a Bronze-stamped
    // legacy customer whose existing rows already supported Silver gets the
    // review alert the moment an accept actually moves the stored tier up.
    // An APPLIED extension always notifies, upgrade or not — money moved;
    // so does a frozen plan that parked for review.
    if (!suppressRecurringConversion && !commercialOnlyRecurring
      && priorQualifyingKeys.length > 0
      && tier && tier !== 'none'
      && (extensionApplied || extensionNeedsReview || isMembershipTierUpgrade(customer.waveguard_tier, tier))) {
      const discountPct = Math.round((discount || 0) * 100);
      const appliedClauses = extensionApplied
        ? [
          extension.familyLines.length ? `Applied automatically: ${extension.familyLines.join('; ')}.` : '',
          extension.creditLines.length ? `Prepaid-term credit issued: ${extension.creditLines.join('; ')}.` : '',
          extension.monthlyRateReviewNeeded
            ? `Monthly-billed member — extend the ${discountPct}% to their monthly rate manually (current rate $${(Number(customer.monthly_rate) || 0).toFixed(2)}/mo).`
            : '',
          [...extension.reviewFamilies, ...extension.skippedFamilies].length
            ? `Still needs review: ${[...extension.reviewFamilies, ...extension.skippedFamilies].join(', ')}.`
            : '',
        ].filter(Boolean)
        : [];
      // Review copy names the SPECIFIC parked work when a frozen plan
      // produced any (codex #3338 r10 sibling) — "review whether to
      // extend" alone would undersell an accept whose card already
      // promised the extension.
      const reviewClauses = !extensionApplied && extension
        ? [...extension.reviewFamilies, ...extension.skippedFamilies]
        : [];
      const tierReviewPayload = {
        type: 'estimate_converted',
        title: extensionApplied
          ? `WaveGuard ${tier} activated: existing services extended`
          : `WaveGuard ${tier} activated: review existing plan rates`,
        body: extensionApplied
          ? `${customer.first_name} ${customer.last_name} reached WaveGuard ${tier} (${discountPct}% tier) by adding ${estimateQualifyingKeys.join(', ') || 'a plan'} to existing ${priorQualifyingKeys.join(', ')}. ${appliedClauses.join(' ')}`
          : `${customer.first_name} ${customer.last_name} reached WaveGuard ${tier} (${discountPct}% tier) by adding ${estimateQualifyingKeys.join(', ') || 'a plan'} to existing ${priorQualifyingKeys.join(', ')}. Existing series keep their contracted per-application prices — review whether to extend the ${discountPct}% tier discount to them.${reviewClauses.length ? ` Needs manual attention: ${reviewClauses.join('; ')}.` : ''}`,
        options: {
          icon: '⭐',
          link: `/admin/customers?customerId=${customerId}`,
          bell: true,
          metadata: {
            estimateId,
            customerId,
            tier,
            priorQualifyingKeys,
            combinedServiceCount,
            ...(extensionApplied
              ? {
                extensionApplied: true,
                extensionFamilies: extension.families,
                extensionRepricedRowCount: extension.repricedRowCount,
                extensionCreditAmount: extension.creditAmount,
              }
              : {}),
          },
        },
      };
      if (opts.deferCommercialScheduleNotification === true) {
        tierUpgradeNotification = tierReviewPayload;
      } else {
        try {
          const NotificationService = require('./notification-service');
          void NotificationService.notifyAdmin(
            tierReviewPayload.type,
            tierReviewPayload.title,
            tierReviewPayload.body,
            tierReviewPayload.options,
          ).catch((err) => logger.warn(`[estimate-converter] tier-upgrade admin notify failed: ${err.message}`));
        } catch (err) {
          logger.warn(`[estimate-converter] tier-upgrade admin notify setup failed: ${err.message}`);
        }
      }
    }

    // Persist the extension OUTCOME onto the frozen snapshot (codex #3338
    // r19): the accepted read-only recap keeps showing the extension ONLY
    // when it actually applied — an accept whose plan parked for review
    // moved no money and must not read as repriced. Stamped HERE, the
    // single choke point every conversion entrypoint passes through;
    // read-modify-write inside the caller's transaction, so the accept
    // path's own estimate_data write (which lands before conversion) is
    // extended, never clobbered. Outcome is written only when a frozen
    // plan was actually in play — legacy/plan-less accepts stay untouched.
    // Never blocks the accept.
    const extensionHadPlanInPlay = !!extension
      && (extension.applied === true
        || extension.reviewFamilies.length > 0
        || extension.skippedFamilies.length > 0
        || extension.monthlyRateReviewNeeded === true);
    if (extensionHadPlanInPlay) {
      try {
        const outcomeRow = await database('estimates').where({ id: estimateId }).first('estimate_data');
        const outcomeIsString = typeof outcomeRow?.estimate_data === 'string';
        const outcomeData = outcomeIsString
          ? JSON.parse(outcomeRow.estimate_data)
          : (outcomeRow?.estimate_data || null);
        if (outcomeData?.membershipSnapshot) {
          outcomeData.membershipSnapshot.extensionOutcome = {
            applied: extension.applied === true,
            // Families whose frozen plan was honored IN FULL — the
            // committed recap projects only these (codex #3338 r26: a
            // partially-applied accept must not display parked families or
            // appointments as repriced).
            appliedFamilies: extension.families.filter(
              (key) => !extension.dirtyFamilies.includes(key),
            ),
            repricedRowCount: extension.repricedRowCount,
            creditAmount: extension.creditAmount,
            familyLines: extension.familyLines,
            creditLines: extension.creditLines,
            reviewFamilies: extension.reviewFamilies,
            skippedFamilies: extension.skippedFamilies,
            monthlyRateReviewNeeded: extension.monthlyRateReviewNeeded === true,
          };
          await database('estimates').where({ id: estimateId }).update({
            estimate_data: outcomeIsString ? JSON.stringify(outcomeData) : outcomeData,
          });
        }
      } catch (outcomeErr) {
        logger.warn(`[estimate-converter] extension outcome stamp skipped: ${outcomeErr.message}`);
      }
    }

    // Plan-rate review alert (owner ruling 2026-08-06): a legacy multi-plan
    // customer's re-quote landed on the un-splittable path — their scalar
    // was REPLACED with this accept's slices while other live plan families
    // exist, and the pre-ledger amounts could not be attributed. This is
    // the exact case the owner previously discovered by hand; the ledger
    // records this accept's slices so the NEXT re-quote splits correctly,
    // and this alert asks the owner to eyeball the rate once. Same deferred
    // post-commit mechanics as the tier alert above.
    let planRateReviewNotification = null;
    if (planRateReviewNeeded) {
      const planReviewPayload = {
        type: 'estimate_converted',
        title: 'Multi-plan rate needs review after re-quote',
        body: `${customer.first_name} ${customer.last_name} accepted a re-quote at $${convertedMonthlyRate.toFixed(2)}/mo, but they carry other live plans whose pre-ledger amounts could not be attributed — verify their total monthly rate (previous: $${(Number(customer.monthly_rate) || 0).toFixed(2)}/mo).`,
        options: {
          icon: '💵',
          link: `/admin/customers?customerId=${customerId}`,
          bell: true,
          metadata: { estimateId, customerId, convertedMonthlyRate },
        },
      };
      if (opts.deferCommercialScheduleNotification === true) {
        planRateReviewNotification = planReviewPayload;
      } else {
        try {
          const NotificationService = require('./notification-service');
          void NotificationService.notifyAdmin(
            planReviewPayload.type,
            planReviewPayload.title,
            planReviewPayload.body,
            planReviewPayload.options,
          ).catch((err) => logger.warn(`[estimate-converter] plan-rate review notify failed: ${err.message}`));
        } catch (err) {
          logger.warn(`[estimate-converter] plan-rate review notify setup failed: ${err.message}`);
        }
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
      // Post-conversion customer rate (summed on add-on accepts). The
      // estimate's own slice rides beside it for callers that need it.
      monthlyRate: convertedMonthlyRate,
      estimateMonthlyRate: monthlyRate,
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
      // Non-null ONLY when opts.deferCommercialScheduleNotification asked for
      // it (dispatched inline otherwise) — so callers can dispatch whatever
      // comes back without double-send risk.
      commercialScheduleNotification,
      // Same deferral contract as commercialScheduleNotification.
      tierUpgradeNotification,
      planRateReviewNotification,
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
module.exports.tierQualifyingRecurringServiceKeys = tierQualifyingRecurringServiceKeys;
module.exports.combinedTierQualifyingCount = combinedTierQualifyingCount;
module.exports.priorQualifyingKeysFromSnapshot = priorQualifyingKeysFromSnapshot;
module.exports.isMembershipTierUpgrade = isMembershipTierUpgrade;
module.exports.determineTier = determineTier;
module.exports.hasWaveGuardSetupService = hasWaveGuardSetupService;
module.exports.nonDiscountableRecurringAnnualFloor = nonDiscountableRecurringAnnualFloor;
module.exports.recurringServiceKey = recurringServiceKey;
module.exports.termiteStationsRentedUpdate = termiteStationsRentedUpdate;
module.exports.foldTermiteRentalIntoBait = foldTermiteRentalIntoBait;
// The $99 WaveGuard setup fee — exported so the /secure plan-choice lane
// (secure-appointment-plans.js) discloses/stamps the SAME fee this converter
// invoices on standard accepts. Never hardcode 99 elsewhere.
module.exports.WAVEGUARD_SETUP_FEE = WAVEGUARD_SETUP_FEE;
// Annual prepay supports exactly ONE recurring coverage unit — the same math
// as convertEstimate's fail-closed ANNUAL_PREPAY_MULTI_SERVICE_UNSUPPORTED
// guard (recurring.services lines + any supplemental companion a solo primary
// absorbs into one combo visit). Shared with the public /deposit-intent mirror
// so a deposit is never collected for a prepay the converter will 422.
module.exports.annualPrepayRecurringUnitCount = function annualPrepayRecurringUnitCount(estimateData = {}) {
  // MUST mirror convertEstimate's recurringUnitCount exactly — the public
  // deposit-intent flow gates on this helper, and a mismatch collects a
  // prepay deposit that acceptance later 422s (Codex r2 on the pest+rodent
  // removal). Same source of truth: recurring lines + fromSupplement
  // standalone units (combine dedupes a line + duplicate scalar to one).
  // The rental rider is folded/dropped exactly as conversion does (codex P1
  // round 5): counting the raw rider row read a rental-only bait estimate
  // as a two-unit plan and rejected the prepay conversion actually allows.
  const recurring = foldTermiteRentalIntoBait(recurringServicesFromEstimateData(estimateData));
  const { standalone } = combineRecurringServicesForScheduling(recurring, {
    acceptFrequency: estimateData?.customerSelection?.frequency || null,
    supplementalCompanions: supplementalCompanionLines(estimateData),
  });
  return recurring.length + standalone.filter((unit) => unit.fromSupplement).length;
};
module.exports.recurringServicesFromEstimateData = recurringServicesFromEstimateData;
module.exports.combineRecurringServicesForScheduling = combineRecurringServicesForScheduling;
module.exports.reservedRowComboRewrites = reservedRowComboRewrites;
module.exports.explicitServiceCadence = explicitServiceCadence;
module.exports.supplementalCompanionLines = supplementalCompanionLines;
module.exports.COMBINED_SERVICE_ROUTES = COMBINED_SERVICE_ROUTES;
module.exports.durationMinutesForRecurringService = durationMinutesForRecurringService;
module.exports.remainingUnitCatalogKey = remainingUnitCatalogKey;
module.exports.supportsConverterFollowUpSeeding = supportsConverterFollowUpSeeding;
module.exports.resolveFirstApplicationAmount = resolveFirstApplicationAmount;
module.exports.resolveAnnualPrepayDraftAmount = resolveAnnualPrepayDraftAmount;
module.exports.resolveAnnualPrepayInvoiceTotal = resolveAnnualPrepayInvoiceTotal;
module.exports.resolveLawnProgramMinimumMonthlyForEstimate = resolveLawnProgramMinimumMonthlyForEstimate;
module.exports.resolveLawnProgramMinimumMonthlyIgnoringBreach = resolveLawnProgramMinimumMonthlyIgnoringBreach;
module.exports.estimateLawnProgramMinimumSignal = estimateLawnProgramMinimumSignal;
module.exports.estimateManualDiscountFloorBreachAcknowledged = estimateManualDiscountFloorBreachAcknowledged;
module.exports.annualPrepayDiscountComponents = annualPrepayDiscountComponents;
module.exports.annualPrepayDiscountPctLabel = annualPrepayDiscountPctLabel;
module.exports.resolveCommercialPrepayTaxRate = resolveCommercialPrepayTaxRate;
module.exports.resolveCommercialPrepayBaseRate = resolveCommercialPrepayBaseRate;
module.exports.canAutoSendDraftInvoice = canAutoSendDraftInvoice;
module.exports.shouldSuppressRecurringConversion = shouldSuppressRecurringConversion;
module.exports.shouldAttachScheduledServiceToStandardDraftInvoice = shouldAttachScheduledServiceToStandardDraftInvoice;
module.exports.serviceCountsTowardWaveGuardTier = serviceCountsTowardWaveGuardTier;
module.exports.shouldIncludeWaveGuardSetupFeeForRecurring = shouldIncludeWaveGuardSetupFeeForRecurring;
module.exports.estimateOperatorSetupFeeWaived = estimateOperatorSetupFeeWaived;
module.exports.recurringMixHasMembershipFeeService = recurringMixHasMembershipFeeService;
module.exports.shouldCreateDraftInvoiceForRecurring = shouldCreateDraftInvoiceForRecurring;
module.exports.converterFollowUpSeedingPattern = converterFollowUpSeedingPattern;
module.exports.annualPrepayCoverageCadence = annualPrepayCoverageCadence;
module.exports.riderAwareSingleUnitVisits = riderAwareSingleUnitVisits;
module.exports.visitsPerYearForRecurringService = visitsPerYearForRecurringService;
module.exports.estimateOneTimeItemsFromData = estimateOneTimeItemsFromData;
module.exports.recurringLineAnnualAmount = recurringLineAnnualAmount;
module.exports.recurringServicesFromEstimateData = recurringServicesFromEstimateData;
module.exports.FL_COMMERCIAL_TAX_RATE = FL_COMMERCIAL_TAX_RATE;
module.exports.classifyAddOnAcceptContext = classifyAddOnAcceptContext;
module.exports.acceptedBillingLaneForConversion = acceptedBillingLaneForConversion;
module.exports.emailPerApplicationAmountForConversion = emailPerApplicationAmountForConversion;
module.exports.applyFrozenExistingServiceExtension = applyFrozenExistingServiceExtension;
