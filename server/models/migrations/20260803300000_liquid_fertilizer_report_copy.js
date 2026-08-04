/**
 * Liquid LESCO products carried GRANULAR fertilizer report copy.
 *
 * A live lawn report review (2026-08-03, Palmetto visit) showed both LESCO
 * liquid products rendering "Granules on sidewalks or driveways are swept
 * back into the turf or beds" in SAFETY & RE-ENTRY — copy written for
 * granular fertilizer, stamped catalog-wide. A prod sweep found the same
 * granular precaution on 9 rows whose label form is liquid or
 * water-soluble spray (name carries Liquid/Soluble, or the row duplicates
 * a "...Liquid Fertilizer" row of the same product):
 *
 *   20-0-0 60% CRN Liquid · 20-20-20 Soluble · 6-0-0 Liquid ·
 *   CarbonPro-L Liquid Soil Amendment · Chelated AM + Micros Liquid
 *   Micronutrient · Chelated Iron Plus · Green Flo 6-0-0 ·
 *   Green Flo Phyte Plus 0-0-26 Liquid · K-Flow 0-0-25 17% S Liquid
 *
 * DELIBERATELY EXCLUDED: "LESCO 0-0-62 AM MOP Turfgrass Soluble
 * Fertilize" — despite "Soluble" in the row name, the verified label
 * metadata (20260712100000_catalog_label_rate_backfill.js, SiteOne
 * "granular-fertilizer-50-lb-bag", lb/1,000 sq ft rate) identifies the
 * stocked SKU as granular, so its existing granular precaution is
 * CORRECT (codex P1 #3187 r4).
 *
 * Two service_report_summary problems ride along on the same rows:
 *   - the fertilizer blend copy promises "a controlled release schedule" —
 *     a granular-coating mechanism no liquid feeding has;
 *   - the micronutrient copy claims it "corrects the specific deficiency
 *     pattern documented on this visit" — a false claim on any visit where
 *     no deficiency was documented (the reviewed report had none).
 *
 * Every UPDATE is guarded on the exact current value (byte-for-byte what
 * the sweep read from prod on 2026-08-03), so an admin edit made after
 * that read is preserved and the migration no-ops for that row. down() is
 * a no-op: value-matched rollbacks cannot prove authorship.
 */

// Surface-neutral on purpose: several of these rows serve ornamental/plant
// visits too (Turf & Ornamental micronutrients, the soil amendment), and
// this field renders on the application card for whatever service line used
// the product — "to the turf" would misdescribe a Tree & Shrub visit
// (codex P1 #3187 r3).
const GRANULAR_PRECAUTION = 'Granules on sidewalks or driveways are swept back into the turf or beds; watering-in follows the visit notes. No re-entry wait once watered in and dry.';
// Conditional instruction, not a completed-work claim: the completion
// payload records the application, never whether drift occurred or was
// rinsed — a permanent report must not state cleanup happened (codex P2
// #3187 r8).
const LIQUID_PRECAUTION = 'Applied as a liquid spray to the treated areas. If any overspray reaches walks or driveways, it rinses off with water. Watering-in follows the visit notes — treated areas are ready once dry, and your technician confirms timing.';

const GRANULAR_BLEND_SUMMARY = 'A professional-grade fertilizer blend feeding the documented plants or turf — supporting density, color, root development, and recovery on a controlled release schedule.';
const LIQUID_BLEND_SUMMARY = 'A professional-grade liquid fertilizer feeding the documented turf or plants through leaf and root uptake — supporting density, color, root development, and recovery.';

const DEFICIENCY_CLAIM_SUMMARY = 'A micronutrient application that corrects the specific deficiency pattern documented on this visit — restoring leaf color and healthy new growth over the following weeks.';
const MICRONUTRIENT_SUMMARY = 'A chelated micronutrient application supporting leaf color and healthy new growth — chelation keeps the nutrients available for uptake.';

const LIQUID_ROWS = [
  'LESCO 20-0-0 60% CRN Plus Micros Turfgrass Liquid Fertilizer',
  'LESCO 20-20-20 Soluble',
  'LESCO 6-0-0 Liquid',
  'LESCO CarbonPro-L w/ MobilEX Biostimulant Liquid Soil Amendment',
  'LESCO Chelated AM + Micros Turf & Ornamental Liquid Micronutrient',
  'LESCO Chelated Iron Plus',
  'LESCO Green Flo 6-0-0 10% Ca',
  'LESCO Green Flo Phyte Plus 0-0-26 + Micros Liquid Fertilizer',
  'LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer',
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const name of LIQUID_ROWS) {
    const precautionUpdated = await knex('products_catalog')
      .where({ name, customer_precaution_summary: GRANULAR_PRECAUTION })
      .update({ customer_precaution_summary: LIQUID_PRECAUTION, updated_at: knex.fn.now() });
    if (!precautionUpdated) {
      console.log(`[20260803300000] ${name}: precaution differs from the audited prior — admin edit preserved, no-op.`);
    }
  }

  // CarbonPro-L is a soil amendment/biostimulant (pricing.csv, lawn
  // protocols), not a fertilizer — it gets the liquid PRECAUTION fix above
  // but must never receive the "liquid fertilizer … leaf and root uptake"
  // summary, even defensively (codex P1 #3187 r5).
  const fertilizerRows = LIQUID_ROWS.filter((name) => !name.includes('CarbonPro-L'));
  const blendUpdated = await knex('products_catalog')
    .whereIn('name', fertilizerRows)
    .where({ service_report_summary: GRANULAR_BLEND_SUMMARY })
    .update({ service_report_summary: LIQUID_BLEND_SUMMARY, updated_at: knex.fn.now() });
  console.log(`[20260803300000] controlled-release summary replaced on ${blendUpdated} liquid rows.`);

  // The deficiency-claim summary is a false claim on ANY visit with no
  // documented deficiency, whatever the product form — replace it wherever
  // it appears, not only on the liquid sweep rows.
  const microUpdated = await knex('products_catalog')
    .where({ service_report_summary: DEFICIENCY_CLAIM_SUMMARY })
    .update({ service_report_summary: MICRONUTRIENT_SUMMARY, updated_at: knex.fn.now() });
  console.log(`[20260803300000] deficiency-claim summary replaced on ${microUpdated} rows.`);
};

// Value-matched down() can never prove this migration authored the value —
// an explicit no-op, same policy as 20260803200000.
exports.down = async function down() {};

exports.LIQUID_ROWS = LIQUID_ROWS;
exports.GRANULAR_PRECAUTION = GRANULAR_PRECAUTION;
exports.LIQUID_PRECAUTION = LIQUID_PRECAUTION;
exports.GRANULAR_BLEND_SUMMARY = GRANULAR_BLEND_SUMMARY;
exports.LIQUID_BLEND_SUMMARY = LIQUID_BLEND_SUMMARY;
exports.DEFICIENCY_CLAIM_SUMMARY = DEFICIENCY_CLAIM_SUMMARY;
exports.MICRONUTRIENT_SUMMARY = MICRONUTRIENT_SUMMARY;
