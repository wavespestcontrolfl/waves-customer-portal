/**
 * content-registry.js — reconciles Astro source content with DB workflow
 * rows into a non-authoritative registry read model.
 */

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const db = require('../../models/db');
const fm = require('../content-astro/frontmatter');

const DEFAULT_COLLECTION_ROOT = path.join('src', 'content');
const WAVES_HOSTS = new Set(['wavespestcontrol.com', 'www.wavespestcontrol.com']);
const LIVE_MIRROR_FIELDS = [
  'sitemap_status',
  'http_status',
  'live_status',
  'redirect_target_url',
  'canonical_target_url',
  'noindex_detected',
  'sitemap_present',
];

function normalizeContentUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let pathname = raw;
  let host = '';

  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try { parsed = new URL(raw); } catch { return ''; }
    pathname = parsed.pathname;
    host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  } else {
    pathname = raw.replace(/[?#].*$/, '');
  }

  let normalizedPath = pathname
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!normalizedPath.startsWith('/')) normalizedPath = `/${normalizedPath}`;
  if (normalizedPath === '/') return host && !WAVES_HOSTS.has(host) ? `https://${host}/` : '/';
  const out = `${normalizedPath}/`;
  if (host && !WAVES_HOSTS.has(host)) return `https://${host}${out}`;
  return out;
}

function slugFromUrl(value) {
  const normalized = normalizeContentUrl(value);
  if (!normalized || /^https?:\/\//.test(normalized)) return '';
  return normalized.replace(/^\/+|\/+$/g, '').split('/').pop() || '';
}

function stableStringify(value) {
  if (value == null) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableHash(value) {
  return crypto.createHash('sha256')
    .update(typeof value === 'string' ? normalizeText(value) : stableStringify(value))
    .digest('hex');
}

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

function normalizeFrontmatterForHash(frontmatter) {
  const omit = new Set(['last_synced_at', 'sync_run_id']);
  const out = {};
  for (const [key, value] of Object.entries(frontmatter || {})) {
    if (omit.has(key)) continue;
    out[key] = normalizeHashValue(value);
  }
  return out;
}

function normalizeHashValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeHashValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeHashValue(value[key])]));
  }
  if (value === '') return null;
  return value;
}

function scanAstroContent(astroRoot, { collections = null, repoSha = null } = {}) {
  const root = String(astroRoot || '').trim();
  if (!root || !fs.existsSync(root)) {
    const err = new Error('ASTRO_REPO_DIR is required and must point to an existing Astro repo');
    err.code = 'ASTRO_ROOT_MISSING';
    throw err;
  }

  const contentRoot = path.join(root, DEFAULT_COLLECTION_ROOT);
  if (!fs.existsSync(contentRoot)) {
    const err = new Error(`Astro content directory missing: ${contentRoot}`);
    err.code = 'ASTRO_CONTENT_MISSING';
    throw err;
  }

  const allowed = collections ? new Set(collections) : null;
  const files = walkMarkdownFiles(contentRoot)
    .filter((full) => !allowed || allowed.has(path.relative(contentRoot, full).split(path.sep)[0]));
  const sha = repoSha || readGitSha(root);
  return files.map((full) => astroFileToItem(root, contentRoot, full, sha));
}

