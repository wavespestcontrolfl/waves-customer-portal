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
 * @param {number|string|null} input.runMinutes   minutes each zone runs per watering day
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

module.exports = {
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
