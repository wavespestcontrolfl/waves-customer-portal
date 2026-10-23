// Reclaimed water through PostgreSQL (cloned schema): the migration (additive, idempotent, safe down), the county match on real property rows,
// an office or customer value beating the county's, an idempotent daily tick, and a failed download keeping the stored layer. Synthetic data only.
// Skips without DATABASE_URL.
const { createLawnHistoryDb, fixture } = require('./helpers/lawn-history-db');
const migration = require('../models/migrations/20261023100000_reclaimed_water');
const resetMigration = require('../models/migrations/20261023110000_reclaimed_water_coordinate_reset');
const meters = require('../services/reclaimed-water-meters');

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
    await resetMigration.down(knex);
    await migration.down(knex);
    await migration.up(knex);
    await resetMigration.up(knex);
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
    await resetMigration.down(knex);
    await migration.down(knex);
    expect(await knex.schema.hasTable('reclaimed_water_meters')).toBe(false);
    expect(await knex.schema.hasColumn('customer_properties', 'reclaimed_water')).toBe(false);
    expect((await p.read()).address_line1).toBe('100 Fixture Street');
    await migration.down(knex);
    await migration.up(knex);
    await resetMigration.up(knex);
    await resetMigration.up(knex);
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
    await knex('customer_properties').where({ id: p.id }).update({ reclaimed_water: false, reclaimed_water_source: 'office', reclaimed_water_checked_at: new Date() });
    await meters.runDailyTick({ knex, fetchImpl: async () => layer(offset(0, 0)), now: T0 });
    expect(await p.read()).toMatchObject({ reclaimed_water: false, reclaimed_water_source: 'office' });
    await knex('customer_properties').where({ id: p.id }).update({ reclaimed_water: null, reclaimed_water_source: null, reclaimed_water_checked_at: null });
    expect(await p.read()).toMatchObject({ reclaimed_water: null, reclaimed_water_source: null });
    // The layer is fresh, so the tick does not download again; it matches the property never checked.
    const fetchImpl = jest.fn();
    const summary = await meters.runDailyTick({ knex, fetchImpl, now: new Date(T0.getTime() + 60000) });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ refreshed: null, checked: 1, reclaimed: 1 });
    expect(await p.read()).toMatchObject({ reclaimed_water: true, reclaimed_water_source: 'county_meter' });
  });

  test('an address change on the primary property drops the stored answer in the real table; a formatting-only edit keeps it', async () => {
    const { syncPrimaryAddress } = require('../services/customer-properties');
    const p = await property(offset(0, 5), { reclaimed_water: true, reclaimed_water_source: 'office', reclaimed_water_checked_at: new Date() });
    const row = await p.read();
    const customer = (change) => ({ id: p.customerId, address_line1: row.address_line1, address_line2: row.address_line2, city: row.city, state: row.state, zip: row.zip, ...change });
    await syncPrimaryAddress(customer({ address_line1: '100 Fixture St' }), knex);
    expect(await p.read()).toMatchObject({ reclaimed_water: true, reclaimed_water_source: 'office' });
    await syncPrimaryAddress(customer({ address_line1: '212 Fixture Street' }), knex);
    expect(await p.read()).toMatchObject({ address_line1: '212 Fixture Street', reclaimed_water: null, reclaimed_water_source: null, reclaimed_water_checked_at: null });
  });

  test('a refresh whose match pass failed is finished by the next tick: properties checked before the stored layer are matched again', async () => {
    await knex('customer_properties').update({ active: false });
    const p = await property(offset(0, 5));
    await meters.runDailyTick({ knex, fetchImpl: async () => layerOf([offset(-500, -500), ...filler]), now: T0 }); // layer A: a meter 700 m away, none at p
    expect(await p.read()).toMatchObject({ reclaimed_water: false, reclaimed_water_source: 'county_meter' });
    const later = new Date(T0.getTime() + 7 * 86400000);
    const failing = Object.assign((...args) => knex(...args), {
      transaction: (...args) => knex.transaction(...args),
      raw: (...args) => (String(args[0]).includes('UPDATE customer_properties') ? Promise.reject(new Error('match cut short')) : knex.raw(...args)),
    });
    await expect(meters.runDailyTick({ knex: failing, fetchImpl: async () => layer(offset(0, 0)), now: later })).rejects.toThrow('match cut short');
    expect(Number((await knex('reclaimed_water_meters').count('* as n').first()).n)).toBe(meters.MIN_PLAUSIBLE_METERS + 1); // layer B is stored (it dropped the far meter, added one at p)
    expect((await p.read()).reclaimed_water).toBe(false); // ... but p was never matched against it
    const fetchImpl = jest.fn();
    const retry = await meters.runDailyTick({ knex, fetchImpl, now: new Date(later.getTime() + 3600000) });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(retry).toMatchObject({ refreshed: null, checked: 1, reclaimed: 1 });
    expect(await p.read()).toMatchObject({ reclaimed_water: true, reclaimed_water_source: 'county_meter' });
  });

  describe('a county verdict never outlives its coordinates (one trigger, every coordinate writer)', () => {
    const COUNTY = { reclaimed_water: true, reclaimed_water_source: 'county_meter' };
    const CLEARED = { reclaimed_water: null, reclaimed_water_source: null, reclaimed_water_checked_at: null };
    const settled = async (point, source = 'county_meter', water = true) => {
      const p = await property(point, { reclaimed_water: water, reclaimed_water_source: source, reclaimed_water_checked_at: new Date() });
      return p;
    };

    test.each([
      ['the geocode review clearing the mirrors (clearLocationMirrors)', (p, row) => knex('customer_properties').where({ id: p.id, latitude: row.latitude, longitude: row.longitude }).update({ latitude: null, longitude: null, updated_at: new Date() })],
      ['a re-geocode or manual pin replacing the coordinates', (p) => knex('customer_properties').where({ id: p.id }).update({ latitude: 27.61, longitude: -82.41 })],
      ['syncPrimaryAddress clearing them on an address move', async (p) => {
        const { syncPrimaryAddress } = require('../services/customer-properties');
        const row = await p.read();
        await syncPrimaryAddress({ id: p.customerId, address_line1: '9 Moved Way', address_line2: null, city: row.city, state: row.state, zip: row.zip }, knex);
      }],
      ['only the longitude changing', (p) => knex('customer_properties').where({ id: p.id }).update({ longitude: -82.5 })],
    ])('%s clears a county verdict', async (_label, write) => {
      const p = await settled(offset(0, 5));
      await write(p, await p.read());
      expect(await p.read()).toMatchObject(CLEARED);
    });

    test.each([['office', true], ['office', false], ['customer', true], ['customer', false]])('a %s answer (%s) stays when the coordinates change', async (source, water) => {
      const p = await settled(offset(0, 5), source, water);
      await knex('customer_properties').where({ id: p.id }).update({ latitude: null, longitude: null });
      expect(await p.read()).toMatchObject({ reclaimed_water: water, reclaimed_water_source: source });
      await knex('customer_properties').where({ id: p.id }).update({ latitude: 27.7, longitude: -82.3 });
      expect(await p.read()).toMatchObject({ reclaimed_water: water, reclaimed_water_source: source });
    });

    test('a write that leaves the coordinates alone, or restates the same numbers, keeps the verdict; so does one that writes a fresh verdict with them', async () => {
      const p = await settled(offset(0, 5));
      const row = await p.read();
      await knex('customer_properties').where({ id: p.id }).update({ label: 'Back lot', updated_at: new Date() });
      await knex('customer_properties').where({ id: p.id }).update({ latitude: row.latitude, longitude: row.longitude });
      expect(await p.read()).toMatchObject(COUNTY);
      // The county job's own write (verdict, same coordinates) and a statement that moves the pin AND judges it are not reset.
      const checked = new Date('2026-10-23T09:00:00Z');
      await knex('customer_properties').where({ id: p.id }).update({ latitude: 27.62, longitude: -82.42, reclaimed_water: false, reclaimed_water_source: 'county_meter', reclaimed_water_checked_at: checked });
      expect(await p.read()).toMatchObject({ reclaimed_water: false, reclaimed_water_source: 'county_meter' });
    });

    test('the county\'s "outside the layer" result (no source, checked_at stamped) is invalidated by a pin move too, and the new location is judged at the next tick', async () => {
      await knex('customer_properties').update({ active: false });
      const p = await property(offset(-60000, 0), { reclaimed_water: null, reclaimed_water_source: null, reclaimed_water_checked_at: new Date() });
      await knex('customer_properties').where({ id: p.id }).update({ latitude: offset(0, 5).lat, longitude: offset(0, 5).lng });
      expect(await p.read()).toMatchObject(CLEARED);
      const result = await meters.runDailyTick({ knex, fetchImpl: async () => layer(offset(0, 0)), now: T0 });
      expect(result).toMatchObject({ checked: 1, reclaimed: 1 });
      expect(await p.read()).toMatchObject(COUNTY);
      // An unchecked property (nothing stamped) is untouched by a move.
      const fresh = await property(offset(0, 5));
      await knex('customer_properties').where({ id: fresh.id }).update({ latitude: 27.9, longitude: -82.1 });
      expect(await fresh.read()).toMatchObject(CLEARED);
    });

    test('after the pin moved the county job judges the NEW location at the next tick', async () => {
      await knex('customer_properties').update({ active: false });
      const p = await settled(offset(5000, 5000), 'county_meter', false);
      await knex('customer_properties').where({ id: p.id }).update({ latitude: offset(0, 5).lat, longitude: offset(0, 5).lng });
      expect(await p.read()).toMatchObject(CLEARED);
      const result = await meters.runDailyTick({ knex, fetchImpl: async () => layer(offset(0, 0)), now: T0 });
      expect(result).toMatchObject({ checked: 1, reclaimed: 1 });
      expect(await p.read()).toMatchObject(COUNTY);
    });
  });

  test('a property that moved between the read and the write is not given the old location\'s answer, and stays unchecked for the next tick', async () => {
    const p = await property(offset(0, 5));
    await knex('customer_properties').whereNot({ id: p.id }).update({ active: false }); // only this property is in play
    await meters.storeMeters([offset(0, 0), ...filler].map((point, i) => ({ objectid: i + 1, lat: point.lat, lng: point.lng })), { knex, now: T0 });
    // The office moves the address (coordinates cleared) just after the match read its coordinates: wrap the first UPDATE.
    let moved = false;
    const racing = Object.assign((...args) => knex(...args), {
      raw: (...args) => {
        if (moved || !String(args[0]).includes('UPDATE customer_properties')) return knex.raw(...args);
        moved = true;
        return knex('customer_properties').where({ id: p.id }).update({ latitude: null, longitude: null, address_line1: '1 Moved Way' }).then(() => knex.raw(...args));
      },
    });
    const result = await meters.matchProperties({ knex: racing, now: T0, all: true });
    expect({ moved, ...result }).toMatchObject({ moved: true, checked: 1, reclaimed: 1, written: 0 });
    expect(await p.read()).toMatchObject({ reclaimed_water: null, reclaimed_water_source: null, reclaimed_water_checked_at: null });
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
