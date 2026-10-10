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
//   C. hold + water-in -> hold, then water in. The water-in deadline is
//      completion + the rule's window while the hold ends before it. When a
//      TIMED hold reaches that deadline (owner 2026-10-09: every post-emergent
//      herbicide holds 24 hours, and the pre-emergents it rides with water in
//      within 24), the water-in follows the hold: the deadline is re-anchored
//      to the printed hold end + the window ("Skip ... until Sat 10 AM. After
//      that, water in ... by Sun 10 AM"). An until-dry hold with no recorded
//      hours has no printed end, so its synthetic floor never anchors a
//      deadline: a window it reaches is still no claim, for review. Hold end
//      = completion + longest timed hold rounded UP to the clock hour in ET.
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
// For the "generic" basis only (step 3, no head type on file): the rule-of-thumb
// figures are not the customer's system, so a completion built with
// `plainWhenNoSetup` states the AMOUNT and no minutes ("with about ½ inch by
// ..."), and records instruction.amountOnly (owner 2026-10-08, permanent and
// ungated since 2026-10-09: minutes only when the customer's portal setup gives
// them). The caller passes it at completion (the instruction is then FROZEN);
// an unfrozen re-render passes nothing. This module reads no gate.
//
// Mowing is a SEPARATE result (instruction.mowHold, never part of `lines`: the
// watering text sends `lines` verbatim). It exists only when an applied product
// carries a LABEL-SOURCED mow_hold_days (integer 1..14); the longest hold wins.
// It never depends on the watering state (a visit whose watering is unknown can
// still carry its mow line), and nothing about mowing is ever defaulted or
// derived.
//
// Copy rules: no rain probability, no county/ordinance, no re-entry or drying
// figures, and never "keep ... off", "stay off", "wait" or "dry" beside an
// hours or minutes figure (the banned re-entry pattern). Water-in copy is
// allowed on a non-permitted county day and says so.

const { resolveApplicationRate, normalizeRuntimeInputs, OWNER_MINUTES_PER_QUARTER_INCH } = require('@waves/irrigation-runtime');
// ET wall-clock extraction lives in the one shared module; only the deadline
// rounding below is specific to this writer.
const { etParts, etDateString, parseETDateTime } = require('../../utils/datetime-et');

const HOUR_MS = 3600000;
// Latest ET wall time a same-day water-in deadline may print ("11 PM tonight"),
// and the least time it must leave after completion: a full cycle of several
// rotor zones at about 40 minutes each.
const SAME_DAY_CUTOFF = '23:00';
const SAME_DAY_MIN_LEAD_MS = 3 * HOUR_MS;

// Owner table: minutes per zone for a quarter inch. Scaled linearly (rounded
// to 5) for any other rule depth.
// One table, in the irrigation package: the lawn report's card derives weekly inches from the same constant.
const GENERIC_MINUTES_PER_QUARTER_INCH = OWNER_MINUTES_PER_QUARTER_INCH;
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
// The live banner's invitation under an amount-only water-in (banner.setupLine).
// Never part of `lines`: the PDF, the watering text and Ask Waves do not carry it.
const SETUP_INVITE_LINE = 'Add your sprinkler setup and we’ll give you minutes for each zone.';

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

// "¼ inch", "½ inch", "0.27 inch", "1 inch", "1.5 inches": exact quarter
// fractions in words, otherwise up to two decimals. Singular up to one inch.
function formatInches(value) {
  const n = Math.round(Number(value) * 100) / 100;
  if (!Number.isFinite(n) || n <= 0) return null;
  const quarters = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
  const text = quarters[n] || String(n);
  return `${text} ${n <= 1 ? 'inch' : 'inches'}`;
}

// ── Mow hold ─────────────────────────────────────────────────────────────
const MOW_HOLD_MIN_DAYS = 1;
const MOW_HOLD_MAX_DAYS = 14;

// A label mow hold is a whole number of days, 1..14. Anything else (null,
// strings, fractions, out of range) is "the label says nothing": no claim.
function normalizeMowHoldDays(value) {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= MOW_HOLD_MIN_DAYS && value <= MOW_HOLD_MAX_DAYS ? value : null;
}

function mowHoldLine(untilLabel, days) {
  return `Mowing: hold off until ${untilLabel}, ${days} ${days === 1 ? 'day' : 'days'} after today's treatment.`;
}

