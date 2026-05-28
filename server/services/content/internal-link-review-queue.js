/**
 * internal-link-review-queue.js — read/action model for autonomous
 * internal-link task review.
 */

const db = require('../../models/db');
const internalLinkExecutor = require('./internal-link-pr-executor');

const TABLE = 'content_internal_link_tasks';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const ALLOWED_STATUSES = new Set([
  'all',
  'pending',
  'queued',
  'patch_candidate',
  'pr_reserved',
  'pr_open',
  'merged',
  'deployed',
  'verified',
  'applied',
  'skipped',
  'failed',
  'dismissed',
]);
const RETRYABLE_STATUSES = new Set(['pending', 'queued', 'patch_candidate', 'skipped', 'failed', 'dismissed']);
const DISMISSABLE_STATUSES = new Set(['pending', 'queued', 'patch_candidate', 'skipped', 'failed']);
const VERIFYABLE_STATUSES = new Set(['pr_open', 'merged', 'deployed']);
const ALLOWED_DECISIONS = new Set(['requeue', 'dismiss', 'verify_now']);

async function listTasks({ status = 'all', limit = DEFAULT_LIMIT } = {}) {
  const normalizedStatus = normalizeStatus(status);
  const boundedLimit = normalizeLimit(limit);
  const [counts, rows] = await Promise.all([
    countsByStatus(),
    taskQuery({ status: normalizedStatus }).limit(boundedLimit),
  ]);

  return {
    status: normalizedStatus,
    limit: boundedLimit,
    counts,
    items: rows.map(buildTaskItem),
  };
}

async function getTask(taskId) {
  const row = await db(TABLE).where({ id: taskId }).first();
  return row ? buildTaskItem(row) : null;
}

async function decideTask(taskId, { decision, note, reviewer } = {}) {
  const normalizedDecision = normalizeDecision(decision);
  const reviewerName = normalizeReviewer(reviewer);
  const cleanNote = normalizeNote(note);
  const task = await db(TABLE).where({ id: taskId }).first();
  if (!task) return null;

  if (normalizedDecision === 'verify_now') {
    if (!VERIFYABLE_STATUSES.has(task.status)) {
      const err = new Error(`Task is ${task.status}, expected pr_open, merged, or deployed`);
      err.statusCode = 409;
      err.isOperational = true;
      throw err;
    }
    await internalLinkExecutor.runPostMergeVerification({ taskIds: [taskId], limit: 1 });
    return getTask(taskId);
  }

  if (normalizedDecision === 'requeue') {
    if (!canRequeue(task)) {
      const err = new Error(`Task is ${task.status} and cannot be requeued`);
      err.statusCode = 409;
      err.isOperational = true;
      throw err;
    }
    await db(TABLE).where({ id: taskId }).whereIn('status', Array.from(RETRYABLE_STATUSES)).where((builder) => {
      builder.whereNull('astro_pr_url').whereNull('pr_branch').whereNull('merged_at');
    }).update({
      status: 'queued',
      skip_reason: null,
      failure_reason: null,
      dismissed_reason: null,
      reviewer_notes: appendReviewerNote(task.reviewer_notes, {
        decision: normalizedDecision,
        reviewer: reviewerName,
        note: cleanNote,
      }),
      updated_at: new Date(),
    });
    return getTask(taskId);
  }

  if (normalizedDecision === 'dismiss') {
    if (!canDismiss(task)) {
      const err = new Error(`Task is ${task.status} and cannot be dismissed`);
      err.statusCode = 409;
      err.isOperational = true;
      throw err;
    }
    await db(TABLE).where({ id: taskId }).whereIn('status', Array.from(DISMISSABLE_STATUSES)).where((builder) => {
      builder.whereNull('astro_pr_url').whereNull('pr_branch').whereNull('merged_at');
    }).update({
      status: 'dismissed',
      dismissed_reason: cleanNote || 'manual_dismiss',
      reviewer_notes: appendReviewerNote(task.reviewer_notes, {
        decision: normalizedDecision,
        reviewer: reviewerName,
        note: cleanNote,
      }),
      updated_at: new Date(),
    });
    return getTask(taskId);
  }

  return getTask(taskId);
}

function taskQuery({ status }) {
  let query = db(TABLE)
    .orderByRaw(`
      CASE status
        WHEN 'patch_candidate' THEN 1
        WHEN 'pr_open' THEN 2
        WHEN 'merged' THEN 3
        WHEN 'deployed' THEN 4
        WHEN 'failed' THEN 5
        WHEN 'skipped' THEN 6
        WHEN 'queued' THEN 7
        WHEN 'pending' THEN 8
        WHEN 'verified' THEN 9
        ELSE 10
      END
    `)
    .orderBy('updated_at', 'desc')
    .select('*');
  if (status && status !== 'all') query = query.where('status', status);
  return query;
}

