/**
 * supplies-consumption.js — per-completion consumables.
 *
 * Unit contract (mocked db):
 *   - GATE_AUTO_REORDER unset → nothing read, nothing written (dark)
 *   - incomplete visit → nothing read, nothing written
 *   - a consumable with a count → one usage movement + decrement
 *   - a duplicate (movement insert ignored by the partial unique index) →
 *     NO decrement (resume-path idempotency)
 *   - a line-scoped product is consumed only on a listed service line;
 *     null = every line; no resolvable line → not consumed
 *   - no inventory_on_hand → skipped, no movement
 *   - a thrown error is contained (never rejects)
 *
 * DB-backed contract (self-skips without DATABASE_URL, after migrate:latest):
 *   - the auto-reorder columns and the partial unique expression index
 *     exist, and the index rejects a second completion_consumable movement
 *     for the same (product, visit).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const { consumeCompletionSupplies, appliesToLine } = require('../services/supplies-consumption');
const { notifyAdmin } = require('../services/notification-service');

function fakeDb({ products, duplicate = false, throwOnInsert = false, techLogged = false }) {
  const updates = [];
  const inserts = [];
  const trx = (table) => {
    const q = {};
    q.where = () => q;
    q.whereRaw = () => q;
    q.forUpdate = () => q;
    q.first = async () => (table === 'product_inventory_movements' ? (techLogged ? { id: 'mv-tech' } : null) : products[0]);
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

// The hook shares the lane's kill switch with the sweep: on for the contract
// below; one test proves unset = nothing read.
beforeAll(() => { process.env.GATE_AUTO_REORDER = 'true'; });
afterAll(() => { delete process.env.GATE_AUTO_REORDER; });

test('GATE_AUTO_REORDER unset → skipped before any read (PR ships dark end to end — GH codex r6 P1)', async () => {
  delete process.env.GATE_AUTO_REORDER;
  try {
    const selectSpy = jest.fn();
    const db = () => ({ where: () => ({ whereNotNull: () => ({ where: () => ({ select: selectSpy }) }) }) });
    const res = await consumeCompletionSupplies(db, args);
    expect(res.skipped).toEqual([{ reason: 'gated' }]);
    expect(selectSpy).not.toHaveBeenCalled();
  } finally { process.env.GATE_AUTO_REORDER = 'true'; }
});

test('incomplete visit → skipped before any read', async () => {
  const selectSpy = jest.fn();
  const db = () => ({ where: () => ({ whereNotNull: () => ({ where: () => ({ select: selectSpy }) }) }) });
  const res = await consumeCompletionSupplies(db, { ...args, isIncompleteVisit: true });
  expect(res.skipped).toEqual([{ reason: 'incomplete_visit' }]);
  expect(selectSpy).not.toHaveBeenCalled();
});

test('inspection_only / customer_declined closeout (visitPerformed=false) → skipped before any read', async () => {
  const selectSpy = jest.fn();
  const db = () => ({ where: () => ({ whereNotNull: () => ({ where: () => ({ select: selectSpy }) }) }) });
  const res = await consumeCompletionSupplies(db, { ...args, visitPerformed: false });
  expect(res.skipped).toEqual([{ reason: 'visit_not_performed' }]);
  expect(selectSpy).not.toHaveBeenCalled();
});

test('an inspection service completed normally consumes nothing (no application, no sign)', async () => {
  const { db, inserts } = fakeDb({ products: [sign] });
  const res = await consumeCompletionSupplies(db, { ...args, serviceType: 'Pest Inspection Service' });
  expect(res.skipped).toEqual([{ reason: 'inspection_service' }]);
  expect(inserts).toHaveLength(0);
});

test('a product retired between the scan and the lock is not deducted', async () => {
  const { db, inserts } = fakeDb({ products: [{ ...sign, active: false }] });
  const res = await consumeCompletionSupplies(db, args);
  expect(inserts).toHaveLength(0);
  expect(res.skipped).toEqual([{ productId: 'prod-sign', reason: 'retired' }]);
});

test('a service-line scope set between the scan and the lock is honored', async () => {
  const { db, inserts } = fakeDb({ products: [{ ...sign, per_completion_service_lines: '["lawn"]' }] });
  const res = await consumeCompletionSupplies(db, { ...args, serviceLine: 'pest' });
  expect(inserts).toHaveLength(0);
  expect(res.skipped).toEqual([{ productId: 'prod-sign', reason: 'service_line_excluded' }]);
});

test('an internal-only completion profile (Waves Assessment) consumes nothing even though its name reads as pest (Codex r9 P2)', async () => {
  const { db, inserts } = fakeDb({ products: [sign] });
  const res = await consumeCompletionSupplies(db, { ...args, serviceType: 'Waves Assessment', isInternalOnlyCompletion: true });
  expect(res.skipped).toEqual([{ reason: 'internal_only_completion' }]);
  expect(inserts).toHaveLength(0);
});

test('a treatment service type is not an inspection', async () => {
  const { db, inserts } = fakeDb({ products: [sign] });
  await consumeCompletionSupplies(db, { ...args, serviceType: 'Quarterly Pest Control' });
  expect(inserts).toHaveLength(1);
});

test('consumable with a count → one usage movement and a decrement', async () => {
  const { db, updates, inserts } = fakeDb({ products: [sign] });
  const res = await consumeCompletionSupplies(db, args);
  expect(res.consumed).toEqual([{ productId: 'prod-sign', name: 'Sign card', usage: 1, unit: 'each', before: 640, after: 639, costUsed: null }]);
  expect(inserts).toHaveLength(1);
  expect(inserts[0]).toMatchObject({ scheduled_service_id: 'svc-1', movement_type: 'usage', quantity: 1, stock_before: 640, stock_after: 639, metadata: { source: 'completion_consumable' } });
  expect(updates).toEqual([{ table: 'products_catalog', row: expect.objectContaining({ inventory_on_hand: 639 }) }]);
});

test('a kit item the tech logged in the picker is not consumed again', async () => {
  const { db, updates, inserts } = fakeDb({ products: [sign], techLogged: true });
  const res = await consumeCompletionSupplies(db, args);
  expect(res.skipped).toEqual([{ productId: 'prod-sign', reason: 'already_logged_by_tech' }]);
  expect(inserts).toHaveLength(0);
  expect(updates).toHaveLength(0);
});

test('movement carries unit_cost / cost_used from cost_per_unit in the inventory unit', async () => {
  const { db, inserts } = fakeDb({ products: [{ ...sign, cost_per_unit: '0.5356', cost_unit: 'each' }] });
  const res = await consumeCompletionSupplies(db, args);
  expect(inserts[0]).toMatchObject({ unit_cost: 0.5356, cost_used: 0.5356 });
  expect(res.consumed[0].costUsed).toBe(0.5356);
  const mismatch = fakeDb({ products: [{ ...sign, cost_per_unit: '12', cost_unit: 'gal' }] });
  await consumeCompletionSupplies(mismatch.db, args);
  expect(mismatch.inserts).toHaveLength(1);
  expect(mismatch.inserts[0]).toMatchObject({ unit_cost: null, cost_used: null });
});

test('duplicate (index ignored the insert) → no decrement', async () => {
  const { db, updates } = fakeDb({ products: [sign], duplicate: true });
  const res = await consumeCompletionSupplies(db, args);
  expect(res.consumed).toHaveLength(0);
  expect(res.skipped).toEqual([{ productId: 'prod-sign', reason: 'already_consumed' }]);
  expect(updates).toHaveLength(0);
});

describe('service-line scope', () => {
  const scoped = { ...sign, per_completion_service_lines: ['pest', 'mosquito', 'lawn', 'tree_shrub'] };

  test('appliesToLine: null = every line; jsonb string or array both parse; unknown line excluded', () => {
    expect(appliesToLine(null, 'termite')).toBe(true);
    expect(appliesToLine(['pest'], 'pest')).toBe(true);
    expect(appliesToLine(JSON.stringify(['pest']), 'pest')).toBe(true);
    expect(appliesToLine(['pest'], 'termite')).toBe(false);
    expect(appliesToLine(['pest'], null)).toBe(false);
    expect(appliesToLine('not json', 'termite')).toBe(true);
  });

  test('a pest visit consumes the kit item', async () => {
    const { db, inserts } = fakeDb({ products: [scoped] });
    const res = await consumeCompletionSupplies(db, { ...args, serviceLine: 'pest' });
    expect(res.consumed).toHaveLength(1);
    expect(inserts).toHaveLength(1);
  });

  test('a termite visit does not consume a pest/mosquito/lawn/tree_shrub item — no movement, no decrement', async () => {
    const { db, inserts, updates } = fakeDb({ products: [scoped] });
    const res = await consumeCompletionSupplies(db, { ...args, serviceLine: 'termite' });
    expect(res.consumed).toHaveLength(0);
    expect(res.skipped).toEqual([{ productId: 'prod-sign', reason: 'service_line_excluded' }]);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  test('an unscoped product is consumed on any line', async () => {
    const { db } = fakeDb({ products: [{ ...sign, per_completion_service_lines: null }] });
    const res = await consumeCompletionSupplies(db, { ...args, serviceLine: 'rodent' });
    expect(res.consumed).toHaveLength(1);
  });
});

test('no inventory_on_hand → skipped, no movement', async () => {
  const { db, updates, inserts } = fakeDb({ products: [{ ...sign, inventory_on_hand: null }] });
  const res = await consumeCompletionSupplies(db, args);
  expect(res.skipped).toEqual([{ productId: 'prod-sign', reason: 'no_on_hand' }]);
  expect(inserts).toHaveLength(0);
  expect(updates).toHaveLength(0);
});

test('a thrown error is contained — and rings ONE deduped bell so the miss is not silent', async () => {
  notifyAdmin.mockClear();
  const { db } = fakeDb({ products: [sign], throwOnInsert: true });
  await expect(consumeCompletionSupplies(db, args)).resolves.toMatchObject({ errors: [{ productId: 'prod-sign', message: 'insert boom' }] });
  expect(notifyAdmin).toHaveBeenCalledTimes(1);
  const [category, title, , opts] = notifyAdmin.mock.calls[0];
  expect(category).toBe('system');
  expect(title).toContain('Sign card');
  expect(opts.bell).toBe(true);
  expect(opts.dedupeKey).toBe('supplies-consumption-failed:prod-sign:svc-1');
});

test('a bell failure on top of a deduction failure is still contained', async () => {
  notifyAdmin.mockImplementationOnce(async () => { throw new Error('bell down'); });
  const { db } = fakeDb({ products: [sign], throwOnInsert: true });
  await expect(consumeCompletionSupplies(db, args)).resolves.toMatchObject({ errors: [{ productId: 'prod-sign' }] });
});

test('a successful deduction rings no bell', async () => {
  notifyAdmin.mockClear();
  const { db } = fakeDb({ products: [sign] });
  await consumeCompletionSupplies(db, args);
  expect(notifyAdmin).not.toHaveBeenCalled();
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
    ['reorder_quantity', 'auto_reorder_vendor_id', 'auto_reorder_enabled', 'per_completion_usage', 'per_completion_service_lines'].forEach((c) => expect(cols).toHaveProperty(c));
    const seeded = await knex('products_catalog').where('name', 'like', 'Pesticide application sign 4x5%').first();
    if (seeded) expect([...seeded.per_completion_service_lines].sort()).toEqual(['lawn', 'mosquito', 'pest', 'tree_shrub']);
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
