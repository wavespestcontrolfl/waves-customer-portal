const db = require('../../models/db');

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const REGISTRY_FIELDS = [
  'id',
  'canonical_url',
  'canonical_url_normalized',
  'live_url',
  'slug',
  'astro_source_path',
  'db_blog_id',
  'content_type',
  'source',
  'workflow_status',
  'astro_status',
  'db_status',
  'sitemap_status',
  'http_status',
  'live_status',
  'redirect_target_url',
  'canonical_target_url',
  'reconciliation_status',
  'title',
  'target_keyword',
  'target_city',
  'target_service',
  'category',
  'author',
  'reviewer',
  'published_at',
  'last_updated_at',
  'last_synced_at',
  'sync_run_id',
  'astro_repo_sha',
  'match_confidence',
  'mismatch_reasons',
  'noindex_detected',
  'sitemap_present',
  'created_at',
  'updated_at',
];

const SYNC_RUN_FIELDS = [
  'id',
  'mode',
  'status',
  'astro_repo_sha',
  'started_at',
  'completed_at',
  'astro_files_scanned',
  'db_rows_scanned',
  'matched_count',
  'astro_only_count',
  'db_only_count',
  'db_published_missing_astro_count',
  'conflict_count',
  'changed_count',
  'error_count',
  'failure_message',
  'summary',
];

const STATUS_PRIORITY = {
  conflict: 1,
  db_published_missing_astro: 2,
  source_missing_since_sync: 3,
  db_changed_since_sync: 4,
  astro_changed_since_sync: 5,
  db_only: 6,
  astro_only: 7,
  matched: 8,
};

function parseBoundedInt(value, { defaultValue, min = 0, max = MAX_LIMIT } = {}) {
  const raw = value == null || value === '' ? defaultValue : value;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) return defaultValue;
  return Math.min(parsed, max);
}

function cleanFilter(value) {
  const text = String(value || '').trim();
  if (!text || text === 'all') return null;
  return text;
}

function normalizeListParams(query = {}) {
  return {
    limit: parseBoundedInt(query.limit, { defaultValue: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT }),
    offset: parseBoundedInt(query.offset, { defaultValue: 0, min: 0, max: 10000 }),
    filters: {
      reconciliation_status: cleanFilter(query.status || query.reconciliation_status),
      content_type: cleanFilter(query.content_type),
      source: cleanFilter(query.source),
      live_status: cleanFilter(query.live_status),
      search: cleanFilter(query.search),
    },
  };
}

function applyRegistryFilters(query, filters = {}) {
  if (filters.reconciliation_status) query.where('reconciliation_status', filters.reconciliation_status);
  if (filters.content_type) query.where('content_type', filters.content_type);
  if (filters.source) query.where('source', filters.source);
  if (filters.live_status) query.where('live_status', filters.live_status);
  if (filters.search) {
    const term = `%${filters.search}%`;
    query.where(function searchScope() {
      this.where('title', 'ilike', term)
        .orWhere('canonical_url_normalized', 'ilike', term)
        .orWhere('live_url', 'ilike', term)
        .orWhere('slug', 'ilike', term)
        .orWhere('astro_source_path', 'ilike', term)
        .orWhere('target_keyword', 'ilike', term);
    });
  }
  return query;
}

function statusSortExpression() {
  const clauses = Object.entries(STATUS_PRIORITY)
    .map(([status, priority]) => `WHEN '${status}' THEN ${priority}`)
    .join(' ');
  return `CASE reconciliation_status ${clauses} ELSE 99 END ASC`;
}

function parseCount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function rowsByKey(rows = [], key) {
  return Object.fromEntries(rows.map((row) => [row[key] || 'unknown', parseCount(row.count)]));
}

async function listContentRegistry({ database = db, query = {} } = {}) {
  const params = normalizeListParams(query);

  const itemsQuery = applyRegistryFilters(
    database('content_registry').select(REGISTRY_FIELDS),
    params.filters,
  )
    .orderByRaw(statusSortExpression())
    .orderBy('last_synced_at', 'desc')
    .orderBy('title', 'asc')
    .limit(params.limit)
    .offset(params.offset);

  const totalQuery = applyRegistryFilters(
    database('content_registry').count('* as count').first(),
    params.filters,
  );

  const statusCountsQuery = applyRegistryFilters(
    database('content_registry')
      .select('reconciliation_status')
      .count('* as count')
      .groupBy('reconciliation_status'),
    { ...params.filters, reconciliation_status: null },
  );

  const contentTypeCountsQuery = database('content_registry')
    .select('content_type')
    .count('* as count')
    .groupBy('content_type');

  const sourceCountsQuery = database('content_registry')
    .select('source')
    .count('* as count')
    .groupBy('source');

  const liveStatusCountsQuery = database('content_registry')
    .select('live_status')
    .count('* as count')
    .groupBy('live_status');

  const latestSyncRunQuery = database('content_registry_sync_runs')
    .select(SYNC_RUN_FIELDS)
    .orderBy('started_at', 'desc')
    .first();

  const recentSyncRunsQuery = database('content_registry_sync_runs')
    .select(SYNC_RUN_FIELDS)
    .orderBy('started_at', 'desc')
    .limit(5);

  const [
    items,
    totalRow,
    statusRows,
    contentTypeRows,
    sourceRows,
    liveStatusRows,
    latestSyncRun,
    recentSyncRuns,
  ] = await Promise.all([
    itemsQuery,
    totalQuery,
    statusCountsQuery,
    contentTypeCountsQuery,
    sourceCountsQuery,
    liveStatusCountsQuery,
    latestSyncRunQuery,
    recentSyncRunsQuery,
  ]);

  return {
    items,
    total: parseCount(totalRow?.count),
    limit: params.limit,
    offset: params.offset,
    filters: params.filters,
    counts: rowsByKey(statusRows, 'reconciliation_status'),
    facets: {
      content_type: rowsByKey(contentTypeRows, 'content_type'),
      source: rowsByKey(sourceRows, 'source'),
      live_status: rowsByKey(liveStatusRows, 'live_status'),
    },
    latest_sync_run: latestSyncRun || null,
    recent_sync_runs: recentSyncRuns || [],
  };
}

module.exports = {
  MAX_LIMIT,
  DEFAULT_LIMIT,
  REGISTRY_FIELDS,
  SYNC_RUN_FIELDS,
  STATUS_PRIORITY,
  parseBoundedInt,
  normalizeListParams,
  applyRegistryFilters,
  listContentRegistry,
};
