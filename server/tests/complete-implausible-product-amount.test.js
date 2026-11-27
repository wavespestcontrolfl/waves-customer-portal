// Owner 2026-11-26: "all alerts like this should just be alerts, they should not stop the job from being completed or
// finished". A product line over its ceiling is never refused, for any role: vetProductAmounts answers null and marks the lines
// (the product's lines TOGETHER over the FIXED reviewed maximum per dimension: 640 fl oz, 100 lb, 50 each; 50 of the submitted
// number for a unit with no known dimension), and deductProductInventory records each marked line, leaves stock alone and flags
// it not_deducted_implausible (pest-stock-advisory.test.js) so the office alert fires. A malformed amount stays a 400: it is
// unreadable input, not a product limit. PostgreSQL-free: the db is a recording fake; the end-to-end proofs are in
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

const { vetProductAmounts, exceedsVisitLimit, canonicalizeProductLines, isOverVisitLimitLine, deductProductInventory } = require('../services/complete-scheduled-service');

// vetProductAmounts assumes canonical ids: completeScheduledService canonicalizes the lines at intake, before anything reads them.
const vet = async (args) => { canonicalizeProductLines(args.products); return vetProductAmounts(require('../models/db'), args); };
// What the completion does with the lines: the vet answer (null = not refused) and which lines it marked as over the ceiling.
const marked = async (products) => { const out = await vet({ products }); return { out, over: products.map(isOverVisitLimitLine) }; };
const historyReads = () => mockCalls.filter((c) => c.table === 'product_inventory_movements');

const CELSIUS = '11111111-1111-4111-8111-111111111111';
const catalog = { id: CELSIUS, name: 'Celsius WG', inventory_unit: 'lb' };
const line = (totalAmount, amountUnit = 'lb') => [{ productId: CELSIUS, totalAmount, amountUnit }];

beforeEach(() => {
  mockCalls.length = 0;
  Object.keys(mockTables).forEach((k) => delete mockTables[k]);
  mockTables.products_catalog = [catalog];
});

