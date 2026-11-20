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
    // A table is a list of rows. It can also be a function of the filters one read used ([name, ...args] in call
    // order), for a test whose answer must depend on WHICH read asks (this fake applies no filter itself).
    const source = tables[table];
    const calls = [];
    const answer = () => (typeof source === 'function' ? source(calls) : source || []);
    const filter = (name) => (...args) => { calls.push([name, ...args]); return q; };
    const q = {
      where: filter('where'),
      whereNotIn: filter('whereNotIn'),
      orWhereNull: filter('orWhereNull'),
      whereNull: filter('whereNull'),
      leftJoin() { return q; },
      orderBy() { return q; },
      select() { return answer(); },
      limit() { return q; },
      first() { return answer()[0] || null; },
      whereNotNull: filter('whereNotNull'),
      // The annual-prepay coverage read (coveredTermsAsOf) filters with raw SQL; this fake answers by table.
      whereRaw: filter('whereRaw'),
      distinct() { return answer(); },
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

function dbFor({ customer = CUSTOMER(), serviceTypes = [], planRates = [], tables = {} } = {}) {
  const scheduled = recurringRows(serviceTypes);
  return dbForTables({
    customers: [customer],
    customer_properties: [],
    scheduled_services: scheduled,
    'scheduled_services as s': scheduled,
    customer_turf_profiles: [],
    estimates: [],
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
  test('pest+lawn recurring → the matrix target (tree & shrub) with a fingerprint', async () => {
    const db = dbFor({ serviceTypes: ['Quarterly Pest Control', 'Lawn Care Program'] });
    const offer = await buildPortalOffer('cust-1', db, { propertyLookup: missLookup });
    expect(offer).not.toBeNull();
    expect(offer.serviceKey).toBe('tree_shrub');
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

  test('a verified correction on file demotes to the quote CTA (no price on stale facts)', async () => {
    hasVerifiedOverrides.mockImplementation(async () => true);
    const db = dbFor({ serviceTypes: ['Quarterly Pest Control', 'Lawn Care Program'] });
    const offer = await buildPortalOffer('cust-1', db, { propertyLookup: missLookup });
    if (offer) {
      expect(offer.mode).toBe('quote_cta');
      expect(offer.option).toBeNull();
    }
  });

  test('a live plan-rate on the target family suppresses the offer entirely', async () => {
    const db = dbFor({
      serviceTypes: ['Quarterly Pest Control', 'Lawn Care Program'],
      planRates: [{ family_key: 'tree_shrub', monthly_rate: 40 }],
    });
    expect(await buildPortalOffer('cust-1', db, { propertyLookup: missLookup })).toBeNull();
  });
});

// buildOfferForFamily — the photo-triage lane's targeted variant (2026-09-25):
// the family is fixed by what the photo shows, every other gate is the
// portal card's.
describe('buildOfferForFamily', () => {
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

// buildStartOffer — the one-time job to plan offer's price (owner 2026-11-19):
// the same stages for a customer who owns NOTHING recurring, with the
// ownership answer reversed. The portal entry points keep their "owns
// nothing → no offer" answer (pinned above); this one is the only way to
// price a plan for that customer, so its refusals are pinned here.
describe('buildStartOffer', () => {
  const pricingEngine = require('../services/pricing-engine');
  // A saved lookup the real engine prices from (the report suite's own shape).
  const savedLookup = async () => ({ enriched: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} });
  // The visit the offer follows. Bare: no stamp and no link, so the single-premises proof decides.
  const VISIT = { id: 'visit-1' };
  const start = (db, options = {}) => buildStartOffer('cust-1', db, 'pest_control', { propertyLookup: savedLookup, visitId: VISIT.id, ...options });
  // The one-time customer the offer is for: no tier and no rate on the account (the suite's fixture is a member).
  const NO_PLAN = { waveguard_tier: null, monthly_rate: null };
  // The read of the visit the offer follows names its id. Every other read of the table gets `visits`: a list of
  // rows, or a function of the read's filters (this fake applies no filter itself).
  const isVisitRead = (calls) => calls.some(([name, filter]) => name === 'where' && filter && filter.id === VISIT.id);
  const noPlanDb = ({ customer = {}, serviceTypes = [], visits = recurringRows(serviceTypes), tables = {}, ...rest } = {}) => dbFor({
    ...rest,
    serviceTypes,
    customer: CUSTOMER({ ...NO_PLAN, ...customer }),
    tables: {
      scheduled_services: (calls) => (isVisitRead(calls) ? [VISIT] : (typeof visits === 'function' ? visits(calls) : visits)),
      ...tables,
    },
  });

  // The fake database holds no price settings, so the bridge's refresh would fail and the start offer would
  // refuse to price (strict price settings). Fresh settings are the default here; one describe below tests the rule.
  let needsSync;
  beforeEach(() => { needsSync = jest.spyOn(pricingEngine, 'needsSync').mockReturnValue(false); });
  afterEach(() => { needsSync.mockRestore(); });

  test('a customer with no plan gets the standard pest plan, priced by the real engine, with the setup fee a new plan carries', async () => {
    const { option, reason } = await start(noPlanDb());
    expect(reason).toBeNull();
    expect(option.id).toBe('pest-quarterly');
    expect(option.perVisit).toBeGreaterThan(0);
    // The fee the offer removes: a customer with no recurring service is priced as new.
    expect(option.setupFee).toBeGreaterThan(0);
    // The FULL quoted option (server-only), not the card payload that carries perVisit alone.
    expect(option.annual).toBeGreaterThan(0);
  });

  test('a home with no saved lookup is not priced (no price on profile facts alone)', async () => {
    expect(await start(noPlanDb(), { propertyLookup: missLookup })).toEqual({ option: null, reason: 'not_priced' });
  });

  test('an owned recurring service, or a billed plan rate with no visit on the calendar, means the customer has a plan', async () => {
    expect(await start(noPlanDb({ serviceTypes: ['Lawn Care Program'] }))).toEqual({ option: null, reason: 'has_plan' });
    expect(await start(noPlanDb({ planRates: [{ family_key: 'lawn_care', monthly_rate: 55 }] })))
      .toEqual({ option: null, reason: 'has_plan' });
  });

  // A plan has several records, and one alone is enough: a member can have no recurring visit on the calendar
  // and no named ledger component, and a plan can be a service the offer ladder has no family for. Without
  // these reads the offer would price a new plan, with a setup fee to remove, for a customer who already has one.
  const PREPAY_INVOICE = (status) => ({
    annual_prepay_terms: [{ id: 'term-1', prepay_invoice_id: 'inv-1' }], invoices: [{ id: 'inv-1', status }],
  });
  test.each([
    ['a tier on the account', { customer: { waveguard_tier: 'Gold' } }],
    ['a legacy monthly rate with no tier', { customer: { monthly_rate: 45 } }],
    ['a billed plan rate the ledger could not name', { planRates: [{ family_key: 'unattributed', monthly_rate: 45 }] }],
    ['a billed plan rate with no family at all', { planRates: [{ family_key: null, monthly_rate: 45 }] }],
    // Palm injection maps to no offer family, so the owned keys are empty. The live recurring row is the plan.
    ['a recurring visit that maps to no offer family', { serviceTypes: ['Palm Injection'] }],
    ['an annual prepay whose paid coverage is live', { tables: { 'annual_prepay_terms as t': [{ id: 'term-1' }] } }],
    ['an annual prepay invoice that is still payable', { tables: PREPAY_INVOICE('sent') }],
  ])('%s means the customer has a plan', async (_label, world) => {
    expect(await start(noPlanDb(world))).toEqual({ option: null, reason: 'has_plan' });
  });

  test.each([
    ['a tier value that names no plan', { customer: { waveguard_tier: 'One-Time' } }],
    ['a plan rate of zero', { planRates: [{ family_key: 'unattributed', monthly_rate: 0 }] }],
    ['an annual prepay invoice that was voided', { tables: PREPAY_INVOICE('void') }],
  ])('%s is not a plan: the home is priced', async (_label, world) => {
    expect(await start(noPlanDb(world))).toMatchObject({ reason: null, option: { id: 'pest-quarterly' } });
  });

  test("the pricer's own ownership answer (alreadyIncluded) also reads as a plan", async () => {
    const spy = jest.spyOn(require('../services/customer-pricing-ai'), 'buildCustomerPricingResponse');
    try {
      spy.mockResolvedValueOnce({ ok: true, options: [], alreadyIncluded: ['pest_control'], currentServiceKeys: ['pest_control'] });
      expect(await start(noPlanDb())).toEqual({ option: null, reason: 'has_plan' });
    } finally {
      spy.mockRestore();
    }
  });

  // The calendar read answers the rows that carry the recurring flag. Its row rule (isLiveObligationRow) decides
  // which of them is a live plan visit, here and in the pricer's own ownership read. The table below answers
  // ONLY the reads that ask for the flag, so these cases cannot pass on the legacy read.
  describe('a visit that carries the recurring flag', () => {
    const asksForRecurringFlag = (calls) => calls.some(([name, filter]) => name === 'where' && filter && filter.is_recurring === true);
    const FLAGGED = { id: 'svc-1', service_type: 'Quarterly Pest Control', is_recurring: true, status: 'scheduled', scheduled_date: FUTURE_SCHEDULED_DATE };
    const calendarDb = (row) => noPlanDb({ visits: (calls) => (asksForRecurringFlag(calls) ? [row] : []) });

    test('means the customer has a plan', async () => {
      expect(await start(calendarDb(FLAGGED))).toEqual({ option: null, reason: 'has_plan' });
    });

    // An included follow-up is the $0 second visit of a one-time job. It rides the job, never a plan, whatever
    // its recurring flag says: the same answer as for the legacy shape below.
    test.each([
      ['an included follow-up', { followup_included: true }],
      ['an included follow-up in progress now', { followup_included: true, status: 'on_site' }],
      ['a free re-service callback', { is_callback: true }],
      ['a visit booked from a one-time source', { source: 'estimate-accept' }],
    ])('%s is not a plan visit: the home is priced', async (_label, change) => {
      expect(await start(calendarDb({ ...FLAGGED, ...change }))).toMatchObject({ reason: null, option: { id: 'pest-quarterly' } });
    });
  });

  // A legacy plan visit carries no recurring flag (NULL) and a recurring parent. The calendar read asks for
  // is_recurring = true, so it never returns that row, and without a second read the offer would price a new
  // plan for a customer whose only live plan record is that visit. The table below answers ONLY the legacy read
  // (the one that asks for a NULL flag), as the database would, so these cases cannot pass on the calendar read.
  describe('a legacy plan visit (no recurring flag, a recurring parent)', () => {
    const PAST_DATE = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const LEGACY = { id: 'legacy-1', is_recurring: null, recurring_parent_id: 'root-1', status: 'confirmed', scheduled_date: FUTURE_SCHEDULED_DATE };
    const asksForNullFlag = (calls) => calls.some(([name, column]) => name === 'whereNull' && column === 'is_recurring');
    const legacyDb = (row) => noPlanDb({ visits: (calls) => (asksForNullFlag(calls) ? [row] : []) });

    test('means the customer has a plan', async () => {
      expect(await start(legacyDb(LEGACY))).toEqual({ option: null, reason: 'has_plan' });
    });

    test('a visit in progress now counts, also when its date is before today', async () => {
      expect(await start(legacyDb({ ...LEGACY, status: 'on_site', scheduled_date: PAST_DATE })))
        .toEqual({ option: null, reason: 'has_plan' });
    });

    test.each([
      ['a free re-service callback', { is_callback: true }],
      ['an included follow-up', { followup_included: true }],
      ['a visit dated before today', { scheduled_date: PAST_DATE }],
      ['a visit with no date', { scheduled_date: null }],
      // The calendar read's own exclusions (isLiveObligationRow): a visit booked as one-time is not a plan,
      // also while it is in progress.
      ['a visit booked from a one-time source', { source: 'estimate-accept' }],
      ['a one-time booking in progress now', { source: 'quote-wizard-onetime', status: 'on_site' }],
      ['a callback in progress now', { is_callback: true, status: 'en_route' }],
      // Rows the read does not ask for. The rule is applied to whatever the read returns.
      ['a row flagged not recurring (a booster)', { is_recurring: false }],
      ['a row with no recurring parent', { recurring_parent_id: null }],
    ])('%s is not a plan visit: the home is priced', async (_label, change) => {
      expect(await start(legacyDb({ ...LEGACY, ...change }))).toMatchObject({ reason: null, option: { id: 'pest-quarterly' } });
    });

    test('the read asks for the legacy shape among visits that are not over', async () => {
      const reads = [];
      const db = noPlanDb({ visits: (calls) => { reads.push(calls.map(([name, ...args]) => [name, ...args])); return []; } });
      await start(db);
      const legacyRead = reads.find(asksForNullFlag);
      expect(legacyRead).toEqual(expect.arrayContaining([
        ['where', { customer_id: 'cust-1' }],
        ['whereNull', 'is_recurring'],
        ['whereNotNull', 'recurring_parent_id'],
        ['whereNotIn', 'status', require('../services/waveguard-existing-services').TERMINAL_STATUSES],
      ]));
    });
  });

  // The start offer prices with nobody watching, so its default lookup asks for strict reads: a failed cache or
  // correction read is thrown (the default form serves the cached home without its corrections). The cards a
  // person looks at keep the default reads.
  describe('the lookup the start offer runs by default', () => {
    const { performPropertyLookup } = require('../routes/property-lookup-v2');
    const SAVED = { enriched: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} };
    afterEach(() => { performPropertyLookup.mockReset(); performPropertyLookup.mockImplementation(async () => null); });

    test('is cache-only, stores nothing and asks for strict reads', async () => {
      performPropertyLookup.mockResolvedValue(SAVED);
      expect(await buildStartOffer('cust-1', noPlanDb(), 'pest_control', { visitId: VISIT.id })).toMatchObject({ reason: null, option: { id: 'pest-quarterly' } });
      expect(performPropertyLookup).toHaveBeenCalled();
      for (const [, options] of performPropertyLookup.mock.calls) {
        expect(options).toEqual({ cacheOnly: true, persist: false, strictCacheReads: true });
      }
    });

    test('the portal card keeps the default reads', async () => {
      performPropertyLookup.mockResolvedValue(SAVED);
      await buildPortalOffer('cust-1', dbFor({ serviceTypes: ['Quarterly Pest Control', 'Lawn Care Program'] }));
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
  describe('the visit the offer follows must be at the home the price is for', () => {
    const scopeModule = require('../services/service-report/visit-property-scope');
    const linkage = require('../services/estimate-property-linkage');
    // The fixture customer's home, stamped on the visit as dispatch stamps it.
    const AT_HOME = { service_address_line1: '123 Gulf Dr', service_address_city: 'Sarasota', service_address_zip: '34236' };
    const visitDb = (visit) => dbForTables({
      customers: [CUSTOMER(NO_PLAN)], customer_properties: [], scheduled_services: visit ? [{ id: 'visit-1', ...visit }] : [],
      'scheduled_services as s': [], customer_turf_profiles: [], estimates: [], customer_plan_rates: [],
    });
    const follow = (db) => start(db);
    // The resolver's answer for a visit that carries a link (the fake database has no promise chain to resolve one).
    const withScope = async (answer, body) => {
      const spy = jest.spyOn(scopeModule, 'resolveVisitPropertyScope').mockImplementationOnce(answer);
      try { return await body(); } finally { spy.mockRestore(); }
    };

    test.each([
      ['a visit stamped at the primary home', AT_HOME],
      ['a visit with no stamp and no link (the single-premises proof stands)', {}],
    ])('%s is priced', async (_label, visit) => {
      expect(await follow(visitDb(visit))).toMatchObject({ reason: null, option: { id: 'pest-quarterly' } });
    });

    // The account-level proof skips another visit whose link cannot be resolved. For a job that carries no
    // proof of its own, that visit could be at a second home: the strict form of the proof decides.
    test('a visit with no stamp and no link is refused when another visit of the account has a link that cannot be resolved', async () => {
      const db = dbForTables({
        customers: [CUSTOMER(NO_PLAN)], customer_properties: [],
        scheduled_services: [{ id: 'visit-1' }, { id: 'visit-2', source_estimate_id: 'est-gone' }],
        'scheduled_services as s': [], customer_turf_profiles: [], estimates: [], customer_plan_rates: [],
      });
      const strict = jest.spyOn(scopeModule, 'customerHasOnlyPrimaryPremises');
      try {
        expect(await follow(db)).toEqual({ option: null, reason: 'premises' });
        expect(strict).toHaveBeenCalledWith(db, 'cust-1', expect.objectContaining({ id: 'cust-1' }), expect.anything(), { unresolvedFails: true });
      } finally {
        strict.mockRestore();
      }
    });

    test("a visit that is not this customer's is refused", async () => {
      expect(await follow(visitDb(null))).toEqual({ option: null, reason: 'premises' });
    });

    // Without the visit nothing proves which home the offer is about: the account-level proof skips a visit
    // whose link cannot be resolved. So the visit is required, and its absence is never a price.
    test.each([[undefined], [null], ['']])('a call with no visit (%p) is a programming error, never a price', async (visitId) => {
      await expect(start(noPlanDb(), { visitId })).rejects.toThrow('the visit the offer follows');
    });

    test.each([
      ['a link that cannot be resolved (an estimate with no address)', { key: null, hasEvidence: true }],
      ['a link that resolves to another home', { key: linkage.normalizedStampedStreet('9 Other St', null, 'Venice', '34285'), hasEvidence: true }],
    ])('%s is refused, never priced at the primary home', async (_label, scope) => {
      const answer = await withScope(async () => scope, () => follow(visitDb({ source_estimate_id: 'est-1' })));
      expect(answer).toEqual({ option: null, reason: 'premises' });
    });

    test('a failed read of the link throws: an outage is never read as "another home"', async () => {
      const failing = async (_row, _db, { onLookupFailure }) => { onLookupFailure(); return { key: null, hasEvidence: true }; };
      await expect(withScope(failing, () => follow(visitDb({ source_estimate_id: 'est-1' })))).rejects.toMatchObject({ code: 'PREMISES_LOOKUP_FAILED' });
    });
  });

  test('an inactive, multi-home or address-less account is refused on the premises proof', async () => {
    for (const customer of [{ active: false }, { has_multi_home: true }, { address_line1: null, city: null, zip: null }]) {
      expect(await start(noPlanDb({ customer }))).toEqual({ option: null, reason: 'premises' });
    }
  });

  test("another cadence is never priced under the standard plan's name (pickOption's fallback is refused)", async () => {
    const spy = jest.spyOn(require('../services/customer-pricing-ai'), 'buildCustomerPricingResponse');
    try {
      spy.mockResolvedValueOnce({
        ok: true, alreadyIncluded: [], currentServiceKeys: [], property: {},
        options: [{ id: 'pest-bimonthly', serviceKey: 'pest_control', label: 'Bi-monthly pest control', perVisit: 80, setupFee: 99, confidence: 'high' }],
      });
      expect(await start(noPlanDb())).toEqual({ option: null, reason: 'not_priced' });
    } finally {
      spy.mockRestore();
    }
  });

  test('an outage throws: a job must never read it as "this home cannot be priced"', async () => {
    const db = noPlanDb();
    await expect(start(db, { propertyLookup: async () => { throw new Error('lookup down'); } })).rejects.toThrow('lookup down');
    hasVerifiedOverrides.mockImplementation(async () => { throw new Error('probe down'); });
    await expect(start(db, { propertyLookup: missLookup })).rejects.toThrow('probe down');
    hasVerifiedOverrides.mockImplementation(async () => false);
    const spy = jest.spyOn(require('../services/customer-pricing-ai'), 'buildCustomerPricingResponse');
    try {
      spy.mockResolvedValueOnce({ ok: false, code: 'PRICING_UNAVAILABLE' });
      await expect(start(db)).rejects.toMatchObject({ code: 'PRICING_UNAVAILABLE' });
    } finally {
      spy.mockRestore();
    }
  });

  // The pest plan's price never reads the turf profile. The pricer's turf-profile read answers a FAILED read as
  // an empty profile, so a lawn price here could come from a fallback size with nobody watching. Lawn care and
  // tree & shrub are ladder families for the cards, and they are refused here.
  test.each([['lawn_care'], ['tree_shrub'], ['mosquito'], [undefined]])('family %p is refused: the start offer prices the pest plan only', async (family) => {
    await expect(buildStartOffer('cust-1', noPlanDb(), family, { propertyLookup: savedLookup, visitId: VISIT.id })).rejects.toThrow('a start offer family');
  });

  test('a missing customer or database is a programming error', async () => {
    const options = { propertyLookup: savedLookup, visitId: VISIT.id };
    await expect(buildStartOffer(null, noPlanDb(), 'pest_control', options)).rejects.toThrow('buildStartOffer');
    await expect(buildStartOffer('cust-1', null, 'pest_control', options)).rejects.toThrow('buildStartOffer');
  });

  // The bridge answers a failed refresh of the price settings with the values it had (the code defaults on a
  // cold start). The start offer prices with nobody watching, so a refresh that is due and fails is no price.
  // The rule is enforced at the pricer's own refresh step, right before the engine prices: the start offer asks
  // the pricer for strict price settings.
  describe('the live price settings', () => {
    const pricer = require('../services/customer-pricing-ai');
    let sync;
    beforeEach(() => { sync = jest.spyOn(pricingEngine, 'syncConstantsFromDB'); });
    afterEach(() => { sync.mockRestore(); });

    test('fresh settings are not loaded again', async () => {
      expect(await start(noPlanDb())).toMatchObject({ reason: null, option: { id: 'pest-quarterly' } });
      expect(sync).not.toHaveBeenCalled();
    });

    test('a refresh that is due and succeeds prices, from the database the caller passed', async () => {
      needsSync.mockReturnValue(true);
      sync.mockResolvedValue(true);
      const db = noPlanDb();
      expect(await start(db)).toMatchObject({ reason: null, option: { id: 'pest-quarterly' } });
      expect(sync).toHaveBeenCalledWith(db);
    });

    test.each([[false], [undefined]])('a refresh that is due and answers %p throws: never a price from the old values or the code defaults', async (answer) => {
      needsSync.mockReturnValue(true);
      sync.mockResolvedValue(answer);
      await expect(start(noPlanDb())).rejects.toMatchObject({ code: 'PRICING_CONFIG_UNAVAILABLE' });
    });

    // The settings can be fresh when the offer starts and come due while it reads (the interval ends, or an
    // admin edit invalidates them). A check made before the reads would pass; the pricer's own step must decide.
    test('settings that come due during the reads, with a refresh that fails, throw at the pricer', async () => {
      sync.mockResolvedValue(false);
      const lookupThenDue = async (address) => { needsSync.mockReturnValue(true); return savedLookup(address); };
      await expect(start(noPlanDb(), { propertyLookup: lookupThenDue })).rejects.toMatchObject({ code: 'PRICING_CONFIG_UNAVAILABLE' });
      expect(sync).toHaveBeenCalledTimes(1);
    });

    // A refresh that is running may still be rolled back while the settings read fresh: the start offer waits.
    test('a refresh already running when the engine would price is waited for; if it fails, there is no price', async () => {
      const running = jest.spyOn(require('../services/pricing-engine/db-bridge'), 'isSyncInFlight').mockReturnValue(true);
      try {
        sync.mockResolvedValue(true);
        expect(await start(noPlanDb())).toMatchObject({ reason: null, option: { id: 'pest-quarterly' } });
        expect(sync).toHaveBeenCalledTimes(1);
        sync.mockResolvedValue(false);
        await expect(start(noPlanDb())).rejects.toMatchObject({ code: 'PRICING_CONFIG_UNAVAILABLE' });
      } finally {
        running.mockRestore();
      }
    });

    test('a customer who is refused before the price costs no refresh', async () => {
      needsSync.mockReturnValue(true);
      sync.mockResolvedValue(false);
      expect(await start(noPlanDb({ serviceTypes: ['Lawn Care Program'] }))).toEqual({ option: null, reason: 'has_plan' });
      expect(sync).not.toHaveBeenCalled();
    });

    // Only the start offer asks. The cards a person reads keep the best-effort refresh: a failed refresh still
    // prices from the values the engine had, as before.
    test('the start offer asks the pricer for strict price settings; the portal card does not, and still prices', async () => {
      const spy = jest.spyOn(pricer, 'buildCustomerPricingResponse');
      try {
        await start(noPlanDb());
        expect(spy.mock.calls[0][0]).toMatchObject({ strictPriceSettings: true });
        spy.mockClear();
        needsSync.mockReturnValue(true);
        sync.mockResolvedValue(false);
        const card = await buildPortalOffer('cust-1', dbFor({ serviceTypes: ['Quarterly Pest Control'] }), { propertyLookup: savedLookup });
        expect(spy).toHaveBeenCalled();
        for (const [args] of spy.mock.calls) expect(args).not.toHaveProperty('strictPriceSettings');
        // The refresh was tried, failed, and the card was still built.
        expect(sync).toHaveBeenCalled();
        expect(['priced', 'quote_cta']).toContain(card.mode);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // With GATE_PLAN_RATE_LEDGER off the ledger answers a failed table probe as "no ledger". A billed rate is
  // evidence of a plan in either mode, so this caller asks for the failure itself.
  test('a failed probe of the plan-rate ledger throws, also while the ledger gate is off', async () => {
    const db = noPlanDb();
    const hasTable = db.schema.hasTable;
    db.schema.hasTable = async (name) => {
      if (name === 'customer_plan_rates') throw Object.assign(new Error('metadata query timeout'), { code: '57014' });
      return hasTable(name);
    };
    expect(require('../config/feature-gates').isEnabled('planRateLedger')).toBe(false);
    await expect(start(db)).rejects.toThrow('metadata query timeout');
  });
});
