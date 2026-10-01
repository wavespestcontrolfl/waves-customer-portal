/**
 * internal-link-pr-executor.js
 *
 * Conservative executor for turning queued internal-link tasks into safe,
 * SEO-aware patch candidates and, when explicitly unshadowed, review-only
 * Astro PRs. It validates tasks, independently constructs patches, and never
 * auto-merges.
 */

const db = require('../../models/db');
const logger = require('../logger');
const GitHubClient = require('../content-astro/github-client');
const frontmatter = require('../content-astro/frontmatter');
const planner = require('./internal-link-planner');
const policy = require('./internal-link-seo-policy');
const judge = require('./internal-link-judge');
const protectedPages = require('./protected-pages');
const { runExclusive } = require('../../utils/cron-lock');
const { etDateString, etWeekStart, parseETDateTime } = require('../../utils/datetime-et');
// Text-level checks are OWNED by the planner and shared here — the planner
// applies every one of them before its site-wide cap, so it never plans a
// task this executor's gate would reject on corpus-knowable grounds.
const {
  sourceRendersOffHub,
  canonicalPointsOffHub,
  pageAlreadyLinksTo,
  findFirstUnlinkedOccurrence,
  findEligiblePlacement,
  placementForTask,
  paragraphAround,
  paragraphHasLink,
  robotsNoindex,
  countInternalLinks,
  inferPageType,
  inferCluster,
  maskExcludedRegions,
  envMinTopicalRelevance,
} = planner._internals;

const TABLE = 'content_internal_link_tasks';
const EXECUTOR_VERSION = 'internal-link-dry-run-v1';
// v2 = every link in the PR passed the LLM reader check and the
// anchor_not_target_specific rule. runAutoMerge merges ONLY v2 PRs; a PR
// opened by an older executor stays for a human.
const PR_EXECUTOR_VERSION = 'internal-link-pr-executor-v2';
const RECOVERED_PR_EXECUTOR_VERSION = 'internal-link-pr-executor-recovered';
const DEFAULT_LIMIT = 10;
// A pr_reserved row normally flips to pr_open/failed within seconds; one
// untouched for 2h with no PR URL is a crash orphan (see
// _recoverStalePrReservedTasks).
const STALE_PR_RESERVED_MS = 2 * 60 * 60 * 1000;

const MISSING_FILE_RE = /^(source_file_not_found|target_file_not_found|target_file_unresolved):/;
// Reviewer verdicts (the LLM reader check, Codex findings) are terminal: a
// replan must not re-queue them, or an unchanged link would be retried until
// a later nondeterministic verdict — or Codex silence — let it through.
// queueInternalLinkTaskForDryRun honors these prefixes; a human requeue
// from the review queue still can.
const REVIEWER_REJECTION_PREFIXES = ['llm_judge_rejected', 'codex_findings'];
// Marker for a PR closed so its links return to the pool (moved main,
// canceled preview), recorded before the branch retirement that may fail.
const RECYCLE_PENDING = 'internal_link_recycle_pending';
// Stamped on pr_open rows (failure_reason) just before mergePr's external
// write; cleared by the recorded publication or a merge that didn't land.
const MERGE_IN_FLIGHT = 'internal_link_merge_in_flight';

function terminalVerdict(task, fields) {
  return { persist: { task_id: task.id, executor_version: EXECUTOR_VERSION, ...fields } };
}

// ── PR batch: one candidate's stages (see _evaluateCandidate) ─────────
async function loadPagesStage(ctx) {
  try {
    ctx.source = await this._loadSourcePage(ctx.task);
    ctx.target = await this._loadTargetPage(ctx.task);
    return null;
  } catch (err) {
    // Only a confirmed-missing file is terminal; a GitHub rate limit,
    // network error or 5xx leaves the candidate for the next sweep.
    const reason = String(err?.message || err);
    if (MISSING_FILE_RE.test(reason)) return terminalVerdict(ctx.task, { status: 'failed', failure_reason: reason.slice(0, 500) });
    logger.warn(`[internal-link-pr-executor] transient load failure for ${ctx.task.id} (retry next sweep): ${reason}`);
    return { retry: true };
  }
}

// Link TARGETS may be protected money pages; the SOURCE is the page this PR
// edits, so it keeps the protected-page guard. A check error fails closed
// without persisting (retried next sweep).
async function sourceProtectionStage(ctx) {
  const prot = await this._sourceProtection(ctx.source, ctx.task);
  if (prot.error) return { retry: true };
  if (!prot.protected) return null;
  return terminalVerdict(ctx.task, { status: 'skipped', skip_reason: `source_protected_page:${prot.reason || 'protected'}` });
}

function validateStage(ctx) {
  const { task, batch } = ctx;
  ctx.validation = evaluateDryRunTask(task, {
    sourcePage: ctx.source,
    targetPage: ctx.target,
    options: { targetNewLinksInPr: batch.targetCounts.get(policy.normalizeInternalUrl(task.target_url)) || 0 },
  });
  if (ctx.validation.status !== 'patch_candidate') return { persist: ctx.validation };
  // Key the per-source cap by the RESOLVED path (source.file) so two tasks
  // for the same post under different extensions (.md + migrated .mdx) count
  // as one source — otherwise both would write the same file in one PR with
  // the same base SHA and the second Contents update would conflict.
  ctx.sourceKey = ctx.source.file || task.source_file;
  ctx.targetUrl = policy.normalizeInternalUrl(task.target_url || ctx.validation.target_canonical_url);
  const capped = (batch.sourceCounts.get(ctx.sourceKey) || 0) >= batch.maxLinksPerSource
    || (batch.targetCounts.get(ctx.targetUrl) || 0) >= batch.maxLinksPerTarget;
  return capped ? { retry: true } : null;
}

async function renderedSourceStage(ctx) {
  const rendered = await this._validateRenderedSourceAnchor(ctx.task, ctx.validation);
  if (rendered.ok) return null;
  const failed = rendered.status === 'failed';
  // A live fetch that failed for any reason other than the page being gone
  // (404/410) — network error, 5xx, CDN blip — is retried next sweep, never
  // persisted as a terminal failure.
  if (failed && !/live_http_(404|410)\b/.test(String(rendered.reason || ''))) return { retry: true };
  return {
    persist: {
      ...ctx.validation,
      status: rendered.status || 'skipped',
      skip_reason: failed ? null : rendered.reason,
      failure_reason: failed ? rendered.reason : null,
    },
  };
}

// The patch must land on the occurrence that passed validation (same
// effective terms), add a crawlable link, and leave frontmatter untouched.
const PATCH_CHECKS = [
  { fails: (patched, ctx) => patched === ctx.source.body, verdict: { status: 'skipped', skip_reason: 'patch_noop' } },
  { fails: (patched, ctx) => !patchContainsCrawlableMarkdownLink(patched, ctx.task.anchor_text, ctx.targetUrl), verdict: { status: 'failed', failure_reason: 'rendered_link_validation_failed' } },
  { fails: (patched, ctx) => !frontmatterUnchanged(ctx.source.body, patched), verdict: { status: 'failed', failure_reason: 'frontmatter_changed' } },
];

function patchStage(ctx) {
  const { task, target, targetUrl } = ctx;
  ctx.patchedContent = planner.applyTaskToBody(
    ctx.source.body,
    { ...task, target_url: targetUrl },
    { targetTerms: effectiveTargetTerms(target, targetUrl, task).targetTerms }
  );
  const failed = PATCH_CHECKS.find((check) => check.fails(ctx.patchedContent, ctx));
  return failed ? { persist: { ...ctx.validation, ...failed.verdict } } : null;
}

// Reader check (internal-link-judge): link PRs merge unattended, so an LLM
// reads the link in context before it is committed. No verdict (provider
// outage) leaves the candidate for the next sweep.
async function judgeStage(ctx) {
  const verdict = await this._judgeLink(ctx);
  if (!verdict.ok) return { retry: true };
  if (verdict.approve) return null;
  return { persist: { ...ctx.validation, status: 'skipped', skip_reason: `llm_judge_rejected:${verdict.reason}`.slice(0, 500) } };
}

const CANDIDATE_STAGES = [loadPagesStage, sourceProtectionStage, validateStage, renderedSourceStage, patchStage, judgeStage];

// ── Auto-merge gates (see runAutoMerge / _applyGateOutcome) ───────────
// Links already published (runAutoMerge records merged_at before settling):
// finish fencing — close the PR if a late commit left it open, confirm the
// branch is retired — then let the tasks leave pr_open. A GitHub failure
// throws or holds and the next tick retries; nothing below may treat this
// PR as unmerged.
async function publishedCleanupGate(ctx) {
  if (!ctx.prTasks.length || !ctx.prTasks.every((t) => t.merged_at)) return null;
  if (String(ctx.pr?.state || '').toLowerCase() === 'open') await GitHubClient.closePr(ctx.prNumber);
  // A surviving branch could carry unreviewed late commits and be reopened:
  // the rows stay pr_open (guard up, retried every tick) until its
  // retirement is CONFIRMED.
  let retired = false;
  try {
    retired = await GitHubClient.retireBranch(ctx.pr?.head?.ref);
  } catch (err) {
    logger.warn(`[internal-link-pr-executor] branch retirement after publish failed for PR #${ctx.prNumber}: ${err.message}`);
  }
  if (!retired) return { hold: 'published_branch_retire_pending' };
  for (const task of ctx.prTasks) {
    await this._markTaskMerged(task.id, { mergedAt: new Date(task.merged_at), commitSha: task.pr_commit_sha || null });
  }
  return { result: { status: 'merged', reason: 'published_settled' } };
}

// A merge was started (MERGE_IN_FLIGHT recorded) but its publication was
// never recorded — the process died mid-merge, or the error path could not
// clear the marker. Prove from GitHub whether main contains our commit (the
// atomic merge makes it a parent of main's new commit): if so, record the
// publication and settle through publishedCleanupGate; if not, the merge
// never landed — clear the marker and continue the normal gates.
async function mergeInFlightGate(ctx) {
  const inFlight = ctx.prTasks.filter((t) => t.failure_reason === MERGE_IN_FLIGHT && !t.merged_at);
  if (!inFlight.length) return null;
  const ours = String(inFlight[0].pr_commit_sha || '');
  let landed;
  try {
    const production = process.env.GITHUB_ASTRO_DEFAULT_BRANCH || 'main';
    const { mergeBaseSha } = await GitHubClient.compareFiles(production, ours);
    landed = !!ours && String(mergeBaseSha || '').toLowerCase() === ours.toLowerCase();
  } catch (err) {
    logger.warn(`[internal-link-pr-executor] merge-in-flight check failed for PR #${ctx.prNumber}: ${err.message}`);
    return { hold: 'merge_state_unknown' };
  }
  const ids = ctx.prTasks.map((t) => t.id);
  if (!landed) {
    await db(TABLE).whereIn('id', ids).where({ status: 'pr_open', failure_reason: MERGE_IN_FLIGHT })
      .update({ failure_reason: null, updated_at: new Date() });
    ctx.prTasks = ctx.prTasks.map((t) => ({ ...t, failure_reason: null }));
    return null;
  }
  const mergedAt = new Date();
  await db(TABLE).whereIn('id', ids).where('status', 'pr_open').update({ merged_at: mergedAt, updated_at: new Date() });
  return publishedCleanupGate.call(this, { ...ctx, prTasks: ctx.prTasks.map((t) => ({ ...t, merged_at: mergedAt })) });
}

function prStateGate(ctx) {
  const state = String(ctx.pr?.state || '').toLowerCase();
  if (ctx.pr && !ctx.pr.merged && state === 'closed') {
    // Closed unmerged (by a gate whose branch retirement failed, or by
    // hand): retire the branch before the tasks leave pr_open. A reviewer
    // rejection recorded before the failed retirement is carried through.
    const rejection = ctx.prTasks.map((t) => t.skip_reason)
      .find((r) => REVIEWER_REJECTION_PREFIXES.some((prefix) => String(r || '').startsWith(prefix)));
    const recycle = ctx.prTasks.some((t) => t.skip_reason === RECYCLE_PENDING);
    const close = rejection
      ? { status: 'skipped', skipReason: rejection, note: 'Link PR closed after a reviewer rejection; branch retired.' }
      : recycle
        ? { status: 'patch_candidate', note: 'Link PR closed for a retry; branch retired, links returned to the candidate pool.' }
        : { status: 'failed', failureReason: 'internal_link_pr_closed_unmerged', note: 'Link PR closed without merging; branch retired.' };
    return { reason: 'pr_closed_unmerged', close };
  }
  // Merged PRs are settled by runPostMergeVerification.
  return state === 'open' ? null : { result: { status: 'pr_not_open' } };
}

