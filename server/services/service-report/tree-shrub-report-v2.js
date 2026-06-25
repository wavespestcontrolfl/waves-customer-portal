/**
 * Tree & Shrub Report V2 — aggregator.
 *
 * Mirrors lawn-report-v2.js: the single integration surface between the
 * tree-shrub plant-health assessment and the V2 client components. report-data.js
 * calls this and attaches the result as `reportV2` on a tree_shrub report payload,
 * behind the TREE_SHRUB_REPORT_V2 flag.
 *
 * Positioning (Task purpose): Waves is not just treating shrubs and ornamentals —
 * we are MONITORING the health of the landscape plants and watching for issues
 * before they become bigger problems. So the report leads with overall landscape
 * plant health + a peace-of-mind line, surfaces the five photo-diagnosis categories,
 * and (Phase 2) organizes findings by plant group / zone.
 *
 * Pure + deterministic. No new model calls; consumes scores/photos/observations the
 * assessment already produced. Landscape water context is intentionally SOFTER than
 * the lawn report (beds may use spray, drip, micro-spray, bubblers, or hand watering).
 */

const { buildTreeShrubVisualCategories, scoreStatus } = require('./tree-shrub-visual-categories');
const { buildTreeShrubInsightCards } = require('./tree-shrub-report-insights');

// Classify an applied product into a customer-facing purpose. Prefers the catalog's
// approved report summary; falls back to category/active-ingredient heuristics. `kind`
// lets insight copy reference the right solution deterministically. Accepts both the
// FINAL report applications shape ({ product: {...}, targets, ... }) and the raw
// service_products shape.
function classifyProduct(app = {}) {
  const p = app.product || {};
  const facts = app.approved_report_product_facts || {};
  const category = p.category || app.product_category || facts.category || '';
  const ai = p.active_ingredient || app.active_ingredient || facts.activeIngredient || '';
  const name = p.name || app.product_name || facts.name || '';
  const hay = `${category} ${ai} ${name}`.toLowerCase();
  let kind = 'other';
  let tag = 'plant treatment';
  let fallback = 'applied as part of today’s tree and shrub program';
  if (/fung|azoxy|propiconazole|thiophanate|mancozeb|chlorothalonil/.test(hay)) { kind = 'fungicide'; tag = 'disease protection'; fallback = 'helps protect foliage where leaf-spot or disease pressure calls for it'; }
  else if (/mite|abamectin|bifenazate|spiromesifen/.test(hay)) { kind = 'miticide'; tag = 'mite control'; fallback = 'targets mites that stipple and bronze the foliage'; }
  else if (/imidacloprid|dinotefuran|acephate|insect|bifenthrin|systemic|merit|safari/.test(hay)) { kind = /imidacloprid|dinotefuran|systemic|merit|safari/.test(hay) ? 'systemic' : 'insecticide'; tag = 'pest protection'; fallback = 'protects the plants from foliage-feeding pests'; }
  else if (/iron|micro|biostim|humic|kelp|seaweed|chelat/.test(hay)) { kind = 'supplement'; tag = 'color support'; fallback = 'supports leaf color and stress tolerance'; }
  else if (/fert|nitrogen|urea|potash|\b\d{1,2}-\d{1,2}-\d{1,2}\b/.test(hay)) { kind = 'fertilizer'; tag = 'color & growth'; fallback = 'feeds the plants to support color, density, and new growth'; }
  const whatItDoes = p.service_report_summary || p.public_summary || facts.serviceReportSummary || facts.publicSummary || fallback;
  return { kind, tag, whatItDoes };
}

