'use strict';

// Post-application watering rule for a catalog product (pure module, no db).
//
// A rule is one small JSON object stored on products_catalog
// .post_application_watering and frozen into the completion product facts:
//
//   { mode: 'hold' | 'water_in' | 'none',
//     hold_hours, water_in_inches, water_in_by_hours,
//     source: 'label' | 'owner' | 'default',
//     label_note, verified_at, verified_by }
//
// resolveWateringRule precedence: valid stored rule -> derivation -> null.
// null = "unknown": callers keep today's legacy behaviour (no claim).
//
// There is deliberately no mow_hold_days key: mowing gets its own column.

const MODES = ['hold', 'water_in', 'none'];
const SOURCES = ['label', 'owner', 'default'];
const RULE_KEYS = [
  'mode', 'hold_hours', 'water_in_inches', 'water_in_by_hours',
  'source', 'label_note', 'verified_at', 'verified_by',
];

const DEFAULT_HOLD_HOURS = 24;
const DEFAULT_WATER_IN_INCHES = 0.25;
const DEFAULT_WATER_IN_BY_HOURS = 24;
const MAX_HOURS = 168;
const MAX_INCHES = 2;
const MAX_TEXT = 500;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function parseJson(json) {
  if (typeof json !== 'string') return json;
  try { return JSON.parse(json); } catch { return undefined; }
}

function positiveNumber(v, max) {
  if (typeof v === 'string' && v.trim() !== '') v = Number(v);
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v : null;
}

function optionalText(v, field, errors) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > MAX_TEXT) {
    errors.push(`${field} must be a string of at most ${MAX_TEXT} characters`);
    return null;
  }
  return v;
}

// validateRule(json) -> { valid, errors, rule }
// `json` is an object or a JSON string. `rule` is the normalized rule (only
// the keys that apply to its mode, defaults filled in) when valid, else null.
function validateRule(json) {
  const value = parseJson(json);
  const errors = [];
  if (!isPlainObject(value)) {
    return { valid: false, errors: ['rule must be a JSON object'], rule: null };
  }
  for (const key of Object.keys(value)) {
    if (!RULE_KEYS.includes(key)) errors.push(`unknown key: ${key}`);
  }
  if (!MODES.includes(value.mode)) errors.push(`mode must be one of ${MODES.join(', ')}`);
  if (!SOURCES.includes(value.source)) errors.push(`source must be one of ${SOURCES.join(', ')}`);

  const rule = { mode: value.mode };
  if (value.mode === 'hold') {
    const hours = value.hold_hours == null ? DEFAULT_HOLD_HOURS : positiveNumber(value.hold_hours, MAX_HOURS);
    if (hours == null) errors.push(`hold_hours must be a number greater than 0 and at most ${MAX_HOURS}`);
    rule.hold_hours = hours;
  } else if (value.mode === 'water_in') {
    const inches = value.water_in_inches == null ? DEFAULT_WATER_IN_INCHES : positiveNumber(value.water_in_inches, MAX_INCHES);
    const byHours = value.water_in_by_hours == null ? DEFAULT_WATER_IN_BY_HOURS : positiveNumber(value.water_in_by_hours, MAX_HOURS);
    if (inches == null) errors.push(`water_in_inches must be a number greater than 0 and at most ${MAX_INCHES}`);
    if (byHours == null) errors.push(`water_in_by_hours must be a number greater than 0 and at most ${MAX_HOURS}`);
    rule.water_in_inches = inches;
    rule.water_in_by_hours = byHours;
  }
  rule.source = value.source;
  rule.label_note = optionalText(value.label_note, 'label_note', errors);
  let verifiedAt = null;
  if (value.verified_at != null && value.verified_at !== '') {
    const t = new Date(value.verified_at);
    if (Number.isNaN(t.getTime())) errors.push('verified_at must be a valid date');
    else verifiedAt = t.toISOString();
  }
  rule.verified_at = verifiedAt;
  rule.verified_by = optionalText(value.verified_by, 'verified_by', errors);

  return errors.length ? { valid: false, errors, rule: null } : { valid: true, errors: [], rule };
}

