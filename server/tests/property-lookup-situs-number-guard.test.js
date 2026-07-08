/**
 * Wrong-building GIS match guard.
 *
 * Live miss (2026-06-12, lead bdfd0037): wizard input "13649 Luxe Avenue,
 * Bradenton 34202" rooftop-geocoded into an apartment complex whose master
 * FDOR parcel is sited "13510 LUXE AVE APT 101" — a different building.
 * The by-parcel path then returned complex-level facts (1,048,472 sqft,
 * COMMERCIAL, 200k turf) as if they were the resident's building and the
 * wizard commercial-diverted a residential quote.
 *
 * These tests pin the guard: a GIS point match whose situs house number
 * disagrees with the typed address is dropped entirely (by-parcel detail,
 * cadastral record, and parcel meta all describe the wrong building) and
 * the lookup degrades to the typed-address county search — positive-only,
 * like the existing geo gates: missing or range house numbers never fire it.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/property-lookup/parcel-gis', () => ({
  lookupParcelByPoint: jest.fn(),
  parcelGisTimeoutMs: jest.fn(() => 4000),
}));
// County GIS layer is tried first; neutralize only its network lookup so the
// FDOR mock parcel above is the one the situs guard sees (this suite targets
// that guard, not county GIS). Pure helpers stay real via requireActual.
jest.mock('../services/property-lookup/county-parcel-gis', () => ({
  ...jest.requireActual('../services/property-lookup/county-parcel-gis'),
  lookupCountyParcelByPoint: jest.fn().mockResolvedValue(null),
}));

const logger = require('../services/logger');
const { lookupParcelByPoint } = require('../services/property-lookup/parcel-gis');
const {
  lookupPropertyFromAITrio,
  _private: aiPrivate,
} = require('../services/property-lookup/ai-property-lookup');

const {
  leadingHouseNumber,
  situsHouseNumberMismatch,
  situsHouseNumberExactMatch,
  houseNumberFromSourceUrl,
  aiRecordHouseNumberMismatch,
} = aiPrivate;

const TYPED = '13649 Luxe Avenue, Bradenton, FL 34211';
const GEO = {
  lat: 27.4458,
  lng: -82.4012,
  formattedAddress: '13649 Luxe Ave, Bradenton, FL 34211, USA',
  county: 'Manatee',
  state: 'FL',
  city: 'Bradenton',
  zip: '34211',
  partialMatch: false,
  locationType: 'ROOFTOP',
};

function complexParcel(overrides = {}) {
  return {
    parcelId: 'fdor-1',
    paoParcelId: '579902509',
    county: 'Manatee',
    situsAddress: '13510 LUXE AVE APT 101',
    situsCity: 'BRADENTON',
    situsZip: '34211',
    ...overrides,
  };
}

let fetchUrls;
const savedFetch = global.fetch;
const savedKeys = {};

beforeEach(() => {
  jest.clearAllMocks();
  fetchUrls = [];
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) {
    savedKeys[k] = process.env[k];
    delete process.env[k]; // AI fallbacks are key-gated → instant null in tests
  }
  global.fetch = jest.fn(async (url) => {
    fetchUrls.push(String(url));
    return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
  });
});

afterEach(() => {
  global.fetch = savedFetch;
  for (const [k, v] of Object.entries(savedKeys)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('leadingHouseNumber', () => {
  test('extracts the leading number from a typed address', () => {
    expect(leadingHouseNumber('13649 Luxe Avenue, Bradenton 34202')).toBe('13649');
  });
  test('null when the line has no leading number', () => {
    expect(leadingHouseNumber('LUXE AVE')).toBeNull();
    expect(leadingHouseNumber('APT 101')).toBeNull();
    expect(leadingHouseNumber('')).toBeNull();
    expect(leadingHouseNumber(null)).toBeNull();
  });
  test('range situs ("13500-13700 LUXE AVE") is not comparable', () => {
    expect(leadingHouseNumber('13500-13700 LUXE AVE')).toBeNull();
  });
  test('ordinal street names are not mistaken for a second number', () => {
    expect(leadingHouseNumber('1 2ND ST')).toBe('1');
  });
});

describe('situsHouseNumberMismatch', () => {
  test('fires on the live-miss pair: different building in the same complex', () => {
    expect(situsHouseNumberMismatch(
      '13649 Luxe Avenue, Bradenton 34202',
      '13510 LUXE AVE APT 101',
    )).toBe(true);
  });
  test('same building, different unit: no mismatch', () => {
    expect(situsHouseNumberMismatch(
      '13649 LUXE AVE APT 110, Bradenton',
      '13649 LUXE AVE APT 101',
    )).toBe(false);
  });
  test('suffix spelling differences never fire it', () => {
    expect(situsHouseNumberMismatch('13649 Luxe Avenue', '13649 LUXE AVE')).toBe(false);
  });
  test('positive-only: missing number on either side keeps today\'s behavior', () => {
    expect(situsHouseNumberMismatch('Luxe Avenue, Bradenton', '13510 LUXE AVE')).toBe(false);
    expect(situsHouseNumberMismatch('13649 Luxe Avenue', 'LUXE AVE')).toBe(false);
    expect(situsHouseNumberMismatch('13649 Luxe Avenue', null)).toBe(false);
  });
  test('positive-only: range situs keeps today\'s behavior', () => {
    expect(situsHouseNumberMismatch('13649 Luxe Avenue', '13500-13700 LUXE AVE')).toBe(false);
  });
});

describe('lookupPropertyFromAITrio GIS acceptance', () => {
  test('mismatching situs drops the GIS match: no by-parcel detail fetch, degrades to address search', async () => {
    lookupParcelByPoint.mockResolvedValue(complexParcel());

    const result = await lookupPropertyFromAITrio(TYPED, GEO);

    // By-parcel PAO detail (pao-model-land/buildings/features) never attempted…
    expect(fetchUrls.some((u) => u.includes('pao-model-land'))).toBe(false);
    expect(fetchUrls.some((u) => u.includes('pao-model-buildings'))).toBe(false);
    // …but the typed-address county search still ran.
    expect(fetchUrls.some((u) => u.includes('pao-model-parcel-search-results'))).toBe(true);
    // Degrade reason logged without address values (PII rule).
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('situs house number disagrees'),
    );
    // Every provider failed in this fixture → no record, and crucially no
    // complex-level cadastral/parcel data smuggled into a result.
    expect(result).toBeNull();
  });

  test('matching situs (same building number) keeps the by-parcel path', async () => {
    lookupParcelByPoint.mockResolvedValue(
      complexParcel({ situsAddress: '13649 LUXE AVE APT 101' }),
    );

    await lookupPropertyFromAITrio(TYPED, GEO);

    expect(fetchUrls.some((u) => u.includes('pao-model-land'))).toBe(true);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('situs house number disagrees'),
    );
  });

  test('GIS miss is untouched by the guard', async () => {
    lookupParcelByPoint.mockResolvedValue(null);

    await lookupPropertyFromAITrio(TYPED, GEO);

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('situs house number disagrees'),
    );
    expect(fetchUrls.some((u) => u.includes('pao-model-parcel-search-results'))).toBe(true);
  });
});

describe('lookupPropertyFromAITrio interpolated-geocode acceptance', () => {
  const GEO_INTERPOLATED = { ...GEO, locationType: 'RANGE_INTERPOLATED' };

  test('interpolated point + POSITIVE situs match keeps the by-parcel path', async () => {
    lookupParcelByPoint.mockResolvedValue(
      complexParcel({ situsAddress: '13649 LUXE AVE' }),
    );

    await lookupPropertyFromAITrio(TYPED, GEO_INTERPOLATED);

    expect(fetchUrls.some((u) => u.includes('pao-model-land'))).toBe(true);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('lacks a confirming situs house number'),
    );
  });

  test('interpolated point + BLANK situs (vacant developer lot) drops the parcel', async () => {
    lookupParcelByPoint.mockResolvedValue(
      complexParcel({ situsAddress: 'LUXE AVE' }),
    );

    const result = await lookupPropertyFromAITrio(TYPED, GEO_INTERPOLATED);

    expect(fetchUrls.some((u) => u.includes('pao-model-land'))).toBe(false);
    expect(fetchUrls.some((u) => u.includes('pao-model-parcel-search-results'))).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('lacks a confirming situs house number'),
    );
    expect(result).toBeNull();
  });

  test('interpolated point + mismatching situs drops the parcel via the existing guard', async () => {
    lookupParcelByPoint.mockResolvedValue(complexParcel());

    await lookupPropertyFromAITrio(TYPED, GEO_INTERPOLATED);

    expect(fetchUrls.some((u) => u.includes('pao-model-land'))).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('situs house number disagrees'),
    );
  });

  test('approximate geocodes still never reach the GIS point path', async () => {
    lookupParcelByPoint.mockResolvedValue(complexParcel({ situsAddress: '13649 LUXE AVE' }));

    await lookupPropertyFromAITrio(TYPED, { ...GEO, locationType: 'APPROXIMATE' });

    expect(lookupParcelByPoint).not.toHaveBeenCalled();
  });
});

describe('situsHouseNumberExactMatch (interpolated acceptance rule)', () => {
  test('true only when both sides expose the same clean number', () => {
    expect(situsHouseNumberExactMatch('13649 Luxe Avenue', '13649 LUXE AVE APT 101')).toBe(true);
    expect(situsHouseNumberExactMatch('13649 Luxe Avenue', '13510 LUXE AVE')).toBe(false);
  });
  test('missing or range numbers are NOT a positive match', () => {
    expect(situsHouseNumberExactMatch('13649 Luxe Avenue', 'LUXE AVE')).toBe(false);
    expect(situsHouseNumberExactMatch('Luxe Avenue', '13649 LUXE AVE')).toBe(false);
    expect(situsHouseNumberExactMatch('13649 Luxe Avenue', '13500-13700 LUXE AVE')).toBe(false);
    expect(situsHouseNumberExactMatch('13649 Luxe Avenue', null)).toBe(false);
  });
});

describe('AI web-record house-number guard', () => {
  // Live miss (2026-07-08): lookup for 14384 Skipping Stone Lp accepted the
  // realtor.com listing for 14375 — the nearest listed NEIGHBOR — and its lot
  // size became the trusted "listing" value. The guard reads the house number
  // out of the source URL slug and drops the record on a clean disagreement.
  test('extracts house numbers from the major listing URL shapes', () => {
    expect(houseNumberFromSourceUrl(
      'https://www.realtor.com/realestateandhomes-detail/14375-Skipping-Stone-Loop_Parrish_FL_34219',
    )).toBe('14375');
    expect(houseNumberFromSourceUrl(
      'https://www.zillow.com/homedetails/14343-Skipping-Stone-Loop-Parrish-FL-34219/2063272367_zpid/',
    )).toBe('14343');
    expect(houseNumberFromSourceUrl(
      'https://www.coldwellbankerhomes.com/fl/parrish/14344-skipping-stone-loop/pid_60888176/',
    )).toBe('14344');
    expect(houseNumberFromSourceUrl(
      'https://www.redfin.com/FL/Parrish/14384-Skipping-Stone-Lp-34219/home/123456',
    )).toBe('14384');
  });

  test('no signal from pages that do not embed an address slug', () => {
    // County parcel page (query-string keyed), builder floorplan, numeric ids.
    expect(houseNumberFromSourceUrl('https://www.manateepao.gov/parcel/?parid=497332659')).toBeNull();
    expect(houseNumberFromSourceUrl('https://www.lennar.com/new-homes/florida/sarasota/parrish/canoe-creek')).toBeNull();
    expect(houseNumberFromSourceUrl('https://example.com/listing/2063272367/')).toBeNull();
    expect(houseNumberFromSourceUrl('not a url')).toBeNull();
    expect(houseNumberFromSourceUrl(null)).toBeNull();
  });

  test('ordinal street names still yield the HOUSE number, not the id segment', () => {
    expect(houseNumberFromSourceUrl(
      'https://www.zillow.com/homedetails/4506-45th-Street-W-Bradenton-FL-34209/2063272367_zpid/',
    )).toBe('4506');
  });

  test('fires only on a clean two-sided disagreement', () => {
    const neighbor = { _aiSourceUrl: 'https://www.realtor.com/realestateandhomes-detail/14375-Skipping-Stone-Loop_Parrish_FL_34219' };
    expect(aiRecordHouseNumberMismatch(neighbor, '14384 Skipping Stone Lp, Parrish, FL 34219')).toBe(true);
    expect(aiRecordHouseNumberMismatch(neighbor, '14375 Skipping Stone Loop, Parrish, FL 34219')).toBe(false);
    // Positive-only: no URL number, no typed number, or no record → no drop.
    expect(aiRecordHouseNumberMismatch({ _aiSourceUrl: 'https://www.manateepao.gov/parcel/?parid=1' }, '14384 Skipping Stone Lp')).toBe(false);
    expect(aiRecordHouseNumberMismatch(neighbor, 'Skipping Stone Lp, Parrish')).toBe(false);
    expect(aiRecordHouseNumberMismatch(null, '14384 Skipping Stone Lp')).toBe(false);
  });
});
