// 20261126130000: the cockroach services' growth regulator moves from Gentrol Complete EC3 to Tekko Pro IGR in the service
// library (default product lists and the cost mapping). Each step writes a row only while it holds the value read from production,
// with the checked values in the UPDATE's own WHERE; down() is a documented no-op.
const mockRecordAuditEvent = jest.fn(async () => {});
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...args) => mockRecordAuditEvent(...args) }));

const fs = require('fs');
const path = require('path');
const migration = require('../models/migrations/20261126130000_roach_growth_regulator_tekko.js');
const protocols = require('../config/protocols.json');


// A column against a WHERE value, the way Postgres compares them: jsonb by content, numeric by number.
function columnEquals(key, stored, wanted) {
  // A jsonb string scalar never equals a jsonb array, as in Postgres.
  if (key === 'default_products') return JSON.stringify(stored) === JSON.stringify(JSON.parse(wanted));
  if (key === 'usage_amount') return Number(stored) === Number(wanted);
  return stored === wanted;
}

// A small in-memory knex stand-in: each table is an array of rows. `beforeUpdate` runs between a select and the next update, to play
// an admin edit that lands in that window.
function fakeKnex({ beforeUpdate } = {}) {
  const db = {
    products_catalog: [
      { id: 'tekko', name: 'Tekko Pro IGR', epa_reg_number: '53883-335', active: true, default_rate: '1', default_unit: 'fl_oz/gal' },
      // The inactive row of the same name holds another product's data.
      { id: 'trio', name: 'Tekko Pro IGR', epa_reg_number: '53883-444', active: false, default_rate: '0.5-1', default_unit: 'fl_oz/gal' },
      { id: 'gentrol', name: 'Gentrol Complete EC3', epa_reg_number: '89459-119', active: true, default_rate: '1.3', default_unit: 'oz/gal' },
    ],
    services: [
      { id: 's1', service_key: 'cockroach_control', default_products: [...migration.LIST_BEFORE] },
      { id: 's2', service_key: 'german_roach', default_products: [...migration.LIST_BEFORE] },
      { id: 's3', service_key: 'vehicle_german_roach', default_products: [...migration.LIST_BEFORE] },
      { id: 's4', service_key: 'vehicle_roach_addon', default_products: [...migration.ADDON_LIST_BEFORE] },
      // Inactive, and not part of the move.
      { id: 's5', service_key: 'german_roach_initial', default_products: ['Advion Gel', 'Gentrol Complete EC3'] },
    ],
    service_product_usage: [
      { id: 'u1', service_type: 'Cockroach Treatment', product_id: 'gentrol', ...migration.USAGE_BEFORE, usage_amount: '1.0000' },
      { id: 'u2', service_type: 'German Roach Cleanout', product_id: 'gentrol', ...migration.USAGE_BEFORE, usage_amount: '1.0000' },
      { id: 'u3', service_type: 'Cockroach Treatment', product_id: 'antapex', usage_amount: '10.0000', usage_unit: 'g', notes: 'Crack & crevice treatment' },
      { id: 'u4', service_type: 'Mosquito Treatment - IGR', product_id: 'tekko', usage_amount: '1.0000', usage_unit: 'oz', notes: 'IGR added where breeding pressure exists.' },
    ],
  };
  const locked = [];
  const knex = (table) => {
    const conds = [];
    const matched = () => db[table].filter((row) => conds.every((cond) => Object.entries(cond).every(([key, value]) => columnEquals(key, row[key], value))));
    const builder = {
      where(cond) { conds.push(cond); return builder; },
      select() {
        const rows = matched().map((row) => ({ ...row }));
        const promise = Promise.resolve(rows);
        promise.forUpdate = () => { locked.push(table); return Promise.resolve(rows); };
        return promise;
      },
      update(values) {
        if (beforeUpdate) beforeUpdate(db, table);
        const rows = matched();
        rows.forEach((row) => Object.assign(row, values, typeof values.default_products === 'string' ? { default_products: JSON.parse(values.default_products) } : {}));
        return Promise.resolve(rows.length);
      },
    };
    return builder;
  };
  knex.fn = { now: () => 'NOW()' };
  knex.schema = { hasTable: async () => true, hasColumn: async () => true };
  knex.raw = jest.fn(async () => ({}));
  return { knex, db, locked };
}
// Rows compared by value: no timestamps, and an amount as a number (Postgres returns numeric(10,4) as "1.0000").
const snapshot = (db) => JSON.parse(JSON.stringify(db, (key, value) => {
  if (key === 'updated_at') return undefined;
  return key === 'usage_amount' ? Number(value) : value;
}));

