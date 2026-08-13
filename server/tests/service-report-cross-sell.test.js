// The builder lazily probes this on a cache MISS to tell an ordinary miss
// from one caused by a verified override that postdates the cached data.
// Nothing else in this suite loads the cache module (the property lookup is
// injected), so a single-export stub is enough.
jest.mock('../services/property-lookup/lookup-cache', () => ({
  hasVerifiedOverrides: jest.fn(async () => false),
}));

const { buildReportCrossSell, _private } = require('../services/service-report/cross-sell');
const { hasVerifiedOverrides } = require('../services/property-lookup/lookup-cache');

// Recurring rows must be UPCOMING to count as live obligations (the ownership
// loader applies the lifecycle evidence unconditionally) — compute the date so
// the suite never ages out.
const FUTURE_SCHEDULED_DATE = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);

function dbForTables(tables = {}, { failCatalogJoin = false } = {}) {
  const dbFn = (table) => {
    if (failCatalogJoin && table === 'scheduled_services as s') {
      const boom = () => { throw new Error('join failed'); };
      return { leftJoin: boom, where: boom, select: boom };
    }
    const rows = tables[table] || [];
    // where() is a no-op for most tables on purpose — fixtures omit
    // customer_id, and honoring it globally would filter every row out.
    // customer_properties is the exception: whether a query restricts to
    // active rows is load-bearing there (a deactivated secondary property
    // is exactly what a permanent historical report token can belong to),
    // and a fake that ignores the filter cannot tell the two queries apart.
    const filtered = [];
    const applyFilter = (criteria) => {
      if (table !== 'customer_properties' || !criteria || typeof criteria !== 'object') return;
      filtered.push(criteria);
    };
    const visible = () => rows.filter((row) => filtered.every(
      (criteria) => Object.entries(criteria).every(([key, value]) => (
        key === 'customer_id' ? true : row[key] === value
      ))
    ));
    const q = {
      where(criteria) { applyFilter(criteria); return q; },
      whereNotIn() { return q; },
      orWhereNull() { return q; },
      leftJoin() { return q; },
      orderBy() { return q; },
      select() { return visible(); },
      limit() { return q; },
      first(col) {
        void col;
        return visible()[0] || null;
      },
      whereNotNull() { return q; },
      distinct() { return visible(); },
      columnInfo() {
        // Mirror the live scheduled_services shape: the stamped service
        // address columns are what the ownership loader scopes on and what
        // the single-premises proof reads, so a fake without them silently
        // skips both.
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
  // plan-rate-ledger's loadComponents probes schema.hasTable before reading.
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

const SERVICE = (overrides = {}) => ({
  id: 'sr-1',
  customer_id: 'cust-1',
  address_line1: '123 Gulf Dr',
  city: 'Sarasota',
  zip: '34236',
  // Recent by default: the report-identity guard only corroborates within
  // one recurrence window (PR r9) — fixtures model the fresh-report case
  // unless a test overrides the date.
  service_date: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString().slice(0, 10),
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

function dbFor({ customer = CUSTOMER(), serviceTypes = [], turfProfile = null, estimates = [], planRates = [], catalogRows = [], stampRows = [], properties = [], failCatalogJoin = false } = {}) {
  const scheduled = recurringRows(serviceTypes);
  return dbForTables({
    customers: [customer],
    customer_properties: properties,
    // stampRows go FIRST so the builder's raw-stamp first() read sees them
    // (the fake's first() returns rows[0]); completed stamp rows carry no
    // upcoming lifecycle so the ownership loader ignores them.
    scheduled_services: [...stampRows, ...scheduled],
    // Catalog join returns the same rows: service_key/service_name stay
    // undefined, so classification falls to service_type text — the plain-row
    // legacy path the classifier documents. catalogRows adds rows visible to
    // the catalog join only (e.g. the report's completed visit).
    'scheduled_services as s': [...scheduled, ...catalogRows],
    customer_turf_profiles: turfProfile ? [turfProfile] : [],
    estimates,
    customer_plan_rates: planRates,
  }, { failCatalogJoin });
}

// Cache-only lookup default: a miss (null) prices from the profile alone.
const missLookup = async () => null;

describe('offer target matrix (owner ruling 2026-08-13, one test per approved cell)', () => {
  const { pickOfferTarget, startFamilyForIdentity, OFFER_LADDER } = _private;

  test('offer vocabulary is unchanged', () => {
    expect(OFFER_LADDER).toEqual(['pest_control', 'lawn_care', 'tree_shrub', 'termite']);
  });

  // Every ownership combination of {pest, lawn, T&S, termite}, exactly as
  // approved. The empty row is absent on purpose — no recurring evidence
  // routes to the identity-start branch, pinned in the next describe.
  const P = 'pest_control'; const L = 'lawn_care'; const T = 'tree_shrub'; const X = 'termite';
  test.each([
    [[P], L, 'pest only → lawn'],
    [[L], P, 'lawn only → pest'],
    [[T], L, 'T&S only → lawn (08-13: T&S-without-lawn beats the pest rung)'],
    [[X], P, 'termite only → pest'],
    [[P, L], T, 'pest+lawn → T&S'],
    [[P, T], L, 'pest+T&S → lawn (pest→lawn and T&S→lawn agree)'],
    [[P, X], L, 'pest+termite → lawn'],
    [[L, T], P, 'lawn+T&S → pest (lawn owned, so the T&S rule is inert)'],
    [[L, X], P, 'lawn+termite → pest'],
    [[T, X], L, 'T&S+termite → lawn (approved: the T&S rule beats termite→pest)'],
    [[P, L, T], X, 'pest+lawn+T&S → termite (08-11 ruling, kept)'],
    [[P, L, X], T, 'pest+lawn+termite → T&S'],
    [[P, T, X], L, 'pest+T&S+termite → lawn'],
    [[L, T, X], P, 'lawn+T&S+termite → pest'],
    [[P, L, T, X], null, 'everything → NO card (the referral card fills the slot)'],
  ])('%j → %s (%s)', (owned, expected) => {
    expect(pickOfferTarget(owned)).toBe(expected);
  });

  test('ownership vocabulary termite_bait maps onto the termite cell', () => {
    expect(pickOfferTarget(['pest_control', 'lawn_care', 'tree_shrub', 'termite_bait'])).toBe(null);
    expect(pickOfferTarget(['termite_bait'])).toBe('pest_control');
  });

  test('mosquito and rodent evidence never move the target', () => {
    // Alone: a plan exists but not the anchor — offer pest.
    expect(pickOfferTarget(['mosquito'])).toBe('pest_control');
    expect(pickOfferTarget(['rodent_bait'])).toBe('pest_control');
    // Added to any row: the row's answer is unchanged.
    expect(pickOfferTarget(['pest_control', 'mosquito'])).toBe('lawn_care');
    expect(pickOfferTarget(['tree_shrub', 'termite', 'mosquito'])).toBe('lawn_care');
    expect(pickOfferTarget(['pest_control', 'lawn_care', 'tree_shrub', 'termite', 'mosquito'])).toBe(null);
  });
});

describe('identity-start rules (owner matrix 2026-08-13: nothing recurring → start the report\'s own family)', () => {
  const { startFamilyForIdentity } = _private;

  test.each([
    [{ service_type: 'One-Time Pest Control Service' }, 'pest_control', 'one-time pest → start pest'],
    [{ service_type: 'German Roach Cleanout' }, 'pest_control', 'roach specialty → start pest'],
    [{ service_type: 'Flea Treatment' }, 'pest_control', 'flea → start pest'],
    [{ service_type: 'Bed Bug Treatment' }, 'pest_control', 'bed bug → start pest'],
    [{ service_type: 'One-Time Lawn Care Visit' }, 'lawn_care', 'one-time lawn → start lawn'],
    [{ service_key: 'lawn_one_time', service_name: 'One-Time Turf Application' }, 'lawn_care', 'turf wording → start lawn'],
    [{ service_type: 'Rodent Trapping' }, 'pest_control', 'rodent anything → start pest'],
    [{ service_type: 'Termite Inspection' }, 'pest_control', 'termite anything → start pest'],
    [{ service_type: 'WDO Inspection' }, 'pest_control', 'WDO → start pest'],
    [{ service_type: 'One-Time Mosquito Treatment' }, 'pest_control', 'one-time mosquito → start pest (approved rec)'],
    [{ service_type: 'Tree & Shrub Treatment' }, 'tree_shrub', 'one-time T&S → start recurring T&S (approved rec)'],
    [{ service_key: 'palm_injection', service_name: 'Palm Tree Injections' }, 'pest_control', 'palm vetoes the tree token — assessment-first, never offered, falls to the anchor'],
    [{ service_type: 'Palm Treatment' }, 'pest_control', 'palm wording alone → pest'],
    [{ service_type: 'Trees & Shrubs Treatment' }, 'tree_shrub', 'plural T&S wording (codex r1 P2)'],
    [{ service_name: 'Ornamentals Care' }, 'tree_shrub', 'plural ornamentals'],
    [{ service_type: 'Palm Trees Injection' }, 'pest_control', 'plural palm trees still vetoes the tree match'],
    [{ service_name: 'Ornamental Care Visit' }, 'tree_shrub', 'ornamental wording is T&S'],
    [{ service_type: 'Lawn, Tree & Shrub Package' }, 'tree_shrub', 'combined wording → the more specific family'],
    [{ service_type: 'Mystery Legacy Row' }, 'pest_control', 'unknown identity → pest, the anchor'],
    [{}, 'pest_control', 'no identity at all → pest'],
  ])('%j → %s (%s)', (identity, expected) => {
    expect(startFamilyForIdentity(identity)).toBe(expected);
  });
});

describe('buildReportCrossSell', () => {
  test('pest-only customer is offered lawn care, priced from the turf profile', async () => {
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('lawn_care');
    expect(result.mode).toBe('priced');
    expect(result.option.perVisit).toBeGreaterThan(0);
    expect(result.option.cadence).toMatch(/applications/);
    // Plan owner → "add to your plan" copy stance, decided server-side.
    expect(result.relationship).toBe('add');
    // The modeled current-service inventory must never ride the public
    // bearer-token payload (codex #3367 PR r2).
    expect(result.currentServices).toBeUndefined();
  });

  describe('engineContext is opt-in mint material, never public payload (click-to-estimate lane)', () => {
    const args = () => ({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });

    test('the default (read-path) call NEVER carries engineContext', async () => {
      const result = await buildReportCrossSell(SERVICE(), dbFor(args()), { propertyLookup: missLookup });
      expect(result.mode).toBe('priced');
      expect(result.engineContext).toBeUndefined();
    });

    test('opting in attaches the exact engine context of the picked option, and the fingerprint is unchanged', async () => {
      const bare = await buildReportCrossSell(SERVICE(), dbFor(args()), { propertyLookup: missLookup });
      const withContext = await buildReportCrossSell(SERVICE(), dbFor(args()), {
        propertyLookup: missLookup, includeEngineContext: true,
      });
      expect(withContext.engineContext).toBeTruthy();
      expect(withContext.engineContext.propertyInput).toBeTruthy();
      expect(withContext.engineContext.targetOnlyServices).toBeTruthy();
      expect(Array.isArray(withContext.engineContext.currentServiceKeys)).toBe(true);
      expect(withContext.engineContext.customer?.id).toBe('cust-1');
      // Which proof admitted the report rides to the mint (GitHub #3391
      // round P1): a single-premises-admitted report must re-prove under
      // the mint lock, a linkage-proven one must not.
      expect(['report_linkage', 'single_premises']).toContain(withContext.engineContext.premisesProof);
      // The context must not perturb the drift check: read path and click
      // path fingerprint the SAME public payload, or every valid tap 409s.
      expect(withContext.fingerprint).toBe(bare.fingerprint);
    });

    test('a quote-mode offer carries no engine context even when asked — there is nothing to mint', async () => {
      hasVerifiedOverrides.mockResolvedValueOnce(true);
      const demoted = await buildReportCrossSell(SERVICE(), dbFor(args()), {
        propertyLookup: missLookup, includeEngineContext: true,
      });
      expect(demoted.mode).toBe('quote_cta');
      expect(demoted.engineContext).toBeUndefined();
    });
  });

  describe('a verified correction on file never prices through the seed (PR r12 P1)', () => {
    // On a cache miss the price falls back to the accepted-estimate seed,
    // but a technician's correction supersedes that estimate too (the seed
    // is older still) — pricing through it publishes an exact price on a
    // fact staff already fixed.
    const args = () => ({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });

    test('a correction demotes the offer to the unpriced CTA', async () => {
      hasVerifiedOverrides.mockResolvedValueOnce(true);
      const demoted = await buildReportCrossSell(SERVICE(), dbFor(args()), { propertyLookup: missLookup });
      expect(demoted).not.toBeNull();
      expect(demoted.serviceKey).toBe('lawn_care');
      expect(demoted.mode).toBe('quote_cta');
      expect(demoted.option).toBeNull();
    });

    test('an unreadable probe FAILS CLOSED — it is not evidence of no corrections', async () => {
      hasVerifiedOverrides.mockRejectedValueOnce(new Error('property_lookups unreadable'));
      const demoted = await buildReportCrossSell(SERVICE(), dbFor(args()), { propertyLookup: missLookup });
      expect(demoted).not.toBeNull();
      expect(demoted.mode).toBe('quote_cta');
      expect(demoted.option).toBeNull();
    });

    test('a REJECTED lookup still runs the probe and demotes (pre-push P0)', async () => {
      // The pricer catches a lookup rejection and prices from the seed
      // anyway. Hooking the probe to a cache MISS meant a throw skipped it
      // entirely — the same bypass CUSTOMER_PRICING_AI_LOOKUP=false opens,
      // where the wrapper is never invoked at all. The probe is independent
      // of the lookup now, keyed on "no lookup result".
      hasVerifiedOverrides.mockResolvedValueOnce(true);
      const boomLookup = async () => { throw new Error('lookup exploded'); };
      const demoted = await buildReportCrossSell(SERVICE(), dbFor(args()), { propertyLookup: boomLookup });
      expect(demoted).not.toBeNull();
      expect(demoted.mode).toBe('quote_cta');
      expect(demoted.option).toBeNull();
    });

    test('a lookup the RESOLVER rejects still runs the probe (pre-push P0)', async () => {
      // A global address/'all' flag makes the resolver adopt nothing from
      // the payload — and apply none of its verified overrides — so pricing
      // falls back to stored fields and the seed exactly as on a miss.
      // Treating the truthy response as "corrections applied" skipped the
      // probe and published an exact price on data staff had fixed.
      hasVerifiedOverrides.mockResolvedValueOnce(true);
      const wrongPremisesLookup = async () => ({
        enriched: {
          homeSqFt: 2400, lotSqFt: 8000, stories: 1,
          fieldVerifyFlags: [{ field: 'address', priority: 'high' }],
        },
        propertyRecord: {},
      });
      const demoted = await buildReportCrossSell(SERVICE(), dbFor(args()), { propertyLookup: wrongPremisesLookup });
      expect(demoted).not.toBeNull();
      expect(demoted.mode).toBe('quote_cta');
      expect(demoted.option).toBeNull();
    });

    test('no corrections on file still prices', async () => {
      const priced = await buildReportCrossSell(SERVICE(), dbFor(args()), { propertyLookup: missLookup });
      expect(priced.mode).toBe('priced');
      expect(priced.option.perVisit).toBeGreaterThan(0);
    });
  });

  test('a seed whose own estimate required field verification never prices (PR r13 P1)', async () => {
    // An accepted estimate sent despite fallback or low-confidence property
    // evidence was a number a human agreed to CHECK. Replaying its
    // dimensions into a DIFFERENT service's price would grade that price
    // high-confidence on inputs the original estimator never qualified.
    const args = (extra) => ({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-seed',
        address: '123 Gulf Dr, Sarasota, FL 34236',
        status: 'accepted',
        estimate_data: { engineInputs: { homeSqFt: 2100, lotSqFt: 8000, stories: 1 }, ...extra },
      }],
    });

    const clean = await buildReportCrossSell(SERVICE(), dbFor(args({})), { propertyLookup: missLookup });
    expect(clean.mode).toBe('priced');
    // A CLEAN line item must not be mistaken for a marker.
    const cleanLines = await buildReportCrossSell(
      SERVICE(),
      dbFor(args({ result: { fieldVerify: [], lineItems: [{ service: 'tree_shrub', pricingConfidence: 'high' }] } })),
      { propertyLookup: missLookup },
    );
    expect(cleanLines.mode).toBe('priced');

    // Each marker shape the stored blob has carried demotes.
    for (const marker of [
      { fieldVerify: ['lotSize'] },
      { result: { fieldVerify: ['squareFootage'] } },
      { estimate: { fieldVerifyFlags: [{ field: 'lotSize' }] } },
      { result: { requiresManualReview: true } },
      { result: { pricingConfidence: 'low' } },
      // Per-service markers live on the LINE ITEMS — a normal engine-backed
      // estimate records its review posture there, under an empty
      // top-level fieldVerify (PR r14 P1).
      { result: { fieldVerify: [], lineItems: [{ service: 'tree_shrub', pricingConfidence: 'low' }] } },
      { engineResult: { lineItems: [{ service: 'lawn', turfConfidence: 'LOW' }] } },
      { result: { lineItems: [{ service: 'pest', requiresManualReview: true }] } },
      { result: { lineItems: [{ service: 'pest', customQuoteFlag: true }] } },
    ]) {
      const flagged = await buildReportCrossSell(SERVICE(), dbFor(args(marker)), { propertyLookup: missLookup });
      expect(flagged).not.toBeNull();
      expect(flagged.mode).toBe('quote_cta');
      expect(flagged.option).toBeNull();
    }
  });

  test('the seed replays the top-level attachedGarage input (PR r15 P1)', async () => {
    // attachedGarage is a top-level estimator input, not a features member,
    // so copying inputs.features alone dropped it — while pest pricing adds
    // a real garage adjustment and the customers table has no column to
    // fall back on. A lawn-derived seed for an attached-garage property
    // would price-lock a Pest Control amount BELOW the true one.
    // Asserted on the seed itself: what it carries out of the accepted
    // estimate is the money-bearing contract, and the pricer already honors
    // features.attachedGarage (hasAttachedGarageForPest).
    const { loadEstimateSeed } = _private;
    const seedDb = (inputs) => dbFor({
      estimates: [{
        id: 'est-garage',
        address: '123 Gulf Dr, Sarasota, FL 34236',
        status: 'accepted',
        estimate_data: { engineInputs: { homeSqFt: 2100, lotSqFt: 8000, stories: 1, ...inputs } },
      }],
    });
    // Derived through the same normalizer the loader uses — a hand-written
    // key would be testing address parsing, not the seed's serialization.
    const street = require('../services/estimate-property-linkage')
      .normalizedEstimateStreet('123 Gulf Dr, Sarasota, FL 34236');

    const withGarage = await loadEstimateSeed(seedDb({ attachedGarage: true }), 'cust-1', street);
    expect(withGarage.features.attachedGarage).toBe(true);

    const withoutGarage = await loadEstimateSeed(seedDb({ attachedGarage: false }), 'cust-1', street);
    expect(withoutGarage.features.attachedGarage).toBe(false);

    // Absent input stays absent — never invented as false-y evidence.
    const silent = await loadEstimateSeed(seedDb({}), 'cust-1', street);
    expect(silent.features === null || silent.features.attachedGarage === undefined).toBe(true);

    // A features member of the same name still round-trips.
    const nested = await loadEstimateSeed(
      seedDb({ features: { attachedGarage: true, pool: true } }), 'cust-1', street,
    );
    expect(nested.features.attachedGarage).toBe(true);
    expect(nested.features.pool).toBe(true);

    // Water adjacency has the same split with a twist (PR r18 P1): the V2
    // adapter persists the real enum at inputs.nearWater while writing
    // features.nearWater FALSE, because it only compares the enum to 'YES'.
    for (const value of ['CANAL_ADJACENT', 'POND_ON_PROPERTY', 'LAKE_ADJACENT']) {
      const water = await loadEstimateSeed(
        seedDb({ nearWater: value, features: { nearWater: false } }), 'cust-1', street,
      );
      expect(water.features.nearWater).toBe(true);
    }
    // Every NEGATIVE spelling the engine recognizes must stay negative
    // (pre-push P0): V2 inputs routinely carry 'NO', and reading that as
    // adjacency would ADD the water adjustment and inflate a price-locked
    // offer. Normalized through the engine's own hasPresenceValue.
    for (const value of ['NO', 'NONE', 'FALSE', 'N', '0', 'UNKNOWN', '', false, 0]) {
      const dry = await loadEstimateSeed(
        seedDb({ nearWater: value, features: { nearWater: false } }), 'cust-1', street,
      );
      expect(dry.features.nearWater).toBe(false);
    }
  });

  test('an uncorroborated NON-ladder report identity never claims a current plan (PR r13 P2)', async () => {
    // Mosquito occupies no ladder rung, so it was exempt from
    // corroboration — but it still landed in the evidence list, and a
    // non-empty list is what selects "add to your plan". A former customer
    // with nothing active was told to add to a plan they do not have.
    const db = dbFor({
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    const result = await buildReportCrossSell(SERVICE({ service_type: 'Mosquito Control' }), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.relationship).toBe('start');
  });

  describe('qualifyingBaselineMismatch (PR r19 P1)', () => {
    // The pricer reloads ownership through its own membership-gated,
    // default-scoped query, so it can disagree with the strictly scoped
    // evidence in BOTH directions — and each moves money the wrong way.
    // Unit-tested directly: the suite's db fake cannot produce a divergence
    // between the two loaders (they read the same fixture rows), so an
    // end-to-end fixture here would assert nothing.
    const { qualifyingBaselineMismatch } = _private;

    test('an exact match is neither incomplete nor unexpected', () => {
      expect(qualifyingBaselineMismatch(['pest_control'], ['pest_control']))
        .toEqual({ incomplete: false, unexpected: false });
    });

    test('a family evidenced but NOT modeled is incomplete (priced standalone, too high)', () => {
      expect(qualifyingBaselineMismatch(['pest_control', 'lawn_care'], ['pest_control']))
        .toEqual({ incomplete: true, unexpected: false });
    });

    test('a family modeled but NOT evidenced is unexpected (unearned tier discount, too low)', () => {
      expect(qualifyingBaselineMismatch(['pest_control'], ['pest_control', 'lawn_care']))
        .toEqual({ incomplete: false, unexpected: true });
    });

    test('non-qualifying families are ignored on both sides', () => {
      // Ownership is broader than qualification: rodent monitoring never
      // moves the tier, so it cannot make the baselines disagree.
      expect(qualifyingBaselineMismatch(['pest_control', 'rodent'], ['pest_control']))
        .toEqual({ incomplete: false, unexpected: false });
      expect(qualifyingBaselineMismatch(['pest_control'], ['pest_control', 'rodent']))
        .toEqual({ incomplete: false, unexpected: false });
    });

    test('the termite vocabularies are reconciled before comparing', () => {
      // Ownership spells it termite_bait; the pricer spells it termite.
      expect(qualifyingBaselineMismatch(['termite_bait'], ['termite']))
        .toEqual({ incomplete: false, unexpected: false });
    });

    test('empty on both sides is a match; duplicates do not create a mismatch', () => {
      expect(qualifyingBaselineMismatch([], [])).toEqual({ incomplete: false, unexpected: false });
      expect(qualifyingBaselineMismatch(['pest_control'], ['pest_control', 'pest_control']))
        .toEqual({ incomplete: false, unexpected: false });
    });
  });

  test('the offer fingerprint covers every rendered field', () => {
    const { offerFingerprint } = _private;
    const base = {
      serviceKey: 'lawn_care', label: 'Lawn Care', mode: 'priced', relationship: 'add',
      option: { id: 'lawn-basic', label: 'Lawn Care', cadence: '9 applications', perVisit: 74.5, waveguardTier: 'silver', confidence: 'high' },
    };
    expect(offerFingerprint(base)).toBe(offerFingerprint({ ...base }));
    // Every visible field moves the digest — including the ones the old
    // field-by-field check ignored (pre-push P1).
    expect(offerFingerprint({ ...base, relationship: 'start' })).not.toBe(offerFingerprint(base));
    expect(offerFingerprint({ ...base, label: 'Lawn Program' })).not.toBe(offerFingerprint(base));
    expect(offerFingerprint({ ...base, option: { ...base.option, cadence: '6 applications' } })).not.toBe(offerFingerprint(base));
    expect(offerFingerprint({ ...base, option: { ...base.option, waveguardTier: 'gold' } })).not.toBe(offerFingerprint(base));
    expect(offerFingerprint({ ...base, option: { ...base.option, perVisit: 74.51 } })).not.toBe(offerFingerprint(base));
  });

  test('customer with no recurring ownership at all gets the start-relationship copy stance', async () => {
    // One-time-treatment customer: no upcoming recurring rows, a report
    // identity that resolves no ownership family, no plan-rate rows. There
    // is no plan to "add" to — the server marks the offer as a start.
    const db = dbFor({ serviceTypes: [] });
    const result = await buildReportCrossSell(
      SERVICE({ service_type: 'German Cockroach Cleanout' }),
      db,
      { propertyLookup: missLookup },
    );
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.relationship).toBe('start');
  });

  test('lawn-only customer is offered pest control; no cached footprint demotes to quote CTA', async () => {
    const db = dbFor({ serviceTypes: ['Lawn Care'] });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    // Home square footage only comes from the lookup; a cache miss must ask,
    // never guess — the card degrades to the unpriced CTA.
    expect(result.mode).toBe('quote_cta');
    expect(result.option).toBeNull();
  });

  test('lawn-only customer with a cached lookup gets a priced pest offer', async () => {
    // A lawn customer carries a measured turf profile; without one the
    // modeled current-lawn baseline raises an estimate-level turf verify
    // flag, and any estimate-level flag demotes the offer to the CTA (the
    // card never shows a price the portal pricing panel would flag).
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    // Stories ride along like a real cached county/vision read would — a
    // DEFAULTED story count is itself a manual-review reason
    // (stories_estimated) and correctly demotes the offer to the CTA.
    const lookup = async () => ({ enriched: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: lookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.mode).toBe('priced');
    expect(result.option.perVisit).toBeGreaterThan(0);
  });

  test('pest + lawn customer is offered tree & shrub', async () => {
    const db = dbFor({
      customer: CUSTOMER({ bed_sqft: 1200 }),
      serviceTypes: ['Pest Control', 'Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500 },
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('tree_shrub');
  });

  test('pest + lawn + tree & shrub customer is offered termite (owner ruling: not mosquito)', async () => {
    const db = dbFor({ serviceTypes: ['Pest Control', 'Lawn Care', 'Tree & Shrub Care'] });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('termite');
  });

  test('customer owning the whole ladder gets no card (referral only)', async () => {
    const db = dbFor({ serviceTypes: ['Pest Control', 'Lawn Care', 'Tree & Shrub Care', 'Termite Bait Monitoring'] });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('one-time-only customer (no recurring rows) is offered a pest plan', async () => {
    const db = dbFor({ serviceTypes: [] });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.relationship).toBe('start');
  });

  test('one-time LAWN report with no recurring rows starts recurring lawn, not pest (owner matrix 2026-08-13)', async () => {
    // End-to-end proof the identity-start branch reads the report's own
    // identity: same empty ownership as the test above, different report
    // wording, different offer.
    const db = dbFor({ serviceTypes: [] });
    const result = await buildReportCrossSell(
      SERVICE({ service_type: 'One-Time Lawn Care Visit' }),
      db,
      { propertyLookup: missLookup },
    );
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('lawn_care');
    expect(result.relationship).toBe('start');
  });

  test('rodent report with no recurring rows starts recurring pest (owner matrix 2026-08-13)', async () => {
    const db = dbFor({ serviceTypes: [] });
    const result = await buildReportCrossSell(
      SERVICE({ service_type: 'Rodent Trapping' }),
      db,
      { propertyLookup: missLookup },
    );
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.relationship).toBe('start');
  });

  test('FAIL CLOSED: a broken ownership catalog join suppresses the card entirely', async () => {
    const db = dbFor({ serviceTypes: ['Pest Control'], failCatalogJoin: true });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('commercial property gets no card', async () => {
    const db = dbFor({
      customer: CUSTOMER({ property_type: 'Commercial' }),
      serviceTypes: ['Pest Control'],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('commercial classification from a trusted cached lookup suppresses the card even with a blank stored type', async () => {
    const db = dbFor({
      customer: CUSTOMER({ property_type: null }),
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    const lookup = async () => ({ enriched: { propertyType: 'Commercial', homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: lookup });
    expect(result).toBeNull();
  });

  test('multifamily property gets no card (≥5-unit ruling rides normalizePropertyType)', async () => {
    const db = dbFor({
      customer: CUSTOMER({ property_type: 'multifamily' }),
      serviceTypes: ['Pest Control'],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('a line1-only raw stamp (no stamped city or zip) suppresses the card — locality unprovable', async () => {
    // The route COALESCEs stamped city/zip to the customer mirror, which
    // makes a line1-only stamp masquerade as the primary locality; the raw
    // stamp is the truth and an unlocalized one cannot rule out a
    // same-street property in another city.
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      stampRows: [{ id: 'stamp-1', status: 'completed', service_address_line1: '123 Gulf Dr' }],
    });
    const result = await buildReportCrossSell(SERVICE({ scheduled_service_id: 'stamp-1' }), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('a fully-localized raw stamp at the primary property keeps the card', async () => {
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      stampRows: [{
        id: 'stamp-1', status: 'completed',
        service_address_line1: '123 Gulf Dr', service_address_city: 'Sarasota', service_address_zip: '34236',
      }],
    });
    const result = await buildReportCrossSell(SERVICE({ scheduled_service_id: 'stamp-1' }), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('lawn_care');
  });

  test('a raw stamp on the same street in a DIFFERENT city suppresses the card', async () => {
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      stampRows: [{
        id: 'stamp-1', status: 'completed',
        service_address_line1: '123 Gulf Dr', service_address_city: 'Venice', service_address_zip: '34285',
      }],
    });
    const result = await buildReportCrossSell(SERVICE({ scheduled_service_id: 'stamp-1' }), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('disjoint locality evidence (city-only primary vs zip-only stamp) suppresses the card', async () => {
    // Neither key lacks locality, but they carry it in different fields —
    // sameScopeKey's per-field wildcard would accept the match across
    // cities; property equality needs one SHARED locality proof.
    const db = dbFor({
      customer: CUSTOMER({ zip: null }),
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      stampRows: [{
        id: 'stamp-1', status: 'completed',
        service_address_line1: '123 Gulf Dr', service_address_zip: '34236',
      }],
    });
    const result = await buildReportCrossSell(SERVICE({ scheduled_service_id: 'stamp-1' }), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('a one-time visit under a recurring catalog identity owns nothing — the ladder still offers that family', async () => {
    // estimate-accept one-time pest visit with a General Pest Control
    // catalog row: without the one-time gate the report identity claims
    // pest and the ladder would advance to lawn care.
    const db = dbFor({
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      catalogRows: [{ id: 'ot-1', service_key: 'general_pest_control', service_name: 'General Pest Control' }],
      stampRows: [{
        id: 'ot-1', status: 'completed', source: 'estimate-accept',
        service_address_line1: '123 Gulf Dr', service_address_city: 'Sarasota', service_address_zip: '34236',
      }],
    });
    const service = SERVICE({ service_type: 'Quarterly Pest Control', scheduled_service_id: 'ot-1' });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
  });

  test('a callback report with no linked row owns nothing (persisted is_callback flag)', async () => {
    // Older service_records have nullable scheduled_service_id; the
    // persisted flag is the only lifecycle evidence — a re-service label
    // must not claim ownership and skip the ladder rung.
    const db = dbFor({
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    const service = SERVICE({ service_type: 'Quarterly Pest Control', is_callback: true });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
  });

  test('an unstamped linked visit resolves through its creating estimate — another city suppresses', async () => {
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      stampRows: [{ id: 'v1', status: 'completed', source_estimate_id: 'est-9' }],
      estimates: [{ id: 'est-9', address: '123 Gulf Dr, Venice, FL 34285', status: 'sent' }],
    });
    const result = await buildReportCrossSell(SERVICE({ scheduled_service_id: 'v1' }), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('an owned recurring row with disjoint locality evidence suppresses the whole card', async () => {
    // Primary is city-only, the recurring row's stamp is zip-only: the row
    // may belong to another property, and both counting and dropping it
    // can be wrong — filterRowsToStreet throws for the strict scope and
    // the card fails closed.
    const db = dbFor({
      customer: CUSTOMER({ zip: null }),
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      stampRows: [{
        id: 'r1', service_type: 'Pest Control', scheduled_date: FUTURE_SCHEDULED_DATE,
        status: 'scheduled', is_recurring: true,
        service_address_line1: '123 Gulf Dr', service_address_zip: '34236',
      }],
    });
    expect(await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup })).toBeNull();
  });

  test('a recurring row linked only to a secondary property row never counts at the primary', async () => {
    // Unstamped lawn row whose property_id resolves to a different street:
    // dispatch's resolution order (stamp → property row → estimate →
    // primary) applies to ownership scoping too, so lawn is NOT owned at
    // the primary and the ladder still offers it — previously the row
    // defaulted to primary and the ladder advanced to tree & shrub.
    // The report itself is LINKED to a visit stamped at the primary: this
    // customer has a second premises on file, and PR r11 suppresses the
    // card for an UNLINKED report on such an account (the report address
    // would be the customer mirror, proving nothing). Here the linked stamp
    // proves the premises, so ownership scoping is what the test exercises.
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      stampRows: [{
        id: 'v-primary', status: 'completed',
        service_address_line1: '123 Gulf Dr', service_address_city: 'Sarasota', service_address_zip: '34236',
      }, {
        id: 'r2', service_type: 'Lawn Care', scheduled_date: FUTURE_SCHEDULED_DATE,
        status: 'scheduled', is_recurring: true, property_id: 'prop-9',
      }],
      properties: [{ id: 'prop-9', address_line1: '88 Palm Ave', city: 'Venice', zip: '34285' }],
    });
    const result = await buildReportCrossSell(SERVICE({ scheduled_service_id: 'v-primary' }), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('lawn_care');
  });

  describe('an UNLINKED report must prove the account has a single premises (PR r11 P1)', () => {
    // service_records.scheduled_service_id is nullable for historical rows
    // whose visit could not be matched, and the route COALESCEs address_*
    // from the CUSTOMER mirror when nothing joins — so the report address
    // is the primary address by construction and proves nothing. On a
    // multi-property account an old secondary-property report would
    // otherwise display and persist a primary-profile price.
    const singlePremisesDb = (extra = {}) => dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      ...extra,
    });

    test('a single-premises account still gets the card', async () => {
      const result = await buildReportCrossSell(SERVICE(), singlePremisesDb(), { propertyLookup: missLookup });
      expect(result).not.toBeNull();
      expect(result.serviceKey).toBe('lawn_care');
    });

    test('a second premises in customer_properties suppresses it', async () => {
      const db = singlePremisesDb({
        properties: [
          { id: 'prop-1', address_line1: '123 Gulf Dr', city: 'Sarasota', zip: '34236' },
          { id: 'prop-9', address_line1: '88 Palm Ave', city: 'Venice', zip: '34285' },
        ],
      });
      expect(await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup })).toBeNull();
    });

    test('a lone property row that is NOT the primary suppresses it', async () => {
      const db = singlePremisesDb({
        properties: [{ id: 'prop-9', address_line1: '88 Palm Ave', city: 'Venice', zip: '34285' }],
      });
      expect(await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup })).toBeNull();
    });

    test('a DEACTIVATED secondary property still suppresses it (pre-push P0)', async () => {
      // Report tokens are permanent, so the report being priced is often
      // older than the account's current shape — a since-deactivated
      // secondary property is exactly the premises a legacy unlinked record
      // is likely to belong to. Restricting the proof to active rows made
      // the COALESCEd primary address look proven.
      const db = singlePremisesDb({
        properties: [{
          id: 'prop-old', address_line1: '88 Palm Ave', city: 'Venice', zip: '34285', active: false,
        }],
      });
      expect(await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup })).toBeNull();
    });

    test('the admin-set has_multi_home flag alone suppresses it', async () => {
      // The flag is the eligibility signal the discount engine already
      // trusts — it covers customers whose second property never made it
      // into customer_properties.
      const db = singlePremisesDb({ customer: CUSTOMER({ has_multi_home: true }) });
      expect(await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup })).toBeNull();
    });

    test('a visit stamped at another street suppresses it even with no property rows', async () => {
      // customer_properties is gated and empty for older accounts, so the
      // stamped visit addresses are the second witness.
      const db = singlePremisesDb({
        stampRows: [{
          id: 'v-other', status: 'completed',
          service_address_line1: '88 Palm Ave', service_address_city: 'Venice', service_address_zip: '34285',
        }],
      });
      expect(await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup })).toBeNull();
    });

    test('a visit stamped at the primary street, and unstamped rows, keep the card', async () => {
      // A stamp that IS the primary is not a second premises, and an
      // unstamped row is the absence of evidence, not evidence of one.
      const db = singlePremisesDb({
        stampRows: [{
          id: 'v-primary', status: 'completed',
          service_address_line1: '123 Gulf Dr', service_address_city: 'Sarasota', service_address_zip: '34236',
        }],
      });
      const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
      expect(result).not.toBeNull();
      expect(result.serviceKey).toBe('lawn_care');
    });

    test('a LINKED row that resolves to nothing gets the same proof (pre-push P0)', async () => {
      // Historical rows predate the linkage columns: a linked visit with no
      // stamp, no property_id and no source_estimate_id proves nothing, and
      // assuming primary published the primary property's exact offer on a
      // report that may belong to a secondary one. Same gate as unlinked.
      const bare = { id: 'v-bare', status: 'completed' };
      const secondary = {
        properties: [{ id: 'prop-9', address_line1: '88 Palm Ave', city: 'Venice', zip: '34285' }],
      };
      const withSecond = singlePremisesDb({ stampRows: [bare], ...secondary });
      expect(await buildReportCrossSell(
        SERVICE({ scheduled_service_id: 'v-bare' }), withSecond, { propertyLookup: missLookup },
      )).toBeNull();

      // Single-premises account: the same unresolvable row still gets a card.
      const singleOnly = singlePremisesDb({ stampRows: [bare] });
      const result = await buildReportCrossSell(
        SERVICE({ scheduled_service_id: 'v-bare' }), singleOnly, { propertyLookup: missLookup },
      );
      expect(result).not.toBeNull();
      expect(result.serviceKey).toBe('lawn_care');
    });

    test('a locality-less witness is UNPROVEN, not benign (PR r12 P1)', async () => {
      // A secondary property with the same street and unit in another city
      // produces exactly this key, so accepting it would declare the wrong
      // premises primary and price from the wrong profile. Same rejection
      // the linked-report and estimate-seed guards already apply.
      const stamped = singlePremisesDb({
        stampRows: [{ id: 'v-partial', status: 'completed', service_address_line1: '123 Gulf Dr' }],
      });
      expect(await buildReportCrossSell(SERVICE(), stamped, { propertyLookup: missLookup })).toBeNull();

      const propertyRow = singlePremisesDb({
        properties: [{ id: 'prop-partial', address_line1: '123 Gulf Dr' }],
      });
      expect(await buildReportCrossSell(SERVICE(), propertyRow, { propertyLookup: missLookup })).toBeNull();
    });

    test('an UNSTAMPED row linking to a secondary address via its creating estimate suppresses it (PR r13 P1)', async () => {
      // Dispatch resolves stamp → property row → creating estimate →
      // primary. Only the property_id leg is covered by the
      // customer_properties witness, so an estimate-linked row at another
      // address would otherwise certify this account as single-premises.
      const db = singlePremisesDb({
        stampRows: [{ id: 'v-unstamped', status: 'completed', source_estimate_id: 'est-secondary' }],
        estimates: [{ id: 'est-secondary', address: '88 Palm Ave, Venice, FL 34285', status: 'accepted' }],
      });
      expect(await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup })).toBeNull();
    });

    test('an unstamped row with no property or estimate link is not evidence of a second premises', async () => {
      const db = singlePremisesDb({
        stampRows: [{ id: 'v-bare', status: 'completed' }],
      });
      const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
      expect(result).not.toBeNull();
      expect(result.serviceKey).toBe('lawn_care');
    });

    test('a same-street stamp in a DIFFERENT city suppresses it', async () => {
      // sameScopeKey is strict on street but wildcards a locality field
      // either side lacks; a fully-qualified stamp in another city is a
      // genuinely different premises.
      const db = singlePremisesDb({
        stampRows: [{
          id: 'v-twin', status: 'completed',
          service_address_line1: '123 Gulf Dr', service_address_city: 'Venice', service_address_zip: '34285',
        }],
      });
      expect(await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup })).toBeNull();
    });
  });

  test('a property-linked row that cannot be resolved suppresses the strict scope entirely', async () => {
    // property_id set but no customer_properties row: the premises are
    // unprovable, and defaulting the row to the primary would count a
    // possibly-secondary plan there (pre-push P0) — the strict scope
    // throws and the card fails closed.
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      stampRows: [{
        id: 'r3', service_type: 'Lawn Care', scheduled_date: FUTURE_SCHEDULED_DATE,
        status: 'scheduled', is_recurring: true, property_id: 'prop-missing',
      }],
    });
    expect(await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup })).toBeNull();
  });

  test('an estimate-linked row that cannot be resolved suppresses the strict scope entirely', async () => {
    // source_estimate_id set but the estimate is missing/addressless: the
    // premises are unprovable, and defaulting to primary would count a
    // possibly-secondary plan there — same fail-closed rule as the
    // property_id leg.
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      stampRows: [{
        id: 'r4', service_type: 'Lawn Care', scheduled_date: FUTURE_SCHEDULED_DATE,
        status: 'scheduled', is_recurring: true, source_estimate_id: 'est-missing',
      }],
    });
    expect(await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup })).toBeNull();
  });

  test('a report stamped at a different property than the primary is suppressed', async () => {
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500 },
    });
    const service = SERVICE({ address_line1: '9 Rental Way', city: 'Venice', zip: '34285' });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('the report row classifies from its catalog identity, not stale service_type text', async () => {
    // A rodent-monitoring visit completed under a stale generic
    // 'Pest Control' label: the informative catalog identity owns no
    // ladder family, so the report identity must not claim pest — the
    // ladder still offers the pest plan (stale text would have advanced
    // it to lawn care).
    const db = dbFor({
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      catalogRows: [{ id: 'done-1', service_key: 'rodent_monitoring', service_name: 'Rodent Monitoring' }],
    });
    const service = SERVICE({ service_type: 'Pest Control', scheduled_service_id: 'done-1' });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
  });

  test('a street-only estimate address (no city/zip) never seeds — wildcard locality is ambiguous', async () => {
    // sameScopeKey treats missing locality as a wildcard, so a legacy
    // street-only key would match every same-street property; the seed is
    // refused instead of pricing an unproven premises.
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '123 Gulf Dr',
        status: 'accepted',
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.mode).toBe('quote_cta');
    expect(result.option).toBeNull();
  });

  test('a commercial catalog identity suppresses the card even under stale residential text', async () => {
    // 'Commercial Pest Control' catalog row, stale generic service_type,
    // blank stored property_type: the catalog-enriched identity must hit
    // the commercial gate — a residential price on a commercial report is
    // the ruled no-card-at-all case.
    const db = dbFor({
      customer: CUSTOMER({ property_type: null }),
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      catalogRows: [{ id: 'done-2', service_key: 'commercial_pest_control', service_name: 'Commercial Pest Control' }],
    });
    const service = SERVICE({ service_type: 'Pest Control', scheduled_service_id: 'done-2' });
    expect(await buildReportCrossSell(service, db, { propertyLookup: missLookup })).toBeNull();
  });

  test('a primary address without city or zip suppresses the card — anchor locality unprovable', async () => {
    // The primary key is the anchor every frame scopes to; without
    // locality it wildcard-matches every same-street property, so the
    // card fails closed exactly like raw stamps and estimate seeds.
    const db = dbFor({
      customer: CUSTOMER({ city: null, zip: null }),
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    expect(await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup })).toBeNull();
  });

  test('options carrying setup or one-time charges never price on the card', () => {
    // Per-application is the ONLY price field the public payload may carry
    // (r7 ruling): a termite-basic dueAtStart would price-lock an
    // undisclosed setup charge — such options demote to the quote CTA.
    const { optionIsPriceable } = _private;
    expect(optionIsPriceable({ perVisit: 42 })).toBe(true);
    expect(optionIsPriceable({ perVisit: 42, dueAtStart: 99 })).toBe(false);
    expect(optionIsPriceable({ perVisit: 42, oneTime: 150 })).toBe(false);
  });

  test('a HISTORICAL report identity does not advance the ladder without billing corroboration', async () => {
    // Former pest customer, plan cancelled: no upcoming rows, no ledger
    // row, and the permanent-token report is months old — pest must be
    // offered again, not skipped for a lawn offer labeled as a plan add.
    const db = dbFor({
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    const service = SERVICE({ service_type: 'Quarterly Pest Control', service_date: '2026-01-05' });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.relationship).toBe('start');
  });

  test('a report identity counts when the AUTHORITATIVE ledger carries the family (gate on)', async () => {
    // Only gate-ON ledger rows are billing authority (advisory rows may
    // never advance the ladder) — with it, the unseeded-gap report keeps
    // its family and the ladder offers the next rung.
    // The feature-gate map is baked at module load, so the gate-on world
    // needs a fresh module registry.
    const prev = process.env.GATE_PLAN_RATE_LEDGER;
    process.env.GATE_PLAN_RATE_LEDGER = 'true';
    jest.resetModules();
    try {
      const { buildReportCrossSell: freshBuild } = require('../services/service-report/cross-sell');
      const db = dbFor({
        serviceTypes: [],
        turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
        planRates: [{ family_key: 'pest_control', monthly_rate: 60 }],
      });
      const service = SERVICE({ service_type: 'Quarterly Pest Control' });
      const result = await freshBuild(service, db, { propertyLookup: missLookup });
      expect(result).not.toBeNull();
      expect(result.serviceKey).toBe('lawn_care');
    } finally {
      if (prev === undefined) delete process.env.GATE_PLAN_RATE_LEDGER;
      else process.env.GATE_PLAN_RATE_LEDGER = prev;
      jest.resetModules();
    }
  });

  test('a UTC-midnight Date service_date reads as its own ET calendar day, not the day before', async () => {
    // pg DATE columns hydrate as UTC-midnight Dates; running one through
    // etDateString would shift it to the PREVIOUS Eastern day and expire
    // the 90-day ambiguity guard a day early (pre-push P1). A report dated
    // exactly 90 ET days ago must still suppress.
    const ninetyDaysAgo = new Date(Date.UTC(
      new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 90, 0, 0, 0, 0,
    ));
    const db = dbFor({
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    const service = SERVICE({ service_type: 'Quarterly Pest Control', service_date: ninetyDaysAgo });
    expect(await buildReportCrossSell(service, db, { propertyLookup: missLookup })).toBeNull();
  });

  test('an old report + a stale ADVISORY ledger component never becomes a lawn request (gate off)', async () => {
    // The advisory component is not corroboration (it may be stale or
    // another property's), so the old report's pest identity drops; pest
    // becomes the ladder target, and the same advisory row then SUPPRESSES
    // the card at the target rung — no card, rather than a lawn request
    // for a customer with no current plan.
    const db = dbFor({
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      planRates: [{ family_key: 'pest_control', monthly_rate: 60 }],
    });
    const service = SERVICE({ service_type: 'Quarterly Pest Control', service_date: '2026-01-05' });
    expect(await buildReportCrossSell(service, db, { propertyLookup: missLookup })).toBeNull();
  });

  test('a seeded synthetic zero tree count is dropped — it never reads as an explicit count', async () => {
    // The v1 lookup adapter stores treeCount: 0 when nothing was observed;
    // replayed as explicit it would let priceTreeShrub skip its density
    // fallback and price zero trees. With the zero dropped, the seed with
    // and without the synthetic count must price identically.
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
    const run = async (features) => buildReportCrossSell(SERVICE(), dbFor({
      serviceTypes: ['Pest Control', 'Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: estimateWith(features),
    }), { propertyLookup: missLookup });
    const withSyntheticZero = await run({ trees: 'moderate', treeCount: 0 });
    expect(withSyntheticZero).not.toBeNull();
    expect(withSyntheticZero.serviceKey).toBe('tree_shrub');
    // r10: a zero count has no provenance (operator-confirmed vs adapter
    // synthetic), so a tree & shrub offer built on it NEVER prices —
    // neither replaying zero trees nor a phantom density fallback is safe.
    expect(withSyntheticZero.mode).toBe('quote_cta');
    expect(withSyntheticZero.option).toBeNull();
  });

  test('report-family guard: a RECENT uncorroborated report identity suppresses the card entirely', async () => {
    // Recurring customer whose next visit isn't seeded — or a customer who
    // just cancelled: with no upcoming rows and no authoritative billing
    // evidence the two are indistinguishable (codex #3367 PR r10), and
    // offering pest vs advancing to lawn are each wrong in one of those
    // worlds. Both-answers-wrong → no card.
    const db = dbFor({
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    const service = SERVICE({ service_type: 'Quarterly Pest Control Service' });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('plan-rate ledger evidence on the target rung suppresses the card — it never advances the ladder', async () => {
    // Pest via upcoming rows; lawn ONLY via a plan-rate row (next lawn visit
    // not seeded). Ledger rows are advisory-capable and never
    // property-scoped, so lawn must not be offered (may be owned) AND the
    // ladder must not advance to tree & shrub (the row may be stale or
    // billed at another property): no card at all.
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      planRates: [{ family_key: 'lawn_care', monthly_rate: 45 }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('plan-rate ledger evidence above the target rung demotes to CTA without moving the target', async () => {
    // Pest via upcoming rows, termite ONLY via a plan-rate row. The ladder
    // still offers lawn care (its rung carries no ledger evidence), but the
    // pricing baseline cannot model the termite plan, so no standalone
    // price may render.
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      planRates: [{ family_key: 'termite', monthly_rate: 80 }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('lawn_care');
    expect(result.mode).toBe('quote_cta');
  });

  test('recurring-but-tierless customer: owned rows dropped by the membership gate demote to CTA', async () => {
    // The documented transition: upcoming recurring lawn rows but no tier
    // and no monthly rate — ownership sees lawn, the membership-gated
    // pricing baseline does not, so a priced standalone pest offer would
    // miss the combined tier.
    const db = dbFor({
      customer: CUSTOMER({ waveguard_tier: 'none', monthly_rate: 0 }),
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '123 Gulf Dr, Sarasota, FL 34236',
        status: 'accepted',
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.mode).toBe('quote_cta');
  });

  test('an explicitly commercial report identity suppresses the card even with a blank property type', async () => {
    const db = dbFor({
      customer: CUSTOMER({ property_type: null }),
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    const service = SERVICE({ service_type: 'Commercial Pest Control' });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('one-time report identities (cockroach cleanout) do NOT count as owned pest', async () => {
    const db = dbFor({ serviceTypes: [] });
    const service = SERVICE({ service_type: 'Cockroach Treatment' });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
  });

  test('estimate seed prices a pest offer when profile and lookup carry nothing', async () => {
    // The dimensions that priced the customer's live plan fill the gaps —
    // prod audit 2026-08-11: without this, real reports never priced.
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '123 Gulf Dr, Sarasota, FL 34236',
        status: 'accepted',
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.mode).toBe('priced');
    expect(result.option.perVisit).toBeGreaterThan(0);
  });

  test('a seed with guessed stories keeps the manual-review demotion (CTA, no price)', async () => {
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '123 Gulf Dr, Sarasota, FL 34236',
        status: 'accepted',
        // No storiesSource on the old estimate → seed replays 'estimated' →
        // stories_estimated manual review → the card refuses the price.
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.mode).toBe('quote_cta');
  });

  test('non-accepted estimates never seed a price (drafts/sent/expired refused)', async () => {
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '123 Gulf Dr, Sarasota, FL 34236',
        status: 'sent',
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.mode).toBe('quote_cta');
  });

  test('an addressless estimate never seeds a customer with a primary street', async () => {
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '',
        status: 'accepted',
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.mode).toBe('quote_cta');
  });

  test('FAIL CLOSED: a customer with no primary street gets no card (property frames cannot be proven aligned)', async () => {
    const customer = CUSTOMER({ address_line1: null, city: null, zip: null });
    const db = dbFor({
      customer,
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '123 Gulf Dr, Sarasota, FL 34236',
        status: 'accepted',
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('an estimate stamped at a different street never seeds this property', async () => {
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '9 Rental Way, Venice, FL 34285',
        status: 'accepted',
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.mode).toBe('quote_cta');
  });

  test('inactive customer gets no card', async () => {
    const db = dbFor({ customer: CUSTOMER({ active: false }), serviceTypes: [] });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('missing customer_id or database returns null, never throws', async () => {
    expect(await buildReportCrossSell({}, dbFor({}))).toBeNull();
    expect(await buildReportCrossSell(SERVICE(), null)).toBeNull();
  });
});