// Only a PR this executor opened after the reader check existed (v2), on
// the exact head it pushed.
function provenanceGate(ctx) {
  if (ctx.prTasks.some((t) => t.executor_version !== PR_EXECUTOR_VERSION)) return { hold: 'pre_judge_pr' };
  ctx.headSha = String(ctx.pr.head?.sha || '').toLowerCase();
  const foreign = !ctx.headSha || ctx.prTasks.some((t) => String(t.pr_commit_sha || '').toLowerCase() !== ctx.headSha);
  return foreign ? { hold: 'head_not_executor_commit' } : null;
}

// The link must land on production main; a PR retargeted to another base
// would "merge" without ever reaching the site.
function productionBaseGate(ctx) {
  const production = process.env.GITHUB_ASTRO_DEFAULT_BRANCH || 'main';
  if (ctx.pr.base?.ref === production) {
    ctx.baseRef = production;
    return null;
  }
  return {
    reason: 'base_not_production',
    close: { status: 'failed', failureReason: 'internal_link_pr_base_changed', note: `PR base is ${ctx.pr.base?.ref || 'unknown'}, not ${production}; closed without merging.` },
  };
}

// Pin main to one commit: the link-only check reads the base files at it and
// the merge refuses unless main is still there (expectBaseSha) and every
// source file lands byte-identical to the checked head (verifyPaths).
async function linkOnlyDiffGate(ctx) {
  ctx.baseSha = await GitHubClient.getBranchSha(ctx.baseRef);
  if (!ctx.baseSha) return { hold: 'base_sha_unknown' };
  const diff = await this._checkLinkOnlyDiff(ctx.pr, ctx.prTasks, ctx.baseSha);
  if (diff.ok) {
    ctx.files = diff.files;
    return null;
  }
  return {
    reason: diff.reason,
    close: { status: 'patch_candidate', note: `Auto-merge diff check failed (${diff.reason}); PR closed, task returned to the candidate pool.` },
  };
}

// Same preview gate the blog lane merges on (autonomous-pr-poller).
async function previewBuildGate(ctx) {
  const preview = await require('./autonomous-pr-poller').previewGate(ctx.pr);
  if (preview.failed) {
    return {
      reason: 'preview_build_failed',
      close: { status: 'failed', failureReason: 'internal_link_preview_build_failed', note: 'Hub preview build failed on the link PR head; PR closed.' },
    };
  }
  if (preview.abandoned) {
    // Canceled/skipped build of the head: not a content problem, so the
    // links go back to the pool for a fresh PR instead of blocking the lane.
    return {
      reason: preview.reason,
      close: { status: 'patch_candidate', note: `Hub preview build ${preview.reason.replace('preview_build_', '')} on the link PR head; PR closed, links returned to the candidate pool.` },
    };
  }
  return preview.ok ? null : { hold: preview.reason };
}

// Findings close the PR as a reviewer rejection (a link PR has nothing to
// remediate). Runs BEFORE any gate that recycles tasks (link-only diff), so
// a PR Codex rejected is never returned to the candidate pool unrecorded.
async function codexFindingsGate(ctx) {
  ctx.codex = await this._codexVerdict(ctx.prNumber, ctx.headSha, ctx.pr.user?.login);
  if (!ctx.codex.findings) return null;
  return {
    reason: 'codex_findings',
    close: { status: 'skipped', skipReason: 'codex_findings', note: `Codex left ${ctx.codex.findings} finding(s) on ${ctx.headSha.slice(0, 10)}; PR closed without merging.` },
  };
}

// A clean verdict passes at once. Silence passes only after the grace
// window measured from a PROVEN review request for this head: if the
// request comment never landed (it is fire-and-forget at PR open), post it
// again and hold — Codex silence is never inferred from a request that
// wasn't made.
async function codexGraceGate(ctx) {
  if (ctx.codex.clean) return null;
  if (!ctx.codex.requestedAt) {
    await requestCodexReview(ctx.pr, ctx.headSha, ctx.prTasks.map((task) => ({ task })));
    return { hold: 'codex_review_not_requested' };
  }
  const graceMs = envInt('AUTONOMOUS_INTERNAL_LINK_CODEX_GRACE_MIN', 120) * 60 * 1000;
  const waiting = new Date(ctx.now).getTime() - ctx.codex.requestedAt < graceMs;
  return waiting ? { hold: 'codex_review_pending' } : null;
}

// The autonomous publish caps — AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY and
// _PER_WEEK, the same env and zero-inclusive semantics the runner's canary
// guards and the blog lane's auto-merge use: 0 in either window is the ops
// freeze. Link PRs count by distinct PR merged since the ET day / ET week
// start. A count error fails closed (hold).
const PUBLISH_CAP_WINDOWS = [
  { env: 'AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_WEEK', reason: 'weekly_publish_cap_reached', start: (d) => `${etWeekStart(d)}T00:00` },
  { env: 'AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY', reason: 'daily_publish_cap_reached', start: (d) => `${etDateString(d)}T00:00` },
];

async function publishCapGate(ctx) {
  const now = new Date(ctx.now);
  for (const window of PUBLISH_CAP_WINDOWS) {
    const max = Number(process.env[window.env]);
    if (process.env[window.env] == null || process.env[window.env] === '' || !Number.isFinite(max) || max < 0) continue;
    if (max === 0) return { hold: 'publish_frozen' };
    try {
      const row = await db(TABLE).where('merged_at', '>=', parseETDateTime(window.start(now))).whereNotNull('astro_pr_url')
        .countDistinct('astro_pr_url as count').first();
      if (Number(row?.count || 0) >= max) return { hold: window.reason };
    } catch (err) {
      logger.warn(`[internal-link-pr-executor] publish-cap count failed (holding merge): ${err.message}`);
      return { hold: 'publish_cap_unavailable' };
    }
  }
  return null;
}

// Re-prove each link TARGET at merge time: a target deleted, renamed, made
// noindex or re-canonicalized while the PR waited would ship a broken or
// wasted link that the source-only diff check cannot see. Missing → close;
// a GitHub read error → hold.
async function targetStillValidGate(ctx) {
  for (const task of ctx.prTasks) {
    let target;
    try {
      target = await this._loadTargetPage(task);
    } catch (err) {
      const reason = String(err?.message || err);
      if (!MISSING_FILE_RE.test(reason)) return { hold: 'target_check_unavailable' };
      return { reason: 'target_gone', close: { status: 'failed', failureReason: 'internal_link_target_gone', note: `Link target ${task.target_url} no longer exists on main; PR closed without merging.` } };
    }
    const targetUrl = policy.normalizeInternalUrl(task.target_url);
    if (target.indexable !== true || !policy.canonicalMatches(targetUrl, target.canonical_url)) {
      return { reason: 'target_not_linkable', close: { status: 'failed', failureReason: 'internal_link_target_not_linkable', note: `Link target ${task.target_url} is now noindex or canonicalized elsewhere; PR closed without merging.` } };
    }
  }
  return null;
}

// Re-prove source protection at merge time: a page protected AFTER the PR
// opened (while it waited on preview, Codex or a cap) must not be edited
// unattended. A lookup error fails closed (hold).
async function sourceProtectionMergeGate(ctx) {
  for (const task of ctx.prTasks) {
    const url = policy.normalizeInternalUrl(task.source_url || task.source_canonical_url || '');
    if (!url) return { hold: 'source_url_unknown' };
    const prot = await this._sourceProtection({ url }, task);
    if (prot.error) return { hold: 'protection_check_unavailable' };
    if (prot.protected) {
      return {
        reason: 'source_now_protected',
        close: { status: 'skipped', skipReason: `source_protected_page:${prot.reason || 'protected'}`, note: `Source page ${url} is now protected; PR closed without merging.` },
      };
    }
  }
  return null;
}

// The poller's per-tick merge cap: checks still ran (and closed failures).
function mergeCapGate(ctx) {
  return ctx.allowMerge ? null : { hold: 'merge_cap_reached' };
}

const MERGE_GATES = [mergeInFlightGate, prStateGate, provenanceGate, productionBaseGate, codexFindingsGate, linkOnlyDiffGate, previewBuildGate, codexGraceGate, targetStillValidGate, sourceProtectionMergeGate, publishCapGate, mergeCapGate];

class InternalLinkPrExecutor {
  async runDryRun({ limit = DEFAULT_LIMIT, taskIds = null } = {}) {
    const tasks = await this._loadQueuedTasks({ limit, taskIds });
    const results = [];
    for (const task of tasks) {
      let result;
      try {
        result = await this.dryRunTask(task);
      } catch (err) {
        logger.warn(`[internal-link-pr-executor] dry-run failed for ${task.id}: ${err.message}`);
        result = {
          task_id: task.id,
          status: 'failed',
          failure_reason: err.message,
          executor_version: EXECUTOR_VERSION,
        };
      }
      await this._persistDryRunResult(task.id, result);
      results.push(result);
    }
    return { count: results.length, results };
  }

  async dryRunTask(task, { sourcePage = null, targetPage = null } = {}) {
    if (!task?.id && !task?.source_file) throw new Error('internal link task required');
    const source = sourcePage || await this._loadSourcePage(task);
    const target = targetPage || await this._loadTargetPage(task);
    return evaluateDryRunTask(task, { sourcePage: source, targetPage: target });
  }

  // The only PR-opening path (the candidate sweep; review tooling too), so
  // the one-open-link-PR rule lives here, serialized by an advisory lock so
  // two callers can't both see "none open" and open two PRs.
  async runPrBatch(opts = {}) {
    const out = await runExclusive('internal-link-pr-batch', async () => {
      const open = await this._openLinkPr();
      if (open) return { status: 'pr_already_open', count: 0, results: [], pr_url: open.astro_pr_url || null };
      return this._runPrBatchUnlocked(opts);
    }, { recordHealth: false, waitForSlot: false });
    if (out?.skipped) return { status: 'lock_busy', count: 0, results: [] };
    return out;
  }

  async _openLinkPr() {
    return db(TABLE).whereIn('status', ['pr_reserved', 'pr_open']).first('id', 'astro_pr_url');
  }

  async _runPrBatchUnlocked({ limit = envInt('AUTONOMOUS_INTERNAL_LINK_MAX_LINKS_PER_PR', 3), taskIds = null, scanLimit = null } = {}) {
    // scanLimit lets the sweep look past candidates that fail revalidation
    // (each terminal failure is persisted, so they drop out of later sweeps).
    const tasks = await this._loadPatchCandidateTasks({ limit: Math.max(limit, Number(scanLimit) || 0), taskIds });
    const batch = {
      selected: [],
      sourceCounts: new Map(),
      targetCounts: new Map(),
      // v1 writes one commit per source file from its current main SHA. Keep
      // source edits capped at one until multi-link same-file patch combining
      // has its own validation path.
      maxLinksPerSource: Math.min(envInt('AUTONOMOUS_INTERNAL_LINK_MAX_LINKS_PER_SOURCE', 1), 1),
      maxLinksPerTarget: envInt('AUTONOMOUS_INTERNAL_LINK_MAX_LINKS_PER_TARGET_PER_PR', 2),
    };
    for (const task of tasks) {
      const item = await this._evaluateCandidate(task, batch);
      if (!item) continue;
      batch.selected.push(item);
      batch.sourceCounts.set(item.sourceKey, (batch.sourceCounts.get(item.sourceKey) || 0) + 1);
      batch.targetCounts.set(item.targetUrl, (batch.targetCounts.get(item.targetUrl) || 0) + 1);
      if (batch.selected.length >= limit) break;
    }
    if (!batch.selected.length) return { status: 'no_candidates', count: 0, results: [] };
    return this._openPrForSelected(batch.selected);
  }

  // Runs one candidate through CANDIDATE_STAGES in order. A stage returns
  // nothing to continue, { persist } to record a terminal verdict and drop
  // the candidate, or { retry: true } to drop it untouched for a later sweep.
  async _evaluateCandidate(task, batch) {
    const ctx = { task, batch };
    for (const stage of CANDIDATE_STAGES) {
      const stop = await stage.call(this, ctx);
      if (!stop) continue;
      if (stop.persist) await this._persistDryRunResult(task.id, stop.persist);
      return null;
    }
    return {
      task,
      source: ctx.source,
      target: ctx.target,
      validation: ctx.validation,
      targetUrl: ctx.targetUrl,
      sourceKey: ctx.sourceKey,
      // Content edits bump the page's freshness field (sitemap lastmod), the
      // same rule publishRefresh / metadata rewrites follow; a one-line edit
      // so the rest of the frontmatter stays byte-identical.
      patchedContent: bumpFreshnessLine(ctx.patchedContent, etDateString()),
    };
  }

