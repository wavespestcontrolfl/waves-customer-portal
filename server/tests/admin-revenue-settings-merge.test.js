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

  test('owner office time saves overlay only the sent keys, carry forward, clear on null, and leave overhead_entered_at alone', () => {
    const withOwner = { ...LATEST, owner_office_hours_per_month: '10.00', owner_office_hourly_rate: '40.00' };
    const { row } = buildSettingsRow(withOwner, { ownerOfficeHoursPerMonth: 12.5 }, '2026-07-04');
    expect(row.owner_office_hours_per_month).toBe(12.5);
    expect(row.owner_office_hourly_rate).toBe('40.00'); // untouched key carried
    expect(row.overhead_entered_at).toBe(LATEST.overhead_entered_at);
    expect(buildSettingsRow(withOwner, { ownerOfficeHourlyRate: null }, '2026-07-04').row.owner_office_hourly_rate).toBeNull();
    expect(buildSettingsRow(withOwner, { ownerOfficeHoursPerMonth: '8' }, '2026-07-04').row.owner_office_hours_per_month).toBe(8);
    // An overhead save carries the owner figures forward too.
    expect(buildSettingsRow(withOwner, { ovhRent: 5 }, '2026-07-04').row.owner_office_hourly_rate).toBe('40.00');
    expect(buildSettingsRow(LATEST, { ownerOfficeHoursPerMonth: 'abc' }, '2026-07-04').error).toMatch(/ownerOfficeHoursPerMonth/);
    expect(buildSettingsRow(LATEST, { ownerOfficeHourlyRate: -1 }, '2026-07-04').error).toMatch(/ownerOfficeHourlyRate/);
  });

  test.each([
    ['a numeric prefix', 'ownerOfficeHoursPerMonth', '12oops'],
    ['an exponent', 'ownerOfficeHoursPerMonth', '1e2'],
    ['a third decimal', 'ownerOfficeHourlyRate', '21.295'],
    ['a float with a long tail', 'ownerOfficeHourlyRate', 0.1 + 0.2],
    ['a leading sign', 'ownerOfficeHoursPerMonth', '+8'],
    ['a negative number', 'ownerOfficeHourlyRate', -1],
    ['hours above numeric(6,2)', 'ownerOfficeHoursPerMonth', 10000],
    ['a rate above numeric(8,2)', 'ownerOfficeHourlyRate', 1000000],
    ['a huge number', 'ownerOfficeHourlyRate', 1e21],
    ['an empty string', 'ownerOfficeHoursPerMonth', ''],
    ['a boolean', 'ownerOfficeHoursPerMonth', true],
    ['an object', 'ownerOfficeHourlyRate', {}],
    ['NaN', 'ownerOfficeHoursPerMonth', NaN],
  ])('owner office time refuses %s (a 400 message, nothing coerced)', (_n, key, value) => {
    const { row, error } = buildSettingsRow(LATEST, { [key]: value }, '2026-07-04');
    expect(row).toBeUndefined();
    expect(error).toMatch(new RegExp(key));
  });

  test.each([
    ['the column maximums', { ownerOfficeHoursPerMonth: 9999.99, ownerOfficeHourlyRate: 999999.99 }, 9999.99, 999999.99],
    ['two decimals as strings, padded with spaces', { ownerOfficeHoursPerMonth: ' 12.5 ', ownerOfficeHourlyRate: '21.29' }, 12.5, 21.29],
    ['zero', { ownerOfficeHoursPerMonth: 0, ownerOfficeHourlyRate: '0.00' }, 0, 0],
  ])('owner office time accepts %s', (_n, body, hours, rate) => {
    const { row, error } = buildSettingsRow(LATEST, body, '2026-07-04');
    expect(error).toBeUndefined();
    expect(row.owner_office_hours_per_month).toBe(hours);
    expect(row.owner_office_hourly_rate).toBe(rate);
  });

  test('first-ever save (no latest row) still works', () => {
    const { row } = buildSettingsRow(null, { loadedLaborRate: 35 }, '2026-07-04');
    expect(row.loaded_labor_rate).toBe(35);
    expect(row.effective_date).toBe('2026-07-04');
  });

  test('vehicle deduction election: allow-listed values + null, stamps set_at', () => {
    const now = new Date('2026-07-21T12:00:00Z');
    const a = buildSettingsRow(LATEST, { vehicleDeductionMethod: 'standard_mileage' }, '2026-07-21', now);
    expect(a.error).toBeUndefined();
    expect(a.row.vehicle_deduction_method).toBe('standard_mileage');
    expect(a.row.vehicle_deduction_method_set_at).toBe(now);

    const b = buildSettingsRow(LATEST, { vehicleDeductionMethod: null }, '2026-07-21', now);
    expect(b.row.vehicle_deduction_method).toBeNull(); // un-elect

    // Garbage is rejected, not coerced or persisted.
    expect(buildSettingsRow(LATEST, { vehicleDeductionMethod: 'mileage' }, '2026-07-21').error)
      .toMatch(/vehicleDeductionMethod/);
    expect(buildSettingsRow(LATEST, { vehicleDeductionMethod: 'STANDARD_MILEAGE' }, '2026-07-21').error)
      .toMatch(/vehicleDeductionMethod/);
  });

  test('an unrelated save does NOT touch the election', () => {
    const withElection = { ...LATEST, vehicle_deduction_method: 'actual_expenses' };
    const { row } = buildSettingsRow(withElection, { loadedLaborRate: 40 }, '2026-07-21');
    // Carried forward untouched — no accidental un-election on a labor save.
    expect(row.vehicle_deduction_method).toBe('actual_expenses');
    expect(row.vehicle_deduction_method_set_at).toBeUndefined();
  });
});
