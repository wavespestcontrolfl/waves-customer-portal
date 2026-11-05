process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/stripe-banking', () => ({
  getBalance: jest.fn(),
  createInstantPayout: jest.fn(),
  createStandardPayout: jest.fn(),
  syncPayouts: jest.fn(),
  getCashFlow: jest.fn(),
  reconcilePayout: jest.fn(),
}));
jest.mock('../services/plaid-sync', () => ({
  readCashBalances: jest.fn(),
}));
jest.mock('../services/banking-export', () => ({
  generateCSV: jest.fn(() => ({ content: 'csv', filename: 'test.csv', content_type: 'text/csv' })),
  generateOFX: jest.fn(() => ({ content: 'ofx', filename: 'test.ofx', content_type: 'application/x-ofx' })),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      // The default IB_FULL_ACCESS_EMAILS allow-list (ib-access.js) is
      // real/unmocked here, so this admin's email must be the owner
      // account for the "owner reaches the service" assertions to hold.
      admin: { id: 'admin-1', role: 'admin', email: 'contact@wavespestcontrol.com', name: 'Owner' },
      // A second, non-owner admin — same role, ordinary admin login — for
      // the owner-only payout guard (owner ruling 2026-09-28).
      admin2: { id: 'admin-2', role: 'admin', email: 'other-admin@example.com', name: 'Other Admin' },
      tech: { id: 'tech-1', role: 'technician', email: 'tech@example.com', name: 'Tech' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));

const express = require('express');
const db = require('../models/db');
const StripeBanking = require('../services/stripe-banking');
const PlaidSync = require('../services/plaid-sync');
const bankingRouter = require('../routes/admin-banking');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/banking', bankingRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('admin banking routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('technician role cannot access banking balance', async () => {
    StripeBanking.getBalance.mockResolvedValue({ total_available: 123 });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/banking/balance`, {
        headers: { Authorization: 'Bearer tech' },
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.error).toBe('Admin access required');
      expect(StripeBanking.getBalance).not.toHaveBeenCalled();
    });
  });

  test('reconciliation list returns the client envelope', async () => {
    const latestSubquery = {
      select: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      as: jest.fn().mockReturnValue('latest-reconciliation'),
    };
    const payoutQuery = {
      where: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([{ id: 'payout-1', amount: '100.00' }]),
    };
    db.mockImplementation((table) => {
      if (table === 'bank_reconciliation as br') return latestSubquery;
      if (table === 'stripe_payouts') return payoutQuery;
      throw new Error(`Unexpected table ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/banking/reconciliation`, {
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toEqual({ payouts: [{ id: 'payout-1', amount: '100.00' }] });
    });
  });

  test('a failed cash-flow read is a 500 the page shows as unavailable, never a zero report', async () => {
    StripeBanking.getCashFlow.mockRejectedValue(new Error('select ... - relation "stripe_payouts" does not exist'));

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/banking/cash-flow?start_date=2026-07-01&end_date=2026-07-31&period=daily`, {
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body).toEqual({ error: 'the cash-flow read failed' });
    });
  });

  test('a bad cash-flow date is still a 400 with its reason', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/banking/cash-flow?start_date=07/01/2026`, {
        headers: { Authorization: 'Bearer admin' },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/start_date/);
      expect(StripeBanking.getCashFlow).not.toHaveBeenCalled();
    });
  });

  describe('Eastern calendar defaults on the UTC server clock', () => {
    // 2026-11-01 00:30 UTC is still Oct 31, 8:30 PM ET. Only Date is faked:
    // the test server's sockets keep their real timers.
    const ALL_BUT_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate',
      'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];
    beforeEach(() => jest.useFakeTimers({ now: new Date('2026-11-01T00:30:00Z'), doNotFake: ALL_BUT_DATE }));
    afterEach(() => jest.useRealTimers());

    test('MTD stats start on the Eastern month', async () => {
      const statsQuery = {
        where: jest.fn().mockReturnThis(),
        whereRaw: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({ mtd_deposited: '250.00', mtd_fees: '0', payout_count: '1', avg_payout: '250' }),
      };
      db.mockImplementation((table) => {
        if (table === 'stripe_payouts') return statsQuery;
        throw new Error(`Unexpected table ${table}`);
      });
      db.raw = jest.fn((sql) => sql);

      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/banking/stats`, { headers: { Authorization: 'Bearer admin' } });
        expect(res.status).toBe(200);
        expect((await res.json()).mtd_deposited).toBe(250);
      });
      expect(statsQuery.whereRaw).toHaveBeenCalledWith('DATE(arrival_date) >= ?::date', ['2026-10-01']);
    });

    test('a cash-flow request without dates covers the Eastern month to date', async () => {
      StripeBanking.getCashFlow.mockResolvedValue({ summary: {}, daily: [] });

      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/banking/cash-flow`, { headers: { Authorization: 'Bearer admin' } });
        expect(res.status).toBe(200);
      });
      expect(StripeBanking.getCashFlow).toHaveBeenCalledWith('2026-10-01', '2026-10-31');
    });
  });

  test('reconciliation records the authenticated admin as actor', async () => {
    StripeBanking.reconcilePayout.mockResolvedValue({ payout_id: 'payout-1', status: 'confirmed' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/banking/reconciliation/payout-1`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ actual_amount: 100, notes: 'matched' }),
      });
      expect(res.status).toBe(200);
      expect(StripeBanking.reconcilePayout).toHaveBeenCalledWith(
        'payout-1',
        100,
        'matched',
        'admin-1',
        'confirmed',
      );
    });
  });

  test('instant payout uses stable non-PII admin actor with client idempotency key', async () => {
    StripeBanking.createInstantPayout.mockResolvedValue({ payout_id: 'po_123', status: 'pending' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/banking/payouts/instant`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 50, idempotency_key: 'ipo_attempt_123' }),
      });
      expect(res.status).toBe(200);
      expect(StripeBanking.createInstantPayout).toHaveBeenCalledWith(50, {
        requestedBy: 'admin-1',
        idempotencyKey: 'ipo_attempt_123',
      });
    });
  });

  test('standard payout uses stable non-PII admin actor with client idempotency key', async () => {
    StripeBanking.createStandardPayout.mockResolvedValue({ payout_id: 'po_standard', status: 'pending', method: 'standard' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/banking/payouts/standard`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 75, idempotency_key: 'spo_attempt_123' }),
      });
      expect(res.status).toBe(200);
      expect(StripeBanking.createStandardPayout).toHaveBeenCalledWith(75, {
        requestedBy: 'admin-1',
        idempotencyKey: 'spo_attempt_123',
      });
    });
  });

  test('standard payout rejects amounts with more than two decimal places', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/banking/payouts/standard`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 75.005, idempotency_key: 'spo_attempt_123' }),
      });
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe('Invalid amount — must be a positive number');
      expect(StripeBanking.createStandardPayout).not.toHaveBeenCalled();
    });
  });

  // Owner ruling 2026-09-28: the same red-tier restriction the Intelligence
  // Bar enforces (contact@wavespestcontrol.com only) applies to these page
  // routes too — every admin can reach the page, but only the owner account
  // can actually request a payout.
  describe('owner-only payout guard', () => {
    test('non-owner admin gets 403 on instant payout and the service is never called', async () => {
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/banking/payouts/instant`, {
          method: 'POST',
          headers: { Authorization: 'Bearer admin2', 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: 50, idempotency_key: 'ipo_attempt_456' }),
        });
        const body = await res.json();
        expect(res.status).toBe(403);
        expect(body.error).toBe('This action is limited to the owner account.');
        expect(StripeBanking.createInstantPayout).not.toHaveBeenCalled();
      });
    });

    test('non-owner admin gets 403 on standard payout and the service is never called', async () => {
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/banking/payouts/standard`, {
          method: 'POST',
          headers: { Authorization: 'Bearer admin2', 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: 75, idempotency_key: 'spo_attempt_456' }),
        });
        const body = await res.json();
        expect(res.status).toBe(403);
        expect(body.error).toBe('This action is limited to the owner account.');
        expect(StripeBanking.createStandardPayout).not.toHaveBeenCalled();
      });
    });

    test('owner admin reaches the instant payout service', async () => {
      StripeBanking.createInstantPayout.mockResolvedValue({ payout_id: 'po_owner', status: 'pending' });
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/banking/payouts/instant`, {
          method: 'POST',
          headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: 50, idempotency_key: 'ipo_attempt_789' }),
        });
        expect(res.status).toBe(200);
        expect(StripeBanking.createInstantPayout).toHaveBeenCalledWith(50, {
          requestedBy: 'admin-1',
          idempotencyKey: 'ipo_attempt_789',
        });
      });
    });

    test('a read route on the same router stays open to a non-owner admin', async () => {
      StripeBanking.getBalance.mockResolvedValue({ total_available: 123 });
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/banking/balance`, {
          headers: { Authorization: 'Bearer admin2' },
        });
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body).toEqual({ total_available: 123 });
      });
    });
  });

  describe('GET /cash-today (GATE_CASH_FORECAST)', () => {
    const savedGate = process.env.GATE_CASH_FORECAST;
    afterEach(() => {
      if (savedGate === undefined) delete process.env.GATE_CASH_FORECAST;
      else process.env.GATE_CASH_FORECAST = savedGate;
    });

    function bank(over = {}) {
      return {
        name: 'Synthetic Checking',
        mask: '1111',
        account_label: 'Synthetic Checking',
        account_type: 'bank',
        available: 1000.5,
        current: 1200,
        currency: 'USD',
        balance_as_of: null,
        ...over,
      };
    }

    function payoutsDb(rows) {
      const q = {
        whereIn: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockResolvedValue(rows),
      };
      db.mockImplementation((table) => {
        if (table === 'stripe_payouts') return q;
        throw new Error(`Unexpected table ${table}`);
      });
      return q;
    }

    async function getCash(token = 'admin') {
      return withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/banking/cash-today`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        return { status: res.status, body: await res.json() };
      });
    }

    test('gate off: the owner gets 404 and nothing is read', async () => {
      delete process.env.GATE_CASH_FORECAST;
      const { status, body } = await getCash('admin');
      expect(status).toBe(404);
      expect(body).toEqual({ error: 'Not found' });
      expect(PlaidSync.readCashBalances).not.toHaveBeenCalled();
      expect(db).not.toHaveBeenCalled();
    });

    test('only the exact value true turns the gate on', async () => {
      process.env.GATE_CASH_FORECAST = '1';
      const { status } = await getCash('admin');
      expect(status).toBe(404);
    });

    test('a non-owner admin gets 403 even with the gate on', async () => {
      process.env.GATE_CASH_FORECAST = 'true';
      const { status } = await getCash('admin2');
      expect(status).toBe(403);
      expect(PlaidSync.readCashBalances).not.toHaveBeenCalled();
    });

    test('gate on + owner: 200 with the full shape', async () => {
      process.env.GATE_CASH_FORECAST = 'true';
      PlaidSync.readCashBalances.mockResolvedValue({
        accounts: [bank(), bank({ name: 'Second Checking', mask: '2222', available: 250, balance_as_of: '2026-11-05T14:00:00Z' })],
        cards: [],
        unavailable: [],
      });
      payoutsDb([
        { amount: '300.25', currency: 'usd', status: 'in_transit', arrival_date: new Date('2026-11-06T00:00:00Z'), bank_last_four: '9999' },
      ]);
      const { status, body } = await getCash('admin');
      expect(status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(['accounts', 'cards', 'fetched_at', 'in_transit', 'totals', 'unavailable']);
      expect(Number.isNaN(Date.parse(body.fetched_at))).toBe(false);
      expect(body.accounts).toHaveLength(2);
      expect(body.in_transit.total).toBe(300.25);
      expect(body.in_transit.payouts[0]).toMatchObject({ amount: 300.25, arrival_day: '2026-11-06', status: 'in_transit', bank_last_four: '9999' });
      expect(body.totals).toEqual({ bank_usd: 1250.5, owed_usd: 0, in_transit_usd: 300.25 });
    });

    test('a login_required connection is listed as unavailable while other data still returns', async () => {
      process.env.GATE_CASH_FORECAST = 'true';
      PlaidSync.readCashBalances.mockResolvedValue({
        accounts: [bank()],
        cards: [],
        unavailable: [{ institution_name: 'Synthetic Bank', reason: 'login_required' }],
      });
      payoutsDb([]);
      const { status, body } = await getCash('admin');
      expect(status).toBe(200);
      expect(body.unavailable).toEqual([{ institution_name: 'Synthetic Bank', reason: 'login_required' }]);
      expect(body.totals.bank_usd).toBe(1000.5);
    });

    test('available null falls back to current', async () => {
      process.env.GATE_CASH_FORECAST = 'true';
      PlaidSync.readCashBalances.mockResolvedValue({
        accounts: [bank({ available: null, current: 77.1 })],
        cards: [],
        unavailable: [],
      });
      payoutsDb([]);
      const { body } = await getCash('admin');
      expect(body.totals.bank_usd).toBe(77.1);
    });

    test('a card lands in cards as money owed and is not in bank_usd', async () => {
      process.env.GATE_CASH_FORECAST = 'true';
      PlaidSync.readCashBalances.mockResolvedValue({
        accounts: [bank()],
        cards: [bank({ name: 'Synthetic Card', mask: '3333', account_type: 'card', available: 5000, current: 420.1 })],
        unavailable: [],
      });
      payoutsDb([]);
      const { body } = await getCash('admin');
      expect(body.totals.bank_usd).toBe(1000.5);
      expect(body.totals.owed_usd).toBe(420.1);
      expect(body.cards).toHaveLength(1);
    });

    test('non-USD entries stay listed but are left out of every total', async () => {
      process.env.GATE_CASH_FORECAST = 'true';
      PlaidSync.readCashBalances.mockResolvedValue({
        accounts: [bank(), bank({ name: 'Foreign', mask: '4444', currency: 'CAD', available: 9999 })],
        cards: [bank({ account_type: 'card', mask: '5555', currency: 'EUR', current: 888 })],
        unavailable: [],
      });
      payoutsDb([
        { amount: '10.00', currency: 'usd', status: 'pending', arrival_date: new Date('2026-11-07T00:00:00Z'), bank_last_four: null },
        { amount: '500.00', currency: 'cad', status: 'pending', arrival_date: new Date('2026-11-07T00:00:00Z'), bank_last_four: null },
      ]);
      const { body } = await getCash('admin');
      expect(body.accounts).toHaveLength(2);
      expect(body.cards).toHaveLength(1);
      expect(body.in_transit.payouts).toHaveLength(2);
      expect(body.totals).toEqual({ bank_usd: 1000.5, owed_usd: 0, in_transit_usd: 10 });
    });

    test('in-transit arrival_day is the UTC calendar day of a midnight-UTC marker, never shifted to Eastern', async () => {
      process.env.GATE_CASH_FORECAST = 'true';
      PlaidSync.readCashBalances.mockResolvedValue({ accounts: [], cards: [], unavailable: [] });
      const q = payoutsDb([
        { amount: '1.00', currency: 'usd', status: 'pending', arrival_date: new Date('2026-01-15T00:00:00Z'), bank_last_four: '1234' },
      ]);
      const { body } = await getCash('admin');
      expect(body.in_transit.payouts[0].arrival_day).toBe('2026-01-15');
      expect(q.whereIn).toHaveBeenCalledWith('status', ['pending', 'in_transit']);
    });

    test('an in-transit database failure answers in_transit.error and still 200', async () => {
      process.env.GATE_CASH_FORECAST = 'true';
      PlaidSync.readCashBalances.mockResolvedValue({ accounts: [bank()], cards: [], unavailable: [] });
      db.mockImplementation(() => { throw new Error('relation "stripe_payouts" does not exist'); });
      const { status, body } = await getCash('admin');
      expect(status).toBe(200);
      expect(body.in_transit).toEqual({ error: 'unavailable' });
      expect(body.totals).toEqual({ bank_usd: 1000.5, owed_usd: 0, in_transit_usd: 0 });
      expect(body.accounts).toHaveLength(1);
    });

    test('an unexpected bank read failure is a 500 without the raw error', async () => {
      process.env.GATE_CASH_FORECAST = 'true';
      PlaidSync.readCashBalances.mockRejectedValue(new Error('select * from plaid_items failed'));
      payoutsDb([]);
      const { status, body } = await getCash('admin');
      expect(status).toBe(500);
      expect(body).toEqual({ error: 'the cash read failed' });
    });
  });
});
