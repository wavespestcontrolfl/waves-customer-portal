// GET /api/admin/agents/activity asks the Activity feed for owner-only rows (an idea sent to Claude) only for the owner login
// (Codex security review round 4). The feed's own filter is in admin-claude-ideas-db.test.js.
jest.mock('../models/db', () => { const db = jest.fn(); db.schema = { hasTable: jest.fn() }; db.fn = { now: jest.fn() }; return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(), gateEnvValue: jest.fn(() => false) }));
jest.mock('../services/lead-attribution', () => ({}));
jest.mock('../services/agent-activity', () => ({ getActivity: jest.fn(async () => ({ available: true, items: [] })) }));
jest.mock('../services/model-switchboard', () => ({ AREAS: [] }));
jest.mock('../services/model-discovery', () => ({}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    req.techRole = 'admin';
    req.technician = { id: 'u', email: req.headers['x-login'] || null };
    next();
  },
  requireAdmin: (req, res, next) => next(),
}));
const express = require('express');
const agentActivity = require('../services/agent-activity');
const agents = require('../routes/admin-agents');

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use('/agents', agents);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => agentActivity.getActivity.mockClear());

test('the owner login gets fullAccess, the office admin does not, and the focus id is passed either way', async () => {
  const focus = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await fetch(`${base}/agents/activity?hours=24&focus=${focus}`, { headers: { 'x-login': 'contact@wavespestcontrol.com' } });
  await fetch(`${base}/agents/activity?hours=24&focus=${focus}`, { headers: { 'x-login': 'office@example.test' } });
  await fetch(`${base}/agents/activity?hours=24`);
  expect(agentActivity.getActivity.mock.calls.map(([o]) => [o.fullAccess, o.focus])).toEqual([[true, focus], [false, focus], [false, null]]);
});
