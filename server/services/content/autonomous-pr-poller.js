/**
 * autonomous-pr-poller.js — PR lifecycle tracking for autonomous publishes.
 *
 * Autonomous blog publishes (astro-publisher.publishOrUpdatePage and the
 * rewrite/refresh lanes) open a GitHub PR and park the run at
 * autonomous_runs outcome='completed_pending_review',
 * skip_reason='astro_pr_pending_merge'. There is no blog_posts row for
 * these, so pages-poll never sees them and mergeAstro never runs — without
 * this poller a HUMAN merging the PR on GitHub leaves the run parked
 * forever: it never completes, IndexNow never fires, and post-merge
 * internal-link planning never happens.
 *
 * Two parked lanes are reconciled (selected by skip_reason):
 *   - astro_pr_pending_merge     — blog/page publishes (full lane).
 *   - metadata_pr_pending_merge  — metadata rewrites (reconcile-only lane:
 *     merged/closed lifecycle handling, NEVER auto-merged — see pollRun).
 *
 * Each tick, for every parked run with an astro_pr_url whose
 * opportunity_queue row is still in the exact parked review state (a human
 * requeue/dismiss in the review queue moves the queue row but not the run —
 * such runs are annotated out of the selection, never finalized):
 *   - PR merged (by human or by us)  → finalize ONLY once the target URL
 *     can be resolved (draft_payload, falling back to the run's
 *     content_briefs.target_url — metadata drafts carry title/meta only)
 *     AND responds live (the hub's production build lags a merge by
 *     30–45 min; completing earlier would count a broken/missing page as
 *     published and trust-building): flip the run to completed_published
 *     with that URL, submit IndexNow, queue post-merge internal-link
 *     planning (new_supporting_blog only — rewrite/refresh/metadata
 *     targets already exist in the link corpus), and auto-share NEW on-hub
 *     blog posts to social (FB/IG/GBP) the moment they're verified live —
 *     a deterministic per-post trigger gated by the same SOCIAL_* flags as
 *     the 4-hourly RSS share cron, which stays as a dedupe-safe backstop.
 *     Also best-effort completes the parked opportunity_queue row. An unresolvable URL
 *     fails closed: the run stays parked (logged each tick) rather than
 *     completing without a URL.
 *   - PR closed unmerged             → flip the run to failed (no retry).
 *   - PR open + AUTONOMOUS_BLOG_AUTO_MERGE truthy → merge it OURSELVES
 *     (blog lane only), but only when the Cloudflare preview build for the
 *     PR branch is green, the deployment was built from the PR's CURRENT
 *     head commit, AND assertCodexReviewClear passes for the PR head (fail
 *     closed, same gate as mergeAstro). Auto-merges are capped per tick
 *     (default 1) because every merge rebuilds the Cloudflare Pages fleet.
 *   - Transient error (GitHub/Cloudflare blip) → log and leave the row
 *     for the next tick. A network error NEVER fails a run.
 *
 * Env:
 *   AUTONOMOUS_BLOG_AUTO_MERGE                 default OFF — ship dark;
 *     merged/closed reconciliation runs regardless of this flag.
 *   AUTONOMOUS_PR_MAX_AUTO_MERGES_PER_POLL     default 1.
 *
 * Intended caller: scheduler cron (every 2 min, runExclusive — a merge plus
 * its post-merge chain must not run twice across overlapping instances).
 */

const db = require('../../models/db');
const logger = require('../logger');
const { spokeBlogNetworkEnabled } = require('./spoke-blog-network');

const PENDING_OUTCOME = 'completed_pending_review';
const BLOG_PENDING_SKIP_REASON = 'astro_pr_pending_merge';
const METADATA_PENDING_SKIP_REASON = 'metadata_pr_pending_merge';
const PENDING_SKIP_REASONS = [BLOG_PENDING_SKIP_REASON, METADATA_PENDING_SKIP_REASON];
const CLOSED_SKIP_REASONS = {
  [BLOG_PENDING_SKIP_REASON]: 'astro_pr_closed_unmerged',
  [METADATA_PENDING_SKIP_REASON]: 'metadata_pr_closed_unmerged',
};
// Stamped onto a parked run whose opportunity_queue row left the parked
// review state (operator requeue/dismiss): takes the run out of the poller's
// selection without inventing a terminal outcome the operator didn't choose.
const SUPERSEDED_SKIP_REASON = 'superseded_by_review_queue_action';
const PR_URL_NUMBER = /\/pull\/(\d+)(?:[/?#]|$)/;

function autoMergeEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.AUTONOMOUS_BLOG_AUTO_MERGE || '').trim());
}

// Kill switch for the deterministic post-merge social share. Defaults ON:
// enabling SOCIAL_RSS_AUTOPUBLISH_ENABLED turns auto-sharing on, and this
// merge-trigger shares that same on/off (it's the same "auto-share new blog
// posts" feature, just fired on confirmed-live merge instead of by the 4-hourly
// RSS poll). Set SOCIAL_BLOG_MERGE_SHARE_ENABLED=false to fall back to RSS-only
// sharing without disabling RSS itself.
function blogMergeSocialShareEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.SOCIAL_BLOG_MERGE_SHARE_ENABLED || '').trim());
}