  async _openPrForSelected(selected) {
    const branch = internalLinkBranchName(selected);
    const reserved = await this._reserveTasksForPr(selected, { branch });
    if (!reserved) return { status: 'reservation_conflict', count: 0, results: [] };

    let pr = null;
    let headSha = null;
    try {
      const created = await GitHubClient.createBranch(branch);
      // ONE commit for the whole batch: Cloudflare Pages may build only the
      // first commit of a rapid push burst, which would leave the auto-merge
      // preview gate waiting on a stale build forever. A main edit to a
      // source between our read and this commit is caught by the link-only
      // diff gate (head with the link unwrapped must equal main).
      const commit = await GitHubClient.commitFiles({
        branch,
        message: `chore(seo): add ${selected.length} internal link${selected.length === 1 ? '' : 's'}`,
        // item.source.file is the RESOLVED path (handles a source post that
        // was migrated .md->.mdx after this task was planned).
        files: selected.map((item) => ({ path: item.source.file || item.task.source_file, content: item.patchedContent })),
        expectedHeadSha: created?.object?.sha || null,
      });
      const commits = [commit];

      pr = await GitHubClient.createPr({
        head: branch,
        title: internalLinkPrTitle(selected),
        body: buildInternalLinkPrBody({ branch, selected }),
      });
      // Provenance is the commit THIS executor created, never the PR head
      // read afterwards: a push landing between commitFiles and createPr must
      // not be recorded as ours (provenanceGate then holds the PR).
      headSha = commits.map((commit) => commit?.commit?.sha).filter(Boolean).at(-1) || null;
      await requestCodexReview(pr, headSha, selected);

      await this._markTasksPrOpen(selected, {
        pr,
        branch,
        commitSha: headSha,
      });
    } catch (err) {
      if (pr?.html_url) {
        await this._markTasksPrOpen(selected, {
          pr,
          branch,
          commitSha: headSha,
          reviewerNotes: `Astro internal-link PR opened but follow-up failed: ${err.message}. Confirm Codex review manually before merge.`,
        });
      } else {
        await this._releaseReservedTasks(selected, { branch, err });
      }
      throw err;
    }

    return {
      status: 'pr_open',
      count: selected.length,
      pr_number: pr.number,
      pr_url: pr.html_url,
      branch,
      commit_sha: headSha,
      results: selected.map((item) => ({ ...item.validation, status: 'pr_open', astro_pr_url: pr.html_url })),
    };
  }

  // Daily sweep for patch candidates nothing else ships. The runner opens a
  // PR only for tasks queued by its own run, and post-merge planning
  // (astro-publisher planInternalLinksForTarget) stops at patch_candidate, so
  // before this sweep those rows sat forever (19 in prod on 2026-09-27).
  // One open link PR at a time: PRs merge by hand after Codex, so a second
  // batch would only pile up. runPrBatch revalidates every candidate against
  // current main and the live page before touching it.
  async runCandidateSweep({ limit = envInt('AUTONOMOUS_INTERNAL_LINK_MAX_LINKS_PER_PR', 3) } = {}) {
    if (!envBool('AUTONOMOUS_INTERNAL_LINK_CANDIDATE_SWEEP', true)) return { status: 'disabled' };
    if (!shadowOff()) return { status: 'shadow' };
    // Post-merge link planning that failed (a protected-registry or corpus
    // outage) stamped the publishing run's link_planning_failed_at and has no
    // other retry route — replan those recent publishes first.
    try {
      await this._replanUnplannedPublishes();
    } catch (err) {
      logger.warn(`[internal-link-pr-executor] unplanned-publish replan failed: ${err.message}`);
    }
    // Settle finished PRs first (merged/closed → off pr_open) and recover
    // crash-orphaned reservations (runPostMergeVerification runs that sweep),
    // so a finished or dead PR never blocks runPrBatch's one-open-PR guard.
    try {
      await this.runPostMergeVerification({ limit: envInt('AUTONOMOUS_INTERNAL_LINK_VERIFY_LIMIT', 10) });
    } catch (err) {
      logger.warn(`[internal-link-pr-executor] pre-sweep reconciliation failed: ${err.message}`);
    }
    return this.runPrBatch({ limit, scanLimit: envInt('AUTONOMOUS_INTERNAL_LINK_SWEEP_SCAN_LIMIT', 15) });
  }

  // Recent autonomous blog publishes whose post-merge link planning failed or
  // could not run (the poller stamps link_planning_failed_at). One transient
  // outage must not leave a new post without inbound links for good.
  // No age window: a marked run stays eligible until planning succeeds (an
  // outage or kill switch can outlast any window). Oldest attempt first, and
  // a failed retry re-stamps the marker, so a persistently failing run
  // rotates to the back instead of starving the rest of the batch.
  async _replanUnplannedPublishes({ limit = 5 } = {}) {
    const runs = await db('autonomous_runs')
      .where({ action_type: 'new_supporting_blog', outcome: 'completed_published', shadow_mode: false })
      .whereNotNull('link_planning_failed_at')
      .whereNotNull('published_url')
      .orderBy('link_planning_failed_at', 'asc')
      .limit(limit)
      .select('*');
    if (!runs.length) return 0;
    const { resolveTargetForRun } = require('./autonomous-pr-poller')._internals;
    const publisher = require('../content-astro/astro-publisher');
    // Same kill switch finalizeMerged honors; markers wait while it is on.
    if (publisher.internalLinkPlanningDisabled?.()) return 0;
    let replanned = 0;
    for (const run of runs) {
      try {
        // published_url is authoritative: finalizeMerged may have replaced a
        // stale draft canonical with the verified route. The draft target is
        // used for metadata (keyword/city/title) only; off-hub URLs are
        // rejected by the planner's hub-only canonicalization anyway.
        const target = await resolveTargetForRun(run);
        const result = await publisher.planInternalLinksForTarget({
          keyword: target?.keyword || null,
          city: target?.city || null,
          title: target?.title || null,
          url: run.published_url,
        });
        // null = planning could not run (no corpus): the marker stays (moved
        // to the back of the queue), same result guard as finalizeMerged.
        if (!result) {
          await this._restampPlanningMarker(run.id);
          continue;
        }
        await db('autonomous_runs').where({ id: run.id }).whereNotNull('link_planning_failed_at')
          .update({ link_tasks_queued: result.queued || 0, link_planning_failed_at: null, updated_at: new Date() });
        replanned += 1;
      } catch (err) {
        // Marker kept (moved to the back) → retried on a later daily sweep.
        logger.warn(`[internal-link-pr-executor] replan failed for run ${run.id}: ${err.message}`);
        await this._restampPlanningMarker(run.id).catch(() => {});
      }
    }
    return replanned;
  }

  async _restampPlanningMarker(runId) {
    await db('autonomous_runs').where({ id: runId }).whereNotNull('link_planning_failed_at')
      .update({ link_planning_failed_at: new Date(), updated_at: new Date() });
  }

  // Unattended merge for internal-link PRs (owner 2026-09-27: "fully
  // autonomous, run some checks before deploying live"). One PR per call.
  // Every check is re-proven against the PR's CURRENT head:
  //   1. the head is still the commit this executor pushed (no foreign push);
  //   2. the diff touches exactly the task source files, and each head file
  //      with the new link unwrapped is byte-identical to main — a link
  //      insertion and nothing else, and main hasn't moved under it;
  //   3. the hub Cloudflare preview built that head successfully;
  //   4. Codex left no findings on that head. A clean Codex verdict merges
  //      at once; with no verdict (pending, or the bot's usage limit) the PR
  //      merges after AUTONOMOUS_INTERNAL_LINK_CODEX_GRACE_MIN (default 120).
  // Findings close the PR and park its tasks as skipped; a moved main closes
  // it and returns the tasks to patch_candidate for the next sweep.
  // Kill switch: AUTONOMOUS_INTERNAL_LINK_AUTO_MERGE=false.
  // Called from the autonomous PR poller's tick (pollInternalLinkPr), which
  // passes allowMerge=false once its per-tick merge cap is spent: checks
  // still run (and close failures), the merge waits for a later tick.
  async runAutoMerge({ now = new Date(), allowMerge = true } = {}) {
    // Already-published rows (merged_at recorded, PR cleanup unfinished) are
    // settled regardless of the switches below: the merge happened, only its
    // fencing remains, and verifyMergedTask leaves such rows to this path. A
    // kill switch stops NEW merges, never the cleanup of a finished one.
    const settled = await this._settlePublishedRows();
    if (!envBool('AUTONOMOUS_INTERNAL_LINK_AUTO_MERGE', true)) return { status: 'disabled', settled };
    if (!require('../../config/feature-gates').isEnabled('autonomousContentEngine')) return { status: 'disabled', settled };
    if (!shadowOff()) return { status: 'shadow', settled };
    // Published rows (merged_at) belong to _settlePublishedRows above.
    const tasks = (await db(TABLE).where('status', 'pr_open').whereNotNull('astro_pr_url').whereNull('merged_at')
      .orderBy('updated_at', 'asc').select('*')).filter((t) => !t.merged_at);
    if (!tasks.length) return { status: settled ? 'settled' : 'no_open_pr', settled };
    const prUrl = tasks[0].astro_pr_url;
    const prNumber = parsePrNumber(prUrl);
    if (!prNumber) return { status: 'pr_number_unknown', pr_url: prUrl };
    const ctx = {
      prUrl,
      prNumber,
      prTasks: tasks.filter((t) => t.astro_pr_url === prUrl),
      now,
      allowMerge,
      pr: await GitHubClient.getPr(prNumber),
    };
    for (const gate of MERGE_GATES) {
      const outcome = await gate.call(this, ctx);
      if (outcome) return this._applyGateOutcome(ctx, outcome);
    }
    return this._mergeLinkPr(ctx);
  }

  // pr_open rows that already carry merged_at, grouped per PR, through
  // publishedCleanupGate only (close if open, confirm branch retired, mark
  // merged). Never merges anything. Returns how many PRs settled.
  async _settlePublishedRows() {
    const rows = (await db(TABLE).where('status', 'pr_open').whereNotNull('merged_at').whereNotNull('astro_pr_url').select('*'))
      .filter((r) => r.merged_at && r.astro_pr_url);
    let settled = 0;
    for (const prUrl of [...new Set(rows.map((r) => r.astro_pr_url))]) {
      const prNumber = parsePrNumber(prUrl);
      if (!prNumber) continue;
      try {
        const pr = await GitHubClient.getPr(prNumber);
        const outcome = await publishedCleanupGate.call(this, { prNumber, pr, prTasks: rows.filter((r) => r.astro_pr_url === prUrl) });
        if (outcome?.result) settled += 1;
      } catch (err) {
        logger.warn(`[internal-link-pr-executor] published cleanup failed for PR #${prNumber} (retrying next tick): ${err.message}`);
      }
    }
    return settled;
  }

  // A gate outcome is { result } (report as-is), { hold } (wait for a later
  // tick) or { close, reason } (close the PR and move its tasks). A close
  // whose branch retirement is not yet confirmed holds instead.
  async _applyGateOutcome(ctx, outcome) {
    const base = { pr_number: ctx.prNumber };
    if (outcome.result) return { ...outcome.result, ...base };
    if (outcome.hold) return { status: 'hold', reason: outcome.hold, ...base };
    const closed = await this._closeLinkPr(ctx.pr, ctx.prTasks, outcome.close);
    return closed
      ? { status: 'closed', reason: outcome.reason, ...base }
      : { status: 'hold', reason: 'branch_retire_pending', ...base };
  }

  async _mergeLinkPr(ctx) {
    const { pr, prNumber, prTasks, codex } = ctx;
    // Merge intent is recorded BEFORE the external write: if the process dies
    // after main moved but before publication is recorded, mergeInFlightGate
    // proves whether main already contains our commit and settles from there.
    await db(TABLE).whereIn('id', prTasks.map((t) => t.id)).where('status', 'pr_open')
      .update({ failure_reason: MERGE_IN_FLIGHT, updated_at: new Date() });
    let merged;
    try {
      merged = await GitHubClient.mergePr(prNumber, {
        sha: pr.head.sha,
        expectBaseSha: ctx.baseSha,
        expectBaseRef: ctx.baseRef,
        verifyPaths: ctx.files,
        title: pr.title,
        message: `Auto-merged: link-only diff, green hub preview, ${codex.clean ? 'clean Codex review' : 'no Codex findings within the grace window'}.`,
      });
    } catch (err) {
      // The MERGE_IN_FLIGHT marker stays: an error can be ambiguous (the
      // PATCH that moved main may have succeeded with its response lost), so
      // only mergeInFlightGate's ancestry check on the next tick may clear it.
      // Main moved between the check and the merge: re-verify next tick.
      if (err?.code === 'BLOG_BASE_MOVED') return { status: 'hold', reason: 'base_moved', pr_number: prNumber };
      throw err;
    }
    // A commit that reached the branch during the merge window was NOT
    // published (mergePr ships the verified head and reports headAdvanced),
    // but it leaves the PR open with unreviewed content. Close it before the
    // tasks leave pr_open: if the close fails, the throw keeps them pr_open,
    // where provenanceGate holds the foreign head for a human.
    // EVERY merge settles the same way, without trusting mergePr's
    // headAdvanced report (its post-merge read can fail silently):
    // publication is recorded FIRST (merged_at + the published SHA, tasks
    // still pr_open so the one-open-PR guard stays up), then
    // publishedCleanupGate re-reads the PR, closes it if a late commit left
    // it open, and releases the rows only once the branch is confirmed gone
    // — now, or on a later tick if GitHub fails.
    const mergedAt = new Date();
    await db(TABLE).whereIn('id', prTasks.map((t) => t.id)).where('status', 'pr_open')
      .update({ merged_at: mergedAt, pr_commit_sha: merged?.sha || null, updated_at: new Date() });
    const settled = await publishedCleanupGate.call(this, {
      ...ctx,
      pr: await GitHubClient.getPr(prNumber).catch(() => ctx.pr),
      prTasks: prTasks.map((t) => ({ ...t, merged_at: mergedAt, pr_commit_sha: merged?.sha || null })),
    });
    if (settled?.hold) return { status: 'hold', reason: settled.hold, pr_number: prNumber, published: true };
    logger.info(`[internal-link-pr-executor] auto-merged link PR #${prNumber} (${prTasks.length} link(s), codex ${codex.clean ? 'clean' : 'silent'})`);
    return { status: 'merged', pr_number: prNumber, count: prTasks.length, codex: codex.clean ? 'clean' : 'silent' };
  }

