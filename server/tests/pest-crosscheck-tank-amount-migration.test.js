// 20261126220000: the three regular pest cost rows for LESCO Crosscheck Plus go from 4 fl_oz to 2.5 fl_oz, the amount the close-out
// house mix records (client/src/lib/pest-default-mix.js), only while a row still holds 4 fl_oz.
const mockRecordAuditEvent = jest.fn(async () => {});
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...args) => mockRecordAuditEvent(...args) }));

const fs = require('fs');
const path = require('path');
const migration = require('../models/migrations/20261126220000_pest_crosscheck_tank_amount.js');

const same = (rowValue, value) => (typeof value === 'number' ? Number(rowValue) === value : rowValue === value);
function fakeKnex(tables, { beforeUpdate } = {}) {
  const db = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
  const knex = (table) => {
    const tests = [];
    const matched = () => db[table].filter((row) => tests.every((test) => test(row)));
    const builder = {
      where(cond) { tests.push((row) => Object.entries(cond).every(([key, value]) => same(row[key], value))); return builder; },
      whereIn(key, values) { tests.push((row) => values.includes(row[key])); return builder; },
      select() {
        const found = matched().map((row) => ({ ...row }));
        const promise = Promise.resolve(found);
        promise.forUpdate = () => Promise.resolve(found);
        return promise;
      },
      update(values) {
        if (beforeUpdate) beforeUpdate(db);
        const hit = matched();
        hit.forEach((row) => Object.assign(row, values));
        return Promise.resolve(hit.length);
      },
    };
    return builder;
  };
  knex.fn = { now: () => 'NOW()' };
  knex.schema = { hasTable: async () => true };
  return { knex, db };
}
// The rows as production holds them (read 2026-11-26): numeric columns arrive as strings.
const live = () => ({
  products_catalog: [{ id: 'cc', name: 'LESCO Crosscheck Plus', active: true }, { id: 'tau', name: 'Taurus SC', active: true }],
  service_product_usage: [
    { id: 'q', service_type: 'Quarterly Pest Control', product_id: 'cc', usage_amount: '4.0000', usage_unit: 'fl_oz' },
    { id: 'b', service_type: 'Bi-Monthly Pest Control', product_id: 'cc', usage_amount: '4.0000', usage_unit: 'fl_oz' },
    { id: 'g', service_type: 'General Pest Perimeter', product_id: 'cc', usage_amount: '4.0000', usage_unit: 'fl_oz' },
    { id: 'm', service_type: 'Mosquito Treatment - Essential Barrier', product_id: 'cc', usage_amount: '3.0000', usage_unit: 'oz' },
    { id: 't', service_type: 'Quarterly Pest Control', product_id: 'tau', usage_amount: '1.6000', usage_unit: 'fl_oz' },
  ],
});
const amounts = (db) => db.service_product_usage.map((row) => [row.id, Number(row.usage_amount)]);

describe('20261126220000 regular pest Crosscheck cost rows at the tank amount', () => {
  beforeEach(() => { mockRecordAuditEvent.mockClear(); jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());

  test('the three regular pest rows become 2.5 fl_oz, each with one critical audit event; mosquito and Taurus rows stay', async () => {
    const { knex, db } = fakeKnex(live());
    await migration.up(knex);
    expect(amounts(db)).toEqual([['q', 2.5], ['b', 2.5], ['g', 2.5], ['m', 3], ['t', 1.6]]);
    expect(mockRecordAuditEvent).toHaveBeenCalledTimes(3);
    const [event] = mockRecordAuditEvent.mock.calls[0];
    expect(event).toMatchObject({
      action: 'migration:20261126220000_pest_crosscheck_tank_amount:usage', resource_type: 'service_product_usage', resource_id: 'q', critical: true,
      metadata: { service_type: 'Quarterly Pest Control', before: { usage_amount: 4, usage_unit: 'fl_oz' }, after: { usage_amount: 2.5, usage_unit: 'fl_oz' } },
    });
    expect(event.action.length).toBeLessThanOrEqual(96);
  });

  test('an amount the office already changed, a second catalog row, and an edit in the window are all kept', async () => {
    const edited = live();
    edited.service_product_usage[0].usage_amount = '3.0000';
    const first = fakeKnex(edited);
    await migration.up(first.knex);
    expect(amounts(first.db).slice(0, 3)).toEqual([['q', 3], ['b', 2.5], ['g', 2.5]]);

    mockRecordAuditEvent.mockClear();
    const twoRows = live();
    twoRows.products_catalog.push({ id: 'cc2', name: 'LESCO Crosscheck Plus', active: true });
    const second = fakeKnex(twoRows);
    await migration.up(second.knex);
    expect(amounts(second.db).slice(0, 3)).toEqual([['q', 4], ['b', 4], ['g', 4]]);

    const raced = fakeKnex(live(), { beforeUpdate: (db) => { db.service_product_usage.forEach((row) => { if (row.product_id === 'cc') row.usage_amount = '2.0000'; }); } });
    await migration.up(raced.knex);
    expect(amounts(raced.db).slice(0, 3)).toEqual([['q', 2], ['b', 2], ['g', 2]]);
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  test('a second run and down() change nothing', async () => {
    const { knex, db } = fakeKnex(live());
    await migration.up(knex);
    const after = JSON.stringify(db);
    await migration.up(knex);
    await migration.down(knex);
    expect(JSON.stringify(db)).toBe(after);
    expect(mockRecordAuditEvent).toHaveBeenCalledTimes(3);
  });

  test('the amount written is the close-out house mix amount the client carries', () => {
    // The client module is ESM, so the total is read from its source.
    const mix = fs.readFileSync(path.join(__dirname, '../../client/src/lib/pest-default-mix.js'), 'utf8');
    const crosscheck = mix.match(/pattern: \/\^lesco[^,]+\/i, totalAmount: ([\d.]+)/);
    expect(Number(crosscheck[1])).toBe(migration.AMOUNT_AFTER);
  });
});
