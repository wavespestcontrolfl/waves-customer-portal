// PATCH /llm-mentions/queries/:id keeps entity-cohort prompt text frozen: the
// scorer keys cohort membership on the exact query, so an edit would silently
// drop the question from the cohort (GitHub review r6 on #4130).
const mockFirst = jest.fn();
const mockReturning = jest.fn();
jest.mock('../models/db', () => {
  const chain = { where: () => chain, first: (...a) => mockFirst(...a), update: () => chain, returning: (...a) => mockReturning(...a) };
  const db = jest.fn(() => chain);
  db.fn = { now: () => 'now' };
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
const { ENTITY_COHORT } = require('../services/seo/aeo-entity-facts');

function call(id, body) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/llm-mentions/queries/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        resolve({ status: res.status, body: await res.json() });
      } catch (err) { reject(err); } finally { server.close(); }
    });
  });
}

afterEach(() => jest.clearAllMocks());

test('editing an entity-cohort prompt is refused; toggling it and editing other prompts still work', async () => {
  const cohortQuery = ENTITY_COHORT.questions[0].query;
  mockFirst.mockResolvedValue({ query: cohortQuery });
  expect(await call(7, { query: `${cohortQuery} please` })).toMatchObject({ status: 409 });
  expect(mockReturning).not.toHaveBeenCalled();

  mockReturning.mockResolvedValue([{ id: 7, query: cohortQuery, active: false }]);
  expect(await call(7, { active: false })).toMatchObject({ status: 200, body: { query: { active: false } } });
  expect(await call(7, { query: cohortQuery, active: true })).toMatchObject({ status: 200 });

  mockFirst.mockResolvedValue({ query: 'best pest control in Bradenton' });
  mockReturning.mockResolvedValue([{ id: 8, query: 'best pest control in Bradenton FL' }]);
  expect(await call(8, { query: 'best pest control in Bradenton FL' })).toMatchObject({ status: 200 });

  mockFirst.mockResolvedValue(undefined);
  expect(await call(9, { query: 'x' })).toMatchObject({ status: 404 });
});
