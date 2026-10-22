'use strict';

// Post-application watering rule for a catalog product (pure module, no db).
//
// A rule is one small JSON object stored on products_catalog
// .post_application_watering and frozen into the completion product facts:
//
//   { mode: 'hold' | 'water_in' | 'none',
//     hold_hours, water_in_inches, water_in_by_hours, water_in_same_day,
//     label_minimum, by_target,
//     source: 'label' | 'owner' | 'default',
//     label_note, verified_at, verified_by }
//
// label_minimum (hold only): the hold the LABEL itself needs under a longer
// one that is our own rule or a "for best results" line, e.g. { hold_until:
// 'dry' } under the owner's 24-hour herbicide hold. Only a water-in the label
// requires the same day (Dylox) may shorten a hold to it
// (lawn-watering-instruction.js rule E); nothing else reads it.
//
// by_target: a product whose label gives different directions by target
// (Acelepryn: water in for grubs, hold for caterpillars). Each entry is a
// rule of its own plus `match`, the target words it covers (lower case;
// a logged target that CONTAINS one of them is covered). The top-level mode
// is then the direction for any other target and may be left out when every
// labeled use has an entry; the FIRST entry is then the product's main use,
// read when no logged target is covered. rulesForTargets picks the rules one
// logged use carries; a rule with no top-level mode is never a rule on its
// own, so it reads as no rule wherever targets are not resolved.
//
// then_water_in (hold only): a second step the label adds after the hold,
// "if no rain falls within N days, irrigate at least 0.5 inch" (Blindside,
// Drive XLR8, Dismiss NXT): { water_in_inches, water_in_by_hours } counted
// from the application. rulesForTargets turns it into its own water-in rule
// with rain_counts: true, which the instruction always words as "needs about
// ½ inch of water by <date>. Rain and your regular watering both count."
//
// resolveWateringRule precedence: valid stored rule -> derivation -> null.
// null = "unknown": callers keep today's legacy behaviour (no claim).
//
// There is deliberately no mow_hold_days key: mowing gets its own column.

const MODES = ['hold', 'water_in', 'none'];
const SOURCES = ['label', 'owner', 'default'];
const RULE_KEYS = [
  'mode', 'hold_hours', 'hold_until', 'water_in_inches', 'water_in_by_hours', 'water_in_same_day', 'rain_counts',
  'label_minimum', 'then_water_in', 'by_target',
  'source', 'label_note', 'verified_at', 'verified_by',
];
// One by_target entry: a rule's own direction fields plus the target words.
const TARGET_RULE_KEYS = [
  'match', 'mode', 'hold_hours', 'hold_until', 'water_in_inches', 'water_in_by_hours', 'water_in_same_day', 'rain_counts',
  'label_minimum', 'then_water_in', 'label_note',
];
const LABEL_MINIMUM_KEYS = ['hold_hours', 'hold_until'];
const THEN_WATER_IN_KEYS = ['water_in_inches', 'water_in_by_hours'];
const MAX_TARGET_RULES = 6;
const MAX_MATCH_WORDS = 12;
const MAX_MATCH_TEXT = 40;

const DEFAULT_HOLD_HOURS = 24;
const DEFAULT_WATER_IN_INCHES = 0.25;
const DEFAULT_WATER_IN_BY_HOURS = 24;
const MAX_HOURS = 168;
// A pre-emergent label allows 14 days to get its water ("at least 0.5 inch of
// rainfall or irrigation within 14 days"), so a water-in window may be longer
// than a hold.
const MAX_WATER_IN_HOURS = 336;
// A water-in window longer than this is met by rain and the regular schedule,
// never by a one-off run (lawn-watering-instruction.js rule D).
const LONG_WINDOW_HOURS = 168;
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
function validateHoldFields(value, errors) {
  // A label that says "do not irrigate until the spray has dried" is a
  // CONDITION, not a duration; it is stored as hold_until 'dry' with no
  // hours, so no surface can turn it into a fixed drying time (codex P2
  // #5389 r2). hold_hours may still accompany it as an optional floor.
  const untilDry = value.hold_until === 'dry';
  if (value.hold_until != null && !untilDry) errors.push("hold_until must be 'dry' when present");
  const out = untilDry ? { hold_until: 'dry' } : {};
  if (untilDry && value.hold_hours == null) return { ...out, hold_hours: null };
  const hours = value.hold_hours == null ? DEFAULT_HOLD_HOURS : positiveNumber(value.hold_hours, MAX_HOURS);
  if (hours == null) errors.push(`hold_hours must be a number greater than 0 and at most ${MAX_HOURS}`);
  return { ...out, hold_hours: hours };
}

