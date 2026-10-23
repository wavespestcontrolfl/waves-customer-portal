// Reclaimed water through PostgreSQL (cloned schema): the migration (additive, idempotent, safe down), the county match on real property rows,
// an office or customer value beating the county's, an idempotent daily tick, and a failed download keeping the stored layer. Synthetic data only.
// Skips without DATABASE_URL.
const { createLawnHistoryDb, fixture } = require('./helpers/lawn-history-db');
const migration = require('../models/migrations/20261023100000_reclaimed_water');
const meters = require('../services/reclaimed-water-meters');
const reclaimed = require('../services/lawn-reclaimed-water');

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
jest.setTimeout(60000);

const BASE = { lat: 27.5, lng: -82.4 };
const offset = (northM, eastM) => ({ lat: BASE.lat + northM / 111320, lng: BASE.lng + eastM / 98650 });
const feature = (objectid, point) => ({ attributes: { OBJECTID: objectid }, geometry: { x: point.lng, y: point.lat } });
const layerOf = (points) => ({ ok: true, status: 200, json: async () => ({ features: points.map((p, i) => feature(i + 1, p)) }) });
const T0 = new Date('2026-10-23T08:00:00Z');

describeDb('reclaimed water through PostgreSQL', () => {
  let owned;
  let knex;

  // 5,000 filler meters (the plausible minimum) scattered 2 to 8 km away, plus the meters under test.
  const filler = Array.from({ length: meters.MIN_PLAUSIBLE_METERS }, (_, i) => offset(2000 + (i % 100) * 60, 2000 + Math.floor(i / 100) * 60));
  const layer = (...near) => layerOf([...near, ...filler]);

  async function property(point, changes = {}) {
    const f = await fixture(knex);
    await knex('customer_properties').where({ id: f.property.id }).update({ latitude: point?.lat ?? null, longitude: point?.lng ?? null, ...changes });
    return { ...f, id: f.property.id, read: () => knex('customer_properties').where({ id: f.property.id }).first() };
  }

  beforeAll(async () => {
    owned = await createLawnHistoryDb(); knex = owned.knex;
    // CI's database already ran this migration; the owned copies start without it so the real up() runs here either way.
    await migration.down(knex);
    await migration.up(knex);
  }, 90000);
  afterAll(async () => { if (owned) await owned.dispose(); });
  beforeEach(async () => { await knex('reclaimed_water_meters').del(); });

  test('the migration is additive and nullable, idempotent, and its down removes only what up added', async () => {
    const columns = await knex('customer_properties').columnInfo();
    for (const name of ['reclaimed_water', 'reclaimed_water_source', 'reclaimed_water_checked_at']) expect(columns[name]).toBeDefined();
    const p = await property(offset(0, 0));
    expect(await p.read()).toMatchObject({ reclaimed_water: null, reclaimed_water_source: null, reclaimed_water_checked_at: null });
    await migration.up(knex);
    await expect(knex('customer_properties').where({ id: p.id }).update({ reclaimed_water_source: 'bogus' })).rejects.toThrow();
    await migration.down(knex);
    expect(await knex.schema.hasTable('reclaimed_water_meters')).toBe(false);
    expect(await knex.schema.hasColumn('customer_properties', 'reclaimed_water')).toBe(false);
    expect((await p.read()).address_line1).toBe('100 Fixture Street');
    await migration.down(knex);
    await migration.up(knex);
    expect(await knex.schema.hasColumn('customer_properties', 'reclaimed_water_source')).toBe(true);
  });

  test('the county match: a property within 30 m of a meter is reclaimed (county_meter); one inside the extent with no meter near is false; one outside is unknown', async () => {
    const atMeter = await property(offset(0, 10));
    const farInside = await property(offset(1000, 1000));
    const outside = await property(offset(-60000, 0));
    const noCoords = await property(null);
    const fetchImpl = jest.fn(async () => layer(offset(0, 0)));
    const summary = await meters.runDailyTick({ knex, fetchImpl, now: T0 });
    expect(summary).toMatchObject({ refreshed: meters.MIN_PLAUSIBLE_METERS + 1 });
    expect(await atMeter.read()).toMatchObject({ reclaimed_water: true, reclaimed_water_source: 'county_meter' });
    expect(await farInside.read()).toMatchObject({ reclaimed_water: false, reclaimed_water_source: 'county_meter' });
    expect(await outside.read()).toMatchObject({ reclaimed_water: null, reclaimed_water_source: null });
    expect(await noCoords.read()).toMatchObject({ reclaimed_water: null, reclaimed_water_source: null, reclaimed_water_checked_at: null });
    expect(new Date((await atMeter.read()).reclaimed_water_checked_at).toISOString()).toBe(T0.toISOString());
  });

  test('an office or customer value beats the county, whichever way it points, and survives every tick', async () => {
    const officeNo = await property(offset(0, 5), { reclaimed_water: false, reclaimed_water_source: 'office' });
    const customerYes = await property(offset(1000, 1000), { reclaimed_water: true, reclaimed_water_source: 'customer' });
    await meters.runDailyTick({ knex, fetchImpl: async () => layer(offset(0, 0)), now: T0 });
    await meters.matchProperties({ knex, now: new Date(T0.getTime() + 1000), all: true });
    expect(await officeNo.read()).toMatchObject({ reclaimed_water: false, reclaimed_water_source: 'office', reclaimed_water_checked_at: null });
    expect(await customerYes.read()).toMatchObject({ reclaimed_water: true, reclaimed_water_source: 'customer' });
  });

  test('the office handing a property back to automatic (null) lets the county settle it at the next tick', async () => {
    const p = await property(offset(0, 5));
    expect(await reclaimed.setPropertyReclaimed(p.customerId, p.id, false, { knex })).toBe(true);
    await meters.runDailyTick({ knex, fetchImpl: async () => layer(offset(0, 0)), now: T0 });
    expect(await p.read()).toMatchObject({ reclaimed_water: false, reclaimed_water_source: 'office' });
    expect(await reclaimed.setPropertyReclaimed(p.customerId, p.id, null, { knex })).toBe(true);
    expect(await p.read()).toMatchObject({ reclaimed_water: null, reclaimed_water_source: null });
    // The layer is fresh, so the tick does not download again; it matches the property never checked.
    const fetchImpl = jest.fn();
    const summary = await meters.runDailyTick({ knex, fetchImpl, now: new Date(T0.getTime() + 60000) });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ refreshed: null, checked: 1, reclaimed: 1 });
    expect(await p.read()).toMatchObject({ reclaimed_water: true, reclaimed_water_source: 'county_meter' });
  });

  test('the setter only touches the customer\'s own active property', async () => {
    const a = await property(offset(0, 5));
    const b = await property(offset(0, 5));
    expect(await reclaimed.setPropertyReclaimed(a.customerId, b.id, true, { knex })).toBe(false);
    expect((await b.read()).reclaimed_water).toBeNull();
  });

  test('the tick is idempotent: a second run the same day downloads nothing and changes no row', async () => {
    const p = await property(offset(0, 5));
    await meters.runDailyTick({ knex, fetchImpl: async () => layer(offset(0, 0)), now: T0 });
    const before = await p.read();
    const countBefore = Number((await knex('reclaimed_water_meters').count('* as n').first()).n);
    const fetchImpl = jest.fn();
    const again = await meters.runDailyTick({ knex, fetchImpl, now: new Date(T0.getTime() + 3600000) });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(again).toMatchObject({ refreshed: null, checked: 0 });
    expect(await p.read()).toEqual(before);
    expect(Number((await knex('reclaimed_water_meters').count('* as n').first()).n)).toBe(countBefore);
  });

  test('a download after six days replaces the layer (a meter the county dropped is dropped) and re-settles the properties', async () => {
    const p = await property(offset(0, 5));
    const q = await property(offset(2030, 2030)); // inside the filler grid, 42 m from the nearest filler meter
    await meters.runDailyTick({ knex, fetchImpl: async () => layer(offset(0, 0)), now: T0 });
    expect((await p.read()).reclaimed_water).toBe(true);
    const later = new Date(T0.getTime() + 7 * 86400000);
    const summary = await meters.runDailyTick({ knex, fetchImpl: async () => layerOf(filler), now: later });
    expect(summary).toMatchObject({ refreshed: meters.MIN_PLAUSIBLE_METERS });
    expect(Number((await knex('reclaimed_water_meters').count('* as n').first()).n)).toBe(meters.MIN_PLAUSIBLE_METERS);
    // The dropped meter no longer holds the property, and the new layer's extent no longer covers it: no opinion (not "false").
    expect(await p.read()).toMatchObject({ reclaimed_water: null, reclaimed_water_source: null });
    expect(await q.read()).toMatchObject({ reclaimed_water: false, reclaimed_water_source: 'county_meter' });
    expect(new Date((await q.read()).reclaimed_water_checked_at).toISOString()).toBe(later.toISOString());
  });

  test('a failed download (403, or a short answer) keeps the stored layer and the stored values; with nothing stored it throws', async () => {
    const p = await property(offset(0, 5));
    await meters.runDailyTick({ knex, fetchImpl: async () => layer(offset(0, 0)), now: T0 });
    const later = new Date(T0.getTime() + 8 * 86400000);
    const denied = await meters.runDailyTick({ knex, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }), now: later });
    expect(denied.refreshed).toBeNull();
    const short = await meters.runDailyTick({ knex, fetchImpl: async () => layerOf([offset(0, 0)]), now: later });
    expect(short.refreshed).toBeNull();
    expect(Number((await knex('reclaimed_water_meters').count('* as n').first()).n)).toBe(meters.MIN_PLAUSIBLE_METERS + 1);
    expect(await p.read()).toMatchObject({ reclaimed_water: true, reclaimed_water_source: 'county_meter' });
    await knex('reclaimed_water_meters').del();
    await expect(meters.runDailyTick({ knex, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }), now: later })).rejects.toMatchObject({ code: 'http_403' });
  });

  test('a layer larger than one write chunk is stored whole', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({ objectid: i + 1, lat: 27 + i * 0.00001, lng: -82.4 }));
    await meters.storeMeters(many.concat(Array.from({ length: 3000 }, (_, i) => ({ objectid: 3000 + i, lat: 27.9, lng: -82 + i * 0.00001 }))), { knex, now: T0 });
    expect(Number((await knex('reclaimed_water_meters').count('* as n').first()).n)).toBe(5500);
  });
});
