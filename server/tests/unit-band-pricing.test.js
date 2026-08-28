/**
 * Residential-unit bedroom-band pricing (GATE_UNIT_BAND_PRICING) — PR2 of
 * the apartment/condo estimator lane, owner ruling 2026-08-11.
 *
 * Pins: the band is a PRICING BASIS, never an imputed sqft; only interior
 * general pest (recurring quarterly/bi-monthly + one-time, roach 'none')
 * may band-price; a unit-scoped sqft outranks the band; monthly parks;
 * the missing bedroom count is askable; the kill switch restores today's
 * engine input byte-for-byte.
 */

const {
  unitBandPricingEnabled,
  bandForBedroomCount,
  bandFrequencyForIntent,
  callerStatedBedroomCount,
  unitBandEligibility,
  resolveUnitBandPricing,
  trustedUnitBand,
  signUnitBandSnapshot,
  SCOPE_EXCLUSIONS,
  SCOPE_NOTES,
} = require('../services/pricing-engine/unit-band-pricing');
const {
  pricePestControlUnitBand,
  priceOneTimePestUnitBand,
  pricePestControl,
} = require('../services/pricing-engine/service-pricing');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { LANES, buildEngineInput, classifyLane } = require('../services/estimator-engine/draft-builder');
const { validateIntent } = require('../services/estimator-engine/intent-schema');
const { _private: composerPriv } = require('../services/estimator-engine/intent-composer');
const { validateModelOutput, validatePersisted } = require('../schemas/validate-extraction');

const withEnv = (name, value, fn) => {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
};
const withGate = (value, fn) => withEnv('GATE_UNIT_BAND_PRICING', value, fn);

// Snapshot signing needs the server secret (fail closed without it).
const TEST_SECRET = 'unit-band-test-secret';
beforeAll(() => { process.env.JWT_SECRET = TEST_SECRET; });
afterAll(() => { delete process.env.JWT_SECRET; });

// Minimal knex stand-in for residential_unit_pricing reads.
function fakeDb(rows, { fail = false } = {}) {
  const calls = [];
  const whereArgs = [];
  return Object.assign((table) => {
    calls.push(table);
    const builder = {
      where(...args) { whereArgs.push(args); return builder; },
      orderBy: async () => {
        if (fail) throw new Error('relation "residential_unit_pricing" does not exist');
        return rows;
      },
    };
    return builder;
  }, { calls, whereArgs });
}

const row = (service_code, frequency, unit_band, price, effective_date = '2026-08-13') => ({
  service_code, frequency, unit_band,
  initial_price: String(price), recurring_price: String(price),
  included_scope: 'interior_unit_general_pest', oversize_sqft_threshold: 2200,
  effective_date: new Date(`${effective_date}T00:00:00Z`),
});
const seedRows = () => [
  row('pest', 'quarterly', 'one_bedroom', 85),
  row('pest', 'bi_monthly', 'one_bedroom', 85),
  row('oneTimePest', 'one_time', 'one_bedroom', 199),
  row('pest', 'quarterly', 'studio', 79),
  row('pest', 'bi_monthly', 'studio', 79),
  row('oneTimePest', 'one_time', 'studio', 199),
];

const unitIntent = (services = { pest: { frequency: 'quarterly' } }, extra = {}) => ({
  decision: 'draft',
  skip_reason: null,
  customer_name: 'Test Caller',
  customer_phone: '+19410000000',
  customer_email: null,
  address: '1400 Lakefront Dr Apt 7109, Sarasota, FL 34240',
  category: 'RESIDENTIAL',
  is_commercial: false,
  commercial_risk_type: null,
  commercial_subtype: null,
  services,
  service_interest_label: 'Quarterly Pest Control',
  evidence: [{ decision: 'pest quarterly', quote: 'quarterly pest control for my apartment', speaker: 'caller' }],
  constraint_flags: [],
  uncertainties: [],
  confidence: 'high',
  ...extra,
});
const unitScope = (overrides = {}) => ({
  propertyUse: 'multifamily_rental',
  serviceScope: 'residential_unit',
  customerRelationship: 'tenant',
  sizeBasis: 'unresolved',
  lotApplicability: 'no_individual_lot',
  ...overrides,
});
const unresolvedHome = () => ({ value: null, source: 'unresolved', confidence: 'none', rejected: [] });
const unitFacts = (overrides = {}) => ({
  home: unresolvedHome(),
  lot: { value: null, source: 'not_applicable:no_individual_lot', confidence: 'high', rejected: [] },
  tenant: true,
  newConstruction: false,
  unitScope: unitScope(),
  ...overrides,
});
const extractionWithBedrooms = (n) => ({
  caller: { relationship_to_property: 'tenant' },
  property: { property_type: 'multi_family', bedroom_count: n, approximate_living_sqft: null },
});

describe('gate semantics', () => {
  test('defaults OFF; accepts 1/true/on', () => {
    withGate(undefined, () => expect(unitBandPricingEnabled()).toBe(false));
    withGate('false', () => expect(unitBandPricingEnabled()).toBe(false));
    withGate('true', () => expect(unitBandPricingEnabled()).toBe(true));
    withGate('1', () => expect(unitBandPricingEnabled()).toBe(true));
    withGate('on', () => expect(unitBandPricingEnabled()).toBe(true));
  });
  test('gate OFF: the resolver returns null and never touches the DB', async () => {
    const db = fakeDb(seedRows());
    const out = await withGate(undefined, () => resolveUnitBandPricing(db, {
      intent: unitIntent(), unitScope: unitScope(), propertyFacts: unitFacts(), extraction: extractionWithBedrooms(1),
    }));
    expect(out).toBeNull();
    expect(db.calls).toEqual([]);
  });
});

