'use strict';

/**
 * The short lawn watering text (owner 2026-10-23:
 * "the watering text is a little wordy, needs to be more concise").
 *
 * The report's watering lines are written to stand alone on a page, so the
 * text that sent them verbatim ran to three SMS segments. This writer builds
 * the TEXT ONLY from the frozen instruction's structured fields (hold end,
 * amount, deadline, minutes, the long total), so the times and amounts are the
 * report's own and the two can never disagree. The report, PDF, banner and Ask
 * Waves keep the full lines.
 *
 * Short, but every detail of the full lines that changes what the customer
 * does stays: the hold is on lawn watering only, every amount is "about", the
 * long total says regular watering counts as well as rain, and the rain
 * sentence says to run the watering when the rain does not come. The
 * screenshot shape is then 183 characters (two segments, within the purpose's
 * maxSegments).
 *
 * Pure: no db, no clock, no gate. Returns null for any shape it does not know
 * (an older record, a missing label); the caller then sends the full lines.
 * Every sentence is GSM-7 (ASCII apostrophe and fractions).
 */

const { formatInches, _private: { formatWhen, WEEKDAYS } } = require('./lawn-watering-instruction');
const { etDateString, etParts, parseETDateTime } = require('../../utils/datetime-et');

const DRY_LABEL = 'today’s treatment has dried';
const NONE_TEXT = 'No change. Keep your usual schedule.';
const ANY_DAY = 'even on an off day';
const COUNTS = 'Rain and regular watering count.';
const EVENING_PHRASE = 'between 8 PM and midnight';
const EVENING_START = '20:00';
const EVENING_END = '23:59';

const ascii = (text) => text.replace(/’/g, "'").replace(/½/g, '1/2').replace(/¼/g, '1/4').replace(/¾/g, '3/4');
const label = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);
const posNum = (value) => {
  const n = Number(value);
  return value != null && value !== '' && Number.isFinite(n) && n > 0 ? n : null;
};

// The hold sentence. `alone` = the whole text is the hold.
function holdSentence(instruction, alone) {
  const until = label(instruction.holdUntilLabel);
  if (!until) return null;
  if (!instruction.holdUntil) {
    // An until-dry hold has no clock end.
    if (until !== DRY_LABEL) return null;
    return alone ? 'Let the treatment dry before you water.' : 'Let the treatment dry first.';
  }
  const waitsForDry = typeof instruction.holdUntilPlanLabel === 'string' && instruction.holdUntilPlanLabel !== until;
  return waitsForDry
    ? `Skip lawn watering until ${until} and the treatment is dry.`
    : `Skip lawn watering until ${until}.`;
}

// How much to run, from the minutes the instruction was frozen with. `when` is
// "by <deadline label>", or the evening window ("tonight between 8 PM and
// midnight") when the caller found one (GATE_LAWN_WATERING_TEXT_HOURS).
function runClause(instruction, when) {
  const m = instruction.minutes || {};
  if (instruction.amountOnly === true) {
    const amount = formatInches(instruction.waterInInches);
    return amount ? `water about ${amount} ${when}` : null;
  }
  if (posNum(m.measured)) return `water ${when}, about ${m.measured} min per zone`;
  const spray = posNum(m.spray);
  const rotor = posNum(m.rotor);
  if (spray && rotor) return `water ${when}: spray zones about ${spray} min, rotor zones about ${rotor} min`;
  if (spray || rotor) return `water ${when}, about ${spray || rotor} min per zone`;
  if (m.unknown === true) return `water ${when}, one full cycle on each zone`;
  return null;
}

const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// The long (pre-emergent) total beside a short water-in, from `later`.
function laterSentence(instruction) {
  const later = instruction.later;
  const amount = formatInches(later && later.waterInInches);
  const at = later && Date.parse(later.waterInBy);
  const from = Date.parse(instruction.completedAt);
  if (!amount || !Number.isFinite(at) || !Number.isFinite(from)) return null;
  return `Get about ${amount} total by ${formatWhen(new Date(at), new Date(from))}. ${COUNTS}`;
}

/**
 * @param {object} instruction  frozen buildWateringInstruction result
 * @param {object} [opts]
 * @param {string|null} [opts.eveningDay]  'tonight' or a short weekday from eveningWindowDay: the plain run clause
 *   names that day's evening window instead of the "by <deadline>" clock. Default null = today's text, byte for byte.
 * @returns {string|null}       the steps for the text, or null (send the full lines)
 */
