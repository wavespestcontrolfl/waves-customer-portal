// 20261126180000: the Victor snap trap's catalog unit becomes "each" (it had none, so the close-out logged traps in "oz"), only on the one
// active row whose unit is still empty.
const mockRecordAuditEvent = jest.fn(async () => {});
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...args) => mockRecordAuditEvent(...args) }));

const migration = require('../models/migrations/20261126180000_victor_trap_count_unit.js');

function fakeKnex(rows, { beforeUpdate } = {}) {
  const db = { products_catalog: rows.map((row) => ({ ...row })) };
  const knex = (table) => {
    const conds = [];
    const matched = () => db[table].filter((row) => conds.every((cond) => Object.entries(cond).every(([key, value]) => (value === null ? row[key] == null : row[key] === value))));
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
// The row as production holds it (read 2026-11-26).
const live = { id: 'v', name: 'Victor Expanded Trigger Rat Snap Trap', active: true, default_unit: null, category: 'rodent_trap' };

describe('20261126180000 Victor snap trap counted in "each"', () => {
  beforeEach(() => { mockRecordAuditEvent.mockClear(); jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());

  test('the unit-less row gets "each" with one critical audit event', async () => {
    const { knex, db } = fakeKnex([live, { ...live, id: 'old', active: false }]);
    await migration.up(knex);
    expect(db.products_catalog.map((row) => [row.id, row.default_unit])).toEqual([['v', 'each'], ['old', null]]);
    expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
    const [event] = mockRecordAuditEvent.mock.calls[0];
    expect(event).toMatchObject({ action: 'migration:20261126180000_victor_trap_count_unit:catalog_row', resource_id: 'v', critical: true, metadata: { before: { default_unit: null }, after: { default_unit: 'each' } } });
    expect(event.action.length).toBeLessThanOrEqual(96);
  });

  test('a unit already set, two active rows, and an admin edit in the window are all kept', async () => {
    for (const rows of [[{ ...live, default_unit: 'trap' }], [live, { ...live, id: 'v2' }]]) {
      const { knex, db } = fakeKnex(rows);
      await migration.up(knex);
      expect(db.products_catalog.map((row) => row.default_unit)).toEqual(rows.map((row) => row.default_unit));
    }
    const raced = fakeKnex([live], { beforeUpdate: (db) => { db.products_catalog[0].default_unit = 'trap'; } });
    await migration.up(raced.knex);
    expect(raced.db.products_catalog[0].default_unit).toBe('trap');
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  test('a second run and down() change nothing', async () => {
    const { knex, db } = fakeKnex([live]);
    await migration.up(knex);
    const after = JSON.stringify(db);
    await migration.up(knex);
    await migration.down(knex);
    expect(JSON.stringify(db)).toBe(after);
    expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
  });
});
