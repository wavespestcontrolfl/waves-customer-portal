// A technician's completion with a product amount no visit uses is refused (422, IMPLAUSIBLE_PRODUCT_AMOUNT) on a fresh
// completion only, after the idempotency claim and before the first service write (the claim is marked failed). The limit is a
// FIXED reviewed maximum per dimension (640 fl oz, 100 lb, 50 each; 50 of the submitted number for a unit with no known
// dimension): no usage history is read. The office (admin) keeps the advisory path in deductProductInventory
// (pest-stock-advisory.test.js). PostgreSQL-free: the db is a recording fake; the end-to-end proofs are in
// complete-implausible-product-amount-postgres.test.js.
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

const { vetProductAmounts, exceedsVisitLimit } = require('../services/complete-scheduled-service');

const vet = async (args) => (await vetProductAmounts(require('../models/db'), args));
const refusalBody = async (args) => (await vet(args))?.body ?? null;
const historyReads = () => mockCalls.filter((c) => c.table === 'product_inventory_movements');

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

describe('the fixed per-visit limit (technician refusal)', () => {
  test('a technician over the limit is refused with the product and amount named', async () => {
    expect(await refusalBody({ actor: tech, products: line(406.25) })).toMatchObject({
      code: 'IMPLAUSIBLE_PRODUCT_AMOUNT',
      productId: CELSIUS,
      productName: 'Celsius WG',
      amount: 406.25,
      error: '406.25 lb of Celsius WG is far more than one visit uses. Check the amount and submit again.',
    });
    expect((await vet({ actor: tech, products: line(406.25) })).status).toBe(422);
  });

  test.each([
    ['volume', 640, 'fl_oz', 'fl_oz'],
    ['weight', 100, 'lb', 'lb'],
    ['count', 50, 'each', 'each'],
    ['weight sold in oz', 1600, 'oz', 'oz'],
  ])('%s: at the limit passes, over it is refused', async (_name, limit, unit, inventoryUnit) => {
    mockTables.products_catalog = [{ ...catalog, inventory_unit: inventoryUnit }];
    expect(await vet({ actor: tech, products: line(limit, unit) })).toBeNull();
    expect(await refusalBody({ actor: tech, products: line(limit + 1, unit) })).toMatchObject({ code: 'IMPLAUSIBLE_PRODUCT_AMOUNT' });
  });

  test('(a) 641 fl oz is refused however much was logged before: no usage history raises the limit', async () => {
    mockTables.products_catalog = [{ ...catalog, inventory_unit: 'fl_oz' }];
    mockTables.product_inventory_movements = [640, 640, 640, 640].map((quantity) => ({ quantity, unit: 'fl_oz' }));
    expect(await refusalBody({ actor: tech, products: line(641, 'fl_oz') })).toMatchObject({ code: 'IMPLAUSIBLE_PRODUCT_AMOUNT' });
    expect(await vet({ actor: tech, products: line(640, 'fl_oz') })).toBeNull();
    expect(historyReads()).toEqual([]);
  });

  test('a run of tiny logged usages cannot pull the limit down either', async () => {
    mockTables.product_inventory_movements = [0.0001, 0.0001, 0.0001].map((quantity) => ({ quantity, unit: 'lb' }));
    expect(await vet({ actor: tech, products: line(1) })).toBeNull();
    expect(historyReads()).toEqual([]);
  });

  test('(b) a blank inventory unit in a per-area unit fails closed on the number: 51 oz/1000sf is refused, 50 passes', async () => {
    mockTables.products_catalog = [{ ...catalog, inventory_unit: null }];
    expect(await refusalBody({ actor: tech, products: line(51, 'oz/1000sf') })).toMatchObject({ code: 'IMPLAUSIBLE_PRODUCT_AMOUNT', amount: 51 });
    expect(await vet({ actor: tech, products: line(50, 'oz/1000sf') })).toBeNull();
    expect(await refusalBody({ actor: tech, products: line(99999, 'oz/1000sf') })).toMatchObject({ code: 'IMPLAUSIBLE_PRODUCT_AMOUNT' });
  });

  test('a unit with no known dimension (bags), and an amount in a unit the stock unit cannot convert, fail closed the same way', async () => {
    mockTables.products_catalog = [{ ...catalog, inventory_unit: 'bags' }];
    expect(await refusalBody({ actor: tech, products: line(51, 'bags') })).toMatchObject({ code: 'IMPLAUSIBLE_PRODUCT_AMOUNT' });
    expect(await vet({ actor: tech, products: line(50, 'bags') })).toBeNull();
    mockTables.products_catalog = [{ ...catalog, inventory_unit: 'lb' }];
    expect(await refusalBody({ actor: tech, products: line(51, 'oz/1000sf') })).toMatchObject({ code: 'IMPLAUSIBLE_PRODUCT_AMOUNT' });
    expect(await vet({ actor: tech, products: line(50, 'oz/1000sf') })).toBeNull();
  });

  test('an amount under the limit is unchanged', async () => {
    expect(await vet({ actor: tech, products: line(2) })).toBeNull();
    expect(await vet({ actor: tech, products: line(100) })).toBeNull();
  });

  test('an admin entry is never refused here (the advisory path records it and skips the stock deduction)', async () => {
    expect(await vet({ actor: admin, products: line(406.25) })).toBeNull();
    expect(mockCalls.filter((c) => c.write)).toEqual([]);
  });

  test('a line with no amount, no known product or a non-uuid id is skipped without a query error', async () => {
    expect(await vet({ actor: tech, products: [{ productId: CELSIUS }] })).toBeNull();
    expect(await vet({ actor: tech, products: [{ productId: 'not-a-uuid', totalAmount: 9999, amountUnit: 'lb' }] })).toBeNull();
    expect(await vet({ actor: tech, products: null })).toBeNull();
  });

  test('(c) many distinct products: one catalog read, zero history reads', async () => {
    const ids = Array.from({ length: 12 }, (_v, i) => `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`);
    mockTables.products_catalog = ids.map((id) => ({ id, name: `P${id.slice(-2)}`, inventory_unit: 'lb' }));
    const products = ids.map((productId) => ({ productId, totalAmount: 2, amountUnit: 'lb' }));
    expect(await vet({ actor: tech, products })).toBeNull();
    expect(mockCalls.map((c) => c.table)).toEqual(['products_catalog', 'products_catalog']); // one query: whereIn + select
    expect(mockCalls.filter((c) => c.table === 'products_catalog' && c.op === 'whereIn')).toHaveLength(1);
    expect(historyReads()).toEqual([]);
  });

  test('exceedsVisitLimit is pure: the same line always gets the same answer', () => {
    const l = { amount: 641, amountUnit: 'fl_oz', inventoryUnit: 'fl_oz' };
    expect([exceedsVisitLimit(l), exceedsVisitLimit(l)]).toEqual([true, true]);
  });
});

