/**
 * Lawn Report V2 — aggregator.
 *
 * Single integration surface between the existing post-service lawn data
 * (buildLawnAssessmentReportData + mowing context) and the V2 client components
 * (client/src/components/report/lawnV2/LawnReportV2.jsx). report-data.js calls this
 * and attaches the result as `reportV2` on the lawn report payload, behind a flag.
 *
 * Pure + deterministic. Reuses the dual-vision scores, the data-driven water
 * balance, and the measured mowing height already computed for V1 — no new model
 * calls, no new copy that isn't grounded in those facts.
 */

const { buildVisualDiagnosisCategories, scoreStatus } = require('./lawn-visual-diagnosis');
const { buildLawnInsightCards } = require('./lawn-report-insights');
const { crossSeasonNote, crossSeasonNoteFromSeasons, dormancyLikely } = require('./lawn-seasonality');

// Classify an applied product into a customer-facing purpose. Prefers the catalog's
// approved report summary; falls back to category/active-ingredient heuristics so a
// product with no summary still reads in plain language. `kind` lets insight copy
// reference the right solution ("a fungicide", "a pre-emergent") deterministically.
// Accepts both the FINAL report applications shape ({ product: { name, category,
// active_ingredient, service_report_summary, ... }, targets, ... }) and the raw
// service_products shape ({ product_name, active_ingredient, approved_report_product_facts }).
function classifyProduct(app = {}) {
  const p = app.product || {};
  const facts = app.approved_report_product_facts || {};
  const category = p.category || app.product_category || facts.category || '';
  const ai = p.active_ingredient || app.active_ingredient || facts.activeIngredient || '';
  const name = p.name || app.product_name || facts.name || '';
  const hay = `${category} ${ai} ${name}`.toLowerCase();
  let kind = 'other';
  let tag = 'lawn treatment';
  let fallback = 'applied as part of today’s lawn program';
  if (/fung|azoxy|propiconazole|thiophanate/.test(hay)) { kind = 'fungicide'; tag = 'fungus protection'; fallback = 'helps protect turf where fungus pressure or wet conditions call for it'; }
  else if (/pre.?emerg|prodiamine|dithiopyr|pendimethalin/.test(hay)) { kind = 'pre_emergent'; tag = 'weed prevention'; fallback = 'a pre-emergent that stops weeds before they sprout'; }
  else if (/herb|weed|celsius|atrazine|2,?4-?d|metsulfuron|halosulfuron|sedgehammer|sulfentrazone|iodosulfuron|dicamba/.test(hay)) { kind = 'herbicide'; tag = 'weed control'; fallback = 'targets actively growing weeds'; }
  else if (/insect|bifenthrin|imidacloprid|chinch|grub|dinotefuran|clothianidin/.test(hay)) { kind = 'insecticide'; tag = 'pest control'; fallback = 'targets turf-damaging insects'; }
  else if (/iron|micro|biostim|humic|kelp|seaweed/.test(hay)) { kind = 'supplement'; tag = 'color support'; fallback = 'supports color and stress tolerance'; }
  else if (/fert|nitrogen|urea|potash|\b\d{1,2}-\d{1,2}-\d{1,2}\b/.test(hay)) { kind = 'fertilizer'; tag = 'color & growth'; fallback = 'feeds the lawn to support density, color, and recovery'; }
  const whatItDoes = p.service_report_summary || p.public_summary || facts.serviceReportSummary || facts.publicSummary || fallback;
  return { kind, tag, whatItDoes };
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

// "What Waves did" — solutions/products applied, in plain language, plus the focus
// tags those products + completed actions add up to. Grounds the report in the
// actual treatment, not just the photo scores.
function buildTreatment({ applications = [], actions = [] } = {}) {
  const products = (applications || []).map((app) => {
    const p = app.product || {};
    const facts = app.approved_report_product_facts || {};
    const name = p.name || app.product_name || facts.name || null;
    if (!name) return null;
    const cls = classifyProduct(app);
    const targets = Array.isArray(app.targets) ? app.targets.filter(Boolean) : [];
    const areaVal = app.areaValue ?? app.area_value;
    const areaUnit = app.areaUnit || app.area_unit;
    const area = areaVal && areaUnit ? `${areaVal} ${areaUnit}` : null;
    return {
      name,
      activeIngredient: p.active_ingredient || app.active_ingredient || facts.activeIngredient || null,
      kind: cls.kind,
      whatItDoes: cls.whatItDoes,
      targets,
      area,
    };
  }).filter(Boolean);

  const focus = uniq([
    ...products.map((p) => classifyProduct({ active_ingredient: p.activeIngredient, product_name: p.name }).tag),
    ...(actions || []).map((a) => String(a || '').trim()),
  ]).map(cap).slice(0, 4);

  const kinds = new Set(products.map((p) => p.kind));
  if (!products.length && !focus.length) return null;
  return { products, focus, kinds: [...kinds] };
}

const GRASS_LABEL = {
  st_augustine: 'St. Augustine lawn',
  bermuda: 'Bermuda lawn',
  zoysia: 'Zoysia lawn',
  bahia: 'Bahia lawn',
  centipede: 'Centipede lawn',
};
function grassLabelFor(grassType) {
  const key = String(grassType || '').toLowerCase().replace(/[\s-]+/g, '_');
  return GRASS_LABEL[key] || 'lawn';
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round1 = (v) => (v == null ? '' : String(Number(Number(v).toFixed(1))));

function monthLabel(date) {
  if (!date) return '';
  // Date-only values (DB DATE / 'YYYY-MM-DD') must anchor at noon so the ET label
  // doesn't shift a day back from a UTC-midnight instant.
  const ymd = date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? new Date(`${ymd}T12:00:00`) : new Date(date);
  if (Number.isNaN(d.getTime())) return String(date);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

// irrigationAdvice.status → client WaterIntakeBar status.
function clientWaterStatus(advice) {
  if (!advice || advice.profileMissing) return 'unknown';
  switch (advice.status) {
    case 'surplus': return 'high';
    case 'deficit': return 'low';
    case 'balanced': return 'balanced';
    default: return 'unknown';
  }
}

function waterExplanation(advice, target, grassLabel) {
  const t = target != null ? `about ${target}"/wk` : 'the seasonal target';
  if (!advice || advice.profileMissing) {
    return `We don’t have your irrigation schedule on file yet. The seasonal target for your ${grassLabel} is ${t}.`;
  }
  switch (advice.status) {
    case 'surplus':
      return `Your weekly water (rain + irrigation) is running above ${t}. Easing back on irrigation should help reduce fungus, mushrooms, and weed pressure.`;
    case 'deficit':
      return `Your weekly water is below ${t}. A little more irrigation time will help the ${grassLabel} handle the heat.`;
    case 'balanced':
      return `Total water for the week is close to ${t} — right where we want it. If one area still looks off, that’s usually coverage, not total watering.`;
    case 'rain_unknown':
    default:
      return `We couldn’t fully read this week’s rainfall, so we’re using your irrigation schedule on file and the lawn’s condition as the guide. The seasonal target is ${t}.`;
  }
}

// Interpretation (from the area water-intake snapshot) → customer copy. Uses
// "your area received" wording and stays honest about confidence/coverage.
function snapshotWaterExplanation(snap, grassLabel) {
  const t = snap.target_water_inches_per_week != null ? `~${round1(snap.target_water_inches_per_week)}"/wk` : 'the seasonal target';
  const rain = snap.adjusted_rain_7day_inches != null ? snap.adjusted_rain_7day_inches : snap.rain_7day_inches;
  const lead = snap.confidence === 'high'
    ? `Based on rainfall for your area and the irrigation schedule on file, `
    : snap.confidence === 'medium'
      ? `Based on estimated rainfall in your area and the schedule on file, `
      : `We couldn't fully verify this week's rainfall, so we're using your lawn's condition and schedule as the guide. `;
  const totals = (rain != null && snap.irrigation_inches_per_week != null && snap.total_water_7day_inches != null)
    ? `your area received about ${round1(rain)}" of rain and your irrigation adds about ${round1(snap.irrigation_inches_per_week)}", for roughly ${round1(snap.total_water_7day_inches)}" this week. `
    : '';
  switch (snap.interpretation) {
    case 'wet_condition_watch':
      return `${lead}${totals}That's above ${t}. Easing back on irrigation should help reduce fungus, mushrooms, and weed pressure.`;
    case 'coverage_issue_possible':
      return `${lead}${totals}That's right around ${t}. Since one area still looks dry, we recommend checking sprinkler coverage there rather than watering the whole yard more.`;
    case 'water_deficit_likely':
      return `${lead}${totals}That's below ${t}. A little more irrigation time will help your ${grassLabel} handle the heat.`;
    case 'irrigation_unknown':
      return `We don't have your irrigation schedule on file yet. The seasonal target for your ${grassLabel} is ${t}.`;
    case 'rain_unknown':
      return `We couldn't fully read this week's rainfall for your area, so we're using the schedule on file and your lawn's condition. The seasonal target is ${t}.`;
    default:
      return `${lead}${totals}That's right around ${t} — right where we want it.`;
  }
}

const SNAP_STATUS = { low: 'low', high: 'high', balanced: 'balanced', unknown: 'unknown' };

// Prefer the area-calibrated water-intake snapshot (Phase 2) when it has a real
// reading; otherwise fall back to the live irrigation-advice water context.
function mapWater(waterContext, waterSnapshot = null) {
  const grassLabel = 'lawn';
  // Only prefer the area snapshot when its inputs are actually known. status can read
  // low/high from irrigation-only totals while rain is unsynced (interpretation =
  // 'rain_unknown'); in that case fall back to the live irrigation-advice context
  // rather than show misleading water totals.
  if (waterSnapshot && waterSnapshot.status && waterSnapshot.status !== 'unknown'
    && waterSnapshot.interpretation !== 'rain_unknown') {
    const rain = waterSnapshot.adjusted_rain_7day_inches != null ? waterSnapshot.adjusted_rain_7day_inches : waterSnapshot.rain_7day_inches;
    return {
      rainInches: num(rain),
      irrigationInches: num(waterSnapshot.irrigation_inches_per_week),
      totalInches: num(waterSnapshot.total_water_7day_inches),
      targetInches: num(waterSnapshot.target_water_inches_per_week),
      status: SNAP_STATUS[waterSnapshot.status] || 'unknown',
      confidence: waterSnapshot.confidence || 'medium',
      explanation: snapshotWaterExplanation(waterSnapshot, grassLabel),
      source: 'area_snapshot',
    };
  }
  if (!waterContext) return null;
  const advice = waterContext.irrigationAdvice || {};
  const target = num(waterContext.targetInchesPerWeek);
  return {
    rainInches: num(waterContext.rainfallInches7d),
    irrigationInches: num(waterContext.irrigationInchesPerWeek),
    totalInches: num(waterContext.effectiveInches7d),
    targetInches: target,
    status: clientWaterStatus(advice),
    confidence: advice.profileMissing ? 'low' : (advice.rainKnown ? 'high' : 'medium'),
    explanation: waterExplanation(advice, target, grassLabel),
    source: 'irrigation_advice',
  };
}

const MOW_STATUS = { below: 'too_short', above: 'too_tall', in_range: 'ideal' };
function mapMowing(mowingHeight, grassLabel) {
  if (!mowingHeight) return null;
  const status = MOW_STATUS[mowingHeight.status] || 'ideal';
  const rec = status === 'too_short'
    ? `Your ${grassLabel} is being kept a bit short. Short mowing makes turf show heat and dry stress faster — consider raising the mower one setting.`
    : status === 'too_tall'
      ? `Your ${grassLabel} is being kept a bit tall, which can shade the base and hold moisture — consider lowering the mower one setting.`
      : `Mowing height looks good — right in the ideal range for your ${grassLabel}.`;
  return {
    measuredHeightInches: num(mowingHeight.heightIn),
    idealMinInches: num(mowingHeight.band?.min),
    idealMaxInches: num(mowingHeight.band?.max),
    grassType: mowingHeight.grassType || null,
    status,
    recommendation: rec,
  };
}

// Collapse consecutive points that render the same label (e.g. two visits on the
// same day → "Jun 17 / Jun 17"), keeping the latest value. A series needs 2+
// distinct points to be a trend; otherwise it's dropped (the chart hides).
function dedupeTrend(points) {
  const out = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev && prev.label === p.label) { out[out.length - 1] = p; continue; }
    out.push(p);
  }
  return out;
}

// Real per-category trends come straight from the assessment history (each trend row
// carries turfDensity/weedSuppression/colorHealth/stressDamage). A series shows only
// with 2+ distinct visits — single-visit customers get no (fabricated) trend.
function seriesFrom(trend, field, mapVal = (v) => num(v)) {
  return dedupeTrend(trend
    .map((t) => ({ label: monthLabel(t.date), value: mapVal(t[field]) }))
    .filter((p) => p.value !== null));
}

function buildTrends(lawnAssessment, mowingHeight) {
  const trend = Array.isArray(lawnAssessment?.trend) ? lawnAssessment.trend : [];
  const out = {};
  const add = (key, series) => { if (series.length >= 2) out[key] = series; };
  add('overall', seriesFrom(trend, 'overallScore'));
  add('coverage', seriesFrom(trend, 'turfDensity'));
  add('weed', seriesFrom(trend, 'weedSuppression'));
  add('color', seriesFrom(trend, 'colorHealth'));
  add('stress', seriesFrom(trend, 'stressDamage'));
  const mowTrend = Array.isArray(mowingHeight?.trend) ? mowingHeight.trend : [];
  const mow = dedupeTrend(mowTrend
    .map((r) => ({ label: monthLabel(r.measuredAt), value: num(r.heightIn) }))
    .filter((p) => p.value !== null));
  if (mow.length >= 2) {
    out.mowing = mow;
    out.mowingBand = [num(mowingHeight.band?.min), num(mowingHeight.band?.max)];
  }
  return out;
}

// Side-by-side proof: same-lawn progression. Only a REAL before/after — the two
// captures must be on different dates (same-day initial+current isn't a trend).
function buildBeforeAfter(lawnAssessment) {
  const ba = lawnAssessment && lawnAssessment.beforeAfter;
  if (!ba || !ba.before || !ba.after || !ba.before.photoUrl || !ba.after.photoUrl) return null;
  const bDate = String(ba.before.date || '').slice(0, 10);
  const aDate = String(ba.after.date || '').slice(0, 10);
  if (!bDate || !aDate || bDate === aDate) return null; // same visit → not a real before/after
  return {
    before: { url: ba.before.photoUrl, label: monthLabel(ba.before.date), score: num(ba.before.overallScore) },
    after: { url: ba.after.photoUrl, label: monthLabel(ba.after.date), score: num(ba.after.overallScore) },
    improvement: num(ba.improvement),
  };
}

// Season × grass expectation-setting line (deflects "why does my lawn look like this").
const SEASON_NOTE = {
  peak: (g) => `It’s peak heat-and-pest season for your ${g} in Southwest Florida — some edge stress and faster drying are normal this time of year, and we’re watching for it.`,
  shoulder: (g) => `Your ${g} is in a transitional stretch — growth and color can be uneven as temperatures shift, which we factor into today’s read.`,
  dormant: (g) => `${g[0].toUpperCase()}${g.slice(1)} naturally slows and can look duller in the cooler months — lighter color now is seasonal, not a problem.`,
};
function buildSeasonalNote(lawnAssessment, grassLabel) {
  const season = (lawnAssessment.scores && lawnAssessment.scores.season)
    || (Array.isArray(lawnAssessment.trend) && lawnAssessment.trend[0] && lawnAssessment.trend[0].season) || null;
  const fn = season && SEASON_NOTE[season];
  return fn ? fn(grassLabel) : null;
}

// One-line SMS that matches the report's lead, from the synthesized snapshot.
function buildSmsSummary(snapshot, grassLabel) {
  if (!snapshot) return null;
  const head = String(snapshot.statusHeadline || '').replace(/\s*—\s*/g, ' — ');
  const action = snapshot.customerAction
    ? ` ${snapshot.customerAction.replace(/\.$/, '')}.`
    : (snapshot.noActionNeeded ? ' No action needed on your end.' : '');
  const line = `Your ${grassLabel} report is ready: ${head.charAt(0).toLowerCase()}${head.slice(1)}.${action}`;
  return line.length > 280 ? `${line.slice(0, 277).trim()}…` : line;
}

// Headline is driven by the most severe insight (what the customer should act on),
// falling back to the overall band when nothing needs attention.
function statusHeadline(overallStatus, topIssue) {
  const topic = topIssue ? ISSUE_TOPIC[topIssue.category] : null;
  if (topIssue && topIssue.status === 'needs_attention') return topic ? `Needs attention — ${topic}` : 'Needs attention this visit';
  if (topIssue && topIssue.status === 'watch') return topic ? `Stable — watching ${topic}` : 'Stable — a couple of things to watch';
  if (overallStatus === 'strong') return 'Looking great';
  if (overallStatus === 'healthy') return 'Looking healthy';
  return 'Lawn health tracked';
}

// Cross-signal root cause — a small deterministic decision table that connects the
// separate signals into ONE driver, so the report reads like an expert wrote it.
function buildRootCause({ effectiveWaterStatus, coverageWatch, overwatering, mowing, diagnosis }) {
  const mowShort = mowing && mowing.status === 'too_short';
  const damage = (diagnosis || []).find((c) => c.key === 'damage_disease_signals');
  const damageBad = damage && (damage.status === 'needs_attention' || damage.status === 'watch');
  if (overwatering || effectiveWaterStatus === 'surplus') {
    return 'The main driver looks like too much water — easing back on irrigation should do more for fungus, mushrooms, and weed pressure than any single treatment.';
  }
  if (effectiveWaterStatus === 'deficit' && !coverageWatch) {
    return 'The lawn is simply running a little dry — a bit more even watering is the highest-impact fix right now.';
  }
  if (coverageWatch && mowShort) {
    return 'The dry-looking areas are most likely uneven sprinkler coverage plus mowing a notch too short — not the whole lawn needing more water.';
  }
  if (coverageWatch) {
    return 'Total water is on target, so the lighter areas point to uneven sprinkler coverage rather than the lawn needing more water overall.';
  }
  if (mowShort && damageBad) {
    return 'Short mowing is likely amplifying heat and stress in the thinner areas — raising the cut height should help them recover.';
  }
  if (damageBad) {
    return 'We’re watching a few stress patterns; the cause isn’t confirmed yet, so we’ll compare them against today’s photos next visit before treating.';
  }
  return null;
}

// Aftercare watering/re-entry from the manufacturer LABEL on the applied products.
// Surfaces a real label watering-in note when present; otherwise a safe default that
// invents no number. Re-entry text comes from the label when available.
function buildAftercare(applications) {
  const apps = Array.isArray(applications) ? applications : [];
  let watering = null;
  let reentry = null;
  for (const a of apps) {
    const p = (a && a.product) || a || {};
    const facts = (a && a.approved_report_product_facts) || {};
    if (!watering) watering = (p.irrigation_notes || facts.irrigationNotes || '').trim() || null;
    if (!reentry) reentry = (p.reentry_text || p.reentry_summary || facts.reentrySummary || '').trim() || null;
  }
  if (!watering) {
    watering = 'No special watering is needed because of today’s treatment — keep your normal schedule unless your technician advised otherwise.';
  }
  return { watering, reentry };
}

// Short topic phrase for the headline, from the top issue card's category.
const ISSUE_TOPIC = {
  water: 'watering', weeds: 'weed pressure', damage: 'a few stress areas',
  coverage: 'thin areas', mowing: 'mowing height', customer_concern: 'what you flagged',
};

/**
 * @param {object} input
 * @param {object} input.lawnAssessment  buildLawnAssessmentReportData(...) return
 * @param {object} [input.mowingHeight]  buildMowingHeightContext(...) return
 * @param {string} [input.customerConcern]
 * @returns {object|null} { snapshot, diagnosis, insights, water, mowing, trends } | null
 */
function buildLawnReportV2({ lawnAssessment, mowingHeight = null, applications = [], actions = [], customerConcern = '', waterSnapshot = null } = {}) {
  if (!lawnAssessment) return null;
  const scores = lawnAssessment.scores || {};
  const grassLabel = grassLabelFor(lawnAssessment.turfProfile?.grassType);
  const advice = lawnAssessment.waterContext?.irrigationAdvice || {};

  const water = mapWater(lawnAssessment.waterContext, waterSnapshot);
  // Unify the water status the diagnosis + insights reason about: prefer the
  // area snapshot (high/low/balanced) mapped to the advice vocabulary, else the
  // live irrigation-advice status.
  const usingSnapshot = !!(waterSnapshot && waterSnapshot.status && waterSnapshot.status !== 'unknown');
  const SNAP_TO_ADVICE = { high: 'surplus', low: 'deficit', balanced: 'balanced' };
  const effectiveWaterStatus = usingSnapshot ? SNAP_TO_ADVICE[waterSnapshot.status] : (advice.status || null);
  const overwatering = !!lawnAssessment.overwateringSignal || (usingSnapshot && waterSnapshot.interpretation === 'wet_condition_watch');

  const categories = buildVisualDiagnosisCategories({
    scores,
    overwateringSignal: overwatering,
    waterStatus: effectiveWaterStatus,
    grassLabel,
  });

  // ── Season-aware dormancy guard ────────────────────────────────────────────
  // Applied to `categories` BEFORE the diagnosis/insights/snapshot derive, so a
  // cool-stretch low-color reading is framed as seasonal EVERYWHERE — not surfaced
  // as a needs-attention hero/insight that contradicts the "seasonal" card copy.
  const assessMonth = lawnAssessment.assessmentDate ? (new Date(lawnAssessment.assessmentDate).getMonth() + 1) : null;
  const dormancy = dormancyLikely({ colorHealth: scores.colorHealth, stressDamage: scores.stressDamage, month: assessMonth });
  if (dormancy.likely) {
    const colorCat = categories.find((c) => c.key === 'color_vigor');
    if (colorCat && (colorCat.status === 'watch' || colorCat.status === 'needs_attention')) {
      // Seasonally-expected low color is not a problem — demote it out of the issue
      // set and reframe the copy. (Raw color score is unchanged, so the overall
      // score stays honest.)
      colorCat.status = 'healthy';
      colorCat.seasonal = true;
      colorCat.customerExplanation = 'Color is a little muted right now, which is normal for this cooler stretch — your lawn should green back up as it warms.';
    }
  }

  // Client VisualDiagnosisCards reads `explanation`; keep customerExplanation too.
  const diagnosis = categories.map((c) => ({ ...c, explanation: c.customerExplanation }));

  // ── Consistency: water AMOUNT vs COVERAGE ──────────────────────────────────
  // A balanced/high weekly amount can still hide a localized dry/uneven area seen
  // in the photos. When the photo analysis mentions dry/drought/uneven/coverage,
  // the Water row must NOT read "Strong" — downgrade it to a coverage "watch" so it
  // never contradicts the photo caption (the report's biggest trust bug).
  const obsText = `${lawnAssessment.observations || ''} ${lawnAssessment.aiSummary || ''}`.toLowerCase();
  // MOISTURE-specific signals only (not generic "stress", which can be heat/insect).
  const drySignal = /\b(dry|drought|tan|uneven|irrigation|coverage|wilt|moisture)\b/.test(obsText);
  // The Water/Coverage score is derived from fungus/over-water signals and ignores
  // drought — so a dry/uneven photo read must downgrade it regardless of the weekly
  // amount (this is the "95 Strong vs photo says drought" contradiction).
  const coverageWatch = drySignal && effectiveWaterStatus !== 'deficit';
  const waterCat = diagnosis.find((c) => c.key === 'water_moisture_stress');
  if (waterCat && drySignal && (waterCat.status === 'strong' || waterCat.status === 'healthy')) {
    waterCat.status = 'watch';
    waterCat.score = Math.min(num(waterCat.score) ?? 62, 62);
    waterCat.customerExplanation = coverageWatch
      ? 'Total weekly water looks adequate, but a few areas look dry or uneven — worth checking that your sprinklers reach them evenly.'
      : 'A few areas look dry — the lawn may benefit from a bit more even watering.';
    waterCat.explanation = waterCat.customerExplanation;
  }
  if (water) water.coverageWatch = coverageWatch;

  const mowing = mapMowing(mowingHeight, grassLabel);
  const treatment = buildTreatment({ applications, actions });

  const insights = buildLawnInsightCards({
    categories,
    water: water ? {
      ...water,
      overwatering,
      status: effectiveWaterStatus,
      // A balanced total with a localized dry read → coverage, not "water more".
      localizedDry: coverageWatch || (usingSnapshot && waterSnapshot.interpretation === 'coverage_issue_possible'),
    } : {},
    mowing,
    grassLabel,
    customerConcern,
    treatmentKinds: treatment ? treatment.kinds : [],
  });

  // Field photos for the horizontal strip (best photo first), plus ONE consolidated
  // analysis across all photos (the composite single-voice observation / customer
  // summary) — NOT the per-photo vision blurbs, which can over-diagnose ("infestation").
  const allPhotos = Array.isArray(lawnAssessment.photos) ? lawnAssessment.photos.filter((p) => p && p.url) : [];
  const photoList = [...allPhotos]
    .sort((a, b) => (b.isBest ? 1 : 0) - (a.isBest ? 1 : 0) || (Number(b.qualityScore) || 0) - (Number(a.qualityScore) || 0))
    .slice(0, 6)
    .map((p) => ({ url: p.url, label: p.isBest ? 'Best view' : (p.zone || null) }));
  const photoSummary = String(
    lawnAssessment.observations || lawnAssessment.aiSummary || lawnAssessment.customerSummary || '',
  ).trim() || null;
  const heroPhoto = photoList[0] || null;

  const overallScore = num(scores.overallScore);
  const status = scoreStatus(overallScore);
  const issues = insights.filter((i) => i.status === 'needs_attention' || i.status === 'watch');
  const topIssue = issues[0] || null;

  // "Why 68": name the category dragging the score down, reassure on the rest.
  const scored = diagnosis.filter((c) => Number.isFinite(num(c.score)));
  const lowest = scored.slice().sort((a, b) => num(a.score) - num(b.score))[0];
  const scoreExplanation = (lowest && num(lowest.score) < 60 && scored.length > 2)
    ? `Your lawn is stable overall — the score is mainly pulled down by ${lowest.label.toLowerCase()}, while the other areas are generally in a healthy range.`
    : null;

  // Action OWNERSHIP: customerAction is a REAL homeowner task only — never a Waves
  // next-visit task. wavesNext carries what Waves will do. No customer task → "no action".
  const realCustomerAction = topIssue ? (topIssue.customerAction || null) : null;
  const wavesNext = topIssue ? (topIssue.nextVisitPlan || topIssue.wavesAction || null) : null;

  // Cross-signal ROOT CAUSE: connect water + coverage + mowing + stress into one
  // explanation instead of leaving the customer to reconcile separate cards.
  const rootCause = buildRootCause({ effectiveWaterStatus, coverageWatch, overwatering, mowing, diagnosis });
  const seasonalNote = buildSeasonalNote(lawnAssessment, grassLabel);

  const snapshot = {
    overallScore,
    status,
    statusHeadline: statusHeadline(status, topIssue),
    scoreExplanation,
    rootCause,
    seasonalNote,
    todaysFocus: treatment ? treatment.focus : [],
    watching: issues.slice(0, 3).map((i) => i.headline), // "main things we're watching"
    mainWatch: topIssue ? (topIssue.whatWeSaw || topIssue.headline) : null,
    wavesNext,
    customerAction: realCustomerAction,
    noActionNeeded: !realCustomerAction,
  };

  // (Season-aware dormancy guard is applied above — before diagnosis/insights/snapshot
  // derive — so the seasonal reframing reaches the hero + insights, not just the card.)

  const smsSummary = buildSmsSummary(snapshot, grassLabel);
  const beforeAfter = buildBeforeAfter(lawnAssessment);
  // Cross-season comparison note: a winter-vs-summer wipe/trend shouldn't read as decline.
  const progressionNote = (lawnAssessment.beforeAfter && lawnAssessment.beforeAfter.before && lawnAssessment.beforeAfter.after)
    ? crossSeasonNote(lawnAssessment.beforeAfter.before.date, lawnAssessment.beforeAfter.after.date)
    : null;
  const trendRows = Array.isArray(lawnAssessment.trend) ? lawnAssessment.trend : [];
  const trendSeasonNote = trendRows.length >= 2
    ? crossSeasonNoteFromSeasons(trendRows[0].season, trendRows[trendRows.length - 1].season)
    : null;
  // Chronological progression frames for the swipeable slider. Currently the two
  // dated captures we can back (before + current); extends to N when a per-visit
  // photo history is wired. Oldest → newest.
  const progression = beforeAfter
    ? [
      { label: beforeAfter.before.label, url: beforeAfter.before.url, score: beforeAfter.before.score },
      { label: beforeAfter.after.label, url: beforeAfter.after.url, score: beforeAfter.after.score },
    ]
    : null;
  const aftercare = buildAftercare(applications);

  const trends = buildTrends(lawnAssessment, mowingHeight);
  if (trendSeasonNote) trends.seasonalNote = trendSeasonNote;

  return {
    snapshot, diagnosis, insights, water, mowing, treatment, heroPhoto, photos: photoList, photoSummary,
    beforeAfter, progression, progressionNote, aftercare, seasonalNote, smsSummary, trends,
  };
}

module.exports = { buildLawnReportV2, grassLabelFor };
