/**
 * message_drafts.facts_block — the exact facts block the shadow drafter drew
 * from when it wrote the draft (drafter v8+).
 *
 * The nightly shadow judge grades fact-grounding, but until now it only saw
 * context_summary — a one-line customer summary. As the drafter's grounding
 * grows (live dispatch status, recent-call summaries), the judge must grade
 * against what the drafter actually saw, or a draft that correctly uses a
 * grounded fact reads as an invention (false draft_unsafe) and the
 * graduation metric stays polluted.
 *
 * Nullable: rows written before v8 (and legacy drafter rows) have none; the
 * judge falls back to context_summary for those.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('message_drafts', (t) => {
    t.text('facts_block');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('message_drafts', (t) => {
    t.dropColumn('facts_block');
  });
};
