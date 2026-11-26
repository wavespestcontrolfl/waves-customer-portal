/**
 * Admin Automations tab and the two seeded new_lead drip steps (GATE_NEW_LEAD_DRIP_STEPS): they are stored enabled=false so a
 * runner from before the drip, or a revert of it, can never select them. The tab must say they are gate-controlled, and a save
 * must not persist enabled=true. Synthetic rows only.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/automation-runner', () => ({ normalizeAutomationFromEmail: (v) => v, testSequence: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const db = require('../models/db');
const { NEW_LEAD_DRIP_STEP_IDS } = require('../services/new-lead-drip-stops');
const router = require('../routes/admin-automations');

function chain({ result = [], first } = {}) {
  const q = {};
  ['where', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.update = jest.fn(async () => 1);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return q;
}

let server;
let baseUrl;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/automations', router);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/automations`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => jest.clearAllMocks());

const STEP_ROWS = [
  { id: 'step-0', template_key: 'new_lead', step_order: 0, enabled: true },
  { id: NEW_LEAD_DRIP_STEP_IDS[0], template_key: 'new_lead', step_order: 1, enabled: false },
  { id: NEW_LEAD_DRIP_STEP_IDS[1], template_key: 'new_lead', step_order: 2, enabled: false },
];

test('the template detail marks only the two seeded drip steps as gate controlled', async () => {
  const tables = { automation_templates: [chain({ first: { key: 'new_lead' } })], automation_steps: [chain({ result: STEP_ROWS })] };
  db.mockImplementation((table) => tables[table].shift());
  const body = await (await fetch(`${baseUrl}/templates/new_lead`)).json();
  expect(body.steps.map((s) => [s.id, !!s.gate_controlled])).toEqual([
    ['step-0', false], [NEW_LEAD_DRIP_STEP_IDS[0], true], [NEW_LEAD_DRIP_STEP_IDS[1], true],
  ]);
});

test.each([[0], [1]])('saving drip step %i with enabled=true keeps the stored enabled=false', async (index) => {
  const row = STEP_ROWS[index + 1];
  const read = chain({ first: row });
  const write = chain();
  const reread = chain({ first: row });
  const queue = [read, write, reread];
  db.mockImplementation(() => queue.shift());
  const res = await fetch(`${baseUrl}/steps/${row.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, subject: 'New subject' }),
  });
  expect(res.status).toBe(200);
  expect(write.update).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, subject: 'New subject' }));
});

test('an ordinary step still saves the enabled value it is sent', async () => {
  const row = { id: 'step-0', enabled: false };
  const write = chain();
  const queue = [chain({ first: row }), write, chain({ first: row })];
  db.mockImplementation(() => queue.shift());
  await fetch(`${baseUrl}/steps/step-0`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  });
  expect(write.update).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
});
