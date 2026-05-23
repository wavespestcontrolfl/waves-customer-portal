#!/usr/bin/env node
/**
 * Archive stale DB blog rows surfaced by content_registry.
 *
 * Default is dry-run. Commit mode requires explicit --ids so broad filters
 * cannot silently archive content. The script never edits Astro files,
 * redirects, indexing state, or live content.
 */

const db = require('../models/db');

const DEFAULT_LIMIT = 50;
const DEFAULT_LIVE_STATUS = 'missing';
const ACTIVE_ASTRO_STATUSES = new Set(['pr-open', 'build-failed', 'merged', 'live', 'unpublish-pending']);
const ACTIVE_PUBLISH_STATUSES = new Set(['pending', 'pending-review', 'publishing', 'scheduled']);

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out[arg] = true;
      continue;
    }
    const raw = arg.slice(2);
    const eq = raw.indexOf('=');
    if (eq !== -1) {
      out[raw.slice(0, eq)] = raw.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[raw] = next;
      i += 1;
    } else {
      out[raw] = true;
    }
  }
  return out;
}

function boolFlag(value) {
  if (value === true) return true;
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function splitList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(splitList);
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueList(items = []) {
  return Array.from(new Set(items));
}

function parsePositiveInt(value, fallback, max = 500) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function isPublishedRow(row = {}) {
  return String(row.blog_status || '').toLowerCase() === 'published'
    || String(row.registry_workflow_status || '').toLowerCase() === 'published';
}

function isArchivedRow(row = {}) {
  return String(row.blog_status || '').toLowerCase() === 'archived'
    || String(row.registry_workflow_status || '').toLowerCase() === 'archived';
}

function normalizeStatusToken(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

function isActiveAstroStatus(row = {}) {
  return ACTIVE_ASTRO_STATUSES.has(normalizeStatusToken(row.astro_status));
}

function hasAstroLiveUrl(row = {}) {
  return Boolean(String(row.astro_live_url || '').trim());
}

function hasAstroPrState(row = {}) {
  return Boolean(row.astro_pr_number)
    || Boolean(String(row.astro_branch_name || '').trim());
}

function isActivePublishStatus(row = {}) {
  return ACTIVE_PUBLISH_STATUSES.has(normalizeStatusToken(row.publish_status))
    || ACTIVE_PUBLISH_STATUSES.has(normalizeStatusToken(row.registry_workflow_status));
}

function hasScheduledPublishAt(row = {}) {
  return Boolean(row.scheduled_publish_at);
}

function blockersForRow(row = {}, { allowPublished = false } = {}) {
  const blockers = [];
  if (!row.registry_id) blockers.push('missing_registry_row');
  if (!row.blog_id) blockers.push('missing_blog_row');
  if (isArchivedRow(row)) blockers.push('already_archived');
  if (row.astro_source_path) blockers.push('has_astro_source');
  if (isActiveAstroStatus(row)) blockers.push(`astro_status_${normalizeStatusToken(row.astro_status)}`);
  if (hasAstroLiveUrl(row)) blockers.push('has_astro_live_url');
  if (hasAstroPrState(row)) blockers.push('has_astro_pr_state');
  if (isActivePublishStatus(row)) blockers.push(`publish_status_${normalizeStatusToken(row.publish_status || row.registry_workflow_status)}`);
  if (hasScheduledPublishAt(row)) blockers.push('has_scheduled_publish_at');
  if (String(row.live_status || '') !== DEFAULT_LIVE_STATUS) {
    blockers.push(`live_status_${row.live_status || 'unknown'}`);
  }
  if (isPublishedRow(row) && !allowPublished) {
    blockers.push('published_requires_allow_published');
  }
  return blockers;
}

function summarizeRows(rows = []) {
  const byStatus = {};
  const byWorkflow = {};
  let blockedCount = 0;
  for (const row of rows) {
    byStatus[row.live_status || 'unknown'] = (byStatus[row.live_status || 'unknown'] || 0) + 1;
    byWorkflow[row.registry_workflow_status || 'unknown'] = (byWorkflow[row.registry_workflow_status || 'unknown'] || 0) + 1;
    if (row.blockers?.length) blockedCount += 1;
  }
  return {
    candidate_count: rows.length,
    blocked_count: blockedCount,
    by_live_status: byStatus,
    by_workflow_status: byWorkflow,
  };
}

async function loadCandidateRows(database, {
  ids = [],
  liveStatus = DEFAULT_LIVE_STATUS,
  limit = DEFAULT_LIMIT,
} = {}) {
  const safeLimit = parsePositiveInt(limit, DEFAULT_LIMIT);
  let query = database('content_registry as cr')
    .leftJoin('blog_posts as bp', 'bp.id', 'cr.db_blog_id')
    .select(
      'cr.id as registry_id',
      'cr.db_blog_id as blog_id',
      'cr.title as registry_title',
      'cr.canonical_url_normalized',
      'cr.live_url',
      'cr.live_status',
      'cr.http_status',
      'cr.redirect_target_url',
      'cr.canonical_target_url',
      'cr.reconciliation_status',
      'cr.workflow_status as registry_workflow_status',
      'cr.astro_source_path',
      'bp.title as blog_title',
      'bp.slug as blog_slug',
      'bp.status as blog_status',
      'bp.publish_status',
      'bp.scheduled_publish_at',
      'bp.astro_status',
      'bp.astro_pr_number',
      'bp.astro_branch_name',
      'bp.astro_live_url',
    )
    .whereNotNull('cr.db_blog_id');

  if (ids.length) {
    query = query.whereIn('cr.db_blog_id', ids);
  } else {
    query = query
      .where('cr.live_status', liveStatus)
      .whereNot('cr.workflow_status', 'archived')
      .limit(safeLimit);
  }

  query = query
    .orderBy('cr.updated_at', 'desc')
    .orderBy('cr.title', 'asc');
  return query;
}

async function lockArchiveRows(trx, ids = []) {
  const registryLock = trx('content_registry')
    .whereIn('db_blog_id', ids);
  if (typeof registryLock.forUpdate === 'function') await registryLock.forUpdate();

  const blogLock = trx('blog_posts')
    .whereIn('id', ids);
  if (typeof blogLock.forUpdate === 'function') await blogLock.forUpdate();
}

async function archiveStaleBlogRows({
  database = db,
  ids = [],
  commit = false,
  allowPublished = false,
  liveStatus = DEFAULT_LIVE_STATUS,
  limit = DEFAULT_LIMIT,
  now = new Date(),
} = {}) {
  const targetIds = uniqueList(ids);
  if (commit && !targetIds.length) {
    return {
      ok: false,
      mode: 'commit',
      error: '--commit requires explicit --ids=<blog_post_id,...>',
      summary: { candidate_count: 0, blocked_count: 0, updated_count: 0 },
      rows: [],
    };
  }

  if (!commit) {
    const rows = await loadCandidateRows(database, { ids: targetIds, liveStatus, limit });
    const annotatedRows = rows.map((row) => ({
      ...row,
      blockers: blockersForRow(row, { allowPublished }),
    }));
    return {
      ok: true,
      mode: 'dry_run',
      summary: { ...summarizeRows(annotatedRows), updated_count: 0 },
      rows: annotatedRows,
    };
  }

  return database.transaction(async (trx) => {
    await lockArchiveRows(trx, targetIds);
    const rows = await loadCandidateRows(trx, {
      ids: targetIds,
      liveStatus,
      limit: targetIds.length,
    });
    const annotatedRows = rows.map((row) => ({
      ...row,
      blockers: blockersForRow(row, { allowPublished }),
    }));
    const blocked = annotatedRows.filter((row) => row.blockers.length);

    if (annotatedRows.length !== targetIds.length) {
      return {
        ok: false,
        mode: 'commit',
        error: 'One or more requested rows were not found',
        summary: { ...summarizeRows(annotatedRows), updated_count: 0 },
        rows: annotatedRows,
      };
    }

    if (blocked.length) {
      return {
        ok: false,
        mode: 'commit',
        error: 'One or more rows failed archive safety checks',
        summary: { ...summarizeRows(annotatedRows), updated_count: 0 },
        rows: annotatedRows,
      };
    }

    const updateIds = annotatedRows.map((row) => row.blog_id);
    await trx('blog_posts')
      .whereIn('id', updateIds)
      .update({
        status: 'archived',
        publish_status: null,
        updated_at: now,
      });
    await trx('content_registry')
      .whereIn('db_blog_id', updateIds)
      .update({
        workflow_status: 'archived',
        reconciliation_status: 'db_only',
        match_confidence: 'none',
        mismatch_reasons: JSON.stringify([]),
        updated_at: now,
      });

    return {
      ok: true,
      mode: 'commit',
      summary: {
        ...summarizeRows(annotatedRows),
        updated_count: updateIds.length,
      },
      rows: annotatedRows,
    };
  });
}

function printSummary(result) {
  const s = result.summary || {};
  console.log('');
  console.log(`Mode:             ${result.mode}`);
  console.log(`Status:           ${result.ok ? 'ok' : 'failed'}`);
  if (result.error) console.log(`Error:            ${result.error}`);
  console.log(`Candidates:       ${s.candidate_count || 0}`);
  console.log(`Blocked:          ${s.blocked_count || 0}`);
  console.log(`Updated:          ${s.updated_count || 0}`);
  if (result.rows?.length) {
    console.log('');
    for (const row of result.rows) {
      const title = row.blog_title || row.registry_title || row.blog_id;
      const blockers = row.blockers?.length ? ` blockers=${row.blockers.join(',')}` : '';
      console.log(`- ${row.blog_id} ${row.live_status}/${row.registry_workflow_status}: ${title}${blockers}`);
    }
  }
  if (result.mode === 'dry_run') {
    console.log('');
    console.log('Dry-run only. Re-run with --commit --ids=<blog_post_id,...> to archive explicit rows.');
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = await archiveStaleBlogRows({
    database: db,
    ids: splitList(args.ids),
    commit: boolFlag(args.commit),
    allowPublished: boolFlag(args['allow-published']),
    liveStatus: args['live-status'] || DEFAULT_LIVE_STATUS,
    limit: args.limit || DEFAULT_LIMIT,
  });

  if (boolFlag(args.json)) console.log(JSON.stringify(result, null, 2));
  else printSummary(result);

  await db.destroy();
  if (!result.ok) process.exit(1);
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err.stack || err.message);
    await db.destroy().catch(() => {});
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_LIMIT,
  DEFAULT_LIVE_STATUS,
  ACTIVE_ASTRO_STATUSES,
  ACTIVE_PUBLISH_STATUSES,
  parseArgs,
  boolFlag,
  splitList,
  uniqueList,
  parsePositiveInt,
  normalizeStatusToken,
  isPublishedRow,
  isArchivedRow,
  isActiveAstroStatus,
  hasAstroLiveUrl,
  hasAstroPrState,
  isActivePublishStatus,
  hasScheduledPublishAt,
  blockersForRow,
  summarizeRows,
  loadCandidateRows,
  lockArchiveRows,
  archiveStaleBlogRows,
  printSummary,
  main,
};
