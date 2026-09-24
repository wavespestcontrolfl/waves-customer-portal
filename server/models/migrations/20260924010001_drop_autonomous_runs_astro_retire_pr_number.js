/**
 * Supersedes 20260924010000: the atomic editorial merge no longer closes a
 * PR whose head advanced mid-merge (owner ruling 2026-09-24), so the
 * autonomous_runs retirement-debt column has no writer. Pushed migrations
 * are frozen, so this drops it rather than deleting that file.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('autonomous_runs', 'astro_retire_pr_number')) {
    await knex.schema.alterTable('autonomous_runs', (t) => { t.dropColumn('astro_retire_pr_number'); });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('autonomous_runs', 'astro_retire_pr_number'))) {
    await knex.schema.alterTable('autonomous_runs', (t) => { t.integer('astro_retire_pr_number').nullable(); });
  }
};
