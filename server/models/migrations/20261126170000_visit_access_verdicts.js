/**
 * Visit access flags for the technician (services/visit-access-flags.js).
 *
 * visit_access_verdicts: a technician's Right / Wrong tap on one flag, one row
 * per visit, question and evidence digest (the visit_access_states.subject_hash
 * the card was read from), stamped with the customer the evidence described.
 * The tap writes only this row; it never touches decision_reviews, so the
 * provider answers and the review lane's labels stay as the sweep and the
 * reviewers left them.
 *
 * visit_access_states gets two columns:
 *  - customer_id: the customer the state was built for. Its texts, notes and
 *    profile are that customer's, and a customer merge or undo can change a
 *    visit's customer while the visit id stays, so a state (and a verdict) is
 *    evidence only for the customer it names; null (a row stored before this
 *    column) is evidence for no one until the sweep stamps it.
 *  - answers: the providers' CURRENT yes / no answers for this exact digest,
 *    { provider: { question_id: boolean } }. The flags read eligibility from
 *    here, not from decision_reviews, whose rows are review samples that a
 *    label preserves under an older digest.
 *
 * Same shape and rules as visit_access_states: no foreign key (the stored
 * states have none either), pruned by the ungated visit-access prune, staff
 * tooling only, no grant to the read-only chart role. Additive only.
 */
const TABLE = 'visit_access_verdicts';
const STATES = 'visit_access_states';

exports.up = async function up(knex) {
  for (const [column, add] of [['customer_id', (t) => t.uuid('customer_id').nullable()], ['answers', (t) => t.jsonb('answers').nullable()]]) {
    if (!(await knex.schema.hasColumn(STATES, column))) await knex.schema.alterTable(STATES, add);
  }
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('scheduled_service_id').notNullable();
    t.uuid('customer_id').notNullable();
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
  for (const column of ['answers', 'customer_id']) {
    if (await knex.schema.hasColumn(STATES, column)) await knex.schema.alterTable(STATES, (t) => t.dropColumn(column));
  }
};
