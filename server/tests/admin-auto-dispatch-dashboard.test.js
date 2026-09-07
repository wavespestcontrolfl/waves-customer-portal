// Dashboard contract: current runtime status, preserved audit data, truthful
// manual outcomes, admin-only access, and direct Agent Ops run visibility.
jest.mock('../models/db', () => { const db = jest.fn(); db.schema = { hasTable: jest.fn() }; return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/auto-dispatch', () => ({ runAutoDispatch: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((key, fn) => fn()) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(), gateEnvValue: jest.fn(() => false) }));
jest.mock('../services/lead-attribution', () => ({}));
jest.mock('../services/agent-activity', () => ({}));
jest.mock('../services/model-switchboard', () => ({ AREAS: [] }));
jest.mock('../services/model-discovery', () => ({}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    if (!req.headers['x-test-role']) return res.sendStatus(401);
    req.techRole = req.headers['x-test-role'];
    req.technicianId = 'test-admin';
    next();
  },
  requireAdmin: (req, res, next) => req.techRole === 'admin' ? next() : res.sendStatus(403),
}));
const express = require('express');
const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { runAutoDispatch } = require('../services/auto-dispatch');
const { runExclusive } = require('../utils/cron-lock');
const autoDispatch = require('../routes/admin-auto-dispatch');
const agents = require('../routes/admin-agents');
let server, base;
let rows, runRow, logs;
const savedEnv = { mode: process.env.AUTO_DISPATCH_MODE, apply: process.env.AUTO_DISPATCH_ALLOW_APPLY };
function chain(result) {
  const qb = {};
  for (const method of ['where', 'orderBy', 'limit', 'leftJoin', 'select']) qb[method] = jest.fn(() => qb);
  qb.first = jest.fn(async () => runRow);
  qb.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return qb;
}
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/auto-dispatch', autoDispatch);
  app.use('/agents', agents);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  for (const [key, value] of [['AUTO_DISPATCH_MODE', savedEnv.mode], ['AUTO_DISPATCH_ALLOW_APPLY', savedEnv.apply]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  jest.clearAllMocks();
  process.env.AUTO_DISPATCH_MODE = 'apply';
  delete process.env.AUTO_DISPATCH_ALLOW_APPLY;
  isEnabled.mockReturnValue(true);
  runExclusive.mockImplementation((key, fn) => fn());
  runRow = { id: 'run-1', status: 'completed', mode: 'dry_run', started_at: new Date(), total_changed: 0, total_evaluated: 2, total_failed: 0 };
  rows = [runRow];
  logs = [{ id: 'audit-1', scheduled_service_id: 'visit-1', old_scheduled_date: '2026-09-20', current_scheduled_date: '2026-09-24', current_visit_id: 'visit-1' }];
  db.mockImplementation((table) => chain(table === 'auto_dispatch_runs' ? rows : logs));
  db.schema.hasTable.mockImplementation(async (table) => table === 'auto_dispatch_runs');
});
const request = (path, options = {}) => fetch(base + path, { ...options, headers: { 'x-test-role': 'admin', 'Content-Type': 'application/json', ...options.headers } });

it('keeps all dashboard endpoints behind authentication and admin role checks', async () => {
  expect((await fetch(base + '/auto-dispatch/runs')).status).toBe(401);
  expect((await request('/auto-dispatch/runs', { headers: { 'x-test-role': 'tech' } })).status).toBe(403);
  expect(db).not.toHaveBeenCalled();
});
it('reports the effective runtime policy rather than deriving it from an old run', async () => {
  isEnabled.mockImplementation((gate) => gate !== 'cronJobs');
  const data = await (await request('/auto-dispatch/runs')).json();
  expect(data.automation).toMatchObject({ scheduledEnabled: false, config: { mode: 'dry_run', applyBlocked: true, applyAllowed: false } });
  expect(data.runs).toHaveLength(1);
});
it('retains historical placement alongside live appointment data', async () => {
  const data = await (await request('/auto-dispatch/runs/run-1')).json();
  expect(data.logs[0]).toMatchObject({ old_scheduled_date: '2026-09-20', current_scheduled_date: '2026-09-24', current_visit_id: 'visit-1' });
  const query = db.mock.results.find((_, index) => db.mock.calls[index][0] === 'auto_dispatch_audit_logs as audit').value;
  expect(query.where).toHaveBeenCalledWith('audit.auto_dispatch_run_id', 'run-1');
});
it.each(['failed', 'completed_with_errors'])('reports an unsuccessful manual %s outcome with the run id', async (status) => {
  runAutoDispatch.mockResolvedValue({ runId: 'failed-run', status, failed: 1 });
  const res = await request('/auto-dispatch/run', { method: 'POST', body: '{"mode":"dry_run"}' });
  expect(await res.json()).toMatchObject({ ok: false, runId: 'failed-run', status });
  expect(runExclusive).toHaveBeenCalledWith('auto-dispatch-recurring', expect.any(Function));
});
it('retains the apply gate and the shared-lock conflict response', async () => {
  expect((await request('/auto-dispatch/run', { method: 'POST', body: '{"mode":"apply"}' })).status).toBe(403);
  expect(runAutoDispatch).not.toHaveBeenCalled();
  runExclusive.mockResolvedValue({ skipped: true, reason: 'lock_held' });
  expect((await request('/auto-dispatch/run', { method: 'POST', body: '{"mode":"dry_run"}' })).status).toBe(409);
});
it('shows failed day-move runs in Agent Ops even without a reorder ledger', async () => {
  rows = [{ ...runRow, status: 'failed', id: 'independent-run' }];
  const data = await (await request('/agents/overview')).json();
  expect(data.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ agentId: 'dispatch', status: 'needs_review', actionUrl: '/admin/agents?tab=dispatch&run=independent-run' })]));
  expect(data.agents.find((agent) => agent.id === 'dispatch')).toMatchObject({ status: 'needs_review', primaryUrl: '/admin/agents?tab=dispatch' });
});
it('counts a healthy day-move run as information instead of approval work', async () => {
  const data = await (await request('/agents/overview')).json();
  expect(data.tasks.find((task) => task.source === 'auto_dispatch_runs')).toMatchObject({ status: 'info' });
  expect(data.agents.find((agent) => agent.id === 'dispatch')).toMatchObject({ openTasks: 0, needsApproval: 0 });
});
