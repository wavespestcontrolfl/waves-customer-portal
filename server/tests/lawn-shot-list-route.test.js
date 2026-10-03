// GATE_LAWN_SHOT_LIST (lawn report rebuild P18) on the admin lawn assessment
// routes: the photo request contract (cap 8, shot keys, per-shot maximum) and
// the flag the admin drawer reads. Every refusal returns before any query, so
// the db is mocked to throw. Gate off is the contract the route always had.
// Synthetic ids only.
let mockRole = 'admin';
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
}));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return { ...actual, adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = mockRole; req.technician = { id: 'admin-1', name: 'Fixture' }; next(); } };
});
jest.mock('../services/technician-visit-scope', () => ({
  isTechnicianRequest: (req) => req.techRole === 'technician',
  technicianServicesCustomer: jest.fn(async () => true),
  technicianCurrentVisitFilter: jest.fn((req, q) => q),
  TECH_DEAD_ASSIGNMENT_STATUSES: ['cancelled', 'canceled', 'rescheduled', 'skipped', 'no_show'],
}));
jest.mock('../services/lawn-assessment', () => ({}));
jest.mock('../services/lawn-intelligence', () => ({}));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-lawn-assessment');

const CUSTOMER = '11111111-2222-4333-8444-555555555555';
const photo = (zone) => ({ data: 'YQ==', mimeType: 'image/jpeg', ...(zone ? { zone } : {}) });

function withServer(fn) {
  const app = express();
  app.use(express.json({ limit: '100mb' }));
  app.use('/api/admin/lawn-assessment', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/admin/lawn-assessment`;
  return fn(base).finally(() => new Promise((r) => server.close(r)));
}
const call = (base, method, path, body) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const assess = (photos) => withServer(async (base) => {
  const res = await call(base, 'POST', '/assess', { customerId: CUSTOMER, photos });
  return { status: res.status, body: await res.json() };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = 'admin';
  mockGates = {};
  db.mockImplementation(() => { throw new Error('db must not be reached'); });
});

describe('POST /assess photo contract, visit assessment on', () => {
  beforeEach(() => { mockGates = { GATE_LAWN_VISIT_ASSESSMENT: true }; });

  test('shot list off: cap 6 and the three-slot vocabulary, exactly as before', async () => {
    const seven = await assess(Array.from({ length: 7 }, () => photo()));
    expect(seven).toEqual({ status: 400, body: { error: 'At most 6 photos per visit' } });
    const hot = await assess([photo('hot_edge')]);
    expect(hot.status).toBe(400);
    expect(hot.body.error).toMatch(/front, close_up, trouble/);
    const back = await assess([photo('back')]);
    expect(back.body.error).toMatch(/front, close_up, trouble/);
  });

  test('shot list on: cap 8, every shot key accepted past the zone check, per-shot maximum enforced', async () => {
    mockGates = { GATE_LAWN_VISIT_ASSESSMENT: true, GATE_LAWN_SHOT_LIST: true };
    const nine = await assess(Array.from({ length: 9 }, () => photo()));
    expect(nine).toEqual({ status: 400, body: { error: 'At most 8 photos per visit' } });
    const twoBack = await assess([photo('back'), photo('back')]);
    expect(twoBack.body.error).toMatch(/only one photo can be the back overview/i);
    const threeTrouble = await assess([photo('trouble'), photo('trouble'), photo('trouble')]);
    expect(threeTrouble.body.error).toMatch(/at most 2 photos can be the problem area/i);
    const garage = await assess([photo('garage')]);
    expect(garage.body.error).toMatch(/front, back, side, close_up, blade_crown, hot_edge, shade, trouble/);
    // Past validation the route reaches its first query (the mocked db throws): proof the set was accepted.
    const accepted = await assess(['front', 'back', 'hot_edge', 'shade', 'close_up', 'blade_crown', 'trouble', 'trouble'].map(photo));
    expect(accepted.status).toBe(500);
  });
});

describe('POST /assess photo contract, visit assessment off (per-photo path)', () => {
  test('shot list off: no cap of its own, only one Front photo, as before', async () => {
    const twoFront = await assess([photo('front'), photo('front')]);
    expect(twoFront).toEqual({ status: 400, body: { error: 'Only one photo can be the Front photo' } });
    const many = await assess(Array.from({ length: 9 }, () => photo()));
    expect(many.status).toBe(500); // reached the first query: nothing capped it
  });

  test('shot list on: cap 8 and the per-shot maximum apply here too', async () => {
    mockGates = { GATE_LAWN_SHOT_LIST: true };
    const nine = await assess(Array.from({ length: 9 }, () => photo()));
    expect(nine).toEqual({ status: 400, body: { error: 'At most 8 photos per visit' } });
    const twoCloseUps = await assess([photo('close_up'), photo('close_up')]);
    expect(twoCloseUps.status).toBe(400);
    expect(twoCloseUps.body.error).toMatch(/only one photo can be the canopy close-up/i);
    const ok = await assess([photo('close_up'), photo('trouble'), photo('trouble')]);
    expect(ok.status).toBe(500);
  });

  test('shot list on: a non-empty invalid tag is refused (same words as the visit path), never stored unlabeled', async () => {
    mockGates = { GATE_LAWN_SHOT_LIST: true };
    const garage = await assess([photo('front'), photo('garage')]);
    expect(garage.status).toBe(400);
    expect(garage.body.error).toMatch(/photo zone must be one of: front, back, side, close_up, blade_crown, hot_edge, shade, trouble/);
    mockGates = { GATE_LAWN_SHOT_LIST: true, GATE_LAWN_VISIT_ASSESSMENT: true };
    const visitPath = await assess([photo('front'), photo('garage')]);
    expect(visitPath.body.error).toBe(garage.body.error);
  });

  test('shot list on: the size rule refuses a set that cannot fit the request body, naming the photo', async () => {
    mockGates = { GATE_LAWN_SHOT_LIST: true };
    const big = (mb) => ({ data: Buffer.alloc(Math.floor(mb * 1048576)).toString('base64'), mimeType: 'image/jpeg' });
    const total = await assess(Array.from({ length: 7 }, () => big(4.5)));
    expect(total.status).toBe(400);
    expect(total.body.error).toMatch(/total 31\.5 MB; one visit can carry 30\.0 MB/);
    const single = await assess([photo('front'), big(5.5)]);
    expect(single.body.error).toMatch(/^Photo 2 is 5\.5 MB; each photo must be 5\.0 MB or smaller/);
    mockGates = {};
    const off = await assess([photo('front'), big(5.5)]);
    expect(off.status).toBe(500); // gate off: no size rule on this path, as before
  });
});

describe('GET /service/:serviceId tells the drawer whether the shot list is live', () => {
  const lookup = (assessment) => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.orderBy = jest.fn(() => chain);
    chain.first = jest.fn(async () => assessment);
    db.mockImplementation(() => chain);
  };

  test('absent when off, present when on, with or without an assessment on file', async () => {
    lookup(null);
    const off = await withServer(async (base) => (await call(base, 'GET', '/service/svc-1')).json());
    expect(off).toEqual({ assessment: null });
    mockGates = { GATE_LAWN_SHOT_LIST: true };
    const on = await withServer(async (base) => (await call(base, 'GET', '/service/svc-1')).json());
    expect(on).toEqual({ shotListEnabled: true, assessment: null });
  });
});
