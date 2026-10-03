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
  blogPostAllowedFor, reportBlogLink, searchReportBlogPosts, resolveReportBlogPostPick, frozenBlogPost, searchTerms,
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
    for (const m of ['where', 'whereNotNull', 'whereRaw', 'orderByRaw', 'orderBy', 'limit']) chain[m] = rec(m);
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

  test('only rows that can be on the site\'s own host reach the limit (GitHub Codex on #5547)', async () => {
    const knex = recordingKnex([LIVE]);
    await searchReportBlogPosts(knex, 'ghost ants');
    const names = knex.calls.map(([name]) => name);
    const host = knex.calls.findIndex(([name, sql]) => name === 'whereRaw' && sql === 'astro_live_url ILIKE ?');
    expect(knex.calls[host]).toEqual(['whereRaw', 'astro_live_url ILIKE ?', ['%wavespestcontrol.com%']]);
    expect(host).toBeLessThan(names.indexOf('limit'));
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
    for (const m of ['where', 'whereNotNull', 'whereRaw', 'orderByRaw', 'orderBy', 'limit']) {
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
    mockDbCurrent = scriptedDb(service, [LIVE], []);
    const res = await invoke({ serviceId: 'svc-1' }, { q: 'roof rats' }, { techRole: 'technician', technicianId: 'tech-1' });
    expect(res.body).toEqual({ available: true, posts: [{ id: LIVE.id, title: LIVE.title, url: LIVE.astro_live_url }] });
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
