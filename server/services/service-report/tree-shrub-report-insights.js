/**
 * Tree & Shrub Report V2 — insight cards (cause → effect → action).
 *
 * Combines the five visual-diagnosis categories + the landscape water context +
 * plant-group findings + the customer's concern into a small, prioritized set of
 * plain-language insights. Deterministic (no LLM) so customer copy can't drift or
 * overclaim. Mirrors lawn-report-insights.js.
 *
 * RULES (baked in):
 *  - Every issue card carries a Waves action AND either a customer action or a
 *    next-visit monitoring plan (Task 6 rule).
 *  - Never say "improving" (that needs trend data — the trend chart owns it).
 *  - Pest/disease are SIGNALS from photos, never a confirmed diagnosis
 *    ("pest-pressure signals" / "leaf-spot signals", never "infestation"/"diseased").
 *  - Landscape water context is SOFTER than lawn: beds may use spray, drip,
 *    micro-spray, bubblers, or hand watering, so never assert a whole-property
 *    watering change off one shrub group — point to coverage in that area.
 */

// Worst first. Card statuses use the tree-shrub spec vocabulary.
const STATUS_RANK = { urgent: 0, needs_attention: 1, watch: 2, stable: 3, good: 4 };

function catByKey(categories, key) {
  return (categories || []).find((c) => c.key === key) || null;
}

// Visual-category status (strong/healthy/watch/needs_attention/tracking) → card status.
function cardStatusFor(catStatus) {
  if (catStatus === 'needs_attention') return 'needs_attention';
  if (catStatus === 'watch') return 'watch';
  return 'stable';
}

/**
 * @param {object} input
 * @param {Array}  input.categories       buildTreeShrubVisualCategories output
 * @param {object} input.water            { status:'surplus'|'deficit'|'balanced'|..., localizedDry } | {}
 * @param {Array}  input.plantGroups      [{ key, label, status, finding }] (Phase 2; [] for now)
 * @param {string} input.customerConcern
 * @param {Array}  input.treatmentKinds   ['fungicide','insecticide','miticide','systemic','fertilizer','supplement']
 * @returns {Array} prioritized TreeShrubInsightCard[]
 */
