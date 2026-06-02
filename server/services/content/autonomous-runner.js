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
const { etDateString, parseETDateTime, etWeekStart } = require('../../utils/datetime-et');
const { THRESHOLDS } = require('./scoring-config');

// Database-wide advisory-lock key for the publishing run. Held for the whole
// daily batch (and by the manual --live single run) so two autonomous runs
// never publish concurrently — overlapping runs would each independently honor
// the per-day/week caps and could exceed them. Within a single locked batch the
// runNext() calls are sequential, so the cap counts are accurate. The lock is
// db-wide, so it also serializes across multiple app instances. 0x57415645 =
// "WAVE" in ASCII; a fixed key shared by every publishing entry point.
const ENGINE_PUBLISH_LOCK_KEY = 0x57415645;

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
const getInternalLinkExecutor = lazy('internal-link-pr-executor', './internal-link-pr-executor');
const getSitemap = lazy('sitemap-manager', '../seo/sitemap-manager');
const getPostPublishVisibilityWorker = lazy('post-publish-visibility-worker', './post-publish-visibility-worker');
const getAiVisibilityGate = lazy('ai-visibility-gate', './ai-visibility-gate');
const getTitleMetaSpamGate = lazy('title-meta-spam-gate', './title-meta-spam-gate');
const getFactsSufficiency = lazy('facts-sufficiency', './facts-sufficiency');
const getClaimsLedgerValidator = lazy('claims-ledger-validator', './claims-ledger-validator');
const getProtectedPages = lazy('protected-pages', './protected-pages');
const getContentGuardrails = lazy('content-guardrails', './content-guardrails');
const getImpactTracker = lazy('impact-tracker', '../seo/impact-tracker');

const TRUST_BUILD_THRESHOLD = parseInt(process.env.TRUST_BUILD_THRESHOLD || THRESHOLDS.autoPublishAfterApprovedRuns, 10);
const DEFAULT_MIN_SCORE = THRESHOLDS.minScoreToAct;
const INTERNAL_LINK_RETRYABLE_STATUSES = ['pending', 'queued', 'patch_candidate', 'skipped', 'failed'];

