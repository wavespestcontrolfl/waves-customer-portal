/**
 * State for Meta Custom Audience syncs (suppression + retargeting lists).
 *
 * One row per audience key. `member_keys` is the set of entity keys
 * (e.g. "customer:<id>" / "lead:<id>") currently uploaded to Meta, so each sync
 * can compute add/remove deltas instead of re-uploading everything. PII never
 * lands here — only opaque entity keys + Meta's returned audience id.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('ad_audience_syncs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('audience_key', 60).notNullable().unique();
    t.string('platform', 20).notNullable().defaultTo('meta');
    t.string('meta_audience_id', 60);
    t.jsonb('member_keys').notNullable().defaultTo('[]');
    t.integer('member_count').notNullable().defaultTo(0);
    t.timestamp('last_synced_at', { useTz: true });
    t.string('last_status', 30);
    t.timestamps(true, true);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ad_audience_syncs');
};
