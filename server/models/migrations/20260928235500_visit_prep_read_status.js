/**
 * Visit prep photos — automatic pest read storage (PR 5,
 * GATE_VISIT_PREP_PEST_READ). Two additive, nullable-safe columns on
 * `visit_prep_submissions`:
 *
 * - `read_status`: none (default — gate off, or not yet attempted) |
 *   pending (engine call in flight) | done (a result is stored, see
 *   `read_ref`) | failed (engine error or the daily cap was reached) |
 *   unsupported (lawn/tree & shrub/other — no engine adapter yet).
 * - `read_ref`: the `pest_identifications.id` this read produced, set only
 *   when `read_status = 'done'`. Nullable, `ON DELETE SET NULL` so a
 *   purged identification never leaves a dangling reference.
 *
 * No change to `pest_identifications` itself: `source` has no CHECK
 * constraint and `'internal'` is an already-allowed `mode` (verified in
 * production, scope doc §5.3) — the read is stored there with
 * `source = 'visit_prep'`, `mode = 'internal'`.
 *
 * `hasColumn`-guarded and reversible, matching the style of
 * 20260928170000_visit_prep_tech_seen.js.
 */

const READ_STATUSES = ['none', 'pending', 'done', 'failed', 'unsupported'];

function quoted(values) {
  return values.map((value) => `'${value}'`).join(', ');
}

exports.up = async function up(knex) {
  const hasReadStatus = await knex.schema.hasColumn('visit_prep_submissions', 'read_status');
  const hasReadRef = await knex.schema.hasColumn('visit_prep_submissions', 'read_ref');

  if (!hasReadStatus || !hasReadRef) {
    await knex.schema.alterTable('visit_prep_submissions', (t) => {
      if (!hasReadStatus) t.string('read_status', 20).notNullable().defaultTo('none');
      if (!hasReadRef) t.uuid('read_ref').references('id').inTable('pest_identifications').onDelete('SET NULL');
    });
  }

  if (!hasReadStatus) {
    await knex.raw(`
      ALTER TABLE visit_prep_submissions
      ADD CONSTRAINT visit_prep_submissions_read_status_check CHECK (read_status IN (${quoted(READ_STATUSES)}))
    `);
    await knex.raw('CREATE INDEX IF NOT EXISTS visit_prep_submissions_read_status_idx ON visit_prep_submissions (read_status)');
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS visit_prep_submissions_read_status_idx');
  await knex.raw('ALTER TABLE visit_prep_submissions DROP CONSTRAINT IF EXISTS visit_prep_submissions_read_status_check');
  const hasReadStatus = await knex.schema.hasColumn('visit_prep_submissions', 'read_status');
  const hasReadRef = await knex.schema.hasColumn('visit_prep_submissions', 'read_ref');
  if (hasReadStatus || hasReadRef) {
    await knex.schema.alterTable('visit_prep_submissions', (t) => {
      if (hasReadRef) t.dropColumn('read_ref');
      if (hasReadStatus) t.dropColumn('read_status');
    });
  }
};
