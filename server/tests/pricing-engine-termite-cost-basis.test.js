/**
 * Termite station cost basis + inventory catalog link (plan 2026-09-03 §A1).
 *
 *  - priceTermiteBait emits a REPORT-ONLY costs block (service labor,
 *    cartridge replacement, follow-up reserve) and materialCostSource, and
 *    the install price follows the $24.00 station cost.
 *  - syncConstantsFromDB links the Trelona station and cartridge cost to the
 *    catalog ONLY through an approved, active vendor price inside the sanity
 *    band, stamps the source, self-heals when the link is off, and re-applies
 *    the config value each sync.
 */
const constants = require('../services/pricing-engine/constants');
const { syncConstantsFromDB } = require('../services/pricing-engine/db-bridge');
const { priceTermiteBait } = require('../services/pricing-engine/service-pricing');
const { validatePricingConfigData } = require('../routes/admin-pricing-config');

const snapshot = JSON.parse(JSON.stringify(constants.TERMITE));
function restoreTermite() {
  for (const key of Object.keys(constants.TERMITE)) delete constants.TERMITE[key];
  Object.assign(constants.TERMITE, JSON.parse(JSON.stringify(snapshot)));
}

function linkDb({ termiteInstall = {}, catalogRows = [], approvedVendorPricingRows = [] } = {}) {
  const db = (table) => {
    if (table === 'products_catalog') {
      const q = { whereIn: jest.fn(() => q), where: jest.fn(() => q), select: jest.fn(async () => catalogRows) };
      return q;
    }
    if (table === 'vendor_pricing') {
      const q = { whereIn: jest.fn(() => q), where: jest.fn(() => q), select: jest.fn(async () => approvedVendorPricingRows) };
      return q;
    }
    const query = {
      select: jest.fn(async () => (table === 'pricing_config'
        ? [{ config_key: 'termite_install', data: { multiplier: 1.45, trelona_bait: 24.0, advance_bait: 13.16, labor_per_station: 5.25, misc_per_station: 0.75, ...termiteInstall } }]
        : [])),
      orderBy: jest.fn(() => query),
      then: (resolve) => resolve([]),
    };
    return query;
  };
  db.schema = { hasTable: jest.fn(async () => true) };
  return db;
}

const STATION_ROW = { name: 'Trelona ATBS Bait Station', best_price: '384.00', container_size: '16 stations', best_vendor_pricing_id: 'vp-station' };
const CARTRIDGE_ROW = { name: 'Trelona Compressed Termite Bait (25-pack)', best_price: '170.75', container_size: '25 cartridges', best_vendor_pricing_id: 'vp-cartridge' };

describe('termite station cost basis (plan §A1)', () => {
  afterEach(restoreTermite);

  test('2,000 sf Trelona install prices off $24.00/station and reports the cost model', () => {
    const li = priceTermiteBait({ footprint: 2000, features: { complexity: 'standard' } }, { system: 'trelona' });
    expect(li.stations).toBe(15);
    // 15 × ($24.00 + $5.25 + $0.75) × 1.45 = $652.50 → $653 (was $610 at $22.05)
    expect(li.installation.price).toBe(653);
    expect(li.materialCostSource).toEqual({ station: 'config', cartridge: 'config' });
    expect(li.costs).toMatchObject({
      stationCost: 24,
      cartridgeCost: 6.83,
      cartridgesPerStation: 2,
      cartridgeReplacementRate: 0.33,
      followUpVisitReserve: 0.25,
      serviceMinutesPerVisit: 95, // 15 × 5 + 20 drive
      serviceVisitsPerYear: 4,
      installMaterial: 450,
    });
    // 30 cartridges × 33% × $6.83 = $67.62; 95 min at $35/hr = $55.42/visit
    expect(li.costs.cartridgeReplacementAnnual).toBe(67.62);
    expect(li.costs.serviceLaborPerVisit).toBe(55.42);
    expect(li.costs.followUpReserveAnnual).toBe(13.85);
    expect(li.costs.annualTotal).toBeCloseTo(li.costs.serviceLaborAnnual + li.costs.cartridgeReplacementAnnual + li.costs.followUpReserveAnnual, 1);
    // The cost model never touches the price: monitoring stays on the bracket.
    expect(li.monitoring.annual).toBe(288);
  });

  test('costs block tolerates missing cartridge inputs (fresh-env / older config)', () => {
    delete constants.TERMITE.cartridges;
    const li = priceTermiteBait({ footprint: 2000, features: { complexity: 'standard' } }, { system: 'trelona' });
    expect(li.installation.price).toBe(653);
    expect(li.costs.cartridgeReplacementAnnual).toBe(0);
    expect(li.costs.followUpReserveAnnual).toBe(0);
    expect(li.materialCostSource).toEqual({ station: 'config', cartridge: 'config' });
  });
});

