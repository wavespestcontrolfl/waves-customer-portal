// buildPortalOffer — the portal-home variant of the report cross-sell card
// (portal roadmap bet 2, owner rulings 2026-08-13). The offer matrix itself
// is pinned cell-by-cell in service-report-cross-sell.test.js; this suite
// pins the PORTAL-SPECIFIC deltas: no identity-start (owns-nothing → no
// offer), the always-required single-premises proof, and that the shared
// demotion rules still hold on this entry point.

jest.mock('../services/property-lookup/lookup-cache', () => ({
  hasVerifiedOverrides: jest.fn(async () => false),
}));

// The lookup itself is never run here: a test passes its own, or reads the options the default one is called with.
jest.mock('../routes/property-lookup-v2', () => ({ performPropertyLookup: jest.fn(async () => null) }));

const { buildPortalOffer, buildOfferForFamily, buildStartOffer } = require('../services/service-report/cross-sell');
const { hasVerifiedOverrides } = require('../services/property-lookup/lookup-cache');

const FUTURE_SCHEDULED_DATE = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);

// Same minimal knex fake as the report suite (kept in sync by hand — the
// fixture builder is test scaffolding, not a production surface).
function dbForTables(tables = {}) {
  const dbFn = (table) => {
    const rows = tables[table] || [];
    const q = {
      where() { return q; },
      whereNotIn() { return q; },
      whereIn() { return q; },
      orWhereNull() { return q; },
      leftJoin() { return q; },
      orderBy() { return q; },
      select() { return rows; },
      limit() { return q; },
      first() { return rows[0] || null; },
      whereNotNull() { return q; },
      distinct() { return rows; },
      columnInfo() {
        return table === 'scheduled_services'
          ? {
            is_recurring: {},
            service_address_line1: {},
            service_address_line2: {},
            service_address_city: {},
            service_address_zip: {},
          }
          : {};
      },
    };
    return q;
  };
  dbFn.schema = { hasTable: async (name) => Object.prototype.hasOwnProperty.call(tables, name) };
  return dbFn;
}

const CUSTOMER = (overrides = {}) => ({
  id: 'cust-1',
  active: true,
  waveguard_tier: 'Bronze',
  monthly_rate: 55,
  property_sqft: 4500,
  lot_sqft: 7000,
  lawn_type: 'St. Augustine',
  address_line1: '123 Gulf Dr',
  city: 'Sarasota',
  state: 'FL',
  zip: '34236',
  ...overrides,
});

function recurringRows(serviceTypes) {
  return serviceTypes.map((service_type, index) => ({
    id: `svc-${index + 1}`,
    service_type,
    scheduled_date: FUTURE_SCHEDULED_DATE,
    status: 'scheduled',
    is_recurring: true,
  }));
}

function dbFor({ customer = CUSTOMER(), serviceTypes = [], planRates = [], turfProfile = null, estimates = [], tables = {} } = {}) {
  const scheduled = recurringRows(serviceTypes);
  return dbForTables({
    customers: [customer],
    customer_properties: [],
    scheduled_services: scheduled,
    'scheduled_services as s': scheduled,
    customer_turf_profiles: turfProfile ? [turfProfile] : [],
    estimates,
    customer_plan_rates: planRates,
    ...tables,
  });
}

const missLookup = async () => null;

beforeEach(() => {
  hasVerifiedOverrides.mockClear();
  hasVerifiedOverrides.mockImplementation(async () => false);
});

