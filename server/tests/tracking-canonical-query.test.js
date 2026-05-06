const db = require('../models/db');
const trackingRouter = require('../routes/tracking');

describe('canonical customer tracker query', () => {
  const build = trackingRouter._test.buildCanonicalScheduledServiceQuery;
  const buildLegacy = trackingRouter._test.buildLegacyTrackerQuery;
  const canonicalOptions = trackingRouter._test.canonicalQueryOptions;

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

  test('legacy fallback only reads services without modern track tokens', () => {
    const { sql, bindings } = buildLegacy(db, 'cust-legacy', {
      fourHoursAgo: '2026-05-05T08:00:00.000Z',
    }).toSQL();

    expect(sql).toContain('from "service_tracking"');
    expect(sql).toContain('left join "scheduled_services" as "s"');
    expect(sql).toContain('"s"."track_view_token" is null');
    expect(sql).toContain('"service_tracking"."current_step" < ?');
    expect(sql).toContain('"service_tracking"."step_7_at" >= ?');
    expect(sql).toContain('order by "service_tracking"."created_at" desc');
    expect(bindings).toEqual(expect.arrayContaining([
      'cust-legacy',
      7,
      '2026-05-05T08:00:00.000Z',
      1,
    ]));
  });

  test('/today legacy fallback is read-only and date-scoped', () => {
    const { sql, bindings } = buildLegacy(db, 'cust-legacy', {
      todayOnly: true,
      today: '2026-05-05',
    }).toSQL();

    expect(sql).toContain('from "service_tracking"');
    expect(sql).toContain('"s"."track_view_token" is null');
    expect(sql).toContain('"s"."scheduled_date" = ?');
    expect(sql).toContain('"service_tracking"."current_step" <= ?');
    expect(sql).not.toContain('insert');
    expect(bindings).toEqual(expect.arrayContaining([
      'cust-legacy',
      '2026-05-05',
      7,
      1,
    ]));
  });
});
