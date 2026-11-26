// 20261127120000: the service library's bed bug and flea product data moves to the cards' own products (default product lists,
// and the flea cost mapping). Each step writes a row only while it holds the value read from production, with the checked
// values in the UPDATE's own WHERE; down() is a documented no-op.
const mockRecordAuditEvent = jest.fn(async () => {});
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...args) => mockRecordAuditEvent(...args) }));

const fs = require('fs');
const path = require('path');
const migration = require('../models/migrations/20261127120000_bed_bug_flea_service_products.js');
const protocols = require('../config/protocols.json');
const { usageOncePerPackage } = require('../services/product-costing');

const NUMERIC = new Set(['usage_amount', 'usage_per_1000sf']);
// A column against a WHERE value, the way Postgres compares them: jsonb by content, numeric by number, null as IS NULL.
function columnEquals(key, stored, wanted) {
  if (wanted === null) return stored == null;
  if (key === 'default_products') return stored != null && JSON.stringify(stored) === JSON.stringify(JSON.parse(wanted));
  if (NUMERIC.has(key)) return stored != null && Number(stored) === Number(wanted);
  return stored === wanted;
}

const [BED_BUG, FLEA] = migration.SERVICE_LISTS;

// A small in-memory knex stand-in: each table is an array of rows. `beforeUpdate` runs between a select and the next update, to
// play an admin edit that lands in that window.
function fakeKnex({ beforeUpdate } = {}) {
  const db = {
    products_catalog: [
      { id: 'antapex', name: 'Atticus Antapex WSG', epa_reg_number: '91234-401', active: true },
      { id: 'tekko', name: 'Tekko Pro IGR', epa_reg_number: '53883-335', active: true },
      // The inactive row of the same name holds another product's data.
      { id: 'trio', name: 'Tekko Pro IGR', epa_reg_number: '53883-444', active: false },
      { id: 'crossfire', name: 'MGK Crossfire Bed Bug Concentrate', epa_reg_number: '1021-2776', active: true },
      { id: 'demand', name: 'Demand CS', epa_reg_number: '100-1066', active: true },
      { id: 'demand-old', name: 'Demand CS Insecticide', epa_reg_number: '100-1066', active: false },
    ],
    services: [
      { id: 's1', service_key: 'bed_bug_treatment', default_products: [...BED_BUG.before] },
      { id: 's2', service_key: 'flea_tick', default_products: null },
      { id: 's3', service_key: 'cockroach_control', default_products: ['Atticus Antapex WSG', 'Tekko Pro IGR'] },
    ],
    service_product_usage: [
      { id: 'u1', service_type: 'Flea Treatment', product_id: 'demand', ...migration.USAGE_BEFORE, usage_amount: '2.0000', usage_per_1000sf: '0.5000', is_primary: true },
      { id: 'u2', service_type: 'Quarterly Pest Control', product_id: 'demand', usage_amount: '2.0000', usage_unit: 'oz', usage_per_1000sf: '0.5000', notes: 'Interior + exterior broadcast', is_primary: true },
    ],
  };
  const locked = [];
  let nextId = 1;
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
      insert(values) {
        const row = { id: `new-${nextId++}`, ...values };
        db[table].push(row);
        return { returning: async () => [{ id: row.id }] };
      },
    };
    return builder;
  };
  knex.fn = { now: () => 'NOW()' };
  knex.schema = { hasTable: async () => true, hasColumn: async () => true };
  knex.raw = jest.fn(async () => ({}));
  return { knex, db, locked };
}
// Rows compared by value: no timestamps, and numeric(10,4) text as a number.
const snapshot = (db) => JSON.parse(JSON.stringify(db, (key, value) => {
  if (key === 'updated_at') return undefined;
  return NUMERIC.has(key) && value != null ? Number(value) : value;
}));

