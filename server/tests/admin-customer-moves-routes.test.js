/**
 * Admin moving routes (GATE_MOVING_FLOW) behind Customer 360's Moving card:
 * GET /:id/moves, POST /:id/moving-link, POST /:id/moving-email. Pins: admin
 * only, dark = { enabled: false } for the read and 404 for both writes, an
 * unknown customer is a 404, and each write calls the one service function.
 */
let mockGateOn = true;
jest.mock('../config/feature-gates', () => ({ movingFlowLive: () => mockGateOn }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const role = token === 'admin' ? 'admin' : token === 'tech' ? 'technician' : null;
    if (!role) return res.status(401).json({ error: 'Admin authentication required' });
    req.technicianId = `${role}-1`;
    req.techRole = role;
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole !== 'admin' ? res.status(403).json({ error: 'Admin access required' }) : next()),
}));
let mockCustomerRow = { id: 'x' };
jest.mock('../models/db', () => jest.fn(() => {
  const b = {};
  b.where = jest.fn(() => b);
  b.whereNull = jest.fn(() => b);
  b.first = jest.fn(async () => mockCustomerRow);
  return b;
}));
jest.mock('../services/customer-moves', () => ({
  recentMoves: jest.fn(async () => [{ id: 'move-1', status: 'open' }]),
  openMoveForCustomer: jest.fn(async () => ({ id: 'move-1', status: 'open', token: 'ab'.repeat(24) })),
  movingLinkFor: jest.fn(async () => 'https://wvs.sh/m1'),
  sendMovingEmail: jest.fn(async () => ({ ok: true, sent: true, reason: null, moveId: 'move-1' })),
}));

const express = require('express');
const Moves = require('../services/customer-moves');
const router = require('../routes/admin-customer-moves');

// The repo has no supertest: a tiny stand-in with the same get/post/set/send
// chain that listens on a free port and uses fetch, like the other route
// suites (admin-communications-reservice-link.test.js).
async function call(app, method, path, { body, headers } = {}) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: method.toUpperCase(),
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: body === undefined || /^(get|head)$/i.test(method) ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, body: json, headers: Object.fromEntries(res.headers.entries()) };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(app) {
  const make = (method, path) => {
    const state = { headers: {}, body: undefined };
    const chain = {
      set(h) { Object.assign(state.headers, h); return chain; },
      send(b) { state.body = b; return chain; },
      then(resolve, reject) { return call(app, method, path, state).then(resolve, reject); },
    };
    return chain;
  };
  return { get: (path) => make('get', path), post: (path) => make('post', path) };
}

const CUSTOMER = '3f2b8c4e-9d1a-4f6b-8e2c-5a7d9b1c3e5f';
const ADMIN = { Authorization: 'Bearer admin' };

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin/customers', router);
  return a;
}

beforeEach(() => {
  mockGateOn = true;
  mockCustomerRow = { id: CUSTOMER };
  jest.clearAllMocks();
});

test('technicians and anonymous callers are refused', async () => {
  expect((await request(app()).get(`/api/admin/customers/${CUSTOMER}/moves`)).status).toBe(401);
  expect((await request(app()).post(`/api/admin/customers/${CUSTOMER}/moving-link`).set({ Authorization: 'Bearer tech' })).status).toBe(403);
  expect(Moves.openMoveForCustomer).not.toHaveBeenCalled();
});

test('dark: the read says enabled false and both writes 404 without touching a move', async () => {
  mockGateOn = false;
  const read = await request(app()).get(`/api/admin/customers/${CUSTOMER}/moves`).set(ADMIN);
  expect(read.status).toBe(200);
  expect(read.body).toEqual({ enabled: false, moves: [] });
  expect((await request(app()).post(`/api/admin/customers/${CUSTOMER}/moving-link`).set(ADMIN)).status).toBe(404);
  expect((await request(app()).post(`/api/admin/customers/${CUSTOMER}/moving-email`).set(ADMIN)).status).toBe(404);
  expect(Moves.recentMoves).not.toHaveBeenCalled();
  expect(Moves.openMoveForCustomer).not.toHaveBeenCalled();
  expect(Moves.sendMovingEmail).not.toHaveBeenCalled();
});

test('the read lists the latest moves', async () => {
  const res = await request(app()).get(`/api/admin/customers/${CUSTOMER}/moves`).set(ADMIN);
  expect(res.body).toEqual({ enabled: true, moves: [{ id: 'move-1', status: 'open' }] });
  expect(Moves.recentMoves).toHaveBeenCalledWith(CUSTOMER, 5);
});

test('moving-link opens or reuses the move and answers its link; sends nothing', async () => {
  const res = await request(app()).post(`/api/admin/customers/${CUSTOMER}/moving-link`).set(ADMIN);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ url: 'https://wvs.sh/m1', moveId: 'move-1', status: 'open' });
  expect(Moves.openMoveForCustomer).toHaveBeenCalledWith(CUSTOMER, { actorId: 'admin-1' });
  expect(Moves.sendMovingEmail).not.toHaveBeenCalled();
});

test('moving-email sends on this click and answers the outcome', async () => {
  const res = await request(app()).post(`/api/admin/customers/${CUSTOMER}/moving-email`).set(ADMIN);
  expect(res.body).toEqual({ ok: true, sent: true, reason: null, moveId: 'move-1' });
  expect(Moves.sendMovingEmail).toHaveBeenCalledWith({ customerId: CUSTOMER, actorId: 'admin-1' });
});

test('an unknown or malformed customer is a 404', async () => {
  mockCustomerRow = null;
  expect((await request(app()).post(`/api/admin/customers/${CUSTOMER}/moving-link`).set(ADMIN)).status).toBe(404);
  expect((await request(app()).post('/api/admin/customers/not-a-uuid/moving-email').set(ADMIN)).status).toBe(404);
  expect(Moves.openMoveForCustomer).not.toHaveBeenCalled();
});
