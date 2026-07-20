jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/ad-attribution-sync', () => ({
  syncCustomerAdAttribution: jest.fn().mockResolvedValue({}),
}));

const {
  deriveRevenue,
  computeServiceRecordFinancials,
  calculateJobCost,
} = require('../services/job-costing');

describe('deriveRevenue — mirrors the completion handler invoiceAmount', () => {
  test('an explicit visit price (estimated_price) wins over monthly_rate', () => {
    const rev = deriveRevenue({
      serviceRecord: { revenue: null },
      scheduledService: { estimated_price: 149, is_callback: false },
      customer: { monthly_rate: 99 },
    });
    expect(rev).toBe(149);
  });

  test('non-callback with no visit price falls back to monthly_rate', () => {
    const rev = deriveRevenue({
      serviceRecord: {},
      scheduledService: { estimated_price: null, is_callback: false },
      customer: { monthly_rate: 99 },
    });
    expect(rev).toBe(99);
  });

  test('a callback with no explicit price is free ($0), never monthly_rate', () => {
    const rev = deriveRevenue({
      serviceRecord: {},
      scheduledService: { estimated_price: null, is_callback: true },
      customer: { monthly_rate: 99 },
    });
    expect(rev).toBe(0);
  });

  test('a callback the operator priced uses that explicit price', () => {
    const rev = deriveRevenue({
      serviceRecord: {},
      scheduledService: { estimated_price: 75, is_callback: true },
      customer: { monthly_rate: 99 },
    });
    expect(rev).toBe(75);
  });

  test('a revenue already written on the record short-circuits (idempotent recompute)', () => {
    const rev = deriveRevenue({
      serviceRecord: { revenue: 120 },
      scheduledService: { estimated_price: 149, is_callback: false },
      customer: { monthly_rate: 99 },
    });
    expect(rev).toBe(120);
  });

  test('ignoreExistingRevenue (backfill) re-derives, bypassing a stale seeded revenue', () => {
    // 20260401000027 seeded synthetic revenue; the backfill must recompute from
    // source rather than preserve it and build margin around a fake number.
    const rev = deriveRevenue({
      serviceRecord: { revenue: 87.34 }, // synthetic seed
      scheduledService: { estimated_price: 149, is_callback: false },
      customer: { monthly_rate: 99 },
      ignoreExistingRevenue: true,
    });
    expect(rev).toBe(149);
  });

  test('an included follow-up is free ($0), never monthly_rate (no double-count)', () => {
    // Scheduler creates included follow-ups with estimated_price=0 +
    // followup_included=true; the originating visit already booked the revenue.
    const rev = deriveRevenue({
      serviceRecord: {},
      scheduledService: { estimated_price: 0, is_callback: false, followup_included: true },
      customer: { monthly_rate: 99 },
    });
    expect(rev).toBe(0);
  });

  test('an always-free type with a STALE positive price is still $0 (never bills)', () => {
    // no-cost-visit-types + the dispatch invoice gate treat these as $0 even with
    // an inherited estimated_price, so the always-free check precedes the price.
    const rev = deriveRevenue({
      serviceRecord: {},
      scheduledService: { service_type: 'Re-Service', estimated_price: 120, is_callback: false },
      customer: { monthly_rate: 99 },
    });
    expect(rev).toBe(0);
  });

  test('a completed free re-service flagged on the RECORD is $0, not monthly', () => {
    // 20260618000002 backfills service_records.is_callback but leaves the terminal
    // scheduled_services row is_callback=false — so the record flag must be honored.
    const rev = deriveRevenue({
      serviceRecord: { is_callback: true },
      scheduledService: { is_callback: false, estimated_price: null },
      customer: { monthly_rate: 99 },
    });
    expect(rev).toBe(0);
  });

  test('an always-free service type (re-service / follow-up) is $0, not monthly', () => {
    const reService = deriveRevenue({
      serviceRecord: {},
      scheduledService: { service_type: 'Free Re-Service', estimated_price: null },
      customer: { monthly_rate: 99 },
    });
    expect(reService).toBe(0);
    const followUp = deriveRevenue({
      serviceRecord: { service_type: 'Follow-up Visit' },
      scheduledService: { estimated_price: null },
      customer: { monthly_rate: 99 },
    });
    expect(followUp).toBe(0);
  });

  test('no price anywhere yields $0', () => {
    expect(deriveRevenue({ serviceRecord: {}, scheduledService: {}, customer: {} })).toBe(0);
  });
});

