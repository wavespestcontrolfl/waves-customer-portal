/**
 * Lawn Report V2 — insight cards (cause → effect → action).
 *
 * Combines the five visual-diagnosis categories + the water balance + mowing height
 * + the customer's concern into a small, prioritized set of plain-language insights.
 * Deterministic (no LLM) so customer copy can't drift or overclaim.
 *
 * RULES (baked in):
 *  - Every issue card carries a Waves action and either a customer action or a
 *    next-visit monitoring plan.
 *  - Never say "improving" (that needs trend data — the trend chart owns it).
 *  - Never diagnose pests/disease from photo-only evidence ("signals", not "infestation").
 *  - Never recommend watering MORE when water is balanced/high (recommend checking
 *    coverage instead); never say Waves will fix mowing (we don't mow).
 */

const STATUS_RANK = { needs_attention: 0, urgent: 0, watch: 1, healthy: 2, strong: 2, tracking: 3 };

function catByKey(categories, key) {
  return (categories || []).find((c) => c.key === key) || null;
}

/**
 * @param {object} input
 * @param {Array}  input.categories  output of buildVisualDiagnosisCategories
 * @param {object} input.water       { status, rainKnown, profileMissing, totalInches, targetInches, overwatering }
 * @param {object} input.mowing      { status, measuredHeightInches, idealMinInches, idealMaxInches } | null
 * @param {string} input.grassLabel
 * @param {string} input.customerConcern
 * @returns {Array} prioritized LawnInsightCard[]
 */
