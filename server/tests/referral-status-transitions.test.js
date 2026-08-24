/**
 * Referral status-transition guards + convert idempotency (fail closed).
 *
 * Bug: PATCH /admin/referrals/:id/status wrote req.body.status verbatim (and
 * accepted tech tokens), so a referral could be moved back to 'pending' after
 * conversion and POST /convert would credit the promoter's balance a second
 * time (payable via /payouts/:id/approve). Rejecting a signed_up referral also
 * left its staged pending_service cents on the promoter forever.
 *
 * Drives the REAL route + REAL engine over a mocked knex, asserting:
 *  - target-status whitelist (reset-to-pending refused, 400)
 *  - transitions out of a rewarded state are 409 REFERRAL_LOCKED
 *  - convert refuses (409 ALREADY_CONVERTED) once converted_at / a staged
 *    reward exists, regardless of the status column — balance credited once
 *  - rejecting a signed_up pending_service referral unwinds the staged cents
 *  - tech tokens get 403 from the real requireAdmin
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn() }));
jest.mock('../services/customer-credit', () => ({
  postCreditMovement: jest.fn(),
  round2: (n) => Math.round(n * 100) / 100,
}));
// Real requireAdmin/requireTechOrAdmin (the 403 must come from prod code, not
// a mock re-implementation); only token decoding is stubbed via a test header.
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.techRole = req.headers['x-test-role'] || 'admin';
      req.technicianId = 'tech-1';
      return next();
    },
  };
});

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-referrals-v2');

const SETTINGS = {
  id: 1,
  program_active: true,
  base_url: 'https://portal.wavespestcontrol.com/r/',
  referrer_reward_cents: 2500,
  require_service_completion: false,
  milestone_3_bonus_cents: 2500,
};

function makeChain(table, state) {
  const chain = {};
  ['where', 'whereNot', 'andWhere', 'orderBy', 'limit', 'forUpdate', 'leftJoin', 'select'].forEach((m) => {
    chain[m] = jest.fn(() => chain);
  });
  chain.whereIn = jest.fn(() => chain);
  chain.first = jest.fn(async () => {
    if (table === 'referral_program_settings') return { ...state.settings };
    if (table === 'referrals') return state.referral ? { ...state.referral } : null;
    if (table === 'referral_promoters') return state.promoter ? { ...state.promoter } : null;
    return null;
  });
  chain.update = jest.fn(async (vals) => {
    state.updates.push({ table, vals });
    if (table === 'referrals' && state.referral) Object.assign(state.referral, vals);
    return 1;
  });
  chain.increment = jest.fn(async (vals) => {
    state.increments.push({ table, vals });
    return 1;
  });
  return chain;
}

function primeDb(state) {
  const trx = jest.fn((table) => makeChain(table, state));
  trx.raw = db.raw;
  db.transaction.mockImplementation(async (cb) => cb(trx));
  db.mockImplementation((table) => {
    // Post-commit promoter re-read (SMS/email legs): return null so the
    // notify side effects are skipped — they are not under test here.
    if (table === 'referral_promoters') return { where: () => ({ first: async () => null }) };
    return makeChain(table, state);
  });
  return trx;
}

function freshState(referralOverrides = {}) {
  return {
    settings: { ...SETTINGS },
    referral: {
      id: 'ref-1',
      promoter_id: 'promo-1',
      status: 'pending',
      referrer_reward_status: 'pending',
      referrer_reward_amount: null,
      first_service_completed: false,
      converted_at: null,
      lead_id: null,
      ...referralOverrides,
    },
    promoter: { id: 'promo-1', total_referrals_converted: 0, milestone_level: 'none' },
    updates: [],
    increments: [],
  };
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/referrals', router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const patchStatus = (base, body, role) => fetch(`${base}/admin/referrals/ref-1/status`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', ...(role ? { 'x-test-role': role } : {}) },
  body: JSON.stringify(body),
});
const convert = (base) => fetch(`${base}/admin/referrals/ref-1/convert`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ customerId: 'cust-1', monthlyValue: 100 }),
});

beforeEach(() => jest.clearAllMocks());

test('tech token gets 403 from PATCH /:id/status and nothing is written', async () => {
  const state = freshState();
  primeDb(state);
  await withServer(async (base) => {
    const res = await patchStatus(base, { status: 'contacted' }, 'technician');
    expect(res.status).toBe(403);
    expect(state.updates).toHaveLength(0);
  });
});

test('reset to a non-whitelisted status (pending) is refused with 400', async () => {
  const state = freshState({ status: 'signed_up', converted_at: new Date(), referrer_reward_status: 'earned' });
  primeDb(state);
  await withServer(async (base) => {
    const res = await patchStatus(base, { status: 'pending' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_STATUS');
    expect(state.updates).toHaveLength(0);
    expect(state.referral.status).toBe('signed_up');
  });
});

test('whitelisted transition out of a rewarded state is 409 REFERRAL_LOCKED', async () => {
  const state = freshState({ status: 'signed_up', converted_at: new Date(), referrer_reward_status: 'earned', referrer_reward_amount: 25 });
  primeDb(state);
  await withServer(async (base) => {
    for (const status of ['contacted', 'rejected']) {
      const res = await patchStatus(base, { status });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('REFERRAL_LOCKED');
    }
    expect(state.updates).toHaveLength(0);
  });
});

test('plain pre-conversion status change still works (admin, contacted)', async () => {
  const state = freshState();
  primeDb(state);
  await withServer(async (base) => {
    const res = await patchStatus(base, { status: 'contacted' });
    expect(res.status).toBe(200);
    expect(state.referral.status).toBe('contacted');
  });
});

test('convert twice: second call is 409 ALREADY_CONVERTED and the balance was credited exactly once', async () => {
  const state = freshState();
  primeDb(state);
  await withServer(async (base) => {
    const first = await convert(base);
    expect(first.status).toBe(200);
    const credits = state.increments.filter((i) => i.table === 'referral_promoters' && i.vals.available_balance_cents);
    expect(credits).toHaveLength(1);
    expect(credits[0].vals.available_balance_cents).toBe(2500);
    expect(state.referral.status).toBe('signed_up');
    expect(state.referral.converted_at).toBeTruthy();

    const second = await convert(base);
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('ALREADY_CONVERTED');
    expect(state.increments.filter((i) => i.table === 'referral_promoters' && i.vals.available_balance_cents)).toHaveLength(1);
  });
});

test('convert refuses even when status was forced back to pending (converted_at set)', async () => {
  const state = freshState({ status: 'pending', converted_at: new Date(), referrer_reward_status: 'earned', referrer_reward_amount: 25 });
  primeDb(state);
  await withServer(async (base) => {
    const res = await convert(base);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_CONVERTED');
    expect(state.increments).toHaveLength(0);
  });
});

test('rejecting a signed_up pending_service referral unwinds the staged promoter cents', async () => {
  const state = freshState({
    status: 'signed_up',
    converted_at: new Date(),
    referrer_reward_status: 'pending_service',
    referrer_reward_amount: 25,
  });
  primeDb(state);
  await withServer(async (base) => {
    const res = await patchStatus(base, { status: 'rejected', lostReason: 'duplicate submission' });
    expect(res.status).toBe(200);
    expect((await res.json()).unwound).toBe(true);

    // Referral retired: rejected + superseded + can never credit later.
    const refUpd = state.updates.find((u) => u.table === 'referrals');
    expect(refUpd.vals.status).toBe('rejected');
    expect(refUpd.vals.referrer_reward_status).toBe('superseded');
    // NOT stamped: first_service_completed is creditReferralOnFirstService's
    // phone-wide already-rewarded witness — a rejected duplicate earned nothing
    // and must not disqualify the legitimate sibling referral for this phone.
    expect(refUpd.vals.first_service_completed).toBe(false);
    expect(refUpd.vals.lost_reason).toBe('duplicate submission');

    // Staged cents drained (floored at 0 via GREATEST).
    const promoUpd = state.updates.find((u) => u.table === 'referral_promoters' && u.vals.pending_earnings_cents);
    expect(promoUpd).toBeTruthy();
    expect(promoUpd.vals.pending_earnings_cents.bindings).toEqual([2500]);
    expect(promoUpd.vals.total_earned_cents.bindings).toEqual([2500]);

    // The conversion count increment is reversed on the same transaction.
    const countUpd = state.updates.find((u) => u.table === 'referral_promoters' && u.vals.total_referrals_converted);
    expect(countUpd.vals.total_referrals_converted.__raw).toContain('GREATEST(total_referrals_converted - 1, 0)');

    // And convert afterwards is refused.
    const res2 = await convert(base);
    expect(res2.status).toBe(409);
    expect(state.increments).toHaveLength(0);
  });
});

test('rejecting the conversion that minted a milestone is refused (fail closed, 409 MILESTONE_LOCKED)', async () => {
  const state = freshState({
    status: 'signed_up',
    converted_at: new Date(),
    referrer_reward_status: 'pending_service',
    referrer_reward_amount: 25,
  });
  // Count sits exactly AT the advocate threshold: this conversion crossed it,
  // and its bonus is payable (maybe paid) — never auto-unwound.
  state.promoter = { id: 'promo-1', total_referrals_converted: 3, milestone_level: 'advocate' };
  primeDb(state);
  await withServer(async (base) => {
    const res = await patchStatus(base, { status: 'rejected' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('MILESTONE_LOCKED');
    // Refused BEFORE any write in the transaction.
    expect(state.updates).toHaveLength(0);
    expect(state.referral.status).toBe('signed_up');
  });
});

test('rejecting a conversion past the milestone threshold keeps the level and bonus', async () => {
  const state = freshState({
    status: 'signed_up',
    converted_at: new Date(),
    referrer_reward_status: 'pending_service',
    referrer_reward_amount: 25,
  });
  // Count PAST the threshold: the milestone came from an earlier conversion.
  state.promoter = { id: 'promo-1', total_referrals_converted: 4, milestone_level: 'advocate' };
  primeDb(state);
  await withServer(async (base) => {
    const res = await patchStatus(base, { status: 'rejected' });
    expect(res.status).toBe(200);
    const upd = state.updates.find((u) => u.table === 'referral_promoters' && u.vals.total_referrals_converted);
    expect(upd.vals.milestone_level).toBeUndefined();
    expect(upd.vals.available_balance_cents).toBeUndefined();
  });
});
