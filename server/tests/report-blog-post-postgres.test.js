/**
 * The report's blog search (services/service-report/report-blog-post.js)
 * against real Postgres. Set REPORT_BLOG_SEARCH_TEST_DATABASE_URL to a
 * private database named waves_test (localhost) or waves_qa_<32 hex>; the
 * suite skips without it. It builds its own schema (the two tables the
 * search reads, with the columns it reads) and drops it after.
 *
 *  - Every row holding a word is read and ranked (GitHub Codex P2 on
 *    7568aea485): an older post holding the rare word "tick" is never
 *    dropped for 600 newer posts holding only "control"; and the rarity is
 *    counted over the posts a report may link, read with the frontmatter the
 *    link rule needs (GitHub Codex P2 on 8c57183332: spoke-only rows never
 *    make "tick" look common).
 *  - A portal post is offered and picked only through the registry's row for
 *    it, never the portal's own fields; a row in conflict never comes back;
 *    the post-publish check's 'live_visible' counts as live (GitHub Codex P1s
 *    and P2 on 8c57183332, P2 on 0d357564c5).
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

const { searchReportBlogPosts, resolveReportBlogPostPick, wordsOnTheSite } = require('../services/service-report/report-blog-post');

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
    reconciliation_status: 'matched',
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
      for (const column of ['content_type', 'workflow_status', 'astro_status', 'live_status', 'reconciliation_status']) t.string(column);
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

  test('the registry read ranks an older post holding the rare word above 600 newer ones holding only the common one', async () => {
    const common = Array.from({ length: 600 }, (_, i) => registryRow(`Weed Control Tips ${i}`, { daysAgo: i }));
    const rare = registryRow('Tick Season Guide for Florida Yards', { daysAgo: 2000 });
    await mockPg.batchInsert('content_registry', [...common, rare], 200);
    const posts = await searchReportBlogPosts(mockPg, 'tick control');
    // It holds "tick" but not "control": the closest post, not an exact one.
    expect(posts[0]).toEqual({ id: rare.id, title: rare.title, url: rare.live_url, exact: false });
    expect(posts).toHaveLength(8);
    // Among equals, newest first.
    expect(posts.slice(1).map((post) => post.title)).toEqual(Array.from({ length: 7 }, (_, i) => `Weed Control Tips ${i}`));
  });

  test('a post holding every word outranks the rare word alone; the title outranks the summary', async () => {
    const both = registryRow('Weed Control Around the Lanai', { daysAgo: 300, metadata: { frontmatter: { meta_description: 'Keeping ticks off the lanai too.' } } });
    const tick = registryRow('Tick Season Guide', { daysAgo: 1 });
    const inSummary = registryRow('Spring Yard Checklist', { daysAgo: 0, metadata: { astro: { frontmatter: { description: 'When tick season starts.' } } } });
    await mockPg('content_registry').insert([both, tick, inSummary]);
    expect((await searchReportBlogPosts(mockPg, 'tick control')).map((post) => post.id)).toEqual([both.id, tick.id, inSummary.id]);
  });

  test('spoke-only rows never make the rare word look common: rarity is counted over linkable posts', async () => {
    const spoke = { live_url: '/blog/tick-checks-lawn/', canonical_url: '/blog/tick-checks-lawn/', metadata: { frontmatter: { domains: ['bradentonfllawncare.com'] } } };
    const spokeTicks = [1, 2, 3].map((i) => registryRow(`Tick Checks on the Lawn ${i}`, { ...spoke, live_url: `/blog/tick-checks-lawn-${i}/`, daysAgo: i }));
    const tick = registryRow('Tick Season Guide', { daysAgo: 2000 });
    const control = [1, 2].map((i) => registryRow(`Weed Control Tips ${i}`, { daysAgo: i }));
    await mockPg('content_registry').insert([...spokeTicks, tick, ...control]);
    expect((await searchReportBlogPosts(mockPg, 'tick control')).map((post) => post.id)).toEqual([tick.id, ...control.map((row) => row.id)]);
  });

  test('a portal post is offered and picked only through the registry\'s row for it', async () => {
    const post = portalRow('Ghost Ants After Rain');
    await mockPg('blog_posts').insert(post);
    const search = async () => (await searchReportBlogPosts(mockPg, 'ghost ants')).map((found) => found.url);
    const pick = async () => (await resolveReportBlogPostPick((fn) => fn(mockPg), post.id)).post?.url || null;
    // No registry row yet: never offered or linked on the portal's own fields.
    expect(await search()).toEqual([]);
    expect(await pick()).toBeNull();
    const row = registryRow(post.title, { db_blog_id: post.id, live_url: post.astro_live_url, canonical_url: post.astro_live_url });
    for (const refused of [
      { live_status: 'visibility_review' },
      { live_status: 'live_visible', astro_status: 'missing' },
      { live_url: '/blog/ghost-ants-lawn/', canonical_url: '/blog/ghost-ants-lawn/', metadata: { frontmatter: { domains: ['bradentonfllawncare.com'] } } },
      { reconciliation_status: 'conflict' },
    ]) {
      await mockPg('content_registry').del();
      await mockPg('content_registry').insert({ ...row, ...refused });
      expect(await search()).toEqual([]);
      expect(await pick()).toBeNull();
    }
    // A row the registry links: the registry's post, by its own text.
    await mockPg('content_registry').del();
    await mockPg('content_registry').insert({ ...row, live_status: 'live_visible' });
    expect(await search()).toEqual([post.astro_live_url]);
    expect((await searchReportBlogPosts(mockPg, 'ghost ants'))[0].id).toBe(row.id);
    expect(await pick()).toBe(post.astro_live_url);
  });

  test('the deployed page\'s keyword is searched in real SQL; the database-first keyword column never is', async () => {
    const merged = registryRow('Spring Yard Checklist', { metadata: { astro: { frontmatter: { primary_keyword: 'termite swarmers' } } } });
    const astroOnly = registryRow('Garage Season Notes', { metadata: { frontmatter: { target_keyword: 'swarmers in the garage' } } });
    const dbOnly = registryRow('Lanai Care Basics', { target_keyword: 'termite swarmers' });
    await mockPg('content_registry').insert([merged, astroOnly, dbOnly]);
    expect((await searchReportBlogPosts(mockPg, 'swarmers')).map((post) => post.id).sort()).toEqual([merged.id, astroOnly.id].sort());
  });

  test('in real SQL, a suggestion\'s words are read against every live post (GitHub Codex P1 on 45144528b8)', async () => {
    await mockPg('content_registry').insert([
      registryRow('Standing Water and Mosquitoes'),
      registryRow('Ghost Ant Trails', { metadata: { frontmatter: { description: 'Why ghost ants come in after rain.' } } }),
      registryRow('John Deere Mower Care', { live_status: 'visibility_review' }),
      // Live, but on a spoke only: the link rule refuses it, so it lends no word.
      registryRow('Johnson Grass on the Spoke', { live_url: '/blog/johnson-grass/', canonical_url: '/blog/johnson-grass/', metadata: { frontmatter: { domains: ['bradentonfllawncare.com'] } } }),
    ]);
    expect((await wordsOnTheSite(mockPg, 'standing water')).known).toEqual([true, true]);
    expect((await wordsOnTheSite(mockPg, 'ghost ants after rain')).known).toEqual([true, true, true, true]);
    // A name no live post uses is unknown, even where a post not live holds it.
    expect((await wordsOnTheSite(mockPg, 'ants for john')).known).toEqual([true, false]);
    expect((await wordsOnTheSite(mockPg, 'ants for johnson')).known).toEqual([true, false]);
  });

  test('in real SQL, an empty keyword alias never hides a populated one, and the database copy a merged row falls back to is never read (GitHub Codex P2s on d527cd5de1)', async () => {
    const emptyAlias = registryRow('Spring Yard Checklist', { metadata: { frontmatter: { target_keyword: '', primary_keyword: 'termite swarmers' } } });
    const dbCopy = registryRow('Lanai Care Basics', { title: 'Termite Swarmers (draft)', meta_description: 'Swarmers in spring.', metadata: { astro: { frontmatter: {} } } });
    const described = registryRow('Window Sill Notes', { metadata: { astro: { frontmatter: { description: 'Swarmers at the window sill.' } } } });
    await mockPg('content_registry').insert([emptyAlias, dbCopy, described]);
    const posts = await searchReportBlogPosts(mockPg, 'swarmers');
    expect(posts.map((post) => post.id).sort()).toEqual([emptyAlias.id, described.id].sort());
    expect(posts.find((post) => post.id === emptyAlias.id).title).toBe('Spring Yard Checklist');
  });

  test('a registry post the post-publish check verified live is found and resolves; one in conflict never is', async () => {
    const fresh = registryRow('Ghost Ants After the First Rain', { live_status: 'live_visible' });
    const review = registryRow('Ghost Ant Baits That Work', { live_status: 'visibility_review' });
    const conflict = registryRow('Ghost Ant Season Notes', { reconciliation_status: 'conflict' });
    await mockPg('content_registry').insert([fresh, review, conflict]);
    expect((await searchReportBlogPosts(mockPg, 'ghost ants')).map((post) => post.id)).toEqual([fresh.id]);
    expect((await resolveReportBlogPostPick((fn) => fn(mockPg), fresh.id)).post).toEqual({ id: fresh.id, title: fresh.title, url: fresh.live_url });
    expect(await resolveReportBlogPostPick((fn) => fn(mockPg), review.id)).toEqual({ post: null, rejected: true });
    expect(await resolveReportBlogPostPick((fn) => fn(mockPg), conflict.id)).toEqual({ post: null, rejected: true });
  });
});