describe('buildPortalOffer', () => {
  test('pest+lawn recurring → no offer (owner 2026-11-21: the ladder pushes pest and lawn only)', async () => {
    const db = dbFor({ serviceTypes: ['Quarterly Pest Control', 'Lawn Care Program'] });
    expect(await buildPortalOffer('cust-1', db, { propertyLookup: missLookup })).toBeNull();
  });

  test('pest recurring → the matrix target (lawn) with a fingerprint', async () => {
    const db = dbFor({ serviceTypes: ['Quarterly Pest Control'] });
    const offer = await buildPortalOffer('cust-1', db, { propertyLookup: missLookup });
    expect(offer).not.toBeNull();
    expect(offer.serviceKey).toBe('lawn_care');
    expect(offer.relationship).toBe('add');
    expect(['priced', 'quote_cta']).toContain(offer.mode);
    expect(typeof offer.fingerprint).toBe('string');
    expect(offer.fingerprint.length).toBeGreaterThan(0);
    // Per-application is the only price field the payload may carry.
    if (offer.mode === 'priced') {
      expect(offer.option.perVisit).toBeGreaterThan(0);
      expect(offer.option.monthly).toBeUndefined();
      expect(offer.option.annual).toBeUndefined();
    }
  });

  test('owns NOTHING recurring → no offer (portal has no identity-start branch; one-time services are never pushed)', async () => {
    const db = dbFor({ serviceTypes: [] });
    expect(await buildPortalOffer('cust-1', db, { propertyLookup: missLookup })).toBeNull();
  });

  test('owns everything → no offer (owner matrix: the referral card fills the slot)', async () => {
    const db = dbFor({
      serviceTypes: ['Quarterly Pest Control', 'Lawn Care Program', 'Tree & Shrub Care', 'Termite Bait Program'],
    });
    expect(await buildPortalOffer('cust-1', db, { propertyLookup: missLookup })).toBeNull();
  });

  test('inactive customer → no offer', async () => {
    const db = dbFor({ customer: CUSTOMER({ active: false }), serviceTypes: ['Quarterly Pest Control'] });
    expect(await buildPortalOffer('cust-1', db, { propertyLookup: missLookup })).toBeNull();
  });

  test('no provable primary premises (blank address) → no offer', async () => {
    const db = dbFor({
      customer: CUSTOMER({ address_line1: null, city: null, zip: null }),
      serviceTypes: ['Quarterly Pest Control'],
    });
    expect(await buildPortalOffer('cust-1', db, { propertyLookup: missLookup })).toBeNull();
  });

  test('multi-home account (has_multi_home) → no offer (single-premises proof is always required)', async () => {
    const db = dbFor({
      customer: CUSTOMER({ has_multi_home: true }),
      serviceTypes: ['Quarterly Pest Control'],
    });
    expect(await buildPortalOffer('cust-1', db, { propertyLookup: missLookup })).toBeNull();
  });

  // A pest-only member with a measured lawn: the ladder offers lawn and the
  // turf profile prices it. Each test below proves that control first, so its
  // own answer is the guard's doing and not an early "nothing to offer".
  const PRICED_LAWN_SEED = {
    serviceTypes: ['Quarterly Pest Control'],
    turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
  };
  const expectPricedLawnControl = async () => {
    const control = await buildPortalOffer('cust-1', dbFor(PRICED_LAWN_SEED), { propertyLookup: missLookup });
    expect(control?.serviceKey).toBe('lawn_care');
    expect(control.mode).toBe('priced');
  };

  test('a verified correction on file demotes to the quote CTA (no price on stale facts)', async () => {
    await expectPricedLawnControl();
    hasVerifiedOverrides.mockImplementation(async () => true);
    const offer = await buildPortalOffer('cust-1', dbFor(PRICED_LAWN_SEED), { propertyLookup: missLookup });
    expect(offer).not.toBeNull();
    expect(offer.serviceKey).toBe('lawn_care');
    expect(offer.mode).toBe('quote_cta');
    expect(offer.option).toBeNull();
  });

  test('a live plan-rate on the target family suppresses the offer entirely', async () => {
    await expectPricedLawnControl();
    const db = dbFor({ ...PRICED_LAWN_SEED, planRates: [{ family_key: 'lawn_care', monthly_rate: 40 }] });
    expect(await buildPortalOffer('cust-1', db, { propertyLookup: missLookup })).toBeNull();
  });
});

