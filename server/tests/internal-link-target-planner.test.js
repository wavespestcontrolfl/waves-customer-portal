jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { targetFacts } = require('../services/content/internal-link-target-planner');

const corpus = [
  { url: '/termite-control-bradenton-fl/', body: '---\ntitle: "Termite Control in Bradenton, FL"\n---\nBody.' },
  { url: '/pest-control/neem-oil-for-whiteflies/', body: '---\ntitle: "Neem Oil for Whiteflies"\nprimary_keyword: neem oil for whiteflies\n---\nBody.' },
];

test('city-service titles become service + city anchor facts, never GSC query text', () => {
  expect(targetFacts('https://www.wavespestcontrol.com/termite-control-bradenton-fl/', corpus)).toEqual({
    url: '/termite-control-bradenton-fl/',
    title: 'Termite Control in Bradenton, FL',
    keyword: 'termite control in bradenton',
    service: 'termite control',
    city: 'Bradenton',
  });
});

test('pages with their own keyword keep it', () => {
  expect(targetFacts('https://www.wavespestcontrol.com/pest-control/neem-oil-for-whiteflies/', corpus))
    .toMatchObject({ keyword: 'neem oil for whiteflies', service: undefined, city: undefined });
});

test('a page missing from the corpus is not planned', () => {
  expect(targetFacts('https://www.wavespestcontrol.com/gone/', corpus)).toBeNull();
});

test('keeps fetching past deleted pages until the cap is filled', async () => {
  jest.resetModules();
  const deleted = Array.from({ length: 30 }, (_, n) => ({ page_url: `https://www.wavespestcontrol.com/deleted-${n}/`, impressions: 9000 - n, position: 10 }));
  const valid = [{ page_url: 'https://www.wavespestcontrol.com/termite-control-bradenton-fl/', impressions: 100, position: 11 }];
  jest.doMock('../models/db', () => {
    const q = {};
    for (const m of ['where', 'whereNot', 'whereRaw', 'groupBy', 'groupByRaw', 'havingRaw', 'orderByRaw', 'limit']) q[m] = jest.fn(() => q);
    q.offset = jest.fn((o) => { q.at = o; return q; });
    q.select = jest.fn(async () => (q.at === 0 ? deleted : valid));
    const db = jest.fn(() => q);
    db.raw = jest.fn((x) => x);
    return db;
  });
  jest.doMock('../services/content/internal-link-planner', () => ({
    loadAstroCorpusFromGitHub: jest.fn(async () => corpus),
    planForTarget: jest.fn(() => []),
  }));
  jest.doMock('../services/content/protected-pages', () => ({ protectedSourcePredicate: jest.fn(async () => () => false) }));
  jest.doMock('../services/content/autonomous-runner', () => ({ _internals: { queueInternalLinkTaskForDryRun: jest.fn() } }));
  const plannerMock = require('../services/content/internal-link-planner');
  const { planGscTargets } = require('../services/content/internal-link-target-planner');
  const result = await planGscTargets({ limit: 1, minImpressions: 100 });
  expect(result.targets).toBe(1);
  expect(plannerMock.planForTarget).toHaveBeenCalledWith(expect.objectContaining({ url: '/termite-control-bradenton-fl/' }), expect.any(Object));
});

