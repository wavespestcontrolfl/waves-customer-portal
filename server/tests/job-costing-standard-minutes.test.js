// GATE_JOB_COST_STANDARD_MINUTES (owner ruling 2026-10-31): standard on-site minutes per lawn and pest
// visit, the Average Drive Time per stop, and revenue from the visit's own sources. Gate off = today's
// numbers. Synthetic ids and numbers only.
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/ad-attribution-sync', () => ({
  syncCustomerAdAttribution: jest.fn().mockResolvedValue({}),
}));
jest.mock('../services/tech-cost-rates', () => ({ loadVisitRates: jest.fn() }));

const logger = require('../services/logger');
const { loadVisitRates } = require('../services/tech-cost-rates');
const { GLOBAL } = require('../services/pricing-engine/constants');
const jobCosting = require('../services/job-costing');

const { calculateJobCost, deriveRevenue, standardLaborMinutesFor } = jobCosting;
const GATE = 'GATE_JOB_COST_STANDARD_MINUTES';
const STAMPED = 'GATE_STAMPED_ZERO_FREE';
const CARDS = 'GATE_TECH_COST_RATES';

const SVC = {
  id: 'svc-1',
  customer_id: 'cust-1',
  technician_id: 'tech-1',
  service_type: 'Lawn Care Service',
  scheduled_date: '2026-10-20',
  status: 'completed',
  estimated_price: 89,
  estimated_duration_minutes: 45,
  actual_start_time: '2026-10-20T14:00:00Z',
  actual_end_time: '2026-10-20T15:00:00Z', // one measured hour
  service_time_minutes: null,
  annual_prepay_term_id: null,
};
const RECORD = {
  id: 'rec-1', scheduled_service_id: 'svc-1', status: 'completed', revenue: null, structured_notes: { visitOutcome: 'completed' },
};
const SR_COLS = {
  scheduled_service_id: {}, status: {}, revenue: {}, material_cost: {}, labor_hours: {}, labor_cost: {}, drive_cost: {},
  total_job_cost: {}, gross_profit: {}, gross_margin_pct: {}, revenue_per_man_hour: {}, vehicle_fixed_cost: {},
};

