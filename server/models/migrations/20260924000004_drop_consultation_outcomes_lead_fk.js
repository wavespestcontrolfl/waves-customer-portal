/**
 * Drop the foreign key on consultation_outcomes.lead_id.
 *
 * 20260923000010_consultation_outcomes.js is already on this PR's pushed
 * branch (PR #4710's preview database has run it — Railway deploys every
 * push), so it cannot be edited in place: knex tracks by filename, and a
 * rewrite is a silent no-op in every environment that already ran it. A
 * NEW migration is the only way to change the schema it shipped.
 *
 * Why the FK has to go (round 6, server/services/consultation-outcomes.js
 * — see the comment above lockCustomerRow there for the full account):
 * recordOutcome's transaction locks `customers` FOR NO KEY UPDATE before
 * its insert into consultation_outcomes; that insert references lead_id,
 * so — as long as the FK exists — it is FORCED to also take an implicit
 * FK KEY SHARE lock on the referenced `leads` row, no matter what
 * recordOutcome itself explicitly pre-locks. estimate-manual-
 * acceptance.js's call-linkage-correction guard locks `leads` FOR UPDATE
 * BEFORE `customers` in that same transaction; admin-leads.js locks
 * `customers` BEFORE `leads`. FOR UPDATE conflicts with KEY SHARE, and the
 * repo already has these two contradictory orders for the same two
 * tables, so no in-code lock order inside recordOutcome can satisfy both
 * — a real ABBA deadlock either way. Dropping the FK removes the implicit
 * lock entirely: recordOutcome's insert then takes no lock at all on the
 * referenced lead row, and its transaction holds `customers` FOR NO KEY
 * UPDATE and, by construction, no other row lock.
 *
 * The column and its index (consultation_outcomes_lead_id_idx, from the
 * 0010 migration) are UNCHANGED — only the FK constraint is dropped.
 * Leads are soft-deleted only (deleted_at), never hard-deleted, so there
 * is no cascade (ON DELETE SET NULL) behavior riding on the FK to lose;
 * the application still resolves/validates the link in JS
 * (deriveLinkage, findSaleEvidenceForConsultation in
 * server/services/consultation-outcomes.js).
 *
 * Idempotent both directions: DROP CONSTRAINT IF EXISTS in up(); down()
 * re-adds the FK only if some other run of this migration (or a fresh
 * 0010 that still carries it) hasn't already left it in place.
 */

const CONSTRAINT_NAME = 'consultation_outcomes_lead_id_foreign';

async function constraintExists(knex, name) {
  const found = await knex('pg_constraint').where({ conname: name }).first();
  return !!found;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('consultation_outcomes'))) return;
  if (!(await knex.schema.hasColumn('consultation_outcomes', 'lead_id'))) return;
  await knex.raw(`ALTER TABLE consultation_outcomes DROP CONSTRAINT IF EXISTS ${CONSTRAINT_NAME}`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('consultation_outcomes'))) return;
  if (!(await knex.schema.hasColumn('consultation_outcomes', 'lead_id'))) return;
  if (await constraintExists(knex, CONSTRAINT_NAME)) return;
  await knex.raw(`
    ALTER TABLE consultation_outcomes
      ADD CONSTRAINT ${CONSTRAINT_NAME}
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
  `);
};
