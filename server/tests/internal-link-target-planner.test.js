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
    for (const m of ['where', 'whereNot', 'groupBy', 'havingRaw', 'orderByRaw', 'limit']) q[m] = jest.fn(() => q);
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
