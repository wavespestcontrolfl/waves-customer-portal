const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../models/db', () => jest.fn());

const registry = require('../services/content/content-registry');
const syncCli = require('../scripts/sync-content-registry');

function makeAstroRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'content-registry-'));
}

function writeFile(root, relative, body) {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

describe('content-registry url and hashing helpers', () => {
  test('normalizes Waves URLs to canonical paths', () => {
    expect(registry.normalizeContentUrl('https://www.wavespestcontrol.com/Blog/Test?utm=x#top')).toBe('/blog/test/');
    expect(registry.normalizeContentUrl('/Blog/Test/')).toBe('/blog/test/');
    expect(registry.normalizeContentUrl('blog/test')).toBe('/blog/test/');
  });

  test('keeps external host in normalized URL to avoid false same-path matches', () => {
    expect(registry.normalizeContentUrl('https://example.com/pest-control/')).toBe('https://example.com/pest-control/');
  });

  test('stableHash ignores object key order and line-ending noise', () => {
    expect(registry.stableHash({ b: 2, a: 1 })).toBe(registry.stableHash({ a: 1, b: 2 }));
    expect(registry.stableHash('a\r\nb  \n')).toBe(registry.stableHash('a\nb'));
    expect(registry.stableHash({ published_at: new Date('2026-05-23T00:00:00Z') }))
      .not.toBe(registry.stableHash({ published_at: new Date('2026-05-24T00:00:00Z') }));
  });

  test('maps content-type filters to Astro collections', () => {
    expect(registry.collectionsForContentType('blog')).toEqual(['blog']);
    expect(registry.collectionsForContentType('Service')).toEqual(['services']);
    expect(registry.collectionsForContentType('city')).toEqual(['locations']);
    expect(registry.collectionsForContentType(null)).toBe(null);
    expect(registry.shouldScanDbBlogs(null)).toBe(true);
    expect(registry.shouldScanDbBlogs('blog')).toBe(true);
    expect(registry.shouldScanDbBlogs('service')).toBe(false);
  });

  test('sync run count columns omit summary-only fields', () => {
    const columns = registry.syncRunCountColumns({
      astro_files_scanned: 2,
      by_status: { astro_only: 2 },
    });
    expect(columns).toEqual(expect.objectContaining({
      astro_files_scanned: 2,
      error_count: 0,
    }));
    expect(columns).not.toHaveProperty('by_status');
  });

  test('registry write payload encodes jsonb fields explicitly', () => {
    const payload = registry.registryWritePayload({
      mismatch_reasons: ['duplicate_astro_canonical'],
      metadata: { source: 'fixture' },
    });
    expect(payload.mismatch_reasons).toBe(JSON.stringify(['duplicate_astro_canonical']));
    expect(payload.metadata).toBe(JSON.stringify({ source: 'fixture' }));
  });

  test('DB row hash includes registry-output workflow and date fields', () => {
    const base = {
      id: '00000000-0000-0000-0000-000000000099',
      title: 'Hash Me',
      slug: 'hash-me',
      status: 'draft',
      publish_status: 'pending_review',
      publish_date: '2026-05-23',
      astro_published_at: null,
    };
    expect(registry.dbBlogRowToItem(base).db_row_hash)
      .not.toBe(registry.dbBlogRowToItem({ ...base, publish_status: 'scheduled' }).db_row_hash);
    expect(registry.dbBlogRowToItem(base).db_row_hash)
      .not.toBe(registry.dbBlogRowToItem({ ...base, publish_date: '2026-05-24' }).db_row_hash);
    expect(registry.dbBlogRowToItem(base).db_row_hash)
      .not.toBe(registry.dbBlogRowToItem({ ...base, astro_published_at: '2026-05-25T00:00:00Z' }).db_row_hash);
  });

  test('commit mode requires an explicit Astro root', () => {
    expect(syncCli.parseArgs(['--astro-dir', '/tmp/astro', '--content-type', 'blog', '--json'])).toEqual({
      'astro-dir': '/tmp/astro',
      'content-type': 'blog',
      json: true,
    });
    expect(syncCli.parseArgs(['--astro-dir=/tmp/astro', '--content-type=blog'])).toEqual({
      'astro-dir': '/tmp/astro',
      'content-type': 'blog',
    });
    expect(syncCli.resolveAstroRoot({}, {}).usingFallback).toBe(true);
    expect(syncCli.resolveAstroRoot({ 'astro-dir': '/tmp/astro' }, {}).usingFallback).toBe(false);
    expect(syncCli.resolveAstroRoot({}, { ASTRO_REPO_DIR: '/tmp/astro-env' })).toEqual({
      astroRoot: '/tmp/astro-env',
      usingFallback: false,
    });
  });
});

describe('content-registry Astro scanner', () => {
  test('scans Astro frontmatter and hashes source parts', () => {
    const root = makeAstroRoot();
    try {
      writeFile(root, 'src/content/blog/how-to-stop-ants.md', `---
title: How to Stop Ants
slug: /how-to-stop-ants/
canonical: https://www.wavespestcontrol.com/how-to-stop-ants/
meta_description: Ant control help for SWFL homes.
category: pest-control
author_slug: adam
reviewer_slug: drew
---
# How to Stop Ants

Body text.
`);

      const rows = registry.scanAstroContent(root, { repoSha: 'abc123' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({
        canonical_url_normalized: '/how-to-stop-ants/',
        astro_source_path: 'src/content/blog/how-to-stop-ants.md',
        content_type: 'blog',
        title: 'How to Stop Ants',
        h1: 'How to Stop Ants',
        author: 'adam',
        reviewer: 'drew',
        astro_repo_sha: 'abc123',
      }));
      expect(rows[0].astro_frontmatter_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(rows[0].astro_body_hash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('normalizes current Astro object frontmatter into scalar registry fields', () => {
    const root = makeAstroRoot();
    try {
      writeFile(root, 'src/content/blog/tvoc-levels-after-pest-control.md', `---
schemaVersion: 2
title: "TVOC Levels After Pest Control"
slug: "/pest-control/tvoc-levels-after-pest-control/"
meta_description: "What Lakewood Ranch homeowners should know."
primary_keyword: "TVOC Levels After Pest Control"
service_areas_tag:
  - "Lakewood Ranch"
related_services:
  - "pest-control-lakewood-ranch-fl"
author:
  name: "Adam Benetti"
  role: "Founder & Lead Technician"
technically_reviewed_by:
  name: "Adam Benetti"
  credential: "FDACS Licensed Pest Control Operator"
published: "2025-06-01"
updated: "2025-06-02"
canonical: "https://www.wavespestcontrol.com/pest-control/tvoc-levels-after-pest-control/"
---
# TVOC Levels After Pest Control
`);

      const [row] = registry.scanAstroContent(root);
      expect(row).toEqual(expect.objectContaining({
        author: 'Adam Benetti',
        reviewer: 'Adam Benetti',
        target_keyword: 'TVOC Levels After Pest Control',
        target_city: 'Lakewood Ranch',
        target_service: 'pest-control-lakewood-ranch-fl',
      }));
      expect(row.published_at.toISOString()).toBe('2025-06-01T00:00:00.000Z');
      expect(row.last_updated_at.toISOString()).toBe('2025-06-02T00:00:00.000Z');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when Astro root is missing', () => {
    expect(() => registry.scanAstroContent('/tmp/not-a-real-astro-root')).toThrow(/ASTRO_REPO_DIR/);
  });
});

describe('content-registry reconciliation', () => {
  test('classifies astro-only, db-only, db-published-missing-astro, and matched rows', () => {
    const astroItems = [
      {
        canonical_url: 'https://www.wavespestcontrol.com/matched/',
        canonical_url_normalized: '/matched/',
        slug: 'matched',
        astro_source_path: 'src/content/blog/matched.md',
        content_type: 'blog',
        source: 'unknown',
        workflow_status: 'published',
        astro_status: 'present',
        db_status: 'missing',
        astro_file_hash: 'astro-a',
      },
      {
        canonical_url: 'https://www.wavespestcontrol.com/astro-only/',
        canonical_url_normalized: '/astro-only/',
        slug: 'astro-only',
        astro_source_path: 'src/content/blog/astro-only.md',
        content_type: 'blog',
        source: 'unknown',
        workflow_status: 'published',
        astro_status: 'present',
        db_status: 'missing',
        astro_file_hash: 'astro-b',
      },
    ];
    const dbItems = [
      registry.dbBlogRowToItem({ id: '00000000-0000-0000-0000-000000000001', title: 'Matched', slug: 'matched', status: 'published' }),
      registry.dbBlogRowToItem({ id: '00000000-0000-0000-0000-000000000002', title: 'Draft Only', slug: 'draft-only', status: 'draft' }),
      registry.dbBlogRowToItem({ id: '00000000-0000-0000-0000-000000000003', title: 'Missing Published', slug: 'missing-published', status: 'published' }),
    ];

    const { rows, summary } = registry.reconcileContent({ astroItems, dbItems });
    const bySlug = Object.fromEntries(rows.map((row) => [row.slug, row.reconciliation_status]));

    expect(bySlug.matched).toBe('matched');
    expect(bySlug['astro-only']).toBe('astro_only');
    expect(bySlug['draft-only']).toBe('db_only');
    expect(bySlug['missing-published']).toBe('db_published_missing_astro');
    expect(summary).toEqual(expect.objectContaining({
      astro_files_scanned: 2,
      db_rows_scanned: 3,
      matched_count: 1,
      astro_only_count: 1,
      db_only_count: 1,
      db_published_missing_astro_count: 1,
    }));
  });

  test('flags duplicate Astro canonicals as conflicts instead of hiding them', () => {
    const astroItems = [
      { canonical_url_normalized: '/same/', slug: 'a', astro_source_path: 'src/content/blog/a.md', content_type: 'blog', astro_status: 'present' },
      { canonical_url_normalized: '/same/', slug: 'b', astro_source_path: 'src/content/blog/b.md', content_type: 'blog', astro_status: 'present' },
    ];

    const { rows, summary } = registry.reconcileContent({ astroItems, dbItems: [] });
    expect(rows.map((row) => row.reconciliation_status)).toEqual(['conflict', 'conflict']);
    expect(rows[0].mismatch_reasons).toContain('duplicate_astro_canonical');
    expect(summary.conflict_count).toBe(2);
  });

  test('does not bind one DB row to multiple duplicate-Astro conflicts', () => {
    const astroItems = [
      { canonical_url_normalized: '/same/', slug: 'a', astro_source_path: 'src/content/blog/a.md', content_type: 'blog', astro_status: 'present' },
      { canonical_url_normalized: '/same/', slug: 'b', astro_source_path: 'src/content/blog/b.md', content_type: 'blog', astro_status: 'present' },
    ];
    const dbItems = [
      registry.dbBlogRowToItem({
        id: '00000000-0000-0000-0000-000000000005',
        title: 'Same',
        slug: 'same',
        status: 'published',
      }),
    ];

    const { rows, summary } = registry.reconcileContent({ astroItems, dbItems });
    const conflictRows = rows.filter((row) => row.reconciliation_status === 'conflict');
    expect(conflictRows).toHaveLength(3);
    expect(rows.filter((row) => row.db_blog_id === '00000000-0000-0000-0000-000000000005')).toHaveLength(1);
    expect(rows.find((row) => row.db_blog_id)?.mismatch_reasons).toContain('duplicate_astro_canonical');
    expect(summary.conflict_count).toBe(3);
  });

  test('flags duplicate Astro slugs before slug fallback can hide a row', () => {
    const astroItems = [
      { canonical_url_normalized: '/a/', slug: 'same-slug', astro_source_path: 'src/content/blog/a.md', content_type: 'blog', astro_status: 'present' },
      { canonical_url_normalized: '/b/', slug: 'same-slug', astro_source_path: 'src/content/blog/b.md', content_type: 'blog', astro_status: 'present' },
    ];
    const dbItems = [
      registry.dbBlogRowToItem({
        id: '00000000-0000-0000-0000-000000000006',
        title: 'Same Slug',
        slug: 'same-slug',
        status: 'draft',
      }),
    ];

    const { rows, summary } = registry.reconcileContent({ astroItems, dbItems });
    expect(rows.filter((row) => row.reconciliation_status === 'conflict')).toHaveLength(3);
    expect(rows.filter((row) => row.db_blog_id === '00000000-0000-0000-0000-000000000006')).toHaveLength(1);
    expect(rows[0].mismatch_reasons).toContain('duplicate_astro_slug');
    expect(summary.conflict_count).toBe(3);
  });

  test('detects Astro and DB changes compared with prior registry rows', () => {
    const astroRows = [{ canonical_url_normalized: '/a/', slug: 'a', astro_source_path: 'src/content/blog/a.md', content_type: 'blog', astro_status: 'present', astro_file_hash: 'new' }];
    const dbRows = [registry.dbBlogRowToItem({ id: '00000000-0000-0000-0000-000000000004', title: 'B', slug: 'b', status: 'draft', content: 'new' })];

    expect(registry.reconcileContent({
      astroItems: astroRows,
      previousRows: [{ astro_source_path: 'src/content/blog/a.md', astro_file_hash: 'old' }],
    }).rows[0].reconciliation_status).toBe('astro_changed_since_sync');

    expect(registry.reconcileContent({
      dbItems: dbRows,
      previousRows: [{ db_blog_id: '00000000-0000-0000-0000-000000000004', db_row_hash: 'old' }],
    }).rows[0].reconciliation_status).toBe('db_changed_since_sync');
  });

  test('repeated reconciliation without previous changes is stable', () => {
    const astroItems = [{ canonical_url_normalized: '/stable/', slug: 'stable', astro_source_path: 'src/content/blog/stable.md', content_type: 'blog', astro_status: 'present', astro_file_hash: 'same' }];
    const first = registry.reconcileContent({ astroItems, dbItems: [] });
    const second = registry.reconcileContent({ astroItems, dbItems: [] });
    expect(second.summary).toEqual(first.summary);
    expect(second.rows.map((row) => row.registry_hash)).toEqual(first.rows.map((row) => row.registry_hash));
  });
});

describe('content-registry sync safety', () => {
  test('dry-run reports previous-state changes and stale scoped rows', async () => {
    const root = makeAstroRoot();
    const fakeDb = (table) => ({
      select: async () => {
        if (table === 'blog_posts') return [];
        if (table === 'content_registry') {
          return [{
            id: 'registry-old-dry-run',
            astro_source_path: 'src/content/blog/old-post.md',
            content_type: 'blog',
            astro_status: 'present',
            db_status: 'missing',
            reconciliation_status: 'astro_only',
          }];
        }
        return [];
      },
    });

    try {
      fs.mkdirSync(path.join(root, 'src', 'content', 'blog'), { recursive: true });
      const result = await registry.runContentRegistrySync({
        astroRoot: root,
        commit: false,
        contentType: 'blog',
        database: fakeDb,
      });

      expect(result.ok).toBe(true);
      expect(result.summary.changed_count).toBe(1);
      expect(result.summary.by_status.source_missing_since_sync).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('successful commit persists only real sync-run count columns', async () => {
    const root = makeAstroRoot();
    const calls = [];
    const fakeDb = (table) => ({
      insert(payload) {
        calls.push({ table, op: 'insert', payload });
        return {
          returning: async () => (table === 'content_registry_sync_runs'
            ? [{ id: 'sync-run-2' }]
            : [{ id: 'registry-row-1' }]),
        };
      },
      select: async () => {
        if (table === 'blog_posts') return [];
        if (table === 'content_registry') return [];
        return [];
      },
      where() {
        return {
          orWhere() { return this; },
          select: async () => [],
          update: async (payload) => {
            calls.push({ table, op: 'update', payload });
            return 1;
          },
        };
      },
      whereIn() {
        return {
          delete: async () => 0,
        };
      },
    });
    fakeDb.transaction = async (callback) => callback(fakeDb);

    try {
      writeFile(root, 'src/content/blog/how-to-stop-ants.md', `---
title: How to Stop Ants
slug: /how-to-stop-ants/
---
# How to Stop Ants
`);

      const result = await registry.runContentRegistrySync({
        astroRoot: root,
        commit: true,
        database: fakeDb,
        now: new Date('2026-05-23T12:00:00Z'),
      });

      expect(result.ok).toBe(true);
      const completed = calls.find((call) => call.table === 'content_registry_sync_runs'
        && call.op === 'update'
        && call.payload.status === 'completed');
      expect(completed.payload).toEqual(expect.objectContaining({
        astro_files_scanned: 1,
        astro_only_count: 1,
        error_count: 0,
      }));
      expect(completed.payload).not.toHaveProperty('by_status');
      expect(calls.some((call) => call.table === 'content_registry' && call.op === 'insert')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('commit marks scoped previous rows missing when current scan no longer sees them', async () => {
    const root = makeAstroRoot();
    const calls = [];
    const previousRows = [
      {
        id: 'registry-old-1',
        astro_source_path: 'src/content/blog/old-post.md',
        content_type: 'blog',
        astro_status: 'present',
        db_status: 'missing',
        reconciliation_status: 'astro_only',
        mismatch_reasons: [],
      },
      {
        id: 'registry-old-db',
        content_type: 'blog',
        astro_status: 'unknown',
        db_status: 'present',
        reconciliation_status: 'db_only',
        mismatch_reasons: [],
        metadata: { db_status: 'published' },
      },
    ];
    const fakeDb = (table) => ({
      insert(payload) {
        calls.push({ table, op: 'insert', payload });
        return { returning: async () => [{ id: 'sync-run-3' }] };
      },
      select: async () => {
        if (table === 'blog_posts') return [];
        if (table === 'content_registry') return previousRows;
        return [];
      },
      where() {
        return {
          orWhere() { return this; },
          select: async () => [],
          update: async (payload) => {
            calls.push({ table, op: 'update', payload });
            return 1;
          },
        };
      },
      whereIn() {
        return { delete: async () => 0 };
      },
    });
    fakeDb.transaction = async (callback) => callback(fakeDb);

    try {
      fs.mkdirSync(path.join(root, 'src', 'content', 'blog'), { recursive: true });
      const result = await registry.runContentRegistrySync({
        astroRoot: root,
        commit: true,
        contentType: 'blog',
        database: fakeDb,
        now: new Date('2026-05-23T12:00:00Z'),
      });

      expect(result.ok).toBe(true);
      const staleUpdates = calls.filter((call) => call.table === 'content_registry'
        && call.op === 'update'
        && call.payload.reconciliation_status === 'source_missing_since_sync');
      expect(staleUpdates).toHaveLength(2);
      expect(staleUpdates[0].payload).toEqual(expect.objectContaining({
        astro_status: 'missing',
        reconciliation_status: 'source_missing_since_sync',
      }));
      expect(staleUpdates.map((call) => call.payload)).toEqual(expect.arrayContaining([
        expect.objectContaining({ astro_status: 'unknown', db_status: 'missing' }),
      ]));
      expect(JSON.parse(staleUpdates[0].payload.mismatch_reasons)).toContain('not_seen_in_latest_sync');
      const completed = calls.find((call) => call.table === 'content_registry_sync_runs'
        && call.op === 'update'
        && call.payload.status === 'completed');
      expect(JSON.parse(completed.payload.summary).by_status.source_missing_since_sync).toBe(2);
      expect(completed.payload.changed_count).toBe(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('commit fails closed when previous registry state cannot be read', async () => {
    const root = makeAstroRoot();
    const calls = [];
    const fakeDb = (table) => ({
      insert(payload) {
        calls.push({ table, op: 'insert', payload });
        return { returning: async () => [{ id: 'sync-run-4' }] };
      },
      select: async () => {
        if (table === 'blog_posts') return [];
        if (table === 'content_registry') throw new Error('previous registry read failed');
        return [];
      },
      where() {
        return {
          update: async (payload) => {
            calls.push({ table, op: 'update', payload });
            return 1;
          },
        };
      },
    });
    fakeDb.transaction = async () => {
      throw new Error('transaction should not start after previous read failure');
    };

    try {
      fs.mkdirSync(path.join(root, 'src', 'content', 'blog'), { recursive: true });
      const result = await registry.runContentRegistrySync({
        astroRoot: root,
        commit: true,
        contentType: 'blog',
        database: fakeDb,
        now: new Date('2026-05-23T12:00:00Z'),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/previous registry read failed/);
      expect(calls).toEqual(expect.arrayContaining([
        expect.objectContaining({
          table: 'content_registry_sync_runs',
          op: 'update',
          payload: expect.objectContaining({ status: 'failed', error_count: 1 }),
        }),
      ]));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('content-type filtered sync does not report unrelated DB blog rows', async () => {
    const root = makeAstroRoot();
    try {
      writeFile(root, 'src/content/services/termite-control.md', `---
title: Termite Control
slug: /termite-control/
---
# Termite Control
`);

      const result = await registry.runContentRegistrySync({
        astroRoot: root,
        contentType: 'service',
        database: (table) => {
          if (table === 'content_registry') return { select: async () => [] };
          throw new Error('blog_posts should not be queried for service-only sync');
        },
      });

      expect(result.ok).toBe(true);
      expect(result.summary).toEqual(expect.objectContaining({
        astro_files_scanned: 1,
        db_rows_scanned: 0,
        astro_only_count: 1,
      }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing Astro root records a failed run without writing registry rows', async () => {
    const calls = [];
    const fakeDb = (table) => ({
      insert(payload) {
        calls.push({ table, op: 'insert', payload });
        return { returning: async () => [{ id: 'sync-run-1' }] };
      },
      where() {
        return {
          update: async (payload) => {
            calls.push({ table, op: 'update', payload });
            return 1;
          },
        };
      },
    });

    const result = await registry.runContentRegistrySync({
      astroRoot: '/tmp/missing-content-registry-root',
      commit: true,
      database: fakeDb,
      now: new Date('2026-05-23T12:00:00Z'),
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('ASTRO_ROOT_MISSING');
    expect(calls.some((call) => call.table === 'content_registry')).toBe(false);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'content_registry_sync_runs', op: 'insert' }),
      expect.objectContaining({
        table: 'content_registry_sync_runs',
        op: 'update',
        payload: expect.objectContaining({ status: 'failed', error_count: 1 }),
      }),
    ]));
  });
});
