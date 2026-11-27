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
  detectVendorCostSpikes,
  evaluateServiceMargins,
  runInventoryMarginWatchdog,
} = require('../services/inventory-margin-watchdog');

describe('cleanup-catalog-cost-overrides (dry-run by default, preserves count items)', () => {
  test('clears stale liquid/granular cost_per_unit overrides while explicitly skipping count items (unit_size_oz IS NULL / each)', () => {
    const catalog = [
      // Liquid/granular stale override (Espoma Soil Acidifier 18.2x): should be cleared.
      { id: 'p-espoma', name: 'Espoma Soil Acidifier', active: true, cost_per_unit: 2.0, cost_unit: 'oz', best_price: 52.80, unit_size_oz: 480, best_vendor_pricing_id: 'vp-1' },
      // Count-based item (unit_size_oz NULL): MUST NEVER be touched!
      { id: 'p-station', name: 'Sentricon Bait Station', active: true, cost_per_unit: 8.69, cost_unit: 'each', best_price: 86.90, unit_size_oz: null, best_vendor_pricing_id: 'vp-2' },
      // Count cost_unit even with unit_size_oz populated: preserved!
      { id: 'p-trap', name: 'Snap Trap', active: true, cost_per_unit: 3.50, cost_unit: 'each', best_price: 42.00, unit_size_oz: 12, best_vendor_pricing_id: 'vp-3' },
      // Unapproved vendor_pricing link: skipped!
      { id: 'p-unapproved', name: 'Pending Chem', active: true, cost_per_unit: 5.00, cost_unit: 'fl_oz', best_price: 20.00, unit_size_oz: 64, best_vendor_pricing_id: 'vp-unapproved' },
      // Already accurate within 5%: skipped!
      { id: 'p-fresh', name: 'Accurate Herbicide', active: true, cost_per_unit: 1.02, cost_unit: 'fl_oz', best_price: 64.00, unit_size_oz: 64, best_vendor_pricing_id: 'vp-4' },
    ];
    const { planned, skippedCountItems } = planStaleOverrideClears(catalog, ['vp-1', 'vp-2', 'vp-3', 'vp-4']);
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

  test('links active products missing best_vendor_pricing_id to the lowest eligible approved vendor row', () => {
    const unlinked = [
      { id: 'p-lesco', name: 'LESCO Dimension 0.21% 18-0-10', active: true, best_vendor_pricing_id: null },
      { id: 'p-already', name: 'Already Linked', active: true, best_vendor_pricing_id: 'vp-existing' },
    ];
    const eligible = [
      { id: 'vp-hi', product_id: 'p-lesco', vendor_id: 'v-2', vendor_name: 'SiteOne', price_amount: 49.50 },
      { id: 'vp-lo', product_id: 'p-lesco', vendor_id: 'v-1', vendor_name: 'Target Specialty', price_amount: 42.25 },
    ];
    const planned = planMissingVendorLinks(unlinked, eligible);
    expect(planned).toEqual([{
      productId: 'p-lesco',
      productName: 'LESCO Dimension 0.21% 18-0-10',
      bestVendorPricingId: 'vp-lo',
      vendorId: 'v-1',
      vendorName: 'Target Specialty',
      bestPrice: 42.25,
    }]);
  });

  test('converts broken "bottle" service_product_usage unit to fl_oz using unit_size_oz', () => {
    const usage = [
      { id: 'u-1', service_type: 'Liquid Termite Perimeter', product_id: 'p-termidor', product_name: 'Termidor SC', usage_amount: 1, usage_unit: 'bottle', unit_size_oz: 78 },
      { id: 'u-2', service_type: 'General Pest Perimeter', product_id: 'p-bifen', product_name: 'Bifen', usage_amount: 2, usage_unit: 'fl_oz', unit_size_oz: 128 },
    ];
    const fixes = planBrokenUsageUnitFixes(usage);
    expect(fixes).toEqual([{
      usageId: 'u-1',
      serviceType: 'Liquid Termite Perimeter',
      productId: 'p-termidor',
      productName: 'Termidor SC',
      fromAmount: 1,
      fromUnit: 'bottle',
      toAmount: 78,
      toUnit: 'fl_oz',
      unitSizeOz: 78,
    }]);
  });

  test('runCleanup defaults to dry_run without starting any write transaction', async () => {
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
          : []);
      }
      if (table === 'vendor_pricing') {
        return makeChain([{ id: 'vp-1', product_id: 'p-1', vendor_id: 'v-1', price_amount: 52.80 }]);
      }
      return makeChain([]);
    };
    dbc.transaction = trxMock;

    const dry = await runCleanup(dbc);
    expect(dry.mode).toBe('dry_run');
    expect(dry.staleOverridesPlanned).toBe(1);
    expect(dry.applied).toEqual({ overridesCleared: 0, vendorLinksUpdated: 0, usageUnitsConverted: 0 });
    expect(trxMock).not.toHaveBeenCalled();
  });
});

