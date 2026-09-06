/**
 * Paging-key indexes for the legacy run ledgers (S3, Codex r16).
 *
 * The Runs list pages autonomous_runs, message_drafts and agent_decisions
 * on their raw created_at (DESC, id DESC — sources/shape.js keyset), and
 * every first page reads up to 2,000 rows per source. None of the three
 * had a leading created_at index (agent_decisions only behind status /
 * workflow / customer), so the scan sorted the whole history — and ran
 * each row's correlated state subqueries on the way. Plain CREATE INDEX
 * (a brief write lock per table); IF NOT EXISTS; hasTable-guarded.
 */

const INDEXES = [
  ['autonomous_runs', 'autonomous_runs_created_idx'],
  ['message_drafts', 'message_drafts_created_idx'],
  ['agent_decisions', 'agent_decisions_created_idx'],
];

exports.up = async function up(knex) {
  for (const [table, name] of INDEXES) {
    if (!(await knex.schema.hasTable(table))) continue;
    await knex.raw(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (created_at DESC, id DESC)`);
  }
};

exports.down = async function down(knex) {
  for (const [, name] of INDEXES) await knex.raw(`DROP INDEX IF EXISTS ${name}`);
};
