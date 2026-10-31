/**
 * GET /api/admin/dashboard/ebitda-bridge with open time (L11b, GATE_TECH_OPEN_TIME + GATE_TECH_COST_RATES).
 * Gates off or either one off = the bridge exactly as before (no open_time row, no openTime key). On = one
 * extra row after gross profit and an openTime summary. Synthetic numbers only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/staff-call-recording-privacy', () => ({ installStaffCallRecordingPrivacy: () => {} }));
jest.mock('../services/referral-engine', () => ({ getSettings: async () => ({ referrer_reward_cents: 0, referee_discount_cents: 0 }) }));

const mockGates = { techOpenTimeLive: jest.fn(), techCostRatesLive: jest.fn() };
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  techOpenTimeLive: (...a) => mockGates.techOpenTimeLive(...a),
  techCostRatesLive: (...a) => mockGates.techCostRatesLive(...a),
}));
const mockComputeOpenTime = jest.fn();
jest.mock('../services/open-time', () => ({ computeOpenTime: (...a) => mockComputeOpenTime(...a) }));

const ROWS = {
  technicians: { id: 'admin-1', role: 'admin', employment_status: 'active', auth_token_version: 1, must_change_password: false },
  service_records: { rev: '20000', gp: '11000', uncosted: null, jobs: '40', v: null },
  ad_performance_daily: { c: '0' },
  channel_fixed_costs: { c: '0' },
  company_financials: {
    overhead_entered_at: '2026-10-01', ovh_office_payroll: '1000', ovh_rent: '500', ovh_insurance: '0', ovh_software: '0', ovh_vehicle_fixed: '0', ovh_other_ga: '0',
  },
  customers: { count: '10' },
  'job_costs as jc': { labor: '5000', materials: '1000', drive: '3000' },
};
jest.mock('../models/db', () => {
  const dbFn = jest.fn((table) => {
    const c = {};
    for (const m of ['where', 'whereNull', 'whereNotNull', 'whereIn', 'join', 'orderBy', 'modify', 'select', 'sum', 'count', 'countDistinct', 'limit']) c[m] = () => c;
    c.first = () => Promise.resolve(ROWS[table] || null);
    c.then = (resolve, reject) => Promise.resolve(table === 'ad_service_attribution' ? [{ n: 0 }] : []).then(resolve, reject);
    return c;
  });
  dbFn.raw = (s) => s;
  return dbFn;
});

const express = require('express');
const jwt = require('jsonwebtoken');
const router = require('../routes/admin-dashboard');

const adminToken = jwt.sign({ type: 'access', tokenVersion: 1, technicianId: 'admin-1', scope: 'staff' }, process.env.JWT_SECRET);

let server; let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dashboard', router);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

// Only Date is faked, so the server and fetch keep working. A distinct query string per call: the route caches 60 s per URL.
let seq = 0;
const FAKE_ALL_BUT_DATE = ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'hrtime', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback'];
function at(iso) { jest.useFakeTimers({ now: new Date(iso), doNotFake: FAKE_ALL_BUT_DATE }); }
async function bridge() {
  seq += 1;
  const res = await fetch(`${base}/api/admin/dashboard/ebitda-bridge?n=${seq}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  return { status: res.status, body: await res.json() };
}

const TODAY_KEYS = ['revenue', 'cogs', 'gross_profit', 'marketing', 'contribution', 'overhead', 'ebitda'];

beforeEach(() => {
  jest.clearAllMocks();
  at('2026-10-15T16:00:00Z'); // 12:00 ET on the 15th: the month's finished days are 10-01 to 10-14
  mockGates.techOpenTimeLive.mockReturnValue(true);
  mockGates.techCostRatesLive.mockReturnValue(true);
  mockComputeOpenTime.mockResolvedValue({ totals: { days: 9, openMinutes: 2500.5, openCostCents: 113625 } });
});
afterEach(() => { jest.useRealTimers(); });

describe('ebitda-bridge route and open time', () => {
  test.each([
    ['both gates off', () => { mockGates.techOpenTimeLive.mockReturnValue(false); mockGates.techCostRatesLive.mockReturnValue(false); }],
    ['only GATE_TECH_OPEN_TIME on', () => mockGates.techCostRatesLive.mockReturnValue(false)],
    ['only GATE_TECH_COST_RATES on', () => mockGates.techOpenTimeLive.mockReturnValue(false)],
  ])('%s: exactly today\'s bridge, open time never computed', async (_n, setUp) => {
    setUp();
    const { status, body } = await bridge();
    expect(status).toBe(200);
    expect(body.rows.map((r) => r.key)).toEqual(TODAY_KEYS);
    expect(body).not.toHaveProperty('openTime');
    expect(body.contribution).toBe(11000);
    expect(body.ebitda).toBe(10274.19); // 11000 less 1500 of overhead prorated to 15 of 31 days
    expect(mockComputeOpenTime).not.toHaveBeenCalled();
  });

  test('both on: one open time row after gross profit, taken out of contribution and EBITDA, and a summary', async () => {
    const { status, body } = await bridge();
    expect(status).toBe(200);
    expect(mockComputeOpenTime).toHaveBeenCalledWith(expect.anything(), { from: '2026-10-01', to: '2026-10-14', today: '2026-10-15' });
    expect(body.rows.map((r) => r.key)).toEqual(['revenue', 'cogs', 'gross_profit', 'open_time', 'marketing', 'contribution', 'overhead', 'ebitda']);
    expect(body.rows.find((r) => r.key === 'open_time').amount).toBe(-1136.25);
    expect(body.openTime).toEqual({ amount: 1136.25, days: 9, openMinutes: 2500.5 });
    expect(body.contribution).toBe(9863.75);
    expect(body.ebitda).toBe(9137.94); // 9863.75 less the same 725.81 of overhead
  });

  test('zero open time adds no row but still reports the summary', async () => {
    mockComputeOpenTime.mockResolvedValue({ totals: { days: 3, openMinutes: 0, openCostCents: 0 } });
    const { body } = await bridge();
    expect(body.rows.map((r) => r.key)).toEqual(TODAY_KEYS);
    expect(body.openTime).toEqual({ amount: 0, days: 3, openMinutes: 0 });
    expect(body.contribution).toBe(11000);
  });

  test('a failed open time read leaves the bridge as it was', async () => {
    mockComputeOpenTime.mockRejectedValue(Object.assign(new Error('boom'), { code: 'XX000' }));
    const { status, body } = await bridge();
    expect(status).toBe(200);
    expect(body.rows.map((r) => r.key)).toEqual(TODAY_KEYS);
    expect(body).not.toHaveProperty('openTime');
  });

  test('on the first of the month there is no finished day: nothing computed, no row', async () => {
    at('2026-10-01T16:00:00Z');
    const { body } = await bridge();
    expect(mockComputeOpenTime).not.toHaveBeenCalled();
    expect(body.rows.map((r) => r.key)).toEqual(TODAY_KEYS);
    expect(body).not.toHaveProperty('openTime');
  });
});
