/**
 * Day-0 review-ask contextual topic (GATE_REVIEW_DAY0_CONTEXT, owner
 * 2026-09-28; services/review-ask-topic.js).
 *
 *   ask_context — the grounded topic the customer raised before a recurring
 *                 visit: { topic, kind, source, evidenceId, confidence,
 *                 version }. Written once, when enrollment inserts the
 *                 sequence; the step runner never writes it. It is not part
 *                 of `decision`, which every step-runner deferral rewrites
 *                 and which never drives dispatch. NULL = no topic.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('review_sequences'))) return;
  if (await knex.schema.hasColumn('review_sequences', 'ask_context')) return;
  await knex.schema.alterTable('review_sequences', (t) => {
    t.jsonb('ask_context');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('review_sequences'))) return;
  if (!(await knex.schema.hasColumn('review_sequences', 'ask_context'))) return;
  await knex.schema.alterTable('review_sequences', (t) => {
    t.dropColumn('ask_context');
  });
};
