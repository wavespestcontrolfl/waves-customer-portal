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

const logger = require('../services/logger');
const { lookupParcelByPoint } = require('../services/property-lookup/parcel-gis');
const {
  lookupPropertyFromAITrio,
  _private: aiPrivate,
} = require('../services/property-lookup/ai-property-lookup');

const { leadingHouseNumber, situsHouseNumberMismatch } = aiPrivate;

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
