jest.mock('../models/db', () => jest.fn());

const registryAdmin = require('../services/content/content-registry-admin');

function makeDatabase(tables) {
  function database(table) {
    return new Query(table, tables[table] || []);
  }
  database.raw = (value) => value;
  return database;
}

class Query {
  constructor(table, rows) {
    this.table = table;
    this.rows = rows;
    this.filters = [];
    this.searchTerms = [];
    this.groupField = null;
    this.countMode = false;
    this.firstMode = false;
    this.limitValue = null;
    this.offsetValue = 0;
    this.ordering = [];
  }

  select() { return this; }

  count() {
    this.countMode = true;
    return this;
  }

  first() {
    this.firstMode = true;
    return this;
  }

  where(field, op, value) {
    if (typeof field === 'function') {
      const scope = {
        where: (_field, _op, term) => {
          this.searchTerms.push(stripLike(term));
          return scope;
        },
        orWhere: (_field, _op, term) => {
          this.searchTerms.push(stripLike(term));
          return scope;
        },
      };
      field.call(scope);
      return this;
    }
    this.filters.push({ field, value: value === undefined ? op : value });
    return this;
  }

  groupBy(field) {
    this.groupField = field;
    return this;
  }

  orderByRaw() {
    this.ordering.push({ raw: true });
    return this;
  }

  orderBy(field, direction = 'asc') {
    this.ordering.push({ field, direction });
    return this;
  }

  limit(value) {
    this.limitValue = value;
    return this;
  }

  offset(value) {
    this.offsetValue = value;
    return this;
  }

  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }

  catch(reject) {
    return Promise.resolve(this.execute()).catch(reject);
  }

  execute() {
    let out = this.rows.filter((row) => this.matches(row));
    if (this.groupField) {
      const grouped = new Map();
      for (const row of out) {
        const key = row[this.groupField] || 'unknown';
        grouped.set(key, (grouped.get(key) || 0) + 1);
      }
      out = Array.from(grouped.entries()).map(([key, count]) => ({
        [this.groupField]: key,
        count,
      }));
    } else if (this.countMode) {
      out = [{ count: out.length }];
    } else {
      out = this.sort(out);
      if (this.offsetValue) out = out.slice(this.offsetValue);
      if (this.limitValue != null) out = out.slice(0, this.limitValue);
    }
    return this.firstMode ? out[0] : out;
  }

  matches(row) {
    const exact = this.filters.every(({ field, value }) => row[field] === value);
    if (!exact) return false;
    if (!this.searchTerms.length) return true;
    const haystack = [
      row.title,
      row.canonical_url_normalized,
      row.live_url,
      row.slug,
      row.astro_source_path,
      row.target_keyword,
    ].join(' ').toLowerCase();
    return this.searchTerms.some((term) => haystack.includes(term.toLowerCase()));
  }

  sort(rows) {
    if (this.table === 'content_registry') {
      return [...rows].sort((a, b) => {
        const aPriority = registryAdmin.STATUS_PRIORITY[a.reconciliation_status] || 99;
        const bPriority = registryAdmin.STATUS_PRIORITY[b.reconciliation_status] || 99;
        if (aPriority !== bPriority) return aPriority - bPriority;
        return String(a.title || '').localeCompare(String(b.title || ''));
      });
    }
    if (this.table === 'content_registry_sync_runs') {
      return [...rows].sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
    }
    return rows;
  }
}

function stripLike(value) {
  return String(value || '').replace(/^%|%$/g, '');
}

describe('content registry admin read model', () => {
  test('normalizes list params with bounded pagination and filters', () => {
    expect(registryAdmin.normalizeListParams({
      limit: '999',
      offset: '-1',
      status: 'conflict',
      content_type: 'blog',
      source: 'all',
      live_status: 'unknown',
      search: ' ants ',
    })).toEqual({
      limit: 200,
      offset: 0,
      filters: {
        reconciliation_status: 'conflict',
        content_type: 'blog',
        source: null,
        live_status: 'unknown',
        search: 'ants',
      },
    });
  });

  test('lists read-only registry rows with counts, facets, and latest sync metadata', async () => {
    const database = makeDatabase({
      content_registry: [
        {
          id: 'row-1',
          title: 'Conflict Ant Page',
          slug: 'ant-page',
          canonical_url_normalized: '/ant-page/',
          astro_source_path: 'src/content/blog/ant-page.md',
          content_type: 'blog',
          source: 'manual',
          live_status: 'unknown',
          reconciliation_status: 'conflict',
          last_synced_at: '2026-05-23T12:00:00Z',
        },
        {
          id: 'row-2',
          title: 'Matched Roach Page',
          slug: 'roach-page',
          canonical_url_normalized: '/roach-page/',
          content_type: 'blog',
          source: 'imported-legacy',
          live_status: 'unknown',
          reconciliation_status: 'matched',
          last_synced_at: '2026-05-23T12:00:00Z',
        },
        {
          id: 'row-3',
          title: 'Service Mosquito Page',
          slug: 'mosquito-page',
          canonical_url_normalized: '/mosquito-page/',
          content_type: 'service',
          source: 'unknown',
          live_status: 'unknown',
          reconciliation_status: 'astro_only',
          last_synced_at: '2026-05-23T12:00:00Z',
        },
      ],
      content_registry_sync_runs: [
        {
          id: 'sync-old',
          status: 'completed',
          mode: 'commit',
          started_at: '2026-05-22T12:00:00Z',
          completed_at: '2026-05-22T12:01:00Z',
        },
        {
          id: 'sync-new',
          status: 'completed',
          mode: 'commit',
          started_at: '2026-05-23T12:00:00Z',
          completed_at: '2026-05-23T12:01:00Z',
        },
      ],
    });

    const result = await registryAdmin.listContentRegistry({
      database,
      query: { content_type: 'blog', search: 'ant' },
    });

    expect(result.items).toEqual([expect.objectContaining({ id: 'row-1' })]);
    expect(result.total).toBe(1);
    expect(result.counts).toEqual({ conflict: 1 });
    expect(result.facets.content_type).toEqual({ blog: 2, service: 1 });
    expect(result.facets.source).toEqual({ manual: 1, 'imported-legacy': 1, unknown: 1 });
    expect(result.latest_sync_run.id).toBe('sync-new');
    expect(result.recent_sync_runs.map((run) => run.id)).toEqual(['sync-new', 'sync-old']);
  });
});
