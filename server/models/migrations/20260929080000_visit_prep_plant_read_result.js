/**
 * Visit prep photos — automatic lawn / tree & shrub read storage
 * (GATE_VISIT_PREP_PLANT_READ, dark). Sibling of
 * 20260928235500_visit_prep_read_status.js's pest-read columns.
 *
 * The pest read points `read_ref` at a `pest_identifications` row — there
 * is no equivalent reusable table for a lawn/tree & shrub workup (the
 * merged photo-id-v2/plant-engine.js has no storage of its own; L4, its
 * customer go-live, is a separate owner-gated PR that has not landed). The
 * smallest correct storage is therefore a second, independently-nullable
 * column that holds the plant engine's `{ v2, internal, subject_type }`
 * result directly on the submission row it belongs to — no join, no FK,
 * no second table:
 *
 * - `read_result` (jsonb, nullable): set only when `read_status = 'done'`
 *   AND the read that produced it was a PLANT read (never both — a
 *   submission's stop is either a pest stop or a lawn/tree & shrub stop,
 *   never read by both engines; see visit-prep-plant-applicability.js's
 *   "pest wins" rule). `read_ref` stays the pest read's own column,
 *   untouched by this lane.
 *
 * `read_status`'s existing CHECK constraint (none/pending/done/failed/
 * unsupported) already covers every state either engine can leave a
 * submission in, so it is reused as-is — ONE status column, ONE cap count
 * (`visit_prep_submissions.read_status`), for both engines (the daily cap
 * this lane shares with the pest read, see visit-prep-plant-read.js).
 *
 * `hasColumn`-guarded and reversible, matching the style of
 * 20260928235500_visit_prep_read_status.js.
 */

exports.up = async function up(knex) {
  const hasReadResult = await knex.schema.hasColumn('visit_prep_submissions', 'read_result');
  if (!hasReadResult) {
    await knex.schema.alterTable('visit_prep_submissions', (t) => {
      t.jsonb('read_result');
    });
  }
};

exports.down = async function down(knex) {
  const hasReadResult = await knex.schema.hasColumn('visit_prep_submissions', 'read_result');
  if (hasReadResult) {
    await knex.schema.alterTable('visit_prep_submissions', (t) => {
      t.dropColumn('read_result');
    });
  }
};