// Defense-in-depth on the ONE free-text path that reaches the customer (the photo
// summary, from the vision model's observations). The five-category diagnosis +
// insight copy are deterministic templates, but the LLM paragraph could in theory
// over-claim despite the prompt. Drop it if it asserts a CONFIRMED pest/disease —
// the report still reads fully from the deterministic "signals" copy. This enforces
// the feature's core guardrail (signals, never "infestation"/"diseased").
const BANNED_CONFIRMED = /\b(infestation|infested|infection|infected|diseased|confirmed\s+(pest|disease|infestation|fungus)|(has|have|with)\s+(a\s+|an\s+)?([a-z-]+\s+){0,2}(disease|infestation|infection)|is\s+(infested|infected|diseased))\b/i;
function scrubObservations(value) {
  const t = String(value || '').trim();
  if (!t) return null;
  return BANNED_CONFIRMED.test(t) ? null : t;
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const uniq = (arr) => [...new Set(arr.filter(Boolean))];
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round1 = (v) => (v == null ? '' : String(Number(Number(v).toFixed(1))));

function monthLabel(date) {
  if (!date) return '';
  // A DATE column / 'YYYY-MM-DD' string parses as UTC midnight; formatting that in ET
  // would show the PREVIOUS day. Anchor date-only values at noon UTC first so the ET
  // label lands on the correct calendar day (matches the lawn V2 / report-data pattern).
  const s = String(date);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  const d = m ? new Date(`${m[1]}T12:00:00Z`) : new Date(date);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

// "What Waves did" — solutions/products applied, in plain language, plus focus tags.
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

// Landscape water context → softer customer copy (vs lawn's whole-yard framing).
function landscapeWaterExplanation(snap) {
  const t = snap.target_water_inches_per_week != null ? `~${round1(snap.target_water_inches_per_week)}"/wk` : 'what the planting needs';
  const rain = snap.adjusted_rain_7day_inches != null ? snap.adjusted_rain_7day_inches : snap.rain_7day_inches;
  const rainLine = rain != null ? `Your area received about ${round1(rain)}" of rain this week. ` : '';
  switch (snap.interpretation) {
    case 'wet_condition_watch':
      return `${rainLine}Based on the irrigation profile on file, the beds may be staying a little wet. Easing back in that area should help reduce leaf-spot and root stress.`;
    case 'coverage_issue_possible':
      return `${rainLine}Your area did receive rain this week, so a dry-looking shrub group may point to coverage in that specific bed rather than the whole property needing more water.`;
    case 'water_deficit_likely':
      return `${rainLine}Water support looks a little light for the planting — a bit more in that area should help the shrubs handle the heat.`;
    case 'irrigation_unknown':
      return `Based on the irrigation profile on file, water support appears reasonable. We’ll keep monitoring coverage by area.`;
    default:
      return `${rainLine}Based on the irrigation profile on file, water support appears reasonable. Since any issue is isolated to one shrub group, we will monitor coverage in that area.`;
  }
}

const SNAP_STATUS = { low: 'deficit', high: 'surplus', balanced: 'balanced', unknown: 'unknown' };

// Optional landscape water snapshot → client water card. Returns null when there is
// no real reading (Phase 1 commonly has none — the card simply hides).
function mapWater(waterSnapshot = null) {
  if (!waterSnapshot || !waterSnapshot.status || waterSnapshot.status === 'unknown') return null;
  const rain = waterSnapshot.adjusted_rain_7day_inches != null ? waterSnapshot.adjusted_rain_7day_inches : waterSnapshot.rain_7day_inches;
  return {
    rainInches: num(rain),
    irrigationInches: num(waterSnapshot.irrigation_inches_per_week),
    totalInches: num(waterSnapshot.total_water_7day_inches),
    targetInches: num(waterSnapshot.target_water_inches_per_week),
    irrigationType: waterSnapshot.irrigation_type || null,
    status: SNAP_STATUS[waterSnapshot.status] || 'unknown',
    confidence: waterSnapshot.confidence || 'medium',
    explanation: landscapeWaterExplanation(waterSnapshot),
    source: 'landscape_snapshot',
  };
}

// Plant groups / zone cards (Phase 2). Normalize whatever the assessment provides;
// keep only entries with a label. Never asserts a confirmed pest/disease.
function buildPlantGroups(plantGroups) {
  if (!Array.isArray(plantGroups)) return [];
  return plantGroups
    .filter((g) => g && (g.label || g.name))
    .map((g) => ({
      key: g.key || String(g.label || g.name).toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      label: g.label || g.name,
      status: ['healthy', 'stable', 'watch', 'needs_attention'].includes(g.status) ? g.status : 'stable',
      finding: g.finding || null,
      wavesAction: g.wavesAction || null,
      confirmedByTech: !!g.confirmedByTech,
    }));
}

// Per-category trends from the assessment history (2+ distinct visits required).
function dedupeTrend(points) {
  const out = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev && prev.label === p.label) { out[out.length - 1] = p; continue; }
    out.push(p);
  }
  return out;
}
function seriesFrom(trend, field) {
  return dedupeTrend(trend
    .map((t) => ({ label: monthLabel(t.date), value: num(t[field]) }))
    .filter((p) => p.value !== null));
}
function buildTrends(assessment) {
  const trend = Array.isArray(assessment?.trend) ? assessment.trend : [];
  const out = {};
  const add = (key, series) => { if (series.length >= 2) out[key] = series; };
  add('overall', seriesFrom(trend, 'overallScore'));
  add('foliage', seriesFrom(trend, 'foliageFullness'));
  add('color', seriesFrom(trend, 'leafColorVigor'));
  add('pest', seriesFrom(trend, 'pestActivity'));
  add('water', seriesFrom(trend, 'waterHeatStress'));
  return out;
}

