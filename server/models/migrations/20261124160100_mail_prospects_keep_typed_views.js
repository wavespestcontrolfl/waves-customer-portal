// Rollback check for page_typed_views (added by 20261124160000, whose own down also checks it). Knex rolls a batch
// back newest first, each migration in its own transaction, so this down runs first. It only checks, under a table
// lock, and never drops anything: a refusal here, or in the older down, leaves the schema whole. It refuses while any
// home is marked mailed or has a typed-link visit count. Up puts the counter back if it is missing.

const TABLE = 'mail_prospects';
const COLUMN = 'page_typed_views';
const TYPED_CHECK = 'mail_prospects_page_typed_views_check';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE)) || (await knex.schema.hasColumn(TABLE, COLUMN))) return;
  await knex.schema.alterTable(TABLE, (t) => { t.integer(COLUMN).notNullable().defaultTo(0); });
  await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${COLUMN} >= 0)`, [TABLE, TYPED_CHECK]);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw('LOCK TABLE ?? IN SHARE ROW EXCLUSIVE MODE', [TABLE]);
  if (await knex.schema.hasColumn(TABLE, 'mailed_at')) {
    const mailed = await knex(TABLE).whereNotNull('mailed_at').first('id');
    if (mailed) throw new Error('mail_prospects has homes marked as mailed; refusing to roll back');
  }
  if (await knex.schema.hasColumn(TABLE, COLUMN)) {
    const visited = await knex(TABLE).where(COLUMN, '>', 0).first('id');
    if (visited) throw new Error('mail_prospects has typed-link visit counts; refusing to roll back');
  }
};
