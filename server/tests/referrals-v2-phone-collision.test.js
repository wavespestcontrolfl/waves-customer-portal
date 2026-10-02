// A customer whose phone already belongs to ANOTHER account's promoter row:
// resolvePromoter rethrows the 23505 (no same-account household promoter).
// The portal home and Refer tab call GET /api/referrals on every load — that
// must answer "not enrolled", never 500 (Sentry 7424336910: 464 × since
// 2026-04-19). Action routes answer 409 with customer copy that never
// carries the phone number PG quotes in its message.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('express-rate-limit', () => () => (req, res, next) => next());
jest.mock('../middleware/auth', () => ({
  authenticate: (req, res, next) => { req.customerId = 'cust-sibling'; next(); },
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/referral-engine', () => ({
  resolvePromoter: jest.fn(),
  findHouseholdPromoter: jest.fn(async () => null),
  submitReferral: jest.fn(),
  getSettings: jest.fn(async () => ({ referrer_reward_cents: 2500, referee_discount_cents: 2500 })),
  getPromoterReferralLink: jest.fn(() => 'https://portal.wavespestcontrol.com/r/WAVES-TEST'),
  buildRefereeOfferLine: jest.fn(() => 'offer'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn() }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn(), redactEmailAddresses: (s) => String(s || '') }));
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const engine = require('../services/referral-engine');
const logger = require('../services/logger');
const referralsRouter = require('../routes/referrals-v2');
const { isPromoterPhoneCollision, PHONE_COLLISION_CODE } = require('../services/referral-errors');

const PHONE = '+19415550123';
function pgCollision() {
  const err = new Error(`insert into "referral_promoters" (...) - duplicate key value violates unique constraint "referral_promoters_customer_phone_unique"`);
  err.code = '23505';
  err.constraint = 'referral_promoters_customer_phone_unique';
  err.detail = `Key (customer_phone)=(${PHONE}) already exists.`;
  return err;
}

let app;
let server;
let base;
beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use('/api/referrals', referralsRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: 'unhandled', message: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/referrals`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(() => ({ where: () => ({ first: async () => ({ first_name: 'Sam' }) }) }));
});

describe('isPromoterPhoneCollision', () => {
  test('matches the customer_phone unique violation by constraint name', () => {
    expect(isPromoterPhoneCollision(pgCollision())).toBe(true);
  });
  test('ignores other unique violations and non-PG errors', () => {
    const other = Object.assign(new Error('dup'), { code: '23505', constraint: 'referral_promoters_referral_code_unique' });
    expect(isPromoterPhoneCollision(other)).toBe(false);
    expect(isPromoterPhoneCollision(new Error('boom'))).toBe(false);
    expect(isPromoterPhoneCollision(null)).toBe(false);
  });
});

describe('GET /api/referrals on a cross-account phone collision', () => {
  test('answers 200 "not enrolled" instead of 500, without the phone', async () => {
    engine.resolvePromoter.mockRejectedValueOnce(pgCollision());
    const res = await fetch(base);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      enrolled: false,
      enrollBlocked: PHONE_COLLISION_CODE,
      referralCode: null,
      referralLink: null,
      referrals: [],
      stats: { totalReferrals: 0, converted: 0, pending: 0, totalClicks: 0 },
      rewardPerReferral: 25,
    });
    expect(JSON.stringify(body)).not.toContain(PHONE);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('customer cust-sibling'));
    expect(logger.warn.mock.calls[0][0]).not.toContain(PHONE);
  });

  test('other engine failures still reach the error handler', async () => {
    engine.resolvePromoter.mockRejectedValueOnce(new Error('db down'));
    const res = await fetch(base);
    expect(res.status).toBe(500);
  });
});

describe('referral actions on a cross-account phone collision', () => {
  test.each([
    ['POST /', '', { name: 'Pat Friend', phone: '941-555-0100' }],
    ['POST /invite', '/invite', { phone: '941-555-0100', friendName: 'Pat' }],
    ['POST /invite-email', '/invite-email', { email: 'pat@example.com', friendName: 'Pat' }],
  ])('%s answers 409 with customer copy and no phone', async (_label, path, payload) => {
    engine.resolvePromoter.mockRejectedValueOnce(pgCollision());
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe(PHONE_COLLISION_CODE);
    expect(body.error).toMatch(/isn't connected to this account yet/);
    expect(JSON.stringify(body)).not.toContain(PHONE);
    expect(engine.submitReferral).not.toHaveBeenCalled();
  });
});
