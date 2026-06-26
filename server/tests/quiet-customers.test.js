/**
 * Quiet-customer surface helpers (the non-SQL logic behind GET /admin/health/quiet).
 */
const { resolveQuietDays, mapQuietRow, LAST_TOUCH_SQL } = require('../services/customer-intelligence/quiet-customers');

describe('resolveQuietDays', () => {
  test('defaults to 45', () => {
    expect(resolveQuietDays({})).toBe(45);
  });
  test('honours HEALTH_QUIET_DAYS', () => {
    expect(resolveQuietDays({ HEALTH_QUIET_DAYS: '60' })).toBe(60);
  });
  test('floors at 7 so a misconfiguration cannot flag the whole book', () => {
    expect(resolveQuietDays({ HEALTH_QUIET_DAYS: '2' })).toBe(7);
    expect(resolveQuietDays({ HEALTH_QUIET_DAYS: '0' })).toBe(45);   // invalid → default
    expect(resolveQuietDays({ HEALTH_QUIET_DAYS: 'abc' })).toBe(45); // NaN → default
  });
});

describe('mapQuietRow', () => {
  const now = Date.parse('2026-06-26T12:00:00Z');

  test('computes days_since_touch from last_touch_at', () => {
    const row = {
      id: 'c1', first_name: 'Pat', last_name: 'Lee', waveguard_tier: 'Gold',
      phone: '+19415551234', city: 'Bradenton', monthly_rate: '120.00',
      overall_score: 78, score_grade: 'B', churn_risk: 'low',
      last_service_at: '2026-05-01T00:00:00Z',
      last_inbound_at: null,
      last_touch_at: '2026-05-01T00:00:00Z',
    };
    const out = mapQuietRow(row, now);
    expect(out.days_since_touch).toBe(56); // May 1 → Jun 26
    expect(out.monthly_rate).toBe(120);    // parsed to number
    expect(out).toMatchObject({ id: 'c1', overall_score: 78, churn_risk: 'low' });
  });

  test('never-touched (epoch floor) → days_since_touch null', () => {
    const row = { id: 'c2', last_touch_at: '1970-01-01T00:00:00Z', monthly_rate: null };
    const out = mapQuietRow(row, now);
    expect(out.days_since_touch).toBeNull();
    expect(out.monthly_rate).toBeNull();
  });

  test('missing last_touch_at → null', () => {
    expect(mapQuietRow({ id: 'c3' }, now).days_since_touch).toBeNull();
  });
});

describe('LAST_TOUCH_SQL', () => {
  test('counts only completed service + inbound SMS (not automated outbound)', () => {
    expect(LAST_TOUCH_SQL).toMatch(/service_records/);
    expect(LAST_TOUCH_SQL).toMatch(/status = 'completed'/);
    expect(LAST_TOUCH_SQL).toMatch(/direction = 'inbound'/);
    expect(LAST_TOUCH_SQL).not.toMatch(/outbound/);
  });
});
