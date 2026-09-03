/**
 * supplies-consumption.js — per-completion consumables.
 *
 * Unit contract (mocked db):
 *   - incomplete visit → nothing read, nothing written
 *   - a consumable with a count → one usage movement + decrement
 *   - a duplicate (movement insert ignored by the partial unique index) →
 *     NO decrement (resume-path idempotency)
 *   - no inventory_on_hand → skipped, no movement
 *   - a thrown error is contained (never rejects)
 *
 * DB-backed contract (self-skips without DATABASE_URL, after migrate:latest):
 *   - the auto-reorder columns and the partial unique expression index
 *     exist, and the index rejects a second completion_consumable movement
 *     for the same (product, visit).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { consumeCompletionSupplies } = require('../services/supplies-consumption');

function fakeDb({ products, duplicate = false, throwOnInsert = false }) {
  const updates = [];
  const inserts = [];
  const trx = (table) => {
    const q = {};
    q.where = () => q;
    q.forUpdate = () => q;
    q.first = async () => products.find((p) => p.id === q._id) || products[0];
    q.update = async (row) => { updates.push({ table, row }); return 1; };
    q.insert = (row) => ({
      onConflict: () => ({
        ignore: () => ({
          returning: async () => {
            if (throwOnInsert) throw new Error('insert boom');
            inserts.push(row);
            return duplicate ? [] : [{ id: 'mv-1' }];
          },
        }),
      }),
    });
    return q;
  };
  trx.raw = (s) => s;
  const db = (table) => {
    const q = {};
    for (const m of ['whereNotNull', 'where']) q[m] = () => q;
    q.select = async () => products;
    return q;
  };
  db.transaction = async (fn) => fn(trx);
  db.raw = (s) => s;
  return { db, updates, inserts };
}

const sign = { id: 'prod-sign', name: 'Sign card', per_completion_usage: '1', inventory_on_hand: '640', inventory_unit: 'each' };
const args = { scheduledServiceId: 'svc-1', serviceRecordId: 'rec-1', customerId: 'cust-1', technicianId: 'tech-1' };

test('incomplete visit → skipped before any read', async () => {
  const selectSpy = jest.fn();
  const db = () => ({ whereNotNull: () => ({ where: () => ({ select: selectSpy }) }) });
  const res = await consumeCompletionSupplies(db, { ...args, isIncompleteVisit: true });
  expect(res.skipped).toEqual([{ reason: 'incomplete_visit' }]);
  expect(selectSpy).not.toHaveBeenCalled();
});

test('consumable with a count → one usage movement and a decrement', async () => {
  const { db, updates, inserts } = fakeDb({ products: [sign] });
  const res = await consumeCompletionSupplies(db, args);
  expect(res.consumed).toEqual([{ productId: 'prod-sign', name: 'Sign card', usage: 1, unit: 'each', before: 640, after: 639 }]);
  expect(inserts).toHaveLength(1);
  expect(inserts[0]).toMatchObject({ scheduled_service_id: 'svc-1', movement_type: 'usage', quantity: 1, stock_before: 640, stock_after: 639, metadata: { source: 'completion_consumable' } });
  expect(updates).toEqual([{ table: 'products_catalog', row: expect.objectContaining({ inventory_on_hand: 639 }) }]);
});

test('duplicate (index ignored the insert) → no decrement', async () => {
  const { db, updates } = fakeDb({ products: [sign], duplicate: true });
  const res = await consumeCompletionSupplies(db, args);
  expect(res.consumed).toHaveLength(0);
  expect(res.skipped).toEqual([{ productId: 'prod-sign', reason: 'already_consumed' }]);
  expect(updates).toHaveLength(0);
});

test('no inventory_on_hand → skipped, no movement', async () => {
  const { db, updates, inserts } = fakeDb({ products: [{ ...sign, inventory_on_hand: null }] });
  const res = await consumeCompletionSupplies(db, args);
  expect(res.skipped).toEqual([{ productId: 'prod-sign', reason: 'no_on_hand' }]);
  expect(inserts).toHaveLength(0);
  expect(updates).toHaveLength(0);
});

test('a thrown error is contained', async () => {
  const { db } = fakeDb({ products: [sign], throwOnInsert: true });
  await expect(consumeCompletionSupplies(db, args)).resolves.toMatchObject({ errors: [{ productId: 'prod-sign', message: 'insert boom' }] });
});

const path = require('path');
const describeOrSkip = process.env.DATABASE_URL ? describe : describe.skip;
describeOrSkip('supplies auto-reorder schema (DB-backed)', () => {
  let knex;
  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
  });
  afterAll(async () => { if (knex) await knex.destroy(); });

  test('products_catalog gains the auto-reorder columns', async () => {
    const cols = await knex('products_catalog').columnInfo();
    ['reorder_quantity', 'auto_reorder_vendor_id', 'auto_reorder_enabled', 'per_completion_usage'].forEach((c) => expect(cols).toHaveProperty(c));
    expect(cols.auto_reorder_enabled.nullable).toBe(false);
  });

  test('one live auto_reorder restock request per product is a DB invariant', async () => {
    const idx = await knex('pg_indexes').where({ indexname: 'product_restock_requests_auto_reorder_live_uniq' }).first();
    expect(idx).toBeTruthy();
    expect(idx.indexdef).toMatch(/UNIQUE/);
    const [product] = await knex('products_catalog').insert({ name: `__test reorder ${Date.now()}`, category: 'supplies', inventory_unit: 'each', inventory_on_hand: 5, needs_pricing: false }).returning('id');
    try {
      const row = { product_id: product.id, status: 'open', source: 'auto_reorder', requested_quantity: 1, unit: 'each' };
      await knex('product_restock_requests').insert(row);
      await expect(knex('product_restock_requests').insert(row)).rejects.toMatchObject({ code: '23505' });
      await knex('product_restock_requests').insert({ ...row, source: 'manual' }); // other sources are not constrained
      await knex('product_restock_requests').insert({ ...row, status: 'received' }); // closed rows are not constrained
    } finally {
      await knex('product_restock_requests').where({ product_id: product.id }).del();
      await knex('products_catalog').where({ id: product.id }).del();
    }
  });

  test('the completion_consumable partial unique index exists and rejects a duplicate', async () => {
    const idx = await knex('pg_indexes').where({ indexname: 'product_inventory_movements_completion_consumable_uniq' }).first();
    expect(idx).toBeTruthy();
    expect(idx.indexdef).toMatch(/UNIQUE/);
    expect(idx.indexdef).toMatch(/completion_consumable/);

    const visit = await knex('scheduled_services').select('id').first();
    if (!visit) return; // empty local DB: the index shape above is still proven
    const [product] = await knex('products_catalog').insert({ name: `__test consumable ${Date.now()}`, category: 'supplies', inventory_unit: 'each', inventory_on_hand: 5, needs_pricing: false }).returning('id');
    try {
      const row = { product_id: product.id, scheduled_service_id: visit.id, movement_type: 'usage', quantity: 1, unit: 'each', metadata: { source: 'completion_consumable' } };
      await knex('product_inventory_movements').insert(row);
      await expect(knex('product_inventory_movements').insert(row)).rejects.toMatchObject({ code: '23505' });
      // a different source for the same pair is NOT blocked (partial predicate)
      await knex('product_inventory_movements').insert({ ...row, metadata: { source: 'other' } });
    } finally {
      await knex('product_inventory_movements').where({ product_id: product.id }).del();
      await knex('products_catalog').where({ id: product.id }).del();
    }
  });
});
