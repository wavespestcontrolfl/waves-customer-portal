/**
 * GATE_REFERRAL_INBOUND_CONFIRM on the admin referral routes: dark by default.
 * Off, the inbound list answers enabled:false and both actions are 404 with
 * no service call. On, ids are checked before the service runs, the admin's
 * id is recorded, and a service refusal keeps its status and code.
 * services/referral-inbound.js itself runs against Postgres in
 * referral-inbound-postgres.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn(() => { throw new Error('no query expected'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/referral-inbound', () => ({
  listInboundReferrals: jest.fn(),
  confirmInboundReferral: jest.fn(),
  dismissInboundReferral: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.techRole = 'admin';
      req.technicianId = '11111111-1111-4111-8111-111111111111';
      return next();
    },
  };
});

const express = require('express');
const inbound = require('../services/referral-inbound');
const router = require('../routes/admin-referrals-v2');

const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const REFERRER = '33333333-3333-4333-8333-333333333333';
const original = process.env.GATE_REFERRAL_INBOUND_CONFIRM;

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/referrals', router);
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/admin/referrals`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const post = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
});

beforeEach(() => jest.clearAllMocks());
afterAll(() => {
  if (original === undefined) delete process.env.GATE_REFERRAL_INBOUND_CONFIRM;
  else process.env.GATE_REFERRAL_INBOUND_CONFIRM = original;
});

test.each([undefined, 'false', '1'])('gate %p: no list, both actions 404, the service never runs', async (value) => {
  if (value === undefined) delete process.env.GATE_REFERRAL_INBOUND_CONFIRM;
  else process.env.GATE_REFERRAL_INBOUND_CONFIRM = value;
  await withServer(async (base) => {
    const list = await fetch(`${base}/inbound`);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ enabled: false, items: [] });
    expect((await post(`${base}/inbound/${CUSTOMER}/confirm`, { referrerCustomerId: REFERRER })).status).toBe(404);
    expect((await post(`${base}/inbound/${CUSTOMER}/dismiss`)).status).toBe(404);
  });
  expect(inbound.listInboundReferrals).not.toHaveBeenCalled();
  expect(inbound.confirmInboundReferral).not.toHaveBeenCalled();
  expect(inbound.dismissInboundReferral).not.toHaveBeenCalled();
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_REFERRAL_INBOUND_CONFIRM = 'true'; });

  test('lists through the service', async () => {
    inbound.listInboundReferrals.mockResolvedValue([{ customerId: CUSTOMER }]);
    await withServer(async (base) => {
      expect(await (await fetch(`${base}/inbound`)).json()).toEqual({ enabled: true, items: [{ customerId: CUSTOMER }] });
    });
  });

  test('confirm and dismiss refuse a missing or malformed id before the service runs', async () => {
    await withServer(async (base) => {
      expect((await post(`${base}/inbound/${CUSTOMER}/confirm`, {})).status).toBe(400);
      expect((await post(`${base}/inbound/${CUSTOMER}/confirm`, { referrerCustomerId: 'jane' })).status).toBe(400);
      expect((await post(`${base}/inbound/not-an-id/confirm`, { referrerCustomerId: REFERRER })).status).toBe(400);
      expect((await post(`${base}/inbound/not-an-id/dismiss`)).status).toBe(400);
    });
    expect(inbound.confirmInboundReferral).not.toHaveBeenCalled();
    expect(inbound.dismissInboundReferral).not.toHaveBeenCalled();
  });

  test('confirm records the admin and returns the outcome', async () => {
    inbound.confirmInboundReferral.mockResolvedValue({ referralId: 'r-1', converted: true, credited: null, firstVisitDone: false, error: null });
    await withServer(async (base) => {
      const res = await post(`${base}/inbound/${CUSTOMER}/confirm`, { referrerCustomerId: REFERRER });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true, referralId: 'r-1', converted: true });
    });
    expect(inbound.confirmInboundReferral).toHaveBeenCalledWith({
      customerId: CUSTOMER,
      referrerCustomerId: REFERRER,
      reviewedBy: '11111111-1111-4111-8111-111111111111',
    });
  });

  test('a service refusal keeps its status and code', async () => {
    inbound.dismissInboundReferral.mockRejectedValue(Object.assign(new Error('This customer was already confirmed or dismissed'), {
      statusCode: 409, code: 'ALREADY_REVIEWED',
    }));
    await withServer(async (base) => {
      const res = await post(`${base}/inbound/${CUSTOMER}/dismiss`);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'This customer was already confirmed or dismissed', code: 'ALREADY_REVIEWED' });
    });
  });
});
