'use strict';

/**
 * GATE_LAWN_REPORT_COPY_FIXES (owner 2026-10-08/09): the lawn report's six customer-copy fixes
 * that act on the built report, kept apart from the builders they correct so the builders gain
 * no decisions. The gate is read here, at call time, and only ever for a lawn report.
 *
 *   applyLawnCopyFixes(v2, ctx)  runs after buildLawnReportV2's own build and changes:
 *     - the weed score card's label (same scale and status words)
 *     - snapshot.treatmentSummary (product categories, never a name or an active ingredient)
 *     - the seasonal color lines (cool month AND the overall score did not rise)
 *     - stale Water Gap / Mowing Height charts (newest point over 45 days before the visit)
 *     - the water target's source line (one fixed sentence)
 *   copyFixesPdfStamp / copyFixesPayloadFlag / lawnTreatmentNarrative are the three small
 *   hooks report-data.js calls without adding a decision of its own.
 *
 * Gate off: every export is a no-op or the old behaviour, so the payload, render and PDF are
 * byte-identical. Pure except lawnTreatmentNarrative's pass-through to the narrative builder.
 */

const featureGates = require('../../config/feature-gates');
const { isKnownGrass } = require('./irrigation-advice');
const { seasonalColorLineAllowed } = require('./lawn-seasonality');
const { dateOnlyToNoonUtc } = require('./time-format');
const { buildCategoryTreatmentSummary } = require('./treatment-summary');

// A partial feature-gates mock (a test) means off, never a crash in a report build.
function copyFixesLive() {
  return typeof featureGates.lawnReportCopyFixesLive === 'function' && featureGates.lawnReportCopyFixesLive();
}

/** The PDF cache-key part: moves the key only while the gate is live. */
function copyFixesPdfStamp() {
  return copyFixesLive() ? ':copyfix=1' : '';
}

/** The payload key that tells the report page not to print the pest re-service wording. */
function copyFixesPayloadFlag(serviceLine) {
  return serviceLine === 'lawn' && copyFixesLive() ? { lawnCopyFixes: true } : {};
}

/**
 * The lawn "What we applied today" paragraph. The AI narrative writes actives, so under the gate
 * the fixed category sentence stands (no model call, no database read, key part '-tn0');
 * otherwise the narrative builder runs exactly as before.
 */
async function lawnTreatmentNarrative(args) {
  if (!copyFixesLive()) return require('./treatment-narrative').buildTreatmentNarrative(args);
  return { text: buildCategoryTreatmentSummary(args.treatment, { noTiming: featureGates.lawnReportCopyV6Live() }), signature: null };
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

const dayKey = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
};

// ── weed card ───────────────────────────────────────────────────────────────
// The value is how clear the lawn is of weeds (Strong = few weeds), so "Weed Pressure: Strong"
// read as strong weeds. Same scale and status words; the name the weed trend chart already uses.
const WEED_CARD_LABEL = 'Weed Cleanliness';

function fixWeedLabel(v2) {
  const card = (v2.diagnosis || []).find((c) => c && c.key === 'weed_pressure');
  if (card) card.label = WEED_CARD_LABEL;
}

// ── seasonal color lines ────────────────────────────────────────────────────
// The cool-season notes talk about color and growth easing off.
const COOL_SEASON_NOTE_SEASONS = new Set(['shoulder', 'dormant']);

// The rule's inputs: this visit's month, its overall score and the prior visit's (the latest
// earlier trend row with a score). `allowed(base)` also compares against a base visit's score.
function colorLineRule(lawnAssessment) {
  const visitDay = dayKey(lawnAssessment.assessmentDate);
  const month = visitDay ? dateOnlyToNoonUtc(visitDay).getUTCMonth() + 1 : null;
  const current = num(lawnAssessment.scores && lawnAssessment.scores.overallScore);
  const earlier = (Array.isArray(lawnAssessment.trend) ? lawnAssessment.trend : [])
    .filter((r) => visitDay && dayKey(r.date) && dayKey(r.date) < visitDay && num(r.overallScore) !== null);
  const priorScore = earlier.length ? num(earlier[earlier.length - 1].overallScore) : null;
  return {
    currentOnly: seasonalColorLineAllowed({ month, currentScore: current, priorScore }),
    allowed: (baseScore) => seasonalColorLineAllowed({ month, currentScore: current, priorScore, baseScore: num(baseScore) }),
  };
}

function fixSeasonalLines(v2, lawnAssessment) {
  const rule = colorLineRule(lawnAssessment);
  const trend = Array.isArray(lawnAssessment.trend) ? lawnAssessment.trend : [];
  const season = (lawnAssessment.scores && lawnAssessment.scores.season) || (trend[0] && trend[0].season) || null;
  const { snapshot } = v2;
  if (snapshot && snapshot.seasonalNoteSource !== 'program' && COOL_SEASON_NOTE_SEASONS.has(season) && !rule.currentOnly) snapshot.seasonalNote = null;
  const before = lawnAssessment.beforeAfter && lawnAssessment.beforeAfter.before;
  if (v2.progressionNote && !rule.allowed(before && before.overallScore)) v2.progressionNote = null;
  if (v2.trends && v2.trends.seasonalNote && !rule.allowed(trend[0] && trend[0].overallScore)) delete v2.trends.seasonalNote;
}

