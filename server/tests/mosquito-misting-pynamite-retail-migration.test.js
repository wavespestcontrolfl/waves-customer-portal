/**
 * 20261025090000: the mosquito misting pricing moves from the MistAway model to the Pynamite system at retail. The pricing_config
 * row is replaced only while it still equals the frozen 10-23 SEED; the catalog install row only while it still holds the seeded
 * 4,595 / 3,795 lists. down() reverses a part only while it still holds exactly what up() wrote.
 */
const { isDeepStrictEqual } = require('util');
const migration = require('../models/migrations/20261025090000_mosquito_misting_pynamite_retail_prices');
const seedMigration = require('../models/migrations/20261023000010_mosquito_misting_pricing_config');
const catalogMigration = require('../models/migrations/20261023100000_mosquito_misting_catalog_rows');
const { mosquitoMistingPricingDefaults } = require('../services/pricing-engine/constants');

const OLD_INSTALL = catalogMigration.SERVICES.find((s) => s.service_key === 'mosquito_misting_install');
const { SEED, NEXT, TAG, STATE_KEY } = migration;
const stateOf = (knex) => {
  const row = knex.db().system_settings.find((r) => r.key === STATE_KEY);
  return row ? JSON.parse(row.value) : null;
};

function fakeKnex(initial = {}) {
  const db = {
    pricing_config: [], pricing_config_audit: [], pricing_changelog: [], services: [], system_settings: [], ...initial,
  };
  const knex = (table) => {
    let cond = {};
    const match = (r) => Object.entries(cond).every(([k, v]) => r[k] === v);
    const q = {
      where(c) { cond = { ...cond, ...c }; return q; },
      async first() { const r = db[table].find(match); return r ? { ...r } : undefined; },
      async update(patch) { db[table].filter(match).forEach((r) => Object.assign(r, patch)); },
      async insert(r) { db[table].push({ ...r }); },
      async del() { db[table] = db[table].filter((r) => !match(r)); },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => Object.prototype.hasOwnProperty.call(db, t) };
  knex.fn = { now: () => 'now()' };
  knex.db = () => db;
  return knex;
}

const configRow = (data) => ({ config_key: 'mosquito_misting_pricing', category: 'mosquito', data: typeof data === 'string' ? data : JSON.stringify(data) });
const installRow = (patch = {}) => ({
  service_key: 'mosquito_misting_install',
  base_price: '4595.00', // pg returns numeric as a string
  price_range_min: '3795.00',
  description: OLD_INSTALL.description,
  internal_notes: OLD_INSTALL.internal_notes,
  ...patch,
});

let warn;
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('the migration literals', () => {
  test('NEXT equals the code defaults (a later constant change must come with its own migration)', () => {
    expect(NEXT).toEqual(JSON.parse(JSON.stringify(mosquitoMistingPricingDefaults())));
  });

  test('SEED is the frozen 10-23 seed, not the current defaults', () => {
    expect(SEED).toBe(seedMigration.SEED);
    expect(isDeepStrictEqual(SEED, NEXT)).toBe(false);
  });

  test('the new catalog values drop the tankless and drum wording and the old list prices', () => {
    expect(migration.NEW_SERVICE).toMatchObject({ base_price: 4195, price_range_min: 2795 });
    expect(migration.NEW_SERVICE.description).not.toMatch(/tankless|drum|system type/i);
    expect(migration.NEW_SERVICE.internal_notes).not.toMatch(/4,595|3,795|Smart list|Essential list/);
    expect(migration.NEW_SERVICE.internal_notes).toMatch(/4,195/);
    expect(migration.NEW_SERVICE.internal_notes).toMatch(/2,795/);
  });
});

describe('up: pricing_config', () => {
  test('replaces an unedited seed row (any key order) and writes one audit and one changelog row', async () => {
    const reordered = Object.fromEntries(Object.entries(SEED).reverse());
    const knex = fakeKnex({ pricing_config: [configRow(reordered)] });
    await migration.up(knex);
    const db = knex.db();
    expect(JSON.parse(db.pricing_config[0].data)).toEqual(NEXT);
    expect(db.pricing_config[0].updated_at).toBe('now()');
    expect(db.pricing_config_audit).toHaveLength(1);
    expect(db.pricing_config_audit[0]).toMatchObject({ config_key: 'mosquito_misting_pricing', changed_by: TAG });
    expect(JSON.parse(db.pricing_config_audit[0].old_value)).toEqual(SEED);
    expect(JSON.parse(db.pricing_config_audit[0].new_value)).toEqual(NEXT);
    expect(db.pricing_changelog).toHaveLength(1);
    expect(db.pricing_changelog[0]).toMatchObject({ changed_by: TAG, category: 'rule' });
  });

  test('accepts a jsonb object value as well as a JSON string', async () => {
    const knex = fakeKnex({ pricing_config: [{ ...configRow(SEED), data: JSON.parse(JSON.stringify(SEED)) }] });
    await migration.up(knex);
    expect(JSON.parse(knex.db().pricing_config[0].data)).toEqual(NEXT);
  });

  test('is idempotent: a second run changes nothing and writes no second audit row', async () => {
    const knex = fakeKnex({ pricing_config: [configRow(SEED)] });
    await migration.up(knex);
    await migration.up(knex);
    const db = knex.db();
    expect(db.pricing_config_audit).toHaveLength(1);
    expect(db.pricing_changelog).toHaveLength(1);
    expect(JSON.parse(db.pricing_config[0].data)).toEqual(NEXT);
  });

  test('leaves an admin-edited row untouched, writes nothing and warns', async () => {
    const edited = { ...SEED, serviceCallNoPlan: 175 };
    const knex = fakeKnex({ pricing_config: [configRow(edited)] });
    await migration.up(knex);
    const db = knex.db();
    expect(JSON.parse(db.pricing_config[0].data)).toEqual(edited);
    expect(db.pricing_config_audit).toHaveLength(0);
    expect(db.pricing_changelog).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('edited'));
  });

  test('a missing row is skipped with a warning and nothing is inserted', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect(knex.db().pricing_config).toHaveLength(0);
    expect(knex.db().pricing_config_audit).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing'));
  });

  test('an unreadable value counts as edited', async () => {
    const knex = fakeKnex({ pricing_config: [configRow('{not json')] });
    await migration.up(knex);
    expect(knex.db().pricing_config[0].data).toBe('{not json');
  });
});

