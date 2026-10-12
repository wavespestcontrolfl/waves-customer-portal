'use strict';

/**
 * GATE_LAWN_WATER_IN_RAIN (owner 2026-10-09): rain since the visit counts toward a water-in banner.
 *
 * Real report, 2026-10-09: 4.68 inches fell, and the banner still told the customer to water in a granular
 * pre-emergent whose precaution says "Water in with about ½ inch within 24 hours". Two read-time changes, both on a
 * REPLAY of the instruction frozen at completion (the frozen object, the completion text and the freeze itself never
 * change; the caller asks only for a record that has a frozen instruction):
 *
 *   1. covered   measured rain from completion to now (no later than the water-in deadline) reaches the water-in amount:
 *                the banner state is "water_in_by_rain" and its lines say the rain did the job. A hold line, when the
 *                visit had one, stays above them (rain does not end a hold on the sprinklers).
 *   2. amount    before that, a water-in frozen with both generic figures reads as an amount first (withAmountLine in
 *                lawn-watering-instruction.js, the one rate table).
 *
 * Rain source: the Open-Meteo hourly series, past hours (application-conditions.fetchPropertyForecast, the reader the
 * rainfast watch uses). It counts whole hours lying inside the window, a LOWER BOUND, and reads null for a missing
 * hour, a failed fetch, no coordinates or no whole hour yet. The rain card's own daily series (rain7d: MRMS blended with
 * Open-Meteo) is a whole-day total and cannot place rain after the completion minute, so it is not used here. Every
 * miss reads "not covered": the banner stays as it was frozen.
 *
 * Pure apart from the injected fetch: no gate read, no database, no clock (the caller passes `now`).
 */

const COPY = require('../../../shared/watering-copy.json');
const { withAmountLine } = require('./lawn-watering-instruction');

const HOUR_MS = 3600000;
const FETCH_TIMEOUT_MS = 2500;
const EPSILON = 1e-9;
const MAX_INCHES = 2;

// The water-in amount when a product's catalog precaution states none we can read. Owner 2026-10-09: 0.5 inch is the
// default for a granular water-in (the label wording on the pre-emergent and fertilizer products is "about ½ inch").
// The one place this number lives.
const DEFAULT_WATER_IN_INCHES = 0.5;

const COVERED_STATE = 'water_in_by_rain';
const WATER_IN_STATES = Object.freeze(['water_in', 'hold_then_water_in']);
const HOLD_LINE = /^Skip your turf watering until /;

const finite = (value) => (value == null || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null));
const round2 = (value) => Math.round(value * 100) / 100;
const toMs = (value) => {
  if (value == null || value === '') return NaN;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : NaN;
};

// ── The amount a product asks for ─────────────────────────────────────────────────────────────────────────────
const FRACTIONS = { '¼': 0.25, '½': 0.5, '¾': 0.75 };
const AMOUNT = '(?:\\d+(?:\\.\\d+)?\\s*\\/\\s*\\d+|\\d+(?:\\.\\d+)?\\s*[¼½¾]|\\d+(?:\\.\\d+)?|[¼½¾])';
const AMOUNT_BEFORE_INCH = new RegExp(`(?:(${AMOUNT})\\s*(?:to|-|–|—)\\s*)?(${AMOUNT})\\s*(?:-\\s*)?(?:inch(?:es)?\\b|in\\b|")`, 'gi');
const WATER_IN_SENTENCE = /water(?:ed|ing)?[\s-]+in\b|\birrigat/i;

function amountValue(text) {
  const t = String(text || '').trim();
  const fraction = t.match(/^(\d+(?:\.\d+)?\s*)?([¼½¾])$/);
  if (fraction) return (fraction[1] ? Number(fraction[1]) : 0) + FRACTIONS[fraction[2]];
  const slash = t.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+)$/);
  if (slash) return Number(slash[2]) > 0 ? Number(slash[1]) / Number(slash[2]) : null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * The inches a catalog precaution asks to water in ("Water in with about ½ inch within 24 hours" = 0.5), or null when it
 * states none we can read. Only a sentence about watering in or irrigating counts; "¼ to ½ inch" reads as the upper
 * figure (the stricter test). Nothing over 2 inches (the rule table's own ceiling) is believed.
 */
function parseWaterInInches(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let best = null;
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (!WATER_IN_SENTENCE.test(sentence)) continue;
    AMOUNT_BEFORE_INCH.lastIndex = 0;
    let match = AMOUNT_BEFORE_INCH.exec(sentence);
    while (match) {
      const value = amountValue(match[2]);
      if (value != null && value > 0 && value <= MAX_INCHES) best = best == null ? value : Math.max(best, value);
      match = AMOUNT_BEFORE_INCH.exec(sentence);
    }
  }
  return best;
}

/**
 * The rain that covers the visit's water-in: the largest amount any water-in product asks for (its precaution's, else
 * DEFAULT_WATER_IN_INCHES), and never less than the amount the instruction itself prints. `products` carry the frozen
 * approved_report_product_facts ({ wateringRule, precautionSummary }).
 */
