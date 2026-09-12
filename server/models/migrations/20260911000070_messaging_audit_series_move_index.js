// no-show-detector.js's sibling-supersession read joins the series text to
// its move through the metadata key the sender stamps:
// `a.metadata->>'series_move_id' = sm.id::text`. Without an index on that
// expression the join is a sequential scan of messaging_audit_log — the
// largest table this read touches — every five minutes once the gate is on.
// Partial on the key being present: only a series notice carries it.
//
// Its own file rather than an edit to 20260911000060, for the reason that one
// is separate from 20260911000050: knex tracks migrations by filename, so
// editing a file the PR preview database has already run is a silent no-op.
exports.up = async function up(knex) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS messaging_audit_series_move_idx
    ON messaging_audit_log ((metadata->>'series_move_id'))
    WHERE metadata->>'series_move_id' IS NOT NULL`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS messaging_audit_series_move_idx');
};