describe('up: services install row', () => {
  test('moves a seeded row to the Standard and Compact lists and the new copy', async () => {
    const knex = fakeKnex({ services: [installRow()] });
    await migration.up(knex);
    expect(knex.db().services[0]).toMatchObject({ base_price: 4195, price_range_min: 2795, ...{ description: migration.NEW_SERVICE.description, internal_notes: migration.NEW_SERVICE.internal_notes } });
  });

  test.each([
    ['an edited base price', { base_price: '4800.00' }, { base_price: '4800.00', price_range_min: 2795 }],
    ['an edited range minimum', { price_range_min: '3500.00' }, { base_price: 4195, price_range_min: '3500.00' }],
  ])('%s is left alone with a warning; the other fields still move', async (_name, patch, expected) => {
    const knex = fakeKnex({ services: [installRow(patch)] });
    await migration.up(knex);
    expect(knex.db().services[0]).toMatchObject({ ...expected, description: migration.NEW_SERVICE.description, internal_notes: migration.NEW_SERVICE.internal_notes });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('changed since the 20261023 catalog seed'));
  });

  test('an edited description with the seeded prices keeps the operator text; prices and notes still move', async () => {
    const knex = fakeKnex({ services: [installRow({ description: 'Our own install copy' })] });
    await migration.up(knex);
    expect(knex.db().services[0]).toMatchObject({
      base_price: 4195, price_range_min: 2795, description: 'Our own install copy', internal_notes: migration.NEW_SERVICE.internal_notes,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('description'));
  });

  test('edited internal notes with the seeded prices keep the operator notes; prices and description still move', async () => {
    const knex = fakeKnex({ services: [installRow({ internal_notes: 'Ask Dana before quoting' })] });
    await migration.up(knex);
    expect(knex.db().services[0]).toMatchObject({
      base_price: 4195, price_range_min: 2795, description: migration.NEW_SERVICE.description, internal_notes: 'Ask Dana before quoting',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('internal_notes'));
  });

  test('every field edited: nothing moves', async () => {
    const edited = installRow({ base_price: '4800.00', price_range_min: '3500.00', description: 'A', internal_notes: 'B' });
    const knex = fakeKnex({ services: [edited] });
    await migration.up(knex);
    expect(knex.db().services[0]).toMatchObject(edited);
  });

  test('a missing row is skipped with a warning', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect(knex.db().services).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing'));
  });

  test('a row already on the new lists is not rewritten (admin copy edits survive a re-run)', async () => {
    const row = installRow({ base_price: 4195, price_range_min: 2795, description: 'Custom copy' });
    const knex = fakeKnex({ services: [row] });
    await migration.up(knex);
    expect(knex.db().services[0].description).toBe('Custom copy');
  });

  test('absent tables are skipped without error', async () => {
    const knex = fakeKnex();
    delete knex.db().pricing_config;
    delete knex.db().services;
    await expect(migration.up(knex)).resolves.toBeUndefined();
    await expect(migration.down(knex)).resolves.toBeUndefined();
  });
});

