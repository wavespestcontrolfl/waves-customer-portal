/**
 * The call estimator's property dig must reuse the plat median the lookup's
 * fresh path already stamped on an unassessed vacant parcel
 * (property-lookup-v2: _subdivisionMedian / enriched.subdivisionMedian)
 * instead of querying the county layer a second time — and keep its own
 * direct dig only for rows served without a stamp.
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
  return { ...actual, lookupSubdivisionMedianLivingSqft: jest.fn(async () => ({ medianSqft: 2277, sampleCount: 9, minSqft: 1558, maxSqft: 3101 })) };
});

const { lookupSubdivisionMedianLivingSqft } = require('../services/property-lookup/county-parcel-gis');
const { _private: { gatherPropertySignals } } = require('../services/estimator-engine');

const PLAT = 'EXAMPLE ESPLANADE PH VI SUBPH A & B PB80/131';

function vacantRecord(extra = {}) {
  return {
    squareFootage: null,
    yearBuilt: null,
    lotSize: 9541,
    _raw: { county: 'Manatee', dorUseCode: '00', landUseDescription: 'Vacant Residential Platted (1554)', subdivision: PLAT },
    _parcel: { parcelId: '999990002', county: 'Manatee', lotSqft: 9541, dorUseCode: '00', landUseDescription: 'Vacant Residential Platted (1554)', subdivision: PLAT },
    ...extra,
  };
}

const CONTEXT = {
  serviceAddressOverride: { street_line_1: '1010 Example Loop', city: 'Lakewood Ranch', state: 'FL', zip: '34211' },
  extraction: { property: {} },
};

beforeEach(() => { lookupSubdivisionMedianLivingSqft.mockClear(); });

describe('gatherPropertySignals — plat median reuse', () => {
  it('reuses the lookup-stamped median and never re-queries the county layer', async () => {
    const stamp = { medianSqft: 3071, sampleCount: 174, minSqft: 2101, maxSqft: 3242 };
    lookupResult.current = {
      propertyRecord: vacantRecord({ _subdivisionMedian: { ...stamp, subdivisionQueried: PLAT, county: 'Manatee' } }),
      enriched: { homeSqFt: 0, unassessedVacantParcel: true, subdivisionMedian: { ...stamp, subdivision: PLAT, county: 'Manatee' } },
    };
    const signals = await gatherPropertySignals(CONTEXT, { persistLookup: false });
    expect(signals.parcelView.unassessedVacant).toBeTruthy();
    expect(signals.subdivisionMedian).toEqual({ medianSqft: 3071, sampleCount: 174 });
    expect(lookupSubdivisionMedianLivingSqft).not.toHaveBeenCalled();
  });

  it('never reads the raw record stamp — with no profile it runs the direct dig', async () => {
    lookupResult.current = {
      propertyRecord: vacantRecord({ _subdivisionMedian: { medianSqft: 3071, sampleCount: 174, subdivisionQueried: PLAT, county: 'Manatee' } }),
      enriched: null,
    };
    const signals = await gatherPropertySignals(CONTEXT, { persistLookup: false });
    expect(lookupSubdivisionMedianLivingSqft).toHaveBeenCalledTimes(1);
    expect(signals.subdivisionMedian).toMatchObject({ medianSqft: 2277, sampleCount: 9 });
  });

  it('respects a profile that nulled the median (unit-inside-a-building lookup) despite a record stamp', async () => {
    lookupResult.current = {
      propertyRecord: vacantRecord({ _subdivisionMedian: { medianSqft: 3071, sampleCount: 174, subdivisionQueried: PLAT, county: 'Manatee' } }),
      enriched: { homeSqFt: 0, unassessedVacantParcel: true, residentialUnitLookup: { wholePropertyCategory: 'residential' }, subdivisionMedian: null },
    };
    const signals = await gatherPropertySignals(CONTEXT, { persistLookup: false });
    expect(signals.subdivisionMedian).toBeNull();
    // ...and no direct dig either — that would price on what the profile refused.
    expect(lookupSubdivisionMedianLivingSqft).not.toHaveBeenCalled();
  });

  it('keeps the direct dig only when the lookup produced NO profile at all', async () => {
    lookupResult.current = { propertyRecord: vacantRecord(), enriched: null };
    const signals = await gatherPropertySignals(CONTEXT, { persistLookup: false });
    expect(lookupSubdivisionMedianLivingSqft).toHaveBeenCalledTimes(1);
    expect(lookupSubdivisionMedianLivingSqft).toHaveBeenCalledWith({ county: 'Manatee', subdivision: PLAT, lotSqft: 9541 });
    expect(signals.subdivisionMedian).toMatchObject({ medianSqft: 2277, sampleCount: 9 });
  });

  it('a thin-sample stamp the profile withheld (null) is final — never prices on it, never re-digs', async () => {
    lookupResult.current = {
      propertyRecord: vacantRecord({ _subdivisionMedian: { medianSqft: 3071, sampleCount: 7, subdivisionQueried: PLAT, county: 'Manatee' } }),
      enriched: { homeSqFt: 0, unassessedVacantParcel: true, subdivisionMedian: null },
    };
    const signals = await gatherPropertySignals(CONTEXT, { persistLookup: false });
    expect(lookupSubdivisionMedianLivingSqft).not.toHaveBeenCalled();
    expect(signals.subdivisionMedian).toBeNull();
  });

  it('keeps the direct dig for a pre-stamp cache row: a profile with NO median key is not a refusal', async () => {
    lookupResult.current = { propertyRecord: vacantRecord(), enriched: { homeSqFt: 0, unassessedVacantParcel: true } };
    const signals = await gatherPropertySignals(CONTEXT, { persistLookup: false });
    expect(lookupSubdivisionMedianLivingSqft).toHaveBeenCalledTimes(1);
    expect(signals.subdivisionMedian).toMatchObject({ medianSqft: 2277, sampleCount: 9 });
  });

  it('does not repeat a query the fresh lookup just attempted (outage / kill switch / budget)', async () => {
    lookupResult.current = { propertyRecord: vacantRecord(), enriched: { homeSqFt: 0, unassessedVacantParcel: true }, meta: { cache: 'miss' } };
    let signals = await gatherPropertySignals(CONTEXT, { persistLookup: false });
    expect(lookupSubdivisionMedianLivingSqft).not.toHaveBeenCalled();
    expect(signals.subdivisionMedian).toBeNull();
    // A cache HIT with no stamp is a legacy row: the direct dig still runs.
    lookupResult.current = { propertyRecord: vacantRecord(), enriched: { homeSqFt: 0, unassessedVacantParcel: true }, meta: { cache: 'hit' } };
    signals = await gatherPropertySignals(CONTEXT, { persistLookup: false });
    expect(lookupSubdivisionMedianLivingSqft).toHaveBeenCalledTimes(1);
    expect(signals.subdivisionMedian).toMatchObject({ medianSqft: 2277 });
  });

  it('never digs for a built parcel', async () => {
    lookupResult.current = {
      propertyRecord: vacantRecord({ squareFootage: 2980, yearBuilt: 2025, _parcel: { parcelId: '999990002', county: 'Manatee', dorUseCode: '01', landUseDescription: 'Single Family', subdivision: PLAT } }),
      enriched: { homeSqFt: 2980 },
    };
    const signals = await gatherPropertySignals(CONTEXT, { persistLookup: false });
    expect(signals.subdivisionMedian).toBeNull();
    expect(lookupSubdivisionMedianLivingSqft).not.toHaveBeenCalled();
  });
});
