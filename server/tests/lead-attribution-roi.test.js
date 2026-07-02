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
      whereNull(...args) { mockWhereCalls.push([table, 'whereNull', ...args]); return builder; },
      whereIn(...args) { mockWhereCalls.push([table, 'whereIn', args[0]]); return builder; },
      whereNotIn(...args) { mockWhereCalls.push([table, 'whereNotIn', ...args]); return builder; },
      modify(fn) { fn(builder); return builder; },
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
        { id: 'i1', customer_id: 'c1', total: '500', created_at: new Date('2026-06-10T00:00:00Z') }, // pre-conversion → ignored
        { id: 'i2', customer_id: 'c1', total: '120', created_at: new Date('2026-06-20T00:00:00Z') }, // post-conversion → counted
      ],
    });

    const res = await calculateSourceROI('src-1', start, end);
    expect(res.totalRevenue).toBe(120);
    expect(res.roi).toBeCloseTo(3900, 0); // (120 - 3) / 3 * 100
  });

  test('excludeCustomerNames filters internal/test accounts out of the leads query', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [{ id: 'L1', status: 'won', customer_id: 'c1', converted_at: start }],
      invoices: [{ customer_id: 'c1', total: '100', created_at: start }],
    });

    await calculateSourceROI('src-1', start, end, { excludeCustomerNames: ['adam martinez'] });
    const exclusion = mockWhereCalls.find((c) => c[0] === 'leads' && c[1] === 'whereNotIn');
    expect(exclusion).toBeTruthy();
    expect(exclusion[3]).toEqual(['adam martinez']);
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

  test('de-duplicates an invoice across repeat won leads for the same customer', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [
        { id: 'L1', status: 'won', customer_id: 'c1', converted_at: new Date('2026-06-10T00:00:00Z') },
        { id: 'L2', status: 'won', customer_id: 'c1', converted_at: new Date('2026-06-12T00:00:00Z') },
      ],
      // One invoice, dated after BOTH conversions — must be counted ONCE, not per lead.
      invoices: [{ id: 'i1', customer_id: 'c1', total: '300', created_at: new Date('2026-06-20T00:00:00Z') }],
    });

    const res = await calculateSourceROI('src-1', start, end);
    expect(res.conversions).toBe(2);
    expect(res.totalRevenue).toBe(300); // not 600
  });

  test('skips the captured-value fallback when the conversion is AFTER the report end', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      // First-contacted in window but won after `end` → no revenue in this closed period.
      leads: [{
        id: 'L1', status: 'won', customer_id: 'c1',
        converted_at: new Date('2026-07-15T00:00:00Z'),
        monthly_value: '80', initial_service_value: '200',
      }],
      invoices: [],
      services: [],
    });

    const res = await calculateSourceROI('src-1', start, end);
    expect(res.totalRevenue).toBe(0);
  });

  test('uses the window start (NOT updated_at) as the cutoff when converted_at is missing', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      // converted_at null + a late updated_at; the in-window invoice predates
      // updated_at and would be wrongly dropped if updated_at were the cutoff.
      leads: [{
        id: 'L1', status: 'won', customer_id: 'c1',
        converted_at: null, updated_at: new Date('2026-06-28T00:00:00Z'),
      }],
      invoices: [{ id: 'i1', customer_id: 'c1', total: '150', created_at: new Date('2026-06-10T00:00:00Z') }],
    });

    const res = await calculateSourceROI('src-1', start, end);
    expect(res.totalRevenue).toBe(150);
  });

  test('credits NO revenue when another source is the customer’s earliest-conversion winner', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [{
        id: 'L1', status: 'won', customer_id: 'c1', converted_at: start,
        monthly_value: '80', initial_service_value: '200',
      }],
      invoices: [{ id: 'i1', customer_id: 'c1', total: '500', created_at: new Date('2026-06-20T00:00:00Z') }],
    });

    // c1's revenue belongs to a DIFFERENT source (earliest conversion) — this
    // source still counts the conversion but neither the invoice nor the fallback.
    const res = await calculateSourceROI('src-1', start, end, {
      revenueSourceByCustomer: new Map([['c1', 'other-src']]),
    });
    expect(res.conversions).toBe(1);
    expect(res.totalRevenue).toBe(0); // not 500, not 280
  });

  test('credits revenue when THIS source is the customer’s winner', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [{ id: 'L1', status: 'won', customer_id: 'c1', converted_at: start }],
      invoices: [{ id: 'i1', customer_id: 'c1', total: '200', created_at: new Date('2026-06-20T00:00:00Z') }],
    });

    const res = await calculateSourceROI('src-1', start, end, {
      revenueSourceByCustomer: new Map([['c1', 'src-1']]),
    });
    expect(res.totalRevenue).toBe(200);
  });

  test('bounds lead_source_costs by an ET date string, not the month-start timestamp', async () => {
    setup({ costs: [{ cost_amount: 5 }], leads: [] });
    await calculateSourceROI('src-1', start, end);

    const costLower = mockWhereCalls.find(
      (c) => c[0] === 'lead_source_costs' && c[1] === 'month' && c[2] === '>=',
    );
    expect(costLower).toBeDefined();
    // A 'YYYY-MM-DD' string (date column), not a Date/timestamp — otherwise the
    // ET month-start timestamp (04:00 UTC) would drop the current month's DATE row.
    expect(typeof costLower[3]).toBe('string');
    expect(costLower[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('credits a service_record fallback (ET date-bounded) when the customer has no invoices', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [{ id: 'L1', status: 'won', customer_id: 'c1', converted_at: new Date('2026-06-05T00:00:00Z') }],
      invoices: [],
      services: [{ id: 's1', customer_id: 'c1', revenue: '90', service_date: '2026-06-10', status: 'completed' }],
    });

    const res = await calculateSourceROI('src-1', start, end);
    expect(res.totalRevenue).toBe(90); // service.revenue after conversion day, no invoices

    // service_date (a DATE column) is bound by a date string, like the cost month.
    const svcLower = mockWhereCalls.find(
      (c) => c[0] === 'service_records' && c[1] === 'service_date' && c[2] === '>=',
    );
    expect(svcLower).toBeDefined();
    expect(typeof svcLower[3]).toBe('string');
    expect(svcLower[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('filters to billed invoices and completed services (status guards)', async () => {
    // A won lead with a customer makes the invoice/service queries run.
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [{ id: 'L1', status: 'won', customer_id: 'c1', converted_at: start }],
      invoices: [],
      services: [],
    });
    await calculateSourceROI('src-1', start, end);

    const invStatus = mockWhereCalls.find(
      (c) => c[0] === 'invoices' && c[1] === 'whereNotIn' && c[2] === 'status',
    );
    expect(invStatus).toBeDefined();
    expect(invStatus[3]).toEqual(expect.arrayContaining(['void', 'cancelled', 'draft', 'refunded']));

    const svcStatus = mockWhereCalls.find(
      (c) => c[0] === 'service_records' && c[1] === 'status' && c[2] === 'completed',
    );
    expect(svcStatus).toBeDefined();
  });
});
