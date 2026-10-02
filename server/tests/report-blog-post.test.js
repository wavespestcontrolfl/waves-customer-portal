/**
 * A Waves blog post on the service report (GATE_REPORT_BLOG_POST, owner "ok
 * go" 2026-10-01): the one link rule (report-blog-post.js), the completion
 * forms' search (GET /admin/dispatch/:serviceId/blog-posts), the freeze at
 * completion and the report payload.
 *
 *  - A report links only a published post that is live on the hub, at its
 *    live URL on the site's own host; never a draft, a merged-but-not-live
 *    post or another host.
 *  - The search is dark with the gate off and reads only the technician's
 *    own current visit.
 *  - The pick is frozen at completion for pest visits only, and one that is
 *    not live is an actionable 400 before any write.
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

const fs = require('fs');
const path = require('path');
const {
  reportBlogLink, searchReportBlogPosts, resolveReportBlogPostPick, frozenBlogPost, searchTerms,
} = require('../services/service-report/report-blog-post');
const router = require('../routes/admin-dispatch');

const LIVE = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'How to Get Rid of Ghost Ants in Sarasota Without Losing Your Mind',
  status: 'published',
  astro_status: 'live',
  astro_live_url: 'https://www.wavespestcontrol.com/pest-control/get-rid-of-ghost-ants-in-sarasota/',
};

afterEach(() => {
  mockDbCurrent = null;
  jest.clearAllMocks();
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

describe('searchTerms', () => {
  test('words of two characters or more, punctuation and LIKE wildcards dropped, at most four', () => {
    expect(searchTerms('Ghost  ANTS!')).toEqual(['ghost', 'ants']);
    expect(searchTerms('a % _ ants')).toEqual(['ants']);
    expect(searchTerms('one two three four five')).toEqual(['one', 'two', 'three', 'four']);
    expect(searchTerms('')).toEqual([]);
  });
});

// A query builder that records what it was asked and answers rows.
function recordingKnex(rows) {
  const calls = [];
  const knex = (table) => {
    calls.push(['table', table]);
    const chain = {};
    const rec = (name) => (...args) => {
      if (typeof args[0] === 'function') {
        const inner = { whereRaw: (...a) => { calls.push(['inner whereRaw', ...a]); return inner; }, orWhereRaw: (...a) => { calls.push(['inner orWhereRaw', ...a]); return inner; } };
        args[0].call(inner);
      } else {
        calls.push([name, ...args]);
      }
      return chain;
    };
    for (const m of ['where', 'whereNotNull', 'orderByRaw', 'orderBy', 'limit']) chain[m] = rec(m);
    chain.select = async (...args) => { calls.push(['select', ...args]); return rows; };
    return chain;
  };
  knex.calls = calls;
  return knex;
}

describe('searchReportBlogPosts', () => {
  test('every typed word must match the title or keyword; only linkable rows come back', async () => {
    const knex = recordingKnex([LIVE, { ...LIVE, id: '2', astro_live_url: 'https://other.example/x/' }]);
    const posts = await searchReportBlogPosts(knex, 'ghost ants');
    expect(posts).toEqual([{ id: LIVE.id, title: LIVE.title, url: LIVE.astro_live_url }]);
    expect(knex.calls).toEqual(expect.arrayContaining([
      ['where', 'status', 'published'],
      ['where', 'astro_status', 'live'],
      ['whereNotNull', 'astro_live_url'],
      ['inner whereRaw', 'title ILIKE ?', ['%ghost%']],
      ['inner orWhereRaw', "COALESCE(keyword, '') ILIKE ?", ['%ants%']],
    ]));
  });

  test('no usable words, no read', async () => {
    const knex = recordingKnex([LIVE]);
    expect(await searchReportBlogPosts(knex, ' a ')).toEqual([]);
    expect(knex.calls).toEqual([]);
  });
});

describe('resolveReportBlogPostPick', () => {
  const reader = (row) => jest.fn(async () => row);

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

function scriptedDb(service, posts, calls) {
  return (table) => {
    calls.push(table);
    const chain = {};
    for (const m of ['where', 'whereNotNull', 'orderByRaw', 'orderBy', 'limit']) {
      chain[m] = (arg) => {
        if (typeof arg === 'function') arg.call({ whereRaw() { return this; }, orWhereRaw() { return this; } });
        return chain;
      };
    }
    chain.first = async () => (table === 'scheduled_services' ? service : null);
    chain.select = async () => (table === 'blog_posts' ? posts : []);
    return chain;
  };
}

describe('GET /:serviceId/blog-posts', () => {
  const ORIGINAL = process.env.GATE_REPORT_BLOG_POST;
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

  test('a visit whose own line is not pest answers unavailable, as /complete would drop the pick (codex local r1 on #5547)', async () => {
    process.env.GATE_REPORT_BLOG_POST = 'true';
    const calls = [];
    mockDbCurrent = scriptedDb({ ...SERVICE, service_type: 'Rodent Pest Control' }, [LIVE], calls);
    const res = await invoke({ serviceId: 'svc-1' }, { q: 'ghost ants' }, { techRole: 'technician', technicianId: 'tech-1' });
    expect(res.body).toEqual({ available: false, posts: [] });
    expect(calls).toEqual(['scheduled_services']);
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

  test('the pick is resolved under the gate, for pest visits only, through a savepoint read', () => {
    expect(block).toMatch(/const blogPostPick = require\('\.\.\/config\/feature-gates'\)\.reportBlogPostLive\(\) && reportServiceLine === 'pest'/);
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
});

describe('report payload', () => {
  const reportSource = fs.readFileSync(path.join(__dirname, '../services/service-report/report-data.js'), 'utf8');
  test('the frozen post is read back through the host check and shown only while the gate is on', () => {
    expect(reportSource).toContain("blogPost: require('./report-blog-post').frozenBlogPost(structured.blogPost),");
    expect(reportSource).toContain('blogPost: featureGates.reportBlogPostLive?.() === true ? (protocol.blogPost || null) : null,');
  });
});
