const dryTime = require('../services/auto-dispatch/dry-time');
const { normalizePreferences, getCustomerSchedulingPreferences } = require('../services/auto-dispatch/preferences');
const { TIME_WINDOWS } = require('../services/auto-dispatch/service-category');

const { DRY_WINDOWS } = dryTime;

// A knex-shaped fake: every chain resolves to the next queued result and the
// table names it was opened on are recorded.
function fakeConn(results = [], { isTransaction = false } = {}) {
  const calls = [];
  const queue = [...results];
  const conn = (table) => {
    calls.push(table);
    const next = () => { const r = queue.shift(); if (r instanceof Error) throw r; return r; };
    const chain = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => { try { res(next()); } catch (e) { rej(e); } };
        return () => chain;
      },
    });
    return chain;
  };
  conn.calls = calls;
  if (isTransaction) {
    conn.isTransaction = true;
    conn.transaction = (fn) => fn(conn);
  }
  return conn;
}

const ctx = { customerId: 'c1', serviceType: 'Quarterly Pest Control', serviceKey: 'pest_quarterly' };
const prefsFor = (serviceType = ctx.serviceType, row = null) => normalizePreferences(row, serviceType);

describe('GATE_AUTO_DISPATCH_DRY_TIME_ORDER dry time', () => {
  const saved = { mode: process.env.GATE_AUTO_DISPATCH_DRY_TIME_ORDER, season: process.env.DRY_TIME_ORDER_SEASON };
  afterEach(() => {
    if (saved.mode === undefined) delete process.env.GATE_AUTO_DISPATCH_DRY_TIME_ORDER; else process.env.GATE_AUTO_DISPATCH_DRY_TIME_ORDER = saved.mode;
    if (saved.season === undefined) delete process.env.DRY_TIME_ORDER_SEASON; else process.env.DRY_TIME_ORDER_SEASON = saved.season;
  });

  test('classForHours: 4+ long, 1-3 short, none proof', () => {
    expect(dryTime.classForHours(4)).toBe('long');
    expect(dryTime.classForHours(24)).toBe('long');
    expect(dryTime.classForHours(3)).toBe('short');
    expect(dryTime.classForHours(2)).toBe('short');
    expect(dryTime.classForHours(0)).toBe('proof');
    expect(dryTime.classForHours(undefined)).toBe('proof');
  });

  test('the windows keep the TIME_WINDOWS shape', () => {
    expect(Object.keys(DRY_WINDOWS.long)).toEqual(Object.keys(TIME_WINDOWS.early_morning));
    expect([DRY_WINDOWS.long.startMin, DRY_WINDOWS.long.endMin]).toEqual([480, 600]);
    expect([DRY_WINDOWS.short.startMin, DRY_WINDOWS.short.endMin]).toEqual([540, 720]);
    expect([DRY_WINDOWS.proof.startMin, DRY_WINDOWS.proof.endMin]).toEqual([780, 1020]);
  });

  describe('inSeason', () => {
    test('empty or invalid is all year', () => {
      expect(dryTime.inSeason('2026-07-04', '')).toBe(true);
      expect(dryTime.inSeason('2026-07-04', undefined)).toBe(true);
      expect(dryTime.inSeason('2026-07-04', 'summer')).toBe(true);
      expect(dryTime.inSeason('2026-07-04', '13-01..05-15')).toBe(true);
      expect(dryTime.inSeason('2026-07-04', '06-01..06-31x')).toBe(true);
    });
    test('a normal range includes both ends', () => {
      expect(dryTime.inSeason('2026-06-01', '06-01..09-30')).toBe(true);
      expect(dryTime.inSeason('2026-09-30', '06-01..09-30')).toBe(true);
      expect(dryTime.inSeason('2026-10-01', '06-01..09-30')).toBe(false);
      expect(dryTime.inSeason('2026-05-31', '06-01..09-30')).toBe(false);
    });
    test('a wrap-around range crosses the new year', () => {
      expect(dryTime.inSeason('2026-11-01', '10-15..05-15')).toBe(true);
      expect(dryTime.inSeason('2026-02-03', '10-15..05-15')).toBe(true);
      expect(dryTime.inSeason('2026-07-04', '10-15..05-15')).toBe(false);
    });
    test('reads the env at call time', () => {
      process.env.DRY_TIME_ORDER_SEASON = '06-01..09-30';
      expect(dryTime.inSeason('2026-11-01')).toBe(false);
      delete process.env.DRY_TIME_ORDER_SEASON;
      expect(dryTime.inSeason('2026-11-01')).toBe(true);
    });
  });

  describe('productDryHours', () => {
    test('a water-in label product needs none', () => {
      expect(dryTime.productDryHours({ name: 'Heritage G', epa_reg_number: '100-1323' }, 4)).toBe(0);
    });
    test('a label dry-before-rain product takes its label hours', () => {
      expect(dryTime.productDryHours({ name: 'Sedgehammer Plus', epa_reg_number: '81880-24' }, 2)).toBe(4);
    });
    test('a granular, bait, gel, dust or station product needs none', () => {
      expect(dryTime.productDryHours({ name: 'Mystery Product', application_method: 'granular_broadcast' }, 4)).toBe(0);
      expect(dryTime.productDryHours({ name: 'Roach Gel Bait', product_category: 'bait' }, 4)).toBe(0);
      expect(dryTime.productDryHours({ name: 'Dustex', product_category: 'dust' }, 4)).toBe(0);
      expect(dryTime.productDryHours({ name: 'Bait Station Refill' }, 4)).toBe(0);
    });
    test('an unknown liquid takes the service hours, or 2 when unknown', () => {
      expect(dryTime.productDryHours({ name: 'Mystery Liquid', application_method: 'foliar_spray' }, 3)).toBe(3);
      expect(dryTime.productDryHours({ name: 'Mystery Liquid' }, 0)).toBe(2);
    });
  });

  describe('serviceRuleHours', () => {
    test.each([
      ['WaveGuard Mosquito Treatment', null, 2],
      ['Tree & Shrub Program', null, 3],
      ['Palm Injection', null, 3],
      ['Lawn Care Visit #3', null, 4],
      ['Fertilization & Weed Control', null, 4],
      ['Quarterly Pest Control', null, 2],
      ['Interior Pest Control', null, 0],
      ['Interior and Exterior Pest', null, 2],
      ['Termite Bait Station Monitoring', null, 0],
      ['Rodent Trapping Followup', null, 0],
      ['Rat Control', null, 0],
      ['Termite Liquid Treatment', null, 2],
      ['', 'lawn_fertilization', 4],
    ])('%s (%s) -> %s h', (type, key, hours) => {
      expect(dryTime.serviceRuleHours(type, key)).toBe(hours);
    });
  });

  describe('resolveDryHours', () => {
    test('a rain-OK service needs none and reads nothing', async () => {
      const conn = fakeConn([]);
      const out = await dryTime.resolveDryHours(conn, { customerId: 'c1', serviceType: 'Termite Inspection', serviceKey: null });
      expect(out).toEqual({ hours: 0, source: 'rain_ok_service' });
      expect(conn.calls).toEqual([]);
    });
    test('the last visit products win, the longest dry time is taken', async () => {
      const conn = fakeConn([
        { id: 'rec1' },
        [
          { product_name: 'Bait Gel', application_method: 'gel' },
          { product_name: 'Sedgehammer Plus', epa_reg_number: '81880-24' },
        ],
      ]);
      const out = await dryTime.resolveDryHours(conn, ctx);
      expect(out).toEqual({ hours: 4, source: 'last_visit_products' });
      expect(conn.calls).toEqual(['scheduled_services as ss', 'service_products as sp']);
    });
    test('the catalog EPA number fills a visit product without one', async () => {
      const conn = fakeConn([{ id: 'rec1' }, [{ product_name: 'Sedge', catalog_epa: '81880-24' }]]);
      expect((await dryTime.resolveDryHours(conn, ctx)).hours).toBe(4);
    });
    test('no completed visit falls to the service product mapping', async () => {
      const conn = fakeConn([undefined, [{ name: 'Mystery Liquid' }]]);
      const out = await dryTime.resolveDryHours(conn, ctx);
      expect(out).toEqual({ hours: 2, source: 'service_products' });
      expect(conn.calls).toEqual(['scheduled_services as ss', 'service_product_usage as u']);
    });
    test('no products anywhere falls to the service rule', async () => {
      const conn = fakeConn([undefined, []]);
      expect(await dryTime.resolveDryHours(conn, { ...ctx, serviceType: 'Lawn Care Visit' })).toEqual({ hours: 4, source: 'service_rule' });
    });
    test('a read error never throws: the service rule answers', async () => {
      const conn = fakeConn([new Error('relation does not exist')]);
      expect(await dryTime.resolveDryHours(conn, ctx)).toEqual({ hours: 2, source: 'service_rule' });
    });
    test('inside a transaction the reads run in a savepoint', async () => {
      const conn = fakeConn([undefined, []], { isTransaction: true });
      const spy = jest.spyOn(conn, 'transaction');
      await dryTime.resolveDryHours(conn, ctx);
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  describe('withDryTime', () => {
    test('off returns the same prefs and makes no database call', async () => {
      delete process.env.GATE_AUTO_DISPATCH_DRY_TIME_ORDER;
      const conn = fakeConn([]);
      const prefs = prefsFor();
      const out = await dryTime.withDryTime(prefs, conn, { ...ctx, runDate: '2026-11-01' });
      expect(out).toBe(prefs);
      expect(JSON.stringify(out)).toBe(JSON.stringify(prefsFor()));
      expect(conn.calls).toEqual([]);
    });
    test('only exactly shadow or true turns it on', async () => {
      process.env.GATE_AUTO_DISPATCH_DRY_TIME_ORDER = 'TRUE ';
      const conn = fakeConn([]);
      const prefs = prefsFor();
      expect(await dryTime.withDryTime(prefs, conn, { ...ctx, runDate: '2026-11-01' })).toBe(prefs);
      expect(conn.calls).toEqual([]);
    });
    test('true replaces the family default window with the dry window', async () => {
      process.env.GATE_AUTO_DISPATCH_DRY_TIME_ORDER = 'true';
      const conn = fakeConn([{ id: 'rec1' }, [{ product_name: 'Sedgehammer Plus', epa_reg_number: '81880-24' }]]);
      const out = await dryTime.withDryTime(prefsFor('Lawn Care Visit'), conn, { ...ctx, serviceType: 'Lawn Care Visit', runDate: '2026-11-01' });
      expect(out.default_time_window).toBe(DRY_WINDOWS.long);
      expect(out.effective_time_window).toBe(DRY_WINDOWS.long);
      expect(out.preferred_time_window).toBeNull();
      expect(out.dry_time).toEqual({
        mode: 'true', hours: 4, class: 'long', source: 'last_visit_products', window_key: 'dry_long', customer_time: false,
      });
    });
    test('true keeps an explicit customer time', async () => {
      process.env.GATE_AUTO_DISPATCH_DRY_TIME_ORDER = 'true';
      const prefs = prefsFor('Lawn Care Visit', { preferred_time: 'afternoon' });
      const out = await dryTime.withDryTime(prefs, fakeConn([undefined, []]), { ...ctx, serviceType: 'Lawn Care Visit', runDate: '2026-11-01' });
      expect(out.preferred_time_window).toBe(TIME_WINDOWS.afternoon);
      expect(out.effective_time_window).toBe(TIME_WINDOWS.afternoon);
      expect(out.default_time_window).toBe(prefs.default_time_window);
      expect(out.dry_time.customer_time).toBe(true);
    });
    test('shadow leaves every window alone and records the meta', async () => {
      process.env.GATE_AUTO_DISPATCH_DRY_TIME_ORDER = 'shadow';
      const prefs = prefsFor();
      const out = await dryTime.withDryTime(prefs, fakeConn([undefined, []]), { ...ctx, runDate: '2026-11-01' });
      expect(out.default_time_window).toBe(prefs.default_time_window);
      expect(out.effective_time_window).toBe(prefs.effective_time_window);
      expect(out.dry_time).toMatchObject({ mode: 'shadow', hours: 2, class: 'short', source: 'service_rule', window_key: 'dry_short' });
    });
    test('out of season the window is null (neutral time score) in true mode', async () => {
      process.env.GATE_AUTO_DISPATCH_DRY_TIME_ORDER = 'true';
      process.env.DRY_TIME_ORDER_SEASON = '06-01..09-30';
      const out = await dryTime.withDryTime(prefsFor(), fakeConn([undefined, []]), { ...ctx, runDate: '2026-11-01' });
      expect(out.default_time_window).toBeNull();
      expect(out.effective_time_window).toBeNull();
      expect(out.dry_time.window_key).toBeNull();
    });
    test('a rain-proof service gets the afternoon window', async () => {
      process.env.GATE_AUTO_DISPATCH_DRY_TIME_ORDER = 'true';
      const out = await dryTime.withDryTime(prefsFor('Rodent Trapping Followup'), fakeConn([]), { ...ctx, serviceType: 'Rodent Trapping Followup', serviceKey: 'rodent_trapping_followup', runDate: '2026-11-01' });
      expect(out.effective_time_window).toBe(DRY_WINDOWS.proof);
      expect(out.dry_time.source).toBe('rain_ok_service');
    });
  });

  describe('shadowPrefs', () => {
    test('shadow with no customer time scores on the dry window', () => {
      const prefs = { ...prefsFor(), dry_time: { mode: 'shadow', window_key: 'dry_long', customer_time: false } };
      const shadow = dryTime.shadowPrefs(prefs);
      expect(shadow.effective_time_window).toBe(DRY_WINDOWS.long);
      expect(shadow.default_time_window).toBe(DRY_WINDOWS.long);
      expect(prefs.effective_time_window).toBe(TIME_WINDOWS.early_morning);
    });
    test('out of season the shadow window is null', () => {
      const prefs = { ...prefsFor(), dry_time: { mode: 'shadow', window_key: null, customer_time: false } };
      expect(dryTime.shadowPrefs(prefs).effective_time_window).toBeNull();
    });
    test('other modes and a customer time return the prefs as they are', () => {
      const base = prefsFor();
      expect(dryTime.shadowPrefs(base)).toBe(base);
      const live = { ...base, dry_time: { mode: 'true', window_key: 'dry_long', customer_time: false } };
      expect(dryTime.shadowPrefs(live)).toBe(live);
      const own = { ...base, dry_time: { mode: 'shadow', window_key: 'dry_long', customer_time: true } };
      expect(dryTime.shadowPrefs(own)).toBe(own);
    });
  });

  describe('auditNote', () => {
    const info = { mode: 'shadow', hours: 4, class: 'long', source: 'service_rule', window_key: 'dry_long', customer_time: false };
    const at = (date, start_time) => ({ date, start_time, technician_id: 't1' });
    test('is null when the gate is off', () => {
      expect(dryTime.auditNote(prefsFor(), { current: at('2026-11-03', '10:00') })).toBeNull();
    });
    test('shadow names the live and shadow best slots', () => {
      const note = dryTime.auditNote({ dry_time: info }, { current: at('2026-11-03', '10:00'), live: at('2026-11-03', '10:00'), shadow: at('2026-11-03', '08:00') });
      expect(note).toEqual({
        ...info,
        current: { date: '2026-11-03', start: '10:00' },
        live_best: { date: '2026-11-03', start: '10:00' },
        shadow_best: { date: '2026-11-03', start: '08:00' },
      });
    });
    test('shadow with nothing qualifying shows nulls', () => {
      const note = dryTime.auditNote({ dry_time: info }, { current: at('2026-11-03', '10:00'), live: null, shadow: null });
      expect(note.live_best).toBeNull();
      expect(note.shadow_best).toBeNull();
    });
    test('true mode carries no shadow_best', () => {
      const note = dryTime.auditNote({ dry_time: { ...info, mode: 'true' } }, { current: at('2026-11-03', '10:00'), live: null });
      expect(note).not.toHaveProperty('shadow_best');
      expect(note.live_best).toBeNull();
    });
  });

  describe('getCustomerSchedulingPreferences', () => {
    // property_preferences read, then (gate on) the dry-time reads.
    test('off: one read, prefs identical to the normalized row', async () => {
      delete process.env.GATE_AUTO_DISPATCH_DRY_TIME_ORDER;
      const conn = fakeConn([{ preferred_day: 'tuesday', preferred_time: 'no_preference' }]);
      const out = await getCustomerSchedulingPreferences('c1', 'Quarterly Pest Control', conn);
      expect(conn.calls).toEqual(['property_preferences']);
      expect(out).toEqual(normalizePreferences({ preferred_day: 'tuesday', preferred_time: 'no_preference' }, 'Quarterly Pest Control'));
      expect(out).not.toHaveProperty('dry_time');
    });
    test('true: two reads give the same prefs every time (no spurious change)', async () => {
      process.env.GATE_AUTO_DISPATCH_DRY_TIME_ORDER = 'true';
      const read = () => getCustomerSchedulingPreferences('c1', 'Lawn Care Visit', fakeConn([undefined, undefined, []]), {});
      const [a, b] = [await read(), await read()];
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.effective_time_window).toMatchObject({ key: 'dry_long' });
    });
  });
});
