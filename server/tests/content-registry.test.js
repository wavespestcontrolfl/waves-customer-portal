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
    expect(syncCli.resolveSyncConfig({ source: 'github', 'github-ref': 'main' }, {}).astroSource).toBe('github');
    expect(syncCli.resolveSyncConfig({ source: 'auto', 'astro-dir': '/tmp/astro' }, {}).astroSource).toBe('filesystem');
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

  test('keeps Astro route URL separate from canonical target', () => {
    const root = makeAstroRoot();
    try {
      writeFile(root, 'src/content/blog/cure-for-bed-bugs-lakewood-ranch.md', `---
title: Cure for Bed Bugs
slug: "/pest-control/cure-for-bed-bugs-lakewood-ranch/"
canonical: "https://www.wavespestcontrol.com/pest-control/get-rid-of-bed-bugs-lakewood-ranch-fl/"
---
# Cure for Bed Bugs
`);

      const [row] = registry.scanAstroContent(root);
      expect(row.canonical_url_normalized).toBe('/pest-control/get-rid-of-bed-bugs-lakewood-ranch-fl/');
      expect(row.live_url).toBe('/pest-control/cure-for-bed-bugs-lakewood-ranch/');
      expect(row.slug).toBe('cure-for-bed-bugs-lakewood-ranch');
      expect(row.canonical_target_url).toBe('/pest-control/get-rid-of-bed-bugs-lakewood-ranch-fl/');
      expect(registry.isCanonicalizedAstro(row)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('derives author detail routes from the authors collection', () => {
    const root = makeAstroRoot();
    try {
      writeFile(root, 'src/content/authors/adam-benetti.md', `---
name: Adam Benetti
slug: "adam-benetti"
canonical: "https://www.wavespestcontrol.com/about/authors/adam-benetti/"
---
# Adam Benetti
`);

      const [row] = registry.scanAstroContent(root);
      expect(row.content_type).toBe('authors');
      expect(row.canonical_url_normalized).toBe('/about/authors/adam-benetti/');
      expect(row.live_url).toBe('/about/authors/adam-benetti/');
      expect(row.slug).toBe('adam-benetti');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses the homepage route for the Astro homepage service entry', () => {
    const root = makeAstroRoot();
    try {
      writeFile(root, 'src/content/services/ellenton-pest-control.md', `---
title: Waves Pest Control
slug: "ellenton-pest-control"
canonical: "https://www.wavespestcontrol.com/"
---
# Waves Pest Control
`);

      const [row] = registry.scanAstroContent(root);
      expect(row.content_type).toBe('service');
      expect(row.canonical_url_normalized).toBe('/');
      expect(row.live_url).toBe('/');
      expect(row.slug).toBe('ellenton-pest-control');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when Astro root is missing', () => {
    expect(() => registry.scanAstroContent('/tmp/not-a-real-astro-root')).toThrow(/ASTRO_REPO_DIR/);
  });

  test('scans Astro content from GitHub recursively', async () => {
    const listings = {
      'src/content/blog': [
        { type: 'file', path: 'src/content/blog/a.md' },
        { type: 'dir', path: 'src/content/blog/nested' },
        { type: 'file', path: 'src/content/blog/ignore.txt' },
      ],
      'src/content/blog/nested': [
        { type: 'file', path: 'src/content/blog/nested/b.mdx' },
      ],
    };
    const files = {
      'src/content/blog/a.md': `---
title: GitHub A
slug: /github-a/
---
# GitHub A
`,
      'src/content/blog/nested/b.mdx': `---
title: GitHub B
slug: /github-b/
canonical: https://www.wavespestcontrol.com/github-canonical/
---
# GitHub B
`,
    };
    const githubClient = {
      getBranchSha: jest.fn(async () => 'abc123branchsha'),
      listDir: jest.fn(async (dir) => listings[dir] || []),
      getFile: jest.fn(async (filePath) => ({ path: filePath, content: files[filePath] })),
    };

    const rows = await registry.scanAstroContentFromGithub({
      collections: ['blog'],
      ref: 'main',
      githubClient,
    });

    expect(rows.map((row) => row.astro_source_path)).toEqual([
      'src/content/blog/a.md',
      'src/content/blog/nested/b.mdx',
    ]);
    expect(rows[0]).toEqual(expect.objectContaining({
      title: 'GitHub A',
      live_url: '/github-a/',
      astro_repo_sha: 'abc123branchsha',
    }));
    expect(rows[1]).toEqual(expect.objectContaining({
      live_url: '/github-b/',
      canonical_url_normalized: '/github-canonical/',
      astro_repo_sha: 'abc123branchsha',
    }));
    expect(githubClient.listDir).toHaveBeenCalledWith('src/content/blog', 'abc123branchsha');
    expect(githubClient.getFile).toHaveBeenCalledWith('src/content/blog/a.md', 'abc123branchsha');
    expect(githubClient.getFile).toHaveBeenCalledWith('src/content/blog/nested/b.mdx', 'abc123branchsha');
  });

  test('fails closed when GitHub ref cannot be resolved', async () => {
    const githubClient = {
      getBranchSha: jest.fn(async () => null),
      listDir: jest.fn(),
      getFile: jest.fn(),
    };

    await expect(registry.scanAstroContentFromGithub({
      collections: ['blog'],
      ref: 'missing-branch',
      githubClient,
    })).rejects.toThrow(/GitHub Astro ref not found: missing-branch/);
    expect(githubClient.listDir).not.toHaveBeenCalled();
  });

  test('fails closed when GitHub source directory is missing or empty', async () => {
    const githubClient = {
      getBranchSha: jest.fn(async () => 'abc123branchsha'),
      listDir: jest.fn(async () => []),
      getFile: jest.fn(),
    };

    await expect(registry.scanAstroContentFromGithub({
      collections: ['blog'],
      ref: 'main',
      githubClient,
    })).rejects.toThrow(/GitHub Astro directory could not be read or was empty: src\/content\/blog/);
    expect(githubClient.getFile).not.toHaveBeenCalled();
  });

  test('fails closed when a listed GitHub markdown file cannot be read', async () => {
    const githubClient = {
      getBranchSha: jest.fn(async () => 'abc123branchsha'),
      listDir: jest.fn(async () => [{ type: 'file', path: 'src/content/blog/missing.md' }]),
      getFile: jest.fn(async () => null),
    };

    await expect(registry.scanAstroContentFromGithub({
      collections: ['blog'],
      ref: 'main',
      githubClient,
    })).rejects.toThrow(/GitHub Astro file could not be read: src\/content\/blog\/missing.md/);
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

  test('allows intentional canonicalized Astro siblings to match DB rows by slug', () => {
    const astroItems = [
      {
        canonical_url_normalized: '/pest-control/get-rid-of-bed-bugs-lakewood-ranch-fl/',
        canonical_url: 'https://www.wavespestcontrol.com/pest-control/get-rid-of-bed-bugs-lakewood-ranch-fl/',
        live_url: '/pest-control/get-rid-of-bed-bugs-lakewood-ranch-fl/',
        slug: 'get-rid-of-bed-bugs-lakewood-ranch-fl',
        astro_source_path: 'src/content/blog/get-rid-of-bed-bugs-lakewood-ranch-fl.md',
        content_type: 'blog',
        astro_status: 'present',
      },
      {
        canonical_url_normalized: '/pest-control/get-rid-of-bed-bugs-lakewood-ranch-fl/',
        canonical_url: 'https://www.wavespestcontrol.com/pest-control/get-rid-of-bed-bugs-lakewood-ranch-fl/',
        live_url: '/pest-control/cure-for-bed-bugs-lakewood-ranch/',
        slug: 'cure-for-bed-bugs-lakewood-ranch',
        astro_source_path: 'src/content/blog/cure-for-bed-bugs-lakewood-ranch.md',
        content_type: 'blog',
        astro_status: 'present',
      },
    ];
    const dbItems = [
      registry.dbBlogRowToItem({
        id: '00000000-0000-0000-0000-000000000020',
        title: 'Get Rid of Bed Bugs',
        slug: 'get-rid-of-bed-bugs-lakewood-ranch-fl',
        status: 'published',
      }),
      registry.dbBlogRowToItem({
        id: '00000000-0000-0000-0000-000000000021',
        title: 'Cure for Bed Bugs',
        slug: 'cure-for-bed-bugs-lakewood-ranch',
        status: 'published',
      }),
    ];

    const { rows, summary } = registry.reconcileContent({ astroItems, dbItems });
    const bySource = Object.fromEntries(rows.map((row) => [row.astro_source_path, row]));

    expect(rows).toHaveLength(2);
    expect(summary.conflict_count).toBe(0);
    expect(summary.matched_count).toBe(2);
    expect(bySource['src/content/blog/get-rid-of-bed-bugs-lakewood-ranch-fl.md']).toEqual(expect.objectContaining({
      db_blog_id: '00000000-0000-0000-0000-000000000020',
      reconciliation_status: 'matched',
      match_confidence: 'slug',
      live_url: '/pest-control/get-rid-of-bed-bugs-lakewood-ranch-fl/',
    }));
    expect(bySource['src/content/blog/cure-for-bed-bugs-lakewood-ranch.md']).toEqual(expect.objectContaining({
      db_blog_id: '00000000-0000-0000-0000-000000000021',
      reconciliation_status: 'matched',
      match_confidence: 'slug',
      live_url: '/pest-control/cure-for-bed-bugs-lakewood-ranch/',
      canonical_url_normalized: '/pest-control/get-rid-of-bed-bugs-lakewood-ranch-fl/',
    }));
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

  test('archived DB rows do not match Astro files or create active conflicts', () => {
    const astroItems = [{
      canonical_url_normalized: '/legacy-post/',
      slug: 'legacy-post',
      astro_source_path: 'src/content/blog/legacy-post.md',
      content_type: 'blog',
      astro_status: 'present',
    }];
    const dbItems = [
      registry.dbBlogRowToItem({
        id: '00000000-0000-0000-0000-000000000010',
        title: 'Archived Legacy Post',
        slug: 'legacy-post',
        status: 'archived',
      }),
    ];

    const { rows, summary } = registry.reconcileContent({ astroItems, dbItems });
    const astroRow = rows.find((row) => row.astro_source_path);
    const dbRow = rows.find((row) => row.db_blog_id);

    expect(astroRow.reconciliation_status).toBe('astro_only');
    expect(astroRow.db_blog_id).toBeNull();
    expect(dbRow.reconciliation_status).toBe('db_only');
    expect(dbRow.workflow_status).toBe('archived');
    expect(summary.conflict_count).toBe(0);
    expect(summary.matched_count).toBe(0);
  });

  test('archived DB rows stay archived even when old Astro live fields remain', () => {
    const item = registry.dbBlogRowToItem({
      id: '00000000-0000-0000-0000-000000000013',
      title: 'Archived Live Mirror',
      slug: 'archived-live-mirror',
      status: 'archived',
      astro_status: 'live',
      astro_live_url: 'https://www.wavespestcontrol.com/archived-live-mirror/',
    });

    expect(item.workflow_status).toBe('archived');

    const { rows, summary } = registry.reconcileContent({
      astroItems: [{
        canonical_url_normalized: '/archived-live-mirror/',
        slug: 'archived-live-mirror',
        astro_source_path: 'src/content/blog/archived-live-mirror.md',
        content_type: 'blog',
        astro_status: 'present',
      }],
      dbItems: [item],
    });
    const dbRow = rows.find((row) => row.db_blog_id === item.db_blog_id);

    expect(dbRow.workflow_status).toBe('archived');
    expect(dbRow.reconciliation_status).toBe('db_only');
    expect(summary.matched_count).toBe(0);
  });

  test('archived DB rows stay dormant when archive updates change the DB hash', () => {
    const item = registry.dbBlogRowToItem({
      id: '00000000-0000-0000-0000-000000000014',
      title: 'Archived Changed Row',
      slug: 'archived-changed-row',
      status: 'archived',
      updated_at: '2026-05-23T12:00:00Z',
    });
    const previousRows = [{
      db_blog_id: item.db_blog_id,
      db_row_hash: 'old-db-row-hash',
      canonical_url_normalized: item.canonical_url_normalized,
      live_url: item.live_url,
    }];

    const { rows } = registry.reconcileContent({
      astroItems: [],
      dbItems: [item],
      previousRows,
    });

    expect(rows[0].workflow_status).toBe('archived');
    expect(rows[0].reconciliation_status).toBe('db_only');
  });

  test('archived DB duplicate does not block active DB canonical matching', () => {
    const astroItems = [{
      canonical_url_normalized: '/active-post/',
      slug: 'active-post',
      astro_source_path: 'src/content/blog/active-post.md',
      content_type: 'blog',
      astro_status: 'present',
    }];
    const dbItems = [
      registry.dbBlogRowToItem({
        id: '00000000-0000-0000-0000-000000000011',
        title: 'Active Post',
        slug: 'active-post',
        status: 'published',
      }),
      registry.dbBlogRowToItem({
        id: '00000000-0000-0000-0000-000000000012',
        title: 'Archived Duplicate',
        slug: 'active-post',
        status: 'archived',
      }),
    ];

    const { rows, summary } = registry.reconcileContent({ astroItems, dbItems });
    const matched = rows.find((row) => row.astro_source_path);
    const archived = rows.find((row) => row.db_blog_id === '00000000-0000-0000-0000-000000000012');

    expect(matched.reconciliation_status).toBe('matched');
    expect(matched.db_blog_id).toBe('00000000-0000-0000-0000-000000000011');
    expect(archived.reconciliation_status).toBe('db_only');
    expect(archived.workflow_status).toBe('archived');
    expect(summary.conflict_count).toBe(0);
    expect(summary.matched_count).toBe(1);
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

  test('preserves live-check mirror fields across registry syncs for the same URL', () => {
    const astroItems = [{
      canonical_url_normalized: '/same-url/',
      live_url: 'https://www.wavespestcontrol.com/same-url/',
      slug: 'same-url',
      astro_source_path: 'src/content/blog/same-url.md',
      content_type: 'blog',
      astro_status: 'present',
      astro_file_hash: 'same',
    }];
    const previousRows = [{
      astro_source_path: 'src/content/blog/same-url.md',
      canonical_url_normalized: '/same-url/',
      live_url: 'https://www.wavespestcontrol.com/same-url/',
      http_status: '301',
      live_status: 'redirected',
      redirect_target_url: 'https://www.wavespestcontrol.com/canonical-url/',
      canonical_target_url: 'https://www.wavespestcontrol.com/canonical-url/',
      noindex_detected: false,
      sitemap_present: true,
      sitemap_status: 'present',
      astro_file_hash: 'same',
    }];

    const row = registry.reconcileContent({ astroItems, previousRows }).rows[0];
    expect(row).toEqual(expect.objectContaining({
      http_status: '301',
      live_status: 'redirected',
      redirect_target_url: 'https://www.wavespestcontrol.com/canonical-url/',
      canonical_target_url: 'https://www.wavespestcontrol.com/canonical-url/',
      sitemap_present: true,
      sitemap_status: 'present',
    }));
  });

  test('does not preserve live-check mirror fields after target URL changes', () => {
    const row = registry.reconcileContent({
      astroItems: [{
        canonical_url_normalized: '/new-url/',
        live_url: 'https://www.wavespestcontrol.com/new-url/',
        slug: 'new-url',
        astro_source_path: 'src/content/blog/post.md',
        content_type: 'blog',
        astro_status: 'present',
      }],
      previousRows: [{
        astro_source_path: 'src/content/blog/post.md',
        canonical_url_normalized: '/old-url/',
        live_url: 'https://www.wavespestcontrol.com/old-url/',
        http_status: '301',
        live_status: 'redirected',
        sitemap_present: true,
      }],
    }).rows[0];

    expect(row.http_status).toBe('unknown');
    expect(row.live_status).toBe('unknown');
    expect(row.sitemap_present).toBeNull();
  });

  test('does not preserve live-check mirror fields when URL is gained or lost', () => {
    const gained = registry.preserveLiveMirrorFields(
      { canonical_url_normalized: '/new-url/', astro_source_path: 'src/content/blog/post.md' },
      {
        byAstroPath: new Map([['src/content/blog/post.md', {
          astro_source_path: 'src/content/blog/post.md',
          http_status: '200',
          live_status: 'live',
        }]]),
        byDbId: new Map(),
      },
    );
    const lost = registry.preserveLiveMirrorFields(
      { astro_source_path: 'src/content/blog/post.md' },
      {
        byAstroPath: new Map([['src/content/blog/post.md', {
          astro_source_path: 'src/content/blog/post.md',
          canonical_url_normalized: '/old-url/',
          http_status: '200',
          live_status: 'live',
        }]]),
        byDbId: new Map(),
      },
    );

    expect(gained.http_status).toBeUndefined();
    expect(gained.live_status).toBeUndefined();
    expect(lost.http_status).toBeUndefined();
    expect(lost.live_status).toBeUndefined();
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

  test('commit can sync from GitHub when Astro root is unavailable', async () => {
    const calls = [];
    const fakeDb = (table) => ({
      insert(payload) {
        calls.push({ table, op: 'insert', payload });
        return {
          returning: async () => (table === 'content_registry_sync_runs'
            ? [{ id: 'sync-run-github' }]
            : [{ id: 'registry-row-github' }]),
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
        return { delete: async () => 0 };
      },
    });
    fakeDb.transaction = async (callback) => callback(fakeDb);
    const githubClient = {
      env: () => ({ owner: 'wavespestcontrolfl', repo: 'wavespestcontrol-astro', defaultBranch: 'main' }),
      getBranchSha: jest.fn(async () => 'github-commit-sha'),
      listDir: jest.fn(async (dir) => (dir === 'src/content/blog'
        ? [{ type: 'file', path: 'src/content/blog/github-post.md' }]
        : [])),
      getFile: jest.fn(async () => ({
        path: 'src/content/blog/github-post.md',
        content: `---
title: GitHub Post
slug: /github-post/
---
# GitHub Post
`,
      })),
    };

    const result = await registry.runContentRegistrySync({
      astroRoot: null,
      astroSource: 'github',
      githubRef: 'main',
      githubClient,
      commit: true,
      contentType: 'blog',
      database: fakeDb,
      now: new Date('2026-05-23T12:00:00Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('github');
    expect(result.summary.astro_files_scanned).toBe(1);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'content_registry_sync_runs',
        op: 'insert',
        payload: expect.objectContaining({
          astro_root: 'github:wavespestcontrolfl/wavespestcontrol-astro@main',
        }),
      }),
    ]));
    const completed = calls.find((call) => call.table === 'content_registry_sync_runs'
      && call.op === 'update'
      && call.payload.status === 'completed');
    expect(completed.payload.astro_repo_sha).toBe('github-commit-sha');
  });

  test('commit GitHub sync fails closed without marking registry rows missing when source is unavailable', async () => {
    const calls = [];
    const fakeDb = (table) => ({
      insert(payload) {
        calls.push({ table, op: 'insert', payload });
        return {
          returning: async () => (table === 'content_registry_sync_runs'
            ? [{ id: 'sync-run-github-failed' }]
            : [{ id: 'registry-row-should-not-write' }]),
        };
      },
      select: async () => [],
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
    const githubClient = {
      env: () => ({ owner: 'wavespestcontrolfl', repo: 'wavespestcontrol-astro', defaultBranch: 'main' }),
      getBranchSha: jest.fn(async () => 'github-commit-sha'),
      listDir: jest.fn(async () => []),
      getFile: jest.fn(),
    };

    const result = await registry.runContentRegistrySync({
      astroRoot: null,
      astroSource: 'github',
      githubRef: 'main',
      githubClient,
      commit: true,
      contentType: 'blog',
      database: fakeDb,
      now: new Date('2026-05-23T12:00:00Z'),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/GitHub Astro directory could not be read or was empty/);
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
