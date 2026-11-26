// 20261126170000: the mosquito services' default product lists move to the mosquito card (owner 2026-11-25, protocols pick D7):
// Suspend PolyZone + Tekko Pro IGR (+ the Bti dunk on the recurring plans). Each row is written only while it holds the value read
// from production, with the checked value in the UPDATE's own WHERE; down() is a documented no-op.
const mockRecordAuditEvent = jest.fn(async () => {});
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...args) => mockRecordAuditEvent(...args) }));

const migration = require('../models/migrations/20261126170000_mosquito_card_products.js');
const protocols = require('../config/protocols.json');

// jsonb by content, as Postgres compares it; a null WHERE value is IS NULL.
function columnEquals(key, stored, wanted) {
  if (key === 'default_products') return wanted === null ? stored === null : JSON.stringify(stored) === JSON.stringify(JSON.parse(wanted));
  return stored === wanted;
}

const BEFORE = Object.fromEntries(migration.SERVICE_LISTS.map(({ key, before }) => [key, before]));

// A small in-memory knex stand-in. `beforeUpdate` runs between a select and the next update, to play an admin edit in that window.
function fakeKnex({ beforeUpdate, catalog } = {}) {
  const db = {
    products_catalog: catalog || [
      { id: 'pz', name: 'Suspend Polyzone', epa_reg_number: '101563-143', active: true },
      { id: 'tekko', name: 'Tekko Pro IGR', epa_reg_number: '53883-335', active: true },
      { id: 'trio', name: 'Tekko Pro IGR', epa_reg_number: '53883-444', active: false },
      { id: 'dunk', name: 'Summit Mosquito Dunk Tablets', epa_reg_number: '6218-87', active: true },
    ],
    services: [
      ...migration.SERVICE_LISTS.map(({ key, before }, i) => ({ id: `s${i}`, service_key: key, default_products: before && [...before] })),
      // Not part of the move.
      { id: 'm1', service_key: 'mosquito_misting_service', default_products: null },
    ],
  };
  const knex = (table) => {
    const conds = [];
    const matched = () => db[table].filter((row) => conds.every((cond) => Object.entries(cond).every(([key, value]) => columnEquals(key, row[key], value))));
    const builder = {
      where(cond) { conds.push(cond); return builder; },
      select() {
        const rows = matched().map((row) => ({ ...row }));
        const promise = Promise.resolve(rows);
        promise.forUpdate = () => Promise.resolve(rows);
        return promise;
      },
      update(values) {
        if (beforeUpdate) beforeUpdate(db, table);
        const rows = matched();
        rows.forEach((row) => Object.assign(row, values, { default_products: JSON.parse(values.default_products) }));
        return Promise.resolve(rows.length);
      },
    };
    return builder;
  };
  knex.fn = { now: () => 'NOW()' };
  knex.schema = { hasTable: async () => true };
  return { knex, db };
}
const listOf = (db, key) => db.services.find((row) => row.service_key === key).default_products;

describe('20261126170000 mosquito card products', () => {
  beforeEach(() => { mockRecordAuditEvent.mockClear(); jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());

  test('moves the four lists read on 2026-11-26 (one of them empty) to the card, with one audit event each; the misting row stays', async () => {
    const { knex, db } = fakeKnex();
    await migration.up(knex);
    expect(Object.fromEntries(['mosquito_monthly', 'mosquito_seasonal', 'mosquito_event', 'mosquito_one_time', 'mosquito_misting_service'].map((key) => [key, listOf(db, key)]))).toEqual({
      mosquito_monthly: ['Suspend Polyzone', 'Tekko Pro IGR', 'Summit Mosquito Dunk Tablets'],
      mosquito_seasonal: ['Suspend Polyzone', 'Tekko Pro IGR', 'Summit Mosquito Dunk Tablets'],
      mosquito_event: ['Suspend Polyzone', 'Tekko Pro IGR', 'Summit Mosquito Dunk Tablets'],
      mosquito_one_time: ['Suspend Polyzone', 'Tekko Pro IGR'],
      mosquito_misting_service: null,
    });
    expect(mockRecordAuditEvent).toHaveBeenCalledTimes(4);
    expect(mockRecordAuditEvent.mock.calls[1][0]).toMatchObject({
      action: 'migration:20261126170000_mosquito_card_products:service_list', resource_type: 'services', resource_id: 's1', critical: true,
      metadata: { service_key: 'mosquito_seasonal', before: null, after: migration.RECURRING_AFTER },
    });
  });

  test('a second run changes nothing and writes no audit event', async () => {
    const { knex, db } = fakeKnex();
    await migration.up(knex);
    const after = JSON.stringify(db);
    mockRecordAuditEvent.mockClear();
    await migration.up(knex);
    expect(JSON.stringify(db)).toBe(after);
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  test('an admin edit, before the run or between the read and the write, wins', async () => {
    const edited = fakeKnex();
    edited.db.services[0].default_products = ['LESCO Crosscheck Plus'];
    await migration.up(edited.knex);
    expect(listOf(edited.db, 'mosquito_monthly')).toEqual(['LESCO Crosscheck Plus']);

    mockRecordAuditEvent.mockClear();
    // The edit lands while the seasonal row's update runs: after its read, before its write.
    const raced = fakeKnex({ beforeUpdate: (db) => { if (db.services[0].default_products[0] === 'Suspend Polyzone') db.services[1].default_products = ['Admin pick']; } });
    await migration.up(raced.knex);
    expect(listOf(raced.db, 'mosquito_seasonal')).toEqual(['Admin pick']);
    expect(mockRecordAuditEvent.mock.calls.map(([event]) => event.metadata.service_key)).not.toContain('mosquito_seasonal');
  });

  test('a product the active catalog cannot resolve to one row changes nothing', async () => {
    for (const catalog of [
      [{ id: 'tekko', name: 'Tekko Pro IGR', epa_reg_number: '53883-335', active: true }, { id: 'dunk', name: 'Summit Mosquito Dunk Tablets', active: true }],
      [{ id: 'pz', name: 'Suspend Polyzone', active: true }, { id: 'trio', name: 'Tekko Pro IGR', epa_reg_number: '53883-444', active: true }, { id: 'dunk', name: 'Summit Mosquito Dunk Tablets', active: true }],
      // Both Tekko Pro registrations active under one name: the lists would store a name the close-out cannot resolve.
      [{ id: 'pz', name: 'Suspend Polyzone', active: true }, { id: 'tekko', name: 'Tekko Pro IGR', epa_reg_number: '53883-335', active: true }, { id: 'trio', name: 'Tekko Pro IGR', epa_reg_number: '53883-444', active: true }, { id: 'dunk', name: 'Summit Mosquito Dunk Tablets', active: true }],
    ]) {
      const { knex, db } = fakeKnex({ catalog });
      await migration.up(knex);
      for (const { key } of migration.SERVICE_LISTS) expect(listOf(db, key)).toEqual(BEFORE[key]);
    }
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  test('down() is a no-op', async () => {
    const { knex, db } = fakeKnex();
    await migration.up(knex);
    const after = JSON.stringify(db);
    await migration.down(knex);
    expect(JSON.stringify(db)).toBe(after);
  });

  test('every product the lists write is a product the mosquito card names', () => {
    const named = new Set(protocols.mosquito.visits.flatMap((visit) => Object.values(visit.lineMeta || {}).flatMap((meta) => meta.catalogProductHints || [])));
    for (const name of new Set([...migration.RECURRING_AFTER, ...migration.EVENT_AFTER])) expect(named).toContain(name);
  });
});