// Short topic phrase for the headline, from the top issue card's category.
const ISSUE_TOPIC = {
  pest_pressure: 'light pest pressure',
  disease_leaf_spot: 'leaf-spot signals',
  water_stress: 'water and heat stress',
  color_vigor: 'color and fullness',
  plant_group: 'one plant group',
  customer_concern: 'what you flagged',
};

// Headline is driven by the most severe insight, falling back to the overall band.
function statusHeadline(overallStatus, topIssue) {
  const topic = topIssue ? ISSUE_TOPIC[topIssue.category] : null;
  if (topIssue && topIssue.status === 'needs_attention') return topic ? `Needs attention — ${topic}` : 'Needs attention this visit';
  if (topIssue && topIssue.status === 'urgent') return topic ? `Action needed — ${topic}` : 'Action needed this visit';
  if (topIssue && topIssue.status === 'watch') return topic ? `Healthy — monitoring ${topic}` : 'Healthy — a couple of things to watch';
  if (overallStatus === 'strong') return 'Landscape looking great';
  if (overallStatus === 'healthy') return 'Landscape looking healthy';
  return 'Plant health tracked';
}

function buildSmsSummary(snapshot) {
  if (!snapshot) return null;
  const head = String(snapshot.statusHeadline || '').replace(/\s*—\s*/g, ' — ');
  const action = snapshot.customerAction
    ? ` ${snapshot.customerAction.replace(/\.$/, '')}.`
    : (snapshot.noActionNeeded ? ' No action needed on your end.' : '');
  const line = `Your tree & shrub report is ready: ${head.charAt(0).toLowerCase()}${head.slice(1)}.${action}`;
  return line.length > 280 ? `${line.slice(0, 277).trim()}…` : line;
}

/**
 * @param {object} input
 * @param {object} input.treeShrubAssessment  { assessmentDate, scores:{ foliageFullness,
 *   leafColorVigor, pestActivity, diseaseLeafSpot, waterHeatStress, overallScore },
 *   observations|aiSummary|customerSummary, photos:[{url,zone,isBest,qualityScore,caption}],
 *   plantGroups:[...], trend:[{date,overallScore,...}],
 *   techConfirmedPest?, techConfirmedDisease? }
 * @param {Array}  [input.applications]
 * @param {Array}  [input.actions]
 * @param {string} [input.customerConcern]
 * @param {object} [input.waterSnapshot]  landscape water snapshot (Phase 3) | null
 * @returns {object|null}
 */
