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
      .toBe("PAR_SUBDIV_LOT = '171' AND (PAR_SUBDIV_NAME = 'RYE RANCH' OR PAR_SUBDIV_NAME LIKE 'RYE RANCH %')");
    expect(parcelWhere({ lot: '171', block: '48', subdivision: 'RYE RANCH' }))
      .toBe("PAR_SUBDIV_LOT = '171' AND (PAR_SUBDIV_NAME = 'RYE RANCH' OR PAR_SUBDIV_NAME LIKE 'RYE RANCH %') AND PAR_SUBDIV_BLOCK = '48'");
  });
  test('an apostrophe is doubled so it cannot end the string', () => {
    expect(parcelWhere(parseLegal("LOT 5 O'NEIL ESTATES")))
      .toBe("PAR_SUBDIV_LOT = '5' AND (PAR_SUBDIV_NAME = 'O''NEIL ESTATES' OR PAR_SUBDIV_NAME LIKE 'O''NEIL ESTATES %')");
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
  const parcel = (parid, ownerName, ownerName2 = null) => ({ parid, ownerName, ownerName2, addressLine1: `${parid.slice(-3)} EXAMPLE TRL` });
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
  test('one parcel with a permit, owner already changed, no parcel under the seller: permit basis', () => {
    const p = parcel('100000001', 'TESTER ALEX J');
    const noPermit = parcel('100000002', 'SOMEONE ELSE LLC');
    const res = chooseParcel({ sellerNames, parcels: [p, noPermit], permitsByParid: { 100000001: permit('A') } });
    expect(res).toMatchObject({ status: 'matched', basis: 'permit', parcel: p });
  });
  test('the permit is on another owner\'s parcel and the seller still owns a different one: ambiguous', () => {
    const permitted = parcel('100000001', 'TESTER ALEX J');
    const sellers = parcel('100000002', 'EXAMPLE BUILDERS LLC');
    for (const parcels of [[permitted, sellers], [sellers, permitted]]) {
      expect(chooseParcel({ sellerNames, parcels, permitsByParid: { 100000001: permit('A') } })).toEqual({ status: 'ambiguous' });
    }
  });
  test('the seller owns two phases and only one has a permit: that one, owner_permit', () => {
    const built = parcel('100000001', 'EXAMPLE BUILDERS LLC');
    const vacant = parcel('100000002', 'EXAMPLE BUILDERS LLC');
    const res = chooseParcel({ sellerNames, parcels: [vacant, built], permitsByParid: { 100000001: permit('A') } });
    expect(res).toMatchObject({ status: 'matched', basis: 'owner_permit', parcel: built });
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
  test('the seller in the second owner field counts as the seller\'s parcel', () => {
    const owned = parcel('100000001', 'EXAMPLE LAND TRUST', 'EXAMPLE BUILDERS LLC');
    expect(chooseParcel({ sellerNames, parcels: [owned, parcel('100000002', 'X PERSON')], permitsByParid: { 100000001: permit('A'), 100000002: permit('B') } }))
      .toMatchObject({ status: 'matched', basis: 'owner_permit', parcel: owned });
    // The permit is on another owner's parcel; the seller still holds this lot in another phase, in field 2.
    const permitted = parcel('100000003', 'TESTER ALEX J');
    expect(chooseParcel({ sellerNames, parcels: [permitted, parcel('100000004', 'EXAMPLE LAND TRUST', 'EXAMPLE BUILDERS LLC')], permitsByParid: { 100000003: permit('A') } }))
      .toEqual({ status: 'ambiguous' });
  });
  test('permit basis needs an owner on the map for every other parcel', () => {
    const permitted = parcel('100000001', 'TESTER ALEX J');
    const permitsByParid = { 100000001: permit('A') };
    for (const unknown of [parcel('100000002', null), parcel('100000002', ''), parcel('100000002', '  '), parcel('100000002', '-')]) {
      expect(chooseParcel({ sellerNames, parcels: [permitted, unknown], permitsByParid })).toEqual({ status: 'ambiguous' });
    }
    // The second field alone is an owner.
    expect(chooseParcel({ sellerNames, parcels: [permitted, parcel('100000002', null, 'SOMEONE ELSE LLC')], permitsByParid }))
      .toMatchObject({ status: 'matched', basis: 'permit', parcel: permitted });
  });
  test('permit basis needs a seller name to compare when there is another parcel', () => {
    const permitted = parcel('100000001', 'TESTER ALEX J');
    const other = parcel('100000002', 'SOMEONE ELSE LLC');
    const permitsByParid = { 100000001: permit('A') };
    for (const noSeller of [[], [''], ['-'], undefined]) {
      expect(chooseParcel({ sellerNames: noSeller, parcels: [permitted, other], permitsByParid })).toEqual({ status: 'ambiguous' });
    }
    // One parcel alone is the lot the deed names: its permit is enough.
    expect(chooseParcel({ sellerNames: [], parcels: [permitted], permitsByParid })).toMatchObject({ status: 'matched', basis: 'permit', parcel: permitted });
    expect(chooseParcel({ sellerNames, parcels: [parcel('100000001', null)], permitsByParid })).toMatchObject({ status: 'matched', basis: 'permit' });
  });
  test('one owned with a permit and one not owned with a permit never falls through to the permit basis', () => {
    const owned = parcel('100000001', 'EXAMPLE BUILDERS LLC');
    const res = chooseParcel({ sellerNames, parcels: [owned, parcel('100000002', 'X PERSON')], permitsByParid: { 100000001: permit('A'), 100000002: permit('B') } });
    expect(res.basis).toBe('owner_permit');
  });
});

describe('queryParcels', () => {
  const legal = { lot: '171', block: null, subdivision: 'RYE RANCH' };
  // An answer as the real fetch gives it: a byte stream. `body` is an object (sent as JSON), a string or bytes.
  const stream = (body, status = 200, headers = {}) => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const state = { reads: 0, canceled: 0 };
    const res = {
      status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      body: {
        getReader: () => ({
          read: async () => { state.reads += 1; return state.reads === 1 ? { done: false, value: bytes } : { done: true, value: undefined }; },
          cancel: async () => { state.canceled += 1; },
        }),
      },
    };
    return { res, state };
  };
  const answer = (body, status = 200, headers = {}) => async () => stream(body, status, headers).res;
  const feature = (extra = {}) => ({
    attributes: {
      PARID: '513309059', SITUS_ADDRESS: '101 EXAMPLE TRL', SITUS_POSTAL_CITY: 'SAMPLETON', SITUS_POSTAL_ZIP: '34212-1234',
      PAR_SUBDIV_NAME: 'RYE RANCH PH IIA PB81/1', PAR_SUBDIV_LOT: '171', PAR_SUBDIV_BLOCK: null, PAR_OWNER_NAME1: 'EXAMPLE BUILDERS LLC', PAR_OWNER_NAME2: null,
      BLDGS_SQFT_LIVING: 2210, BLDG_R1_STORIES: 1.5, BLDG_R1_YRBUILT: 2026, ...extra,
    },
  });

  test('reads the features and sends the query parameters', async () => {
    const fetchImpl = jest.fn(answer({ features: [feature()] }));
    const parcels = await queryParcels(legal, { fetchImpl });
    expect(parcels).toEqual([{
      parid: '513309059', addressLine1: '101 EXAMPLE TRL', city: 'SAMPLETON', zip: '34212', subdivision: 'RYE RANCH PH IIA PB81/1',
      lot: '171', block: null, ownerName: 'EXAMPLE BUILDERS LLC', ownerName2: null, livingSqft: 2210, stories: 1.5, yearBuilt: 2026,
    }]);
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.searchParams.get('where')).toBe("PAR_SUBDIV_LOT = '171' AND (PAR_SUBDIV_NAME = 'RYE RANCH' OR PAR_SUBDIV_NAME LIKE 'RYE RANCH %')");
    expect(url.searchParams.get('outFields')).toContain('PAR_OWNER_NAME2');
    expect(url.searchParams.get('returnGeometry')).toBe('false');
    expect(url.searchParams.get('resultRecordCount')).toBe('25');
    expect(url.searchParams.get('f')).toBe('json');
    expect(url.searchParams.get('outFields')).toContain('PARID');
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual');
  });
  test('a phase on the deed is not the phase that only starts with it', async () => {
    const phaseOne = { lot: '171', block: null, subdivision: 'RYE RANCH PH I' };
    const same = [feature({ PAR_SUBDIV_NAME: 'RYE RANCH PH I' }), feature({ PARID: '513309060', PAR_SUBDIV_NAME: 'Rye Ranch Ph I PB81/1' })];
    expect(await queryParcels(phaseOne, { fetchImpl: answer({ features: same }) })).toHaveLength(2);
    for (const other of ['RYE RANCH PH II', 'RYE RANCH PH IA PB81/1', 'RYE RANCH PH I-A', 'RYE RANCH PH IV']) {
      await expect(queryParcels(phaseOne, { fetchImpl: answer({ features: [feature({ PAR_SUBDIV_NAME: other })] }) })).rejects.toThrow(/not the lot asked for/);
    }
  });
  test('the second owner field is read', async () => {
    const [p] = await queryParcels(legal, { fetchImpl: answer({ features: [feature({ PAR_OWNER_NAME1: 'EXAMPLE LAND TRUST', PAR_OWNER_NAME2: ' EXAMPLE BUILDERS LLC ' })] }) });
    expect(p).toMatchObject({ ownerName: 'EXAMPLE LAND TRUST', ownerName2: 'EXAMPLE BUILDERS LLC' });
  });
  test('a block in the question must be the block of every parcel', async () => {
    const withBlock = { lot: '171', block: '48', subdivision: 'RYE RANCH' };
    const [p] = await queryParcels(withBlock, { fetchImpl: answer({ features: [feature({ PAR_SUBDIV_BLOCK: '48' })] }) });
    expect(p.block).toBe('48');
    await expect(queryParcels(withBlock, { fetchImpl: answer({ features: [feature({ PAR_SUBDIV_BLOCK: '49' })] }) })).rejects.toThrow(/not the lot asked for/);
    await expect(queryParcels(withBlock, { fetchImpl: answer({ features: [feature()] }) })).rejects.toThrow(/not the lot asked for/);
  });
  test('a refused answer is let go: the request is aborted after a non-200 status', async () => {
    const seen = {};
    const fetchImpl = async (_url, opts) => { seen.signal = opts.signal; return stream({ features: [] }, 302, { location: 'https://elsewhere.example/query' }).res; };
    await expect(queryParcels(legal, { fetchImpl })).rejects.toThrow(/HTTP 302/);
    expect(seen.signal.aborted).toBe(true);
  });
  test('an answer over 1 MB is refused: by its declared length before a read, or at the piece that crosses the limit', async () => {
    const declared = stream({ features: [] }, 200, { 'content-length': String(1024 * 1024 + 1) });
    await expect(queryParcels(legal, { fetchImpl: async () => declared.res })).rejects.toThrow(/too large/);
    expect(declared.state.reads).toBe(0);
    const big = stream(Buffer.alloc(1024 * 1024 + 1, 0x20));
    await expect(queryParcels(legal, { fetchImpl: async () => big.res })).rejects.toThrow(/too large/);
    expect(big.state.canceled).toBe(1);
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
    ['an answer with no parcel list', answer({ objectIdFieldName: 'OBJECTID' })],
    ['a parcel list that is not a list', answer({ features: 'none' })],
    ['one of two parcels without a parcel number', answer({ features: [feature(), feature({ PARID: null })] })],
    ['a parcel with no attributes', answer({ features: [feature(), {}] })],
    ['a parcel number that is not 9 or 10 digits', answer({ features: [feature({ PARID: '51330905A' })] })],
    ['a parcel number sent as a number', answer({ features: [feature({ PARID: 513309059 })] })],
    ['the same parcel twice', answer({ features: [feature(), feature()] })],
    ['a full list of 25 parcels with no cut-off mark', answer({ features: Array.from({ length: 25 }, (_, i) => feature({ PARID: String(513309000 + i) })) })],
    ['a parcel of another lot', answer({ features: [feature({ PAR_SUBDIV_LOT: '172' })] })],
    ['a parcel of another subdivision', answer({ features: [feature({ PAR_SUBDIV_NAME: 'OTHER RANCH PH I' })] })],
    ['a subdivision that only starts with the same letters', answer({ features: [feature({ PAR_SUBDIV_NAME: 'RYE RANCHES PH I' })] })],
    ['a second owner name with a replacement character', answer({ features: [feature({ PAR_OWNER_NAME2: 'EXAMPLE BUILD\uFFFDRS LLC' })] })],
    ['a parcel with no subdivision', answer({ features: [feature({ PAR_SUBDIV_NAME: null })] })],
    ['an owner name with a replacement character', answer({ features: [feature({ PAR_OWNER_NAME1: 'EXAMPLE BUILD\uFFFDRS LLC' })] })],
    ['an address with a no-break space', answer({ features: [feature({ SITUS_ADDRESS: '101\u00A0EXAMPLE TRL' })] })],
    ['an address that is not text', answer({ features: [feature({ SITUS_ADDRESS: 101 })] })],
    ['bytes that are not UTF-8', answer(Buffer.concat([Buffer.from('{"features":[],"x":"'), Buffer.from([0xff]), Buffer.from('"}')]))],
    ['a redirect', answer({ features: [feature()] }, 302, { location: 'https://elsewhere.example/query' })],
  ])('throws on %s', async (_label, fetchImpl) => {
    await expect(queryParcels(legal, { fetchImpl })).rejects.toThrow();
  });
});
