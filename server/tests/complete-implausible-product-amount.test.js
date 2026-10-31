// A technician's completion with a product amount no visit uses is refused (422, IMPLAUSIBLE_PRODUCT_AMOUNT) before the
// claim and every write: no service_products row, no inventory move, no FDACS ledger row, no cost. The office (admin)
// keeps the advisory path in deductProductInventory (pest-stock-advisory.test.js): the line is recorded and stock is
// left alone. PostgreSQL-free: the db is a recording fake.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockCalls = [];
const mockTables = {};
jest.mock('../models/db', () => {
  const builder = (table) => {
    const b = {};
    ['where', 'whereIn', 'whereNull', 'whereNot', 'orderBy', 'limit', 'forUpdate', 'select', 'first', 'leftJoin', 'join'].forEach((m) => {
      b[m] = (...a) => { mockCalls.push({ table, op: m, args: a }); return b; };
    });
    ['insert', 'update', 'del', 'delete', 'increment', 'decrement'].forEach((m) => {
      b[m] = (...a) => { mockCalls.push({ table, op: m, write: true, args: a }); return b; };
    });
    b.returning = () => b;
    b.then = (resolve, reject) => Promise.resolve(mockTables[table] || []).then(resolve, reject);
    return b;
  };
  const db = (table) => builder(table);
  db.transaction = (...a) => { mockCalls.push({ table: null, op: 'transaction', write: true, args: a }); return Promise.resolve(); };
  db.raw = (...a) => { mockCalls.push({ table: null, op: 'raw', write: true, args: a }); return Promise.resolve({ rows: [] }); };
  db.fn = { now: () => 'now()' };
  return db;
});

const { completeScheduledService, technicianImplausibleProduct } = require('../services/complete-scheduled-service');

const CELSIUS = '11111111-1111-4111-8111-111111111111';
const catalog = { id: CELSIUS, name: 'Celsius WG', inventory_unit: 'lb' };
const tech = { techRole: 'technician', technicianId: 'tech-1' };
const admin = { techRole: 'admin', technicianId: 'admin-1' };
const line = (totalAmount, amountUnit = 'lb') => [{ productId: CELSIUS, totalAmount, amountUnit }];

beforeEach(() => {
  mockCalls.length = 0;
  Object.keys(mockTables).forEach((k) => delete mockTables[k]);
  mockTables.products_catalog = [catalog];
});

describe('technicianImplausibleProduct', () => {
  test('a technician over the floor (no history) is refused with the product and amount named', async () => {
    const refusal = await technicianImplausibleProduct(require('../models/db'), { actor: tech, products: line(406.25) });
    expect(refusal).toMatchObject({
      code: 'IMPLAUSIBLE_PRODUCT_AMOUNT',
      productId: CELSIUS,
      productName: 'Celsius WG',
      amount: 406.25,
      error: '406.25 lb of Celsius WG is far more than one visit uses. Check the amount and submit again.',
    });
  });

  test('a technician over 20 times the product\'s own median is refused', async () => {
    mockTables.product_inventory_movements = [1, 1.5, 2, 2].map((quantity) => ({ quantity, unit: 'lb' }));
    expect(await technicianImplausibleProduct(require('../models/db'), { actor: tech, products: line(36) })).toMatchObject({ code: 'IMPLAUSIBLE_PRODUCT_AMOUNT' });
    expect(await technicianImplausibleProduct(require('../models/db'), { actor: tech, products: line(35) })).toBeNull();
  });

  test('an amount under the ceiling is unchanged', async () => {
    expect(await technicianImplausibleProduct(require('../models/db'), { actor: tech, products: line(2) })).toBeNull();
    expect(await technicianImplausibleProduct(require('../models/db'), { actor: tech, products: line(100) })).toBeNull();
  });

  test('an admin entry is never refused here (the advisory path records it and skips the stock deduction)', async () => {
    expect(await technicianImplausibleProduct(require('../models/db'), { actor: admin, products: line(406.25) })).toBeNull();
    expect(mockCalls).toEqual([]);
  });

  test('a line with no amount, no known product or a non-uuid id is skipped without a query error', async () => {
    const db = require('../models/db');
    expect(await technicianImplausibleProduct(db, { actor: tech, products: [{ productId: CELSIUS }] })).toBeNull();
    expect(await technicianImplausibleProduct(db, { actor: tech, products: [{ productId: 'not-a-uuid', totalAmount: 9999, amountUnit: 'lb' }] })).toBeNull();
    expect(await technicianImplausibleProduct(db, { actor: tech, products: null })).toBeNull();
  });
});

describe('POST /complete by a technician with an over-ceiling amount', () => {
  test('answers 422 and writes nothing', async () => {
    const result = await completeScheduledService({
      serviceId: 'visit-1',
      actor: tech,
      body: { visitOutcome: 'completed', products: line(406, 'lb') },
    });
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      code: 'IMPLAUSIBLE_PRODUCT_AMOUNT',
      error: '406 lb of Celsius WG is far more than one visit uses. Check the amount and submit again.',
    });
    expect(mockCalls.filter((c) => c.write)).toEqual([]);
    const touched = new Set(mockCalls.map((c) => c.table));
    for (const table of ['service_products', 'service_records', 'fdacs_application_ledger', 'scheduled_services']) {
      expect(touched.has(table)).toBe(false);
    }
  });

  test('a saved packet\'s effects phase never re-checks (its records already committed)', async () => {
    mockTables.scheduled_services = [];
    await completeScheduledService({
      serviceId: 'visit-1', actor: tech, body: { visitOutcome: 'completed', products: line(406, 'lb') },
    }, { phase: 'effects', itemId: 'item-1' }).catch(() => {});
    expect(mockCalls.some((c) => c.table === 'products_catalog' && c.op === 'whereIn')).toBe(false);
  });
});
