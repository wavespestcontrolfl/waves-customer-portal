'use strict';

/**
 * GATE_LAWN_WATER_RAIN: the lawn report's "rain card" (owner 2026-10-09; advisor sections A.3 R1-R5 and A.4,
 * ~/lawn-program-scope-20261001/fable-advice-20261009-rain-carryover.md). The Water This Week card is honest after rain:
 *
 *   R1  the card STATUS counts each day's rain at most EVENT_DEPTH_MAX_INCHES (the package's per-event depth), summed over
 *       the card's 7 days. The Rain row still shows the measured total; the capped figure is never shown. Only a weekly
 *       total (no complete 7-day daily series) means NO cap: the split is never guessed.
 *   R2  no look-back beyond the 7 days; the Monday plan's 0.5 inch carry is not touched.
 *   R3  new status "rain_covered": the week's measured rain alone is at least the week's target, with or without a
 *       sprinkler schedule on file. One fixed sentence says to leave the sprinklers off until the wilt signs show.
 *   R5  the deficit and surplus card sentences are replaced (the amount per run stays fixed: no "add minutes to each run").
 *   A.4 once, in a rain-covered week only, when the rain sensor field is not true: the Florida rain shutoff line.
 *
 * ALL of it is suppressed (today's card, byte for byte) unless the record's frozen decision allows it
 * (lawnReportFacts.waterAdvice version 2: new sod rooted, schedule confirmed after a move, decided once at completion),
 * and, at render, when the visit carries a post-treatment hold / water-in instruction or the schedule is withheld.
 *
 * Pure: no gate read (the freeze reads lawnWaterRainFreezeLive; a render reads the record), no database, no clock.
 */

const { WEEK_PLAN_CONSTANTS } = require('@waves/irrigation-runtime');
const { balanceOf } = require('./irrigation-advice');
const { instructionCarriesWatering, sodIsEstablished } = require('./lawn-longer-cycles');
const { scheduleUnconfirmedAfterMove, rainSensorConfirmedAfterMove } = require('../irrigation-schedule-confirmation');
const COPY = require('../../../shared/lawn-water-rain-copy.json');
const { wiltSigns: WILT_SIGNS } = require('../../../shared/watering-copy.json');

// The most one watering (or one wet day) can usefully put into sandy soil: UF/IFAS LH025, 1/2 to 3/4 inch.
const MAX_INCHES_PER_DAY = WEEK_PLAN_CONSTANTS.EVENT_DEPTH_MAX_INCHES;
const WINDOW_DAYS = 7;

const finite = (value) => (value == null || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null));
const round2 = (value) => Math.round(value * 100) / 100;

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => values[key]);

// The deficit advice alone (the insight card says it too, so the card and the insight never differ).
const deficitAction = () => fill(COPY.deficitAction, { wiltSigns: WILT_SIGNS });

/**
 * R1. The rain the card STATUS counts: the measured total less, for each day, the part above MAX_INCHES_PER_DAY.
 * The weekly total stays the base, so a total from another source than the daily series is not re-derived.
 * No complete 7-day series (null, short, or a day without a number) = NO cap: the total comes back as it is, because a
 * split of a weekly total would be a guess. Never displayed.
 */
function effectiveRainInches(rainTotal, dailyRain) {
  const total = finite(rainTotal);
  if (total == null) return null;
  if (!Array.isArray(dailyRain) || dailyRain.length !== WINDOW_DAYS) return total;
  const days = dailyRain.map((day) => finite(day && day.inches));
  if (days.some((inches) => inches == null || inches < 0)) return total;
  const excess = days.reduce((sum, inches) => sum + Math.max(0, inches - MAX_INCHES_PER_DAY), 0);
  return Math.max(0, round2(total - excess));
}

/**
 * Whether the rain card may change this card at all: the record froze permission at completion (rainAdvice.rainCard),
 * the schedule is not withheld after a move, and the visit carries no hold / water-in instruction.
 */
function rainCardAllowed({ rainAdvice, waterContext, instruction, aftercare }) {
  return !!(rainAdvice && rainAdvice.rainCard === true && waterContext && !waterContext.scheduleUnconfirmed
    && !instructionCarriesWatering(instruction, aftercare));
}

/**
 * R1 on the report's water context: the advice (status, applied, differential) is recounted with the capped rain, with
 * the engine's own rule (balanceOf). Same object back when nothing changes (no schedule, no rain, no excess).
 */