function validateWaterInFields(value, errors) {
  const inches = value.water_in_inches == null ? DEFAULT_WATER_IN_INCHES : positiveNumber(value.water_in_inches, MAX_INCHES);
  const byHours = value.water_in_by_hours == null ? DEFAULT_WATER_IN_BY_HOURS : positiveNumber(value.water_in_by_hours, MAX_WATER_IN_HOURS);
  if (inches == null) errors.push(`water_in_inches must be a number greater than 0 and at most ${MAX_INCHES}`);
  if (byHours == null) errors.push(`water_in_by_hours must be a number greater than 0 and at most ${MAX_WATER_IN_HOURS}`);
  // A label that says water in "the same day" (Dylox): the deadline is also
  // capped at the end of the application's ET day. Present only when true.
  if (value.water_in_same_day != null && typeof value.water_in_same_day !== 'boolean') {
    errors.push('water_in_same_day must be true or false when present');
  }
  // "The same day" and a window of more than a week contradict each other: the
  // long-window line (rule D) has no same-day cutoff, so the pair would print a
  // 14-day deadline for a same-day label.
  if (value.water_in_same_day === true && byHours != null && byHours > LONG_WINDOW_HOURS) {
    errors.push(`water_in_same_day cannot be true when water_in_by_hours is more than ${LONG_WINDOW_HOURS}`);
  }
  // rain_counts: the label lets rain do the watering in ("if no rain falls
  // within 7 days, irrigate"); worded like a long window whatever its length.
  if (value.rain_counts != null && typeof value.rain_counts !== 'boolean') errors.push('rain_counts must be true or false when present');
  if (value.rain_counts === true && value.water_in_same_day === true) errors.push('rain_counts cannot be true with water_in_same_day');
  return {
    water_in_inches: inches,
    water_in_by_hours: byHours,
    ...(value.water_in_same_day === true ? { water_in_same_day: true } : {}),
    ...(value.rain_counts === true ? { rain_counts: true } : {}),
  };
}

function validateVerifiedAt(value, errors) {
  if (value == null || value === '') return null;
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) { errors.push('verified_at must be a valid date'); return null; }
  return t.toISOString();
}

const MODE_FIELDS = { hold: validateHoldFields, water_in: validateWaterInFields, none: () => ({}) };

// The label's own minimum under a longer hold. At least one of the two
// conditions; a timed minimum never longer than the hold it sits under.
function validateLabelMinimum(value, hold, errors, field = 'label_minimum') {
  if (value == null) return null;
  if (!isPlainObject(value)) {
    errors.push(`${field} must be an object`);
    return null;
  }
  Object.keys(value).filter((key) => !LABEL_MINIMUM_KEYS.includes(key)).forEach((key) => errors.push(`unknown key: ${field}.${key}`));
  const untilDry = value.hold_until === 'dry';
  if (value.hold_until != null && !untilDry) errors.push(`${field}.hold_until must be 'dry' when present`);
  const hours = value.hold_hours == null ? null : positiveNumber(value.hold_hours, MAX_HOURS);
  if (value.hold_hours != null && hours == null) errors.push(`${field}.hold_hours must be a number greater than 0 and at most ${MAX_HOURS}`);
  if (!untilDry && hours == null) errors.push(`${field} needs hold_until 'dry' or hold_hours`);
  if (hours != null && Number.isFinite(hold?.hold_hours) && hours > hold.hold_hours) {
    errors.push(`${field}.hold_hours cannot be longer than hold_hours`);
  }
  return { ...(untilDry ? { hold_until: 'dry' } : {}), ...(hours != null ? { hold_hours: hours } : {}) };
}

// The label's second step after a hold: an amount and a window counted from
// the application, both required, the window longer than the hold.
function validateThenWaterIn(value, hold, errors, field = 'then_water_in') {
  if (value == null) return null;
  if (!isPlainObject(value)) {
    errors.push(`${field} must be an object`);
    return null;
  }
  Object.keys(value).filter((key) => !THEN_WATER_IN_KEYS.includes(key)).forEach((key) => errors.push(`unknown key: ${field}.${key}`));
  const inches = positiveNumber(value.water_in_inches, MAX_INCHES);
  const byHours = positiveNumber(value.water_in_by_hours, MAX_WATER_IN_HOURS);
  if (inches == null) errors.push(`${field}.water_in_inches must be a number greater than 0 and at most ${MAX_INCHES}`);
  if (byHours == null) errors.push(`${field}.water_in_by_hours must be a number greater than 0 and at most ${MAX_WATER_IN_HOURS}`);
  if (byHours != null && Number.isFinite(hold?.hold_hours) && byHours <= hold.hold_hours) {
    errors.push(`${field}.water_in_by_hours must be longer than hold_hours`);
  }
  return inches == null || byHours == null ? null : { water_in_inches: inches, water_in_by_hours: byHours };
}