function astroFileToItem(astroRoot, contentRoot, fullPath, repoSha = null) {
  const source = fs.readFileSync(fullPath, 'utf8');
  const parsed = fm.parse(source);
  const frontmatter = parsed.data || {};
  const body = parsed.content || '';
  const relativePath = path.relative(astroRoot, fullPath).split(path.sep).join('/');
  const contentRelative = path.relative(contentRoot, fullPath).split(path.sep).join('/');
  const collection = contentRelative.split('/')[0] || 'unknown';
  const fallbackUrl = deriveUrlFromAstroPath(collection, contentRelative, frontmatter);
  const canonicalUrl = frontmatter.canonical || frontmatter.canonical_url || fallbackUrl;
  const normalized = normalizeContentUrl(canonicalUrl);
  const routeUrl = fallbackUrl || canonicalUrl;
  const frontmatterHash = stableHash(normalizeFrontmatterForHash(frontmatter));
  const bodyHash = stableHash(body);

  return {
    kind: 'astro',
    canonical_url: canonicalUrl || null,
    canonical_url_normalized: normalized || null,
    live_url: routeUrl || null,
    slug: slugFromUrl(frontmatter.slug || routeUrl || canonicalUrl),
    astro_source_path: relativePath,
    content_type: contentTypeFromCollection(collection, frontmatter),
    source: normalizeSource(frontmatter.source || frontmatter.content_source || 'unknown'),
    workflow_status: 'published',
    astro_status: 'present',
    db_status: 'missing',
    live_status: 'unknown',
    reconciliation_status: 'astro_only',
    title: frontmatter.title || null,
    h1: firstH1(body),
    meta_description: frontmatter.meta_description || frontmatter.description || null,
    target_keyword: frontmatter.target_keyword || frontmatter.primary_keyword || frontmatter.keyword || null,
    target_city: firstString(frontmatter.city, frontmatter.target_city, frontmatter.service_area, frontmatter.service_areas_tag),
    target_service: firstString(frontmatter.service, frontmatter.target_service, frontmatter.category, frontmatter.related_services),
    category: frontmatter.category || null,
    author: scalarFrontmatterValue(frontmatter.author_slug, frontmatter.author),
    reviewer: scalarFrontmatterValue(frontmatter.reviewer_slug, frontmatter.reviewer, frontmatter.technically_reviewed_by),
    published_at: parseDateMaybe(frontmatter.published || frontmatter.publish_date || frontmatter.published_at || frontmatter.date),
    last_updated_at: parseDateMaybe(frontmatter.updated || frontmatter.updated_at || frontmatter.last_updated_at || frontmatter.modified_at),
    astro_repo_sha: repoSha,
    astro_frontmatter_hash: frontmatterHash,
    astro_body_hash: bodyHash,
    astro_file_hash: stableHash(source),
    canonical_target_url: normalizeContentUrl(frontmatter.canonical || ''),
    noindex_detected: robotsNoindex(frontmatter),
    metadata: {
      collection,
      frontmatter,
    },
  };
}

function dbBlogRowToItem(row) {
  const canonicalUrl = row.astro_live_url || row.url || slugToPath(row.slug);
  const normalized = normalizeContentUrl(canonicalUrl);
  const workflowStatus = normalizeWorkflowStatus(row);
  const dbHash = stableHash(normalizeDbBlogForHash(row));
  return {
    kind: 'db_blog',
    canonical_url: canonicalUrl || null,
    canonical_url_normalized: normalized || null,
    live_url: row.astro_live_url || row.url || null,
    slug: row.slug || slugFromUrl(canonicalUrl),
    db_blog_id: row.id,
    content_type: 'blog',
    source: normalizeSource(row.source || 'unknown'),
    workflow_status: workflowStatus,
    astro_status: 'missing',
    db_status: 'present',
    live_status: 'unknown',
    reconciliation_status: workflowStatus === 'published' ? 'db_published_missing_astro' : 'db_only',
    title: row.title || null,
    meta_description: row.meta_description || null,
    target_keyword: row.keyword || null,
    target_city: row.city || null,
    target_service: row.tag || row.category || null,
    category: row.category || row.tag || null,
    author: row.author_slug || null,
    reviewer: row.reviewer_slug || null,
    published_at: parseDateMaybe(row.astro_published_at || row.publish_date),
    last_updated_at: parseDateMaybe(row.updated_at),
    db_row_hash: dbHash,
    metadata: {
      db_status: row.status || null,
      publish_status: row.publish_status || null,
      astro_status: row.astro_status || null,
      astro_pr_number: row.astro_pr_number || null,
      astro_branch_name: row.astro_branch_name || null,
      astro_commit_sha: row.astro_commit_sha || null,
    },
  };
}