describe('inventory-margin-watchdog (one-way read-only alerting)', () => {
  test('detectVendorCostSpikes alerts ONLY on upward spikes >10% and ignores cheaper generic swaps', () => {
    const catalog = [
      { id: 'p-taurus', name: 'Taurus SC', active: true, best_price: 95.00 },
      { id: 'p-termidor', name: 'Termidor SC', active: true, best_price: 174.72 },
      { id: 'p-small-bump', name: 'Alpine WSG', active: true, best_price: 80.00 },
    ];
    const vendorRows = [
      // Cheaper generic substitute ($86.63 < $95): MUST be ignored (Waves keeps the margin!).
      { id: 'vp-1', product_id: 'p-taurus', price_amount: 86.63 },
      // Upward vendor spike ($210 > $174.72, +20.2%): MUST be flagged.
      { id: 'vp-2', product_id: 'p-termidor', price_amount: 210.00 },
      // Tiny +5% bump (<=10%): ignored.
      { id: 'vp-3', product_id: 'p-small-bump', price_amount: 84.00 },
    ];
    const spikes = detectVendorCostSpikes(catalog, vendorRows);
    expect(spikes).toHaveLength(1);
    expect(spikes[0]).toMatchObject({
      productId: 'p-termidor',
      productName: 'Termidor SC',
      baselinePrice: 174.72,
      currentMinPrice: 210,
      pctIncrease: 20.2,
      unitMismatchLikely: false,
    });
  });

  test('evaluateServiceMargins flags <35% modeled gross margin and missing COGS mappings', () => {
    const generateEstimate = ({ services }) => {
      if (services.pest) return { lineItems: [{ service: 'pest_control', perVisit: 30 }] }; // low rev -> <35% GM!
      if (services.mosquito) return { lineItems: [{ service: 'mosquito', perVisit: 75 }] }; // healthy GM
      if (services.treeShrub) return { lineItems: [{ service: 'tree_shrub', perVisit: 90 }] };
      if (services.oneTimePest) return { lineItems: [{ service: 'one_time_pest', price: 250 }] };
      if (services.rodentTrapping) return { lineItems: [{ service: 'rodent_trapping', price: 350 }] };
      if (services.stinging) return { lineItems: [{ service: 'stinging', price: 175 }] };
      return { lineItems: [] };
    };
    const inventoryCostFromRows = (serviceKey) => {
      if (serviceKey === 'rodent_trapping' || serviceKey === 'stinging') {
        return { status: 'missing_cogs', totalPerVisit: 0, fixedCost: 0, lines: [], warnings: ['No inventory COGS rows mapped'] };
      }
      return { status: 'ok', totalPerVisit: 8, fixedCost: 0, lines: [], warnings: [] };
    };
    const { lowMargins, missingCogs } = evaluateServiceMargins({
      inventory: { available: true, rows: [] },
      generateEstimate,
      inventoryCostFromRows,
      laborRate: 35,
    });
    expect(lowMargins.map((m) => m.serviceKey)).toEqual(['pest_control']);
    expect(missingCogs.map((m) => m.serviceKey)).toEqual(['rodent_trapping', 'stinging']);
  });

  test('runInventoryMarginWatchdog respects dark gate, raises one alert on findings, and closes alert when clean', async () => {
    const offRes = await runInventoryMarginWatchdog({ deps: { isLive: () => false } });
    expect(offRes).toEqual({ skipped: true, reason: 'gate_off' });

    const makeDb = (catalogRows, vpRows) => {
      const makeChain = (rows) => {
        const chain = {
          where: () => chain,
          whereNotNull: () => chain,
          whereIn: () => chain,
          whereRaw: () => chain,
          select: () => Promise.resolve(rows),
        };
        return chain;
      };
      return (table) => (table === 'products_catalog' ? makeChain(catalogRows) : makeChain(vpRows));
    };

    const raiseAdminAlert = jest.fn(async () => ({ id: 'alert-1' }));
    const closeAdminAlertKeys = jest.fn(async () => 1);
    const healthyEstimate = ({ services }) => {
      const key = Object.keys(services)[0];
      const map = { pest: 'pest_control', mosquito: 'mosquito', treeShrub: 'tree_shrub', oneTimePest: 'one_time_pest', rodentTrapping: 'rodent_trapping', stinging: 'stinging' };
      return { lineItems: [{ service: map[key], perVisit: 120, price: 250 }] };
    };
    const healthyCogs = () => ({ status: 'ok', totalPerVisit: 5, fixedCost: 0, lines: [], warnings: [] });

    // Clean run -> closes any prior alert, raises none.
    const clean = await runInventoryMarginWatchdog({
      deps: {
        isLive: () => true,
        db: makeDb([{ id: 'p-1', name: 'Taurus SC', active: true, best_price: 95 }], [{ id: 'vp-1', product_id: 'p-1', price_amount: 86 }]),
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

    // Spike run -> raises one dedupe-keyed Inventory alert (read-only).
    const spiked = await runInventoryMarginWatchdog({
      deps: {
        isLive: () => true,
        db: makeDb([{ id: 'p-1', name: 'Termidor SC', active: true, best_price: 174.72 }], [{ id: 'vp-1', product_id: 'p-1', price_amount: 215 }]),
        loadInventoryCostRows: async () => ({ available: true, rows: [] }),
        inventoryCostFromRows: healthyCogs,
        generateEstimate: healthyEstimate,
        laborRate: 35,
        raiseAdminAlert,
        closeAdminAlertKeys,
      },
    });
    expect(spiked.alerted).toBe(true);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(raiseAdminAlert.mock.calls[0][1]).toMatchObject({ area: 'Inventory', link: '/admin/inventory', who: 'person' });
    expect(raiseAdminAlert.mock.calls[0][2]).toMatchObject({ dedupeKey: WATCHDOG_ALERT_KEY });
  });
});
