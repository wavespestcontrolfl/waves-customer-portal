/**
 * autonomous-runner.js — the orchestrator. Cron fires runNext() once
 * per business day (Mon–Fri 9am ET); it pulls the top opportunity,
 * runs the full chain, records the result.
 *
 * Per v3.1 plan:
 *   - SHADOW mode (default): compose brief + dispatch agent + run
 *     gates, but DO NOT publish, index, or plan links. Daily digest
 *     says "would have published X / would have gated Y / would have
 *     skipped Z."
 *   - LIVE mode: per-action-type opt-in (SHADOW_MODE map env). Even
 *     in live mode, the first N publishes per action type require
 *     human-approve regardless of gate score (TRUST_BUILD_THRESHOLD).
 *
 * Flow (every call):
 *   1. opportunity-queue.claimNext({ minScore })
 *   2. content-brief-builder.compose(opp.id)  → persists brief
 *   3. agent-dispatcher.runWithBrief(brief)   → emit_draft / emit_metadata
 *   4. uniqueness-gate.evaluate(draft, brief, { siblingPages })
 *   5. content-quality-gate.evaluate(draft, brief, context)
 *   6. if NOT shadow + both gates pass + trust-build OK:
 *        astro-publisher.publishOrUpdatePage(draft, brief)
 *        indexnow-submit.submit(url)
 *        internal-link-planner.planForTarget(target, ...) → enqueue
 *      else:
 *        opportunity-queue.skip(opp.id, reason) or queue.release on
 *        partial failure
 *   7. autonomous_runs row inserted with everything observed
 *
 * Shadow / trust-build defaults are conservative: ship with EVERY
 * action_type in shadow mode and trust-build threshold of 3. Adam
 * flips entries via `SHADOW_MODE_<ACTION_TYPE>=false` env vars as
 * he builds confidence.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { THRESHOLDS } = require('./scoring-config');

// Lazy loaders — keeps the runner usable on any branch in the stack.
function lazy(name, path) {
  let mod;
  return () => {
    if (mod === undefined) {
      try { mod = require(path); }
      catch (err) { logger.warn(`[autonomous-runner] ${name} unavailable: ${err.message}`); mod = null; }
    }
    return mod;
  };
}
const getQueue = lazy('opportunity-queue', './opportunity-queue');
const getBriefBuilder = lazy('brief-builder', './content-brief-builder');
const getDispatcher = lazy('agent-dispatcher', './agents/agent-dispatcher');
const getUniquenessGate = lazy('uniqueness-gate', './uniqueness-gate');
const getQualityGate = lazy('content-quality-gate', './content-quality-gate');
const getSeoCompletionGate = lazy('seo-completion-gate', './seo-completion-gate');
const getAstroPublisher = lazy('astro-publisher', '../content-astro/astro-publisher');
const getIndexNow = lazy('indexnow', '../seo/indexnow-submit');
const getLinkPlanner = lazy('internal-link-planner', './internal-link-planner');
const getSitemap = lazy('sitemap-manager', '../seo/sitemap-manager');

const TRUST_BUILD_THRESHOLD = parseInt(process.env.TRUST_BUILD_THRESHOLD || THRESHOLDS.autoPublishAfterApprovedRuns, 10);
const DEFAULT_MIN_SCORE = THRESHOLDS.minScoreToAct;

// Per-action-type shadow mode. Reads env var SHADOW_MODE_<ACTION_TYPE>
// (uppercase, dots/dashes → underscores). Unset → shadow ON. Set to
// "false" or "0" → shadow OFF (live publishing for that action type).
function isShadow(actionType) {
  const key = `SHADOW_MODE_${String(actionType || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const v = (process.env[key] || '').toLowerCase();
  if (v === 'false' || v === '0' || v === 'off') return false;
  return true;
}

class AutonomousRunner {
  /**
   * runNext({ minScore, dryRun })
   *
   * - dryRun=true short-circuits before any agent dispatch or publish
   *   side-effects — useful for the CLI to see "what would happen."
   *
   * Returns the autonomous_runs row that was written (or would have
   * been written in dryRun).
   */
  async runNext({ minScore = DEFAULT_MIN_SCORE, dryRun = false } = {}) {
    const t0 = Date.now();
    const run = {
      claimed_at: new Date(t0),
      shadow_mode: true, // updated when we know the action_type
      outcome: 'skipped_no_opportunity',
    };

    const queue = getQueue();
    if (!queue) return finalize(run, t0, { outcome: 'failed', failure_message: 'opportunity-queue unavailable' });
    if (dryRun) return this._previewNext({ queue, minScore, t0 });

    // 1. Claim.
    const t1 = Date.now();
    let opp;
    try {
      opp = await queue.claimNext({ minScore });
    } catch (err) {
      logger.warn(`[autonomous-runner] claim failed: ${err.message}`);
      return finalize(run, t0, { outcome: 'failed', failure_message: `claim:${err.message}` });
    }
    run.claim_ms = Date.now() - t1;
    if (!opp) return finalize(run, t0, { outcome: 'skipped_no_opportunity' });

    run.opportunity_id = opp.id;
    run.action_type = opp.action_type;
    run.shadow_mode = isShadow(opp.action_type);
    const claimToken = opp.claimed_at;

    // 2. Compose brief.
    const briefBuilder = getBriefBuilder();
    if (!briefBuilder) {
      await this._releaseClaimOrThrow(queue, opp.id, { claimToken });
      return finalize(run, t0, { outcome: 'failed', failure_message: 'brief-builder unavailable' });
    }
    const t2 = Date.now();
    let brief;
    try {
      brief = await briefBuilder.compose(opp.id, { persist: !dryRun, skipSerp: false });
    } catch (err) {
      await this._releaseClaimOrThrow(queue, opp.id, { claimToken });
      return finalize(run, t0, { outcome: 'failed', failure_message: `brief_compose:${err.message}` });
    }
    run.brief_ms = Date.now() - t2;
    run.brief_id = brief.id || null;
    run.page_type = brief.page_type;
    run.action_type = brief.action_type || opp.action_type;
    run.shadow_mode = isShadow(run.action_type);

    // 2a. Router blocked the action — record + skip.
    if (brief.action_type === 'do_not_publish') {
      const finalized = await finalize(run, t0, {
        outcome: 'skipped_gate_fail',
        skip_reason: brief.human_review_reason || 'router_do_not_publish',
      });
      await this._skipClaimOrThrow(queue, opp.id, brief.human_review_reason || 'router_do_not_publish', { claimToken });
      return finalized;
    }

    if (dryRun) {
      await this._releaseClaimOrThrow(queue, opp.id, { claimToken });
      return finalize(run, t0, {
        outcome: 'skipped_shadow_mode',
        skip_reason: 'dry_run_via_cli',
      });
    }

    if (brief.action_type === 'add_internal_links') {
      let result;
      try {
        result = await this._handleInternalLinksAction(brief, run);
      } catch (err) {
        await this._releaseClaimOrThrow(queue, opp.id, { claimToken });
        return finalize(run, t0, { outcome: 'failed', failure_message: `internal_links:${err.message}` });
      }
      const finalized = await finalize(run, t0, result.patch);
      if (result.patch.outcome === 'skipped_shadow_mode') {
        await this._pendingReviewClaimOrThrow(queue, opp.id, result.patch.skip_reason || 'shadow_internal_links', { claimToken });
      } else {
        await this._pendingReviewClaimOrThrow(queue, opp.id, result.patch.skip_reason || 'internal_links_pending_review', { claimToken });
      }
      return finalized;
    }

    if (brief.action_type === 'gbp_post') {
      const finalized = await finalize(run, t0, {
        outcome: 'completed_pending_review',
        skip_reason: 'gbp_post_not_implemented',
        reviewer_notes: 'GBP post distribution handler is not wired yet; route this opportunity manually.',
      });
      await this._pendingReviewClaimOrThrow(queue, opp.id, 'gbp_post_not_implemented', { claimToken });
      return finalized;
    }

    // 3. Dispatch agent — unless dryRun.
    const dispatcher = getDispatcher();
    if (!dispatcher) {
      await this._releaseClaimOrThrow(queue, opp.id, { claimToken });
      return finalize(run, t0, { outcome: 'failed', failure_message: 'agent-dispatcher unavailable' });
    }
    const t3 = Date.now();
    const dispatchResult = await dispatcher.runWithBrief(brief, { dryRun }).catch((err) => ({
      ok: false, reason: `dispatch_threw:${err.message}`,
    }));
    run.agent_ms = Date.now() - t3;

    if (!dispatchResult.ok) {
      if (dispatchResult.reason === 'dry_run') {
        await this._releaseClaimOrThrow(queue, opp.id, { claimToken });
        // Defensive dryRun short-circuit — finalize as if shadow_mode skipped.
        return finalize(run, t0, {
          outcome: 'skipped_shadow_mode',
          skip_reason: 'dry_run_via_cli',
        });
      }
      await this._releaseClaimOrThrow(queue, opp.id, { claimToken });
      return finalize(run, t0, {
        outcome: 'failed_agent',
        failure_message: dispatchResult.reason,
      });
    }

    const draft = dispatchResult.draft;
    run.agent_id = dispatchResult.agent_id || null;
    run.agent_session_id = dispatchResult.session_id || null;
    run.draft_payload = draft || null;
    if (!draft) {
      await this._releaseClaimOrThrow(queue, opp.id, { claimToken });
      return finalize(run, t0, { outcome: 'failed_agent', failure_message: 'no draft from agent' });
    }

    if (brief.action_type === 'rewrite_title_meta') {
      const finalized = await finalize(run, t0, {
        outcome: 'completed_pending_review',
        skip_reason: 'metadata_requires_existing_page_hydration',
        reviewer_notes: 'Metadata-only agent output must be hydrated with the existing page before gates/publish; route manually until that adapter is wired.',
      });
      await this._pendingReviewClaimOrThrow(queue, opp.id, 'metadata_requires_existing_page_hydration', { claimToken });
      return finalized;
    }

    // 4. Uniqueness gate (only applies to certain page types).
    const uniquenessGate = getUniquenessGate();
    const needsUniquenessGate = brief.page_type === 'city-service' || brief.page_type === 'customer-question';
    let uniquenessResult = { ok: true, skipped: 'not_applicable' };
    if (!uniquenessGate && needsUniquenessGate) {
      uniquenessResult = { ok: false, error: 'uniqueness_gate_unavailable' };
    } else if (uniquenessGate && needsUniquenessGate) {
      const t4 = Date.now();
      try {
        const siblingPages = await this._loadSiblingPages(brief, { required: true });
        uniquenessResult = uniquenessGate.evaluate(draft, brief, { siblingPages });
      } catch (err) {
        uniquenessResult = { ok: false, error: err.message };
      }
      run.uniqueness_gate_ms = Date.now() - t4;
    }
    run.uniqueness_gate_result = uniquenessResult;

    // 5. Quality gate.
    const qualityGate = getQualityGate();
    let qualityResult = { ok: false, error: 'quality_gate_unavailable' };
    if (qualityGate) {
      const t5 = Date.now();
      const sitemap = getSitemap();
      const ctx = {};
      const checkSitemapBeforePublish = ['refresh_existing_page'].includes(brief.action_type);
      if (sitemap && draft.url && checkSitemapBeforePublish) {
        const has = await sitemap.hasUrl(draft.url).catch(() => null);
        if (has) ctx.sitemapHasUrl = has.present;
      }
      try {
        qualityResult = qualityGate.evaluate(draft, brief, ctx);
      } catch (err) {
        qualityResult = { ok: false, error: err.message };
      }
      run.quality_gate_ms = Date.now() - t5;
    }
    run.quality_gate_result = qualityResult;

    // 5a. SEO completion gate for generated supporting-blog drafts.
    const seoCompletionGate = getSeoCompletionGate();
    const requiresSeoCompletion = run.action_type === 'new_supporting_blog' || brief.page_type === 'supporting-blog';
    const seoGateBrief = {
      ...brief,
      action_type: run.action_type === 'new_supporting_blog' ? run.action_type : brief.action_type,
      page_type: brief.page_type || (run.action_type === 'new_supporting_blog' ? 'supporting-blog' : undefined),
    };
    let seoCompletionResult = requiresSeoCompletion
      ? {
          passed: false,
          error: 'seo_completion_gate_unavailable',
          findings: [{
            severity: 'P0',
            code: 'P0_SEO_COMPLETION_GATE_UNAVAILABLE',
            message: 'SEO completion gate is unavailable for a generated supporting-blog draft.',
            recommendation: 'Fix the SEO completion gate dependency before creating an Astro PR.',
          }],
          summary: { passed: false, p0: 1, p1: 0, p2: 0, p3: 0, needs_review: true },
        }
      : { passed: true, skipped: 'not_supporting_blog', findings: [], summary: { passed: true, p0: 0, p1: 0, p2: 0, p3: 0, needs_review: false } };
    if (seoCompletionGate?.evaluate) {
      const tSeo = Date.now();
      try {
        seoCompletionResult = seoCompletionGate.evaluate({
          draft,
          brief: seoGateBrief,
          uniquenessResult,
          shadowMode: run.shadow_mode,
          actionType: run.action_type,
          pageType: seoGateBrief.page_type,
        });
        if (requiresSeoCompletion && seoCompletionResult?.skipped) {
          seoCompletionResult = {
            passed: false,
            error: 'seo_completion_gate_skipped_required',
            findings: [{
              severity: 'P0',
              code: 'P0_SEO_COMPLETION_GATE_SKIPPED',
              message: 'SEO completion gate skipped a generated supporting-blog draft that requires review.',
              recommendation: 'Ensure the runner passes supporting-blog action/page metadata into the SEO completion gate before publishing.',
            }],
            summary: { passed: false, p0: 1, p1: 0, p2: 0, p3: 0, needs_review: true },
          };
        }
      } catch (err) {
        seoCompletionResult = {
          passed: false,
          error: err.message,
          findings: [{ severity: 'P0', code: 'P0_SEO_COMPLETION_GATE_ERROR', message: err.message, recommendation: 'Fix the SEO completion gate error before publishing.' }],
          summary: { passed: false, p0: 1, p1: 0, p2: 0, p3: 0, needs_review: true },
        };
      }
      run.seo_completion_gate_ms = Date.now() - tSeo;
    }
    run.seo_completion_gate_result = seoCompletionResult;
    if (qualityResult && typeof qualityResult === 'object') {
      qualityResult.seo_completion = seoCompletionResult;
      run.quality_gate_result = qualityResult;
    }
    if (seoCompletionResult?.contract) {
      draft.seo_contract = seoCompletionResult.contract;
      draft.seo_completion_findings = seoCompletionResult.findings || [];
      run.draft_payload = draft;
      brief.seo_completion_gate_result = seoCompletionResult;
      brief.seo_contract = seoCompletionResult.contract;
    }

    const gatesPass = uniquenessResult.ok && qualityResult.ok && seoCompletionResult.passed !== false;

    // 6. Trust-build check.
    const trustBuildCount = await this._getTrustBuildCount(run.action_type).catch(() => 0);
    const trustBuildSatisfied = trustBuildCount >= TRUST_BUILD_THRESHOLD;
    run.trust_build_count_after = trustBuildCount + (gatesPass ? 1 : 0);

    // 7. Decide outcome.
    if (dryRun || run.shadow_mode) {
      // Shadow / dry: never publish. Record what would have happened.
      const wouldPublish = gatesPass && trustBuildSatisfied && !brief.human_review_required;
      const finalized = await finalize(run, t0, {
        outcome: 'skipped_shadow_mode',
        skip_reason: wouldPublish ? 'shadow_would_publish' : 'shadow_would_gate',
      });
      await this._pendingReviewClaimOrThrow(queue, opp.id, finalized.skip_reason, { claimToken });
      return finalized;
    }

    if (!gatesPass || !trustBuildSatisfied || brief.human_review_required) {
      const reason = !gatesPass ? 'gate_fail'
        : !trustBuildSatisfied ? `trust_build_${trustBuildCount}_of_${TRUST_BUILD_THRESHOLD}`
        : 'brief_requires_human_review';
      const trustBuildNote = reason.startsWith('trust_build_')
        ? 'Review autonomous_runs.draft_payload, then approve with server/scripts/approve-autonomous-run.js --id=<run_id> --by=<operator>.'
        : null;
      const finalized = await finalize(run, t0, {
        outcome: 'completed_pending_review',
        skip_reason: reason,
        reviewer_notes: [this._summarizeForReviewer(uniquenessResult, qualityResult, seoCompletionResult, brief), trustBuildNote].filter(Boolean).join(' | '),
      });
      await this._pendingReviewClaimOrThrow(queue, opp.id, reason, { claimToken });
      return finalized;
    }

    if (!this._hasDraftBriefPublisher(draft, brief)) {
      const finalized = await finalize(run, t0, {
        outcome: 'completed_pending_review',
        skip_reason: 'publisher_adapter_unavailable',
        reviewer_notes: 'Astro draft/brief publisher adapter is not wired yet; route this approved draft manually.',
      });
      await this._pendingReviewClaimOrThrow(queue, opp.id, 'publisher_adapter_unavailable', { claimToken });
      return finalized;
    }

    // 8. Publish + index + plan links.
    let publishOutcome;
    try {
      publishOutcome = await this._publishAndDistribute(draft, brief, run);
    } catch (err) {
      if (isDeterministicPublishError(err)) {
        const finalized = await finalize(run, t0, {
          outcome: 'completed_pending_review',
          skip_reason: 'publish_validation_failed',
          failure_message: err.message,
          reviewer_notes: `Astro publish validation failed before publishing: ${err.message}`,
        });
        await this._pendingReviewClaimOrThrow(queue, opp.id, 'publish_validation_failed', { claimToken });
        return finalized;
      }
      await this._releaseClaimOrThrow(queue, opp.id, { claimToken }); // let next run retry
      return finalize(run, t0, {
        outcome: 'failed_publish',
        failure_message: err.message,
      });
    }

    Object.assign(run, publishOutcome);
    if (!publishOutcome.published_url) {
      const reason = 'astro_pr_pending_merge';
      const notes = publishOutcome.astro_pr_url
        ? `Astro PR opened: ${publishOutcome.astro_pr_url}. Merge and verify deployment before indexing.`
        : 'Publish adapter completed without a live URL; route manually before indexing.';
      let finalized;
      try {
        finalized = await finalize(run, t0, {
          outcome: 'completed_pending_review',
          skip_reason: reason,
          reviewer_notes: notes,
        });
      } catch (err) {
        await this._parkPublishedClaimForReconciliation(queue, opp.id, 'astro_pr_audit_failed', { claimToken }, err);
        throw err;
      }
      try {
        await this._pendingReviewClaimOrThrow(queue, opp.id, reason, { claimToken });
      } catch (err) {
        await this._parkPublishedClaimForReconciliation(queue, opp.id, 'astro_pr_queue_transition_failed', { claimToken }, err);
      }
      return finalized;
    }

    let finalized;
    try {
      finalized = await finalize(run, t0, { outcome: 'completed_published' });
    } catch (err) {
      await this._parkPublishedClaimForReconciliation(queue, opp.id, 'published_audit_failed', { claimToken }, err);
      throw err;
    }

    try {
      await this._completeClaimOrThrow(queue, opp.id, { notes: `published:${publishOutcome.published_url || 'unknown'}`, claimToken });
    } catch (err) {
      await this._parkPublishedClaimForReconciliation(queue, opp.id, 'published_queue_complete_failed', { claimToken }, err);
    }
    return finalized;
  }

  /**
   * Drains the queue for the cron — runs runNext() once per call.
   * The cron only fires once per day at 9am ET, so this is a thin
   * wrapper today; future expansion could batch multiple actions
   * per day per the weekly mix in scoring-config.WEEKLY_MIX.
   */
  async runDaily() {
    const run = await this.runNext();
    await this._appendToDailyDigest(run).catch(() => {});
    return run;
  }

  // ── internals ────────────────────────────────────────────────────

  async _previewNext({ queue, minScore, t0 }) {
    const run = {
      claimed_at: new Date(t0),
      shadow_mode: true,
      outcome: 'skipped_no_opportunity',
    };

    const rows = await queue.peek({ limit: 1, minScore }).catch((err) => {
      logger.warn(`[autonomous-runner] preview peek failed: ${err.message}`);
      return [];
    });
    const opp = rows?.[0];
    if (!opp) return finalize(run, t0, { outcome: 'skipped_no_opportunity' }, { persist: false });

    run.opportunity_id = opp.id;
    run.action_type = opp.action_type;

    const briefBuilder = getBriefBuilder();
    if (!briefBuilder) {
      return finalize(run, t0, { outcome: 'failed', failure_message: 'brief-builder unavailable' }, { persist: false });
    }

    try {
      const brief = await briefBuilder.compose(opp.id, { persist: false, skipSerp: true });
      run.brief_id = brief.id || null;
      run.page_type = brief.page_type;
      run.action_type = brief.action_type || opp.action_type;
      run.shadow_mode = isShadow(run.action_type);
      return finalize(run, t0, {
        outcome: brief.action_type === 'do_not_publish' ? 'skipped_gate_fail' : 'skipped_shadow_mode',
        skip_reason: brief.action_type === 'do_not_publish'
          ? (brief.human_review_reason || 'router_do_not_publish')
          : 'dry_run_via_cli',
      }, { persist: false });
    } catch (err) {
      return finalize(run, t0, { outcome: 'failed', failure_message: `brief_compose:${err.message}` }, { persist: false });
    }
  }

  async _loadSiblingPages(brief, { required = false } = {}) {
    // For city-service and customer-question, load sibling pages
    // matching the service for Jaccard comparison. For now we read
    // from the local Astro corpus via the link planner's loader; in
    // a future iteration this could pull from github-client directly.
    if (brief.page_type !== 'city-service' && brief.page_type !== 'customer-question') return [];
    const planner = getLinkPlanner();
    if (!planner?.loadAstroCorpus) {
      if (required) throw new Error('sibling_corpus_loader_unavailable');
      return [];
    }
    const astroDir = process.env.ASTRO_REPO_DIR;
    if (!astroDir) {
      if (required) throw new Error('ASTRO_REPO_DIR required for live uniqueness gate');
      return [];
    }
    try {
      const corpus = planner.loadAstroCorpus(astroDir, { collections: ['services', 'locations'] });
      const service = (brief.service || '').toLowerCase();
      return corpus.filter((p) => service && p.file.toLowerCase().includes(service));
    } catch (err) {
      if (required) throw err;
      return [];
    }
  }

  async _completeClaimOrThrow(queue, opportunityId, payload) {
    const ok = await queue.complete(opportunityId, payload);
    if (!ok) throw new Error('queue_complete_failed_or_stale_claim');
  }

  async _skipClaimOrThrow(queue, opportunityId, reason, payload) {
    const ok = await queue.skip(opportunityId, reason, payload);
    if (!ok) throw new Error('queue_skip_failed_or_stale_claim');
  }

  async _pendingReviewClaimOrThrow(queue, opportunityId, reason, payload) {
    const ok = await queue.pendingReview(opportunityId, reason, payload);
    if (!ok) throw new Error('queue_pending_review_failed_or_stale_claim');
  }

  async _releaseClaimOrThrow(queue, opportunityId, payload) {
    const ok = await queue.release(opportunityId, payload);
    if (!ok) throw new Error('queue_release_failed_or_stale_claim');
  }

  async _parkPublishedClaimForReconciliation(queue, opportunityId, reason, payload, cause) {
    logger.error(`[autonomous-runner] published ${opportunityId} but ${reason}: ${cause.message}`);
    try {
      await this._pendingReviewClaimOrThrow(queue, opportunityId, reason, payload);
    } catch (err) {
      logger.error(`[autonomous-runner] failed to park published ${opportunityId} for reconciliation: ${err.message}`);
    }
  }

  async _getTrustBuildCount(actionType) {
    try {
      const rows = await db('autonomous_runs')
        .where('action_type', actionType)
        .where('shadow_mode', false)
        .whereIn('outcome', ['completed_published', 'completed_pending_review'])
        .select('outcome', 'skip_reason', 'trust_build_approved_at');
      return (rows || []).filter(countsTowardTrustBuild).length;
    } catch { return 0; }
  }

  async _handleInternalLinksAction(brief, run) {
    if (run.shadow_mode) {
      return {
        notes: 'shadow_internal_links',
        patch: { outcome: 'skipped_shadow_mode', skip_reason: 'shadow_internal_links' },
      };
    }

    const planner = getLinkPlanner();
    if (!planner?.planForTarget) {
      return {
        notes: 'pending_review:internal_link_planner_unavailable',
        patch: {
          outcome: 'completed_pending_review',
          skip_reason: 'internal_link_planner_unavailable',
          reviewer_notes: 'Internal-link planner module was unavailable; route manually.',
        },
      };
    }

    const t = Date.now();
    const astroDir = process.env.ASTRO_REPO_DIR;
    const corpus = astroDir && planner.loadAstroCorpus ? planner.loadAstroCorpus(astroDir) : [];
    const tasks = planner.planForTarget(
      { url: brief.target_url, keyword: brief.target_keyword, city: brief.city, service: brief.service, title: brief.title },
      { corpus, opportunityId: run.opportunity_id }
    );
    let insertedCount = 0;
    for (const task of tasks) {
      const inserted = await db('content_internal_link_tasks')
        .insert(task)
        .onConflict(['source_file', 'target_url', 'anchor_text'])
        .ignore()
        .returning('id');
      insertedCount += Array.isArray(inserted) ? inserted.length : (inserted ? 1 : 0);
    }
    run.link_plan_ms = Date.now() - t;
    return {
      notes: `internal_links_queued:${insertedCount}`,
      patch: {
        outcome: 'completed_pending_review',
        skip_reason: 'internal_links_queued',
        link_tasks_queued: insertedCount,
        reviewer_notes: `Queued ${insertedCount} internal-link task(s) for manual/apply review.`,
      },
    };
  }

  _hasDraftBriefPublisher(draft, brief) {
    const publisher = getAstroPublisher();
    if (!publisher?.publishOrUpdatePage) return false;
    if (typeof publisher.canPublishDraftBrief === 'function') return publisher.canPublishDraftBrief(draft, brief);
    return true;
  }

  async _publishAndDistribute(draft, brief, run) {
    const out = {};
    const publisher = getAstroPublisher();
    const indexNow = getIndexNow();
    const planner = getLinkPlanner();

    // Publish via existing astro-publisher. We pass the draft + brief;
    // the publisher decides whether to open a PR or commit directly to
    // main based on its own configuration. The astro-publisher service
    // pre-dates this engine and handles the PR open/merge state machine.
    const t1 = Date.now();
    if (publisher?.publishOrUpdatePage) {
      const r = await publisher.publishOrUpdatePage(draft, brief);
      const isLive = r?.live === true || r?.status === 'live' || r?.merged === true;
      out.published_url = isLive ? (r?.url || draft.url || null) : null;
      out.pending_url = isLive ? null : (r?.url || draft.url || null);
      out.publish_status = r?.status || (isLive ? 'live' : (r?.pr_url ? 'pr_open' : null));
      out.astro_pr_url = r?.pr_url || null;
    } else {
      throw new Error('astro-publisher draft/brief adapter unavailable');
    }
    run.publish_ms = Date.now() - t1;

    // IndexNow submission.
    if (indexNow?.submit && out.published_url) {
      const t2 = Date.now();
      let r;
      try {
        r = await indexNow.submit(out.published_url);
      } catch (err) {
        logger.warn(`[autonomous-runner] indexnow failed: ${err.message}`);
        r = { ok: false, error: err.message };
      }
      out.indexnow_status = r.status || (r.ok ? 'ok' : 'error');
      run.index_submit_ms = Date.now() - t2;
    }

    // Internal-link planning.
    if (planner?.planForTarget && out.published_url) {
      const t3 = Date.now();
      try {
        const astroDir = process.env.ASTRO_REPO_DIR;
        const corpus = astroDir ? planner.loadAstroCorpus(astroDir) : [];
        const tasks = planner.planForTarget(
          { url: out.published_url, keyword: brief.target_keyword, city: brief.city, service: brief.service },
          { corpus, opportunityId: run.opportunity_id }
        );
        for (const task of tasks) {
          await db('content_internal_link_tasks').insert(task).onConflict(['source_file', 'target_url', 'anchor_text']).ignore().catch(() => {});
        }
        out.link_tasks_queued = tasks.length;
      } catch (err) {
        logger.warn(`[autonomous-runner] link-planner failed: ${err.message}`);
      }
      run.link_plan_ms = Date.now() - t3;
    }

    return out;
  }

  _summarizeForReviewer(uniquenessResult, qualityResult, seoCompletionResult, brief) {
    const lines = [];
    if (brief.human_review_required) lines.push(`router: ${brief.human_review_reason}`);
    if (!uniquenessResult.ok) {
      const failed = (uniquenessResult.failed_reasons || []).slice(0, 5);
      lines.push(`uniqueness: ${failed.join('; ') || 'failed'}`);
    }
    if (!qualityResult.ok) {
      const hard = (qualityResult.hard_failures || []).map((f) => f.name).join(', ');
      const soft = (qualityResult.soft_failures || []).slice(0, 3).map((f) => f.name).join(', ');
      lines.push(`quality: hard=${hard || 'none'} soft=${soft || 'none'} score=${qualityResult.total_score}/${qualityResult.min_total_score}`);
    }
    if (seoCompletionResult?.passed === false || seoCompletionResult?.summary?.needs_review) {
      const summary = seoCompletionResult.summary || {};
      lines.push(`seo_completion: P0=${summary.p0 || 0} P1=${summary.p1 || 0} P2=${summary.p2 || 0} score=${seoCompletionResult.score ?? 'n/a'}`);
    }
    return lines.join(' | ');
  }

  async _appendToDailyDigest(run) {
    // v1 digest = log line. A future iteration sends an SMS or writes
    // to a digest_log table.
    logger.info(`[autonomous-runner] daily: ${JSON.stringify({
      action_type: run.action_type,
      outcome: run.outcome,
      skip_reason: run.skip_reason,
      shadow_mode: run.shadow_mode,
      total_ms: run.total_ms,
    })}`);
  }
}

