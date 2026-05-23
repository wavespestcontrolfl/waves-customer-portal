jest.mock('../models/db', () => jest.fn());

const archiveCli = require('../scripts/archive-stale-blog-rows');

function fakeDatabase(rows = []) {
  const updates = [];
  const locks = [];
  function queryFor(table) {
    if (table === 'content_registry as cr') {
      return {
        leftJoin() { return this; },
        select() { return this; },
        whereNotNull() { return this; },
        whereIn() { return this; },
        where() { return this; },
        whereNot() { return this; },
        limit() { return this; },
        orderBy() { return this; },
        forUpdate() { return this; },
        then(resolve, reject) {
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
    }
    if (table === 'blog_posts' || table === 'content_registry') {
      return {
        whereIn(_field, ids) {
          this.ids = ids;
          return this;
        },
        forUpdate() {
          locks.push({ table, ids: this.ids });
          return this;
        },
        then(resolve, reject) {
          return Promise.resolve([]).then(resolve, reject);
        },
        update(payload) {
          updates.push({ table, ids: this.ids, payload });
          return Promise.resolve(this.ids?.length || 0);
        },
      };
    }
    throw new Error(`Unexpected table ${table}`);
  }
  queryFor.transaction = async (callback) => callback(queryFor);
  queryFor.updates = updates;
  queryFor.locks = locks;
  return queryFor;
}

describe('archive stale blog rows script helpers', () => {
  test('parses args and IDs', () => {
    expect(archiveCli.parseArgs([
      '--ids=a,b',
      '--allow-published',
      '--limit',
      '25',
    ])).toEqual({
      ids: 'a,b',
      'allow-published': true,
      limit: '25',
    });
    expect(archiveCli.splitList('a, b,,c')).toEqual(['a', 'b', 'c']);
    expect(archiveCli.uniqueList(['a', 'a', 'b'])).toEqual(['a', 'b']);
  });

  test('blocks unsafe archive rows by default', () => {
    expect(archiveCli.blockersForRow({
      registry_id: 'registry-1',
      blog_id: 'blog-1',
      live_status: 'missing',
      registry_workflow_status: 'published',
      blog_status: 'published',
    })).toContain('published_requires_allow_published');

    expect(archiveCli.blockersForRow({
      registry_id: 'registry-2',
      blog_id: 'blog-2',
      live_status: 'redirected',
      registry_workflow_status: 'draft',
      blog_status: 'draft',
    })).toContain('live_status_redirected');

    expect(archiveCli.blockersForRow({
      registry_id: 'registry-3',
      blog_id: 'blog-3',
      live_status: 'missing',
      astro_source_path: 'src/content/blog/live.md',
      registry_workflow_status: 'draft',
      blog_status: 'draft',
    })).toContain('has_astro_source');

    expect(archiveCli.blockersForRow({
      registry_id: 'registry-4',
      blog_id: 'blog-4',
      live_status: 'missing',
      astro_status: 'pr_open',
      registry_workflow_status: 'draft',
      blog_status: 'draft',
    })).toContain('astro_status_pr-open');

    expect(archiveCli.blockersForRow({
      registry_id: 'registry-4b',
      blog_id: 'blog-4b',
      live_status: 'missing',
      astro_status: 'build_failed',
      astro_pr_number: 123,
      astro_branch_name: 'publish/blog-post',
      registry_workflow_status: 'draft',
      blog_status: 'draft',
    })).toEqual(expect.arrayContaining(['astro_status_build-failed', 'has_astro_pr_state']));

    expect(archiveCli.blockersForRow({
      registry_id: 'registry-5',
      blog_id: 'blog-5',
      live_status: 'missing',
      astro_live_url: 'https://www.wavespestcontrol.com/old-post/',
      registry_workflow_status: 'draft',
      blog_status: 'draft',
    })).toContain('has_astro_live_url');

    expect(archiveCli.blockersForRow({
      registry_id: 'registry-6',
      blog_id: 'blog-6',
      live_status: 'missing',
      publish_status: 'pending_review',
      registry_workflow_status: 'draft',
      blog_status: 'draft',
    })).toContain('publish_status_pending-review');

    expect(archiveCli.blockersForRow({
      registry_id: 'registry-7',
      blog_id: 'blog-7',
      live_status: 'missing',
      scheduled_publish_at: '2026-05-24T12:00:00Z',
      registry_workflow_status: 'draft',
      blog_status: 'draft',
    })).toContain('has_scheduled_publish_at');
  });

  test('commit requires explicit ids', async () => {
    const result = await archiveCli.archiveStaleBlogRows({
      database: fakeDatabase([]),
      commit: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/explicit --ids/);
  });

  test('commit blocks published rows unless allowed', async () => {
    const database = fakeDatabase([{
      registry_id: 'registry-1',
      blog_id: 'blog-1',
      live_status: 'missing',
      registry_workflow_status: 'published',
      blog_status: 'published',
    }]);

    const result = await archiveCli.archiveStaleBlogRows({
      database,
      ids: ['blog-1'],
      commit: true,
    });

    expect(result.ok).toBe(false);
    expect(result.summary.updated_count).toBe(0);
    expect(database.updates).toHaveLength(0);
  });

  test('commit blocks rows with active Astro publish state', async () => {
    const database = fakeDatabase([{
      registry_id: 'registry-1',
      blog_id: 'blog-1',
      live_status: 'missing',
      registry_workflow_status: 'draft',
      blog_status: 'draft',
      astro_status: 'merged',
      astro_live_url: null,
    }]);

    const result = await archiveCli.archiveStaleBlogRows({
      database,
      ids: ['blog-1'],
      commit: true,
    });

    expect(result.ok).toBe(false);
    expect(result.rows[0].blockers).toContain('astro_status_merged');
    expect(database.updates).toHaveLength(0);
  });

  test('commit blocks rows with failed Astro PR state', async () => {
    const database = fakeDatabase([{
      registry_id: 'registry-1',
      blog_id: 'blog-1',
      live_status: 'missing',
      registry_workflow_status: 'draft',
      blog_status: 'draft',
      astro_status: 'build_failed',
      astro_pr_number: 27,
      astro_branch_name: 'content/blog-failed',
      astro_live_url: null,
    }]);

    const result = await archiveCli.archiveStaleBlogRows({
      database,
      ids: ['blog-1'],
      commit: true,
    });

    expect(result.ok).toBe(false);
    expect(result.rows[0].blockers).toEqual(expect.arrayContaining([
      'astro_status_build-failed',
      'has_astro_pr_state',
    ]));
    expect(database.updates).toHaveLength(0);
  });

  test('commit fails when explicit rows disappear before transactional validation', async () => {
    const database = fakeDatabase([]);

    const result = await archiveCli.archiveStaleBlogRows({
      database,
      ids: ['blog-1'],
      commit: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
    expect(database.updates).toHaveLength(0);
  });

  test('commit blocks rows with an Astro live URL even when status is stale', async () => {
    const database = fakeDatabase([{
      registry_id: 'registry-1',
      blog_id: 'blog-1',
      live_status: 'missing',
      registry_workflow_status: 'draft',
      blog_status: 'draft',
      astro_status: 'build_failed',
      astro_live_url: 'https://www.wavespestcontrol.com/old-post/',
    }]);

    const result = await archiveCli.archiveStaleBlogRows({
      database,
      ids: ['blog-1'],
      commit: true,
    });

    expect(result.ok).toBe(false);
    expect(result.rows[0].blockers).toContain('has_astro_live_url');
    expect(database.updates).toHaveLength(0);
  });

  test('commit blocks rows still in the publishing queue', async () => {
    const database = fakeDatabase([{
      registry_id: 'registry-1',
      blog_id: 'blog-1',
      live_status: 'missing',
      registry_workflow_status: 'draft',
      blog_status: 'draft',
      publish_status: 'scheduled',
    }]);

    const result = await archiveCli.archiveStaleBlogRows({
      database,
      ids: ['blog-1'],
      commit: true,
    });

    expect(result.ok).toBe(false);
    expect(result.rows[0].blockers).toContain('publish_status_scheduled');
    expect(database.updates).toHaveLength(0);
  });

  test('commit blocks rows with a scheduled publish timestamp', async () => {
    const database = fakeDatabase([{
      registry_id: 'registry-1',
      blog_id: 'blog-1',
      live_status: 'missing',
      registry_workflow_status: 'draft',
      blog_status: 'draft',
      publish_status: null,
      scheduled_publish_at: new Date('2026-05-24T12:00:00Z'),
    }]);

    const result = await archiveCli.archiveStaleBlogRows({
      database,
      ids: ['blog-1'],
      commit: true,
    });

    expect(result.ok).toBe(false);
    expect(result.rows[0].blockers).toContain('has_scheduled_publish_at');
    expect(database.updates).toHaveLength(0);
  });

  test('commit archives explicit safe rows and updates registry mirror', async () => {
    const database = fakeDatabase([{
      registry_id: 'registry-1',
      blog_id: 'blog-1',
      live_status: 'missing',
      registry_workflow_status: 'draft',
      blog_status: 'draft',
      blog_title: 'Draft to archive',
    }]);
    const now = new Date('2026-05-23T12:00:00Z');

    const result = await archiveCli.archiveStaleBlogRows({
      database,
      ids: ['blog-1'],
      commit: true,
      now,
    });

    expect(result.ok).toBe(true);
    expect(result.summary.updated_count).toBe(1);
    expect(database.locks).toEqual([
      { table: 'content_registry', ids: ['blog-1'] },
      { table: 'blog_posts', ids: ['blog-1'] },
    ]);
    expect(database.updates).toEqual([
      {
        table: 'blog_posts',
        ids: ['blog-1'],
        payload: {
          status: 'archived',
          publish_status: null,
          updated_at: now,
        },
      },
      {
        table: 'content_registry',
        ids: ['blog-1'],
        payload: {
          workflow_status: 'archived',
          reconciliation_status: 'db_only',
          match_confidence: 'none',
          mismatch_reasons: JSON.stringify([]),
          updated_at: now,
        },
      },
    ]);
  });
});
