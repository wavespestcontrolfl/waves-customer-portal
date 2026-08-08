/**
 * content_optimization_impact — record whether a confirmed regression was
 * acted on, and what happened.
 *
 * verdict='regressed' has been a dead end for the page itself: its only
 * consumer is pausedBuckets, which stops the whole BUCKET after 3 confirmed
 * regressions and never touches the page that lost ground. The re-queue leg
 * hands each regressed page back to the existing refresh lane, and needs a
 * durable "already handled" marker so a daily sweep acts on each regression
 * exactly once instead of reviving the same refresh forever.
 *
 * requeue_status also records WHY a regression was not re-queued
 * (no_gsc_signal / no_service / unresolved_page / …), so a page the lane
 * cannot act on is visible rather than silently skipped every night.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('content_optimization_impact'))) return;

  const hasRequeuedAt = await knex.schema.hasColumn('content_optimization_impact', 'requeued_at');
  const hasRequeueStatus = await knex.schema.hasColumn('content_optimization_impact', 'requeue_status');
  if (hasRequeuedAt && hasRequeueStatus) return;

  await knex.schema.alterTable('content_optimization_impact', (t) => {
    // Stamped on every terminal attempt outcome, queued or refused — the row
    // is "handled" either way, and the reason column says which.
    if (!hasRequeuedAt) t.timestamp('requeued_at', { useTz: true });
    if (!hasRequeueStatus) t.string('requeue_status', 40);
  });

  // The sweep's hot path: unhandled confirmed regressions. Partial index so it
  // stays tiny as the impact corpus grows (the handled rows are the majority).
  try {
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_coi_regressed_unrequeued
        ON content_optimization_impact (checked_21d_at)
        WHERE verdict = 'regressed' AND requeued_at IS NULL
    `);
  } catch (err) {
    // A missing partial index costs a seq scan on a small table, never
    // correctness — don't fail the deploy over it.
    if (!/already exists/i.test(err.message)) throw err;
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('content_optimization_impact'))) return;

  try {
    await knex.raw('DROP INDEX IF EXISTS idx_coi_regressed_unrequeued');
  } catch (err) {
    if (!/does not exist/i.test(err.message)) throw err;
  }

  const hasRequeuedAt = await knex.schema.hasColumn('content_optimization_impact', 'requeued_at');
  const hasRequeueStatus = await knex.schema.hasColumn('content_optimization_impact', 'requeue_status');
  if (!hasRequeuedAt && !hasRequeueStatus) return;

  await knex.schema.alterTable('content_optimization_impact', (t) => {
    if (hasRequeuedAt) t.dropColumn('requeued_at');
    if (hasRequeueStatus) t.dropColumn('requeue_status');
  });
};