function maxAutoMergesPerPoll() {
  const raw = parseInt(process.env.AUTONOMOUS_PR_MAX_AUTO_MERGES_PER_POLL, 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
}

function prNumberFromUrl(prUrl) {
  const match = PR_URL_NUMBER.exec(String(prUrl || ''));
  return match ? Number(match[1]) : null;
}

/** The exact parked skip_reason this run was selected on (lane marker). */
function pendingSkipReasonForRun(run) {
  return PENDING_SKIP_REASONS.includes(run?.skip_reason) ? run.skip_reason : BLOG_PENDING_SKIP_REASON;
}

function isMetadataLane(run) {
  return pendingSkipReasonForRun(run) === METADATA_PENDING_SKIP_REASON;
}

function closedSkipReasonForRun(run) {
  return CLOSED_SKIP_REASONS[pendingSkipReasonForRun(run)];
}

function normalizeSha(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Reconstruct the publish target from what the run actually persisted.
 * The runner stores the draft in autonomous_runs.draft_payload (jsonb) but
 * NOT the pending URL, so derive it the same way the publisher did:
 *   - new_supporting_blog: frontmatter.canonical (publishOrUpdatePage
 *     stamps + returns exactly this).
 *   - rewrite_title_meta / refresh_existing_page: the draft's page_url /
 *     target_url (the page already exists; its canonical is frozen).
 * Internal-link planning only applies to NEW pages — rewrite/refresh
 * targets are already part of the corpus and keep their inbound links.
 */
// Hosts the post-merge internal-link planner operates on (hub only). A
// spoke-only post is self-canonical on its spoke domain and renders ONLY there
// (domains: [spoke]), so hub pages must not be asked to link to it — those links
// would 404 on the hub. (Mirrors internal-link-planner's ALLOWED_SITE_HOSTS.)
const PLANNER_HUB_HOSTS = new Set(['www.wavespestcontrol.com', 'wavespestcontrol.com']);
function canonicalIsOffHub(url) {
  const raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw)) return false; // relative/empty → keep existing (hub) behavior
  try { return !PLANNER_HUB_HOSTS.has(new URL(raw).hostname.toLowerCase()); } catch { return true; }
}

function targetForRun(run) {
  const draft = parseJsonObject(run.draft_payload);
  const frontmatter = draft.frontmatter || {};
  const isNewPage = String(run.action_type || '') === 'new_supporting_blog';
  const url = (isNewPage
    ? String(frontmatter.canonical || '').trim()
    : String(draft.page_url || draft.target_url || frontmatter.canonical || '').trim()) || null;
  return {
    url,
    keyword: frontmatter.primary_keyword || null,
    city: Array.isArray(frontmatter.service_areas_tag) ? frontmatter.service_areas_tag[0] : null,
    title: frontmatter.title || draft.title || null,
    // Best-effort meta description for the post-merge social share (card excerpt
    // + caption seed); blog drafts carry meta_description, tolerate camelCase.
    // null is fine — publishToAll falls back to a title-only card/caption.
    excerpt: frontmatter.meta_description || frontmatter.metaDescription
      || draft.meta_description || draft.metaDescription || draft.excerpt || null,
    // Skip post-merge hub-internal-link planning for spoke-only posts — they
    // render only on their spoke, so proposing hub→spoke-path links 404s.
    planLinks: isNewPage && !canonicalIsOffHub(url),
  };
}

// Kill-switch gate for the AUTONOMOUS merge path. This poller merges blog PRs
// directly (gh.mergePr) and bypasses mergeAstro's assertOpenPublishPrIsHubOnly,
// so a spoke-targeted PR created before the spoke blog network was disabled
// could otherwise auto-merge and fan out to a spoke despite the seed/publish/
// mergeAstro gates. Mirror the same hub-only policy here: when the network is
// disabled, a run whose resolved target is off-hub (a spoke self-canonical,
// which the publisher syncs into draft_payload.frontmatter.canonical) must not
// auto-merge. Enabled = spoke PRs are intended (mergeAstro's guard is likewise
// skipped), so the single flag governs every merge path.
function spokeMergeBlockedByKillSwitch(run) {
  if (spokeBlogNetworkEnabled()) return false;
  // Scope the block to NEW spoke-blog fanout only. maybeAutoMerge also handles
  // rewrite_title_meta / refresh_existing_page runs, whose target is an
  // ALREADY-EXISTING page (e.g. a spoke service page) — legitimately off-hub and
  // not blog fanout. The blog kill switch must not park those; blocking them
  // would strand routine spoke service-page refreshes while the lane is off.
  if (String(run.action_type || '') !== 'new_supporting_blog') return false;
  return canonicalIsOffHub(targetForRun(run).url);
}

