// Pinned AI Overview captures: no pins = no paid call; every attempt is stored.
const mockInserts = [];
const mockWhereArgs = [];
let mockQueries = [];
jest.mock('../models/db', () => {
  const builder = {
    where(...a) {
      mockWhereArgs.push(a);
      if (typeof a[0] === 'function') a[0].call({ whereNull: () => ({ orWhere: (...b) => mockWhereArgs.push(b) }) });
      return builder;
    },
    orderBy: () => Promise.resolve(mockQueries),
  };
  const db = jest.fn((table) => (table === 'seo_aio_captures'
    ? { insert: (row) => { mockInserts.push(row); return Promise.resolve(); } }
    : builder));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/seo/dataforseo', () => ({
  request: jest.fn(),
  serpLocation: jest.requireActual('../services/seo/dataforseo').serpLocation,
}));

const dataforseo = require('../services/seo/dataforseo');
const { runPinnedCaptures, MAX_PINNED_CALLS_PER_PASS } = require('../services/seo/aio-pinned-capture');

const q = (over = {}) => ({ id: 'q1', query: 'best pest control in Exampleville', pin_location: null, ...over });
const serp = (items, over = {}) => ({ tasks: [{ status_code: 20000, cost: 0.004, result: [{ check_url: 'https://google.example/search?q=x', datetime: '2026-10-06 12:00:00 +00:00', items }], ...over }] });
const organic = Array.from({ length: 12 }, (_, i) => ({ type: 'organic', rank_absolute: i + 1, rank_group: i + 1, url: `https://rival${i}.example/`, domain: `rival${i}.example`, title: `Rival ${i}` }));

beforeEach(() => {
  jest.clearAllMocks();
  mockInserts.length = 0;
  mockWhereArgs.length = 0;
  mockQueries = [];
});

test('no pinned rows: zero DataForSEO calls and zero inserts', async () => {
  const summary = await runPinnedCaptures({ pass: 'am' });
  expect(dataforseo.request).not.toHaveBeenCalled();
  expect(mockInserts).toHaveLength(0);
  expect(summary).toMatchObject({ pinned: 0, attempted: 0 });
});

test('the query filters on active, pin_daily and an unexpired pin_until (ET today)', async () => {
  await runPinnedCaptures({ pass: 'pm' });
  expect(mockWhereArgs[0][0]).toEqual({ active: true, pin_daily: true });
  expect(mockWhereArgs).toContainEqual(['pin_until', '>=', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)]);
});

test('desktop and mobile are both called; a coordinate pin_location becomes location_coordinate', async () => {
  mockQueries = [q({ pin_location: '27.5870,-82.4248,10' })];
  dataforseo.request.mockResolvedValue(serp([]));
  await runPinnedCaptures({ pass: 'am' });
  expect(dataforseo.request).toHaveBeenCalledTimes(2);
  const bodies = dataforseo.request.mock.calls.map((c) => c[1][0]);
  expect(bodies.map((b) => [b.device, b.os])).toEqual([['desktop', 'macos'], ['mobile', 'iOS']]);
  for (const b of bodies) {
    expect(b).toMatchObject({ keyword: 'best pest control in Exampleville', location_coordinate: '27.5870,-82.4248,10', language_name: 'English', load_async_ai_overview: true });
    expect(b.location_name).toBeUndefined();
  }
  expect(dataforseo.request.mock.calls[0][0]).toBe('/serp/google/organic/live/advanced');
});

test('no pin_location uses the Bradenton place name', async () => {
  mockQueries = [q()];
  dataforseo.request.mockResolvedValue(serp([]));
  await runPinnedCaptures({ pass: 'am' });
  expect(dataforseo.request.mock.calls[0][1][0].location_name).toBe('Bradenton,Florida,United States');
  expect(mockInserts[0]).toMatchObject({ location: 'Bradenton,Florida,United States', pass: 'am' });
});

test('a null request stores request_error', async () => {
  mockQueries = [q()];
  dataforseo.request.mockResolvedValue(null);
  const summary = await runPinnedCaptures({ pass: 'am' });
  expect(mockInserts).toHaveLength(2);
  expect(mockInserts[0]).toMatchObject({ query_id: 'q1', device: 'desktop', status: 'request_error' });
  expect(summary).toMatchObject({ attempted: 2, errors: 2, shown: 0 });
});

test('a task error stores task_error with the status message and the cost', async () => {
  mockQueries = [q()];
  dataforseo.request.mockResolvedValue({ tasks: [{ status_code: 40501, status_message: 'Invalid Field: location_name', cost: 0 }] });
  await runPinnedCaptures({ pass: 'am' });
  expect(mockInserts[0]).toMatchObject({ status: 'task_error' });
  expect(JSON.parse(mockInserts[0].raw_item)).toEqual({ status_code: 40501, status_message: 'Invalid Field: location_name' });
});

