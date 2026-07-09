// Attempt counter for AI extraction failures. processAllPending retries
// extraction_failed rows while extraction_attempts is under the cap
// (CALL_EXTRACTION_MAX_ATTEMPTS, default 3); at the cap the processor files
// a blocking triage item instead of losing the call silently (2026-07-09:
// six calls died on a retired-model 404 with no retry, no triage, no lead).
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('call_log');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('call_log', 'extraction_attempts');
  if (!hasColumn) {
    await knex.schema.alterTable('call_log', (table) => {
      table.integer('extraction_attempts').notNullable().defaultTo(0);
    });
  }
  // Pre-existing failures get parked at the cap (below) — which also means
  // the sweep will never pick them up, so the blocking card that the
  // processor files at the cap would never exist for them. Surface RECENT
  // ones (same 7-day horizon as the sweep's retry fence) with the same card
  // first; older rows stay quiet — resurfacing months-stale calls as
  // blocking cards would be noise, not signal. Read-modify-write with an
  // open-card existence check rather than ON CONFLICT: the partial unique
  // index this dedupes against may not exist in every environment.
  const hasTriage = await knex.schema.hasTable('triage_items');
  if (hasTriage) {
    const recentFailed = await knex('call_log')
      .select('id')
      .where({ processing_status: 'extraction_failed' })
      .where('created_at', '>', knex.raw("NOW() - INTERVAL '7 days'"));
    for (const row of recentFailed) {
      const open = await knex('triage_items')
        .where({ call_log_id: row.id, reason_code: 'extraction_failed_permanent' })
        .whereIn('status', ['open', 'in_progress'])
        .first();
      if (open) continue;
      await knex('triage_items').insert({
        call_log_id: row.id,
        category: 'service_unknown',
        severity: 'blocking',
        reason_code: 'extraction_failed_permanent',
        status: 'open',
        summary: 'AI extraction failed before the retry lane shipped; the call produced no lead/customer. Use Reprocess on the call recording.',
        payload: JSON.stringify({ flag: 'extraction_failed_permanent', migrated: true }),
        created_at: new Date(),
        updated_at: new Date(),
      });
    }
  }

  // Park pre-existing failures at the cap so the new sweep branch can't
  // resurrect months-old calls and re-run them (stale conversations would
  // mint fresh leads/SMS). They stay reachable via the admin Reprocess
  // button, which drives processRecording directly and never consults
  // the counter.
  await knex('call_log')
    .where({ processing_status: 'extraction_failed' })
    .update({ extraction_attempts: 3 });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('call_log');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('call_log', 'extraction_attempts');
  if (hasColumn) {
    await knex.schema.alterTable('call_log', (table) => {
      table.dropColumn('extraction_attempts');
    });
  }
};
