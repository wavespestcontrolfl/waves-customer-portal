/**
 * State for Meta Custom Audience syncs (suppression + retargeting lists).
 *
 * One row per audience key. `member_keys` holds the hash rows currently uploaded to
 * Meta as `[{ k: "customer:<id>"|"lead:<id>", d: [emailSha256, phoneSha256] }]` —
 * current members PLUS "retained" stale rows we couldn't safely delete yet (a stale
 * row that still shares an identifier with a current member, since Meta deletes by
 * matching any identifier). Each sync diffs by hash to add/remove/retain, so it can
 * DELETE a member even after a hard-delete and self-heal orphans once their shared
 * identifier leaves. Stored values are SHA-256 match-key hashes (the same data sent to
 * Meta), never plaintext PII.
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
