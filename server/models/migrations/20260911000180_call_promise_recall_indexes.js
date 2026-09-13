// The candidate recall in no-show-detector.js also follows the two DERIVED
// call promises — an applied reschedule's activity row and a booking's own
// call extraction — because neither path sends the customer anything of its
// own, so that derivation is the only evidence those visits have (codex P1,
// PR #4403 round 20).
//
// Indexed on the DATE TEXT each row already stores. `::timestamptz` and
// `AT TIME ZONE` are not immutable in Postgres and cannot be indexed at all;
// the recall therefore matches a date band and lets evaluateNoShow apply the
// real window to whatever that pulls in.
exports.up = async function up(knex) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS activity_log_applied_window_idx
    ON activity_log ((metadata->'to'->>'date'))
    WHERE action = 'call_reschedule_applied'`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS call_log_confirmed_start_idx
    ON call_log ((substr(ai_extraction_enriched->'scheduling'->>'confirmed_start_at', 1, 10)))
    WHERE ai_extraction_enriched->'scheduling'->>'confirmed_start_at' IS NOT NULL`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS call_log_confirmed_start_idx');
  await knex.raw('DROP INDEX IF EXISTS activity_log_applied_window_idx');
};
