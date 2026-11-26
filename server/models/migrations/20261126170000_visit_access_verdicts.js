/**
 * visit_access_verdicts: a technician's Right / Wrong tap on one visit access
 * flag (services/visit-access-flags.js), one row per visit, question and
 * evidence digest (the visit_access_states.subject_hash the card was read
 * from). The tap writes only this row; it never touches decision_reviews, so
 * the provider answers and the review lane's labels stay as the sweep and the
 * reviewers left them.
 *
 * Same shape and rules as visit_access_states: no foreign key (the stored
 * states have none either, and a pruned or removed visit takes its verdicts
 * with the 180-day prune), pruned by the ungated visit-access prune, staff
 * tooling only, no grant to the read-only chart role. Additive only.
 */
const TABLE = 'visit_access_verdicts';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('scheduled_service_id').notNullable();
    t.string('question_id', 60).notNullable();
    t.string('subject_hash', 64).notNullable();
    t.string('verdict', 8).notNullable();
    t.uuid('technician_id').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['scheduled_service_id', 'question_id', 'subject_hash'], { indexName: 'visit_access_verdicts_visit_question_hash_uniq' });
    t.index(['scheduled_service_id'], 'visit_access_verdicts_visit_idx');
    t.index(['created_at'], 'visit_access_verdicts_created_idx');
  });
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT visit_access_verdicts_verdict_check CHECK (verdict IN ('right', 'wrong'))`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