function reconcileContent({ astroItems = [], dbItems = [], previousRows = [] } = {}) {
  const previous = previousLookup(previousRows);
  const astroCanonicalCounts = countsBy(astroItems, 'canonical_url_normalized');
  const astroCanonicalOwnerCounts = canonicalOwnerCounts(astroItems);
  const astroSlugCounts = countsBy(astroItems, 'slug');
  const activeDbItems = dbItems.filter((item) => !isArchivedWorkflow(item));
  const dbCanonicalCounts = countsBy(activeDbItems, 'canonical_url_normalized');
  const dbByCanonical = uniqueMap(activeDbItems, 'canonical_url_normalized');
  const dbBySlug = uniqueMap(activeDbItems, 'slug');
  const usedDb = new Set();
  const rows = [];

  for (const astro of astroItems) {
    const canonicalizedAstro = isCanonicalizedAstro(astro);
    const duplicateAstroCanonical = isDuplicateAstroCanonicalConflict(astro, astroCanonicalCounts, astroCanonicalOwnerCounts);
    const duplicateAstroSlug = astro.slug && astroSlugCounts.get(astro.slug) > 1;
    const duplicateDbCanonical = astro.canonical_url_normalized && dbCanonicalCounts.get(astro.canonical_url_normalized) > 1;
    let dbMatch = null;
    let matchConfidence = null;

    if (!canonicalizedAstro && !duplicateAstroCanonical && !duplicateAstroSlug && !duplicateDbCanonical && astro.canonical_url_normalized) {
      dbMatch = dbByCanonical.get(astro.canonical_url_normalized) || null;
      if (dbMatch) matchConfidence = 'canonical_url';
    }
    if (!duplicateAstroCanonical && !duplicateAstroSlug && !duplicateDbCanonical && !dbMatch && astro.slug) {
      const bySlug = dbBySlug.get(astro.slug);
      if (bySlug && bySlug.content_type === astro.content_type && !usedDb.has(bySlug.db_blog_id)) {
        dbMatch = bySlug;
        matchConfidence = 'slug';
      }
    }

    if (dbMatch) usedDb.add(dbMatch.db_blog_id);

    const base = dbMatch ? mergeAstroDb(astro, dbMatch) : { ...astro };
    base.match_confidence = matchConfidence || (dbMatch ? 'matched' : 'none');
    base.mismatch_reasons = [];

    if (duplicateAstroCanonical || duplicateAstroSlug || duplicateDbCanonical) {
      base.reconciliation_status = 'conflict';
      if (duplicateAstroCanonical) base.mismatch_reasons.push('duplicate_astro_canonical');
      if (duplicateAstroSlug) base.mismatch_reasons.push('duplicate_astro_slug');
      if (duplicateDbCanonical) base.mismatch_reasons.push('duplicate_db_canonical');
    } else if (dbMatch) {
      base.reconciliation_status = changeStatus(base, previous) || 'matched';
    } else {
      base.reconciliation_status = changeStatus(base, previous) || 'astro_only';
    }

    rows.push(finalizeRegistryRow(preserveLiveMirrorFields(base, previous)));
  }

  for (const item of dbItems) {
    if (usedDb.has(item.db_blog_id)) continue;
    const isArchived = isArchivedWorkflow(item);
    const duplicateDbCanonical = !isArchived && item.canonical_url_normalized && dbCanonicalCounts.get(item.canonical_url_normalized) > 1;
    const duplicateAstroCanonical = !isArchived && item.canonical_url_normalized && astroCanonicalCounts.get(item.canonical_url_normalized) > 1;
    const duplicateAstroSlug = !isArchived && item.slug && astroSlugCounts.get(item.slug) > 1;
    const row = { ...item, mismatch_reasons: [] };
    if (duplicateAstroCanonical || duplicateAstroSlug || duplicateDbCanonical) {
      row.reconciliation_status = 'conflict';
      if (duplicateAstroCanonical) row.mismatch_reasons.push('duplicate_astro_canonical');
      if (duplicateAstroSlug) row.mismatch_reasons.push('duplicate_astro_slug');
      if (duplicateDbCanonical) row.mismatch_reasons.push('duplicate_db_canonical');
    } else {
      const changedStatus = isArchived ? null : changeStatus(row, previous);
      row.reconciliation_status = changedStatus
        || (row.workflow_status === 'published' ? 'db_published_missing_astro' : 'db_only');
    }
    rows.push(finalizeRegistryRow(preserveLiveMirrorFields(row, previous)));
  }

  const summary = summarizeRows(rows, astroItems.length, dbItems.length);
  return { rows, summary };
}