// ── stale charts ────────────────────────────────────────────────────────────
// A chart whose newest point is more than this many days before the visit date is not shown.
const STALE_CHART_DAYS = 45;

function isStale(dates, visitDay) {
  const newest = dates.map(dayKey).filter(Boolean).sort().pop();
  if (!visitDay || !newest) return false; // nothing to judge by: leave the chart alone
  return (dateOnlyToNoonUtc(visitDay) - dateOnlyToNoonUtc(newest)) / 86400000 > STALE_CHART_DAYS;
}

// The chart keys in reportV2.trends that are dated, with the keys that go with them and the
// dated rows each is drawn from (the same sources buildTrends reads).
function datedCharts({ waterGapHistory, mowingHeight, mowingTrendFallback }) {
  const mowCtx = mowingHeight && Array.isArray(mowingHeight.trend) && mowingHeight.trend.length ? mowingHeight : mowingTrendFallback;
  const mowRows = mowCtx && Array.isArray(mowCtx.trend) ? mowCtx.trend : [];
  return [
    { keys: ['waterGap'], dates: (Array.isArray(waterGapHistory) ? waterGapHistory : []).filter((r) => num(r.waterGapInches) !== null).map((r) => r.serviceDate) },
    { keys: ['mowing', 'mowingBand'], dates: mowRows.filter((r) => num(r.heightIn) !== null).map((r) => r.measuredAt) },
  ];
}

function fixStaleCharts(v2, lawnAssessment, ctx) {
  const { trends } = v2;
  if (!trends) return;
  const visitDay = dayKey(lawnAssessment.assessmentDate);
  const stale = datedCharts(ctx).filter((chart) => trends[chart.keys[0]] && isStale(chart.dates, visitDay));
  stale.forEach((chart) => chart.keys.forEach((key) => { delete trends[key]; }));
  // Nothing left to chart: no block at all, or the page would print a false "today sets your baseline".
  if (stale.length && !Object.keys(trends).length) v2.trends = null;
}

// ── water target source line ────────────────────────────────────────────────
// ONE fixed sentence from this closed table, only from inputs the figure actually used. The figure
// is the reference evapotranspiration of the 7-day window ENDING ON the visit date (the open service
// day can include hours not yet happened) x the grass's crop factor x a seasonal factor for the
// visit month; when that weather was missing it is the grass x season lookup. The grass is named
// only when the target tables list it (an unlisted grass is priced as St. Augustine). A target read
// from the area snapshot also carries the area's demand factor and does not record its basis, so it
// gets no line. The number itself never changes.
const WATER_TARGET_NOTES = Object.freeze({
  weather_grass: 'Based on the weather in your area for the week ending on this visit, your grass type and the time of year.',
  weather: 'Based on the weather in your area for the week ending on this visit and the time of year.',
  season_grass: 'Based on the usual weekly water need for your grass type at this time of year.',
  season: 'Based on the usual weekly water need for a lawn at this time of year.',
});
const TARGET_BASIS_KEY = Object.freeze({ evapotranspiration: 'weather', seasonal: 'season' });

function waterTargetNote(advice, grassKnown) {
  const base = TARGET_BASIS_KEY[advice && advice.targetBasis];
  return base ? WATER_TARGET_NOTES[`${base}${grassKnown ? '_grass' : ''}`] : null;
}

function fixWaterTargetNote(v2, lawnAssessment) {
  const { water } = v2;
  if (!water || water.source !== 'irrigation_advice' || water.targetInches == null) return;
  const waterContext = lawnAssessment.waterContext || {};
  const grassKnown = isKnownGrass(lawnAssessment.turfProfile && lawnAssessment.turfProfile.grassType);
  const note = waterTargetNote(waterContext.irrigationAdvice, grassKnown);
  if (note) water.targetNote = note;
}

/**
 * Apply the fixes to a built lawn reportV2, in place. Callers check the gate first.
 * @param {object} v2 buildLawnReportV2's own result
 * @param {object} ctx the same arguments buildLawnReportV2 was called with
 * @returns {object} v2
 */
function applyLawnCopyFixes(v2, ctx) {
  const { lawnAssessment } = ctx;
  fixWeedLabel(v2);
  if (v2.snapshot && v2.snapshot.treatmentSummary) v2.snapshot.treatmentSummary = buildCategoryTreatmentSummary(v2.treatment);
  fixSeasonalLines(v2, lawnAssessment);
  fixStaleCharts(v2, lawnAssessment, ctx);
  fixWaterTargetNote(v2, lawnAssessment);
  return v2;
}

module.exports = {
  copyFixesLive,
  copyFixesPdfStamp,
  copyFixesPayloadFlag,
  lawnTreatmentNarrative,
  applyLawnCopyFixes,
  WATER_TARGET_NOTES,
  WEED_CARD_LABEL,
  STALE_CHART_DAYS,
};
