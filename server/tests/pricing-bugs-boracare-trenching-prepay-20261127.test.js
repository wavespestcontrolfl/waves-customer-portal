'use strict';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const constants = require('../services/pricing-engine/constants');
const { syncConstantsFromDB } = require('../services/pricing-engine/db-bridge');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const {
  annualPrepayDiscountComponents,
  estimateHasNoYear1PrepayPercent,
  resolveAnnualPrepayInvoiceTotal,
} = require('../services/estimate-converter');
const { savedFloorReplaySignals } = require('../services/estimate-floor-signal-replay');
const { CLIENT_IDENTITY_FIELDS, sanitizeClientIdentityFields } = require('../services/estimate-client-identity-fields');

function makePricingDb({ pricingConfigRows = [], catalogRows = [], approvedVendorPricingRows = [] } = {}) {
  const db = (table) => {
    if (table === 'products_catalog') {
      const q = {
        whereIn: jest.fn(() => q),
        where: jest.fn(() => q),
        select: jest.fn(async () => catalogRows),
      };
      return q;
    }
    if (table === 'vendor_pricing') {
      const q = {
        whereIn: jest.fn(() => q),
        where: jest.fn(() => q),
        whereRaw: jest.fn(() => q),
        select: jest.fn(async () => approvedVendorPricingRows),
      };
      return q;
    }
    const q = {
      select: jest.fn(async () => (table === 'pricing_config' ? pricingConfigRows : [])),
      orderBy: jest.fn(() => q),
      then: (resolve) => resolve([]),
    };
    return q;
  };
  db.schema = { hasTable: jest.fn(async () => true) };
  return db;
}

describe('Bora-Care live snake_case pricing_config keys (db-bridge)', () => {
  const originalBoraCare = JSON.parse(JSON.stringify(constants.SPECIALTY.boraCare));

  afterEach(() => {
    Object.assign(constants.SPECIALTY.boraCare, JSON.parse(JSON.stringify(originalBoraCare)));
  });

  test('reads gal_cost, coverage_sqft, and equip_cost when bc_* / camelCase keys are absent', async () => {
    const db = makePricingDb({
      pricingConfigRows: [{
        config_key: 'onetime_boracare',
        data: { gal_cost: 88.75, coverage_sqft: 250, equip_cost: 22.5 },
      }],
    });
    await expect(syncConstantsFromDB(db)).resolves.toBe(true);
    expect(constants.SPECIALTY.boraCare.galCost).toBe(88.75);
    expect(constants.SPECIALTY.boraCare.coverage).toBe(250);
    expect(constants.SPECIALTY.boraCare.equipCost).toBe(22.5);
  });

  test('keeps bc_* precedence over snake_case when both exist', async () => {
    const db = makePricingDb({
      pricingConfigRows: [{
        config_key: 'onetime_boracare',
        data: { bc_gal: 95, gal_cost: 88.75, bc_cov: 260, coverage_sqft: 250, bc_equip: 19, equip_cost: 22.5 },
      }],
    });
    await expect(syncConstantsFromDB(db)).resolves.toBe(true);
    expect(constants.SPECIALTY.boraCare.galCost).toBe(95);
    expect(constants.SPECIALTY.boraCare.coverage).toBe(260);
    expect(constants.SPECIALTY.boraCare.equipCost).toBe(19);
  });
});

