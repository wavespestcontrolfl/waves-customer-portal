/**
 * Deed legal description -> parcel (services/mail/deed-parcel-match.js). All names, lots and parcel numbers are made
 * up. The map answer shapes (features, { error }, cut off) follow what the county layer returns.
 */
const {
  parseLegal, parcelWhere, queryParcels, ownerMatchesSeller, chooseParcel,
} = require('../services/mail/deed-parcel-match');

describe('parseLegal', () => {
  test.each([
    ['LOT 12 SAMPLE GROVE', { lot: '12', block: null, subdivision: 'SAMPLE GROVE' }],
    ['LOT 36 BLK 48 NORTH RIVER RANCH', { lot: '36', block: '48', subdivision: 'NORTH RIVER RANCH' }],
    ['LOT 7 BLOCK B EXAMPLE RANCH', { lot: '7', block: 'B', subdivision: 'EXAMPLE RANCH' }],
    ['LOT 12A SAMPLE GROVE', { lot: '12A', block: null, subdivision: 'SAMPLE GROVE' }],
    ["LOT 5 O'NEIL ESTATES", { lot: '5', block: null, subdivision: "O'NEIL ESTATES" }],
    ['lot 9 sample grove', { lot: '9', block: null, subdivision: 'SAMPLE GROVE' }],
    ['  LOT   9   BLK  2   SAMPLE   GROVE ', { lot: '9', block: '2', subdivision: 'SAMPLE GROVE' }],
  ])('%s', (text, expected) => {
    expect(parseLegal(text)).toEqual(expected);
  });

  test.each([
    'COACH HOMES AT SAMPLE COVE UNIT 104',
    'COMM AT THE NE COR OF SEC 5 THENCE S 100 FT',
    'LOT 1 AND 2 SAMPLE GROVE',
    'LOT 3 THRU 5 SAMPLE GROVE',
    'LOT 12',
    'LOT 12 X',
    "LOT 1 SAMPLE'; DROP TABLE x --",
    '',
    null,
  ])('not one plain lot: %s', (text) => {
    expect(parseLegal(text)).toBeNull();
  });
});

describe('parcelWhere', () => {
  test('lot and subdivision prefix, block when there is one', () => {
    expect(parcelWhere({ lot: '171', block: null, subdivision: 'RYE RANCH' }))
      .toBe("PAR_SUBDIV_LOT = '171' AND PAR_SUBDIV_NAME LIKE 'RYE RANCH%'");
    expect(parcelWhere({ lot: '171', block: '48', subdivision: 'RYE RANCH' }))
      .toBe("PAR_SUBDIV_LOT = '171' AND PAR_SUBDIV_NAME LIKE 'RYE RANCH%' AND PAR_SUBDIV_BLOCK = '48'");
  });
  test('an apostrophe is doubled so it cannot end the string', () => {
    expect(parcelWhere(parseLegal("LOT 5 O'NEIL ESTATES"))).toBe("PAR_SUBDIV_LOT = '5' AND PAR_SUBDIV_NAME LIKE 'O''NEIL ESTATES%'");
  });
});

describe('ownerMatchesSeller', () => {
  test('the map and the deed spell punctuation differently', () => {
    expect(ownerMatchesSeller('M/I HOMES OF SAMPLETON LLC', ['M I HOMES OF SAMPLETON LLC'])).toBe(true);
  });
  test('one name starting the other counts when the shorter has 8 or more characters', () => {
    expect(ownerMatchesSeller('EXAMPLE BUILDERS OF SAMPLETON LLC', ['EXAMPLE BUILDERS'])).toBe(true);
    expect(ownerMatchesSeller('ACME LLC', ['ACME LLC OF SAMPLETON'])).toBe(false); // "ACMELLC" is 7 characters
  });
  test('different owners and empty names do not match', () => {
    expect(ownerMatchesSeller('OTHER BUILDERS LLC', ['EXAMPLE BUILDERS LLC'])).toBe(false);
    expect(ownerMatchesSeller('', ['EXAMPLE BUILDERS LLC'])).toBe(false);
    expect(ownerMatchesSeller('EXAMPLE BUILDERS LLC', [])).toBe(false);
  });
});