function buildTreeShrubInsightCards({
  categories = [],
  water = {},
  plantGroups = [],
  customerConcern = '',
  treatmentKinds = [],
} = {}) {
  const cards = [];
  const has = (kind) => Array.isArray(treatmentKinds) && treatmentKinds.includes(kind);

  // ── Pest-pressure SIGNALS (never a confirmed pest) ─────────────────────────────
  const pest = catByKey(categories, 'pest_activity');
  if (pest && (pest.status === 'watch' || pest.status === 'needs_attention')) {
    const confirmed = pest.confidence === 'tech_confirmed';
    cards.push({
      category: 'pest_pressure',
      status: cardStatusFor(pest.status),
      confidence: confirmed ? 'tech_confirmed' : 'ai_supported',
      headline: pest.status === 'needs_attention'
        ? 'Pest-pressure signals to stay ahead of'
        : 'Light pest-pressure signals to monitor',
      whatWeSaw: confirmed
        ? 'Visible pest activity on some foliage, confirmed during the visit.'
        : 'Visible pest-pressure signals on some foliage (chewing, stippling, or residue).',
      whyItMatters: 'Catching pest pressure early keeps it from spreading across the planting.',
      wavesAction: has('insecticide') || has('miticide')
        ? 'Treated the affected foliage today and built follow-up monitoring into the plan.'
        : 'Documented the area and will continue protective monitoring.',
      nextVisitPlan: 'Recheck the affected foliage next visit to confirm the signals are easing.',
    });
  }

  // ── Disease / leaf-spot SIGNALS (never a confirmed disease) ────────────────────
  const disease = catByKey(categories, 'disease_leaf_spot');
  if (disease && (disease.status === 'watch' || disease.status === 'needs_attention')) {
    const confirmed = disease.confidence === 'tech_confirmed';
    cards.push({
      category: 'disease_leaf_spot',
      status: cardStatusFor(disease.status),
      confidence: confirmed ? 'tech_confirmed' : 'ai_supported',
      headline: 'A few leaf-spot signals to monitor',
      whatWeSaw: 'Some leaf-spot or disease-like signals on the foliage that we want to keep an eye on.',
      whyItMatters: 'Tracking leaf-spot signals early lets us confirm the cause before it spreads.',
      wavesAction: has('fungicide')
        ? 'Applied a protective treatment and documented the areas for comparison next visit.'
        : 'Documented the areas for comparison next visit.',
      nextVisitPlan: 'Recheck these leaves next visit to confirm what is driving the signals.',
    });
  }

  // ── Landscape water / heat stress (softer than lawn) ───────────────────────────
  const waterCat = catByKey(categories, 'water_heat_mechanical_stress');
  if (water && water.status === 'surplus') {
    cards.push({
      category: 'water_stress',
      status: 'watch',
      confidence: 'area_estimated',
      headline: 'The beds may be staying a little wet',
      whatWeSaw: 'Wet-bed clues with the weekly water running above what the planting needs.',
      whyItMatters: 'Staying too wet can drive leaf spot and root stress in landscape beds.',
      wavesAction: 'Documented the moisture and noted it for the next visit.',
      customerAction: 'Ease back on irrigation in that area and let us know if it stays soggy.',
    });
  } else if (water && (water.status === 'deficit' || water.localizedDry)) {
    const localized = !!water.localizedDry;
    cards.push({
      category: 'water_stress',
      status: 'watch',
      confidence: 'area_estimated',
      headline: localized ? 'Water coverage in one area is worth a check' : 'One shrub area is running a little dry',
      whatWeSaw: localized
        ? 'Visible dry-stress signals in one shrub area even though the property got rain this week.'
        : 'Dry-stress signals on the foliage with weekly water below what the planting needs.',
      whyItMatters: localized
        ? 'That pattern usually points to coverage in that specific bed rather than the whole property needing more water.'
        : 'Under-watered shrubs show heat and dry stress faster and can drop leaves.',
      wavesAction: 'Flagged the area and will recheck coverage there next visit.',
      customerAction: localized
        ? 'Check that the irrigation reaches that bed evenly rather than watering the whole property more.'
        : 'Add a little water support to that area if it stays dry.',
    });
  } else if (waterCat && (waterCat.status === 'watch' || waterCat.status === 'needs_attention')) {
    cards.push({
      category: 'water_stress',
      status: cardStatusFor(waterCat.status),
      confidence: 'monitoring',
      headline: 'Some water, heat, or pruning stress to watch',
      whatWeSaw: 'Dry margins, wilt, or pruning stress on some of the plants.',
      whyItMatters: 'Stress signals tell us where the planting needs a little extra support.',
      wavesAction: 'Documented the stressed areas and will monitor them on future visits.',
      nextVisitPlan: 'Recheck the stressed plants next visit.',
    });
  }

  // ── Color & vigor recovery ─────────────────────────────────────────────────────
  const color = catByKey(categories, 'leaf_color_vigor');
  const foliage = catByKey(categories, 'foliage_fullness');
  const weak = [color, foliage].filter((c) => c && c.status === 'needs_attention');
  if (weak.length) {
    cards.push({
      category: 'color_vigor',
      status: 'watch',
      confidence: 'ai_supported',
      headline: 'Some thin or off-color foliage',
      whatWeSaw: 'Fullness and color are down in places, mostly where the plants are most stressed.',
      whyItMatters: 'Plants weaken when they can’t recover between stresses.',
      wavesAction: has('fertilizer') || has('supplement') || has('systemic')
        ? 'Fed the plants to support color and new growth, and adjusted the program accordingly.'
        : 'Adjusted the program toward color and density recovery.',
      nextVisitPlan: 'Recheck fullness and color next visit.',
    });
  }

  // ── Plant-group findings (Phase 2 — one card per non-healthy group) ────────────
  for (const group of Array.isArray(plantGroups) ? plantGroups : []) {
    if (!group || !group.label) continue;
    const gstatus = group.status === 'needs_attention' ? 'needs_attention' : group.status === 'watch' ? 'watch' : null;
    if (!gstatus) continue;
    cards.push({
      category: 'plant_group',
      status: gstatus,
      confidence: group.confirmedByTech ? 'tech_confirmed' : 'ai_supported',
      headline: `${group.label}: ${gstatus === 'needs_attention' ? 'needs a closer look' : 'one item to watch'}`,
      whatWeSaw: group.finding || 'We noted something worth monitoring in this area.',
      whyItMatters: 'Tracking issues by plant group lets us treat the right area, not the whole property.',
      wavesAction: group.wavesAction || 'Treated this area today and will continue monitoring it.',
      nextVisitPlan: 'Recheck this area next visit.',
    });
  }

  // ── Customer concern (acknowledge, never confirm a cause) ──────────────────────
  if (String(customerConcern || '').trim()) {
    cards.push({
      category: 'customer_concern',
      status: 'watch',
      confidence: 'tech_confirmed',
      headline: 'We looked into what you flagged',
      whatWeSaw: `You mentioned: “${String(customerConcern).trim()}”. We checked it during the visit.`,
      whyItMatters: 'We want what you noticed tracked on the report, not lost.',
      wavesAction: 'Noted it on this visit and built any follow-up into the plan.',
      nextVisitPlan: 'Follow up on it next visit.',
    });
  }

  // ── Reassurance when nothing needs attention ───────────────────────────────────
  if (!cards.length) {
    cards.push({
      category: 'overall',
      status: 'good',
      confidence: 'ai_supported',
      headline: 'Your landscape plants are in good shape',
      whatWeSaw: 'Foliage, color, and pest pressure all look healthy today.',
      whyItMatters: 'Your plants are responding well to the protective program.',
      wavesAction: has('fertilizer') || has('systemic')
        ? 'Completed today’s scheduled treatment and documented the visit.'
        : 'Completed today’s scheduled treatment and continued preventive monitoring.',
      nextVisitPlan: 'Keep the program steady and keep monitoring each visit.',
    });
  }

  // Priority: worst status first, then a stable category order.
  const CAT_ORDER = ['pest_pressure', 'disease_leaf_spot', 'water_stress', 'color_vigor', 'plant_group', 'customer_concern', 'treatment', 'overall'];
  cards.sort((a, b) => {
    const r = (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3);
    if (r) return r;
    return CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category);
  });
  cards.forEach((c, i) => { c.priority = i + 1; });
  return cards;
}

module.exports = { buildTreeShrubInsightCards };
