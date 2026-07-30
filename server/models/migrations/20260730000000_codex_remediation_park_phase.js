/**
 * Migration — record WHEN in a remediation round a park happened, structurally,
 * on codex_remediation_state.
 *
 * The P2-only merge bar (codex-remediation p2OnlyMergeEligible) has to know one
 * thing about a parked PR: did the round MUTATE the branch before it parked?
 *
 *   - Parked BEFORE the push  → the head is still exactly the content Codex
 *     reviewed. A P2-only review of it is as mergeable as it was before
 *     remediation tried, so the bar may open (owner directive 2026-07-16,
 *     "no gates on the auto blog").
 *   - Parked AFTER the push   → the fix commit is on the branch but the
 *     post-commit sync/revalidation didn't finish, so portal state may not
 *     match what a merge would ship. A human reconciles; the bar stays shut.
 *
 * That distinction was inferred by regex-matching three free-form park_reason
 * prefixes — i.e. prose was the merge-safety boundary. Renaming a reason string
 * or adding a new post-push failure path would silently reclassify a
 * branch-mutating park as pre-push and permit a merge against unsynchronized
 * state (Codex P1 on this change; the mirror-image failure of the same prose
 * matching that starved the bar on astro #394-#398 and #409).
 *
 *   park_phase — 'pre_push' | 'post_push', written by codex-remediation park()
 *                at every call site. NULL on legacy rows, where the bar falls
 *                back to the reason-prefix heuristic; any value it doesn't
 *                recognize fails CLOSED (treated as branch-mutating).
 *
 * Deliberately a plain nullable string, not a CHECK/enum: this column is
 * written only by one module, and a CHECK constraint that rejects a future
 * phase name would throw inside a park — turning a recoverable park into a
 * crashed remediation round. The reader validates instead, and fails closed.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('codex_remediation_state');
  if (!has) return;
  if (!(await knex.schema.hasColumn('codex_remediation_state', 'park_phase'))) {
    await knex.schema.alterTable('codex_remediation_state', (t) => {
      t.string('park_phase', 16);
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasTable('codex_remediation_state');
  if (!has) return;
  if (await knex.schema.hasColumn('codex_remediation_state', 'park_phase')) {
    await knex.schema.alterTable('codex_remediation_state', (t) => {
      t.dropColumn('park_phase');
    });
  }
};