/**
 * targetForRun + a content_briefs fallback for the URL. Real
 * rewrite_title_meta runs persist the raw emit_metadata_only draft (title +
 * meta_description only — no page_url), so the target URL has to come from
 * the brief the run was built from (content_briefs.target_url; the brief
 * outlives the run via brief_id). Returns target.url === null when neither
 * source resolves — callers fail closed on that.
 */
async function resolveTargetForRun(run) {
  const target = targetForRun(run);
  if (target.url || !run.brief_id) return target;
  try {
    const brief = await db('content_briefs')
      .where('id', run.brief_id)
      .first('target_url', 'target_keyword', 'city');
    const briefUrl = String(brief?.target_url || '').trim();
    if (briefUrl) {
      target.url = briefUrl;
      target.keyword = target.keyword || brief.target_keyword || null;
      target.city = target.city || brief.city || null;
    }
  } catch (err) {
    // Lookup blip → leave url null; finalizeMerged keeps the run parked and
    // the next tick retries. Never guess a URL.
    logger.warn(`[autonomous-pr-poller] content_briefs lookup failed for run ${run.id} (brief ${run.brief_id}): ${err.message}`);
  }
  return target;
}

/**
 * Re-check (fresh read, not the tick-start snapshot) that the run's queue
 * row is STILL parked. maybeAutoMerge calls this immediately before
 * gh.mergePr: the Cloudflare/GitHub/Codex gates above it take seconds, and
 * an operator requeue/dismiss landing in that window must win over the
 * stale tick-start validation. Errors propagate (transient → caught by
 * pollRun, retried next tick) so a lookup outage can never allow a merge.
 */
async function queueRowParkedState(run) {
  if (!run.opportunity_id) return { parked: true, row: null };
  const row = await db('opportunity_queue')
    .where('id', run.opportunity_id)
    .first('id', 'status', 'skip_reason');
  const parked = !!row
    && row.status === 'pending_review'
    && row.skip_reason === pendingSkipReasonForRun(run);
  // status + skip_reason alone are ambiguous across requeue cycles: an
  // operator requeue followed by a NEWER run re-parking the same opportunity
  // reproduces the exact parked state this run was selected on, and the
  // stale run's old PR would look valid again. The opportunity's lifecycle
  // belongs to its newest run — any newer sibling supersedes this one.
  if (parked && run.created_at) {
    const newer = await db('autonomous_runs')
      .where('opportunity_id', run.opportunity_id)
      .whereNot('id', run.id)
      .where('created_at', '>', run.created_at)
      .first('id');
    if (newer) return { parked: false, row, supersededByRunId: newer.id };
  }
  return { parked, row };
}

async function queueRowStillParked(run) {
  return (await queueRowParkedState(run)).parked;
}

/**
 * Best-effort: the runner parked the opportunity_queue row at
 * status='pending_review' / skip_reason=<the run's parked reason> alongside
 * the run (astro_pr_pending_merge or metadata_pr_pending_merge).
 * complete()/skip() require the original claimToken (the row is no longer
 * 'claimed'), so reconcile directly — guarded to the exact parked state so
 * we never touch a row a human re-routed. Failure logs only; queue state
 * must never block run finalization.
 */
async function reconcileQueueRow(run, { merged }) {
  if (!run.opportunity_id) return;
  try {
    await db('opportunity_queue')
      .where('id', run.opportunity_id)
      .where('status', 'pending_review')
      .where('skip_reason', pendingSkipReasonForRun(run))
      .update(merged
        ? { status: 'done', completed_at: new Date(), updated_at: new Date() }
        : { status: 'skipped', skip_reason: closedSkipReasonForRun(run), completed_at: new Date(), updated_at: new Date() });
  } catch (err) {
    logger.warn(`[autonomous-pr-poller] opportunity_queue reconcile failed for run ${run.id}: ${err.message}`);
  }
}

/**
 * The run's opportunity_queue row left the parked review state — an operator
 * requeued or dismissed it in the review queue (which updates only
 * opportunity_queue, not the run). Finalizing the run now would resurrect a
 * decision a human already overrode (e.g. mark a dismissed draft
 * completed_published when its PR is later merged for unrelated reasons), so
 * NEVER reconcile it: annotate the run out of the poller's selection with a
 * non-pending skip_reason instead. Compare-and-set guarded on the exact
 * parked state so a concurrent finalize/operator write wins.
 */
async function supersedeRun(run, queueRow) {
  const pendingReason = pendingSkipReasonForRun(run);
  const queueState = queueRow
    ? `status='${queueRow.status}'${queueRow.skip_reason ? ` skip_reason='${queueRow.skip_reason}'` : ''}`
    : 'row missing';
  try {
    const claimed = await db('autonomous_runs')
      .where('id', run.id)
      .where('outcome', PENDING_OUTCOME)
      .where('skip_reason', pendingReason)
      .update({
        skip_reason: SUPERSEDED_SKIP_REASON,
        reviewer_notes: [
          run.reviewer_notes,
          `PR lifecycle reconciliation stopped by autonomous-pr-poller: opportunity_queue row ${queueState} is no longer parked at pending_review/${pendingReason} (operator requeue/dismiss or superseding claim).`,
        ].filter(Boolean).join(' | '),
        updated_at: new Date(),
      });
    if (!claimed) return { skipped: true, reason: 'already_finalized' };
  } catch (err) {
    logger.warn(`[autonomous-pr-poller] supersede annotation failed for run ${run.id}: ${err.message}`);
    return { skipped: true, reason: 'queue_row_moved_on', annotated: false };
  }
  logger.info(`[autonomous-pr-poller] run ${run.id} skipped: opportunity_queue row ${run.opportunity_id} moved on (${queueState}); marked ${SUPERSEDED_SKIP_REASON}`);
  return { skipped: true, reason: 'queue_row_moved_on', annotated: true };
}

