// Supersedes 20260925000001 (Codex #4816 r1 P2): that file already ran on the
// preview database, so it is frozen; this one re-asserts the same widened
// CHECK behind the repository's hasTable/hasColumn guards so a partially
// provisioned or schema-skewed environment cannot break the migration chain
// in either direction. Idempotent: dropping and re-adding the identical
// constraint on a database where 000001 ran is a no-op in effect.
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

exports.down = async function down(knex) {
  if (!(await guarded(knex))) return;
  // 'default_kind' rows are SMS-lane default deadlines, never human-stated:
  // 'suggested' (a derived default) is the closest legacy value.
  await knex('call_commitments').where({ due_basis: 'default_kind' }).update({ due_basis: 'suggested' });
  await knex.raw(`ALTER TABLE call_commitments DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
  await knex.raw(
    `ALTER TABLE call_commitments ADD CONSTRAINT ${CONSTRAINT}
      CHECK (due_basis IS NULL OR due_basis IN ('stated', 'suggested'))`,
  );
};
