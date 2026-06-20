const { deriveRevenue, computeServiceRecordFinancials } = require('../services/job-costing');

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
