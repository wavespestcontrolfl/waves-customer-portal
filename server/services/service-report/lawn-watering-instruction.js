'use strict';

// The one watering instruction for a lawn visit (pure module, no db, no clock).
//
// Input: the per-product watering rules frozen with the visit (see
// lawn-watering-rule.js), the completion time, and the customer's runtime
// facts. Output: ONE object that the aftercare writer, the banner payload and
// the weekly-plan not-before overlay all read, so the surfaces cannot
// disagree.
//
//   state 'hold'               skip turf watering until a clock time
//   state 'water_in'           water in by a clock time
//   state 'hold_then_water_in' hold wins; then water in after the hold ends
//   state 'none'               every product resolved, none asks for anything
//   state null                 no claim (fail closed: existing aftercare stays)
//
// Mixed visit: hold wins (hold end = completion + longest hold, rounded UP to
// the next clock hour in ET), then the water-in follows the hold.
//
// Minutes ladder for a water-in (NEVER assumes there is no sprinkler system):
//   1. customer's measured rate (typed inches per week + run minutes + days
//      + one turf head type, via @waves/irrigation-runtime)
//   2. one turf head type on file      -> owner head table (spray 15, rotor 40
//      minutes per quarter inch)
//   3. both head types / nothing on file -> both generic figures
//   4. heads on file but unknown (drip only, unrecognised) -> "one full cycle"
//   5. customer explicitly says no system -> inches with a hose-end sprinkler
// Generic copy prints minutes only, never "about a quarter inch": at the UF
// rates the runtime uses those minutes are really 0.33-0.38 inch.
//
// Copy rules: no rain probability, no county/ordinance, no re-entry or drying
// figures, and never "keep ... off", "stay off", "wait" or "dry" beside an
// hours or minutes figure (the banned re-entry pattern). Water-in copy is
// allowed on a non-permitted county day and says so.

const { resolveApplicationRate, normalizeRuntimeInputs } = require('@waves/irrigation-runtime');

const DEFAULT_TZ = 'America/New_York';
const HOUR_MS = 3600000;

// Owner table: minutes per zone for a quarter inch. Scaled linearly (rounded
// to 5) for any other rule depth.
const GENERIC_MINUTES_PER_QUARTER_INCH = Object.freeze({ spray: 15, rotor: 40 });
const BASE_INCHES = 0.25;

const HOLD_SECOND_LINE = 'That gives today’s treatment time to work.';
const PLAN_LINE = 'Then follow this week’s plan below.';
const ANY_DAY_LINE = 'Run it even if it is not your usual day.';
const NONE_LINE_1 = 'No watering change from today’s treatment.';
const NONE_LINE_2 = 'Follow this week’s plan below.';
// An "until dry" hold has no printed duration (fixed drying figures are
// prohibited customer copy). This floor is used ONLY as the base for the
// water-in deadline maths and is never printed.
const DRY_HOLD_FLOOR_HOURS = 6;
const DRY_LABEL = 'today’s treatment has dried';
const DRY_PLAN_LABEL = 'the spray has dried';
const FULL_CYCLE = 'one full cycle on each turf zone';

// ── Time helpers ─────────────────────────────────────────────────────────
function toDate(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function wallParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // Intl quirk: midnight reports as 24
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: get('weekday'),
    hour,
    minute: parseInt(get('minute'), 10),
  };
}

// Whole-hour rounding on the absolute clock. Every US zone offset is a whole
// number of hours, so an absolute hour boundary is a wall-clock hour boundary
// on both sides of a DST change.
function ceilToHour(date) {
  return new Date(Math.ceil(date.getTime() / HOUR_MS) * HOUR_MS);
}
function floorToHour(date) {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
}

