// Supersedes the due_local half of 20260928030000 (already run on the PR
// preview database, so it is not edited in place). Codex #5139 r1 showed a
// side column is the wrong shape: every due_at reader would have to learn
// it. The spoken ET wall clock is now applied to due_at itself when an
// AI-written time is parsed (call-commitments isoOrNull), so the column is
// never written or read. The partial index from 20260928030000 stays.
exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('call_commitments');
  if (!has) return;
  await knex.raw('ALTER TABLE call_commitments DROP CONSTRAINT IF EXISTS call_commitments_due_local_format');
  if (await knex.schema.hasColumn('call_commitments', 'due_local')) {
    await knex.schema.alterTable('call_commitments', (t) => { t.dropColumn('due_local'); });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasTable('call_commitments');
  if (!has) return;
  if (!(await knex.schema.hasColumn('call_commitments', 'due_local'))) {
    await knex.schema.alterTable('call_commitments', (t) => { t.string('due_local', 16).nullable(); });
    await knex.raw("ALTER TABLE call_commitments ADD CONSTRAINT call_commitments_due_local_format CHECK (due_local IS NULL OR due_local ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$')");
  }
};
