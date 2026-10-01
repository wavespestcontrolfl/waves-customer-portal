/**
 * decision_reviews.package_hash becomes NOT NULL.
 *
 * Codex #5476 r1: every review row must name the immutable package content
 * (question wording, criteria, thresholds) its answer was evaluated against,
 * or it can be exported as a labeled evaluation case that nobody can verify
 * once package versions evolve. askPackage always computes the hash; this
 * closes the door on recorder or manual inserts without it. The creating
 * migration (20261001090000) is frozen (already pushed), so this is the
 * correction migration. The table is brand new and unwritten, but the guard
 * UPDATE keeps the ALTER safe if a row ever slipped in first.
 */
const TABLE = 'decision_reviews';

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;
  // A provenance-less row cannot be repaired; mark it so it is never exported
  // as evidence (the export script selects by label_status, and 'unreviewed'
  // rows with this sentinel hash are excluded there) and make the column strict.
  await knex(TABLE).whereNull('package_hash').update({ package_hash: 'unknown-' + '0'.repeat(56) });
  await knex.schema.alterTable(TABLE, (t) => {
    t.string('package_hash', 64).notNullable().alter();
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;
  await knex.schema.alterTable(TABLE, (t) => {
    t.string('package_hash', 64).nullable().alter();
  });
};
