'use strict';

/**
 * GATE_LAWN_REPORT_POLISH: the longer-cycles line on the Water This Week card (owner 2026-10-09):
 * "Short runs on several days wet only the top of the soil. Put the same water into fewer, longer runs on your
 * allowed watering days and it reaches the roots." One fixed sentence (shared/lawn-report-polish-copy.json).
 *
 * It is advice about the customer's standing schedule, not an after-visit step. It names no weekday, no day count and
 * no minutes, and no restriction number: it says "allowed watering days" and asks for FEWER runs, so it agrees with
 * any watering-restriction policy (irrigation-restrictions.js) however strict.
 *
 * Two parts, decided in two places:
 *   at completion (frozen with the report facts, lawnReportFacts.waterAdvice, first writer wins)
 *       the schedule on file has 3 or more watering days, AND the property has no new sod that is still establishing
 *   at render (this module, from the payload the build has assembled)
 *       no hold or water-in banner on the visit (state hold, hold_then_water_in or water_in, expired or not: the
 *       decision never depends on the clock), no weekly plan on the card, no after-visit watering note, the schedule
 *       is confirmed (not withheld after a move)
 * A schedule left unconfirmed after a move (irrigation-schedule-confirmation.js, the report's own guard) freezes false.
 * Every doubt answers "do not print": an unreadable sod record, a prefs row without the sod columns (migration not
 * applied), a failed read, a toggle that switched irrigation off.
 *
 * "New sod still establishing" is the sod hold module's own answer (lawn-sod-holds.js): the weed-killer hold is
 * "held through day 30 AND until a technician confirms the sod has been mowed twice and does not lift", the point
 * where the sod is treated as rooted. Pure. No gate read, no database read.
 */

const { normalizeRuntimeInputs } = require('@waves/irrigation-runtime');
const { sodHolds } = require('../lawn-sod-holds');
const { scheduleUnconfirmedAfterMove } = require('../irrigation-schedule-confirmation');

const MIN_WATERING_DAYS = 3;

const hasText = (value) => value != null && String(value).trim() !== '';

/**
 * True when the property has no sod record, or a readable one whose sod is rooted. False when a sod record exists and
 * the sod is still establishing, or the record cannot be read, or the prefs row does not carry the sod columns.
 */
function sodIsEstablished(prefs, visitDate) {
  if (!Object.prototype.hasOwnProperty.call(prefs, 'sod_laid_on')) return false;
  if (!hasText(prefs.sod_laid_on)) return true;
  const holds = sodHolds({
    sodLaidOn: prefs.sod_laid_on,
    sodCovers: prefs.sod_covers,
    sodArea: prefs.sod_area,
    sodRootedOn: prefs.sod_rooted_on,
    visitDate,
  });
  return !!holds && holds.weedKiller.held === false;
}

/**
 * The completion-time decision for one lawn visit: true or false. `prefs` is the customer's property_preferences row
 * (or null); `visitDate` the service day.
 */
function longerCyclesDecision(prefs, visitDate) {
  if (!prefs || prefs.irrigation_system === false) return false;
  // After an address change the row can still hold the former home's schedule, which the report withholds until the
  // customer confirms a new one: the same guard the report uses, applied at completion, fails closed (a permanent
  // record never carries advice built from another house).
  if (scheduleUnconfirmedAfterMove(prefs)) return false;
  const days = normalizeRuntimeInputs({ wateringDays: prefs.watering_days }).wateringDays;
  return days.length >= MIN_WATERING_DAYS && sodIsEstablished(prefs, visitDate);
}

/** The frozen block a record stores: { v: 1, longerCycles: boolean }. */
function waterAdviceBlock(prefs, visitDate) {
  return { v: 1, longerCycles: longerCyclesDecision(prefs, visitDate) };
}

// A banner states a post-treatment watering step while it holds watering back or asks for a water-in. The state "none"
// ("No watering change from today's treatment.") and a mow-hold-only banner (state null) ask for nothing.
const WATERING_BANNER_STATES = Object.freeze(['hold', 'hold_then_water_in', 'water_in']);

const aftercareAsksForWatering = (aftercare) => !!(aftercare && hasText(aftercare.watering) && aftercare.neutral !== true);

// The visit prints a post-treatment watering instruction of its own: a hold or water-in banner (whether or not its
// clock has run out, so a printed or reopened report never changes), or the label's after-visit watering note.
function visitCarriesWateringInstruction(reportV2) {
  return WATERING_BANNER_STATES.includes(reportV2.banner && reportV2.banner.state) || aftercareAsksForWatering(reportV2.aftercare);
}

/**
 * The same question asked BEFORE the banner exists, of the visit's frozen watering instruction (the banner's state is
 * the instruction's state) and its aftercare: the rain card (lawn-water-rain.js) decides while the report is built.
 */
function instructionCarriesWatering(instruction, aftercare) {
  return WATERING_BANNER_STATES.includes(instruction && instruction.state) || aftercareAsksForWatering(aftercare);
}

/**
 * The payload field for the card: { longerCycles: true } or {}. `frozen` is the record's frozen answer (true/false/null).
 * `reportV2` is the assembled report, banner included.
 */
function longerCyclesField(frozen, reportV2) {
  if (frozen !== true || !reportV2 || !reportV2.water) return {};
  const water = reportV2.water;
  // The rain card (GATE_LAWN_WATER_RAIN) says what to do with the sprinklers this week; the advice is said once.
  if (water.weekPlan || water.scheduleUnconfirmed || water.rainCard === true || visitCarriesWateringInstruction(reportV2)) return {};
  return { longerCycles: true };
}

/** Adds the field to the assembled report's water card (mutates; nothing when it does not apply). */
function attachLongerCycles(reportV2, frozen) {
  Object.assign((reportV2 && reportV2.water) || {}, longerCyclesField(frozen, reportV2));
}

module.exports = { attachLongerCycles, instructionCarriesWatering, MIN_WATERING_DAYS, sodIsEstablished, longerCyclesDecision, waterAdviceBlock, longerCyclesField };
