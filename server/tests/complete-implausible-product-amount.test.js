// A technician's completion with a product amount no visit uses is refused (422, IMPLAUSIBLE_PRODUCT_AMOUNT) on a fresh
// completion only, after the idempotency claim and before the first service write (the claim is marked failed). The office
// (admin) keeps the advisory path in deductProductInventory (pest-stock-advisory.test.js). PostgreSQL-free: the db is a
// recording fake; the end-to-end proofs are in complete-implausible-product-amount-postgres.test.js.
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

const { freezeCompletionCeilings, deductProductInventory } = require('../services/complete-scheduled-service');

const technicianImplausibleProduct = async (db, args) => (await freezeCompletionCeilings(db, args)).refusal?.body ?? null;

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

describe('freezeCompletionCeilings (technician refusal)', () => {
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

  test('a technician over 20 times the product\'s own median is refused (history raises the ceiling above the floor)', async () => {
    mockTables.product_inventory_movements = [10, 10, 10, 12].map((quantity) => ({ quantity, unit: 'lb' }));
    expect(await technicianImplausibleProduct(require('../models/db'), { actor: tech, products: line(201) })).toMatchObject({ code: 'IMPLAUSIBLE_PRODUCT_AMOUNT' });
    expect(await technicianImplausibleProduct(require('../models/db'), { actor: tech, products: line(200) })).toBeNull();
  });

  test('a run of tiny logged usages cannot pull the ceiling under the floor', async () => {
    mockTables.product_inventory_movements = [0.0001, 0.0001, 0.0001].map((quantity) => ({ quantity, unit: 'lb' }));
    const out = await freezeCompletionCeilings(require('../models/db'), { actor: tech, products: line(1) });
    expect(out.refusal).toBeNull();
    expect([...out.ceilings.values()]).toEqual([100]);
    expect(await technicianImplausibleProduct(require('../models/db'), { actor: tech, products: line(101) })).toMatchObject({ code: 'IMPLAUSIBLE_PRODUCT_AMOUNT' });
  });

  test('an amount under the ceiling is unchanged', async () => {
    expect(await technicianImplausibleProduct(require('../models/db'), { actor: tech, products: line(2) })).toBeNull();
    expect(await technicianImplausibleProduct(require('../models/db'), { actor: tech, products: line(100) })).toBeNull();
  });

  test('an admin entry is never refused here (the advisory path records it and skips the stock deduction)', async () => {
    expect(await technicianImplausibleProduct(require('../models/db'), { actor: admin, products: line(406.25) })).toBeNull();
    expect(mockCalls.filter((c) => c.write)).toEqual([]);
  });

  test('a line with no amount, no known product or a non-uuid id is skipped without a query error', async () => {
    const db = require('../models/db');
    expect(await technicianImplausibleProduct(db, { actor: tech, products: [{ productId: CELSIUS }] })).toBeNull();
    expect(await technicianImplausibleProduct(db, { actor: tech, products: [{ productId: 'not-a-uuid', totalAmount: 9999, amountUnit: 'lb' }] })).toBeNull();
    expect(await technicianImplausibleProduct(db, { actor: tech, products: null })).toBeNull();
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
      const out = await freezeCompletionCeilings(require('../models/db'), { actor, products });
      expect(out.refusal).toMatchObject({ status: 400, body: { code: 'INVALID_PRODUCT_AMOUNT', productId: CELSIUS } });
      expect(out.refusal.body.error).toBe('The amount for Celsius WG is not a number. Enter the amount as a plain number and submit again.');
    }
  });

  test('a plain decimal string is parsed once and written back as the number every later reader sees', async () => {
    const products = [{ productId: CELSIUS, totalAmount: ' 12.5 ', amountUnit: 'lb' }, { productId: CELSIUS, totalAmount: '.5', amountUnit: 'lb' }, { productId: CELSIUS, totalAmount: 3, amountUnit: 'lb' }];
    const out = await freezeCompletionCeilings(require('../models/db'), { actor: tech, products });
    expect(out.refusal).toBeNull();
    expect(products.map((p) => p.totalAmount)).toEqual([12.5, 0.5, 3]);
  });

  test('empty and absent amounts behave as today: not judged, not changed', async () => {
    const products = [{ productId: CELSIUS, totalAmount: '', amountUnit: 'lb' }, { productId: CELSIUS, amountUnit: 'lb' }, { productId: CELSIUS, totalAmount: null }];
    const out = await freezeCompletionCeilings(require('../models/db'), { actor: tech, products });
    expect(out.refusal).toBeNull();
    expect(products.map((p) => p.totalAmount)).toEqual(['', undefined, null]);
  });

  test('a replay or resume (skip) parses and changes nothing', async () => {
    const products = [{ productId: CELSIUS, totalAmount: '99999junk', amountUnit: 'lb' }];
    expect((await freezeCompletionCeilings(require('../models/db'), { actor: tech, products, skip: true })).refusal).toBeNull();
    expect(products[0].totalAmount).toBe('99999junk');
  });
});