describe('termite catalog link (db-bridge)', () => {
  afterEach(restoreTermite);

  test('approved catalog prices override station and cartridge cost per unit and stamp the source', async () => {
    const db = linkDb({
      termiteInstall: { trelona_bait: 22.05 },
      catalogRows: [STATION_ROW, CARTRIDGE_ROW],
      approvedVendorPricingRows: [{ id: 'vp-station' }, { id: 'vp-cartridge' }],
    });
    await expect(syncConstantsFromDB(db)).resolves.toBe(true);
    expect(constants.TERMITE.systems.trelona.stationCost).toBe(24);
    expect(constants.TERMITE.systems.trelona.stationCostSource).toBe('catalog');
    expect(constants.TERMITE.cartridges.cartridgeCost).toBe(6.83);
    expect(constants.TERMITE.cartridges.cartridgeCostSource).toBe('catalog');
    const li = priceTermiteBait({ footprint: 2000, features: { complexity: 'standard' } }, { system: 'trelona' });
    expect(li.installation.price).toBe(653);
    expect(li.materialCostSource).toEqual({ station: 'catalog', cartridge: 'catalog' });
  });

  test('a catalog price without an approved active vendor price is ignored', async () => {
    const db = linkDb({ catalogRows: [STATION_ROW], approvedVendorPricingRows: [] });
    await expect(syncConstantsFromDB(db)).resolves.toBe(true);
    expect(constants.TERMITE.systems.trelona.stationCost).toBe(24);
    expect(constants.TERMITE.systems.trelona.stationCostSource).toBe('config');
  });

  test('a catalog price outside the [0.5x, 2x] sanity band keeps the config value', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = linkDb({
        catalogRows: [{ ...STATION_ROW, best_price: '1200.00' }],
        approvedVendorPricingRows: [{ id: 'vp-station' }],
      });
      await expect(syncConstantsFromDB(db)).resolves.toBe(true);
      expect(constants.TERMITE.systems.trelona.stationCost).toBe(24);
      expect(constants.TERMITE.systems.trelona.stationCostSource).toBe('config');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('outside sanity band'));
    } finally {
      warn.mockRestore();
    }
  });

  test('link kill switch: catalog is not queried and the config value reasserts on the next sync', async () => {
    const linked = linkDb({ catalogRows: [STATION_ROW], approvedVendorPricingRows: [{ id: 'vp-station' }] });
    await expect(syncConstantsFromDB(linked)).resolves.toBe(true);
    expect(constants.TERMITE.systems.trelona.stationCostSource).toBe('catalog');

    const killDb = (table) => {
      if (table === 'products_catalog') throw new Error('products_catalog must not be queried when the termite link is off');
      const query = {
        select: jest.fn(async () => (table === 'pricing_config'
          ? [{ config_key: 'termite_install', data: { trelona_bait: 23.5, link_station_costs_to_catalog: false } }]
          : [])),
        orderBy: jest.fn(() => query),
        then: (resolve) => resolve([]),
      };
      return query;
    };
    killDb.schema = { hasTable: jest.fn(async () => true) };
    await expect(syncConstantsFromDB(killDb)).resolves.toBe(true);
    expect(constants.TERMITE.linkStationCostsToCatalog).toBe(false);
    expect(constants.TERMITE.systems.trelona.stationCost).toBe(23.5);
    expect(constants.TERMITE.systems.trelona.stationCostSource).toBe('config');
  });

  test('cartridge cost inputs sync from pricing_config.termite_install', async () => {
    const db = linkDb({ termiteInstall: { cartridge_cost: 10.7, cartridges_per_station: 2, cartridge_replacement_rate: 0.5, follow_up_visit_reserve: 0 } });
    await expect(syncConstantsFromDB(db)).resolves.toBe(true);
    expect(constants.TERMITE.cartridges).toMatchObject({ cartridgeCost: 10.7, cartridgesPerStation: 2, replacementRate: 0.5, followUpVisitReserve: 0, cartridgeCostSource: 'config' });
    const li = priceTermiteBait({ footprint: 2000, features: { complexity: 'standard' } }, { system: 'trelona' });
    expect(li.costs.cartridgeReplacementAnnual).toBe(Math.round(15 * 2 * 0.5 * 10.7 * 100) / 100);
    expect(li.costs.followUpReserveAnnual).toBe(0);
  });
});

describe('termite_install admin validation', () => {
  const base = { multiplier: 1.45, trelona_bait: 24, advance_bait: 13.16, labor_per_station: 5.25, misc_per_station: 0.75 };
  test('accepts the shipped shape and the new cost inputs', () => {
    expect(validatePricingConfigData('termite_install', { ...base, link_station_costs_to_catalog: true, cartridge_cost: 6.83, cartridges_per_station: 2, cartridge_replacement_rate: 0.33, follow_up_visit_reserve: 0.25 }, null)).toEqual({ ok: true });
    expect(validatePricingConfigData('termite_install', base, null)).toEqual({ ok: true });
  });
  test.each([
    [{ trelona_bait: -1 }, 'trelona_bait'],
    [{ multiplier: 0 }, 'multiplier'],
    [{ cartridge_cost: 'free' }, 'cartridge_cost'],
    [{ cartridges_per_station: 2.5 }, 'cartridges_per_station'],
    [{ cartridge_replacement_rate: 1.5 }, 'cartridge_replacement_rate'],
    [{ follow_up_visit_reserve: -0.25 }, 'follow_up_visit_reserve'],
    [{ link_station_costs_to_catalog: 'yes' }, 'link_station_costs_to_catalog'],
  ])('rejects %j', (patch, key) => {
    const verdict = validatePricingConfigData('termite_install', { ...base, ...patch }, null);
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain(`termite_install.${key}`);
  });
});

