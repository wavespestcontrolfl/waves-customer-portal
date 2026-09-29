/**
 * Visit prep reads — count engine ATTEMPTS, not rows, against the shared
 * daily cap (VISIT_PREP_READ_DAILY_CAP).
 *
 * A read whose stop changes line while the engine runs is released and read
 * again for the stop as it is now (Codex #5320 r8). Counting rows by
 * read_status would drop the first, already-paid engine call from the day's
 * count, so a re-read could take the same slot twice. `read_attempts` is
 * bumped by every claim and never lowered; the cap counts
 * GREATEST(read_attempts, 1 if the row sits in a claimed status), so rows
 * claimed before this column existed still count once.
 *
 * `hasColumn`-guarded and reversible, matching
 * 20260929080000_visit_prep_plant_read_result.js.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('visit_prep_submissions', 'read_attempts');
  if (!has) {
    await knex.schema.alterTable('visit_prep_submissions', (t) => {
      t.integer('read_attempts').notNullable().defaultTo(0);
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('visit_prep_submissions', 'read_attempts');
  if (has) {
    await knex.schema.alterTable('visit_prep_submissions', (t) => {
      t.dropColumn('read_attempts');
    });
  }
};
