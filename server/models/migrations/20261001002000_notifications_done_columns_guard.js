/**
 * Ensures each done column on its own, ordered BEFORE the done backfill
 * (20261001003000), which writes done_by and resolution. 20261001001500 gated
 * all three on done_at, so an environment that already had done_at but not
 * its companions would skip them there and fail in the backfill.
 * (20261001004000 repeats this check; both are idempotent.)
 * down() is a no-op: 20261001001500's down() owns dropping the columns.
 */
const COLUMNS = [
  ['done_at', (t) => t.timestamp('done_at', { useTz: true }).nullable().defaultTo(null)],
  ['done_by', (t) => t.string('done_by', 64).nullable().defaultTo(null)],
  ['resolution', (t) => t.text('resolution').nullable().defaultTo(null)],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;
  for (const [column, add] of COLUMNS) {
    if (!(await knex.schema.hasColumn('notifications', column))) {
      await knex.schema.alterTable('notifications', add);
    }
  }
};

exports.down = async function down() {};