describe('replay and resume', () => {
  test('skip (a replay, a resume or a packet effects phase) judges nothing, freezes nothing and reads nothing', async () => {
    const out = await freezeCompletionCeilings(require('../models/db'), { actor: tech, products: line(406), skip: true });
    expect(out.refusal).toBeNull();
    expect(out.ceilings.size).toBe(0);
    expect(mockCalls).toEqual([]);
  });
});

describe('the ceiling is frozen once per completion', () => {
  test('it is frozen for an admin too, and read once per product however many lines carry it', async () => {
    mockTables.product_inventory_movements = [{ quantity: 1, unit: 'lb' }, { quantity: 1, unit: 'lb' }];
    const out = await freezeCompletionCeilings(require('../models/db'), { actor: admin, products: [...line(1), ...line(30)] });
    expect(out.refusal).toBeNull();
    expect([...out.ceilings.values()]).toEqual([100]);
    expect(mockCalls.filter((c) => c.table === 'product_inventory_movements' && c.op === 'select')).toHaveLength(1);
  });

  // Codex's case: two prior 1 lb rows (ceiling 100 lb); a host row of 1 lb and an add-on row of 30 lb in one completion.
  // Saving the host row adds a 1 lb usage row, so a recomputed ceiling would be 20 lb and silently skip the add-on's stock
  // and cost. A stateful fake db lets each saved movement join the history the next line would read.
  const statefulTrx = (history) => {
    const writes = [];
    let reads = 0;
    const trx = (table) => ({
      where: () => ({
        forUpdate: () => ({ first: async () => null }),
        update: async (row) => { writes.push({ table, update: row }); return 1; },
        where: () => ({ select: async () => { reads += 1; return history; } }),
      }),
      insert: (row) => ({ returning: async () => { writes.push({ table, insert: row }); history.push({ quantity: row.quantity, unit: row.unit }); return [{ id: `movement-${writes.length}`, ...row }]; } }),
    });
    trx.writes = writes;
    trx.historyReads = () => reads;
    return trx;
  };
  const visit = {
    serviceProduct: { id: 'service-product-1' },
    serviceRecord: { id: 'record-1' },
    scheduledService: { id: 'visit-1', customer_id: 'customer-1', technician_id: 'tech-1' },
    allowNegative: true,
  };
  const product = (onHand) => ({ id: CELSIUS, name: 'Celsius WG', inventory_on_hand: onHand, inventory_unit: 'lb', cost_per_unit: 2 });

  test('the later line is judged against the frozen 100 lb ceiling, so its stock deduction and cost are written', async () => {
    const history = [{ quantity: 1, unit: 'lb' }, { quantity: 1, unit: 'lb' }];
    mockTables.product_inventory_movements = history;
    const { ceilings, refusal } = await freezeCompletionCeilings(require('../models/db'), { actor: tech, products: [...line(1), ...line(30)] });
    expect(refusal).toBeNull();
    const trx = statefulTrx(history);
    const host = await deductProductInventory(trx, { ...visit, product: product(1), productInput: { totalAmount: 1, amountUnit: 'lb' }, plausibleCeilings: ceilings });
    const addOn = await deductProductInventory(trx, { ...visit, product: product(0), productInput: { totalAmount: 30, amountUnit: 'lb' }, plausibleCeilings: ceilings });
    expect(host.status).toBe('deducted');
    expect(addOn).toMatchObject({ status: 'deducted_insufficient_stock', stockBefore: 0, stockAfter: -30, deductedAmount: 30 });
    expect(addOn.costUsed).toBeGreaterThan(0);
    expect(trx.writes.filter((w) => w.table === 'product_inventory_movements')).toHaveLength(2);
    expect(trx.historyReads()).toBe(0); // no deduction recomputed a ceiling
  });

  test('without the frozen map each line reads the history afresh (what freezing replaces)', async () => {
    const history = [{ quantity: 1, unit: 'lb' }, { quantity: 1, unit: 'lb' }];
    const trx = statefulTrx(history);
    await deductProductInventory(trx, { ...visit, product: product(1), productInput: { totalAmount: 1, amountUnit: 'lb' } });
    await deductProductInventory(trx, { ...visit, product: product(0), productInput: { totalAmount: 30, amountUnit: 'lb' } });
    expect(trx.historyReads()).toBe(1); // the host line stayed in stock; the add-on overdrew and read the history
  });
});
// The end-to-end proofs (422 before any write with the claim released, admin advisory path, under-ceiling unchanged, an
// identical retry replaying after its own usage moved the ceiling) are in complete-implausible-product-amount-postgres.test.js.