/**
 * PR is merged: claim the run row atomically (compare-and-set on the parked
 * outcome so overlapping ticks / a concurrent manual finalize can't run the
 * post-merge chain twice), then IndexNow + internal-link planning.
 *
 * Lane differences on merge:
 *   - blog lane (astro_pr_pending_merge): full chain — IndexNow + post-merge
 *     internal-link planning for NEW pages (target.planLinks).
 *   - metadata lane (metadata_pr_pending_merge): the merged PR only rewrote
 *     frontmatter on an EXISTING page, so the only post-merge effect is the
 *     IndexNow URL-updated ping (mirrors the runner's direct-live metadata
 *     path); internal-link planning never applies (targetForRun returns
 *     planLinks=false for non-new actions) and there is no blog_posts row /
 *     blog post-merge chain to drive.
 * Side effects run AFTER the claim on purpose — a crash between claim and
 * side effects loses only belt-and-suspenders work (IndexNow is throttled/
 * relayed by Cloudflare anyway, link tasks are deduped on conflict), whereas
 * side effects before the claim could double-run them.
 *
 * Two fail-closed gates run BEFORE the claim:
 *   - URL resolution: a run whose target URL cannot be resolved (draft +
 *     brief both blank) stays parked and is logged every tick — never
 *     completed_published with published_url=null (that would skip IndexNow
 *     and hide the page from the post-publish visibility sweep).
 *   - Live check: GitHub reporting "merged" only means the commit landed;
 *     the hub's production build lags 30–45 min and can fail. The run stays
 *     parked until the target URL actually responds (rewrite/refresh/
 *     metadata targets are already-live pages, so they pass immediately),
 *     so a broken deploy is never counted as published/trust-building and
 *     IndexNow never pings a 404.
 */
