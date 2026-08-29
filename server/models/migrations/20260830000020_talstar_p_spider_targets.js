// Talstar P completion-target prefill → SWFL spider work (owner request
// 2026-08-29): on the recurring general-pest tank mix Talstar P is the
// spider-knockdown product, so the completion card should prefill the
// spiders the visit actually targets — widow, orb-weaver, and jumping
// spiders — instead of the ant/roach/chinch-bug list 20260723000001 wrote.
// All three classify onto the pest line client-side (labelTargetLines) and
// fit inside MAX_LABEL_TARGET_PREFILL, so the whole list prefills on a
// pest visit and none of it leaks onto lawn/T&S completions.
//
// Deliberate UNCONDITIONAL overwrite for this one row: the owner directed
// replacing Talstar P's CURRENT targets, so this write IS the admin edit —
// unlike the fill migrations, which only replace machine-written lists.
// down() restores the 20260723000001 list only when the row still holds
// exactly what this migration wrote.

const NEXT = ['Widow spiders', 'Orb-weaver spiders', 'Jumping spiders'];
const PREV = [
  'Ghost ants',
  'Big-headed ants',
  'Fire ants',
  'Smokybrown cockroaches',
  'Southern chinch bugs',
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', ['Talstar P'])
    .update({
      target_pests: JSON.stringify(NEXT),
      updated_at: new Date(),
    });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', ['Talstar P'])
    .whereRaw('target_pests = ?::jsonb', [JSON.stringify(NEXT)])
    .update({
      target_pests: JSON.stringify(PREV),
      updated_at: new Date(),
    });
};
