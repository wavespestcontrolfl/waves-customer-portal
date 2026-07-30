/**
 * Typed-completion follow-up alerts: storage-level dedupe + no_show linkage.
 *
 * 1. dispatch_alerts — the typed obligation writers (parkFollowupAlert,
 *    sources 'typed_completion' / 'followup_cancelled') get the same
 *    storage-level idempotency the project flow has had since
 *    20260521000007: two concurrent same-status cancellation retries can
 *    both pass the read-side pre-check post-commit and double-card one
 *    obligation (Codex r3 on PR #3091). One partial unique index covers
 *    BOTH sources — they describe the same obligation for the same job, so
 *    at most one unresolved card may exist across them.
 *    createAlertOnce().onConflict().ignore() turns the collision into the
 *    existing-row lookup.
 *
 * 2. scheduled_services — uq_scheduled_services_followup_source_open
 *    (20260611000011) excluded only cancelled/skipped children, so a
 *    no_show follow-up blocked booking a linked replacement forever while
 *    the obligation logic (FOLLOWUP_CHILD_INACTIVE_STATUSES) now treats
 *    no_show as uncovered (Codex r3). Recreated with no_show excluded —
 *    the covered row set only shrinks, so the create cannot collide.
 */

const NEW_LINK_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduled_services_followup_source_open
  ON scheduled_services (followup_source_service_id)
  WHERE followup_source_service_id IS NOT NULL
    AND status NOT IN ('cancelled', 'skipped', 'no_show')
`;

const ORIGINAL_LINK_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduled_services_followup_source_open
  ON scheduled_services (followup_source_service_id)
  WHERE followup_source_service_id IS NOT NULL
    AND status NOT IN ('cancelled', 'skipped')
`;

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('dispatch_alerts')) {
    // Resolve any pre-existing duplicates before the unique index lands
    // (mirrors 20260521000007's cleanup — read-modify-write, keeps rows
    // for audit, stamps which migration resolved them).
    await knex.raw(`
      WITH ranked AS (
        SELECT
          id,
          row_number() OVER (PARTITION BY job_id ORDER BY created_at ASC, id ASC) AS rn
        FROM dispatch_alerts
        WHERE type = 'follow_up_needed'
          AND resolved_at IS NULL
          AND job_id IS NOT NULL
          AND payload->>'source' IN ('typed_completion', 'followup_cancelled')
      )
      UPDATE dispatch_alerts AS a
      SET
        resolved_at = now(),
        payload = coalesce(a.payload, '{}'::jsonb) || jsonb_build_object(
          'dedupedByMigration', '20260730500000_typed_followup_alert_dedupe'
        )
      FROM ranked
      WHERE a.id = ranked.id
        AND ranked.rn > 1
    `);
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_alerts_typed_followup_one_unresolved
        ON dispatch_alerts (job_id)
        WHERE type = 'follow_up_needed'
          AND resolved_at IS NULL
          AND job_id IS NOT NULL
          AND payload->>'source' IN ('typed_completion', 'followup_cancelled')
    `);
  }

  if (await knex.schema.hasTable('scheduled_services')
    && await knex.schema.hasColumn('scheduled_services', 'followup_source_service_id')) {
    await knex.raw('DROP INDEX IF EXISTS uq_scheduled_services_followup_source_open');
    await knex.raw(NEW_LINK_INDEX);
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_dispatch_alerts_typed_followup_one_unresolved');
  if (await knex.schema.hasTable('scheduled_services')
    && await knex.schema.hasColumn('scheduled_services', 'followup_source_service_id')) {
    await knex.raw('DROP INDEX IF EXISTS uq_scheduled_services_followup_source_open');
    // Restoring the pre-migration definition WIDENS the covered row set
    // (no_show rows re-enter). If a no_show child and its live replacement
    // both exist by then, the strict recreate would collide — fall back to
    // the new definition rather than leaving no index at all.
    try {
      await knex.raw(ORIGINAL_LINK_INDEX);
    } catch (err) {
      await knex.raw(NEW_LINK_INDEX);
    }
  }
};
