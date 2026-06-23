/**
 * Tree & Shrub Report V2 — five customer-facing photo-diagnosis categories.
 *
 * Mirrors lawn-visual-diagnosis.js: the plant-health assessment (tree-shrub
 * vision scorer) returns granular display scores; the customer report shows only
 * FIVE simple categories. This maps those scores → the five spec categories with
 * customer-safe status words and plain-language explanations.
 *
 * Every score is a "health" reading (higher = healthier / fewer problem signals),
 * so a LOW pest-activity score means MORE visible pest pressure (a "Watch"), and a
 * HIGH disease score means few leaf-spot signals (a "Strong"). This keeps the bars
 * consistent with the lawn report's direction.
 *
 * HARD GUARDRAILS (categories 3 and 4 especially): the photo AI flags a PATTERN /
 * SIGNAL, never a confirmed diagnosis. We say "pest-pressure signals" — never
 * "infestation"/"confirmed pests"; "leaf-spot signals"/"disease-like symptoms" —
 * never "diseased"/"confirmed disease" — unless a tech or protocol result confirms
 * it. A null/unknown score reads "Tracking", never 0 (the Number(null) === 0 trap).
 */

function toScore(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Status bands — MUST match the client (scoreStatus) and the lawn report (85/70/55).
function scoreStatus(value) {
  const n = toScore(value);
  if (n === null) return 'tracking';
  if (n >= 85) return 'strong';
  if (n >= 70) return 'healthy';
  if (n >= 55) return 'watch';
  return 'needs_attention';
}

// Plain-language explanation per (category, band). Deterministic — no LLM — so the
// customer copy can't drift or overclaim. The pest and disease rows say SIGNALS only.
function explain(categoryKey, band) {
  const T = {
    foliage_fullness: {
      strong: 'Full, dense canopy with healthy growth and no bare areas.',
      healthy: 'Good fullness overall with only minor thin spots.',
      watch: 'Some thin or sparse areas are starting to show in the canopy.',
      needs_attention: 'Noticeable bare stems or hedge gaps we want to help rebuild.',
    },
    leaf_color_vigor: {
      strong: 'Vibrant, even leaf color with healthy new growth.',
      healthy: 'Healthy, fairly even color across the plants.',
      watch: 'Color is a little uneven, pale, or off in places.',
      needs_attention: 'Yellowing, bronzing, or leaf scorch that needs support.',
    },
    // Category 3 — SIGNALS, never a confirmed pest. Never "infestation".
    pest_activity: {
      strong: 'No visible pest-pressure signals on the foliage today.',
      healthy: 'Little to no pest-pressure signals visible today.',
      watch: 'Light pest-pressure signals on some foliage — worth monitoring.',
      needs_attention: 'Visible pest-pressure signals we treated today and will keep monitoring.',
    },
    // Category 4 — SIGNALS / disease-like symptoms, never "diseased".
    disease_leaf_spot: {
      strong: 'No leaf-spot or disease-like signals visible today.',
      healthy: 'No clear leaf-spot signals to monitor right now.',
      watch: 'A few leaf-spot or disease-like signals worth keeping an eye on.',
      needs_attention: 'Leaf-spot signals we want to monitor and confirm next visit.',
    },
    water_heat_mechanical_stress: {
      strong: 'No water, heat, or pruning stress showing on the plants.',
      healthy: 'Plants look comfortable — little sign of water or heat stress.',
      watch: 'Some dry margins, wilt, or pruning stress worth watching.',
      needs_attention: 'Visible stress — dry margins, scorch, or over-pruning to address.',
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
 * @param {object} input.scores  camelCase display scores from the tree-shrub assessment:
 *                                { foliageFullness, leafColorVigor, pestActivity,
 *                                  diseaseLeafSpot, waterHeatStress }
 *                                Each is a 0-100 "health" reading (higher = healthier).
 * @param {boolean} [input.techConfirmedPest]     a tech confirmed a pest finding (raises confidence)
 * @param {boolean} [input.techConfirmedDisease]  a tech confirmed a disease finding (raises confidence)
 * @returns {Array} five TreeShrubVisualCategory
 */
function buildTreeShrubVisualCategories({
  scores = {},
  techConfirmedPest = false,
  techConfirmedDisease = false,
} = {}) {
  const s = scores || {};
  const foliage = toScore(s.foliageFullness);
  const color = toScore(s.leafColorVigor);
  const pest = toScore(s.pestActivity);
  const disease = toScore(s.diseaseLeafSpot);
  const stress = toScore(s.waterHeatStress);

  const mk = (key, label, score, confidence = 'ai_supported', evidence = []) => {
    const status = scoreStatus(score);
    return {
      key,
      label,
      score: toScore(score),
      status,
      confidence,
      customerExplanation: explain(key, bandOf(status)),
      evidence,
    };
  };

  return [
    mk('foliage_fullness', 'Foliage Fullness', foliage),
    mk('leaf_color_vigor', 'Leaf Color & Vigor', color),
    mk('pest_activity', 'Pest Activity Signals', pest, techConfirmedPest ? 'tech_confirmed' : 'ai_supported'),
    mk('disease_leaf_spot', 'Disease / Leaf Spot Signals', disease, techConfirmedDisease ? 'tech_confirmed' : 'ai_supported'),
    mk('water_heat_mechanical_stress', 'Water, Heat & Pruning Stress', stress),
  ];
}

module.exports = { buildTreeShrubVisualCategories, scoreStatus, toScore };
