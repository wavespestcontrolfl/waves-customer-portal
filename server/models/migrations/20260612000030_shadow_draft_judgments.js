/**
 * shadow_draft_judgments — Phase C of the SMS brand-voice loop.
 *
 * One row per judged message_drafts status='shadow' row: the nightly judge
 * pairs each shadow draft with the reply a human actually sent to the same
 * customer within the reply window, scores the AI draft against it, and
 * records a verdict. Per-intent aggregates over this table drive the
 * graduation ladder (Phase E) and the Shadow Drafts tab in /admin/agents.
 *
 * Verdicts:
 *   draft_better | equivalent | human_better  LLM-scored comparisons
 *   draft_unsafe                              LLM flagged a safety problem
 *   human_no_reply                            human sent nothing and the AI
 *                                             drafted text — ambiguous, NOT
 *                                             LLM-scored (no ground truth)
 *   both_no_reply                             AI drafted "" and human was
 *                                             silent — deterministic agree,
 *                                             no LLM call spent
 *
 * scores jsonb: { voice, safety, actions, overall } each 0-10 — present
 * only on LLM-scored verdicts.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('shadow_draft_judgments', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('draft_id').notNullable().unique().references('id').inTable('message_drafts');
    t.uuid('customer_id').references('id').inTable('customers');
    t.string('intent', 50);
    t.uuid('human_reply_sms_id'); // sms_log.id of the paired human reply
    t.text('human_reply_text');
    t.boolean('human_replied').notNullable().defaultTo(false);
    t.boolean('draft_was_empty').notNullable().defaultTo(false); // AI said "no reply warranted"
    t.string('verdict', 20).notNullable();
    t.jsonb('scores'); // {voice,safety,actions,overall} 0-10, LLM verdicts only
    t.text('notes');
    t.string('model', 80);
    t.string('prompt_version', 40);
    t.timestamp('judged_at').defaultTo(knex.fn.now());

    t.index('intent');
    t.index('judged_at');
    t.index('verdict');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('shadow_draft_judgments');
};
