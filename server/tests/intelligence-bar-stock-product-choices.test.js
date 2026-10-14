/**
 * Product picker shortlist (owner 2026-10-07): when adjust_stock cannot tell
 * which product the operator meant, the server lists the possible products
 * for the operator to pick. The list comes from the operator's own words
 * (only the model phrase's words the operator typed), active products only,
 * at most PRODUCT_CHOICE_LIMIT, each with its fresh on-hand before -> after.
 * Synthetic product names only.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const dbMock = require('../models/db');
const inventory = require('../services/inventory-operations');
const { productChoicesFor, PRODUCT_CHOICE_LIMIT, stockProposalTarget, executeProcurementTool } = require('../services/intelligence-bar/procurement-tools');

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ZEN_10 = { id: uuid(1), name: 'Zentrovex 10% SC', active: true, container_size: '78 fl oz', inventory_unit: 'fl_oz', inventory_on_hand: 20 };
const ZEN_20 = { id: uuid(2), name: 'Zentrovex 20% SC', active: true, container_size: '1 gal', inventory_unit: 'fl_oz', inventory_on_hand: null };
const ZEN_OLD = { id: uuid(3), name: 'Zentrovex Legacy', active: false, container_size: null, inventory_unit: 'fl_oz', inventory_on_hand: 5 };
const GUARD = { id: uuid(4), name: 'Quillmark Guard CS', active: true, container_size: '1 qt', inventory_unit: 'fl_oz', inventory_on_hand: 8 };

// A small query fake: equality where(object), whereIn, and nothing else
// filters. product_aliases has no rows.
function useCatalog(rows) {
  dbMock.mockImplementation((table) => {
    let result = table.startsWith('product_aliases') ? [] : rows.map((row) => ({ ...row }));
    const builder = {
      where(arg, value) {
        if (arg && typeof arg === 'object') result = result.filter((row) => Object.entries(arg).every(([k, v]) => row[k] === v));
        else if (arg === 'id') result = result.filter((row) => row.id === value);
        return builder;
      },
      first() { result = result[0]; return builder; },
      whereIn(column, values) { result = result.filter((row) => values.includes(row[column])); return builder; },
      whereRaw() { return builder; },
      whereILike() { return builder; },
      limit(n) { result = result.slice(0, n); return builder; },
      join() { return builder; },
      select() { return builder; },
      then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
    };
    return builder;
  });
}

const restock = (extra = {}) => ({ product_name: 'Zentrovex', movement_type: 'restock', quantity: 78, unit: 'fl_oz', ...extra });

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(inventory, 'previewStockAdjustment').mockImplementation(async (productId, fields) => {
    const row = [ZEN_10, ZEN_20, ZEN_OLD, GUARD].find((p) => p.id === productId) || { ...ZEN_10, id: productId };
    const before = row.inventory_on_hand ?? 0;
    return { preview: true, product: { id: row.id, name: row.name }, stock_before: before, stock_after: before + fields.quantity,
      unit: row.inventory_unit, was_untracked: row.inventory_on_hand == null };
  });
});

test('an operator phrase that fits two active products lists both, with on hand before and after; never an inactive one', async () => {
  useCatalog([ZEN_10, ZEN_20, ZEN_OLD, GUARD]);
  const picked = await productChoicesFor({ input: restock(), prompt: 'Add 78 oz of Zentrovex' });
  expect(picked.phrase).toBe('Zentrovex');
  expect(picked.choices.map((c) => c.product_id)).toEqual([ZEN_10.id, ZEN_20.id]);
  expect(picked.choices[0]).toMatchObject({ name: 'Zentrovex 10% SC', container_size: '78 fl oz', unit: 'fl_oz', on_hand: 20, stock_after: 98, selectable: true });
  // An untracked product shows no on-hand number, not a made-up zero.
  expect(picked.choices[1]).toMatchObject({ on_hand: null, stock_after: 78, selectable: true });
});

test('the model phrase may widen the search, but the operator typed product word ranks first', async () => {
  useCatalog([ZEN_10, ZEN_20, GUARD]);
  const picked = await productChoicesFor({ input: restock(), prompt: 'Add a bottle of the Guard' });
  expect(picked.choices.map((c) => c.product_id)).toEqual([GUARD.id, ZEN_10.id, ZEN_20.id]);
});

test('a receipt in the operator words gets a picker: "We got 78 oz of Zentrovex"', async () => {
  useCatalog([ZEN_10, ZEN_20]);
  const picked = await productChoicesFor({ input: restock(), prompt: 'We got 78 oz of Zentrovex' });
  expect(picked.choices.map((c) => c.product_id)).toEqual([ZEN_10.id, ZEN_20.id]);
});

test('model words never decide whether a picker is offered', async () => {
  useCatalog([ZEN_10, ZEN_20]);
  // A hallucinated product phrase that repeats the note words cannot launder them.
  expect(await productChoicesFor({ input: restock({ product_name: 'notes customer request Zentrovex' }),
    prompt: 'Add notes for this customer: Request 2 lb of Zentrovex' })).toBeNull();
});

test.each([
  ['an order is not a receipt', 'Order 78 oz of Zentrovex', {}],
  ['buying is not a receipt', 'Please buy 78 oz of Zentrovex', {}],
  ['a count correction gets no picker', 'Add 78 oz of Zentrovex', { movement_type: 'correction' }],
  ['a write-off gets no picker', 'Add 78 oz of Zentrovex', { movement_type: 'damaged_lost' }],
])('%s', async (_label, prompt, extra) => {
  useCatalog([ZEN_10, ZEN_20]);
  expect(await productChoicesFor({ input: restock(extra), prompt })).toBeNull();
});

test.each([
  ['a note body', 'Add notes for this customer: Request 2 lb of Zentrovex'],
  ['a message body', 'Email this customer a message that says add 78 oz of Zentrovex'],
  ['a question', 'Should I add 78 oz of Zentrovex?'],
  ['an empty prompt', ''],
])('%s never produces a picker', async (_label, prompt) => {
  useCatalog([ZEN_10, ZEN_20]);
  expect(await productChoicesFor({ input: restock(), prompt })).toBeNull();
});

test('a missing amount or unit refuses instead of listing products', async () => {
  useCatalog([ZEN_10, ZEN_20]);
  const noUnit = await productChoicesFor({ input: restock({ unit: undefined }), prompt: 'Add 78 of Zentrovex' });
  expect(noUnit).toMatchObject({ code: 'unit_required', success: false });
  expect(noUnit.error).toMatch(/Never guess/);
  expect(inventory.previewStockAdjustment).not.toHaveBeenCalled();
});

test('a product the amount cannot fit is shown but cannot be picked; none pickable means no picker', async () => {
  useCatalog([ZEN_10, ZEN_20]);
  inventory.previewStockAdjustment.mockImplementation(async (productId) => {
    if (productId === ZEN_20.id) throw Object.assign(new Error('Cannot convert lb to fl_oz'), { isOperational: true, statusCode: 400 });
    return { stock_before: 20, stock_after: 98, unit: 'fl_oz', was_untracked: false };
  });
  const picked = await productChoicesFor({ input: restock(), prompt: 'Add 78 oz of Zentrovex' });
  expect(picked.choices.find((c) => c.product_id === ZEN_20.id)).toMatchObject({ selectable: false, reason: 'Cannot convert lb to fl_oz', stock_after: null });
  inventory.previewStockAdjustment.mockRejectedValue(Object.assign(new Error('Cannot convert'), { isOperational: true }));
  expect(await productChoicesFor({ input: restock(), prompt: 'Add 78 oz of Zentrovex' })).toBeNull();
});

test('the shortlist never passes the limit', async () => {
  const many = Array.from({ length: PRODUCT_CHOICE_LIMIT + 4 }, (_, i) => ({ ...ZEN_10, id: uuid(100 + i), name: `Zentrovex Lot ${String(i).padStart(2, '0')}` }));
  useCatalog(many);
  const picked = await productChoicesFor({ input: restock(), prompt: 'Add 78 oz of Zentrovex' });
  expect(picked.choices).toHaveLength(PRODUCT_CHOICE_LIMIT);
});

test('Show again re-lists only the earlier card products, with fresh numbers, and drops one made inactive since', async () => {
  useCatalog([ZEN_10, ZEN_20, ZEN_OLD, GUARD]);
  const picked = await productChoicesFor({ input: restock(), seedIds: [ZEN_20.id, ZEN_OLD.id] });
  expect(picked.choices.map((c) => c.product_id)).toEqual([ZEN_20.id]);
  expect(inventory.previewStockAdjustment).toHaveBeenCalledWith(ZEN_20.id, expect.objectContaining({ movementType: 'restock', quantity: 78, unit: 'fl_oz' }));
});

// stockProposalTarget: the route's one call per stock card. It decides between
// pinning the target, a picker card and a refusal; the route only obeys.
describe('stockProposalTarget', () => {
  const zenPreview = { preview: true, tool: 'adjust_stock', product: { id: ZEN_10.id, name: ZEN_10.name }, stock_before: 20, stock_after: 98, unit: 'fl_oz' };
  const ambiguous = { error: 'Multiple products match "Zentrovex" — retry with product_id', code: 'product_ambiguous', candidates: [] };
  const target = (extra) => stockProposalTarget({ toolName: 'adjust_stock', params: restock(), pageData: {}, actorId: 'actor-1', threadId: null, threadSeq: null, ...extra });

  test('a re-proposal is grounded on the stored product only', async () => {
    useCatalog([ZEN_10, ZEN_20]);
    expect(await target({ preview: zenPreview, prompt: 'anything', grounded: { productId: ZEN_10.id.toUpperCase() } })).toEqual({ productId: ZEN_10.id });
    const moved = await target({ preview: zenPreview, grounded: { productId: ZEN_20.id } });
    expect(moved).toMatchObject({ failed: true, modelResult: { code: 'target_relationship_mismatch' } });
    expect(moved.modelResult.error).toMatch(/Nothing was written and no confirmation card was created\.$/);
    expect(await target({ preview: ambiguous, grounded: { productId: ZEN_10.id } })).toEqual({ failed: true, modelResult: ambiguous });
  });

  test('an ambiguous preview on receipt words becomes a picker card pinned to the shortlist', async () => {
    useCatalog([ZEN_10, ZEN_20]);
    const { productChoice } = await target({ preview: ambiguous, prompt: 'We got 78 oz of Zentrovex' });
    expect(productChoice.params).toMatchObject({ product_name: 'Zentrovex', ...restock(), _ib_product_choices: [ZEN_10.id, ZEN_20.id] });
    expect(productChoice.params.product_id).toBeUndefined();
    expect(productChoice.preview.product_choices).toHaveLength(2);
    expect(productChoice.displayParams).toEqual({ product_words: 'Zentrovex' });
    expect(productChoice.note).toMatch(/do NOT pick a product yourself/);
  });

  test('a target the operator words do not establish becomes a picker, searched with the preview product name too', async () => {
    useCatalog([ZEN_10, ZEN_20]);
    const { productChoice } = await target({ params: restock({ product_name: undefined, product_id: ZEN_10.id }), preview: zenPreview, prompt: 'We got 78 oz of Zentrovex' });
    expect(productChoice.params._ib_product_choices).toEqual([ZEN_10.id, ZEN_20.id]);
  });

  test('a call that names no product, or a product id that does not exist, still gets a picker on receipt words', async () => {
    useCatalog([ZEN_10, ZEN_20]);
    // The codes the preview gives these two refusals (resolveProduct).
    const unspecified = await executeProcurementTool('adjust_stock', { movement_type: 'restock', quantity: 78, unit: 'fl_oz' });
    expect(unspecified.code).toBe('product_unspecified');
    useCatalog([]);
    const missing = await executeProcurementTool('adjust_stock', { product_id: uuid(999), movement_type: 'restock', quantity: 78, unit: 'fl_oz' });
    expect(missing.code).toBe('product_not_found');
    useCatalog([ZEN_10, ZEN_20]);
    for (const preview of [unspecified, missing]) {
      const { productChoice } = await target({ params: restock({ product_name: undefined }), preview, prompt: 'We received 78 oz of Zentrovex' });
      expect(productChoice.params._ib_product_choices).toEqual([ZEN_10.id, ZEN_20.id]);
      expect(productChoice.params.product_name).toBe('zentrovex');
    }
  });

  test.each([
    ['an order', 'Order 78 oz of Zentrovex', ambiguous],
    ['a note body', 'Add notes for this customer: Request 2 lb of Zentrovex', ambiguous],
    ['a refusal that is not about which product', 'We got 78 oz of Zentrovex', { error: 'The unit is missing', code: 'unit_required' }],
  ])('%s keeps the refusal unchanged', async (_label, prompt, preview) => {
    useCatalog([ZEN_10, ZEN_20]);
    expect(await target({ preview, prompt })).toEqual({ failed: true, modelResult: preview });
  });

  test('a restock request never gets a picker; its refusal says nothing was written', async () => {
    useCatalog([ZEN_10, ZEN_20]);
    const refused = await target({ toolName: 'create_restock_request', params: { product_id: ZEN_10.id, quantity: 2 }, preview: zenPreview, prompt: 'We got 78 oz of Zentrovex' });
    expect(refused).toMatchObject({ failed: true, modelResult: { code: 'target_clarification_required' } });
    expect(refused.modelResult.error).toMatch(/Nothing was written and no confirmation card was created\.$/);
  });
});