  async _checkLinkOnlyDiff(pr, prTasks, baseSha) {
    const files = await GitHubClient.listPrFiles(pr.number);
    const changed = new Set((files || []).map((f) => f.filename));
    const expected = new Set(prTasks.map((t) => t.source_file));
    // Tasks may name a pre-migration path (.md → .mdx); match on the stem.
    const stem = (p) => String(p || '').replace(/\.mdx?$/, '');
    const expectedStems = new Set([...expected].map(stem));
    if (!changed.size || changed.size !== prTasks.length || [...changed].some((f) => !expectedStems.has(stem(f)))) {
      return { ok: false, reason: 'diff_files_unexpected' };
    }
    for (const file of changed) {
      const task = prTasks.find((t) => stem(t.source_file) === stem(file));
      const [head, base] = await Promise.all([
        GitHubClient.getFile(file, pr.head.sha),
        GitHubClient.getFile(file, baseSha),
      ]);
      if (!head?.content || !base?.content) return { ok: false, reason: 'diff_file_unreadable' };
      const targetUrl = policy.normalizeInternalUrl(task.target_url);
      const linkRe = new RegExp(`\\[([^\\]\\n]+)\\]\\(${escapeRegExp(targetUrl)}\\)`, 'g');
      const links = head.content.match(linkRe) || [];
      if (links.length !== 1) return { ok: false, reason: 'diff_link_count' };
      if (restoreFreshnessLine(head.content.replace(linkRe, '$1'), base.content) !== base.content) return { ok: false, reason: 'diff_not_link_only_or_main_moved' };
    }
    return { ok: true, files: [...changed] };
  }

