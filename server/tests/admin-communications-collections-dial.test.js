/**
 * POST /admin/communications/collections-cases/:id/dial (PR C) — pins:
 *  - master gate off ⇒ 409 lane_dark, ZERO db reads;
 *  - admin-only (requireAdmin) — a tech token is refused;
 *  - shadow/proposed promote is GUARDED (state + case_version fence) and
 *    stamped with the acting admin + 24h expiry; a lost fence ⇒ 409;
 *  - held/cancelled/dialing states are never dialable from here;
 *  - policy refusals return 200 with origination's verdict verbatim — the
 *    endpoint makes no eligibility judgment of its own.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.fn = { now: jest.fn(() => 'NOW()') };
  return fn;
});
jest.mock('../services/twilio', () => ({}));
jest.mock('twilio', () => jest.fn(() => ({ calls: { create: jest.fn() } })));
jest.mock('../config', () => ({ twilio: { accountSid: 'AC_test', authToken: 'auth_test' } }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token !== 'admin' && token !== 'tech') return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = { id: `${token}-1`, role: token, email: `${token}@waves.test` };
    req.technicianId = `${token}-1`;
    req.techRole = token;
    return next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (req, res, next) =>
    (req.techRole !== 'admin'
      ? res.status(403).json({ error: 'Admin access required' })
      : next()),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-media', () => ({
  mediaFromOutboundAttachments: jest.fn(() => []),
  signMediaForClient: jest.fn(async (media) => media),
}));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/collections/outbound-voice/origination', () => ({
  originateCollectionCall: jest.fn(),
  CALL_SOURCE: 'collections_voice',
}));

const express = require('express');
const db = require('../models/db');
const { originateCollectionCall } = require('../services/collections/outbound-voice/origination');
const communicationsRouter = require('../routes/admin-communications');

function chain({ first, updateResult = 1 } = {}) {
  const q = { _wheres: [], _patches: [] };
  q.where = jest.fn((...a) => { q._wheres.push(a); return q; });
  q.whereIn = jest.fn(() => q);
  q.whereNot = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.update = jest.fn(async (patch) => { q._patches.push(patch); return updateResult; });
  return q;
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/communications', communicationsRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try { return await fn(baseUrl); } finally { await new Promise((r) => { server.close(r); }); }
}

const CASE_UUID = 'a1b2c3d4-0000-4000-8000-000000000001';

function dial(baseUrl, { token = 'admin', id = CASE_UUID } = {}) {
  return fetch(`${baseUrl}/admin/communications/collections-cases/${id}/dial`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.transaction = jest.fn(async (fn) => {
    const trx = (t) => db(t);
    trx.raw = jest.fn(async () => ({}));
    trx.fn = db.fn;
    return fn(trx);
  });
  process.env.GATE_VOICE_LATE_PAYMENT = 'true';
  originateCollectionCall.mockResolvedValue({ dialed: true, reason: 'dialed', callSid: 'CA1', callLogId: 'cl-1' });
});

afterAll(() => { delete process.env.GATE_VOICE_LATE_PAYMENT; });

test('master gate off ⇒ 409 lane_dark with ZERO db reads', async () => {
  process.env.GATE_VOICE_LATE_PAYMENT = 'false';
  await withServer(async (baseUrl) => {
    const res = await dial(baseUrl);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('lane_dark');
  });
  expect(db).not.toHaveBeenCalled();
  expect(originateCollectionCall).not.toHaveBeenCalled();
});

test('a tech token is refused — this endpoint places a phone call', async () => {
  await withServer(async (baseUrl) => {
    const res = await dial(baseUrl, { token: 'tech' });
    expect(res.status).toBe(403);
  });
  expect(originateCollectionCall).not.toHaveBeenCalled();
});

test('a shadow case is promoted (guarded, admin-stamped, 24h expiry) and dialed', async () => {
  const readChain = chain({ first: { id: CASE_UUID, current_state: 'shadow', case_version: 3 } });
  const promote = chain({ updateResult: 1 });
  const queues = [readChain, chain({ first: undefined }), promote]; // live-check then promote
  db.mockImplementation(() => queues.shift());
  await withServer(async (baseUrl) => {
    const res = await dial(baseUrl);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dialed: true, reason: 'dialed' });
  });
  expect(promote._wheres[0][0]).toEqual({ id: CASE_UUID, current_state: 'shadow', case_version: 3 });
  const patch = promote._patches[0];
  expect(patch.current_state).toBe('approved');
  expect(patch.approved_by).toBe('admin:admin@waves.test');
  expect(patch.approval_expires_at.getTime() - patch.approved_at.getTime()).toBe(24 * 60 * 60 * 1000);
  expect(originateCollectionCall).toHaveBeenCalledWith(CASE_UUID);
});

test('a LOST promote fence ⇒ 409 case_moved, no dial', async () => {
  const queues = [
    chain({ first: { id: CASE_UUID, current_state: 'proposed', case_version: 3 } }),
    chain({ first: undefined }), // in-lock live-check
    chain({ updateResult: 0 }),
  ];
  db.mockImplementation(() => queues.shift());
  await withServer(async (baseUrl) => {
    const res = await dial(baseUrl);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('case_moved');
  });
  expect(originateCollectionCall).not.toHaveBeenCalled();
});

test('held/dialing/cancelled states are never dialable from here', async () => {
  for (const state of ['held', 'dialing', 'cancelled', 'expired', 'lapsed']) {
    jest.clearAllMocks();
    originateCollectionCall.mockResolvedValue({ dialed: true, reason: 'dialed' });
    db.mockImplementation(() => chain({ first: { id: CASE_UUID, current_state: state, case_version: 1 } }));
    await withServer(async (baseUrl) => {
      const res = await dial(baseUrl);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('case_not_dialable');
    });
    expect(originateCollectionCall).not.toHaveBeenCalled();
  }
});

test('an already-approved case dials without a second promote', async () => {
  const readChain = chain({ first: { id: CASE_UUID, current_state: 'approved', case_version: 2 } });
  db.mockImplementation(() => readChain);
  await withServer(async (baseUrl) => {
    const res = await dial(baseUrl);
    expect(res.status).toBe(200);
  });
  expect(readChain.update).not.toHaveBeenCalled();
  expect(originateCollectionCall).toHaveBeenCalledWith(CASE_UUID);
});

test('a policy refusal returns 200 with origination\'s verdict verbatim', async () => {
  originateCollectionCall.mockResolvedValue({ dialed: false, reason: 'policy_denied', denialReasons: ['voice_contact_within_7d'] });
  const queues = [
    chain({ first: { id: CASE_UUID, current_state: 'proposed', case_version: 1 } }),
    chain({ first: undefined }), // in-lock live-check
    chain({ updateResult: 1 }),
    chain({ updateResult: 1 }), // revert after the policy refusal
  ];
  db.mockImplementation(() => queues.shift());
  await withServer(async (baseUrl) => {
    const res = await dial(baseUrl);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dialed: false, reason: 'policy_denied' });
  });
});

test('unknown case ⇒ 404', async () => {
  db.mockImplementation(() => chain({ first: undefined }));
  await withServer(async (baseUrl) => {
    const res = await dial(baseUrl);
    expect(res.status).toBe(404);
  });
});

// codex gh-r1 P2: the kill-switch view surfaces the autodial gate's
// EFFECTIVE state.
test('collections-voice-status reports GATE_VOICE_LATE_PAYMENT_AUTODIAL (effective, chained)', async () => {
  process.env.GATE_VOICE_LATE_PAYMENT_AUTODIAL = 'true'; // alone — chain unsatisfied
  delete process.env.GATE_COLLECTIONS_POLICY;
  db.mockImplementation(() => {
    const q = {};
    ['select', 'count', 'groupBy', 'where', 'orderBy', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.catch = jest.fn(async () => []);
    return q;
  });
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/admin/communications/collections-voice-status`, {
      headers: { Authorization: 'Bearer admin' },
    });
    const body = await res.json();
    expect(body.gates.GATE_VOICE_LATE_PAYMENT_AUTODIAL).toBe(false); // chain, not the raw env

    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const res2 = await fetch(`${baseUrl}/admin/communications/collections-voice-status`, {
      headers: { Authorization: 'Bearer admin' },
    });
    expect((await res2.json()).gates.GATE_VOICE_LATE_PAYMENT_AUTODIAL).toBe(true);
  });
  delete process.env.GATE_VOICE_LATE_PAYMENT_AUTODIAL;
  delete process.env.GATE_COLLECTIONS_POLICY;
});


// codex gh-r2 pins.
test('a malformed case id ⇒ 400 before any db read (no 22P02 500s)', async () => {
  await withServer(async (baseUrl) => {
    const res = await dial(baseUrl, { id: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_case_id');
  });
  expect(db).not.toHaveBeenCalled();
});

test('a successful supervised promote retires the shadow proposal card', async () => {
  const readChain = chain({ first: { id: CASE_UUID, current_state: 'shadow', case_version: 1, idempotency_key: 'collections:c1:1:14' } });
  const promote = chain({ updateResult: 1 });
  const cardChain = chain({ updateResult: 1 });
  cardChain.whereNull = jest.fn(() => cardChain);
  cardChain.whereRaw = jest.fn(() => cardChain);
  const queues = [readChain, chain({ first: undefined }), promote, cardChain];
  db.mockImplementation(() => queues.shift());
  db.raw = jest.fn((sql, b) => ({ sql, b }));
  db.fn = { now: jest.fn(() => 'NOW()') };
  await withServer(async (baseUrl) => {
    const res = await dial(baseUrl);
    expect(res.status).toBe(200);
  });
  expect(cardChain.whereRaw).toHaveBeenCalledWith("metadata->>'dedupeKey' = ?", ['collections:c1:1:14']);
  expect(cardChain.update).toHaveBeenCalled();
});


// codex gh-r5 pins.
test('promotion refuses when the customer already has a live/held case (one pipeline per customer)', async () => {
  const queues = [
    chain({ first: { id: CASE_UUID, current_state: 'shadow', case_version: 1 } }),
    chain({ first: { id: 'other-live' } }), // in-lock live-check finds one
  ];
  db.mockImplementation(() => queues.shift());
  await withServer(async (baseUrl) => {
    const res = await dial(baseUrl);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('another_case_live');
  });
  expect(originateCollectionCall).not.toHaveBeenCalled();
});

test('a pre-dial refusal reverts OUR promotion (fenced on the admin actor)', async () => {
  originateCollectionCall.mockResolvedValue({ dialed: false, reason: 'relay_unavailable' });
  const revert = chain({ updateResult: 1 });
  const queues = [
    chain({ first: { id: CASE_UUID, current_state: 'shadow', case_version: 2 } }),
    chain({ first: undefined }), // live-check
    chain({ updateResult: 1 }), // promote
    revert,
  ];
  db.mockImplementation(() => queues.shift());
  await withServer(async (baseUrl) => {
    const res = await dial(baseUrl);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reason: 'relay_unavailable' });
  });
  expect(revert._wheres[0][0]).toEqual({
    id: CASE_UUID, current_state: 'approved', case_version: 2, approved_by: 'admin:admin@waves.test',
  });
  expect(revert._patches[0].current_state).toBe('proposed');
});

// codex gh-r6 P2: the proposal card survives a transient refusal — it is
// the operator's only case-id surface during the shakedown; retirement
// happens only after a REAL dial attempt.
test('a transient refusal leaves the proposal card standing; a real attempt retires it', async () => {
  originateCollectionCall.mockResolvedValue({ dialed: false, reason: 'relay_unavailable' });
  const queues = [
    chain({ first: { id: CASE_UUID, current_state: 'shadow', case_version: 1, idempotency_key: 'collections:c1:1:14' } }),
    chain({ first: undefined }), // live-check
    chain({ updateResult: 1 }), // promote
    chain({ updateResult: 1 }), // revert (NOT the card — no whereRaw assertion)
  ];
  const consumed = [];
  db.mockImplementation(() => { const q = queues.shift(); consumed.push(q); return q; });
  await withServer(async (baseUrl) => {
    const res = await dial(baseUrl);
    expect(res.status).toBe(200);
  });
  // Exactly four db calls: read, live-check, promote, revert — no card query.
  expect(consumed).toHaveLength(4);
  expect(queues).toHaveLength(0);
});
