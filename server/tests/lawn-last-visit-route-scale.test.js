// GET /service/:serviceId under score scale 2 (GATE_LAWN_SCORE_SCALE_V2, owner 2026-10-24): the
// read-only Last visit row is the last visit on the same score scale as this visit's AI read,
// the scale on its assessment row, else the scale a new read uses now. Synthetic ids only.
let mockGates = {};
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((x) => x);
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../config', () => ({ jwt: { secret: 'test-secret' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gateEnvValue: jest.fn((name) => mockGates[name] === true),
  lawnPhotoLabelPickLive: jest.fn(() => false),
  lawnScoreScaleV2Live: jest.fn(() => mockGates.GATE_LAWN_SCORE_SCALE_V2 === true),
}));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return { ...actual, adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; req.technician = { id: 'admin-1', name: 'Fixture' }; next(); } };
});
jest.mock('../services/technician-visit-scope', () => ({
  isTechnicianRequest: () => false,
  technicianServicesCustomer: jest.fn(async () => true),
  technicianCurrentVisitFilter: jest.fn((req, q) => q),
  TECH_DEAD_ASSIGNMENT_STATUSES: ['cancelled', 'canceled', 'rescheduled', 'skipped', 'no_show'],
}));
jest.mock('../services/lawn-assessment', () => ({}));
jest.mock('../services/lawn-intelligence', () => ({}));
jest.mock('../services/lawn-last-visit-scores', () => ({ lastVisitScores: jest.fn(async () => null) }));
jest.mock('../services/lawn-visit-runs', () => ({ ...jest.requireActual('../services/lawn-visit-runs'), loadRun: jest.fn(async () => null) }));

const express = require('express');
const db = require('../models/db');
const { lastVisitScores } = require('../services/lawn-last-visit-scores');
const router = require('../routes/admin-lawn-assessment');

const VISIT = { id: 'svc-1', customer_id: 'cust-1', scheduled_date: '2026-11-10' };

function lookup(assessment) {
  db.mockImplementation((table) => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.orderBy = jest.fn(() => chain);
    chain.first = jest.fn(async () => (table === 'scheduled_services' ? VISIT : assessment));
    chain.catch = jest.fn(async () => []);
    return chain;
  });
}
async function get() {
  const app = express();
  app.use('/api/admin/lawn-assessment', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/lawn-assessment/service/svc-1`);
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => { jest.clearAllMocks(); mockGates = {}; });

test.each([
  ['no assessment yet, gate off: scale 1', null, {}, 1],
  ['no assessment yet, gate on: the scale a new read uses', null, { GATE_LAWN_SCORE_SCALE_V2: true }, 2],
  ['a scale-2 read on file, gate since off: its own scale', { id: 'a-1', score_scale: 2 }, {}, 2],
  ['a scale-1 read on file, gate since on: its own scale', { id: 'a-1', score_scale: null }, { GATE_LAWN_SCORE_SCALE_V2: true }, 1],
])('%s', async (_name, assessment, gates, scoreScale) => {
  mockGates = gates;
  lookup(assessment);
  const { status, body } = await get();
  expect(status).toBe(200);
  expect(lastVisitScores).toHaveBeenCalledWith(VISIT, db, { scoreScale });
  expect(body.lastVisit).toBeNull();
});
