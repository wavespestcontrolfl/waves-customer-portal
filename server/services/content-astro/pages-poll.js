/**
 * pages-poll.js — polls the Cloudflare Pages API for preview deployment
 * status on open blog-publish PRs.
 *
 * For every blog_posts row in `astro_status='pr_open'`, look up the most
 * recent deployment for its branch and update:
 *   success  → astro_preview_url (resolves the pages.dev short URL)
 *   failure  → astro_status='build_failed' + error captured
 *
 * This is the "preview" half of the pipeline. After merge, a separate
 * check resolves the live URL on the hub (and relevant spokes) and
 * flips astro_status → 'live'.
 *
 * Env: CF_API_TOKEN, CF_ACCOUNT_ID, CF_PAGES_PROJECT
 * Intended caller: scheduler cron (every 1–2 min) or manual refresh from
 * the admin UI.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { liveUrlForPost } = require('./astro-publisher');

function cfEnv() {
  const token = process.env.CF_API_TOKEN;
  const account = process.env.CF_ACCOUNT_ID;
  const project = process.env.CF_PAGES_PROJECT || 'wavespestcontrol-astro';
  if (!token || !account) throw new Error('CF_API_TOKEN / CF_ACCOUNT_ID not configured');
  return { token, account, project };
}

async function cfFetch(path) {
  const { token, account } = cfEnv();
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Cloudflare ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function latestDeploymentForBranch(branch) {
  const { project } = cfEnv();
  // CF API paginates but default is newest-first; for a freshly pushed
  // feature branch there are only ever 1–3 deployments. Grab page 1.
  const res = await cfFetch(`/pages/projects/${encodeURIComponent(project)}/deployments?env=preview&per_page=25`);
  const list = Array.isArray(res?.result) ? res.result : [];
  return list.find((d) => d?.deployment_trigger?.metadata?.branch === branch) || null;
}

// Newest successful production deployment, regardless of which commit it
// was for. Used by the autonomous PR poller: main is linear (squash
// merges), so ANY successful production deploy at/after a merge contains
// that merge — checking "latest success is newer than merged_at" is both
// sufficient and immune to the 25-deploy pagination window that a
// commit-exact match can fall out of on busy days.
async function latestSuccessfulProductionDeployment() {
  const { project } = cfEnv();
  const res = await cfFetch(`/pages/projects/${encodeURIComponent(project)}/deployments?env=production&per_page=25`);
  const list = Array.isArray(res?.result) ? res.result : [];
  return list.find((d) => {
    if (d?.environment && d.environment !== 'production') return false;
    return extractStatus(d).status === 'success';
  }) || null;
}

async function latestProductionDeploymentForPost(post) {
  const { project } = cfEnv();
  const res = await cfFetch(`/pages/projects/${encodeURIComponent(project)}/deployments?env=production&per_page=25`);
  const list = Array.isArray(res?.result) ? res.result : [];
  const eligible = list.filter((deploy) => deploymentMatchesMergedPost(deploy, post));
  if (eligible.length <= 1) return eligible[0] || null;

  // More than one production deploy falls in the match window (a busy push
  // window). Prefer an exact commit match; otherwise the deploy triggered
  // CLOSEST to the merge, so a later unrelated merge's deploy isn't mistaken
  // for ours (the old `.find` on the newest-first list could pick it).
  const wantedSha = normalizeSha(post.astro_commit_sha);
  if (wantedSha) {
    const exact = eligible.find((d) => normalizeSha(deploymentCommitSha(d)) === wantedSha);
    if (exact) return exact;
  }
  const mergedAt = timestampMs(post.astro_merged_at);
  if (mergedAt == null) return eligible[0];
  return eligible
    .map((d) => ({ d, delta: Math.abs((deploymentTimestampMs(d) ?? mergedAt) - mergedAt) }))
    .sort((a, b) => a.delta - b.delta)[0].d;
}

function extractStatus(deploy) {
  // CF Pages deployments have a list of stages (queued → initialize →
  // clone_repo → build → deploy). The last stage's `status` tells us
  // what happened. Values: active | success | failure | canceled | skipped.
  const stages = Array.isArray(deploy?.stages) ? deploy.stages : [];
  const last = stages[stages.length - 1];
  return {
    stage: last?.name || null,
    status: deploy?.latest_stage?.status || last?.status || null,
    url: deploy?.url || null,
    error: deploy?.latest_stage?.status === 'failure' ? (deploy?.latest_stage?.name || 'build failed') : null,
  };
}

function deploymentMatchesMergedPost(deploy, post) {
  const { status } = extractStatus(deploy);
  if (deploy?.environment && deploy.environment !== 'production') return false;
  if (status !== 'success') return false;

  const wantedSha = normalizeSha(post.astro_commit_sha);
  const deployedSha = normalizeSha(deploymentCommitSha(deploy));
  if (wantedSha && deployedSha) return wantedSha === deployedSha;

  const mergedAt = timestampMs(post.astro_merged_at);
  const createdAt = deploymentCreatedAtMs(deploy);
  if (mergedAt == null || createdAt == null) return false;
  // Bounded window on the deploy's CREATION time: at/after the merge AND
  // within a plausible trigger window after it. Two prior bugs live here:
  // (1) only a lower bound, so ANY later production deploy (a subsequent
  // unrelated merge) matched and could flip this post live prematurely;
  // (2) the completion timestamp was compared, so a deploy of a PRE-merge
  // commit that merely FINISHED after the merge (builds take 30–45 min)
  // matched too. A deploy CREATED at/after the merge necessarily clones a
  // tree containing it (main is linear via squash merges). No negative
  // clock-skew allowance: a deploy created moments BEFORE the merge doesn't
  // contain it, and losing the merge's own deploy to sub-second skew just
  // means waiting for the next tick/deploy (fail closed, self-heals).
  const maxAge = Number(process.env.CF_DEPLOY_MATCH_MAX_AGE_MS);
  const MAX_AGE_MS = Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 3600000;
  return createdAt >= mergedAt && createdAt <= mergedAt + MAX_AGE_MS;
}

function deploymentCommitSha(deploy) {
  const metadata = deploy?.deployment_trigger?.metadata || {};
  return metadata.commit_hash
    || metadata.commit_sha
    || metadata.commit
    || deploy?.source?.config?.commit_hash
    || deploy?.source?.config?.commit_sha
    || deploy?.source?.commit_hash
    || deploy?.source?.commit_sha
    || null;
}

function deploymentTimestampMs(deploy) {
  const metadata = deploy?.deployment_trigger?.metadata || {};
  return timestampMs(deploy?.modified_on)
    ?? timestampMs(deploy?.created_on)
    ?? timestampMs(metadata.committed_on)
    ?? timestampMs(metadata.commit_time);
}

// When a deploy was TRIGGERED — never modified_on. "Contains the merge"
// reasoning must compare the merge time against when the deploy was created
// (CF clones the repo after that), not when it finished: hub production
// builds take 30–45 min, so a deploy of a PRE-merge commit routinely
// COMPLETES after the merge and a completion-time window matches it.
function deploymentCreatedAtMs(deploy) {
  const metadata = deploy?.deployment_trigger?.metadata || {};
  return timestampMs(deploy?.created_on)
    ?? timestampMs(metadata.committed_on)
    ?? timestampMs(metadata.commit_time);
}

function timestampMs(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isNaN(ms) ? null : ms;
}

function normalizeSha(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

async function pollPost(post, { allowMerge = true } = {}) {
  if (post.astro_status === 'merged') return pollLivePost(post);
  if (!post.astro_branch_name) return { skipped: true, reason: 'no branch' };
  try {
    const deploy = await latestDeploymentForBranch(post.astro_branch_name);
    if (!deploy) return { pending: true };

    const { status, url, error } = extractStatus(deploy);

    if (status === 'success' && url) {
      await db('blog_posts').where({ id: post.id }).update({
        astro_preview_url: url,
        updated_at: new Date(),
      });

      // DELIBERATE auto-merge path for SCHEDULER-driven posts: publish_status
      // 'publishing' is the content-scheduler's transient claim state while it
      // drives a scheduled post live, and mergeAstro below is Codex-gated
      // (assertCodexReviewClear) before any merge. Note the coupling: a row
      // STRANDED at 'publishing' (process crashed mid-publish) would keep this
      // branch armed indefinitely — the content-scheduler's stale-publishing
      // sweep (resetStalePublishingBlogs, ~30 min) bounds that window by
      // resetting crashed claims out of 'publishing' ('pending' when no Astro
      // state exists yet, 'pending_review' otherwise). Keep that sweep in
      // mind before changing this condition.
      if (post.astro_status === 'pr_open' && post.publish_status === 'publishing') {
        if (post.astro_requires_human_merge) {
          // Named-competitor content on the UNATTENDED lane: publishAstro
          // stamped this post as passing the comparison gate only under a
          // human sign-off (validated <ComparisonTable> naming curated
          // competitors). The scheduler's claim is not that sign-off — the
          // autonomous lane parks these for approval and the admin lane's
          // merge click provides it — so the auto-merge is withheld. Park
          // the claim at pending_review (claim-guarded, same CAS rule as
          // the scheduler) so this branch disarms instead of re-arming
          // every 2-minute tick; the PR stays open for an admin to merge
          // via merge-astro, and the merged→live transition then completes
          // the post exactly like the admin lane.
          await db('blog_posts').where({ id: post.id, publish_status: 'publishing' })
            .update({ publish_status: 'pending_review', updated_at: new Date() });
          logger.warn(`[pages-poll] auto-merge WITHHELD for ${post.slug || post.id} — post names curated competitors (astro_requires_human_merge); PR left open for admin merge`);
          return { ok: true, url, humanMergeRequired: true };
        }
        if (!allowMerge) {
          // Per-poll auto-merge cap reached — defer this merge to the next tick
          // so we don't squash N PRs to main at once (each merge rebuilds the
          // whole Cloudflare Pages fleet). The poll runs every 2 min, so the
          // backlog drains quickly.
          logger.info(`[pages-poll] auto-merge deferred for ${post.slug || post.id} (per-poll cap reached); retries next tick`);
          return { ok: true, url, mergeDeferred: true };
        }
        try {
          const { mergeAstro } = require('./astro-publisher');
          // Pin the merge to the commit this GREEN deploy was built from:
          // latestDeploymentForBranch returns the newest deployment for the
          // branch, which can still be an OLDER commit's build when a fresh
          // push hasn't registered its deployment yet — without the pin, a
          // green build of commit A would authorize merging commit B.
          // deploymentCommitSha may be null (CF metadata missing) — mergeAstro
          // treats null as "no build-commit assertion" and still enforces its
          // own Codex-clear + head-pinned merge.
          await mergeAstro(post.id, { expectHeadSha: deploymentCommitSha(deploy) });
          logger.info(`[pages-poll] auto-merged PR for ${post.slug || post.id} (preview build succeeded)`);
          return { ok: true, url, autoMerged: true };
        } catch (mergeErr) {
          logger.warn(`[pages-poll] auto-merge failed for ${post.slug || post.id}: ${mergeErr.message}`);
          // Codex left findings on the PR → try to auto-fix them so the post
          // can merge without a human. No-op unless AUTONOMOUS_CODEX_REMEDIATION
          // is on; never merges (that still needs a genuine Codex-clean signal).
          if (mergeErr.code === 'CODEX_REVIEW_REQUIRED') {
            try {
              const { maybeRemediate } = require('../content/codex-remediation');
              const rem = await maybeRemediate(post);
              if (rem?.remediated) {
                logger.info(`[pages-poll] codex remediation round ${rem.round} pushed for ${post.slug || post.id} (${rem.findings} finding(s))`);
              } else if (rem?.parked) {
                logger.warn(`[pages-poll] codex remediation parked ${post.slug || post.id}: ${rem.reason}`);
              }
            } catch (remErr) {
              logger.warn(`[pages-poll] codex remediation error for ${post.slug || post.id}: ${remErr.message}`);
            }
          }
        }
      }

      return { ok: true, url };
    }

    if (status === 'failure') {
      await db('blog_posts').where({ id: post.id }).update({
        astro_status: 'build_failed',
        astro_publish_error: error || 'Cloudflare Pages build failed',
        updated_at: new Date(),
      });
      return { failed: true, error };
    }

    return { pending: true, status };
  } catch (err) {
    logger.warn(`[pages-poll] ${post.astro_branch_name} failed: ${err.message}`);
    return { error: err.message };
  }
}

async function pollLivePost(post) {
  const url = post.astro_live_url || liveUrlForPost(post);
  if (!url) return { skipped: true, reason: 'no live url' };

  try {
    const deploy = await latestProductionDeploymentForPost(post);
    if (!deploy) return { pending: true, url, reason: 'production deployment pending' };

    const seen = await liveUrlResponds(url);
    if (!seen) return { pending: true, url };

    const updates = {
      astro_status: 'live',
      astro_live_url: url,
      astro_published_at: post.astro_published_at || new Date(),
      status: 'published',
      updated_at: new Date(),
    };

    await db('blog_posts').where({ id: post.id }).update(updates);
    await runPostPublishVisibility({ ...post, ...updates, astro_live_url: url });
    return { live: true, url, deployment_url: deploy.url || null };
  } catch (err) {
    logger.warn(`[pages-poll] live check failed for ${url}: ${err.message}`);
    return { pending: true, url, error: err.message };
  }
}

async function runPostPublishVisibility(post) {
  try {
    const worker = require('../content/post-publish-visibility-worker');
    if (worker?.runForPost) await worker.runForPost(post);
  } catch (err) {
    logger.warn(`[pages-poll] post-publish visibility check failed for ${post.slug || post.id}: ${err.message}`);
  }
}

async function liveUrlResponds(url) {
  const head = await fetchWithTimeout(url, { method: 'HEAD' });
  if (head.status === 405 || head.status === 403) {
    const get = await fetchWithTimeout(url, { method: 'GET' });
    return get.status >= 200 && get.status < 400;
  }
  return head.status >= 200 && head.status < 400;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...options,
      headers: {
        'Cache-Control': 'no-cache',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function pollPending() {
  try {
    cfEnv(); // throws early if unconfigured
  } catch (err) {
    logger.warn(`[pages-poll] checks skipped: ${err.message}`);
    return { count: 0, skipped: true, reason: err.message };
  }

  const pending = await db('blog_posts')
    .whereIn('astro_status', ['pr_open', 'build_failed', 'merged'])
    .whereNotNull('astro_branch_name')
    .select('id', 'slug', 'target_sites', 'publish_status', 'astro_branch_name', 'astro_preview_url', 'astro_live_url', 'astro_status', 'astro_merged_at', 'astro_published_at', 'astro_commit_sha', 'astro_requires_human_merge');

  // Cap auto-merges per tick so a batch of simultaneously-green PRs doesn't all
  // squash to main at once (each merge rebuilds the whole Cloudflare Pages
  // fleet). Build-status polling + the merged→live transition are unaffected;
  // only the merge action is throttled, and deferred merges retry next tick.
  const rawMax = parseInt(process.env.AUTONOMOUS_CONTENT_MAX_AUTO_MERGES_PER_POLL, 10);
  const maxAutoMerges = Number.isFinite(rawMax) && rawMax >= 0 ? rawMax : 2;

  const results = [];
  let autoMerges = 0;
  let deferred = 0;
  for (const post of pending) {
    const r = await pollPost(post, { allowMerge: autoMerges < maxAutoMerges });
    if (r.autoMerged) autoMerges += 1;
    if (r.mergeDeferred) deferred += 1;
    results.push({ id: post.id, branch: post.astro_branch_name, ...r });
  }
  const note = deferred > 0 ? ` (${autoMerges} merged, ${deferred} deferred past cap ${maxAutoMerges})` : '';
  logger.info(`[pages-poll] polled ${results.length} blog publish states${note}`);
  return { count: results.length, results, autoMerges, deferred };
}

module.exports = {
  pollPost,
  pollPending,
  pollLivePost,
  liveUrlResponds,
  deploymentMatchesMergedPost,
  runPostPublishVisibility,
  // Reused by the autonomous PR-lifecycle poller to verify a PR branch's
  // Cloudflare preview build is green AND built from the PR's current head
  // commit before auto-merging (deploymentCommitSha returns null when the
  // deployment object carries no usable commit hash — callers fail closed).
  latestDeploymentForBranch,
  extractStatus,
  deploymentCommitSha,
  // Also reused by the poller: PR-backed publishes (including
  // new_supporting_blog, which can UPDATE an existing slug) must not
  // finalize until a successful production deploy contains the merge —
  // exact merge-sha match, or latest success CREATED at/after merged_at
  // (deploymentCreatedAtMs, never the completion timestamp — see its note).
  latestSuccessfulProductionDeployment,
  deploymentTimestampMs,
  deploymentCreatedAtMs,
};