function withCappedAdvice(waterContext) {
  const advice = waterContext.irrigationAdvice;
  if (!advice || advice.profileMissing || !advice.rainKnown) return waterContext;
  const effective = effectiveRainInches(waterContext.rainfallInches7d, waterContext.dailyRain7d);
  if (effective == null || effective === finite(waterContext.rainfallInches7d)) return waterContext;
  const balance = balanceOf({
    recommended: advice.recommendedInchesPerWeek,
    irrigation: finite(waterContext.irrigationInchesPerWeek),
    rain: effective,
    rainKnown: true,
  });
  return { ...waterContext, irrigationAdvice: { ...advice, ...balance } };
}

/**
 * The lawn assessment with the rain card's water context (the capped advice), or the very same object when the cap
 * changes nothing (so everything downstream is untouched). The caller has already checked rainCardAllowed.
 */
function withCappedRain(lawnAssessment) {
  const waterContext = lawnAssessment && lawnAssessment.waterContext;
  if (!waterContext) return lawnAssessment;
  const capped = withCappedAdvice(waterContext);
  return capped === waterContext ? lawnAssessment : { ...lawnAssessment, waterContext: capped };
}

/**
 * R3 / R5 / A.4 on the mapped water card (mutates `water`; nothing when the card may not change). `targetLabel` is the
 * target as the card formats it today ('about 1.25"/wk', '~1.25"/wk' on the snapshot path, or 'the seasonal target'),
 * `prefix` the snapshot path's lead sentence ('' on the live path). The measured rain (water.rainInches) decides
 * "covered"; the status of every other week is the one the engine (with the capped rain) gave.
 */
function applyRainCard(water, { rainAdvice, allowed, targetLabel, prefix = '' }) {
  if (!water || !allowed) return water;
  const rain = finite(water.rainInches);
  const target = finite(water.targetInches);
  const values = { wiltSigns: WILT_SIGNS, target: targetLabel };
  if (rain != null && target != null && target > 0 && rain >= target) {
    Object.assign(water, {
      status: 'rain_covered',
      explanation: fill(COPY.covered, values),
      rainCard: true,
      ...(rainAdvice.sensorLine === true ? { rainSensorLine: true } : {}),
    });
  } else if (water.status === 'low') {
    Object.assign(water, { explanation: `${prefix}${fill(COPY.deficitLead, values)} ${deficitAction()}`, rainCard: true });
  } else if (water.status === 'high') {
    Object.assign(water, { explanation: `${prefix}${COPY.surplus}`, rainCard: true });
  }
  return water;
}

/** The status the diagnosis, root cause and insights read: the card's own when it is "rain covered", else `base`. */
function waterStatusFor(water, base) {
  return water && water.status === 'rain_covered' ? 'rain_covered' : base;
}

// ── The decision frozen at completion (lawnReportFacts.waterAdvice, version 2) ───────────────────────────────
const SENSOR_TRUE = new Set([true, 't']);

/**
 * { rainCard, rainSensorLine } from the customer's property_preferences row at completion.
 *   rainCard         new sod is not still establishing and the schedule is not left unconfirmed after a move. No prefs
 *                    row at all = no sod record can exist = allowed (the no-schedule customer is the one who gains most).
 *                    A row without the sod columns, or an unreadable one, = not allowed (fail closed).
 *   rainSensorLine   the rain sensor field is not true (the portal default is false for every row), or it is true but
 *                    left unconfirmed after a move.
 * `prefs` is the row, null (no row), or undefined (the read failed).
 */
function rainCardDecision(prefs, visitDate) {
  if (prefs === undefined) return { rainCard: false, rainSensorLine: false };
  if (prefs === null) return { rainCard: true, rainSensorLine: true };
  const allowed = sodIsEstablished(prefs, visitDate) && !scheduleUnconfirmedAfterMove(prefs);
  const hasSensor = rainSensorConfirmedAfterMove(prefs) && SENSOR_TRUE.has(prefs.rain_sensor);
  return { rainCard: allowed, rainSensorLine: allowed && !hasSensor };
}

module.exports = {
  MAX_INCHES_PER_DAY,
  effectiveRainInches,
  rainCardAllowed,
  withCappedRain,
  applyRainCard,
  waterStatusFor,
  rainCardDecision,
  deficitAction,
  COPY,
};