describe('a malformed amount is refused with a 400 for every role, and the parsed number is what every sink reads', () => {
  test.each([
    ['trailing junk', '99999junk'],
    ['exponent text', '1e3'],
    ['a negative', -4],
    ['a negative string', '-4'],
    ['a boolean', true],
    ['an object', { v: 1 }],
    ['words', 'lots'],
    ['whitespace and junk', ' 12 lb'],
  ])('%s', async (_name, totalAmount) => {
    for (const actor of [tech, admin]) {
      const products = [{ productId: CELSIUS, totalAmount, amountUnit: 'lb' }];
      const out = await vet({ actor, products });
      expect(out).toMatchObject({ status: 400, body: { code: 'INVALID_PRODUCT_AMOUNT', productId: CELSIUS } });
      expect(out.body.error).toBe('The amount for Celsius WG is not a number. Enter the amount as a plain number and submit again.');
    }
  });

  test('a plain decimal string is parsed once and written back as the number every later reader sees', async () => {
    const products = [{ productId: CELSIUS, totalAmount: ' 12.5 ', amountUnit: 'lb' }, { productId: CELSIUS, totalAmount: '.5', amountUnit: 'lb' }, { productId: CELSIUS, totalAmount: 3, amountUnit: 'lb' }];
    expect(await vet({ actor: tech, products })).toBeNull();
    expect(products.map((p) => p.totalAmount)).toEqual([12.5, 0.5, 3]);
  });

  test('empty and absent amounts behave as today: not judged, not changed', async () => {
    const products = [{ productId: CELSIUS, totalAmount: '', amountUnit: 'lb' }, { productId: CELSIUS, amountUnit: 'lb' }, { productId: CELSIUS, totalAmount: null }];
    expect(await vet({ actor: tech, products })).toBeNull();
    expect(products.map((p) => p.totalAmount)).toEqual(['', undefined, null]);
  });

  test('a replay or resume (skip) parses and changes nothing, and reads nothing', async () => {
    const products = [{ productId: CELSIUS, totalAmount: '99999junk', amountUnit: 'lb' }];
    expect(await vet({ actor: tech, products, skip: true })).toBeNull();
    expect(products[0].totalAmount).toBe('99999junk');
    expect(mockCalls).toEqual([]);
  });
});
// The end-to-end proofs (422 before any write with the claim released, 400 for a malformed amount, admin advisory path,
// under-limit unchanged, an identical retry replaying) are in complete-implausible-product-amount-postgres.test.js.
