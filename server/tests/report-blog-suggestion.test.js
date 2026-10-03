/**
 * "Suggest a post" from the completion forms' blog search
 * (GATE_BLOG_SEARCH_SUGGEST; owner mockup approval 2026-10-03, owner ruling
 * 2026-10-02: straight into the autonomous blog queue):
 * services/service-report/report-blog-suggestion.js and
 * POST /admin/dispatch/:serviceId/blog-suggestions.
 *
 *  - A phrase that is no topic (too short, filler only, "near me", out of
 *    the area, personal data) is refused before anything is read or written.
 *  - A search a live post now covers is no suggestion.
 *  - One operator-pinned new_supporting_blog row per phrase: the bucket the
 *    chain takes without search-traffic evidence, no city, the service and
 *    specialty topic inferred from the phrase, score 79, 45 days to expire.
 *  - The same phrase held by any source answers already_queued; an expired
 *    suggestion is revived; at most ten a person a day.
 *  - The route is dark with either gate off, keeps the search's own reach
 *    and blog rule, and never logs the phrase.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
let mockDbCurrent = null;
jest.mock('../models/db', () => {
  const proxy = (...args) => (mockDbCurrent ? mockDbCurrent(...args) : {});
  proxy.raw = (...args) => (mockDbCurrent?.raw ? mockDbCurrent.raw(...args) : { toString: () => args[0] });
  // A transaction runs inline on the same fake.
  proxy.transaction = (fn) => (mockDbCurrent?.transaction ? mockDbCurrent.transaction(fn) : fn(proxy));
  proxy.fn = { now: () => new Date() };
  proxy.schema = { hasTable: async () => true, hasColumn: async () => true };
  return proxy;
});
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../services/logger', () => mockLogger);
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

const {
  suggestReportBlogPost, suggestionRow, phraseProblem, normalizePhrase, dedupeKeyFor, MAX_PER_DAY,
} = require('../services/service-report/report-blog-suggestion');
const router = require('../routes/admin-dispatch');

// A knex fake for the search (no live post unless given), the day's count,
// the held-topic lookup and the insert; it records every call.
function queueKnex({ registry = [], sentToday = 0, held = null, inserted = true } = {}) {
  const calls = [];
  const knex = (table) => {
    calls.push(['table', table]);
    const chain = {};
    for (const m of ['where', 'whereIn', 'whereNotNull', 'whereRaw', 'orderByRaw', 'limit']) {
      chain[m] = (...args) => {
        if (typeof args[0] === 'function') args[0].call({ orWhereRaw() { return this; } });
        else calls.push([`${table} ${m}`, ...args]);
        return chain;
      };
    }
    chain.select = async () => (table === 'content_registry' ? registry : []);
    chain.count = () => ({ first: async () => ({ n: String(sentToday) }) });
    chain.first = async () => (table === 'opportunity_queue' ? held : null);
    return chain;
  };
  knex.raw = jest.fn(async (sql, values) => {
    calls.push(['raw', sql, values]);
    return { rows: inserted ? [{ id: 'row-1' }] : [] };
  });
  knex.calls = calls;
  // The count and the write share one transaction (the fake runs it inline).
  knex.transaction = jest.fn(async (fn) => fn(knex));
  return knex;
}
// The queue's own writes: the search's select builds a raw metadata
// fragment too, which writes nothing.
const queueWrites = (knex) => knex.calls.filter(([name, sql]) => name === 'raw' && /^INSERT INTO opportunity_queue/.test(String(sql)));
const LIVE_STANDING_WATER = {
  id: '99999999-9999-4999-8999-999999999999',
  title: 'Mosquitoes Breed in Standing Water',
  h1: 'Mosquitoes Breed in Standing Water',
  meta_description: '',
  target_keyword: '',
  live_url: 'https://www.wavespestcontrol.com/mosquito/standing-water/',
  canonical_url: 'https://www.wavespestcontrol.com/mosquito/standing-water/',
  canonical_url_normalized: '/mosquito/standing-water/',
  content_type: 'blog',
  workflow_status: 'published',
  astro_status: 'present',
  live_status: 'live',
  reconciliation_status: 'matched',
  noindex_detected: false,
  metadata: {},
  published_at: '2026-08-01T00:00:00Z',
};

describe('phraseProblem', () => {
  test.each([
    ['standing water', null],
    ['  Standing   WATER ', null],
    ['ab', 'not_a_topic'],
    ['how to get rid of', 'not_a_topic'],
    ['pest control near me', 'not_a_topic'],
    ['termites in ohio', 'not_a_topic'],
    ['call 941-555-1234', 'not_a_topic'],
    ['email jane@example.com', 'not_a_topic'],
    ['x'.repeat(81), 'not_a_topic'],
  ])('%p: %p', (phrase, problem) => {
    expect(phraseProblem(normalizePhrase(phrase))).toBe(problem);
  });
});

describe('suggestionRow', () => {
  test('one operator-pinned new blog row, no city, priority 79, 45 days to expire, ids only', () => {
    const now = new Date('2026-10-03T12:00:00Z');
    const row = suggestionRow('palmetto bugs', { actorId: 'tech-1', scheduledServiceId: 'svc-1', now });
    expect(row).toMatchObject({
      bucket: 'operator_intercept',
      action_type: 'new_supporting_blog',
      query: 'palmetto bugs',
      page_url: null,
      city: null,
      service: 'pest',
      score: 79,
      status: 'pending',
      dedupe_key: 'techsuggest:v1:palmetto-bugs',
      signal_metadata: {
        source: 'tech_blog_search',
        operator_pinned: true,
        specialty_topic: 'cockroach',
        suggested_at: now.toISOString(),
        suggested_by: 'tech-1',
        scheduled_service_id: 'svc-1',
      },
    });
    expect(row.expires_at.toISOString()).toBe('2026-11-17T12:00:00.000Z');
    expect(dedupeKeyFor('x'.repeat(300)).length).toBeLessThanOrEqual(200);
  });
});

describe('personal data (pre-push P1 on 1aaeaa36ab)', () => {
  test('is read in the words as typed: lowercasing hides a capitalized name from the redactor', () => {
    expect(phraseProblem(normalizePhrase('ants at John Smith home'))).toBeNull();
    expect(phraseProblem(normalizePhrase('ants at John Smith home'), 'ants at John Smith home')).toBe('not_a_topic');
  });

  test('a phrase the redactor is unsure of is refused', () => {
    expect(phraseProblem(normalizePhrase('ants 12345678'), 'ants 12345678')).toBe('not_a_topic');
  });

  test('a capitalized topic can read as a name and is refused with it; written as a sentence it is not', () => {
    expect(phraseProblem(normalizePhrase('Standing Water'), 'Standing Water')).toBe('not_a_topic');
    expect(phraseProblem(normalizePhrase('Standing water'), 'Standing water')).toBeNull();
  });

  test('a suggestion is checked as typed, before anything is read', async () => {
    const knex = queueKnex();
    expect(await suggestReportBlogPost(knex, { phrase: 'ants at John Smith home', actorId: 'tech-1' })).toEqual({ error: 'not_a_topic' });
    expect(knex.calls).toEqual([]);
  });
});

describe('suggestReportBlogPost', () => {
  test('the count, the held check and the write run in one transaction under the person\'s lock (pre-push P1 on 1aaeaa36ab)', async () => {
    const knex = queueKnex();
    expect(await suggestReportBlogPost(knex, { phrase: 'standing water', actorId: 'tech-1' })).toEqual({ status: 'queued' });
    expect(knex.transaction).toHaveBeenCalledTimes(1);
    const lock = knex.calls.findIndex(([name, sql]) => name === 'raw' && /pg_advisory_xact_lock/.test(String(sql)));
    const count = knex.calls.findIndex(([name, sql]) => name === 'opportunity_queue whereRaw' && /suggested_by/.test(String(sql)));
    const write = knex.calls.findIndex(([name, sql]) => name === 'raw' && /^INSERT INTO opportunity_queue/.test(String(sql)));
    expect(knex.calls[lock]).toEqual(['raw', 'SELECT pg_advisory_xact_lock(hashtext(?))', ['report-blog-suggestion:tech-1']]);
    expect(lock).toBeLessThan(count);
    expect(count).toBeLessThan(write);
  });

  test('writes one row for a phrase no post covers; an expired suggestion of it is revived, nothing else overwritten', async () => {
    const knex = queueKnex();
    expect(await suggestReportBlogPost(knex, { phrase: '  Standing   water ', actorId: 'tech-1', scheduledServiceId: 'svc-1' })).toEqual({ status: 'queued' });
    expect(queueWrites(knex)).toHaveLength(1);
    const [[, sql, values]] = queueWrites(knex);
    expect(sql).toMatch(/^INSERT INTO opportunity_queue \(/);
    expect(sql).toMatch(/ON CONFLICT \(dedupe_key\) DO UPDATE SET status = 'pending'/);
    expect(sql).toMatch(/WHERE opportunity_queue\.status = 'expired'\s+RETURNING id$/);
    expect(values).toEqual(expect.arrayContaining(['operator_intercept', 'new_supporting_blog', 'standing water', 79, 'techsuggest:v1:standing-water']));
    expect(JSON.parse(values.find((v) => typeof v === 'string' && v.includes('operator_pinned')))).toMatchObject({ source: 'tech_blog_search', operator_pinned: true, suggested_by: 'tech-1', scheduled_service_id: 'svc-1' });
  });

  test('a suggestion held already (not expired) answers already_queued', async () => {
    const knex = queueKnex({ inserted: false });
    expect(await suggestReportBlogPost(knex, { phrase: 'standing water', actorId: 'tech-1' })).toEqual({ status: 'already_queued' });
  });

  test('the same phrase held by any source answers already_queued with nothing written', async () => {
    const knex = queueKnex({ held: { id: 'mined-row' } });
    expect(await suggestReportBlogPost(knex, { phrase: 'standing water', actorId: 'tech-1' })).toEqual({ status: 'already_queued' });
    expect(queueWrites(knex)).toEqual([]);
    expect(knex.calls).toEqual(expect.arrayContaining([
      ['opportunity_queue where', { action_type: 'new_supporting_blog' }],
      ['opportunity_queue whereRaw', 'lower(query) = ?', ['standing water']],
      ['opportunity_queue whereIn', 'status', ['pending', 'claimed', 'pending_review', 'done']],
    ]));
  });

  test('a search a live post now covers is no suggestion', async () => {
    const knex = queueKnex({ registry: [LIVE_STANDING_WATER] });
    expect(await suggestReportBlogPost(knex, { phrase: 'standing water', actorId: 'tech-1' })).toEqual({ status: 'covered' });
    expect(queueWrites(knex)).toEqual([]);
  });

  test(`at most ${MAX_PER_DAY} a person a day`, async () => {
    const knex = queueKnex({ sentToday: MAX_PER_DAY });
    expect(await suggestReportBlogPost(knex, { phrase: 'standing water', actorId: 'tech-1' })).toEqual({ error: 'too_many_suggestions' });
    expect(queueWrites(knex)).toEqual([]);
  });

  test('a phrase that is no topic reads and writes nothing', async () => {
    const knex = queueKnex();
    expect(await suggestReportBlogPost(knex, { phrase: 'exterminator near me', actorId: 'tech-1' })).toEqual({ error: 'not_a_topic' });
    expect(knex.calls).toEqual([]);
  });
});

describe('POST /:serviceId/blog-suggestions', () => {
  const TODAY = new Date().toISOString().slice(0, 10);
  const SERVICE = { id: 'svc-1', technician_id: 'tech-1', status: 'confirmed', scheduled_date: TODAY, service_type: 'Mosquito Control' };
  const saved = { post: process.env.GATE_REPORT_BLOG_POST, suggest: process.env.GATE_BLOG_SEARCH_SUGGEST };
  let queue;
  beforeEach(() => {
    mockLogger.info.mockClear();
    mockResolveProfile.mockReset();
    mockResolveProfile.mockResolvedValue({ serviceKey: 'mosquito_monthly' });
    process.env.GATE_REPORT_BLOG_POST = 'true';
    process.env.GATE_BLOG_SEARCH_SUGGEST = 'true';
    queue = queueKnex();
    mockDbCurrent = (table) => {
      if (table === 'scheduled_services') return { where: () => ({ first: async () => SERVICE }) };
      return queue(table);
    };
    mockDbCurrent.raw = queue.raw;
  });
  afterEach(() => {
    for (const [name, value] of [['GATE_REPORT_BLOG_POST', saved.post], ['GATE_BLOG_SEARCH_SUGGEST', saved.suggest]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  function invoke(body, actor = { techRole: 'technician', technicianId: 'tech-1' }) {
    const layer = router.stack.find((l) => l.route && l.route.path === '/:serviceId/blog-suggestions' && l.route.methods.post);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    return new Promise((resolve, reject) => {
      handler({ params: { serviceId: 'svc-1' }, body, ...actor }, res, (err) => (err ? reject(err) : resolve(res)))
        .then(() => resolve(res))
        .catch(reject);
    });
  }

  test.each([
    ['the suggestion gate off', { GATE_BLOG_SEARCH_SUGGEST: undefined }],
    ['the blog post gate off', { GATE_REPORT_BLOG_POST: 'false' }],
  ])('%s: 404, nothing read', async (_label, env) => {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    const res = await invoke({ phrase: 'standing water' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    expect(queue.raw).not.toHaveBeenCalled();
  });

  test('the assigned technician suggests a phrase: 201 queued, logged without the phrase', async () => {
    const res = await invoke({ phrase: 'standing water' });
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ status: 'queued' });
    const logged = mockLogger.info.mock.calls.map(([line]) => line).join(' ');
    expect(logged).toContain('svc-1');
    expect(logged).not.toMatch(/standing/i);
  });

  test('another technician\'s visit is refused', async () => {
    const res = await invoke({ phrase: 'standing water' }, { techRole: 'technician', technicianId: 'tech-2' });
    expect(res.statusCode).toBe(403);
    expect(queue.raw).not.toHaveBeenCalled();
  });

  test('a visit that carries no blog post (WDO) is not_available', async () => {
    mockResolveProfile.mockResolvedValue({ serviceKey: 'wdo_inspection', projectType: 'wdo_inspection' });
    const res = await invoke({ phrase: 'standing water' });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'not_available' });
  });

  test('no topic is 422; a phrase over the day\'s limit is 429', async () => {
    expect((await invoke({ phrase: 'near me' })).statusCode).toBe(422);
    queue = queueKnex({ sentToday: MAX_PER_DAY });
    mockDbCurrent.raw = queue.raw;
    expect((await invoke({ phrase: 'standing water' })).statusCode).toBe(429);
  });
});
