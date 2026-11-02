/**
 * Public moving page routes (GATE_MOVING_FLOW): /api/public/moving/:token.
 * The service is mocked here; moving-flow-postgres.test.js runs it for real.
 * Pins: dark = 404 everywhere, malformed/unknown tokens = the same 404, only
 * the allowed fields leave the check route, a MoveError keeps its status and
 * words, and submit passes a checkId only when it is a non-empty string.
 */
let mockGateOn = true;
jest.mock('../config/feature-gates', () => ({ movingFlowLive: () => mockGateOn }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-moves', () => {
  class MoveError extends Error {
    constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
  }
  return {
    MoveError,
    TOKEN_RE: /^[a-f0-9]{48}$/,
    loadMoveByToken: jest.fn(),
    publicMoveView: jest.fn(),
    checkMoveAddress: jest.fn(),
    submitMove: jest.fn(),
    receiptFor: jest.fn(() => ['Thanks, Chris. We have your move.']),
  };
});

const express = require('express');
const Moves = require('../services/customer-moves');
const router = require('../routes/moving-public');

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

const TOKEN = 'ab'.repeat(24);
const MOVE = { id: 'move-1', customer_id: 'cust-1', token: TOKEN, status: 'open' };

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/public/moving', router);
  return a;
}

beforeEach(() => {
  mockGateOn = true;
  jest.clearAllMocks();
  Moves.loadMoveByToken.mockResolvedValue(MOVE);
});

test('dark: every route answers the same 404 and never reads a move', async () => {
  mockGateOn = false;
  const a = app();
  for (const [method, path] of [['get', `/api/public/moving/${TOKEN}`], ['post', `/api/public/moving/${TOKEN}/check`], ['post', `/api/public/moving/${TOKEN}/submit`]]) {
    const res = await request(a)[method](path).send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(res.headers['cache-control']).toBe('private, no-store');
  }
  expect(Moves.loadMoveByToken).not.toHaveBeenCalled();
});

test('a malformed token or an unknown move is the same 404', async () => {
  const a = app();
  const bad = await request(a).get('/api/public/moving/not-a-token');
  expect(bad.status).toBe(404);
  expect(Moves.loadMoveByToken).not.toHaveBeenCalled();
  Moves.loadMoveByToken.mockResolvedValueOnce(null);
  const unknown = await request(a).get(`/api/public/moving/${TOKEN}`);
  expect(unknown.status).toBe(404);
  expect(unknown.body).toEqual({ error: 'Not found' });
});

test('GET answers the public view with no-store headers', async () => {
  Moves.publicMoveView.mockResolvedValue({ firstName: 'Chris', services: ['Monthly Pest Control Service'], status: 'open' });
  const res = await request(app()).get(`/api/public/moving/${TOKEN}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ firstName: 'Chris', services: ['Monthly Pest Control Service'], status: 'open' });
  expect(res.headers['cache-control']).toBe('private, no-store');
  expect(res.headers['referrer-policy']).toBe('no-referrer');
});

test('check passes only a string address and returns only typed, normalized, verdict and checkId', async () => {
  Moves.checkMoveAddress.mockResolvedValue({ typed: '12 Example Way', normalized: { city: 'Parrish' }, verdict: 'in_area', checkId: 'abcdef0123456789', reused: false, extra: 'x' });
  const res = await request(app()).post(`/api/public/moving/${TOKEN}/check`).send({ address: '12 Example Way' });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ typed: '12 Example Way', normalized: { city: 'Parrish' }, verdict: 'in_area', checkId: 'abcdef0123456789' });
  expect(Moves.checkMoveAddress).toHaveBeenCalledWith(MOVE, '12 Example Way');
  await request(app()).post(`/api/public/moving/${TOKEN}/check`).send({ address: { nested: true } });
  expect(Moves.checkMoveAddress).toHaveBeenLastCalledWith(MOVE, '');
});

test('a MoveError keeps its status and plain words; anything else is a generic 500', async () => {
  Moves.checkMoveAddress.mockRejectedValueOnce(new Moves.MoveError('check_cap', 'We have checked that address a few times today.', 429));
  const capped = await request(app()).post(`/api/public/moving/${TOKEN}/check`).send({ address: '12 Example Way' });
  expect(capped.status).toBe(429);
  expect(capped.body).toEqual({ error: 'We have checked that address a few times today.' });
  Moves.checkMoveAddress.mockRejectedValueOnce(new Error('db exploded at host x'));
  const broken = await request(app()).post(`/api/public/moving/${TOKEN}/check`).send({ address: '12 Example Way' });
  expect(broken.status).toBe(500);
  expect(broken.body.error).not.toMatch(/db exploded/);
});

test('submit passes a checkId only as a non-empty string and answers the receipt', async () => {
  Moves.submitMove.mockResolvedValue({ view: { firstName: 'Chris', status: 'submitted' } });
  const res = await request(app()).post(`/api/public/moving/${TOKEN}/submit`)
    .send({ checkId: true, moveOutDate: '2026-11-15', moveInDate: '' });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true, receipt: ['Thanks, Chris. We have your move.'], view: { firstName: 'Chris', status: 'submitted' } });
  expect(Moves.submitMove).toHaveBeenCalledWith(MOVE, { checkId: null, moveOutDate: '2026-11-15', moveInDate: '' });
  await request(app()).post(`/api/public/moving/${TOKEN}/submit`).send({ checkId: 'abcdef0123456789' });
  expect(Moves.submitMove).toHaveBeenLastCalledWith(MOVE, { checkId: 'abcdef0123456789', moveOutDate: undefined, moveInDate: undefined });
});

test('a stale check is a 409 with plain words', async () => {
  Moves.submitMove.mockRejectedValueOnce(new Moves.MoveError('stale_check', 'That address changed in another window. Check it again, then confirm it.', 409));
  const res = await request(app()).post(`/api/public/moving/${TOKEN}/submit`).send({ checkId: 'abcdef0123456789' });
  expect(res.status).toBe(409);
  expect(res.body).toEqual({ error: 'That address changed in another window. Check it again, then confirm it.' });
});