describe('chooseParcel', () => {
  const sellerNames = ['EXAMPLE BUILDERS LLC'];
  const parcel = (parid, ownerName) => ({ parid, ownerName, addressLine1: `${parid.slice(-3)} EXAMPLE TRL` });
  const permit = (no) => ({ permit_no: no });

  test('no parcels', () => {
    expect(chooseParcel({ sellerNames, parcels: [], permitsByParid: {} })).toEqual({ status: 'no_parcel' });
  });
  test('one parcel owned by the seller with a permit: owner_permit', () => {
    const p = parcel('100000001', 'EXAMPLE BUILDERS LLC');
    expect(chooseParcel({ sellerNames, parcels: [p], permitsByParid: { 100000001: permit('A') } }))
      .toEqual({ status: 'matched', basis: 'owner_permit', parcel: p, permit: permit('A') });
  });
  test('two parcels with permits, one owned by the seller: the owned one', () => {
    const owned = parcel('100000001', 'EXAMPLE BUILDERS LLC');
    const other = parcel('100000002', 'SOMEONE ELSE LLC');
    const res = chooseParcel({ sellerNames, parcels: [other, owned], permitsByParid: { 100000001: permit('A'), 100000002: permit('B') } });
    expect(res).toMatchObject({ status: 'matched', basis: 'owner_permit', parcel: owned });
  });
  test('one parcel with a permit, owner already changed: permit basis', () => {
    const p = parcel('100000001', 'TESTER ALEX J');
    const noPermit = parcel('100000002', 'EXAMPLE BUILDERS LLC');
    const res = chooseParcel({ sellerNames, parcels: [p, noPermit], permitsByParid: { 100000001: permit('A') } });
    expect(res).toMatchObject({ status: 'matched', basis: 'permit', parcel: p });
  });
  test('parcels without a new-home permit: no_permit (a parcel owned by the seller is not enough)', () => {
    const p = parcel('100000001', 'EXAMPLE BUILDERS LLC');
    expect(chooseParcel({ sellerNames, parcels: [p], permitsByParid: {} })).toEqual({ status: 'no_permit' });
  });
  test('two with permits, none owned by the seller: ambiguous', () => {
    const parcels = [parcel('100000001', 'A PERSON'), parcel('100000002', 'B PERSON')];
    expect(chooseParcel({ sellerNames, parcels, permitsByParid: { 100000001: permit('A'), 100000002: permit('B') } }))
      .toEqual({ status: 'ambiguous' });
  });
  test('two with permits, both owned by the seller: ambiguous', () => {
    const parcels = [parcel('100000001', 'EXAMPLE BUILDERS LLC'), parcel('100000002', 'EXAMPLE BUILDERS LLC')];
    expect(chooseParcel({ sellerNames, parcels, permitsByParid: { 100000001: permit('A'), 100000002: permit('B') } }))
      .toEqual({ status: 'ambiguous' });
  });
  test('one owned with a permit and one not owned with a permit never falls through to the permit basis', () => {
    const owned = parcel('100000001', 'EXAMPLE BUILDERS LLC');
    const res = chooseParcel({ sellerNames, parcels: [owned, parcel('100000002', 'X PERSON')], permitsByParid: { 100000001: permit('A'), 100000002: permit('B') } });
    expect(res.basis).toBe('owner_permit');
  });
});

describe('queryParcels', () => {
  const legal = { lot: '171', block: null, subdivision: 'RYE RANCH' };
  const answer = (body, status = 200) => async () => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const feature = (extra = {}) => ({
    attributes: {
      PARID: '513309059', SITUS_ADDRESS: '101 EXAMPLE TRL', SITUS_POSTAL_CITY: 'SAMPLETON', SITUS_POSTAL_ZIP: '34212-1234',
      PAR_SUBDIV_NAME: 'RYE RANCH PH IIA PB81/1', PAR_SUBDIV_LOT: '171', PAR_SUBDIV_BLOCK: null, PAR_OWNER_NAME1: 'EXAMPLE BUILDERS LLC',
      BLDGS_SQFT_LIVING: 2210, BLDG_R1_STORIES: 1.5, BLDG_R1_YRBUILT: 2026, ...extra,
    },
  });

  test('reads the features and sends the query parameters', async () => {
    const fetchImpl = jest.fn(answer({ features: [feature()] }));
    const parcels = await queryParcels(legal, { fetchImpl });
    expect(parcels).toEqual([{
      parid: '513309059', addressLine1: '101 EXAMPLE TRL', city: 'SAMPLETON', zip: '34212', subdivision: 'RYE RANCH PH IIA PB81/1',
      lot: '171', block: null, ownerName: 'EXAMPLE BUILDERS LLC', livingSqft: 2210, stories: 1.5, yearBuilt: 2026,
    }]);
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.searchParams.get('where')).toBe("PAR_SUBDIV_LOT = '171' AND PAR_SUBDIV_NAME LIKE 'RYE RANCH%'");
    expect(url.searchParams.get('returnGeometry')).toBe('false');
    expect(url.searchParams.get('resultRecordCount')).toBe('25');
    expect(url.searchParams.get('f')).toBe('json');
    expect(url.searchParams.get('outFields')).toContain('PARID');
  });
  test('0 and missing numbers become null', async () => {
    const [p] = await queryParcels(legal, { fetchImpl: answer({ features: [feature({ BLDGS_SQFT_LIVING: 0, BLDG_R1_STORIES: null, BLDG_R1_YRBUILT: null, SITUS_POSTAL_ZIP: null })] }) });
    expect(p).toMatchObject({ livingSqft: null, stories: null, yearBuilt: null, zip: null });
  });
  test('no features is an empty list', async () => {
    expect(await queryParcels(legal, { fetchImpl: answer({ features: [] }) })).toEqual([]);
  });
  test.each([
    ['an error body with HTTP 200', answer({ error: { code: 400 } })],
    ['a non-200 answer', answer({ features: [] }, 503)],
    ['a body that is not JSON', answer('<html>busy</html>')],
    ['a cut-off answer', answer({ features: [feature()], exceededTransferLimit: true })],
  ])('throws on %s', async (_label, fetchImpl) => {
    await expect(queryParcels(legal, { fetchImpl })).rejects.toThrow();
  });
});
