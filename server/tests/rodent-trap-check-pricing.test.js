/**
 * Rodent trapping: $350 covers setup + 1 trap check; visit 3+ is the
 * "Rodent Trap Check - Additional" catalog row (owner ruling 2026-09-26).
 * Pins the pricing-side guards and the customer copy.
 */
const { RODENT } = require('../services/pricing-engine/constants');
const copy = require('../services/estimate-one-time-copy');

describe('rodent trap check pricing + copy', () => {
  test('the engine allows one included check and a $95 code-default extra', () => {
    expect(RODENT.trapping.includedFollowUps).toBe(1);
    expect(RODENT.trapping.additionalCheckPrice).toBe(95);
  });

  test('the extra check is excluded from pricing-engine percentage discounts', () => {
    const { serviceExcludedFromPercentDiscount } = require('../services/pricing-engine/discount-engine');
    expect(serviceExcludedFromPercentDiscount('rodent_trap_check_additional')).toBe(true);
  });

  test('Pricing Logic refuses any trapping allowance other than 1', () => {
    const { validatePricingConfigData } = require('../routes/admin-pricing-config');
    const base = { emergency_multiplier: 1.2, emergency_minimum_surcharge: 75 };
    expect(validatePricingConfigData('rodent_trapping', { ...base, included_followups: 1 }).ok).toBe(true);
    expect(validatePricingConfigData('rodent_trapping', { ...base, included_followups: 2 }).ok).toBe(false);
    expect(validatePricingConfigData('rodent_trapping', { ...base, included_followups: 'unlimited' }).ok).toBe(false);
  });

  test('saved estimates render the allowance they were priced with', () => {
    const legacy = { service: 'rodent_trapping', price: 350, unlimitedCallbacks: true, includedFollowUps: 'unlimited' };
    const current = { service: 'rodent_trapping', price: 350, unlimitedCallbacks: false, includedFollowUps: 1 };
    const twoChecks = { service: 'rodent_trapping', price: 350, includedFollowUps: 2 };

    expect(copy.resolveOneTimeServiceCopy(legacy).includes.join(' ')).not.toMatch(/trap-check visit|billed separately/);
    expect(copy.oneTimeOnlyIntelligenceCopy([legacy]).aiBody).not.toMatch(/one trap check/);
    expect(copy.oneTimeOnlyIntelligenceCopy([legacy]).hero.sub).toMatch(/until the activity stops/);

    expect(copy.resolveOneTimeServiceCopy(current).includes).toContain('Setup visit plus 1 trap-check visit — additional checks are billed separately if the job needs them');
    expect(copy.oneTimeOnlyIntelligenceCopy([current]).aiBody).toMatch(/the setup visit and one trap check for/);

    expect(copy.resolveOneTimeServiceCopy(twoChecks).includes).toContain('Setup visit plus 2 trap-check visits — additional checks are billed separately if the job needs them');
    expect(copy.oneTimeOnlyIntelligenceCopy([twoChecks]).aiBody).toMatch(/the setup visit and two trap checks for/);
  });

  test('no copy carries an unfilled placeholder', () => {
    const current = { service: 'rodent_trapping', price: 350, includedFollowUps: 1 };
    const all = JSON.stringify([copy.resolveOneTimeServiceCopy(current), copy.oneTimeOnlyIntelligenceCopy([current])]);
    expect(all).not.toMatch(/\{checks\}|\{Checks\}/);
  });
});

describe('a new trapping quote renders the 1-check copy on the public page path', () => {
  const { generateEstimate } = require('../services/pricing-engine');
  const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
  const { normalizeOneTimeBreakdown } = require('../routes/estimate-public');

  test('engine → legacy mapper → normalizeOneTimeBreakdown keeps the allowance', () => {
    const mapped = mapV1ToLegacyShape(generateEstimate({
      homeSqFt: 2000, stories: 1, lotSqFt: 10000, propertyType: 'single_family', zone: 'A',
      features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
      services: { rodentTrapping: { plan: 'standard' } },
    }));
    const rows = normalizeOneTimeBreakdown({ result: mapped }).items
      .filter((r) => r.service === 'rodent_trapping');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ includedFollowUps: 1, unlimitedCallbacks: false });

    const [rowCopy] = copy.resolveOneTimeRowCopies(rows);
    expect(rowCopy.includes).toContain('Setup visit plus 1 trap-check visit — additional checks are billed separately if the job needs them');
    const page = copy.oneTimeOnlyIntelligenceCopy(rows);
    expect(page.aiBody).toMatch(/the setup visit and one trap check for/);
    expect(page.hero.sub).not.toMatch(/until the activity stops/);
  });

  test('non-trapping rows do not gain nullable allowance fields', () => {
    const result = {
      oneTime: {
        items: [{ service: 'flea', name: 'Flea Treatment', price: 250 }],
      },
    };
    const [row] = normalizeOneTimeBreakdown({ result }).items;
    expect(row).toMatchObject({ service: 'flea', label: 'Flea Treatment', amount: 250 });
    expect(row).not.toHaveProperty('includedFollowUps');
    expect(row).not.toHaveProperty('includedCallbacks');
    expect(row).not.toHaveProperty('unlimitedCallbacks');
    expect(row.includedScope).toBeNull();
  });
});

