/**
 * A Waves blog post on the service report (GATE_REPORT_BLOG_POST, owner "ok
 * go" 2026-10-01): the one link rule (report-blog-post.js), the completion
 * forms' search (GET /admin/dispatch/:serviceId/blog-posts), the freeze at
 * completion and the report payload.
 *
 *  - A report links only a post live on the hub, at its live URL on the
 *    site's own host: a content registry row the daily sweep verified live
 *    on the hub, or a portal post stamped live; never a draft, a
 *    merged-but-not-live post, a spoke-only post or another host.
 *  - The search reads the site's live posts by title, headline, summary and
 *    keyword, a word in its singular or plural as a whole word, best match
 *    first (owner 2026-10-02: it found almost nothing).
 *  - The search is dark with the gate off and reads only the technician's
 *    own current visit.
 *  - The pick is frozen at completion for every service but WDO, termite
 *    pre-treat, lawn and tree, shrub & palm (blogPostAllowedFor, the
 *    search's rule too), and one that is not live is an actionable 400
 *    before any write.
 *  - The report shows a frozen post only while the gate is on.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

let mockDbCurrent = null;
jest.mock('../models/db', () => {
  const defaultChain = () => {
    const chain = {};
    for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhereRaw', 'andWhere', 'orWhere', 'join', 'leftJoin', 'select', 'orderBy', 'orderByRaw', 'groupBy', 'limit', 'offset']) chain[m] = () => chain;
    chain.first = async () => null;
    chain.then = (resolve) => Promise.resolve([]).then(resolve);
    chain.catch = () => chain;
    return chain;
  };
  const proxy = (...args) => (mockDbCurrent ? mockDbCurrent(...args) : defaultChain());
  proxy.transaction = () => Promise.resolve();
  proxy.raw = (sql) => ({ toString: () => sql });
  proxy.fn = { now: () => new Date() };
  proxy.schema = { hasTable: async () => true, hasColumn: async () => true };
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/job-costing', () => ({
  calculateJobCost: jest.fn(async () => ({})),
  resolveServiceRecord: jest.requireActual('../services/job-costing').resolveServiceRecord,
}));
jest.mock('../services/time-tracking', () => ({ adminEditEntry: jest.fn(async () => ({})) }));
const mockResolveProfile = jest.fn();
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: (...args) => mockResolveProfile(...args),
}));

const fs = require('fs');
const path = require('path');
const {
  blogPostAllowedFor, reportBlogLink, searchReportBlogPosts, resolveReportBlogPostPick, frozenBlogPost, searchTerms, registryLink,
} = require('../services/service-report/report-blog-post');
const router = require('../routes/admin-dispatch');

const LIVE = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'How to Get Rid of Ghost Ants in Sarasota Without Losing Your Mind',
  status: 'published',
  astro_status: 'live',
  astro_live_url: 'https://www.wavespestcontrol.com/pest-control/get-rid-of-ghost-ants-in-sarasota/',
};

// A content registry row the daily live sweep verified on the hub.
const REGISTRY_LIVE = {
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Ghost Ant Control in Sarasota: What Actually Works',
  h1: 'Ghost Ant Control in Sarasota',
  meta_description: 'Tiny ghost ants trail along counters after rain. Here is how we treat them.',
  target_keyword: 'ghost ant control sarasota',
  live_url: 'https://www.wavespestcontrol.com/pest-control/ghost-ant-control-sarasota/',
  canonical_url: 'https://www.wavespestcontrol.com/pest-control/ghost-ant-control-sarasota/',
  canonical_url_normalized: '/pest-control/ghost-ant-control-sarasota/',
  content_type: 'blog',
  workflow_status: 'published',
  astro_status: 'present',
  live_status: 'live',
  noindex_detected: false,
  metadata: {},
  published_at: '2026-08-01T00:00:00Z',
};
const registryRow = (id, title, change = {}) => ({
  ...REGISTRY_LIVE,
  id,
  title,
  h1: title,
  meta_description: '',
  target_keyword: '',
  live_url: `https://www.wavespestcontrol.com/blog/${id}/`,
  canonical_url: `https://www.wavespestcontrol.com/blog/${id}/`,
  canonical_url_normalized: `/blog/${id}/`,
  ...change,
});

afterEach(() => {
  mockDbCurrent = null;
  jest.clearAllMocks();
});

// Owner ruling 2026-10-02: every service but WDO, termite pre-treat, lawn
// and tree, shrub & palm.
describe('blogPostAllowedFor', () => {
  test.each([
    ['Quarterly Pest Control', null],
    ['Rodent Trap Check', { serviceKey: 'rodent_trapping' }],
    ['Mosquito Control', { serviceKey: 'mosquito_monthly' }],
    ['Bed Bug Treatment', { serviceKey: 'bed_bug_treatment' }],
    ['Termite Bait Station Monitoring', { serviceKey: 'termite_bait_monitoring' }],
    ['Liquid Termite Treatment', { serviceKey: 'termite_liquid', projectType: 'termite_treatment' }],
    ['Termite Inspection', { serviceKey: 'termite_inspection' }],
  ])('%s carries a post', (serviceType, profile) => {
    expect(blogPostAllowedFor({ serviceType, profile })).toBe(true);
  });

  test.each([
    ['WDO Inspection (Termite Letter)', { serviceKey: 'wdo_inspection', projectType: 'wdo_inspection' }],
    ['Termite Inspection', { serviceKey: 'wdo_inspection' }],
    ['Pre-Slab Termite Treatment', { serviceKey: 'termite_slab_pretreat', projectType: 'pre_treatment_termite_certificate' }],
    ['Termite Pre-Treatment', { serviceKey: 'termite_pretreatment' }],
    ['WDO Inspection', null],
    ['New Construction Termite Pretreat', null],
    ['Lawn Care', { serviceKey: 'lawn_care' }],
    ['Tree & Shrub Care', null],
    ['Palm Injection', null],
    ['Pest Control', { serviceKey: 'pest_general', requiresProject: true }],
    ['Pest Control', { serviceKey: 'pest_general', projectBacked: true }],
  ])('%s carries none', (serviceType, profile) => {
    expect(blogPostAllowedFor({ serviceType, profile })).toBe(false);
  });

  // The customer never gets a report there, so the post could never be seen
  // (resolveCompletionDeliveryPosture, the completion's own). Codex #5547.
  test.each([
    ['Waves Assessment', { serviceKey: 'waves_assessment', completionMode: 'internal_only' }],
    ['Mosquito Misting Consultation', { serviceKey: 'mosquito_misting_assessment', completionMode: 'internal_only' }],
    ['Pest Control', { serviceKey: 'pest_general', deliveryMode: 'disabled' }],
    ['Pest Control', { serviceKey: 'pest_general', deliveryMode: 'internal_only' }],
    ['Rodent Trapping Service', { serviceKey: 'rodent_trapping', findingsType: 'rodent_trapping', deliveryMode: 'internal_only' }],
  ])('%s with a report the customer never gets carries none', (serviceType, profile) => {
    expect(blogPostAllowedFor({ serviceType, profile })).toBe(false);
  });

  test('a typed service that auto-sends its report carries one', () => {
    expect(blogPostAllowedFor({ serviceType: 'Rodent Trapping Service', profile: { serviceKey: 'rodent_trapping', findingsType: 'rodent_trapping', deliveryMode: 'auto_send' } })).toBe(true);
  });
});

describe('reportBlogLink', () => {
  test('a published post live on the hub links at its live URL', () => {
    expect(reportBlogLink(LIVE)).toEqual({ id: LIVE.id, title: LIVE.title, url: LIVE.astro_live_url });
  });

  test.each([
    ['a draft', { status: 'draft' }],
    ['a post merged but not live yet', { astro_status: 'merged' }],
    ['a post with no live URL', { astro_live_url: null }],
    ['a URL on another host', { astro_live_url: 'https://example.com/pest-control/ghost-ants/' }],
    ['a spoke-looking host', { astro_live_url: 'https://wavespestcontrol.com.example.net/x/' }],
    ['no title', { title: '  ' }],
  ])('%s never links', (_label, change) => {
    expect(reportBlogLink({ ...LIVE, ...change })).toBeNull();
  });
});

describe('registryLink', () => {
  test('a row the sweep verified live on the hub links at its live URL', () => {
    expect(registryLink(REGISTRY_LIVE)).toEqual({ id: REGISTRY_LIVE.id, title: REGISTRY_LIVE.title, url: REGISTRY_LIVE.live_url });
  });

  test.each([
    ['not live', { live_status: 'not_found' }],
    ['not published', { workflow_status: 'draft' }],
    ['noindex', { noindex_detected: true }],
    ['a spoke site only', { live_url: 'https://bradentonfllawncare.com/blog/ghost-ants/', canonical_url: 'https://bradentonfllawncare.com/blog/ghost-ants/' }],
    ['no title', { title: ' ', h1: '' }],
  ])('%s never links', (_label, change) => {
    expect(registryLink({ ...REGISTRY_LIVE, ...change })).toBeNull();
  });
});

describe('searchTerms', () => {
  const words = (query) => searchTerms(query).map((term) => term.word);
  test('words of three characters or more in their singular, punctuation and filler words dropped, each once, at most four', () => {
    expect(words('Ghost  ANTS!')).toEqual(['ghost', 'ant']);
    expect(words('how to get rid of roaches')).toEqual(['roach']);
    expect(words('a % _ ants')).toEqual(['ant']);
    expect(words('roach roaches')).toEqual(['roach']);
    expect(words('fleas ticks mosquitoes flies spiders')).toEqual(['flea', 'tick', 'mosquito', 'fly']);
    expect(words('')).toEqual([]);
  });

  test('a singular that ends in s keeps its own plural (GitHub Codex P2 on #5652)', () => {
    expect(searchTerms('virus')[0].forms).toEqual(expect.arrayContaining(['virus', 'viruses']));
    expect(searchTerms('mantis')[0].forms).toEqual(expect.arrayContaining(['mantis', 'mantises']));
    expect(searchTerms('pest')[0].forms).toEqual(expect.arrayContaining(['pest', 'pests']));
  });

  test('each word carries the forms a post may use for it', () => {
    expect(searchTerms('roaches')[0].forms).toEqual(expect.arrayContaining(['roach', 'roaches']));
    expect(searchTerms('fly')[0].forms).toEqual(expect.arrayContaining(['fly', 'flies']));
    expect(searchTerms('mosquito')[0].forms).toEqual(expect.arrayContaining(['mosquito', 'mosquitoes', 'mosquitos']));
  });
});

// A query builder that records what it was asked and answers each table's
// rows (the SQL filter is the database's; the rows given are what it found).
function recordingKnex(rowsByTable) {
  const calls = [];
  const knex = (table) => {
    calls.push(['table', table]);
    const chain = {};
    const rec = (name) => (...args) => {
      if (typeof args[0] === 'function') {
        const inner = { whereRaw: (...a) => { calls.push([`${table} inner whereRaw`, ...a]); return inner; }, orWhereRaw: (...a) => { calls.push([`${table} inner orWhereRaw`, ...a]); return inner; } };
        args[0].call(inner);
      } else {
        calls.push([`${table} ${name}`, ...args]);
      }
      return chain;
    };
    for (const m of ['where', 'whereNotNull', 'whereRaw', 'orderByRaw', 'orderBy', 'limit']) chain[m] = rec(m);
    chain.select = async (...args) => { calls.push([`${table} select`, ...args]); return rowsByTable[table] || []; };
    return chain;
  };
  knex.calls = calls;
  return knex;
}

describe('searchReportBlogPosts', () => {
  test('reads the registry\'s verified-live posts and the portal\'s live posts, every text field, each word whole in its forms', async () => {
    const knex = recordingKnex({ content_registry: [REGISTRY_LIVE] });
    await searchReportBlogPosts(knex, 'ghost ants');
    expect(knex.calls).toEqual(expect.arrayContaining([
      ['content_registry where', { content_type: 'blog', workflow_status: 'published', astro_status: 'present', live_status: 'live' }],
      ['content_registry whereRaw', 'COALESCE(noindex_detected, false) = false'],
      ['content_registry inner orWhereRaw', "COALESCE(title, '') ~* ?", ['\\m(?:ghost|ghosts)\\M']],
      ['content_registry inner orWhereRaw', "COALESCE(meta_description, '') ~* ?", ['\\m(?:ants|ant|antses)\\M']],
      ['content_registry inner orWhereRaw', "COALESCE(h1, '') ~* ?", ['\\m(?:ants|ant|antses)\\M']],
      ['content_registry inner orWhereRaw', "COALESCE(target_keyword, '') ~* ?", ['\\m(?:ants|ant|antses)\\M']],
      ['blog_posts where', 'astro_status', 'live'],
      ['blog_posts whereRaw', 'astro_live_url ILIKE ?', ['%wavespestcontrol.com%']],
      ['blog_posts inner orWhereRaw', "COALESCE(keyword, '') ~* ?", ['\\m(?:ghost|ghosts)\\M']],
    ]));
  });

  test('each source orders by how many words a row holds before its read cap (GitHub Codex P2 on #5652)', async () => {
    const knex = recordingKnex({ content_registry: [REGISTRY_LIVE] });
    await searchReportBlogPosts(knex, 'ghost ants');
    for (const [table, newest] of [['content_registry', 'published_at'], ['blog_posts', 'astro_published_at']]) {
      const calls = knex.calls.filter(([name]) => name.startsWith(`${table} `));
      const order = calls.findIndex(([name]) => name === `${table} orderByRaw`);
      const limit = calls.findIndex(([name]) => name === `${table} limit`);
      expect(order).toBeGreaterThanOrEqual(0);
      expect(order).toBeLessThan(limit);
      const [, sql, bindings] = calls[order];
      expect(sql).toMatch(new RegExp(`^\\(CASE WHEN .+ THEN 1 ELSE 0 END \\+ CASE WHEN .+ THEN 1 ELSE 0 END\\) DESC, ${newest} DESC NULLS LAST$`));
      expect(bindings).toEqual(expect.arrayContaining(['\\m(?:ghost|ghosts)\\M', '\\m(?:ants|ant|antses)\\M']));
      expect(calls[limit]).toEqual([`${table} limit`, 500]);
    }
  });

  test('a plural finds the singular: "ghost ants" finds a Ghost Ant post, at its live URL', async () => {
    const knex = recordingKnex({ content_registry: [REGISTRY_LIVE] });
    expect(await searchReportBlogPosts(knex, 'ghost ants')).toEqual([{ id: REGISTRY_LIVE.id, title: REGISTRY_LIVE.title, url: REGISTRY_LIVE.live_url }]);
  });

  test('every word first, then most; a title before a summary; newest first among equals', async () => {
    const knex = recordingKnex({
      content_registry: [
        registryRow('aaaaaaaa-0000-4000-8000-000000000001', 'Mosquitoes Love Standing Water After Rain'),
        registryRow('aaaaaaaa-0000-4000-8000-000000000002', 'Lanai Mosquito Tips', { meta_description: 'Tip out standing water every week.', published_at: '2026-09-01T00:00:00Z' }),
        registryRow('aaaaaaaa-0000-4000-8000-000000000003', 'Water Your Lawn Less in Summer'),
        registryRow('aaaaaaaa-0000-4000-8000-000000000004', 'Ghost Ants After Rain'),
      ],
    });
    const posts = await searchReportBlogPosts(knex, 'standing water');
    expect(posts.map((post) => post.title)).toEqual(['Mosquitoes Love Standing Water After Rain', 'Lanai Mosquito Tips', 'Water Your Lawn Less in Summer']);
  });

  test('with no post holding every word, the rarest word decides: "tick control" puts the tick post first', async () => {
    const knex = recordingKnex({
      content_registry: [
        registryRow('aaaaaaaa-0000-4000-8000-000000000011', 'Pest Control Costs in Sarasota'),
        registryRow('aaaaaaaa-0000-4000-8000-000000000012', 'Lawn Weed Control Calendar'),
        registryRow('aaaaaaaa-0000-4000-8000-000000000013', 'Ticks on Dogs After a Walk', { published_at: '2025-01-01T00:00:00Z' }),
        registryRow('aaaaaaaa-0000-4000-8000-000000000014', 'Rodent Control Basics'),
      ],
    });
    expect((await searchReportBlogPosts(knex, 'tick control'))[0].title).toBe('Ticks on Dogs After a Walk');
  });

  test('a word matches only whole: "rat" never finds "Rates"', async () => {
    const knex = recordingKnex({
      content_registry: [
        registryRow('aaaaaaaa-0000-4000-8000-000000000005', 'Pest Control Rates Explained'),
        registryRow('aaaaaaaa-0000-4000-8000-000000000006', 'Roof Rat Season in Bradenton'),
      ],
    });
    expect((await searchReportBlogPosts(knex, 'rats')).map((post) => post.title)).toEqual(['Roof Rat Season in Bradenton']);
  });

  test('a post the sweep did not verify live on the hub never comes back', async () => {
    const knex = recordingKnex({
      content_registry: [
        { ...REGISTRY_LIVE, live_status: 'not_found' },
        { ...REGISTRY_LIVE, id: '44444444-4444-4444-8444-444444444444', noindex_detected: true },
        { ...REGISTRY_LIVE, id: '55555555-5555-4555-8555-555555555555', live_url: 'https://bradentonfllawncare.com/blog/ghost-ants/', canonical_url: 'https://bradentonfllawncare.com/blog/ghost-ants/' },
      ],
    });
    expect(await searchReportBlogPosts(knex, 'ghost ants')).toEqual([]);
  });

  test('a portal post stamped live since the last sweep comes back; a post in both comes back once', async () => {
    const knex = recordingKnex({
      content_registry: [registryRow('66666666-6666-4666-8666-666666666666', 'How to Get Rid of Ghost Ants in Sarasota', { live_url: LIVE.astro_live_url, canonical_url: LIVE.astro_live_url })],
      blog_posts: [LIVE, { ...LIVE, id: '77777777-7777-4777-8777-777777777777', astro_live_url: 'https://www.wavespestcontrol.com/pest-control/ghost-ants-after-rain/', title: 'Ghost Ants After Rain' }],
    });
    const posts = await searchReportBlogPosts(knex, 'ghost ants');
    expect(posts.map((post) => post.url)).toEqual([LIVE.astro_live_url, 'https://www.wavespestcontrol.com/pest-control/ghost-ants-after-rain/']);
    expect(posts[0].id).toBe('66666666-6666-4666-8666-666666666666');
  });

  test('at most eight', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => registryRow(`aaaaaaaa-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, `Termite Season Note ${i}`));
    expect(await searchReportBlogPosts(recordingKnex({ content_registry: rows }), 'termites')).toHaveLength(8);
  });

  test('no usable words, no read', async () => {
    const knex = recordingKnex({ content_registry: [REGISTRY_LIVE] });
    expect(await searchReportBlogPosts(knex, ' a to of ')).toEqual([]);
    expect(knex.calls).toEqual([]);
  });
});

describe('resolveReportBlogPostPick', () => {
  // The savepoint reader: each read gets a knex that answers its table's row.
  const readerOf = (rows) => jest.fn(async (fn) => fn((table) => {
    const chain = { where: () => chain, first: async () => rows[table] || null };
    return chain;
  }));
  const reader = (row) => readerOf({ blog_posts: row });

  test('nothing picked is no pick, never a refusal', async () => {
    const read = reader(LIVE);
    expect(await resolveReportBlogPostPick(read, null)).toEqual({ post: null, rejected: false });
    expect(await resolveReportBlogPostPick(read, '')).toEqual({ post: null, rejected: false });
    expect(read).not.toHaveBeenCalled();
  });

  test('a live pick resolves; an unknown, unpublished or malformed one is refused', async () => {
    expect(await resolveReportBlogPostPick(reader(LIVE), LIVE.id)).toEqual({ post: { id: LIVE.id, title: LIVE.title, url: LIVE.astro_live_url } });
    expect(await resolveReportBlogPostPick(reader(null), LIVE.id)).toEqual({ post: null, rejected: true });
    expect(await resolveReportBlogPostPick(reader({ ...LIVE, astro_status: 'draft' }), LIVE.id)).toEqual({ post: null, rejected: true });
    const read = reader(LIVE);
    expect(await resolveReportBlogPostPick(read, 'not-a-uuid')).toEqual({ post: null, rejected: true });
    expect(read).not.toHaveBeenCalled();
  });

  test('a pick from the registry resolves from the registry; one no longer live there is refused', async () => {
    expect(await resolveReportBlogPostPick(readerOf({ content_registry: REGISTRY_LIVE }), REGISTRY_LIVE.id))
      .toEqual({ post: { id: REGISTRY_LIVE.id, title: REGISTRY_LIVE.title, url: REGISTRY_LIVE.live_url } });
    expect(await resolveReportBlogPostPick(readerOf({ content_registry: { ...REGISTRY_LIVE, live_status: 'not_found' } }), REGISTRY_LIVE.id))
      .toEqual({ post: null, rejected: true });
  });
});

describe('frozenBlogPost', () => {
  test('the frozen title and URL, on the site\'s own host only', () => {
    expect(frozenBlogPost({ id: LIVE.id, title: LIVE.title, url: LIVE.astro_live_url })).toEqual({ title: LIVE.title, url: LIVE.astro_live_url });
    expect(frozenBlogPost({ title: 'x', url: 'https://example.com/x/' })).toBeNull();
    expect(frozenBlogPost({ title: '', url: LIVE.astro_live_url })).toBeNull();
    expect(frozenBlogPost('not an object')).toBeNull();
  });
});

function invoke(params, query, actor = { techRole: 'admin', technicianId: 'admin-1' }) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/:serviceId/blog-posts' && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return new Promise((resolve, reject) => {
    handler({ params, query, ...actor }, res, (err) => (err ? reject(err) : resolve(res)))
      .then(() => resolve(res))
      .catch(reject);
  });
}

const TODAY = new Date().toISOString().slice(0, 10);
const SERVICE = { id: 'svc-1', technician_id: 'tech-1', status: 'confirmed', scheduled_date: TODAY, service_type: 'Quarterly Pest Control' };

function scriptedDb(service, posts, calls, registry = []) {
  return (table) => {
    calls.push(table);
    const chain = {};
    for (const m of ['where', 'whereNotNull', 'whereRaw', 'orderByRaw', 'orderBy', 'limit']) {
      chain[m] = (arg) => {
        if (typeof arg === 'function') arg.call({ whereRaw() { return this; }, orWhereRaw() { return this; } });
        return chain;
      };
    }
    chain.first = async () => (table === 'scheduled_services' ? service : null);
    chain.select = async () => (table === 'blog_posts' ? posts : (table === 'content_registry' ? registry : []));
    return chain;
  };
}

describe('GET /:serviceId/blog-posts', () => {
  const ORIGINAL = process.env.GATE_REPORT_BLOG_POST;
  beforeEach(() => {
    mockResolveProfile.mockReset();
    mockResolveProfile.mockResolvedValue({ serviceKey: 'pest_general_quarterly', synthesized: false });
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GATE_REPORT_BLOG_POST;
    else process.env.GATE_REPORT_BLOG_POST = ORIGINAL;
  });

  test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: unavailable with no database read', async (value) => {
    if (value === undefined) delete process.env.GATE_REPORT_BLOG_POST; else process.env.GATE_REPORT_BLOG_POST = value;
    const calls = [];
    mockDbCurrent = scriptedDb(SERVICE, [LIVE], calls);
    const res = await invoke({ serviceId: 'svc-1' }, { q: 'ghost ants' });
    expect(res.body).toEqual({ available: false, posts: [] });
    expect(calls).toEqual([]);
  });

  test('an unknown visit is a 404', async () => {
    process.env.GATE_REPORT_BLOG_POST = 'true';
    mockDbCurrent = scriptedDb(null, [LIVE], []);
    const res = await invoke({ serviceId: 'svc-x' }, { q: 'ghost ants' });
    expect(res.statusCode).toBe(404);
  });

  test('a technician searches only from their own current visit', async () => {
    process.env.GATE_REPORT_BLOG_POST = 'true';
    mockDbCurrent = scriptedDb(SERVICE, [LIVE], []);
    const other = await invoke({ serviceId: 'svc-1' }, { q: 'ghost ants' }, { techRole: 'technician', technicianId: 'tech-2' });
    expect(other.statusCode).toBe(403);
  });

  test.each([
    ['WDO Inspection (Termite Letter)', { serviceKey: 'wdo_inspection', projectType: 'wdo_inspection' }],
    ['Pre-Slab Termite Treatment', { serviceKey: 'termite_slab_pretreat', projectType: 'pre_treatment_termite_certificate' }],
    ['Lawn Care', { serviceKey: 'lawn_care' }],
    ['Tree & Shrub Care', { serviceKey: 'tree_shrub_care' }],
  ])('%s answers unavailable, as /complete would drop the pick (owner ruling 2026-10-02)', async (serviceType, profile) => {
    process.env.GATE_REPORT_BLOG_POST = 'true';
    mockResolveProfile.mockResolvedValue(profile);
    const calls = [];
    mockDbCurrent = scriptedDb({ ...SERVICE, service_type: serviceType }, [LIVE], calls);
    const res = await invoke({ serviceId: 'svc-1' }, { q: 'ghost ants' }, { techRole: 'technician', technicianId: 'tech-1' });
    expect(res.body).toEqual({ available: false, posts: [] });
    expect(calls).toEqual(['scheduled_services']);
  });

  test('a rodent visit gets live posts too: the profile is read from the visit\'s own identity', async () => {
    process.env.GATE_REPORT_BLOG_POST = 'true';
    mockResolveProfile.mockResolvedValue({ serviceKey: 'rodent_trapping' });
    const service = { ...SERVICE, service_type: 'Rodent Trap Check', service_id: 'cat-9', service_key_snapshot: 'rodent_trapping', is_recurring: false };
    const roofRats = registryRow('88888888-8888-4888-8888-888888888888', 'Roof Rats in Sarasota Attics');
    mockDbCurrent = scriptedDb(service, [LIVE], [], [roofRats]);
    const res = await invoke({ serviceId: 'svc-1' }, { q: 'roof rats' }, { techRole: 'technician', technicianId: 'tech-1' });
    expect(res.body).toEqual({ available: true, posts: [{ id: roofRats.id, title: roofRats.title, url: roofRats.live_url }] });
    expect(mockResolveProfile).toHaveBeenCalledWith(service);
  });

  test('the assigned technician gets live posts; an empty query reads no posts', async () => {
    process.env.GATE_REPORT_BLOG_POST = 'true';
    const calls = [];
    mockDbCurrent = scriptedDb(SERVICE, [LIVE, { ...LIVE, id: '2', astro_status: 'merged' }], calls);
    const res = await invoke({ serviceId: 'svc-1' }, { q: 'ghost ants' }, { techRole: 'technician', technicianId: 'tech-1' });
    expect(res.body).toEqual({ available: true, posts: [{ id: LIVE.id, title: LIVE.title, url: LIVE.astro_live_url }] });
    calls.length = 0;
    const probe = await invoke({ serviceId: 'svc-1' }, {}, { techRole: 'technician', technicianId: 'tech-1' });
    expect(probe.body).toEqual({ available: true, posts: [] });
    expect(calls).toEqual(['scheduled_services']);
  });
});

// The completion function is pinned by source, like the tip freeze
// (admin-dispatch-tech-tips.test.js): it is too large for a unit harness.
describe('completion freeze contract', () => {
  const completionSource = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  const block = completionSource.slice(completionSource.indexOf('async function completeScheduledService('));

  test('the pick is resolved under the gate, by the search\'s own scope rule, through a savepoint read', () => {
    expect(block).toMatch(/const blogPostPick = require\('\.\.\/config\/feature-gates'\)\.reportBlogPostLive\(\)\s*&& ReportBlogPost\.blogPostAllowedFor\(\{ serviceType: svc\.service_type, profile: completionProfile \}\)/);
    expect(block).toMatch(/resolveReportBlogPostPick\(\s*\(reader\) => failSoftRead\(db, reader, null\),\s*completionInput\.body\?\.blogPostId,/);
    expect(block).toMatch(/: \{ post: null, rejected: false \};/);
  });

  test('a pick that is not live is an actionable 400 for a fresh attempt, before any write', () => {
    const reject = block.indexOf("if (claim.action === 'proceed' && blogPostPick.rejected) {");
    expect(reject).toBeGreaterThan(block.indexOf("if (claim.action === 'replay') {"));
    expect(reject).toBeLessThan(block.indexOf("trx('service_records').insert(recordInsert)"));
    const rejectBlock = block.slice(reject, reject + 800);
    expect(rejectBlock).toMatch(/markCompletionAttemptFailed\([\s\S]*blog_post_unavailable/);
    expect(rejectBlock).toMatch(/status: 400[\s\S]*code: 'BLOG_POST_UNAVAILABLE'/);
  });

  test('the resolved post is frozen into structured_notes.blogPost', () => {
    expect(block).toContain('...(blogPostPick.post ? { blogPost: blogPostPick.post } : {}),');
  });

  test('a repoint under the lock to a service that carries none drops the post before the record is written (Codex #5547)', () => {
    const resolve = block.indexOf('frozenCompletionProfile = await resolveCompletionProfileForScheduledService(lockedSvcRow, trx);');
    const drop = block.indexOf('if (structuredNotes.blogPost && (!primaryFreezeTrusted');
    expect(resolve).toBeGreaterThan(0);
    expect(drop).toBeGreaterThan(resolve);
    expect(drop).toBeLessThan(block.indexOf('structured_notes: serializeJsonb(structuredNotes),'));
    const dropBlock = block.slice(drop, drop + 500);
    expect(dropBlock).toMatch(/blogPostAllowedFor\(\{\s*serviceType: lockedSvcRow \? lockedSvcRow\.service_type : svc\.service_type,\s*profile: frozenCompletionProfile,/);
    expect(dropBlock).toContain('delete structuredNotes.blogPost;');
  });
});

describe('report payload', () => {
  const reportSource = fs.readFileSync(path.join(__dirname, '../services/service-report/report-data.js'), 'utf8');
  test('the frozen post is read back through the host check and shown only while the gate is on', () => {
    expect(reportSource).toMatch(/blogPost: featureGates\.reportBlogPostLive\?\.\(\) === true\s*\?\s*require\('\.\/report-blog-post'\)\.frozenBlogPost\(structured\.blogPost\)\s*:\s*null,/);
    // Never onto the protocol object the payload also returns (pre-push P0
    // on #5547; the whole payload is pinned in report-blog-post-payload.test.js).
    expect(reportSource).not.toMatch(/protocol\??\.blogPost/);
  });
});