describe('the fixed per-visit limit (a warning, never a refusal)', () => {
  test('a line over the limit is not refused: the answer is null and the line is marked', async () => {
    expect(await marked(line(406.25))).toEqual({ out: null, over: [true] });
  });

  // 50 lb on hand (the flag does not depend on the shelf: see the 500 lb case below). The row lock finds
  // no row, so the passed-in product is used; any write is recorded.
  const deduct = async (products, index, onHand = 50) => {
    const writes = [];
    // The product has never been counted: the count read answers no rows.
    const trx = () => ({
      where: () => ({
        forUpdate: () => ({ first: async () => null }),
        orderBy: () => ({ limit: () => ({ select: async () => [] }) }),
        update: async (row) => { writes.push(row); return 1; },
        where: () => ({ select: async () => [] }),
      }),
      insert: (row) => ({ returning: async () => { writes.push(row); return [row]; } }),
    });
    const result = await deductProductInventory(trx, {
      product: { ...catalog, inventory_on_hand: onHand }, productInput: products[index], serviceProduct: { id: 'sp-1' },
      serviceRecord: { id: 'record-1' }, scheduledService: { id: 'visit-1', customer_id: 'customer-1' }, allowNegative: false,
    });
    return { result, writes };
  };

  test('the deduction of a line over the limit records it, moves no stock and no cost, and flags it for the office alert, with no thrown refusal', async () => {
    const products = line(406.25);
    expect((await marked(products)).out).toBeNull();
    const { result, writes } = await deduct(products, 0);
    expect(result).toMatchObject({ status: 'not_deducted_implausible', productId: CELSIUS, amount: 406.25, amountUnit: 'lb', stockBefore: 50, remainingStock: 50 });
    expect(writes).toEqual([]);
  });

  test('406 lb on 500 lb on hand is flagged all the same: stock and cost untouched, nothing written (owner 2026-11-26)', async () => {
    const products = line(406);
    expect((await marked(products)).out).toBeNull();
    const { result, writes } = await deduct(products, 0, 500);
    expect(result).toMatchObject({ status: 'not_deducted_implausible', amount: 406, stockBefore: 500, remainingStock: 500 });
    expect(result.costUsed).toBeUndefined();
    expect(writes).toEqual([]);
  });

  test('lines each under the limit but together over it are flagged too, whatever the shelf holds', async () => {
    const products = [{ productId: CELSIUS, totalAmount: 60, amountUnit: 'lb' }, { productId: CELSIUS, totalAmount: 60, amountUnit: 'lb', areaAddOnKey: 'x' }];
    expect((await marked(products)).over).toEqual([true, true]);
    expect((await deduct(products, 1)).result).toMatchObject({ status: 'not_deducted_implausible', amount: 60 });
  });

  test.each([
    ['volume', 640, 'fl_oz', 'fl_oz'],
    ['weight', 100, 'lb', 'lb'],
    ['count', 50, 'each', 'each'],
    ['weight sold in oz', 1600, 'oz', 'oz'],
  ])('%s: at the limit is not marked, over it is marked', async (_name, limit, unit, inventoryUnit) => {
    mockTables.products_catalog = [{ ...catalog, inventory_unit: inventoryUnit }];
    expect(await marked(line(limit, unit))).toEqual({ out: null, over: [false] });
    expect(await marked(line(limit + 1, unit))).toEqual({ out: null, over: [true] });
  });

  test('(a) 641 fl oz is over however much was logged before: no usage history raises the limit', async () => {
    mockTables.products_catalog = [{ ...catalog, inventory_unit: 'fl_oz' }];
    mockTables.product_inventory_movements = [640, 640, 640, 640].map((quantity) => ({ quantity, unit: 'fl_oz' }));
    expect((await marked(line(641, 'fl_oz'))).over).toEqual([true]);
    expect((await marked(line(640, 'fl_oz'))).over).toEqual([false]);
    expect(historyReads()).toEqual([]);
  });

  test('a run of tiny logged usages cannot pull the limit down either', async () => {
    mockTables.product_inventory_movements = [0.0001, 0.0001, 0.0001].map((quantity) => ({ quantity, unit: 'lb' }));
    expect((await marked(line(1))).over).toEqual([false]);
    expect(historyReads()).toEqual([]);
  });

  test('(b) a blank inventory unit in a per-area unit fails closed on the number: 51 oz/1000sf is marked, 50 is not', async () => {
    mockTables.products_catalog = [{ ...catalog, inventory_unit: null }];
    expect((await marked(line(51, 'oz/1000sf'))).over).toEqual([true]);
    expect((await marked(line(50, 'oz/1000sf'))).over).toEqual([false]);
    expect((await marked(line(99999, 'oz/1000sf'))).over).toEqual([true]);
  });

  test('a unit with no known dimension (bags), and an amount in a unit the stock unit cannot convert, fail closed the same way', async () => {
    mockTables.products_catalog = [{ ...catalog, inventory_unit: 'bags' }];
    expect((await marked(line(51, 'bags'))).over).toEqual([true]);
    expect((await marked(line(50, 'bags'))).over).toEqual([false]);
    mockTables.products_catalog = [{ ...catalog, inventory_unit: 'lb' }];
    expect((await marked(line(51, 'oz/1000sf'))).over).toEqual([true]);
    expect((await marked(line(50, 'oz/1000sf'))).over).toEqual([false]);
  });

  test('an amount under the limit is unchanged', async () => {
    expect(await marked(line(2))).toEqual({ out: null, over: [false] });
    expect(await marked(line(100))).toEqual({ out: null, over: [false] });
  });

  test('a line with no amount, no known product or a non-uuid id is skipped without a query error', async () => {
    expect(await marked([{ productId: CELSIUS }])).toEqual({ out: null, over: [false] });
    expect(await marked([{ productId: 'not-a-uuid', totalAmount: 9999, amountUnit: 'lb' }])).toEqual({ out: null, over: [false] });
    expect(await vet({ products: null })).toBeNull();
  });

  test('(c) many distinct products: one catalog read, zero history reads', async () => {
    const ids = Array.from({ length: 12 }, (_v, i) => `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`);
    mockTables.products_catalog = ids.map((id) => ({ id, name: `P${id.slice(-2)}`, inventory_unit: 'lb' }));
    const products = ids.map((productId) => ({ productId, totalAmount: 2, amountUnit: 'lb' }));
    expect((await marked(products)).out).toBeNull();
    expect(mockCalls.map((c) => c.table)).toEqual(['products_catalog', 'products_catalog']); // one query: whereIn + select
    expect(mockCalls.filter((c) => c.table === 'products_catalog' && c.op === 'whereIn')).toHaveLength(1);
    expect(historyReads()).toEqual([]);
  });

  test('exceedsVisitLimit is pure: the same line always gets the same answer', () => {
    const l = { amount: 641, amountUnit: 'fl_oz', inventoryUnit: 'fl_oz' };
    expect([exceedsVisitLimit(l), exceedsVisitLimit(l)]).toEqual([true, true]);
  });

  test('lines over together carry the combined amount and each contributing line into the flag and the warning', async () => {
    const products = [{ productId: CELSIUS, totalAmount: 60, amountUnit: 'lb' }, { productId: CELSIUS, totalAmount: 41, amountUnit: 'lb', areaAddOnKey: 'x' }];
    expect((await marked(products)).over).toEqual([true, true]);
    for (const index of [0, 1]) {
      const { result } = await deduct(products, index, 500);
      expect(result).toMatchObject({
        status: 'not_deducted_implausible', combinedAmount: 101, combinedAmountUnit: 'lb', contributingLines: ['60 lb', '41 lb'], serviceProductId: 'sp-1',
        warning: '101 lb of Celsius WG across 2 lines is too much for one visit, so stock was not changed. Check the amounts.',
      });
    }
  });

  test('mixed units report the total in the base unit and each line as entered', async () => {
    const products = [{ productId: CELSIUS, totalAmount: 60, amountUnit: 'lb' }, { productId: CELSIUS, totalAmount: 960, amountUnit: 'oz' }];
    await marked(products);
    expect((await deduct(products, 1, 500)).result).toMatchObject({ combinedAmount: 120, combinedAmountUnit: 'lb', contributingLines: ['60 lb', '960 oz'] });
  });

  test('a single flagged line carries no combined fields', async () => {
    const products = line(406);
    await marked(products);
    expect((await deduct(products, 0, 500)).result.combinedAmount).toBeUndefined();
  });

  test('the ceiling judges what the completion records: a duplicate row of one product (the loop keeps the first) is neither summed nor flagged', async () => {
    const rowIdentity = (p) => `${p.productId}|${p.areaAddOnKey || ''}`;
    const dup = [{ productId: CELSIUS, totalAmount: 60, amountUnit: 'lb' }, { productId: CELSIUS, totalAmount: 60, amountUnit: 'lb' }];
    canonicalizeProductLines(dup);
    expect(await vetProductAmounts(require('../models/db'), { products: dup, rowIdentity })).toBeNull();
    expect(dup.map(isOverVisitLimitLine)).toEqual([false, false]);
    // An add-on row is its own row: both are recorded, so together they are over.
    const addOn = [{ productId: CELSIUS, totalAmount: 60, amountUnit: 'lb' }, { productId: CELSIUS, totalAmount: 60, amountUnit: 'lb', areaAddOnKey: 'x' }];
    canonicalizeProductLines(addOn);
    await vetProductAmounts(require('../models/db'), { products: addOn, rowIdentity });
    expect(addOn.map(isOverVisitLimitLine)).toEqual([true, true]);
  });

  test('a client cannot mark its own line: a submitted flag changes nothing', async () => {
    const products = [{ productId: CELSIUS, totalAmount: 2, amountUnit: 'lb', overVisitLimit: true, status: 'not_deducted_implausible' }];
    expect(await marked(products)).toEqual({ out: null, over: [false] });
  });
});

