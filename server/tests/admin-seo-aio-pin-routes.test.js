// PATCH /llm-mentions/queries/:id pin fields and GET /llm-mentions/captures.
const mockUpdate = jest.fn();
const mockSelect = jest.fn();
const mockWhere = jest.fn();
jest.mock('../models/db', () => {
  const chain = {
    where: (...a) => { mockWhere(...a); return chain; },
    first: jest.fn(),
    update: (...a) => { mockUpdate(...a); return chain; },
    returning: () => Promise.resolve([{ id: 7, pin_daily: true }]),
    select: (...a) => { mockSelect(...a); return chain; },
    orderBy: () => chain,
    limit: () => Promise.resolve([{ id: 'c1', status: 'shown' }]),
  };
  const db = jest.fn(() => chain);
  db.fn = { now: () => 'now' };
  db.raw = (...a) => ({ raw: a });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: (_q, _s, n) => n(), requireAdmin: (_q, _s, n) => n(), requireTechOrAdmin: (_q, _s, n) => n() }));
for (const m of ['search-console-v2', 'seo-advisor', 'rank-tracker', 'serp-analyzer', 'backlink-monitor', 'gsc-links-importer', 'ai-overview-tracker', 'content-qa', 'cannibalization', 'content-decay', 'refresh-audit', 'citation-auditor', 'conversion-funnel', 'site-rollup', 'geo-grid-tracker', 'site-auditor']) {
  jest.mock(`../services/seo/${m}`, () => ({}));
}
jest.mock('../services/csv-generators', () => ({ geoGridToCSV: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => false }));

const express = require('express');
const router = require('../routes/admin-seo-v2');

function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
          method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
        });
        resolve({ status: res.status, body: await res.json() });
      } catch (err) { reject(err); } finally { server.close(); }
    });
  });
}
const patch = (body) => call('PATCH', '/llm-mentions/queries/7', body);

afterEach(() => jest.clearAllMocks());

test('pin_daily, pin_until and a coordinate pin_location are accepted', async () => {
  const res = await patch({ pin_daily: true, pin_until: '2026-12-31', pin_location: '27.5870, -82.4248, 10' });
  expect(res.status).toBe(200);
  expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ pin_daily: true, pin_until: '2026-12-31', pin_location: '27.5870, -82.4248, 10' }));
});

test('a place name is accepted, and null or empty clears pin_until and pin_location', async () => {
  expect((await patch({ pin_location: 'Parrish,Florida,United States' })).status).toBe(200);
  expect((await patch({ pin_until: null, pin_location: '' })).status).toBe(200);
  expect(mockUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ pin_until: null, pin_location: null }));
});

test.each([
  [{ pin_daily: 'yes' }],
  [{ pin_until: '2026-02-30' }],
  [{ pin_until: 'tomorrow' }],
  [{ pin_location: '12345' }],
  [{ pin_location: '27.58,-82.42,10,4' }],
  [{ pin_location: 42 }],
])('invalid pin field %j is refused with 400 and nothing is written', async (body) => {
  expect((await patch(body)).status).toBe(400);
  expect(mockUpdate).not.toHaveBeenCalled();
});

test('captures list leaves out raw_item unless raw=1, filters by query_id and clamps days', async () => {
  const res = await call('GET', '/llm-mentions/captures?query_id=11111111-2222-4333-8444-555555555555&days=500');
  expect(res).toMatchObject({ status: 200, body: { captures: [{ id: 'c1' }] } });
  expect(mockSelect.mock.calls[0][0]).not.toContain('raw_item');
  expect(mockWhere).toHaveBeenCalledWith('query_id', '11111111-2222-4333-8444-555555555555');
  expect(mockWhere.mock.calls[0][2].raw[1]).toEqual([90]);

  mockSelect.mockClear();
  await call('GET', '/llm-mentions/captures?raw=1');
  expect(mockSelect.mock.calls[0][0]).toContain('raw_item');
});

test('captures list refuses a query_id that is not a uuid', async () => {
  mockSelect.mockClear();
  const res = await call('GET', '/llm-mentions/captures?query_id=abc');
  expect(res.status).toBe(400);
});