test('a SERP with no ai_overview stores none, still keeping organic_top (10), paa and local_pack', async () => {
  mockQueries = [q()];
  dataforseo.request.mockResolvedValue(serp([
    ...organic,
    { type: 'people_also_ask', items: [{ type: 'people_also_ask_element', title: 'How much is pest control?' }] },
    { type: 'local_pack', title: 'Places', items: [
      { type: 'local_pack_element', title: 'Example Pest Co', domain: 'example.test', rating: { value: 4.8, votes_count: 120 }, rank_group: 1 },
      { type: 'local_pack_element', title: 'Sample Bug Co', domain: 'sample.test', rating: { value: 4.5, votes_count: 30 }, rank_group: 2 },
    ] },
  ]));
  const summary = await runPinnedCaptures({ pass: 'pm' });
  const row = mockInserts[0];
  expect(row).toMatchObject({ status: 'none', waves_cited: false, cost_usd: 0.004, check_url: 'https://google.example/search?q=x', se_datetime: '2026-10-06 12:00:00 +00:00' });
  expect(JSON.parse(row.organic_top)).toHaveLength(10);
  expect(JSON.parse(row.organic_top)[0]).toEqual({ rank_absolute: 1, rank_group: 1, url: 'https://rival0.example/', domain: 'rival0.example', title: 'Rival 0' });
  expect(JSON.parse(row.paa)).toEqual(['How much is pest control?']);
  expect(JSON.parse(row.local_pack)).toEqual([
    { title: 'Example Pest Co', domain: 'example.test', rating: 4.8, review_count: 120, rank_group: 1 },
    { title: 'Sample Bug Co', domain: 'sample.test', rating: 4.5, review_count: 30, rank_group: 2 },
  ]);
  expect(summary).toMatchObject({ none: 2, shown: 0, errors: 0 });
});

test('a shown overview maps elements to urls, keeps reference titles and flags a Waves citation', async () => {
  mockQueries = [q()];
  const aio = {
    type: 'ai_overview',
    markdown: 'Overview text',
    items: [
      { type: 'ai_overview_element', title: 'Claim A', text: 'Claim A text', references: [{ url: 'https://www.wavespestcontrol.com/pest-control-bradenton/' }, { url: 'https://rival0.example/a' }] },
      { type: 'ai_overview_element', text: 'Claim B text', links: [{ url: 'https://rival1.example/b' }] },
      { type: 'ai_overview_element', text: '' },
    ],
    references: [{ url: 'https://rival2.example/c', title: 'Source C', domain: 'rival2.example', text: 'snippet' }],
  };
  dataforseo.request.mockResolvedValue(serp([aio, ...organic]));
  const summary = await runPinnedCaptures({ pass: 'am' });
  const row = mockInserts[0];
  expect(row.status).toBe('shown');
  expect(row.waves_cited).toBe(true);
  expect(row.answer_markdown).toBe('Overview text');
  expect(JSON.parse(row.elements)).toEqual([
    { title: 'Claim A', text: 'Claim A text', urls: ['https://www.wavespestcontrol.com/pest-control-bradenton/', 'https://rival0.example/a'] },
    { title: null, text: 'Claim B text', urls: ['https://rival1.example/b'] },
  ]);
  expect(JSON.parse(row.aio_references)).toEqual([{ url: 'https://rival2.example/c', title: 'Source C', domain: 'rival2.example', text: 'snippet' }]);
  expect(JSON.parse(row.raw_item).type).toBe('ai_overview');
  expect(summary).toMatchObject({ shown: 2, costUsd: 0.008 });
});

test('waves_cited is false when no cited url is a Waves domain', async () => {
  mockQueries = [q()];
  dataforseo.request.mockResolvedValue(serp([{ type: 'ai_overview', markdown: 'x', items: [{ type: 'ai_overview_element', text: 'x', references: [{ url: 'https://rival0.example/a' }] }], references: [] }]));
  await runPinnedCaptures({ pass: 'am' });
  expect(mockInserts[0]).toMatchObject({ status: 'shown', waves_cited: false });
});

test('a Waves URL only in the top-level references is not a citation', async () => {
  mockQueries = [q()];
  dataforseo.request.mockResolvedValue(serp([{ type: 'ai_overview', markdown: 'x', items: [{ type: 'ai_overview_element', text: 'x', references: [{ url: 'https://rival0.example/a' }] }], references: [{ url: 'https://www.wavespestcontrol.com/lawn-care/' }] }]));
  await runPinnedCaptures({ pass: 'am' });
  expect(mockInserts[0]).toMatchObject({ status: 'shown', waves_cited: false });
});

test('one thrown request does not stop the rest of the pass', async () => {
  mockQueries = [q({ id: 'q1' }), q({ id: 'q2', query: 'second query' })];
  dataforseo.request.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(serp([]));
  const summary = await runPinnedCaptures({ pass: 'am' });
  expect(dataforseo.request).toHaveBeenCalledTimes(4);
  expect(summary).toMatchObject({ attempted: 4, errors: 1, none: 3 });
});

test(`the pass stops at ${MAX_PINNED_CALLS_PER_PASS} calls`, async () => {
  mockQueries = Array.from({ length: 10 }, (_, i) => q({ id: `q${i}`, query: `query ${i}` }));
  dataforseo.request.mockResolvedValue(serp([]));
  const summary = await runPinnedCaptures({ pass: 'am' });
  expect(MAX_PINNED_CALLS_PER_PASS).toBe(12);
  expect(dataforseo.request).toHaveBeenCalledTimes(12);
  expect(mockInserts).toHaveLength(12);
  expect(summary).toMatchObject({ pinned: 10, attempted: 12 });
});

test('with more pins than one pass takes, the am and pm passes start at different pins and cover them all', async () => {
  mockQueries = Array.from({ length: 10 }, (_, i) => q({ id: `q${i}`, query: `query ${i}` }));
  dataforseo.request.mockResolvedValue(serp([]));
  await runPinnedCaptures({ pass: 'am' });
  const am = new Set(mockInserts.map((r) => r.query_id));
  mockInserts.length = 0;
  await runPinnedCaptures({ pass: 'pm' });
  const pm = new Set(mockInserts.map((r) => r.query_id));
  expect(am.size).toBe(6);
  expect(pm.size).toBe(6);
  expect(new Set([...am, ...pm]).size).toBe(10);
});

test('an unknown pass is refused before any query', async () => {
  await expect(runPinnedCaptures({ pass: 'noon' })).rejects.toThrow(/pass/);
  expect(dataforseo.request).not.toHaveBeenCalled();
});
