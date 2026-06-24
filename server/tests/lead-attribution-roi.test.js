// Revenue accuracy for calculateSourceROI — the attribution dashboard's ROI is
// only as honest as this number. Locks in two fixes:
//   • the invoice query is bounded to the period END (was `>= start` only).
//   • revenue is attributed PER won-lead, counted from its conversion onward —
//     never the customer's pre-conversion billing history.
let mockDbConfig = {};
let mockWhereCalls = [];

jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const rows = mockDbConfig[table];
    const builder = {
      where(...args) { mockWhereCalls.push([table, ...args]); return builder; },
      whereIn(...args) { mockWhereCalls.push([table, 'whereIn', args[0]]); return builder; },
      first: async () => (Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null)),
      select: async () => (Array.isArray(rows) ? rows : []),
      then(resolve, reject) {
        return Promise.resolve(Array.isArray(rows) ? rows : []).then(resolve, reject);
      },
    };
    return builder;
  };
  const db = (table) => makeBuilder(table);
  db.raw = (s) => ({ __raw: s });
  db.fn = { now: () => 'NOW' };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { calculateSourceROI } = require('../services/lead-attribution');

describe('calculateSourceROI — window- and conversion-bounded revenue', () => {
  const start = new Date('2026-06-01T00:00:00Z');
  const end = new Date('2026-06-30T23:59:59Z');

  beforeEach(() => { mockDbConfig = {}; mockWhereCalls = []; });

  function setup({ leads, costs = [], invoices = [], services = [], monthlyCost = 0 }) {
    mockDbConfig = {
      lead_sources: { id: 'src-1', name: 'GBP', monthly_cost: monthlyCost, channel: 'organic' },
      leads,
      lead_source_costs: costs,
      invoices,
      service_records: services,
    };
  }

  test('excludes invoices dated BEFORE the lead converted (no pre-conversion history)', async () => {
    const convertedAt = new Date('2026-06-15T00:00:00Z');
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [{ id: 'L1', status: 'won', customer_id: 'c1', converted_at: convertedAt }],
      invoices: [
        { customer_id: 'c1', total: '500', created_at: new Date('2026-06-10T00:00:00Z') }, // pre-conversion → ignored
        { customer_id: 'c1', total: '120', created_at: new Date('2026-06-20T00:00:00Z') }, // post-conversion → counted
      ],
    });

    const res = await calculateSourceROI('src-1', start, end);
    expect(res.totalRevenue).toBe(120);
    expect(res.roi).toBeCloseTo(3900, 0); // (120 - 3) / 3 * 100
  });

  test('bounds the invoice query to the period end (created_at <= end)', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [{ id: 'L1', status: 'won', customer_id: 'c1', converted_at: start }],
      invoices: [{ customer_id: 'c1', total: '100', created_at: start }],
    });

    await calculateSourceROI('src-1', start, end);
    const hasUpperBound = mockWhereCalls.some(
      (c) => c[0] === 'invoices' && c[1] === 'created_at' && c[2] === '<=' && c[3] === end,
    );
    expect(hasUpperBound).toBe(true);
  });

  test('falls back to captured monthly_value + initial_service_value when not yet billed', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [{
        id: 'L1', status: 'won', customer_id: 'c1', converted_at: end,
        monthly_value: '80', initial_service_value: '200',
      }],
      invoices: [],
      services: [],
    });

    const res = await calculateSourceROI('src-1', start, end);
    expect(res.totalRevenue).toBe(280); // 1 month * 80 + 200
  });

  test('a source with cost but no conversions reads negative ROI, not a placeholder', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [{ id: 'L1', status: 'new', customer_id: null }],
    });

    const res = await calculateSourceROI('src-1', start, end);
    expect(res.totalRevenue).toBe(0);
    expect(res.conversions).toBe(0);
    expect(res.roi).toBe(-100); // (0 - 3) / 3 * 100
  });
});
