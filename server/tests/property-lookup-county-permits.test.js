/**
 * County pool/enclosure permit evidence (pool facts Step 2).
 *
 * Provider pins: Manatee closed-vocabulary parse (Pool_Spa / Aluminum
 * Structure, newest wins), Charlotte description match with code-enforcement
 * rows excluded, the checked-marker contract (successful empty query returns
 * the empty object; failures return null), the digits-only injection guard,
 * the kill switch, and Sarasota/unknown counties returning null.
 *
 * Profile pins: poolPermit/enclosurePermit surface from the cached record,
 * the new-pool verify flag fires only on permit-without-assessed-pool and
 * never double-prompts the pool field, and pricing modifiers are untouched.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const logger = require('../services/logger');
const {
  lookupPoolPermitsByParcel,
  _private,
} = require('../services/property-lookup/county-permits');
const { buildEnrichedProfile } = require('../routes/property-lookup-v2');

const savedFetch = global.fetch;

function arcgisResponse(features) {
  return { ok: true, json: async () => ({ features }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.COUNTY_PERMITS_DISABLED;
});

afterEach(() => {
  global.fetch = savedFetch;
  delete process.env.COUNTY_PERMITS_DISABLED;
});

describe('lookupPoolPermitsByParcel', () => {
  test('Manatee: Pool_Spa and Aluminum Structure split into pool/enclosure, newest wins', async () => {
    global.fetch = jest.fn(async () => arcgisResponse([
      { attributes: { PERMIT_NO: 'BLD2401-1111', PERMIT_TYPE: 'Pool_Spa', PERMIT_ISSUE: Date.UTC(2024, 0, 15) } },
      { attributes: { PERMIT_NO: 'BLD2603-2086', PERMIT_TYPE: 'Aluminum Structure', PERMIT_ISSUE: Date.UTC(2026, 4, 27) } },
      { attributes: { PERMIT_NO: 'BLD2602-0001', PERMIT_TYPE: 'Pool_Spa', PERMIT_ISSUE: Date.UTC(2026, 1, 2) } },
    ]));

    const result = await lookupPoolPermitsByParcel({ county: 'Manatee', parcelId: '1016411603' });

    expect(result.poolPermit).toEqual({ permitNo: 'BLD2602-0001', type: 'Pool_Spa', issuedAt: '2026-02-02' });
    expect(result.enclosurePermit).toEqual({ permitNo: 'BLD2603-2086', type: 'Aluminum Structure', issuedAt: '2026-05-27' });
    // The WHERE reached the layer with the validated PIN and closed vocabulary.
    // URLSearchParams encodes spaces as '+', which decodeURIComponent keeps.
    const url = decodeURIComponent(String(global.fetch.mock.calls[0][0])).replace(/\+/g, ' ');
    expect(url).toContain("SELECTPIN='1016411603'");
    expect(url).toContain("'Pool_Spa','Aluminum Structure'");
  });

  test('Charlotte: description match, code-enforcement rows are complaints not evidence', async () => {
    global.fetch = jest.fn(async () => arcgisResponse([
      { attributes: { RECORD_ID: 'COD-26-00120', RECORD_TYPE: 'Code Enforcement', DESCRIPTION: 'Pool cage missing screens', DATE_OPENED: Date.UTC(2026, 2, 1) } },
      { attributes: { RECORD_ID: '20260102496', RECORD_TYPE: 'Residential Single Family', DESCRIPTION: 'NEW CONSTRUCTION RESIDENTIAL WITH POOL', DATE_OPENED: Date.UTC(2026, 0, 10) } },
    ]));

    const result = await lookupPoolPermitsByParcel({ county: 'Charlotte', parcelId: '402216307002' });

    expect(result.poolPermit).toEqual({
      permitNo: '20260102496',
      type: 'Residential Single Family',
      issuedAt: '2026-01-10',
    });
    expect(result.enclosurePermit).toBeNull();
  });

  test('checked-marker contract: successful empty query returns the empty object', async () => {
    global.fetch = jest.fn(async () => arcgisResponse([]));
    await expect(lookupPoolPermitsByParcel({ county: 'Manatee', parcelId: '1016411603' }))
      .resolves.toEqual({ poolPermit: null, enclosurePermit: null });
  });

  test('fail-open: provider failure returns null (retry later), never throws', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));
    await expect(lookupPoolPermitsByParcel({ county: 'Manatee', parcelId: '1016411603' }))
      .resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  test('Sarasota and unknown counties are unsupported — null without fetching', async () => {
    global.fetch = jest.fn();
    await expect(lookupPoolPermitsByParcel({ county: 'Sarasota', parcelId: '0069140016' })).resolves.toBeNull();
    await expect(lookupPoolPermitsByParcel({ county: 'Lee', parcelId: '1234567890' })).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('injection guard: non-digit parcel ids never reach a WHERE clause', async () => {
    global.fetch = jest.fn();
    await expect(lookupPoolPermitsByParcel({ county: 'Manatee', parcelId: "1' OR '1'='1" })).resolves.toBeNull();
    await expect(lookupPoolPermitsByParcel({ county: 'Manatee', parcelId: null })).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(_private.cleanParcelDigits('1016411603')).toBe('1016411603');
    expect(_private.cleanParcelDigits('402216307002')).toBe('402216307002');
    expect(_private.cleanParcelDigits('abc123')).toBeNull();
  });

  test('kill switch skips without fetching', async () => {
    process.env.COUNTY_PERMITS_DISABLED = '1';
    global.fetch = jest.fn();
    await expect(lookupPoolPermitsByParcel({ county: 'Manatee', parcelId: '1016411603' })).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('profile surfacing + verify flag (evidence-only)', () => {
  const rc = (overrides = {}) => ({
    formattedAddress: '123 Test St, Bradenton, FL',
    squareFootage: 1800,
    lotSize: 9000,
    stories: 1,
    ...overrides,
  });
  const permits = {
    poolPermit: { permitNo: 'BLD2602-0001', type: 'Pool_Spa', issuedAt: '2026-02-02' },
    enclosurePermit: null,
  };

  test('permit fields surface from the cached record; absent stays null', () => {
    const withPermit = buildEnrichedProfile(rc({ _poolPermits: permits }), {}, 27.4, -82.4, null);
    const without = buildEnrichedProfile(rc(), {}, 27.4, -82.4, null);
    expect(withPermit.poolPermit).toEqual(permits.poolPermit);
    expect(withPermit.enclosurePermit).toBeNull();
    expect(without.poolPermit).toBeNull();
  });

  test('new-pool verify flag: permit + no assessed pool → HIGH flag; assessed pool → no flag', () => {
    const flagged = buildEnrichedProfile(rc({ _poolPermits: permits, hasPool: null }), {}, 27.4, -82.4, null);
    const poolFlag = flagged.fieldVerifyFlags.find((f) => f.field === 'pool');
    expect(poolFlag).toBeDefined();
    expect(poolFlag.priority).toBe('HIGH');
    expect(poolFlag.reason).toContain('2026-02-02');

    const assessed = buildEnrichedProfile(rc({ _poolPermits: permits, hasPool: true }), {}, 27.4, -82.4, null);
    expect(assessed.fieldVerifyFlags.some((f) => f.field === 'pool' && /permit/i.test(f.reason))).toBe(false);
  });

  test('pool field is never double-prompted when another pool flag already fired', () => {
    // AI-detected-pool flag fires (ai pool YES, record says no pool table
    // parsed) — the permit flag must then stay quiet.
    const profile = buildEnrichedProfile(
      rc({ _poolPermits: permits, hasPool: false }),
      { poolVisible: 'YES' },
      27.4, -82.4, null,
    );
    const poolFlags = profile.fieldVerifyFlags.filter((f) => f.field === 'pool');
    expect(poolFlags.length).toBeLessThanOrEqual(1);
  });

  test('pricing modifiers identical with and without permit evidence', () => {
    const withPermit = buildEnrichedProfile(rc({ _poolPermits: permits }), {}, 27.4, -82.4, null);
    const without = buildEnrichedProfile(rc(), {}, 27.4, -82.4, null);
    expect(withPermit.modifiers).toEqual(without.modifiers);
  });
});
