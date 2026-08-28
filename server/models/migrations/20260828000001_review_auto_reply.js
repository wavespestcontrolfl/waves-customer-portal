/**
 * Automatic review replies — per-review pipeline state on google_reviews.
 *
 * One row = one review; the columns record exactly what the auto-reply
 * pipeline did to it and why, so any published reply can be explained later:
 *
 *   auto_reply_status        NULL (never queued) | queued | drafted | posted |
 *                            parked | skipped | failed | retracted
 *   auto_reply_due_at        when the runner may act (review time + jitter)
 *   auto_reply_claimed_until runner claim token — atomic UPDATE … WHERE lets
 *                            exactly one worker own a row per attempt
 *   auto_reply_attempts      draft/publish attempts so far (retry ceiling)
 *   auto_reply_draft         last accepted draft text
 *   auto_reply_drafted_at    when that draft was produced
 *   auto_reply_published_at  when Google accepted it (NULL in shadow/park)
 *   auto_reply_version       drafter prompt/verifier version that produced it
 *   auto_reply_mode          reply mode the classifier picked (tech_praise …)
 *   auto_reply_reason        why a row is parked/skipped/failed
 *   auto_reply_error         last provider/verifier error text
 *   auto_reply_grounding     public-safe facts + provenance the draft saw
 *
 * Deploy-forward only (owner ruling 2026-08-27): no backfill — rows that
 * exist before the enqueue hook ships keep auto_reply_status NULL.
 */

const COLUMNS = [
  ['auto_reply_status', (t) => t.string('auto_reply_status', 20)],
  ['auto_reply_due_at', (t) => t.timestamp('auto_reply_due_at', { useTz: true })],
  ['auto_reply_claimed_until', (t) => t.timestamp('auto_reply_claimed_until', { useTz: true })],
  ['auto_reply_attempts', (t) => t.integer('auto_reply_attempts').notNullable().defaultTo(0)],
  ['auto_reply_draft', (t) => t.text('auto_reply_draft')],
  ['auto_reply_drafted_at', (t) => t.timestamp('auto_reply_drafted_at', { useTz: true })],
  ['auto_reply_published_at', (t) => t.timestamp('auto_reply_published_at', { useTz: true })],
  ['auto_reply_version', (t) => t.string('auto_reply_version', 40)],
  ['auto_reply_mode', (t) => t.string('auto_reply_mode', 30)],
  ['auto_reply_reason', (t) => t.string('auto_reply_reason', 60)],
  ['auto_reply_error', (t) => t.text('auto_reply_error')],
  ['auto_reply_grounding', (t) => t.jsonb('auto_reply_grounding')],
];

const INDEX_NAME = 'google_reviews_auto_reply_due_idx';

exports.up = async function (knex) {
  for (const [name, add] of COLUMNS) {

    const has = await knex.schema.hasColumn('google_reviews', name);
    if (!has) {

      await knex.schema.alterTable('google_reviews', (t) => { add(t); });
    }
  }
  // Partial index: the runner only ever scans rows still waiting to act.
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS ${INDEX_NAME} ON google_reviews (auto_reply_due_at)
     WHERE auto_reply_status IN ('queued', 'drafted', 'failed')`,
  );
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
  for (const [name] of COLUMNS) {

    const has = await knex.schema.hasColumn('google_reviews', name);
    if (has) {

      await knex.schema.alterTable('google_reviews', (t) => { t.dropColumn(name); });
    }
  }
};
