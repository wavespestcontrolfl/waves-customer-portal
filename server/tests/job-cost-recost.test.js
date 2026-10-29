// L11b: the nightly re-cost after the trip link (GATE_TECH_OPEN_TIME + GATE_TECH_COST_RATES).
// Synthetic ids only.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../config/feature-gates', () => ({
  techOpenTimeLive: jest.fn(),
  techCostRatesLive: jest.fn(),
}));
jest.mock('../services/job-costing', () => ({ calculateJobCost: jest.fn(), resolveServiceRecord: jest.fn() }));
jest.mock('../services/tech-cost-rates', () => ({
  loadVisitRates: jest.fn(),
  dateString: (v) => (typeof v === 'string' ? v.slice(0, 10) : null),
}));
jest.mock('../services/trip-link', () => ({
  nightlyDays: jest.fn(),
  lateArrivals: jest.fn(),
}));

const gates = require('../config/feature-gates');
const logger = require('../services/logger');
const { calculateJobCost, resolveServiceRecord } = require('../services/job-costing');
const { loadVisitRates } = require('../services/tech-cost-rates');
const tripLink = require('../services/trip-link');
const { recostVisits, recostNightly } = require('../services/job-cost-recost');

const VISITS = {
  'svc-ok': { id: 'svc-ok', status: 'completed', technician_id: 'tech-1', scheduled_date: '2026-10-26' },
  'svc-ok2': { id: 'svc-ok2', status: 'completed', technician_id: 'tech-1', scheduled_date: '2026-10-26' },
  'svc-pending': { id: 'svc-pending', status: 'scheduled', technician_id: 'tech-1', scheduled_date: '2026-10-26' },
  'svc-notech': { id: 'svc-notech', status: 'completed', technician_id: null, scheduled_date: '2026-10-26' },
  'svc-nocard': { id: 'svc-nocard', status: 'completed', technician_id: 'tech-nocard', scheduled_date: '2026-10-26' },
  'svc-boom': { id: 'svc-boom', status: 'completed', technician_id: 'tech-1', scheduled_date: '2026-10-26' },
};

function fakeConn({ legIds = [] } = {}) {
  const queries = [];
  const conn = (table) => {
    queries.push(table);
    const chain = {
      where: (cond) => { chain.cond = cond; return chain; },
      first: () => Promise.resolve(VISITS[chain.cond && chain.cond.id]),
      whereIn: (col, values) => { chain.days = values; return chain; },
      pluck: () => Promise.resolve(legIds),
      columnInfo: () => Promise.resolve({ scheduled_service_id: {}, revenue: {} }),
    };
    return chain;
  };
  conn.queries = queries;
  return conn;
}

beforeEach(() => {
  jest.clearAllMocks();
  gates.techOpenTimeLive.mockReturnValue(true);
  gates.techCostRatesLive.mockReturnValue(true);
  loadVisitRates.mockImplementation(async (conn, technicianId) => (technicianId === 'tech-nocard' ? null : { cardId: 'card-1', laborPerWorkedHourCents: 2725 }));
  calculateJobCost.mockResolvedValue({});
  // One service record with its revenue written: the re-cost keeps it (keepRecordedRevenue).
  resolveServiceRecord.mockResolvedValue({ record: { id: 'sr-1', revenue: '129.00' }, ambiguous: false });
  tripLink.lateArrivals.mockResolvedValue([]);
  tripLink.nightlyDays.mockReturnValue(['2026-10-26', '2026-10-25']);
});

