'use strict';

/**
 * GATE_LAWN_REPORT_POLISH, part 2: ONE label line per product card.
 *
 * A product card prints the catalog's precaution text and then its re-entry line. On a spray both say the same
 * thing ("Per the product label: keep people and pets off treated areas until sprays have dried." and "Stay off
 * treated areas until the application has dried."). The rule is decided by what each sentence MEANS, not by text
 * equality, with the parser the label facts already trust (sms-label-facts.js parseReentryText):
 *
 *   kinds        until_dry            "keep people and pets off ... until sprays have dried"
 *                watered_in_and_dry   "... until the product has been watered in and the turf is dry", and the
 *                                     permission form "People and pets can use the lawn once it has been watered
 *                                     in and the turf is dry"
 *   the line     the re-entry line's kind; no kind (the parser cannot read it) = nothing is dropped
 *   the rule     a precaution sentence whose kind is NO STRICTER than the re-entry line's kind is dropped; a
 *                sentence of another kind, or one that cannot be read, is KEPT (fail toward printing)
 *   guard        the re-entry line always stays, so a card never ends with no keep-off line when the catalog had
 *                one; a positive stored re-entry figure (hours) means nothing is dropped
 *
 * A leading "Per the product label:" is stripped before parsing (the parser does not accept that lead).
 *
 * The decision is made ONCE at completion and frozen with the lawn report facts (lawn-report-facts.js,
 * labelLines); a render only reads it, so a catalog edit never rewrites an old card and the web page, the PDF and
 * Ask Waves agree. Pure. No gate read.
 */

const { parseReentryText } = require('../sms-label-facts');

const RANK = Object.freeze({ until_dry: 1, watered_in_and_dry: 2 });
const LEAD_RE = /^per the product label:\s*/i;
const TIME_WORD_RE = /\d|\b(?:hours?|hrs?|minutes?|mins?|days?|overnight)\b/i;

const KEEP_OFF_SRC = '(?:stay off|keep (?:people and pets|pets and people|everyone) off)';
const CAN_USE_SRC = '(?:people and pets|pets and people|everyone) can (?:use|walk on|return to|go back on)';
const AREA_SRC = '(?:the )?(?:treated )?(?:areas?|turf|lawn|grass)';
const WATERED_IN_SRC = '(?:the )?(?:product|application|treatment|granules?|it) (?:has|have) been watered in and (?:the )?(?:turf|grass|lawn|surface) (?:is dry|has dried)';
const WATERED_IN_RE = new RegExp(`^(?:${KEEP_OFF_SRC} ${AREA_SRC} until|${CAN_USE_SRC} ${AREA_SRC} once) ${WATERED_IN_SRC}\\.?$`, 'i');
// The seeded no-wait wording: "No re-entry wait once watered in and dry." (the PolyPlus fertilizer's precaution)
const NO_WAIT_RE = /^no re-?entry wait once (?:it is |the (?:product|application|treatment|granules?) (?:is|are|has been|have been) )?watered in and (?:the (?:turf|grass|lawn|surface) is )?dry\.?$/i;

/** The sentences of a catalog text, in order (one function, used at the decision and at the render). */
function splitSentences(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
}

/** 'until_dry' | 'watered_in_and_dry' | null (the parser cannot read it) */
function kindOf(sentence) {
  const text = String(sentence || '').replace(LEAD_RE, '').trim();
  if (!text) return null;
  if (!TIME_WORD_RE.test(text) && (WATERED_IN_RE.test(text) || NO_WAIT_RE.test(text))) return 'watered_in_and_dry';
  const parsed = parseReentryText(text);
  return parsed && parsed.kind === 'until_dry' ? 'until_dry' : null;
}

/**
 * The indexes of the precaution's sentences to drop for one product card, [] when nothing is dropped.
 * @param {{precaution?: string|null, reentry?: string|null, reentryHours?: number|null}} facts the product's frozen facts
 */
function precautionDrops({ precaution, reentry, reentryHours } = {}) {
  if (Number.isFinite(Number(reentryHours)) && Number(reentryHours) > 0) return [];
  const reentryKind = kindOf(reentry);
  if (!reentryKind || !precaution) return [];
  return splitSentences(precaution)
    .map((sentence, index) => ({ index, kind: kindOf(sentence) }))
    .filter(({ kind }) => kind && RANK[kind] <= RANK[reentryKind])
    .map(({ index }) => index);
}

/**
 * The frozen decision for a visit's rows: { [service_products.id]: [dropped sentence indexes] }, only rows that
 * drop something. `rows` carry approved_report_product_facts (precautionSummary, reentrySummary, reentryHours).
 */
function labelLineDrops(rows) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const facts = (row && row.approved_report_product_facts) || {};
    const drops = row && row.id ? precautionDrops({ precaution: facts.precautionSummary, reentry: facts.reentrySummary, reentryHours: facts.reentryHours }) : [];
    if (drops.length) out[String(row.id)] = drops;
  }
  return out;
}

/** A frozen drop list read back: whole non-negative integers only, anything else is no decision. */
function cleanDrops(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 12) return null;
  return raw.every((n) => Number.isInteger(n) && n >= 0 && n < 50) ? [...new Set(raw)].sort((a, b) => a - b) : null;
}

/** The precaution text a card prints once its dropped sentences are left out; null when none is left. */
function precautionAfterDrops(precaution, drops) {
  if (!precaution || !Array.isArray(drops) || !drops.length) return precaution || null;
  const kept = splitSentences(precaution).filter((_, index) => !drops.includes(index));
  return kept.length ? kept.join(' ') : null;
}

module.exports = { splitSentences, kindOf, precautionDrops, labelLineDrops, cleanDrops, precautionAfterDrops };
