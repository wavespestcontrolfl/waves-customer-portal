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

// Content the standard page body prints that the lawn layout has no section for. A lawn payload that
// carries any of it keeps the standard page (the layout declines), so the layout can never drop it. Each
// entry mirrors the standard mount's own condition. (A lawn visit carries none of these today; they belong to
// the pest, mosquito, termite, rodent and cockroach lines and to typed specialty reports.)
export const LAYOUT_DECLINES = Object.freeze({
  pestReportV2: (data) => Boolean(data.pestReportV2),
  mosquitoReportV2: (data) => Boolean(data.mosquitoReportV2),
  termiteReportV2: (data) => Boolean(data.termiteReportV2),
  cockroachReportV2: (data) => Boolean(data.cockroachReportV2),
  customerConcernCard: (data) => Boolean(data.customerConcernCard),
  typedReport: (data) => Boolean(data.typedReport),
  typedVisitTimeline: (data) => Boolean(data.typedVisitTimeline),
  activity: (data) => Boolean(data.activity),
  // the Pest Pressure card renders under the same test the standard page uses for its gauge
  pestPressure: (data) => Boolean(data.pestPressure) && data.pestPressure.enabled !== false && data.pestPressure.showOnCustomerReport !== false,
  pressureTrend: (data) => Boolean(data.dynamicContext?.pressureTrend),
  companionReports: (data) => Array.isArray(data.companionReports) && data.companionReports.length > 0,
  stationMap: (data) => Array.isArray(data.stationMap?.stations) && data.stationMap.stations.length > 0,
});

/** The names in LAYOUT_DECLINES that this payload carries. */
export function layoutDeclines(data) {
  return Object.keys(LAYOUT_DECLINES).filter((key) => LAYOUT_DECLINES[key](data || {}));
}

/**
 * The layout applies to a LIVE lawn report whose payload carries the layout key and a lead, and nothing the
 * layout has no section for (LAYOUT_DECLINES).
 */
export function lawnLayoutActive(data, mode) {
  return mode === 'live'
    && data?.serviceLine === 'lawn'
    && Boolean(data.lawnLayout)
    && typeof data.lawnLayout === 'object'
    && Boolean(data.reportV2?.lead)
    && layoutDeclines(data).length === 0;
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

/**
 * The re-entry content the card prints, from the re-entry builder's own output and its keep-off line. The old
 * card printed the same two things, plus tiles that restate the sentence:
 *  - a frozen CONDITION (context.condition, no clock) prints its text AND its keep-off line, never one without
 *    the other (the keep-off line is condition.pets, else the pet advisory);
 *  - a timed sentence the builder wrote is printed as written, with the pet advisory;
 *  - with no sentence, only a real "Ready after <time>" status stands in (never a status label);
 *  - a finished re-entry prints no sentence but still keeps a pet advisory the old card printed;
 *  - nothing real to say = null, and the card says nothing about re-entry.
 */
export function reentryRow(context, readiness) {
  if (!context || !readiness) return null;
  const condition = isText(context.condition?.text) ? context.condition : null;
  const keepOff = [condition?.pets, context.petAdvisory].find(isText);
  const pets = keepOff ? keepOff.trim() : null;
  let text = null;
  if (condition) text = condition.text.trim();
  else if (!readiness.allReady) {
    if (isText(context.customerSummary)) text = context.customerSummary.trim();
    else if (/^Ready after /.test(readiness.status || '')) text = readiness.status;
  }
  return text || pets ? { text, pets } : null;
}

/** True when the re-entry content is timed (the clock path), which is what the timer-view event counts. */
export function reentryIsTimed(context) {
  return Boolean(context) && !context.condition && Array.isArray(context.targets) && context.targets.length > 0;
}

/** The lead's own homeowner steps (the top issue's action), as printed lines. */
export function alsoSteps(lead) {
  return Array.isArray(lead?.yourPart) ? lead.yourPart.filter(isText) : [];
}

/** Nothing to print in the card: the one fixed "nothing to do" sentence stands in. */
export function yourPartIsEmpty({ banner, reentry, lines }) {
  return !bannerShowsAnything(banner) && !reentry && !(lines && lines.length);
}

/**
 * True when ANY section the layout prints carries a customer instruction: the lead's own step, a finding's
 * next step (after the dedupe, among the cards the findings block prints), the technician recommendations, the
 * weekly watering plan, a coverage-watch callout, the aftercare watering or re-entry note, the tips from your
 * technician. The card then never says "nothing to do" (and is left out when it would be empty).
 */
export function pageCarriesInstruction(data, nowMs) {
  const v2 = data?.reportV2 || {};
  const care = v2.aftercare || {};
  const plainInstruction = alsoSteps(v2.lead).length > 0
    || (data?.recommendations || []).length > 0
    || Boolean(v2.water?.weekPlan?.title || v2.water?.coverageWatch)
    || (isText(care.watering) && care.neutral !== true)
    || Boolean(data?.techNote?.tips?.length);
  return plainInstruction || findingsCarryStep(v2, nowMs);
}

// A finding the findings block prints has a next step of its own (after the dedupe against the banner).
function findingsCarryStep(v2, nowMs) {
  const cards = insightsWithoutRepeats(v2.insights, { banner: v2.banner, aftercare: v2.aftercare, nowMs }).filter(Boolean);
  const shown = [...cards].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)).slice(0, FINDING_CARD_LIMIT);
  if (!shown.length || shown.every((card) => card.category === 'overall')) return false;
  return shown.some((card) => isText(card.customerAction));
}

