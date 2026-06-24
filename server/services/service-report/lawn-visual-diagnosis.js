/**
 * Lawn Report V2 — five customer-facing photo-diagnosis categories.
 *
 * The dual-vision scorer (lawn-assessment.js: Gemini 3.5 Flash + Claude Sonnet)
 * returns granular display scores + signals. The customer report shows only FIVE
 * simple categories. This maps the granular fields → those five, with customer-safe
 * status words and plain-language explanations.
 *
 * HARD RULE (category 5 especially): photo AI flags a PATTERN, never a confirmed
 * diagnosis. We say "signals"/"patterns", never "diseased"/"chinch bugs"/"infestation"
 * unless a tech or protocol result confirms it. A null/unknown score reads "Tracking",
 * never 0 (the Number(null) === 0 trap — see lawnScoreValue / PR #1907).
 */

// Status bands — MUST match the client (scoreStatus) and V1 lawnScoreLabel (85/70/55).
function toScore(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function scoreStatus(value) {
  const n = toScore(value);
  if (n === null) return 'tracking';
  if (n >= 85) return 'strong';
  if (n >= 70) return 'healthy';
  if (n >= 55) return 'watch';
  return 'needs_attention';
}

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

// Severity word → 0-100 "health" display (higher = healthier). Mirrors
// lawn-assessment.js FUNGUS_DISPLAY so the water/damage categories agree with the
// scorer's own ramps.
const SEVERITY_DISPLAY = { none: 95, minor: 75, moderate: 50, severe: 20 };

// Plain-language explanation per (category, band). Kept deterministic — no LLM —
// so the customer copy can't drift or overclaim. {detail} slots in named evidence.
function explain(categoryKey, band, ctx = {}) {
  const G = ctx.grassLabel || 'lawn';
  const T = {
    coverage: {
      strong: 'Thick, full turf with no bare spots showing.',
      healthy: 'Good coverage overall with only minor thinning.',
      watch: 'Some thinning or patchiness starting to show.',
      needs_attention: 'Noticeable thin or bare areas we want to rebuild.',
    },
    color_vigor: {
      strong: 'Strong, even green across the lawn.',
      healthy: `Healthy, fairly even color for your ${G}.`,
      watch: 'Color is a little uneven or off in places.',
      needs_attention: 'Yellowing or off-color areas that need support.',
    },
    weed_pressure: {
      strong: 'Very little weed activity visible today.',
      healthy: 'Weeds are well in check.',
      watch: 'Some weed activity is starting to compete with the turf.',
      needs_attention: 'Noticeable weeds competing with the turf.',
    },
    water_moisture_stress: {
      strong: 'Moisture looks well balanced — not too wet, not too dry.',
      healthy: 'Moisture looks reasonable across the lawn.',
      watch: 'Moisture looks a little off — worth keeping an eye on.',
      needs_attention: ctx.overwatering
        ? 'Damp areas and fungal/mushroom signs that point to too much water.'
        : 'Signs of moisture stress — too dry or too wet in places.',
    },
    damage_disease_signals: {
      strong: 'No stress patterns to monitor right now.',
      healthy: 'No clear stress patterns to monitor right now.',
      watch: 'A few stress patterns worth keeping an eye on.',
      needs_attention: 'Stress patterns we want to watch and confirm next visit.',
    },
  };
  const byBand = T[categoryKey] || {};
  const key = band === 'strong' ? 'strong' : band === 'healthy' ? 'healthy' : band === 'watch' ? 'watch' : 'needs_attention';
  return byBand[key] || '';
}

function bandOf(status) {
  return status === 'strong' || status === 'healthy' ? status : status === 'watch' ? 'watch' : 'needs_attention';
}

/**
 * @param {object} input
 * @param {object} input.scores       camelCase display scores from report-data currentScore:
 *                                     { turfDensity, weedSuppression, colorHealth, stressDamage, fungusControl, thatchScore }
 * @param {boolean} input.overwateringSignal  explicit vision overwatering tell
 * @param {string}  input.waterStatus  irrigationAdvice.status ('surplus'|'deficit'|'balanced'|'rain_unknown'|'unknown')
 * @param {string}  input.grassLabel
 * @returns {Array} five VisualDiagnosisCategory
 */
function buildVisualDiagnosisCategories({ scores = {}, overwateringSignal = false, waterStatus = null, grassLabel = 'lawn' } = {}) {
  const s = scores || {};
  const coverage = toScore(s.turfDensity);
  const color = toScore(s.colorHealth);
  const weed = toScore(s.weedSuppression);
  const fungus = toScore(s.fungusControl);
  const damage = toScore(s.stressDamage);

  // Water / moisture: worst (lowest health) of the moisture-driven signals.
  // Over-watering tell and a surplus water balance pull it down; a fungus signal
  // (often wetness-driven) caps it; a deficit reads as moderate dryness.
  const waterCandidates = [
    overwateringSignal ? 40 : 95,
    waterStatus === 'surplus' ? 50 : waterStatus === 'deficit' ? 60 : 95,
    fungus === null ? 95 : fungus,
  ];
  const water = clamp(Math.min(...waterCandidates));

  const mk = (key, label, score, extra = {}) => {
    const status = scoreStatus(score);
    return {
      key,
      label,
      score: toScore(score),
      status,
      confidence: 'ai_supported',
      customerExplanation: explain(key, bandOf(status), { grassLabel, overwatering: overwateringSignal, ...extra }),
      evidence: extra.evidence || [],
    };
  };

  return [
    mk('coverage', 'Turf Coverage', coverage),
    mk('color_vigor', 'Color & Vigor', color),
    mk('weed_pressure', 'Weed Pressure', weed),
    mk('water_moisture_stress', 'Water / Coverage', water, {
      evidence: [
        overwateringSignal ? 'over-watering signs in photos' : null,
        waterStatus === 'surplus' ? 'water balance above target' : null,
        waterStatus === 'deficit' ? 'water balance below target' : null,
      ].filter(Boolean),
    }),
    // Category 5 never asserts a confirmed pest/disease — "signals" only.
    mk('damage_disease_signals', 'Stress / Damage Signals', damage),
  ];
}

module.exports = { buildVisualDiagnosisCategories, scoreStatus, toScore, SEVERITY_DISPLAY };
