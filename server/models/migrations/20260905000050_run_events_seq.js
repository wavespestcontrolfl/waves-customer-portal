/**
 * Causal order for run_events (S3, Codex r10).
 *
 * A transition and its events commit in one transaction, so their
 * created_at (the transaction's now()) ties — `finished` / `disposition`,
 * `failed` / `eval_candidate` — and the row id is a random uuid. `seq`
 * (bigserial) is the insertion order the detail timeline sorts by.
 * Additive, IF NOT EXISTS; the table is new in this PR.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('run_events'))) return;
  await knex.raw('ALTER TABLE run_events ADD COLUMN IF NOT EXISTS seq BIGSERIAL');
  await knex.raw('CREATE INDEX IF NOT EXISTS run_events_run_seq_idx ON run_events (run_id, seq)');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS run_events_run_seq_idx');
  await knex.raw('ALTER TABLE run_events DROP COLUMN IF EXISTS seq');
};