// ── finalize: persist autonomous_runs row + return it ───────────────

async function finalize(run, t0, patch, { persist = true } = {}) {
  Object.assign(run, patch, { total_ms: Date.now() - t0, completed_at: new Date() });
  if (!persist) return run;
  try {
    const [persisted] = await db('autonomous_runs').insert({
      opportunity_id: run.opportunity_id || null,
      brief_id: run.brief_id || null,
      action_type: run.action_type || 'unknown',
      page_type: run.page_type || null,
      shadow_mode: run.shadow_mode === undefined ? true : !!run.shadow_mode,
      claim_ms: run.claim_ms || null,
      brief_ms: run.brief_ms || null,
      agent_ms: run.agent_ms || null,
      uniqueness_gate_ms: run.uniqueness_gate_ms || null,
      quality_gate_ms: run.quality_gate_ms || null,
      publish_ms: run.publish_ms || null,
      index_submit_ms: run.index_submit_ms || null,
      link_plan_ms: run.link_plan_ms || null,
      total_ms: run.total_ms,
      outcome: run.outcome,
      skip_reason: run.skip_reason || null,
      failure_message: run.failure_message || null,
      uniqueness_gate_result: JSON.stringify(run.uniqueness_gate_result || {}),
      quality_gate_result: JSON.stringify(run.quality_gate_result || {}),
      draft_payload: JSON.stringify(run.draft_payload || {}),
      agent_id: run.agent_id || null,
      agent_session_id: run.agent_session_id || null,
      trust_build_count_after: run.trust_build_count_after || 0,
      published_url: run.published_url || null,
      astro_pr_url: run.astro_pr_url || null,
      indexnow_status: run.indexnow_status || null,
      link_tasks_queued: run.link_tasks_queued || 0,
      reviewer_notes: run.reviewer_notes || null,
      claimed_at: run.claimed_at,
      completed_at: run.completed_at,
    }).returning('id');
    run.id = persisted?.id || persisted;
  } catch (err) {
    logger.warn(`[autonomous-runner] persist failed: ${err.message}`);
    throw err;
  }
  return run;
}

function countsTowardTrustBuild(row) {
  if (row?.outcome === 'completed_published') return true;
  return row?.outcome === 'completed_pending_review'
    && /^trust_build_\d+_of_\d+$/.test(String(row.skip_reason || ''))
    && !!row.trust_build_approved_at;
}

function isDeterministicPublishError(err) {
  if (err?.code === 'BLOG_FRONTMATTER_INVALID') return true;
  const message = String(err?.message || '');
  return [
    /^unsupported autonomous draft for Astro publish:/,
    /^autonomous draft missing safe frontmatter slug$/,
    /^autonomous draft canonical is not a valid URL$/,
    /^autonomous draft canonical must match slug /,
  ].some((pattern) => pattern.test(message));
}

module.exports = new AutonomousRunner();
module.exports.AutonomousRunner = AutonomousRunner;
module.exports._internals = {
  isShadow,
  TRUST_BUILD_THRESHOLD,
  DEFAULT_MIN_SCORE,
  countsTowardTrustBuild,
  isDeterministicPublishError,
};