// The longest valid label hold across the applied products. A label day is 24
// elapsed hours from the visit ("postpone mowing for 24 hours"), so the end is
// completion + days * 24 h, rounded UP to the hour (rounding down would let the
// customer mow before the label interval ends), and the line names that clock
// time ("Fri 4 PM"), never a bare weekday that reads as "any time Friday".
function buildMowHold(entries, completedAt) {
  const at = toDate(completedAt);
  if (!at) return null;
  const days = (Array.isArray(entries) ? entries : [])
    .map((entry) => normalizeMowHoldDays(entry && typeof entry === 'object' ? entry.mowHoldDays : null))
    .filter((d) => d != null);
  if (!days.length) return null;
  const longest = Math.max(...days);
  const until = ceilToHour(new Date(at.getTime() + longest * 24 * HOUR_MS));
  const untilLabel = formatWhen(until, at);
  return {
    days: longest,
    untilAt: until.toISOString(),
    untilDate: etDateString(until),
    untilLabel,
    line: mowHoldLine(untilLabel, longest),
  };
}

// Shape check for a frozen mowHold read back from structured_notes: anything
// else is ignored (no claim), never repaired.
function isValidMowHold(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && normalizeMowHoldDays(value.days) != null
    && typeof value.untilDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.untilDate)
    // untilAt arrived after the first shape: a record frozen without it replays
    // as written (record, not clock); when present it must parse.
    && (value.untilAt === undefined || (typeof value.untilAt === 'string' && Number.isFinite(Date.parse(value.untilAt))))
    && typeof value.untilLabel === 'string' && value.untilLabel.length > 0
    && typeof value.line === 'string' && value.line.length > 0;
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

function minutesFor(runtime, inches, plainWhenNoSetup = false) {
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
  // No head type on file: never assume no sprinklers. The amount alone when the
  // caller is a completion build (plainWhenNoSetup); both generic figures on an
  // unfrozen re-render.
  if (plainWhenNoSetup) {
    return { minutes: { ...empty }, basis: 'generic', clause: null, amountOnly: true, amount: formatInches(inches) };
  }
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
    completedAt: null,
    waterInBy: null,
    waterInByLabel: null,
    waterInInches: null,
    minutes: { spray: null, rotor: null, unknown: false, measured: null },
    lines: [],
    ruleSource: null,
    products: [],
    mowHold: null,
  };
}

/**
 * @param {object} input
 * @param {Array}  input.rules        per applied product: a rule object, null,
 *                                    or { name, rule, mowHoldDays }
 * @param {Date|string|null} input.completedAt
 * (Times are always America/New_York; see utils/datetime-et.js.)
 * @param {object|null} [input.runtime] { runMinutes, wateringDays, headTypes,
 *                                    explicitInchesPerWeek, unconfirmed }
 * @returns {object}
 */
// The water-in deadline, or null when no honest one exists.
// C. Completion + the rule's window while the hold ends before it. A hold that
// reaches it: when the effective hold end is a TIMED end (a printed clock
// time), the water-in follows the hold and the deadline becomes that hold end
// + the window (owner 2026-10-09). When the effective end is the until-dry
// floor (synthetic, never printed) the pair cannot be honoured together: no
// claim, for review, never a deadline anchored to an invented figure. A
// same-day rule (label: water in "the same day") also caps it at
// SAME_DAY_CUTOFF on the completion's ET day, and when the later of completion
// and the hold's end leaves less than SAME_DAY_MIN_LEAD before the cutoff, the
// watering run cannot fit: no claim, never a next-day or impossible deadline
// (so a 24-hour hold beside Dylox stays no claim).
function waterInDeadline(at, waterIns, byHours, holdEnd, timedEnd = null) {
  let by = deadlineAfter(at, byHours);
  if (holdEnd && holdEnd.getTime() >= by.getTime()) {
    if (!timedEnd || timedEnd.getTime() < holdEnd.getTime()) return null;
    by = deadlineAfter(timedEnd, byHours);
  }
  if (!waterIns.some((r) => r.water_in_same_day === true)) return by;
  // The run can start only once completion AND any hold are behind it.
  const start = Math.max(at.getTime(), holdEnd ? holdEnd.getTime() : 0);
  const cutoff = parseETDateTime(`${etDateString(at)}T${SAME_DAY_CUTOFF}`);
  if (cutoff.getTime() - start < SAME_DAY_MIN_LEAD_MS) return null;
  if (cutoff.getTime() < by.getTime()) by = cutoff;
  return by;
}

