// Rollback guard for page_typed_views (added by 20261124160000). Typed-link visits are counted before any home is
// mailed, and that migration's down checks only mailed_at. Knex rolls a batch back newest first, so this down runs
// first: under one table lock it refuses while any count exists, else drops the counter itself in the same
// transaction (the earlier down then skips the missing column). Up puts the counter back if it is missing.

const TABLE = 'mail_prospects';
const COLUMN = 'page_typed_views';
const TYPED_CHECK = 'mail_prospects_page_typed_views_check';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE)) || (await knex.schema.hasColumn(TABLE, COLUMN))) return;
  await knex.schema.alterTable(TABLE, (t) => { t.integer(COLUMN).notNullable().defaultTo(0); });
  await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${COLUMN} >= 0)`, [TABLE, TYPED_CHECK]);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE)) || !(await knex.schema.hasColumn(TABLE, COLUMN))) return;
  // Block writers until the drop commits (knex runs a migration in a transaction), so no visit is counted after the check.
  await knex.raw('LOCK TABLE ?? IN SHARE ROW EXCLUSIVE MODE', [TABLE]);
  const visited = await knex(TABLE).where(COLUMN, '>', 0).first('id');
  if (visited) throw new Error('mail_prospects has typed-link visit counts; refusing to roll back');
  await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [TABLE, TYPED_CHECK]);
  await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(COLUMN); });
};