function buildTreeShrubReportV2({
  treeShrubAssessment,
  applications = [],
  actions = [],
  customerConcern = '',
  waterSnapshot = null,
} = {}) {
  if (!treeShrubAssessment) return null;
  const scores = treeShrubAssessment.scores || {};

  const categories = buildTreeShrubVisualCategories({
    scores,
    techConfirmedPest: !!treeShrubAssessment.techConfirmedPest,
    techConfirmedDisease: !!treeShrubAssessment.techConfirmedDisease,
  });
  // Client cards read `explanation`; keep customerExplanation too.
  const diagnosis = categories.map((c) => ({ ...c, explanation: c.customerExplanation }));

  const water = mapWater(waterSnapshot);

  // ── Consistency: a dry/uneven photo read downgrades the water/stress row so it
  // never contradicts the photo caption. Landscape-soft: mark it as localized
  // coverage (one area), not a whole-property "water more".
  const obsText = `${treeShrubAssessment.observations || ''} ${treeShrubAssessment.aiSummary || ''}`.toLowerCase();
  // Per-SENTENCE so a negated/no-issue sentence ("no dry margins, wilt, or moisture
  // stress observed") doesn't read as a dry signal and falsely downgrade a clean visit.
  const DRY_RE = /\b(dry|drought|crispy|wilt|scorch|uneven|coverage|moisture)\b/;
  const NEG_RE = /\b(no|not|never|none|without)\b|n['’]t|free of/;
  const drySignal = obsText.split(/[.!?]+/).some((sent) => DRY_RE.test(sent) && !NEG_RE.test(sent));
  const localizedDry = drySignal && (!water || water.status !== 'deficit');
  const stressCat = diagnosis.find((c) => c.key === 'water_heat_mechanical_stress');
  if (stressCat && drySignal && (stressCat.status === 'strong' || stressCat.status === 'healthy')) {
    stressCat.status = 'watch';
    stressCat.score = Math.min(num(stressCat.score) ?? 62, 62);
    stressCat.customerExplanation = 'A few plants look dry or stressed — worth checking that the beds in that area get even water.';
    stressCat.explanation = stressCat.customerExplanation;
  }
  if (water) water.localizedDry = localizedDry;

  const treatment = buildTreatment({ applications, actions });
  const plantGroups = buildPlantGroups(treeShrubAssessment.plantGroups);

  const insights = buildTreeShrubInsightCards({
    categories,
    water: water ? { ...water, localizedDry } : (localizedDry ? { localizedDry: true } : {}),
    plantGroups,
    customerConcern,
    treatmentKinds: treatment ? treatment.kinds : [],
  });

  // Photos for the strip (best first) + ONE consolidated summary (never the
  // per-photo vision blurbs, which can over-diagnose).
  const allPhotos = Array.isArray(treeShrubAssessment.photos) ? treeShrubAssessment.photos.filter((p) => p && p.url) : [];
  const photos = [...allPhotos]
    .sort((a, b) => (b.isBest ? 1 : 0) - (a.isBest ? 1 : 0) || (Number(b.qualityScore) || 0) - (Number(a.qualityScore) || 0))
    .slice(0, 6)
    // Captions are the OTHER customer-visible free-text path (set at closeout / typed
    // completion) — run them through the same over-claim scrub as the photo summary so
    // a caption like "confirmed scale infestation" can't bypass the signals guardrail.
    .map((p) => ({ url: p.url, label: p.label || (p.isBest ? 'Best view' : (p.zone || null)), caption: scrubObservations(p.caption) }));
  const photoSummary = scrubObservations(
    treeShrubAssessment.observations || treeShrubAssessment.aiSummary || treeShrubAssessment.customerSummary || '',
  );
  const heroPhoto = photos[0] || null;

  const overallScore = num(scores.overallScore);
  const status = scoreStatus(overallScore);
  const issues = insights.filter((i) => i.status === 'needs_attention' || i.status === 'watch' || i.status === 'urgent');
  const topIssue = issues[0] || null;

  // "Why NN": name the category dragging the score down, reassure on the rest — but
  // ONLY when the landscape really is stable overall (healthy band) and a SINGLE
  // category is low. For a genuinely poor visit (low overall / several low categories)
  // this reassurance would contradict the "Needs attention" headline, so suppress it.
  const scored = diagnosis.filter((c) => Number.isFinite(num(c.score)));
  const lowCats = scored.filter((c) => num(c.score) < 60);
  const scoreExplanation = (overallScore != null && overallScore >= 70 && lowCats.length === 1 && scored.length > 2)
    ? `Your landscape is stable overall — the score is mainly pulled down by ${lowCats[0].label.toLowerCase()}, while the other areas are generally in a healthy range.`
    : null;

  // Action OWNERSHIP: customerAction is a REAL homeowner task only.
  const realCustomerAction = topIssue ? (topIssue.customerAction || null) : null;
  const wavesNext = topIssue ? (topIssue.nextVisitPlan || topIssue.wavesAction || null) : null;

  // Peace-of-mind line (Task layout §1). Honest: monitoring count, no urgency unless real.
  const monitorCount = issues.length;
  const hasUrgent = insights.some((i) => i.status === 'urgent' || i.status === 'needs_attention');
  const peaceOfMind = hasUrgent
    ? `We found ${monitorCount} item${monitorCount === 1 ? '' : 's'} to address today and completed treatment for ${monitorCount === 1 ? 'it' : 'them'}.`
    : monitorCount > 0
      ? `No urgent plant decline was found today. We noted ${monitorCount} item${monitorCount === 1 ? '' : 's'} to monitor and will recheck ${monitorCount === 1 ? 'it' : 'them'} on future visits.`
      : 'No urgent plant decline was found today. Your scheduled treatment is complete and your landscape plants are protected.';

  const snapshot = {
    overallScore,
    status,
    statusHeadline: statusHeadline(status, topIssue),
    scoreExplanation,
    peaceOfMind,
    todaysFocus: treatment ? treatment.focus : [],
    watching: issues.slice(0, 3).map((i) => i.headline),
    mainWatch: topIssue ? (topIssue.whatWeSaw || topIssue.headline) : null,
    wavesNext,
    customerAction: realCustomerAction,
    noActionNeeded: !realCustomerAction,
  };

  const smsSummary = buildSmsSummary(snapshot);
  const trends = buildTrends(treeShrubAssessment);

  return {
    snapshot,
    diagnosis,
    insights,
    plantGroups,
    water,
    treatment,
    heroPhoto,
    photos,
    photoSummary,
    trends,
    smsSummary,
  };
}

module.exports = { buildTreeShrubReportV2, classifyProduct };
