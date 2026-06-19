/**
 * Fix referral_invites.promoter_id type: uuid -> integer.
 *
 * The original migration (20260415000022) declared promoter_id as uuid, but
 * referral_promoters.id is an integer (t.increments). Every invite insert from
 * routes/referrals-v2.js passes the integer promoter.id, which failed the uuid
 * cast — and because those reads/writes are wrapped in .catch(), the error was
 * swallowed and the 24h invite cooldown silently never worked (always fails open).
 *
 * referral_invites is a transient cooldown log (24h window), so clearing any rows
 * is harmless. We empty it, swap the column type, and restore the dedup index.
 */
const INDEX_COLS = ['promoter_id', 'phone', 'sent_at'];
const INDEX_NAME = 'idx_referral_invites_promoter_phone_time';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('referral_invites'))) return;

  // Any existing rows carry unusable uuid promoter ids (or none — inserts kept throwing).
  // Clearing the transient cooldown log lets us re-add promoter_id as NOT NULL cleanly.
  await knex('referral_invites').del();

  await knex.schema.alterTable('referral_invites', (t) => {
    t.dropIndex(INDEX_COLS, INDEX_NAME);
  });
  await knex.schema.alterTable('referral_invites', (t) => {
    t.dropColumn('promoter_id');
  });
  await knex.schema.alterTable('referral_invites', (t) => {
    t.integer('promoter_id').notNullable();
  });
  await knex.schema.alterTable('referral_invites', (t) => {
    t.index(INDEX_COLS, INDEX_NAME);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('referral_invites'))) return;

  await knex('referral_invites').del();

  await knex.schema.alterTable('referral_invites', (t) => {
    t.dropIndex(INDEX_COLS, INDEX_NAME);
  });
  await knex.schema.alterTable('referral_invites', (t) => {
    t.dropColumn('promoter_id');
  });
  await knex.schema.alterTable('referral_invites', (t) => {
    t.uuid('promoter_id').notNullable();
  });
  await knex.schema.alterTable('referral_invites', (t) => {
    t.index(INDEX_COLS, INDEX_NAME);
  });
};
