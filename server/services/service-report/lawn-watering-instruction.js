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
//   state 'hold_then_water_in' hold, then water in
//   state 'none'               every product resolved, none asks for anything
//   state null                 no claim (fail closed: existing aftercare stays)
//
// Mixed-visit rules, in order:
//   A. any applied product with no rule -> no claim; no other product may
//      force a direction over it.
//   B. until-dry + timed hold -> ONE hold keeping both conditions (the clock
//      time, and not before the treatment has dried).
//   C. hold + water-in -> the water-in deadline is always completion + the
//      rule's window (never re-anchored to the hold end). A hold that reaches
//      it cannot be satisfied together with the water-in -> no claim, for
//      review; otherwise hold then water in. Hold end = completion + longest
//      timed hold rounded UP to the clock hour in ET.
//
// Minutes ladder for a water-in (NEVER assumes there is no sprinkler system):
//   1. customer's measured rate (typed inches per week + run minutes + days
//      + one turf head type, via @waves/irrigation-runtime)
//   2. one turf head type on file      -> owner head table (spray 15, rotor 40
//      minutes per quarter inch)
//   3. both head types / nothing on file -> both generic figures
//   4. a head type on file but unusable (drip only, unrecognised) -> "one full
//      cycle"
// No flag ever means "no system": irrigation_system false is a legacy default
// and every other reader treats it as "do not count the schedule", so it (and
// true) are ignored here.
// Generic copy prints minutes only, never "about a quarter inch": at the UF
// rates the runtime uses those minutes are really 0.33-0.38 inch.
//
// Copy rules: no rain probability, no county/ordinance, no re-entry or drying
// figures, and never "keep ... off", "stay off", "wait" or "dry" beside an
// hours or minutes figure (the banned re-entry pattern). Water-in copy is
// allowed on a non-permitted county day and says so.

const { resolveApplicationRate, normalizeRuntimeInputs } = require('@waves/irrigation-runtime');
// ET wall-clock extraction lives in the one shared module; only the deadline
// rounding below is specific to this writer.
const { etParts, etDateString } = require('../../utils/datetime-et');

const HOUR_MS = 3600000;

// Owner table: minutes per zone for a quarter inch. Scaled linearly (rounded
// to 5) for any other rule depth.
const GENERIC_MINUTES_PER_QUARTER_INCH = Object.freeze({ spray: 15, rotor: 40 });
const BASE_INCHES = 0.25;

const HOLD_SECOND_LINE = 'That gives today’s treatment time to work.';
const PLAN_LINE = 'Then follow this week’s plan below.';
const ANY_DAY_LINE = 'Run it even if it is not your usual day.';
// A water-in shallower than the plan's per-run depth is partial credit only.
const PARTIAL_CREDIT_LINE = `${ANY_DAY_LINE} That counts toward this week’s watering.`;
// Plan-dependent sentences are NEVER part of the instruction (which is frozen
// at completion): they are composed at each render from the plan present on
// THAT render, by composeBannerLines below.
const NONE_LINE_1 = 'No watering change from today’s treatment.';
const NONE_LINE_2 = 'Follow this week’s plan below.';
// An "until dry" hold has no printed duration (fixed drying figures are
// prohibited customer copy). This floor is used ONLY as the base for the
// water-in deadline maths and is never printed.
const DRY_HOLD_FLOOR_HOURS = 6; // used only when no dry-hold rule carries hold_hours
const DRY_LABEL = 'today’s treatment has dried';
const DRY_PLAN_LABEL = 'the spray has dried';
const FULL_CYCLE = 'one full cycle on each turf zone';