describe('computeServiceRecordFinancials', () => {
  test('rolls up costs, margin, and revenue-per-man-hour', () => {
    const fin = computeServiceRecordFinancials({
      revenue: 100,
      laborHours: 0.5,
      laborCost: 17.5,
      productsCost: 10,
      driveCost: 6,
    });
    expect(fin.total_job_cost).toBe(33.5);
    expect(fin.gross_profit).toBe(66.5);
    expect(fin.gross_margin_pct).toBe(66.5);
    expect(fin.revenue_per_man_hour).toBe(200);
    expect(fin.material_cost).toBe(10);
    expect(fin.labor_hours).toBe(0.5);
  });

  test('margin and rpmh are null (not 0) when revenue/labor are absent', () => {
    const fin = computeServiceRecordFinancials({
      revenue: 0,
      laborHours: 0,
      laborCost: 0,
      productsCost: 0,
      driveCost: 6,
    });
    expect(fin.revenue).toBe(0);
    expect(fin.gross_margin_pct).toBeNull();
    expect(fin.revenue_per_man_hour).toBeNull();
    // A free visit still carries its drive cost → negative profit, which is true.
    expect(fin.gross_profit).toBe(-6);
  });

  test('a free callback with labor logged still reports null margin but real RPMH=0 guard', () => {
    const fin = computeServiceRecordFinancials({
      revenue: 0,
      laborHours: 0.4,
      laborCost: 14,
      productsCost: 0,
      driveCost: 6,
    });
    expect(fin.gross_margin_pct).toBeNull();
    // revenue is 0 so rpmh is 0/hours = 0, a real (if unflattering) number.
    expect(fin.revenue_per_man_hour).toBe(0);
  });

  test('rounds to cents', () => {
    const fin = computeServiceRecordFinancials({
      revenue: 100,
      laborHours: 0.333,
      laborCost: 11.655,
      productsCost: 3.337,
      driveCost: 6,
    });
    expect(fin.labor_cost).toBe(11.66);
    expect(fin.material_cost).toBe(3.34);
    expect(fin.total_job_cost).toBe(21);
  });
});

