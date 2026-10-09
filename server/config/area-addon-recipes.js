/**
 * Governed treatment recipes for the five chemical area add-ons
 * (migration 20261008200000; keys in pricing-engine/constants.js AREA_ADDONS).
 *
 * The recurring lawn and pest programs are NOT these jobs' work, so a booked
 * area add-on takes none of their lines. The job card (services/job-card.js)
 * shows the recipe below instead: the catalog product, the label rate, the
 * area basis the tech measures, the yearly limit and the one safety line.
 * The web sweep applies no product and has no recipe.
 *
 * Source: product labels and the Florida FIFRA 2(ee) sheet for Arena 50 WDG
 * (expires 2028-12-31, on file in Staff documents), checked against the
 * labels in the week of 2026-10-05 for PR #6135. Change a number here only
 * with the label in hand, and keep the pricing constants (materialPer1000,
 * maxPerYear) in step.
 *
 * `product` is a products_catalog name, resolved the way protocol lines are
 * (exact name, alias, then the tightest token match). Nothing here is a
 * dose for a tank: the amount depends on the treated area the tech measures,
 * so the tank search stays closed to these visits and the rate is label text.
 */
const AREA_ADDON_RECIPES = Object.freeze({
  area_addon_bed_pre_emergent: Object.freeze({
    product: 'Snapshot 2.5TG',
    step: 'Granular pre-emergent on the beds, then water in.',
    rate: '3.45 lb per 1,000 sq ft of bed (label range 2.3 to 4.6). Granular; water in.',
    area: 'Bed square feet treated.',
    limit: 'Label limit 600 lb per acre (13.8 lb per 1,000 sq ft) in 12 months. At least 60 days between applications.',
    safety: 'Beds must be weed-free first: it does not kill existing weeds.',
  }),
  area_addon_lawn_insect_spot: Object.freeze({
    product: 'Arena 50 WDG',
    step: 'Spray the damaged area and the green edge into the thatch.',
    rate: '0.147 oz per 1,000 sq ft (6.4 oz per acre) in 4 gal of water per 1,000 sq ft. St. Augustine only.',
    area: 'Treated square feet: the damaged area plus the green edge.',
    limit: 'Repeat no sooner than 8 weeks. Season limit 12.8 oz per acre (0.29 oz per 1,000 sq ft): 2 applications.',
    safety: 'Florida FIFRA 2(ee) sheet (expires 2028-12-31, on file in Staff documents): the applicator must carry it.',
  }),
  area_addon_fire_ant_yard: Object.freeze({
    product: 'Topchoice Granular Insecticide',
    step: 'Broadcast the granules over the lawn.',
    rate: '2 lb per 1,000 sq ft (87 lb per acre), broadcast.',
    area: 'Lawn square feet treated.',
    limit: 'Once per 12 months.',
    safety: 'Restricted-use product: certified applicator only.',
  }),
  area_addon_lawn_insect_preventive: Object.freeze({
    product: 'Acelepryn Insecticide',
    step: 'Yearly preventive spray over the lawn.',
    rate: '0.184 fl oz per 1,000 sq ft (8 fl oz per acre).',
    area: 'Lawn square feet treated.',
    limit: 'Once a year (April).',
    // No safety line beyond the product card's own precautions: none is
    // verified for this add-on, and none is invented here.
    safety: null,
  }),
  area_addon_hardscape_weed: Object.freeze({
    product: 'Roundup QuikPro SC',
    step: 'Spray weeds on hard surfaces and bare ground only.',
    rate: '16 fl oz in 1 gal of water per 1,000 sq ft.',
    area: 'Hard-surface and bare-ground square feet treated.',
    limit: 'Label limit 32 fl oz per 1,000 sq ft in 12 months: 2 applications.',
    safety: 'Carries indaziflam, up to 6 months of soil residual. Hard surfaces and bare ground only: keep off lawn, planted beds and the root zones of trees and shrubs. Do not walk on it until dry.',
  }),
});

// Own-property lookup so a key like "constructor" is not a recipe.
function areaAddOnRecipe(serviceKey) {
  return typeof serviceKey === 'string' && Object.prototype.hasOwnProperty.call(AREA_ADDON_RECIPES, serviceKey)
    ? AREA_ADDON_RECIPES[serviceKey]
    : null;
}

module.exports = { AREA_ADDON_RECIPES, areaAddOnRecipe };
