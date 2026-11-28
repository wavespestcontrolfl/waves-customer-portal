'use strict';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const constants = require('../services/pricing-engine/constants');
const { syncConstantsFromDB, resetTrenchingCatalogFallbackCache } = require('../services/pricing-engine/db-bridge');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { priceTrenching } = require('../services/pricing-engine/service-pricing');
const {
  annualPrepayDiscountComponents,
  estimateHasNoYear1PrepayPercent,
  formatAnnualPrepayInvoiceCopy,
  resolveAnnualPrepayInvoiceTotal,
} = require('../services/estimate-converter');
const { savedFloorReplaySignals } = require('../services/estimate-floor-signal-replay');
const { CLIENT_IDENTITY_FIELDS, sanitizeClientIdentityFields } = require('../services/estimate-client-identity-fields');
const { buildAutomatedLeadDraftEstimate, evaluateLeadEstimateAutomationReadiness } = require('../services/lead-estimate-automation');
const { buildEstimateServiceRevisionDraft } = require('../services/estimate-add-service-request');
const { resolveServerAuthoritativePricing } = require('../services/admin-estimate-persistence');

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
    resetTrenchingCatalogFallbackCache();
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

  test('keeps the configured included allowance fixed when Taurus SC catalog cost rises (Taurus retail rises, Termidor never drops)', async () => {
    const property = { homeSqFt: 2400, stories: 1, lotSqFt: 9000 };
    const options = { perimeterLF: 200, dirtLF: 150, concreteLF: 50 };
    const baseTaurus = priceTrenching(property, { ...options, productKey: 'taurus_sc' });
    const baseTermidor = priceTrenching(property, { ...options, productKey: 'termidor_sc' });

    const dbTaurusSpike = makePricingDb({
      pricingConfigRows: [{ config_key: 'onetime_trenching', data: {} }],
      catalogRows: [
        // Taurus SC (the default included product) jumps from $95 -> $150/78oz.
        { name: 'Taurus SC', best_price: 150, unit_size_oz: 78, best_vendor_pricing_id: 'vp-taurus' },
      ],
      approvedVendorPricingRows: [{ id: 'vp-taurus' }],
    });
    await expect(syncConstantsFromDB(dbTaurusSpike)).resolves.toBe(true);

    const afterTaurus = priceTrenching(property, { ...options, productKey: 'taurus_sc' });
    const afterTermidor = priceTrenching(property, { ...options, productKey: 'termidor_sc' });
    expect(afterTaurus.price).toBeGreaterThan(baseTaurus.price);
    expect(afterTaurus.productSurcharge).toBeGreaterThan(0);
    expect(afterTermidor.price).toBe(baseTermidor.price);
  });

  test('consecutive syncs restore default bottle costs, sizes, and catalog names before applying overrides and sanity checks', async () => {
    // Sync 1: catalog ratchets Termidor SC from default $174.72 -> $250.
    const dbSync1 = makePricingDb({
      pricingConfigRows: [{ config_key: 'onetime_trenching', data: {} }],
      catalogRows: [{ name: 'Termidor SC', best_price: 250, unit_size_oz: 78, best_vendor_pricing_id: 'vp-1' }],
      approvedVendorPricingRows: [{ id: 'vp-1' }],
    });
    await expect(syncConstantsFromDB(dbSync1)).resolves.toBe(true);
    expect(constants.SPECIALTY.trenching.products.termidor_sc.containerCost).toBe(250);

    // Sync 2: link disabled with empty/partial product config -> restores default $174.72 (no carryover).
    const dbSync2 = makePricingDb({
      pricingConfigRows: [{ config_key: 'onetime_trenching', data: { link_container_costs_to_catalog: false } }],
      catalogRows: [{ name: 'Termidor SC', best_price: 250, unit_size_oz: 78, best_vendor_pricing_id: 'vp-1' }],
      approvedVendorPricingRows: [{ id: 'vp-1' }],
    });
    await expect(syncConstantsFromDB(dbSync2)).resolves.toBe(true);
    expect(constants.SPECIALTY.trenching.products.termidor_sc.containerCost).toBe(174.72);
    expect(constants.SPECIALTY.trenching.products.termidor_sc.configuredContainerCost).toBeUndefined();

    // Sync 3: link re-enabled with $400 spike (>2x of default $174.72, would have been <2x of stale $250) -> rejected.
    const dbSync3 = makePricingDb({
      pricingConfigRows: [{ config_key: 'onetime_trenching', data: {} }],
      catalogRows: [{ name: 'Termidor SC', best_price: 400, unit_size_oz: 78, best_vendor_pricing_id: 'vp-3' }],
      approvedVendorPricingRows: [{ id: 'vp-3' }],
    });
    await expect(syncConstantsFromDB(dbSync3)).resolves.toBe(true);
    expect(constants.SPECIALTY.trenching.products.termidor_sc.containerCost).toBe(174.72);
  });

  test('uses deterministic config-floor max(config, catalog) across refreshes and retains last synced cost on transient catalog failure', async () => {
    // Refresh 1: Termidor spikes $174.72 -> $250 (accepted).
    const dbRise = makePricingDb({
      pricingConfigRows: [{ config_key: 'onetime_trenching', data: {} }],
      catalogRows: [{ name: 'Termidor SC', best_price: 250, unit_size_oz: 78, best_vendor_pricing_id: 'vp-rise' }],
      approvedVendorPricingRows: [{ id: 'vp-rise' }],
    });
    await expect(syncConstantsFromDB(dbRise)).resolves.toBe(true);
    expect(constants.SPECIALTY.trenching.products.termidor_sc.containerCost).toBe(250);

    // Refresh 2: transient catalog read error -> retains last synced $250 (never silently drops to config).
    const dbFail = makePricingDb({ pricingConfigRows: [{ config_key: 'onetime_trenching', data: {} }] });
    dbFail.schema.hasTable = jest.fn(async (table) => {
      if (table === 'products_catalog') throw new Error('catalog timeout');
      return table === 'pricing_config';
    });
    await expect(syncConstantsFromDB(dbFail)).resolves.toBe(true);
    expect(constants.SPECIALTY.trenching.products.termidor_sc.containerCost).toBe(250);

    // Refresh 3: catalog recovers with cheaper vendor $160 (< config $174.72) -> deterministic floor stays at config $174.72 across all workers.
    const dbDrop = makePricingDb({
      pricingConfigRows: [{ config_key: 'onetime_trenching', data: {} }],
      catalogRows: [{ name: 'Termidor SC', best_price: 160, unit_size_oz: 78, best_vendor_pricing_id: 'vp-drop' }],
      approvedVendorPricingRows: [{ id: 'vp-drop' }],
    });
    await expect(syncConstantsFromDB(dbDrop)).resolves.toBe(true);
    expect(constants.SPECIALTY.trenching.products.termidor_sc.containerCost).toBe(174.72);
  });

  test('keeps the last published trenching catalog cost active while a concurrent refresh awaits the catalog read', async () => {
    const dbRise = makePricingDb({
      pricingConfigRows: [{ config_key: 'onetime_trenching', data: {} }],
      catalogRows: [{ name: 'Termidor SC', best_price: 250, unit_size_oz: 78, best_vendor_pricing_id: 'vp-rise' }],
      approvedVendorPricingRows: [{ id: 'vp-rise' }],
    });
    await expect(syncConstantsFromDB(dbRise)).resolves.toBe(true);
    expect(constants.SPECIALTY.trenching.products.termidor_sc.containerCost).toBe(250);

    let releaseCatalog;
    const catalogPaused = new Promise((resolve) => { releaseCatalog = resolve; });
    let observedMidRefreshCost = null;
    const dbSlow = makePricingDb({
      pricingConfigRows: [{ config_key: 'onetime_trenching', data: {} }],
      catalogRows: [{ name: 'Termidor SC', best_price: 260, unit_size_oz: 78, best_vendor_pricing_id: 'vp-next' }],
      approvedVendorPricingRows: [{ id: 'vp-next' }],
    });
    const origHasTable = dbSlow.schema.hasTable;
    dbSlow.schema.hasTable = jest.fn(async (table) => {
      if (table === 'products_catalog') {
        observedMidRefreshCost = constants.SPECIALTY.trenching.products.termidor_sc.containerCost;
        await catalogPaused;
      }
      return origHasTable(table);
    });

    const syncPromise = syncConstantsFromDB(dbSlow);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(observedMidRefreshCost).toBe(250);
    expect(constants.SPECIALTY.trenching.products.termidor_sc.containerCost).toBe(250);
    releaseCatalog();
    await expect(syncPromise).resolves.toBe(true);
    expect(constants.SPECIALTY.trenching.products.termidor_sc.containerCost).toBe(260);
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

  test('automated lead drafts preserve year1PrepayNoPercent through invoice calculation', async () => {
    process.env.GATE_NO_YEAR1_PREPAY_DISCOUNT = 'true';
    const intake = {
      email: 'lead@example.com',
      serviceInterest: 'Lawn Care',
      fullAddress: '123 Main St, Venice, FL 34285',
      normalizedAddress: { line1: '123 Main St', city: 'Venice', state: 'FL', zip: '34285' },
    };
    const readiness = evaluateLeadEstimateAutomationReadiness({ intake, phone: '+19415550199' });
    const draft = await buildAutomatedLeadDraftEstimate({
      readiness,
      intake,
      body: { homeSqFt: 2000, lotSqFt: 8000, propertyType: 'single_family' },
      measurements: null,
    });
    expect(draft.estimateData.engineResult.pricingMetadata.year1PrepayNoPercent).toBe(true);
    expect(estimateHasNoYear1PrepayPercent(draft.estimateData)).toBe(true);
    expect(resolveAnnualPrepayInvoiceTotal({
      baseAnnual: draft.annual || 720,
      recurringServices: LAWN_ONLY,
      estimateData: draft.estimateData,
    })).toEqual({ amount: draft.annual || 720, discount: 0, rate: 0 });
  });

  test('adding a service to a saved quote preserves original prepay terms across both gate transitions', async () => {
    // 1) Pre-gate quote (5% terms): adding lawn AFTER gate turns ON keeps 5% terms.
    delete process.env.GATE_NO_YEAR1_PREPAY_DISCOUNT;
    const preGateEst = generateEstimate({ ...PROPERTY, services: { pest: { frequency: 'quarterly' } } });
    const preGateSaved = {
      estimate_data: {
        inputs: { ...PROPERTY, services: { pest: { frequency: 'quarterly' } } },
        result: { pricingMetadata: preGateEst.pricingMetadata },
      },
      monthly_total: 40,
      annual_total: 480,
      onetime_total: 0,
      waveguard_tier: 'Bronze',
    };
    process.env.GATE_NO_YEAR1_PREPAY_DISCOUNT = 'true';
    const preGateRev = await buildEstimateServiceRevisionDraft(preGateSaved, 'lawn_care');
    expect(preGateRev.status).toBe('priced');
    expect(estimateHasNoYear1PrepayPercent(preGateRev.draftEstimateData)).toBe(false);
    expect(annualPrepayDiscountComponents({ recurringServices: BUNDLE, estimateData: preGateRev.draftEstimateData }).discountRate).toBeCloseTo(0.05, 5);
    expect(preGateRev.draftEstimateData.inputs.year1PrepayNoPercent).toBeUndefined();

    // 2) Post-gate quote (0% terms): adding lawn AFTER gate turns OFF keeps 0% terms.
    const postGateEst = generateEstimate({ ...PROPERTY, services: { pest: { frequency: 'quarterly' } } });
    const postGateSaved = {
      estimate_data: {
        inputs: { ...PROPERTY, services: { pest: { frequency: 'quarterly' } } },
        result: { pricingMetadata: postGateEst.pricingMetadata },
      },
      monthly_total: 40,
      annual_total: 480,
      onetime_total: 0,
      waveguard_tier: 'Bronze',
    };
    delete process.env.GATE_NO_YEAR1_PREPAY_DISCOUNT;
    const postGateRev = await buildEstimateServiceRevisionDraft(postGateSaved, 'lawn_care');
    expect(postGateRev.status).toBe('priced');
    expect(estimateHasNoYear1PrepayPercent(postGateRev.draftEstimateData)).toBe(true);
    expect(annualPrepayDiscountComponents({ recurringServices: BUNDLE, estimateData: postGateRev.draftEstimateData }).discountRate).toBe(0);
    expect(postGateRev.draftEstimateData.inputs.year1PrepayNoPercent).toBeUndefined();
  });

  test('CLIENT_FALLBACK admin saves strip forged stamps from every carrier and derive the stamp from gate (create) or stored row (revise)', async () => {
    const noRecompute = async () => ({ recomputed: false, reason: 'NO_INPUTS' });
    const clientPreview = { monthlyTotal: 60, annualTotal: 720, oneTimeTotal: 0 };

    // Gate OFF on creation: client-forged true on EVERY carrier is stripped.
    delete process.env.GATE_NO_YEAR1_PREPAY_DISCOUNT;
    const forgedCreate = {
      pricingMetadata: { year1PrepayNoPercent: true },
      routingMetadata: { year1PrepayNoPercent: true },
      result: { pricingMetadata: { year1PrepayNoPercent: true }, routingMetadata: { year1PrepayNoPercent: true }, results: { pest: { pa: 112 } } },
      engineResult: { pricingMetadata: { year1PrepayNoPercent: true }, lineItems: [] },
      sendSnapshot: { year1PrepayNoPercent: true, pricingBundle: { year1PrepayNoPercent: true } },
    };
    const createOff = await resolveServerAuthoritativePricing({
      estimateData: forgedCreate,
      clientPreview,
      quoteRequired: false,
      recompute: noRecompute,
    });
    expect(createOff.audit.pricing_authority).toBe('CLIENT_FALLBACK');
    expect(estimateHasNoYear1PrepayPercent(forgedCreate)).toBe(false);

    // Gate ON on creation: omitted stamp is stamped true by the server.
    process.env.GATE_NO_YEAR1_PREPAY_DISCOUNT = 'true';
    const omittedCreate = { result: { results: { pest: { pa: 112 } } } };
    await resolveServerAuthoritativePricing({
      estimateData: omittedCreate,
      clientPreview,
      quoteRequired: false,
      recompute: noRecompute,
    });
    expect(estimateHasNoYear1PrepayPercent(omittedCreate)).toBe(true);

    // Fallback revision of a pre-gate stored quote while gate is ON: keeps false (5%).
    const preGateStored = { result: { pricingMetadata: { legacyPricingRules: false } } };
    const revPreGate = { result: { pricingMetadata: { year1PrepayNoPercent: true }, results: { pest: { pa: 112 } } } };
    await resolveServerAuthoritativePricing({
      estimateData: revPreGate,
      clientPreview,
      quoteRequired: false,
      recompute: noRecompute,
      storedEstimateData: preGateStored,
    });
    expect(estimateHasNoYear1PrepayPercent(revPreGate)).toBe(false);

    // Fallback revision of a post-gate stored quote while gate is OFF: keeps true (0%).
    delete process.env.GATE_NO_YEAR1_PREPAY_DISCOUNT;
    const postGateStored = { result: { pricingMetadata: { year1PrepayNoPercent: true } } };
    const revPostGate = { result: { results: { pest: { pa: 112 } } } };
    await resolveServerAuthoritativePricing({
      estimateData: revPostGate,
      clientPreview,
      quoteRequired: false,
      recompute: noRecompute,
      storedEstimateData: postGateStored,
    });
    expect(estimateHasNoYear1PrepayPercent(revPostGate)).toBe(true);
  });

  test('successful SERVER staff revisions preserve the stored quote prepay decision across gate transitions', async () => {
    const engineInputs = {
      ...PROPERTY,
      services: { lawn: { grassType: 'st_augustine', tier: 'enhanced', turfSqFt: 5000 } },
    };
    const clientPreview = { monthlyTotal: 60, annualTotal: 720, oneTimeTotal: 0 };

    // 1) Pre-gate quote revised by staff AFTER gate turns ON -> keeps 5% (no stamp).
    process.env.GATE_NO_YEAR1_PREPAY_DISCOUNT = 'true';
    const preGateStored = { result: { pricingMetadata: { legacyPricingRules: false } } };
    const revisedPreGate = { engineInputs: { ...engineInputs }, result: {} };
    const preRes = await resolveServerAuthoritativePricing({
      estimateData: revisedPreGate,
      clientPreview,
      quoteRequired: false,
      storedEstimateData: preGateStored,
    });
    expect(preRes.audit.pricing_authority).toBe('SERVER');
    expect(estimateHasNoYear1PrepayPercent(revisedPreGate)).toBe(false);
    expect(annualPrepayDiscountComponents({ recurringServices: LAWN_ONLY, estimateData: revisedPreGate }).discountRate).toBeCloseTo(0.05, 5);

    // 2) Post-gate quote revised by staff AFTER gate turns OFF -> keeps 0% (stamped true).
    delete process.env.GATE_NO_YEAR1_PREPAY_DISCOUNT;
    const postGateStored = { result: { pricingMetadata: { legacyPricingRules: false, year1PrepayNoPercent: true } } };
    const revisedPostGate = { engineInputs: { ...engineInputs }, result: {} };
    const postRes = await resolveServerAuthoritativePricing({
      estimateData: revisedPostGate,
      clientPreview,
      quoteRequired: false,
      storedEstimateData: postGateStored,
    });
    expect(postRes.audit.pricing_authority).toBe('SERVER');
    expect(estimateHasNoYear1PrepayPercent(revisedPostGate)).toBe(true);
    expect(annualPrepayDiscountComponents({ recurringServices: LAWN_ONLY, estimateData: revisedPostGate }).discountRate).toBe(0);
  });

  test('adding a service to an existing 30-nozzle Smart misting quote replays its saved $4,195 installation row directly', async () => {
    const savedMistingGate = process.env.GATE_MOSQUITO_MISTING;
    process.env.GATE_MOSQUITO_MISTING = 'true';
    try {
      const legacyMistingQuote = {
        estimate_data: {
          inputs: {
            ...PROPERTY,
            services: { mosquitoMisting: { tier: 'smart', nozzles: 30 } },
          },
          engineResult: {
            lineItems: [{
              service: 'mosquito_misting',
              tier: 'smart',
              nozzles: 30,
              installation: { price: 4195 },
              pricingKnobs: {
                tier: 'smart',
                tierPrice: 2995,
                includedNozzles: 10,
                extraNozzlePrice: 60,
                planMonthly: 149,
                refillPrice: 149,
              },
            }],
          },
        },
        monthly_total: 149,
        annual_total: 1788,
        onetime_total: 4195,
        waveguard_tier: 'Bronze',
      };
      const rev = await buildEstimateServiceRevisionDraft(legacyMistingQuote, 'lawn_care');
      expect(rev.status).toBe('priced');
      const oneTimeItems = rev.draftEstimateData.result?.oneTime?.items || [];
      const installRow = oneTimeItems.find((item) => item.service === 'mosquito_misting_installation');
      expect(installRow).toBeDefined();
      expect(installRow.price).toBe(4195);
      // Confirm a fresh 30-nozzle Smart quote (without legacy knobs) gets the $4,295 Essential floor.
      const fresh = generateEstimate({
        ...PROPERTY,
        services: { mosquitoMisting: { tier: 'smart', nozzles: 30 } },
      });
      expect(fresh.lineItems.find((l) => l.service === 'mosquito_misting').installation.price).toBe(4295);
    } finally {
      if (savedMistingGate === undefined) delete process.env.GATE_MOSQUITO_MISTING;
      else process.env.GATE_MOSQUITO_MISTING = savedMistingGate;
    }
  });

  test('adding a service to an existing trenching quote replays its saved trenching product surcharge after catalog spikes', async () => {
    const originalTrenching = JSON.parse(JSON.stringify(constants.SPECIALTY.trenching));
    try {
      const trenchingQuote = generateEstimate({
        ...PROPERTY,
        services: {
          trenching: { productKey: 'termidor_sc', perimeterLF: 200, dirtLF: 150, concreteLF: 50 },
        },
      });
      const initialLine = trenchingQuote.lineItems.find((l) => l.service === 'trenching');
      expect(initialLine).toBeDefined();
      const savedQuote = {
        estimate_data: {
          inputs: {
            ...PROPERTY,
            services: {
              trenching: { productKey: 'termidor_sc', perimeterLF: 200, dirtLF: 150, concreteLF: 50 },
            },
          },
          engineResult: trenchingQuote,
        },
        monthly_total: 0,
        annual_total: 0,
        onetime_total: initialLine.price,
        waveguard_tier: 'Bronze',
      };

      // Simulate Termidor SC bottle cost jumping after quote was saved.
      constants.SPECIALTY.trenching.products.termidor_sc.containerCost = 290;
      const freshAfterSpike = generateEstimate({
        ...PROPERTY,
        services: {
          trenching: { productKey: 'termidor_sc', perimeterLF: 200, dirtLF: 150, concreteLF: 50 },
        },
      });
      const spikedLine = freshAfterSpike.lineItems.find((l) => l.service === 'trenching');
      expect(spikedLine.productSurcharge).toBeGreaterThan(initialLine.productSurcharge);

      const rev = await buildEstimateServiceRevisionDraft(savedQuote, 'lawn_care');
      expect(rev.status).toBe('priced');
      const oneTimeItems = rev.draftEstimateData.result?.oneTime?.items || [];
      const revisedTrench = oneTimeItems.find((item) => item.service === 'trenching');
      expect(revisedTrench).toBeDefined();
      // Adding lawn_care unlocks bundle discount on `price`, while the pinned trenching surcharge
      // and pre-discount subtotal must match the original quote rather than the post-spike cost.
      expect(revisedTrench.productSurcharge).toBe(initialLine.productSurcharge);
      expect(revisedTrench.priceBeforeWarranty).toBe(initialLine.priceBeforeWarranty);
      expect(revisedTrench.priceBeforeDiscount).toBe(initialLine.price);
    } finally {
      Object.assign(constants.SPECIALTY.trenching, originalTrenching);
    }
  });

  test('annual prepay invoice copy uses neutral wording when neither prepay % nor setup waiver applies', () => {
    const lawnZero = formatAnnualPrepayInvoiceCopy({
      prepayPlanPrefix: 'WaveGuard Bronze',
      prepayDiscountApplied: false,
      prepayWaivesSetupFee: false,
      estimateId: 'est-1',
      setupFeeAmount: 99,
    });
    expect(lawnZero.prepayLineDescription).toBe('WaveGuard Bronze — 12 months prepaid');
    expect(lawnZero.prepayLineDescription).not.toMatch(/setup fee waived/i);
    expect(lawnZero.prepayNotes).not.toMatch(/setup fee waived/i);

    const soloPestWaived = formatAnnualPrepayInvoiceCopy({
      prepayPlanPrefix: 'WaveGuard Bronze',
      prepayDiscountApplied: false,
      prepayWaivesSetupFee: true,
      estimateId: 'est-2',
      setupFeeAmount: 99,
    });
    expect(soloPestWaived.prepayLineDescription).toBe('WaveGuard Membership — 12 months prepaid (setup fee waived)');
    expect(soloPestWaived.prepayNotes).toContain('$99.00 setup fee waived');
  });

  test('mandatory-prepay Subterranean Termite annual plans keep their 5% annual prepay rate and renewal fee even under GATE_NO_YEAR1_PREPAY_DISCOUNT', () => {
    const termiteAnnualData = {
      pricingMetadata: { year1PrepayNoPercent: true },
      result: {
        results: { tmBait: { plan: 'annual_protection', annual: 1000 } },
        recurring: { services: [{ service: 'termite_bait', plan: 'annual_protection', annual: 1000 }] },
      },
    };
    const comps = annualPrepayDiscountComponents({
      recurringServices: [{ service: 'termite_bait', plan: 'annual_protection', annual: 1000 }],
      estimateData: termiteAnnualData,
    });
    expect(comps.discountRate).toBeCloseTo(0.05, 5);
    const resolved = resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 1000,
      recurringServices: [{ service: 'termite_bait', plan: 'annual_protection', annual: 1000 }],
      estimateData: termiteAnnualData,
    });
    expect(resolved).toEqual({ amount: 950, discount: 50, rate: 0.05 });
  });

  test('pre-fix unstamped Bora-Care quote keeps its original base price when adding another service after snake_case DB sync', async () => {
    const origBora = { ...constants.SPECIALTY.boraCare };
    try {
      // Price a Bora-Care attic quote under the historical pre-fix defaults (galCost 91.98, coverage 275, equip 17.50, margin 0.45).
      const preFixEst = generateEstimate({
        ...PROPERTY,
        services: { boraCare: { atticSqFt: 1500 } },
      });
      const preFixLine = preFixEst.lineItems.find((l) => l.service === 'bora_care');
      expect(preFixLine).toBeDefined();
      // Strip pricingKnobs to simulate a quote persisted before the snake_case DB fix.
      const { pricingKnobs: _stripped, ...unstampedLine } = preFixLine;
      const savedQuote = {
        estimate_data: {
          inputs: { ...PROPERTY, services: { boraCare: { atticSqFt: 1500 } } },
          engineResult: { ...preFixEst, lineItems: [unstampedLine] },
        },
        monthly_total: 0,
        annual_total: 0,
        onetime_total: preFixLine.price,
        waveguard_tier: 'Bronze',
      };

      // Simulate snake_case DB config raising Bora-Care costs after the quote was saved.
      constants.SPECIALTY.boraCare.galCost = 140;
      constants.SPECIALTY.boraCare.equipCost = 50;
      const freshAfterSync = generateEstimate({
        ...PROPERTY,
        services: { boraCare: { atticSqFt: 1500 } },
      });
      const higherLiveLine = freshAfterSync.lineItems.find((l) => l.service === 'bora_care');
      expect(higherLiveLine.price).toBeGreaterThan(preFixLine.price);

      const rev = await buildEstimateServiceRevisionDraft(savedQuote, 'lawn_care');
      expect(rev.status).toBe('priced');
      const oneTime = rev.draftEstimateData.result?.oneTime || {};
      const revisedBora = [...(oneTime.items || []), ...(oneTime.specItems || [])].find((item) => item.service === 'bora_care');
      expect(revisedBora).toBeDefined();
      expect(revisedBora.price).toBe(preFixLine.price);
    } finally {
      Object.assign(constants.SPECIALTY.boraCare, origBora);
    }
  });

  test('ignores client-supplied services.boraCare.knobs and preserves mapped pricingKnobs across revisions', async () => {
    const origBora = { ...constants.SPECIALTY.boraCare };
    const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
    try {
      // 1) Client-supplied services.boraCare.knobs must NEVER alter live pricing.
      const clean = generateEstimate({ ...PROPERTY, services: { boraCare: { atticSqFt: 1500 } } });
      const forged = generateEstimate({
        ...PROPERTY,
        services: { boraCare: { atticSqFt: 1500, knobs: { galCost: 1, marginDivisor: 1, pinnedPrice: 10 } } },
      });
      const cleanLine = clean.lineItems.find((l) => l.service === 'bora_care');
      const forgedLine = forged.lineItems.find((l) => l.service === 'bora_care');
      expect(forgedLine.price).toBe(cleanLine.price);

      // 2) Freshly mapped Bora-Care quote with nondefault costs keeps pricingKnobs on result.oneTime.specItems
      //    and replays identically even after DB settings change.
      constants.SPECIALTY.boraCare.galCost = 115;
      constants.SPECIALTY.boraCare.equipCost = 35;
      const nonDefaultEst = generateEstimate({ ...PROPERTY, services: { boraCare: { atticSqFt: 1500 } } });
      const nonDefaultLine = nonDefaultEst.lineItems.find((l) => l.service === 'bora_care');
      const mapped = mapV1ToLegacyShape(nonDefaultEst, PROPERTY);
      const mappedBora = mapped.oneTime.specItems.find((item) => item.service === 'bora_care');
      expect(mappedBora?.pricingKnobs?.galCost).toBe(115);
      expect(mappedBora?.pricingKnobs?.equipCost).toBe(35);

      const savedMappedOnly = {
        estimate_data: {
          inputs: { ...PROPERTY, services: { boraCare: { atticSqFt: 1500 } } },
          result: mapped,
        },
        monthly_total: 0,
        annual_total: 0,
        onetime_total: nonDefaultLine.price,
        waveguard_tier: 'Bronze',
      };
      constants.SPECIALTY.boraCare.galCost = 160;
      const rev = await buildEstimateServiceRevisionDraft(savedMappedOnly, 'lawn_care');
      expect(rev.status).toBe('priced');
      const revisedBora = rev.draftEstimateData.result?.oneTime?.specItems?.find((item) => item.service === 'bora_care');
      expect(revisedBora.price).toBe(nonDefaultLine.price);
    } finally {
      Object.assign(constants.SPECIALTY.boraCare, origBora);
    }
  });

  test('unstamped legacy Bora-Care rows (including name-only client rows and camelCase overrides) preserve quoted base price on unchanged scope and unpin on scope edit', async () => {
    const origBora = { ...constants.SPECIALTY.boraCare };
    const { boraCareKnobSignalForReplay } = require('../services/estimate-tree-shrub-knob-replay');
    try {
      // Unstamped row priced under a historical camelCase DB override (e.g. $1,375 instead of default).
      const camelCaseSaved = {
        estimate_data: {
          inputs: { ...PROPERTY, services: { boraCare: { atticSqFt: 1500 } } },
          result: {
            oneTime: {
              items: [],
              specItems: [{ name: 'Bora-Care Wood Treatment Service', price: 1375 }],
            },
          },
        },
        monthly_total: 0,
        annual_total: 0,
        onetime_total: 1375,
        waveguard_tier: 'Bronze',
      };
      constants.SPECIALTY.boraCare.galCost = 150;
      const rev = await buildEstimateServiceRevisionDraft(camelCaseSaved, 'lawn_care');
      expect(rev.status).toBe('priced');
      const revisedBora = rev.draftEstimateData.result?.oneTime?.specItems?.find((item) => item.service === 'bora_care');
      expect(revisedBora.price).toBe(1375);

      // If staff changes the attic scope during revision, the pinned price unpins cleanly.
      const signal = boraCareKnobSignalForReplay(camelCaseSaved.estimate_data);
      const resized = generateEstimate({
        ...PROPERTY,
        services: { boraCare: { atticSqFt: 3000 } },
        boraCarePricingKnobs: signal,
      });
      const resizedLine = resized.lineItems.find((l) => l.service === 'bora_care');
      expect(resizedLine.price).not.toBe(1375);
      expect(resizedLine.price).toBeGreaterThan(1375);
    } finally {
      Object.assign(constants.SPECIALTY.boraCare, origBora);
    }
  });

  test('public estimate prepay eligibility hides prepay on stamped 0% quotes without a setup waiver while keeping unwaived solo pest and termite annual plans', () => {
    const { annualPrepayHasSellableIncentive } = require('../routes/estimate-public');
    process.env.GATE_NO_YEAR1_PREPAY_DISCOUNT = 'true';
    const stampedLawn = generateEstimate({ ...PROPERTY, services: { lawn: { grassType: 'st_augustine', tier: 'enhanced', turfSqFt: 5000 } } });
    const stampedSoloPest = generateEstimate({ ...PROPERTY, services: { pest: { frequency: 'quarterly' } } });

    // Stamped lawn-only (no setup waiver, 0% prepay): hides annual prepay on /data.
    expect(annualPrepayHasSellableIncentive(
      { annual_total: 720 },
      { result: stampedLawn },
      {},
    )).toBe(false);

    // Stamped solo pest WITH setup waiver still owed ($99): keeps annual prepay on /data.
    expect(annualPrepayHasSellableIncentive(
      { annual_total: 480 },
      { result: stampedSoloPest },
      {},
    )).toBe(true);

    // Stamped solo pest with operator-waived setup fee (One-Time->Plan): hides annual prepay.
    expect(annualPrepayHasSellableIncentive(
      { annual_total: 480 },
      { result: stampedSoloPest, operatorPriceAdjustment: { waiveSetupFee: true } },
      {},
    )).toBe(false);

    // Stamped mandatory-prepay Subterranean Termite annual plan: keeps 5% & prepay eligibility.
    const termiteAnnualData = {
      pricingMetadata: { year1PrepayNoPercent: true },
      result: {
        results: { tmBait: { plan: 'annual_protection', annual: 1000 } },
        recurring: { services: [{ service: 'termite_bait', plan: 'annual_protection', annual: 1000 }] },
      },
    };
    expect(annualPrepayHasSellableIncentive(
      { annual_total: 1000 },
      termiteAnnualData,
      {},
    )).toBe(true);
  });

  test('annual-prepay billing switch honors stamped year1PrepayNoPercent on source estimate', () => {
    const { computeSeriesPrepayPricing } = require('../services/secure-appointment-plans');
    const stamped = computeSeriesPrepayPricing({
      perVisit: 100,
      visitsPerYear: 10,
      planClass: 'discount',
      noYear1PrepayPercent: true,
    });
    expect(stamped.annualBase).toBe(1000);
    expect(stamped.prepay.total).toBe(1000);
    expect(stamped.prepay.discount).toBe(0);
    expect(stamped.prepay.ratePctLabel).toBe('');

    const preGate = computeSeriesPrepayPricing({
      perVisit: 100,
      visitsPerYear: 10,
      planClass: 'discount',
      noYear1PrepayPercent: false,
    });
    expect(preGate.prepay.total).toBe(950);
    expect(preGate.prepay.discount).toBe(50);
  });

  test('staff revisions preserve unchanged misting, Bora-Care, and trenching lines while repricing edited scopes', async () => {
    const origBora = { ...constants.SPECIALTY.boraCare };
    const prevMistingGate = process.env.GATE_MOSQUITO_MISTING;
    process.env.GATE_MOSQUITO_MISTING = 'true';
    const { applyUnchangedRevisionPricingKnobs } = require('../services/estimate-tree-shrub-knob-replay');
    try {
      // Sent 30-nozzle Smart misting install quoted at pre-floor $4,195 (without essentialTierPrice knob).
      const sentMistingBlob = {
        result: {
          recurring: {
            services: [{
              service: 'mosquito_misting',
              tier: 'smart',
              solution: 'standard',
              nozzles: 30,
              risers: 0,
              refill: { solution: 'standard', refillsPerYear: 4 },
              pricingKnobs: {
                tier: 'smart',
                tierPrice: 4195,
                hardwareCost: 1850,
                includedNozzles: 30,
                extraNozzlePrice: 95,
                extraNozzleCost: 22,
                includedRisers: 0,
                extraRiserPrice: 75,
                extraRiserCost: 15,
                installTechs: 2,
                installHours: 8,
                laborRate: 35,
                planMonthly: 95,
                planVisitsPerYear: 6,
                laborMinutesPerVisit: 30,
                partsReservePerMonth: 10,
                refillSolution: 'standard',
                refillPrice: 275,
                refillProductCost: 85,
                serviceCallNoPlan: 125,
                minNozzles: 15,
                maxNozzles: 40,
                maxRisers: 20,
                maxRefillsPerYear: 12,
                defaultRefillsPerYear: 4,
              },
            }],
          },
        },
      };
      // Unchanged 30-nozzle Smart revision -> preserves $4,195 via stored mistingPricingKnobs!
      const unchangedInput = { ...PROPERTY, services: { mosquitoMisting: { tier: 'smart', solution: 'standard', nozzles: 30, risers: 0, refillsPerYear: 4 } } };
      applyUnchangedRevisionPricingKnobs(unchangedInput, sentMistingBlob);
      expect(unchangedInput.mistingPricingKnobs).toBeTruthy();
      const unchangedEst = generateEstimate(unchangedInput);
      const unchangedLine = unchangedEst.lineItems.find((li) => li.service === 'mosquito_misting');
      expect(unchangedLine.installation.price).toBe(4195);

      // Edited scope (adding 1 riser) -> drops stored knobs and reprices live with Smart>=Essential floor!
      const editedInput = { ...PROPERTY, services: { mosquitoMisting: { tier: 'smart', solution: 'standard', nozzles: 30, risers: 1, refillsPerYear: 4 } } };
      applyUnchangedRevisionPricingKnobs(editedInput, sentMistingBlob);
      expect(editedInput.mistingPricingKnobs).toBeUndefined();
      const editedEst = generateEstimate(editedInput);
      const editedLine = editedEst.lineItems.find((li) => li.service === 'mosquito_misting');
      const essentialComparable = generateEstimate({
        ...PROPERTY,
        services: { mosquitoMisting: { tier: 'essential', solution: 'standard', nozzles: 30, risers: 1, refillsPerYear: 4 } },
      }).lineItems.find((li) => li.service === 'mosquito_misting');
      expect(editedLine.installation.price).toBeGreaterThanOrEqual(essentialComparable.installation.price);
      expect(editedLine.installation.price).toBeGreaterThan(4195 + 75);
    } finally {
      Object.assign(constants.SPECIALTY.boraCare, origBora);
      if (prevMistingGate === undefined) delete process.env.GATE_MOSQUITO_MISTING;
      else process.env.GATE_MOSQUITO_MISTING = prevMistingGate;
    }
  });

  test('legacy Bora-Care replay recovers flat boracareSqft from V2 engineRequest.options', () => {
    const { boraCareKnobSignalForReplay } = require('../services/estimate-tree-shrub-knob-replay');
    const v2Saved = {
      engineRequest: {
        profile: { ...PROPERTY },
        selectedServices: ['BORACARE'],
        options: { boracareSqft: 1650 },
      },
      result: {
        oneTime: {
          items: [],
          specItems: [{ name: 'Bora-Care Wood Treatment Service', price: 1420 }],
        },
      },
    };
    const signal = boraCareKnobSignalForReplay(v2Saved);
    expect(signal).toMatchObject({ pinnedPrice: 1420, pinnedAtticSqFt: 1650 });
  });

  test('db-bridge resets Bora-Care constants from immutable defaults when a DB override key is removed', async () => {
    const origBora = { ...constants.SPECIALTY.boraCare };
    try {
      await syncConstantsFromDB(makePricingDb({
        pricingConfigRows: [{ config_key: 'onetime_boracare', data: { bc_gal: 125, bc_cov: 310 } }],
      }));
      expect(constants.SPECIALTY.boraCare.galCost).toBe(125);
      expect(constants.SPECIALTY.boraCare.coverage).toBe(310);

      // Removing bc_gal from DB row restores the immutable code default (91.98) while applying bc_cov.
      await syncConstantsFromDB(makePricingDb({
        pricingConfigRows: [{ config_key: 'onetime_boracare', data: { bc_cov: 290 } }],
      }));
      expect(constants.SPECIALTY.boraCare.galCost).toBe(91.98);
      expect(constants.SPECIALTY.boraCare.coverage).toBe(290);
    } finally {
      Object.assign(constants.SPECIALTY.boraCare, origBora);
    }
  });
});