// Per-action-type shadow mode. Reads env var SHADOW_MODE_<ACTION_TYPE>
// (uppercase, dots/dashes → underscores). Unset → shadow ON. Set to
// "false" or "0" → shadow OFF (live publishing for that action type).
function isShadow(actionType) {
  const key = `SHADOW_MODE_${String(actionType || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const v = (process.env[key] || '').toLowerCase();
  if (v === 'false' || v === '0' || v === 'off') return false;
  return true;
}

// Per-action-type auto-publish. When AUTO_PUBLISH_<ACTION_TYPE>=true|1|on,
// that action type skips the human trust-build ramp: a draft that clears
// EVERY quality/SEO/guardrail gate publishes automatically (still subject to
// the canary publishing guards + daily/weekly publish caps). A draft that
// FAILS a quality gate is skipped silently rather than queued for review.
// Router-flagged human-review cases (loop / cannibalization / .gov SERP)
// still route to review. Unset → the trust-build approval ramp applies.
function autoPublishEnabled(actionType) {
  const key = `AUTO_PUBLISH_${String(actionType || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const v = (process.env[key] || '').toLowerCase();
  return v === 'true' || v === '1' || v === 'on';
}

// Actions that require verified facts-bank backing before drafting — kept in
// sync with facts-sufficiency.js FACTS_GATED_ACTIONS. If the facts-sufficiency
// module is unavailable, a LIVE one of these must fail closed (skip) rather
// than draft unverified content (the pre-gate + claims-ledger validator are
// both skipped when the module can't load).
const FACTS_GATED_ACTIONS = new Set([
  'create_or_refresh_city_service_page',
  'refresh_existing_page',
  'create_customer_question_page',
  'new_supporting_blog',
]);

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
  async runNext({ minScore = DEFAULT_MIN_SCORE, dryRun = false, excludeIds = [] } = {}) {
    const t0 = Date.now();
    const run = {
      claimed_at: new Date(t0),
      shadow_mode: true, // updated when we know the action_type
      outcome: 'skipped_no_opportunity',
    };

    const queue = getQueue();
    if (!queue) return finalize(run, t0, { outcome: 'failed', failure_message: 'opportunity-queue unavailable' });
    if (dryRun) return this._previewNext({ queue, minScore, t0 });

    await this._verifyMergedInternalLinkPrs(run);

    // 1. Claim.
    const t1 = Date.now();
    let opp;
    try {
      opp = await queue.claimNext({ minScore, excludeIds });
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

    // 1a. Protected-page guard. Money pages, high-traffic pages, and manually
    // protected URLs are never auto-optimized — regardless of facts. This runs
    // FIRST so e.g. /pest-control-sarasota-fl/ is blocked even though
    // "sarasota × pest-control" passes facts sufficiency.
    const initialProtected = await this._checkProtectedPage(opp);
    if (initialProtected?.protected) {
      const finalized = await finalize(run, t0, protectedPagePatch(initialProtected));
      await this._pendingReviewClaimOrThrow(queue, opp.id, `protected_page:${initialProtected.reason}`, { claimToken });
      return finalized;
    }
    if (initialProtected) run.protected_check = initialProtected;

    // 1a.2 Auto-pause guard. A bucket that has accrued repeated regressions
    // (per the impact tracker's diff-in-diff verdicts) is paused — stop
    // drafting that action type until a human reviews the losses.
    const impactTracker = getImpactTracker();
    if (impactTracker?.pausedBuckets && opp.bucket) {
      let paused = [];
      try { paused = await impactTracker.pausedBuckets({ db }); } catch { paused = []; }
      if (paused.some((p) => p.bucket === opp.bucket)) {
        const finalized = await finalize(run, t0, {
          outcome: 'skipped_gate_fail',
          skip_reason: `bucket_paused:${opp.bucket}`,
          reviewer_notes: `Bucket "${opp.bucket}" auto-paused after repeated regressions — review impact verdicts before resuming.`,
        });
        await this._pendingReviewClaimOrThrow(queue, opp.id, `bucket_paused:${opp.bucket}`, { claimToken });
        return finalized;
      }
    }

    // (Facts-sufficiency runs AFTER brief composition — the decision-router can
    // change the final action_type, so the gate must key on brief.action_type,
    // not the claimed opp.action_type. See step 2b below.)

    // 2. Compose brief.
    const briefBuilder = getBriefBuilder();
    if (!briefBuilder) {
      await this._releaseClaimOrThrow(queue, opp.id, { claimToken });
      return finalize(run, t0, { outcome: 'failed', failure_message: 'brief-builder unavailable' });
    }
    const t2 = Date.now();
    let brief;
    try {
      brief = await briefBuilder.compose(opp.id, {
        persist: !dryRun,
        skipSerp: opp.action_type === 'add_internal_links',
      });
    } catch (err) {
      await this._releaseClaimOrThrow(queue, opp.id, { claimToken });
      return finalize(run, t0, { outcome: 'failed', failure_message: `brief_compose:${err.message}` });
    }
    run.brief_ms = Date.now() - t2;
    run.brief_id = brief.id || null;
    run.page_type = brief.page_type;
    run.action_type = brief.action_type || opp.action_type;
    run.shadow_mode = isShadow(run.action_type);

    const finalProtected = await this._checkProtectedPage(opp, brief);
    if (finalProtected?.protected) {
      run.protected_check = finalProtected;
      const finalized = await finalize(run, t0, protectedPagePatch(finalProtected));
      await this._pendingReviewClaimOrThrow(queue, opp.id, `protected_page:${finalProtected.reason}`, { claimToken });
      return finalized;
    }
    if (finalProtected) run.protected_check = finalProtected;

    // 2b. Facts-sufficiency gate. Keyed on the FINAL (router-decided)
    // action_type — for content-generating city×service actions, refuse to
    // draft unless the facts-bank has verified local facts to ground the
    // claims. Sets run.facts_sufficiency, which the claims-ledger gate (after
    // dispatch) keys on. Insufficient → human review. Fail-closed by design.
    const factsSufficiency = getFactsSufficiency();
    if (factsSufficiency) {
      const finalOpp = { ...opp, action_type: brief.action_type, city: brief.city || opp.city, service: brief.service || opp.service };
      let factsCheck;
      try {
        factsCheck = await factsSufficiency.check(finalOpp);
      } catch (err) {
        logger.warn(`[autonomous-runner] facts-sufficiency check threw: ${err.message}`);
        factsCheck = { applicable: true, sufficient: false, reason: 'facts_check_error', gap_codes: [`threw:${err.message}`], notes: `facts check threw: ${err.message}` };
      }
      run.facts_sufficiency = factsCheck;
      if (factsCheck.applicable && !factsCheck.sufficient) {
        const finalized = await finalize(run, t0, {
          outcome: 'skipped_gate_fail',
          skip_reason: factsCheck.reason || 'facts_insufficient',
          reviewer_notes: factsCheck.notes,
        });
        await this._pendingReviewClaimOrThrow(queue, opp.id, factsCheck.reason || 'facts_insufficient', { claimToken });
        return finalized;
      }
    } else if (FACTS_GATED_ACTIONS.has(brief.action_type) && !run.shadow_mode) {
      // Fail-closed: facts-sufficiency module is unavailable but this is a
      // LIVE facts-gated action. Refuse to draft — publishing unverified
      // content (with the claims-ledger validator also skipped) is the one
      // outcome this gate exists to prevent. Route to review + alert loudly.
      logger.error(`[autonomous-runner] facts-sufficiency module unavailable — refusing live facts-gated action ${brief.action_type}`);
      const finalized = await finalize(run, t0, {
        outcome: 'skipped_gate_fail',
        skip_reason: 'facts_sufficiency_unavailable',
        reviewer_notes: 'Facts-sufficiency module failed to load; live facts-gated action held to avoid publishing unverified content.',
      });
      await this._pendingReviewClaimOrThrow(queue, opp.id, 'facts_sufficiency_unavailable', { claimToken });
      return finalized;
    }

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
    const dispatchResult = await dispatcher.runWithBrief(brief, {
      dryRun,
      sessionTimeoutMs: agentSessionTimeoutMs(run.action_type, brief),
    }).catch((err) => ({
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
      let result;
      try {
        result = await this._handleMetadataRewriteAction(brief, draft, run);
      } catch (err) {
        if (isDeterministicPublishError(err)) {
          const finalized = await finalize(run, t0, {
            outcome: 'completed_pending_review',
            skip_reason: 'metadata_publish_validation_failed',
            failure_message: err.message,
            reviewer_notes: `Metadata publish validation failed before creating an Astro PR: ${err.message}`,
          });
          await this._pendingReviewClaimOrThrow(queue, opp.id, 'metadata_publish_validation_failed', { claimToken });
          return finalized;
        }
        await this._releaseClaimOrThrow(queue, opp.id, { claimToken });
        return finalize(run, t0, { outcome: 'failed_publish', failure_message: `metadata:${err.message}` });
      }
      const finalized = await finalize(run, t0, result.patch);
      if (result.queue === 'complete') {
        await this._completeClaimOrThrow(queue, opp.id, { notes: result.notes, claimToken });
      } else {
        await this._pendingReviewClaimOrThrow(queue, opp.id, result.patch.skip_reason || result.notes, { claimToken });
      }
      return finalized;
    }

    // 3b. Claims-ledger validation. For facts-gated content actions that
    // passed the facts-sufficiency pre-gate, verify every local claim in the
    // draft traces to a real fact and does not overreach. P0/P1 findings
    // (hallucinated fact citation, missing ledger when required) route to
    // human review rather than publishing ungrounded local copy.
    const factsCtx = run.facts_sufficiency;
    if (factsCtx && factsCtx.applicable && factsCtx.sufficient && draft) {
      const claimsValidator = getClaimsLedgerValidator();
      if (claimsValidator) {
        let claimsResult;
        try {
          claimsResult = await claimsValidator.validate(draft, {
            city: factsCtx.city_id,
            service: factsCtx.service_id,
            county: factsCtx.county,
          }, {
            // Facts were sufficient (a facts_pack was supplied and the agent
            // was told to emit a ledger), so a MISSING ledger is a real
            // failure here — block it regardless of the global default.
            options: { missingLedgerSeverity: 'P1' },
          });
        } catch (err) {
          logger.warn(`[autonomous-runner] claims-ledger validation threw: ${err.message}`);
          claimsResult = { pass: false, findings: [{ severity: 'P1', code: 'CLAIMS_LEDGER_ERROR', message: err.message }] };
        }
        run.claims_ledger_result = claimsResult;
        if (!claimsResult.pass) {
          const blocking = claimsResult.findings.filter((f) => f.severity === 'P0' || f.severity === 'P1');
          const notes = `Claims-ledger validation failed: ${blocking.map((f) => `${f.severity} ${f.code}`).join('; ')}`;
          const finalized = await finalize(run, t0, {
            outcome: 'skipped_gate_fail',
            skip_reason: 'claims_ledger_failed',
            reviewer_notes: notes,
          });
          await this._pendingReviewClaimOrThrow(queue, opp.id, 'claims_ledger_failed', { claimToken });
          return finalized;
        }
      }
    }

    // 3c. Content guardrails — page-policy checks on the drafted body
    // (hardcoded price on any page type, brand-token leak on multi-domain
    // pages, FAQ on a policy-blocked service, keyword stuffing). Applies to
    // every body-content action. P0/P1 → human review.
    const contentGuardrails = getContentGuardrails();
    if (contentGuardrails && draft) {
      // For a refresh, the draft carries only editable meta — the live page's
      // domains are frozen by publishRefresh. Hydrate them so the brand-token
      // check enforces against the page that will actually be written. If we
      // CAN'T read the live page (null/throw), fail CLOSED: route to review
      // rather than silently treating it as hub-only and skipping the guard
      // (which would let a literal-brand draft leak onto a spoke domain).
      let liveDomains = null;
      if (brief.action_type === 'refresh_existing_page') {
        const publisher = getAstroPublisher();
        if (publisher?.getLiveFrontmatter) {
          let liveFm;
          try {
            liveFm = await publisher.getLiveFrontmatter(brief.target_url || opp.page_url);
          } catch (err) {
            logger.warn(`[autonomous-runner] live frontmatter load for guardrails failed: ${err.message}`);
            liveFm = null;
          }
          if (liveFm == null) {
            const finalized = await finalize(run, t0, {
              outcome: 'skipped_gate_fail',
              skip_reason: 'refresh_domains_load_failed',
              reviewer_notes: `Could not read live page frontmatter to enforce the brand-token guard for a multi-domain refresh (${brief.target_url || opp.page_url}) — routed to review (fail-closed).`,
            });
            await this._pendingReviewClaimOrThrow(queue, opp.id, 'refresh_domains_load_failed', { claimToken });
            return finalized;
          }
          liveDomains = Array.isArray(liveFm.domains) ? liveFm.domains : [];
        }
      }
      const guardResult = contentGuardrails.evaluate(draft, {
        service: opp.service || brief.service || null,
        primaryKeyword: brief.target_keyword || null,
        domains: liveDomains,
      });
      run.content_guardrails_result = guardResult;
      if (!guardResult.pass) {
        const blocking = guardResult.findings.filter((f) => f.severity === 'P0' || f.severity === 'P1');
        const notes = `Content guardrails failed: ${blocking.map((f) => `${f.severity} ${f.code}`).join('; ')}`;
        const finalized = await finalize(run, t0, {
          outcome: 'skipped_gate_fail',
          skip_reason: 'content_guardrails_failed',
          reviewer_notes: notes,
        });
        await this._pendingReviewClaimOrThrow(queue, opp.id, 'content_guardrails_failed', { claimToken });
        return finalized;
      }
    }

    // 4. Uniqueness gate. City-service/customer-question run the full
    //    landing-page uniqueness suite. Supporting blogs (opt-in via
    //    AUTONOMOUS_CONTENT_BLOG_UNIQUENESS) run a dedup-only check vs the
    //    blog corpus so an auto-published blog can't be a near-duplicate of
    //    something already published.
    const uniquenessGate = getUniquenessGate();
    const needsUniquenessGate = brief.page_type === 'city-service' || brief.page_type === 'customer-question';
    const needsBlogUniqueness = !needsUniquenessGate
      && (brief.page_type === 'supporting-blog' || run.action_type === 'new_supporting_blog')
      // Default ON: blog dedup is the primary anti-scaled-content gate for the
      // highest-volume content type. Set AUTONOMOUS_CONTENT_BLOG_UNIQUENESS=false
      // to explicitly disable (fail open) rather than relying on an unset env.
      && envBool('AUTONOMOUS_CONTENT_BLOG_UNIQUENESS', true);
    let uniquenessResult = { ok: true, skipped: 'not_applicable' };
    if (!uniquenessGate && (needsUniquenessGate || needsBlogUniqueness)) {
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
    } else if (uniquenessGate && needsBlogUniqueness) {
      const t4 = Date.now();
      try {
        const siblingPages = await this._loadBlogCorpus({ required: true });
        uniquenessResult = uniquenessGate.evaluateBlog(draft, brief, { siblingPages });
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
      // Hydrate the live page body so the quality gate's improvement_over_prior
      // hard check has a prior version to compare against. Without this every
      // refresh fails that check (no_previous_version_to_compare) and can never
      // publish. On load failure we leave previousVersion unset → the hard
      // check fails closed and the refresh routes to review (safe).
      if (brief.action_type === 'refresh_existing_page') {
        const publisher = getAstroPublisher();
        if (publisher?.loadExistingPageBody) {
          const prior = await publisher
            .loadExistingPageBody(brief.target_url || brief.page_url || draft.url)
            .catch((err) => {
              logger.warn(`[autonomous-runner] previousVersion load failed: ${err.message}`);
              return null;
            });
          if (prior) ctx.previousVersion = prior;
        }
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

    // 5b. Pre-publish AI-visibility subset. Runs the static-HTML P0 checks
    // (noindex, canonical-elsewhere, empty body, schema-vs-hidden) before we
    // ever open a PR — for refreshes AND newly generated supporting blogs, so
    // an unindexable new draft can't slip through the way a bad refresh can't.
    // The live-only checks (robots.txt, inbound links) stay in the post-publish
    // visibility worker. Any P0 blocks publish.
    let prePublishVisibilityResult = { passed: true, skipped: 'not_applicable' };
    if (brief.action_type === 'refresh_existing_page' || brief.action_type === 'new_supporting_blog') {
      const visGate = getAiVisibilityGate();
      if (visGate?.evaluateStatic) {
        try {
          // No canonicalUrl: publishRefresh freezes canonical from the live
          // page, and a new blog's canonical is its own URL — so the draft
          // canonical is either irrelevant or self-referential, and passing it
          // would risk a false P0 and needlessly route good content to review.
          prePublishVisibilityResult = visGate.evaluateStatic({
            url: draft.url,
            html: draft.body,
          });
        } catch (err) {
          prePublishVisibilityResult = {
            passed: false,
            error: err.message,
            summary: { p0: 1, p1: 0, p2: 0, p3: 0, needs_review: true },
          };
        }
      }
    }
    run.pre_publish_visibility_result = prePublishVisibilityResult;
    if (qualityResult && typeof qualityResult === 'object') {
      qualityResult.pre_publish_visibility = prePublishVisibilityResult;
      run.quality_gate_result = qualityResult;
    }

    // Require an explicit pass from every gate. `=== true` (not `!== false`)
    // so a gate that returns a malformed/missing `passed` shape fails CLOSED
    // rather than slipping through as a silent pass. Both results above are
    // always initialized with an explicit boolean `passed`.
    const gatesPass = uniquenessResult.ok && qualityResult.ok && seoCompletionResult.passed === true
      && prePublishVisibilityResult.passed === true;

    // 6. Trust-build check. AUTO_PUBLISH_<ACTION_TYPE>=true skips the human
    // trust-build ramp once every quality gate has passed; the canary
    // publishing guards + daily/weekly caps downstream still apply.
    const autoPublish = autoPublishEnabled(run.action_type);
    const trustBuildCount = await this._getTrustBuildCount(run.action_type).catch(() => 0);
    const trustBuildSatisfied = autoPublish || trustBuildCount >= TRUST_BUILD_THRESHOLD;
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
      // Auto-publish lanes skip silently on a pure quality-gate failure rather
      // than build a review backlog. Router-flagged human-review cases (loop /
      // cannibalization / .gov SERP) still route to review even under
      // auto-publish, since those are content-risk signals, not quality misses.
      if (autoPublish && !gatesPass && !brief.human_review_required) {
        const finalized = await finalize(run, t0, {
          outcome: 'skipped_gate_fail',
          skip_reason: 'auto_publish_gate_fail',
          reviewer_notes: this._summarizeForReviewer(uniquenessResult, qualityResult, seoCompletionResult, brief),
        });
        await this._skipClaimOrThrow(queue, opp.id, 'auto_publish_gate_fail', { claimToken });
        return finalized;
      }
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

    const publishingGuards = await this._evaluatePublishingGuards(run, brief, seoCompletionResult);
    if (!publishingGuards.ok) {
      const finalized = await finalize(run, t0, {
        outcome: 'completed_pending_review',
        skip_reason: publishingGuards.reason,
        reviewer_notes: publishingGuards.notes,
      });
      await this._pendingReviewClaimOrThrow(queue, opp.id, publishingGuards.reason, { claimToken });
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

    // No-op refresh: the live page already matched the draft, so nothing was
    // published. Complete the queue item (don't park it for a PR that doesn't
    // exist) with a distinct outcome that has no published_url — so it is not
    // impact-tracked and does not count toward trust-build.
    if (publishOutcome.publish_status === 'no_changes') {
      let finalized;
      try {
        finalized = await finalize(run, t0, {
          outcome: 'completed_no_changes',
          skip_reason: 'publish_no_changes',
          published_url: null,
          reviewer_notes: 'Refresh matched the live page byte-for-meaning; no PR opened and nothing to publish or track.',
        });
      } catch (err) {
        await this._parkPublishedClaimForReconciliation(queue, opp.id, 'no_changes_audit_failed', { claimToken }, err);
        throw err;
      }
      try {
        await this._completeClaimOrThrow(queue, opp.id, { notes: 'no_changes', claimToken });
      } catch (err) {
        await this._parkPublishedClaimForReconciliation(queue, opp.id, 'no_changes_queue_complete_failed', { claimToken }, err);
      }
      return finalized;
    }

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
   * Drains the daily cron batch. The opportunity queue already sorts by score,
   * so each runNext() claims the current best remaining opportunity. Keep the
   * batch bounded: review generation can scale, while publish canaries still
   * cap actual live output per action type.
   */
  async runDaily({ limit = null } = {}) {
    // Serialize the whole batch behind the engine lock so a long batch that
    // spills past the next cron, a manual --live run, or another instance can't
    // publish concurrently and blow past the per-day/week caps.
    return this._withEngineLock('runDaily', () => this._runDailyInner({ limit }));
  }

  /**
   * Acquire the database-wide publishing lock for the duration of `fn`.
   * - lock held by another run  → skip cleanly (returns skipped_locked).
   * - lock infrastructure error → degrade and run anyway (the per-day/week
   *   caps still bound output); never block the daily run on a lock hiccup.
   * Uses a dedicated pooled connection (session-scoped pg_advisory_lock) so the
   * lock spans external I/O without holding an open transaction; pg auto-clears
   * the lock if the connection/process dies. We always unlock + release in
   * finally — a failed unlock implies the connection is gone (lock already
   * cleared), so the connection can't return to the pool holding a stale lock.
   */
  async _withEngineLock(label, fn) {
    let lockConn = null;
    let acquired = false;
    try {
      lockConn = await db.client.acquireConnection();
      const res = await lockConn.query('SELECT pg_try_advisory_lock($1) AS locked', [ENGINE_PUBLISH_LOCK_KEY]);
      acquired = res?.rows?.[0]?.locked === true;
    } catch (err) {
      logger.warn(`[autonomous-runner] ${label}: engine lock unavailable (${err.message}); proceeding without it`);
      if (lockConn) { try { await db.client.releaseConnection(lockConn); } catch { /* pool reaps */ } }
      return fn();
    }
    if (!acquired) {
      try { await db.client.releaseConnection(lockConn); } catch { /* pool reaps */ }
      logger.warn(`[autonomous-runner] ${label} skipped: another autonomous publishing run holds the engine lock`);
      return { outcome: 'skipped_locked', skipped: true, reason: 'engine_locked', count: 0, runs: [] };
    }
    try {
      return await fn();
    } finally {
      try { await lockConn.query('SELECT pg_advisory_unlock($1)', [ENGINE_PUBLISH_LOCK_KEY]); }
      catch (err) { logger.warn(`[autonomous-runner] ${label}: advisory unlock failed (${err.message}); lock auto-clears on session end`); }
      try { await db.client.releaseConnection(lockConn); } catch { /* pool reaps */ }
    }
  }

  async _runDailyInner({ limit = null } = {}) {
    const batchLimit = dailyBatchLimit(limit);
    // A single transient failure (e.g. a flaky agent dispatch) used to abort
    // the whole batch, leaving the rest of the day's queue untouched. Instead,
    // continue past an isolated failure and only bail when failures stack up —
    // a genuinely broken engine still stops fast, but one hiccup doesn't waste
    // the day. Bounded by batchLimit and the downstream per-day/week publish
    // caps, so continuing can't over-publish.
    const maxConsecutiveFailures = envInt('AUTONOMOUS_CONTENT_MAX_CONSECUTIVE_FAILURES', 2);
    const runs = [];
    let consecutiveFailures = 0;
    let failuresSeen = 0;
    // A failed runNext() releases its claim back to 'pending', so the queue
    // would re-serve the same top opportunity on the next iteration. Exclude
    // already-failed opportunities for the rest of THIS batch so a single
    // poison row can't starve the lower-scored queue (it's still eligible on
    // the next cron, where its claim was released to pending).
    const failedOppIds = [];
    for (let i = 0; i < batchLimit; i += 1) {
      const run = await this.runNext({ excludeIds: [...failedOppIds] });
      runs.push(run);
      await this._appendToDailyDigest(run).catch(() => {});
      if (run.outcome === 'skipped_no_opportunity') break;
      if (String(run.outcome || '').startsWith('failed')) {
        consecutiveFailures += 1;
        failuresSeen += 1;
        if (run.opportunity_id != null) failedOppIds.push(run.opportunity_id);
        if (consecutiveFailures >= maxConsecutiveFailures) {
          logger.warn(`[autonomous-runner] runDaily halting batch after ${consecutiveFailures} consecutive failed runs (last: ${run.failure_message || run.outcome})`);
          break;
        }
        logger.warn(`[autonomous-runner] runDaily continuing to the next opportunity past a failure (${run.failure_message || run.outcome}); ${consecutiveFailures}/${maxConsecutiveFailures} consecutive, ${failedOppIds.length} excluded`);
        continue;
      }
      consecutiveFailures = 0;
    }
    if (failuresSeen > 0) {
      logger.info(`[autonomous-runner] runDaily completed with ${failuresSeen} failed run(s) across ${runs.length} attempt(s)`);
    }
    await this._sendDailyDigestSms(runs).catch((err) => {
      logger.warn(`[autonomous-runner] daily digest SMS failed: ${err.message}`);
    });
    return {
      outcome: runs[runs.length - 1]?.outcome || 'skipped_no_opportunity',
      count: runs.length,
      limit: batchLimit,
      failures: failuresSeen,
      runs,
    };
  }

  /**
   * After the daily batch, text the operator a one-line summary so an
   * unattended auto-publishing engine isn't a black box. Opt-in via
   * AUTONOMOUS_CONTENT_DIGEST_SMS=true; routed as an internal_alert so it
   * respects the OWNER_SMS_DISABLED kill switch. Stays silent on a
   * nothing-happened day (all skipped_no_opportunity) to avoid noise.
   */
  async _sendDailyDigestSms(runs) {
    if (!envBool('AUTONOMOUS_CONTENT_DIGEST_SMS', false)) return;
    const real = (runs || []).filter((r) => r && r.outcome !== 'skipped_no_opportunity');
    const published = real.filter((r) => r.outcome === 'completed_published').length;
    const review = real.filter((r) => r.outcome === 'completed_pending_review').length;
    const gated = real.filter((r) => r.outcome === 'skipped_gate_fail').length;
    const failed = real.filter((r) => String(r.outcome || '').startsWith('failed')).length;
    if (published + review + gated + failed === 0) return; // nothing notable today

    const reasons = {};
    for (const r of real) {
      const key = r.skip_reason || r.failure_message;
      if (key) reasons[key] = (reasons[key] || 0) + 1;
    }
    const topReasons = Object.entries(reasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k}×${v}`)
      .join(', ');
    const liveUrls = real.map((r) => r.published_url).filter(Boolean);

    const parts = [`Waves content engine: ${published} published, ${review} to review, ${gated} gated, ${failed} failed.`];
    if (topReasons) parts.push(`Why: ${topReasons}.`);
    if (liveUrls.length) parts.push(`Live: ${liveUrls.slice(0, 2).join(' ')}`);
    const body = parts.join(' ');

    const twilio = require('../twilio');
    const ownerPhone = process.env.OWNER_PHONE || '+19413187612';
    await twilio.sendSMS(ownerPhone, body, { messageType: 'internal_alert', link: '/admin/seo' });
    logger.info(`[autonomous-runner] daily digest SMS sent: ${body}`);
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
    // matching the service for Jaccard comparison.
    if (brief.page_type !== 'city-service' && brief.page_type !== 'customer-question') return [];
    const planner = getLinkPlanner();
    if (!planner?.loadAstroCorpus && !planner?.loadAstroCorpusFromGitHub) {
      if (required) throw new Error('sibling_corpus_loader_unavailable');
      return [];
    }
    try {
      const corpus = await this._loadAstroCorpus({ collections: ['services', 'locations'], required });
      const service = (brief.service || '').toLowerCase();
      return corpus.filter((p) => service && p.file.toLowerCase().includes(service));
    } catch (err) {
      if (required) throw err;
      return [];
    }
  }

  async _loadBlogCorpus({ required = false } = {}) {
    // All published blog posts, for supporting-blog dedup. Fail-closed when
    // required: an unverifiable corpus must not let a possible duplicate
    // through (the run is skipped/parked and retried next cycle).
    const planner = getLinkPlanner();
    if (!planner?.loadAstroCorpus && !planner?.loadAstroCorpusFromGitHub) {
      if (required) throw new Error('blog_corpus_loader_unavailable');
      return [];
    }
    try {
      return await this._loadAstroCorpus({ collections: ['blog'], required });
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

  async _checkProtectedPage(opp = {}, brief = null) {
    const protectedPages = getProtectedPages();
    if (!protectedPages?.isProtected) return null;
    const target = protectedPageCandidateUrl(opp, brief);
    // No resolvable target: nothing to check here. An in-place editor (rewrite/
    // refresh) that reaches publish without a target still fails closed at the
    // publish step (the handler throws a deterministic "could not resolve
    // target" error and the run is parked for review).
    if (!target) return null;
    let prot;
    try {
      prot = await protectedPages.isProtected(target, { db });
    } catch (err) {
      // The guard normally catches its own registry failures and RETURNS an
      // error verdict (see below); this catch is the belt-and-suspenders path
      // for an unexpected throw. Fail closed with the same error shape.
      prot = { protected: true, reason: 'protected_check_error', source: 'error', detail: err.message };
    }
    // Normalize the ERROR case from BOTH paths into one place: a thrown check
    // (caught above) AND the guard's own returned failure
    // (protected-pages.js fails closed with reason:'protected_check_error',
    // source:'error'). Either is an engine ERROR, not a by-design money-page
    // skip — tag is_error so it's distinguishable in autonomous_runs, log it,
    // and optionally alert the operator. Still fails closed regardless.
    const isError = !!prot && (prot.reason === 'protected_check_error' || prot.source === 'error');
    if (isError && !prot.is_error) {
      prot = { ...prot, is_error: true };
      logger.error(`[autonomous-runner] protected-page check errored for ${target}: ${prot.detail || 'unknown'}`);
      await this._alertEngineError('protected_check_error', `Protected-page check errored for ${target}: ${prot.detail || 'unknown'}`).catch(() => {});
    }
    return { ...prot, checked_url: target };
  }

  /**
   * Surface a hard engine error (a thrown guard, not a by-design skip) to the
   * operator. Opt-in via AUTONOMOUS_CONTENT_ENGINE_ERROR_ALERT=true; routed as
   * an internal_alert so it respects the OWNER_SMS_DISABLED kill switch. Best
   * effort — never let an alert failure affect the run.
   */
  async _alertEngineError(code, message) {
    if (!envBool('AUTONOMOUS_CONTENT_ENGINE_ERROR_ALERT', false)) return;
    try {
      const twilio = require('../twilio');
      const ownerPhone = process.env.OWNER_PHONE || '+19413187612';
      await twilio.sendSMS(ownerPhone, `Waves content engine error [${code}]: ${message}`, {
        messageType: 'internal_alert',
        link: '/admin/seo',
      });
      logger.info(`[autonomous-runner] engine-error alert sent: ${code}`);
    } catch (err) {
      logger.warn(`[autonomous-runner] engine-error alert failed: ${err.message}`);
    }
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

  async _handleMetadataRewriteAction(brief, draft, run) {
    const spamGate = getTitleMetaSpamGate();
    if (!spamGate?.evaluateTitleMetaSpam) {
      return {
        notes: 'title_meta_spam_gate_unavailable',
        patch: {
          outcome: 'completed_pending_review',
          skip_reason: 'title_meta_spam_gate_unavailable',
          reviewer_notes: 'Title/meta spam gate was unavailable; route this metadata rewrite manually.',
          quality_gate_result: { ok: false, error: 'title_meta_spam_gate_unavailable' },
        },
      };
    }

    const gateResult = spamGate.evaluateTitleMetaSpam({
      title: draft.title,
      meta_description: draft.meta_description,
      city: brief.city,
      service: brief.service,
      target_keyword: brief.target_keyword,
    });
    run.quality_gate_result = {
      ok: gateResult.ok,
      hard_failures: gateResult.hard_failures || [],
      soft_failures: gateResult.soft_failures || [],
      gate: 'title_meta_spam',
    };

    if (!gateResult.ok) {
      return {
        notes: 'metadata_gate_fail',
        patch: {
          outcome: 'completed_pending_review',
          skip_reason: 'metadata_gate_fail',
          reviewer_notes: `Title/meta spam gate blocked PR creation: ${(gateResult.hard_failures || []).map((f) => f.code || f.reason).join(', ') || 'failed'}.`,
        },
      };
    }

    const qualityGate = getQualityGate();
    if (!qualityGate?.evaluate) {
      return {
        notes: 'metadata_quality_gate_unavailable',
        patch: {
          outcome: 'completed_pending_review',
          skip_reason: 'metadata_quality_gate_unavailable',
          reviewer_notes: 'Content quality gate was unavailable; route this metadata rewrite manually.',
        },
      };
    }

    const metadataDraft = {
      ...draft,
      url: brief.target_url || brief.page_url || draft.page_url || null,
      canonical: brief.target_url || brief.page_url || draft.page_url || null,
      // Metadata-only rewrites intentionally do not alter schema/body, but
      // the shared quality gate expects a schema-shaped draft for common checks.
      schema: draft.schema || {},
      frontmatter: {
        ...(draft.frontmatter || {}),
        title: draft.title,
        meta_description: draft.meta_description,
      },
    };
    const metadataBrief = { ...brief, page_type: 'metadata' };
    const qualityContext = {
      siblingTitles: await this._loadSiblingTitlesForMetadata(brief, draft),
      previewBuildSuccess: true,
      sitemapHasUrl: true,
    };
    let qualityResult;
    try {
      qualityResult = qualityGate.evaluate(metadataDraft, metadataBrief, qualityContext);
    } catch (err) {
      qualityResult = { ok: false, error: err.message, hard_failures: [{ name: 'metadata_quality_gate_error', reason: err.message }], soft_failures: [] };
    }
    run.quality_gate_result = {
      ...qualityResult,
      spam_gate: gateResult,
      gate: 'metadata_quality',
    };

    const keywordCheckFailed = qualityResult?.checks?.primary_keyword_in_title?.ok === false;
    if (!qualityResult.ok || keywordCheckFailed) {
      const forcedHardFailures = keywordCheckFailed
        ? [{ name: 'primary_keyword_in_title', reason: qualityResult.checks.primary_keyword_in_title.reason || 'failed' }]
        : [];
      if (forcedHardFailures.length) {
        run.quality_gate_result = {
          ...run.quality_gate_result,
          ok: false,
          hard_failures: [
            ...(Array.isArray(run.quality_gate_result.hard_failures) ? run.quality_gate_result.hard_failures : []),
            ...forcedHardFailures,
          ],
        };
      }
      const hard = (qualityResult.hard_failures || []).map((f) => `${f.name}:${f.reason}`).join(', ');
      const soft = (qualityResult.soft_failures || []).slice(0, 4).map((f) => `${f.name}:${f.reason}`).join(', ');
      const forced = forcedHardFailures.map((f) => `${f.name}:${f.reason}`).join(', ');
      return {
        notes: 'metadata_quality_gate_fail',
        patch: {
          outcome: 'completed_pending_review',
          skip_reason: 'metadata_quality_gate_fail',
          reviewer_notes: `Metadata quality gate blocked PR creation: hard=${[hard, forced].filter(Boolean).join(', ') || 'none'} soft=${soft || 'none'} score=${qualityResult.total_score ?? 'n/a'}/${qualityResult.min_total_score ?? 'n/a'}.`,
        },
      };
    }

    const trustBuildCount = await this._getTrustBuildCount('rewrite_title_meta').catch(() => 0);
    run.trust_build_count_after = trustBuildCount + 1;

    if (run.shadow_mode) {
      return {
        notes: 'shadow_metadata_pr',
        patch: {
          outcome: 'skipped_shadow_mode',
          skip_reason: 'shadow_would_metadata_pr',
          reviewer_notes: 'Metadata rewrite passed the title/meta spam gate, but SHADOW_MODE_REWRITE_TITLE_META is still enabled.',
        },
      };
    }

    if (brief.human_review_required) {
      return {
        notes: 'brief_requires_human_review',
        patch: {
          outcome: 'completed_pending_review',
          skip_reason: 'brief_requires_human_review',
          reviewer_notes: brief.human_review_reason || 'Decision router requires manual review before opening a metadata PR.',
        },
      };
    }

    const publisher = getAstroPublisher();
    if (!publisher?.publishMetadataRewrite) {
      return {
        notes: 'metadata_publisher_adapter_unavailable',
        patch: {
          outcome: 'completed_pending_review',
          skip_reason: 'metadata_publisher_adapter_unavailable',
          reviewer_notes: 'Astro metadata rewrite publisher adapter is unavailable; route this rewrite manually.',
        },
      };
    }

    const t = Date.now();
    const publishResult = await publisher.publishMetadataRewrite(draft, brief);
    run.publish_ms = Date.now() - t;

    if (publishResult.status === 'no_changes') {
      // No-op: nothing republished. Mirror the refresh no-op — distinct outcome
      // with no published_url, so it isn't impact-tracked or counted toward
      // trust-build.
      return {
        queue: 'complete',
        notes: 'metadata_no_changes',
        patch: {
          outcome: 'completed_no_changes',
          skip_reason: 'metadata_no_changes',
          published_url: null,
          publish_status: publishResult.status,
          reviewer_notes: 'Metadata rewrite matched existing frontmatter; no Astro PR was needed.',
        },
      };
    }

    return {
      notes: 'metadata_pr_pending_merge',
      patch: {
        outcome: 'completed_pending_review',
        skip_reason: 'metadata_pr_pending_merge',
        published_url: null,
        pending_url: publishResult.url || null,
        publish_status: publishResult.status || 'pr_open',
        astro_pr_url: publishResult.pr_url || null,
        reviewer_notes: publishResult.pr_url
          ? `Astro metadata PR opened: ${publishResult.pr_url}. Merge after Codex review and preview verification.`
          : 'Metadata publisher completed without an Astro PR URL; route manually.',
      },
    };
  }

  async _loadSiblingTitlesForMetadata(brief, draft) {
    const titles = new Set();
    let corpus = [];
    try {
      corpus = await this._loadAstroCorpus({ collections: ['blog', 'services', 'locations'], required: false });
    } catch {
      return titles;
    }
    const targetUrl = normalizeContentPath(brief.target_url || brief.page_url || draft.page_url || '');
    for (const page of corpus || []) {
      if (targetUrl && normalizeContentPath(page.url || '') === targetUrl) continue;
      const title = extractFrontmatterScalar(page.body, 'title');
      if (title) titles.add(title.toLowerCase());
    }
    return titles;
  }

  async _handleInternalLinksAction(brief, run) {
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
    const corpus = await this._loadAstroCorpus({ required: false });
    const tasks = planner.planForTarget(
      { url: brief.target_url, keyword: brief.target_keyword, city: brief.city, service: brief.service, title: brief.title },
      { corpus, opportunityId: run.opportunity_id }
    );
    const taskIds = [];
    for (const task of tasks) {
      const queued = await queueInternalLinkTaskForDryRun(task, run.opportunity_id);
      if (queued?.id) taskIds.push(queued.id);
    }
    run.link_plan_ms = Date.now() - t;
    const executor = getInternalLinkExecutor();
    let dryRunResult = null;
    if (executor?.runDryRun && taskIds.length) {
      const t2 = Date.now();
      dryRunResult = await executor.runDryRun({
        taskIds,
        limit: envInt('AUTONOMOUS_INTERNAL_LINK_DRY_RUN_LIMIT', taskIds.length),
      });
      run.link_execute_ms = Date.now() - t2;
    }
    const candidates = Number((dryRunResult?.results || []).filter((result) => result.status === 'patch_candidate').length);
    const skipped = Number((dryRunResult?.results || []).filter((result) => result.status === 'skipped').length);
    const failed = Number((dryRunResult?.results || []).filter((result) => result.status === 'failed').length);
    let prResult = null;
    if (!run.shadow_mode && candidates > 0 && executor?.runPrBatch) {
      const t3 = Date.now();
      prResult = await executor.runPrBatch({
        taskIds,
        limit: envInt('AUTONOMOUS_INTERNAL_LINK_MAX_LINKS_PER_PR', 3),
      });
      run.publish_ms = Date.now() - t3;
    }
    const reason = run.shadow_mode ? 'internal_links_dry_run_shadow' : 'internal_links_dry_run';
    if (prResult?.status === 'pr_open') {
      return {
        notes: `internal_links_pr_pending_merge:queued=${taskIds.length}:pr_links=${prResult.count}`,
        patch: {
          outcome: 'completed_pending_review',
          skip_reason: 'internal_links_pr_pending_merge',
          link_tasks_queued: taskIds.length,
          publish_status: 'pr_open',
          astro_pr_url: prResult.pr_url || null,
          reviewer_notes: `Astro internal-link PR opened with ${prResult.count} link(s): ${prResult.pr_url}. Merge only after Codex, editorial review, and preview verification.`,
        },
      };
    }
    return {
      notes: `${reason}:queued=${taskIds.length}:candidates=${candidates}:skipped=${skipped}:failed=${failed}`,
      patch: {
        outcome: 'completed_pending_review',
        skip_reason: reason,
        link_tasks_queued: taskIds.length,
        reviewer_notes: `Queued ${taskIds.length} internal-link task(s); dry-run produced ${candidates} patch candidate(s), ${skipped} skipped, and ${failed} failed.`,
      },
    };
  }

  async _verifyMergedInternalLinkPrs(run) {
    if (!envBool('AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN', false)) return null;
    const executor = getInternalLinkExecutor();
    if (!executor?.runPostMergeVerification) return null;
    const t = Date.now();
    try {
      const timeoutMs = envInt('AUTONOMOUS_INTERNAL_LINK_VERIFY_TIMEOUT_MS', 15000);
      const result = await withTimeout(
        executor.runPostMergeVerification({
          limit: envInt('AUTONOMOUS_INTERNAL_LINK_VERIFY_LIMIT', 10),
        }),
        timeoutMs,
        `internal_link_verify_timeout_${timeoutMs}ms`
      );
      const rows = Array.isArray(result?.results) ? result.results : [];
      run.internal_link_verify_ms = Date.now() - t;
      run.internal_link_verify_count = Number(result?.count || rows.length || 0);
      run.internal_link_verified_count = rows.filter((row) => row.status === 'verified').length;
      run.internal_link_verify_failed_count = rows.filter((row) => row.status === 'failed' || row.failure_reason).length;
      logger.info(`[autonomous-runner] internal-link verification: checked=${run.internal_link_verify_count} verified=${run.internal_link_verified_count} failed=${run.internal_link_verify_failed_count}`);
      return result;
    } catch (err) {
      run.internal_link_verify_ms = Date.now() - t;
      run.internal_link_verify_error = err.message;
      logger.warn(`[autonomous-runner] internal-link verification skipped: ${err.message}`);
      return null;
    }
  }

  _hasDraftBriefPublisher(draft, brief) {
    const publisher = getAstroPublisher();
    // Refresh of an existing page uses the freeze-preserving publishRefresh path.
    if (brief.action_type === 'refresh_existing_page') {
      return !!(publisher?.publishRefresh
        && (typeof publisher.canPublishRefresh !== 'function' || publisher.canPublishRefresh(draft, brief)));
    }
    if (!publisher?.publishOrUpdatePage) return false;
    if (typeof publisher.canPublishDraftBrief === 'function') return publisher.canPublishDraftBrief(draft, brief);
    return true;
  }

  async _evaluatePublishingGuards(run, brief, seoCompletionResult) {
    const actionType = run.action_type || brief.action_type;
    if (!envBool('AUTONOMOUS_CONTENT_ENABLE_CANARY_GUARDS', actionType === 'new_supporting_blog')) {
      return { ok: true };
    }

    if (envBool('AUTONOMOUS_CONTENT_REQUIRE_ZERO_P0', false) && Number(seoCompletionResult?.summary?.p0 || 0) > 0) {
      return { ok: false, reason: 'canary_p0_findings', notes: 'Canary guard blocked publish because SEO completion has P0 findings.' };
    }

    const maxP1 = envInt('AUTONOMOUS_CONTENT_MAX_P1_FINDINGS', null);
    if (maxP1 != null && Number(seoCompletionResult?.summary?.p1 || 0) > maxP1) {
      return {
        ok: false,
        reason: 'canary_p1_findings',
        notes: `Canary guard blocked publish because SEO completion has ${seoCompletionResult.summary.p1} P1 finding(s), above max ${maxP1}.`,
      };
    }

    if (envBool('AUTONOMOUS_CONTENT_REQUIRE_INTERNAL_LINK_PLAN', false)) {
      const planner = getLinkPlanner();
      if (!planner?.planForTarget) {
        return { ok: false, reason: 'canary_internal_link_planner_unavailable', notes: 'Canary guard requires internal-link planning before publish.' };
      }
    }

    if (envBool('AUTONOMOUS_CONTENT_REQUIRE_POST_PUBLISH_CHECK', false)) {
      const worker = getPostPublishVisibilityWorker();
      if (!worker?.runForPost && !worker?.runForUrl) {
        return { ok: false, reason: 'canary_post_publish_visibility_unavailable', notes: 'Canary guard requires post-publish visibility worker before publish.' };
      }
    }

    const maxPerDay = envInt('AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY', null);
    if (maxPerDay != null) {
      const count = await this._countPublishedSince(actionType, startOfEtDay(new Date()));
      if (count >= maxPerDay) {
        return {
          ok: false,
          reason: 'canary_daily_publish_cap',
          notes: `Canary guard blocked publish because ${count} ${actionType} publish(es) already completed today, max ${maxPerDay}.`,
        };
      }
    }

    const maxPerWeek = envInt('AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_WEEK', null);
    if (maxPerWeek != null) {
      const count = await this._countPublishedSince(actionType, startOfEtWeek(new Date()));
      if (count >= maxPerWeek) {
        return {
          ok: false,
          reason: 'canary_weekly_publish_cap',
          notes: `Canary guard blocked publish because ${count} ${actionType} publish(es) already completed this ET week, max ${maxPerWeek}.`,
        };
      }
    }

    return { ok: true };
  }

  async _countPublishedSince(actionType, since) {
    const row = await db('autonomous_runs')
      .where('action_type', actionType)
      .where('shadow_mode', false)
      .where('outcome', 'completed_published')
      .where('completed_at', '>=', since)
      .count('id as count')
      .first();
    return Number(row?.count || 0);
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
    // Refresh of an existing page uses publishRefresh (freezes canonical /
    // slug / schema / tracking / domains; swaps only body + meta + freshness).
    // New pages use publishOrUpdatePage.
    const usePublish = (brief.action_type === 'refresh_existing_page' && publisher?.publishRefresh)
      ? publisher.publishRefresh.bind(publisher)
      : publisher?.publishOrUpdatePage?.bind(publisher);
    if (usePublish) {
      const r = await usePublish(draft, brief);
      // A refresh whose body + editable meta already match the live page is a
      // completed no-op: publishRefresh returns status:'no_changes' (no PR, no
      // commit, nothing republished). Leave published_url UNSET so the impact
      // sweep (whereNotNull('published_url')) and trust-build counting both
      // skip it — an unchanged page must not earn a baseline/14d/21d verdict or
      // count toward shadow graduation. The caller completes it as a no-op
      // rather than parking it for a non-existent PR.
      if (r?.status === 'no_changes') {
        out.published_url = null;
        out.pending_url = null;
        out.publish_status = 'no_changes';
        out.astro_pr_url = null;
        run.publish_ms = Date.now() - t1;
        return out;
      }
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
        const corpus = await this._loadAstroCorpus({ required: false });
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

  async _loadAstroCorpus({ collections = ['blog', 'services', 'locations'], required = false } = {}) {
    const planner = getLinkPlanner();
    if (!planner) {
      if (required) throw new Error('astro_corpus_loader_unavailable');
      return [];
    }

    const astroDir = process.env.ASTRO_REPO_DIR;
    if (astroDir && planner.loadAstroCorpus) {
      return planner.loadAstroCorpus(astroDir, { collections });
    }

    if (planner.loadAstroCorpusFromGitHub) {
      try {
        return await planner.loadAstroCorpusFromGitHub({ collections });
      } catch (err) {
        if (required) throw err;
        logger.warn(`[autonomous-runner] optional Astro corpus GitHub load skipped: ${err.message}`);
        return [];
      }
    }

    if (required) throw new Error('ASTRO_REPO_DIR or GitHub Astro corpus loader required');
    return [];
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
      claims_ledger_result: JSON.stringify(run.claims_ledger_result || {}),
      content_guardrails_result: JSON.stringify(run.content_guardrails_result || {}),
      seo_completion_gate_result: JSON.stringify(run.seo_completion_gate_result || {}),
      facts_sufficiency: JSON.stringify(run.facts_sufficiency || {}),
      protected_check: JSON.stringify(run.protected_check || {}),
      seo_completion_gate_ms: run.seo_completion_gate_ms || null,
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
    /^unsupported metadata rewrite for Astro publish:/,
    /^could not resolve metadata rewrite target:/,
    /^Astro file not found for metadata rewrite:/,
    /^could not resolve refresh target:/,
    /^Astro file not found for refresh:/,
    /^autonomous draft missing safe frontmatter slug$/,
    /^autonomous draft canonical is not a valid URL$/,
    /^autonomous draft canonical must match slug /,
  ].some((pattern) => pattern.test(message));
}

function envBool(key, defaultValue = false) {
  const value = process.env[key];
  if (value == null || value === '') return defaultValue;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return defaultValue;
}

function envInt(key, defaultValue = null) {
  const raw = process.env[key];
  if (raw == null || raw === '') return defaultValue;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function agentSessionTimeoutMs(actionType, brief = {}) {
  const longRunningAgent = actionType === 'new_supporting_blog'
    || actionType === 'refresh_existing_page'
    || brief?.page_type === 'supporting-blog'
    || brief?.page_type === 'refresh';
  const fallback = longRunningAgent
    ? 10 * 60 * 1000
    : 5 * 60 * 1000;
  return envInt('AUTONOMOUS_CONTENT_AGENT_SESSION_TIMEOUT_MS', fallback);
}

function dailyBatchLimit(value = null) {
  const raw = value == null
    ? envInt('AUTONOMOUS_CONTENT_DAILY_BATCH_SIZE', 5)
    : Number.parseInt(value, 10);
  const parsed = Number.isFinite(raw) && raw > 0 ? raw : 5;
  return Math.min(Math.max(parsed, 1), 10);
}

function withTimeout(promise, timeoutMs, message) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || `timeout_${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function normalizeContentPath(url) {
  return String(url || '')
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/[?#].*$/, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

function protectedPageCandidateUrl(opp = {}, brief = null) {
  return opp.page_url
    || protectedBriefTargetUrl(opp, brief)
    || protectedDerivedCityServicePath(opp, brief)
    || null;
}

function protectedBriefTargetUrl(opp = {}, brief = null) {
  // Resolve the URL the action will actually edit so the protected-page check
  // sees the same target the handler does. City-service actions derive it; the
  // in-place editors (rewrite/refresh) carry it on the brief (target_url||
  // page_url) even when opp.page_url is empty — without this a refresh/rewrite
  // on a non-city-service money page is checked against `null` (i.e. skipped).
  if (!brief) return null;
  if (!protectedCityServiceGuardApplies(opp, brief) && !actionEditsExistingPage(opp, brief)) return null;
  return brief.target_url || brief.page_url || null;
}

// Actions that edit an already-published page IN PLACE (vs. creating a new one).
// For these, an unresolvable target must fail CLOSED — we can't confirm it isn't
// a protected money page. NOTE: add_internal_links is intentionally excluded —
// its target_url is the link DESTINATION (which may legitimately be a money
// page), not the page being edited; its source files get their own protection
// via the internal-link executor's indexability/canonical checks.
const EDITING_ACTION_TYPES = new Set(['rewrite_title_meta', 'refresh_existing_page']);
function actionEditsExistingPage(opp = {}, brief = null) {
  return EDITING_ACTION_TYPES.has(brief?.action_type || opp.action_type);
}

function protectedPagePatch(prot = {}) {
  return {
    outcome: 'skipped_gate_fail',
    skip_reason: `protected_page:${prot.reason}`,
    reviewer_notes: `Protected page (${prot.reason}${prot.source ? `, ${prot.source}` : ''})${prot.checked_url ? `, ${prot.checked_url}` : ''})${prot.detail ? `: ${prot.detail}` : ''} — not auto-optimized.`,
  };
}

function cityServicePath(service, city) {
  const serviceSlug = servicePathSlug(service);
  const citySlug = slugifyPathPart(city);
  if (!serviceSlug || !citySlug) return null;
  return `/${serviceSlug}-${citySlug}-fl/`;
}

function protectedDerivedCityServicePath(opp = {}, brief = null) {
  if (!protectedCityServiceGuardApplies(opp, brief)) return null;
  return cityServicePath(brief?.service || opp.service, brief?.city || opp.city);
}

function protectedCityServiceGuardApplies(opp = {}, brief = null) {
  const actionType = brief?.action_type || opp.action_type;
  const pageType = brief?.page_type || opp.page_type;
  return actionType === 'create_or_refresh_city_service_page'
    || pageType === 'city-service';
}

function servicePathSlug(value) {
  const slug = slugifyPathPart(value);
  const map = {
    pest: 'pest-control',
    lawn: 'lawn-care',
    mosquito: 'mosquito-control',
    termite: 'termite-control',
    rodent: 'rodent-control',
    'bed-bug': 'bed-bug-control',
    bedbug: 'bed-bug-control',
    commercial: 'commercial-pest-control',
    quote: 'pest-control-quote',
    inspection: 'termite-inspection',
  };
  return map[slug] || slug || null;
}

function slugifyPathPart(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractFrontmatterScalar(body, key) {
  const text = String(body || '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const escaped = String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = match[1].match(new RegExp(`^\\s*${escaped}\\s*:\\s*(.+?)\\s*$`, 'm'));
  if (!line) return null;
  let value = line[1].trim().replace(/\s+#.*$/, '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value.trim() || null;
}

function startOfEtDay(date = new Date()) {
  return parseETDateTime(`${etDateString(date)}T00:00`);
}

function startOfEtWeek(date = new Date()) {
  return parseETDateTime(`${etWeekStart(date)}T00:00`);
}

async function queueInternalLinkTaskForDryRun(task, opportunityId) {
  const inserted = await db('content_internal_link_tasks')
    .insert(task)
    .onConflict(['source_file', 'target_url', 'anchor_text'])
    .ignore()
    .returning('id');
  const insertedId = firstReturnedId(inserted);
  if (insertedId) return { id: insertedId, inserted: true };

  const existing = await db('content_internal_link_tasks')
    .select('id', 'status')
    .where({
      source_file: task.source_file,
      target_url: task.target_url,
      anchor_text: task.anchor_text,
    })
    .whereIn('status', INTERNAL_LINK_RETRYABLE_STATUSES)
    .first();
  if (!existing?.id) return null;

  const refreshed = await db('content_internal_link_tasks')
    .where({ id: existing.id })
    .whereIn('status', INTERNAL_LINK_RETRYABLE_STATUSES)
    .update({
      status: 'queued',
      opportunity_id: opportunityId || task.opportunity_id || null,
      skip_reason: null,
      failure_reason: null,
      updated_at: new Date(),
    });
  if (Number(refreshed || 0) < 1) return null;

  return { id: existing.id, inserted: false, refreshed: true };
}

function firstReturnedId(rows) {
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  for (const row of list) {
    const id = typeof row === 'object' ? row.id : row;
    if (id) return id;
  }
  return null;
}

module.exports = new AutonomousRunner();
module.exports.AutonomousRunner = AutonomousRunner;
module.exports._internals = {
  isShadow,
  autoPublishEnabled,
  FACTS_GATED_ACTIONS,
  TRUST_BUILD_THRESHOLD,
  DEFAULT_MIN_SCORE,
  countsTowardTrustBuild,
  isDeterministicPublishError,
  envBool,
  envInt,
  agentSessionTimeoutMs,
  dailyBatchLimit,
  INTERNAL_LINK_RETRYABLE_STATUSES,
  firstReturnedId,
  queueInternalLinkTaskForDryRun,
  normalizeContentPath,
  protectedPageCandidateUrl,
  cityServicePath,
  servicePathSlug,
  protectedDerivedCityServicePath,
  protectedBriefTargetUrl,
  protectedCityServiceGuardApplies,
  extractFrontmatterScalar,
  startOfEtDay,
  startOfEtWeek,
};
