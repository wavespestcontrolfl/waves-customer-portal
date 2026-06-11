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

const TABLE = 'content_internal_link_tasks';
const EXECUTOR_VERSION = 'internal-link-dry-run-v1';
const PR_EXECUTOR_VERSION = 'internal-link-pr-executor-v1';
const DEFAULT_LIMIT = 10;
// A pr_reserved row normally flips to pr_open/failed within seconds; one
// untouched for 2h with no PR URL is a crash orphan (see
// _recoverStalePrReservedTasks).
const STALE_PR_RESERVED_MS = 2 * 60 * 60 * 1000;

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

  async runPrBatch({ limit = envInt('AUTONOMOUS_INTERNAL_LINK_MAX_LINKS_PER_PR', 3), taskIds = null } = {}) {
    const tasks = await this._loadPatchCandidateTasks({ limit, taskIds });
    const selected = [];
    const sourceCounts = new Map();
    const targetCounts = new Map();
    // v1 writes one commit per source file from its current main SHA. Keep
    // source edits capped at one until multi-link same-file patch combining
    // has its own validation path.
    const maxLinksPerSource = Math.min(envInt('AUTONOMOUS_INTERNAL_LINK_MAX_LINKS_PER_SOURCE', 1), 1);
    const maxLinksPerTarget = envInt('AUTONOMOUS_INTERNAL_LINK_MAX_LINKS_PER_TARGET_PER_PR', 2);

    for (const task of tasks) {
      const source = await this._loadSourcePage(task);
      const target = await this._loadTargetPage(task);
      const validation = evaluateDryRunTask(task, {
        sourcePage: source,
        targetPage: target,
        options: {
          targetNewLinksInPr: targetCounts.get(policy.normalizeInternalUrl(task.target_url)) || 0,
        },
      });
      if (validation.status !== 'patch_candidate') {
        await this._persistDryRunResult(task.id, validation);
        continue;
      }

      // Key the per-source cap by the RESOLVED path (source.file) so two tasks
      // for the same post under different extensions (.md + migrated .mdx) count
      // as one source — otherwise both would write the same file in one PR with
      // the same base SHA and the second Contents update would conflict.
      const sourceKey = source.file || task.source_file;
      const sourceCount = sourceCounts.get(sourceKey) || 0;
      if (sourceCount >= maxLinksPerSource) continue;
      const targetUrl = policy.normalizeInternalUrl(task.target_url || validation.target_canonical_url);
      const targetCount = targetCounts.get(targetUrl) || 0;
      if (targetCount >= maxLinksPerTarget) continue;

      const renderedSource = await this._validateRenderedSourceAnchor(task, validation);
      if (!renderedSource.ok) {
        await this._persistDryRunResult(task.id, {
          ...validation,
          status: renderedSource.status || 'skipped',
          skip_reason: renderedSource.status === 'failed' ? null : renderedSource.reason,
          failure_reason: renderedSource.status === 'failed' ? renderedSource.reason : null,
        });
        continue;
      }

      const patchedContent = planner.applyTaskToBody(source.body, { ...task, target_url: targetUrl });
      if (patchedContent === source.body) {
        await this._persistDryRunResult(task.id, { ...validation, status: 'skipped', skip_reason: 'patch_noop' });
        continue;
      }
      if (!patchContainsCrawlableMarkdownLink(patchedContent, task.anchor_text, targetUrl)) {
        await this._persistDryRunResult(task.id, { ...validation, status: 'failed', failure_reason: 'rendered_link_validation_failed' });
        continue;
      }
      if (!frontmatterUnchanged(source.body, patchedContent)) {
        await this._persistDryRunResult(task.id, { ...validation, status: 'failed', failure_reason: 'frontmatter_changed' });
        continue;
      }

      selected.push({ task, source, target, validation, patchedContent, targetUrl });
      sourceCounts.set(sourceKey, sourceCount + 1);
      targetCounts.set(targetUrl, targetCount + 1);
      if (selected.length >= limit) break;
    }

    if (!selected.length) return { status: 'no_candidates', count: 0, results: [] };

    const branch = internalLinkBranchName(selected);
    const reserved = await this._reserveTasksForPr(selected, { branch });
    if (!reserved) return { status: 'reservation_conflict', count: 0, results: [] };

    let pr = null;
    let headSha = null;
    try {
      await GitHubClient.createBranch(branch);
      const commits = [];
      for (const item of selected) {
        const commit = await GitHubClient.putFile({
          // item.source.file is the RESOLVED path (handles a source post that
          // was migrated .md->.mdx after this task was planned); fall back to
          // the task path for safety.
          path: item.source.file || item.task.source_file,
          content: item.patchedContent,
          message: `chore(seo): add internal link to ${item.targetUrl}`,
          branch,
          sha: item.source.sha,
        });
        commits.push(commit);
      }

      pr = await GitHubClient.createPr({
        head: branch,
        title: internalLinkPrTitle(selected),
        body: buildInternalLinkPrBody({ branch, selected }),
      });
      headSha = pr?.head?.sha || commits.map((commit) => commit?.commit?.sha).filter(Boolean).at(-1) || null;
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
        await this._markReservedTasksFailed(selected, err);
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
    if (!prInfo?.merged) {
      // A closed-but-unmerged PR (abandoned canary, manual close) is terminal.
      // Leaving the task at pr_open strands it forever: the review queue can't
      // requeue or dismiss a pr_open task (those require a terminal status), and
      // re-verifying just re-confirms "not merged". Move it to failed AND clear
      // the abandoned PR lifecycle fields — otherwise hasPrLifecycle() in the
      // review queue keeps blocking requeue/dismiss even once it's failed,
      // leaving it just as stuck. The periodic verify loop then auto-clears
      // these instead of accumulating pr_open zombies.
      if (String(prInfo.state).toLowerCase() === 'closed') {
        const reason = 'internal_link_pr_closed_unmerged';
        await this._failAbandonedPrTask(task.id, reason);
        return { task_id: task.id, status: 'failed', failure_reason: reason, pr_number: resolvedPrNumber };
      }
      return { task_id: task.id, status: task.status, skipped: 'pr_not_merged', pr_number: resolvedPrNumber };
    }

    const mergedAt = prInfo.merged_at ? new Date(prInfo.merged_at) : new Date();
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
    const ids = selected.map((item) => item.task.id).filter(Boolean);
    if (!ids.length) return;
    await db(TABLE)
      .whereIn('id', ids)
      .where('status', 'pr_reserved')
      .update({
        status: 'pr_open',
        astro_pr_url: pr?.html_url || null,
        pr_branch: branch,
        pr_commit_sha: commitSha || null,
        executor_version: PR_EXECUTOR_VERSION,
        reviewer_notes: reviewerNotes || `Astro internal-link PR opened: ${pr?.html_url || 'unknown'}. Merge only after Codex and editorial review.`,
        updated_at: new Date(),
      });
  }

  async _markReservedTasksFailed(selected, err) {
    const ids = selected.map((item) => item.task.id).filter(Boolean);
    if (!ids.length) return;
    await db(TABLE)
      .whereIn('id', ids)
      .where('status', 'pr_reserved')
      .update({
        status: 'failed',
        failure_reason: `internal_link_pr_open_failed:${String(err?.message || err).slice(0, 500)}`,
        // Clear the reservation branch: no PR exists, and a lingering
        // pr_branch trips the review queue's hasPrLifecycle guard, blocking
        // requeue/dismiss on an otherwise retryable failure.
        pr_branch: null,
        updated_at: new Date(),
      });
  }

  // Crash-orphan recovery. _reserveTasksForPr commits status='pr_reserved'
  // BEFORE branch/PR creation; if the process dies before _markTasksPrOpen /
  // _markReservedTasksFailed run, the row is stranded forever — no loader
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
    for (const row of rows) {
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
    }
    if (rows.length) {
      logger.info(`[internal-link-pr-executor] recovered ${rows.length} stale pr_reserved task(s) back to patch_candidate`);
    }
    return rows.length;
  }

  // Record a TRANSIENT verification error (GitHub API/network) without
  // touching status, so the next daily verify pass retries the task.
  async _recordTransientVerificationError(taskId, reason) {
    await db(TABLE)
      .where({ id: taskId })
      .whereIn('status', ['pr_open', 'merged', 'deployed'])
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
  async _failAbandonedPrTask(taskId, reason) {
    await db(TABLE)
      .where({ id: taskId })
      .whereIn('status', ['pr_open', 'pr_reserved', 'merged', 'deployed'])
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

function evaluateDryRunTask(task, { sourcePage, targetPage, options = {} } = {}) {
  const base = baseResult(task, sourcePage, targetPage);
  if (!sourcePage?.body) return skipped(base, 'source_body_missing');
  if (!targetPage?.body) return skipped(base, 'target_body_missing');
  // Tasks planned before the planner grew its spoke guard can still name a
  // spoke-rendered or spoke-canonical source; re-check at execution time so
  // they skip cleanly.
  if (planner._internals.sourceRendersOffHub(sourcePage.frontmatter || {})) {
    return skipped(base, 'source_renders_on_spoke');
  }
  if (planner._internals.canonicalPointsOffHub(sourcePage.frontmatter || {})) {
    return skipped(base, 'source_canonical_off_hub');
  }

  const targetUrl = policy.normalizeInternalUrl(task.target_url || targetPage.url || targetPage.canonical_url);
  const sourceUrl = policy.normalizeInternalUrl(sourcePage.url || task.source_url || sourcePage.canonical_url);
  if (!targetUrl) return skipped(base, 'target_url_invalid');
  if (!sourceUrl) return skipped(base, 'source_url_invalid');
  if (sourceUrl === targetUrl) return skipped(base, 'self_link');
  if (planner._internals.pageAlreadyLinksTo(sourcePage.body, targetUrl)) return skipped(base, 'source_already_links_target');

  const occurrence = planner._internals.findFirstUnlinkedOccurrence(sourcePage.body, task.anchor_text);
  if (!occurrence) return skipped(base, 'anchor_not_found');
  if (isHeadingOccurrence(sourcePage.body, occurrence.index)) return skipped(base, 'anchor_in_heading');

  const paragraph = paragraphAround(sourcePage.body, occurrence.index);
  if (paragraphHasLink(paragraph)) return skipped(base, 'paragraph_already_has_link');

  const sourceFacts = pageFacts(sourcePage, { url: sourceUrl });
  const targetFacts = pageFacts(targetPage, { url: targetUrl });
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
      minTopicalRelevance: Number(options.minTopicalRelevance ?? process.env.AUTONOMOUS_INTERNAL_LINK_MIN_TOPICAL_RELEVANCE ?? 0.75),
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

  const patched = planner.applyTaskToBody(sourcePage.body, { ...task, target_url: targetUrl });
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

function pageFacts(page, { url }) {
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

function inferPageType(file, frontmatter = {}) {
  if (frontmatter.page_type || frontmatter.content_type) return String(frontmatter.page_type || frontmatter.content_type);
  const normalized = String(file || '').replace(/\\/g, '/');
  if (normalized.includes('/blog/')) return 'supporting-blog';
  if (normalized.includes('/services/')) return /-fl\.mdx?$/.test(normalized) ? 'city-service' : 'service';
  if (normalized.includes('/locations/')) return 'location';
  return 'unknown';
}

function inferCluster(file, frontmatter = {}) {
  const text = [
    frontmatter.category,
    frontmatter.service,
    frontmatter.primary_keyword,
    frontmatter.title,
    file,
  ].filter(Boolean).join(' ').toLowerCase();
  for (const cluster of ['termite', 'mosquito', 'rodent', 'lawn', 'tree', 'shrub', 'pest']) {
    if (text.includes(cluster)) return cluster === 'tree' || cluster === 'shrub' ? 'tree-shrub' : cluster;
  }
  return null;
}

function robotsNoindex(frontmatter = {}) {
  return String(frontmatter.robots || frontmatter.indexing || '').toLowerCase().includes('noindex')
    || frontmatter.noindex === true;
}

function isHeadingOccurrence(body, index) {
  const lineStart = String(body || '').lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  return /^[ \t]{0,3}#{1,6}\s/.test(String(body || '').slice(lineStart, index + 1));
}

function paragraphAround(body, index) {
  const text = String(body || '');
  let start = text.lastIndexOf('\n\n', Math.max(0, index - 1));
  start = start === -1 ? 0 : start + 2;
  let end = text.indexOf('\n\n', index);
  end = end === -1 ? text.length : end;
  return text.slice(start, end).trim();
}

function paragraphHasLink(paragraph) {
  return /\[[^\]\n]+\]\(\s*[^)]+\)/.test(paragraph) || /<a\b[^>]*\bhref\s*=/i.test(paragraph);
}

function countInternalLinks(body) {
  const text = String(body || '');
  let count = 0;
  // (?<!!) excludes markdown image embeds — ![alt](/x.webp) is not a link.
  const mdLink = /(?<!!)\[[^\]\n]+\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
  let match;
  while ((match = mdLink.exec(text)) !== null) {
    if (policy.normalizeInternalUrl(String(match[1] || '').replace(/^<|>$/g, ''))) count++;
  }
  const href = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((match = href.exec(text)) !== null) {
    if (policy.normalizeInternalUrl(match[1])) count++;
  }
  return count;
}

function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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
    `Adds ${selected.length} review-only internal link${selected.length === 1 ? '' : 's'} from validated \`patch_candidate\` tasks.`,
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
    `## Review`,
    ``,
    `- [ ] Codex review completed`,
    `- [ ] Human editorial review confirms each link is useful to readers`,
    `- [ ] Preview page renders the expected crawlable link (on the **hub** project — ignore spoke 404s)`,
    `- [ ] Diff contains only intended internal-link insertions`,
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
module.exports._internals = {
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