describe('AI-search benchmark targets', () => {
  const post = (path, title) => ({ url: path, body: `---\ntitle: "${title}"\nprimary_keyword: ${title.toLowerCase()}\n---\nBody.` });
  const benchCorpus = [
    post('/pest-control/pest-control-costs-2025/', 'Pest Control Costs'),
    post('/termite/termite-bond/', 'Termite Bond'),
    post('/pest-control/not-in-benchmark/', 'Not In Benchmark'),
  ];

  // GSC picks costs-2025 (also a benchmark path); the identifier pages are
  // benchmark paths with no content file, so they cannot be planned.
  async function run(env, gscRows = [{ page_url: 'https://www.wavespestcontrol.com/pest-control/pest-control-costs-2025/', impressions: 250, position: 12 }], opts = {}) {
    jest.resetModules();
    for (const key of ['AUTONOMOUS_INTERNAL_LINK_GSC_TARGETS', 'AUTONOMOUS_INTERNAL_LINK_BENCHMARK_TARGETS']) delete process.env[key];
    Object.assign(process.env, env);
    const update = jest.fn(async () => 1);
    const q = { whereIn: jest.fn(() => q), update };
    for (const m of ['where', 'whereNot', 'whereRaw', 'groupByRaw', 'havingRaw', 'orderByRaw', 'limit', 'offset']) q[m] = jest.fn(() => q);
    q.select = jest.fn(async () => gscRows);
    const db = jest.fn(() => q);
    db.raw = jest.fn((x) => x);
    jest.doMock('../models/db', () => db);
    const planForTarget = jest.fn((target) => [{ source_file: 'src/x.md', target_url: target.url, anchor_text: 'a' }]);
    jest.doMock('../services/content/internal-link-planner', () => ({
      loadAstroCorpusFromGitHub: jest.fn(async () => benchCorpus),
      planForTarget,
    }));
    jest.doMock('../services/content/protected-pages', () => ({ protectedSourcePredicate: jest.fn(async () => () => false) }));
    const queue = jest.fn(async () => ({ id: `id-${queue.mock.calls.length}` }));
    jest.doMock('../services/content/autonomous-runner', () => ({ _internals: { queueInternalLinkTaskForDryRun: queue } }));
    jest.doMock('../services/content/internal-link-pr-executor', () => ({
      runDryRun: jest.fn(async () => ({ results: [] })),
      requeueTransientDryRunFailures: jest.fn(async () => 0),
    }));
    const result = await require('../services/content/internal-link-target-planner').planGscTargets({ limit: 5, minImpressions: 100, ...opts });
    const priorities = Object.fromEntries(queue.mock.calls.map(([task]) => [task.target_url, task.target_priority]));
    return { result, priorities, db, update, planForTarget };
  }

  afterEach(() => {
    delete process.env.AUTONOMOUS_INTERNAL_LINK_GSC_TARGETS;
    delete process.env.AUTONOMOUS_INTERNAL_LINK_BENCHMARK_TARGETS;
  });

  test('benchmark pages outrank impressions in the sweep, dedupe against GSC picks, and skip pages with no content file', async () => {
    const { result, priorities, update } = await run({});
    expect(priorities).toEqual({
      '/pest-control/pest-control-costs-2025/': 250, // GSC pick keeps its impressions rank, planned once
      '/termite/termite-bond/': 1_000_000,
    });
    expect(result.targets).toBe(2);
    expect(update).toHaveBeenCalledWith({ target_priority: 1_000_000 });
  });

  test('a week plans one link each for at most the benchmark limit, rotating the start by week (Codex r1)', async () => {
    // Outranking everything, an unbounded benchmark queue would starve the
    // impressions-ranked targets (the sweep ships three links a day at most).
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const weekA = await run({ AUTONOMOUS_INTERNAL_LINK_GSC_TARGETS: 'false' }, [], { benchmarkLimit: 1, now: 10 * WEEK_MS });
    const weekB = await run({ AUTONOMOUS_INTERNAL_LINK_GSC_TARGETS: 'false' }, [], { benchmarkLimit: 1, now: 11 * WEEK_MS });
    expect(Object.keys(weekA.priorities)).toHaveLength(1);
    expect(Object.keys(weekB.priorities)).toHaveLength(1);
    expect(Object.keys(weekA.priorities)).not.toEqual(Object.keys(weekB.priorities));
    expect(weekA.planForTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ cap: 1 }));
    // Search Console targets keep the planner's default cap.
    const both = await run({});
    const gscCall = both.planForTarget.mock.calls.find(([target]) => target.url === '/pest-control/pest-control-costs-2025/');
    expect(gscCall[1]).not.toHaveProperty('cap');
  });

  test('each source has its own kill switch', async () => {
    const gscOnly = await run({ AUTONOMOUS_INTERNAL_LINK_BENCHMARK_TARGETS: 'false' });
    expect(Object.keys(gscOnly.priorities)).toEqual(['/pest-control/pest-control-costs-2025/']);

    const benchmarkOnly = await run({ AUTONOMOUS_INTERNAL_LINK_GSC_TARGETS: 'false' });
    expect(benchmarkOnly.db).not.toHaveBeenCalledWith('gsc_pages');
    expect(benchmarkOnly.priorities).toEqual({ '/pest-control/pest-control-costs-2025/': 1_000_000, '/termite/termite-bond/': 1_000_000 });

    const off = await run({ AUTONOMOUS_INTERNAL_LINK_GSC_TARGETS: 'false', AUTONOMOUS_INTERNAL_LINK_BENCHMARK_TARGETS: 'false' });
    expect(off.result).toEqual({ status: 'disabled' });
  });
});
