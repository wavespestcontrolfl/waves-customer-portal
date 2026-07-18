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
 *     gate_fail) — writer mistakes, not human decisions. These become
 *     'expired' (NOT the miner-sticky 'skipped'): a still-live signal is
 *     revived to pending by the next mine and flows through the new
 *     one-redraft-then-skip path; a disappeared signal stays retired.
 *     Rows whose run history shows a gate INFRA failure stay parked.
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

  // Rows whose run history shows a gate INFRA failure (thrown evaluator,
  // unavailable module/corpus, PII scanner down, missing previous version) or
  // the gated named-competitor state are genuine exceptions the operator
  // should still see — exclude them from the skip (Codex PR r1). The
  // STRUCTURED gate-result jsonb columns are authoritative (reviewer_notes
  // are lossy — _summarizeForReviewer records "uniqueness: failed" without
  // the error text); the notes checks stay as a conservative extra OR. ANY
  // matching run keeps the row parked. jsonb_exists() instead of the `?`
  // operator — knex would eat `?` as a binding placeholder.
  const INFRA_MARKERS_SQL = `(
        jsonb_exists(ar.uniqueness_gate_result, 'error')
        OR jsonb_exists(ar.quality_gate_result, 'error')
        OR jsonb_exists(ar.seo_completion_gate_result, 'error')
        OR jsonb_exists(COALESCE(ar.quality_gate_result->'pre_publish_visibility', '{}'::jsonb), 'error')
        OR ar.quality_gate_result::text ILIKE '%evaluator_threw%'
        OR ar.quality_gate_result::text ILIKE '%pii_scan_unavailable%'
        OR ar.quality_gate_result::text ILIKE '%no_previous_version_to_compare%'
        OR ar.comparison_table_result::text ILIKE '%comparison_table_gate_error%'
        OR ar.comparison_table_result::text ILIKE '%named_competitor_disabled%'
        OR ar.content_guardrails_result::text ILIKE '%unavailable%'
        OR ar.reviewer_notes ILIKE '%gate_error%'
        OR ar.reviewer_notes ILIKE '%unavailable%'
        OR ar.reviewer_notes ILIKE '%evaluator_threw%'
        OR ar.reviewer_notes ILIKE '%no_previous_version_to_compare%'
        OR ar.reviewer_notes ILIKE '%load fail%'
        OR ar.reviewer_notes ILIKE '%named_competitor_disabled%'
        -- Router-flagged human review: the old runner prioritized 'gate_fail'
        -- as the skip reason even when the brief demanded human review, with
        -- the router verdict recorded only as a "router: <reason>" note (and
        -- structurally as content_briefs.human_review_required). Those are
        -- genuine human decisions — keep them parked. (Prod check: both
        -- predicates match the same 2 rows.)
        OR ar.reviewer_notes ILIKE '%router:%'
        OR EXISTS (
          SELECT 1 FROM content_briefs cb
          WHERE cb.id = ar.brief_id AND cb.human_review_required IS TRUE
        )
      )`;
  // 'expired', NOT 'skipped': the miner's upsert keeps 'skipped' STICKY for
  // matching dedupe keys (operator dismissals must not resurrect), so a
  // skipped disposition would permanently retire these opportunities. An
  // 'expired' row is exactly the revivable state — a still-live signal
  // re-pends with fresh metadata on the next mine and flows through the new
  // one-redraft-then-skip path; a disappeared signal stays retired.
  const gateRows = await knex('opportunity_queue')
    .where('status', 'pending_review')
    .whereIn('skip_reason', ['content_guardrails_failed', 'comparison_table_failed', 'gate_fail'])
    .whereRaw(`NOT EXISTS (
      SELECT 1 FROM autonomous_runs ar
      WHERE ar.opportunity_id = opportunity_queue.id
        AND ${INFRA_MARKERS_SQL}
    )`)
    .update({ status: 'expired', updated_at: knex.fn.now() });

  const protectedRows = await knex('opportunity_queue')
    .where('status', 'pending_review')
    .where('skip_reason', 'like', 'protected_page:%')
    .whereNot('skip_reason', 'protected_page:protected_check_error')
    .update({ status: 'skipped', updated_at: knex.fn.now() });

   
  console.log(`[20260718000020] review-queue cleanup: ${capRows} cap-parked → pending, ${gateRows} gate-fail → expired (revivable), ${protectedRows} protected-page → skipped`);
};

// Data-disposition change: the prior pending_review states are not
// reconstructable (and the new runner would immediately re-disposition them
// anyway), so down is a deliberate no-op.
exports.down = async function down() {};
