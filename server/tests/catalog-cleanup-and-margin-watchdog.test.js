'use strict';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const {
  isCountBasedProduct,
  planStaleOverrideClears,
  planMissingVendorLinks,
  planBrokenUsageUnitFixes,
  runCleanup,
} = require('../../ops/agents/cleanup-catalog-cost-overrides');
const {
  WATCHDOG_ALERT_KEY,
  WATCHED_SERVICES,
  detectVendorCostSpikes,
  evaluateServiceMargins,
  runInventoryMarginWatchdog,
} = require('../services/inventory-margin-watchdog');

describe('cleanup-catalog-cost-overrides (MUTATES with --execute, preserves count items & revalidates in trx)', () => {
  test('clears stale liquid/granular cost_per_unit overrides while explicitly skipping count items (unit_size_oz IS NULL / each)', () => {
    const catalog = [
      // Liquid/granular stale override (Espoma Soil Acidifier 18.2x): should be cleared.
      { id: 'p-espoma', name: 'Espoma Soil Acidifier', active: true, cost_per_unit: 2.0, cost_unit: 'oz', best_price: 52.80, unit_size_oz: 480, best_vendor_pricing_id: 'vp-1' },
      // Empty cost_unit (implicit unit per usage row, e.g. bottle): MUST be skipped!
      { id: 'p-implicit', name: 'Implicit Unit Chem', active: true, cost_per_unit: 25.0, cost_unit: null, best_price: 25.00, unit_size_oz: 64, best_vendor_pricing_id: 'vp-5' },
      // Count-based item (unit_size_oz NULL): MUST NEVER be touched!
      { id: 'p-station', name: 'Sentricon Bait Station', active: true, cost_per_unit: 8.69, cost_unit: 'each', best_price: 86.90, unit_size_oz: null, best_vendor_pricing_id: 'vp-2' },
      // Count cost_unit even with unit_size_oz populated: preserved!
      { id: 'p-trap', name: 'Snap Trap', active: true, cost_per_unit: 3.50, cost_unit: 'each', best_price: 42.00, unit_size_oz: 12, best_vendor_pricing_id: 'vp-3' },
      // Unapproved vendor_pricing link: skipped!
      { id: 'p-unapproved', name: 'Pending Chem', active: true, cost_per_unit: 5.00, cost_unit: 'fl_oz', best_price: 20.00, unit_size_oz: 64, best_vendor_pricing_id: 'vp-unapproved' },
      // Already accurate within 5%: skipped!
      { id: 'p-fresh', name: 'Accurate Herbicide', active: true, cost_per_unit: 1.02, cost_unit: 'fl_oz', best_price: 64.00, unit_size_oz: 64, best_vendor_pricing_id: 'vp-4' },
      // Fallback usage row in 'bottle' would break if override cleared -> MUST be skipped!
      { id: 'p-bottle-dep', name: 'Bottle Dependent', active: true, cost_per_unit: 2.0, cost_unit: 'oz', best_price: 50.00, unit_size_oz: 64, best_vendor_pricing_id: 'vp-6' },
      // Automatic supply deduction uses cost_per_unit directly -> MUST be preserved!
      { id: 'p-supply-deduct', name: 'Auto Deduct Supply', active: true, cost_per_unit: 2.0, cost_unit: 'oz', best_price: 50.00, unit_size_oz: 64, best_vendor_pricing_id: 'vp-6', per_completion_usage: 1.5 },
    ];
    const usageByProduct = new Map([
      ['p-espoma', [{ usage_amount: 4, usage_unit: 'oz' }]],
      ['p-bottle-dep', [{ usage_amount: 1, usage_unit: 'bottle' }]],
    ]);
    const { planned, skippedCountItems } = planStaleOverrideClears(catalog, ['vp-1', 'vp-2', 'vp-3', 'vp-4', 'vp-5', 'vp-6'], usageByProduct);
    expect(planned.map((p) => p.id)).toEqual(['p-espoma']);
    expect(planned[0].liveDerivedPerUnit).toBeCloseTo(0.11, 4);
    expect(skippedCountItems.map((s) => s.id)).toEqual(['p-station', 'p-trap']);
  });

  test('isCountBasedProduct classifies null/zero unit_size_oz and count cost units accurately', () => {
    expect(isCountBasedProduct({ unit_size_oz: null, cost_unit: 'each' })).toBe(true);
    expect(isCountBasedProduct({ unit_size_oz: 0, cost_unit: 'oz' })).toBe(true);
    expect(isCountBasedProduct({ unit_size_oz: 78, cost_unit: 'bottle' })).toBe(true);
    expect(isCountBasedProduct({ unit_size_oz: 78, cost_unit: 'fl_oz' })).toBe(false);
  });

  test('planMissingVendorLinks scales packages via scoreVendorRows and refuses unscalable pack/case quotes even when best_price is null', () => {
    const unlinked = [
      // Scalable measured product (50 lb bag = 800 oz): scales vendor pack price cleanly.
      { id: 'p-lesco', name: 'LESCO Dimension 0.21% 18-0-10', active: true, unit_size_oz: 800, container_size: '50 lb', best_price: null, best_vendor_pricing_id: null },
      // Measured product with null best_price whose only quote is an unscalable case price: MUST SKIP!
      { id: 'p-case-only', name: 'Liquid Concentrate', active: true, unit_size_oz: 64, container_size: '64 fl oz', best_price: null, best_vendor_pricing_id: null },
      // Liquid product whose only quote is in pounds (weight vs volume clash): MUST SKIP!
      { id: 'p-clash', name: 'Liquid Gal Chem', active: true, unit_size_oz: 128, container_size: '1 gal', best_price: null, best_vendor_pricing_id: null },
      // Liquid product whose only quote is '1 case' with unit_normalized='lb' (weight vs volume clash via normalized unit): MUST SKIP!
      { id: 'p-norm-clash', name: 'Liquid Gal Normalized Clash', active: true, unit_size_oz: 128, container_size: '1 gal', best_price: null, best_vendor_pricing_id: null },
      // Count item with valid existing single-station price ($8.69) and unscalable pack row ($86.94 / "1 box"): MUST NOT overwrite!
      { id: 'p-hexpro', name: 'HexPro Station', active: true, unit_size_oz: null, container_size: '1 station', best_price: 8.69, best_vendor_pricing_id: null },
      // Unmeasured count product with null best_price and explicit 1-station match: allowed!
      { id: 'p-single', name: 'Single Station', active: true, unit_size_oz: null, container_size: '1 station', best_price: null, best_vendor_pricing_id: null },
      { id: 'p-already', name: 'Already Linked', active: true, unit_size_oz: 64, best_vendor_pricing_id: 'vp-existing' },
    ];
    const eligible = [
      { id: 'vp-hi', product_id: 'p-lesco', vendor_id: 'v-2', vendor_name: 'SiteOne', price_amount: 49.50, quantity: '50 lb', shipping_cost: 0 },
      { id: 'vp-lo', product_id: 'p-lesco', vendor_id: 'v-1', vendor_name: 'Target Specialty', price_amount: 42.25, quantity: '50 lb', shipping_cost: 0 },
      { id: 'vp-case', product_id: 'p-case-only', vendor_id: 'v-1', vendor_name: 'Target Specialty', price_amount: 480.00, quantity: '1 case', shipping_cost: 0 },
      { id: 'vp-clash', product_id: 'p-clash', vendor_id: 'v-1', vendor_name: 'Target Specialty', price_amount: 12.00, quantity: '1 lb', shipping_cost: 0 },
      { id: 'vp-norm-clash', product_id: 'p-norm-clash', vendor_id: 'v-1', vendor_name: 'Target Specialty', price_amount: 20.00, quantity: '1 case', unit_normalized: 'lb', normalized_unit_price: 20.00, shipping_cost: 0 },
      { id: 'vp-pack', product_id: 'p-hexpro', vendor_id: 'v-1', vendor_name: 'Target Specialty', price_amount: 86.94, quantity: '1 box', shipping_cost: 0 },
      { id: 'vp-single', product_id: 'p-single', vendor_id: 'v-1', vendor_name: 'Target Specialty', price_amount: 9.50, quantity: '1 station', shipping_cost: 0 },
    ];
    const planned = planMissingVendorLinks(unlinked, eligible);
    expect(planned).toEqual([
      {
        productId: 'p-lesco',
        productName: 'LESCO Dimension 0.21% 18-0-10',
        bestVendorPricingId: 'vp-lo',
        vendorId: 'v-1',
        vendorName: 'Target Specialty',
        mode: 'oz',
        bestPrice: 42.25,
      },
      {
        productId: 'p-single',
        productName: 'Single Station',
        bestVendorPricingId: 'vp-single',
        vendorId: 'v-1',
        vendorName: 'Target Specialty',
        mode: 'count',
        bestPrice: 9.5,
      },
    ]);
  });

  test('converts ONLY broken liquid "bottle" mappings (preserving zero base usage for revalidation) and skips dry weight or working bottle prices', () => {
    const usage = [
      // Broken liquid bottle with BOTH usage_amount and usage_per_1000sf -> converts both!
      {
        id: 'u-1', service_type: 'Liquid Termite Perimeter', product_id: 'p-termidor', product_name: 'Termidor SC',
        usage_amount: 1, usage_per_1000sf: 0.5, usage_unit: 'bottle', unit_size_oz: 78, container_size: '78 fl oz', best_price: 174.72,
      },
      // Area-rate-only broken liquid bottle with explicit 0 usage_amount -> preserves fromAmount: 0 for revalidation!
      {
        id: 'u-area', service_type: 'Liquid Barrier', product_id: 'p-taurus', product_name: 'Taurus SC',
        usage_amount: 0, usage_per_1000sf: 0.25, usage_unit: 'bottle', unit_size_oz: 78, container_size: '78 fl oz', best_price: 86.00,
      },
      // Multipack liquid case ("4 x 1 gal" or "12 bottles / 16 fl oz") -> MUST skip so 1 bottle never becomes the whole case!
      {
        id: 'u-multipack', service_type: 'Liquid Barrier', product_id: 'p-case', product_name: '4x1 Gal Case',
        usage_amount: 1, usage_per_1000sf: null, usage_unit: 'bottle', unit_size_oz: 512, container_size: '4 x 1 gal', best_price: 240.00,
      },
      {
        id: 'u-12pack', service_type: 'Liquid Barrier', product_id: 'p-12pack', product_name: '12 Bottle Case',
        usage_amount: 1, usage_per_1000sf: null, usage_unit: 'bottle', unit_size_oz: 192, container_size: '12 bottles / 16 fl oz', best_price: 180.00,
      },
      // Dry weight bottle (container_size '16 lb') -> NEVER relabel to fl_oz!
      {
        id: 'u-dry', service_type: 'Granular', product_id: 'p-dry', product_name: 'Dry Bait Bottle',
        usage_amount: 1, usage_per_1000sf: null, usage_unit: 'bottle', unit_size_oz: 256, container_size: '16 lb', best_price: 40.00,
      },
      // Working manual cost per bottle -> already prices cleanly, MUST be skipped!
      {
        id: 'u-working', service_type: 'Spot', product_id: 'p-manual', product_name: 'Priced Bottle',
        usage_amount: 1, usage_per_1000sf: null, usage_unit: 'bottle', unit_size_oz: 32, container_size: '32 fl oz',
        cost_per_unit: 19.99, cost_unit: 'bottle', best_price: 19.99,
      },
    ];
    const fixes = planBrokenUsageUnitFixes(usage);
    expect(fixes).toEqual([
      {
        usageId: 'u-1', serviceType: 'Liquid Termite Perimeter', productId: 'p-termidor', productName: 'Termidor SC',
        fromAmount: 1, fromPer1000: 0.5, fromUnit: 'bottle', toAmount: 78, toPer1000: 39, toUnit: 'fl_oz', unitSizeOz: 78,
      },
      {
        usageId: 'u-area', serviceType: 'Liquid Barrier', productId: 'p-taurus', productName: 'Taurus SC',
        fromAmount: 0, fromPer1000: 0.25, fromUnit: 'bottle', toAmount: null, toPer1000: 19.5, toUnit: 'fl_oz', unitSizeOz: 78,
      },
    ]);
  });

  test('runCleanup defaults to dry_run and --execute revalidates rows in trx + delegates vendor links to recalcBestPrice', async () => {
    const trxMock = jest.fn();
    const makeChain = (rows) => {
      const chain = {
        where: () => chain,
        whereNotNull: () => chain,
        whereNull: () => chain,
        whereIn: () => chain,
        whereRaw: () => chain,
        leftJoin: () => chain,
        join: () => chain,
        select: () => Promise.resolve(rows),
      };
      return chain;
    };
    let catalogCall = 0;
    const dbc = (table) => {
      if (table === 'products_catalog') {
        catalogCall += 1;
        return makeChain(catalogCall === 1
          ? [{ id: 'p-1', name: 'Espoma', active: true, cost_per_unit: 2.0, cost_unit: 'oz', best_price: 52.80, unit_size_oz: 480, best_vendor_pricing_id: 'vp-1' }]
          : [{ id: 'p-lesco', name: 'LESCO Dimension', active: true, unit_size_oz: 800, container_size: '50 lb', best_price: null, best_vendor_pricing_id: null }]);
      }
      if (table === 'vendor_pricing') {
        return makeChain([
          { id: 'vp-1', product_id: 'p-1', vendor_id: 'v-1', price_amount: 52.80, quantity: '30 lb' },
          { id: 'vp-2', product_id: 'p-lesco', vendor_id: 'v-1', price_amount: 42.25, quantity: '50 lb' },
        ]);
      }
      return makeChain([]);
    };
    dbc.transaction = trxMock;

    const dry = await runCleanup(dbc);
    expect(dry.mode).toBe('dry_run');
    expect(dry.staleOverridesPlanned).toBe(1);
    expect(dry.missingVendorLinksPlanned).toBe(1);
    expect(dry.applied).toEqual({ overridesCleared: 0, vendorLinksUpdated: 0, usageUnitsConverted: 0 });
    expect(trxMock).not.toHaveBeenCalled();

    // --execute: simulate admin editing p-1 cost_per_unit concurrently (should skip clear!),
    // recalcBestPrice linking p-lesco (still eligible under lock), and expired quote skipping recalcBestPrice.
    catalogCall = 0;
    const recalcBestPrice = jest.fn(async () => {});
    const updateCalls = [];
    let currentVpRowsForLock = [{ id: 'vp-2', product_id: 'p-lesco', vendor_id: 'v-1', vendor_name: 'Target', price_amount: 42.25, quantity: '50 lb', shipping_cost: 0 }];
    dbc.transaction = async (fn) => {
      let lescoChecks = 0;
      const trx = (table) => {
        let filter = null;
        const chain = {
          where: (cond) => { filter = cond; return chain; },
          whereNotNull: () => chain,
          whereIn: () => chain,
          whereRaw: () => chain,
          leftJoin: () => chain,
          forUpdate: () => chain,
          select: async () => (table === 'vendor_pricing' ? currentVpRowsForLock : []),
          first: async () => {
            if (table === 'products_catalog' && filter?.id === 'p-1') {
              // Concurrent admin already corrected cost_per_unit from 2.0 to 0.11!
              return { id: 'p-1', active: true, cost_per_unit: 0.11, cost_unit: 'oz', best_price: 52.80, unit_size_oz: 480, best_vendor_pricing_id: 'vp-1' };
            }
            if (table === 'products_catalog' && filter?.id === 'p-lesco') {
              lescoChecks += 1;
              return lescoChecks === 1
                ? { id: 'p-lesco', name: 'LESCO Dimension', active: true, unit_size_oz: 800, container_size: '50 lb', best_price: null, best_vendor_pricing_id: null }
                : { best_vendor_pricing_id: 'vp-2' };
            }
            return { id: 'vp-1' };
          },
          update: async (patch) => { updateCalls.push({ table, filter, patch }); return 1; },
        };
        return chain;
      };
      trx.raw = jest.fn(async () => ({}));
      return fn(trx);
    };

    const execRes = await runCleanup(dbc, { execute: true, helpers: { recalcBestPrice } });
    expect(execRes.mode).toBe('execute');
    expect(execRes.applied.overridesCleared).toBe(0); // concurrent admin fix preserved!
    expect(execRes.applied.vendorLinksUpdated).toBe(1);
    expect(recalcBestPrice).toHaveBeenCalledWith('p-lesco', expect.any(Function));
    expect(updateCalls).toHaveLength(0);

    // If the last eligible quote expires before the lock runs, recalcBestPrice MUST NOT be called!
    catalogCall = 0;
    recalcBestPrice.mockClear();
    currentVpRowsForLock = [];
    const expiredRes = await runCleanup(dbc, { execute: true, helpers: { recalcBestPrice } });
    expect(expiredRes.applied.vendorLinksUpdated).toBe(0);
    expect(recalcBestPrice).not.toHaveBeenCalled();
  });
});

