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

  test('a saved-property scope narrows the canonical tracker to that property (primary also owns unstamped rows)', () => {
    const secondary = build(db, 'cust-1', {
      activeOnly: true, today: '2026-05-05', nowIso: '2026-05-05T12:00:00.000Z',
      scope: { customerId: 'cust-1', enabled: true, multi: true, scoped: true, property: { id: 'prop-b', is_primary: false } },
    }).toSQL();
    expect(secondary.sql).toMatch(/"scheduled_services"\."property_id" = \?/);
    expect(secondary.sql).not.toMatch(/"property_id" is null/);
    expect(secondary.bindings).toEqual(expect.arrayContaining(['cust-1', 'prop-b']));

    const primary = build(db, 'cust-1', {
      activeOnly: true, today: '2026-05-05', nowIso: '2026-05-05T12:00:00.000Z',
      scope: { customerId: 'cust-1', enabled: true, multi: true, scoped: true, property: { id: 'prop-a', is_primary: true } },
    }).toSQL();
    expect(primary.sql).toMatch(/\("scheduled_services"\."property_id" = \? or "scheduled_services"\."property_id" is null\)/);

    // Gate off / single property: no property predicate at all — today's SQL.
    const off = build(db, 'cust-1', {
      activeOnly: true, today: '2026-05-05', nowIso: '2026-05-05T12:00:00.000Z',
      scope: { customerId: 'cust-1', enabled: false, multi: false, scoped: false, property: null },
    }).toSQL();
    expect(off.sql).not.toContain('property_id');
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

  test('authenticated tracking only exposes fresh tech_status location timestamps', () => {
    expect(trackingRouter._test.isFreshTechStatusTimestamp('2026-05-05T11:55:00.000Z')).toBe(true);
    expect(trackingRouter._test.isFreshTechStatusTimestamp('2026-05-05T11:54:59.999Z')).toBe(false);
    expect(trackingRouter._test.isFreshTechStatusTimestamp(null)).toBe(false);
    expect(trackingRouter._test.isFreshTechStatusTimestamp('not-a-date')).toBe(false);
  });

  test('scopedLocationCustomer: a non-primary selection supplies its own coordinates/address (no geocode → no pin); primary/single/off keep the customer row', () => {
    const scoped = trackingRouter._test.scopedLocationCustomer;
    const customer = { id: 'c1', latitude: 27.1, longitude: -82.1, address_line1: '1200 Palm Row Ct', city: 'Parrish', state: 'FL', zip: '34219' };
    const secondary = { id: 'pb', is_primary: false, latitude: 27.5, longitude: -82.5, address_line1: '418 Oak Ave', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34205' };
    expect(scoped(customer, { enabled: true, multi: true, scoped: true, property: secondary })).toMatchObject({ id: 'c1', latitude: 27.5, longitude: -82.5, address_line1: '418 Oak Ave', city: 'Bradenton', zip: '34205' });
    expect(scoped(customer, { enabled: true, multi: true, scoped: true, property: { ...secondary, latitude: null, longitude: null } })).toMatchObject({ latitude: null, longitude: null, address_line1: '418 Oak Ave' });
    // The visit's own stamped geocode wins inside the scoped branch — even when the property row has none.
    expect(scoped(customer, { enabled: true, multi: true, scoped: true, property: { ...secondary, latitude: null, longitude: null } }, { lat: 27.9, lng: -82.9 })).toMatchObject({ latitude: 27.9, longitude: -82.9, address_line1: '418 Oak Ave' });
    expect(scoped(customer, { enabled: true, multi: true, scoped: true, property: secondary }, { lat: 'nope', lng: null })).toMatchObject({ latitude: 27.5, longitude: -82.5 });
    expect(scoped(customer, { enabled: true, multi: true, scoped: true, property: { ...secondary, is_primary: true } })).toBe(customer);
    expect(scoped(customer, { enabled: true, multi: false, scoped: false, property: secondary })).toBe(customer);
    expect(scoped(customer, { enabled: false, multi: false, scoped: false, property: null })).toBe(customer);
    expect(scoped(customer, null)).toBe(customer);
  });
});
