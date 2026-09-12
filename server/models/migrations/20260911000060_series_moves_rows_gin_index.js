// no-show-detector.js's loadPromiseEvents derives one promise event per
// SIBLING occurrence a customer-notified series move touched (the single
// series text names only the anchor's new slot, so every sibling's own
// window becomes unknown). It finds those moves with a JSONB containment
// probe per candidate visit — `series_moves.rows @> '[{"id": <visit>}]'` —
// which needs a GIN index to be anything but a full scan of move history;
// the sweep re-runs this read every five minutes once the gate is on.
//
// jsonb_path_ops: smaller and faster than the default opclass, and
// containment is the only operator this read uses. The partial predicate
// keeps the index to the rows this read can ever match — a move whose text
// never went out supersedes nothing.
exports.up = async function up(knex) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS series_moves_rows_gin_idx
    ON series_moves USING gin (rows jsonb_path_ops) WHERE customer_notified = true`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS series_moves_rows_gin_idx');
};