// ── Form classification ─────────────────────────────────────────────────
// Free-text vocabulary is "WDG, SC, EC, granular, liquid, gel, bait". WG/WDG
// contain a G but are mixed with water and sprayed, so spray tokens are tested
// BEFORE granule tokens. Each source (formulation, then application_method,
// then name) is tried in turn; the first source that classifies wins.
const SPRAY_RE = /(?:^|[^a-z0-9])(?:wg|wdg|wsg|sc|ec|ew|sl|cs|df|wp|f|liquid|flowable|foliar|spray|drench|concentrate|solution|suspension|emulsifiable)(?:$|[^a-z0-9])/i;
const GRANULE_RE = /(?:^|[^a-z0-9])(?:g|\d+g|granular|granule|granules|broadcast)(?:$|[^a-z0-9])/i;

function formOf(text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  if (SPRAY_RE.test(s)) return 'spray';
  if (GRANULE_RE.test(s)) return 'granular';
  return null;
}

function classifyForm(row) {
  return formOf(row.formulation) || formOf(row.application_method) || formOf(row.name);
}

const PRE_EMERGENT_RE = /pre-?\s?emerg|prodiamine|pendimethalin|dithiopyr|indaziflam|isoxaben|oryzalin|oxadiazon|barricade|dimension|specticle|pendulum|surflan|ronstar/i;

function isPreEmergent(row) {
  return PRE_EMERGENT_RE.test([row.name, row.active_ingredient, row.subcategory, row.category].filter(Boolean).join(' '));
}

function defaultRule(fields) {
  return {
    mode: fields.mode,
    ...(fields.mode === 'hold' ? { hold_hours: fields.hold_hours } : {}),
    ...(fields.mode === 'water_in'
      ? { water_in_inches: DEFAULT_WATER_IN_INCHES, water_in_by_hours: DEFAULT_WATER_IN_BY_HOURS }
      : {}),
    source: 'default',
    label_note: null,
    verified_at: null,
    verified_by: null,
  };
}

// deriveDefaultRule(row) -> rule (source 'default') | null
// First match wins:
//   1. post-emergent herbicide spray            -> hold, max(24, ceil(rainfast/60)) h
//   2. pre-emergent (any form), any granular product, or irrigation_required
//      true                                      -> water_in 0.25 in by 24 h
//      (irrigation_required === false never yields water_in)
//   3. liquid fertilizer / micronutrient / supplement spray -> none
//   4. insecticide / fungicide spray with no stored rule    -> null (never
//      'none': label reads for Talak and Artavia say hold 24 h / 48 h)
//   5. anything else                                        -> null
function deriveDefaultRule(row) {
  if (!row || typeof row !== 'object') return null;
  const category = String(row.category || '').toLowerCase();
  const form = classifyForm(row);
  const flagFalse = row.irrigation_required === false;
  const preEmergent = isPreEmergent(row);
  const herbicide = category.includes('herbicide') || preEmergent;

  if (herbicide && !preEmergent && form === 'spray') {
    const rainfastMinutes = Number(row.rainfast_minutes);
    const rainfastHours = Number.isFinite(rainfastMinutes) && rainfastMinutes > 0
      ? Math.ceil(rainfastMinutes / 60)
      : 0;
    return defaultRule({ mode: 'hold', hold_hours: Math.max(DEFAULT_HOLD_HOURS, rainfastHours) });
  }

  if (!flagFalse && (preEmergent || form === 'granular' || row.irrigation_required === true)) {
    return defaultRule({ mode: 'water_in' });
  }

  const nutrient = /fertiliz|micronutrient|supplement|nutrient/.test(category);
  if (nutrient && form === 'spray') return defaultRule({ mode: 'none' });

  return null;
}

// resolveWateringRule(row) -> rule | null. Valid stored JSON, else derived.
function resolveWateringRule(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.post_application_watering != null) {
    const checked = validateRule(row.post_application_watering);
    if (checked.valid) return checked.rule;
  }
  return deriveDefaultRule(row);
}

module.exports = {
  MODES,
  SOURCES,
  validateRule,
  deriveDefaultRule,
  resolveWateringRule,
};