// buildOfferForFamily — the photo-triage lane's targeted variant (2026-09-25):
// the family is fixed by what the photo shows, every other gate is the
// portal card's.
describe('buildOfferForFamily', () => {
  // Moved from the report suite when tree & shrub left the ladder
  // (2026-11-21): a requested T&S family (My Plan list, photo triage) is now
  // the only way a T&S offer is built.
  test('a seeded synthetic zero tree count never prices a tree & shrub offer (codex #3367 PR r10)', async () => {
    // The v1 lookup adapter stores treeCount: 0 when nothing was observed;
    // a zero count has no provenance (operator-confirmed vs adapter
    // synthetic), so neither replaying zero trees nor a phantom density
    // fallback is safe — the offer demotes to the unpriced CTA.
    const estimateWith = (features) => [{
      id: 'est-1',
      address: '123 Gulf Dr, Sarasota, FL 34236',
      status: 'accepted',
      estimate_data: JSON.stringify({
        engineInputs: {
          homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup',
          bedArea: 3000, bedAreaSource: 'explicit', features,
        },
      }),
    }];
    const run = (features) => buildOfferForFamily('cust-1', dbFor({
      serviceTypes: ['Quarterly Pest Control', 'Lawn Care Program'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: estimateWith(features),
    }), 'tree_shrub', { propertyLookup: missLookup });
    // Control: the same seed without the zero count prices, so the CTA
    // below is the zero count's doing and nothing else's.
    expect((await run({ trees: 'moderate' }))?.mode).toBe('priced');
    const withSyntheticZero = await run({ trees: 'moderate', treeCount: 0 });
    expect(withSyntheticZero).not.toBeNull();
    expect(withSyntheticZero.serviceKey).toBe('tree_shrub');
    expect(withSyntheticZero.mode).toBe('quote_cta');
    expect(withSyntheticZero.option).toBeNull();
  });

  test('lawn-only customer asked about tree & shrub → a tree & shrub offer (the ladder would have picked pest)', async () => {
    const db = dbFor({ serviceTypes: ['Lawn Care Program'] });
    expect((await buildPortalOffer('cust-1', db, { propertyLookup: missLookup }))?.serviceKey).toBe('pest_control');
    const offer = await buildOfferForFamily('cust-1', db, 'tree_shrub', { propertyLookup: missLookup });
    expect(offer).not.toBeNull();
    expect(offer.serviceKey).toBe('tree_shrub');
    expect(['priced', 'quote_cta']).toContain(offer.mode);
    if (offer.mode === 'priced') {
      expect(offer.option.perVisit).toBeGreaterThan(0);
      expect(offer.option.monthly).toBeUndefined();
      expect(offer.option.annual).toBeUndefined();
    }
  });

  test('a family the customer already owns is never re-priced → mode owned, no option, no price', async () => {
    const db = dbFor({ serviceTypes: ['Lawn Care Program'] });
    const offer = await buildOfferForFamily('cust-1', db, 'lawn_care', { propertyLookup: missLookup });
    expect(offer).toMatchObject({ serviceKey: 'lawn_care', mode: 'owned', option: null });
    expect(typeof offer.fingerprint).toBe('string');
    // The ladder entry points never see the owned shape.
    expect((await buildPortalOffer('cust-1', db, { propertyLookup: missLookup })).mode).not.toBe('owned');
  });

  test('owns NOTHING recurring → null (no engine quote for a customer with no plan)', async () => {
    const db = dbFor({ serviceTypes: [] });
    expect(await buildOfferForFamily('cust-1', db, 'tree_shrub', { propertyLookup: missLookup })).toBeNull();
  });

  test('a live plan-rate on the requested family fails closed → mode unavailable, no option (the ladder still returns null)', async () => {
    const db = dbFor({ serviceTypes: ['Lawn Care Program'], planRates: [{ family_key: 'tree_shrub', monthly_rate: 40 }] });
    expect(await buildOfferForFamily('cust-1', db, 'tree_shrub', { propertyLookup: missLookup })).toMatchObject({ serviceKey: 'tree_shrub', mode: 'unavailable', option: null });
    const ladderDb = dbFor({ serviceTypes: ['Quarterly Pest Control', 'Lawn Care Program'], planRates: [{ family_key: 'tree_shrub', monthly_rate: 40 }] });
    expect(await buildPortalOffer('cust-1', ladderDb, { propertyLookup: missLookup })).toBeNull();
  });

  test('a live plan-rate on the requested family with NO seeded visit row still fails closed (codex #4810 r5)', async () => {
    const db = dbFor({ serviceTypes: [], planRates: [{ family_key: 'lawn_care', monthly_rate: 55 }] });
    expect(await buildOfferForFamily('cust-1', db, 'lawn_care', { propertyLookup: missLookup })).toMatchObject({ serviceKey: 'lawn_care', mode: 'unavailable', option: null });
    // Other families on an owns-nothing account are still simply not offered.
    expect(await buildOfferForFamily('cust-1', db, 'tree_shrub', { propertyLookup: missLookup })).toBeNull();
    // The ladder path is unchanged: owns nothing → null.
    expect(await buildPortalOffer('cust-1', db, { propertyLookup: missLookup })).toBeNull();
  });

  test('an ownership lookup failure fails closed → mode unavailable, never null', async () => {
    const db = dbFor({ serviceTypes: ['Lawn Care Program'] });
    const broken = Object.assign((table) => {
      if (table === 'scheduled_services as s') throw new Error('catalog join down');
      return db(table);
    }, { schema: db.schema });
    const offer = await buildOfferForFamily('cust-1', broken, 'tree_shrub', { propertyLookup: missLookup });
    expect(offer).toMatchObject({ serviceKey: 'tree_shrub', mode: 'unavailable', option: null });
    // Dispatch-time callers ask for the error instead (codex #4810 r7).
    await expect(buildOfferForFamily('cust-1', broken, 'tree_shrub', { propertyLookup: missLookup, throwOnError: true })).rejects.toThrow();
  });

  test('throwOnError also surfaces the best-effort inner failures (verified-override probe) instead of demoting (codex #4810 r8)', async () => {
    hasVerifiedOverrides.mockImplementation(async () => { throw new Error('probe down'); });
    const db = dbFor({ serviceTypes: ['Lawn Care Program'] });
    // Creation-time: demoted to the CTA, as the card does.
    expect((await buildOfferForFamily('cust-1', db, 'tree_shrub', { propertyLookup: missLookup })).mode).toBe('quote_cta');
    // Dispatch-time: the error reaches the caller.
    await expect(buildOfferForFamily('cust-1', db, 'tree_shrub', { propertyLookup: missLookup, throwOnError: true })).rejects.toThrow('probe down');
  });

  test('throwOnError surfaces a property-lookup throw the pricer would swallow into a profile-only price (codex #4810 r9)', async () => {
    const downLookup = jest.fn(async () => { throw new Error('lookup down'); });
    const db = dbFor({ serviceTypes: ['Lawn Care Program'] });
    // Creation-time: best effort, no throw.
    await expect(buildOfferForFamily('cust-1', db, 'tree_shrub', { propertyLookup: downLookup })).resolves.not.toBeUndefined();
    expect(downLookup).toHaveBeenCalled();
    // Dispatch-time: the lookup outage reaches the caller.
    await expect(buildOfferForFamily('cust-1', db, 'tree_shrub', { propertyLookup: downLookup, throwOnError: true })).rejects.toThrow('lookup down');
  });

  test('a verified correction on file demotes to the quote CTA, same as the card', async () => {
    hasVerifiedOverrides.mockImplementation(async () => true);
    const db = dbFor({ serviceTypes: ['Lawn Care Program'] });
    const offer = await buildOfferForFamily('cust-1', db, 'tree_shrub', { propertyLookup: missLookup });
    expect(offer).not.toBeNull();
    expect(offer.mode).toBe('quote_cta');
    expect(offer.option).toBeNull();
  });

  test('no provable single premises → a requested family fails closed (unavailable); the ladder still returns null (codex #4810 r12)', async () => {
    for (const customer of [CUSTOMER({ has_multi_home: true }), CUSTOMER({ address_line1: null, city: null, zip: null })]) {
      const db = dbFor({ customer, serviceTypes: ['Quarterly Pest Control'] });
      expect(await buildOfferForFamily('cust-1', db, 'tree_shrub', { propertyLookup: missLookup }))
        .toMatchObject({ serviceKey: 'tree_shrub', mode: 'unavailable', option: null });
      expect(await buildPortalOffer('cust-1', db, { propertyLookup: missLookup })).toBeNull();
    }
  });

  test('the pricer\'s own refusals keep their meaning for a requested family: alreadyIncluded → owned, PRICING_UNAVAILABLE → unavailable (codex #4810 r12)', async () => {
    const pricingAi = require('../services/customer-pricing-ai');
    const spy = jest.spyOn(pricingAi, 'buildCustomerPricingResponse');
    try {
      const db = dbFor({ serviceTypes: ['Lawn Care Program'] });
      spy.mockResolvedValueOnce({ ok: true, options: [], alreadyIncluded: ['tree_shrub'], currentServiceKeys: ['lawn_care'] });
      expect(await buildOfferForFamily('cust-1', db, 'tree_shrub', { propertyLookup: missLookup }))
        .toMatchObject({ serviceKey: 'tree_shrub', mode: 'owned', option: null });
      spy.mockResolvedValueOnce({ ok: false, code: 'PRICING_UNAVAILABLE' });
      expect(await buildOfferForFamily('cust-1', db, 'tree_shrub', { propertyLookup: missLookup }))
        .toMatchObject({ serviceKey: 'tree_shrub', mode: 'unavailable', option: null });
      // The ladder entry point keeps its plain null for both.
      spy.mockResolvedValueOnce({ ok: true, options: [], alreadyIncluded: ['pest_control'], currentServiceKeys: ['lawn_care'] });
      expect(await buildPortalOffer('cust-1', db, { propertyLookup: missLookup })).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test('an unknown family → null', async () => {
    const db = dbFor({ serviceTypes: ['Lawn Care Program'] });
    expect(await buildOfferForFamily('cust-1', db, 'mosquito', { propertyLookup: missLookup })).toBeNull();
  });
});

// buildStartOffer — the one-time job to plan offer's price (owner 2026-11-19): the same stages for a customer
// who has NO plan, on the pricer's strict option. The portal entry points keep their "owns nothing → no offer"
// answer (pinned above); this one is the only way to price a plan for that customer, so its answers are pinned
// here. The strict rules have their own suite (customer-pricing-ai.test.js, strictPriceSettings) and so has the
// shared proof (plan-start-eligibility.test.js). Here the proof's two answers and the bridge's operation are
// spies, and the tests pin what THIS function does with them. The engine is the real one.
describe('buildStartOffer', () => {
  const proof = require('../services/plan-start-eligibility');
  const bridge = require('../services/pricing-engine/db-bridge');
  const pricer = require('../services/customer-pricing-ai');
  // A saved lookup the real engine prices from (the report suite's own shape).
  const SAVED = { enriched: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} };
  const savedLookup = async () => SAVED;
  // The visit the offer follows. Bare: no stamp and no link, so the single-premises proof decides.
  const VISIT = { id: 'visit-1' };
  // The one-time customer the offer is for: no tier and no rate on the account (the suite's fixture is a member).
  const NO_PLAN = { waveguard_tier: null, monthly_rate: null };
  const noPlanDb = ({ customer = {}, visits = [VISIT], tables = {} } = {}) => dbFor({
    customer: CUSTOMER({ ...NO_PLAN, ...customer }),
    tables: { scheduled_services: visits, ...tables },
  });
  const start = (db = noPlanDb(), options = {}) => buildStartOffer('cust-1', db, 'pest_control', { propertyLookup: savedLookup, visitId: VISIT.id, ...options });
  const PRICED = { reason: null, option: { id: 'pest-quarterly' } };
  const refused = (reason) => ({ option: null, reason });

  let accountBlocker;
  let propertyBlocker;
  let ownSettings;
  beforeEach(() => {
    accountBlocker = jest.spyOn(proof, 'planStartBlocker').mockResolvedValue(null);
    propertyBlocker = jest.spyOn(proof, 'resolvedPropertyTypeBlocker').mockResolvedValue(null);
    ownSettings = jest.spyOn(bridge, 'withSettingsForUnattendedPrice').mockImplementation(async (price) => ({ priced: true, value: price() }));
  });
  afterEach(() => { accountBlocker.mockRestore(); propertyBlocker.mockRestore(); ownSettings.mockRestore(); });

  test('a customer with no plan gets the standard pest plan, priced by the real engine on the strict option', async () => {
    const db = noPlanDb();
    const { option, reason } = await start(db);
    expect(reason).toBeNull();
    expect(option.id).toBe('pest-quarterly');
    expect(option.perVisit).toBeGreaterThan(0);
    // The fee the offer removes: a customer with no recurring service is priced as new.
    expect(option.setupFee).toBeGreaterThan(0);
    // The FULL quoted option (server-only), not the card payload that carries perVisit alone.
    expect(option.annual).toBeGreaterThan(0);
    // The strict option: the shared proof was asked about this account, and the engine ran inside the bridge's
    // one operation (its own refresh of the price settings).
    expect(accountBlocker).toHaveBeenCalledWith(db, 'cust-1');
    expect(ownSettings).toHaveBeenCalledTimes(1);
  });

  test('the cards a person looks at do not ask for the strict option', async () => {
    const spy = jest.spyOn(pricer, 'buildCustomerPricingResponse');
    try {
      await buildPortalOffer('cust-1', dbFor({ serviceTypes: ['Quarterly Pest Control'] }), { propertyLookup: savedLookup });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].strictPriceSettings).toBe(false);
      spy.mockClear();
      await start();
      expect(spy.mock.calls[0][0].strictPriceSettings).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(accountBlocker).toHaveBeenCalledTimes(1);
  });

  // The pricer refuses the account with PLAN_START_BLOCKED and the proof's answer. This function owns the
  // reason the job reads, the proof's own word: 'has_plan', 'commercial', 'not_live'.
  describe("the proof's answer about the account", () => {
    test.each([
      ['has_plan', 'has_plan'],
      ['commercial', 'commercial'],
      ['not_live', 'not_live'],
    ])('%s is the reason %s, and nothing is priced', async (blocker, reason) => {
      accountBlocker.mockResolvedValue(blocker);
      expect(await start()).toEqual(refused(reason));
      expect(ownSettings).not.toHaveBeenCalled();
    });

    test("its answer about the resolved property type keeps its word: 'commercial'", async () => {
      propertyBlocker.mockResolvedValue('commercial');
      expect(await start()).toEqual(refused('commercial'));
      expect(ownSettings).not.toHaveBeenCalled();
    });

    test('an answer this function has no reason for is thrown, never read as a reason or as a price', async () => {
      accountBlocker.mockResolvedValue('a_new_answer');
      await expect(start()).rejects.toMatchObject({ code: 'PLAN_START_BLOCKED', blocker: 'a_new_answer' });
    });

    test('a failed read of the proof is thrown', async () => {
      accountBlocker.mockRejectedValue(new Error('proof down'));
      await expect(start()).rejects.toThrow('proof down');
    });

    // The reason table is for the pricer's refusal of the account alone. Another error is an outage, also when
    // it happens to carry a blocker.
    test('an error of another code that names a blocker is thrown, never read as a reason', async () => {
      const spy = jest.spyOn(pricer, 'buildCustomerPricingResponse');
      try {
        spy.mockRejectedValueOnce(Object.assign(new Error('not a refusal'), { code: 'SOMETHING_ELSE', blocker: 'has_plan' }));
        await expect(start()).rejects.toMatchObject({ code: 'SOMETHING_ELSE' });
      } finally {
        spy.mockRestore();
      }
    });
  });

  test('a home with no saved lookup is not priced (no price on profile facts alone)', async () => {
    expect(await start(noPlanDb(), { propertyLookup: missLookup })).toEqual(refused('not_priced'));
  });

  // The strict option of the pricer does not ask whether a lookup that missed left a staff correction of a
  // measurement unapplied. The pricing stage this function calls does (hasVerifiedOverrides), and the price
  // that an accepted estimate's measurements would give is then withheld.
  describe('a home priced from an accepted estimate (the lookup missed)', () => {
    const seeded = () => noPlanDb({
      tables: {
        estimates: [{
          id: 'est-1', address: '123 Gulf Dr, Sarasota, FL 34236', status: 'accepted',
          estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
        }],
      },
    });

    test('is priced when no staff correction is on file', async () => {
      expect(await start(seeded(), { propertyLookup: missLookup })).toMatchObject(PRICED);
      expect(hasVerifiedOverrides).toHaveBeenCalledTimes(1);
    });

    test('is not priced when a staff correction is on file', async () => {
      hasVerifiedOverrides.mockImplementation(async () => true);
      expect(await start(seeded(), { propertyLookup: missLookup })).toEqual(refused('not_priced'));
    });

    test('a failed read of the corrections is thrown', async () => {
      hasVerifiedOverrides.mockImplementation(async () => { throw new Error('probe down'); });
      await expect(start(seeded(), { propertyLookup: missLookup })).rejects.toThrow('probe down');
    });
  });

  // The start offer prices with nobody watching, so its default lookup asks for strict reads: a failed cache or
  // correction read is thrown (the default form serves the cached home without its corrections). The cards a
  // person looks at keep the default reads.
  describe('the lookup the start offer runs by default', () => {
    const { performPropertyLookup } = require('../routes/property-lookup-v2');
    afterEach(() => { performPropertyLookup.mockReset(); performPropertyLookup.mockImplementation(async () => null); });

    test('is cache-only, stores nothing and asks for strict reads', async () => {
      performPropertyLookup.mockResolvedValue(SAVED);
      expect(await buildStartOffer('cust-1', noPlanDb(), 'pest_control', { visitId: VISIT.id })).toMatchObject(PRICED);
      expect(performPropertyLookup).toHaveBeenCalled();
      for (const [, options] of performPropertyLookup.mock.calls) {
        expect(options).toEqual({ cacheOnly: true, persist: false, strictCacheReads: true });
      }
    });

    test('the portal card keeps the default reads', async () => {
      performPropertyLookup.mockResolvedValue(SAVED);
      await buildPortalOffer('cust-1', dbFor({ serviceTypes: ['Quarterly Pest Control'] }));
      expect(performPropertyLookup).toHaveBeenCalled();
      for (const [, options] of performPropertyLookup.mock.calls) expect(options).toEqual({ cacheOnly: true, persist: false });
    });

    test('a failed cache or correction read is thrown: never a miss, never a price', async () => {
      performPropertyLookup.mockRejectedValue(Object.assign(new Error('property lookup verified override read failed'), { code: 'LOOKUP_CACHE_READ_FAILED' }));
      await expect(buildStartOffer('cust-1', noPlanDb(), 'pest_control', { visitId: VISIT.id })).rejects.toMatchObject({ code: 'LOOKUP_CACHE_READ_FAILED' });
    });
  });

  // The offer follows one visit and prices the primary home. The account-level proof skips a visit whose link
  // cannot be resolved, so without this proof such a job could earn a price for a home it was not at.
  // The price is for the primary home. The start offer runs the account's single-premises proof in its strict
  // form, and that proof reads every visit of the account: the visit the offer follows, and every other one.
  describe('every visit of the account must be at the home the price is for', () => {
    // The fixture customer's home, stamped on the visit as dispatch stamps it, and as an estimate names it.
    const AT_HOME = { service_address_line1: '123 Gulf Dr', service_address_city: 'Sarasota', service_address_zip: '34236' };
    const ELSEWHERE = { service_address_line1: '9 Other St', service_address_city: 'Venice', service_address_zip: '34285' };
    const LINKED = { source_estimate_id: 'est-1' };
    const estimateAt = (address) => ({ estimates: [{ id: 'est-1', address }] });
    const follow = (visits, tables) => start(noPlanDb({ visits, tables }));

    test.each([
      ['a visit stamped at the primary home', AT_HOME, undefined],
      ['a visit with no stamp and no link', {}, undefined],
      ['a visit whose estimate names the primary home', LINKED, estimateAt('123 Gulf Dr, Sarasota, FL 34236')],
    ])('%s is priced', async (_label, visit, tables) => {
      expect(await follow([{ ...VISIT, ...visit }], tables)).toMatchObject(PRICED);
    });

    test.each([
      ['a visit stamped at another home', ELSEWHERE, undefined],
      ['a visit whose estimate names another home', LINKED, estimateAt('9 Other St, Venice, FL 34285')],
      ['a visit whose estimate has no address (a link that cannot be resolved)', LINKED, estimateAt(null)],
      ['a visit whose estimate is not on file (a link that cannot be resolved)', LINKED, undefined],
    ])('%s is refused, never priced at the primary home', async (_label, visit, tables) => {
      expect(await follow([{ ...VISIT, ...visit }], tables)).toEqual(refused('premises'));
      expect(accountBlocker).not.toHaveBeenCalled();
    });

    // Another visit of the account whose link cannot be resolved could be at a second home. So the account is
    // refused: also when the visit the offer follows is stamped at the primary home.
    const UNRESOLVED_LINK = { id: 'visit-2', source_estimate_id: 'est-gone' };
    test.each([
      ['a visit with no stamp and no link', {}],
      ['a visit stamped at the primary home', AT_HOME],
    ])('%s is refused when another visit of the account has a link that cannot be resolved', async (_label, visit) => {
      expect(await follow([{ ...VISIT, ...visit }, UNRESOLVED_LINK])).toEqual(refused('premises'));
      expect(accountBlocker).not.toHaveBeenCalled();
    });

    // The cards keep the default form of that proof, as before: a person looks at a card.
    test('the same visit does not take the portal card away', async () => {
      const services = ['Quarterly Pest Control'];
      const member = dbFor({ serviceTypes: services, tables: { scheduled_services: [...recurringRows(services), UNRESOLVED_LINK] } });
      const card = await buildPortalOffer('cust-1', member, { propertyLookup: missLookup });
      expect(card).not.toBeNull();
      expect(card.serviceKey).toBe((await buildPortalOffer('cust-1', dbFor({ serviceTypes: services }), { propertyLookup: missLookup })).serviceKey);
    });

    test('a failed read of a link throws: an outage is never read as "another home"', async () => {
      const db = noPlanDb({ visits: [{ ...VISIT, ...LINKED }] });
      const failing = (table) => { if (table === 'estimates') throw new Error('estimates down'); return db(table); };
      failing.schema = db.schema;
      await expect(start(failing)).rejects.toThrow('estimates down');
    });

    test("a visit that is not this customer's is refused", async () => {
      expect(await follow([])).toEqual(refused('premises'));
    });

    // Without the visit nothing says which job the offer follows. So the visit is required, and its absence
    // is never a price.
    test.each([[undefined], [null], ['']])('a call with no visit (%p) is a programming error, never a price', async (visitId) => {
      await expect(start(noPlanDb(), { visitId })).rejects.toThrow('the visit the offer follows');
    });
  });

  test('an inactive, multi-home or address-less account is refused on the premises proof, before the pricer is asked', async () => {
    for (const customer of [{ active: false }, { has_multi_home: true }, { address_line1: null, city: null, zip: null }]) {
      expect(await start(noPlanDb({ customer }))).toEqual(refused('premises'));
    }
    expect(accountBlocker).not.toHaveBeenCalled();
  });

  test("another cadence is never priced under the standard plan's name (pickOption's fallback is refused)", async () => {
    const spy = jest.spyOn(pricer, 'buildCustomerPricingResponse');
    try {
      spy.mockResolvedValueOnce({
        ok: true, alreadyIncluded: [], currentServiceKeys: [], property: {},
        options: [{ id: 'pest-bimonthly', serviceKey: 'pest_control', label: 'Bi-monthly pest control', perVisit: 80, setupFee: 99, confidence: 'high' }],
      });
      expect(await start()).toEqual(refused('not_priced'));
    } finally {
      spy.mockRestore();
    }
  });

  // The pricing stage's own refusals. With the strict option the pricer refuses these accounts first
  // (PLAN_START_BLOCKED), so each one is a second line: the answer is never a price, and never a crash.
  test.each([
    ['the pricer answers nothing', null],
    ['the pricer finds the family already active', { ok: true, options: [], alreadyIncluded: ['pest_control'], currentServiceKeys: [] }],
    ['the priced property resolves as a business', {
      ok: true, alreadyIncluded: [], currentServiceKeys: [], property: { propertyType: 'commercial' },
      options: [{ id: 'pest-quarterly', serviceKey: 'pest_control', label: 'Quarterly pest control', perVisit: 80, setupFee: 99, confidence: 'high' }],
    }],
  ])('%s: not priced', async (_label, answer) => {
    const spy = jest.spyOn(pricer, 'buildCustomerPricingResponse');
    try {
      spy.mockResolvedValueOnce(answer);
      expect(await start()).toEqual(refused('not_priced'));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  describe('an outage is thrown: a job must never read it as "this home cannot be priced"', () => {
    test('the lookup', async () => {
      await expect(start(noPlanDb(), { propertyLookup: async () => { throw new Error('lookup down'); } })).rejects.toThrow('lookup down');
    });

    test.each([
      ['not_loaded'], ['edited'], ['rows'],
    ])('the price settings (%s)', async (reason) => {
      ownSettings.mockImplementation(async () => ({ priced: false, reason }));
      await expect(start()).rejects.toMatchObject({ code: 'PRICING_CONFIG_UNAVAILABLE' });
    });

    test("the pricer's own read of the current services", async () => {
      const spy = jest.spyOn(pricer, 'buildCustomerPricingResponse');
      try {
        spy.mockResolvedValueOnce({ ok: false, code: 'PRICING_UNAVAILABLE' });
        await expect(start()).rejects.toMatchObject({ code: 'PRICING_UNAVAILABLE' });
      } finally {
        spy.mockRestore();
      }
    });
  });

  // The pricer's strict option prices pest control only: it reads no turf profile, and the standard pest price
  // is the one whose settings rows it proves. Lawn care and tree & shrub are ladder families for the cards, and
  // they are refused here before any read.
  test.each([['lawn_care'], ['tree_shrub'], ['mosquito'], [undefined]])('family %p is refused: the start offer prices the pest plan only', async (family) => {
    await expect(buildStartOffer('cust-1', noPlanDb(), family, { propertyLookup: savedLookup, visitId: VISIT.id })).rejects.toThrow('a start offer family');
  });

  test('a missing customer or database is a programming error', async () => {
    const options = { propertyLookup: savedLookup, visitId: VISIT.id };
    await expect(buildStartOffer(null, noPlanDb(), 'pest_control', options)).rejects.toThrow('buildStartOffer');
    await expect(buildStartOffer('cust-1', null, 'pest_control', options)).rejects.toThrow('buildStartOffer');
  });
});