// ── Dedupe ──────────────────────────────────────────────────────────────────
// A fact is left off a block only when the block that carries it is on the page and says the same
// thing. Every rule below proves that from the payload; without the proof the original stays.

// No lookbehind (older iOS Safari rejects it): mark each sentence end, then split on the mark.
const sentencesOf = (text) => String(text || '').replace(/([.!?])\s+/g, '$1\u0000').split('\u0000').filter(isText);
// A sentence as compared: one apostrophe, one space, no closing punctuation.
const norm = (text) => String(text || '').replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
const sentenceSet = (texts) => new Set(texts.flatMap(sentencesOf).map(norm).filter(Boolean));

// Remove the sentences `drop` approves from the original text (kept as written, line breaks included).
// Nothing approved = the text itself. Everything removed = null.
function withoutSentences(text, drop) {
  const dropped = sentencesOf(text).filter(drop);
  if (!dropped.length) return text;
  let out = String(text);
  dropped.forEach((sentence) => { out = out.replace(sentence, ''); });
  out = out.replace(/[ \t]{2,}/g, ' ').trim();
  return out || null;
}

/**
 * True when the "Your part" card prints the banner's watering lines: the banner has lines and has not
 * ended (an ended banner prints one fine-print note instead of its lines, the way LawnWateringBanner reads it).
 */
export function bannerCarriesWatering(banner, nowMs = Date.now()) {
  if (!bannerWateringLines(banner).length) return false;
  const expiresMs = banner.expiresAt ? Date.parse(banner.expiresAt) : NaN;
  return !(Number.isFinite(expiresMs) && nowMs > expiresMs);
}

/**
 * A finding's "Your next step" loses ONLY the sentences that are the banner's own sentences, or the
 * aftercare's hold / water-in task sentences, word for word (apostrophe, spacing and closing punctuation
 * aside). Any other sentence stays: a sprinkler check, a mowing or irrigation-repair step, or the rest of a
 * mixed step. A step that is entirely repeats becomes empty. Only while the card prints the banner's lines.
 */
export function insightsWithoutRepeats(insights, { banner, aftercare, nowMs } = {}) {
  const list = Array.isArray(insights) ? insights : [];
  if (!bannerCarriesWatering(banner, nowMs)) return list;
  const known = sentenceSet([...bannerWateringLines(banner), aftercare?.holdTask, aftercare?.waterInTask, aftercare?.customerTask].filter(isText));
  return list.map((card) => {
    if (!card || !isText(card.customerAction)) return card;
    const kept = withoutSentences(card.customerAction, (sentence) => known.has(norm(sentence)));
    return kept === card.customerAction ? card : { ...card, customerAction: kept };
  });
}

/**
 * True when the water card's own copy of the watering instruction (the line inside the weekly plan's
 * condition note) says nothing the banner does not: every sentence of aftercare.watering is one of the
 * banner's sentences, and the banner carries them.
 */