async function finalizeMerged(run, prNumber, { autoMerged = false, mergeSha = null, mergedAt = null } = {}) {
  // Fresh queue re-check at finalize time: the tick-start validation is
  // stale by now (GitHub lookup + live-URL gating take seconds), and an
  // operator requeue/dismiss landing in that window must win — never mark a
  // human-overridden run completed_published just because its PR merged.
  // A lookup error throws → transient via pollRun's catch, no finalize.
  // `autoMerged` is preserved so a just-merged PR still consumes the cap.
  const { parked, row: queueRow } = await queueRowParkedState(run);
  if (!parked) return { ...(await supersedeRun(run, queueRow)), autoMerged };

  const target = await resolveTargetForRun(run);
  if (!target.url) {
    logger.warn(`[autonomous-pr-poller] run ${run.id} (PR #${prNumber} merged) has no resolvable target URL (draft + brief blank); leaving parked`);
    return { pending: true, reason: 'target_url_unresolved', autoMerged };
  }
  try {
    const { liveUrlResponds } = require('../content-astro/pages-poll');
    if (!(await liveUrlResponds(target.url))) {
      return { pending: true, reason: 'awaiting_live_deploy', url: target.url, autoMerged };
    }
  } catch (err) {
    // Network blip on the HEAD check — transient, retry next tick.
    logger.warn(`[autonomous-pr-poller] live check failed for ${target.url} (run ${run.id}): ${err.message}`);
    return { pending: true, reason: 'live_check_failed', url: target.url, autoMerged };
  }

  // ALL PR-backed lanes: a 200 on the target URL is not evidence the MERGED
  // content deployed — existing pages (rewrite/refresh/metadata) were live
  // before the merge, and even new_supporting_blog can UPDATE an existing
  // slug via publishOrUpdatePage. Require a successful PRODUCTION deploy
  // that contains the merge: exact merge-sha match, or the latest success
  // at/after merged_at (main is linear via squash merges, so any later
  // production deploy includes the merge — and this stays correct for old
  // merges whose own deploy has fallen out of the API's recent window).
  // mergeSha/mergedAt come from the PR object (human merges) or the merge
  // response + merge time (auto-merges); when neither resolves this fails
  // closed and the next tick's PR re-fetch supplies merge_commit_sha/
  // merged_at.
  try {
    const { latestSuccessfulProductionDeployment, deploymentCommitSha, deploymentCreatedAtMs } = require('../content-astro/pages-poll');
    const prodDeploy = await latestSuccessfulProductionDeployment();
    const shaMatch = mergeSha && normalizeSha(deploymentCommitSha(prodDeploy)) === normalizeSha(mergeSha);
    const mergedAtMs = mergedAt ? Date.parse(mergedAt) : NaN;
    // Compare the deploy's CREATION time, not its completion time: hub
    // production builds take 30–45 min, so a deploy of a PRE-merge commit
    // routinely FINISHES after the merge — the old completion-time window
    // matched it and finalized the run (IndexNow + social share) on STALE
    // content whenever two merges landed within one build window. A deploy
    // CREATED at/after the merge necessarily clones a tree containing it
    // (main is linear via squash merges). No negative clock-skew allowance:
    // a deploy created moments before the merge doesn't contain it, and
    // losing the merge's own deploy to sub-second skew only means staying
    // parked until the next deploy (fail closed, self-heals).
    const createdAtMs = prodDeploy ? deploymentCreatedAtMs(prodDeploy) : null;
    const timeMatch = Number.isFinite(mergedAtMs) && createdAtMs != null
      && createdAtMs >= mergedAtMs;
    if (!prodDeploy || (!shaMatch && !timeMatch)) {
      return { pending: true, reason: 'awaiting_production_deploy', url: target.url, autoMerged };
    }
  } catch (err) {
    logger.warn(`[autonomous-pr-poller] production deploy check failed for run ${run.id}: ${err.message}`);
    return { pending: true, reason: 'production_deploy_check_failed', url: target.url, autoMerged };
  }

  const now = new Date();
  const note = `${autoMerged ? 'Auto-merged' : 'PR merged'} (#${prNumber}); run completed by autonomous-pr-poller.`;

  const claimed = await db('autonomous_runs')
    .where('id', run.id)
    .where('outcome', PENDING_OUTCOME)
    // skip_reason in the guard: a concurrent supersedeRun (overlapping tick)
    // rewrites it, and a superseded run must never be resurrected here.
    .where('skip_reason', pendingSkipReasonForRun(run))
    .update({
      outcome: 'completed_published',
      published_url: target.url,
      reviewer_notes: [run.reviewer_notes, note].filter(Boolean).join(' | '),
      completed_at: now,
      updated_at: now,
    });
  if (!claimed) return { skipped: true, reason: 'already_finalized' };

  const patch = {};

  // IndexNow — same lazy/fail-soft pattern as the runner; the submitter
  // itself no-ops with status 'skipped' when the key env is unset.
  if (target.url) {
    try {
      const indexNow = require('../seo/indexnow-submit');
      if (indexNow?.submit) {
        const r = await indexNow.submit(target.url);
        patch.indexnow_status = r?.status || (r?.ok ? 'ok' : 'error');
      }
    } catch (err) {
      logger.warn(`[autonomous-pr-poller] indexnow failed for ${target.url}: ${err.message}`);
      patch.indexnow_status = 'error';
    }
  }

  // Post-merge internal-link planning (new pages only) — reuses the
  // astro-publisher target-shaped planner; honors the
  // INTERNAL_LINK_PLAN_ON_BLOG_MERGE kill switch.
  if (target.url && target.planLinks) {
    try {
      const publisher = require('../content-astro/astro-publisher');
      if (publisher.internalLinkPlanningDisabled?.()) {
        logger.info(`[autonomous-pr-poller] internal-link planning disabled by kill switch for ${target.url}`);
      } else if (publisher.planInternalLinksForTarget) {
        const result = await publisher.planInternalLinksForTarget(target);
        if (result) {
          patch.link_tasks_queued = result.queued || 0;
          logger.info(`[autonomous-pr-poller] internal-link planning for ${result.url}: queued=${result.queued} candidates=${result.candidates}`);
        }
      }
    } catch (err) {
      logger.warn(`[autonomous-pr-poller] internal-link planning failed for ${target.url}: ${err.message}`);
    }
  }

  if (Object.keys(patch).length) {
    try {
      await db('autonomous_runs').where('id', run.id).update({ ...patch, updated_at: new Date() });
    } catch (err) {
      logger.warn(`[autonomous-pr-poller] post-merge patch failed for run ${run.id}: ${err.message}`);
    }
  }

  // Auto-share NEW hub blog posts to social the moment they're verified live
  // (PR merged + production deploy contains it + URL responds 200 — all gated
  // above). A deterministic, per-post trigger so sharing no longer depends on
  // the 4-hourly RSS feed poll happening to catch the post in the feed's top
  // slice. Same feature and same SOCIAL_* gates as that poll; the RSS cron
  // stays as a backstop and dedupes on source_url, so it never double-posts a
  // URL this already shared. Gated to NEW on-hub posts only (target.planLinks):
  // refreshes/metadata rewrites aren't new posts, and spoke-only posts are
  // neither in the hub feed nor written in hub-brand social copy. Fully
  // fail-soft — a share failure never blocks the completed_published finalize
  // (already claimed above), and IndexNow/link-planning already ran.
  if (target.planLinks && target.title && blogMergeSocialShareEnabled()) {
    try {
      const social = require('../social-media');
      const flags = social.SOCIAL_FLAGS || {};
      if (flags.automationEnabled && flags.rssAutopublish) {
        // shareUrlOnce serializes against the RSS cron via its advisory lock and
        // dedupes on source_url, so this deterministic trigger and the 4-hourly
        // RSS backstop can never double-post the same URL. Brand card only
        // (noAiImage) — mirrors the RSS cron's autonomous share path.
        const r = await social.shareUrlOnce({
          title: target.title,
          description: target.excerpt || '',
          link: target.url,
          source: 'autonomous_blog',
          noAiImage: true,
        });
        const status = r?.skipped ? `skipped (${r.skipped})`
          : r?.dryRun ? 'dry_run' : (r?.success ? 'published' : 'failed');
        logger.info(`[autonomous-pr-poller] social share for ${target.url}: ${status}`);
      }
    } catch (err) {
      logger.warn(`[autonomous-pr-poller] social share failed for ${target.url}: ${err.message}`);
    }
  }

  await reconcileQueueRow(run, { merged: true });
  logger.info(`[autonomous-pr-poller] run ${run.id} completed_published via PR #${prNumber}${autoMerged ? ' (auto-merged)' : ''} → ${target.url || 'no URL recorded'}`);
  return { merged: true, autoMerged, url: target.url };
}

