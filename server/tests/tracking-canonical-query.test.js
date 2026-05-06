const db = require('../models/db');
const trackingRouter = require('../routes/tracking');

describe('canonical customer tracker query', () => {
  const build = trackingRouter._test.buildCanonicalScheduledServiceQuery;
  const canonicalOptions = trackingRouter._test.canonicalQueryOptions;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-05T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('/active scope excludes future scheduled trackers', () => {
    const { sql, bindings } = build(db, 'cust-1', {
      activeOnly: true,
      today: '2026-05-05',
      nowIso: '2026-05-05T12:00:00.000Z',
    }).toSQL();

    expect(sql).toMatch(/"track_token_expires_at" >=/);
    expect(sql).toMatch(/"track_state" in \((?:\?, ){1}\?\)/);
    expect(sql).toMatch(/"scheduled_date" = \?/);
    expect(bindings).toEqual(expect.arrayContaining([
      'cust-1',
      '2026-05-05T12:00:00.000Z',
      'en_route',
      'on_property',
      'scheduled',
      'complete',
      'cancelled',
      '2026-05-05',
    ]));
    expect(sql).not.toContain('service_tracking');
  });

  test('/today scope permits today scheduled trackers', () => {
    const { sql, bindings } = build(db, 'cust-2', {
      todayOnly: true,
      today: '2026-05-05',
      nowIso: '2026-05-05T12:00:00.000Z',
    }).toSQL();

    expect(sql).toMatch(/"track_state" in \((?:\?, ){2}\?\)/);
    expect(sql).toMatch(/or (?:".+"\.)?"track_state" in \(\?, \?\)/);
    expect(sql).toMatch(/"scheduled_date" = \?/);
    expect(bindings).toEqual(expect.arrayContaining([
      'cust-2',
      'scheduled',
      'en_route',
      'on_property',
      'complete',
      'cancelled',
      '2026-05-05',
    ]));
    expect(sql).not.toContain('service_tracking');
  });

  test('authenticated canonical lookup can ignore public token expiry', () => {
    const { sql, bindings } = build(db, 'cust-rescheduled', {
      todayOnly: true,
      today: '2026-05-05',
      nowIso: '2026-05-05T12:00:00.000Z',
      requireUnexpiredToken: false,
    }).toSQL();

    expect(sql).toContain('"track_view_token" is not null');
    expect(sql).not.toMatch(/"track_token_expires_at" >=/);
    expect(sql).toMatch(/"scheduled_date" = \?/);
    expect(bindings).toEqual(expect.arrayContaining([
      'cust-rescheduled',
      '2026-05-05',
    ]));
  });

  test('authenticated /today lookup is the only default expiry override', () => {
    expect(canonicalOptions({ todayOnly: true, today: '2026-05-05' })).toMatchObject({
      todayOnly: true,
      today: '2026-05-05',
      requireUnexpiredToken: false,
    });
    expect(canonicalOptions({ activeOnly: true, today: '2026-05-05' })).toMatchObject({
      activeOnly: true,
      today: '2026-05-05',
      requireUnexpiredToken: true,
    });
  });

  test('authenticated tracking exposes no service_tracking fallback query', () => {
    expect(trackingRouter._test.buildLegacyTrackerQuery).toBeUndefined();
  });

  test('authenticated tracking only exposes fresh tech_status coordinates', () => {
    expect(trackingRouter._test.isFreshTechStatusTimestamp('2026-05-05T11:55:00.000Z')).toBe(true);
    expect(trackingRouter._test.isFreshTechStatusTimestamp('2026-05-05T11:54:59.999Z')).toBe(false);
    expect(trackingRouter._test.isFreshTechStatusTimestamp(null)).toBe(false);
    expect(trackingRouter._test.isFreshTechStatusTimestamp('not-a-date')).toBe(false);
  });
});