function matchWordsOf(value, errors, field) {
  const words = Array.isArray(value) ? value.map((word) => (typeof word === 'string' ? word.trim().toLowerCase() : '')) : [];
  if (!Array.isArray(value) || !words.length || words.length > MAX_MATCH_WORDS
    || words.some((word) => !word || word.length > MAX_MATCH_TEXT)) {
    errors.push(`${field} must be a list of 1 to ${MAX_MATCH_WORDS} target words of at most ${MAX_MATCH_TEXT} characters`);
    return [];
  }
  return [...new Set(words)];
}

function validateTargetRules(value, errors) {
  if (value == null) return null;
  if (!Array.isArray(value) || !value.length || value.length > MAX_TARGET_RULES) {
    errors.push(`by_target must be a list of 1 to ${MAX_TARGET_RULES} target rules`);
    return null;
  }
  return value.map((entry, index) => {
    const field = `by_target[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${field} must be an object`);
      return null;
    }
    Object.keys(entry).filter((key) => !TARGET_RULE_KEYS.includes(key)).forEach((key) => errors.push(`unknown key: ${field}.${key}`));
    if (!MODES.includes(entry.mode)) errors.push(`${field}.mode must be one of ${MODES.join(', ')}`);
    const fields = MODE_FIELDS[entry.mode] ? MODE_FIELDS[entry.mode](entry, errors) : {};
    if (entry.label_minimum != null && entry.mode !== 'hold') errors.push(`${field}.label_minimum is for a hold only`);
    if (entry.then_water_in != null && entry.mode !== 'hold') errors.push(`${field}.then_water_in is for a hold only`);
    const minimum = entry.mode === 'hold' ? validateLabelMinimum(entry.label_minimum, fields, errors, `${field}.label_minimum`) : null;
    const then = entry.mode === 'hold' ? validateThenWaterIn(entry.then_water_in, fields, errors, `${field}.then_water_in`) : null;
    return {
      match: matchWordsOf(entry.match, errors, `${field}.match`),
      mode: entry.mode,
      ...fields,
      ...(minimum ? { label_minimum: minimum } : {}),
      ...(then ? { then_water_in: then } : {}),
      label_note: optionalText(entry.label_note, `${field}.label_note`, errors),
    };
  });
}