// A small in-memory knex stand-in: tables are arrays, where/whereNotIn filter, first/count/select read.
function fakeDb(tables = {}) {
  const stores = {
    scheduled_services: [SVC],
    service_records: [RECORD],
    customers: [{ id: 'cust-1', monthly_rate: 99 }],
    company_financials: [{ loaded_labor_rate: 35, drive_cost_per_stop: 6, effective_date: '2026-01-01' }],
    annual_prepay_terms: [],
    invoices: [],
    time_entries: [],
    visit_billing_dispositions: [],
    expenses: [],
    ...tables,
  };
  const writes = { jobCosts: [], serviceRecordUpdates: [], queried: new Set() };
  const db = (table) => {
    writes.queried.add(table);
    const preds = [];
    let counting = false;
    const rows = () => (stores[table] || []).filter((r) => preds.every((p) => p(r)));
    const chain = {
      where: (a, op, val) => {
        if (a && typeof a === 'object') preds.push((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        else if (op === '<=') preds.push((r) => r[a] <= val);
        return chain;
      },
      whereNot: () => chain,
      whereNotIn: (col, list) => { preds.push((r) => !list.includes(r[col])); return chain; },
      whereNotNull: () => chain,
      whereBetween: () => chain,
      orderBy: () => chain,
      forUpdate: () => chain,
      limit: () => Promise.resolve(rows()),
      columnInfo: () => Promise.resolve(table === 'service_records' ? SR_COLS : {}),
      select: () => Promise.resolve(rows()),
      count: () => { counting = true; return chain; },
      first: () => {
        if (counting) return Promise.resolve({ c: rows().length });
        return Promise.resolve(rows()[0] || null);
      },
      insert: (row) => { if (table === 'job_costs') writes.jobCosts.push(row); return Promise.resolve([1]); },
      update: (upd) => { if (table === 'service_records') writes.serviceRecordUpdates.push(upd); return Promise.resolve(1); },
    };
    return chain;
  };
  db.schema = { hasTable: async () => false };
  db.transaction = async (fn) => fn(db);
  db.writes = writes;
  return db;
}

const withSvc = (patch) => ({ scheduled_services: [{ ...SVC, ...patch }] });
const withRecord = (patch) => ({ service_records: [{ ...RECORD, ...patch }] });
const cost = (db, opts) => calculateJobCost('svc-1', db, opts);

describe('GATE_JOB_COST_STANDARD_MINUTES', () => {
  const OLD = { [GATE]: process.env[GATE], [STAMPED]: process.env[STAMPED], [CARDS]: process.env[CARDS] };
  const oldDriveTime = GLOBAL.DRIVE_TIME;
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env[GATE];
    delete process.env[STAMPED];
    delete process.env[CARDS];
    GLOBAL.DRIVE_TIME = oldDriveTime;
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(OLD)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    GLOBAL.DRIVE_TIME = oldDriveTime;
  });

  describe('gate off: today, byte for byte', () => {
    test('measured hour, drive_cost_per_stop, and no revenue lookups', async () => {
      const db = fakeDb();
      const res = await cost(db, { keepRecordedRevenue: true });
      expect(res.labor_cost).toBe(35);
      expect(res.laborHours).toBe(1);
      expect(res.drive_cost).toBe(6);
      expect(res.revenue).toBe(89);
      expect(db.writes.queried.has('annual_prepay_terms')).toBe(false);
      expect(db.writes.queried.has('invoices')).toBe(false);
    });

    test('the gate is strict: "1", "TRUE" and "yes" leave it off', async () => {
      for (const value of ['1', 'TRUE', 'yes', '']) {
        process.env[GATE] = value;
        const res = await cost(fakeDb());
        expect(res.labor_cost).toBe(35);
        expect(res.drive_cost).toBe(6);
      }
    });

    test('a recorded $0 with a price still keeps the $0 under keepRecordedRevenue', async () => {
      const res = await cost(fakeDb(withRecord({ revenue: 0 })), { keepRecordedRevenue: true });
      expect(res.revenue).toBe(0);
    });
  });

  describe('gate on: labor minutes', () => {
    beforeEach(() => { process.env[GATE] = 'true'; });

    test('a lawn care visit books 20 minutes, a pest control visit 25, whatever the clock says', async () => {
      const lawn = await cost(fakeDb());
      expect(lawn.laborHours).toBe(0.33);
      expect(lawn.labor_cost).toBe(11.67); // 20/60 x 35
      const pest = await cost(fakeDb(withSvc({ service_type: 'Quarterly Pest Control Service' })));
      expect(pest.laborHours).toBe(0.42);
      expect(pest.labor_cost).toBe(14.58); // 25/60 x 35
    });

    test('the standard replaces time entries, backfill minutes and a combined-closeout share', async () => {
      const db = fakeDb({
        ...withRecord({ structured_notes: { backfill: true, visitDurationAllocation: { version: 1, allocatedMinutes: 90 } } }),
        ...withSvc({ service_time_minutes: 70 }),
        time_entries: [{ job_id: 'svc-1', entry_type: 'job', duration_minutes: 200 }],
      });
      const res = await cost(db, { explicitLaborMinutes: 80 });
      expect(res.labor_cost).toBe(11.67);
    });

    test('specialty and one-off names keep their measured time', async () => {
      for (const name of [
        'Rodent Control Service', 'Termite Inspection', 'Mosquito Control Pest Control', 'Pest Control — Cockroach Treatment',
        'Lawn Care Wasp Removal', 'Bed Bug Treatment', 'Flea Pest Control', 'Wildlife Exclusion',
      ]) {
        expect(standardLaborMinutesFor(name)).toBeNull();
        const res = await cost(fakeDb(withSvc({ service_type: name })));
        expect(res.labor_cost).toBe(35);
      }
      expect(standardLaborMinutesFor('Tree & Shrub Service')).toBeNull();
      expect(standardLaborMinutesFor('Monthly Lawn Care Service')).toBe(20);
      expect(standardLaborMinutesFor('PEST CONTROL')).toBe(25);
    });

    test('a visit that is not completed books no standard labor', async () => {
      const res = await cost(fakeDb({ ...withSvc({ status: 'scheduled', actual_start_time: null, actual_end_time: null }) }));
      expect(res.labor_cost).toBe(0);
    });

    test('an admin time-on-site correction wins over the standard', async () => {
      const stamped = await cost(fakeDb(withSvc({ time_on_site_adjusted_minutes: 45 })));
      expect(stamped.labor_cost).toBe(26.25);
      const marker = await cost(fakeDb({
        ...withSvc({ service_time_minutes: 30 }),
        ...withRecord({ structured_notes: { timeOnSiteAdjusted: true } }),
      }));
      expect(marker.labor_cost).toBe(17.5);
      const option = await cost(fakeDb(), { overrideLaborMinutes: 600 });
      expect(option.laborHours).toBe(10); // an override is never second-guessed
    });

    test('a measured span over 480 minutes books the scheduled estimate, and logs only the visit id', async () => {
      const stale = {
        service_type: 'Tree & Shrub Service', actual_start_time: '2026-10-01T14:00:00Z', actual_end_time: '2026-10-20T15:00:00Z',
      };
      const res = await cost(fakeDb(withSvc(stale)));
      expect(res.labor_cost).toBe(26.25); // 45 minutes
      const warning = logger.warn.mock.calls.map((c) => c[0]).find((m) => /over 480 minutes/.test(m));
      expect(warning).toContain('svc-1');
      expect(warning).not.toMatch(/cust-1|tech-1/);
      const noEstimate = await cost(fakeDb(withSvc({ ...stale, estimated_duration_minutes: null })));
      expect(noEstimate.labor_cost).toBe(0);
      // 480 minutes exactly and below stay measured.
      const edge = await cost(fakeDb(withSvc({
        service_type: 'Tree & Shrub Service', actual_start_time: '2026-10-20T10:00:00Z', actual_end_time: '2026-10-20T18:00:00Z',
      })));
      expect(edge.laborHours).toBe(8);
    });
  });

  describe('gate on: drive', () => {
    beforeEach(() => { process.env[GATE] = 'true'; });

    test('the drive owner books the Average Drive Time at the labor rate, other members book 0', async () => {
      const owner = await cost(fakeDb());
      expect(owner.drive_cost).toBe(11.67); // 20/60 x 35
      const marker = (ownerServiceId) => withRecord({
        structured_notes: { visitDriveCostAllocation: { version: 1, packetId: 'p-1', ownerServiceId } },
      });
      expect((await cost(fakeDb(marker('svc-1')))).drive_cost).toBe(11.67);
      expect((await cost(fakeDb(marker('svc-2')))).drive_cost).toBe(0);
    });

    test('the Average Drive Time is read when the visit is costed', async () => {
      GLOBAL.DRIVE_TIME = 30;
      expect((await cost(fakeDb())).drive_cost).toBe(17.5);
    });

    test('a cost card keeps its own drive path but charges the same on-job minutes', async () => {
      process.env[CARDS] = 'true';
      loadVisitRates.mockResolvedValue({
        cardId: 'card-1', laborPerWorkedHourCents: 3000,
        vehicle: { cardId: 'veh-1', fixedPerWorkedHourCents: 0, perMileTenThousandths: 0 },
      });
      const res = await cost(fakeDb());
      expect(res.costRates).toMatchObject({ onJobMinutes: 20, driveSource: 'default' });
      // (20 on site + 24 default drive minutes) / 60 x $30
      expect(res.labor_cost).toBe(22);
      expect(res.laborHours).toBe(0.33);
    });
  });

  describe('gate on: revenue', () => {
    beforeEach(() => { process.env[GATE] = 'true'; });
    const KEEP = { keepRecordedRevenue: true };
    const unpriced = { estimated_price: null };

    test('a recorded revenue above $0 is kept', async () => {
      expect((await cost(fakeDb(withRecord({ revenue: 120 })), KEEP)).revenue).toBe(120);
    });

    test('a recorded $0 falls to the visit price', async () => {
      expect((await cost(fakeDb(withRecord({ revenue: 0 })), KEEP)).revenue).toBe(89);
    });

    test('a recorded $0 with no price falls to the visit\'s share of a paid annual-prepay term', async () => {
      const statuses = [...Array(11).fill('scheduled'), 'cancelled', 'skipped'];
      const others = statuses.map((status, i) => ({ id: `v-${i}`, annual_prepay_term_id: 'term-1', status }));
      const tables = (term) => ({
        ...withRecord({ revenue: 0 }),
        annual_prepay_terms: [term],
        scheduled_services: [{ ...SVC, ...unpriced, annual_prepay_term_id: 'term-1' }, ...others],
      });
      const live = { id: 'term-1', prepay_amount: '480.00', status: 'active' };
      // This visit and 11 scheduled ones are counted: 12. The cancelled and the skipped one are not.
      expect((await cost(fakeDb(tables(live)), KEEP)).revenue).toBe(40);
      // A covered visit stamped $0 gets the share BEFORE the stamped-zero rule.
      process.env[STAMPED] = 'true';
      const stamped = { ...tables(live), scheduled_services: tables(live).scheduled_services.map((s) => (s.id === 'svc-1' ? { ...s, estimated_price: 0 } : s)) };
      expect((await cost(fakeDb(stamped), KEEP)).revenue).toBe(40);
    });

    test('an unpaid term gives no share; a payment_pending term counts once its prepay invoice is paid', async () => {
      const base = {
        ...withSvc({ ...unpriced, annual_prepay_term_id: 'term-1' }),
        ...withRecord({ revenue: 0 }),
      };
      const term = (patch) => ({ id: 'term-1', prepay_amount: '120.00', status: 'payment_pending', prepay_invoice_id: 'inv-p', ...patch });
      const pending = fakeDb({ ...base, annual_prepay_terms: [term()], invoices: [{ id: 'inv-p', status: 'sent', paid_at: null }] });
      expect((await cost(pending, KEEP)).revenue).toBe(0);
      const paid = fakeDb({ ...base, annual_prepay_terms: [term()], invoices: [{ id: 'inv-p', status: 'paid', paid_at: '2026-10-01T00:00:00Z' }] });
      expect((await cost(paid, KEEP)).revenue).toBe(120); // this visit is the only one counted
      const refunded = fakeDb({ ...base, annual_prepay_terms: [term({ status: 'refunded' })] });
      expect((await cost(refunded, KEEP)).revenue).toBe(0);
    });

    test('a linked invoice gives its service lines, without setup, membership or onboarding fee lines or tax', async () => {
      const invoice = {
        service_record_id: 'rec-1', status: 'paid',
        line_items: [
          { description: 'Quarterly Pest Control Service', quantity: 1, unit_price: 129, amount: 129 },
          { description: 'WaveGuard Membership — one-time setup', amount: 99 },
          { description: 'One-time setup fee', quantity: 1, unit_price: 49 },
          { description: 'setup fee — waived (first application promo)', amount: 0 },
          { description: 'Onboarding fee', amount: 25 },
          { description: 'Sales tax', amount: 9.03 },
          { description: 'Wasp add-on', quantity: 2, unit_price: 10 },
        ],
      };
      const tables = { ...withSvc(unpriced), ...withRecord({ revenue: 0 }), invoices: [invoice] };
      expect((await cost(fakeDb(tables), KEEP)).revenue).toBe(149);
      // line_items can arrive as serialized text.
      const text = { ...tables, invoices: [{ ...invoice, line_items: JSON.stringify(invoice.line_items) }] };
      expect((await cost(fakeDb(text), KEEP)).revenue).toBe(149);
      // A void invoice bills nothing; a setup-fee-only invoice leaves $0.
      expect((await cost(fakeDb({ ...tables, invoices: [{ ...invoice, status: 'void' }] }), KEEP)).revenue).toBe(0);
      const feeOnly = { ...invoice, line_items: [{ description: 'One-time setup fee', amount: 99 }] };
      expect((await cost(fakeDb({ ...tables, invoices: [feeOnly] }), KEEP)).revenue).toBe(0);
    });

    test('monthly_rate is never used under keepRecordedRevenue, and is the old fallback without it', async () => {
      const tables = { ...withSvc(unpriced), ...withRecord({ revenue: 0 }) };
      expect((await cost(fakeDb(tables), KEEP)).revenue).toBe(0);
      expect((await cost(fakeDb(tables))).revenue).toBe(99);
    });

    test('free types, included follow-ups, consultations and callbacks stay $0', async () => {
      const invoice = { service_record_id: 'rec-1', status: 'paid', line_items: [{ description: 'Service', amount: 80 }] };
      const run = (patch) => cost(fakeDb({ ...withSvc(patch), ...withRecord({ revenue: 0 }), invoices: [invoice] }), KEEP);
      expect((await run({ service_type: 'Pest Control Re-Service', estimated_price: 50 })).revenue).toBe(0);
      expect((await run({ ...unpriced, followup_included: true })).revenue).toBe(0);
      expect((await run({ ...unpriced, service_type: 'Waves Assessment' })).revenue).toBe(0);
      expect((await run({ ...unpriced, is_callback: true })).revenue).toBe(0);
      expect((await run(unpriced)).revenue).toBe(80);
    });

    test('an intentionally free disposition is $0', async () => {
      const db = fakeDb({
        ...withRecord({ revenue: 0 }),
        visit_billing_dispositions: [{ scheduled_service_id: 'svc-1', disposition: 'intentionally_free' }],
      });
      expect((await cost(db, KEEP)).revenue).toBe(0);
    });

    test('the rolled-up row carries the standard figures through to job_costs and service_records', async () => {
      const db = fakeDb(withRecord({ revenue: 0 }));
      const res = await cost(db, KEEP);
      expect(res.total_cost).toBe(23.34); // 11.67 labor + 11.67 drive
      expect(res.gross_profit).toBe(65.66);
      expect(db.writes.jobCosts[0]).toMatchObject({ labor_cost: 11.67, drive_cost: 11.67, revenue: 89 });
      expect(db.writes.serviceRecordUpdates[0]).toMatchObject({ labor_cost: 11.67, drive_cost: 11.67, labor_hours: 0.33 });
    });
  });

  describe('deriveRevenue stays pure', () => {
    test('without ownRevenue it is exactly today\'s function', () => {
      expect(deriveRevenue({
        serviceRecord: { revenue: 0 }, scheduledService: { estimated_price: 149 }, customer: { monthly_rate: 99 }, keepRecordedRevenue: true,
      })).toBe(0);
    });

    test('with ownRevenue the prepay share outranks the invoice, which outranks nothing', () => {
      const base = { serviceRecord: { revenue: 0 }, scheduledService: { estimated_price: null }, keepRecordedRevenue: true };
      expect(deriveRevenue({ ...base, ownRevenue: { prepayShare: 40, invoiceTotal: 70 } })).toBe(40);
      expect(deriveRevenue({ ...base, ownRevenue: { prepayShare: 0, invoiceTotal: 70 } })).toBe(70);
      expect(deriveRevenue({ ...base, customer: { monthly_rate: 99 }, ownRevenue: { prepayShare: 0, invoiceTotal: 0 } })).toBe(0);
    });
  });
});