/** PR closed without merge: terminal failure, never retried (both lanes). */
async function finalizeClosed(run, prNumber) {
  // Same finalize-time queue re-check as finalizeMerged: an operator who
  // requeued the opportunity mid-tick has already re-routed the work — the
  // old run gets annotated out of selection, not marked failed.
  const { parked, row: queueRow } = await queueRowParkedState(run);
  if (!parked) return supersedeRun(run, queueRow);

  const now = new Date();
  const claimed = await db('autonomous_runs')
    .where('id', run.id)
    .where('outcome', PENDING_OUTCOME)
    .where('skip_reason', pendingSkipReasonForRun(run))
    .update({
      outcome: 'failed',
      skip_reason: closedSkipReasonForRun(run),
      failure_message: `Astro ${isMetadataLane(run) ? 'metadata ' : ''}PR #${prNumber} was closed without merging; the draft was rejected and will not be retried.`,
      completed_at: now,
      updated_at: now,
    });
  if (!claimed) return { skipped: true, reason: 'already_finalized' };
  await reconcileQueueRow(run, { merged: false });
  logger.info(`[autonomous-pr-poller] run ${run.id} failed: PR #${prNumber} closed unmerged`);
  return { closed: true };
}

/**
 * Open PR + auto-merge enabled: merge only when the preview build is green,
 * was built from the PR's CURRENT head commit, AND Codex review is clear —
 * each condition individually blocking.
 */