describe('recostVisits', () => {
  test('a completed visit with a card is re-costed as a cost-only run (revenue kept as recorded)', async () => {
    const conn = fakeConn();
    const result = await recostVisits(conn, ['svc-ok']);
    expect(result).toEqual({ recosted: 1, skipped: 0, failed: 0 });
    expect(calculateJobCost).toHaveBeenCalledTimes(1);
    expect(calculateJobCost).toHaveBeenCalledWith('svc-ok', conn, { keepRecordedRevenue: true });
    expect(loadVisitRates).toHaveBeenCalledWith(conn, 'tech-1', '2026-10-26');
  });

  test('no card, not completed, no technician, or no such visit: skipped, nothing costed', async () => {
    const result = await recostVisits(fakeConn(), ['svc-nocard', 'svc-pending', 'svc-notech', 'svc-missing']);
    expect(result).toEqual({ recosted: 0, skipped: 4, failed: 0 });
    expect(calculateJobCost).not.toHaveBeenCalled();
  });

  test('no single service record with revenue written: skipped, so the ledger revenue is never derived again', async () => {
    const cases = [
      { record: null, ambiguous: false }, // reportless visit
      { record: { id: 'sr-a', revenue: '129.00' }, ambiguous: true }, // ambiguous legacy match
      { record: { id: 'sr-b', revenue: null }, ambiguous: false }, // no revenue written yet
      { record: { id: 'sr-c', revenue: '-5.00' }, ambiguous: false }, // keepRecordedRevenue would not keep it
    ];
    for (const resolution of cases) resolveServiceRecord.mockResolvedValueOnce(resolution);
    const result = await recostVisits(fakeConn(), ['svc-ok', 'svc-ok', 'svc-ok', 'svc-ok']);
    expect(result).toEqual({ recosted: 0, skipped: 4, failed: 0 });
    expect(calculateJobCost).not.toHaveBeenCalled();
  });

  test('a recorded $0 is revenue written: the visit is re-costed and keeps it', async () => {
    resolveServiceRecord.mockResolvedValueOnce({ record: { id: 'sr-0', revenue: '0.00' }, ambiguous: false });
    const result = await recostVisits(fakeConn(), ['svc-ok']);
    expect(result).toEqual({ recosted: 1, skipped: 0, failed: 0 });
    expect(calculateJobCost).toHaveBeenCalledWith('svc-ok', expect.anything(), { keepRecordedRevenue: true });
  });

  test('one failure does not stop the others, and the log carries the id and error code only', async () => {
    calculateJobCost.mockImplementation(async (id) => {
      if (id === 'svc-boom') throw Object.assign(new Error('secret detail 555-0100 12 Example St'), { code: 'XX000' });
      return {};
    });
    const result = await recostVisits(fakeConn(), ['svc-ok', 'svc-boom', 'svc-ok2']);
    expect(result).toEqual({ recosted: 2, skipped: 0, failed: 1 });
    expect(calculateJobCost.mock.calls.map((c) => c[0])).toEqual(['svc-ok', 'svc-boom', 'svc-ok2']);
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('svc-boom');
    expect(logged).toContain('XX000');
    expect(logged).not.toContain('secret detail');
    expect(logged).not.toContain('Example St');
  });

  test('dry run counts the visits that would be re-costed and costs none', async () => {
    const result = await recostVisits(fakeConn(), ['svc-ok', 'svc-nocard'], { dryRun: true });
    expect(result).toEqual({ recosted: 1, skipped: 1, failed: 0 });
    expect(calculateJobCost).not.toHaveBeenCalled();
  });
});

describe('recostNightly', () => {
  test.each([
    ['GATE_TECH_OPEN_TIME off', () => gates.techOpenTimeLive.mockReturnValue(false)],
    ['GATE_TECH_COST_RATES off', () => gates.techCostRatesLive.mockReturnValue(false)],
    ['both off', () => { gates.techOpenTimeLive.mockReturnValue(false); gates.techCostRatesLive.mockReturnValue(false); }],
  ])('%s: returns gated before any query', async (_name, turnOff) => {
    turnOff();
    const conn = fakeConn();
    expect(await recostNightly({ conn, now: new Date('2026-10-27T05:40:00Z') })).toEqual({ skipped: 'gated' });
    expect(conn.queries).toEqual([]);
    expect(tripLink.lateArrivals).not.toHaveBeenCalled();
    expect(calculateJobCost).not.toHaveBeenCalled();
  });

  test('the strict gate: a truthy non-true reading is off', async () => {
    gates.techOpenTimeLive.mockReturnValue('yes');
    const conn = fakeConn();
    expect(await recostNightly({ conn })).toEqual({ skipped: 'gated' });
    expect(conn.queries).toEqual([]);
  });

  test('uses the trip link\'s day list and re-costs the visits whose legs sit on those days', async () => {
    const now = new Date('2026-10-27T05:40:00Z');
    tripLink.lateArrivals.mockResolvedValue(['2026-10-20T14:00:00Z']);
    const conn = fakeConn({ legIds: ['svc-ok', 'svc-ok2', 'svc-nocard'] });
    const result = await recostNightly({ conn, now });
    expect(tripLink.lateArrivals).toHaveBeenCalledWith(conn, now);
    expect(tripLink.nightlyDays).toHaveBeenCalledWith(now, ['2026-10-20T14:00:00Z']);
    expect(conn.queries).toContain('visit_gps_legs');
    expect(calculateJobCost.mock.calls.map((c) => c[0])).toEqual(['svc-ok', 'svc-ok2']);
    expect(result).toMatchObject({ days: ['2026-10-26', '2026-10-25'], recosted: 2, skipped: 1, failed: 0 });
  });

  test('a failure is thrown after the whole loop has run, so the job health reads red', async () => {
    calculateJobCost.mockImplementation(async (id) => {
      if (id === 'svc-boom') throw new Error('x');
      return {};
    });
    const conn = fakeConn({ legIds: ['svc-boom', 'svc-ok'] });
    await expect(recostNightly({ conn })).rejects.toThrow('1 visit(s) failed to re-cost');
    expect(calculateJobCost.mock.calls.map((c) => c[0])).toEqual(['svc-boom', 'svc-ok']);
  });
});
