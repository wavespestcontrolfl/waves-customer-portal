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
