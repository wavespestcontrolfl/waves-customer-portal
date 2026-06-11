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
 * Each tick, for every parked run with an astro_pr_url:
 *   - PR merged (by human or by us)  → finalize: flip the run to
 *     completed_published with the canonical URL, submit IndexNow, and
 *     queue post-merge internal-link planning (new_supporting_blog only —
 *     rewrite/refresh targets already exist in the link corpus). Also
 *     best-effort completes the parked opportunity_queue row.
 *   - PR closed unmerged             → flip the run to failed (no retry).
 *   - PR open + AUTONOMOUS_BLOG_AUTO_MERGE truthy → merge it OURSELVES,
 *     but only when the Cloudflare preview build for the PR branch is
 *     green AND assertCodexReviewClear passes for the PR head (fail
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

const PENDING_OUTCOME = 'completed_pending_review';
const PENDING_SKIP_REASON = 'astro_pr_pending_merge';
const CLOSED_SKIP_REASON = 'astro_pr_closed_unmerged';
const PR_URL_NUMBER = /\/pull\/(\d+)(?:[/?#]|$)/;

function autoMergeEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.AUTONOMOUS_BLOG_AUTO_MERGE || '').trim());
}

function maxAutoMergesPerPoll() {
  const raw = parseInt(process.env.AUTONOMOUS_PR_MAX_AUTO_MERGES_PER_POLL, 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
}

function prNumberFromUrl(prUrl) {
  const match = PR_URL_NUMBER.exec(String(prUrl || ''));
  return match ? Number(match[1]) : null;
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
    planLinks: isNewPage,
  };
}

/**
 * Best-effort: the runner parked the opportunity_queue row at
 * status='pending_review' / skip_reason='astro_pr_pending_merge' alongside
 * the run. complete()/skip() require the original claimToken (the row is no
 * longer 'claimed'), so reconcile directly — guarded to the exact parked
 * state so we never touch a row a human re-routed. Failure logs only; queue
 * state must never block run finalization.
 */
async function reconcileQueueRow(run, { merged }) {
  if (!run.opportunity_id) return;
  try {
    await db('opportunity_queue')
      .where('id', run.opportunity_id)
      .where('status', 'pending_review')
      .where('skip_reason', PENDING_SKIP_REASON)
      .update(merged
        ? { status: 'done', completed_at: new Date(), updated_at: new Date() }
        : { status: 'skipped', skip_reason: CLOSED_SKIP_REASON, completed_at: new Date(), updated_at: new Date() });
  } catch (err) {
    logger.warn(`[autonomous-pr-poller] opportunity_queue reconcile failed for run ${run.id}: ${err.message}`);
  }
}

/**
 * PR is merged: claim the run row atomically (compare-and-set on the parked
 * outcome so overlapping ticks / a concurrent manual finalize can't run the
 * post-merge chain twice), then IndexNow + internal-link planning.
 * Side effects run AFTER the claim on purpose — a crash between claim and
 * side effects loses only belt-and-suspenders work (IndexNow is throttled/
 * relayed by Cloudflare anyway, link tasks are deduped on conflict), whereas
 * side effects before the claim could double-run them.
 */
async function finalizeMerged(run, prNumber, { autoMerged = false } = {}) {
  const target = targetForRun(run);
  const now = new Date();
  const note = `${autoMerged ? 'Auto-merged' : 'PR merged'} (#${prNumber}); run completed by autonomous-pr-poller.`;

  const claimed = await db('autonomous_runs')
    .where('id', run.id)
    .where('outcome', PENDING_OUTCOME)
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

  await reconcileQueueRow(run, { merged: true });
  logger.info(`[autonomous-pr-poller] run ${run.id} completed_published via PR #${prNumber}${autoMerged ? ' (auto-merged)' : ''} → ${target.url || 'no URL recorded'}`);
  return { merged: true, autoMerged, url: target.url };
}

/** PR closed without merge: terminal failure, never retried. */
async function finalizeClosed(run, prNumber) {
  const now = new Date();
  const claimed = await db('autonomous_runs')
    .where('id', run.id)
    .where('outcome', PENDING_OUTCOME)
    .update({
      outcome: 'failed',
      skip_reason: CLOSED_SKIP_REASON,
      failure_message: `Astro PR #${prNumber} was closed without merging; the draft was rejected and will not be retried.`,
      completed_at: now,
      updated_at: now,
    });
  if (!claimed) return { skipped: true, reason: 'already_finalized' };
  await reconcileQueueRow(run, { merged: false });
  logger.info(`[autonomous-pr-poller] run ${run.id} failed: PR #${prNumber} closed unmerged`);
  return { closed: true };
}

/**
 * Open PR + auto-merge enabled: merge only when the preview build is green
 * AND Codex review is clear — each condition individually blocking.
 */
async function maybeAutoMerge(run, pr) {
  const gh = require('../content-astro/github-client');
  const branch = pr.head?.ref;
  if (!branch) return { pending: true, reason: 'pr_head_branch_unknown' };

  // 1. Cloudflare preview build for the PR branch must be green.
  const { latestDeploymentForBranch, extractStatus } = require('../content-astro/pages-poll');
  const deploy = await latestDeploymentForBranch(branch);
  if (!deploy) return { pending: true, reason: 'preview_build_pending' };
  const { status } = extractStatus(deploy);
  if (status !== 'success') return { pending: true, reason: `preview_build_${status || 'pending'}` };

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

  await gh.mergePr(pr.number, {
    method: 'squash',
    title: String(pr.title || '').slice(0, 72),
  });
  logger.info(`[autonomous-pr-poller] auto-merged PR #${pr.number} for run ${run.id} (build green + Codex clear)`);
  return finalizeMerged(run, pr.number, { autoMerged: true });
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

    if (pr.merged || pr.merged_at) return await finalizeMerged(run, prNumber, { autoMerged: false });
    if (pr.state !== 'open') return await finalizeClosed(run, prNumber);

    if (!autoMergeEnabled()) return { pending: true, reason: 'awaiting_human_merge' };
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
      .where('skip_reason', PENDING_SKIP_REASON)
      .whereNotNull('astro_pr_url')
      .orderBy('claimed_at', 'asc')
      .limit(25)
      .select('id', 'opportunity_id', 'action_type', 'astro_pr_url', 'draft_payload', 'reviewer_notes');
  } catch (err) {
    logger.warn(`[autonomous-pr-poller] pending-run query failed: ${err.message}`);
    return { count: 0, skipped: true, reason: err.message };
  }
  if (!rows.length) return { count: 0, results: [] };

  const maxAutoMerges = maxAutoMergesPerPoll();
  const results = [];
  let autoMerges = 0;
  for (const run of rows) {
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
    maxAutoMergesPerPoll,
    prNumberFromUrl,
    targetForRun,
    finalizeMerged,
    finalizeClosed,
    reconcileQueueRow,
  },
};
