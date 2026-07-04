/**
 * FEMA NFHL flood-zone evidence (estimator backlog: flood-zone inference).
 *
 * Provider pins: zone parse + SFHA tri-state, fail-open on outage/error,
 * kill switch, no-feature null, seam handling (first usable FLD_ZONE wins).
 * Profile pins: fields surface from the cached _floodZone, and the pricing
 * modifiers are IDENTICAL with and without the evidence — promoting flood
 * zone into inferFoundation (termite/WDO modifiers) is a later, gated step.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/property-lookup/lookup-cache', () => ({
  attachFloodZoneToCachedLookup: jest.fn(async () => {}),
  attachAddressAuditToCachedLookup: jest.fn(async () => {}),
  applyVerifiedOverrides: jest.fn((record) => record),
  getCachedLookup: jest.fn(async () => null),
  getVerifiedOverrides: jest.fn(async () => null),
  saveLookup: jest.fn(async () => {}),
  saveVerifiedOverride: jest.fn(async () => {}),
}));

const logger = require('../services/logger');
const { lookupFloodZoneByPoint, _private } = require('../services/property-lookup/fema-nfhl');
const {
  buildEnrichedProfile,
  performPropertyLookup,
} = require('../routes/property-lookup-v2');
const {
  attachFloodZoneToCachedLookup,
  attachAddressAuditToCachedLookup,
  getCachedLookup,
} = require('../services/property-lookup/lookup-cache');

const savedFetch = global.fetch;

function femaResponse(features) {
  return {
    ok: true,
    json: async () => ({ features }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.FEMA_NFHL_DISABLED;
});

afterEach(() => {
  global.fetch = savedFetch;
  delete process.env.FEMA_NFHL_DISABLED;
});

describe('lookupFloodZoneByPoint', () => {
  test('parses zone X / minimal hazard (live golden-point shape)', async () => {
    global.fetch = jest.fn(async () => femaResponse([
      { attributes: { FLD_ZONE: 'X', ZONE_SUBTY: 'AREA OF MINIMAL FLOOD HAZARD', SFHA_TF: 'F' } },
    ]));
    await expect(lookupFloodZoneByPoint(27.4536, -82.4221)).resolves.toEqual({
      floodZone: 'X',
      floodZoneSubtype: 'AREA OF MINIMAL FLOOD HAZARD',
      sfha: false,
    });
  });

  test('parses a special flood hazard area (AE / T)', async () => {
    global.fetch = jest.fn(async () => femaResponse([
      { attributes: { FLD_ZONE: 'AE', ZONE_SUBTY: null, SFHA_TF: 'T' } },
    ]));
    await expect(lookupFloodZoneByPoint(27.1, -82.4)).resolves.toEqual({
      floodZone: 'AE',
      floodZoneSubtype: null,
      sfha: true,
    });
  });

  test('panel-seam rows: first feature with a usable FLD_ZONE wins', async () => {
    global.fetch = jest.fn(async () => femaResponse([
      { attributes: { FLD_ZONE: '', ZONE_SUBTY: null, SFHA_TF: null } },
      { attributes: { FLD_ZONE: 'VE', ZONE_SUBTY: 'COASTAL HIGH HAZARD', SFHA_TF: 'T' } },
    ]));
    const result = await lookupFloodZoneByPoint(27.1, -82.4);
    expect(result.floodZone).toBe('VE');
  });

  test('no features at point → null (logged coarse, info-level)', async () => {
    global.fetch = jest.fn(async () => femaResponse([]));
    await expect(lookupFloodZoneByPoint(27.123456, -82.654321)).resolves.toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      '[fema-nfhl] no flood zone at point',
      expect.objectContaining({ latApprox: 27.12, lngApprox: -82.65 }),
    );
  });

  test('fail-open: HTTP error and layer error both return null with a warn', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));
    await expect(lookupFloodZoneByPoint(27.1, -82.4)).resolves.toBeNull();

    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ error: { message: 'layer offline', code: 500 } }),
    }));
    await expect(lookupFloodZoneByPoint(27.1, -82.4)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  test('fail-open: network rejection returns null', async () => {
    global.fetch = jest.fn(async () => { throw new Error('socket hang up'); });
    await expect(lookupFloodZoneByPoint(27.1, -82.4)).resolves.toBeNull();
  });

  test('kill switch skips without fetching', async () => {
    process.env.FEMA_NFHL_DISABLED = '1';
    global.fetch = jest.fn();
    await expect(lookupFloodZoneByPoint(27.1, -82.4)).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('non-finite coordinates return null without fetching', async () => {
    global.fetch = jest.fn();
    await expect(lookupFloodZoneByPoint(NaN, -82.4)).resolves.toBeNull();
    await expect(lookupFloodZoneByPoint(27.1, undefined)).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('SFHA tri-state: anything but T/F is unknown, not false', () => {
    expect(_private.parseSfha('T')).toBe(true);
    expect(_private.parseSfha('F')).toBe(false);
    expect(_private.parseSfha('')).toBeNull();
    expect(_private.parseSfha(null)).toBeNull();
    expect(_private.parseSfha('U')).toBeNull();
  });
});

describe('profile surfacing (evidence-only)', () => {
  const rc = (floodZone) => ({
    formattedAddress: '123 Test St, Bradenton, FL',
    squareFootage: 1800,
    lotSize: 9000,
    stories: 1,
    ...(floodZone ? { _floodZone: floodZone } : {}),
  });

  test('flood fields surface from the cached record', () => {
    const profile = buildEnrichedProfile(
      rc({ floodZone: 'AE', floodZoneSubtype: null, sfha: true }), {}, 27.1, -82.4, null,
    );
    expect(profile.floodZone).toBe('AE');
    expect(profile.inSpecialFloodHazardArea).toBe(true);
  });

  test('absent evidence is null, not false', () => {
    const profile = buildEnrichedProfile(rc(null), {}, 27.1, -82.4, null);
    expect(profile.floodZone).toBeNull();
    expect(profile.floodZoneSubtype).toBeNull();
    expect(profile.inSpecialFloodHazardArea).toBeNull();
  });

  test('SFHA downgrades foundation to UNKNOWN for field-verify but does NOT move pricing modifiers', () => {
    const withFlood = buildEnrichedProfile(
      rc({ floodZone: 'VE', floodZoneSubtype: 'COASTAL HIGH HAZARD', sfha: true }), {}, 27.1, -82.4, null,
    );
    const without = buildEnrichedProfile(rc(null), {}, 27.1, -82.4, null);
    // Conservative posture: foundation flips slab->UNKNOWN so a tech verifies,
    // but every pricing modifier (termite adj, WDO mult, ...) stays identical.
    expect(without.foundationType).toBe('SLAB');
    expect(withFlood.foundationType).toBe('UNKNOWN');
    expect(withFlood.modifiers).toEqual(without.modifiers);
    expect(withFlood.modifiers.termiteFoundationAdj).toBe(0);
  });

  test('SFHA raises a foundationType field-verify flag (single, non-duplicated)', () => {
    const withFlood = buildEnrichedProfile(
      rc({ floodZone: 'AE', floodZoneSubtype: 'COASTAL FLOODPLAIN', sfha: true }), {}, 27.1, -82.4, null,
    );
    const foundationFlags = withFlood.fieldVerifyFlags.filter((f) => f.field === 'foundationType');
    expect(foundationFlags).toHaveLength(1);
    expect(foundationFlags[0].priority).toBe('HIGH');
    expect(foundationFlags[0].reason).toMatch(/flood zone AE/i);
  });

  test('non-SFHA flood zone (X) leaves foundation as slab with no foundation flag', () => {
    const profile = buildEnrichedProfile(
      rc({ floodZone: 'X', floodZoneSubtype: 'AREA OF MINIMAL FLOOD HAZARD', sfha: false }), {}, 27.1, -82.4, null,
    );
    expect(profile.foundationType).toBe('SLAB');
    expect(profile.fieldVerifyFlags.filter((f) => f.field === 'foundationType')).toHaveLength(0);
  });
});

describe('cache-hit backfill (#1698 review P2)', () => {
  const cachedRow = (recordOverrides = {}) => ({
    property_record: {
      formattedAddress: '123 Test St, Bradenton, FL',
      // Pin the audit key so the house-number-audit backfill (its own suite:
      // property-lookup-address-audit.test.js) never fires inside these
      // FEMA-focused fixtures.
      _addressAudit: null,
      squareFootage: 1800,
      lotSize: 9000,
      stories: 1,
      ...recordOverrides,
    },
    ai_analysis: { estimatedTurfSf: 5000, confidenceScore: 80 },
    lat: 27.1,
    lng: -82.4,
    updated_at: '2026-06-01T00:00:00Z',
  });

  test('pre-provider cached row gets the zone queried, attached, and persisted', async () => {
    getCachedLookup.mockResolvedValue(cachedRow());
    global.fetch = jest.fn(async () => femaResponse([
      { attributes: { FLD_ZONE: 'AE', ZONE_SUBTY: null, SFHA_TF: 'T' } },
    ]));

    const result = await performPropertyLookup('123 Test St, Bradenton, FL');

    expect(result.meta.cache).toBe('hit');
    expect(result.enriched.floodZone).toBe('AE');
    expect(result.enriched.inSpecialFloodHazardArea).toBe(true);
    expect(attachFloodZoneToCachedLookup).toHaveBeenCalledWith(
      '123 Test St, Bradenton, FL',
      { floodZone: 'AE', floodZoneSubtype: null, sfha: true },
    );
  });

  test('a cached SNAPPED county record gets the audit despite county evidence', async () => {
    // Typed 4867 but the cached county-backed record describes 4857 — the
    // backfill must run, flag the mismatch, and persist the marker.
    const row = cachedRow({
      _floodZone: { floodZone: 'X', floodZoneSubtype: null, sfha: false },
      _source: 'county',
      addressLine1: '4857 TOBERMORY WAY',
    });
    delete row.property_record._addressAudit;
    getCachedLookup.mockResolvedValue(row);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ features: [{ attributes: { SITUS_ADDRESS: '4857 TOBERMORY WAY' } }] }),
    });

    const result = await performPropertyLookup('4867 Tobermory Way, Bradenton, FL 34211');

    const audit = result.propertyRecord._addressAudit;
    expect(audit.snappedRecord).toEqual({ typed: 4867, record: 4857 });
    expect(attachAddressAuditToCachedLookup).toHaveBeenCalledWith(
      '4867 Tobermory Way, Bradenton, FL 34211',
      expect.objectContaining({ snappedRecord: { typed: 4867, record: 4857 } }),
    );
    const flag = result.enriched.fieldVerifyFlags.find((f) => f.field === 'address');
    expect(flag.reason).toContain('snapped');
  });

  test('row that already carries _floodZone is served as-is — no FEMA query', async () => {
    getCachedLookup.mockResolvedValue(cachedRow({
      _floodZone: { floodZone: 'X', floodZoneSubtype: 'AREA OF MINIMAL FLOOD HAZARD', sfha: false },
    }));
    global.fetch = jest.fn();

    const result = await performPropertyLookup('123 Test St, Bradenton, FL');

    expect(result.enriched.floodZone).toBe('X');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(attachFloodZoneToCachedLookup).not.toHaveBeenCalled();
  });

  test('FEMA outage on a cache hit: nothing persisted, hit still served (retry next hit)', async () => {
    getCachedLookup.mockResolvedValue(cachedRow());
    global.fetch = jest.fn(async () => { throw new Error('socket hang up'); });

    const result = await performPropertyLookup('123 Test St, Bradenton, FL');

    expect(result.meta.cache).toBe('hit');
    expect(result.enriched.floodZone).toBeNull();
    expect(attachFloodZoneToCachedLookup).not.toHaveBeenCalled();
  });
});
