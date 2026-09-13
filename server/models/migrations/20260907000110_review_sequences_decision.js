/**
 * Review cadence decision record (owner directive 2026-09-07: the completion
 * panel and the Reviews page must explain the same decision — reason, planned
 * send, next evaluation, and whether the owner has to do anything).
 *
 *   decision           — the cadence's latest scheduling decision, written by
 *                        enrollment and by every step-runner deferral/advance:
 *                        { reason, plannedAt, nextEvalAt, ownerAction, at }.
 *                        Read-only for the UI; never drives dispatch.
 *   customer_requested — set once at enrollment when the completion panel's
 *                        "Customer asked for the link" option was chosen:
 *                        { by, at, source }. Historical "Now" selections were
 *                        never recorded as requests and are not backfilled.
 */
exports.up = async function up(knex) {
  const hasDecision = await knex.schema.hasColumn('review_sequences', 'decision');
  const hasRequested = await knex.schema.hasColumn('review_sequences', 'customer_requested');
  if (hasDecision && hasRequested) return;
  await knex.schema.alterTable('review_sequences', (t) => {
    if (!hasDecision) t.jsonb('decision');
    if (!hasRequested) t.jsonb('customer_requested');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('review_sequences', (t) => {
    t.dropColumn('decision');
    t.dropColumn('customer_requested');
  });
};
