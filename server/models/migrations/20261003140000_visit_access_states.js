/**
 * visit_access_states: the exact redacted state a visit_access.v1 answer was
 * judged on (services/typed-decisions/visit-access-shadow.js), one row per
 * visit and digest. decision_reviews holds ids and answers only, and a
 * visit's inputs (saved preferences, the visit note, the neighborhood
 * directory) can be edited after its last sweep, so without this the reviewer
 * could never be shown, or label against, what the models actually read.
 *
 * The state is already redacted when it is written: no saved code, no text
 * that mentions access (only its closed-vocabulary marker). Staff tooling
 * reads it; it is not granted to the read-only chart role. Additive only.
 */
const TABLE = 'visit_access_states';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('scheduled_service_id').notNullable();
    t.string('subject_hash', 64).notNullable();
    t.jsonb('state').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['scheduled_service_id', 'subject_hash'], { indexName: 'visit_access_states_visit_hash_uniq' });
    t.index(['created_at'], 'visit_access_states_created_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