// ── Time helpers ─────────────────────────────────────────────────────────
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function toDate(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
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

// "8 PM tonight" / "10 AM today" on the visit's own day, else "Wed 4 PM".
// Anchored to the (frozen) visit day, never to "now", so a permanent report
// link reads the same forever.
function formatWhen(date, anchor) {
  const at = etParts(date);
  const clock = clockLabel(at.hour, at.minute);
  const atDay = etDateString(date);
  const fromDay = etDateString(anchor);
  if (fromDay === atDay) return `${clock} ${at.hour >= 17 ? 'tonight' : 'today'}`;
  // A weekday alone is ambiguous once the target is six or more days out.
  const days = Math.round((Date.parse(`${atDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86400000);
  if (days >= 6) return `${WEEKDAYS[at.dayOfWeek]}, ${MONTHS[at.month - 1]} ${at.day} at ${clock}`;
  return `${WEEKDAYS[at.dayOfWeek]} ${clock}`;
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

function minutesFor(runtime, inches) {
  const empty = { spray: null, rotor: null, unknown: false, measured: null };
  const rt = runtime && typeof runtime === 'object' && runtime.unconfirmed !== true ? runtime : null;

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
  // A head type IS on file but names no usable turf head (drip only,
  // unrecognised): one full cycle. Anything else on file (a toggle, run
  // minutes) is not a head type.
  const onFile = heads.length > 0;
  if (onFile) {
    return { minutes: { ...empty, unknown: true }, basis: 'unknown_heads', clause: FULL_CYCLE };
  }
  // No head type on file: never assume no sprinklers. Both generic figures.
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
    holdUntilDry: false,
    waterInBy: null,
    waterInByLabel: null,
    waterInInches: null,
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
 * (Times are always America/New_York; see utils/datetime-et.js.)
 * @param {object|null} [input.runtime] { runMinutes, wateringDays, headTypes,
 *                                    explicitInchesPerWeek, unconfirmed }
 * @returns {object}
 */
function buildWateringInstruction({ rules, completedAt, runtime = null } = {}) {
  const out = emptyInstruction();
  const list = Array.isArray(rules) ? rules : [];
  const resolved = list.map(ruleOf);
  const at = toDate(completedAt);
  if (!at || !list.length) return out;

  out.products = list.map((entry, index) => {
    const rule = resolved[index];
    return { name: nameOf(entry), mode: rule ? rule.mode : null, source: rule ? (rule.source || null) : null };
  });

  // A. Any applied product with no rule: no claim, the legacy fail-closed path.
  // No other product may force a direction over a product we know nothing about.
  if (resolved.some((r) => !r)) return out;

  const holds = resolved.filter((r) => r.mode === 'hold');
  const waterIns = resolved.filter((r) => r.mode === 'water_in');
  const nones = resolved.filter((r) => r.mode === 'none');

  if (!holds.length && !waterIns.length) {
    // "None" is a positive claim: every product resolved (above) and at least
    // one of them is label or owner sourced.
    if (nones.some((r) => r.source === 'label' || r.source === 'owner')) {
      out.state = 'none';
      out.ruleSource = ruleSourceOf(nones);
      out.lines = [NONE_LINE_1];
    }
    return out;
  }

  // Each hold is timed or until-dry. The effective hold end below is used for
  // the conflict check only; only the timed end is ever printed.
  const timedHolds = holds.filter((r) => r.hold_until !== 'dry');
  const dryHolds = holds.filter((r) => r.hold_until === 'dry');
  const timedEnd = timedHolds.length
    ? ceilToHour(new Date(at.getTime() + Math.max(...timedHolds.map((r) => finitePositive(r.hold_hours, 24))) * HOUR_MS))
    : null;
  const dryHours = dryHolds.map((r) => Number(r.hold_hours)).filter((h) => Number.isFinite(h) && h > 0);
  const dryEnd = dryHolds.length
    ? new Date(at.getTime() + (dryHours.length ? Math.max(...dryHours) : DRY_HOLD_FLOOR_HOURS) * HOUR_MS)
    : null;
  const effectiveHoldEnd = [timedEnd, dryEnd].filter(Boolean).sort((x, y) => y - x)[0] || null;

  let waterInDetail = null;
  let by = null;
  if (waterIns.length) {
    const inches = Math.max(...waterIns.map((r) => finitePositive(r.water_in_inches, BASE_INCHES)));
    const byHours = Math.min(...waterIns.map((r) => finitePositive(r.water_in_by_hours, 24)));
    waterInDetail = { inches, byHours, ...minutesFor(runtime, inches) };
    // C. The deadline is ALWAYS completion + the rule's window. A hold that
    // reaches it cannot be honoured together with the water-in: no claim, for
    // review, never a manufactured later deadline.
    by = deadlineAfter(at, byHours);
    if (effectiveHoldEnd && effectiveHoldEnd.getTime() >= by.getTime()) return out;
    out.minutes = waterInDetail.minutes;
    out.waterInInches = inches;
    out.waterInBy = by.toISOString();
    out.waterInByLabel = formatWhen(by, at);
  }
  out.ruleSource = ruleSourceOf([...holds, ...waterIns]);

  if (!holds.length) {
    out.state = 'water_in';
    out.expiresAt = out.waterInBy;
    out.lines = [
      `Water in today’s treatment by ${out.waterInByLabel}.`,
      `Run ${waterInDetail.clause}.`,
      ANY_DAY_LINE,
    ];
    return out;
  }

  // B. Until-dry + timed hold is ONE hold that keeps both conditions: the
  // clock time, and not before the treatment has dried (never a number beside
  // dry/dried).
  let holdLabel;
  if (timedEnd) {
    out.holdUntil = timedEnd.toISOString();
    out.holdUntilLabel = formatWhen(timedEnd, at);
    out.holdUntilPlanLabel = out.holdUntilLabel;
    holdLabel = dryHolds.length ? `${out.holdUntilLabel}, and not before ${DRY_LABEL}` : out.holdUntilLabel;
    if (dryHolds.length) out.holdUntilDry = true;
  } else {
    out.holdUntilLabel = DRY_LABEL;
    out.holdUntilPlanLabel = DRY_PLAN_LABEL;
    out.holdUntilDry = true;
    holdLabel = DRY_LABEL;
  }
  if (waterInDetail) {
    out.state = 'hold_then_water_in';
    // A hold that waits for drying keeps the whole note live past the water-in
    // deadline: the drying condition never ends by the clock.
    out.expiresAt = dryHolds.length ? null : out.waterInBy;
    out.lines = [
      `Skip your turf watering until ${holdLabel}.`,
      `After that, water in today’s treatment by ${out.waterInByLabel}: run ${waterInDetail.clause}.`,
      ANY_DAY_LINE,
    ];
  } else {
    out.state = 'hold';
    // A hold that waits for the treatment to dry has no clock end: dryness is
    // a condition, so it never expires on a synthetic clock (the plan-week
    // scope bounds it). A purely timed hold ends at its clock time.
    out.expiresAt = timedEnd && !dryHolds.length ? timedEnd.toISOString() : null;
    out.lines = [`Skip your turf watering until ${holdLabel}.`, HOLD_SECOND_LINE];
  }
  return out;
}

/**
 * The banner's lines for THIS render: the frozen treatment-specific lines plus
 * the plan-dependent sentence, judged on the weekly plan present now.
 *   hold / none    -> "follow this week's plan" when a plan renders below
 *   water_in       -> the any-day sentence becomes "... That counts toward this
 *                     week's watering." when the water-in is shallower than the
 *                     plan's run (no credit for a full run)
 * @param {object} instruction  buildWateringInstruction result (frozen or fresh)
 * @param {{hasWeekPlan?: boolean, planRunInches?: number|null}} [plan]
 */
function composeBannerLines(instruction, { hasWeekPlan = false, planRunInches = null } = {}) {
  const lines = Array.isArray(instruction?.lines) ? instruction.lines.slice() : [];
  if (!lines.length || !hasWeekPlan) return lines;
  if (instruction.state === 'hold') lines.push(PLAN_LINE);
  else if (instruction.state === 'none') lines.push(NONE_LINE_2);
  else if (planRunInches != null && Number.isFinite(Number(planRunInches))
    && Number(instruction.waterInInches) < Number(planRunInches) - 0.001
    && lines[lines.length - 1] === ANY_DAY_LINE) lines[lines.length - 1] = PARTIAL_CREDIT_LINE;
  return lines;
}

const ACTIONABLE_STATES = ['hold', 'water_in', 'hold_then_water_in'];

// The ONE clock reading of a frozen instruction, for every live consumer
// (aftercare verdict, hero task, assistant): 'hold' | 'water_in' | 'ended',
// or null when the instruction asks for nothing.
//   - past expiresAt: 'ended' (history; wording kept as a record)
//   - hold_then_water_in: 'hold' until a TIMED hold's clock end, then
//     'water_in'; a hold that also waits for the treatment to dry (or waits
//     only for that) has no clock release and stays 'hold' until expiry
//   - an until-dry-only hold has no expiresAt and never ends by the clock
function instructionPhaseAt(instruction, nowMs = Date.now()) {
  if (!instruction || !ACTIONABLE_STATES.includes(instruction.state)) return null;
  if (!Array.isArray(instruction.lines) || instruction.lines.length < 2) return null;
  const expiresMs = instruction.expiresAt ? Date.parse(instruction.expiresAt) : NaN;
  if (Number.isFinite(expiresMs) && nowMs > expiresMs) return 'ended';
  if (instruction.state !== 'hold_then_water_in') return instruction.state;
  const holdEndMs = instruction.holdUntil ? Date.parse(instruction.holdUntil) : NaN;
  if (instruction.holdUntilDry !== true && Number.isFinite(holdEndMs) && nowMs >= holdEndMs) return 'water_in';
  return 'hold';
}

module.exports = {
  buildWateringInstruction,
  instructionPhaseAt,
  composeBannerLines,
  GENERIC_MINUTES_PER_QUARTER_INCH,
  _private: { ceilToHour, floorToHour, formatWhen, minutesFor, deadlineAfter },
};