// `json` is an object or a JSON string. `rule` is the normalized rule (only
// the keys that apply to its mode, defaults filled in) when valid, else null.
function validateRule(json) {
  const value = parseJson(json);
  if (!isPlainObject(value)) {
    return { valid: false, errors: ['rule must be a JSON object'], rule: null };
  }
  const errors = Object.keys(value).filter((key) => !RULE_KEYS.includes(key)).map((key) => `unknown key: ${key}`);
  const byTarget = validateTargetRules(value.by_target, errors);
  // A product whose every labeled use has a target rule may leave the
  // top-level direction out; anything else needs one.
  const targetOnly = value.mode == null && !!byTarget;
  if (!targetOnly && !MODES.includes(value.mode)) errors.push(`mode must be one of ${MODES.join(', ')}`);
  if (!SOURCES.includes(value.source)) errors.push(`source must be one of ${SOURCES.join(', ')}`);

  const modeFields = MODE_FIELDS[value.mode] ? MODE_FIELDS[value.mode](value, errors) : {};
  if (value.label_minimum != null && value.mode !== 'hold') errors.push('label_minimum is for a hold only');
  if (value.then_water_in != null && value.mode !== 'hold') errors.push('then_water_in is for a hold only');
  const minimum = value.mode === 'hold' ? validateLabelMinimum(value.label_minimum, modeFields, errors) : null;
  const then = value.mode === 'hold' ? validateThenWaterIn(value.then_water_in, modeFields, errors) : null;
  const rule = {
    ...(targetOnly ? {} : { mode: value.mode }),
    ...modeFields,
    ...(minimum ? { label_minimum: minimum } : {}),
    ...(then ? { then_water_in: then } : {}),
    ...(byTarget ? { by_target: byTarget } : {}),
    source: value.source,
    label_note: optionalText(value.label_note, 'label_note', errors),
    verified_at: validateVerifiedAt(value.verified_at, errors),
    verified_by: optionalText(value.verified_by, 'verified_by', errors),
  };
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

  // An affirmative catalog flag is label-derived and outranks the generic
  // post-emergent spray default (codex P2 #5389 r3).
  if (row.irrigation_required === true) return defaultRule({ mode: 'water_in' });

  if (herbicide && !preEmergent && form === 'spray') {
    const rainfastMinutes = Number(row.rainfast_minutes);
    const rainfastHours = Number.isFinite(rainfastMinutes) && rainfastMinutes > 0
      ? Math.ceil(rainfastMinutes / 60)
      : 0;
    return defaultRule({ mode: 'hold', hold_hours: Math.max(DEFAULT_HOLD_HOURS, rainfastHours) });
  }

  // A dry granular BAIT (e.g. Advion WDG Granular) is placed, not watered in:
  // its granular form must not imply water_in unless the catalog flag says so
  // (codex P2 #5389 r2).
  const bait = /\bbait\b/i.test([row.category, row.formulation, row.name, row.subcategory].filter(Boolean).join(' '));
  const granularWaterIn = form === 'granular' && !bait;
  if (!flagFalse && (preEmergent || granularWaterIn || row.irrigation_required === true)) {
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

// One by_target entry as a rule of its own (a valid rule shape): the
// parent's provenance and the entry's own note, else the parent's.
function targetRuleOf(entry, parent) {
  const { match: _match, label_note: note, ...direction } = entry;
  return {
    ...direction,
    source: parent.source,
    label_note: note ?? parent.label_note ?? null,
    verified_at: parent.verified_at ?? null,
    verified_by: parent.verified_by ?? null,
  };
}

// A hold with a then_water_in step is two rules: the hold, and the label's
// later water-in that rain may do (rain_counts).
function withThenStep(rule) {
  const { then_water_in: then, ...hold } = rule;
  if (!isPlainObject(then)) return [rule];
  return [hold, {
    mode: 'water_in',
    water_in_inches: then.water_in_inches,
    water_in_by_hours: then.water_in_by_hours,
    rain_counts: true,
    source: rule.source,
    label_note: rule.label_note ?? null,
    verified_at: rule.verified_at ?? null,
    verified_by: rule.verified_by ?? null,
  }];
}

// rulesForTargets(rule, targets) -> rule[] : the rules ONE logged use of a
// product carries. A rule with no by_target is itself. The logged targets are
// usually the completion form's label prefill (the catalog's first targets),
// not the use (codex #6449), so they pick a target rule only when they point
// ONE way: every logged target named by an entry, and every named entry the
// same mode. A mixed list (the prefill, or a real mix) reads the product's
// main use: the top-level rule, or for a target-only rule its FIRST entry. So
// does no target logged. Targets that no entry names read the top-level rule;
// on a target-only rule that is a use the label gives no watering line for:
// no rule (no claim). A hold's then_water_in step becomes a rule of its own.
// [] = no rule (no claim).
function rulesForTargets(rule, targets) {
  return pickTargetRules(rule, targets).flatMap(withThenStep);
}

// service_products.targets as stored (text[], or its JSON text): every caller
// reads a use's targets the same way.
function targetList(targets) {
  if (Array.isArray(targets)) return targets;
  if (typeof targets !== 'string') return [];
  try {
    const parsed = JSON.parse(targets);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function pickTargetRules(rule, targets) {
  if (!isPlainObject(rule)) return [];
  const { by_target: entries, ...rest } = rule;
  const base = MODES.includes(rest.mode) ? rest : null;
  if (!Array.isArray(entries) || !entries.length) return base ? [base] : [];
  const names = targetList(targets)
    .map((target) => (typeof target === 'string' ? target.trim().toLowerCase() : ''))
    .filter(Boolean);
  const main = base || targetRuleOf(entries[0], rule);
  if (!names.length) return [main];
  const covers = (entry, name) => entry.match.some((word) => name.includes(word));
  const picked = entries.filter((entry) => names.some((name) => covers(entry, name)));
  if (!picked.length) return base ? [base] : [];
  const unnamed = names.some((name) => !entries.some((entry) => covers(entry, name)));
  const oneWay = !unnamed && new Set(picked.map((entry) => entry.mode)).size === 1;
  return oneWay ? picked.map((entry) => targetRuleOf(entry, rule)) : [main];
}

module.exports = {
  MAX_HOURS,
  LONG_WINDOW_HOURS,
  MAX_INCHES,
  MODES,
  SOURCES,
  validateRule,
  deriveDefaultRule,
  resolveWateringRule,
  rulesForTargets,
  isPreEmergent,
};