  async _codexVerdict(prNumber, headSha, trustedRequester = null) {
    const publisher = require('../content-astro/astro-publisher');
    const { codexReviewStatus, isCodexAuthor } = publisher._internals;
    const [comments, reviews, inline] = await Promise.all([
      GitHubClient.listIssueComments(prNumber),
      GitHubClient.listPrReviews(prNumber),
      GitHubClient.listPrReviewComments(prNumber),
    ]);
    const onHead = (sha) => String(sha || '').toLowerCase() === headSha;
    const mentionsHead = (body) => (String(body || '').match(/\b[0-9a-f]{7,40}\b/gi) || [])
      .some((run) => headSha.startsWith(run.toLowerCase()));
    const isClean = (body) => /Codex Review/i.test(String(body || '')) && /Didn'?t find any major issues/i.test(String(body || ''));
    const isLimit = (body) => /usage limits/i.test(String(body || ''));
    // A Codex ANSWER on this head that is not the clean verdict is a
    // rejection, whichever artifact carries it: inline comments, a review
    // object (CHANGES_REQUESTED or a findings body), or a findings issue
    // comment naming the reviewed commit. Only true silence (no answer, or a
    // usage-limit reply) may ride the grace window.
    const inlineFindings = (inline || []).filter((c) => isCodexAuthor(c?.user?.login) && (onHead(c.commit_id) || onHead(c.original_commit_id))).length;
    const reviewFindings = (reviews || []).filter((r) => isCodexAuthor(r?.user?.login) && onHead(r.commit_id)
      && !isLimit(r.body) && (String(r.state).toUpperCase() === 'CHANGES_REQUESTED' || !isClean(r.body))
      && !/approved/i.test(String(r.state || ''))).length;
    const commentFindings = (comments || []).filter((c) => isCodexAuthor(c?.user?.login) && mentionsHead(c.body)
      && /Codex Review/i.test(String(c.body || '')) && !isClean(c.body) && !isLimit(c.body)).length;
    const findings = inlineFindings + reviewFindings + commentFindings;
    const clean = !findings && codexReviewStatus({ comments, reviews, headSha }).clean === true;
    // When the review of THIS head was requested (the grace window runs from
    // here): an "@codex review" comment naming the head commit, posted by the
    // automation account that opened the PR — never an arbitrary commenter,
    // who could otherwise start the silence clock without Codex being asked.
    const trusted = String(trustedRequester || '').toLowerCase();
    const requestedAt = (comments || [])
      .filter((c) => trusted && String(c?.user?.login || '').toLowerCase() === trusted
        && /@codex\s+review/i.test(String(c.body || '')) && mentionsHead(c.body))
      .map((c) => Date.parse(c.created_at || c.createdAt || 0))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0] || null;
    return { clean, findings, requestedAt };
  }

  async _closeLinkPr(pr, prTasks, { status, skipReason = null, failureReason = null, note }) {
    // A reviewer rejection is recorded BEFORE any cleanup: if the branch
    // retirement below fails, every later path that settles this PR
    // (prStateGate's closed branch, verification) reads it back from
    // skip_reason, so the rejection stays terminal (never re-queued).
    // The same holds for a recycle (tasks back to patch_candidate): the
    // RECYCLE_PENDING marker survives a failed retirement so both settle
    // paths return the links to the pool instead of failing them.
    const intent = skipReason || (status === 'patch_candidate' ? RECYCLE_PENDING : null);
    if (intent) {
      await db(TABLE).whereIn('id', prTasks.map((t) => t.id)).where('status', 'pr_open').update({ skip_reason: intent, updated_at: new Date() });
    }
    if (String(pr.state).toLowerCase() !== 'closed') {
      try {
        await GitHubClient.createIssueComment(pr.number, note);
      } catch (err) {
        logger.warn(`[internal-link-pr-executor] close note failed for PR #${pr.number}: ${err.message}`);
      }
      await GitHubClient.closePr(pr.number);
      // A human may have merged it between our read and the close: then the
      // links are live — record the publication, never the rejection.
      const after = await GitHubClient.getPr(pr.number).catch(() => null);
      if (after?.merged) {
        const mergedAt = after.merged_at ? new Date(after.merged_at) : new Date();
        await db(TABLE).whereIn('id', prTasks.map((t) => t.id)).where('status', 'pr_open')
          .update({ skip_reason: null, merged_at: mergedAt, updated_at: new Date() });
        for (const task of prTasks) {
          await this._markTaskMerged(task.id, { mergedAt, commitSha: after.merge_commit_sha || null });
        }
        logger.info(`[internal-link-pr-executor] PR #${pr.number} was merged concurrently; recorded as published instead of closing`);
        return true;
      }
    }
    // Clear the tasks' PR lifecycle only once the rejected branch is
    // confirmed gone: while it survives, the PR could be reopened and merged,
    // so the tasks stay pr_open (holding the one-open-PR guard) and the next
    // poll tick retries the retirement (runAutoMerge's closed-PR path).
    let retired = false;
    try {
      retired = await GitHubClient.retireBranch(pr.head?.ref);
    } catch (err) {
      logger.warn(`[internal-link-pr-executor] branch cleanup failed for PR #${pr.number}: ${err.message}`);
    }
    if (!retired) {
      logger.warn(`[internal-link-pr-executor] PR #${pr.number} closed but branch ${pr.head?.ref} not yet retired; tasks stay tracked`);
      return false;
    }
    for (const task of prTasks) {
      await db(TABLE).where({ id: task.id, status: 'pr_open' }).update({
        status,
        skip_reason: skipReason,
        failure_reason: failureReason,
        astro_pr_url: null,
        pr_branch: null,
        pr_commit_sha: null,
        reviewer_notes: [String(task.reviewer_notes || '').trim(), `[${new Date().toISOString()}] system: ${note} (was ${pr.html_url || `#${pr.number}`})`]
          .filter(Boolean).join('\n').slice(-5000),
        updated_at: new Date(),
      });
    }
    logger.info(`[internal-link-pr-executor] closed link PR #${pr.number}: ${note}`);
    return true;
  }

  async _sourceProtection(source, task) {
    const url = policy.normalizeInternalUrl(source.url || task.source_url || source.canonical_url);
    // An unresolvable source URL can't be proven unprotected: fail closed
    // (retry next sweep), same as the merge-time gate.
    if (!url) return { error: true };
    try {
      const prot = await protectedPages.isProtected(url, { db });
      if (prot?.reason === 'protected_check_error' || prot?.source === 'error') return { error: true };
      return { protected: !!prot?.protected, reason: prot?.reason || null };
    } catch (err) {
      logger.warn(`[internal-link-pr-executor] source protection check failed for ${url}: ${err.message}`);
      return { error: true };
    }
  }

  async _judgeLink({ task, source, target, validation, targetUrl }) {
    return judge.judgeLink({
      anchor: task.anchor_text,
      paragraph: validation.link_context_before || task.context_snippet || '',
      sourceTitle: source.title,
      sourceUrl: validation.source_url || task.source_url,
      targetTitle: target.title,
      targetUrl,
      targetSummary: markdownToVisibleText(frontmatter.parse(target.body || '').content || '').slice(0, 800),
    });
  }

  async _validateRenderedSourceAnchor(task, validation) {
    if (!envBool('AUTONOMOUS_INTERNAL_LINK_REQUIRE_RENDERED_SOURCE_TEXT', true)) {
      return { ok: true };
    }
    const liveUrl = liveUrlForTask({
      source_url: validation.source_url || task.source_url,
      source_canonical_url: validation.source_canonical_url || task.source_canonical_url,
    });
    if (!liveUrl) return { ok: false, status: 'skipped', reason: 'source_live_url_missing' };
    let html;
    try {
      html = await fetchLiveHtml(liveUrl);
    } catch (err) {
      return {
        ok: false,
        status: 'failed',
        reason: `source_rendered_fetch_failed:${String(err?.message || err).slice(0, 160)}`,
      };
    }
    const expectedText = validation.link_context_before || task.context_snippet || task.anchor_text;
    if (!htmlContainsVisibleText(html, expectedText)) {
      return { ok: false, status: 'skipped', reason: 'source_rendered_context_missing' };
    }
    return { ok: true };
  }

  async runPostMergeVerification({ limit = envInt('AUTONOMOUS_INTERNAL_LINK_VERIFY_LIMIT', 10), taskIds = null } = {}) {
    // Piggyback the stale-reservation sweep on the daily verify pass (the only
    // recurring entry point). A sweep failure must never block verification.
    try {
      await this._recoverStalePrReservedTasks();
    } catch (err) {
      logger.warn(`[internal-link-pr-executor] stale pr_reserved sweep failed: ${err.message}`);
    }
    const tasks = await this._loadPrOpenTasks({ limit, taskIds });
    const results = [];
    for (const task of tasks) {
      let result;
      try {
        result = await this.verifyMergedTask(task);
      } catch (err) {
        // A thrown error here is TRANSIENT (GitHub API/network from getPr or
        // the live fetch). Leave the task status untouched so the next daily
        // pass retries; only record the error. Marking it failed used to
        // strand the task permanently: status='failed' with astro_pr_url /
        // pr_branch intact is blocked from requeue, dismiss AND verify_now by
        // the review queue's hasPrLifecycle guard.
        logger.warn(`[internal-link-pr-executor] verification error for ${task.id} (transient, will retry next pass): ${err.message}`);
        result = {
          task_id: task.id,
          status: task.status,
          transient: true,
          failure_reason: `internal_link_verify_error:${err.message}`,
        };
        await this._recordTransientVerificationError(task.id, result.failure_reason);
      }
      results.push(result);
    }
    return { count: results.length, results };
  }

  async verifyMergedTask(task, { html = null, pr = null } = {}) {
    if (!task?.id) throw new Error('internal link task id required');
    const prNumber = task.astro_pr_number || parsePrNumber(task.astro_pr_url);
    if (!prNumber && !pr) {
      // TERMINAL: no PR reference at all — re-verifying can never succeed.
      // Fail it AND clear the PR lifecycle fields (like a closed-unmerged PR)
      // so the review queue can requeue/dismiss instead of dead-ending.
      const reason = 'internal_link_verify_missing_pr_number';
      await this._failAbandonedPrTask(task.id, reason);
      return { task_id: task.id, status: 'failed', failure_reason: reason };
    }

    const prInfo = pr || await GitHubClient.getPr(prNumber);
    if (!prInfo) {
      // TERMINAL: GitHub answered and the PR does not exist (getPr resolves
      // null only on a definitive 404; API/network errors throw and are
      // handled as transient by the caller). Clear lifecycle fields so the
      // task stays actionable in the review queue.
      const reason = 'internal_link_verify_pr_not_found';
      await this._failAbandonedPrTask(task.id, reason);
      return { task_id: task.id, status: 'failed', failure_reason: reason, pr_number: prNumber };
    }
    const resolvedPrNumber = prNumber || prInfo.number || null;
    // pr_open + merged_at: an advanced-head merge published the verified
    // head but its PR cleanup is still pending. publishedCleanupGate (the
    // auto-merge tick) owns that row until the PR is closed; leave it pr_open
    // so the one-open-PR guard stays up and the cleanup keeps retrying.
    if (task.status === 'pr_open' && task.merged_at) {
      return { task_id: task.id, status: 'pr_open', skipped: 'advanced_head_cleanup_pending', pr_number: resolvedPrNumber };
    }
    // merged_at on a settled row: runAutoMerge published the verified head
    // itself (an advanced-head PR is closed without GitHub's merged flag).
    if (!prInfo?.merged && !task.merged_at) {
      // A closed-but-unmerged PR (abandoned canary, manual close) is terminal.
      // Leaving the task at pr_open strands it forever: the review queue can't
      // requeue or dismiss a pr_open task (those require a terminal status), and
      // re-verifying just re-confirms "not merged". Move it to failed AND clear
      // the abandoned PR lifecycle fields — otherwise hasPrLifecycle() in the
      // review queue keeps blocking requeue/dismiss even once it's failed,
      // leaving it just as stuck. The periodic verify loop then auto-clears
      // these instead of accumulating pr_open zombies.
      if (String(prInfo.state).toLowerCase() === 'closed') {
        // Retire the branch first: while it exists the PR can be reopened and
        // merged, so the task keeps its PR lifecycle until it is confirmed gone.
        let retired = false;
        try {
          retired = await GitHubClient.retireBranch(prInfo.head?.ref);
        } catch (err) {
          logger.warn(`[internal-link-pr-executor] branch retirement failed for PR #${resolvedPrNumber}: ${err.message}`);
        }
        if (!retired) return { task_id: task.id, status: task.status, transient: true, skipped: 'branch_retire_pending', pr_number: resolvedPrNumber };
        const reason = 'internal_link_pr_closed_unmerged';
        // Both terminal updates are conditioned on the CURRENT row: the
        // auto-merge tick (separately locked) may have recorded a publication
        // or a merge in flight after this task was loaded. Nothing updated →
        // leave it for the next pass.
        const unpublished = (q) => q.whereNull('merged_at')
          .where((inner) => inner.whereNull('failure_reason').orWhereNot('failure_reason', MERGE_IN_FLIGHT));
        if (task.skip_reason === RECYCLE_PENDING) {
          // Closed for a retry (moved main / canceled preview): back to the pool.
          const moved = await db(TABLE).where({ id: task.id }).whereIn('status', ['pr_open', 'pr_reserved']).where(unpublished)
            .update({ status: 'patch_candidate', skip_reason: null, astro_pr_url: null, pr_branch: null, pr_commit_sha: null, updated_at: new Date() });
          if (!Number(moved)) return { task_id: task.id, status: task.status, transient: true, skipped: 'publication_state_changed', pr_number: resolvedPrNumber };
          return { task_id: task.id, status: 'patch_candidate', pr_number: resolvedPrNumber };
        }
        // _failAbandonedPrTask keeps skip_reason, so a recorded reviewer
        // rejection (codex_findings) stays terminal through this path.
        const failed = await this._failAbandonedPrTask(task.id, reason, { onlyIf: unpublished });
        if (!Number(failed)) return { task_id: task.id, status: task.status, transient: true, skipped: 'publication_state_changed', pr_number: resolvedPrNumber };
        return { task_id: task.id, status: 'failed', failure_reason: reason, pr_number: resolvedPrNumber };
      }
      return { task_id: task.id, status: task.status, skipped: 'pr_not_merged', pr_number: resolvedPrNumber };
    }

    // Publication time: GitHub's, else the one runAutoMerge recorded (an
    // advanced-head PR closes without GitHub's merged_at) — never "now",
    // which would move an old publish into today's publish cap.
    const mergedAt = prInfo.merged_at ? new Date(prInfo.merged_at) : (task.merged_at ? new Date(task.merged_at) : new Date());
    await this._markTaskMerged(task.id, {
      mergedAt,
      commitSha: prInfo.merge_commit_sha || task.pr_commit_sha || null,
    });

    const liveUrl = liveUrlForTask(task);
    if (!liveUrl) {
      const reason = 'internal_link_verify_missing_source_url';
      await this._markTaskVerificationFailed(task.id, reason, { status: 'merged' });
      return { task_id: task.id, status: 'merged', failure_reason: reason, pr_number: resolvedPrNumber };
    }

    let renderedHtml;
    try {
      renderedHtml = html == null ? await fetchLiveHtml(liveUrl) : String(html);
    } catch (err) {
      const reason = `internal_link_verify_live_fetch_failed:${String(err?.message || err).slice(0, 200)}`;
      await this._markTaskVerificationFailed(task.id, reason, { status: 'merged' });
      return { task_id: task.id, status: 'merged', failure_reason: reason, pr_number: resolvedPrNumber, live_url: liveUrl };
    }
    const deployedAt = new Date();
    if (!renderedHtml) {
      const reason = 'internal_link_verify_empty_live_html';
      await this._markTaskVerificationFailed(task.id, reason, { status: 'merged' });
      return { task_id: task.id, status: 'merged', failure_reason: reason, pr_number: resolvedPrNumber, live_url: liveUrl };
    }

    if (!htmlContainsCrawlableLink(renderedHtml, task.target_url, task.anchor_text)) {
      const reason = 'internal_link_verify_link_missing';
      await this._markTaskVerificationFailed(task.id, reason, { status: 'deployed', deployedAt });
      return { task_id: task.id, status: 'deployed', failure_reason: reason, pr_number: resolvedPrNumber, live_url: liveUrl };
    }

    const verifiedAt = new Date();
    await this._markTaskVerified(task.id, {
      mergedAt,
      deployedAt,
      verifiedAt,
      commitSha: prInfo.merge_commit_sha || task.pr_commit_sha || null,
      liveUrl,
    });
    return {
      task_id: task.id,
      status: 'verified',
      pr_number: resolvedPrNumber,
      live_url: liveUrl,
      verified_at: verifiedAt.toISOString(),
    };
  }

  async _loadQueuedTasks({ limit, taskIds }) {
    let query = db(TABLE)
      .whereIn('status', ['pending', 'queued'])
      .orderByRaw('COALESCE(target_priority, 0) DESC')
      .orderBy('planned_at', 'asc')
      .limit(limit);
    if (Array.isArray(taskIds) && taskIds.length) query = query.whereIn('id', taskIds);
    return query.select('*');
  }

  async _loadPatchCandidateTasks({ limit, taskIds }) {
    let query = db(TABLE)
      .where('status', 'patch_candidate')
      .orderByRaw('COALESCE(target_priority, 0) DESC')
      .orderBy('updated_at', 'asc')
      .limit(limit);
    if (Array.isArray(taskIds) && taskIds.length) query = query.whereIn('id', taskIds);
    return query.select('*');
  }

  async _loadPrOpenTasks({ limit, taskIds }) {
    let query = db(TABLE)
      .whereIn('status', ['pr_open', 'merged', 'deployed'])
      .orderBy('updated_at', 'asc')
      .limit(limit);
    if (Array.isArray(taskIds) && taskIds.length) query = query.whereIn('id', taskIds);
    return query.select('*');
  }

  async _loadSourcePage(task) {
    const resolved = await resolveContentFileByPath(task.source_file);
    if (!resolved?.file?.content) throw new Error(`source_file_not_found:${task.source_file}`);
    // page.file carries the RESOLVED path (e.g. a migrated .mdx), so the
    // write-back below commits to the real file, not the stale task path.
    return { ...pageFromAstroFile(resolved.path, resolved.file.content), file: resolved.path, sha: resolved.file.sha || null };
  }

  async _loadTargetPage(task) {
    // Prefer the planner-stamped target_file, but keep the URL-derived
    // candidates as fallback — a stamped path can go stale (post renamed or
    // migrated after planning).
    const candidates = task.target_file ? [task.target_file] : [];
    for (const candidate of candidateAstroFilesForUrl(task.target_url)) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
    if (!candidates.length) throw new Error(`target_file_unresolved:${task.target_url}`);
    for (const candidate of candidates) {
      const resolved = await resolveContentFileByPath(candidate);
      if (!resolved?.file?.content) continue;
      return { ...pageFromAstroFile(resolved.path, resolved.file.content, { fallbackUrl: task.target_url }), file: resolved.path, sha: resolved.file.sha || null };
    }
    throw new Error(`target_file_not_found:${candidates[0]}`);
  }

  async _persistDryRunResult(taskId, result) {
    if (!taskId) return;
    const patch = {
      status: result.status,
      source_url: result.source_url || null,
      source_canonical_url: result.source_canonical_url || null,
      target_canonical_url: result.target_canonical_url || null,
      target_file: result.target_file || null,
      source_page_type: result.source_page_type || null,
      target_page_type: result.target_page_type || null,
      topic_cluster: result.topic_cluster || null,
      source_topic: result.source_topic || null,
      target_topic: result.target_topic || null,
      topical_relevance_score: result.topical_relevance_score ?? null,
      anchor_type: result.anchor_type || null,
      anchor_variant: result.anchor_variant || null,
      anchor_confidence: result.anchor_confidence ?? null,
      source_existing_internal_links_count: result.source_existing_internal_links_count ?? null,
      target_existing_inlinks_count: result.target_existing_inlinks_count ?? null,
      target_indexable: result.target_indexable ?? null,
      target_http_status: result.target_http_status ?? null,
      target_canonical_matches: result.target_canonical_matches ?? null,
      source_indexable: result.source_indexable ?? null,
      source_http_status: result.source_http_status ?? null,
      source_canonical_matches: result.source_canonical_matches ?? null,
      link_context_before: result.link_context_before || null,
      link_context_after: result.link_context_after || null,
      paragraph_hash: result.paragraph_hash || null,
      executor_version: result.executor_version || EXECUTOR_VERSION,
      skip_reason: result.skip_reason || null,
      failure_reason: result.failure_reason || null,
      updated_at: new Date(),
    };
    await db(TABLE).where({ id: taskId }).update(patch);
  }

  async _reserveTasksForPr(selected, { branch }) {
    const ids = selected.map((item) => item.task.id).filter(Boolean);
    if (!ids.length) return false;
    const reserve = async (knexLike) => {
      const updated = await knexLike(TABLE)
        .whereIn('id', ids)
        .where('status', 'patch_candidate')
        .update({
          status: 'pr_reserved',
          pr_branch: branch,
          executor_version: PR_EXECUTOR_VERSION,
          updated_at: new Date(),
        });
      if (Number(updated || 0) === ids.length) return true;
      await knexLike(TABLE)
        .whereIn('id', ids)
        .where({
          status: 'pr_reserved',
          pr_branch: branch,
        })
        .update({
          status: 'patch_candidate',
          pr_branch: null,
          updated_at: new Date(),
        });
      return false;
    };
    if (typeof db.transaction === 'function') {
      return db.transaction((trx) => reserve(trx));
    }
    return reserve(db);
  }

  async _markTasksPrOpen(selected, { pr, branch, commitSha, reviewerNotes = null }) {
    // Per task: persist the source URL as revalidated for THIS PR, so the
    // merge-time protection gate checks the page actually edited, not a
    // URL from an earlier dry-run (the slug may have changed since).
    for (const item of selected) {
      if (!item.task.id) continue;
      await db(TABLE)
        .where({ id: item.task.id, status: 'pr_reserved' })
        .update({
          status: 'pr_open',
          astro_pr_url: pr?.html_url || null,
          pr_branch: branch,
          pr_commit_sha: commitSha || null,
          executor_version: PR_EXECUTOR_VERSION,
          source_url: item.validation?.source_url || item.task.source_url || null,
          source_canonical_url: item.validation?.source_canonical_url || item.task.source_canonical_url || null,
          reviewer_notes: reviewerNotes || `Astro internal-link PR opened: ${pr?.html_url || 'unknown'}. Auto-merges only after its link-only, preview, Codex, target and protection gates pass.`,
          updated_at: new Date(),
        });
    }
  }

  // No PR was opened (branch/commit/createPr failed — usually a transient
  // GitHub error): retire any half-created branch and return the tasks to
  // patch_candidate so the next daily sweep retries them. Marking them
  // failed stranded one-off post-publish candidates for good (the sweep
  // selects only patch_candidate). The error is kept for diagnosis.
  //
  // The failure can be ambiguous (createPr succeeded remotely but the
  // response was lost), so first look the PR up by branch: if it exists,
  // restore its lifecycle (stamped recovered → held for a human, never
  // auto-merged). Otherwise keep the reservation until the branch is
  // CONFIRMED retired (the stale-reservation sweep retries later).
  async _releaseReservedTasks(selected, { branch, err }) {
    const ids = selected.map((item) => item.task.id).filter(Boolean);
    if (!ids.length) return;
    let livePr = null;
    let retired = !branch;
    try {
      livePr = branch ? await GitHubClient.findOpenPrByHead(branch) : null;
      if (!livePr && branch) retired = await GitHubClient.retireBranch(branch);
    } catch (cleanupErr) {
      logger.warn(`[internal-link-pr-executor] cleanup after failed PR open failed for ${branch}: ${cleanupErr.message}`);
      return; // reservation kept; the stale-reservation sweep settles it
    }
    if (livePr?.html_url) {
      await db(TABLE).whereIn('id', ids).where('status', 'pr_reserved').update({
        status: 'pr_open',
        astro_pr_url: livePr.html_url,
        pr_commit_sha: livePr.head?.sha || null,
        executor_version: RECOVERED_PR_EXECUTOR_VERSION,
        updated_at: new Date(),
      });
      return;
    }
    if (!retired) return; // reservation kept until the branch is gone
    await db(TABLE)
      .whereIn('id', ids)
      .where('status', 'pr_reserved')
      .update({
        status: 'patch_candidate',
        failure_reason: `internal_link_pr_open_failed:${String(err?.message || err).slice(0, 500)}`,
        // Clear the reservation branch: no PR exists, and a lingering
        // pr_branch trips the review queue's hasPrLifecycle guard.
        pr_branch: null,
        updated_at: new Date(),
      });
  }

  // Crash-orphan recovery. _reserveTasksForPr commits status='pr_reserved'
  // BEFORE branch/PR creation; if the process dies before _markTasksPrOpen /
  // _releaseReservedTasks run, the row is stranded forever — no loader
  // selects pr_reserved and the review queue 409s requeue/dismiss/verify on
  // it. A healthy run flips the status within seconds, so a reservation with
  // no astro_pr_url that has sat untouched for >2h is a crash orphan: reset
  // it to patch_candidate so the next PR batch can pick it up.
  async _recoverStalePrReservedTasks({ staleMs = STALE_PR_RESERVED_MS } = {}) {
    const cutoff = new Date(Date.now() - staleMs);
    const rows = await db(TABLE)
      .where('status', 'pr_reserved')
      .whereNull('astro_pr_url')
      .where('updated_at', '<', cutoff)
      .select('id', 'pr_branch', 'reviewer_notes');
    let freed = 0;
    for (const row of rows) {
      // A crash after createPr but before _markTasksPrOpen leaves a real open
      // PR behind a pr_reserved row with no URL. Restore that PR's lifecycle
      // instead of freeing the task (which would open a duplicate PR).
      const livePr = row.pr_branch ? await GitHubClient.findOpenPrByHead(row.pr_branch) : null;
      if (livePr?.html_url) {
        // The live head cannot be proven to be the executor's own push (the
        // crash lost that record), so the recovered PR is stamped with a
        // non-v2 version: provenanceGate holds it for a human, never merges.
        await db(TABLE).where({ id: row.id, status: 'pr_reserved' }).update({
          status: 'pr_open',
          astro_pr_url: livePr.html_url,
          pr_commit_sha: livePr.head?.sha || null,
          executor_version: RECOVERED_PR_EXECUTOR_VERSION,
          reviewer_notes: [String(row.reviewer_notes || '').trim(), `[${new Date().toISOString()}] system: restored stale reservation to its open PR ${livePr.html_url}.`]
            .filter(Boolean).join('\n').slice(-5000),
          updated_at: new Date(),
        });
        continue;
      }
      // No PR: the branch (if any) must be CONFIRMED gone before the task is
      // freed — a surviving branch could be PR'd or reopened outside tracking.
      if (row.pr_branch) {
        let retired = false;
        try {
          retired = await GitHubClient.retireBranch(row.pr_branch);
        } catch (err) {
          logger.warn(`[internal-link-pr-executor] stale reservation branch retirement failed for ${row.pr_branch}: ${err.message}`);
        }
        if (!retired) continue; // retried on the next sweep
      }
      const note = `[${new Date().toISOString()}] system: recovered stale pr_reserved reservation`
        + `${row.pr_branch ? ` (branch ${row.pr_branch})` : ''} back to patch_candidate.`;
      await db(TABLE)
        .where({ id: row.id, status: 'pr_reserved' })
        .update({
          status: 'patch_candidate',
          pr_branch: null,
          reviewer_notes: [String(row.reviewer_notes || '').trim(), note].filter(Boolean).join('\n').slice(-5000),
          updated_at: new Date(),
        });
      freed += 1;
    }
    if (freed) {
      logger.info(`[internal-link-pr-executor] recovered ${freed} stale pr_reserved task(s) back to patch_candidate`);
    }
    return freed;
  }

  // Record a TRANSIENT verification error (GitHub API/network) without
  // touching status, so the next daily verify pass retries the task.
  async _recordTransientVerificationError(taskId, reason) {
    await db(TABLE)
      .where({ id: taskId })
      .whereIn('status', ['pr_open', 'merged', 'deployed'])
      // Never overwrite a pending-merge marker: it is the only record that a
      // merge may have landed (mergeInFlightGate settles it).
      .where((q) => q.whereNull('failure_reason').orWhereNot('failure_reason', MERGE_IN_FLIGHT))
      .update({
        failure_reason: String(reason || '').slice(0, 500),
        updated_at: new Date(),
      });
  }

  async _markTaskMerged(taskId, { mergedAt, commitSha }) {
    await db(TABLE)
      .where({ id: taskId })
      .whereIn('status', ['pr_open', 'merged', 'deployed'])
      .update({
        status: 'merged',
        merged_at: mergedAt,
        pr_commit_sha: commitSha || null,
        failure_reason: null,
        updated_at: new Date(),
      });
  }

  async _markTaskVerified(taskId, { mergedAt, deployedAt, verifiedAt, commitSha, liveUrl }) {
    await db(TABLE)
      .where({ id: taskId })
      .whereIn('status', ['pr_open', 'merged', 'deployed'])
      .update({
        status: 'verified',
        merged_at: mergedAt,
        deployed_at: deployedAt,
        verified_at: verifiedAt,
        pr_commit_sha: commitSha || null,
        failure_reason: null,
        reviewer_notes: `Verified live rendered internal link on ${liveUrl}.`,
        updated_at: new Date(),
      });
  }

  // Fail a task whose Astro PR is terminally gone (closed unmerged, PR number
  // missing, or PR 404) AND clear its PR lifecycle fields, so the review
  // queue's hasPrLifecycle guard no longer blocks requeue/dismiss.
  // (astro_pr_number is not a column — the PR number is parsed from
  // astro_pr_url — so only astro_pr_url/pr_branch/pr_commit_sha are cleared.)
  // The closed PR URL stays in reviewer_notes (from the pr_open note) for audit.
  async _failAbandonedPrTask(taskId, reason, { onlyIf = null } = {}) {
    let q = db(TABLE)
      .where({ id: taskId })
      .whereIn('status', ['pr_open', 'pr_reserved', 'merged', 'deployed']);
    if (onlyIf) q = q.where(onlyIf);
    return q
      .update({
        status: 'failed',
        failure_reason: reason,
        astro_pr_url: null,
        pr_branch: null,
        pr_commit_sha: null,
        updated_at: new Date(),
      });
  }

  async _markTaskVerificationFailed(taskId, reason, { status = 'failed', deployedAt = null } = {}) {
    const patch = {
      status,
      failure_reason: reason,
      updated_at: new Date(),
    };
    if (deployedAt) patch.deployed_at = deployedAt;
    await db(TABLE)
      .where({ id: taskId })
      .whereIn('status', ['pr_open', 'merged', 'deployed'])
      .update(patch);
  }
}