// The water-in half of the instruction: amount, deadline and minutes. Fills the
// water-in fields of `out` and returns the detail the lines are written from,
// or null when no honest deadline exists (C. see waterInDeadline).
function applyWaterIn(out, { waterIns, runtime, plainWhenNoSetup, at, holdEnd, timedEnd }) {
  const inches = Math.max(...waterIns.map((r) => finitePositive(r.water_in_inches, BASE_INCHES)));
  const byHours = Math.min(...waterIns.map((r) => finitePositive(r.water_in_by_hours, 24)));
  const detail = { inches, byHours, ...minutesFor(runtime, inches, plainWhenNoSetup) };
  const by = waterInDeadline(at, waterIns, byHours, holdEnd, timedEnd);
  if (!by) return null;
  out.minutes = detail.minutes;
  out.waterInInches = inches;
  out.waterInBy = by.toISOString();
  out.waterInByLabel = formatWhen(by, at);
  if (detail.amountOnly) out.amountOnly = true;
  return detail;
}

// The water-in sentences. Minutes: "by <when>" then "Run <clause>" (one line after
// a hold). Amount only (no sprinkler setup on file): "with about ½ inch by <when>".
function waterInLines(detail, whenLabel, afterHold) {
  const lead = afterHold ? 'After that, water in' : 'Water in';
  if (detail.amountOnly) return [`${lead} today’s treatment with about ${detail.amount} by ${whenLabel}.`];
  return afterHold
    ? [`${lead} today’s treatment by ${whenLabel}: run ${detail.clause}.`]
    : [`${lead} today’s treatment by ${whenLabel}.`, `Run ${detail.clause}.`];
}