async function countsByStatus() {
  const rows = await db(TABLE).select('status').count('* as count').groupBy('status');
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count || 0)]));
}

function buildTaskItem(row = {}) {
  return {
    id: row.id,
    status: row.status,
    source_file: row.source_file,
    source_url: row.source_url,
    source_canonical_url: row.source_canonical_url,
    target_url: row.target_url,
    target_canonical_url: row.target_canonical_url,
    target_file: row.target_file,
    anchor_text: row.anchor_text,
    context_snippet: row.context_snippet,
    source_offset: row.source_offset,
    opportunity_id: row.opportunity_id,
    source_page_type: row.source_page_type,
    target_page_type: row.target_page_type,
    target_priority: row.target_priority,
    topic_cluster: row.topic_cluster,
    source_topic: row.source_topic,
    target_topic: row.target_topic,
    topical_relevance_score: numberOrNull(row.topical_relevance_score),
    anchor_type: row.anchor_type,
    anchor_variant: row.anchor_variant,
    anchor_confidence: numberOrNull(row.anchor_confidence),
    source_existing_internal_links_count: row.source_existing_internal_links_count,
    target_existing_inlinks_count: row.target_existing_inlinks_count,
    source_indexable: row.source_indexable,
    source_http_status: row.source_http_status,
    source_canonical_matches: row.source_canonical_matches,
    target_indexable: row.target_indexable,
    target_http_status: row.target_http_status,
    target_canonical_matches: row.target_canonical_matches,
    link_context_before: row.link_context_before,
    link_context_after: row.link_context_after,
    paragraph_hash: row.paragraph_hash,
    planner_version: row.planner_version,
    executor_version: row.executor_version,
    skip_reason: row.skip_reason,
    failure_reason: row.failure_reason,
    dismissed_reason: row.dismissed_reason,
    reviewer_notes: row.reviewer_notes,
    pr_branch: row.pr_branch,
    pr_commit_sha: row.pr_commit_sha,
    astro_pr_url: row.astro_pr_url,
    planned_at: row.planned_at,
    applied_at: row.applied_at,
    merged_at: row.merged_at,
    deployed_at: row.deployed_at,
    verified_at: row.verified_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    review_actions: {
      can_requeue: canRequeue(row),
      can_dismiss: canDismiss(row),
      can_verify_now: VERIFYABLE_STATUSES.has(row.status),
    },
  };
}

function hasPrLifecycle(row = {}) {
  return Boolean(row.astro_pr_url || row.pr_branch || row.pr_commit_sha || row.merged_at || row.deployed_at || row.verified_at);
}

function canRequeue(row = {}) {
  return RETRYABLE_STATUSES.has(row.status) && !hasPrLifecycle(row);
}

function canDismiss(row = {}) {
  return DISMISSABLE_STATUSES.has(row.status) && !hasPrLifecycle(row);
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeStatus(status) {
  const value = String(status || 'all');
  return ALLOWED_STATUSES.has(value) ? value : 'all';
}

function normalizeLimit(limit) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function normalizeDecision(decision) {
  const value = String(decision || '').trim();
  if (!ALLOWED_DECISIONS.has(value)) {
    const err = new Error(`decision must be one of: ${Array.from(ALLOWED_DECISIONS).join(', ')}`);
    err.statusCode = 400;
    err.isOperational = true;
    throw err;
  }
  return value;
}

function normalizeReviewer(reviewer) {
  return String(reviewer || 'admin').trim().slice(0, 100) || 'admin';
}

function normalizeNote(note) {
  return String(note || '').trim().replace(/\s+/g, ' ').slice(0, 500);
}

function appendReviewerNote(existing, { decision, reviewer, note, now = new Date() }) {
  const stamp = `[${now.toISOString()}] ${reviewer}: ${decision}${note ? ` - ${note}` : ''}`;
  return [String(existing || '').trim(), stamp].filter(Boolean).join('\n').slice(-5000);
}

module.exports = {
  listTasks,
  getTask,
  decideTask,
  buildTaskItem,
  countsByStatus,
  normalizeStatus,
  normalizeLimit,
  normalizeDecision,
  appendReviewerNote,
  hasPrLifecycle,
  canRequeue,
  canDismiss,
};
