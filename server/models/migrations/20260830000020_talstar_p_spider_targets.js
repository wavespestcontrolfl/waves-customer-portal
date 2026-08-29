// Talstar P completion-target prefill → SWFL spider work (owner request
// 2026-08-29): on the recurring general-pest tank mix Talstar P is the
// spider-knockdown product, so the completion card should prefill the
// spiders the visit actually targets — widow, orb-weaver, and jumping
// spiders — instead of leading with the ant/roach list 20260723000001
// wrote.
//
// The row's list is shared across service lines, so the LAWN targets are
// preserved after the spiders (codex P1 on #3611): the lawn protocol
// operating layer's Talstar P chinch curative (20260529000003) must keep
// prefilling "Southern chinch bugs" (+ "Fire ants") on lawn completions.
// filterLabelTargetsForLine makes the split: a pest visit keeps the first
// MAX_LABEL_TARGET_PREFILL (3) pest-line targets — exactly the three
// spiders — while a lawn visit drops them and keeps the chinch/fire-ant
// pair, so the owner's pest-card ask and the lawn curative both hold.
//
// Deliberate UNCONDITIONAL overwrite for this one row: the owner directed
// replacing Talstar P's CURRENT pest targets, so this write IS the admin
// edit — unlike the fill migrations, which only replace machine-written
// lists. down() restores the 20260723000001 list only when the row still
// holds exactly what this migration wrote.

const NEXT = [
  'Widow spiders',
  'Orb-weaver spiders',
  'Jumping spiders',
  'Southern chinch bugs',
  'Fire ants',
];
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
