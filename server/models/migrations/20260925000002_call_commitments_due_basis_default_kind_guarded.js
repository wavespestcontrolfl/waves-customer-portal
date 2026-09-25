// Supersedes 20260925000001 (Codex #4816 r1 P2): that file already ran on the
// preview database, so it is frozen and cannot take a guard of its own. This
// one re-asserts the same widened CHECK behind the repository's
// hasTable/hasColumn guards, so an environment that skipped 000001 still
// converges on the widened constraint. On a fresh chain 000001's ALTER always
// has its table: 20260901000010 creates call_commitments with due_basis.
// Idempotent: dropping and re-adding the identical constraint on a database
// where 000001 ran is a no-op in effect.
const CONSTRAINT = 'call_commitments_due_basis_check';

async function guarded(knex) {
  if (!(await knex.schema.hasTable('call_commitments'))) return false;
  return knex.schema.hasColumn('call_commitments', 'due_basis');
}

exports.up = async function up(knex) {
  if (!(await guarded(knex))) return;
  await knex.raw(`ALTER TABLE call_commitments DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
  await knex.raw(
    `ALTER TABLE call_commitments ADD CONSTRAINT ${CONSTRAINT}
      CHECK (due_basis IS NULL OR due_basis IN ('stated', 'suggested', 'default_kind'))`,
  );
};

// Codex #4816 r14: rolling back only this guard leaves 000001 applied, and
// 000001 established the widened constraint that live SMS inserts rely on.
// Restoring the old CHECK (and rewriting 'default_kind' rows) is 000001's
// own down; this one has nothing of its own to undo.
exports.down = async function down() {};
