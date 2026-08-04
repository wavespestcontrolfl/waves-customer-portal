/**
 * Structural products carried ornamental-systemic report copy, and Gentrol's
 * target prefill shipped secondary label uses as the default.
 *
 * A customer-facing sweep (2026-08-03, spun off PR #3181) found the
 * plant-systemic service_report_summary — Safari 20 SG's profile ("taken up
 * by the plant and moved through its tissue... sap-feeding and soil pests")
 * — cloned onto two STRUCTURAL-ONLY products where no plant use site exists
 * on the label:
 *
 *   - Alpine WSG (dinotefuran 40% WSG, EPA 499-561): structural label only —
 *     same active as Safari, different label (the exact near-miss recorded in
 *     the 2026-08-01 full-catalog label audit). Rendered in the PRODUCT NOTE
 *     cell on a live 2026-08-02 cockroach report (record ID in session notes).
 *   - Temprid FX (beta-cyfluthrin + imidacloprid, EPA 101563-165):
 *     structural suspension; its own target_pests row is ants / roaches /
 *     wasps / bed bugs.
 *
 * Gentrol IGR's target_pests prefill (written by 20260723000001) defaulted
 * to all three label uses — German cockroaches + drain flies + pantry moths
 * & beetles — so every untouched completion carried the secondary uses and
 * the report renderer (post-#3181) correctly refuses to name a pest for the
 * mixed set. Owner direction (2026-08-01 target-prefill lane): the prefill
 * is the BEST pest for the solution, ≤3, popular SWFL pests. Gentrol's
 * primary use here is cockroach IGR work; drain flies / pantry pests remain
 * label-valid and addable per visit.
 *
 * Every UPDATE is guarded on the exact current value (byte-for-byte what the
 * sweep read from prod on 2026-08-03), so an admin edit made after that read
 * is preserved and the migration no-ops for that row. down() is a no-op:
 * value-matched rollbacks cannot prove authorship.
 */

const CLONED_PLANT_SUMMARY = 'A systemic insecticide taken up by the plant and moved through its tissue, so sap-feeding and soil pests take it in as they feed — including pests concealed where sprays cannot reach. Protection builds over days and keeps working for weeks.';

const SUMMARY_FIXES = [
  {
    name: 'Alpine WSG',
    prior: CLONED_PLANT_SUMMARY,
    next: 'A non-repellent insecticide applied where pests travel and harbor — cracks, crevices, and entry areas. Pests do not detect and avoid the treatment, so they contact it as they move through treated zones.',
  },
  {
    name: 'Temprid FX',
    prior: CLONED_PLANT_SUMMARY,
    next: 'A dual-action insecticide pairing a fast-acting ingredient with a longer-lasting residual, applied to surfaces, cracks, and entry areas where target pests travel and harbor.',
  },
];

const GENTROL_PRIOR_TARGETS = ['German cockroaches', 'Drain flies', 'Pantry moths & beetles'];
const GENTROL_NEXT_TARGETS = ['German cockroaches', 'American cockroaches'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const fix of SUMMARY_FIXES) {
    const updated = await knex('products_catalog')
      .where({ name: fix.name, service_report_summary: fix.prior })
      .update({ service_report_summary: fix.next, updated_at: knex.fn.now() });
    if (!updated) {
       
      console.log(`[20260803200000] ${fix.name}: summary differs from the audited prior — admin edit preserved, no-op.`);
    }
  }

  if (await knex.schema.hasColumn('products_catalog', 'target_pests')) {
    const updated = await knex('products_catalog')
      .where({ name: 'Gentrol IGR' })
      .whereRaw('target_pests = ?::jsonb', [JSON.stringify(GENTROL_PRIOR_TARGETS)])
      .update({ target_pests: JSON.stringify(GENTROL_NEXT_TARGETS), updated_at: knex.fn.now() });
    if (!updated) {
       
      console.log('[20260803200000] Gentrol IGR: target_pests differs from the 20260723000001 value — admin edit preserved, no-op.');
    }
  }
};

// Value-matched down() can never prove this migration authored the value —
// an explicit no-op, same policy as 20260801300000.
exports.down = async function down() {};

exports.SUMMARY_FIXES = SUMMARY_FIXES;
exports.CLONED_PLANT_SUMMARY = CLONED_PLANT_SUMMARY;
exports.GENTROL_PRIOR_TARGETS = GENTROL_PRIOR_TARGETS;
exports.GENTROL_NEXT_TARGETS = GENTROL_NEXT_TARGETS;