function buildWateringInstruction({ rules, completedAt, runtime = null, plainWhenNoSetup } = {}) {
  const out = emptyInstruction();
  const list = Array.isArray(rules) ? rules : [];
  const resolved = list.map(ruleOf);
  const at = toDate(completedAt);
  if (!at || !list.length) return out;
  // The visit's completion instant the lines are anchored to ("today",
  // "tonight"): the watering text checks freshness against it.
  out.completedAt = at.toISOString();

  out.products = list.map((entry, index) => {
    const rule = resolved[index];
    return { name: nameOf(entry), mode: rule ? rule.mode : null, source: rule ? (rule.source || null) : null };
  });

  // The mow hold is decided before any watering early return below.
  out.mowHold = buildMowHold(list, at);

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

  // Each hold is timed or until-dry. An until-dry rule's EXPLICIT hold_hours
  // is a recorded minimum, so it counts as a timed hold too (printed as a
  // clock time beside the drying condition). The synthetic six-hour floor is
  // for the conflict check only and is never printed.
  const dryHolds = holds.filter((r) => r.hold_until === 'dry');
  const dryHours = dryHolds.map((r) => Number(r.hold_hours)).filter((h) => Number.isFinite(h) && h > 0);
  const timedHours = [
    ...holds.filter((r) => r.hold_until !== 'dry').map((r) => finitePositive(r.hold_hours, 24)),
    ...dryHours,
  ];
  const timedEnd = timedHours.length
    ? ceilToHour(new Date(at.getTime() + Math.max(...timedHours) * HOUR_MS))
    : null;
  const dryEnd = dryHolds.length && !dryHours.length
    ? new Date(at.getTime() + DRY_HOLD_FLOOR_HOURS * HOUR_MS)
    : null;
  const effectiveHoldEnd = [timedEnd, dryEnd].filter(Boolean).sort((x, y) => y - x)[0] || null;

  let waterInDetail = null;
  if (waterIns.length) {
    waterInDetail = applyWaterIn(out, { waterIns, runtime, plainWhenNoSetup, at, holdEnd: effectiveHoldEnd, timedEnd });
    if (!waterInDetail) return out;
  }
  out.ruleSource = ruleSourceOf([...holds, ...waterIns]);

  if (!holds.length) {
    out.state = 'water_in';
    out.expiresAt = out.waterInBy;
    out.lines = [...waterInLines(waterInDetail, out.waterInByLabel, false), ANY_DAY_LINE];
    return out;
  }

  // B. Until-dry + timed hold is ONE hold that keeps both conditions: the
  // clock time, and not before the treatment has dried (never a number beside
  // dry/dried).
  let holdLabel;
  if (timedEnd) {
    out.holdUntil = timedEnd.toISOString();
    out.holdUntilLabel = formatWhen(timedEnd, at);
    // The plan overlay ("Not before …:") keeps the drying condition too, or
    // the plan card would release a run at the clock time on a wet treatment.
    out.holdUntilPlanLabel = dryHolds.length ? `${out.holdUntilLabel} and ${DRY_PLAN_LABEL}` : out.holdUntilLabel;
    holdLabel = dryHolds.length ? `${out.holdUntilLabel}, and not before ${DRY_LABEL}` : out.holdUntilLabel;
  } else {
    out.holdUntilLabel = DRY_LABEL;
    out.holdUntilPlanLabel = DRY_PLAN_LABEL;
    holdLabel = DRY_LABEL;
  }
  if (waterInDetail) {
    out.state = 'hold_then_water_in';
    // A hold that waits for drying keeps the whole note live past the water-in
    // deadline: the drying condition never ends by the clock.
    out.expiresAt = dryHolds.length ? null : out.waterInBy;
    out.lines = [
      `Skip your turf watering until ${holdLabel}.`,
      ...waterInLines(waterInDetail, out.waterInByLabel, true),
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

/**
 * GATE_LAWN_WATER_IN_RAIN, read time only: a water-in frozen with BOTH generic figures ("spray heads about 30 minutes a zone
 * and rotors about 80 minutes": no head type was on file) says the amount first, then the same two figures:
 * "...by Sat 9 AM: about ½ inch — around 30 minutes on spray heads or 80 on rotors." The minutes are the ones the
 * instruction was frozen with (one rate table, minutesFor); nothing is recomputed. Anything else comes back as the very same
 * object: a head type or a measured rate on file (one figure), mixed heads on file, an amount-only instruction (owner
 * 2026-10-08: minutes only when the customer's setup gives them), a hold-only or none instruction, or lines that are not
 * the generic ones (an older record).
 */
function withAmountLine(instruction) {
  if (!instruction || typeof instruction !== 'object' || !Array.isArray(instruction.lines)) return instruction;
  if (!['water_in', 'hold_then_water_in'].includes(instruction.state) || instruction.amountOnly === true) return instruction;
  const m = instruction.minutes;
  const spray = m && Number(m.spray);
  const rotor = m && Number(m.rotor);
  if (!m || m.measured != null || m.unknown === true || !Number.isFinite(spray) || !Number.isFinite(rotor) || spray <= 0 || rotor <= 0) return instruction;
  const amount = formatInches(instruction.waterInInches);
  if (!amount) return instruction;
  const clause = `spray heads about ${spray} minutes a zone and rotors about ${rotor} minutes`;
  const tail = `about ${amount} — around ${spray} minutes on spray heads or ${rotor} on rotors.`;
  const lines = instruction.lines.slice();
  const afterHold = lines.findIndex((line) => typeof line === 'string' && line.startsWith('After that, water in today’s treatment by ') && line.endsWith(`: run ${clause}.`));
  if (afterHold >= 0) {
    lines[afterHold] = `${lines[afterHold].slice(0, -`run ${clause}.`.length)}${tail}`;
    return { ...instruction, lines };
  }
  const runAt = lines.findIndex((line) => line === `Run ${clause}.`);
  if (runAt < 1 || !(typeof lines[runAt - 1] === 'string' && lines[runAt - 1].startsWith('Water in today’s treatment by ') && lines[runAt - 1].endsWith('.'))) return instruction;
  lines[runAt - 1] = `${lines[runAt - 1].slice(0, -1)}: ${tail}`;
  lines.splice(runAt, 1);
  return { ...instruction, lines };
}

module.exports = {
  buildWateringInstruction,
  composeBannerLines,
  withAmountLine,
  formatInches,
  SETUP_INVITE_LINE,
  normalizeMowHoldDays,
  isValidMowHold,
  GENERIC_MINUTES_PER_QUARTER_INCH,
  _private: { ceilToHour, floorToHour, formatWhen, minutesFor, deadlineAfter, buildMowHold },
};