/**
 * The target facts this gate scores, plus the flattened topical terms used
 * to rank drift relocation — ONE derivation shared by validation and patch
 * application, so both relocate to the same occurrence.
 */
function effectiveTargetTerms(targetPage, targetUrl, task) {
  const targetFacts = pageFacts(targetPage, { url: targetUrl });
  if (!targetFacts.keyword && task.target_keyword) {
    // Legacy targets without a frontmatter keyword: use the keyword the
    // planner persisted on the task so the core denominator carries the
    // topic instead of the descriptive title — mirrors the planner's merge.
    targetFacts.keyword = task.target_keyword;
    targetFacts.topic = task.target_keyword;
  }
  return {
    targetFacts,
    targetTerms: [targetFacts.topic, targetFacts.topic_cluster, targetFacts.keyword].filter(Boolean).join(' '),
  };
}

function evaluateDryRunTask(task, { sourcePage, targetPage, options = {} } = {}) {
  const base = baseResult(task, sourcePage, targetPage);
  if (!sourcePage?.body) return skipped(base, 'source_body_missing');
  if (!targetPage?.body) return skipped(base, 'target_body_missing');
  // Tasks planned before the planner grew its spoke guard can still name a
  // spoke-rendered or spoke-canonical source; re-check at execution time so
  // they skip cleanly.
  if (sourceRendersOffHub(sourcePage.frontmatter || {})) {
    return skipped(base, 'source_renders_on_spoke');
  }
  if (canonicalPointsOffHub(sourcePage.frontmatter || {})) {
    return skipped(base, 'source_canonical_off_hub');
  }

  const targetUrl = policy.normalizeInternalUrl(task.target_url || targetPage.url || targetPage.canonical_url);
  const sourceUrl = policy.normalizeInternalUrl(sourcePage.url || task.source_url || sourcePage.canonical_url);
  if (!targetUrl) return skipped(base, 'target_url_invalid');
  if (!sourceUrl) return skipped(base, 'source_url_invalid');
  if (sourceUrl === targetUrl) return skipped(base, 'self_link');
  if (pageAlreadyLinksTo(sourcePage.body, targetUrl)) return skipped(base, 'source_already_links_target');

  // Target facts FIRST — relocation after a drift must rank occurrences by
  // the same effective terms this gate scores (frontmatter topic + cluster
  // + keyword), not a reconstruction from the brief keyword and filename.
  const { targetFacts, targetTerms } = effectiveTargetTerms(targetPage, targetUrl, task);

  // Prefer the exact occurrence the planner recorded (source_offset) — the
  // planner may have chosen a later occurrence whose paragraph carries the
  // topical support — with a scan fallback for drifted files. When no
  // occurrence survives, report the first occurrence's specific failure so
  // skip reasons stay diagnostic.
  const occurrence = placementForTask(sourcePage.body, task, { targetTerms });
  if (!occurrence) {
    const first = findFirstUnlinkedOccurrence(sourcePage.body, task.anchor_text);
    if (!first) return skipped(base, 'anchor_not_found');
    const firstParagraph = paragraphAround(sourcePage.body, first.index);
    if (paragraphHasLink(firstParagraph)) return skipped(base, 'paragraph_already_has_link');
    const anchorCheck = policy.validateAnchorPolicy(
      String(sourcePage.body).slice(first.index, first.index + first.length),
      { surroundingText: firstParagraph, targetKeyword: task.target_keyword || undefined }
    );
    return skipped(base, anchorCheck.issues.map((issue) => issue.code).join(',') || 'anchor_not_found');
  }
  if (isHeadingOccurrence(sourcePage.body, occurrence.index)) return skipped(base, 'anchor_in_heading');

  const paragraph = occurrence.paragraph;

  // The paragraph around the matched anchor is the link's actual context —
  // without it the relevance score sees only frontmatter facts and misses
  // that the source body demonstrably discusses the target's topic (the
  // anchor phrase was found IN it). Masked first: hidden MDX props/comments
  // must not lift topical overlap for text the reader never sees.
  const sourceFacts = pageFacts(sourcePage, { url: sourceUrl, bodyExcerpt: maskExcludedRegions(paragraph) });
  const opportunity = policy.evaluateLinkOpportunity({
    source: sourceFacts,
    target: targetFacts,
    anchor_text: task.anchor_text,
    context: {
      sourceExistingInternalLinksCount: countInternalLinks(sourcePage.body),
      targetNewLinksInPr: Number(options.targetNewLinksInPr || 0),
      sameAnchorCountForTarget: Number(task.same_anchor_count_for_target || 0),
      existingExactMatchAnchorsForTarget: Number(task.existing_exact_match_anchors_for_target || 0),
      surroundingText: paragraph,
    },
    options: {
      // Finite-guarded (shared with the planner): a nonnumeric env value
      // must not turn the gate into accept-everything via `score < NaN`.
      minTopicalRelevance: Number.isFinite(Number(options.minTopicalRelevance))
        ? Number(options.minTopicalRelevance)
        : envMinTopicalRelevance(),
      maxLinksPerTargetPerPr: Number(options.maxLinksPerTargetPerPr ?? process.env.AUTONOMOUS_INTERNAL_LINK_MAX_LINKS_PER_TARGET_PER_PR ?? 2),
      maxExactMatchAnchorsPerTarget: Number(options.maxExactMatchAnchorsPerTarget ?? process.env.AUTONOMOUS_INTERNAL_LINK_MAX_EXACT_MATCH_ANCHORS_PER_TARGET ?? 1),
      sourceCooldownDays: Number(options.sourceCooldownDays ?? process.env.AUTONOMOUS_INTERNAL_LINK_SOURCE_COOLDOWN_DAYS ?? 30),
      targetCooldownDays: Number(options.targetCooldownDays ?? process.env.AUTONOMOUS_INTERNAL_LINK_TARGET_COOLDOWN_DAYS ?? 7),
    },
  });
  if (!opportunity.ok) {
    return skipped({
      ...base,
      ...seoFieldsFromOpportunity(opportunity),
      link_context_before: paragraph,
      paragraph_hash: policy.paragraphHash(paragraph),
    }, opportunity.issues.map((issue) => issue.code).join(','));
  }

  const patched = planner.applyTaskToBody(sourcePage.body, { ...task, target_url: targetUrl }, { targetTerms });
  if (patched === sourcePage.body) return skipped(base, 'patch_noop');
  const patchedParagraph = paragraphAround(patched, occurrence.index);

  return {
    ...base,
    ...seoFieldsFromOpportunity(opportunity),
    status: 'patch_candidate',
    source_url: sourceUrl,
    source_canonical_url: sourceFacts.canonical_url,
    target_canonical_url: targetFacts.canonical_url,
    target_file: targetPage.file,
    source_page_type: sourceFacts.page_type,
    target_page_type: targetFacts.page_type,
    topic_cluster: targetFacts.topic_cluster || sourceFacts.topic_cluster || null,
    source_topic: sourceFacts.topic,
    target_topic: targetFacts.topic,
    source_existing_internal_links_count: countInternalLinks(sourcePage.body),
    target_existing_inlinks_count: task.target_existing_inlinks_count ?? null,
    source_http_status: sourceFacts.http_status,
    target_http_status: targetFacts.http_status,
    source_indexable: sourceFacts.indexable,
    target_indexable: targetFacts.indexable,
    source_canonical_matches: policy.canonicalMatches(sourceUrl, sourceFacts.canonical_url),
    target_canonical_matches: policy.canonicalMatches(targetUrl, targetFacts.canonical_url),
    link_context_before: paragraph,
    link_context_after: patchedParagraph,
    paragraph_hash: policy.paragraphHash(paragraph),
    executor_version: EXECUTOR_VERSION,
  };
}