describe('inventory-margin-watchdog (one-way read-only alerting with normalized pack prices)', () => {
  test('detectVendorCostSpikes compares consecutive winning costs (ignoring $100->$150->$130 cuts) and catches approved worker snapshot spikes', () => {
    const catalog = [
      { id: 'p-taurus', name: 'Taurus SC', active: true, best_price: 86.63, unit_size_oz: 78, container_size: '78 fl oz' },
      { id: 'p-termidor', name: 'Termidor SC', active: true, best_price: 210.00, unit_size_oz: 78, container_size: '78 fl oz' },
      { id: 'p-pack', name: 'Bifen I/T', active: true, best_price: 120.00, unit_size_oz: 64, container_size: '64 fl oz' },
      { id: 'p-switched', name: 'Demand CS', active: true, best_price: 130.00, unit_size_oz: 32, container_size: '32 fl oz' },
      { id: 'p-cut-after-spike', name: 'Suspend PolyZone', active: true, best_price: 130.00, unit_size_oz: 32, container_size: '32 fl oz' },
      { id: 'p-expired-ignored', name: 'Temprid FX', active: true, best_price: 130.00, unit_size_oz: 32, container_size: '32 fl oz' },
      { id: 'p-expired-spike', name: 'Transport Mikron', active: true, best_price: 160.00, unit_size_oz: 32, container_size: '32 fl oz' },
      { id: 'p-small-bump', name: 'Alpine WSG', active: true, best_price: 84.00, unit_size_oz: 17.6, container_size: '500 g' },
    ];
    const vendorRows = [
      { id: 'vp-1', product_id: 'p-taurus', vendor_id: 'v-1', price_amount: 86.63, quantity: '78 fl oz' },
      { id: 'vp-2', product_id: 'p-termidor', vendor_id: 'v-1', price_amount: 210.00, quantity: '78 fl oz' },
      { id: 'vp-3', product_id: 'p-pack', vendor_id: 'v-1', price_amount: 120.00, quantity: '64 fl oz' },
      { id: 'vp-5', product_id: 'p-switched', vendor_id: 'v-2', price_amount: 130.00, quantity: '32 fl oz' },
      // $100 -> $150 -> $130: final step is a price CUT, MUST NOT report a 30% spike!
      { id: 'vp-6', product_id: 'p-cut-after-spike', vendor_id: 'v-1', price_amount: 130.00, quantity: '32 fl oz' },
      // Expired v-old quoted $100 earlier, while eligible v-2 dropped $150 -> $130: MUST NOT fake a spike!
      { id: 'vp-7', product_id: 'p-expired-ignored', vendor_id: 'v-2', price_amount: 130.00, quantity: '32 fl oz' },
      // Expired v-old won at $100 while eligible v-2 rose $150 -> $160: MUST catch the +60% jump vs $100!
      { id: 'vp-8', product_id: 'p-expired-spike', vendor_id: 'v-2', price_amount: 160.00, quantity: '32 fl oz' },
      { id: 'vp-4', product_id: 'p-small-bump', vendor_id: 'v-1', price_amount: 84.00, quantity: '500 g' },
    ];
    const priceHistory = [
      { product_id: 'p-taurus', vendor_id: 'v-1', price: 86.63, quantity: '78 fl oz', recorded_at: '2026-11-20T00:00:00Z' },
      { product_id: 'p-taurus', vendor_id: 'v-1', price: 95.00, quantity: '78 fl oz', recorded_at: '2026-10-01T00:00:00Z' },
      { product_id: 'p-termidor', vendor_id: 'v-1', price_amount: 210.00, quantity: '78 fl oz', approved_at: '2026-11-20T00:00:00Z' },
      { product_id: 'p-termidor', vendor_id: 'v-1', price_amount: 174.72, quantity: '78 fl oz', approved_at: '2026-10-01T00:00:00Z' },
      { product_id: 'p-pack', vendor_id: 'v-1', price: 120.00, quantity: '64 fl oz', recorded_at: '2026-11-20T00:00:00Z' },
      { product_id: 'p-pack', vendor_id: 'v-1', price: 60.00, quantity: '32 fl oz', recorded_at: '2026-10-01T00:00:00Z' },
      { product_id: 'p-switched', vendor_id: 'v-2', price: 130.00, quantity: '32 fl oz', recorded_at: '2026-11-01T00:00:00Z' },
      { product_id: 'p-switched', vendor_id: 'v-1', price: 100.00, quantity: '32 fl oz', recorded_at: '2026-10-01T00:00:00Z' },
      { product_id: 'p-cut-after-spike', vendor_id: 'v-1', price: 130.00, quantity: '32 fl oz', recorded_at: '2026-11-20T00:00:00Z' },
      { product_id: 'p-cut-after-spike', vendor_id: 'v-1', price: 150.00, quantity: '32 fl oz', recorded_at: '2026-11-01T00:00:00Z' },
      { product_id: 'p-cut-after-spike', vendor_id: 'v-1', price: 100.00, quantity: '32 fl oz', recorded_at: '2026-10-01T00:00:00Z' },
      { product_id: 'p-expired-ignored', vendor_id: 'v-2', price: 130.00, quantity: '32 fl oz', recorded_at: '2026-11-20T00:00:00Z' },
      { product_id: 'p-expired-ignored', vendor_id: 'v-2', price: 150.00, quantity: '32 fl oz', recorded_at: '2026-11-01T00:00:00Z' },
      { product_id: 'p-expired-ignored', vendor_id: 'v-old', price: 100.00, quantity: '32 fl oz', recorded_at: '2026-10-01T00:00:00Z' },
      { product_id: 'p-expired-spike', vendor_id: 'v-2', price: 160.00, quantity: '32 fl oz', recorded_at: '2026-11-20T00:00:00Z' },
      { product_id: 'p-expired-spike', vendor_id: 'v-2', price: 150.00, quantity: '32 fl oz', recorded_at: '2026-11-01T00:00:00Z' },
      { product_id: 'p-expired-spike', vendor_id: 'v-old', price: 100.00, quantity: '32 fl oz', recorded_at: '2026-10-01T00:00:00Z' },
      { product_id: 'p-small-bump', vendor_id: 'v-1', price: 84.00, quantity: '500 g', recorded_at: '2026-11-20T00:00:00Z' },
      { product_id: 'p-small-bump', vendor_id: 'v-1', price: 80.00, quantity: '500 g', recorded_at: '2026-10-01T00:00:00Z' },
    ];
    const spikes = detectVendorCostSpikes(catalog, vendorRows, priceHistory);
    expect(spikes.map((s) => s.productId)).toEqual(['p-termidor', 'p-switched', 'p-expired-spike']);
    expect(spikes[2]).toMatchObject({ productId: 'p-expired-spike', pctIncrease: 60 });
    expect(spikes[0]).toMatchObject({
      productId: 'p-termidor',
      productName: 'Termidor SC',
      basis: 'oz',
      pctIncrease: 20.2,
      unitMismatchLikely: false,
    });
    expect(spikes[1]).toMatchObject({
      productId: 'p-switched',
      pctIncrease: 30,
    });
  });

  test('evaluateServiceMargins verifies both required mosquito mappings, recognizes Liquid Termite Perimeter in trenching, amortizes fixedCost, and flags missing revenue', () => {
    const { inventoryCostFromRows: realInventoryCostFromRows } = require('../services/estimate-pricing-audit');
    const trenchingCogs = realInventoryCostFromRows('trenching', { homeSqFt: 2000 }, {
      available: true,
      rows: [{
        service_type: 'Liquid Termite Perimeter',
        product_id: 'p-termidor',
        product_name: 'Termidor SC',
        usage_amount: 78,
        usage_unit: 'fl_oz',
        unit_size_oz: 78,
        best_price: 174.72,
      }],
    });
    expect(trenchingCogs.status).toBe('ok');
    expect(trenchingCogs.matchedServiceType).toBe('Liquid Termite Perimeter');
    expect(trenchingCogs.totalPerVisit).toBeCloseTo(174.72, 2);
    expect(WATCHED_SERVICES.map((s) => s.engineServiceKey)).toEqual(
      expect.arrayContaining(['pest_control', 'mosquito', 'tree_shrub', 'one_time_pest', 'rodent_trapping', 'stinging_insect', 'trenching', 'bora_care']),
    );
    const generateEstimate = ({ services }) => {
      if (services.pest) return { lineItems: [{ service: 'pest_control', perVisit: 40 }] };
      if (services.mosquito) return { lineItems: [{ service: 'mosquito', perVisit: 75 }] };
      if (services.treeShrub) return { lineItems: [{ service: 'tree_shrub', perVisit: 90 }] };
      if (services.oneTimePest) return { lineItems: [{ service: 'one_time_pest', price: 250 }] };
      if (services.rodentTrapping) return { lineItems: [{ service: 'rodent_trapping', price: 350 }] };
      if (services.stinging) return { lineItems: [{ service: 'stinging_insect', price: 175 }] };
      if (services.trenching) return { lineItems: [{ service: 'trenching', price: 1800 }] };
      if (services.boraCare) return { lineItems: [] };
      return { lineItems: [] };
    };
    const inventoryCostFromRows = (serviceKey) => {
      if (serviceKey === 'pest_control') return { status: 'ok', totalPerVisit: 10, fixedCost: 40, lines: [], warnings: [] };
      // Only IGR mapped (Barrier missing!) -> MUST flag missingCogs on mosquito!
      if (serviceKey === 'mosquito') {
        return {
          status: 'ok',
          totalPerVisit: 3,
          fixedCost: 0,
          lines: [{ serviceType: 'Mosquito Treatment - IGR', cost: 3, warning: null }],
          warnings: [],
        };
      }
      if (serviceKey === 'rodent_trapping' || serviceKey === 'stinging') {
        return { status: 'missing_cogs', totalPerVisit: 0, fixedCost: 0, lines: [], warnings: ['No inventory COGS rows mapped'] };
      }
      return { status: 'ok', totalPerVisit: 8, fixedCost: 0, lines: [], warnings: [] };
    };
    const { lowMargins, missingCogs, incompleteChecks } = evaluateServiceMargins({
      inventory: { available: true, rows: [] },
      generateEstimate,
      inventoryCostFromRows,
      laborRate: 35,
    });
    expect(lowMargins.map((m) => m.serviceKey)).toEqual(['pest_control']);
    expect(lowMargins[0].materialCost).toBe(20);
    expect(missingCogs.map((m) => m.serviceKey)).toEqual(['mosquito', 'rodent_trapping', 'stinging']);
    expect(missingCogs[0].missingServiceTypes).toEqual(['Mosquito Treatment - Essential Barrier']);
    expect(incompleteChecks.map((c) => c.serviceKey)).toEqual(['bora_care']);
  });

  test('evaluateServiceMargins reads real engine labor costs (onSite+drive, laborPerVisit, annual laborCost/visits) before falling back', () => {
    const generateEstimate = ({ services }) => {
      if (services.pest) return { lineItems: [{ service: 'pest_control', perVisit: 45, costs: { onSiteLaborCost: 14.58, driveLaborCost: 11.67 } }] };
      if (services.mosquito) return { lineItems: [{ service: 'mosquito', perVisit: 50, costs: { laborPerVisit: 29.17 } }] };
      if (services.treeShrub) return { lineItems: [{ service: 'tree_shrub', perVisit: 45, visitsPerYear: 6, costs: { laborCost: 122.50 } }] };
      if (services.oneTimePest) return { lineItems: [{ service: 'one_time_pest', price: 250 }] };
      if (services.rodentTrapping) return { lineItems: [{ service: 'rodent_trapping', price: 350 }] };
      if (services.stinging) return { lineItems: [{ service: 'stinging_insect', price: 175 }] };
      if (services.trenching) return { lineItems: [{ service: 'trenching', price: 1800 }] };
      if (services.boraCare) return { lineItems: [{ service: 'bora_care', price: 1200 }] };
      return { lineItems: [] };
    };
    const healthyCogs = (serviceKey) => ({
      status: 'ok',
      totalPerVisit: 10,
      fixedCost: 0,
      lines: serviceKey === 'mosquito'
        ? [
          { serviceType: 'Mosquito Treatment - Essential Barrier', cost: 6, warning: null },
          { serviceType: 'Mosquito Treatment - IGR', cost: 4, warning: null },
        ]
        : [{ serviceType: serviceKey, cost: 10, warning: null }],
      warnings: [],
    });
    const { lowMargins } = evaluateServiceMargins({
      inventory: { available: true, rows: [] },
      generateEstimate,
      inventoryCostFromRows: healthyCogs,
      laborRate: 35,
    });
    const byKey = Object.fromEntries(lowMargins.map((m) => [m.serviceKey, m]));
    expect(byKey.pest_control.laborCost).toBeCloseTo(26.25, 2);
    expect(byKey.mosquito.laborCost).toBeCloseTo(29.17, 2);
    expect(byKey.tree_shrub.laborCost).toBeCloseTo(20.42, 2);
  });

  test('runInventoryMarginWatchdog respects gate, loads approved price_snapshots, keeps alert open on outage, closes when clean, and fails on null alert receipt', async () => {
    const offRes = await runInventoryMarginWatchdog({ deps: { isLive: () => false } });
    expect(offRes).toEqual({ skipped: true, reason: 'gate_off' });

    const makeDb = (catalogRows, vpRows, histRows = [], snapshotRows = []) => {
      const makeChain = (rows) => {
        const chain = {
          where: () => chain,
          whereNotNull: () => chain,
          whereIn: () => chain,
          whereRaw: () => chain,
          join: () => chain,
          orderBy: () => chain,
          orderByRaw: () => chain,
          select: () => Promise.resolve(rows),
        };
        return chain;
      };
      const fn = (table) => {
        if (table === 'products_catalog') return makeChain(catalogRows);
        if (table === 'price_history') return makeChain(histRows);
        if (String(table).startsWith('price_approval_events')) return makeChain(snapshotRows);
        return makeChain(vpRows);
      };
      fn.schema = { hasTable: async () => true };
      return fn;
    };

    const raiseAdminAlert = jest.fn(async () => ({ id: 'alert-1' }));
    const closeAdminAlertKeys = jest.fn(async () => 1);
    const healthyEstimate = ({ services }) => {
      const key = Object.keys(services)[0];
      const map = {
        pest: 'pest_control', mosquito: 'mosquito', treeShrub: 'tree_shrub', oneTimePest: 'one_time_pest',
        rodentTrapping: 'rodent_trapping', stinging: 'stinging_insect', trenching: 'trenching', boraCare: 'bora_care',
      };
      return { lineItems: [{ service: map[key], perVisit: 120, price: 850 }] };
    };
    const healthyCogs = (serviceKey) => ({
      status: 'ok',
      totalPerVisit: 5,
      fixedCost: 0,
      lines: serviceKey === 'mosquito'
        ? [
          { serviceType: 'Mosquito Treatment - Essential Barrier', cost: 3, warning: null },
          { serviceType: 'Mosquito Treatment - IGR', cost: 2, warning: null },
        ]
        : [],
      warnings: [],
    });

    // Clean run -> closes any prior alert, raises none.
    const clean = await runInventoryMarginWatchdog({
      deps: {
        isLive: () => true,
        db: makeDb(
          [{ id: 'p-1', name: 'Taurus SC', active: true, best_price: 86, unit_size_oz: 78, container_size: '78 fl oz' }],
          [{ id: 'vp-1', product_id: 'p-1', vendor_id: 'v-1', price_amount: 86, previous_price: 95, quantity: '78 fl oz' }],
        ),
        syncConstantsFromDB: async () => true,
        loadInventoryCostRows: async () => ({ available: true, rows: [] }),
        inventoryCostFromRows: healthyCogs,
        generateEstimate: healthyEstimate,
        laborRate: 35,
        raiseAdminAlert,
        closeAdminAlertKeys,
      },
    });
    expect(clean.alerted).toBe(false);
    expect(closeAdminAlertKeys).toHaveBeenCalledWith(expect.any(Function), [WATCHDOG_ALERT_KEY], 'margin_watchdog_clean', expect.any(Object));
    expect(raiseAdminAlert).not.toHaveBeenCalled();

    // Approved worker price_snapshots spike with empty price_history -> MUST alert!
    raiseAdminAlert.mockClear();
    const snapSpike = await runInventoryMarginWatchdog({
      deps: {
        isLive: () => true,
        db: makeDb(
          [{ id: 'p-1', name: 'Taurus SC', active: true, best_price: 130, unit_size_oz: 78, container_size: '78 fl oz' }],
          [{ id: 'vp-1', product_id: 'p-1', vendor_id: 'v-1', price_amount: 130, quantity: '78 fl oz' }],
          [],
          [
            { product_id: 'p-1', vendor_id: 'v-1', price_amount: 130, quantity: '78 fl oz', approved_at: '2026-11-25T00:00:00Z' },
            { product_id: 'p-1', vendor_id: 'v-1', price_amount: 100, quantity: '78 fl oz', approved_at: '2026-10-01T00:00:00Z' },
          ],
        ),
        syncConstantsFromDB: async () => true,
        loadInventoryCostRows: async () => ({ available: true, rows: [] }),
        inventoryCostFromRows: healthyCogs,
        generateEstimate: healthyEstimate,
        laborRate: 35,
        raiseAdminAlert,
        closeAdminAlertKeys,
      },
    });
    expect(snapSpike.alerted).toBe(true);
    expect(snapSpike.spikes).toHaveLength(1);
    expect(snapSpike.spikes[0].pctIncrease).toBe(30);

    // Unavailable inventory table -> MUST NOT close alert; raises incomplete-check alert!
    closeAdminAlertKeys.mockClear();
    const unavail = await runInventoryMarginWatchdog({
      deps: {
        isLive: () => true,
        db: makeDb([], []),
        syncConstantsFromDB: async () => true,
        loadInventoryCostRows: async () => ({ available: false, rows: [] }),
        inventoryCostFromRows: healthyCogs,
        generateEstimate: healthyEstimate,
        laborRate: 35,
        raiseAdminAlert,
        closeAdminAlertKeys,
      },
    });
    expect(unavail.alerted).toBe(true);
    expect(unavail.incompleteChecks).toEqual([{ check: 'inventory_unavailable', label: 'inventory COGS table' }]);
    expect(closeAdminAlertKeys).not.toHaveBeenCalled();

    // Pricing sync failure -> keeps alert open; failed alert persistence (null receipt) MUST reject!
    await expect(runInventoryMarginWatchdog({
      deps: {
        isLive: () => true,
        db: makeDb([], []),
        syncConstantsFromDB: async () => false,
        loadInventoryCostRows: async () => ({ available: true, rows: [] }),
        inventoryCostFromRows: healthyCogs,
        generateEstimate: healthyEstimate,
        laborRate: 35,
        raiseAdminAlert: async () => null,
        closeAdminAlertKeys,
      },
    })).rejects.toMatchObject({ code: 'WATCHDOG_ALERT_FAILED' });
  });
});