describe('20261126130000 cockroach growth regulator: Gentrol Complete EC3 to Tekko Pro', () => {
  let log;
  beforeEach(() => { mockRecordAuditEvent.mockClear(); log = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { log.mockRestore(); });

  test('the list it writes is the home cockroach card\'s own default products, and the amount is the card\'s rate', () => {
    const cleanout = protocols.cockroach.visits.find((visit) => visit.visit === 1);
    expect([...migration.LIST_AFTER].sort()).toEqual([...cleanout.completionDefaultProducts].sort());
    expect(JSON.stringify(cleanout)).not.toContain('Gentrol');
    const line = Object.values(cleanout.lineMeta).find((meta) => meta.catalogProductHints.includes('Tekko Pro IGR'));
    expect(line.labelRatePerGallon).toMatchObject({ amount: 2, unit: 'fl_oz', epa: '53883-335' });
    // 2 fl oz per gallon at 1 gallon per 1,000 sq ft: 2 fl oz per 1,000 sq ft, in the catalog row's cost unit; 2 fl oz with no area.
    expect(migration.USAGE_AFTER).toMatchObject({ usage_amount: 2, usage_unit: 'fl_oz', usage_per_1000sf: 2 });
  });

  test('up moves the two home services and their two cost rows; nothing else', async () => {
    const { knex, db, locked } = fakeKnex();
    const catalog = snapshot(db).products_catalog;
    await migration.up(knex);
    // The catalog is not written: the Tekko Pro per-gallon rate stays 1 for every other job.
    expect(snapshot(db).products_catalog).toEqual(catalog);
    // The vehicle services move too: the Tekko Pro label lists automobiles, buses, boats and trucks.
    expect(db.services.slice(0, 3).map((row) => row.default_products)).toEqual([migration.LIST_AFTER, migration.LIST_AFTER, migration.LIST_AFTER]);
    expect(db.services[3].default_products).toEqual(migration.ADDON_LIST_AFTER);
    expect(db.services[4].default_products).toEqual(['Advion Gel', 'Gentrol Complete EC3']);
    for (const id of ['u1', 'u2']) expect(db.service_product_usage.find((row) => row.id === id)).toMatchObject({ product_id: 'tekko', ...migration.USAGE_AFTER });
    expect(db.service_product_usage.find((row) => row.id === 'u3')).toMatchObject({ product_id: 'antapex', usage_unit: 'g' });
    expect(db.service_product_usage.find((row) => row.id === 'u4')).toMatchObject({ product_id: 'tekko', usage_amount: '1.0000' });
    // One critical audit event per changed row, inside the migration's transaction, with an action that fits audit_log.action (96).
    const events = mockRecordAuditEvent.mock.calls.map(([event]) => event);
    expect(events.map((event) => [event.resource_type, event.resource_id]).sort()).toEqual([
      ['service_product_usage', 'u1'], ['service_product_usage', 'u2'], ['services', 's1'], ['services', 's2'], ['services', 's3'], ['services', 's4'],
    ]);
    for (const event of events) {
      expect(event).toMatchObject({ actor_type: 'system', critical: true, trx: knex, metadata: { migration: migration.MIGRATION } });
      expect(event.action.length).toBeLessThanOrEqual(96);
      expect(event.metadata.before).toBeDefined();
      expect(event.metadata.after).toBeDefined();
    }
    // The service rows are read FOR UPDATE and the cost mapping is locked before it is read.
    expect(locked).toEqual(['services', 'services', 'services', 'services']);
    expect(knex.raw).toHaveBeenCalledWith('LOCK TABLE service_product_usage IN SHARE ROW EXCLUSIVE MODE');
  });

  test('a second up changes nothing and records nothing', async () => {
    const { knex, db } = fakeKnex();
    await migration.up(knex);
    const afterUp = snapshot(db);
    mockRecordAuditEvent.mockClear();
    await migration.up(knex);
    expect(snapshot(db)).toEqual(afterUp);
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  test('down is a no-op: it never replaces what may be an admin\'s own value', async () => {
    const { knex, db } = fakeKnex();
    await migration.up(knex);
    const afterUp = snapshot(db);
    mockRecordAuditEvent.mockClear();
    await migration.down(knex);
    expect(snapshot(db)).toEqual(afterUp);
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  test('rows an admin already changed are left alone, each on its own', async () => {
    const { knex, db } = fakeKnex();
    db.services[0].default_products = ['Atticus Antapex WSG', 'Gentrol Complete EC3'];
    db.service_product_usage[0].usage_amount = '1.5000';
    await migration.up(knex);
    expect(db.services[0].default_products).toEqual(['Atticus Antapex WSG', 'Gentrol Complete EC3']);
    expect(db.service_product_usage[0]).toMatchObject({ product_id: 'gentrol', usage_amount: '1.5000' });
    // The untouched rows still move.
    expect(db.services[1].default_products).toEqual(migration.LIST_AFTER);
    expect(db.service_product_usage[1]).toMatchObject({ product_id: 'tekko', usage_amount: 2 });
  });

  test('an edit that lands between the read and the write wins: the checked values are in the UPDATE\'s WHERE, and no event is written', async () => {
    const adminList = ['Atticus Antapex WSG'];
    const { knex, db } = fakeKnex({
      beforeUpdate: (rows, table) => {
        if (table === 'services') rows.services[0].default_products = adminList;
        if (table === 'service_product_usage') rows.service_product_usage[0].notes = 'office note';
      },
    });
    await migration.up(knex);
    expect(db.services[0].default_products).toEqual(adminList);
    expect(db.service_product_usage[0]).toMatchObject({ product_id: 'gentrol', notes: 'office note' });
    const touched = mockRecordAuditEvent.mock.calls.map(([event]) => event.resource_id);
    expect(touched).not.toContain('s1');
    expect(touched).not.toContain('u1');
    const source = fs.readFileSync(path.join(__dirname, '../models/migrations/20261126130000_roach_growth_regulator_tekko.js'), 'utf8');
    expect(source).toContain(".where({ id: row.id, default_products: JSON.stringify(before) })");
    expect(source).toContain(".where({ id: row.id, product_id: found.gentrol.id, ...USAGE_BEFORE })");
    expect(migration.USAGE_BEFORE).toHaveProperty('usage_per_1000sf', null);
  });

  test('a cost row an admin gave a per-area amount keeps Gentrol, also when the edit lands between the read and the write', async () => {
    const before = fakeKnex();
    before.db.service_product_usage[0].usage_per_1000sf = '0.5000';
    await migration.up(before.knex);
    expect(before.db.service_product_usage[0]).toMatchObject({ product_id: 'gentrol', usage_amount: '1.0000', usage_per_1000sf: '0.5000' });
    expect(before.db.service_product_usage[1]).toMatchObject({ product_id: 'tekko', usage_amount: 2 });

    const racing = fakeKnex({ beforeUpdate: (rows, table) => { if (table === 'service_product_usage') rows.service_product_usage[0].usage_per_1000sf = '0.5000'; } });
    mockRecordAuditEvent.mockClear();
    await migration.up(racing.knex);
    expect(racing.db.service_product_usage[0]).toMatchObject({ product_id: 'gentrol', usage_per_1000sf: '0.5000' });
    expect(mockRecordAuditEvent.mock.calls.map(([event]) => event.resource_id)).not.toContain('u1');
  });

  test('a service type that already has a Tekko Pro cost row keeps its Gentrol row (no duplicate product)', async () => {
    const { knex, db } = fakeKnex();
    db.service_product_usage.push({ id: 'u5', service_type: 'Cockroach Treatment', product_id: 'tekko', usage_amount: '2.0000', usage_unit: 'oz', notes: 'added by hand' });
    await migration.up(knex);
    expect(db.service_product_usage.find((row) => row.id === 'u1').product_id).toBe('gentrol');
    expect(db.service_product_usage.find((row) => row.id === 'u2').product_id).toBe('tekko');
  });

  test('no single active Tekko Pro row, or no Gentrol row: nothing changes', async () => {
    for (const edit of [
      (db) => { db.products_catalog[0].active = false; },
      (db) => { db.products_catalog.push({ id: 'dup', name: 'Tekko Pro IGR', epa_reg_number: '53883-335', active: true, default_rate: '1', default_unit: 'fl_oz/gal' }); },
      (db) => { db.products_catalog = db.products_catalog.filter((row) => row.id !== 'gentrol'); },
    ]) {
      const { knex, db } = fakeKnex();
      edit(db);
      const start = snapshot(db);
      await migration.up(knex);
      expect(snapshot(db)).toEqual(start);
    }
  });

  test('default_products stored as a jsonb string (an encoded list) is kept and logged, never a silent no-op', async () => {
    const { knex, db } = fakeKnex();
    db.services[0].default_products = JSON.stringify(migration.LIST_BEFORE);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await migration.up(knex);
    expect(db.services[0].default_products).toBe(JSON.stringify(migration.LIST_BEFORE));
    expect(log.mock.calls.flat().join('\n')).toMatch(/service "cockroach_control" default_products is not the list read on 2026-11-26: kept/);
    expect(db.services[1].default_products).toEqual(migration.LIST_AFTER);
    log.mockRestore();
  });
});
