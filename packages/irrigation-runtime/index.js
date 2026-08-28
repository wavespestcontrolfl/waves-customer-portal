/**
 * @waves/irrigation-runtime — runtime → inches-per-week conversion.
 *
 * Customers describe their sprinklers in natural units (minutes per zone,
 * which days, what kind of heads) far more readily than in the engineering
 * unit the water balance needs (inches per week). This module is the ONE
 * place that converts, so the portal preview, the Monday irrigation email
 * and the lawn report water balance cannot drift from each other.
 *
 *   inches/week = (minutes ÷ 60) × head rate (in/hr) × watering days/week
 *
 * Zone COUNT does not enter the formula: precipitation rate is per area, so
 * every zone puts down the same depth for the same runtime.
 *
 * Head precipitation rates are the UF/IFAS typical application rates for
 * residential systems (AE451 "Basic Repairs and Maintenance for Home
 * Landscape Irrigation Systems"; ENH9 "Watering Your Florida Lawn"): fixed
 * spray heads ≈ 1.5 in/hr, rotors ≈ 0.5 in/hr. They are published defaults,
 * not customer data — a catch-can test on the actual system is the only way
 * to know the real rate, which is why the customer's own inches-per-week
 * entry always outranks the derived figure.
 *
 * Drip zones irrigate beds, not turf, and mixed head types put water down at
 * very different rates — neither converts to a single lawn figure, so both
 * decline (reason codes below) rather than guess. NEVER impute.
 *
 * Pure CommonJS, zero dependencies — consumable by the CJS server via
 * require() and by the ESM/Vite client via import.
 */

const HEAD_PRECIP_RATE_IN_PER_HR = Object.freeze({
  spray: 1.5,
  rotor: 0.5,
});

const HEAD_LABELS = Object.freeze({
  spray: 'spray heads',
  rotor: 'rotor heads',
  drip: 'drip',
});

// Same seven keys the portal pills emit (watering_days / mowing_days).
const DAY_KEYS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

const MAX_RUN_MINUTES = 240;

// Same ceiling the portal's explicit weekly-inches field validates against
// (property.js Joi max(5)). A derived figure above it — 240 min × 7 days on
// spray is 42"/week — is a data-entry artifact, not a schedule, and must
// decline rather than flow into customer watering advice.
const MAX_INCHES_PER_WEEK = 5;

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch {
      return [value];
    }
  }
  return [];
}

function positiveInt(value, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const i = Math.round(n);
  return i > max ? null : i;
}

// Legacy rows predate the canonical-keys route validation and can hold full
// day names ("Monday") or common abbreviations. EXACT aliases only — a
// prefix rule fabricated days out of non-day text ("monthly" → Mon,
// "sunny" → Sun). Anything not in this map drops.
const DAY_ALIASES = Object.freeze({
  mon: 'Mon', monday: 'Mon',
  tue: 'Tue', tues: 'Tue', tuesday: 'Tue',
  wed: 'Wed', weds: 'Wed', wednesday: 'Wed',
  thu: 'Thu', thur: 'Thu', thurs: 'Thu', thursday: 'Thu',
  fri: 'Fri', friday: 'Fri',
  sat: 'Sat', saturday: 'Sat',
  sun: 'Sun', sunday: 'Sun',
});

function normalizeDays(value) {
  const seen = new Set(toArray(value)
    .map((d) => DAY_ALIASES[String(d || '').trim().toLowerCase()])
    .filter(Boolean));
  return DAY_KEYS.filter((d) => seen.has(d));
}

function normalizeHeadTypes(value) {
  const seen = new Set(toArray(value).map((t) => String(t || '').trim().toLowerCase()).filter(Boolean));
  return Array.from(seen);
}

/**
 * @param {object} input
 * @param {number|string|null} input.runMinutes   TOTAL minutes each zone runs
 *   on a watering day — a cycle-and-soak controller's cycles are summed by
 *   the customer (the portal field says so); the formula counts the figure
 *   once per watering day
 * @param {Array|string|null} input.wateringDays  ['Mon','Wed',...] (jsonb array or JSON string)
 * @param {Array|string|null} input.systemType    ['spray'|'rotor'|'drip', ...]
 * @returns {{
 *   inchesPerWeek: number|null,   // rounded to hundredths; null when it cannot be derived
 *   reason: string|null,          // why it could not be derived (null when it could)
 *   runMinutes: number|null,
 *   runsPerWeek: number,
 *   headType: string|null,        // the single head type the rate came from
 *   rateInPerHr: number|null,
 * }}
 *
 * Reasons (all "declined", never guessed):
 *   'missing_minutes'   no per-zone runtime
 *   'missing_days'      no watering days
 *   'missing_head_type' no head type recorded
 *   'mixed_head_types'  more than one head type — rates differ too much
 *   'drip_only'         drip does not irrigate turf
 *   'unknown_head_type' a type this table has no published rate for
 *   'implausible_total' the math exceeds MAX_INCHES_PER_WEEK — entry artifact
 */