describe('down', () => {
  test('restores an unchanged row and removes only its own audit and changelog rows', async () => {
    const knex = fakeKnex({
      pricing_config: [configRow(SEED)],
      services: [installRow()],
      pricing_config_audit: [{ config_key: 'mosquito_misting_pricing', changed_by: seedMigration.TAG }],
      pricing_changelog: [{ ...seedMigration.CHANGELOG }],
    });
    await migration.up(knex);
    // jsonb hands the keys back in another order: the comparison is by value
    knex.db().pricing_config[0].data = JSON.stringify(Object.fromEntries(Object.entries(NEXT).reverse()));
    await migration.down(knex);
    const db = knex.db();
    expect(JSON.parse(db.pricing_config[0].data)).toEqual(SEED);
    expect(db.services[0]).toMatchObject({ base_price: OLD_INSTALL.base_price, price_range_min: OLD_INSTALL.price_range_min, description: OLD_INSTALL.description, internal_notes: OLD_INSTALL.internal_notes });
    expect(db.pricing_config_audit).toEqual([{ config_key: 'mosquito_misting_pricing', changed_by: seedMigration.TAG }]);
    expect(db.pricing_changelog).toEqual([{ ...seedMigration.CHANGELOG }]);
  });

  test('leaves a pricing_config row an admin edited after up() (and an edited services price)', async () => {
    const knex = fakeKnex({ pricing_config: [configRow(SEED)], services: [installRow()] });
    await migration.up(knex);
    const edited = { ...NEXT, serviceCallNoPlan: 175 };
    knex.db().pricing_config[0].data = JSON.stringify(edited);
    knex.db().services[0].base_price = '4300.00';
    await migration.down(knex);
    const db = knex.db();
    expect(JSON.parse(db.pricing_config[0].data)).toEqual(edited);
    expect(Number(db.services[0].base_price)).toBe(4300);
    expect(db.services[0].description).toBe(OLD_INSTALL.description);
    expect(db.pricing_config_audit).toHaveLength(0);
  });

  test.each([
    ['description', 'Admin copy', 'internal_notes'],
    ['internal_notes', 'Admin notes', 'description'],
  ])('an edited %s after up() stays; the other fields still go back', async (field, text, other) => {
    const knex = fakeKnex({ services: [installRow()] });
    await migration.up(knex);
    knex.db().services[0][field] = text;
    await migration.down(knex);
    const row = knex.db().services[0];
    expect(row[field]).toBe(text);
    expect(row[other]).toBe(OLD_INSTALL[other]);
    expect(Number(row.base_price)).toBe(OLD_INSTALL.base_price);
    expect(Number(row.price_range_min)).toBe(OLD_INSTALL.price_range_min);
  });

  test('an edited price after up() stays; the unedited fields still go back', async () => {
    const knex = fakeKnex({ services: [installRow()] });
    await migration.up(knex);
    knex.db().services[0].base_price = '4300.00';
    await migration.down(knex);
    const row = knex.db().services[0];
    expect(Number(row.base_price)).toBe(4300);
    expect(Number(row.price_range_min)).toBe(OLD_INSTALL.price_range_min);
    expect(row.description).toBe(OLD_INSTALL.description);
    expect(row.internal_notes).toBe(OLD_INSTALL.internal_notes);
  });

  test('operator text that up() left alone is never overwritten by down()', async () => {
    const knex = fakeKnex({ services: [installRow({ description: 'Our own install copy' })] });
    await migration.up(knex);
    await migration.down(knex);
    expect(knex.db().services[0].description).toBe('Our own install copy');
    expect(Number(knex.db().services[0].base_price)).toBe(OLD_INSTALL.base_price);
  });

  test('a row that up() skipped (edited) is not rewritten by down()', async () => {
    const edited = { ...SEED, serviceCallNoPlan: 175 };
    const knex = fakeKnex({ pricing_config: [configRow(edited)], services: [installRow({ base_price: '4800.00' })] });
    await migration.up(knex);
    await migration.down(knex);
    expect(JSON.parse(knex.db().pricing_config[0].data)).toEqual(edited);
    expect(Number(knex.db().services[0].base_price)).toBe(4800);
  });
});