describe('one product\'s lines are judged together, under one canonical id', () => {
  const spellings = [CELSIUS, ` ${CELSIUS.toUpperCase()}`, `${CELSIUS}\t`, `  ${CELSIUS.toUpperCase()}  `];
  const variants = (n, amount = 100) => Array.from({ length: n }, (_v, i) => ({ productId: spellings[i % spellings.length], totalAmount: amount, amountUnit: 'lb' }));

  test('200 lines of one UUID in whitespace and case variants, each at the 100 lb limit, are all marked and none refused', async () => {
    const { out, over } = await marked(variants(200));
    expect(out).toBeNull();
    expect(over).toEqual(Array(200).fill(true));
  });

  test('intake makes every line\'s id canonical in place, and hands back the ids as submitted only when something changed', () => {
    const products = variants(6, 10);
    const submitted = canonicalizeProductLines(products);
    expect(products.map((p) => p.productId)).toEqual(Array(6).fill(CELSIUS));
    expect(submitted).toEqual(variants(6, 10).map((p) => p.productId));
    expect(canonicalizeProductLines(products)).toBeNull(); // already canonical: the hash body is the body
    expect(canonicalizeProductLines([{ name: 'no id' }, null, { productId: '' }])).toBeNull();
    expect(canonicalizeProductLines(null)).toBeNull();
  });

  test('host and add-on rows of one product that add up to the limit or less are not marked; one lb more marks both', async () => {
    const rows = (a, b) => [{ productId: CELSIUS, totalAmount: a, amountUnit: 'lb' }, { productId: ` ${CELSIUS.toUpperCase()} `, totalAmount: b, amountUnit: 'lb', areaAddOnKey: 'x' }];
    expect((await marked(rows(60, 40))).over).toEqual([false, false]);
    expect(await marked(rows(60, 41))).toEqual({ out: null, over: [true, true] });
  });

  test('lines in different units add up in the stock unit', async () => {
    const products = [{ productId: CELSIUS, totalAmount: 90, amountUnit: 'lb' }, { productId: CELSIUS, totalAmount: 320, amountUnit: 'oz' }]; // 90 + 20 lb
    expect((await marked(products)).over).toEqual([true, true]);
  });

  describe.each([['a blank stock unit', null], ['a set stock unit', 'lb'], ['a stock unit in another dimension', 'fl_oz']])('mixed units of one product with %s', (_name, inventoryUnit) => {
    beforeEach(() => { mockTables.products_catalog = [{ ...catalog, inventory_unit: inventoryUnit }]; });
    const mix = (...parts) => parts.map(([totalAmount, amountUnit], i) => ({ productId: i % 2 ? CELSIUS.toUpperCase() : CELSIUS, totalAmount, amountUnit }));

    test('60 lb host + 960 oz add-on is 120 lb: both marked', async () => {
      expect(await marked(mix([60, 'lb'], [960, 'oz']))).toEqual({ out: null, over: [true, true] });
    });

    test('50 lb + 800 oz is 100 lb: not marked', async () => {
      expect((await marked(mix([50, 'lb'], [800, 'oz']))).over).toEqual([false, false]);
    });

    test('gal + fl oz add up in fluid ounces: 5 gal + 1 fl oz is 641 fl oz and is marked, 4 gal + 128 fl oz is not', async () => {
      expect((await marked(mix([5, 'gal'], [1, 'fl_oz']))).over).toEqual([true, true]);
      expect((await marked(mix([4, 'gal'], [128, 'fl_oz']))).over).toEqual([false, false]);
    });

    test('lines in unrelated dimensions are not added together', async () => {
      expect((await marked(mix([100, 'lb'], [640, 'fl_oz'], [50, 'each']))).over).toEqual([false, false, false]);
    });
  });

  test('number-bucket units add only within the same unit string', async () => {
    mockTables.products_catalog = [{ ...catalog, inventory_unit: null }];
    const rows = (...parts) => parts.map(([totalAmount, amountUnit]) => ({ productId: CELSIUS, totalAmount, amountUnit }));
    expect((await marked(rows([30, 'bags'], [30, 'cases']))).over).toEqual([false, false]);
    expect((await marked(rows([30, 'bags'], [30, 'Bags ']))).over).toEqual([true, true]);
  });

  test('a unit with no known dimension adds the submitted numbers against the cap of 50', async () => {
    mockTables.products_catalog = [{ ...catalog, inventory_unit: null }];
    const rows = (a, b) => [{ productId: CELSIUS, totalAmount: a, amountUnit: 'oz/1000sf' }, { productId: CELSIUS.toUpperCase(), totalAmount: b, amountUnit: 'oz/1000sf' }];
    expect((await marked(rows(25, 25))).over).toEqual([false, false]);
    expect((await marked(rows(25, 26))).over).toEqual([true, true]);
  });

  test('different products are judged separately', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    mockTables.products_catalog = [catalog, { id: other, name: 'Other', inventory_unit: 'lb' }];
    const products = [{ productId: CELSIUS, totalAmount: 100, amountUnit: 'lb' }, { productId: other, totalAmount: 100, amountUnit: 'lb' }];
    expect((await marked(products)).over).toEqual([false, false]);
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
    ['an over-long digit run', '1'.repeat(33)],
  ])('%s', async (_name, totalAmount) => {
    const products = [{ productId: CELSIUS, totalAmount, amountUnit: 'lb' }];
    const out = await vet({ products });
    expect(out).toMatchObject({ status: 400, body: { code: 'INVALID_PRODUCT_AMOUNT', productId: CELSIUS } });
    expect(out.body.error).toBe('The amount for Celsius WG is not a number. Enter the amount as a plain number and submit again.');
  });

  test.each([
    ['one over the column maximum', 100000],
    ['a string over it', '100000.5'],
    ['a million', 1000000],
    ['rounds up past it', 99999.9995],
  ])('an amount the numeric(8,3) column cannot store is a 400 before any write: %s', async (_name, totalAmount) => {
    const products = [{ productId: CELSIUS, totalAmount, amountUnit: 'lb' }];
    const out = await vet({ products });
    expect(out).toMatchObject({ status: 400, body: { code: 'PRODUCT_AMOUNT_TOO_LARGE', productId: CELSIUS } });
    expect(out.body.error).toBe('The amount for Celsius WG is too large to record. The most one line can hold is 99,999.999. Check the amount and submit again.');
    expect(mockCalls.filter((c) => c.write)).toEqual([]);
  });

  test('the column maximum itself is storable: 99999.999 is marked over the ceiling, never refused', async () => {
    expect(await marked(line(99999.999))).toEqual({ out: null, over: [true] });
    expect(await marked(line(99999.9994))).toEqual({ out: null, over: [true] });
  });

  test('a plain decimal string is parsed once and written back as the number every later reader sees', async () => {
    const products = [{ productId: CELSIUS, totalAmount: ' 12.5 ', amountUnit: 'lb' }, { productId: CELSIUS, totalAmount: '.5', amountUnit: 'lb' }, { productId: CELSIUS, totalAmount: 3, amountUnit: 'lb' }];
    expect(await vet({ products })).toBeNull();
    expect(products.map((p) => p.totalAmount)).toEqual([12.5, 0.5, 3]);
  });

  test('a long digit run ending in junk is refused quickly, not after quadratic backtracking', async () => {
    const products = [{ productId: CELSIUS, totalAmount: `${'1'.repeat(100000)}x`, amountUnit: 'lb' }];
    const started = Date.now();
    const out = await vet({ products });
    expect(out).toMatchObject({ status: 400, body: { code: 'INVALID_PRODUCT_AMOUNT' } });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('empty and absent amounts behave as today: not judged, not changed', async () => {
    const products = [{ productId: CELSIUS, totalAmount: '', amountUnit: 'lb' }, { productId: CELSIUS, amountUnit: 'lb' }, { productId: CELSIUS, totalAmount: null }];
    expect(await vet({ products })).toBeNull();
    expect(products.map((p) => p.totalAmount)).toEqual(['', undefined, null]);
  });

  test('a replay or resume (skip) parses and changes nothing, marks nothing, and reads nothing', async () => {
    const products = [{ productId: CELSIUS, totalAmount: '99999junk', amountUnit: 'lb' }, { productId: CELSIUS, totalAmount: 500, amountUnit: 'lb' }];
    expect(await vet({ products, skip: true })).toBeNull();
    expect(products[0].totalAmount).toBe('99999junk');
    expect(products.map(isOverVisitLimitLine)).toEqual([false, false]);
    expect(mockCalls).toEqual([]);
  });
});
// The end-to-end proofs (the completion succeeds for a technician and an admin with the line flagged, stock untouched; 400 for
// a malformed amount; an identical retry replaying) are in complete-implausible-product-amount-postgres.test.js.