function deriveIrrigationInchesPerWeek({ runMinutes, wateringDays, systemType } = {}) {
  const minutes = positiveInt(runMinutes, MAX_RUN_MINUTES);
  const days = normalizeDays(wateringDays);
  const heads = normalizeHeadTypes(systemType);
  const base = { inchesPerWeek: null, runMinutes: minutes, runsPerWeek: days.length, headType: null, rateInPerHr: null };

  if (minutes == null) return { ...base, reason: 'missing_minutes' };
  if (!days.length) return { ...base, reason: 'missing_days' };
  if (!heads.length) return { ...base, reason: 'missing_head_type' };
  if (heads.length === 1 && heads[0] === 'drip') return { ...base, reason: 'drip_only' };
  if (heads.length > 1) return { ...base, reason: 'mixed_head_types' };
  const rate = HEAD_PRECIP_RATE_IN_PER_HR[heads[0]];
  if (rate == null) return { ...base, reason: 'unknown_head_type' };

  const inches = Math.round(((minutes / 60) * rate * days.length) * 100) / 100;
  if (inches > MAX_INCHES_PER_WEEK) return { ...base, reason: 'implausible_total' };
  return { ...base, inchesPerWeek: inches, reason: null, headType: heads[0], rateInPerHr: rate };
}

/**
 * Plain-English description of the inputs a derived figure came from, for
 * copy that must say WHERE a number the customer never typed came from:
 * "20 minutes per zone, 4 days a week on spray heads".
 */
function describeRuntimeBasis(derived) {
  if (!derived || derived.inchesPerWeek == null) return null;
  const dayWord = derived.runsPerWeek === 1 ? 'day' : 'days';
  return `${derived.runMinutes} minutes per zone, ${derived.runsPerWeek} ${dayWord} a week on ${HEAD_LABELS[derived.headType] || derived.headType}`;
}

/**
 * The three inputs as the sender sees them, normalized — so copy that names
 * "what we already have on file" and "the one thing missing" reads the same
 * columns the derivation does.
 */
function normalizeRuntimeInputs({ runMinutes, wateringDays, systemType } = {}) {
  return {
    runMinutes: positiveInt(runMinutes, MAX_RUN_MINUTES),
    wateringDays: normalizeDays(wateringDays),
    headTypes: normalizeHeadTypes(systemType),
  };
}

// ---------------------------------------------------------------------------
// This week's watering plan — the DECISION only (no prose; the email and the
// lawn report render it). Governing principle (owner ruling 2026-08-28):
// recommend the smallest LEGAL irrigation action that keeps an established
// lawn healthy, using observed rain and soil-water need first, forecast rain
// second (conditionally, never credited up front), and visible turf stress
// as the customer's final override.
//
// Precedence: legal restriction → turf need → observed rain / carryover →
// forecast → customer's own schedule (used only to phrase "less than you run
// now"; never as authority for WHICH days — the permitted day is the
// customer's assigned one until an ordinance/address lane exists).
// ---------------------------------------------------------------------------

// UF/IFAS: apply ½–¾" per irrigation event, deep and infrequent. ½" is the
// DEFAULT dose (spray ≈ 20 min, rotor ≈ 60 min); the dose rises toward ¾"
// only when the soil-water deficit justifies it.
const EVENT_DEPTH_MIN_INCHES = 0.5;
const EVENT_DEPTH_MAX_INCHES = 0.75;
// Below one meaningful event there is nothing to schedule — a 0.3" deficit is
// never "topped off" with a ½" run (the hold threshold IS the event minimum).
const HOLD_BELOW_INCHES = EVENT_DEPTH_MIN_INCHES;
// Last week's surplus is not banked 1:1 — SWFL sand drains and runs off. Cap
// carryover at an estimated root-zone storage (AE482 daily balance uses a
// root-zone bucket; ~½" is a conservative established-turf figure).
const ROOT_ZONE_STORAGE_INCHES = 0.5;
// FAWN / UF/IFAS rule of thumb: ≥ ½" of rain skips the next scheduled run.
// A forecast at or above it makes the plan CONDITIONAL, not cancelled.
const RAIN_SKIP_INCHES = 0.5;
// Seasonal ceiling on events even where restrictions allow more: warm months
// up to 2, Dec–Mar one ("every 10–14 days if needed").
const SEASONAL_MAX_EVENTS = Object.freeze({ peak: 2, shoulder: 2, cool: 1 });
// Sanity band for a MEASURED application rate (in/hr) computed from a
// customer's typed inches ÷ their runtime — outside it the inputs disagree
// and the default head rate is used instead.
const MEASURED_RATE_MIN = 0.2;
const MEASURED_RATE_MAX = 4;