describe('Termite trenching one-way upward catalog cost ratchet (db-bridge)', () => {
  const originalTrenching = JSON.parse(JSON.stringify(constants.SPECIALTY.trenching));
  const originalPreSlab = JSON.parse(JSON.stringify(constants.SPECIALTY.preSlabTermiticide));

  afterEach(() => {
    Object.assign(constants.SPECIALTY.trenching, JSON.parse(JSON.stringify(originalTrenching)));
    Object.assign(constants.SPECIALTY.preSlabTermiticide, JSON.parse(JSON.stringify(originalPreSlab)));
  });

  test('raises containerCost when approved catalog $/oz spikes, and NEVER auto-lowers on cheaper generic swaps', async () => {
    const db = makePricingDb({
      pricingConfigRows: [{
        config_key: 'onetime_trenching',
        data: {
          products: {
            taurus_sc: { container_cost: 95, container_oz: 78 },
            termidor_sc: { container_cost: 174.72, container_oz: 78 },
          },
        },
      }],
      catalogRows: [
        // Cheaper generic swap ($86.63 < $95.00): one-way ratchet keeps $95 so margin stays with Waves.
        { name: 'Taurus SC', best_price: 86.63, unit_size_oz: 78, best_vendor_pricing_id: 'vp-taurus' },
        // Approved vendor price spike ($199.50 > $174.72, within 2x band): raises containerCost to protect margin.
        { name: 'Termidor SC', best_price: 199.50, unit_size_oz: 78, best_vendor_pricing_id: 'vp-termidor' },
      ],
      approvedVendorPricingRows: [{ id: 'vp-taurus' }, { id: 'vp-termidor' }],
    });

    await expect(syncConstantsFromDB(db)).resolves.toBe(true);
    expect(constants.SPECIALTY.trenching.products.taurus_sc.containerCost).toBe(95);
    expect(constants.SPECIALTY.trenching.products.termidor_sc.containerCost).toBe(199.50);
  });

  test('ignores out-of-band catalog spikes (>2x) and respects link_container_costs_to_catalog=false kill switch', async () => {
    const dbSpike = makePricingDb({
      pricingConfigRows: [{
        config_key: 'onetime_trenching',
        data: { products: { termidor_sc: { container_cost: 174.72, container_oz: 78 } } },
      }],
      catalogRows: [{ name: 'Termidor SC', best_price: 500, unit_size_oz: 78, best_vendor_pricing_id: 'vp-termidor' }],
      approvedVendorPricingRows: [{ id: 'vp-termidor' }],
    });
    await expect(syncConstantsFromDB(dbSpike)).resolves.toBe(true);
    expect(constants.SPECIALTY.trenching.products.termidor_sc.containerCost).toBe(174.72);

    const dbOff = makePricingDb({
      pricingConfigRows: [{
        config_key: 'onetime_trenching',
        data: {
          link_container_costs_to_catalog: false,
          products: { termidor_sc: { container_cost: 174.72, container_oz: 78 } },
        },
      }],
      catalogRows: [{ name: 'Termidor SC', best_price: 210, unit_size_oz: 78, best_vendor_pricing_id: 'vp-termidor' }],
      approvedVendorPricingRows: [{ id: 'vp-termidor' }],
    });
    await expect(syncConstantsFromDB(dbOff)).resolves.toBe(true);
    expect(constants.SPECIALTY.trenching.linkContainerCostsToCatalog).toBe(false);
    expect(constants.SPECIALTY.trenching.products.termidor_sc.containerCost).toBe(174.72);
  });
});

