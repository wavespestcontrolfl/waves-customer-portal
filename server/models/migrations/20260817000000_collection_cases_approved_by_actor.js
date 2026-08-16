/**
 * collection_cases.approved_by: uuid → text (PR C / codex gh-r1 P0).
 *
 * PR A created the column as uuid, but no code path ever wrote it (the lane
 * shipped dark and the outcome writers only ever set it to NULL), so the
 * column is all-NULL in prod and the alter is free. PR C's two dial
 * surfaces record ACTORS, not technician rows: 'system:autodial' for the
 * sweep and 'admin:<email>' for the supervised endpoint — an audit string
 * a human can read in the case history, covering non-row actors the uuid
 * type cannot.
 */

exports.up = async function up(knex) {
  await knex.raw(
    'ALTER TABLE collection_cases ALTER COLUMN approved_by TYPE text USING approved_by::text',
  );
};

exports.down = async function down(knex) {
  // Actor strings that are not uuid-shaped cannot survive the reversal —
  // they become NULL (the pre-PR-C value for every row).
  await knex.raw(
    "ALTER TABLE collection_cases ALTER COLUMN approved_by TYPE uuid USING (CASE WHEN approved_by ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN approved_by::uuid ELSE NULL END)",
  );
};
