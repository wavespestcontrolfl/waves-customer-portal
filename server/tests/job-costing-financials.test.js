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
