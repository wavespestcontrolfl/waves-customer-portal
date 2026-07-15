/**
 * Poll-pending observability for autonomous PR runs.
 *
 * The PR poller can return a "pending" verdict for the same run on every
 * 2-minute tick without ever surfacing WHY — a run wedged behind a gate that
 * never clears (e.g. `preview_build_stale_commit`, PR #374 2026-07-15) was
 * indistinguishable from one healthily awaiting Codex. These columns let the
 * poller persist the current pending reason + when it started, and stamp a
 * one-time reviewer_notes annotation when a reason persists past its
 * expected window.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('autonomous_runs');
  if (!hasTable) return;
  const addCol = async (name, cb) => {
    const has = await knex.schema.hasColumn('autonomous_runs', name);
    if (!has) await knex.schema.alterTable('autonomous_runs', cb);
  };
  await addCol('poll_pending_reason', (t) => t.text('poll_pending_reason'));
  await addCol('poll_pending_since', (t) => t.timestamp('poll_pending_since', { useTz: true }));
  await addCol('poll_pending_annotated_at', (t) => t.timestamp('poll_pending_annotated_at', { useTz: true }));
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('autonomous_runs');
  if (!hasTable) return;
  const dropCol = async (name) => {
    const has = await knex.schema.hasColumn('autonomous_runs', name);
    if (has) await knex.schema.alterTable('autonomous_runs', (t) => t.dropColumn(name));
  };
  await dropCol('poll_pending_reason');
  await dropCol('poll_pending_since');
  await dropCol('poll_pending_annotated_at');
};