function clockLabel(hour, minute = 0) {
  return `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, '0')}` : ''} ${hour < 12 ? 'AM' : 'PM'}`;
}

// A water-in DEADLINE: rounds DOWN (rounding up would hand the customer more
// time than the rule allows), but only to the hour when the window is at least
// two hours. A short window keeps minute precision, and a deadline is never at
// or before its base (a 15-minute rule completed at 2:40 PM must not read
// "by 2 PM"): if flooring would land there, the exact instant is used.
function deadlineAfter(base, hours) {
  const exact = new Date(base.getTime() + hours * HOUR_MS);
  const floored = hours >= 2 ? floorToHour(exact) : new Date(Math.floor(exact.getTime() / 60000) * 60000);
  return floored.getTime() > base.getTime() ? floored : exact;
}

// The end of the visit's ET day (23:59:59). Walks hour boundaries, so a 23- or
// 25-hour DST day is handled.
function endOfDay(anchor, tz) {
  const day = wallParts(anchor, tz).day;
  let t = ceilToHour(anchor);
  for (let i = 0; i < 26 && wallParts(t, tz).day === day; i += 1) t = new Date(t.getTime() + HOUR_MS);
  return new Date(t.getTime() - 1000);
}

// "within 24 hours" / "within 90 minutes".
function withinPhrase(hours) {
  if (Number.isInteger(hours)) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const minutes = Math.max(1, Math.round(hours * 60));
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

// "8 PM tonight" / "10 AM today" on the visit's own day, else "Wed 4 PM".
// Anchored to the (frozen) visit day, never to "now", so a permanent report
// link reads the same forever.
function formatWhen(date, anchor, tz) {
  const at = wallParts(date, tz);
  const clock = clockLabel(at.hour, at.minute);
  if (wallParts(anchor, tz).day === at.day) return `${clock} ${at.hour >= 17 ? 'tonight' : 'today'}`;
  return `${at.weekday} ${clock}`;
}

// ── Rule aggregation ─────────────────────────────────────────────────────
function ruleOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const rule = entry.mode ? entry : entry.rule;
  return rule && typeof rule === 'object' && ['hold', 'water_in', 'none'].includes(rule.mode) ? rule : null;
}

function nameOf(entry) {
  return entry && typeof entry === 'object' && !entry.mode && entry.name ? String(entry.name) : null;
}

function finitePositive(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Weakest provenance among the rules that drive the instruction.
function ruleSourceOf(rules) {
  const sources = rules.map((r) => r.source);
  if (sources.some((s) => s !== 'label' && s !== 'owner')) return 'default';
  return sources.includes('owner') ? 'owner' : 'label';
}

// ── Minutes ladder ───────────────────────────────────────────────────────
function scaledMinutes(perQuarterInch, inches) {
  return Math.max(5, Math.round((perQuarterInch * (inches / BASE_INCHES)) / 5) * 5);
}

function fmtInches(n) {
  if (Math.abs(n - 0.25) < 0.01) return '¼';
  if (Math.abs(n - 0.5) < 0.01) return '½';
  if (Math.abs(n - 0.75) < 0.01) return '¾';
  return String(Math.round(n * 100) / 100).replace(/\.?0+$/, '');
}

function minutesFor(runtime, inches) {
  const empty = { spray: null, rotor: null, unknown: false, measured: null };
  const rt = runtime && typeof runtime === 'object' && runtime.unconfirmed !== true ? runtime : null;

  // Customer said, explicitly, that there is no system. Never inferred.
  if (rt && rt.systemOn === false) {
    return { minutes: empty, basis: 'no_system', verb: 'apply', clause: `about ${fmtInches(inches)} inch of water with a hose-end sprinkler` };
  }

  const rateInput = rt ? {
    explicitInchesPerWeek: rt.explicitInchesPerWeek,
    runMinutes: rt.runMinutes,
    wateringDays: rt.wateringDays,
    systemType: rt.headTypes,
  } : null;

  if (rateInput) {
    const rate = resolveApplicationRate(rateInput);
    if (rate.rateSource === 'measured' && rate.rateInPerHr > 0) {
      const measured = Math.max(1, Math.round((inches / rate.rateInPerHr) * 60));
      return { minutes: { ...empty, measured }, basis: 'measured', clause: `each zone about ${measured} minutes` };
    }
  }

  const heads = rateInput ? normalizeRuntimeInputs(rateInput).headTypes : [];
  const turfHeads = heads.filter((h) => h !== 'drip');
  const known = turfHeads.filter((h) => GENERIC_MINUTES_PER_QUARTER_INCH[h] != null);
  const spray = scaledMinutes(GENERIC_MINUTES_PER_QUARTER_INCH.spray, inches);
  const rotor = scaledMinutes(GENERIC_MINUTES_PER_QUARTER_INCH.rotor, inches);

  if (known.length === 1 && turfHeads.length === 1) {
    const kind = known[0];
    const value = kind === 'spray' ? spray : rotor;
    return { minutes: { ...empty, [kind]: value }, basis: 'head_type', clause: `each zone about ${value} minutes` };
  }
  if (known.length === 2) {
    return { minutes: { ...empty, spray, rotor }, basis: 'mixed_heads', clause: `spray zones about ${spray} minutes and rotor zones about ${rotor} minutes` };
  }
  // Something IS on file about the system (heads, run minutes, days, the
  // toggle) but it does not name a usable turf head: one full cycle.
  const onFile = heads.length > 0
    || normalizeRuntimeInputs(rateInput || {}).runMinutes != null
    || (rt && rt.systemOn === true);
  if (onFile) {
    return { minutes: { ...empty, unknown: true }, basis: 'unknown_heads', clause: FULL_CYCLE };
  }
  // Nothing on file: never assume no sprinklers. Both generic figures.
  return { minutes: { ...empty, spray, rotor }, basis: 'generic', clause: `spray heads about ${spray} minutes a zone and rotors about ${rotor} minutes` };
}

// ── The instruction ──────────────────────────────────────────────────────
function emptyInstruction() {
  return {
    state: null,
    holdUntil: null,
    holdUntilLabel: null,
    holdUntilPlanLabel: null,
    expiresAt: null,
    waterInBy: null,
    waterInByLabel: null,
    minutes: { spray: null, rotor: null, unknown: false, measured: null },
    lines: [],
    ruleSource: null,
    products: [],
  };
}

/**
 * @param {object} input
 * @param {Array}  input.rules        per applied product: a rule object, null,
 *                                    or { name, rule }
 * @param {Date|string|null} input.completedAt
 * @param {string} [input.tz]         defaults to America/New_York
 * @param {object|null} [input.runtime] { runMinutes, wateringDays, headTypes,
 *                                    explicitInchesPerWeek, systemOn, unconfirmed }
 * @param {null} [input.forecast]     reserved (forecast-aware water-in is a later PR)
 * @param {boolean} [input.hasWeekPlan] a weekly plan callout renders below the banner
 * @returns {object}
 */
function buildWateringInstruction({ rules, completedAt, tz = DEFAULT_TZ, runtime = null, forecast = null, hasWeekPlan = false } = {}) {  
  const out = emptyInstruction();
  const list = Array.isArray(rules) ? rules : [];
  const resolved = list.map(ruleOf);
  const at = toDate(completedAt);
  if (!at || !list.length) return out;

  const holds = resolved.filter((r) => r && r.mode === 'hold');
  const waterIns = resolved.filter((r) => r && r.mode === 'water_in');
  const nones = resolved.filter((r) => r && r.mode === 'none');
  const unresolved = resolved.length - holds.length - waterIns.length - nones.length;

  out.products = list.map((entry, index) => {
    const rule = resolved[index];
    return { name: nameOf(entry), mode: rule ? rule.mode : null, source: rule ? (rule.source || null) : null };
  });

  if (!holds.length && !waterIns.length) {
    // "None" is a positive claim: only when EVERY applied product resolved to
    // a rule and at least one of them is label or owner sourced. Otherwise no
    // claim, and the existing fail-closed aftercare stays.
    if (unresolved === 0 && nones.length && nones.some((r) => r.source === 'label' || r.source === 'owner')) {
      out.state = 'none';
      out.ruleSource = ruleSourceOf(nones);
      out.lines = hasWeekPlan ? [NONE_LINE_1, NONE_LINE_2] : [NONE_LINE_1];
    }
    return out;
  }

  const driving = [...holds, ...waterIns];
  out.ruleSource = ruleSourceOf(driving);

  let waterInDetail = null;
  if (waterIns.length) {
    const inches = Math.max(...waterIns.map((r) => finitePositive(r.water_in_inches, BASE_INCHES)));
    const byHours = Math.min(...waterIns.map((r) => finitePositive(r.water_in_by_hours, 24)));
    waterInDetail = { inches, byHours, ...minutesFor(runtime, inches) };
    out.minutes = waterInDetail.minutes;
  }

  if (holds.length) {
    // A hold rule with hold_until 'dry' has no clock time; a timed hold (the
    // longer, concrete one) outranks it on the same visit.
    const timedHolds = holds.filter((r) => r.hold_until !== 'dry');
    let holdEnd = null;
    if (timedHolds.length) {
      const holdHours = Math.max(...timedHolds.map((r) => finitePositive(r.hold_hours, 24)));
      holdEnd = ceilToHour(new Date(at.getTime() + holdHours * HOUR_MS));
      out.holdUntil = holdEnd.toISOString();
      out.holdUntilLabel = formatWhen(holdEnd, at, tz);
      out.holdUntilPlanLabel = out.holdUntilLabel;
    } else {
      out.holdUntilLabel = DRY_LABEL;
      out.holdUntilPlanLabel = DRY_PLAN_LABEL;
    }
    const holdLabel = out.holdUntilLabel;
    if (waterInDetail) {
      out.state = 'hold_then_water_in';
      // Until-dry: counted from completion + the floor, for the deadline only.
      const base = holdEnd || new Date(at.getTime() + DRY_HOLD_FLOOR_HOURS * HOUR_MS);
      const thenBy = deadlineAfter(base, waterInDetail.byHours);
      out.waterInBy = thenBy.toISOString();
      out.waterInByLabel = formatWhen(thenBy, at, tz);
      out.expiresAt = out.waterInBy;
      out.lines = [
        `Skip your turf watering until ${holdLabel}, then water in.`,
        `After that, ${waterInDetail.verb || 'run'} ${waterInDetail.clause} within ${withinPhrase(waterInDetail.byHours)}.`,
        ANY_DAY_LINE,
      ];
    } else {
      out.state = 'hold';
      out.expiresAt = (holdEnd || endOfDay(at, tz)).toISOString();
      out.lines = [`Skip your turf watering until ${holdLabel}.`, HOLD_SECOND_LINE];
      if (hasWeekPlan) out.lines.push(PLAN_LINE);
    }
    return out;
  }

  const by = deadlineAfter(at, waterInDetail.byHours);
  out.state = 'water_in';
  out.waterInBy = by.toISOString();
  out.expiresAt = out.waterInBy;
  out.waterInByLabel = formatWhen(by, at, tz);
  out.lines = [
    `Water in today’s treatment by ${formatWhen(by, at, tz)}.`,
    `${waterInDetail.verb === 'apply' ? 'Apply' : 'Run'} ${waterInDetail.clause}.`,
    ANY_DAY_LINE,
  ];
  return out;
}

module.exports = {
  buildWateringInstruction,
  GENERIC_MINUTES_PER_QUARTER_INCH,
  _private: { ceilToHour, floorToHour, formatWhen, minutesFor, deadlineAfter, endOfDay },
};