describe('GATE_NO_YEAR1_PREPAY_DISCOUNT — no 5% Year-1 prepay on new estimates', () => {
  const savedGate = process.env.GATE_NO_YEAR1_PREPAY_DISCOUNT;
  const PROPERTY = { homeSqFt: 2000, stories: 1, lotSqFt: 8000, propertyType: 'single_family' };
  const SOLO_PEST = [{ service: 'pest_control', name: 'Pest Control' }];
  const LAWN_ONLY = [{ service: 'lawn_care', name: 'Lawn Care' }];
  const BUNDLE = [{ service: 'pest_control', name: 'Pest Control' }, { service: 'lawn_care', name: 'Lawn Care' }];

  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_NO_YEAR1_PREPAY_DISCOUNT;
    else process.env.GATE_NO_YEAR1_PREPAY_DISCOUNT = savedGate;
  });

  test('gate OFF: new estimates omit the stamp and keep existing 5% behavior untouched', () => {
    delete process.env.GATE_NO_YEAR1_PREPAY_DISCOUNT;
    const est = generateEstimate({ ...PROPERTY, services: { lawn: { grassType: 'st_augustine', tier: 'enhanced', turfSqFt: 5000 } } });
    expect(est.pricingMetadata.year1PrepayNoPercent).toBeUndefined();
    expect(estimateHasNoYear1PrepayPercent({ result: est })).toBe(false);
    expect(annualPrepayDiscountComponents({ recurringServices: LAWN_ONLY, estimateData: { result: est } }).discountRate).toBeCloseTo(0.05, 5);
  });

  test('gate ON: new estimates stamp year1PrepayNoPercent=true and apply 0% Year-1 prepay across bundles, lawn, and setup-waived offers', () => {
    process.env.GATE_NO_YEAR1_PREPAY_DISCOUNT = 'true';
    const est = generateEstimate({
      ...PROPERTY,
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { grassType: 'st_augustine', tier: 'enhanced', turfSqFt: 5000 },
      },
    });
    expect(est.pricingMetadata.year1PrepayNoPercent).toBe(true);
    const estData = {
      result: est,
      operatorPriceAdjustment: { waiveSetupFee: true, internalReason: 'One-time job to plan offer' },
    };
    expect(estimateHasNoYear1PrepayPercent(estData)).toBe(true);
    // Setup-waived solo pest (One-Time->Plan): 0% (no double-discount!).
    expect(annualPrepayDiscountComponents({ recurringServices: SOLO_PEST, estimateData: estData })).toEqual({ discountRate: 0, protectedFloor: 0 });
    // Multi-service bundle & lawn-only: 0% in Year 1.
    expect(annualPrepayDiscountComponents({ recurringServices: BUNDLE, estimateData: estData })).toEqual({ discountRate: 0, protectedFloor: 0 });
    expect(resolveAnnualPrepayInvoiceTotal({ baseAnnual: 1000, recurringServices: BUNDLE, estimateData: estData })).toEqual({ amount: 1000, discount: 0, rate: 0 });
    expect(resolveAnnualPrepayInvoiceTotal({ baseAnnual: 660, recurringServices: LAWN_ONLY, estimateData: estData })).toEqual({ amount: 660, discount: 0, rate: 0 });
  });

  test('replay stability: a stamped quote keeps 0% even if the gate turns off; a pre-gate quote and Year-2 renewal keep 5%', () => {
    process.env.GATE_NO_YEAR1_PREPAY_DISCOUNT = 'true';
    const fresh = generateEstimate({ ...PROPERTY, services: { lawn: { grassType: 'st_augustine', tier: 'enhanced', turfSqFt: 5000 } } });
    const savedNew = { result: fresh };
    delete process.env.GATE_NO_YEAR1_PREPAY_DISCOUNT;

    // Replay signals preserve year1PrepayNoPercent=true after gate flips off.
    expect(savedFloorReplaySignals(savedNew).year1PrepayNoPercent).toBe(true);
    const replayed = generateEstimate({
      ...PROPERTY,
      services: { lawn: { grassType: 'st_augustine', tier: 'enhanced', turfSqFt: 5000 } },
      savedEstimateReplay: true,
      ...savedFloorReplaySignals(savedNew),
    });
    expect(replayed.pricingMetadata.year1PrepayNoPercent).toBe(true);
    expect(annualPrepayDiscountComponents({ recurringServices: LAWN_ONLY, estimateData: { result: replayed } }).discountRate).toBe(0);

    // Pre-gate quote (unstamped) and Year-2 renewal (unstamped) still keep 5%.
    expect(annualPrepayDiscountComponents({ recurringServices: LAWN_ONLY, estimateData: {} }).discountRate).toBeCloseTo(0.05, 5);
  });

  test('year1PrepayNoPercent is server-owned and stripped from client-posted inputs', () => {
    expect(CLIENT_IDENTITY_FIELDS).toContain('year1PrepayNoPercent');
    const posted = { year1PrepayNoPercent: false, homeSqFt: 2000 };
    sanitizeClientIdentityFields(posted);
    expect(posted).toEqual({ homeSqFt: 2000 });
  });
});
