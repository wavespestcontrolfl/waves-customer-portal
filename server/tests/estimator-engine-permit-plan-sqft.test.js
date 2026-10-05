/**
 * The estimator engine prices a new home off its building permit's plan
 * (address-match R2-B): resolveHomeSqft ranks the permit's conditioned area
 * above the plat median and below county and the caller, as a FALLBACK
 * source (yellow lane); gatherPropertySignals hands the engine only the
 * profile's exposed object (never the raw record stamp).
 */
jest.mock('../models/db', () => {
  const mock = jest.fn(() => { throw new Error('db not expected'); });
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const lookupResult = { current: null };
jest.mock('../routes/property-lookup-v2', () => ({
  performPropertyLookup: jest.fn(async () => lookupResult.current),
}));
jest.mock('../services/property-lookup/county-parcel-gis', () => {
  const actual = jest.requireActual('../services/property-lookup/county-parcel-gis');
  return { ...actual, lookupSubdivisionMedianLivingSqft: jest.fn(async () => null) };
});

const { resolvePropertyFacts, SQFT_SOURCES, FALLBACK_SQFT_SOURCES, _private: { resolveHomeSqft } } = require('../services/estimator-engine/source-arbitration');
const { _private: { gatherPropertySignals } } = require('../services/estimator-engine');

const PERMIT = { conditionedSqft: 2314, permitNo: 'BLD2503-01234' };
const MEDIAN = { medianSqft: 3071, sampleCount: 174 };
const vacantParcel = { county: 'Manatee', parcelId: '999990002', unassessedVacant: true, livingAreaSqft: null, yearBuilt: null, landUseDescription: 'Vacant Residential Platted (1554)', subdivision: 'EXAMPLE PLAT' };

describe('resolveHomeSqft — permit plan rung', () => {
  it('beats the plat median and the lookup estimate, as a fallback source', () => {
    const home = resolveHomeSqft({ extraction: null, parcel: vacantParcel, lookupSqft: 1900, isCommercial: false, subdivisionMedian: MEDIAN, permitFacts: PERMIT });
    expect(home).toMatchObject({ value: 2314, source: SQFT_SOURCES.PERMIT_PLAN, confidence: 'medium', permitNo: 'BLD2503-01234' });
    expect(FALLBACK_SQFT_SOURCES.has(SQFT_SOURCES.PERMIT_PLAN)).toBe(true);
  });

  it('yields to a county living area and to a caller-stated size', () => {
    const county = resolveHomeSqft({ extraction: null, parcel: { ...vacantParcel, unassessedVacant: false, livingAreaSqft: 2300, yearBuilt: 2025 }, lookupSqft: 2300, isCommercial: false, subdivisionMedian: null, permitFacts: PERMIT });
    expect(county).toMatchObject({ value: 2300, source: SQFT_SOURCES.COUNTY_ASSESSED });
    const stated = resolveHomeSqft({ extraction: { property: { approximate_living_sqft: 2500 } }, parcel: vacantParcel, lookupSqft: null, isCommercial: false, subdivisionMedian: null, permitFacts: PERMIT });
    expect(stated.source).toBe(SQFT_SOURCES.CALLER_STATED);
  });

  it('is absent by default: the median and lookup rungs are unchanged without permit facts', () => {
    const median = resolveHomeSqft({ extraction: null, parcel: vacantParcel, lookupSqft: null, isCommercial: false, subdivisionMedian: MEDIAN });
    expect(median.source).toBe(SQFT_SOURCES.SUBDIVISION_MEDIAN);
    const none = resolveHomeSqft({ extraction: null, parcel: null, lookupSqft: null, isCommercial: false, subdivisionMedian: null, permitFacts: null });
    expect(none.source).toBe(SQFT_SOURCES.NONE);
  });

  it('threads through resolvePropertyFacts', () => {
    const facts = resolvePropertyFacts({ extraction: { property: {} }, propertyRecord: { squareFootage: null, _parcel: vacantParcel }, customer: null, isCommercial: false, subdivisionMedian: MEDIAN, permitFacts: PERMIT });
    expect(facts.home).toMatchObject({ value: 2314, source: SQFT_SOURCES.PERMIT_PLAN });
    expect(facts.newConstruction).toBe(true);
  });
});

describe('gatherPropertySignals — permit facts come from the profile only', () => {
  const CONTEXT = {
    serviceAddressOverride: { street_line_1: '1010 Example Loop', city: 'Lakewood Ranch', state: 'FL', zip: '34211' },
    extraction: { property: {} },
  };

  it('hands the engine the exposed object', async () => {
    lookupResult.current = {
      propertyRecord: { squareFootage: null, _permitBuildingFacts: { ...PERMIT, stories: 2 } },
      enriched: { homeSqFt: 0, permitBuildingFacts: { ...PERMIT, underRoofSqft: 3102, stories: 2, sourceLabel: 'Manatee building permit BLD2503-01234, issued Mar 2025' } },
    };
    const signals = await gatherPropertySignals(CONTEXT, { persistLookup: false });
    expect(signals.permitFacts).toEqual({ conditionedSqft: 2314, permitNo: 'BLD2503-01234' });
  });

  it('never reads the raw record stamp when the profile withheld (null) or lacks (undefined) it', async () => {
    lookupResult.current = {
      propertyRecord: { squareFootage: 2300, _permitBuildingFacts: PERMIT },
      enriched: { homeSqFt: 2300, permitBuildingFacts: null },
    };
    expect((await gatherPropertySignals(CONTEXT, { persistLookup: false })).permitFacts).toBeNull();
    lookupResult.current = {
      propertyRecord: { squareFootage: null, _permitBuildingFacts: PERMIT },
      enriched: { homeSqFt: 0 },
    };
    expect((await gatherPropertySignals(CONTEXT, { persistLookup: false })).permitFacts).toBeNull();
  });
});