describe('20261127120000 bed bug and flea service products', () => {
  let log;
  beforeEach(() => { mockRecordAuditEvent.mockClear(); log = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { log.mockRestore(); });

  test('each list it writes is its card\'s own starting products, and the cost amounts are the flea card\'s rates', () => {
    const bedBug = protocols.bed_bug.visits.find((visit) => visit.visit === 2);
    const flea = protocols.flea.visits.find((visit) => visit.visit === 1);
    expect(BED_BUG.after).toEqual(bedBug.completionDefaultProducts);
    expect(FLEA.after).toEqual(flea.completionDefaultProducts);
    const rateOf = (name) => Object.values(flea.lineMeta).find((meta) => meta.catalogProductHints?.length === 1 && meta.catalogProductHints[0] === name);
    // Antapex 10 g per gallon and Tekko Pro 0.66 fl oz per gallon in one tank at 1 gallon per 1,000 sq ft.
    expect(rateOf('Atticus Antapex WSG').tankRatePerGallon).toEqual({ amount: 10, unit: 'g' });
    expect(rateOf('Tekko Pro IGR').labelRatePerGallon).toMatchObject({ amount: 0.66, unit: 'fl_oz', carrierGalPer1000: 1 });
    expect(migration.ANTAPEX_USAGE).toMatchObject({ usage_amount: 10, usage_unit: 'g', usage_per_1000sf: 10 });
    expect(migration.TEKKO_USAGE).toMatchObject({ usage_amount: 0.66, usage_unit: 'fl_oz', usage_per_1000sf: 0.66 });
    // Both go down at treatment 1 only: treatment 2's card lists neither, so the package is costed once.
    const second = protocols.flea.visits.find((visit) => visit.visit === 2);
    expect(JSON.stringify(second.lineMeta)).not.toMatch(/Antapex|Tekko/);
    expect(usageOncePerPackage(migration.ANTAPEX_USAGE)).toBe(true);
    expect(usageOncePerPackage(migration.TEKKO_USAGE)).toBe(true);
  });

  test('up moves the two service lists, points the flea cost row at Antapex and adds the Tekko Pro row; nothing else', async () => {
    const { knex, db, locked } = fakeKnex();
    const before = snapshot(db);
    await migration.up(knex);
    expect(snapshot(db).products_catalog).toEqual(before.products_catalog);
    expect(db.services.map((row) => row.default_products)).toEqual([BED_BUG.after, FLEA.after, ['Atticus Antapex WSG', 'Tekko Pro IGR']]);
    expect(db.service_product_usage.find((row) => row.id === 'u1')).toMatchObject({ product_id: 'antapex', ...migration.ANTAPEX_USAGE, is_primary: true });
    expect(snapshot(db).service_product_usage.find((row) => row.id === 'u2')).toEqual(before.service_product_usage[1]);
    const added = db.service_product_usage.filter((row) => !['u1', 'u2'].includes(row.id));
    expect(added).toEqual([{ id: 'new-1', service_type: 'Flea Treatment', product_id: 'tekko', ...migration.TEKKO_USAGE, is_primary: false }]);
    // One critical audit event per changed or added row, inside the migration's transaction, with an action that fits audit_log.action (96).
    const events = mockRecordAuditEvent.mock.calls.map(([event]) => event);
    expect(events.map((event) => [event.resource_type, event.resource_id]).sort()).toEqual([
      ['service_product_usage', 'new-1'], ['service_product_usage', 'u1'], ['services', 's1'], ['services', 's2'],
    ]);
    for (const event of events) {
      expect(event).toMatchObject({ actor_type: 'system', critical: true, trx: knex, metadata: { migration: migration.MIGRATION } });
      expect(event.action.length).toBeLessThanOrEqual(96);
      expect(event.metadata).toHaveProperty('before');
      expect(event.metadata.after).toBeDefined();
    }
    // The service rows are read FOR UPDATE and the cost mapping is locked before it is read.
    expect(locked).toEqual(['services', 'services']);
    expect(knex.raw).toHaveBeenCalledWith('LOCK TABLE service_product_usage IN SHARE ROW EXCLUSIVE MODE');
  });

  test('a second up changes nothing and records nothing; down is a no-op', async () => {
    const { knex, db } = fakeKnex();
    await migration.up(knex);
    const afterUp = snapshot(db);
    mockRecordAuditEvent.mockClear();
    await migration.up(knex);
    await migration.down(knex);
    expect(snapshot(db)).toEqual(afterUp);
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  test('a list an admin already changed is left alone, each service on its own', async () => {
    const { knex, db } = fakeKnex();
    db.services[0].default_products = ['Temprid FX'];
    db.services[1].default_products = [];
    await migration.up(knex);
    expect(db.services[0].default_products).toEqual(['Temprid FX']);
    // An empty list is an admin's own choice, not "no list".
    expect(db.services[1].default_products).toEqual([]);
    expect(log.mock.calls.flat().join('\n')).toMatch(/service "flea_tick" default_products is not the value read on 2026-11-26: kept/);
    // The cost mapping still moves.
    expect(db.service_product_usage[0].product_id).toBe('antapex');
  });

  test('an edit that lands between the read and the write wins: the checked values are in the UPDATE\'s WHERE, and nothing is added', async () => {
    const { knex, db } = fakeKnex({
      beforeUpdate: (rows, table) => {
        if (table === 'services') { rows.services[0].default_products = ['Temprid FX']; rows.services[1].default_products = ['Demand CS']; }
        if (table === 'service_product_usage') rows.service_product_usage[0].notes = 'office note';
      },
    });
    await migration.up(knex);
    expect(db.services[0].default_products).toEqual(['Temprid FX']);
    expect(db.services[1].default_products).toEqual(['Demand CS']);
    expect(db.service_product_usage[0]).toMatchObject({ product_id: 'demand', notes: 'office note' });
    // The Antapex row was not written, so its growth regulator row is not added either.
    expect(db.service_product_usage).toHaveLength(2);
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
    const source = fs.readFileSync(path.join(__dirname, '../models/migrations/20261127120000_bed_bug_flea_service_products.js'), 'utf8');
    expect(source).toContain(".where({ id: row.id, default_products: before ? JSON.stringify(before) : null })");
    expect(source).toContain(".where({ id: row.id, product_id: found.demand.id, ...USAGE_BEFORE })");
  });

  test('a flea cost mapping that is not the one row read (changed, or a row added) is kept whole', async () => {
    for (const edit of [
      (db) => { db.service_product_usage[0].usage_per_1000sf = '0.7500'; },
      (db) => { db.service_product_usage[0].usage_amount = '3.0000'; },
      (db) => { db.service_product_usage[0].product_id = 'antapex'; },
      (db) => { db.service_product_usage.push({ id: 'u9', service_type: 'Flea Treatment', product_id: 'tekko', usage_amount: '1.0000', usage_unit: 'fl_oz', usage_per_1000sf: null, notes: 'added by hand' }); },
      (db) => { db.service_product_usage = db.service_product_usage.filter((row) => row.id !== 'u1'); },
    ]) {
      const { knex, db } = fakeKnex();
      edit(db);
      const start = snapshot(db).service_product_usage;
      await migration.up(knex);
      expect(snapshot(db).service_product_usage).toEqual(start);
    }
  });

  test('no single active row of a product the migration names: nothing changes', async () => {
    for (const edit of [
      (db) => { db.products_catalog[0].active = false; },
      (db) => { db.products_catalog[1].epa_reg_number = '53883-999'; },
      (db) => { db.products_catalog.push({ id: 'dup', name: 'MGK Crossfire Bed Bug Concentrate', epa_reg_number: '1021-2776', active: true }); },
      // Two active rows of one name with different registration numbers: a list of names could not tell them apart.
      (db) => { db.products_catalog[2].active = true; },
      (db) => { db.products_catalog = db.products_catalog.filter((row) => row.id !== 'demand'); },
    ]) {
      const { knex, db } = fakeKnex();
      edit(db);
      const start = snapshot(db);
      await migration.up(knex);
      expect(snapshot(db)).toEqual(start);
      expect(mockRecordAuditEvent).not.toHaveBeenCalled();
    }
  });

  test('default_products stored as a jsonb string (an encoded list) is kept and logged, never a silent no-op', async () => {
    const { knex, db } = fakeKnex();
    db.services[0].default_products = JSON.stringify(BED_BUG.before);
    await migration.up(knex);
    expect(db.services[0].default_products).toBe(JSON.stringify(BED_BUG.before));
    expect(log.mock.calls.flat().join('\n')).toMatch(/service "bed_bug_treatment" default_products is not the value read on 2026-11-26: kept/);
    expect(db.services[1].default_products).toEqual(FLEA.after);
  });
});