function shortWateringText(instruction, { eveningDay = null } = {}) {
  if (!instruction || typeof instruction !== 'object') return null;
  const { state } = instruction;
  if (state === 'none') return NONE_TEXT;
  if (!['hold', 'water_in', 'hold_then_water_in'].includes(state)) return null;
  const parts = [];
  const hasHold = state !== 'water_in';
  if (hasHold) {
    const hold = holdSentence(instruction, state === 'hold');
    if (!hold) return null;
    parts.push(hold);
  }
  if (state !== 'hold') {
    const by = label(instruction.waterInByLabel);
    if (!by) return null;
    if (instruction.longWindow === true) {
      const amount = formatInches(instruction.waterInInches);
      if (!amount) return null;
      parts.push(`${hasHold ? 'Then get' : 'Get'} about ${amount} of water by ${by}. ${COUNTS}`);
    } else {
      const run = runClause(instruction, eveningDay ? `${eveningDay} ${EVENING_PHRASE}` : `by ${by}`);
      if (!run) return null;
      parts.push(`${hasHold ? `Then ${run}` : capital(run)}, ${ANY_DAY}.`);
      if (instruction.later) {
        const later = laterSentence(instruction);
        if (!later) return null;
        parts.push(later);
      }
    }
  }
  return ascii(parts.join(' '));
}

/**
 * The evening window the short text may name (owner 2026-11-15, GATE_LAWN_WATERING_TEXT_HOURS): the first ET evening
 * window [20:00, 23:59] that starts at or after the hold end (else the completion) and ends by the water-in deadline,
 * when the restriction policy in force at its start allows watering for all of it. Pure: `policyAt(instant)` returns the
 * policy (or null) and carries the county.
 * @returns {string|null} 'tonight' (the window is on the completion's ET day), else the short weekday as formatWhen
 *   prints it; null = no window, so the text keeps its "by <deadline>" wording.
 */
function eveningWindowDay(instruction, policyAt) {
  if (!instruction || typeof policyAt !== 'function') return null;
  const floor = Date.parse(instruction.holdUntil || instruction.completedAt);
  const completed = Date.parse(instruction.completedAt);
  const deadline = Date.parse(instruction.waterInBy);
  if (![floor, completed, deadline].every(Number.isFinite)) return null;
  const completedDay = etDateString(new Date(completed));
  let day = etDateString(new Date(floor));
  for (let i = 0; i < 30; i += 1) {
    const start = parseETDateTime(`${day}T${EVENING_START}`);
    if (start.getTime() > deadline) return null;
    if (start.getTime() >= floor) {
      if (parseETDateTime(`${day}T${EVENING_END}`).getTime() > deadline) return null;
      const policy = policyAt(start);
      const windows = policy && policy.noHourRestriction !== true && Array.isArray(policy.allowedHours) ? policy.allowedHours : [];
      if (!windows.some((w) => w.start <= EVENING_START && w.end >= EVENING_END)) return null;
      if (day === completedDay) return 'tonight';
      const days = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${completedDay}T00:00:00Z`)) / 86400000);
      // A weekday alone is ambiguous six or more days out (formatWhen prints the date then): keep the deadline wording.
      return days >= 6 ? null : WEEKDAYS[etParts(start).dayOfWeek];
    }
    day = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * The short rain sentence, for a visit whose full forecast sentence is valid
 * for the text (the caller passes textForecastLine's result as `fullLine`).
 * @returns {string|null}  null = keep the full sentence
 */
function shortForecastSentence(instruction, fullLine) {
  if (!fullLine || !instruction || !instruction.forecast) return null;
  const { forecast } = instruction;
  const rain = formatInches(forecast.inches);
  const amount = formatInches(instruction.waterInInches);
  const checkpoint = label(forecast.checkpointLabel);
  if (!rain || !amount || !checkpoint) return null;
  if (forecast.afterHold === true) {
    const from = label(instruction.holdUntilLabel);
    if (!from) return null;
    return ascii(`Rain forecast: about ${rain} between ${from} and ${checkpoint}. If ${amount} falls, skip the run. If not, run it.`);
  }
  return ascii(`Rain forecast: about ${rain} by ${checkpoint}. If ${amount} falls by then, skip the run. If not, run it.`);
}

module.exports = { shortWateringText, shortForecastSentence, eveningWindowDay };
