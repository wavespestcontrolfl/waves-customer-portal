/**
 * Deed legal description -> parcel (services/mail/deed-parcel-match.js). All names, lots and parcel numbers are made
 * up. The map answer shapes (features, { error }, cut off) follow what the county layer returns.
 */
const {
  parseLegal, parcelWhere, queryParcels, sellerOwns, chooseParcel,
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
  test('plain field comparisons joined by AND only: the shape the county firewall answers', () => {
    for (const text of ['LOT 171 RYE RANCH', 'LOT 36 BLK 48 NORTH RIVER RANCH', "LOT 5 O'NEIL ESTATES PH I-A", 'LOT 12A TOWN & COUNTRY ESTATES']) {
      const where = parcelWhere(parseLegal(text));
      expect(where).not.toMatch(/\bOR\b|\(|\)|UPPER|LOWER|;|--/);
      expect(where.split(' AND ').every((part) => /^PAR_SUBDIV_(LOT|BLOCK) = '[^']+'$|^PAR_SUBDIV_NAME LIKE '([^']|'')+%'$/.test(part))).toBe(true);
    }
  });
});

describe('sellerOwns', () => {
  const sellers = ['EXAMPLE BUILDERS LLC'];
  const owned = (ownerName, ownerName2 = null) => ({ ownerName, ownerName2 });
  test.each([
    ['the same text', owned('EXAMPLE BUILDERS LLC'), sellers, true],
    ['signs and spaces differ', owned('M/I HOMES OF SAMPLETON, L.L.C.'), ['M I HOMES OF SAMPLETON LLC'], true],
    ['& on the map, AND on the deed', owned('A & B HOMES LLC'), ['A AND B HOMES LLC'], true],
    ['an accent on the deed only', owned('GARCIA HOMES LLC'), ['GARC\u00CDA HOMES LLC'], true],
    ['an accent on the map, as a separate mark', owned('GARCI\u0301A HOMES LLC'), ['GARCIA HOMES LLC'], true],
    ['the seller in the second field', owned('EXAMPLE LAND TRUST', 'EXAMPLE BUILDERS LLC'), sellers, true],
    ['the second of two sellers', owned('OTHER BUILDERS INC'), ['EXAMPLE BUILDERS LLC', 'OTHER BUILDERS INC'], true],
    ['another owner', owned('TESTER ALEX J', 'TESTER SAM K'), sellers, false],
    ['a longer name that starts with the seller\'s', owned('SAMPLE HOMESTEAD LLC'), ['SAMPLE HOMES'], false],
    ['a shorter form of the seller\'s name', owned('EXAMPLE BUILDERS'), sellers, false],
    ['no owner on the map', owned(null), sellers, false],
    ['an owner of signs only, a seller of signs only', owned(' - ', ''), ['-', ''], false],
    ['no seller list', owned('EXAMPLE BUILDERS LLC'), undefined, false],
    ['two names with a letter that cannot be compared', owned('S\u00D8REN HOMES LLC'), ['S\u00D8REN HOMES LLC'], false],
  ])('%s', (_name, parcel, sellerNames, expected) => {
    expect(sellerOwns(parcel, sellerNames)).toBe(expected);
  });
});