async function maybeAutoMerge(run, pr) {
  const gh = require('../content-astro/github-client');
  const branch = pr.head?.ref;
  if (!branch) return { pending: true, reason: 'pr_head_branch_unknown' };

  // 1. Cloudflare preview build for the PR branch must be green.
  const { latestDeploymentForBranch, extractStatus, deploymentCommitSha } = require('../content-astro/pages-poll');
  const deploy = await latestDeploymentForBranch(branch);
  if (!deploy) return { pending: true, reason: 'preview_build_pending' };
  const { status } = extractStatus(deploy);
  if (status !== 'success') return { pending: true, reason: `preview_build_${status || 'pending'}` };

  // 1b. The green deployment must be a build of the PR's CURRENT head.
  //     latestDeploymentForBranch returns the newest deployment for the
  //     branch, which can still be an OLDER commit's build when a new push
  //     hasn't registered a deployment yet — merging on that signal would
  //     ship an unverified head. Fail closed when the deployment object
  //     carries no usable commit hash (skip the merge this tick; merged/
  //     closed reconciliation is unaffected).
  const headSha = normalizeSha(pr.head?.sha);
  const deployedSha = normalizeSha(deploymentCommitSha(deploy));
  if (!headSha) return { pending: true, reason: 'pr_head_sha_unknown' };
  if (!deployedSha) return { pending: true, reason: 'preview_build_commit_unknown' };
  if (deployedSha !== headSha) return { pending: true, reason: 'preview_build_stale_commit' };

  // 2. Codex review must be clear for the current head (fail closed —
  //    same gate mergeAstro applies on the scheduler path).
  const publisher = require('../content-astro/astro-publisher');
  try {
    await publisher.assertCodexReviewClear(pr.number, { headSha: pr.head?.sha });
  } catch (err) {
    if (err?.code === 'CODEX_REVIEW_REQUIRED') {
      return { pending: true, reason: `codex_review_pending: ${err.message}` };
    }
    throw err; // lookup outage etc. — transient, retry next tick
  }

  // 2b. Hub-only kill switch (mirrors mergeAstro's assertOpenPublishPrIsHubOnly,
  //     which THIS path bypasses). Never auto-merge a spoke-targeted PR while
  //     the spoke blog network is disabled — a stale spoke PR from before the
  //     lane was turned off would otherwise fan out to a spoke. Parks until the
  //     lane is re-enabled or the PR is closed.
  if (spokeMergeBlockedByKillSwitch(run)) {
    logger.info(`[autonomous-pr-poller] auto-merge blocked for run ${run.id}: PR #${pr.number} targets a spoke but the spoke blog network is disabled (set SPOKE_BLOG_NETWORK_ENABLED=true to allow)`);
    return { pending: true, reason: 'spoke_blog_network_disabled' };
  }

  // 2c. Daily publish cap — same env the runner's canary guard enforces at
  //     PR-open time. The runner bounds how many PRs OPEN per ET day; this
  //     bounds how many go LIVE per ET day, so a backlog of parked PRs
  //     (older days, human-cleared Codex findings) can't all auto-merge on
  //     the same afternoon. Capped runs stay parked for a human merge or
  //     tomorrow's ticks; count errors fail closed (no merge this tick).
  const maxPerDay = Number(process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY);
  if (Number.isFinite(maxPerDay) && maxPerDay > 0) {
    const { parseETDateTime, etDateString } = require('../../utils/datetime-et');
    const startOfEtDay = parseETDateTime(`${etDateString(new Date())}T00:00`);
    const row = await db('autonomous_runs')
      .where('action_type', run.action_type)
      .where('shadow_mode', false)
      .where('outcome', 'completed_published')
      .where('completed_at', '>=', startOfEtDay)
      .count('id as count')
      .first();
    if (Number(row?.count || 0) >= maxPerDay) {
      logger.info(`[autonomous-pr-poller] auto-merge deferred for run ${run.id}: daily publish cap reached (${row.count}/${maxPerDay} ${run.action_type} today)`);
      return { pending: true, reason: 'daily_publish_cap_reached' };
    }
  }

  // 3. Last-instant queue re-check: the gates above take seconds of network
  //    time, and the tick-start queue validation is stale by now. An
  //    operator requeue/dismiss landing in that window must block the merge
  //    (fresh read; a lookup error throws → transient, no merge).
  if (!(await queueRowStillParked(run))) {
    logger.info(`[autonomous-pr-poller] auto-merge aborted for run ${run.id}: opportunity_queue row moved during gating (operator action)`);
    return { pending: true, reason: 'queue_row_moved_during_gating' };
  }

  // 4. The merge itself is pinned to the head commit the gates above were
  //    checked against: GitHub rejects with 409 if the branch received
  //    another push while the merge call was in flight, so an unbuilt/
  //    unreviewed commit can never ride through the gate. The fresh head
  //    re-runs the full gate next tick.
  let mergeRes;
  try {
    mergeRes = await gh.mergePr(pr.number, {
      method: 'squash',
      title: String(pr.title || '').slice(0, 72),
      sha: pr.head?.sha,
    });
  } catch (err) {
    if (err?.status === 409) {
      logger.info(`[autonomous-pr-poller] auto-merge aborted for run ${run.id}: PR #${pr.number} head moved after gating (409)`);
      return { pending: true, reason: 'head_moved_during_merge' };
    }
    throw err; // anything else → transient via pollRun's catch
  }
  logger.info(`[autonomous-pr-poller] auto-merged PR #${pr.number} for run ${run.id} (build green + Codex clear)`);
  // finalizeMerged may legitimately stay pending here (production deploy of
  // the merge takes 30–45 min) — `autoMerged` must still be true on the
  // result so pollPending counts this tick's merge against the per-poll cap.
  const finalized = await finalizeMerged(run, pr.number, {
    autoMerged: true,
    mergeSha: mergeRes?.sha || null, // GitHub merge response carries the merge commit
    mergedAt: new Date().toISOString(),
  });
  return { ...finalized, autoMerged: true };
}

async function pollRun(run, { allowMerge = true } = {}) {
  const prNumber = prNumberFromUrl(run.astro_pr_url);
  if (!prNumber) {
    logger.warn(`[autonomous-pr-poller] run ${run.id} has unparseable astro_pr_url: ${run.astro_pr_url}`);
    return { skipped: true, reason: 'unparseable_pr_url' };
  }

  try {
    const gh = require('../content-astro/github-client');
    const pr = await gh.getPr(prNumber);
    if (!pr) {
      // GET 404 → null. PRs aren't deletable, so this means repo/env drift —
      // surface it but never fail the run over it.
      logger.warn(`[autonomous-pr-poller] PR #${prNumber} not found for run ${run.id}; leaving parked`);
      return { pending: true, reason: 'pr_not_found' };
    }

    if (pr.merged || pr.merged_at) {
      return await finalizeMerged(run, prNumber, {
        autoMerged: false,
        mergeSha: pr.merge_commit_sha || null,
        mergedAt: pr.merged_at || null,
      });
    }
    if (pr.state !== 'open') return await finalizeClosed(run, prNumber);

    if (!autoMergeEnabled()) return { pending: true, reason: 'awaiting_human_merge' };
    if (isMetadataLane(run)) {
      // Conservative reading of AUTONOMOUS_BLOG_AUTO_MERGE: the flag is
      // named for — and was trust-ramped on — the blog publish lane.
      // Metadata-rewrite PRs get lifecycle reconciliation only (the merged/
      // closed branches above) and ALWAYS wait for a human merge, even with
      // the flag on. Widening auto-merge to this lane needs its own decision
      // (and likely its own flag), not an implicit ride-along.
      return { pending: true, reason: 'awaiting_human_merge_metadata_lane' };
    }
    if (!allowMerge) {
      // Per-poll cap reached — each merge rebuilds the Cloudflare Pages
      // fleet, so drain the backlog one tick at a time (mirrors pages-poll).
      logger.info(`[autonomous-pr-poller] auto-merge deferred for run ${run.id} (per-poll cap reached); retries next tick`);
      return { pending: true, mergeDeferred: true };
    }
    return await maybeAutoMerge(run, pr);
  } catch (err) {
    // Transient (network / GitHub 5xx / Cloudflare blip): leave the row for
    // the next tick. NEVER mark a run failed on an infrastructure error.
    logger.warn(`[autonomous-pr-poller] run ${run.id} (PR #${prNumber}) poll failed: ${err.message}`);
    return { error: err.message, transient: true };
  }
}

