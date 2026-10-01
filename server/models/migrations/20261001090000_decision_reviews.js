'use strict';

/**
 * decision_reviews — one row per (typed decision package, subject, question):
 * what TypeSafe Jev answered, what the existing paths said, what happened
 * afterwards, and what a person later decided was right. Evidence for the
 * typed-decisions shadow lane (GATE_TYPED_DECISIONS, dark); nothing reads or
 * writes this table until that lane's recorder ships.
 *
 * MEANING vs EVIDENCE are kept in separate columns on purpose:
 *   - `jev_answer`, `baseline_answers` and `label` are MEANING: what the call
 *     or text was judged to be (the model's reading, the rules' / deep judge's
 *     / production's reading, and a person's verdict).
 *   - `outcome_evidence` is EVIDENCE about what happened AFTER the decision
 *     ({ source, window, value|null, observed_at }): a booking that followed,
 *     a reschedule that was actually filed, a complaint that arrived. It can
 *     support or contradict a label but is never itself the label, so a later
 *     outcome never rewrites what the message meant, and a label never
 *     back-fills evidence nobody observed.
 *
 * `label` stays NULL until a person labels the row (`label_status` moves off
 * 'unreviewed'; `labeled_by` / `labeled_at` record who and when). `sampled_for`
 * says why the row is in the review set: a disagreement with a baseline, a
 * random audit draw, or a held-out evaluation case.
 *
 * Rows hold subject ids and answers only. Message text and transcripts are
 * re-read from call_log / sms_log when needed; none is copied here.
 */
const TABLE = 'decision_reviews';
const UNIQUE = 'decision_reviews_subject_question_uniq';
const LABEL_IDX = 'decision_reviews_capability_label_status_idx';
const SAMPLE_IDX = 'decision_reviews_sampled_for_created_idx';
const SUBJECT_IDX = 'decision_reviews_subject_idx';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;

  await knex.schema.createTable(TABLE, (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('capability', 60).notNullable();
    t.string('package_id', 80).notNullable(); // e.g. call_judge.v1
    t.string('package_hash', 64); // sha256 of the package's questions + stateShape + thresholds
    t.string('served_model', 60); // the model version the provider reports serving
    t.string('subject_type', 30).notNullable(); // call_log | sms_log
    t.uuid('subject_id').notNullable();
    t.string('question_id', 60).notNullable();
    t.jsonb('jev_answer').notNullable(); // the normalised answer
    t.jsonb('baseline_answers'); // e.g. { rules, deep_judge, production }
    t.jsonb('outcome_evidence'); // { source, window, value|null, observed_at }
    t.string('sampled_for', 20); // disagreement | random_audit | heldout
    t.jsonb('label'); // null until a person labels it
    t.string('label_status', 20).notNullable().defaultTo('unreviewed');
    t.string('labeled_by', 120);
    t.timestamp('labeled_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.unique(['capability', 'package_id', 'subject_type', 'subject_id', 'question_id'], UNIQUE);
    t.index(['capability', 'label_status'], LABEL_IDX);
    t.index(['sampled_for', 'created_at'], SAMPLE_IDX);
    t.index(['subject_type', 'subject_id'], SUBJECT_IDX);
  });

  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT decision_reviews_subject_type_check CHECK (subject_type IN ('call_log','sms_log'))`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT decision_reviews_label_status_check CHECK (label_status IN ('unreviewed','suspected_error','confirmed_error','disagreement','confirmed_correct'))`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT decision_reviews_sampled_for_check CHECK (sampled_for IS NULL OR sampled_for IN ('disagreement','random_audit','heldout'))`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