describe('public trapping quote catalog freshness', () => {
  const bridge = require('../services/pricing-engine/db-bridge');
  const { buildPricingBundle } = require('../routes/estimate-public');
  const { withTrustedCatalogPricing } = require('../services/pricing-engine/trusted-catalog-pricing');
  const { clearAllEstimatePricingCache } = require('../services/estimate-pricing-cache');

  function liveRodentEstimate(id) {
    return {
      id,
      estimate_data: {
        engineInputs: {
          homeSqFt: 2000,
          stories: 1,
          lotSqFt: 10000,
          propertyType: 'single_family',
          zone: 'A',
          features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
          services: { rodentTrapping: { plan: 'standard' } },
        },
      },
    };
  }

  function trappingRow(bundle) {
    return bundle.oneTimeBreakdown.items.find((row) => row.service === 'rodent_trapping');
  }

  afterEach(() => {
    clearAllEstimatePricingCache();
    jest.restoreAllMocks();
  });

  test('quote creation attaches the catalog price as a request-scoped engine input', async () => {
    jest.spyOn(bridge, 'readRodentAdditionalCheckPriceFromCatalog').mockResolvedValue(110.25);
    const input = {
      services: { rodentTrapping: { plan: 'standard' } },
      catalogPricing: { rodentAdditionalCheckPrice: 1 },
    };

    const trusted = await withTrustedCatalogPricing(input, { database: {} });

    expect(trusted).not.toBe(input);
    expect(trusted.catalogPricing).toEqual({ rodentAdditionalCheckPrice: 110.25 });
    expect(input.catalogPricing).toEqual({ rodentAdditionalCheckPrice: 1 });
  });

  test('a non-trapping quote drops a posted catalog override without changing its shape otherwise', async () => {
    const readCatalog = jest.spyOn(bridge, 'readRodentAdditionalCheckPriceFromCatalog');
    const posted = {
      homeSqFt: 1800,
      services: { flea: {} },
      catalogPricing: { rodentAdditionalCheckPrice: 1 },
    };

    await expect(withTrustedCatalogPricing(posted, { database: {} })).resolves.toEqual({
      homeSqFt: 1800,
      services: { flea: {} },
    });
    expect(readCatalog).not.toHaveBeenCalled();
  });

  test('a quote reads the catalog even when this process still holds the old bridge price', async () => {
    RODENT.trapping.additionalCheckPrice = 95;
    jest.spyOn(bridge, 'readRodentAdditionalCheckPriceFromCatalog').mockResolvedValue(110.25);

    const bundle = await buildPricingBundle(liveRodentEstimate('rodent-other-process-price'), { monthlyBilled: false });

    expect(trappingRow(bundle).detail).toContain('$110.25');
    expect(trappingRow(bundle).reason).toContain('$110.25');
  });

  test('a second request discards its cached bundle after another process changes the catalog', async () => {
    const readCatalog = jest.spyOn(bridge, 'readRodentAdditionalCheckPriceFromCatalog')
      .mockResolvedValueOnce(95)
      .mockResolvedValueOnce(110);
    const estimate = liveRodentEstimate('rodent-stale-estimate-cache');

    const first = await buildPricingBundle(estimate, { monthlyBilled: false });
    const second = await buildPricingBundle(estimate, { monthlyBilled: false });

    expect(trappingRow(first).detail).toContain('$95');
    expect(trappingRow(second).detail).toContain('$110');
    expect(readCatalog).toHaveBeenCalledTimes(2);
    expect(second.cacheHit).not.toBe(true);
  });

  test('a sent snapshot stays frozen without consulting the current catalog', async () => {
    const readCatalog = jest.spyOn(bridge, 'readRodentAdditionalCheckPriceFromCatalog').mockResolvedValue(110);
    const frozen = {
      id: 'rodent-sent-snapshot',
      estimate_data: {
        engineInputs: {
          services: { rodentTrapping: { plan: 'standard' } },
        },
        sendSnapshot: {
          pricingBundle: {
            frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 88, annual: 1056 }],
            firstVisitFees: [{ service: 'waveguard_setup', amount: 99, label: 'WaveGuard setup', waivedWithPrepay: true }],
            source: 'frozen_rodent_snapshot',
          },
        },
        result: {
          recurring: { services: [{ name: 'Pest Control', mo: 88 }] },
        },
      },
    };

    const bundle = await buildPricingBundle(frozen, { monthlyBilled: false });

    expect(bundle).toMatchObject({ snapshotHit: true, source: 'frozen_rodent_snapshot' });
    expect(readCatalog).not.toHaveBeenCalled();
  });
});

describe('active admin V2 calculator catalog freshness', () => {
  const pricingEngine = require('../services/pricing-engine');
  const bridge = require('../services/pricing-engine/db-bridge');
  const propertyRouter = require('../routes/property-lookup-v2');
  const handler = propertyRouter.stack
    .find((layer) => layer.route?.path === '/calculate-estimate' && layer.route.methods.post)
    .route.stack.at(-1).handle;

  afterEach(() => jest.restoreAllMocks());

  test('another process catalog edit overrides this process stale 60-second singleton', async () => {
    RODENT.trapping.additionalCheckPrice = 95;
    jest.spyOn(pricingEngine, 'needsSync').mockReturnValue(false);
    const readCatalog = jest.spyOn(bridge, 'readRodentAdditionalCheckPriceFromCatalog').mockResolvedValue(110.25);
    const req = {
      body: {
        profile: {
          homeSqFt: 2000,
          lotSqFt: 10000,
          stories: 1,
          propertyType: 'single_family',
          zone: 'A',
          features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
        },
        selectedServices: ['RODENT_TRAP'],
        options: {},
      },
    };
    let statusCode = 200;
    let payload;
    const res = {
      status(code) { statusCode = code; return this; },
      json(body) { payload = body; return this; },
    };

    await handler(req, res);

    expect(statusCode).toBe(200);
    const trapping = payload.oneTime.specItems.find((item) => item.service === 'rodent_trapping');
    expect(trapping.detail).toContain('$110.25');
    expect(trapping.pricingBasis.additionalCheckPrice).toBe(110.25);
    expect(readCatalog).toHaveBeenCalledTimes(1);
  });
});
