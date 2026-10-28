// L11b: GET /api/admin/cost-cards/open-time (GATE_TECH_OPEN_TIME + GATE_TECH_COST_RATES). Synthetic data only.
const express = require('express');

const mockGates = { techCostRatesLive: jest.fn(), techOpenTimeLive: jest.fn() };
const mockComputeOpenTime = jest.fn();
const mockDbCalls = [];

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'staff-1', role: 'admin' };
      req.technicianId = 'staff-1';
      req.techRole = 'admin';
      return next();
    },
  };
});
jest.mock('../config/feature-gates', () => ({
  techCostRatesLive: (...a) => mockGates.techCostRatesLive(...a),
  techOpenTimeLive: (...a) => mockGates.techOpenTimeLive(...a),
}));
jest.mock('../services/open-time', () => ({ computeOpenTime: (...a) => mockComputeOpenTime(...a) }));
jest.mock('../models/db', () => jest.fn((table) => {
  mockDbCalls.push(table);
  const builder = {
    whereIn: () => builder,
    select: () => Promise.resolve([{ id: 'tech-1', name: 'Sample Tech' }]),
  };
  return builder;
}));
jest.mock('../utils/datetime-et', () => ({
  ...jest.requireActual('../utils/datetime-et'),
  etDateString: () => '2026-10-27',
}));

const router = require('../routes/admin-cost-cards');

const app = express();
app.use('/api/admin/cost-cards', router);

let server;
let base;
beforeAll(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// Tiny GET helper: { status, body, headers }.
const request = {
  get: async (path) => {
    const res = await fetch(`${base}${path}`);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body, headers: { 'cache-control': res.headers.get('cache-control') } };
  },
};

const RESULT = {
  from: '2026-09-27',
  to: '2026-10-26',
  days: [],
  leftOut: [
    { technicianId: 'tech-1', day: '2026-10-20', reason: 'costed_before_card', visits: 3 },
    { technicianId: 'tech-1', day: '2026-10-21', reason: 'costed_before_card', visits: 2 },
    { technicianId: 'tech-2', day: '2026-10-21', reason: 'no_card', visits: 1 },
  ],
  totals: { days: 2, paidMinutes: 1200, bookedMinutes: 600, onJobMinutes: 500, driveMinutes: 100, openMinutes: 600, overMinutes: 0, openCostCents: 27250, bookedShare: 0.5 },
  technicians: [{ technicianId: 'tech-1', days: 2, paidMinutes: 1200, bookedMinutes: 600, onJobMinutes: 500, driveMinutes: 100, openMinutes: 600, overMinutes: 0, openCostCents: 27250, bookedShare: 0.5 }],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDbCalls.length = 0;
  mockGates.techCostRatesLive.mockReturnValue(true);
  mockGates.techOpenTimeLive.mockReturnValue(true);
  mockComputeOpenTime.mockResolvedValue(RESULT);
});

describe('GET /api/admin/cost-cards/open-time', () => {
  test.each([
    ['GATE_TECH_OPEN_TIME off', () => mockGates.techOpenTimeLive.mockReturnValue(false)],
    ['GATE_TECH_COST_RATES off', () => mockGates.techCostRatesLive.mockReturnValue(false)],
  ])('%s: 404 and nothing is read', async (_n, turnOff) => {
    turnOff();
    const res = await request.get('/api/admin/cost-cards/open-time');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    expect(mockComputeOpenTime).not.toHaveBeenCalled();
    expect(mockDbCalls).toEqual([]);
  });

  test('on: per technician totals with the name, and the left-out days counted by reason', async () => {
    const res = await request.get('/api/admin/cost-cards/open-time');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      from: '2026-09-27',
      to: '2026-10-26',
      totals: RESULT.totals,
      technicians: [{ ...RESULT.technicians[0], name: 'Sample Tech' }],
      leftOut: { days: 3, visits: 6, byReason: { costed_before_card: 2, no_card: 1 } },
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('the default window is the 30 days ending yesterday (Eastern)', async () => {
    await request.get('/api/admin/cost-cards/open-time');
    expect(mockComputeOpenTime).toHaveBeenCalledWith(expect.anything(), { from: '2026-09-27', to: '2026-10-26' });
  });

  test('from and to are passed through', async () => {
    const res = await request.get('/api/admin/cost-cards/open-time?from=2026-10-01&to=2026-10-15');
    expect(res.status).toBe(200);
    expect(mockComputeOpenTime).toHaveBeenCalledWith(expect.anything(), { from: '2026-10-01', to: '2026-10-15' });
  });

  test.each([
    ['not a date', '?from=yesterday&to=2026-10-15'],
    ['not a real day', '?from=2026-02-30&to=2026-03-15'],
    ['from after to', '?from=2026-10-15&to=2026-10-01'],
    ['more than 92 days', '?from=2026-07-01&to=2026-10-26'],
  ])('refuses %s with 400', async (_n, query) => {
    const res = await request.get(`/api/admin/cost-cards/open-time${query}`);
    expect(res.status).toBe(400);
    expect(mockComputeOpenTime).not.toHaveBeenCalled();
  });

  test('exactly 92 days is allowed', async () => {
    const res = await request.get('/api/admin/cost-cards/open-time?from=2026-07-27&to=2026-10-26');
    expect(res.status).toBe(200);
  });

  test('a read failure answers 500 in plain words, with no detail', async () => {
    mockComputeOpenTime.mockRejectedValue(Object.assign(new Error('relation x does not exist 555-0100'), { code: '42P01' }));
    const res = await request.get('/api/admin/cost-cards/open-time');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('555-0100');
  });
});