function round2(n) { return Math.round(n * 100) / 100; }
function roundTo5(n) { return Math.max(5, Math.round(n / 5) * 5); }
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function finiteOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Application rate (in/hr) for minutes → depth. MEASURED when the customer
 * typed weekly inches AND a runtime (inches ÷ (min/60 × days)) — their
 * system's real output; otherwise the published head-type default; null
 * when neither is available (plan degrades to events-only).
 */
function resolveApplicationRate({ explicitInchesPerWeek, runMinutes, wateringDays, systemType } = {}) {
  const inputs = normalizeRuntimeInputs({ runMinutes, wateringDays, systemType });
  // A per-zone runtime needs ONE turf head type: a mixed system's zones put
  // down water at very different rates, drip doesn't irrigate turf, and an
  // unknown/missing type can't be converted — all stay events-only, even
  // when weekly inches were typed (a whole-system average is not a per-zone
  // minute figure).
  const turfHeads = inputs.headTypes.filter((h) => h !== 'drip');
  if (turfHeads.length !== 1 || HEAD_PRECIP_RATE_IN_PER_HR[turfHeads[0]] == null) {
    return { rateInPerHr: null, rateSource: null, headType: null };
  }
  const headType = turfHeads[0];
  const explicit = finiteOrNull(explicitInchesPerWeek);
  if (explicit != null && explicit > 0 && inputs.runMinutes != null && inputs.wateringDays.length) {
    const rate = explicit / ((inputs.runMinutes / 60) * inputs.wateringDays.length);
    if (rate >= MEASURED_RATE_MIN && rate <= MEASURED_RATE_MAX) {
      return { rateInPerHr: round2(rate), rateSource: 'measured', headType };
    }
  }
  return { rateInPerHr: HEAD_PRECIP_RATE_IN_PER_HR[headType], rateSource: 'system_type_default', headType };
}

/**
 * @param {object} input
 * @param {number|null} input.targetInchesPerWeek   this week's turf need (ET₀×Kc or seasonal)
 * @param {number|null} input.lastWeekAppliedInches last week's rain + irrigation (null = unknown)
 * @param {number|null} input.lastWeekRainInches    last week's observed rain alone (carryover basis when rainSensor)
 * @param {number|null} input.lastWeekTargetInches  last week's need (defaults to target)
 * @param {number|null} input.forecastRainInches    7-day forecast total (null = unavailable)
 * @param {'peak'|'shoulder'|'cool'} input.season
 * @param {{maxDaysPerWeek:number}|null} input.restriction CURRENT legal policy — null = no plan
 * @param {number|string|null} input.runMinutes     customer's minutes per zone (phrasing only)
 * @param {Array|string|null} input.wateringDays
 * @param {Array|string|null} input.systemType
 * @param {number|null} input.explicitInchesPerWeek
 * @param {boolean} input.rainSensor
 * @param {boolean} input.rainKnown                 last week's rain was observed
 * @returns {object} decision — see fields below; `action` is
 *   'unavailable' (no legal policy / no target), 'hold' (skip turf watering
 *   this week), or 'run' (with `conditionalOnForecast` when rain ≥ ½" is
 *   expected: leave off, run only if it doesn't come).
 */
