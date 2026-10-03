/**
 * The report's blog search (services/service-report/report-blog-post.js)
 * against real Postgres. Set REPORT_BLOG_SEARCH_TEST_DATABASE_URL to a
 * private database named waves_test (localhost) or waves_qa_<32 hex>; the
 * suite skips without it. It builds its own schema (the two tables the
 * search reads, with the columns it reads) and drops it after.
 *
 *  - Each source's read cap keeps its rows by the ranking the results use
 *    (GitHub Codex P2 on 7568aea485): an older post holding the rare word
 *    "tick" is never dropped for 500+ newer posts holding only "control".
 *  - The registry judges a portal post only by a live check since the post
 *    went live, on the driver's own timestamps (a check half a second before
 *    the post went live is older news); the post-publish check's
 *    'live_visible' counts as live (GitHub Codex P2 on 7568aea485).
 */
jest.mock('../models/db', () => new Proxy((...args) => mockPg(...args), {
  get: (_, key) => (typeof mockPg[key] === 'function' ? mockPg[key].bind(mockPg) : mockPg[key]),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const knex = require('knex');
const { randomBytes, randomUUID } = require('node:crypto');

const connection = process.env.REPORT_BLOG_SEARCH_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let mockPg;
jest.setTimeout(60000);

const { searchReportBlogPosts, resolveReportBlogPostPick } = require('../services/service-report/report-blog-post');

const HUB = 'https://www.wavespestcontrol.com';
const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 30, 12);

const registryRow = (title, { daysAgo = 0, ...change } = {}) => {
  const id = randomUUID();
  const url = `${HUB}/blog/${id}/`;
  return {
    id,
    db_blog_id: null,
    title,
    h1: title,
    meta_description: '',
    target_keyword: '',
    live_url: url,
    canonical_url: url,
    canonical_url_normalized: `/blog/${id}/`,
    content_type: 'blog',
    workflow_status: 'published',
    astro_status: 'present',
    live_status: 'live',
    live_status_checked_at: null,
    noindex_detected: false,
    metadata: {},
    published_at: new Date(NOW - daysAgo * DAY),
    ...change,
  };
};
const portalRow = (title, { daysAgo = 0, ...change } = {}) => {
  const id = randomUUID();
  return {
    id,
    title,
    status: 'published',
    astro_status: 'live',
    astro_live_url: `${HUB}/pest-control/${id}/`,
    astro_published_at: new Date(NOW - daysAgo * DAY),
    meta_description: '',
    keyword: '',
    ...change,
  };
};

postgres('report blog search on Postgres', () => {
  const schema = `rbp_${randomBytes(8).toString('hex')}`;
  let admin;

  beforeAll(async () => {
    const url = new URL(connection);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!local && !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) throw new Error('Use the verified private dev database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    await admin.raw('CREATE SCHEMA ??', [schema]);
    await admin.schema.withSchema(schema).createTable('content_registry', (t) => {
      t.uuid('id').primary();
      t.uuid('db_blog_id');
      for (const column of ['title', 'h1', 'meta_description', 'target_keyword', 'live_url', 'canonical_url', 'canonical_url_normalized']) t.text(column);
      for (const column of ['content_type', 'workflow_status', 'astro_status', 'live_status']) t.string(column);
      t.timestamp('live_status_checked_at', { useTz: true });
      t.boolean('noindex_detected');
      t.jsonb('metadata');
      t.timestamp('published_at', { useTz: true });
    });
    await admin.schema.withSchema(schema).createTable('blog_posts', (t) => {
      t.uuid('id').primary();
      for (const column of ['title', 'astro_live_url', 'meta_description', 'keyword']) t.text(column);
      for (const column of ['status', 'astro_status']) t.string(column);
      t.timestamp('astro_published_at', { useTz: true });
    });
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 4 } });
  });

  afterAll(async () => {
    if (mockPg) await mockPg.destroy();
    if (admin) {
      await admin.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    await mockPg('content_registry').del();
    await mockPg('blog_posts').del();
  });

  test('the registry\'s read cap keeps an older post holding the rare word over 600 newer ones holding only the common one', async () => {
    const common = Array.from({ length: 600 }, (_, i) => registryRow(`Weed Control Tips ${i}`, { daysAgo: i }));
    const rare = registryRow('Tick Season Guide for Florida Yards', { daysAgo: 2000 });
    await mockPg.batchInsert('content_registry', [...common, rare], 200);
    const posts = await searchReportBlogPosts(mockPg, 'tick control');
    expect(posts[0]).toEqual({ id: rare.id, title: rare.title, url: rare.live_url });
    expect(posts).toHaveLength(8);
    // Among equals, newest first.
    expect(posts.slice(1).map((post) => post.title)).toEqual(Array.from({ length: 7 }, (_, i) => `Weed Control Tips ${i}`));
  });

  test('the portal\'s read cap does the same', async () => {
    const common = Array.from({ length: 600 }, (_, i) => portalRow(`Weed Control Tips ${i}`, { daysAgo: i }));
    const rare = portalRow('Tick Season Guide for Florida Yards', { daysAgo: 2000 });
    await mockPg.batchInsert('blog_posts', [...common, rare], 200);
    const posts = await searchReportBlogPosts(mockPg, 'tick control');
    expect(posts[0]).toEqual({ id: rare.id, title: rare.title, url: rare.astro_live_url });
  });

  test('a post holding every word outranks the rare word alone; the title outranks the summary', async () => {
    const both = registryRow('Weed Control Around the Lanai', { daysAgo: 300, meta_description: 'Keeping ticks off the lanai too.' });
    const tick = registryRow('Tick Season Guide', { daysAgo: 1 });
    const inSummary = registryRow('Spring Yard Checklist', { daysAgo: 0, meta_description: 'When tick season starts.' });
    await mockPg('content_registry').insert([both, tick, inSummary]);
    expect((await searchReportBlogPosts(mockPg, 'tick control')).map((post) => post.id)).toEqual([both.id, tick.id, inSummary.id]);
  });

  test('a portal post the registry has not judged since it went live is found; one it found gone since is not', async () => {
    const wentLive = new Date(Date.UTC(2026, 8, 20, 12, 0, 0, 800));
    const post = portalRow('Ghost Ants After Rain', { astro_published_at: wentLive });
    await mockPg('blog_posts').insert(post);
    const check = (checkedAt, change = {}) => registryRow(post.title, {
      db_blog_id: post.id, live_url: post.astro_live_url, canonical_url: post.astro_live_url, live_status: 'not_found', live_status_checked_at: checkedAt, ...change,
    });
    const search = async () => (await searchReportBlogPosts(mockPg, 'ghost ants')).map((found) => found.url);
    const pick = async () => (await resolveReportBlogPostPick((fn) => fn(mockPg), post.id)).post?.url || null;

    // Checked half a second before it went live: older news.
    await mockPg('content_registry').insert(check(new Date(wentLive.getTime() - 500)));
    expect(await search()).toEqual([post.astro_live_url]);
    expect(await pick()).toBe(post.astro_live_url);

    // Found gone half a second after: refused.
    await mockPg('content_registry').update({ live_status_checked_at: new Date(wentLive.getTime() + 500) });
    expect(await search()).toEqual([]);
    expect(await pick()).toBeNull();

    // The post-publish check's verdict on a row synced before the post existed.
    await mockPg('content_registry').del();
    await mockPg('content_registry').insert(check(null, { live_status: 'live_visible', astro_status: 'missing' }));
    expect(await search()).toEqual([post.astro_live_url]);
    expect(await pick()).toBe(post.astro_live_url);
  });

  test('a registry post the post-publish check verified live is found and resolves before the sweep looks', async () => {
    const fresh = registryRow('Ghost Ants After the First Rain', { live_status: 'live_visible' });
    const review = registryRow('Ghost Ant Baits That Work', { live_status: 'visibility_review' });
    await mockPg('content_registry').insert([fresh, review]);
    expect((await searchReportBlogPosts(mockPg, 'ghost ants')).map((post) => post.id)).toEqual([fresh.id]);
    expect((await resolveReportBlogPostPick((fn) => fn(mockPg), fresh.id)).post).toEqual({ id: fresh.id, title: fresh.title, url: fresh.live_url });
    expect(await resolveReportBlogPostPick((fn) => fn(mockPg), review.id)).toEqual({ post: null, rejected: true });
  });
});
