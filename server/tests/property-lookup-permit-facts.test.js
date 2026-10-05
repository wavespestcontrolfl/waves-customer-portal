/**
 * Permit building facts in the property lookup (address-match round 2, R2-B,
 * GATE_LOOKUP_PERMIT_FACTS). A new home the Manatee roll has not posted yet
 * (the parcel is still "Vacant Residential Platted", or the typed address
 * has no county record at all) carries its own building permit's plan
 * figures in construction_permit_records (collected by R2-A). Pins: the
 * fresh path stamps _permitBuildingFacts on the record, the enriched profile
 * exposes it ONLY beside an empty homeSqFt and only while the gate is live,
 * the sq ft verify flag names the permit, a permit story count fills an empty
 * record count, and a built record (roll posted) hides it again.
 */

let mockDbHandler = () => { throw new Error('db handler not configured'); };

jest.mock('../models/db', () => {
  const mock = jest.fn((...args) => mockDbHandler(...args));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const trioRecord = { current: null };
jest.mock('../services/property-lookup/ai-property-lookup', () => {
  const actual = jest.requireActual('../services/property-lookup/ai-property-lookup');
  return {
    ...actual,
    lookupPropertyFromAITrio: jest.fn(async () => trioRecord.current()),
    lookupStoriesFromAI: jest.fn(async () => null),
    lookupStoriesEvidenceFromAI: jest.fn(async () => null),
  };
});
jest.mock('../services/property-lookup/county-parcel-gis', () => {
  const actual = jest.requireActual('../services/property-lookup/county-parcel-gis');
  return { ...actual, lookupSubdivisionMedianLivingSqft: jest.fn(async () => null) };
});

const permitFacts = { current: null, calls: [] };
jest.mock('../services/property-lookup/manatee-permit-detail', () => ({
  findPermitBuildingFacts: jest.fn(async (args) => {
    permitFacts.calls.push({ parcelPin: args.parcelPin, looseKey: args.looseKey, hasStreetCheck: typeof args.addressMatches === 'function' });
    const out = permitFacts.current;
    if (out instanceof Error) throw out;
    // The real reader applies the caller's street check to every
    // address-tier candidate; mirror that for the one candidate here.
    if (out && out.matchedBy === 'address' && typeof args.addressMatches === 'function' && !args.addressMatches(out.addressRaw)) return null;
    return out;
  }),
}));

const { performPropertyLookup } = require('../routes/property-lookup-v2');
const { permitBuildingFactsEstimate } = require('../routes/property-lookup-v2')._private;

const ADDRESS = '1010 Example Loop, Lakewood Ranch, FL 34211';
const PLAT = 'EXAMPLE PLAT PH I PB80/131';

const FACTS = {
  source: 'manatee_permit_detail',
  matchedBy: 'parcel',
  addressRaw: '1010 EXAMPLE LP  LAKEWOOD RANCH 34211',
  permitNo: 'BLD2503-01234',
  typeOfWork: 'New Single Family',
  issuedAt: '2025-03-14T00:00:00.000Z',
  coIssuedAt: null,
  fetchedAt: '2025-10-05T08:05:00.000Z',
  conditionedSqft: 2314,
  underRoofSqft: 3102,
  stories: 2,
  bedrooms: 4,
  bathrooms: 2.5,
};

function vacantTrioRecord(overrides = {}) {
  return {
    formattedAddress: ADDRESS,
    county: 'Manatee',
    squareFootage: null,
    yearBuilt: null,
    lotSize: 9541,
    stories: null,
    propertyType: 'Single Family',
    hasPool: false,
    _provider: 'manatee_gis',
    _source: 'county',
    _aiProviders: ['manatee_gis'],
    _fieldEvidence: {
      lotSize: { value: 9541, sourceType: 'county', fieldVerify: false, evidence: [] },
    },
    _raw: { county: 'Manatee', dorUseCode: '00', landUseDescription: 'Vacant Residential Platted (1554)', subdivision: PLAT },
    _parcel: {
      parcelId: '999990002',
      paoParcelId: '9999900029',
      county: 'Manatee',
      polygon: null,
      polygonAreaSqft: 9580,
      lotSqft: 9541,
      dorUseCode: '00',
      landUseDescription: 'Vacant Residential Platted (1554)',
      subdivision: PLAT,
    },
    ...overrides,
  };
}

// The new-plat miss: no county record at all, only a satellite/AI record.
function noCountyTrioRecord(overrides = {}) {
  return {
    formattedAddress: ADDRESS,
    squareFootage: null,
    yearBuilt: null,
    lotSize: null,
    stories: null,
    propertyType: 'Single Family',
    hasPool: false,
    _provider: 'satellite',
    _source: 'ai',
    _aiProviders: ['satellite'],
    _fieldEvidence: {},
    _raw: {},
    ...overrides,
  };
}

function fakeTable() {
  const builder = {
    where() { return builder; },
    whereIn() { return builder; },
    orderBy() { return builder; },
    first: async () => null,
    update: async () => {},
    insert() {
      const done = Promise.resolve();
      return {
        onConflict: () => ({ merge: async () => {} }),
        then: (...args) => done.then(...args),
        catch: (...args) => done.catch(...args),
      };
    },
  };
  return builder;
}

const savedEnv = {};
const KEYS = ['GOOGLE_MAPS_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'COUNTY_PARCEL_GIS_DISABLED', 'GATE_LOOKUP_PERMIT_FACTS'];
const originalFetch = global.fetch;

beforeEach(() => {
  for (const key of KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  process.env.GOOGLE_MAPS_API_KEY = 'current-maps-key';
  process.env.GATE_LOOKUP_PERMIT_FACTS = 'true';
  mockDbHandler = () => fakeTable();
  permitFacts.current = { ...FACTS };
  permitFacts.calls.length = 0;
  trioRecord.current = () => vacantTrioRecord();

  global.fetch = jest.fn(async (url) => {
    const urlText = String(url);
    if (urlText.includes('geocode')) {
      return {
        ok: true,
        json: async () => ({
          status: 'OK',
          results: [{
            formatted_address: '1010 Example Loop, Lakewood Ranch, FL 34211, USA',
            types: ['street_address'],
            geometry: { location: { lat: 27.4678, lng: -82.3852 }, location_type: 'ROOFTOP' },
            address_components: [{ long_name: 'Manatee County', types: ['administrative_area_level_2'] }],
          }],
        }),
      };
    }
    if (urlText.includes('staticmap')) {
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    }
    // Only the plat-median query is answered (empty: no neighbors yet); every
    // other county call, the house-number audit included, fails open like
    // the median suite so no 'address' flag is raised by the stub.
    if (urlText.includes('gis.manateepao.gov') && urlText.includes('BLDGS_SQFT_LIVING')) {
      return { ok: true, json: async () => ({ features: [] }) };
    }
    throw new Error(`unexpected fetch: ${urlText}`);
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const key of KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('performPropertyLookup — permit building facts for a new home the roll has not posted', () => {
  it('stamps the permit facts on an unassessed parcel and exposes them beside an empty homeSqFt', async () => {
    const result = await performPropertyLookup(ADDRESS, { refresh: true });

    // Parcel tier with the Manatee pin, loose key from the typed address.
    expect(permitFacts.calls).toEqual([{ parcelPin: '9999900029', looseKey: '1010example34211', hasStreetCheck: true }]);
    expect(result.propertyRecord._permitBuildingFacts).toMatchObject({ permitNo: 'BLD2503-01234', conditionedSqft: 2314 });
    // Never a measurement: the record and the profile still carry no home sqft.
    expect(result.propertyRecord.squareFootage).toBeNull();
    expect(result.enriched.homeSqFt).toBe(0);
    expect(result.enriched.permitBuildingFacts).toEqual({
      conditionedSqft: 2314,
      underRoofSqft: 3102,
      stories: 2,
      bedrooms: 4,
      bathrooms: 2.5,
      permitNo: 'BLD2503-01234',
      issuedAt: '2025-03-14T00:00:00.000Z',
      coIssuedAt: null,
      sourceLabel: 'Manatee building permit BLD2503-01234, issued Mar 2025',
    });
    // The permit's story count fills the empty record count, and says so.
    expect(result.enriched.stories).toBe(2);
    expect(result.enriched.storiesSource).toBe('permit');
    const sqftFlag = result.enriched.fieldVerifyFlags.find((f) => f.field === 'homeSqFt');
    expect(sqftFlag.priority).toBe('HIGH');
    expect(sqftFlag.reason).toContain('Manatee building permit BLD2503-01234, issued Mar 2025');
    expect(sqftFlag.reason).toContain('2,314 sq ft conditioned, 3,102 sq ft under roof, 2 stories');
    expect(sqftFlag.reason).toContain('confirm the size with the customer');
  });

  it('reads the loose-key tier alone for an address with no county record (the new-plat miss)', async () => {
    trioRecord.current = () => noCountyTrioRecord();
    permitFacts.current = { ...FACTS, matchedBy: 'address' };
    const result = await performPropertyLookup(ADDRESS, { refresh: true });
    expect(permitFacts.calls).toEqual([{ parcelPin: null, looseKey: '1010example34211', hasStreetCheck: true }]);
    expect(result.enriched.permitBuildingFacts).toMatchObject({ conditionedSqft: 2314, permitNo: 'BLD2503-01234' });
    // No lot size on this record: the flag still names the permit.
    const sqftFlag = result.enriched.fieldVerifyFlags.find((f) => f.field === 'homeSqFt');
    expect(sqftFlag.reason).toContain('BLD2503-01234');
  });

  it('hands the reader a full-street check: another street on the same loose key is nothing on file', async () => {
    trioRecord.current = () => noCountyTrioRecord();
    // "1010 Example Way" shares the loose key (1010 + example + 34211) with the typed "1010 Example Loop".
    permitFacts.current = { ...FACTS, matchedBy: 'address', addressRaw: '1010 EXAMPLE WAY  LAKEWOOD RANCH 34211' };
    let result = await performPropertyLookup(ADDRESS, { refresh: true });
    expect(result.propertyRecord._permitBuildingFacts).toBeNull();
    expect(result.enriched.permitBuildingFacts).toBeNull();
    // No job address on the permit row: fail closed.
    permitFacts.current = { ...FACTS, matchedBy: 'address', addressRaw: null };
    result = await performPropertyLookup(ADDRESS, { refresh: true });
    expect(result.propertyRecord._permitBuildingFacts).toBeNull();
    // A parcel-tier hit is the parcel's own permit: no street check needed.
    permitFacts.current = { ...FACTS, matchedBy: 'parcel', addressRaw: null };
    trioRecord.current = () => vacantTrioRecord();
    result = await performPropertyLookup(ADDRESS, { refresh: true });
    expect(result.enriched.permitBuildingFacts).toMatchObject({ permitNo: 'BLD2503-01234' });
  });

  it('passes no parcel pin for a non-Manatee parcel (pin formats collide across counties)', async () => {
    trioRecord.current = () => vacantTrioRecord({
      county: 'Sarasota',
      _raw: { county: 'Sarasota', dorUseCode: '0000', landUseDescription: 'Vacant Residential', subdivision: PLAT },
      _parcel: { parcelId: '0123456789', paoParcelId: '0123456789', county: 'Sarasota', dorUseCode: '0000', landUseDescription: 'Vacant Residential', subdivision: PLAT, lotSqft: 9541 },
    });
    permitFacts.current = null;
    const result = await performPropertyLookup(ADDRESS, { refresh: true });
    expect(permitFacts.calls).toEqual([{ parcelPin: null, looseKey: '1010example34211', hasStreetCheck: true }]);
    // Checked, nothing on file: an explicit null stamp, no profile estimate.
    expect(result.propertyRecord._permitBuildingFacts).toBeNull();
    expect(result.enriched.permitBuildingFacts).toBeNull();
    expect(result.enriched.storiesSource).toBe('default');
  });

  it('is byte-identical with the gate off: no read, no stamp, no profile field', async () => {
    delete process.env.GATE_LOOKUP_PERMIT_FACTS;
    const result = await performPropertyLookup(ADDRESS, { refresh: true });
    expect(permitFacts.calls).toHaveLength(0);
    expect(result.propertyRecord._permitBuildingFacts).toBeUndefined();
    expect(result.enriched.permitBuildingFacts).toBeUndefined();
    expect(result.enriched.stories).toBe(1);
    expect(result.enriched.storiesSource).toBe('default');
    const sqftFlag = result.enriched.fieldVerifyFlags.find((f) => f.field === 'homeSqFt');
    expect(sqftFlag.reason).not.toContain('permit');
  });

  it('fails open: a thrown read records an error and leaves the lookup otherwise intact', async () => {
    permitFacts.current = new Error('relation "construction_permit_records" does not exist');
    const result = await performPropertyLookup(ADDRESS, { refresh: true });
    expect(result.propertyRecord._permitBuildingFacts).toBeUndefined();
    expect(result.enriched.permitBuildingFacts).toBeUndefined();
    expect(result.errors.some((e) => e.source === 'permit-facts')).toBe(true);
    expect(result.enriched.homeSqFt).toBe(0);
  });

  it('steps aside once the record carries a home size, and does not move a known story count', async () => {
    trioRecord.current = () => vacantTrioRecord({
      squareFootage: 2300,
      yearBuilt: 2025,
      stories: 1,
      _storiesSource: 'verified',
      _fieldEvidence: { squareFootage: { value: 2300, sourceType: 'county', fieldVerify: false, evidence: [] } },
    });
    const result = await performPropertyLookup(ADDRESS, { refresh: true });
    expect(result.propertyRecord._permitBuildingFacts).toMatchObject({ permitNo: 'BLD2503-01234' });
    expect(result.enriched.homeSqFt).toBe(2300);
    // A stamp exists but is withheld: explicit null, not undefined.
    expect(result.enriched.permitBuildingFacts).toBeNull();
    expect(result.enriched.stories).toBe(1);
    expect(result.enriched.storiesSource).not.toBe('permit');
  });
});

describe('permitStreetMatchesTyped — full street line against the permit job address', () => {
  const { permitStreetMatchesTyped } = require('../routes/property-lookup-v2')._private;
  it('matches across suffix spellings, route aliases and a unit, and refuses a different street or no address', () => {
    expect(permitStreetMatchesTyped('200 Sample Trail, Parrish, FL 34219', '200 SAMPLE TRL  PARRISH 34219')).toBe(true);
    expect(permitStreetMatchesTyped('5805 Gentle Current Wy, Parrish, FL 34219', '5805 GENTLE CURRENT WAY  PARRISH 34219')).toBe(true);
    expect(permitStreetMatchesTyped('14617 FL-70 E Unit B, Bradenton, FL 34202', '14617 SR 70 E  BRADENTON 34202')).toBe(true);
    expect(permitStreetMatchesTyped('1010 Example Loop, Lakewood Ranch, FL 34211', '1010 EXAMPLE WAY  LAKEWOOD RANCH 34211')).toBe(false);
    expect(permitStreetMatchesTyped('1012 Example Loop, Lakewood Ranch, FL 34211', '1010 EXAMPLE LOOP  LAKEWOOD RANCH 34211')).toBe(false);
    expect(permitStreetMatchesTyped('1010 Example Loop, Lakewood Ranch, FL 34211', null)).toBe(false);
    expect(permitStreetMatchesTyped('Example Loop, Lakewood Ranch, FL 34211', 'EXAMPLE LOOP  LAKEWOOD RANCH 34211')).toBe(false);
  });
});

describe('permitBuildingFactsEstimate — read-side guards', () => {
  const rc = (facts, extra = {}) => ({ squareFootage: null, stories: null, _permitBuildingFacts: facts, ...extra });

  it('returns null with no stamp, an explicit null stamp, or the gate off', () => {
    expect(permitBuildingFactsEstimate({ squareFootage: null })).toBeNull();
    expect(permitBuildingFactsEstimate(rc(null))).toBeNull();
    delete process.env.GATE_LOOKUP_PERMIT_FACTS;
    expect(permitBuildingFactsEstimate(rc(FACTS))).toBeNull();
  });

  it('rejects an implausible conditioned area and a non-integer or out-of-range story count', () => {
    expect(permitBuildingFactsEstimate(rc({ ...FACTS, conditionedSqft: 120 }))).toBeNull();
    expect(permitBuildingFactsEstimate(rc({ ...FACTS, conditionedSqft: 40000 }))).toBeNull();
    expect(permitBuildingFactsEstimate(rc({ ...FACTS, conditionedSqft: null }))).toBeNull();
    expect(permitBuildingFactsEstimate(rc({ ...FACTS, stories: 1.5 })).stories).toBeNull();
    expect(permitBuildingFactsEstimate(rc({ ...FACTS, stories: 9 })).stories).toBeNull();
  });

  it('labels a permit with no issue date by number alone', () => {
    expect(permitBuildingFactsEstimate(rc({ ...FACTS, issuedAt: null })).sourceLabel).toBe('Manatee building permit BLD2503-01234');
  });
});
