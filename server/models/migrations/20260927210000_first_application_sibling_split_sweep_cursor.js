/**
 * first_application_sibling_split_sweep_cursor — a single persisted row
 * (id = 1) recording the last source_estimate_id the sweep
 * (services/first-application-sibling-split.js) finished evaluating among
 * the FRESH, not-yet-established structural candidates.
 *
 * Codex P2 (PR #5021 r7): the sweep must be bounded per tick without
 * starving later candidates forever behind an always-same head of the
 * list. Established anchors (already alerting or already known) are never
 * bounded by this cursor — they are the stale-alert-recovery path and
 * always run in full every tick (see runSweepInner) — this cursor only
 * paginates the FRESH structural scan's own candidates in fair,
 * estimate-id-ordered batches, wrapping back to the start once it reaches
 * the end.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('first_application_sibling_split_sweep_cursor')) return;
  await knex.schema.createTable('first_application_sibling_split_sweep_cursor', (t) => {
    t.integer('id').primary();
    // source_estimate_id (estimates.id) is a uuid, not a sequential
    // integer — NULL means "start from the beginning of the ordering"
    // (before the first row a `uuid > cursor` comparison could match).
    t.uuid('last_estimate_id');
    t.timestamps(true, true);
  });
  await knex('first_application_sibling_split_sweep_cursor').insert({ id: 1, last_estimate_id: null });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('first_application_sibling_split_sweep_cursor'))) return;
  await knex.schema.dropTable('first_application_sibling_split_sweep_cursor');
};
