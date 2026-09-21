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

  it('falls back to the record stamp only when the lookup returned NO profile', async () => {
    lookupResult.current = {
      propertyRecord: vacantRecord({ _subdivisionMedian: { medianSqft: 3071, sampleCount: 174, subdivisionQueried: PLAT, county: 'Manatee' } }),
      enriched: null,
    };
    const signals = await gatherPropertySignals(CONTEXT, { persistLookup: false });
    expect(signals.subdivisionMedian).toMatchObject({ medianSqft: 3071, sampleCount: 174 });
    expect(lookupSubdivisionMedianLivingSqft).not.toHaveBeenCalled();
  });

  it('respects a profile that nulled the median (unit-inside-a-building lookup) despite a record stamp', async () => {
    lookupResult.current = {
      propertyRecord: vacantRecord({ _subdivisionMedian: { medianSqft: 3071, sampleCount: 174, subdivisionQueried: PLAT, county: 'Manatee' } }),
      enriched: { homeSqFt: 0, unassessedVacantParcel: true, residentialUnitLookup: { wholePropertyCategory: 'residential' }, subdivisionMedian: null },
    };
    lookupSubdivisionMedianLivingSqft.mockResolvedValueOnce(null);
    const signals = await gatherPropertySignals(CONTEXT, { persistLookup: false });
    expect(signals.subdivisionMedian).toBeNull();
  });

  it('keeps the direct dig for a vacant row served without a stamp (pre-stamp cache rows)', async () => {
    lookupResult.current = { propertyRecord: vacantRecord(), enriched: { homeSqFt: 0, unassessedVacantParcel: true } };
    const signals = await gatherPropertySignals(CONTEXT, { persistLookup: false });
    expect(lookupSubdivisionMedianLivingSqft).toHaveBeenCalledTimes(1);
    expect(lookupSubdivisionMedianLivingSqft).toHaveBeenCalledWith({ county: 'Manatee', subdivision: PLAT });
    expect(signals.subdivisionMedian).toMatchObject({ medianSqft: 2277, sampleCount: 9 });
  });

  it('treats a below-floor record stamp as no stamp — never prices on a thin sample', async () => {
    lookupResult.current = {
      propertyRecord: vacantRecord({ _subdivisionMedian: { medianSqft: 3071, sampleCount: 7, subdivisionQueried: PLAT, county: 'Manatee' } }),
      enriched: { homeSqFt: 0, unassessedVacantParcel: true, subdivisionMedian: null },
    };
    lookupSubdivisionMedianLivingSqft.mockResolvedValueOnce(null);
    const signals = await gatherPropertySignals(CONTEXT, { persistLookup: false });
    expect(lookupSubdivisionMedianLivingSqft).toHaveBeenCalledTimes(1);
    expect(signals.subdivisionMedian).toBeNull();
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