function baseResult(task, sourcePage, targetPage) {
  return {
    task_id: task.id || null,
    // Prefer the RESOLVED page path so persisted metadata reflects the actual
    // file (a post migrated to .mdx), not the stale planned task path.
    source_file: sourcePage?.file || task.source_file || null,
    target_file: targetPage?.file || task.target_file || null,
    target_url: task.target_url || targetPage?.url || null,
    anchor_text: task.anchor_text || null,
    executor_version: EXECUTOR_VERSION,
  };
}

function skipped(base, reason) {
  return {
    ...base,
    status: 'skipped',
    skip_reason: reason,
    executor_version: EXECUTOR_VERSION,
  };
}

function seoFieldsFromOpportunity(opportunity) {
  return {
    anchor_type: opportunity.anchor_type,
    anchor_variant: opportunity.anchor_type === 'exact_match' ? 'exact' : opportunity.anchor_type,
    anchor_confidence: opportunity.ok ? 1 : 0,
    topical_relevance_score: opportunity.topical_relevance_score,
  };
}

function pageFromAstroFile(file, body, { fallbackUrl = null } = {}) {
  const parsed = frontmatter.parse(body || '');
  const data = parsed.data || {};
  // Frontmatter `slug` FIRST: the Astro glob loader honors a frontmatter slug
  // as the entry id, so the live hub route IS the slug URL (the path-derived
  // URL 301s to it). The planner derives URLs slug-first too — the executor
  // must match, or legacy posts whose slug differs from their file basename
  // skip with source_canonical_mismatch.
  const url = firstValidInternalUrl(
    slugToInternalUrl(data.slug),
    deriveUrlFromFile(file),
    data.canonical,
    data.canonical_url,
    fallbackUrl
  );
  const canonicalUrl = canonicalUrlFromFrontmatter(data, url);
  return {
    file,
    body,
    frontmatter: data,
    title: data.title || null,
    url,
    canonical_url: canonicalUrl,
    page_type: inferPageType(file, data),
    topic: data.primary_keyword || data.target_keyword || data.title || null,
    topic_cluster: data.category || data.service || data.target_service || inferCluster(file, data),
    http_status: 200,
    indexable: !robotsNoindex(data),
  };
}

function canonicalUrlFromFrontmatter(data = {}, fallbackUrl = null) {
  const hasCanonical = data.canonical != null && String(data.canonical).trim() !== '';
  const hasCanonicalUrl = data.canonical_url != null && String(data.canonical_url).trim() !== '';
  if (hasCanonical || hasCanonicalUrl) {
    return firstValidInternalUrl(data.canonical, data.canonical_url)
      || data.canonical
      || data.canonical_url
      || null;
  }
  return fallbackUrl;
}

function firstValidInternalUrl(...values) {
  for (const value of values) {
    const normalized = policy.normalizeInternalUrl(value);
    if (normalized) return normalized;
  }
  return null;
}

function slugToInternalUrl(slug) {
  const raw = String(slug || '').trim();
  if (!raw) return null;
  return raw.startsWith('/') ? raw : `/${raw}/`;
}

function pageFacts(page, { url, bodyExcerpt = null } = {}) {
  const front = page.frontmatter || {};
  return {
    url: url || page.url,
    canonical_url: page.canonical_url || front.canonical || front.canonical_url || url || page.url,
    http_status: page.http_status ?? 200,
    indexable: page.indexable !== false && !robotsNoindex(front),
    page_type: page.page_type || inferPageType(page.file, front),
    topic: page.topic || front.primary_keyword || front.target_keyword || front.title || page.title || null,
    topic_cluster: page.topic_cluster || front.category || front.service || inferCluster(page.file, front),
    title: page.title || front.title || null,
    keyword: page.keyword || front.primary_keyword || front.target_keyword || null,
    body_excerpt: page.body_excerpt || bodyExcerpt || null,
    last_linked_at: page.last_linked_at || null,
  };
}

function deriveUrlFromFile(file) {
  const normalized = String(file || '').replace(/\\/g, '/');
  const match = normalized.match(/src\/content\/(blog|services|locations)\/(.+?)\.mdx?$/);
  if (!match) return null;
  return `/${match[2]}/`;
}

// Fetch a content file by path, tolerating the .md->.mdx migration for BLOG
// posts (autonomous posts are now .mdx; service/location stay .md). Probes
// .mdx first then .md for blog paths; uses the path as-is otherwise. Returns
// { path, file } (file = github-client getFile result) or null. Used for both
// source and target reads so a post migrated to .mdx after a link task was
// planned still resolves on both sides.
async function resolveContentFileByPath(filePath) {
  if (!filePath) return null;
  const isBlog = String(filePath).startsWith('src/content/blog/');
  const base = String(filePath).replace(/\.mdx?$/, '');
  const candidates = isBlog ? [`${base}.mdx`, `${base}.md`] : [filePath];
  for (const candidate of candidates) {
    const file = await GitHubClient.getFile(candidate);
    if (file?.content) return { path: candidate, file };
  }
  return null;
}

function resolveAstroFileForUrl(url) {
  return candidateAstroFilesForUrl(url)[0] || null;
}

// Candidate content files for a site URL, most-likely first. The slug shape
// alone cannot distinguish a root-slug blog post (frontmatter `slug`
// override) from a location page — both live at /<slug>/ — so the target
// loader probes every candidate for existence instead of trusting the first
// guess. The old single-guess resolution sent root-slug blog targets to
// src/content/locations/ and hard-failed the task.
function candidateAstroFilesForUrl(url) {
  const path = policy.normalizeInternalUrl(url);
  if (!path) return [];
  const slug = path.replace(/^\/+|\/+$/g, '');
  if (!slug) return [];
  if (slug.startsWith('blog/')) return [`src/content/blog/${slug.slice(5)}.md`];
  if (/-fl$/.test(slug) || SERVICE_HUB_SLUGS.has(slug)) {
    return [
      `src/content/services/${slug}.md`,
      `src/content/blog/${slug}.md`,
      `src/content/locations/${slug}.md`,
    ];
  }
  return [
    `src/content/locations/${slug}.md`,
    `src/content/blog/${slug}.md`,
    `src/content/services/${slug}.md`,
  ];
}

const SERVICE_HUB_SLUGS = new Set([
  'pest-control',
  'lawn-care',
  'mosquito-control',
  'termite-control',
  'rodent-control',
  'bed-bug-control',
  'commercial-pest-control',
  'pest-control-services',
  'pest-control-quote',
  'termite-inspection',
  'tree-shrub-care',
  'tree-and-shrub-care',
]);


function isHeadingOccurrence(body, index) {
  const lineStart = String(body || '').lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  return /^[ \t]{0,3}#{1,6}\s/.test(String(body || '').slice(lineStart, index + 1));
}


function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Same reading as autonomous-runner isShadow('add_internal_links'): only an
// explicit false/0/off takes the lane live.
function shadowOff() {
  return /^(false|0|off)$/i.test(String(process.env.SHADOW_MODE_ADD_INTERNAL_LINKS || '').trim());
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function shortId(n = 6) {
  return Math.random().toString(36).slice(2, 2 + n);
}

function internalLinkBranchName(selected) {
  const first = selected[0];
  const slug = String(first?.targetUrl || first?.task?.target_url || 'internal-link')
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/-+/g, '-')
    .slice(0, 60) || 'internal-link';
  return `content/internal-link-${slug}-${shortId()}`;
}

function internalLinkPrTitle(selected) {
  const first = selected[0];
  const target = String(first?.targetUrl || first?.task?.target_url || 'internal link');
  const count = selected.length;
  return `SEO links: ${count} internal link${count === 1 ? '' : 's'} to ${target}`.slice(0, 72);
}

function buildInternalLinkPrBody({ branch, selected }) {
  const hubOrigin = String(process.env.ASTRO_HUB_ORIGIN || 'https://www.wavespestcontrol.com').replace(/\/$/, '');
  const hubSourceUrls = [...new Set(
    selected
      .map((item) => item.validation?.source_url || item.task?.source_url)
      .filter(Boolean)
      .map((u) => `${hubOrigin}${u}`),
  )];

  const rows = selected.map((item, index) => [
    `${index + 1}. \`${item.source?.file || item.task.source_file}\``,
    `   - Target: ${item.targetUrl}`,
    `   - Anchor: \`${item.task.anchor_text}\` (${item.validation.anchor_type || 'unknown'})`,
    `   - Relevance: ${item.validation.topical_relevance_score ?? 'n/a'}`,
    `   - Before: ${inlineCodeBlock(item.validation.link_context_before)}`,
    `   - After: ${inlineCodeBlock(item.validation.link_context_after)}`,
  ].join('\n'));

  return [
    `**Autonomous internal-link PR**`,
    ``,
    `Adds ${selected.length} internal link${selected.length === 1 ? '' : 's'} from validated \`patch_candidate\` tasks.`,
    ``,
    `## Safety Checks`,
    ``,
    `- Source and target were reloaded from the Astro repo before patching.`,
    `- Target URL is canonical/indexable and not self-referential.`,
    `- Patch is limited to Markdown body text; frontmatter is unchanged.`,
    `- Paragraph did not already contain a link.`,
    `- Anchor passed SEO policy, topical relevance, and context guards.`,
    `- Markdown output contains the expected crawlable internal link.`,
    ``,
    `## Proposed Links`,
    ``,
    ...rows,
    ``,
    `## Preview`,
    ``,
    `These edits are to **hub** content. Verify on the **hub** Cloudflare Pages project (or the live hub URL after merge):`,
    ...(hubSourceUrls.length ? hubSourceUrls.map((u) => `- ${u}`) : ['- (source URL unavailable — check the hub project)']),
    ``,
    `> Spoke-project previews (e.g. north-port, venice) return **404** for hub-only pages — that is expected and is **not** a reason to reject this PR. Only the hub preview/render matters here.`,
    ``,
    `## Auto-merge`,
    ``,
    `Each link passed an LLM reader check before this PR opened. The portal merges this PR without a human once, on the current head:`,
    `- the diff is exactly these link insertions (each file with the link unwrapped equals main),`,
    `- the hub Cloudflare preview built this head successfully, and`,
    `- Codex left no findings on this head (a clean verdict merges at once; no verdict merges after the grace window).`,
    `Codex findings, a failed preview build, or a moved main close this PR instead.`,
    ``,
    `Generated by waves-customer-portal internal-link executor.`,
    ``,
    `Branch: \`${branch}\``,
  ].join('\n');
}