function buildLawnInsightCards({ categories = [], water = {}, mowing = null, grassLabel = 'lawn', customerConcern = '', treatmentKinds = [] } = {}) {
  const cards = [];
  const has = (kind) => Array.isArray(treatmentKinds) && treatmentKinds.includes(kind);

  // ── Water ───────────────────────────────────────────────────────────────────
  const waterCat = catByKey(categories, 'water_moisture_stress');
  if (water && water.status === 'surplus') {
    cards.push({
      category: 'water', status: 'needs_attention', confidence: water.overwatering ? 'tech_confirmed' : 'area_estimated',
      headline: 'The lawn is likely getting too much water',
      whatWeSaw: water.overwatering
        ? 'Damp areas and fungal/mushroom signs in today’s photos, with the weekly water total running above target.'
        : 'The weekly water total (rain + irrigation) is running above the seasonal target.',
      whyItMatters: `Staying too wet drives fungus, mushrooms, and weed pressure and weakens the ${grassLabel}.`,
      wavesAction: has('fungicide')
        ? 'Applied a fungicide and adjusted today’s plan toward drying things out.'
        : 'Documented the moisture and adjusted today’s plan toward drying things out.',
      customerAction: 'Ease back on irrigation by one cycle and let us know if it stays soggy.',
      confidenceNote: null,
    });
  } else if (water && water.status === 'deficit') {
    cards.push({
      category: 'water', status: 'watch', confidence: 'area_estimated',
      headline: 'The lawn is running a little dry',
      whatWeSaw: 'The weekly water total is below the seasonal target for your lawn.',
      whyItMatters: 'Under-watered turf shows heat and drought stress faster and thins out.',
      wavesAction: 'Noted the shortfall and set the watering target on the report.',
      customerAction: `Add a little irrigation time to reach the seasonal target for your ${grassLabel}.`,
    });
  } else if (water.localizedDry || (waterCat && (waterCat.status === 'watch' || waterCat.status === 'needs_attention'))) {
    // Balanced total but a localized dry/wet read — coverage, NOT "water more".
    cards.push({
      category: 'water', status: 'watch', confidence: 'area_estimated',
      headline: 'Water coverage is the main thing to watch',
      whatWeSaw: 'Total water for the week looks on target, but one area still reads off.',
      whyItMatters: 'That pattern usually points to uneven sprinkler coverage, not the whole lawn needing more water.',
      wavesAction: 'Flagged the area and will recheck it next visit.',
      customerAction: 'Check sprinkler coverage in that area rather than watering the whole yard more.',
    });
  }

  // ── Weed pressure ─────────────────────────────────────────────────────────────
  const weed = catByKey(categories, 'weed_pressure');
  if (weed && (weed.status === 'watch' || weed.status === 'needs_attention')) {
    cards.push({
      category: 'weeds', status: weed.status, confidence: 'ai_supported',
      headline: weed.status === 'needs_attention' ? 'Weed pressure is climbing' : 'A little weed activity to keep ahead of',
      whatWeSaw: 'Weeds competing with the turf in places.',
      whyItMatters: 'Weeds spread fastest when the turf is thin or stressed.',
      wavesAction: has('pre_emergent')
        ? 'Applied a pre-emergent to stop new weeds and built follow-up into the plan.'
        : has('herbicide')
          ? 'Spot-treated the weeds with a targeted herbicide and built it into the plan.'
          : 'Spot-treated where appropriate and built it into the plan.',
      nextVisitPlan: 'Reassess weed pressure next visit.',
    });
  }

  // ── Damage / disease SIGNALS (never a confirmed diagnosis) ─────────────────────
  const damage = catByKey(categories, 'damage_disease_signals');
  if (damage && (damage.status === 'watch' || damage.status === 'needs_attention')) {
    cards.push({
      category: 'damage', status: damage.status === 'needs_attention' ? 'watch' : damage.status, confidence: 'ai_supported',
      headline: 'A few stress patterns to monitor',
      whatWeSaw: 'Some stress patterns in the turf that we want to keep an eye on.',
      whyItMatters: 'Catching patterns early lets us confirm the cause before it spreads.',
      wavesAction: 'Documented the areas for comparison next visit.',
      nextVisitPlan: 'Recheck these areas next visit to confirm what’s driving them.',
    });
  }

  // ── Coverage / color recovery ──────────────────────────────────────────────────
  const coverage = catByKey(categories, 'coverage');
  const color = catByKey(categories, 'color_vigor');
  const weakGrowth = [coverage, color].filter((c) => c && c.status === 'needs_attention');
  if (weakGrowth.length) {
    cards.push({
      category: 'coverage', status: 'watch', confidence: 'ai_supported',
      headline: 'Some thinning and uneven color',
      whatWeSaw: 'Coverage and color are down in places, mostly where the lawn is most stressed.',
      whyItMatters: 'Turf weakens when it can’t recover between stresses.',
      wavesAction: has('fertilizer') || has('supplement')
        ? 'Fed the lawn to support density and color recovery, and shifted the program accordingly.'
        : 'Shifted the program toward density and color recovery.',
      nextVisitPlan: 'Recheck density and color next visit.',
    });
  }

  // ── Mowing height (we don't mow — heads-up only) ───────────────────────────────
  if (mowing && (mowing.status === 'too_short' || mowing.status === 'too_tall')) {
    const short = mowing.status === 'too_short';
    cards.push({
      category: 'mowing', status: 'watch', confidence: 'measured',
      headline: short ? 'Lawn is being mowed a bit short' : 'Lawn is being mowed a bit tall',
      whatWeSaw: `Measured height of cut is ${short ? 'below' : 'above'} the ideal range for your ${grassLabel}.`,
      whyItMatters: short
        ? 'Short mowing makes turf show heat and dry stress faster.'
        : 'Tall mowing can shade the base of the turf and hold moisture.',
      wavesAction: 'Logged the height for your file — we don’t mow, so this is a heads-up.',
      customerAction: short ? 'Raise the mower one setting.' : 'Lower the mower one setting.',
    });
  }

  // ── Customer concern (acknowledge, never confirm a cause) ──────────────────────
  if (String(customerConcern || '').trim()) {
    cards.push({
      category: 'customer_concern', status: 'watch', confidence: 'tech_confirmed',
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
      category: 'overall', status: 'healthy', confidence: 'ai_supported',
      headline: 'Your lawn is in good shape',
      whatWeSaw: 'Coverage, color, and weed control all look healthy today.',
      whyItMatters: 'Your lawn is responding well to the program.',
      wavesAction: has('fertilizer')
        ? 'Applied today’s scheduled feeding and documented the visit.'
        : 'Completed today’s scheduled treatment and documented the visit.',
      nextVisitPlan: 'Keep the program steady and keep tracking each visit.',
    });
  }

  // Priority: worst status first, then a stable category order.
  const CAT_ORDER = ['water', 'weeds', 'damage', 'coverage', 'mowing', 'customer_concern', 'overall'];
  cards.sort((a, b) => {
    const r = (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3);
    if (r) return r;
    return CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category);
  });
  cards.forEach((c, i) => { c.priority = i + 1; });
  return cards;
}

module.exports = { buildLawnInsightCards };