function canonicalOwnerCounts(astroItems = []) {
  const counts = new Map();
  for (const item of astroItems) {
    const key = item.canonical_url_normalized;
    if (!key || isCanonicalizedAstro(item)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function isCanonicalizedAstro(item = {}) {
  const live = normalizeContentUrl(item.live_url);
  const canonical = item.canonical_url_normalized || normalizeContentUrl(item.canonical_url);
  return Boolean(live && canonical && live !== canonical);
}

function isDuplicateAstroCanonicalConflict(item = {}, canonicalCounts = new Map(), ownerCounts = new Map()) {
  const key = item.canonical_url_normalized;
  if (!key || (canonicalCounts.get(key) || 0) <= 1) return false;
  return (ownerCounts.get(key) || 0) !== 1;
}

function mergeAstroDb(astro, dbItem) {
  return {
    ...astro,
    db_blog_id: dbItem.db_blog_id,
    db_status: 'present',
    source: dbItem.source !== 'unknown' ? dbItem.source : astro.source,
    workflow_status: dbItem.workflow_status || astro.workflow_status,
    title: astro.title || dbItem.title,
    meta_description: astro.meta_description || dbItem.meta_description,
    target_keyword: dbItem.target_keyword || astro.target_keyword,
    target_city: dbItem.target_city || astro.target_city,
    target_service: dbItem.target_service || astro.target_service,
    category: astro.category || dbItem.category,
    author: astro.author || dbItem.author,
    reviewer: astro.reviewer || dbItem.reviewer,
    published_at: astro.published_at || dbItem.published_at,
    last_updated_at: astro.last_updated_at || dbItem.last_updated_at,
    db_row_hash: dbItem.db_row_hash,
    metadata: {
      astro: astro.metadata || {},
      db: dbItem.metadata || {},
    },
  };
}

function changeStatus(row, previous) {
  const prev = previous.byAstroPath.get(row.astro_source_path) || previous.byDbId.get(row.db_blog_id);
  if (!prev) return null;
  if (row.astro_file_hash && prev.astro_file_hash && row.astro_file_hash !== prev.astro_file_hash) return 'astro_changed_since_sync';
  if (row.db_row_hash && prev.db_row_hash && row.db_row_hash !== prev.db_row_hash) return 'db_changed_since_sync';
  return null;
}

function isArchivedWorkflow(row = {}) {
  return String(row.workflow_status || '').trim().toLowerCase() === 'archived';
}

function preserveLiveMirrorFields(row, previous) {
  const prev = previous.byAstroPath.get(row.astro_source_path) || previous.byDbId.get(row.db_blog_id);
  if (!prev || liveTargetChanged(row, prev)) return row;
  const out = { ...row };
  for (const field of LIVE_MIRROR_FIELDS) {
    if (typeof prev[field] !== 'undefined') out[field] = prev[field];
  }
  return out;
}

function liveTargetChanged(row, prev) {
  const current = normalizeContentUrl(row.live_url || row.canonical_url || row.canonical_url_normalized);
  const previous = normalizeContentUrl(prev.live_url || prev.canonical_url || prev.canonical_url_normalized);
  return current !== previous;
}

function finalizeRegistryRow(row) {
  const out = {
    canonical_url: row.canonical_url || null,
    canonical_url_normalized: row.canonical_url_normalized || null,
    live_url: row.live_url || null,
    slug: row.slug || null,
    astro_source_path: row.astro_source_path || null,
    db_blog_id: row.db_blog_id || null,
    content_type: row.content_type || 'unknown',
    source: row.source || 'unknown',
    workflow_status: row.workflow_status || 'unknown',
    astro_status: row.astro_status || 'unknown',
    db_status: row.db_status || 'unknown',
    sitemap_status: row.sitemap_status || 'unknown',
    http_status: row.http_status || 'unknown',
    live_status: row.live_status || 'unknown',
    reconciliation_status: row.reconciliation_status || 'unknown',
    title: row.title || null,
    h1: row.h1 || null,
    meta_description: row.meta_description || null,
    target_keyword: row.target_keyword || null,
    target_city: row.target_city || null,
    target_service: row.target_service || null,
    category: row.category || null,
    author: row.author || null,
    reviewer: row.reviewer || null,
    published_at: row.published_at || null,
    last_updated_at: row.last_updated_at || null,
    astro_repo_sha: row.astro_repo_sha || null,
    astro_frontmatter_hash: row.astro_frontmatter_hash || null,
    astro_body_hash: row.astro_body_hash || null,
    astro_file_hash: row.astro_file_hash || null,
    db_row_hash: row.db_row_hash || null,
    redirect_target_url: row.redirect_target_url || null,
    canonical_target_url: row.canonical_target_url || null,
    noindex_detected: Boolean(row.noindex_detected),
    sitemap_present: row.sitemap_present ?? null,
    match_confidence: row.match_confidence || null,
    mismatch_reasons: row.mismatch_reasons || [],
    metadata: row.metadata || {},
  };
  out.registry_hash = stableHash({ ...out, registry_hash: undefined });
  return out;
}

function summarizeRows(rows, astroCount, dbCount) {
  const byStatus = {};
  let changed = 0;
  for (const row of rows) {
    byStatus[row.reconciliation_status] = (byStatus[row.reconciliation_status] || 0) + 1;
    if (/changed_since_sync/.test(row.reconciliation_status)) changed++;
  }
  return {
    astro_files_scanned: astroCount,
    db_rows_scanned: dbCount,
    matched_count: byStatus.matched || 0,
    astro_only_count: byStatus.astro_only || 0,
    db_only_count: byStatus.db_only || 0,
    db_published_missing_astro_count: byStatus.db_published_missing_astro || 0,
    conflict_count: byStatus.conflict || 0,
    changed_count: changed,
    error_count: 0,
    by_status: byStatus,
  };
}

async function runContentRegistrySync({
  astroRoot = process.env.ASTRO_REPO_DIR,
  commit = false,
  contentType = null,
  database = db,
  now = new Date(),
} = {}) {
  const mode = commit ? 'commit' : 'dry_run';
  let syncRun = null;
  try {
    if (commit) {
      const inserted = await database('content_registry_sync_runs')
        .insert({
          mode,
          status: 'running',
          astro_root: astroRoot || null,
          started_at: now,
        })
        .returning('*');
      syncRun = Array.isArray(inserted) ? inserted[0] : inserted;
    }

    const astroItems = scanAstroContent(astroRoot, {
      collections: collectionsForContentType(contentType),
    });
    const dbRows = shouldScanDbBlogs(contentType) ? await database('blog_posts').select('*') : [];
    const dbItems = dbRows.map(dbBlogRowToItem);
    const previousRows = await database('content_registry').select('*');
    const result = reconcileContent({ astroItems, dbItems, previousRows });
    const staleRows = staleRegistryRows(previousRows, result.rows, contentType);
    const summary = summaryWithStaleRows(result.summary, staleRows.length);

    if (commit) {
      await database.transaction(async (trx) => {
        for (const row of result.rows) {
          const payload = {
            ...row,
            sync_run_id: syncRun.id,
            last_synced_at: now,
            updated_at: now,
          };
          await upsertRegistryRow(trx, registryWritePayload(payload));
        }
        for (const row of staleRows) {
          await markRegistryRowMissing(trx, row, syncRun.id, now);
        }
        await trx('content_registry_sync_runs').where('id', syncRun.id).update({
          status: 'completed',
          completed_at: now,
          astro_repo_sha: result.rows.find((row) => row.astro_repo_sha)?.astro_repo_sha || null,
          ...syncRunCountColumns(summary),
          summary: jsonbValue(summary),
          updated_at: now,
        });
      });
    }

    return {
      ok: true,
      mode,
      sync_run_id: syncRun?.id || null,
      rows: result.rows,
      summary,
    };
  } catch (err) {
    if (commit && syncRun?.id) {
      await database('content_registry_sync_runs').where('id', syncRun.id).update({
        status: 'failed',
        completed_at: now,
        failure_message: err.message,
        error_count: 1,
        summary: jsonbValue({ error: err.message, code: err.code || null }),
        updated_at: now,
      }).catch(() => {});
    }
    return {
      ok: false,
      mode,
      sync_run_id: syncRun?.id || null,
      error: err.message,
      code: err.code || null,
      rows: [],
      summary: { error_count: 1 },
    };
  }
}

function syncRunCountColumns(summary = {}) {
  return {
    astro_files_scanned: summary.astro_files_scanned || 0,
    db_rows_scanned: summary.db_rows_scanned || 0,
    matched_count: summary.matched_count || 0,
    astro_only_count: summary.astro_only_count || 0,
    db_only_count: summary.db_only_count || 0,
    db_published_missing_astro_count: summary.db_published_missing_astro_count || 0,
    conflict_count: summary.conflict_count || 0,
    changed_count: summary.changed_count || 0,
    error_count: summary.error_count || 0,
  };
}

function summaryWithStaleRows(summary = {}, staleCount = 0) {
  if (!staleCount) return summary;
  return {
    ...summary,
    changed_count: (summary.changed_count || 0) + staleCount,
    by_status: {
      ...(summary.by_status || {}),
      source_missing_since_sync: staleCount,
    },
  };
}

async function upsertRegistryRow(database, row) {
  let existingRows = [];
  if (row.db_blog_id && row.astro_source_path) {
    existingRows = await database('content_registry')
      .where('db_blog_id', row.db_blog_id)
      .orWhere('astro_source_path', row.astro_source_path)
      .select('id');
  } else if (row.db_blog_id) {
    existingRows = await database('content_registry').where('db_blog_id', row.db_blog_id).select('id');
  } else if (row.astro_source_path) {
    existingRows = await database('content_registry').where('astro_source_path', row.astro_source_path).select('id');
  }

  if (!existingRows.length) {
    await database('content_registry').insert(row);
    return;
  }

  const [existing, ...staleRows] = existingRows;
  if (staleRows.length) {
    await database('content_registry').whereIn('id', staleRows.map((r) => r.id)).delete();
  }

  const updates = { ...row };
  delete updates.id;
  delete updates.created_at;
  await database('content_registry').where('id', existing.id).update(updates);
}

function registryWritePayload(row) {
  return {
    ...row,
    mismatch_reasons: jsonbValue(row.mismatch_reasons || []),
    metadata: jsonbValue(row.metadata || {}),
  };
}

function jsonbValue(value) {
  return JSON.stringify(value == null ? null : value);
}

async function markRegistryRowMissing(database, row, syncRunId, now) {
  if (!row.id) return;
  const mismatchReasons = Array.from(new Set([
    ...arrayValue(row.mismatch_reasons),
    'not_seen_in_latest_sync',
  ]));
  const hadAstroSource = Boolean(row.astro_source_path) || row.astro_status === 'present';
  const hadDbSource = Boolean(row.db_blog_id)
    || row.db_status === 'present'
    || Boolean(row.metadata?.db_status)
    || Boolean(row.metadata?.publish_status);
  const updates = {
    astro_status: hadAstroSource ? 'missing' : (row.astro_status || 'unknown'),
    db_status: hadDbSource ? 'missing' : (row.db_status || 'unknown'),
    live_status: row.live_status || 'unknown',
    reconciliation_status: 'source_missing_since_sync',
    match_confidence: 'none',
    mismatch_reasons: jsonbValue(mismatchReasons),
    sync_run_id: syncRunId,
    last_synced_at: now,
    updated_at: now,
  };
  updates.registry_hash = stableHash({ ...row, ...updates, registry_hash: undefined });
  await database('content_registry').where('id', row.id).update(updates);
}

function staleRegistryRows(previousRows = [], currentRows = [], contentType = null) {
  const touchedAstro = new Set(currentRows.map((row) => row.astro_source_path).filter(Boolean));
  const touchedDb = new Set(currentRows.map((row) => row.db_blog_id).filter(Boolean));
  return (previousRows || []).filter((row) => {
    if (!registryRowInSyncScope(row, contentType)) return false;
    if (row.astro_source_path && touchedAstro.has(row.astro_source_path)) return false;
    if (row.db_blog_id && touchedDb.has(row.db_blog_id)) return false;
    return Boolean(row.id);
  });
}

function registryRowInSyncScope(row = {}, contentType = null) {
  const value = String(contentType || '').trim().toLowerCase();
  if (!value) return true;
  const sourcePath = String(row.astro_source_path || '');
  const type = String(row.content_type || '').trim().toLowerCase();
  if (value === 'blog') return type === 'blog' || sourcePath.startsWith('src/content/blog/') || Boolean(row.db_blog_id);
  if (value === 'service' || value === 'city-service' || value === 'customer-question') {
    return ['service', 'city-service', 'customer-question'].includes(type)
      || sourcePath.startsWith('src/content/services/');
  }
  if (value === 'city' || value === 'location') {
    return type === 'city' || type === 'location' || sourcePath.startsWith('src/content/locations/');
  }
  return type === value || sourcePath.startsWith(`src/content/${value}/`);
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch {
      return [value];
    }
  }
  return [value];
}

function shouldScanDbBlogs(contentType) {
  const value = String(contentType || '').trim().toLowerCase();
  return !value || value === 'blog';
}

function previousLookup(rows) {
  const byAstroPath = new Map();
  const byDbId = new Map();
  for (const row of rows || []) {
    if (row.astro_source_path) byAstroPath.set(row.astro_source_path, row);
    if (row.db_blog_id) byDbId.set(row.db_blog_id, row);
  }
  return { byAstroPath, byDbId };
}

function uniqueMap(items, key) {
  const counts = countsBy(items, key);
  const out = new Map();
  for (const item of items) {
    const value = item[key];
    if (value && counts.get(value) === 1) out.set(value, item);
  }
  return out;
}

function countsBy(items, key) {
  const counts = new Map();
  for (const item of items) {
    const value = item[key];
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

function deriveUrlFromAstroPath(collection, contentRelative, frontmatter = {}) {
  const slug = normalizeContentUrl(frontmatter.slug || '');
  if (slug) return slug;
  const withoutCollection = contentRelative.split('/').slice(1).join('/').replace(/\.mdx?$/, '');
  if (collection === 'blog') return `/blog/${withoutCollection}/`;
  return `/${withoutCollection}/`;
}

function contentTypeFromCollection(collection, frontmatter = {}) {
  if (frontmatter.content_type) return String(frontmatter.content_type);
  if (frontmatter.page_type) return String(frontmatter.page_type);
  if (collection === 'blog') return 'blog';
  if (collection === 'services') return 'service';
  if (collection === 'locations') return 'city';
  return collection || 'unknown';
}

function collectionsForContentType(contentType) {
  const value = String(contentType || '').trim().toLowerCase();
  if (!value) return null;
  if (value === 'blog') return ['blog'];
  if (value === 'service' || value === 'city-service' || value === 'customer-question') return ['services'];
  if (value === 'city' || value === 'location') return ['locations'];
  return [value];
}

function normalizeSource(value) {
  const raw = String(value || 'unknown').trim().toLowerCase().replace(/_/g, '-');
  if (!raw) return 'unknown';
  if (raw === 'ai-generated') return 'ai-assisted';
  if (raw === 'wordpress-import') return 'imported-legacy';
  return raw;
}

function normalizeWorkflowStatus(row = {}) {
  const status = String(row.status || '').toLowerCase().replace(/_/g, '-');
  const astroStatus = String(row.astro_status || '').toLowerCase().replace(/_/g, '-');
  const publishStatus = String(row.publish_status || '').toLowerCase().replace(/_/g, '-');
  if (status === 'archived') return 'archived';
  if (astroStatus === 'live' || status === 'published') return 'published';
  if (publishStatus === 'pending-review') return 'pending-review';
  if (status === 'scheduled' || publishStatus === 'scheduled') return 'scheduled';
  if (status === 'idea' || status === 'queued' || status === 'draft' || status === 'wp-draft') return 'draft';
  return status || publishStatus || astroStatus || 'unknown';
}

function normalizeDbBlogForHash(row = {}) {
  const keys = [
    'title', 'slug', 'meta_description', 'keyword', 'tag', 'city', 'status',
    'source', 'category', 'post_type', 'author_slug', 'reviewer_slug',
    'publish_status', 'publish_date', 'updated_at', 'astro_status',
    'astro_live_url', 'astro_published_at', 'astro_pr_number',
    'astro_branch_name', 'astro_commit_sha', 'url', 'content',
  ];
  return Object.fromEntries(keys.map((key) => [key, normalizeHashValue(row[key])]));
}

function robotsNoindex(frontmatter = {}) {
  return String(frontmatter.robots || frontmatter.indexing || '').toLowerCase().includes('noindex')
    || frontmatter.noindex === true;
}

function firstString(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return String(value[0]);
    if (value != null && value !== '') return String(value);
  }
  return null;
}

function scalarFrontmatterValue(...values) {
  for (const value of values) {
    const scalar = extractScalar(value);
    if (scalar) return scalar;
  }
  return null;
}

function extractScalar(value) {
  if (value == null || value === '') return null;
  if (Array.isArray(value)) return value.map(extractScalar).find(Boolean) || null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    for (const key of ['slug', 'name', 'title', 'id', 'email', 'bio_url']) {
      const scalar = extractScalar(value[key]);
      if (scalar) return scalar;
    }
    return null;
  }
  return String(value);
}

function firstH1(body) {
  const m = String(body || '').match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function parseDateMaybe(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function slugToPath(slug) {
  const raw = String(slug || '').trim();
  if (!raw) return '';
  if (raw.startsWith('http')) return raw;
  if (raw.startsWith('/')) return raw;
  return `/${raw}/`;
}

function walkMarkdownFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdownFiles(full));
    else if (entry.isFile() && /\.mdx?$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

function readGitSha(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

module.exports = {
  normalizeContentUrl,
  slugFromUrl,
  stableStringify,
  stableHash,
  LIVE_MIRROR_FIELDS,
  normalizeFrontmatterForHash,
  normalizeHashValue,
  scanAstroContent,
  astroFileToItem,
  dbBlogRowToItem,
  reconcileContent,
  canonicalOwnerCounts,
  isCanonicalizedAstro,
  isDuplicateAstroCanonicalConflict,
  isArchivedWorkflow,
  preserveLiveMirrorFields,
  liveTargetChanged,
  summarizeRows,
  runContentRegistrySync,
  syncRunCountColumns,
  summaryWithStaleRows,
  registryWritePayload,
  jsonbValue,
  deriveUrlFromAstroPath,
  contentTypeFromCollection,
  collectionsForContentType,
  shouldScanDbBlogs,
  staleRegistryRows,
  registryRowInSyncScope,
  normalizeWorkflowStatus,
  normalizeDbBlogForHash,
  firstH1,
  parseDateMaybe,
  slugToPath,
};
