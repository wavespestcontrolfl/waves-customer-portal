// Rollback guard for page_typed_views (added by 20261124160000). Typed-link visits are counted before any home is
// mailed, so the earlier migration's down (which checks only mailed_at) could drop those counts. Knex rolls a batch
// back newest first, so this down runs before it and refuses while any count exists. Up changes nothing.

const TABLE = 'mail_prospects';

exports.up = async function up() {};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE)) || !(await knex.schema.hasColumn(TABLE, 'page_typed_views'))) return;
  // Block writers until the rollback commits (knex runs a migration in a transaction), so no visit is counted after the check.
  await knex.raw('LOCK TABLE ?? IN SHARE ROW EXCLUSIVE MODE', [TABLE]);
  const visited = await knex(TABLE).where('page_typed_views', '>', 0).first('id');
  if (visited) throw new Error('mail_prospects has typed-link visit counts; refusing to roll back');
};