function inlineCodeBlock(value) {
  return `\`${String(value || '').replace(/`/g, '\\`').replace(/\s+/g, ' ').trim().slice(0, 500) || '—'}\``;
}

function patchContainsCrawlableMarkdownLink(content, anchorText, targetUrl) {
  const escapedAnchor = escapeRegExp(String(anchorText || '').trim());
  const escapedTarget = escapeRegExp(String(targetUrl || '').trim());
  if (!escapedAnchor || !escapedTarget) return false;
  return new RegExp(`\\[${escapedAnchor}\\]\\(${escapedTarget}\\)`).test(String(content || ''));
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Freshness field per content type: services carry `modified`
// ("YYYY-MM-DDT12:00:00"), blog v2 carries `updated` ("YYYY-MM-DD") — the
// same values astro-publisher writes on a metadata rewrite.
const FRESHNESS_FIELDS = [
  { key: 'modified', value: (day) => `${day}T12:00:00` },
  { key: 'updated', value: (day) => day },
];

function freshnessLineRe(key) {
  return new RegExp(`^(${key}:[ \\t]*)(["']?)([^"'\\r\\n]*)\\2[ \\t]*$`, 'm');
}

function bumpFreshnessLine(body, day) {
  const block = frontmatterBlock(body);
  if (!block) return body;
  for (const { key, value } of FRESHNESS_FIELDS) {
    const re = freshnessLineRe(key);
    if (!re.test(block)) continue;
    const bumped = block.replace(re, (_m, prefix, quote) => `${prefix}${quote}${value(day)}${quote}`);
    return bumped + String(body).slice(block.length);
  }
  // Neither field present (legacy pages): add the page format's own field
  // just before the closing fence — v2 blog frontmatter (`published:`)
  // carries `updated`; v1 blog, services and locations carry `modified`
  // (the astro blog schema maps updated → modified either way).
  const field = /^published:/m.test(block) ? FRESHNESS_FIELDS[1] : FRESHNESS_FIELDS[0];
  const line = field.key === 'modified' ? `modified: "${field.value(day)}"` : `updated: ${field.value(day)}`;
  const closeAt = block.lastIndexOf('---');
  const eol = block.includes('\r\n') ? '\r\n' : '\n';
  return block.slice(0, closeAt) + line + eol + block.slice(closeAt) + String(body).slice(block.length);
}

// Undo a freshness bump on `head` by restoring base's line for that field —
// only when head's new value is a well-formed date for the field. Anything
// else in the frontmatter still has to match byte-for-byte.
function restoreFreshnessLine(head, base) {
  const headBlock = frontmatterBlock(head);
  const baseBlock = frontmatterBlock(base);
  if (!headBlock || !baseBlock) return head;
  const wellFormed = (v) => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/.test(v);
  for (const { key } of FRESHNESS_FIELDS) {
    const re = freshnessLineRe(key);
    const h = re.exec(headBlock);
    const b = re.exec(baseBlock);
    if (!h || (b && h[0] === b[0])) continue;
    if (!wellFormed(h[3])) return head;
    // Bumped in place → restore base's line; inserted (base had none) →
    // drop head's line and its line break.
    const restored = b
      ? headBlock.replace(re, () => b[0])
      : headBlock.replace(new RegExp(`${re.source}\\r?\\n`, 'm'), '');
    return restored + String(head).slice(headBlock.length);
  }
  return head;
}

function frontmatterUnchanged(before, after) {
  return frontmatterBlock(before) === frontmatterBlock(after);
}

function frontmatterBlock(body) {
  const match = /^---\r?\n[\s\S]*?\r?\n---/.exec(String(body || ''));
  return match ? match[0] : '';
}

function parsePrNumber(url) {
  const match = String(url || '').match(/\/pull\/(\d+)(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

function liveUrlForTask(task = {}) {
  const source = policy.normalizeInternalUrl(task.source_url || task.source_canonical_url || task.source_path);
  if (!source) return null;
  const origin = String(process.env.ASTRO_HUB_ORIGIN || 'https://www.wavespestcontrol.com').replace(/\/$/, '');
  return `${origin}${source}`;
}

async function fetchLiveHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'waves-internal-link-verifier/1.0',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`live_http_${res.status}`);
  return res.text();
}

function htmlContainsCrawlableLink(html, targetUrl, anchorText) {
  const target = policy.normalizeInternalUrl(targetUrl);
  const anchor = normalizeHtmlText(anchorText);
  if (!target || !anchor) return false;
  const renderedHtml = stripNonRenderedHtml(html);
  const hiddenRanges = hiddenElementRanges(renderedHtml);
  const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRe.exec(renderedHtml)) !== null) {
    if (isIndexInRanges(match.index, hiddenRanges) || hasHiddenHtmlAttribute(match[1])) continue;
    const href = extractHref(match[1]);
    if (policy.normalizeInternalUrl(href) !== target) continue;
    if (normalizeHtmlText(stripTags(match[2])) === anchor) return true;
  }
  return false;
}

function htmlContainsVisibleText(html, expectedText) {
  const expected = normalizeHtmlText(markdownToVisibleText(expectedText));
  if (!expected) return false;
  const renderedHtml = stripNonRenderedHtml(html);
  const visibleHtml = removeRanges(renderedHtml, hiddenElementRanges(renderedHtml));
  const visibleText = normalizeHtmlText(stripTags(visibleHtml));
  return visibleText.includes(expected);
}

function markdownToVisibleText(value) {
  return String(value || '')
    .replace(/!\[([^\]\n]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/(\*\*|__)([\s\S]*?)\1/g, '$2')
    .replace(/(^|[\s([{])([*_])([^*_\n]+)\2(?=[$\s\]).,;:!?}])/g, '$1$3')
    .replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, '$1');
}

function removeRanges(value, ranges = []) {
  const source = String(value || '');
  if (!ranges.length) return source;
  let out = '';
  let cursor = 0;
  for (const [start, end] of ranges.slice().sort((a, b) => a[0] - b[0])) {
    if (start > cursor) out += source.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  return out + source.slice(cursor);
}

function stripNonRenderedHtml(value) {
  return String(value || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
}

const VOID_HTML_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function hiddenElementRanges(html) {
  const ranges = [];
  const stack = [];
  for (const token of scanHtmlTags(html)) {
    const closing = token.closing;
    const tag = token.tag;
    const attrs = token.attrs || '';
    if (!tag) continue;
    if (closing) {
      const index = stack.map((item) => item.tag).lastIndexOf(tag);
      if (index !== -1) {
        const hiddenItems = stack.splice(index).filter((item) => item.hidden);
        for (const item of hiddenItems) ranges.push([item.start, token.end]);
      }
      continue;
    }

    const hidden = hasHiddenHtmlAttribute(attrs);
    const selfClosing = /\/\s*$/.test(attrs) || VOID_HTML_TAGS.has(tag);
    if (hidden && selfClosing) ranges.push([token.start, token.end]);
    if (!selfClosing) stack.push({ tag, hidden, start: token.start });
  }
  for (const item of stack.filter((entry) => entry.hidden)) {
    ranges.push([item.start, String(html || '').length]);
  }
  return ranges;
}

function scanHtmlTags(html) {
  const text = String(html || '');
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf('<', index);
    if (start === -1) break;
    const next = text[start + 1] || '';
    if (!/[A-Za-z/]/.test(next)) {
      index = start + 1;
      continue;
    }

    let quote = null;
    let end = -1;
    for (let i = start + 1; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '>') {
        end = i + 1;
        break;
      }
    }
    if (end === -1) break;

    const inside = text.slice(start + 1, end - 1).trim();
    const match = inside.match(/^(\/)?\s*([a-zA-Z][\w:-]*)([\s\S]*)$/);
    if (match) {
      tokens.push({
        start,
        end,
        closing: Boolean(match[1]),
        tag: String(match[2] || '').toLowerCase(),
        attrs: match[3] || '',
      });
    }
    index = end;
  }
  return tokens;
}

function hasHiddenHtmlAttribute(attrs) {
  const value = String(attrs || '');
  if (/(^|\s)hidden(?:\s|=|$)/i.test(value)) return true;
  if (/(^|\s)inert(?:\s|=|$)/i.test(value)) return true;
  if (/\baria-hidden\s*=\s*["']?true["']?/i.test(value)) return true;
  const classMatch = value.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const classes = String((classMatch && (classMatch[1] || classMatch[2] || classMatch[3])) || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (classes.some((name) => ['hidden', 'invisible', 'collapse', 'sr-only'].includes(name))) return true;
  const styleMatch = value.match(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const style = String((styleMatch && (styleMatch[1] || styleMatch[2] || styleMatch[3])) || '').toLowerCase();
  if (/(^|;)\s*display\s*:\s*none\b/.test(style)) return true;
  if (/(^|;)\s*visibility\s*:\s*hidden\b/.test(style)) return true;
  if (/(^|;)\s*content-visibility\s*:\s*hidden\b/.test(style)) return true;
  return false;
}

function isIndexInRanges(index, ranges = []) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function extractHref(attrs) {
  const match = String(attrs || '').match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  return match ? (match[1] || match[2] || match[3] || '') : '';
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ');
}

function normalizeHtmlText(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function requestCodexReview(pr, headSha, selected) {
  if (!pr?.number || typeof GitHubClient.createIssueComment !== 'function') return;
  const body = [
    '@codex review',
    '',
    `Please review this autonomous internal-link PR on head \`${headSha || 'unknown'}\`.`,
    '',
    'Focus on whether the diff only adds reader-useful crawlable internal links, preserves frontmatter/body outside the intended anchors, and avoids awkward or over-optimized anchor text.',
    '',
    `Tasks: ${selected.map((item) => item.task.id).filter(Boolean).join(', ') || 'n/a'}`,
  ].join('\n');
  try {
    await GitHubClient.createIssueComment(pr.number, body);
  } catch (err) {
    logger.warn(`[internal-link-pr-executor] failed to request Codex review for PR #${pr.number}: ${err.message}`);
  }
}

module.exports = new InternalLinkPrExecutor();
module.exports.InternalLinkPrExecutor = InternalLinkPrExecutor;
module.exports.REVIEWER_REJECTION_PREFIXES = REVIEWER_REJECTION_PREFIXES;
// Planners without a claim to release (weekly GSC, post-merge planning) put
// dry-run rows that failed only on a transient load error back in the pool:
// the sweep's runPrBatch fully revalidates every candidate anyway.
module.exports.requeueTransientDryRunFailures = async (results = []) => {
  const ids = (results || [])
    .filter((r) => r.status === 'failed' && r.task_id && module.exports.isTransientLoadFailure(r.failure_reason))
    .map((r) => r.task_id);
  if (!ids.length) return 0;
  await db(TABLE).whereIn('id', ids).where('status', 'failed').update({ status: 'patch_candidate', updated_at: new Date() });
  return ids.length;
};
// A load failure that is not a confirmed-missing file (rate limit, network,
// 5xx) — callers retry instead of treating it as a verdict.
module.exports.isTransientLoadFailure = (reason) => !!reason && !MISSING_FILE_RE.test(String(reason))
  && /^(?!internal_link_|rendered_link_|frontmatter_)/.test(String(reason));
module.exports._internals = {
  bumpFreshnessLine,
  restoreFreshnessLine,
  EXECUTOR_VERSION,
  PR_EXECUTOR_VERSION,
  evaluateDryRunTask,
  pageFromAstroFile,
  pageFacts,
  firstValidInternalUrl,
  canonicalUrlFromFrontmatter,
  slugToInternalUrl,
  resolveAstroFileForUrl,
  candidateAstroFilesForUrl,
  inferPageType,
  inferCluster,
  robotsNoindex,
  isHeadingOccurrence,
  paragraphAround,
  paragraphHasLink,
  countInternalLinks,
  buildInternalLinkPrBody,
  patchContainsCrawlableMarkdownLink,
  frontmatterUnchanged,
  parsePrNumber,
  liveUrlForTask,
  htmlContainsCrawlableLink,
  htmlContainsVisibleText,
  stripNonRenderedHtml,
  hiddenElementRanges,
  hasHiddenHtmlAttribute,
  scanHtmlTags,
};
