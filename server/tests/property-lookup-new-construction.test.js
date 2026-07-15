/**
 * Pending new construction: the county roll knows the (vacant) parcel but not
 * the home — plat filed, building not assessed yet. Real case this encodes
 * (live-probed 2026-07-15, just-platted Manatee/Parrish parcel):
 * CUR_MAN_LUC_DESC "Vacant Residential Platted (1554)", CUR_DOR_LUC_CODE
 * '00', every BLDG_* field null, lot sqft on the roll. The lookup must (a) name the
 * situation instead of the misleading "estimated from lot size" copy — no
 * lot-size estimator exists, the 2,000 sqft is a flat default — and (b) cache
 * the record on a short TTL so it self-heals once the county posts the home.
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

const { detectPendingNewConstruction } = require('../services/property-lookup/ai-property-lookup');
const { saveLookup } = require('../services/property-lookup/lookup-cache');
const { buildFieldVerifyFlags } = require('../routes/property-lookup-v2')._private;

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

function fakeTable({ writes = [] } = {}) {
  const builder = {
    where() { return builder; },
    first: async () => null,
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
  delete process.env.PROPERTY_LOOKUP_NEWCONST_TTL_DAYS;
  mockDbHandler = () => { throw new Error('db handler not configured'); };
});

describe('detectPendingNewConstruction', () => {
  it('detects a vacant-platted parcel with no building facts', () => {
    const hit = detectPendingNewConstruction(vacantRecord());
    expect(hit).toBeTruthy();
    expect(hit.landUseDescription).toBe('Vacant Residential Platted (1554)');
    expect(hit.dorUseCode).toBe('00');
  });

  it('detects via DOR vacant-residential code alone in every county form', () => {
    for (const code of ['00', '000', '0000']) {
      const rec = vacantRecord();
      rec._parcel = { dorUseCode: code };
      expect(detectPendingNewConstruction(rec)).toBeTruthy();
    }
  });

  it('detects via _raw land use when a PAO record won the merge', () => {
    const rec = vacantRecord();
    rec._parcel = {};
    rec._raw = { landUseDescription: 'VACANT RESIDENTIAL', subdivision: 'PARRISH LAKES' };
    const hit = detectPendingNewConstruction(rec);
    expect(hit).toBeTruthy();
    expect(hit.subdivision).toBe('PARRISH LAKES');
  });

  it('never fires once any building fact exists (incl. a verified override)', () => {
    expect(detectPendingNewConstruction(vacantRecord({ squareFootage: 2400 }))).toBeNull();
    expect(detectPendingNewConstruction(vacantRecord({ yearBuilt: 2026 }))).toBeNull();
  });

  it('never fires on built land uses or non-vacant DOR codes', () => {
    const sfr = vacantRecord();
    sfr._parcel = { dorUseCode: '01', landUseDescription: 'Single Family' };
    expect(detectPendingNewConstruction(sfr)).toBeNull();
    // Sarasota 4-digit SFR county code — leading zeros must not read as vacant.
    const sarasota = vacantRecord();
    sarasota._parcel = { dorUseCode: '0100' };
    expect(detectPendingNewConstruction(sarasota)).toBeNull();
    expect(detectPendingNewConstruction(null)).toBeNull();
    // No parcel/land-use signal at all (AI-only record) — never fires.
    expect(detectPendingNewConstruction({ squareFootage: null, yearBuilt: null })).toBeNull();
  });
});

describe('buildFieldVerifyFlags — new-construction copy', () => {
  it('names the situation and corrects the sq ft copy on a vacant parcel', () => {
    const flags = buildFieldVerifyFlags(vacantRecord(), null, null);
    const situation = flags.find((f) => f.field === 'newConstruction');
    expect(situation).toBeTruthy();
    expect(situation.priority).toBe('HIGH');
    expect(situation.reason).toContain('Vacant Residential Platted');
    const sqft = flags.find((f) => f.field === 'homeSqFt');
    expect(sqft.reason).toContain('new construction');
    expect(sqft.reason).toContain('2,000');
    // The old copy claimed an estimator that doesn't exist.
    expect(JSON.stringify(flags)).not.toContain('estimated from lot size');
  });

  it('keeps an honest default-applied message when sq ft is missing without the vacant signal', () => {
    const rec = vacantRecord();
    rec._parcel = { dorUseCode: '01', landUseDescription: 'Single Family' };
    const flags = buildFieldVerifyFlags(rec, null, null);
    expect(flags.find((f) => f.field === 'newConstruction')).toBeUndefined();
    const sqft = flags.find((f) => f.field === 'homeSqFt');
    expect(sqft.reason).toContain('defaults to 2,000');
    expect(sqft.reason).not.toContain('estimated from lot size');
  });
});

describe('saveLookup — pending-new-construction TTL', () => {
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
    await saveLookup('100 Main St', lookupResult(vacantRecord({ squareFootage: 1800 })));
    expect(daysUntil(writes[0].expires_at)).toBeGreaterThan(179);
  });

  it('honors PROPERTY_LOOKUP_NEWCONST_TTL_DAYS and never exceeds the base TTL', async () => {
    const writes = [];
    mockDbHandler = () => fakeTable({ writes });
    process.env.PROPERTY_LOOKUP_NEWCONST_TTL_DAYS = '7';
    await saveLookup('100 Main St', lookupResult(vacantRecord()));
    expect(daysUntil(writes[0].expires_at)).toBeLessThan(8);

    // Base TTL shorter than the new-construction TTL → the shorter wins.
    delete process.env.PROPERTY_LOOKUP_NEWCONST_TTL_DAYS;
    process.env.PROPERTY_LOOKUP_CACHE_TTL_DAYS = '10';
    await saveLookup('100 Main St', lookupResult(vacantRecord()));
    expect(daysUntil(writes[1].expires_at)).toBeLessThan(11);
  });
});