describe('band + frequency vocabulary', () => {
  test('bedroom count → band (studio = 0, 4+ collapses)', () => {
    expect(bandForBedroomCount(0)).toBe('studio');
    expect(bandForBedroomCount(1)).toBe('one_bedroom');
    expect(bandForBedroomCount(2)).toBe('two_bedroom');
    expect(bandForBedroomCount(3)).toBe('three_bedroom');
    expect(bandForBedroomCount(4)).toBe('four_plus');
    expect(bandForBedroomCount(7)).toBe('four_plus');
    expect(bandForBedroomCount(null)).toBeNull();
    expect(bandForBedroomCount(-1)).toBeNull();
    expect(bandForBedroomCount(1.5)).toBeNull();
    expect(bandForBedroomCount('2')).toBe('two_bedroom');
  });
  test('intent cadence → table frequency; monthly has NO band', () => {
    expect(bandFrequencyForIntent('quarterly')).toBe('quarterly');
    expect(bandFrequencyForIntent('bimonthly')).toBe('bi_monthly');
    expect(bandFrequencyForIntent(undefined)).toBe('quarterly');
    expect(bandFrequencyForIntent('monthly')).toBeNull();
  });
  test('bedroom count provenance: extraction first, then the composer intent, never derived', () => {
    expect(callerStatedBedroomCount({ extraction: extractionWithBedrooms(2), intent: { unit_bedroom_count: 3 } }))
      .toEqual({ count: 2, source: 'call_extraction' });
    expect(callerStatedBedroomCount({ extraction: null, intent: { unit_bedroom_count: 0 } }))
      .toEqual({ count: 0, source: 'composer_intent' });
    expect(callerStatedBedroomCount({ extraction: { property: { approximate_living_sqft: 900 } }, intent: {} }))
      .toEqual({ count: null, source: null });
  });
});

describe('eligibility (ruling #3 — interior general pest only; basis ladder)', () => {
  test('residential unit + quarterly pest + unresolved sqft → eligible', () => {
    const v = unitBandEligibility({ intent: unitIntent(), unitScope: unitScope(), propertyFacts: unitFacts() });
    expect(v.eligible).toBe(true);
    expect(v.keys.pest).toEqual({ eligible: true, frequency: 'quarterly', intentFrequency: 'quarterly' });
  });
  test('a resolved unit-scoped sqft outranks the band (standard ladder prices it)', () => {
    const facts = unitFacts({ home: { value: 780, source: 'caller_stated', confidence: 'medium', rejected: [] } });
    expect(unitBandEligibility({ intent: unitIntent(), unitScope: unitScope(), propertyFacts: facts }).reason).toBe('unit_sqft_resolved');
  });
  test('whole-structure scope, commercial intent, and non-draft decline', () => {
    expect(unitBandEligibility({ intent: unitIntent(), unitScope: unitScope({ serviceScope: 'entire_residential_structure' }), propertyFacts: unitFacts() }).reason).toBe('not_a_residential_unit');
    expect(unitBandEligibility({ intent: unitIntent(undefined, { is_commercial: true }), unitScope: unitScope(), propertyFacts: unitFacts() }).reason).toBe('commercial_intent');
    expect(unitBandEligibility({ intent: unitIntent(undefined, { decision: 'skip' }), unitScope: unitScope(), propertyFacts: unitFacts() }).reason).toBe('not_a_draft');
  });
  test('roach programs keep their own rules; monthly parks; other services never band', () => {
    const roach = unitBandEligibility({ intent: unitIntent({ pest: { frequency: 'quarterly', roachType: 'german' } }), unitScope: unitScope(), propertyFacts: unitFacts() });
    expect(roach.eligible).toBe(false);
    expect(roach.keys.pest).toEqual({ eligible: false, reason: 'roach_program' });
    const monthly = unitBandEligibility({ intent: unitIntent({ pest: { frequency: 'monthly' }, oneTimePest: {} }), unitScope: unitScope(), propertyFacts: unitFacts() });
    expect(monthly.eligible).toBe(true);
    expect(monthly.keys.pest).toEqual({ eligible: false, reason: 'monthly_frequency' });
    expect(monthly.keys.oneTimePest).toEqual({ eligible: true, frequency: 'one_time' });
    const mosquito = unitBandEligibility({ intent: unitIntent({ mosquito: {} }), unitScope: unitScope(), propertyFacts: unitFacts() });
    expect(mosquito.eligible).toBe(false);
    expect(mosquito.reason).toBe('no_pest_service');
  });
});

