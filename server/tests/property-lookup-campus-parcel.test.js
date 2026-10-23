/**
 * Campus parcel context. An office park can record six buildings under one
 * county address: a typed building number then has no roll row, the map
 * point sits well inside the campus parcel, and the lookup keeps that parcel
 * as context (address-match PR 6). This suite covers what the panel shows
 * from it: the county building list (Manatee), the address flag copy, and
 * the meta field. Context only — nothing here is a size or price input.
 * Synthetic fixtures only: no real address or parcel id.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { _private: lookupPrivate } = require('../services/property-lookup/ai-property-lookup');
const { buildEnrichedProfile } = require('../routes/property-lookup-v2');
const { buildFieldVerifyFlags, campusParcelMeta } = require('../routes/property-lookup-v2')._private;

const { groupParentParcelBuildings } = lookupPrivate;

// The PAO building table shape (cols + rows).
const COLS = ['Type', 'Bldg', 'Classification', 'Yrblt', 'Effyr', 'Stories', 'UnRoof', 'LivBus']
  .map((title) => ({ title }));
const row = (bldg, classification, stories, livBus) => ['COM', String(bldg), classification, '2007', '2014', stories, String(livBus), String(livBus)];

describe('the parent parcel building list', () => {
  test('identical buildings group into one line; the largest group comes first', () => {
    const table = {
      cols: COLS,
      rows: [
        row(1, 'RETAIL', 1, 40000),
        row(2, 'OFFICE BUILDING', 1, 5000),
        row(3, 'OFFICE BUILDING', 1, 5000),
        row(4, 'OFFICE BUILDING', 1, 5000),
        row(5, 'HOTEL/MOTEL', 4, 60000),
      ],
    };
    const out = groupParentParcelBuildings(table);
    expect(out.total).toBe(5);
    expect(out.groups[0]).toEqual({ classification: 'OFFICE BUILDING', stories: 1, sqft: 5000, count: 3 });
    expect(out.groups).toHaveLength(3);
    expect(out.moreGroups).toBe(0);
  });

  test('rows without an area are skipped; an empty or unreadable table is no list', () => {
    expect(groupParentParcelBuildings({ cols: COLS, rows: [row(1, 'OFFICE BUILDING', 1, 0)] })).toBeNull();
    expect(groupParentParcelBuildings(null)).toBeNull();
    expect(groupParentParcelBuildings({ cols: [], rows: [] })).toBeNull();
  });

  test('at most eight lines; the rest is a count', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1, 'RETAIL', 1, 1000 + i));
    const out = groupParentParcelBuildings({ cols: COLS, rows });
    expect(out.groups).toHaveLength(8);
    expect(out.moreGroups).toBe(2);
  });
});

const campusRecord = (over = {}) => ({
  _source: 'ai',
  _parentParcel: {
    parcelId: '1000000000',
    county: 'Manatee',
    situsAddress: '900 EXAMPLE PARK BLVD',
    landUseDescription: 'Mixed Use Commercial (1555)',
    buildings: { total: 6, groups: [{ classification: 'OFFICE BUILDING', stories: 1, sqft: 5000, count: 6 }], moreGroups: 0 },
  },
  ...over,
});

const notOnRoll = {
  county: 'Manatee', houseNumber: 950, streetLabel: 'EXAMPLE PARK BLVD',
  streetExists: true, hasExactMatch: false, parcelCount: 5, nearestNumbers: [900, 910],
};

describe('campusParcelMeta', () => {
  test('a record carrying a parent parcel and no county evidence gives the panel its context', () => {
    expect(campusParcelMeta(campusRecord())).toEqual({
      parcelId: '1000000000',
      county: 'Manatee',
      situsAddress: '900 EXAMPLE PARK BLVD',
      landUseDescription: 'Mixed Use Commercial (1555)',
      buildings: expect.objectContaining({ total: 6 }),
    });
  });

  test('no parent parcel, no record, or a roll-vouched record → null', () => {
    expect(campusParcelMeta({ _source: 'ai' })).toBeNull();
    expect(campusParcelMeta(null)).toBeNull();
    expect(campusParcelMeta(campusRecord({ _source: 'county' }))).toBeNull();
  });
});

describe('the address flag on a campus parcel', () => {
  test('names the parcel the point sits in and warns against its size, not a typo', () => {
    const rc = campusRecord();
    const addr = buildFieldVerifyFlags(rc, null, notOnRoll, { campusParcel: campusParcelMeta(rc) }).find((f) => f.field === 'address');
    expect(addr.priority).toBe('HIGH');
    expect(addr.reason).toContain('900 EXAMPLE PARK BLVD (Mixed Use Commercial)');
    expect(addr.reason).toContain("do not price from that parcel's size");
    expect(addr.reason).not.toContain('These are context only');
  });

  test('without a parent parcel the house-number copy is unchanged', () => {
    const addr = buildFieldVerifyFlags({ _source: 'ai' }, null, notOnRoll).find((f) => f.field === 'address');
    expect(addr.reason).toContain('could not match house number 950');
    expect(addr.reason).toContain('900, 910');
  });
});

describe('who gets the campus wording in the profile', () => {
  afterEach(() => { delete process.env.GATE_LOOKUP_BUSINESS_IDENTITY; delete process.env.GATE_COMMERCIAL_SUITE_SIZING; });
  const addressReason = (options) => {
    const profile = buildEnrichedProfile(campusRecord(), null, 27.4, -82.5, null, notOnRoll, '950 Example Park Blvd', options);
    return (profile.fieldVerifyFlags || []).find((f) => f.field === 'address')?.reason || '';
  };

  test('an opted-in caller with the gate live gets it', () => {
    process.env.GATE_COMMERCIAL_SUITE_SIZING = 'true';
    process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'true';
    expect(addressReason({ commercialSuiteSizing: true })).toContain('900 EXAMPLE PARK BLVD');
  });

  test('a public caller, or the gate off, keeps the house-number copy and never names the parcel', () => {
    process.env.GATE_COMMERCIAL_SUITE_SIZING = 'true';
    process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'true';
    expect(addressReason({})).not.toContain('900 EXAMPLE PARK BLVD (');
    expect(addressReason({})).toContain('could not match house number 950');
    delete process.env.GATE_LOOKUP_BUSINESS_IDENTITY;
    expect(addressReason({ commercialSuiteSizing: true })).toContain('could not match house number 950');
  });
});