describe('chooseParcel', () => {
  const sellerNames = ['EXAMPLE BUILDERS LLC'];
  const parcel = (parid, ownerName, ownerName2 = null) => ({ parid, ownerName, ownerName2, addressLine1: `${parid.slice(-3)} EXAMPLE TRL` });
  const permit = (no) => ({ permit_no: no });
  const AMBIGUOUS = { status: 'ambiguous' };

  test('no parcels', () => {
    expect(chooseParcel({ sellerNames, parcels: [], permitsByParid: {} })).toEqual({ status: 'no_parcel' });
    expect(chooseParcel({ sellerNames, parcels: undefined, permitsByParid: {} })).toEqual({ status: 'no_parcel' });
  });
  test('no parcel with a new-home permit: no_permit (the seller\'s name on a parcel is not enough)', () => {
    const p = parcel('100000001', 'EXAMPLE BUILDERS LLC');
    expect(chooseParcel({ sellerNames, parcels: [p], permitsByParid: {} })).toEqual({ status: 'no_permit' });
    expect(chooseParcel({ sellerNames, parcels: [p, parcel('100000002', 'TESTER ALEX J')], permitsByParid: undefined })).toEqual({ status: 'no_permit' });
  });
  test('one parcel with a permit under the seller\'s name: owner_permit', () => {
    const p = parcel('100000001', 'EXAMPLE BUILDERS LLC');
    expect(chooseParcel({ sellerNames, parcels: [p], permitsByParid: { 100000001: permit('A') } }))
      .toEqual({ status: 'matched', basis: 'owner_permit', parcel: p, permit: permit('A') });
  });
  test('the only parcel of the answer has a permit and another owner: permit basis', () => {
    for (const owner of ['TESTER ALEX J', 'EXAMPLE BUILDERS', null, 'S\u00D8REN HOMES LLC']) {
      const p = parcel('100000001', owner);
      expect(chooseParcel({ sellerNames, parcels: [p], permitsByParid: { 100000001: permit('A') } }))
        .toEqual({ status: 'matched', basis: 'permit', parcel: p, permit: permit('A') });
    }
    const p = parcel('100000001', 'TESTER ALEX J');
    expect(chooseParcel({ sellerNames: [], parcels: [p], permitsByParid: { 100000001: permit('A') } })).toMatchObject({ status: 'matched', basis: 'permit' });
  });
  test('several phases, one permit, on the parcel under the seller\'s name: owner_permit, in either order', () => {
    const home = parcel('100000001', 'EXAMPLE BUILDERS LLC');
    const others = [parcel('100000002', 'TESTER ALEX J'), parcel('100000003', null), parcel('100000004', 'EXAMPLE BUILDERS LLC'), parcel('100000005', 'SAMPLE HOMESTEAD LLC')];
    for (const parcels of [[home, ...others], [...others, home]]) {
      expect(chooseParcel({ sellerNames, parcels, permitsByParid: { 100000001: permit('A') } }))
        .toEqual({ status: 'matched', basis: 'owner_permit', parcel: home, permit: permit('A') });
    }
  });
  test('the seller in the second owner field counts', () => {
    const home = parcel('100000001', 'EXAMPLE LAND TRUST', 'EXAMPLE BUILDERS LLC');
    expect(chooseParcel({ sellerNames, parcels: [home, parcel('100000002', 'TESTER ALEX J')], permitsByParid: { 100000001: permit('A') } }))
      .toMatchObject({ status: 'matched', basis: 'owner_permit', parcel: home });
  });
  test('several phases, and the one permit is not on a parcel under the seller\'s exact name: ambiguous', () => {
    const permitsByParid = { 100000001: permit('A') };
    // The seller still holds this lot number in another phase; the permit is on another owner's parcel.
    expect(chooseParcel({ sellerNames, parcels: [parcel('100000001', 'TESTER ALEX J'), parcel('100000002', 'EXAMPLE BUILDERS LLC')], permitsByParid })).toEqual(AMBIGUOUS);
    // No parcel is under the seller's name: nothing says which phase the deed means.
    expect(chooseParcel({ sellerNames, parcels: [parcel('100000001', 'TESTER ALEX J'), parcel('100000002', 'SAMPLE PAT Q')], permitsByParid })).toEqual(AMBIGUOUS);
    // A name that only looks like the seller's is not proof.
    expect(chooseParcel({ sellerNames: ['SAMPLE HOMES'], parcels: [parcel('100000001', 'SAMPLE HOMESTEAD LLC'), parcel('100000002', 'TESTER ALEX J')], permitsByParid })).toEqual(AMBIGUOUS);
    expect(chooseParcel({ sellerNames: [], parcels: [parcel('100000001', 'TESTER ALEX J'), parcel('100000002', 'SAMPLE PAT Q')], permitsByParid })).toEqual(AMBIGUOUS);
  });
  test('two parcels with a permit are always ambiguous, whoever the map names as owner', () => {
    const both = { 100000001: permit('A'), 100000002: permit('B') };
    const sellers = parcel('100000001', 'EXAMPLE BUILDERS LLC');
    const rivals = ['TESTER ALEX J', 'EXAMPLE BUILDERS LLC', 'EXAMPLE BUILDERS LLC OF SAMPLETON', 'A AND B HOMES LLC', 'OTHER BUILDERS LLC', null, '', ' - '];
    for (const owner of rivals) {
      const rival = parcel('100000002', owner);
      for (const parcels of [[sellers, rival], [rival, sellers]]) {
        expect(chooseParcel({ sellerNames, parcels, permitsByParid: both })).toEqual(AMBIGUOUS);
      }
    }
    // A rival whose second owner field was the seller is covered by the same rule.
    expect(chooseParcel({ sellerNames, parcels: [sellers, parcel('100000002', 'TESTER ALEX J', 'EXAMPLE BUILDERS LLC')], permitsByParid: both })).toEqual(AMBIGUOUS);
  });
  test('an accent or an "&" on one side does not hide the seller\'s parcel', () => {
    const home = parcel('100000001', 'GARCIA & SONS HOMES LLC');
    expect(chooseParcel({ sellerNames: ['GARC\u00CDA AND SONS HOMES LLC'], parcels: [home, parcel('100000002', 'TESTER ALEX J')], permitsByParid: { 100000001: permit('A') } }))
      .toMatchObject({ status: 'matched', basis: 'owner_permit', parcel: home });
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
    expect(url.searchParams.get('where')).toBe("PAR_SUBDIV_LOT = '171' AND PAR_SUBDIV_NAME LIKE 'RYE RANCH%'");
    expect(url.searchParams.get('outFields')).toContain('PAR_OWNER_NAME2');
    expect(url.searchParams.get('returnGeometry')).toBe('false');
    expect(url.searchParams.get('resultRecordCount')).toBe('25');
    expect(url.searchParams.get('f')).toBe('json');
    expect(url.searchParams.get('outFields')).toContain('PARID');
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual');
  });
  test('a phase on the deed is not the phase that only starts with it: the query returns it, the result drops it', async () => {
    const phaseOne = { lot: '171', block: null, subdivision: 'RYE RANCH PH I' };
    const same = [feature({ PAR_SUBDIV_NAME: 'RYE RANCH PH I' }), feature({ PARID: '513309060', PAR_SUBDIV_NAME: 'Rye Ranch Ph I PB81/1' })];
    const others = ['RYE RANCH PH II', 'RYE RANCH PH IA PB81/1', 'RYE RANCH PH I-A', 'RYE RANCH PH IV']
      .map((name, i) => feature({ PARID: String(513309070 + i), PAR_SUBDIV_NAME: name }));
    const parcels = await queryParcels(phaseOne, { fetchImpl: answer({ features: [others[0], same[0], others[1], same[1], others[2], others[3]] }) });
    expect(parcels.map((p) => p.parid)).toEqual(['513309059', '513309060']);
    expect(await queryParcels(phaseOne, { fetchImpl: answer({ features: others }) })).toEqual([]);
    // The dropped parcels still count for the cut-off check: 25 rows are a full page.
    const full = Array.from({ length: 25 }, (_, i) => feature({ PARID: String(513309100 + i), PAR_SUBDIV_NAME: 'RYE RANCH PH II' }));
    await expect(queryParcels(phaseOne, { fetchImpl: answer({ features: full }) })).rejects.toThrow(/cut off/);
  });
  test('only a phase, unit, section or plat-book part may follow the deed\'s subdivision words', async () => {
    const named = (names) => answer({ features: names.map((name, i) => feature({ PARID: String(513309200 + i), PAR_SUBDIV_NAME: name })) });
    const same = ['RYE RANCH', 'RYE RANCH PH IIA PB81/1', 'RYE RANCH PHASE 2', 'RYE RANCH PB81/1', 'RYE RANCH PB 81/1', 'RYE RANCH UNIT 3',
      'RYE RANCH SEC 2', 'RYE RANCH SECTION 2', 'RYE RANCH SUBDIVISION PB81/1', 'RYE RANCH  PH I', 'Rye Ranch Ph I'];
    expect(await queryParcels(legal, { fetchImpl: named(same) })).toHaveLength(same.length);
    // Another subdivision that starts with the same words. With one parcel and a permit it would otherwise match.
    const others = ['RYE RANCH ESTATES', 'RYE RANCH ESTATES PH I', 'RYE RANCH WEST PH I', 'RYE RANCH VILLAS', 'RYE RANCH III', 'RYE RANCH IA PB81/1',
      'RYE RANCHES PH I', 'RYE RANCH PHILLIPS ADD', 'RYE RANCH UNITED PB1/1', 'RYE RANCH PBX'];
    expect(await queryParcels(legal, { fetchImpl: named(others) })).toEqual([]);
  });
  test('a field that was asked for must come back, even when it is null', async () => {
    const without = (key) => { const f = feature(); delete f.attributes[key]; return f; };
    for (const key of ['PAR_OWNER_NAME2', 'PAR_OWNER_NAME1', 'SITUS_ADDRESS', 'PAR_SUBDIV_BLOCK', 'BLDG_R1_YRBUILT']) {
      await expect(queryParcels(legal, { fetchImpl: answer({ features: [feature(), without(key)] }) })).rejects.toThrow(`lacks the field ${key}`);
    }
    // An explicit null is the map's "none".
    const [p] = await queryParcels(legal, { fetchImpl: answer({ features: [feature({ PAR_OWNER_NAME1: null, PAR_OWNER_NAME2: null, SITUS_ADDRESS: null })] }) });
    expect(p).toMatchObject({ ownerName: null, ownerName2: null, addressLine1: null });
  });
  test('an owner name with an accent is read, so the comparison can fold it', async () => {
    const [p] = await queryParcels(legal, { fetchImpl: answer({ features: [feature({ PAR_OWNER_NAME1: 'GARC\u00CDA HOMES LLC', PAR_OWNER_NAME2: 'GARCI\u0301A HOMES LLC' })] }) });
    expect(p).toMatchObject({ ownerName: 'GARC\u00CDA HOMES LLC', ownerName2: 'GARCI\u0301A HOMES LLC' });
    expect(sellerOwns(p, ['GARCIA HOMES LLC'])).toBe(true);
  });
  test('the second owner field is read', async () => {
    const [p] = await queryParcels(legal, { fetchImpl: answer({ features: [feature({ PAR_OWNER_NAME1: 'EXAMPLE LAND TRUST', PAR_OWNER_NAME2: ' EXAMPLE BUILDERS LLC ' })] }) });
    expect(p).toMatchObject({ ownerName: 'EXAMPLE LAND TRUST', ownerName2: 'EXAMPLE BUILDERS LLC' });
  });
  test('the county map kill switch stops the lookup before any request, as an error', async () => {
    const before = process.env.COUNTY_PARCEL_GIS_DISABLED;
    const fetchImpl = jest.fn(answer({ features: [] }));
    try {
      for (const on of ['1', 'true']) {
        process.env.COUNTY_PARCEL_GIS_DISABLED = on;
        await expect(queryParcels(legal, { fetchImpl })).rejects.toThrow(/turned off/);
      }
      expect(fetchImpl).not.toHaveBeenCalled();
      process.env.COUNTY_PARCEL_GIS_DISABLED = '0';
      await expect(queryParcels(legal, { fetchImpl })).resolves.toEqual([]);
    } finally {
      if (before === undefined) delete process.env.COUNTY_PARCEL_GIS_DISABLED; else process.env.COUNTY_PARCEL_GIS_DISABLED = before;
    }
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
    ['the firewall page instead of JSON', answer('<html><head><title>Request Rejected</title></head><body>Request Rejected</body></html>')],
    ['a second owner name with a replacement character', answer({ features: [feature({ PAR_OWNER_NAME2: 'EXAMPLE BUILD\uFFFDRS LLC' })] })],
    ['a parcel with no subdivision', answer({ features: [feature({ PAR_SUBDIV_NAME: null })] })],
    ['an owner name with a replacement character', answer({ features: [feature({ PAR_OWNER_NAME1: 'EXAMPLE BUILD\uFFFDRS LLC' })] })],
    ['an owner name with a control character', answer({ features: [feature({ PAR_OWNER_NAME1: 'EXAMPLE\u0007BUILDERS LLC' })] })],
    ['an owner name with a zero-width space', answer({ features: [feature({ PAR_OWNER_NAME1: 'EXAMPLE\u200BBUILDERS LLC' })] })],
    ['an address with an accent (it would be printed)', answer({ features: [feature({ SITUS_ADDRESS: '101 EXAMPL\u00C9 TRL' })] })],
    ['an address with a no-break space', answer({ features: [feature({ SITUS_ADDRESS: '101\u00A0EXAMPLE TRL' })] })],
    ['an address that is not text', answer({ features: [feature({ SITUS_ADDRESS: 101 })] })],
    ['bytes that are not UTF-8', answer(Buffer.concat([Buffer.from('{"features":[],"x":"'), Buffer.from([0xff]), Buffer.from('"}')]))],
    ['a redirect', answer({ features: [feature()] }, 302, { location: 'https://elsewhere.example/query' })],
  ])('throws on %s', async (_label, fetchImpl) => {
    await expect(queryParcels(legal, { fetchImpl })).rejects.toThrow();
  });
});
