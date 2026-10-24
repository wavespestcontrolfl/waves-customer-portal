'use strict';

/**
 * The short lawn watering text (GATE_LAWN_WATERING_SHORT_TEXT, owner 2026-10-23:
 * "the watering text is a little wordy, needs to be more concise").
 *
 * The report's watering lines are written to stand alone on a page, so the
 * text that sent them verbatim ran to three SMS segments. This writer builds
 * the TEXT ONLY from the frozen instruction's structured fields (hold end,
 * amount, deadline, minutes, the long total), so the times and amounts are the
 * report's own and the two can never disagree. The report, PDF, banner and Ask
 * Waves keep the full lines.
 *
 * Pure: no db, no clock, no gate. Returns null for any shape it does not know
 * (an older record, a missing label); the caller then sends the full lines.
 * Every sentence is GSM-7 (ASCII apostrophe and fractions).
 */

const { formatInches, _private: { formatWhen } } = require('./lawn-watering-instruction');

const DRY_LABEL = 'today’s treatment has dried';
const NONE_TEXT = 'No change. Keep your usual schedule.';
const ANY_DAY = 'even on an off day';

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
    ? `Skip watering until ${until} and the treatment is dry.`
    : `Skip watering until ${until}.`;
}

// How much to run, from the minutes the instruction was frozen with.
function runClause(instruction, by) {
  const m = instruction.minutes || {};
  if (instruction.amountOnly === true) {
    const amount = formatInches(instruction.waterInInches);
    return amount ? `water ${amount} by ${by}` : null;
  }
  if (posNum(m.measured)) return `water by ${by}, about ${m.measured} min per zone`;
  const spray = posNum(m.spray);
  const rotor = posNum(m.rotor);
  if (spray && rotor) return `water by ${by}: spray zones about ${spray} min, rotor zones about ${rotor} min`;
  if (spray || rotor) return `water by ${by}, about ${spray || rotor} min per zone`;
  if (m.unknown === true) return `water by ${by}, one full cycle on each zone`;
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
  return `Get ${amount} total by ${formatWhen(new Date(at), new Date(from))}. Rain counts.`;
}

/**
 * @param {object} instruction  frozen buildWateringInstruction result
 * @returns {string|null}       the steps for the text, or null (send the full lines)
 */
function shortWateringText(instruction) {
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
      parts.push(`${hasHold ? 'Then get' : 'Get'} about ${amount} of water by ${by}. Rain counts.`);
    } else {
      const run = runClause(instruction, by);
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
    return ascii(`Rain forecast: about ${rain} between ${from} and ${checkpoint}. If ${amount} falls, skip the run.`);
  }
  return ascii(`Rain forecast: about ${rain} by ${checkpoint}. If ${amount} falls by then, skip the run.`);
}

module.exports = { shortWateringText, shortForecastSentence };
