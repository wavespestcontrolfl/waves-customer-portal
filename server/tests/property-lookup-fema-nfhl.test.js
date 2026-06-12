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

const logger = require('../services/logger');
const { lookupFloodZoneByPoint, _private } = require('../services/property-lookup/fema-nfhl');
const { buildEnrichedProfile } = require('../routes/property-lookup-v2');

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

  test('pricing modifiers and foundation are identical with and without flood evidence', () => {
    const withFlood = buildEnrichedProfile(
      rc({ floodZone: 'VE', floodZoneSubtype: 'COASTAL HIGH HAZARD', sfha: true }), {}, 27.1, -82.4, null,
    );
    const without = buildEnrichedProfile(rc(null), {}, 27.1, -82.4, null);
    expect(withFlood.modifiers).toEqual(without.modifiers);
    expect(withFlood.foundationType).toBe(without.foundationType);
  });
});