function thresholdInches(instruction, products) {
  const amounts = [];
  for (const product of Array.isArray(products) ? products : []) {
    const facts = product && product.approved_report_product_facts;
    if (!facts || !facts.wateringRule || facts.wateringRule.mode !== 'water_in') continue;
    amounts.push(parseWaterInInches(facts.precautionSummary) ?? DEFAULT_WATER_IN_INCHES);
  }
  const base = amounts.length ? Math.max(...amounts) : DEFAULT_WATER_IN_INCHES;
  return Math.max(base, finite(instruction && instruction.waterInInches) ?? 0);
}

/** Whether a frozen instruction is one this gate may change: a water-in (alone or after a hold) with a completion instant and a deadline. */
function appliesTo(instruction) {
  return !!instruction && typeof instruction === 'object' && WATER_IN_STATES.includes(instruction.state)
    && Array.isArray(instruction.lines) && instruction.lines.length > 0
    && Number.isFinite(toMs(instruction.completedAt)) && Number.isFinite(toMs(instruction.waterInBy));
}

// A window that ended at least an hour ago will not change: remember its answer (the banner of a permanent report is
// read again and again). Never remembered: a miss, or a window still open.
const CLOSED_WINDOW_MEMO = new Map();
const MEMO_MAX = 200;

/**
 * Observed rain since completion against the water-in amount.
 * @returns {Promise<{covered: boolean, observedInches: number, thresholdInches: number}|null>} null = not applicable or
 *   the rain could not be read (the caller then leaves the banner alone).
 */
async function resolveRainCoverage({
  instruction, products, now, latitude, longitude, fetchForecast,
} = {}) {
  try {
    if (!appliesTo(instruction) || typeof fetchForecast !== 'function') return null;
    const fromMs = toMs(instruction.completedAt);
    const nowMs = now instanceof Date ? now.getTime() : Date.now();
    const endMs = Math.min(nowMs, toMs(instruction.waterInBy));
    if (!Number.isFinite(nowMs) || endMs - fromMs < HOUR_MS) return null;
    const threshold = thresholdInches(instruction, products);
    const closed = endMs <= nowMs - HOUR_MS;
    const memoKey = closed ? `${Number(latitude).toFixed(3)},${Number(longitude).toFixed(3)}|${fromMs}|${endMs}` : null;
    let observed = memoKey ? CLOSED_WINDOW_MEMO.get(memoKey) : undefined;
    if (observed === undefined) {
      const result = await fetchForecast({
        latitude, longitude, from: new Date(fromMs), to: new Date(endMs), timeoutMs: FETCH_TIMEOUT_MS, now: new Date(nowMs), exactTotal: true,
      });
      // null = a needed hour had no reading, or no whole hour lies inside: never read as zero, never as rain.
      const total = result && result.status === 'ok' ? result.precipitationInTotalExact : null;
      if (typeof total !== 'number' || !Number.isFinite(total)) return null;
      observed = total;
      if (memoKey) {
        CLOSED_WINDOW_MEMO.delete(memoKey);
        CLOSED_WINDOW_MEMO.set(memoKey, observed);
        while (CLOSED_WINDOW_MEMO.size > MEMO_MAX) CLOSED_WINDOW_MEMO.delete(CLOSED_WINDOW_MEMO.keys().next().value);
      }
    }
    // The test is on the UNROUNDED sum: 0.496 inch has not watered in half an inch.
    return { covered: observed + EPSILON >= threshold, observedInches: round2(observed), thresholdInches: threshold };
  } catch {
    return null;
  }
}

/**
 * The instruction once rain has covered the water-in: state "water_in_by_rain", the two fixed sentences (a hold line
 * stays first). Every other field is the frozen one, so the hold times, the deadline and the expiry read as before.
 * The caller has checked appliesTo.
 */
function coveredByRain(instruction) {
  const holdLine = instruction.state === 'hold_then_water_in' && typeof instruction.lines[0] === 'string' && HOLD_LINE.test(instruction.lines[0])
    ? [instruction.lines[0]] : [];
  return {
    ...instruction,
    state: COVERED_STATE,
    lines: [...holdLine, COPY.waterInByRainLine1, COPY.waterInByRainLine2],
    rainCovered: true,
  };
}

/**
 * The read-time instruction: covered by rain when the rain read says so, else the amount line (withAmountLine), else the
 * very same object. `coverage` is resolveRainCoverage's answer (null = unread).
 */
function applyWaterInRain(instruction, coverage) {
  if (!appliesTo(instruction)) return instruction;
  if (coverage && coverage.covered === true) return coveredByRain(instruction);
  return withAmountLine(instruction);
}

/**
 * The PDF cache-key part: '' when this gate does nothing to the instruction, else ':wir=' and a letter for what the
 * banner will say (c = covered by rain, a = amount line). A banner left as frozen adds nothing, so its key is the gate-off key. Pure.
 */
function waterInRainStamp(instruction, coverage) {
  if (!appliesTo(instruction)) return '';
  if (coverage && coverage.covered === true) return ':wir=c';
  return withAmountLine(instruction) !== instruction ? ':wir=a' : '';
}

module.exports = {
  COVERED_STATE,
  DEFAULT_WATER_IN_INCHES,
  parseWaterInInches,
  thresholdInches,
  appliesTo,
  resolveRainCoverage,
  coveredByRain,
  applyWaterInRain,
  waterInRainStamp,
  _private: { CLOSED_WINDOW_MEMO },
};
