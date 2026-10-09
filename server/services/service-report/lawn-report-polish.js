'use strict';

/**
 * GATE_LAWN_REPORT_POLISH (owner 2026-10-09): the lawn report's Water card gets a THIRD state, kept apart from
 * the builders it corrects so they gain no decisions. The gate is read here, at call time, and only ever for a
 * lawn report.
 *
 *   A  inches known   explicit weekly inches, or a figure derived from ONE turf head type (drip ignored) with
 *                     the owner's rate table: the card prints the inches; a derived figure also prints its basis
 *   B  schedule on file, no inches   run minutes and/or watering days on file, but no weekly inches and none can
 *                     be honestly derived (mixed head types, drip only, a missing piece, an implausible total):
 *                     the Irrigation row prints what IS on file ("45 min, Mondays"), the confidence line says weekly
 *                     inches are not on file, no Total prints, and the call to action asks for the weekly inches
 *   C  nothing on file  today's card ("Not on file", the schedule call to action), unchanged
 *
 * profileMissing stays TRUE in B and C: the water balance, the status pill, the weekly plan, Ask Waves and the
 * weekly email never compute from a guess. Only the card's presentation changes (water.scheduleKind and friends).
 *
 * ONE rate table: the watering banner's (spray 15 min, rotor 40 min per quarter inch), exported by
 * @waves/irrigation-runtime as OWNER_HEAD_RATE_IN_PER_HR. The portal preview, the weekly email and the schedule
 * move guard keep the package's own default table and rules; this module is the only caller that opts in.
 *
 * Gate off: every export returns the old behaviour or nothing, so the payload, render and PDF are byte-identical.
 * Pure. No database read, no model call.
 */

const featureGates = require('../../config/feature-gates');
const {
  deriveIrrigationInchesPerWeek,
  describeRuntimeBasis,
  normalizeRuntimeInputs,
  OWNER_HEAD_RATE_IN_PER_HR,
} = require('@waves/irrigation-runtime');

// A partial feature-gates mock (a test) means off, never a crash in a report build.
function polishLive() {
  return typeof featureGates.lawnReportPolishLive === 'function' && featureGates.lawnReportPolishLive();
}

/** The PDF cache-key part: moves the key only while the gate is live. */
function polishPdfStamp() {
  return polishLive() ? ':polish=1' : '';
}

/** The payload key the page reads (status card, hero): only for a lawn report that has a reportV2. */
function lawnPolishPayload({ serviceLine, reportV2 } = {}) {
  return serviceLine === 'lawn' && reportV2 && polishLive() ? { lawnPolish: true } : {};
}

const numberOrNull = (value) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const DERIVE_OPTIONS = Object.freeze({ rates: OWNER_HEAD_RATE_IN_PER_HR, ignoreDrip: true });

function deriveForReport(prefs) {
  return deriveIrrigationInchesPerWeek({
    runMinutes: prefs.irrigation_run_minutes,
    wateringDays: prefs.watering_days,
    systemType: prefs.irrigation_system_type,
  }, DERIVE_OPTIONS);
}

/**
 * The customer's portal irrigation figure for the lawn report: explicit weekly inches, else the figure derived from
 * minutes x days with ONE turf head type (drip ignored) on the owner's table. Same precedence and toggle rule as
 * report-data.js portalIrrigationInches, which the report keeps while the gate is off.
 * @returns {number|null}
 */
function polishPrefsInches(propertyPrefs) {
  if (!propertyPrefs) return null;
  const explicit = numberOrNull(propertyPrefs.irrigation_inches_per_week);
  if (explicit != null && explicit > 0) return explicit;
  if (propertyPrefs.irrigation_system === false) return null;
  return deriveForReport(propertyPrefs).inchesPerWeek;
}

/** The prefs figure the report reads: the polish rules while the gate is live, else the report's own resolver. */
function prefsInchesFor(propertyPrefs, standardResolver) {
  return polishLive() ? polishPrefsInches(propertyPrefs) : standardResolver(propertyPrefs);
}

// ── What is on file, in plain words ─────────────────────────────────────────
const DAY_WORDS = Object.freeze({
  Mon: 'Mondays', Tue: 'Tuesdays', Wed: 'Wednesdays', Thu: 'Thursdays', Fri: 'Fridays', Sat: 'Saturdays', Sun: 'Sundays',
});