async function pollPending() {
  let rows;
  try {
    rows = await db('autonomous_runs')
      .where('outcome', PENDING_OUTCOME)
      .whereIn('skip_reason', PENDING_SKIP_REASONS)
      .whereNotNull('astro_pr_url')
      // Random order, NOT claimed_at asc: parked runs (Codex-blocked, red
      // build, awaiting a human) stay in this set indefinitely, so a fixed
      // oldest-first order starves everything past the limit — once 25 runs
      // are parked, a newly-merged newer PR would never be polled and never
      // finalize (no IndexNow, no link planning, queue never completes).
      // Random rotation guarantees every parked run is visited across ticks
      // (every 2 min) with no schema change; with ≤25 parked it is identical
      // coverage to before.
      .orderByRaw('random()')
      .limit(25)
      .select('id', 'opportunity_id', 'brief_id', 'action_type', 'skip_reason', 'astro_pr_url', 'draft_payload', 'reviewer_notes', 'created_at');
  } catch (err) {
    logger.warn(`[autonomous-pr-poller] pending-run query failed: ${err.message}`);
    return { count: 0, skipped: true, reason: err.message };
  }
  if (!rows.length) return { count: 0, results: [] };

  // Human review-queue actions (requeue/dismiss) update ONLY the
  // opportunity_queue row and leave the run's parked outcome/skip_reason in
  // place — so the run's own state is not enough to reconcile on. Load each
  // run's queue row and only reconcile when it is still in the exact parked
  // review state; runs whose row moved on are superseded (annotated out of
  // the selection), never finalized. opportunity_id is nullable (FK is SET
  // NULL), so a run with no opportunity_id has nothing to cross-check and
  // reconciles normally. A failed lookup skips the whole tick (fail closed).
  let queueById = new Map();
  const oppIds = [...new Set(rows.map((r) => r.opportunity_id).filter(Boolean))];
  if (oppIds.length) {
    try {
      const queueRows = await db('opportunity_queue')
        .whereIn('id', oppIds)
        .select('id', 'status', 'skip_reason');
      queueById = new Map(queueRows.map((q) => [q.id, q]));
    } catch (err) {
      logger.warn(`[autonomous-pr-poller] opportunity_queue state query failed: ${err.message}`);
      return { count: 0, skipped: true, reason: err.message };
    }
  }

  const maxAutoMerges = maxAutoMergesPerPoll();
  const results = [];
  let autoMerges = 0;
  for (const run of rows) {
    if (run.opportunity_id) {
      const queueRow = queueById.get(run.opportunity_id) || null;
      const stillParked = !!queueRow
        && queueRow.status === 'pending_review'
        && queueRow.skip_reason === pendingSkipReasonForRun(run);
      if (!stillParked) {
        const r = await supersedeRun(run, queueRow);
        results.push({ id: run.id, pr_url: run.astro_pr_url, ...r });
        continue;
      }
    }
    const r = await pollRun(run, { allowMerge: autoMerges < maxAutoMerges });
    if (r.autoMerged) autoMerges += 1;
    results.push({ id: run.id, pr_url: run.astro_pr_url, ...r });
  }
  logger.info(`[autonomous-pr-poller] polled ${results.length} parked autonomous PR run(s) (${autoMerges} auto-merged)`);
  return { count: results.length, results, autoMerges };
}

module.exports = {
  pollPending,
  pollRun,
  _internals: {
    autoMergeEnabled,
    blogMergeSocialShareEnabled,
    maxAutoMergesPerPoll,
    prNumberFromUrl,
    pendingSkipReasonForRun,
    isMetadataLane,
    closedSkipReasonForRun,
    targetForRun,
    spokeMergeBlockedByKillSwitch,
    resolveTargetForRun,
    queueRowStillParked,
    finalizeMerged,
    finalizeClosed,
    reconcileQueueRow,
    supersedeRun,
  },
};
