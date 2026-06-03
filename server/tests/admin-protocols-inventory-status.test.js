const adminProtocolsRouter = require('../routes/admin-protocols');

const {
  defaultProductStockPublishIssue,
  stockStatusForProduct,
} = adminProtocolsRouter._internals;

describe('admin protocols inventory status', () => {
  test('treats tracked zero or negative inventory as depleted before low-stock threshold checks', () => {
    expect(stockStatusForProduct({
      inventory_on_hand: 0,
      low_stock_threshold: null,
    })).toBe('depleted');

    expect(stockStatusForProduct({
      inventory_on_hand: '0',
      low_stock_threshold: '0',
    })).toBe('depleted');

    expect(stockStatusForProduct({
      inventory_on_hand: -1,
      low_stock_threshold: 5,
    })).toBe('depleted');
  });

  test('distinguishes missing inventory from depleted and low inventory', () => {
    expect(stockStatusForProduct(null)).toBe('unmapped');
    expect(stockStatusForProduct({
      inventory_on_hand: null,
      low_stock_threshold: 5,
    })).toBe('not_tracked');
    expect(stockStatusForProduct({
      inventory_on_hand: 3,
      low_stock_threshold: 5,
    })).toBe('low');
    expect(stockStatusForProduct({
      inventory_on_hand: 6,
      low_stock_threshold: 5,
    })).toBe('ok');
  });

  test('blocks publishing when a required default product is depleted', () => {
    const issue = defaultProductStockPublishIssue('depleted', {
      product: { id: 'protocol-product-1' },
      catalog: {
        id: 'catalog-product-1',
        name: 'Talstar P',
        inventory_on_hand: 0,
        low_stock_threshold: null,
        inventory_unit: 'fl_oz',
      },
      window: { window_key: 'jun_blackout_stress' },
    });

    expect(issue).toEqual({
      severity: 'block',
      code: 'depleted_default_product',
      message: 'Talstar P is depleted and is required by the draft.',
      metadata: {
        windowKey: 'jun_blackout_stress',
        productId: 'protocol-product-1',
        catalogProductId: 'catalog-product-1',
        onHand: 0,
        lowStockThreshold: null,
        unit: 'fl_oz',
      },
    });
  });
});