function joinWords(words) {
  if (words.length <= 1) return words[0] || '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * "45 min, Mondays" from the stored run minutes and watering days. Only the part that is on file prints
 * ("45 min", "Mondays"); all seven days read "every day". null when neither part is on file.
 */
function describeScheduleOnFile(propertyPrefs) {
  if (!propertyPrefs) return null;
  const inputs = normalizeRuntimeInputs({
    runMinutes: propertyPrefs.irrigation_run_minutes,
    wateringDays: propertyPrefs.watering_days,
    systemType: propertyPrefs.irrigation_system_type,
  });
  const days = inputs.wateringDays.length === 7 ? 'every day' : joinWords(inputs.wateringDays.map((day) => DAY_WORDS[day]));
  const parts = [inputs.runMinutes != null ? `${inputs.runMinutes} min` : null, days || null].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

const formatInches = (value) => Number(value).toFixed(2).replace(/\.?0+$/, '');

/**
 * The basis line for a DERIVED figure, the portal's own sentence (PortalPage.jsx derivedIrrigationLine) with the
 * attribution to the owner's typical head rates: 'About 0.75" a week from 45 minutes per zone, 1 day a week on
 * rotor heads — typical head rates.' null unless the figure was derived from the customer's minutes and days.
 */
function derivedBasisLine(propertyPrefs) {
  const explicit = numberOrNull(propertyPrefs && propertyPrefs.irrigation_inches_per_week);
  if (!propertyPrefs || (explicit != null && explicit > 0) || propertyPrefs.irrigation_system === false) return null;
  const derived = deriveForReport(propertyPrefs);
  if (derived.inchesPerWeek == null) return null;
  return `About ${formatInches(derived.inchesPerWeek)}" a week from ${describeRuntimeBasis(derived)} — typical head rates.`;
}

// The Ask Waves explanation for state B (the card hides it; only the assistant reads it).
function scheduleOnFileExplanation(scheduleText, target) {
  const t = target != null ? `about ${target}"/wk` : 'the seasonal target';
  return `We have your sprinkler schedule on file (${scheduleText}), but not your weekly inches, so we can’t weigh this week’s water against ${t}.`;
}

/**
 * The extras buildLawnWaterContext adds to its result while the gate is live:
 *   scheduleKind  'inches' (A) | 'runtime_only' (B) | 'none' (C)
 *   scheduleText  B only: what is on file ("45 min, Mondays")
 *   irrigationBasis  A only, and only for a figure derived from minutes and days
 * `inchesKnown` is the final verdict of the advice engine (profileMissing === false); `fromPrefs` says the figure
 * the report used came from the portal entry (explicit or derived), not a turf or assessment reading.
 */
function polishWaterContext({ propertyPrefs, scheduleUnconfirmed, profileMissing, fromPrefs }) {
  if (!polishLive()) return {};
  if (!profileMissing) {
    const basis = fromPrefs && !scheduleUnconfirmed ? derivedBasisLine(propertyPrefs) : null;
    return { scheduleKind: 'inches', ...(basis ? { irrigationBasis: basis } : {}) };
  }
  const onFile = !scheduleUnconfirmed && propertyPrefs && propertyPrefs.irrigation_system !== false
    ? describeScheduleOnFile(propertyPrefs) : null;
  return onFile ? { scheduleKind: 'runtime_only', scheduleText: onFile } : { scheduleKind: 'none' };
}

/**
 * The water payload fields the report copies from the context (a spread in mapWater, both paths). The card's state
 * follows the figure the card itself prints: with inches on the card (`scheduleOnFile`) it is A (the basis line only
 * on the live path, where the figure is the portal's); without them, B when the context found a schedule on file,
 * else C. State B also replaces the explanation (it said "we don't have your irrigation schedule on file yet").
 * Nothing while the gate is off (the context carries no polish key).
 */
function waterPolishFields(waterContext, { target = null, scheduleOnFile = false, live = true } = {}) {
  if (!waterContext || !waterContext.scheduleKind) return {};
  if (scheduleOnFile) {
    return { scheduleKind: 'inches', ...(live && waterContext.irrigationBasis ? { irrigationBasis: waterContext.irrigationBasis } : {}) };
  }
  if (waterContext.scheduleKind !== 'runtime_only') return { scheduleKind: 'none' };
  return {
    scheduleKind: 'runtime_only',
    scheduleText: waterContext.scheduleText,
    explanation: scheduleOnFileExplanation(waterContext.scheduleText, target),
  };
}

module.exports = {
  polishLive,
  polishPdfStamp,
  lawnPolishPayload,
  polishPrefsInches,
  prefsInchesFor,
  describeScheduleOnFile,
  derivedBasisLine,
  polishWaterContext,
  waterPolishFields,
  scheduleOnFileExplanation,
};
