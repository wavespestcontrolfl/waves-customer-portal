/**
 * Writer marker for ad_service_attribution rows (codex/audit rounds on the
 * bridge-ambiguity PR).
 *
 * The reopen reconciliation must retire EXACTLY the rows the
 * unclaimed→organic sweep wrote while an ambiguity hold was wrongly lifted
 * — and every reconstruction of "which writer created this row" from
 * provenance, web markers, and source-call timestamps carried a corner
 * where some other writer's legitimate row matched (borrowed provenance,
 * delayed processing of pre-resolution calls, …). The writer stamps itself
 * instead: the sweep's inserts carry attribution_basis =
 * 'bridge_unclaimed_sweep'; every other writer leaves it NULL. Nullable,
 * INSERT-only, never patched onto existing rows.
 *
 * Forward-only by construction: ambiguity records (and therefore reopens)
 * only exist from this PR on, and any lift-window row they need to retire
 * is written after deploy, so it carries the marker.
 */

exports.up = async function up(knex) {
  const hasColumn = await knex.schema.hasColumn('ad_service_attribution', 'attribution_basis');
  if (hasColumn) return;
  await knex.schema.alterTable('ad_service_attribution', (t) => {
    t.string('attribution_basis', 40);
  });
};

exports.down = async function down(knex) {
  const hasColumn = await knex.schema.hasColumn('ad_service_attribution', 'attribution_basis');
  if (!hasColumn) return;
  await knex.schema.alterTable('ad_service_attribution', (t) => {
    t.dropColumn('attribution_basis');
  });
};
