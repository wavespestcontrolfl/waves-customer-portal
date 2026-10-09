// GATE_LAWN_REPORT_LAYOUT: the pure rules behind the lawn web report layout (LawnLayout.jsx).
// Everything here reads data the report payload already carries; the only strings are the fixed
// sentences in shared/lawn-report-layout-copy.json (screened by server/tests/lawn-report-layout.test.js).
// The server adds the payload key `lawnLayout` only while the gate is live (lawn-report-layout.js), so
// with the gate off none of this runs and the page is exactly what it was.

import COPY from '../../../../../shared/lawn-report-layout-copy.json';
import { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_PHONE_TEL } from '../../../constants/business';
import { etDateString } from '../../../lib/timezone';

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

/**
 * The status card's data: "Your documents" is not part of the lawn layout, and "Next service" is left off when the
 * plan area prints that same appointment (nextVisitPlacement), so the date is printed once.
 */
export function lawnLayoutStatusData(data, mode, todayEt) {
  if (!lawnLayoutActive(data, mode)) return data;
  const { statusDrops } = nextVisitPlacement(data, { todayEt });
  return { ...data, relatedDocuments: undefined, ...(statusDrops ? { nextAppointment: undefined } : {}) };
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

// ── What "Nothing for you to do after this visit." may be said over ─────────
// The sentence is about care AFTER THE VISIT. It is printed only when no printed section carries an after-visit
// instruction. Two closed lists make that explicit; a third names the slots that are plain information.
//
// INSTRUCTION_SOURCES: what COUNTS as an after-visit instruction (any one removes the sentence).
export const INSTRUCTION_SOURCES = Object.freeze({
  leadStep: { reason: 'the lead\'s own homeowner step (Other steps)', test: (v2) => alsoSteps(v2.lead).length > 0 },
  recommendations: { reason: 'the technician\'s recommendations list', test: (v2, data) => (data?.recommendations || []).length > 0 },
  weeklyPlan: { reason: 'the weekly watering plan on the water card', test: (v2) => Boolean(v2.water?.weekPlan?.title) },
  coverageWatch: { reason: 'the coverage-watch callout ("worth checking that your sprinklers reach those spots")', test: (v2) => Boolean(v2.water?.coverageWatch) },
  aftercareNote: { reason: 'the aftercare watering / re-entry note on the water card', test: (v2) => isText(v2.aftercare?.watering) && v2.aftercare?.neutral !== true },
  techTips: { reason: 'tips from your technician', test: (v2, data) => Boolean(data?.techNote?.tips?.length) },
  // findings' next steps need the banner clock; see findingsCarryStep
  findingStep: { reason: 'a finding\'s next step among the cards the findings block prints, after the banner dedupe', test: (v2, data, clock) => findingsCarryStep(v2, clock.nowMs, clock.printing) },
});

// INVITATIONS: page elements that invite or inform and deliberately do NOT count. None is care after the visit; the
// page also shows most of them on a clean visit, so counting them would remove the sentence from nearly every report.
export const INVITATIONS = Object.freeze({
  waterScheduleCta: 'the "Add your watering schedule" call to action (WaterIntakeBar, scheduleOnFile false): optional account setup that makes the reading more exact; no treatment depends on it',
  longerCyclesAdvice: 'the longer-cycles sentence on the water card (water.longerCycles, GATE_LAWN_REPORT_POLISH): advice about the customer\'s standing sprinkler schedule, printed only when no banner, weekly plan or after-visit watering note is on the visit; it is not a step after this visit',
  rainCardAdvice: 'the rain card\'s sentence on the water card (water.rainCard, GATE_LAWN_WATER_RAIN: "Rain alone covered your lawn this week. Leave the sprinklers off until the grass shows…", and the new deficit and surplus sentences): the explanation of the week that ended and advice about the standing schedule, like every water-card explanation today; "leave the sprinklers off" is not an after-visit task, and a visit that carries a real watering instruction (hold / water-in) never shows it',
  bannerSetupLink: 'the sprinkler-setup link under an amount-only water-in (banner.setupLine): the amount to water is already printed; the link only offers minutes per zone',
  reviewAsk: 'the review ask',
  referralCard: 'the referral card',
  crossSellCard: 'the cross-sell offer',
  reschedule: 'the Reschedule link on Your plan',
  textUs: 'the "Something come up between visits? Text us." line and the When to call us block',
  reserviceInvite: 'the "Still seeing something? Tell us" re-service invitation',
});

// SLOT_CLASS: every slot the page hands the layout, named in exactly one place: an instruction source, an
// invitation, or information (a fact, not a task). lawnLayoutCoverage.test.js fails when a slot is in none.
export const SLOT_CLASS = Object.freeze({
  status: 'information', recap: 'information', nearYou: 'information', recordedFindings: 'information',
  visitSummary: 'information', products: 'information', productsKind: 'information', poisonNote: 'information',
  tracedMap: 'information', markedPhotos: 'information', highlights: 'information',
  yourPart: 'instruction', recommendations: 'instruction', techNote: 'instruction',
  reservice: 'invitation', plan: 'invitation', upcoming: 'invitation', review: 'invitation', referral: 'invitation', crossSell: 'invitation',
});

/**
 * True when ANY section the layout prints carries an after-visit instruction (INSTRUCTION_SOURCES). The card then
 * never says "nothing to do" (and is left out when it would be empty). INVITATIONS never count.
 */
export function pageCarriesInstruction(data, nowMs, printing = false) {
  const v2 = data?.reportV2 || {};
  const clock = { nowMs, printing };
  return Object.values(INSTRUCTION_SOURCES).some((source) => source.test(v2, data, clock));
}

// A finding the findings block prints has a next step of its own (after the dedupe against the banner).
function findingsCarryStep(v2, nowMs, printing) {
  const cards = insightsWithoutRepeats(v2.insights, { banner: v2.banner, aftercare: v2.aftercare, nowMs, printing }).filter(Boolean);
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
export function bannerCarriesWatering(banner, nowMs = Date.now(), printing = false) {
  if (!bannerWateringLines(banner).length) return false;
  // A page being printed prints the banner's lines whatever the clock says (LawnWateringBanner: ended is
  // false when print or the browser print pass is on), so the dedupe follows the same signal.
  if (printing) return true;
  const expiresMs = banner.expiresAt ? Date.parse(banner.expiresAt) : NaN;
  return !(Number.isFinite(expiresMs) && nowMs > expiresMs);
}

/**
 * A finding's "Your next step" loses ONLY the sentences that are the banner's own sentences, or the
 * aftercare's hold / water-in task sentences, word for word (apostrophe, spacing and closing punctuation
 * aside). Any other sentence stays: a sprinkler check, a mowing or irrigation-repair step, or the rest of a
 * mixed step. A step that is entirely repeats becomes empty. Only while the card prints the banner's lines.
 */
export function insightsWithoutRepeats(insights, { banner, aftercare, nowMs, printing } = {}) {
  const list = Array.isArray(insights) ? insights : [];
  if (!bannerCarriesWatering(banner, nowMs, printing)) return list;
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
export function bannerRepeatsAftercare(banner, aftercare, nowMs, printing) {
  if (!bannerCarriesWatering(banner, nowMs, printing) || !isText(aftercare?.watering)) return false;
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

// The calendar day the plan area parses a scheduledDate to ('YYYY-MM-DD' only; a full timestamp parses to
// nothing and the card prints no date), mirroring calendarDateFromDateOnlyValue in ReportViewPage.jsx.
const dateOnly = (value) => {
  const found = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.000)?(?:Z|\+00:00)?)?$/.exec(String(value || ''));
  return found ? found[1] : null;
};
const isLawnVisit = (serviceType) => /lawn|turf/i.test(String(serviceType || ''));

// The visits the plan area PRINTS (what PlanSummaryCard and UpcomingVisitsCard render), each with whether the print
// carries the arrival window:
//   - a visits list (data.upcomingVisitsCard.visits): the merged "Your plan" section (merged: true) or the standalone
//     "Your upcoming visits" card print each visit's service, date and window (clarity on lists one lawn visit;
//     clarity off lists every service line). An unparsable date prints no date, so that visit does not count;
//   - with NO upcomingVisitsCard key (the upcoming-visits gate off), "Your plan" prints "Your next <service> visit is
//     <date>." from data.nextAppointment (no window), only with a plan (visitsThisYear > 0), a date that has not passed
//     (ET) and a service name.
// (The server scopes the list to this report's property.)
function printedPlanVisits(data, todayEt) {
  if (data.upcomingVisitsCard) {
    const visits = Array.isArray(data.upcomingVisitsCard.visits) ? data.upcomingVisitsCard.visits : [];
    return visits.filter((visit) => dateOnly(visit?.scheduledDate)).map((visit) => ({ visit, window: true }));
  }
  const appointment = data.nextAppointment;
  const printed = (Number(data.planSummary?.visitsThisYear) || 0) > 0
    && dateOnly(appointment?.scheduledDate) >= todayEt
    && isText(String(appointment?.serviceType || '').replace(/\s+service$/i, ''));
  return printed ? [{ visit: appointment, window: false }] : [];
}

// The window the card prints for a visit ("9:00 AM–11:00 AM" from windowStart), as a comparable key.
const windowKey = (visit) => (/^(\d{1,2}):(\d{2})/.exec(String(visit?.windowStart || '')) || []).slice(1).join(':');
const sameDayAs = (visit, ymd) => Boolean(ymd) && dateOnly(visit?.scheduledDate) === ymd;
// The label the lead prints for its next visit, as a calendar day (the server's long form, with or without the year).
const leadDayMatches = (label, visit) => {
  const ymd = dateOnly(visit?.scheduledDate);
  return Boolean(ymd) && [longDay(ymd, false), longDay(ymd, true)].some((day) => norm(day) === norm(label));
};
const scheduledLabel = (data) => {
  const next = data?.reportV2?.snapshot?.nextVisit;
  return next && next.source === 'scheduled' && isText(next.label) ? next.label : null;
};
// The same appointment: same day, same service, same window.
const sameAppointment = (a, b) => sameDayAs(a, dateOnly(b?.scheduledDate)) && norm(a?.serviceType) === norm(b?.serviceType) && windowKey(a) === windowKey(b);

/**
 * True only when the plan area PRINTS the visit the lead's date names: the lead's next visit is a scheduled booking,
 * and the plan area (printedPlanVisits) prints a lawn visit on that same day. A pest visit, another day, an
 * unparsable date, a cadence estimate or a card that does not print it keeps the lead's date.
 */
export function planShowsNextVisit(data, todayEt = etDateString()) {
  const label = scheduledLabel(data);
  return Boolean(label) && printedPlanVisits(data, todayEt).some(({ visit }) => isLawnVisit(visit.serviceType) && leadDayMatches(label, visit));
}

/**
 * True when the plan area prints this very appointment: a list entry prints service, date and window, so all three must
 * match; the plan-only fallback line prints service and date but no window, so the appointment must have none.
 */
function planPrintsAppointment(data, appointment, todayEt) {
  if (!dateOnly(appointment?.scheduledDate)) return false;
  return printedPlanVisits(data, todayEt).some(({ visit, window }) => {
    const sameServiceDay = sameDayAs(visit, dateOnly(appointment.scheduledDate)) && norm(visit.serviceType) === norm(appointment.serviceType);
    return sameServiceDay && (window ? windowKey(visit) === windowKey(appointment) : !windowKey(appointment));
  });
}

/**
 * Where each next-visit date prints on the lawn layout page, so none prints twice and none is lost. Printers, in the
 * order that wins: the plan area, the status card's "Next service" (data.nextAppointment, any service line), the
 * Visit Summary's "What's next" line (data.nextSameServiceAppointment, only inside the four-section technician
 * report: `summaryPrintsNext`), then the lead's "Next visit" date. A later printer drops its date only when an
 * earlier one that really prints is the SAME visit; with no proof it keeps its date.
 */
export function nextVisitPlacement(data, { summaryPrintsNext = false, todayEt = etDateString() } = {}) {
  const appointment = data?.nextAppointment;
  const statusPrintable = Boolean(dateOnly(appointment?.scheduledDate));
  const statusDrops = statusPrintable && planPrintsAppointment(data, appointment, todayEt);
  const statusPrints = statusPrintable && !statusDrops;
  const summary = data?.nextSameServiceAppointment;
  const summaryPrintable = summaryPrintsNext && Boolean(dateOnly(summary?.scheduledDate));
  const summaryDrops = summaryPrintable && (planPrintsAppointment(data, summary, todayEt) || (statusPrints && sameAppointment(summary, appointment)));
  const summaryPrints = summaryPrintable && !summaryDrops;
  const leadDrops = leadDateIsPrintedElsewhere(data, todayEt, [statusPrints && appointment, summaryPrints && summary]);
  return { statusDrops, summaryDrops, leadDrops };
}

// The lead's scheduled date is dropped when the plan area, or an earlier printer that really prints (the `printers`
// that are appointments, not false), shows a lawn visit on that same day.
function leadDateIsPrintedElsewhere(data, todayEt, printers) {
  const label = scheduledLabel(data);
  if (!label) return false;
  return planShowsNextVisit(data, todayEt) || printers.some((visit) => visit && isLawnVisit(visit.serviceType) && leadDayMatches(label, visit));
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
/**
 * True when treatment may have been applied on this visit: the products section's own verdict
 * (appliedProductsKind: 'products' or 'poison' when something went down, or the verdict is unknown) is not 'none'.
 * An older payload with no applicationMade verdict counts as unknown, i.e. "may have applied".
 */
export function treatmentMayHaveBeenApplied(data, productsKind) {
  return productsKind !== 'none' || data?.applicationMade === undefined;
}

/**
 * The approved call lines. "if the area we treated gets worse" is about a treatment, so it prints only when one
 * may have been applied; the damage line (no treatment in it) always prints. The approved sentences are not changed.
 */
export function whenToCallLines({ treated = true } = {}) {
  const lines = COPY.whenToCall.map((line) => fill(line, { phone: WAVES_SUPPORT_PHONE_DISPLAY }));
  return treated ? lines : lines.filter((line) => !/\btreated\b/.test(line));
}

/** The office number as the report's footer prints it, for the block that has no sentence carrying it. */
export const OFFICE_PHONE = { display: WAVES_SUPPORT_PHONE_DISPLAY, tel: WAVES_SUPPORT_PHONE_TEL };
