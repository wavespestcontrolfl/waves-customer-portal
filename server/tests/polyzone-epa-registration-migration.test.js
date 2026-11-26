// 20261126170100: the Suspend PolyZone catalog row's EPA registration moves from 432-1514 to 101563-143 (the number the mosquito
// card's label rate names), only on a row that still holds 432-1514; production already holds 101563-143.
const mockRecordAuditEvent = jest.fn(async () => {});
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...args) => mockRecordAuditEvent(...args) }));

const migration = require('../models/migrations/20261126170100_polyzone_epa_registration.js');
const protocols = require('../config/protocols.json');
const { labelUseRate } = require('../utils/protocol-label-rate');

function fakeKnex(rows, { beforeUpdate } = {}) {
  const db = { products_catalog: rows.map((row) => ({ ...row })) };
  const knex = (table) => {
    const conds = [];
    const matched = () => db[table].filter((row) => conds.every((cond) => Object.entries(cond).every(([key, value]) => row[key] === value)));
    const builder = {
      where(cond) { conds.push(cond); return builder; },
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
const seeded = { id: 'pz', name: 'Suspend Polyzone', active: true, epa_reg_number: '432-1514', default_rate: '0.25-1.5', default_unit: 'fl_oz/gal' };

describe('20261126170100 Suspend PolyZone EPA registration', () => {
  beforeEach(() => { mockRecordAuditEvent.mockClear(); jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());

  test('a migration-built row moves to 101563-143 with one audit event; the card line then gets its label rate', async () => {
    const polyzoneLine = Object.values(protocols.mosquito.visits[0].lineMeta).find((meta) => meta.catalogProductHints?.includes('Suspend Polyzone'));
    expect(labelUseRate(polyzoneLine, seeded)).toBeNull();
    const { knex, db } = fakeKnex([seeded]);
    await migration.up(knex);
    expect(db.products_catalog[0].epa_reg_number).toBe('101563-143');
    expect(labelUseRate(polyzoneLine, db.products_catalog[0])).toMatchObject({ amount: 1.1, unit: 'fl_oz' });
    expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
    const [event] = mockRecordAuditEvent.mock.calls[0];
    expect(event).toMatchObject({ action: 'migration:20261126170100_polyzone_epa_registration:catalog_row', resource_id: 'pz', critical: true, metadata: { before: { epa_reg_number: '432-1514' }, after: { epa_reg_number: '101563-143' } } });
    expect(event.action.length).toBeLessThanOrEqual(96);
  });

  test('production (already 101563-143), an admin edit in the window, and two active rows are all kept', async () => {
    for (const rows of [
      [{ ...seeded, epa_reg_number: '101563-143' }],
      [seeded, { ...seeded, id: 'pz2' }],
    ]) {
      const { knex, db } = fakeKnex(rows);
      await migration.up(knex);
      expect(db.products_catalog.map((row) => row.epa_reg_number)).toEqual(rows.map((row) => row.epa_reg_number));
    }
    const raced = fakeKnex([seeded], { beforeUpdate: (db) => { db.products_catalog[0].epa_reg_number = '999-1'; } });
    await migration.up(raced.knex);
    expect(raced.db.products_catalog[0].epa_reg_number).toBe('999-1');
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  test('a second run and down() change nothing', async () => {
    const { knex, db } = fakeKnex([seeded]);
    await migration.up(knex);
    const after = JSON.stringify(db);
    await migration.up(knex);
    await migration.down(knex);
    expect(JSON.stringify(db)).toBe(after);
    expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
  });
});