function buildWeekPlan({
  targetInchesPerWeek = null,
  lastWeekAppliedInches = null,
  lastWeekRainInches = null,
  lastWeekTargetInches = null,
  forecastRainInches = null,
  season = 'peak',
  restriction = null,
  runMinutes = null,
  wateringDays = null,
  systemType = null,
  explicitInchesPerWeek = null,
  rainSensor = false,
  rainKnown = true,
} = {}) {
  const reasons = [];
  const legalMaxEvents = restriction && Number.isInteger(Number(restriction.maxDaysPerWeek)) && Number(restriction.maxDaysPerWeek) >= 0
    ? Number(restriction.maxDaysPerWeek)
    : null;
  const target = finiteOrNull(targetInchesPerWeek);
  const base = {
    action: 'unavailable',
    events: 0,
    depthInches: null,
    minutesPerEvent: null,
    rateInPerHr: null,
    rateSource: null,
    headType: null,
    permittedDays: null, // never the customer's saved days — assigned-day lane not built
    legalMaxEvents,
    seasonalMaxEvents: SEASONAL_MAX_EVENTS[season] ?? SEASONAL_MAX_EVENTS.peak,
    targetInches: target,
    carryoverInches: 0,
    needInches: null,
    forecastRainInches: finiteOrNull(forecastRainInches),
    conditionalOnForecast: false,
    rainSensor: rainSensor === true,
    season,
    reasons,
    confidence: 'low',
  };
  if (legalMaxEvents == null) { reasons.push('restriction_policy_missing'); return base; }
  if (target == null || target < 0) { reasons.push('target_missing'); return base; }

  // Carryover: only a SURPLUS carries, only up to root-zone storage. With a
  // rain sensor the programmed irrigation is an UPPER BOUND (the sensor may
  // have skipped runs — which ones is unknowable), so only the observed rain
  // can prove a surplus; assumed irrigation never tells a sensor customer to
  // skip a run.
  const applied = finiteOrNull(rainSensor === true ? lastWeekRainInches : lastWeekAppliedInches);
  const lastTarget = finiteOrNull(lastWeekTargetInches) ?? target;
  let carryover = 0;
  if (applied != null && applied > lastTarget) {
    carryover = round2(clamp(applied - lastTarget, 0, ROOT_ZONE_STORAGE_INCHES));
    if (carryover > 0) reasons.push(rainSensor === true ? 'prior_week_rain_surplus' : 'prior_week_overwatered');
  }
  const need = round2(Math.max(0, target - carryover));
  if (season === 'cool') reasons.push('cool_season');

  const rate = resolveApplicationRate({ explicitInchesPerWeek, runMinutes, wateringDays, systemType });
  const forecast = base.forecastRainInches;
  const forecastSkips = forecast != null && forecast >= RAIN_SKIP_INCHES;
  if (forecastSkips) reasons.push('forecast_rain');
  if (forecast == null) reasons.push('forecast_unavailable');
  if (!rainKnown) reasons.push('rain_unknown');

  const confidence = !rainKnown ? 'low'
    : (rate.rateSource === 'measured' && forecast != null ? 'high' : 'medium');

  // A "run" plan sized for the need, used both as the plan and as the
  // conditional fallback ("if less than ½" falls, run one cycle").
  const maxEvents = Math.min(legalMaxEvents, base.seasonalMaxEvents);
  const sizeRun = (needInches) => {
    if (maxEvents === 0) return { events: 0, depthInches: null, minutesPerEvent: null };
    const events = clamp(Math.ceil(needInches / EVENT_DEPTH_MAX_INCHES), 1, maxEvents);
    const depth = round2(clamp(needInches / events, EVENT_DEPTH_MIN_INCHES, EVENT_DEPTH_MAX_INCHES));
    // A MEASURED rate earns a whole-minute figure ("run 23 minutes"); a
    // published default is an estimate and rounds to 5 ("about 20 minutes").
    const minutes = rate.rateInPerHr
      ? (rate.rateSource === 'measured' ? Math.max(1, Math.round((depth / rate.rateInPerHr) * 60)) : roundTo5((depth / rate.rateInPerHr) * 60))
      : null;
    return { events, depthInches: depth, minutesPerEvent: minutes };
  };

  const common = { ...base, ...rate, carryoverInches: carryover, needInches: need, confidence };

  // A legal ban wins over everything — checked BEFORE the low-need hold so a
  // prohibited week never carries a wilt-override cycle.
  if (maxEvents === 0) {
    reasons.push('restriction_prohibits');
    return { ...common, action: 'hold', events: 0, fallbackMinutesPerEvent: null };
  }
  if (need < HOLD_BELOW_INCHES) {
    reasons.push('need_below_event_minimum');
    // The wilt-override cycle the copy offers is one default-dose event.
    const fallback = sizeRun(EVENT_DEPTH_MIN_INCHES);
    return { ...common, action: 'hold', events: 0, depthInches: null, minutesPerEvent: null, fallbackMinutesPerEvent: fallback.minutesPerEvent };
  }
  const run = sizeRun(need);
  if (need > run.events * EVENT_DEPTH_MAX_INCHES) {
    reasons.push(legalMaxEvents <= base.seasonalMaxEvents ? 'restriction_limited' : 'season_limited');
  }
  return {
    ...common,
    ...run,
    action: 'run',
    conditionalOnForecast: forecastSkips,
    fallbackMinutesPerEvent: run.minutesPerEvent,
  };
}

module.exports = {
  buildWeekPlan,
  resolveApplicationRate,
  WEEK_PLAN_CONSTANTS: Object.freeze({ EVENT_DEPTH_MIN_INCHES, EVENT_DEPTH_MAX_INCHES, HOLD_BELOW_INCHES, ROOT_ZONE_STORAGE_INCHES, RAIN_SKIP_INCHES, SEASONAL_MAX_EVENTS }),
  normalizeRuntimeInputs,
  DAY_ALIASES,
  HEAD_PRECIP_RATE_IN_PER_HR,
  HEAD_LABELS,
  DAY_KEYS,
  MAX_RUN_MINUTES,
  MAX_INCHES_PER_WEEK,
  deriveIrrigationInchesPerWeek,
  describeRuntimeBasis,
};
