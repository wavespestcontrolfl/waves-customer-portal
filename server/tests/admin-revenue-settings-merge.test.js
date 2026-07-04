const { buildSettingsRow } = require('../routes/admin-revenue');

// Regression: the old PUT /api/admin/revenue/settings inserted a FRESH row
// with only the four fields it knew about — every other company_financials
// column (pricing inputs + ovh_* operating costs) silently reset to table
// defaults on any save. buildSettingsRow must carry the latest row forward
// and overlay only what the request explicitly sent.
describe('buildSettingsRow (revenue settings merge)', () => {
  const LATEST = {
    id: 'row-1',
    effective_date: '2026-07-01',
    loaded_labor_rate: '35.00',
    drive_cost_per_stop: '6.00',
    drive_cost_per_mile: '0.67',
    admin_cost_per_customer_year: '51.00',
    vehicle_cost_per_month: '850.00',
    insurance_cost_per_month: '400.00',
    software_cost_per_month: '350.00',
    target_gross_margin_pct: '55.00',
    target_rpmh: '120.00',
    ovh_office_payroll: '2000.00',
    ovh_rent: null,
    overhead_entered_at: '2026-07-01T05:00:00Z',
    notes: 'keep me',
    created_at: '2026-01-01T00:00:00Z',
  };

  test('carries every unlisted column forward — a labor-rate save no longer wipes the others', () => {
    const { row, error } = buildSettingsRow(LATEST, { loadedLaborRate: 38 }, '2026-07-04');
    expect(error).toBeUndefined();
    expect(row.loaded_labor_rate).toBe(38);
    // The bug: these came back as table defaults before.
    expect(row.vehicle_cost_per_month).toBe('850.00');
    expect(row.insurance_cost_per_month).toBe('400.00');
    expect(row.software_cost_per_month).toBe('350.00');
    expect(row.admin_cost_per_customer_year).toBe('51.00');
    expect(row.drive_cost_per_mile).toBe('0.67');
    expect(row.ovh_office_payroll).toBe('2000.00');
    expect(row.notes).toBe('keep me');
    // Row identity/bookkeeping never carries into the new effective-dated row.
    expect(row.id).toBeUndefined();
    expect(row.created_at).toBeUndefined();
    expect(row.effective_date).toBe('2026-07-04');
  });

  test('overhead saves overlay only the sent keys and stamp overhead_entered_at', () => {
    const now = new Date('2026-07-04T07:00:00Z');
    const { row } = buildSettingsRow(LATEST, { ovhRent: 1200, ovhSoftware: 0 }, '2026-07-04', now);
    expect(row.ovh_rent).toBe(1200);
    expect(row.ovh_software).toBe(0); // 0 is a valid deliberate figure
    expect(row.ovh_office_payroll).toBe('2000.00'); // untouched key carried
    expect(row.overhead_entered_at).toBe(now);
  });

  test('pricing-only saves do NOT bump overhead_entered_at', () => {
    const { row } = buildSettingsRow(LATEST, { targetRpmh: 130 }, '2026-07-04');
    expect(row.overhead_entered_at).toBe(LATEST.overhead_entered_at);
  });

  test('null clears an overhead figure; garbage rejects instead of coercing', () => {
    const { row } = buildSettingsRow(LATEST, { ovhOfficePayroll: null }, '2026-07-04');
    expect(row.ovh_office_payroll).toBeNull();
    expect(buildSettingsRow(LATEST, { ovhRent: 'abc' }, '2026-07-04').error).toMatch(/ovhRent/);
    expect(buildSettingsRow(LATEST, { ovhRent: -5 }, '2026-07-04').error).toMatch(/ovhRent/);
    expect(buildSettingsRow(LATEST, { loadedLaborRate: -1 }, '2026-07-04').error).toMatch(/loadedLaborRate/);
  });

  test('first-ever save (no latest row) still works', () => {
    const { row } = buildSettingsRow(null, { loadedLaborRate: 35 }, '2026-07-04');
    expect(row.loaded_labor_rate).toBe(35);
    expect(row.effective_date).toBe('2026-07-04');
  });
});
