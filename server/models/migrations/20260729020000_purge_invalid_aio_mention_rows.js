/**
 * Purge invalid google_ai_overview rows from seo_llm_mentions.
 *
 * Every google_ai_overview probe since the tracker shipped (2026-05-30) hit a
 * nonexistent DataForSEO path (/serp/google/ai_overview/live/advanced) and got
 * a task-level 40402 "Invalid Path" error — which the prober recorded as a
 * legitimate "no AI overview" observation (empty response_raw). That is 100%
 * of the platform's rows (1,092 as of 2026-07-29): pure measurement artifacts
 * that drag overall share-of-voice down and feed false absence signal into the
 * aeo_gap miner.
 *
 * Delete is scoped to rows recorded BEFORE the endpoint fix ships
 * (check_date < 2026-07-30) so genuine post-fix "no overview" observations —
 * which are also stored with empty response_raw — are never touched by a
 * re-run.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('seo_llm_mentions');
  if (!hasTable) return;
  const deleted = await knex('seo_llm_mentions')
    .where('llm_platform', 'google_ai_overview')
    .where('check_date', '<', '2026-07-30')
    .where(function emptyRaw() {
      this.whereNull('response_raw').orWhere('response_raw', '');
    })
    .del();
   
  console.log(`[migration] purged ${deleted} invalid google_ai_overview mention rows`);
};

exports.down = async function down() {
  // Deleted rows were measurement artifacts (task-level API errors recorded as
  // observations); they carry no recoverable signal. Intentional no-op.
};
