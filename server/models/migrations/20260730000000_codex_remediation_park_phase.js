/**
 * Migration — record WHEN in a remediation round a park happened, and whether a
 * pushed fix still owes a portal sync, on codex_remediation_state.
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
 *
 *   sync_pending_sha — the commit SHA of a remediation push whose post-commit
 *                      portal sync (runRemediationForPr's onRemediated: the
 *                      scheduler lane's blog_posts.content mirror) was WITHHELD.
 *
 * park_phase alone cannot carry this. A park is a verdict on one head and is
 * cleared when the branch re-arms, but "this pushed commit was never synced" is
 * a fact about the REPOSITORY that survives re-arms: the stale-'moved past'
 * recovery clears the park, the next round may park pre-push (round limit,
 * no-change), and the bar would then see a pre-push park plus a last_push_sha
 * matching the head and merge a commit whose portal row still holds the pre-fix
 * body. Tracked separately, cleared only when a round actually completes its
 * sync, and blocking on its own in p2OnlyMergeEligible.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('codex_remediation_state');
  if (!has) return;
  if (!(await knex.schema.hasColumn('codex_remediation_state', 'park_phase'))) {
    await knex.schema.alterTable('codex_remediation_state', (t) => {
      t.string('park_phase', 16);
    });
  }
  if (!(await knex.schema.hasColumn('codex_remediation_state', 'sync_pending_sha'))) {
    await knex.schema.alterTable('codex_remediation_state', (t) => {
      t.string('sync_pending_sha', 64);
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasTable('codex_remediation_state');
  if (!has) return;
  if (await knex.schema.hasColumn('codex_remediation_state', 'sync_pending_sha')) {
    await knex.schema.alterTable('codex_remediation_state', (t) => {
      t.dropColumn('sync_pending_sha');
    });
  }
  if (await knex.schema.hasColumn('codex_remediation_state', 'park_phase')) {
    await knex.schema.alterTable('codex_remediation_state', (t) => {
      t.dropColumn('park_phase');
    });
  }
};
