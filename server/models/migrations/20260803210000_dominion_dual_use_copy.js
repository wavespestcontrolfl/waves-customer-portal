/**
 * Dominion 2L (imidacloprid 21.4%, both container rows) carried the same
 * cloned plant-systemic service_report_summary as 20260803200000's rows,
 * but its label covers TWO uses — termiticide soil treatment around
 * structures AND ornamental/turf systemic — so the plant-only copy was
 * incomplete rather than wrong: on a termite job the PRODUCT NOTE read as
 * an ornamental treatment. Owner ruled 2026-08-03: rewrite to dual-use
 * copy (deliberately split out of 20260803200000, which shipped the
 * unambiguous structural-only fixes).
 *
 * Same rails as 20260803200000: guarded on the exact audited value so a
 * later admin edit is preserved (logged no-op), and down() is an explicit
 * no-op because a value-matched rollback cannot prove authorship.
 */

const CLONED_PLANT_SUMMARY = 'A systemic insecticide taken up by the plant and moved through its tissue, so sap-feeding and soil pests take it in as they feed — including pests concealed where sprays cannot reach. Protection builds over days and keeps working for weeks.';

const DOMINION_ROW_NAMES = ['Dominion 2L 1 gal', 'Dominion 2L 27.5 oz'];

const DOMINION_DUAL_USE_SUMMARY = 'A systemic insecticide with two labeled uses: as a soil treatment around structures, where subterranean termites and foraging ants contact it as they move through treated soil; and on ornamentals or turf, where it is taken up by the plant and controls sap-feeding pests as they feed.';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const name of DOMINION_ROW_NAMES) {
    const updated = await knex('products_catalog')
      .where({ name, service_report_summary: CLONED_PLANT_SUMMARY })
      .update({ service_report_summary: DOMINION_DUAL_USE_SUMMARY, updated_at: knex.fn.now() });
    if (!updated) {
      console.log(`[20260803210000] ${name}: summary differs from the audited prior — admin edit preserved, no-op.`);
    }
  }
};

// Same policy as 20260803200000: value-matched down() cannot prove
// authorship — explicit no-op.
exports.down = async function down() {};

exports.CLONED_PLANT_SUMMARY = CLONED_PLANT_SUMMARY;
exports.DOMINION_ROW_NAMES = DOMINION_ROW_NAMES;
exports.DOMINION_DUAL_USE_SUMMARY = DOMINION_DUAL_USE_SUMMARY;
