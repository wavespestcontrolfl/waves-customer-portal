/**
 * Review-queue cleanup (owner directive 2026-07-18: the content review queue
 * is exceptions-only). Re-disposition the pending_review rows the OLD runner
 * dispositions created, to match the new ones shipped in this PR:
 *
 *  1. Cap-parked rows (canary day/week publish cap) — nothing is wrong with
 *     these; the cap was full. Back to 'pending', immediately claimable: the
 *     runner's new cap pre-check defers them to the next cap window and they
 *     publish autonomously. expires_at is pushed out so the expireStale
 *     janitor can't expire them before that window opens.
 *  2. Hard-gate failures (content guardrails / comparison table / quality
 *     gate_fail) — writer mistakes, not human decisions. New code gives one
 *     feedback-informed redraft then skips; these old rows had no feedback
 *     recorded, so they go straight to 'skipped' (the miner re-mines a
 *     still-live signal).
 *  3. By-design protected pages (money pages etc.) — a refusal, not an
 *     exception. 'skipped'. protected_check_error stays parked: that one IS
 *     an engine fault a human should see.
 *
 * Leaves untouched: trust_build_*, astro_pr_pending_merge (poller-owned),
 * named_competitor_review, facts_* fail-closed parks, bucket_paused, and
 * every other genuine exception.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('opportunity_queue');
  if (!hasTable) return;

  const capRows = await knex('opportunity_queue')
    .where('status', 'pending_review')
    .whereIn('skip_reason', ['canary_weekly_publish_cap', 'canary_daily_publish_cap'])
    .update({
      status: 'pending',
      skip_reason: null,
      claimed_at: null,
      available_at: knex.fn.now(),
      expires_at: knex.raw("GREATEST(COALESCE(expires_at, now()), now() + interval '10 days')"),
      updated_at: knex.fn.now(),
    });

  const gateRows = await knex('opportunity_queue')
    .where('status', 'pending_review')
    .whereIn('skip_reason', ['content_guardrails_failed', 'comparison_table_failed', 'gate_fail'])
    .update({ status: 'skipped', updated_at: knex.fn.now() });

  const protectedRows = await knex('opportunity_queue')
    .where('status', 'pending_review')
    .where('skip_reason', 'like', 'protected_page:%')
    .whereNot('skip_reason', 'protected_page:protected_check_error')
    .update({ status: 'skipped', updated_at: knex.fn.now() });

   
  console.log(`[20260718000020] review-queue cleanup: ${capRows} cap-parked → pending, ${gateRows} gate-fail → skipped, ${protectedRows} protected-page → skipped`);
};

// Data-disposition change: the prior pending_review states are not
// reconstructable (and the new runner would immediately re-disposition them
// anyway), so down is a deliberate no-op.
exports.down = async function down() {};
