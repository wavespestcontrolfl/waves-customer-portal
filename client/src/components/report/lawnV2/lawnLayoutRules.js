// GATE_LAWN_REPORT_LAYOUT: the pure rules behind the lawn web report layout (LawnLayout.jsx).
// Everything here reads data the report payload already carries; the only strings are the fixed
// sentences in shared/lawn-report-layout-copy.json (screened by server/tests/lawn-report-layout.test.js).
// The server adds the payload key `lawnLayout` only while the gate is live (lawn-report-layout.js), so
// with the gate off none of this runs and the page is exactly what it was.

import COPY from '../../../../../shared/lawn-report-layout-copy.json';
import { WAVES_SUPPORT_PHONE_DISPLAY } from '../../../constants/business';

export const LAYOUT_COPY = COPY;

const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isNumber = (value) => value != null && value !== '' && Number.isFinite(Number(value));
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => values[key]);

/** The layout applies to a LIVE lawn report whose payload carries the layout key and a lead. */
export function lawnLayoutActive(data, mode) {
  return mode === 'live'
    && data?.serviceLine === 'lawn'
    && Boolean(data.lawnLayout)
    && typeof data.lawnLayout === 'object'
    && Boolean(data.reportV2?.lead);
}

/** The status card's data: "Your documents" is not part of the lawn layout. */
export function lawnLayoutStatusData(data, mode) {
  return lawnLayoutActive(data, mode) ? { ...data, relatedDocuments: undefined } : data;
}

/** The "Today's result" override the standard page passes to the status card. */
export function lawnTodaysResult(data) {
  return data?.reportV2?.todaysResult || null;
}

// ── "Your part" ─────────────────────────────────────────────────────────────
/** True when the watering banner has a watering line or a mow hold to print (the same test the banner uses). */
export function bannerShowsAnything(banner) {
  if (!banner || typeof banner !== 'object') return false;
  const watering = Array.isArray(banner.lines) && banner.lines.length > 0;
  return watering || isText(banner.mowHold?.line);
}

function bannerWateringLines(banner) {
  return Array.isArray(banner?.lines) ? banner.lines.filter(isText) : [];
}

/** True when the banner carries watering lines (not only a mow hold): the water card then drops its restatements. */
export function bannerCarriesWatering(banner) {
  return bannerWateringLines(banner).length > 0;
}

/** The re-entry content the card prints, from the re-entry builder's own sentence (timed or condition). */
export function reentryRow(context, readiness) {
  if (!context || !readiness || readiness.allReady) return null;
  const text = isText(context.customerSummary) ? context.customerSummary.trim() : (readiness.status || null);
  if (!isText(text)) return null;
  const pets = isText(context.petAdvisory) ? context.petAdvisory.trim() : null;
  return { text, pets };
}

/** The lead's own homeowner steps (the top issue's action), as printed lines. */
export function alsoSteps(lead) {
  return Array.isArray(lead?.yourPart) ? lead.yourPart.filter(isText) : [];
}

/** Nothing to print in the card: the one fixed "nothing to do" sentence stands in. */
export function yourPartIsEmpty({ banner, reentry, lines }) {
  return !bannerShowsAnything(banner) && !reentry && !(lines && lines.length);
}

// ── Dedupe ──────────────────────────────────────────────────────────────────
// Mirror of CREDITED_WATER_IN_PHRASE in server/services/service-report/lawn-report-insights.js.
const CREDITED_WATER_IN_PHRASE = 'Water in today’s application as directed';

function restatesWatering(card, known) {
  const action = card && card.customerAction;
  if (!isText(action)) return false;
  return known.some((text) => action.includes(text)) || (card.category === 'water' && action.includes(CREDITED_WATER_IN_PHRASE));
}

/**
 * A finding's "Your next step" that restates the watering instruction is dropped: the "Your part"
 * card prints that instruction once. Only while the banner carries watering lines (otherwise the
 * finding is the one place the step appears).
 */
export function insightsWithoutRepeats(insights, { banner, aftercare } = {}) {
  const list = Array.isArray(insights) ? insights : [];
  const lines = bannerWateringLines(banner);
  if (!lines.length) return list;
  const known = [...lines, aftercare?.holdTask, aftercare?.waterInTask, aftercare?.customerTask].filter(isText);
  return list.map((card) => (restatesWatering(card, known) ? { ...card, customerAction: null } : card));
}

// No lookbehind (older iOS Safari rejects it): mark each sentence end, then split on the mark.
const sentencesOf = (text) => String(text || '').replace(/([.!?])\s+/g, '$1\u0000').split('\u0000').filter(isText);

// The v6 copy's fixed "watching" sentence (lawn-copy-v6.js buildWatching).
const WATCHING_SENTENCE = /^We are also keeping an eye on\b/;
// How many finding cards the findings block prints (LawnInsightCards limit, sorted by priority).
const FINDING_CARD_LIMIT = 3;

/**
 * The lead's Watching line, minus the v6 sentence when every watched topic already has a finding card
 * on the page. Any other sentence in the field (the rainfast note) stays.
 */
export function watchingLine(lead, insights) {
  if (!isText(lead?.watching)) return null;
  const cards = (Array.isArray(insights) ? insights : []).filter(Boolean);
  const shown = [...cards].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)).slice(0, FINDING_CARD_LIMIT);
  const watched = cards.filter((card) => card.status === 'watch' || card.status === 'needs_attention');
  const repeatsFindings = watched.every((card) => shown.includes(card));
  const kept = sentencesOf(lead.watching).filter((sentence) => !(repeatsFindings && WATCHING_SENTENCE.test(sentence)));
  return kept.length ? kept.join(' ') : null;
}

const APPLIED_SENTENCE = /^Today we applied\b/;

/**
 * "What we applied today" prints once: the technician paragraph's own "Today we applied ..."
 * sentence is left out while the lead's applied sentence is on the page.
 */
export function techParagraphWithoutApplied(text, applied) {
  if (!isText(text)) return null;
  if (!isText(applied)) return text;
  const kept = sentencesOf(text).filter((sentence) => !APPLIED_SENTENCE.test(sentence));
  return kept.length ? kept.join(' ') : null;
}

// ── Next visit ──────────────────────────────────────────────────────────────
/** True when "Your plan" (or the standalone visits card) already prints the next visit's date. */
export function planShowsNextVisit(data) {
  const visits = data?.upcomingVisitsCard?.visits;
  return Array.isArray(visits) && visits.length > 0;
}

// ── Mowing height ───────────────────────────────────────────────────────────
// The Mowing Height gauge prints the ideal range itself when this visit has a reading.
export function gaugePrintsRange(mowing) {
  return Boolean(mowing) && isNumber(mowing.measuredHeightInches) && isNumber(mowing.idealMinInches) && isNumber(mowing.idealMaxInches);
}

const inches = (value) => String(Number(value));

/**
 * The fixed mowing-height sentence, from the server's per-grass table row (data.lawnLayout.mowingRange).
 * No row for the grass, or a gauge that already prints the range = no line.
 */
export function mowingLine(range, mowing) {
  if (!range || !isText(range.grassLabel) || !isNumber(range.minInches) || !isNumber(range.maxInches)) return null;
  if (gaugePrintsRange(mowing)) return null;
  return fill(COPY.mowing, { grass: range.grassLabel, min: inches(range.minInches), max: inches(range.maxInches) });
}

// ── When to call ────────────────────────────────────────────────────────────
export function whenToCallLines() {
  return COPY.whenToCall.map((line) => fill(line, { phone: WAVES_SUPPORT_PHONE_DISPLAY }));
}
