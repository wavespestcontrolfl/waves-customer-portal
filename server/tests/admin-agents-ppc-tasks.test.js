// The Agents hub raises a PPC task for spend problems only. A campaign the
// capacity rule put in 'stop' is the rule working as designed, not a task.
jest.mock('../models/db', () => { const db = jest.fn(); db.schema = { hasTable: jest.fn() }; return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(), gateEnvValue: jest.fn(() => false) }));
jest.mock('../services/lead-attribution', () => ({}));
jest.mock('../services/agent-activity', () => ({}));
jest.mock('../services/model-switchboard', () => ({ AREAS: [] }));
jest.mock('../services/model-discovery', () => ({}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => { req.techRole = 'admin'; next(); },
  requireAdmin: (req, res, next) => next(),
}));
const express = require('express');
const db = require('../models/db');
const agents = require('../routes/admin-agents');

let server, base, campaigns, perf, sourceStatus;
function chain(result) {
  const qb = {};
  for (const method of ['where', 'whereIn', 'orderBy', 'limit', 'select', 'sum', 'groupBy', 'leftJoin']) qb[method] = jest.fn(() => qb);
  qb.first = jest.fn(async () => null);
  qb.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return qb;
}
beforeAll(async () => {
  const app = express();
  app.use('/agents', agents);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  campaigns = [{ id: 'c1', campaign_name: 'Waves Pest Control - GBP Search', campaign_type: '2', target_area: null, budget_mode: 'stop', daily_budget_current: '0.05', created_at: new Date('2026-10-01T12:00:00Z') }];
  perf = [];
  db.schema.hasTable.mockImplementation(async (table) => table === 'ad_campaigns' || table === 'ad_performance_daily');
  db.mockImplementation((table) => chain(table === 'ad_campaigns' ? campaigns : table === 'ad_performance_daily' ? perf : []));
});

async function ppcTasks() {
  const res = await fetch(`${base}/agents/overview`);
  const body = await res.json();
  sourceStatus = body.sources.find((s) => s.id === 'ad_campaigns').status;
  return (body.tasks || []).filter((t) => t.source === 'ad_campaigns');
}

it('raises no PPC task for a stopped campaign with low spend', async () => {
  perf = [{ campaign_id: 'c1', cost: '0.30', conversions: '0', conversion_value: '0' }];
  // the source must be read (not missing), or an empty list proves nothing
  expect(await ppcTasks()).toEqual([]);
  expect(sourceStatus).toBe('ok');
});

it('still raises a high-priority review for high spend with no conversions', async () => {
  perf = [{ campaign_id: 'c1', cost: '120', conversions: '0', conversion_value: '0' }];
  const tasks = await ppcTasks();
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ title: 'Review spend: Waves Pest Control - GBP Search', priority: 'high' });
});
