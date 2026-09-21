/**
 * Unassessed vacant parcel: the county roll knows the parcel but carries no
 * building — an unbuilt lot, or new construction between plat and the next
 * roll posting. Real case this encodes (live-probed 2026-07-15, just-platted
 * Manatee/Parrish parcel): CUR_MAN_LUC_DESC "Vacant Residential Platted
 * (1554)", CUR_DOR_LUC_CODE '00', every BLDG_* field null, lot sqft on the
 * roll. The lookup must (a) name the situation — conservatively, since the
 * roll can't split empty-lot from new-build — instead of the misleading
 * "estimated from lot size" copy (no lot-size estimator exists; the 2,000
 * sqft is a flat default), and (b) cache the record on a short TTL, enforced
 * on write AND read, so it self-heals once the county posts the home.
 */

let mockDbHandler = () => { throw new Error('db handler not configured'); };

jest.mock('../models/db', () => {
  const mock = jest.fn((...args) => mockDbHandler(...args));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { detectUnassessedVacantParcel } = require('../services/property-lookup/ai-property-lookup');
const { saveLookup, getCachedLookup } = require('../services/property-lookup/lookup-cache');
const { buildEnrichedProfile } = require('../routes/property-lookup-v2');
const { buildFieldVerifyFlags, subdivisionMedianEstimate } = require('../routes/property-lookup-v2')._private;

// Merged-record shape for the probed case: county GIS matched (lot + land
// use on _parcel), no building facts anywhere. Fictional parcel identity.
function vacantRecord(overrides = {}) {
  return {
    squareFootage: null,
    yearBuilt: null,
    lotSize: 10500,
    _parcel: {
      parcelId: '999990001',
      county: 'Manatee',
      dorUseCode: '00',
      landUseDescription: 'Vacant Residential Platted (1554)',
    },
    ...overrides,
  };
}

function fakeTable({ row = null, writes = [] } = {}) {
  const builder = {
    where() { return builder; },
    first: async () => row,
    insert(payload) {
      return {
        onConflict: () => ({
          merge: async () => { writes.push(payload); },
        }),
      };
    },
  };
  return builder;
}

afterEach(() => {
  delete process.env.PROPERTY_LOOKUP_CACHE_TTL_DAYS;
  delete process.env.PROPERTY_LOOKUP_VACANT_TTL_DAYS;
  mockDbHandler = () => { throw new Error('db handler not configured'); };
});

describe('detectUnassessedVacantParcel', () => {
  it('detects a vacant-platted parcel with no building facts', () => {
    const hit = detectUnassessedVacantParcel(vacantRecord());
    expect(hit).toBeTruthy();
    expect(hit.landUseDescription).toBe('Vacant Residential Platted (1554)');
    expect(hit.dorUseCode).toBe('00');
  });

  it('detects via DOR vacant-residential code alone in every county form', () => {
    for (const code of ['00', '000', '0000']) {
      const rec = vacantRecord();
      rec._parcel = { dorUseCode: code };
      expect(detectUnassessedVacantParcel(rec)).toBeTruthy();
    }
  });

  it('detects via _raw land use when a PAO record won the merge', () => {
    const rec = vacantRecord();
    rec._parcel = {};
    rec._raw = { landUseDescription: 'VACANT RESIDENTIAL', subdivision: 'EXAMPLE LAKES' };
    const hit = detectUnassessedVacantParcel(rec);
    expect(hit).toBeTruthy();
    expect(hit.subdivision).toBe('EXAMPLE LAKES');
  });

  it('detects via _raw.landUse — the only surviving copy on pre-change cached rows', () => {
    // preserveCountyGisLandUse parks the county text under _raw.landUse when
    // a PAO record wins the merge; rows cached before _parcel carried
    // landUseDescription have nothing else for the read-side TTL to key on.
    const rec = vacantRecord();
    rec._parcel = {};
    rec._raw = { landUse: 'Vacant Residential' };
    expect(detectUnassessedVacantParcel(rec)).toBeTruthy();
    // The synthesized commercial landUse form must not read as vacant.
    rec._raw = { landUse: 'DOR use code 10 — commercial/industrial' };
    expect(detectUnassessedVacantParcel(rec)).toBeNull();
  });

  it('never fires once any building fact exists (incl. a verified override)', () => {
    expect(detectUnassessedVacantParcel(vacantRecord({ squareFootage: 2400 }))).toBeNull();
    expect(detectUnassessedVacantParcel(vacantRecord({ yearBuilt: 2026 }))).toBeNull();
  });

  it('never fires on built land uses or non-vacant DOR codes', () => {
    const sfr = vacantRecord();
    sfr._parcel = { dorUseCode: '01', landUseDescription: 'Single Family' };
    expect(detectUnassessedVacantParcel(sfr)).toBeNull();
    // Sarasota 4-digit SFR county code — leading zeros must not read as vacant.
    const sarasota = vacantRecord();
    sarasota._parcel = { dorUseCode: '0100' };
    expect(detectUnassessedVacantParcel(sarasota)).toBeNull();
    expect(detectUnassessedVacantParcel(null)).toBeNull();
    // No parcel/land-use signal at all (AI-only record) — never fires.
    expect(detectUnassessedVacantParcel({ squareFootage: null, yearBuilt: null })).toBeNull();
  });
});

describe('buildFieldVerifyFlags — vacant-parcel copy', () => {
  it('names both possible states and corrects the sq ft copy on a vacant parcel', () => {
    const flags = buildFieldVerifyFlags(vacantRecord(), null, null);
    const situation = flags.find((f) => f.field === 'vacantParcel');
    expect(situation).toBeTruthy();
    expect(situation.priority).toBe('HIGH');
    expect(situation.reason).toContain('Vacant Residential Platted');
    // Conservative wording: the roll can't split empty-lot from new-build.
    expect(situation.reason).toContain('unbuilt lot');
    expect(situation.reason).toContain('new construction');
    const sqft = flags.find((f) => f.field === 'homeSqFt');
    expect(sqft.reason).toContain('vacant parcel');
    expect(sqft.reason).toContain('2,000');
    // The old copy claimed an estimator that doesn't exist.
    expect(JSON.stringify(flags)).not.toContain('estimated from lot size');
  });

  it('keeps an honest default-applied message when sq ft is missing without the vacant signal', () => {
    const rec = vacantRecord();
    rec._parcel = { dorUseCode: '01', landUseDescription: 'Single Family' };
    const flags = buildFieldVerifyFlags(rec, null, null);
    expect(flags.find((f) => f.field === 'vacantParcel')).toBeUndefined();
    const sqft = flags.find((f) => f.field === 'homeSqFt');
    expect(sqft.reason).toContain('defaults to 2,000');
    expect(sqft.reason).not.toContain('estimated from lot size');
  });
});

// Plat-median stamp the fresh lookup path writes for a vacant parcel whose
// plat already has assessed neighbors (shape from a 2026-09-21 live probe of
// a Lakewood Ranch plat: 174 assessed homes, median 3,071 sq ft, 2,101–3,242;
// fictional plat name).
function platMedianStamp(overrides = {}) {
  return {
    medianSqft: 3070.5,
    sampleCount: 174,
    minSqft: 2101,
    maxSqft: 3242,
    p25: 2650,
    p75: 3180,
    subdivisionQueried: 'EXAMPLE ESPLANADE PH VI SUBPH A & B PB80/131',
    county: 'Manatee',
    ...overrides,
  };
}

describe('subdivisionMedianEstimate — plat median for an unassessed vacant parcel', () => {
  it('exposes the rounded median, sample count, range, and plat while the parcel is unassessed', () => {
    const est = subdivisionMedianEstimate(vacantRecord({ _subdivisionMedian: platMedianStamp() }));
    expect(est).toEqual({
      medianSqft: 3071,
      sampleCount: 174,
      minSqft: 2101,
      maxSqft: 3242,
      subdivision: 'EXAMPLE ESPLANADE PH VI SUBPH A & B PB80/131',
      county: 'Manatee',
      sourceLabel: 'median of 174 assessed homes in this plat',
    });
  });

  it('disappears the moment a real building fact lands (roll posting or a verified sqft)', () => {
    expect(subdivisionMedianEstimate(vacantRecord({ _subdivisionMedian: platMedianStamp(), squareFootage: 2980 }))).toBeNull();
    expect(subdivisionMedianEstimate(vacantRecord({ _subdivisionMedian: platMedianStamp(), yearBuilt: 2026 }))).toBeNull();
  });

  it('refuses a thin sample or a non-positive median', () => {
    expect(subdivisionMedianEstimate(vacantRecord({ _subdivisionMedian: platMedianStamp({ sampleCount: 7 }) }))).toBeNull();
    expect(subdivisionMedianEstimate(vacantRecord({ _subdivisionMedian: platMedianStamp({ medianSqft: 0 }) }))).toBeNull();
    expect(subdivisionMedianEstimate(vacantRecord())).toBeNull();
    expect(subdivisionMedianEstimate(null)).toBeNull();
  });

  it('tolerates a stamp without a range (older helper shape)', () => {
    const est = subdivisionMedianEstimate(vacantRecord({ _subdivisionMedian: platMedianStamp({ minSqft: undefined, maxSqft: undefined }) }));
    expect(est).toMatchObject({ medianSqft: 3071, minSqft: null, maxSqft: null });
  });
});

describe('buildEnrichedProfile — plat median rides beside an EMPTY homeSqFt', () => {
  it('surfaces subdivisionMedian on a vacant parcel without claiming a measurement', () => {
    const profile = buildEnrichedProfile(vacantRecord({ _subdivisionMedian: platMedianStamp() }), null, 27.47, -82.39);
    expect(profile.unassessedVacantParcel).toBe(true);
    expect(profile.homeSqFt).toBe(0);
    expect(profile.fieldEvidence.squareFootage).toBeUndefined();
    expect(profile.subdivisionMedian).toMatchObject({ medianSqft: 3071, sampleCount: 174, minSqft: 2101, maxSqft: 3242 });
  });

  it('is null when the address audit could not confirm the parcel (snapped house number)', () => {
    const audit = { snappedRecord: { typed: '1010', record: '1012' }, hasExactMatch: false, streetExists: true, county: 'Manatee', nearestNumbers: [] };
    const profile = buildEnrichedProfile(vacantRecord({ _subdivisionMedian: platMedianStamp() }), null, 27.47, -82.39, null, audit);
    expect(profile.fieldVerifyFlags.some((f) => f.field === 'address')).toBe(true);
    expect(profile.subdivisionMedian).toBeNull();
  });

  it('is null without the stamp and null once the record carries a home', () => {
    expect(buildEnrichedProfile(vacantRecord(), null, 27.47, -82.39).subdivisionMedian).toBeNull();
    const built = buildEnrichedProfile(vacantRecord({ _subdivisionMedian: platMedianStamp(), squareFootage: 2980, yearBuilt: 2026 }), null, 27.47, -82.39);
    expect(built.subdivisionMedian).toBeNull();
    expect(built.homeSqFt).toBe(2980);
  });
});

describe('buildFieldVerifyFlags — plat-median sq ft copy', () => {
  it('names the median, sample count, and range, and asks for customer confirmation', () => {
    const flags = buildFieldVerifyFlags(vacantRecord({ _subdivisionMedian: platMedianStamp() }), null, null);
    const sqft = flags.find((f) => f.field === 'homeSqFt');
    expect(sqft.priority).toBe('HIGH');
    expect(sqft.reason).toContain('vacant parcel');
    expect(sqft.reason).toContain('174 assessed homes');
    expect(sqft.reason).toContain('3,071 sq ft');
    expect(sqft.reason).toContain('range 2,101–3,242');
    expect(sqft.reason).toContain('confirm the size with the customer');
    // The flat-default wording is gone: the estimator no longer prices on 2,000 here.
    expect(sqft.reason).not.toContain('2,000');
    // The situation flag is unchanged — the roll still can't split lot from build.
    expect(flags.find((f) => f.field === 'vacantParcel')).toBeTruthy();
  });

  it('uses the median-free copy when the address audit could not confirm the parcel', () => {
    const audit = { snappedRecord: { typed: '1010', record: '1012' }, hasExactMatch: false, streetExists: true, county: 'Manatee', nearestNumbers: [] };
    const flags = buildFieldVerifyFlags(vacantRecord({ _subdivisionMedian: platMedianStamp() }), null, audit);
    expect(flags.some((f) => f.field === 'address')).toBe(true);
    const sqft = flags.find((f) => f.field === 'homeSqFt');
    expect(sqft.reason).toContain('defaults to 2,000');
    expect(JSON.stringify(flags)).not.toMatch(/3,071|174 assessed/);
  });

  it('omits the range when the stamp has none and keeps the default copy for a thin sample', () => {
    const noRange = buildFieldVerifyFlags(vacantRecord({ _subdivisionMedian: platMedianStamp({ minSqft: null, maxSqft: null }) }), null, null)
      .find((f) => f.field === 'homeSqFt');
    expect(noRange.reason).toContain('3,071 sq ft');
    expect(noRange.reason).not.toContain('range');
    const thin = buildFieldVerifyFlags(vacantRecord({ _subdivisionMedian: platMedianStamp({ sampleCount: 5 }) }), null, null)
      .find((f) => f.field === 'homeSqFt');
    expect(thin.reason).toContain('defaults to 2,000');
  });
});

describe('saveLookup — vacant-parcel TTL (write side)', () => {
  function lookupResult(record) {
    return {
      propertyRecord: record,
      aiAnalysis: { estimatedTurfSf: 0 },
      satellite: { lat: 27.58, lng: -82.42 },
      meta: { lookupMs: 1000 },
    };
  }

  function daysUntil(expiresAt) {
    return (new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  }

  it('caches a vacant-parcel record for ~21 days instead of 180', async () => {
    const writes = [];
    mockDbHandler = () => fakeTable({ writes });
    await saveLookup('123 New Plat Loop, Parrish, FL 34219', lookupResult(vacantRecord()));
    expect(writes.length).toBe(1);
    expect(daysUntil(writes[0].expires_at)).toBeGreaterThan(20);
    expect(daysUntil(writes[0].expires_at)).toBeLessThan(22);
  });

  it('keeps the full TTL for records with building facts', async () => {
    const writes = [];
    mockDbHandler = () => fakeTable({ writes });
    await saveLookup('100 Main St', lookupResult(vacantRecord({ squareFootage: 1800, propertyType: 'Single Family' })));
    expect(daysUntil(writes[0].expires_at)).toBeGreaterThan(179);
  });

  it('honors PROPERTY_LOOKUP_VACANT_TTL_DAYS and never exceeds the base TTL', async () => {
    const writes = [];
    mockDbHandler = () => fakeTable({ writes });
    process.env.PROPERTY_LOOKUP_VACANT_TTL_DAYS = '7';
    await saveLookup('100 Main St', lookupResult(vacantRecord()));
    expect(daysUntil(writes[0].expires_at)).toBeLessThan(8);

    // Base TTL shorter than the vacant TTL → the shorter wins.
    delete process.env.PROPERTY_LOOKUP_VACANT_TTL_DAYS;
    process.env.PROPERTY_LOOKUP_CACHE_TTL_DAYS = '10';
    await saveLookup('100 Main St', lookupResult(vacantRecord()));
    expect(daysUntil(writes[1].expires_at)).toBeLessThan(11);
  });
});

describe('getCachedLookup — vacant-parcel TTL (read side)', () => {
  function cachedRow({ record, savedDaysAgo }) {
    const savedAt = savedDaysAgo == null
      ? null
      : new Date(Date.now() - savedDaysAgo * 24 * 60 * 60 * 1000);
    return {
      property_record: record,
      // Pre-short-TTL rows carry the base 180-day expiry — the exact case
      // the read clamp exists for.
      expires_at: new Date(Date.now() + 170 * 24 * 60 * 60 * 1000),
      lat: 27.58,
      lng: -82.42,
      data_saved_at: savedAt,
      verified_overrides: {},
    };
  }

  it('treats a vacant-parcel row older than the short TTL as a miss despite its stored expiry', async () => {
    mockDbHandler = () => fakeTable({ row: cachedRow({ record: vacantRecord(), savedDaysAgo: 30 }) });
    expect(await getCachedLookup('100 Main St')).toBeNull();
  });

  it('still serves a vacant-parcel row inside the short TTL', async () => {
    mockDbHandler = () => fakeTable({ row: cachedRow({ record: vacantRecord(), savedDaysAgo: 3 }) });
    expect(await getCachedLookup('100 Main St')).toBeTruthy();
  });

  it('fails toward the live lookup when a vacant-parcel row has no data timestamp', async () => {
    mockDbHandler = () => fakeTable({ row: cachedRow({ record: vacantRecord(), savedDaysAgo: null }) });
    expect(await getCachedLookup('100 Main St')).toBeNull();
  });

  it('leaves built-record rows on the stored expiry', async () => {
    mockDbHandler = () => fakeTable({
      row: cachedRow({ record: vacantRecord({ squareFootage: 1800, propertyType: 'Single Family' }), savedDaysAgo: 90 }),
    });
    expect(await getCachedLookup('100 Main St')).toBeTruthy();
  });
});
