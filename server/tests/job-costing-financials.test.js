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
  calcProductsCost,
  backfillServiceRecordFinancials,
} = require('../services/job-costing');

describe('deriveRevenue — mirrors the completion handler invoiceAmount', () => {
  test('keepRecordedRevenue keeps a written $0 even when the visit now carries a price', () => {
    expect(deriveRevenue({
      serviceRecord: { revenue: 0 },
      scheduledService: { estimated_price: 149, is_callback: false },
      customer: { monthly_rate: 99 },
      keepRecordedRevenue: true,
    })).toBe(0);
    // Without the mode, the positive-only short-circuit re-derives the $0.
    expect(deriveRevenue({
      serviceRecord: { revenue: 0 },
      scheduledService: { estimated_price: 149, is_callback: false },
      customer: { monthly_rate: 99 },
    })).toBe(149);
  });

  test('keepRecordedRevenue still derives when nothing was ever written', () => {
    expect(deriveRevenue({
      serviceRecord: { revenue: null },
      scheduledService: { estimated_price: 149, is_callback: false },
      customer: { monthly_rate: 99 },
      keepRecordedRevenue: true,
    })).toBe(149);
  });

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

  test('an unpriced consultation (Waves Assessment) books $0, never monthly_rate; a priced one books its price', () => {
    expect(deriveRevenue({
      serviceRecord: {},
      scheduledService: { estimated_price: null, is_callback: false, service_type: 'Waves Assessment' },
      customer: { monthly_rate: 47 },
    })).toBe(0);
    expect(deriveRevenue({
      serviceRecord: {},
      scheduledService: { estimated_price: 75, is_callback: false, service_type: 'Waves Assessment' },
      customer: { monthly_rate: 47 },
    })).toBe(75);
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

  // GATE_STAMPED_ZERO_FREE (owner ruling 2026-09-28): a STAMPED 0 (as
  // opposed to the genuinely blank estimated_price the test above and
  // "non-callback with no visit price" above cover) records $0 revenue, not
  // the customer's monthly_rate. Off is byte-identical to today.
  describe('a stamped $0 visit — GATE_STAMPED_ZERO_FREE', () => {
    afterEach(() => { delete process.env.GATE_STAMPED_ZERO_FREE; });

    test('off: a bare stamped 0 still records monthly_rate as revenue, same as today', () => {
      const rev = deriveRevenue({
        serviceRecord: {},
        scheduledService: { estimated_price: 0, is_callback: false },
        customer: { monthly_rate: 99 },
      });
      expect(rev).toBe(99);
    });

    test('on: a bare stamped 0 records $0 revenue, never the monthly_rate', () => {
      process.env.GATE_STAMPED_ZERO_FREE = 'true';
      const rev = deriveRevenue({
        serviceRecord: {},
        scheduledService: { estimated_price: 0, is_callback: false },
        customer: { monthly_rate: 99 },
      });
      expect(rev).toBe(0);
    });

    test('on: a genuinely blank (never-priced) row is unaffected — still records monthly_rate', () => {
      process.env.GATE_STAMPED_ZERO_FREE = 'true';
      const rev = deriveRevenue({
        serviceRecord: {},
        scheduledService: { estimated_price: null, is_callback: false },
        customer: { monthly_rate: 99 },
      });
      expect(rev).toBe(99);
    });

    test('on: a callback stamped $0 is unaffected ($0 revenue either way)', () => {
      process.env.GATE_STAMPED_ZERO_FREE = 'true';
      const rev = deriveRevenue({
        serviceRecord: {},
        scheduledService: { estimated_price: 0, is_callback: true },
        customer: { monthly_rate: 99 },
      });
      expect(rev).toBe(0);
    });

    test('on: a POSITIVE price always wins, gate or not', () => {
      process.env.GATE_STAMPED_ZERO_FREE = 'true';
      const rev = deriveRevenue({
        serviceRecord: {},
        scheduledService: { estimated_price: 60, is_callback: false },
        customer: { monthly_rate: 99 },
      });
      expect(rev).toBe(60);
    });
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
  // Applies a getFinancials query to in-memory rows: `effective_date <= x`
  // filters, then the orderBy spec sorts (strings compare as dates, ISO form).
  function pickFinancialRow(rows, whereArgs, orderSpec) {
    let list = rows.slice();
    for (const [col, op, val] of whereArgs) {
      if (op === '<=') list = list.filter((r) => r[col] <= val);
    }
    list.sort((a, b) => {
      for (const { column, order } of orderSpec) {
        if (a[column] === b[column]) continue;
        const cmp = a[column] < b[column] ? -1 : 1;
        return order === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
    return list[0] || null;
  }

  function fakeCostingDb({
    svc,
    record,
    jobEntries = [],
    windowEntries = [],
    financials = null,
    // Several effective-dated rows: the fake then honors the where/orderBy that
    // getFinancials sends. Without it, `financials` is returned for any query.
    financialRows = null,
    existingJobCost = null,
    transactionHook = null,
  } = {}) {
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
    let currentRecord = record;
    let currentJobCost = existingJobCost;
    const writes = {
      jobCosts: [],
      jobCostUpdates: [],
      serviceRecordUpdates: [],
      plucks: [],
      windowQueried: false,
      financialQueries: [],
      get currentJobCost() { return currentJobCost; },
    };
    const db = (table) => {
      const wheres = [];
      const whereArgs = [];
      let orderSpec = [];
      const chain = {
        where: (...args) => { wheres.push(args[0]); whereArgs.push(args); return chain; },
        whereNot: () => chain,
        whereNotNull: () => chain,
        distinct: () => chain,
        // The backfill's id lists: this visit, from either source.
        pluck: () => {
          writes.plucks.push({ table, wheres: whereArgs });
          return Promise.resolve([svc.id]);
        },
        whereBetween: () => chain,
        leftJoin: () => chain,
        orderBy: (spec, dir) => {
          orderSpec = Array.isArray(spec) ? spec : [{ column: spec, order: dir || 'asc' }];
          return chain;
        },
        limit: () => Promise.resolve(currentRecord ? [currentRecord] : []),
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
          if (table === 'service_records') return Promise.resolve(currentRecord);
          if (table === 'company_financials') {
            if (!financialRows) return Promise.resolve(financials);
            writes.financialQueries.push({ wheres: whereArgs, orderSpec });
            return Promise.resolve(pickFinancialRow(financialRows, whereArgs, orderSpec));
          }
          if (table === 'job_costs') return Promise.resolve(currentJobCost);
          return Promise.resolve(null); // customers / dispositions
        },
        insert: (row) => {
          if (table === 'job_costs') {
            currentJobCost = { id: currentJobCost?.id || 'cost-1', ...row };
            writes.jobCosts.push(row);
          }
          return Promise.resolve([1]);
        },
        update: (upd) => {
          if (table === 'job_costs') {
            currentJobCost = { ...currentJobCost, ...upd };
            writes.jobCostUpdates.push(upd);
          } else if (table === 'service_records') {
            Object.assign(currentRecord, upd);
            writes.serviceRecordUpdates.push(upd);
          }
          return Promise.resolve(1);
        },
        forUpdate: () => chain,
      };
      return chain;
    };
    // The stamp fence wraps the financial writes in a transaction holding
    // the scheduled_services row lock (codex P2 #3152 round 9) — the fake
    // hands the same handle back as the trx.
    let transactionCount = 0;
    db.transaction = async (fn) => {
      transactionCount += 1;
      if (transactionHook) await transactionHook(transactionCount);
      return fn(db);
    };
    db.setRecord = (nextRecord) => { currentRecord = nextRecord; };
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
    expect(res.drive_cost).toBe(6);
  });

  test.each([
    ['zero', 0],
    ['unknown', null],
  ])('a grouped %s allocation blocks linked timers and the shared lifecycle span', async (_label, allocatedMinutes) => {
    const record = {
      ...NORMAL_RECORD,
      structured_notes: { visitDurationAllocation: { version: 1, allocatedMinutes } },
    };
    const db = fakeCostingDb({
      svc: NORMAL_SVC,
      record,
      jobEntries: [{ duration_minutes: 90 }],
      windowEntries: [{ duration_minutes: 90 }],
    });
    const res = await calculateJobCost('svc-1', db);
    expect(res.laborHours).toBe(0);
    expect(res.labor_cost).toBe(0);
    expect(db.writes.windowQueried).toBe(false);
  });

  test('a later authorized duration correction supersedes the frozen grouped allocation', async () => {
    const record = {
      ...NORMAL_RECORD,
      structured_notes: {
        visitDurationAllocation: { version: 1, allocatedMinutes: 20 },
        timeOnSiteAdjusted: true,
      },
    };
    const db = fakeCostingDb({
      svc: { ...NORMAL_SVC, service_time_minutes: 45, time_on_site_adjusted_minutes: 45 },
      record,
      jobEntries: [{ duration_minutes: 90 }],
    });
    const res = await calculateJobCost('svc-1', db);
    expect(res.laborHours).toBe(0.75);
    expect(res.labor_cost).toBe(26.25);
  });

  test('the marked drive owner gets exactly one configured stop cost in the record and ledger', async () => {
    const record = {
      ...NORMAL_RECORD,
      structured_notes: {
        visitDriveCostAllocation: { version: 1, packetId: 'packet-1', ownerServiceId: 'svc-1' },
      },
    };
    const db = fakeCostingDb({
      svc: NORMAL_SVC,
      record,
      financials: { loaded_labor_rate: 35, drive_cost_per_stop: 8.75 },
    });

    const res = await calculateJobCost('svc-1', db);

    expect(res.drive_cost).toBe(8.75);
    expect(res.total_cost).toBe(61.25);
    expect(db.writes.currentJobCost).toMatchObject({ drive_cost: 8.75, total_cost: 61.25 });
    expect(db.writes.serviceRecordUpdates[0]).toMatchObject({
      drive_cost: 8.75,
      total_job_cost: 61.25,
    });
  });

  test('a marked non-owner replaces legacy drive cost with zero in both stores and stays zero on rerun', async () => {
    const record = {
      ...NORMAL_RECORD,
      drive_cost: 8.75,
      total_job_cost: 61.25,
      structured_notes: {
        visitDriveCostAllocation: { version: 1, packetId: 'packet-1', ownerServiceId: 'svc-owner' },
      },
    };
    const db = fakeCostingDb({
      svc: NORMAL_SVC,
      record,
      financials: { loaded_labor_rate: 35, drive_cost_per_stop: 8.75 },
      existingJobCost: { id: 'cost-1', drive_cost: 8.75, total_cost: 61.25 },
    });

    const first = await calculateJobCost('svc-1', db);
    const second = await calculateJobCost('svc-1', db);

    expect(first.drive_cost).toBe(0);
    expect(first.total_cost).toBe(52.5);
    expect(second.drive_cost).toBe(0);
    expect(second.total_cost).toBe(52.5);
    expect(db.writes.jobCosts).toHaveLength(0);
    expect(db.writes.jobCostUpdates).toHaveLength(2);
    expect(db.writes.currentJobCost).toMatchObject({ drive_cost: 0, total_cost: 52.5 });
    expect(db.writes.serviceRecordUpdates).toHaveLength(2);
    expect(db.writes.serviceRecordUpdates[1]).toMatchObject({
      drive_cost: 0,
      total_job_cost: 52.5,
    });
  });

  test.each([
    { label: 'reportless', initialRecord: null },
    { label: 'retained legacy record', initialRecord: NORMAL_RECORD },
  ])('a stale $label calculation cannot overwrite a packet non-owner after resuming last', async ({ initialRecord }) => {
    let signalStaleAtFence;
    let releaseStale;
    const staleAtFence = new Promise((resolve) => { signalStaleAtFence = resolve; });
    const staleCanResume = new Promise((resolve) => { releaseStale = resolve; });
    const db = fakeCostingDb({
      svc: NORMAL_SVC,
      record: initialRecord,
      financials: { loaded_labor_rate: 35, drive_cost_per_stop: 6 },
      transactionHook: async (transactionNumber) => {
        if (transactionNumber !== 1) return;
        signalStaleAtFence();
        await staleCanResume;
      },
    });

    const staleCalculation = calculateJobCost('svc-1', db);
    await staleAtFence;
    db.setRecord({
      ...NORMAL_RECORD,
      structured_notes: {
        visitDriveCostAllocation: { version: 1, packetId: 'packet-1', ownerServiceId: 'svc-owner' },
      },
    });

    let current;
    try {
      current = await calculateJobCost('svc-1', db);
    } finally {
      releaseStale();
    }
    const stale = await staleCalculation;

    expect(current.drive_cost).toBe(0);
    expect(current.total_cost).toBe(52.5);
    expect(stale.staleSkipped).toBe(true);
    expect(db.writes.jobCosts).toHaveLength(1);
    expect(db.writes.jobCostUpdates).toHaveLength(0);
    expect(db.writes.currentJobCost).toMatchObject({ drive_cost: 0, total_cost: 52.5 });
    expect(db.writes.serviceRecordUpdates).toHaveLength(1);
    expect(db.writes.serviceRecordUpdates[0]).toMatchObject({
      drive_cost: 0,
      total_job_cost: 52.5,
    });
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

  describe('scheduled estimate — a completed visit nothing measured', () => {
    test('a backfilled close with no typed time books its scheduled estimate, never the stale span', async () => {
      const db = fakeCostingDb({ svc: { ...STALE_SVC, estimated_duration_minutes: 45 }, record: BACKFILLED_RECORD });
      const res = await calculateJobCost('svc-1', db);
      expect(res.laborHours).toBe(0.75);
      expect(res.labor_cost).toBe(26.25); // 45 min at $35/hr — not 0, not 698 h
      expect(db.writes.windowQueried).toBe(false);
      expect(db.writes.serviceRecordUpdates[0].labor_hours).toBe(0.75);
    });

    test('typed time on site and job time entries both outrank the estimate', async () => {
      const typed = fakeCostingDb({
        svc: { ...STALE_SVC, service_time_minutes: 30, estimated_duration_minutes: 45 },
        record: BACKFILLED_RECORD,
      });
      expect((await calculateJobCost('svc-1', typed)).laborHours).toBe(0.5);
      const clocked = fakeCostingDb({
        svc: { ...STALE_SVC, estimated_duration_minutes: 45 },
        record: BACKFILLED_RECORD,
        jobEntries: [{ duration_minutes: 50 }],
      });
      expect((await calculateJobCost('svc-1', clocked)).labor_cost).toBe(29.17);
    });

    test('a measured same-day span outranks the estimate (live behavior unchanged)', async () => {
      const db = fakeCostingDb({ svc: { ...NORMAL_SVC, estimated_duration_minutes: 45 }, record: NORMAL_RECORD });
      expect((await calculateJobCost('svc-1', db)).laborHours).toBe(1.5);
    });

    test('a completed close with no start stamp books the estimate', async () => {
      const db = fakeCostingDb({
        svc: { ...NORMAL_SVC, actual_start_time: null, estimated_duration_minutes: 60 },
        record: NORMAL_RECORD,
      });
      const res = await calculateJobCost('svc-1', db);
      expect(res.laborHours).toBe(1);
      expect(res.labor_cost).toBe(35);
    });

    test('a visit that is not completed never books an estimate', async () => {
      const db = fakeCostingDb({
        svc: {
          ...NORMAL_SVC, status: 'confirmed', actual_start_time: null, actual_end_time: null, estimated_duration_minutes: 60,
        },
        record: NORMAL_RECORD,
      });
      const res = await calculateJobCost('svc-1', db);
      expect(res.laborHours).toBe(0);
      expect(res.labor_cost).toBe(0);
    });

    test.each([
      ['zero', 0],
      ['unknown', null],
    ])('a grouped %s allocation is never replaced by the estimate', async (_label, allocatedMinutes) => {
      const record = {
        ...NORMAL_RECORD,
        structured_notes: { visitDurationAllocation: { version: 1, allocatedMinutes } },
      };
      const db = fakeCostingDb({ svc: { ...NORMAL_SVC, estimated_duration_minutes: 60 }, record });
      expect((await calculateJobCost('svc-1', db)).laborHours).toBe(0);
    });
  });

  test.each([
    ['a positive', 120],
    ['a $0', 0],
  ])('a dated costing re-run keeps %s written revenue and asks only for visits since the date', async (_label, written) => {
    const db = fakeCostingDb({ svc: NORMAL_SVC, record: { ...NORMAL_RECORD, revenue: written } });
    const res = await backfillServiceRecordFinancials(db, { since: '2026-04-01', keepRecordedRevenue: true });
    expect(res).toEqual({ processed: 1, updated: 1, skipped: 0 });
    expect(db.writes.serviceRecordUpdates[0].revenue).toBe(written); // never re-derived to the $129 visit price
    expect(db.writes.plucks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'scheduled_services',
        wheres: expect.arrayContaining([['scheduled_date', '>=', '2026-04-01']]),
      }),
      expect.objectContaining({
        table: 'service_records',
        wheres: expect.arrayContaining([['service_date', '>=', '2026-04-01']]),
      }),
    ]));
  });

  describe('cost settings in effect on the visit date', () => {
    const ROWS = [
      { id: 'fin-a', effective_date: '2026-01-01', created_at: '2026-01-01T05:00:00Z', loaded_labor_rate: '35.00', drive_cost_per_stop: '6.00' },
      { id: 'fin-b', effective_date: '2026-11-01', created_at: '2026-11-01T15:00:00Z', loaded_labor_rate: '30.00', drive_cost_per_stop: '12.00' },
    ];

    test.each([
      { label: 'before the new row', date: '2026-10-31', labor: 52.5, drive: 6 },
      { label: 'on the new row date', date: '2026-11-01', labor: 45, drive: 12 },
      { label: 'before every row (oldest row)', date: '2025-12-15', labor: 52.5, drive: 6 },
    ])('a visit $label ($date) is costed at the row in effect that day', async ({ date, labor, drive }) => {
      const db = fakeCostingDb({
        svc: { ...NORMAL_SVC, scheduled_date: date },
        record: NORMAL_RECORD,
        financialRows: ROWS,
      });
      const res = await calculateJobCost('svc-1', db);
      expect(res.labor_cost).toBe(labor); // 90 on-site minutes
      expect(res.drive_cost).toBe(drive);
      expect(db.writes.currentJobCost).toMatchObject({ labor_cost: labor, drive_cost: drive });
      expect(db.writes.serviceRecordUpdates[0]).toMatchObject({ labor_cost: labor, drive_cost: drive });
    });

    test('a node-postgres local-midnight Date reads the same row as the string', async () => {
      const asDate = fakeCostingDb({
        svc: { ...NORMAL_SVC, scheduled_date: new Date(2026, 9, 31) },
        record: NORMAL_RECORD,
        financialRows: ROWS,
      });
      const asString = fakeCostingDb({
        svc: { ...NORMAL_SVC, scheduled_date: '2026-10-31' },
        record: NORMAL_RECORD,
        financialRows: ROWS,
      });
      const fromDate = await calculateJobCost('svc-1', asDate);
      const fromString = await calculateJobCost('svc-1', asString);
      expect(fromDate.labor_cost).toBe(52.5);
      expect(fromString.labor_cost).toBe(52.5);
      expect(asDate.writes.financialQueries[0].wheres).toEqual([['effective_date', '<=', '2026-10-31']]);
    });
  });

});

describe('calcProductsCost — an application amount is priced per unit, never per package', () => {
  // Chainable fake for exactly calcProductsCost's queries: the usage movements,
  // the application rows, and the catalog row. vendor_pricing must never be
  // read (the catalog's best_price already ranks the vendor rows).
  function fakeProductsDb({ movements = [], applications = [], products = {} } = {}) {
    return (table) => {
      let productId = null;
      const chain = {
        leftJoin: () => chain,
        where: (arg) => {
          if (arg && typeof arg === 'object') productId = arg.id || arg.product_id || productId;
          return chain;
        },
        whereNull: () => chain,
        orderBy: () => chain,
        select: () => Promise.resolve(table.startsWith('product_inventory_movements') ? movements : applications),
        first: () => {
          if (table === 'vendor_pricing') throw new Error('vendor_pricing read');
          // The record's notes come from the caller: a second read inside calcProductsCost lengthens a job that outlives its
          // request and, in the Postgres suites, reaches into the next test's transaction.
          if (table === 'service_records') throw new Error('calcProductsCost must not re-read the service record');
          if (table === 'products_catalog') return Promise.resolve(products[productId] || null);
          return Promise.resolve(null);
        },
      };
      return chain;
    };
  }
  // A 2.5-gal (320 fl oz) jug at $38.95.
  const JUG = { inventory_unit: 'fl_oz', unit_size_oz: 320, best_price: 38.95, cost_per_unit: null };

  test('a liquid amount costs its share of one best_price package', async () => {
    const db = fakeProductsDb({
      applications: [{ product_id: 'p-jug', quantity_applied: 31.5, quantity_unit: 'fl_oz' }],
      products: { 'p-jug': JUG },
    });
    const { productsCost, breakdown } = await calcProductsCost(db, 'rec-1');
    expect(productsCost).toBe(3.83); // the old fallback booked 31.5 × the jug price
    expect(breakdown).toEqual([
      expect.objectContaining({ product_id: 'p-jug', qty: 31.5, unit: 'fl_oz', line: 3.83 }),
    ]);
  });

  test('a granular amount in lb is converted to ounces of the bag', async () => {
    const db = fakeProductsDb({
      applications: [{ product_id: 'p-bag', quantity_applied: 16.968, quantity_unit: 'lb' }],
      products: { 'p-bag': { inventory_unit: 'lb', unit_size_oz: 800, best_price: 44.23, cost_per_unit: null } },
    });
    expect((await calcProductsCost(db, 'rec-1')).productsCost).toBe(15.01); // 50-lb bag at $44.23
  });

  test('cost_per_unit is applied in its own unit', async () => {
    const db = fakeProductsDb({
      applications: [{ product_id: 'p-unit', quantity_applied: 9.25, quantity_unit: 'fl_oz' }],
      products: { 'p-unit': { inventory_unit: 'fl_oz', cost_per_unit: 0.2835, cost_unit: 'fl_oz', unit_size_oz: 320, best_price: 89.31 } },
    });
    expect((await calcProductsCost(db, 'rec-1')).productsCost).toBe(2.62);
  });

  test.each([
    ['a product with no catalog price', { quantity_applied: 6, quantity_unit: 'fl_oz' }, { inventory_unit: 'fl_oz', unit_size_oz: null, best_price: null, cost_per_unit: null }],
    ['an amount with no unit', { quantity_applied: 6, quantity_unit: null }, JUG],
    ['a count amount on a measured product', { quantity_applied: 2, quantity_unit: 'each' }, JUG],
  ])('%s stays uncosted instead of fabricated', async (_label, application, product) => {
    const db = fakeProductsDb({
      applications: [{ product_id: 'p-1', ...application }],
      products: { 'p-1': product },
    });
    const { productsCost, breakdown } = await calcProductsCost(db, 'rec-1');
    expect(productsCost).toBe(0);
    expect(breakdown).toEqual([]);
  });

  test.each([
    ['saved as an object', (notes) => notes],
    ['saved as text', (notes) => JSON.stringify(notes)],
  ])('a line the completion refused as an implausible amount is not priced from the ledger (%s)', async (_label, save) => {
    const db = fakeProductsDb({
      applications: [
        { product_id: 'p-jug', quantity_applied: 1000000, quantity_unit: 'fl_oz' },
        { product_id: 'p-bag', quantity_applied: 16.968, quantity_unit: 'lb' },
      ],
      products: { 'p-jug': JUG, 'p-bag': { inventory_unit: 'lb', unit_size_oz: 800, best_price: 44.23, cost_per_unit: null } },
    });
    const notes = save({ inventoryDeductions: [{ productId: 'p-jug', amount: 1000000, amountUnit: 'fl_oz', status: 'not_deducted_implausible' }, { productId: 'p-bag', amount: 16.968, amountUnit: 'lb', status: 'deducted' }] });
    const { productsCost, breakdown } = await calcProductsCost(db, 'rec-1', notes);
    expect(productsCost).toBe(15.01);
    expect(breakdown).toEqual([expect.objectContaining({ product_id: 'p-bag' })]);
  });

  describe('a refusal is bound to the amount it refused', () => {
    const refusedNotes = { inventoryDeductions: [{ productId: 'p-jug', amount: 1000000, amountUnit: 'fl_oz', status: 'not_deducted_implausible' }] };
    const cost = async (applied, notes = refusedNotes) => calcProductsCost(
      fakeProductsDb({ applications: [applied], products: { 'p-jug': JUG } }), 'rec-1', notes,
    );

    test('the same product, amount and unit stays excluded (also when the amount arrives as numeric text)', async () => {
      expect((await cost({ product_id: 'p-jug', quantity_applied: 1000000, quantity_unit: 'fl_oz' })).productsCost).toBe(0);
      expect((await cost({ product_id: 'p-jug', quantity_applied: '1000000.0000', quantity_unit: 'fl_oz' })).productsCost).toBe(0);
    });

    test('after a correction to a different amount, the corrected usage is costed', async () => {
      const { productsCost, breakdown } = await cost({ product_id: 'p-jug', quantity_applied: 31.5, quantity_unit: 'fl_oz' });
      expect(productsCost).toBe(3.83);
      expect(breakdown).toEqual([expect.objectContaining({ product_id: 'p-jug' })]);
    });

    test('the same number in a different unit is a different line and is costed', async () => {
      expect((await cost({ product_id: 'p-jug', quantity_applied: 1000000, quantity_unit: 'oz' })).productsCost).toBeGreaterThan(0);
    });
  });

  test('a product an inventory movement already costed is not costed again', async () => {
    const db = fakeProductsDb({
      movements: [{ product_id: 'p-jug', quantity: 31.5, unit: 'fl_oz', unit_cost: 0.1217, cost_used: 3.83 }],
      applications: [{ product_id: 'p-jug', quantity_applied: 31.5, quantity_unit: 'fl_oz' }],
      products: { 'p-jug': JUG },
    });
    const { productsCost, breakdown } = await calcProductsCost(db, 'rec-1');
    expect(productsCost).toBe(3.83);
    expect(breakdown).toHaveLength(1);
  });
});

describe('getFinancials — the company_financials row in effect on a date', () => {
  const { getFinancials } = require('../services/job-costing');

  const ROWS = [
    { id: 'fin-a', effective_date: '2026-01-01', created_at: '2026-01-01T05:00:00Z', loaded_labor_rate: '35.00', drive_cost_per_stop: '6.00' },
    { id: 'fin-b', effective_date: '2026-11-01', created_at: '2026-11-01T15:00:00Z', loaded_labor_rate: '30.00', drive_cost_per_stop: '12.00' },
  ];

  // Applies exactly what getFinancials sends: where(col, '<=', x), orderBy([...]).
  function fakeFinancialsDb(rows, { fail = false } = {}) {
    const queries = [];
    const db = (table) => {
      if (table !== 'company_financials') throw new Error(`unexpected table ${table}`);
      const q = { wheres: [], orderSpec: [] };
      queries.push(q);
      const chain = {
        where: (...args) => { q.wheres.push(args); return chain; },
        orderBy: (spec, dir) => {
          q.orderSpec = Array.isArray(spec) ? spec : [{ column: spec, order: dir || 'asc' }];
          return chain;
        },
        first: () => {
          if (fail) return Promise.reject(new Error('relation does not exist'));
          let list = rows.slice();
          for (const [col, op, val] of q.wheres) {
            if (op === '<=') list = list.filter((r) => r[col] <= val);
          }
          list.sort((a, b) => {
            for (const { column, order } of q.orderSpec) {
              if (a[column] === b[column]) continue;
              const cmp = a[column] < b[column] ? -1 : 1;
              return order === 'desc' ? -cmp : cmp;
            }
            return 0;
          });
          return Promise.resolve(list[0]);
        },
      };
      return chain;
    };
    db.queries = queries;
    return db;
  }

  test('reads the row with the greatest effective_date on or before the visit', async () => {
    const db = fakeFinancialsDb(ROWS);
    expect(await getFinancials(db, '2026-10-31')).toEqual({ laborRate: 35, driveCostPerStop: 6 });
    expect(await getFinancials(db, '2026-11-01')).toEqual({ laborRate: 30, driveCostPerStop: 12 });
    expect(await getFinancials(db, '2027-03-15')).toEqual({ laborRate: 30, driveCostPerStop: 12 });
  });

  test('a visit older than every row reads the oldest row', async () => {
    const db = fakeFinancialsDb(ROWS);
    expect(await getFinancials(db, '2025-12-15')).toEqual({ laborRate: 35, driveCostPerStop: 6 });
  });

  test('two rows on one effective_date: the newer created_at wins (and id breaks a created_at tie)', async () => {
    const sameDay = [
      { id: 'fin-1', effective_date: '2026-05-01', created_at: '2026-05-01T09:00:00Z', loaded_labor_rate: '31', drive_cost_per_stop: '7' },
      { id: 'fin-2', effective_date: '2026-05-01', created_at: '2026-05-01T17:00:00Z', loaded_labor_rate: '33', drive_cost_per_stop: '8' },
    ];
    expect(await getFinancials(fakeFinancialsDb(sameDay), '2026-05-02')).toEqual({ laborRate: 33, driveCostPerStop: 8 });
    // Visit older than both: oldest date, same tiebreak.
    expect(await getFinancials(fakeFinancialsDb(sameDay), '2026-04-01')).toEqual({ laborRate: 33, driveCostPerStop: 8 });
    const tied = [
      { id: 'fin-1', effective_date: '2026-05-01', created_at: '2026-05-01T09:00:00Z', loaded_labor_rate: '31', drive_cost_per_stop: '7' },
      { id: 'fin-9', effective_date: '2026-05-01', created_at: '2026-05-01T09:00:00Z', loaded_labor_rate: '34', drive_cost_per_stop: '9' },
    ];
    expect(await getFinancials(fakeFinancialsDb(tied), '2026-05-02')).toEqual({ laborRate: 34, driveCostPerStop: 9 });
  });

  test('no rows: the defaults', async () => {
    expect(await getFinancials(fakeFinancialsDb([]), '2026-10-31')).toEqual({ laborRate: 35, driveCostPerStop: 6 });
    expect(await getFinancials(fakeFinancialsDb([]))).toEqual({ laborRate: 35, driveCostPerStop: 6 });
  });

  test('a read error: the defaults', async () => {
    expect(await getFinancials(fakeFinancialsDb(ROWS, { fail: true }), '2026-10-31'))
      .toEqual({ laborRate: 35, driveCostPerStop: 6 });
  });

  test('a local-midnight Date and a string read the same row, in any process time zone', async () => {
    const db = fakeFinancialsDb(ROWS);
    // new Date(y, m, d) is what node-postgres builds for a DATE cell.
    expect(await getFinancials(db, new Date(2026, 9, 31))).toEqual({ laborRate: 35, driveCostPerStop: 6 });
    expect(await getFinancials(db, new Date(2026, 10, 1))).toEqual({ laborRate: 30, driveCostPerStop: 12 });
    expect(db.queries[0].wheres).toEqual([['effective_date', '<=', '2026-10-31']]);
    expect(db.queries[1].wheres).toEqual([['effective_date', '<=', '2026-11-01']]);
  });

  test.each([undefined, null, '', 'not-a-date', new Date('nope')])('missing or unparseable date %p: the newest row, no date filter', async (bad) => {
    const db = fakeFinancialsDb(ROWS);
    expect(await getFinancials(db, bad)).toEqual({ laborRate: 30, driveCostPerStop: 12 });
    expect(db.queries[0].wheres).toEqual([]);
  });
});