describe('calculateJobCost — durable backfill labor guard (Codex P1)', () => {
  // The completion route passes { untrustedLifecycleSpan, explicitLaborMinutes }
  // for its own calc, but admin-job-costs recalc, admin-job-expenses CRUD,
  // admin-billing-recovery recompute, admin-projects costing, and the
  // financials backfill all call calculateJobCost with NO opts. The guard must
  // therefore re-derive itself from the record's persisted
  // structured_notes.backfill marker, or any later recalc overwrites the
  // financials with the fabricated stale span.

  // A stale on_site closeout: checked in 2026-06-20, closed out from the
  // office 29 days later. Span = 41,880 min = 698 h → $24,430 at $35/hr.
  const STALE_SVC = {
    id: 'svc-1',
    customer_id: 'cust-1',
    technician_id: 'tech-1',
    service_type: 'Quarterly Pest Control Service',
    scheduled_date: '2026-06-20',
    status: 'completed',
    estimated_price: 129,
    actual_start_time: '2026-06-20T14:00:00Z',
    actual_end_time: '2026-07-19T16:00:00Z',
    service_time_minutes: null,
  };
  // A normal same-day visit: 90 real minutes on site.
  const NORMAL_SVC = {
    ...STALE_SVC,
    actual_start_time: '2026-06-20T14:00:00Z',
    actual_end_time: '2026-06-20T15:30:00Z',
  };
  const BACKFILLED_RECORD = {
    id: 'rec-1',
    status: 'completed',
    structured_notes: { backfill: true, visitOutcome: 'completed' },
  };
  const NORMAL_RECORD = {
    id: 'rec-1',
    status: 'completed',
    structured_notes: { visitOutcome: 'completed' },
  };

  // Minimal chainable knex fake covering exactly the queries calculateJobCost
  // issues (FK record resolution — srCols advertises scheduled_service_id — so
  // the legacy soft-join/count path never runs). time_entries queries are told
  // apart by their where shape: { job_id } = direct job entries, { technician_id }
  // = the clock-in-window fallback, whose use is tracked so tests can pin that
  // an untrusted span never even consults it.
  function fakeCostingDb({ svc, record, jobEntries = [], windowEntries = [] } = {}) {
    const SR_COLS = {
      scheduled_service_id: {},
      status: {},
      revenue: {},
      material_cost: {},
      labor_hours: {},
      labor_cost: {},
      drive_cost: {},
      total_job_cost: {},
      gross_profit: {},
      gross_margin_pct: {},
      revenue_per_man_hour: {},
    };
    const writes = { jobCosts: [], serviceRecordUpdates: [], windowQueried: false };
    const db = (table) => {
      const wheres = [];
      const chain = {
        where: (...args) => { wheres.push(args[0]); return chain; },
        whereNot: () => chain,
        whereBetween: () => chain,
        leftJoin: () => chain,
        orderBy: () => chain,
        columnInfo: () => Promise.resolve(SR_COLS),
        select: () => {
          if (table === 'time_entries') {
            if (wheres[0] && wheres[0].job_id) return Promise.resolve(jobEntries);
            writes.windowQueried = true;
            return Promise.resolve(windowEntries);
          }
          return Promise.resolve([]);
        },
        first: () => {
          if (table === 'scheduled_services') return Promise.resolve(svc);
          if (table === 'service_records') return Promise.resolve(record);
          return Promise.resolve(null); // customers / dispositions / financials / job_costs
        },
        insert: (row) => { writes.jobCosts.push(row); return Promise.resolve([1]); },
        update: (upd) => { writes.serviceRecordUpdates.push(upd); return Promise.resolve(1); },
      };
      return chain;
    };
    db.writes = writes;
    return db;
  }

  test('a bare recalc (no opts) on a backfilled record yields $0 labor — never the weeks-long span, never the clock window', async () => {
    const db = fakeCostingDb({ svc: STALE_SVC, record: BACKFILLED_RECORD });
    const res = await calculateJobCost('svc-1', db);
    expect(res.labor_cost).toBe(0);
    expect(res.laborHours).toBe(0);
    expect(db.writes.windowQueried).toBe(false);
    expect(res.revenue).toBe(129);
    // The recalc DOES overwrite the record's financials — which is exactly why
    // the marker must be durable, not a caller option.
    expect(res.serviceRecordId).toBe('rec-1');
    expect(db.writes.serviceRecordUpdates[0].labor_cost).toBe(0);
    expect(db.writes.jobCosts[0].labor_cost).toBe(0);
  });

  test('the marker is honored as serialized-string jsonb too', async () => {
    const record = { ...BACKFILLED_RECORD, structured_notes: JSON.stringify(BACKFILLED_RECORD.structured_notes) };
    const db = fakeCostingDb({ svc: STALE_SVC, record });
    const res = await calculateJobCost('svc-1', db);
    expect(res.labor_cost).toBe(0);
    expect(db.writes.windowQueried).toBe(false);
  });

  test('persisted service_time_minutes (the explicit timeOnSite the closeout stored) is the labor source on recalc', async () => {
    const db = fakeCostingDb({
      svc: { ...STALE_SVC, service_time_minutes: 45 },
      record: BACKFILLED_RECORD,
    });
    const res = await calculateJobCost('svc-1', db);
    expect(res.laborHours).toBe(0.75);
    expect(res.labor_cost).toBe(26.25); // 45 min at $35/hr — not 698 h
  });

  test('direct job time entries beat the persisted duration under backfill', async () => {
    const db = fakeCostingDb({
      svc: { ...STALE_SVC, service_time_minutes: 45 },
      record: BACKFILLED_RECORD,
      jobEntries: [{ duration_minutes: 50 }],
    });
    const res = await calculateJobCost('svc-1', db);
    expect(res.labor_cost).toBe(29.17); // 50 min at $35/hr
  });

  test('caller-supplied explicit minutes win over the persisted column (completion-time call)', async () => {
    const db = fakeCostingDb({
      svc: { ...STALE_SVC, service_time_minutes: 45 },
      record: BACKFILLED_RECORD,
    });
    const res = await calculateJobCost('svc-1', db, {
      untrustedLifecycleSpan: true, explicitLaborMinutes: 30,
    });
    expect(res.labor_cost).toBe(17.5);
  });

  test('the caller option still works alone — a pre-persist calc with no marker on the record', async () => {
    const db = fakeCostingDb({ svc: STALE_SVC, record: NORMAL_RECORD });
    const res = await calculateJobCost('svc-1', db, {
      untrustedLifecycleSpan: true, explicitLaborMinutes: 45,
    });
    expect(res.labor_cost).toBe(26.25);
    expect(db.writes.windowQueried).toBe(false);
  });

  test('hazard control: without the marker the same recalc books the whole stale span', async () => {
    // This is the exact overwrite the durable marker exists to prevent.
    const db = fakeCostingDb({ svc: STALE_SVC, record: NORMAL_RECORD });
    const res = await calculateJobCost('svc-1', db);
    expect(res.laborHours).toBe(698);
    expect(res.labor_cost).toBe(24430);
  });

  test('a normal record still uses the span fallback (live behavior unchanged)', async () => {
    const db = fakeCostingDb({ svc: NORMAL_SVC, record: NORMAL_RECORD });
    const res = await calculateJobCost('svc-1', db);
    expect(res.laborHours).toBe(1.5);
    expect(res.labor_cost).toBe(52.5);
  });

  test('only boolean true triggers — a string "true" marker never flips the policy', async () => {
    const record = { ...NORMAL_RECORD, structured_notes: { backfill: 'true' } };
    const db = fakeCostingDb({ svc: NORMAL_SVC, record });
    const res = await calculateJobCost('svc-1', db);
    expect(res.labor_cost).toBe(52.5);
  });

  test('garbage structured_notes never crash the calc — normal path applies', async () => {
    const record = { ...NORMAL_RECORD, structured_notes: 'not json{' };
    const db = fakeCostingDb({ svc: NORMAL_SVC, record });
    const res = await calculateJobCost('svc-1', db);
    expect(res.labor_cost).toBe(52.5);
  });
});