export function bannerRepeatsAftercare(banner, aftercare, nowMs) {
  if (!bannerCarriesWatering(banner, nowMs) || !isText(aftercare?.watering)) return false;
  const shown = sentenceSet(bannerWateringLines(banner));
  return sentencesOf(aftercare.watering).every((sentence) => shown.has(norm(sentence)));
}

// The v6 copy's fixed "watching" sentence (lawn-copy-v6.js buildWatching).
const WATCHING_SENTENCE = /^We are also keeping an eye on\b/;
// How many finding cards the findings block prints (LawnInsightCards limit, sorted by priority).
const FINDING_CARD_LIMIT = 3;

/**
 * The lead's Watching line, minus the v6 sentence once the findings block is on the page with a card for
 * EVERY watched finding: the block prints (LawnInsightCards prints nothing when all its cards are the
 * healthy "overall" one) and every watch / needs-attention finding is among the cards it prints.
 * Any other sentence in the field (the rainfast note) stays.
 */
export function watchingLine(lead, insights) {
  if (!isText(lead?.watching)) return null;
  const cards = (Array.isArray(insights) ? insights : []).filter(Boolean);
  const shown = [...cards].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)).slice(0, FINDING_CARD_LIMIT);
  const blockPrints = shown.length > 0 && !shown.every((card) => card.category === 'overall');
  const watched = cards.filter((card) => card.status === 'watch' || card.status === 'needs_attention');
  const repeatsFindings = blockPrints && watched.length > 0 && watched.every((card) => shown.includes(card));
  const kept = sentencesOf(lead.watching).filter((sentence) => !(repeatsFindings && WATCHING_SENTENCE.test(sentence)));
  return kept.length ? kept.join(' ') : null;
}

const APPLIED_SENTENCE = /^Today we applied\b/;
const APPLIED_LEAD_IN = /^Today we applied\s+/i;

// An applied sentence is covered when everything it lists (products or categories) is in the lead's
// applied sentence. A trailing clause the lead does not carry ("which fits the fall season") is not
// covered, so that sentence stays.
function appliedCovered(sentence, applied) {
  const items = norm(sentence).replace(APPLIED_LEAD_IN, '').split(/,\s*(?:and\s+)?|\s+and\s+/i).map((item) => item.trim().toLowerCase()).filter(Boolean);
  const said = norm(applied).toLowerCase();
  return items.length > 0 && items.every((item) => said.includes(item));
}

/**
 * "What we applied today" prints once: an "Today we applied ..." sentence is left out of the technician
 * paragraph (or the Visit Summary) only while the lead's own applied sentence is printed and says everything
 * that sentence lists. Anything else in the text stays, as written.
 */
export function withoutRepeatedApplied(text, applied) {
  if (!isText(text)) return null;
  if (!isText(applied)) return text;
  return withoutSentences(text, (sentence) => APPLIED_SENTENCE.test(sentence) && appliedCovered(sentence, applied));
}

// ── Next visit ──────────────────────────────────────────────────────────────
const longDay = (ymd, withYear) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC', ...(withYear ? { year: 'numeric' } : {}),
});

/**
 * True only when "Your plan" (or the standalone visits card) PRINTS the visit the lead's date names: the
 * lead's next visit is a scheduled booking, and the card lists a lawn visit on that same calendar day.
 * A pest visit, a visit on another day, a cadence estimate or an empty list keeps the lead's own date.
 * (The server scopes the card to this report's property.)
 */
export function planShowsNextVisit(data) {
  const next = data?.reportV2?.snapshot?.nextVisit;
  const visits = data?.upcomingVisitsCard?.visits;
  if (!next || next.source !== 'scheduled' || !isText(next.label) || !Array.isArray(visits)) return false;
  const label = norm(next.label);
  return visits.some((visit) => {
    const ymd = /^\d{4}-\d{2}-\d{2}/.exec(String(visit?.scheduledDate || ''));
    if (!ymd || !/lawn|turf/i.test(String(visit.serviceType || ''))) return false;
    return [longDay(ymd[0], false), longDay(ymd[0], true)].some((day) => norm(day) === label);
  });
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