describe('resolver (gate ON)', () => {
  const resolve = (args) => withGate('true', () => resolveUnitBandPricing(args.db, args));

  test('1BR tenant, quarterly + one-time: both keys carry the approved rows and the audit stamps', async () => {
    const out = await resolve({
      db: fakeDb(seedRows()),
      intent: unitIntent({ pest: { frequency: 'quarterly' }, oneTimePest: {} }),
      unitScope: unitScope(), propertyFacts: unitFacts(), extraction: extractionWithBedrooms(1),
    });
    expect(out.eligible).toBe(true);
    expect(out.pricingBasis).toBe('caller_stated_bedroom_count');
    expect(out.sizeBasis).toBe('bedroom_band');
    expect(out.pricingBand).toBe('one_bedroom');
    expect(out.bedroomCount).toBe(1);
    expect(out.bedroomSource).toBe('call_extraction');
    expect(out.missing).toEqual([]);
    expect(out.parked).toEqual({});
    expect(out.unresolved).toBeNull();
    expect(out.pest).toMatchObject({ serviceCode: 'pest', frequency: 'quarterly', intentFrequency: 'quarterly', band: 'one_bedroom', recurringPrice: 85, initialPrice: 85, includedScope: 'interior_unit_general_pest', oversizeSqftThreshold: 2200, effectiveDate: '2026-08-13' });
    expect(out.pest.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(out.pest.kid).toMatch(/^[0-9a-f]{8}$/);
    expect(Object.keys(out.pestCadences).sort()).toEqual(['bi_monthly', 'quarterly']);
    expect(out.pestCadences.bi_monthly).toMatchObject({ serviceCode: 'pest', frequency: 'bi_monthly', recurringPrice: 85 });
    expect(out.pestCadences.bi_monthly.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(out.pestCadences.bi_monthly.sig).not.toBe(out.pestCadences.quarterly.sig);
    expect(out.pest.subjectAddress).toBe(unitIntent().address.toLowerCase());
    expect(out.oneTimePest.serviceCode).toBe('oneTimePest');
    expect(out.pest.scopeExclusions).toEqual(SCOPE_EXCLUSIONS.interior_unit_general_pest);
    expect(out.pest.scopeNote).toBe(SCOPE_NOTES.interior_unit_general_pest);
    expect(out.oneTimePest).toMatchObject({ frequency: 'one_time', recurringPrice: 199 });
  });
  test('effective-date lookup compares on the EASTERN calendar day, date-to-date (hook P1)', async () => {
    const db = fakeDb(seedRows());
    // 03:30Z on Sep 1 is still Aug 31 in Eastern time — the row effective
    // 2026-09-01 must NOT be live yet.
    await resolve({
      db, intent: unitIntent(), unitScope: unitScope(), propertyFacts: unitFacts(),
      extraction: extractionWithBedrooms(1), asOf: new Date('2026-09-01T03:30:00Z'),
    });
    expect(db.whereArgs[0]).toEqual(['effective_date', '<=', '2026-08-31']);
    await resolve({
      db, intent: unitIntent(), unitScope: unitScope(), propertyFacts: unitFacts(),
      extraction: extractionWithBedrooms(1), asOf: new Date('2026-09-01T05:30:00Z'),
    });
    expect(db.whereArgs[1]).toEqual(['effective_date', '<=', '2026-09-01']);
  });
  test('bi-monthly reads the bi_monthly row at the same per-visit price', async () => {
    const out = await resolve({
      db: fakeDb(seedRows()), intent: unitIntent({ pest: { frequency: 'bimonthly' } }),
      unitScope: unitScope(), propertyFacts: unitFacts(), extraction: extractionWithBedrooms(1),
    });
    expect(out.pest).toMatchObject({ frequency: 'bi_monthly', intentFrequency: 'bimonthly', recurringPrice: 85 });
  });
  test('the newest effective_date ≤ now wins; a future row is ignored', async () => {
    const rows = [
      row('pest', 'quarterly', 'one_bedroom', 85, '2026-08-13'),
      row('pest', 'quarterly', 'one_bedroom', 90, '2026-09-01'),
    ];
    // The stand-in returns rows in the order the query would (effective_date desc).
    const out = await resolve({
      db: fakeDb([rows[1], rows[0]]), intent: unitIntent(), unitScope: unitScope(), propertyFacts: unitFacts(),
      extraction: extractionWithBedrooms(1), asOf: new Date('2026-09-15T00:00:00Z'),
    });
    expect(out.pest.recurringPrice).toBe(90);
    expect(out.pest.effectiveDate).toBe('2026-09-01');
  });
  test('no stated bedroom count → eligible, nothing priced, bedroom_count MISSING (askable); DB untouched', async () => {
    const db = fakeDb(seedRows());
    const out = await resolve({
      db, intent: unitIntent(), unitScope: unitScope(), propertyFacts: unitFacts(),
      extraction: { caller: { relationship_to_property: 'tenant' }, property: { property_type: 'multi_family' } },
    });
    expect(out.eligible).toBe(true);
    expect(out.missing).toEqual(['bedroom_count']);
    expect(out.pest).toBeUndefined();
    expect(out.pricingBand).toBeNull();
    expect(db.calls).toEqual([]);
  });
  test('the composer intent supplies the count on the SMS-thread path (no extraction)', async () => {
    const out = await resolve({
      db: fakeDb(seedRows()), intent: unitIntent(undefined, { unit_bedroom_count: 0 }),
      unitScope: unitScope(), propertyFacts: unitFacts(), extraction: null,
    });
    expect(out.pricingBand).toBe('studio');
    expect(out.bedroomSource).toBe('composer_intent');
    expect(out.pest.recurringPrice).toBe(79);
  });
  test('monthly recurring parks while a one-time on the same intent still band-prices', async () => {
    const out = await resolve({
      db: fakeDb(seedRows()), intent: unitIntent({ pest: { frequency: 'monthly' }, oneTimePest: {} }),
      unitScope: unitScope(), propertyFacts: unitFacts(), extraction: extractionWithBedrooms(1),
    });
    expect(out.parked).toEqual({ pest: 'monthly_frequency' });
    expect(out.pest).toBeUndefined();
    expect(out.oneTimePest.recurringPrice).toBe(199);
  });
  test('rate lookup failure and a missing row both fail OPEN as unresolved (nothing priced from the band)', async () => {
    const failed = await resolve({
      db: fakeDb([], { fail: true }), intent: unitIntent(), unitScope: unitScope(), propertyFacts: unitFacts(), extraction: extractionWithBedrooms(1),
    });
    expect(failed.unresolved).toMatch(/^rate_lookup_failed/);
    expect(failed.pest).toBeUndefined();
    const noRow = await resolve({
      db: fakeDb(seedRows()), intent: unitIntent(), unitScope: unitScope(), propertyFacts: unitFacts(), extraction: extractionWithBedrooms(4),
    });
    expect(noRow.unresolved).toBe('no_rate_row');
    expect(noRow.pest).toBeUndefined();
  });
  test('ineligible drafts resolve to null (engine input untouched)', async () => {
    const out = await resolve({
      db: fakeDb(seedRows()), intent: unitIntent(), unitScope: unitScope({ serviceScope: 'entire_residential_structure' }),
      propertyFacts: unitFacts(), extraction: extractionWithBedrooms(1),
    });
    expect(out).toBeNull();
  });
});

describe('snapshot integrity (hook P0 — engineInputs are browser-controlled)', () => {
  const ADDRESS = '1400 Lakefront Dr Apt 7109, Sarasota, FL 34240';
  const row = () => ({
    serviceCode: 'pest', frequency: 'quarterly', intentFrequency: 'quarterly', band: 'one_bedroom',
    initialPrice: 85, recurringPrice: 85, includedScope: 'interior_unit_general_pest',
    oversizeSqftThreshold: 2200, effectiveDate: '2026-08-13', scopeExclusions: [], scopeNote: null,
  });
  const signed = (r = row(), address = ADDRESS) => ({ ...r, ...signUnitBandSnapshot(r, address) });

  const verdict = (input, key, opts) => trustedUnitBand(input, key, opts);
  test('a row the resolver signed for this address is trusted; unsigned, tampered, transplanted, or mis-keyed rows are UNTRUSTED (never absent)', () => {
    expect(verdict({ address: ADDRESS, unitBandPricing: { pest: signed() } }, 'pest')).toMatchObject({ status: 'trusted', band: { recurringPrice: 85 } });
    // Address normalization is whitespace/case-insensitive, nothing more.
    expect(verdict({ address: `  ${ADDRESS.toUpperCase()}  `, unitBandPricing: { pest: signed() } }, 'pest').status).toBe('trusted');
    expect(verdict({ address: ADDRESS, unitBandPricing: { pest: row() } }, 'pest')).toEqual({ status: 'untrusted', reason: 'signature' });
    expect(verdict({ address: ADDRESS, unitBandPricing: { pest: { ...signed(), recurringPrice: 1 } } }, 'pest').status).toBe('untrusted');
    expect(verdict({ address: ADDRESS, unitBandPricing: { pest: { ...signed(), effectiveDate: '2030-01-01' } } }, 'pest').status).toBe('untrusted');
    expect(verdict({ address: '9 Other St, Venice, FL', unitBandPricing: { pest: signed() } }, 'pest').status).toBe('untrusted');
    expect(verdict({ address: ADDRESS }, 'pest')).toEqual({ status: 'absent' });
    // A signed one-time row cannot be used as the recurring row (and vice versa).
    const oneTime = signed({ ...row(), serviceCode: 'oneTimePest', frequency: 'one_time', initialPrice: 199, recurringPrice: 199 });
    // (rejected at the cadence step — a one_time row is no cadence row — or the key check; either way untrusted)
    expect(verdict({ address: ADDRESS, unitBandPricing: { pest: oneTime } }, 'pest').status).toBe('untrusted');
    expect(verdict({ address: ADDRESS, unitBandPricing: { pest: { ...oneTime, frequency: 'quarterly', ...signUnitBandSnapshot({ ...oneTime, frequency: 'quarterly' }, ADDRESS) } } }, 'pest')).toEqual({ status: 'untrusted', reason: 'service_key_mismatch' });
    expect(verdict({ address: ADDRESS, unitBandPricing: { oneTimePest: oneTime } }, 'oneTimePest').status).toBe('trusted');
  });
  test('the requested cadence must have ITS OWN signed row: quarterly cannot authorize bi-monthly; monthly is never a band cadence (hook P1)', () => {
    const quarterly = signed();
    const biMonthly = signed({ ...row(), frequency: 'bi_monthly', intentFrequency: undefined });
    const input = { address: ADDRESS, unitBandPricing: { pest: quarterly, pestCadences: { quarterly, bi_monthly: biMonthly } } };
    expect(verdict(input, 'pest', { requestedFrequency: 'quarterly' }).band.frequency).toBe('quarterly');
    expect(verdict(input, 'pest', { requestedFrequency: 'bimonthly' }).band.frequency).toBe('bi_monthly');
    expect(verdict(input, 'pest', { requestedFrequency: 'monthly' })).toEqual({ status: 'untrusted', reason: 'unsupported_cadence' });
    const quarterlyOnly = { address: ADDRESS, unitBandPricing: { pest: quarterly } };
    expect(verdict(quarterlyOnly, 'pest', { requestedFrequency: 'bimonthly' })).toEqual({ status: 'untrusted', reason: 'no_row_for_cadence' });
    // A cadence row whose signature is off is untrusted even when the primary verifies.
    const forged = { address: ADDRESS, unitBandPricing: { pest: quarterly, pestCadences: { quarterly, bi_monthly: { ...biMonthly, recurringPrice: 1 } } } };
    expect(verdict(forged, 'pest', { requestedFrequency: 'bimonthly' })).toEqual({ status: 'untrusted', reason: 'signature' });
  });
  test('an untrusted snapshot FAILS CLOSED in the engine: quote-required line with no dollars, never the footprint ladder (hook P0)', () => {
    const line = generateEstimate({
      services: { pest: { frequency: 'quarterly' } }, propertyType: 'unknown', stories: 1, isCommercial: false,
      address: '9 Other St, Venice, FL', unitBandPricing: { pest: signed() },
    }).lineItems.find((l) => l.service === 'pest_control');
    expect(line).toMatchObject({ quoteRequired: true, requiresManualReview: true, monthly: 0, annual: 0, footprintSource: 'bedroom_band' });
    expect(line.manualReviewReasons).toEqual(['unit_band_snapshot_signature']);
    const oneTime = generateEstimate({
      services: { oneTimePest: {} }, propertyType: 'unknown', stories: 1, isCommercial: false, address: ADDRESS,
      unitBandPricing: { oneTimePest: { ...row(), serviceCode: 'oneTimePest', frequency: 'one_time', recurringPrice: 199, initialPrice: 199 } },
    }).lineItems.find((l) => l.service === 'one_time_pest');
    expect(oneTime).toMatchObject({ quoteRequired: true, price: 0 });
  });
  test('scope copy is rebuilt from the SIGNED includedScope key — hostile scopeNote/scopeExclusions on a validly signed row are discarded (GH codex)', () => {
    const hostile = { ...signed(), scopeNote: 'We treat the whole building and your neighbors too.', scopeExclusions: [] };
    const { band: trusted } = trustedUnitBand({ address: ADDRESS, unitBandPricing: { pest: hostile } }, 'pest');
    expect(trusted.scopeNote).toBe(SCOPE_NOTES.interior_unit_general_pest);
    expect(trusted.scopeExclusions).toEqual(SCOPE_EXCLUSIONS.interior_unit_general_pest);
    const line = generateEstimate({
      services: { pest: { frequency: 'quarterly' } }, propertyType: 'unknown', stories: 1, isCommercial: false,
      address: ADDRESS, unitBandPricing: { pest: hostile },
    }).lineItems.find((l) => l.service === 'pest_control');
    expect(line.pricingBasis).toBe('caller_stated_bedroom_count');
    expect(line.scopeNote).toBe(SCOPE_NOTES.interior_unit_general_pest);
  });
  test('KEYRING: a rotated signing secret keeps every persisted snapshot verifying via _PREVIOUS + kid; a dropped key fails closed (hook P0)', () => {
    const signedUnderOld = signed(); // signed under TEST_SECRET (JWT bootstrap fallback)
    expect(signedUnderOld.kid).toMatch(/^[0-9a-f]{8}$/);
    withEnv('PRICING_SNAPSHOT_SECRET', 'brand-new-pricing-secret', () => {
      // New key signs new rows under a different kid…
      const fresh = signed();
      expect(fresh.kid).not.toBe(signedUnderOld.kid);
      expect(verdict({ address: ADDRESS, unitBandPricing: { pest: fresh } }, 'pest').status).toBe('trusted');
      // …and the old row no longer verifies UNLESS the old secret is kept in the ring.
      expect(verdict({ address: ADDRESS, unitBandPricing: { pest: signedUnderOld } }, 'pest')).toEqual({ status: 'untrusted', reason: 'signature' });
      withEnv('PRICING_SNAPSHOT_SECRET_PREVIOUS', `retired-key-1, ${TEST_SECRET}`, () => {
        expect(verdict({ address: ADDRESS, unitBandPricing: { pest: signedUnderOld } }, 'pest').status).toBe('trusted');
        // A dedicated secret means JWT_SECRET is never consulted for signing.
        expect(signed().kid).toBe(fresh.kid);
      });
    });
    // A row without a kid, or with a kid the ring never carried, cannot verify.
    expect(verdict({ address: ADDRESS, unitBandPricing: { pest: { ...signedUnderOld, kid: undefined } } }, 'pest').status).toBe('untrusted');
    expect(verdict({ address: ADDRESS, unitBandPricing: { pest: { ...signedUnderOld, kid: 'deadbeef' } } }, 'pest').status).toBe('untrusted');
  });
  test('without the server secret nothing signs and nothing verifies; the resolver reports it instead of pricing', async () => {
    await withEnv('JWT_SECRET', undefined, async () => {
      expect(signUnitBandSnapshot(row(), ADDRESS)).toBeNull();
      expect(trustedUnitBand({ address: ADDRESS, unitBandPricing: { pest: signed() } }, 'pest').status).toBe('untrusted');
      const out = await withGate('true', () => resolveUnitBandPricing(fakeDb(seedRows()), {
        intent: unitIntent(), unitScope: unitScope(), propertyFacts: unitFacts(), extraction: extractionWithBedrooms(1),
      }));
      expect(out.unresolved).toBe('no_signing_secret');
      expect(out.pest).toBeUndefined();
    });
  });
  test('the engine never prices a hand-built snapshot from its dollars — it fails closed', () => {
    const hostile = {
      services: { pest: { frequency: 'quarterly' } }, propertyType: 'unknown', stories: 1, isCommercial: false,
      address: ADDRESS,
      unitBandPricing: { pest: { ...row(), recurringPrice: 1, sig: 'f'.repeat(64) } },
    };
    const line = generateEstimate(hostile).lineItems.find((l) => l.service === 'pest_control');
    expect(line.quoteRequired).toBe(true);
    expect(line.perApp).toBe(0);
  });
});

describe('band pricers (never a footprint)', () => {
  const band = () => ({
    band: 'one_bedroom', recurringPrice: 85, initialPrice: 85, includedScope: 'interior_unit_general_pest',
    scopeExclusions: SCOPE_EXCLUSIONS.interior_unit_general_pest, effectiveDate: '2026-08-13', intentFrequency: 'quarterly',
  });
  test('recurring: per-visit IS the band; quarterly and bi-monthly tiers only, same perApp; no review', () => {
    const q = pricePestControlUnitBand({ propertyType: 'unknown' }, { band: band(), frequency: 'quarterly', bedroomCount: 1 });
    expect(q).toMatchObject({
      service: 'pest_control', basePrice: 85, perApp: 85, annual: 340, monthly: 28.33, visitsPerYear: 4,
      pricingVersion: 'unit_band', pricingBasis: 'caller_stated_bedroom_count', pricingBand: 'one_bedroom',
      pricingBandLabel: '1 bedroom', bedroomCount: 1, footprintUsed: null, footprintSource: 'bedroom_band',
      footprintWasDefaulted: false, requiresManualReview: false, pricingConfidence: 'high', roachType: 'none',
      includedScope: 'interior_unit_general_pest',
    });
    expect(q.tiers.map((t) => [t.frequency, t.perApp, t.annual])).toEqual([['quarterly', 85, 340], ['bimonthly', 85, 510]]);
    expect(q.scopeExclusions).toEqual(SCOPE_EXCLUSIONS.interior_unit_general_pest);
    expect(Number.isFinite(q.costs.annualCost)).toBe(true);
    const b = pricePestControlUnitBand({}, { band: { ...band(), intentFrequency: 'bimonthly' }, frequency: 'bimonthly' });
    expect(b).toMatchObject({ perApp: 85, annual: 510, monthly: 42.5, visitsPerYear: 6, frequency: 'bimonthly' });
  });
  test('recurring: refuses monthly and a non-positive band', () => {
    expect(() => pricePestControlUnitBand({}, { band: band(), frequency: 'monthly' })).toThrow(/no band for cadence/);
    expect(() => pricePestControlUnitBand({}, { band: { ...band(), recurringPrice: 0 } })).toThrow(/positive band/);
  });
  test('one-time: the seeded row is the pre-urgency price; urgency + recurring-customer discount + floor stack in the footprint pricer\'s order', () => {
    const base = priceOneTimePestUnitBand({}, { band: { ...band(), recurringPrice: 199 }, recurringPerVisit: 85 });
    expect(base).toMatchObject({ service: 'one_time_pest', price: 199, preUrgencyPrice: 199, baseSource: 'unit_band_row', pricingBasis: 'caller_stated_bedroom_count', footprintUsed: null, requiresManualReview: false, recurringVisitOneCost: 184, recurringIncentiveClampApplied: false });
    const discounted = priceOneTimePestUnitBand({}, { band: { ...band(), recurringPrice: 239.8 }, isRecurringCustomer: true });
    expect(discounted.price).toBeGreaterThanOrEqual(discounted.selectedFloor);
    expect(discounted.price).toBeLessThanOrEqual(240);
    expect(discounted.recurringCustomerDiscountAmount).toBeCloseTo(239.8 - discounted.price, 2);
  });
  test('one-time: DB-authoritative cents survive — an unmodified $202.40 / $217.80 / $239.80 row reaches the customer exactly (hook P0)', () => {
    for (const seeded of [202.4, 217.8, 239.8]) {
      const r = priceOneTimePestUnitBand({}, { band: { ...band(), recurringPrice: seeded } });
      expect(r.price).toBe(seeded);
      expect(r.preUrgencyPrice).toBe(seeded);
      expect(r.subtotalBeforeRecurringCustomerDiscount).toBe(seeded);
      expect(r.recurringCustomerDiscountAmount).toBe(0);
    }
    // Urgency keeps cent precision too (no whole-dollar rounding step).
    const urgent = priceOneTimePestUnitBand({}, { band: { ...band(), recurringPrice: 202.4 }, urgency: 'SAME_DAY' });
    expect(Number.isInteger(Math.round(urgent.price * 100))).toBe(true);
    expect(urgent.price).toBe(Math.round(202.4 * urgent.urgencyMultiplier * 100) / 100);
  });
  test('both pricers carry the customer scope line; the one-time row exposes it as `detail` for the legacy mapper', () => {
    const note = 'Interior of your unit only — test note.';
    const rec = pricePestControlUnitBand({}, { band: { ...band(), scopeNote: note }, frequency: 'quarterly' });
    expect(rec.scopeNote).toBe(note);
    const ot = priceOneTimePestUnitBand({}, { band: { ...band(), recurringPrice: 199, scopeNote: note } });
    expect(ot.scopeNote).toBe(note);
    expect(ot.detail).toBe(note);
  });
  test('the footprint pricer is unchanged by the shared cost model extraction', () => {
    const p = pricePestControl({ homeSqFt: 1600, propertyType: 'single_family', stories: 1 }, { frequency: 'quarterly' });
    expect(Number.isFinite(p.costs.annualCost)).toBe(true);
    expect(Number.isFinite(p.margin)).toBe(true);
    expect(p.footprintSource).toBe('homeSqFt');
  });
});

describe('pricing engine wiring', () => {
  const ADDRESS = '1400 Lakefront Dr Apt 7109, Sarasota, FL 34240';
  const signedRow = (r) => ({ ...r, ...signUnitBandSnapshot(r, ADDRESS) });
  const bandInput = (services, extra = {}) => ({
    services, propertyType: 'unknown', stories: 1, isCommercial: false, address: ADDRESS,
    unitBandPricing: {
      eligible: true, pricingBasis: 'caller_stated_bedroom_count', sizeBasis: 'bedroom_band', pricingBand: 'one_bedroom', bedroomCount: 1,
      pest: signedRow({ serviceCode: 'pest', frequency: 'quarterly', intentFrequency: 'quarterly', band: 'one_bedroom', recurringPrice: 85, initialPrice: 85, includedScope: 'interior_unit_general_pest', oversizeSqftThreshold: 2200, scopeExclusions: [], effectiveDate: '2026-08-13' }),
      pestCadences: {
        quarterly: signedRow({ serviceCode: 'pest', frequency: 'quarterly', band: 'one_bedroom', recurringPrice: 85, initialPrice: 85, includedScope: 'interior_unit_general_pest', oversizeSqftThreshold: 2200, effectiveDate: '2026-08-13' }),
        bi_monthly: signedRow({ serviceCode: 'pest', frequency: 'bi_monthly', band: 'one_bedroom', recurringPrice: 85, initialPrice: 85, includedScope: 'interior_unit_general_pest', oversizeSqftThreshold: 2200, effectiveDate: '2026-08-13' }),
      },
      oneTimePest: signedRow({ serviceCode: 'oneTimePest', frequency: 'one_time', band: 'one_bedroom', recurringPrice: 199, initialPrice: 199, includedScope: 'interior_unit_general_pest', oversizeSqftThreshold: 2200, scopeExclusions: [], effectiveDate: '2026-08-13' }),
      missing: [], parked: {}, unresolved: null,
    },
    ...extra,
  });
  test('band rows on the input price the pest lines from the table; unrelated lines untouched', () => {
    const r = generateEstimate(bandInput({ pest: { frequency: 'quarterly' }, oneTimePest: {} }));
    const pest = r.lineItems.find((l) => l.service === 'pest_control');
    const oneTime = r.lineItems.find((l) => l.service === 'one_time_pest');
    expect(pest).toMatchObject({ perApp: 85, annual: 340, pricingBasis: 'caller_stated_bedroom_count', requiresManualReview: false });
    expect(oneTime).toMatchObject({ price: 199, pricingBasis: 'caller_stated_bedroom_count', recurringVisitOneCost: 184 });
    expect(r.summary.oneTimeTotal).toBe(199);
  });
  test('parked/absent keys fall back to the footprint pricer exactly as before', () => {
    const withoutRows = bandInput({ pest: { frequency: 'monthly' } });
    delete withoutRows.unitBandPricing.pest;
    delete withoutRows.unitBandPricing.pestCadences;
    delete withoutRows.unitBandPricing.oneTimePest;
    withoutRows.unitBandPricing.parked = { pest: 'monthly_frequency' };
    const parked = generateEstimate(withoutRows).lineItems.find((l) => l.service === 'pest_control');
    const legacy = generateEstimate({ services: { pest: { frequency: 'monthly' } }, propertyType: 'unknown', stories: 1, isCommercial: false })
      .lineItems.find((l) => l.service === 'pest_control');
    expect(parked.perApp).toBe(legacy.perApp);
    expect(parked.footprintSource).toBe(legacy.footprintSource);
    expect(parked.pricingBasis).toBeUndefined();
  });
  test('a commercial property never band-prices (manual quote path unchanged)', () => {
    const r = generateEstimate(bandInput({ pest: { frequency: 'quarterly' } }, { isCommercial: true, propertyType: 'commercial', commercialSubtype: 'office' }));
    expect(r.lineItems.some((l) => l.pricingBasis)).toBe(false);
  });
});

describe('draft builder — engine input + lane', () => {
  const context = () => ({
    isExistingCustomer: false, extractionSource: 'enriched', smsThread: [],
    transcript: 'Caller: quarterly pest control for my apartment, it is a one bedroom.',
  });
  const bandAudit = (overrides = {}) => ({
    eligible: true, pricingBasis: 'caller_stated_bedroom_count', sizeBasis: 'bedroom_band', pricingBand: 'one_bedroom',
    bedroomCount: 1, bedroomSource: 'call_extraction', missing: [], parked: {}, unresolved: null,
    pest: { frequency: 'quarterly', band: 'one_bedroom', recurringPrice: 85, initialPrice: 85 },
    ...overrides,
  });
  const bandLine = () => ({ service: 'pest_control', monthly: 28.33, annual: 340, perApp: 85, pricingConfidence: 'high', pricingBasis: 'caller_stated_bedroom_count', footprintUsed: null, requiresManualReview: false });
  const fallbackLine = () => ({ service: 'pest_control', monthly: 37.33, annual: 448, pricingConfidence: 'low', requiresManualReview: true, manualReviewReasons: ['footprint fallback'] });
  const args = (overrides = {}) => ({
    intent: unitIntent(),
    propertyFacts: unitFacts(),
    engineResult: { summary: {}, lineItems: [bandLine()] },
    engineInput: { unitBandPricing: bandAudit() },
    totals: { monthly: 28.33, annual: 340, oneTime: 0 },
    comps: { samples: 10, median: 30, outlier: false, insufficient: false },
    calibration: [],
    context: context(),
    ...overrides,
  });

  test('buildEngineInput forwards the resolved band; omits the key when null (kill switch = byte-identical input)', () => {
    const base = { intent: unitIntent(), propertyFacts: unitFacts(), context: {}, lookupEnriched: null };
    const withBand = buildEngineInput({ ...base, unitBandPricing: bandAudit() });
    expect(withBand.unitBandPricing.pest.recurringPrice).toBe(85);
    expect(withBand.homeSqFt).toBeUndefined();
    const without = buildEngineInput({ ...base, unitBandPricing: null });
    expect('unitBandPricing' in without).toBe(false);
    expect(without).toEqual(buildEngineInput(base));
  });
  test('the trigger shape lands GREEN: 1BR tenant, unresolved sqft, lot not applicable, band-priced pest', () => {
    const { lane, reasons } = classifyLane(args());
    expect(reasons).toEqual([]);
    expect(lane).toBe(LANES.GREEN);
  });
  test('the unresolved home sqft still parks a NON-band residential line on the same draft', () => {
    const { lane, reasons } = classifyLane(args({
      engineResult: { summary: {}, lineItems: [bandLine(), { service: 'mosquito', monthly: 60, annual: 720, pricingConfidence: 'high' }] },
      intent: unitIntent({ pest: { frequency: 'quarterly' }, mosquito: {} }),
    }));
    expect(lane).toBe(LANES.YELLOW);
    expect(reasons.some((r) => /home\/building sqft from fallback source/.test(r))).toBe(true);
  });
  test('missing bedroom count → yellow with the ask spelled out (fallback-priced line)', () => {
    const { lane, reasons } = classifyLane(args({
      engineResult: { summary: {}, lineItems: [fallbackLine()] },
      engineInput: { unitBandPricing: bandAudit({ missing: ['bedroom_count'], pricingBand: null, bedroomCount: null, pest: undefined }) },
      totals: { monthly: 37.33, annual: 448, oneTime: 0 },
    }));
    expect(lane).toBe(LANES.YELLOW);
    expect(reasons.some((r) => /no stated bedroom count/.test(r))).toBe(true);
  });
  test('monthly cadence and an unavailable rate each park with their own reason', () => {
    const monthly = classifyLane(args({
      intent: unitIntent({ pest: { frequency: 'monthly' } }),
      engineResult: { summary: {}, lineItems: [fallbackLine()] },
      engineInput: { unitBandPricing: bandAudit({ parked: { pest: 'monthly_frequency' }, pest: undefined }) },
    }));
    expect(monthly.reasons.some((r) => /monthly cadence on a residential unit/.test(r))).toBe(true);
    const unresolved = classifyLane(args({
      engineResult: { summary: {}, lineItems: [fallbackLine()] },
      engineInput: { unitBandPricing: bandAudit({ unresolved: 'no_rate_row', pest: undefined }) },
    }));
    expect(unresolved.reasons.some((r) => /band rate unavailable \(no_rate_row\)/.test(r))).toBe(true);
  });
  test('propertyTypeUnresolved parks ONLY when a pest-family line priced off the type', () => {
    const facts = unitFacts({ propertyTypeUnresolved: true });
    const suppressed = classifyLane(args({ propertyFacts: facts }));
    expect(suppressed.reasons.some((r) => /property type unresolved/.test(r))).toBe(false);
    const mixed = classifyLane(args({
      propertyFacts: facts,
      intent: unitIntent({ pest: { frequency: 'quarterly' }, oneTimePest: {} }),
      engineResult: { summary: {}, lineItems: [bandLine(), { service: 'one_time_pest', price: 250, pricingConfidence: 'high' }] },
    }));
    expect(mixed.reasons.some((r) => /property type unresolved/.test(r))).toBe(true);
    const noBand = classifyLane(args({ propertyFacts: facts, engineResult: { summary: {}, lineItems: [{ service: 'pest_control', monthly: 39, annual: 468, pricingConfidence: 'high' }] }, engineInput: {} }));
    expect(noBand.reasons.some((r) => /property type unresolved/.test(r))).toBe(true);
  });
  test('no band audit on the input ⇒ lane logic is exactly today\'s', () => {
    const { lane, reasons } = classifyLane(args({
      engineResult: { summary: {}, lineItems: [fallbackLine()] }, engineInput: {},
    }));
    expect(lane).toBe(LANES.YELLOW);
    expect(reasons.some((r) => /no stated bedroom count|monthly cadence|band rate/.test(r))).toBe(false);
  });
});

describe('composer intent + prompt addendum', () => {
  test('unit_bedroom_count is optional, bounded, and nullable', () => {
    expect(validateIntent(unitIntent()).valid).toBe(true);
    expect(validateIntent(unitIntent(undefined, { unit_bedroom_count: 0 })).valid).toBe(true);
    expect(validateIntent(unitIntent(undefined, { unit_bedroom_count: null })).valid).toBe(true);
    expect(validateIntent(unitIntent(undefined, { unit_bedroom_count: 21 })).valid).toBe(false);
    expect(validateIntent(unitIntent(undefined, { unit_bedroom_count: 1.5 })).valid).toBe(false);
  });
  test('the bedroom addendum is appended ONLY with the gate on (gate-off prompt byte-identical)', () => {
    const off = withGate(undefined, () => composerPriv.buildSystemPrompt());
    const on = withGate('true', () => composerPriv.buildSystemPrompt());
    expect(off.includes('unit_bedroom_count')).toBe(false);
    expect(on.endsWith(composerPriv.UNIT_BAND_ADDENDUM)).toBe(true);
    expect(on.startsWith(off)).toBe(true);
  });
});

describe('call extraction schema — property.bedroom_count', () => {
  const property = (extra) => ({
    service_address: { raw_text: null, street_line_1: null, street_line_2: null, city: null, state: null, postal_code: null, county: null, subdivision_or_community: null, normalization_status: 'not_attempted' },
    property_type: 'multi_family', hoa_community_flag: false, hoa_common_area_service: false, ...extra,
  });
  const errorsFor = (fn, data) => (fn(data).errors || []).map((e) => e.instancePath);
  test('both schemas accept an integer or null and reject out-of-range', () => {
    for (const fn of [validateModelOutput, validatePersisted]) {
      expect(errorsFor(fn, { property: property({ bedroom_count: 1 }) }).some((p) => p.includes('bedroom_count'))).toBe(false);
      expect(errorsFor(fn, { property: property({ bedroom_count: null }) }).some((p) => p.includes('bedroom_count'))).toBe(false);
      expect(errorsFor(fn, { property: property({ bedroom_count: 30 }) }).some((p) => p.includes('bedroom_count'))).toBe(true);
      expect(errorsFor(fn, { property: property({ bedroom_count: 'two' }) }).some((p) => p.includes('bedroom_count'))).toBe(true);
    }
  });
});