describe('recorded ownership (system_settings state row)', () => {
  test('the normal path records exactly what up() wrote and a full round trip restores the seed', async () => {
    const knex = fakeKnex({ pricing_config: [configRow(SEED)], services: [installRow()] });
    await migration.up(knex);
    expect(stateOf(knex)).toEqual({ pricingConfig: true, serviceFields: ['base_price', 'price_range_min', 'description', 'internal_notes'] });
    await migration.down(knex);
    const db = knex.db();
    expect(JSON.parse(db.pricing_config[0].data)).toEqual(SEED);
    expect(db.services[0]).toMatchObject({ base_price: OLD_INSTALL.base_price, price_range_min: OLD_INSTALL.price_range_min, description: OLD_INSTALL.description, internal_notes: OLD_INSTALL.internal_notes });
    expect(db.system_settings).toHaveLength(0);
    expect(db.pricing_config_audit).toHaveLength(0);
    expect(db.pricing_changelog).toHaveLength(0);
  });

  test('a pricing_config row an operator already set equal to NEXT: up skips and records nothing, down leaves it', async () => {
    const knex = fakeKnex({ pricing_config: [configRow(NEXT)], services: [installRow()] });
    await migration.up(knex);
    expect(knex.db().pricing_config_audit).toHaveLength(0);
    expect(knex.db().pricing_changelog).toHaveLength(0);
    expect(stateOf(knex)).toEqual({ pricingConfig: false, serviceFields: ['base_price', 'price_range_min', 'description', 'internal_notes'] });
    await migration.down(knex);
    expect(JSON.parse(knex.db().pricing_config[0].data)).toEqual(NEXT);
    expect(Number(knex.db().services[0].base_price)).toBe(OLD_INSTALL.base_price);
  });

  test('nothing to change: no state row is written and down changes nothing', async () => {
    const knex = fakeKnex({
      pricing_config: [configRow(NEXT)],
      services: [installRow({ base_price: 4195, price_range_min: 2795, description: migration.NEW_SERVICE.description, internal_notes: migration.NEW_SERVICE.internal_notes })],
    });
    await migration.up(knex);
    expect(knex.db().system_settings).toHaveLength(0);
    const before = JSON.stringify(knex.db().services);
    await migration.down(knex);
    expect(JSON.stringify(knex.db().services)).toBe(before);
    expect(JSON.parse(knex.db().pricing_config[0].data)).toEqual(NEXT);
  });

  test('an operator base_price already 4195: not recorded, down leaves 4195 and restores the recorded fields', async () => {
    const knex = fakeKnex({ pricing_config: [configRow(SEED)], services: [installRow({ base_price: '4195.00' })] });
    await migration.up(knex);
    expect(stateOf(knex)).toEqual({ pricingConfig: true, serviceFields: ['price_range_min', 'description', 'internal_notes'] });
    await migration.down(knex);
    const row = knex.db().services[0];
    expect(Number(row.base_price)).toBe(4195);
    expect(Number(row.price_range_min)).toBe(OLD_INSTALL.price_range_min);
    expect(row.description).toBe(OLD_INSTALL.description);
    expect(row.internal_notes).toBe(OLD_INSTALL.internal_notes);
    expect(JSON.parse(knex.db().pricing_config[0].data)).toEqual(SEED);
  });

  test('no state row: down changes nothing in pricing_config or services, only removes its own audit rows', async () => {
    const knex = fakeKnex({
      pricing_config: [configRow(NEXT)],
      services: [installRow({ base_price: 4195, price_range_min: 2795, description: migration.NEW_SERVICE.description, internal_notes: migration.NEW_SERVICE.internal_notes })],
      pricing_config_audit: [{ config_key: 'mosquito_misting_pricing', changed_by: TAG }, { config_key: 'mosquito_misting_pricing', changed_by: seedMigration.TAG }],
    });
    await migration.down(knex);
    expect(JSON.parse(knex.db().pricing_config[0].data)).toEqual(NEXT);
    expect(Number(knex.db().services[0].base_price)).toBe(4195);
    expect(knex.db().pricing_config_audit).toEqual([{ config_key: 'mosquito_misting_pricing', changed_by: seedMigration.TAG }]);
  });

  test('an unreadable state row restores nothing and is left in place', async () => {
    const knex = fakeKnex({ pricing_config: [configRow(NEXT)], services: [installRow({ base_price: 4195 })], system_settings: [{ key: STATE_KEY, value: '{nope' }] });
    await migration.down(knex);
    expect(JSON.parse(knex.db().pricing_config[0].data)).toEqual(NEXT);
    expect(Number(knex.db().services[0].base_price)).toBe(4195);
    expect(knex.db().system_settings).toHaveLength(1);
  });

  test('a recorded part an admin changed after up() is left alone; the state row is still removed', async () => {
    const knex = fakeKnex({ pricing_config: [configRow(SEED)], services: [installRow()] });
    await migration.up(knex);
    knex.db().pricing_config[0].data = JSON.stringify({ ...NEXT, serviceCallNoPlan: 175 });
    knex.db().services[0].price_range_min = '2900.00';
    await migration.down(knex);
    const db = knex.db();
    expect(JSON.parse(db.pricing_config[0].data)).toEqual({ ...NEXT, serviceCallNoPlan: 175 });
    expect(Number(db.services[0].price_range_min)).toBe(2900);
    expect(Number(db.services[0].base_price)).toBe(OLD_INSTALL.base_price);
    expect(db.system_settings).toHaveLength(0);
  });

  test('re-run idempotency: the second run writes nothing and the record keeps what the first run wrote', async () => {
    const knex = fakeKnex({ pricing_config: [configRow(SEED)], services: [installRow()] });
    await migration.up(knex);
    const first = stateOf(knex);
    await migration.up(knex);
    expect(stateOf(knex)).toEqual(first);
    expect(knex.db().system_settings).toHaveLength(1);
    expect(knex.db().pricing_config_audit).toHaveLength(1);
    await migration.down(knex);
    expect(JSON.parse(knex.db().pricing_config[0].data)).toEqual(SEED);
    expect(Number(knex.db().services[0].base_price)).toBe(OLD_INSTALL.base_price);
  });

  test('a missing system_settings table: up still runs without a record, and down changes nothing', async () => {
    const knex = fakeKnex({ pricing_config: [configRow(SEED)], services: [installRow()] });
    delete knex.db().system_settings;
    await migration.up(knex);
    expect(JSON.parse(knex.db().pricing_config[0].data)).toEqual(NEXT);
    await migration.down(knex);
    expect(JSON.parse(knex.db().pricing_config[0].data)).toEqual(NEXT);
    expect(Number(knex.db().services[0].base_price)).toBe(4195);
  });
});
