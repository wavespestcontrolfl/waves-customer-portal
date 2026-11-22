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
  test('every form of the lot number, the subdivision words in order, the block when there is one', () => {
    expect(parcelWhere({ lot: '171', block: null, subdivision: 'RYE RANCH' }))
      .toBe("PAR_SUBDIV_LOT IN ('171', '0171') AND PAR_SUBDIV_NAME LIKE 'RYE%RANCH%'");
    expect(parcelWhere({ lot: '5', block: '48', subdivision: 'RYE RANCH' }))
      .toBe("PAR_SUBDIV_LOT IN ('5', '05', '005', '0005') AND PAR_SUBDIV_NAME LIKE 'RYE%RANCH%' AND PAR_SUBDIV_BLOCK IN ('48', '048', '0048')");
  });
  test('a lot with leading zeros or a letter: with and without the zeros, capital and lower-case', () => {
    expect(parcelWhere({ lot: '05', block: null, subdivision: 'RYE RANCH' })).toContain("PAR_SUBDIV_LOT IN ('05', '5', '005', '0005') AND");
    expect(parcelWhere({ lot: '012A', block: 'B', subdivision: 'RYE RANCH' }))
      .toBe("PAR_SUBDIV_LOT IN ('012A', '12A', '012a', '12a') AND PAR_SUBDIV_NAME LIKE 'RYE%RANCH%' AND PAR_SUBDIV_BLOCK IN ('B', 'b')");
    expect(parcelWhere({ lot: '12345', block: null, subdivision: 'RYE RANCH' })).toContain("PAR_SUBDIV_LOT IN ('12345') AND");
    expect(parcelWhere({ lot: '0', block: null, subdivision: 'RYE RANCH' })).toContain("PAR_SUBDIV_LOT IN ('0', '00', '000', '0000') AND");
  });
  test('only letters and digits of the deed reach the where string: an apostrophe cannot end it', () => {
    expect(parcelWhere(parseLegal("LOT 5 O'NEIL ESTATES"))).toBe("PAR_SUBDIV_LOT IN ('5', '05', '005', '0005') AND PAR_SUBDIV_NAME LIKE 'O%NEIL%ESTATES%'");
    expect(parcelWhere(parseLegal('LOT 12A TOWN & COUNTRY ESTATES'))).toContain("LIKE 'TOWN%COUNTRY%ESTATES%'");
  });
  test('IN lists and one LIKE, joined by AND: the shapes the county firewall answers', () => {
    for (const text of ['LOT 171 RYE RANCH', 'LOT 36 BLK 48 NORTH RIVER RANCH', "LOT 5 O'NEIL ESTATES PH I-A", 'LOT 12A TOWN & COUNTRY ESTATES', 'LOT 07 BLK 0A ST. JOHNS']) {
      const where = parcelWhere(parseLegal(text));
      expect(where).not.toMatch(/\bOR\b|UPPER|LOWER|;|--|''/);
      expect(where.split(' AND ').every((part) => /^PAR_SUBDIV_(LOT|BLOCK) IN \('[0-9A-Za-z]+'(, '[0-9A-Za-z]+')*\)$|^PAR_SUBDIV_NAME LIKE '[A-Z0-9]+(%[A-Z0-9]+)*%'$/.test(part))).toBe(true);
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
  const parcel = (parid, ownerName, extra = {}) => ({ parid, ownerName, ownerName2: null, platKnown: true, addressLine1: `${parid.slice(-3)} EXAMPLE TRL`, ...extra });
  const permit = (no) => ({ permit_no: no });

  test('no parcels', () => {
    expect(chooseParcel({ sellerNames, parcels: [], permitsByParid: {} })).toEqual({ status: 'no_parcel' });
  });
  test('no parcel with a new-home permit: no_permit (the seller\'s name on a parcel is not enough)', () => {
    const p = parcel('100000001', 'EXAMPLE BUILDERS LLC');
    expect(chooseParcel({ sellerNames, parcels: [p], permitsByParid: {} })).toEqual({ status: 'no_permit' });
    expect(chooseParcel({ sellerNames, parcels: [p, parcel('100000002', 'TESTER ALEX J')], permitsByParid: { 100000009: permit('Z') } })).toEqual({ status: 'no_permit' });
  });
  test('a lookup that was never done is an error, not "nothing found"', () => {
    const p = parcel('100000001', 'EXAMPLE BUILDERS LLC');
    for (const parcels of [undefined, null, 'x', {}]) {
      expect(() => chooseParcel({ sellerNames, parcels, permitsByParid: {} })).toThrow(TypeError);
    }
    // A Promise is the permit read that was not awaited.
    for (const permitsByParid of [undefined, null, 'x', [], new Map(), Promise.resolve({})]) {
      expect(() => chooseParcel({ sellerNames, parcels: [p], permitsByParid })).toThrow(TypeError);
    }
  });
  test('the permits may be an object with no prototype', () => {
    const p = parcel('100000001', 'EXAMPLE BUILDERS LLC');
    const permitsByParid = Object.assign(Object.create(null), { 100000001: permit('A') });
    expect(chooseParcel({ sellerNames, parcels: [p], permitsByParid })).toMatchObject({ status: 'matched', permit: permit('A') });
  });
  test('one parcel with a permit, still under the seller\'s name: matched, owner_permit', () => {
    const p = parcel('100000001', 'EXAMPLE BUILDERS LLC');
    expect(chooseParcel({ sellerNames, parcels: [p], permitsByParid: { 100000001: permit('A') } }))
      .toEqual({ status: 'matched', basis: 'owner_permit', parcel: p, permit: permit('A') });
    const second = parcel('100000001', 'EXAMPLE LAND TRUST', { ownerName2: 'EXAMPLE BUILDERS LLC' });
    expect(chooseParcel({ sellerNames, parcels: [second], permitsByParid: { 100000001: permit('A') } })).toMatchObject({ status: 'matched', basis: 'owner_permit' });
  });
  test('one parcel with a permit and any other owner: matched, permit basis', () => {
    for (const owner of ['TESTER ALEX J', 'EXAMPLE BUILDERS', 'SAMPLE HOMESTEAD LLC', null, 'S\u00D8REN HOMES LLC']) {
      const p = parcel('100000001', owner);
      expect(chooseParcel({ sellerNames, parcels: [p], permitsByParid: { 100000001: permit('A') } }))
        .toEqual({ status: 'matched', basis: 'permit', parcel: p, permit: permit('A') });
    }
    const p = parcel('100000001', 'TESTER ALEX J');
    expect(chooseParcel({ sellerNames: [], parcels: [p], permitsByParid: { 100000001: permit('A') } })).toMatchObject({ status: 'matched', basis: 'permit' });
  });
  test('the same lot number in two phases is never matched, whoever owns them and whichever has a permit', () => {
    const owners = ['EXAMPLE BUILDERS LLC', 'TESTER ALEX J', 'EXAMPLE BUILDERS LLC OF SAMPLETON', 'A AND B HOMES LLC', 'OTHER BUILDERS LLC', null, ' - '];
    for (const first of owners) {
      for (const second of owners) {
        const parcels = [parcel('100000001', first), parcel('100000002', second)];
        for (const permitsByParid of [{ 100000001: permit('A') }, { 100000002: permit('B') }, { 100000001: permit('A'), 100000002: permit('B') }]) {
          expect(chooseParcel({ sellerNames, parcels, permitsByParid })).toEqual({ status: 'ambiguous' });
        }
      }
    }
    // The case the first rule matched wrongly: the seller holds the lot number in two phases, one with a permit.
    const built = parcel('100000001', 'EXAMPLE BUILDERS LLC');
    const vacant = parcel('100000002', 'EXAMPLE BUILDERS LLC');
    expect(chooseParcel({ sellerNames, parcels: [vacant, built], permitsByParid: { 100000001: permit('A') } })).toEqual({ status: 'ambiguous' });
  });
  test('a parcel whose plat name is not the deed\'s subdivision by the grammar: unknown_plat', () => {
    const permitsByParid = { 100000001: permit('A') };
    // Alone with a permit it would otherwise match.
    expect(chooseParcel({ sellerNames, parcels: [parcel('100000001', 'EXAMPLE BUILDERS LLC', { platKnown: false })], permitsByParid })).toEqual({ status: 'unknown_plat' });
    // Next to the deed's own plat it is not dropped: it may be the same subdivision under another name.
    const known = parcel('100000001', 'EXAMPLE BUILDERS LLC');
    for (const other of [parcel('100000002', 'TESTER ALEX J', { platKnown: false }), { parid: '100000002', ownerName: 'TESTER ALEX J', ownerName2: null }]) {
      expect(chooseParcel({ sellerNames, parcels: [known, other], permitsByParid })).toEqual({ status: 'unknown_plat' });
      expect(chooseParcel({ sellerNames, parcels: [other, known], permitsByParid })).toEqual({ status: 'unknown_plat' });
    }
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
      lot: '171', block: null, ownerName: 'EXAMPLE BUILDERS LLC', ownerName2: null, platKnown: true, livingSqft: 2210, stories: 1.5, yearBuilt: 2026,
    }]);
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.searchParams.get('where')).toBe("PAR_SUBDIV_LOT IN ('171', '0171') AND PAR_SUBDIV_NAME LIKE 'RYE%RANCH%'");
    expect(url.searchParams.get('outFields')).toContain('PAR_OWNER_NAME2');
    expect(url.searchParams.get('returnGeometry')).toBe('false');
    expect(url.searchParams.get('resultRecordCount')).toBe('25');
    expect(url.searchParams.get('f')).toBe('json');
    expect(url.searchParams.get('outFields')).toContain('PARID');
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual');
  });
  describe('platKnown: the plat name is the deed\'s subdivision by the grammar', () => {
    // One answer per name: an answer of 25 parcels or more is a cut-off answer.
    const flags = (deed, names) => Promise.all(names.map(async (name) => {
      const [p] = await queryParcels(deed, { fetchImpl: answer({ features: [feature({ PAR_SUBDIV_NAME: name })] }) });
      return p.platKnown;
    }));
    test('real forms of the rest of the name (digits changed)', async () => {
      const names = ['RYE RANCH', 'RYE RANCH PB81/1', 'RYE RANCH PB 81/1', 'RYE RANCH SUBDIVISION PB81/1', 'RYE RANCH SUBDIVISION', 'RYE RANCH PH I PB81/1',
        'RYE RANCH PH IIA PB81/1', 'RYE RANCH PH IV-A PB81/1', 'RYE RANCH PH IA-1 AND IA-2 PB81/1', 'RYE RANCH PH ID2 PB81/1', 'RYE RANCH PH N1A AND N1B PB81/1',
        'RYE RANCH PH IIA IIB & IIC PB81/1', 'RYE RANCH PH IIB-1, IIB-2 AND IIB-3 PB81/1', 'RYE RANCH PH IV-C1 PB81/1', 'RYE RANCH PH IVC, IVD AND IVE PB81/1',
        'RYE RANCH PH I SUBPH IA AND IB-1 PB81/1', 'RYE RANCH PH II SUBPH II-B-1, II-B-2, II-B-3 & II-B-4 PB81/1', 'RYE RANCH PH VIB AND VB SUBPH V1B-2 AND VB-1 PB81/1',
        'RYE RANCH PH II SUBPHASE B-D PB81/1', 'RYE RANCH PH II-A-1A PB81/1', 'RYE RANCH PH IA-I PB81/1', 'RYE RANCH PH IV-B', 'RYE RANCH PH V-A, V-B AND V-C',
        'RYE RANCH PHASE IIIC PB81/1', 'RYE RANCH PH 2 PB81/1', 'RYE RANCH PH 2A PB81/1', 'RYE RANCH PH I & II PB81/1', 'RYE RANCH  PH IV SUBPH IV-B-1, IV-B-2 AND  IV-B-3 PB81/1',
        'Rye Ranch Ph I PB81/1'];
      expect(await flags(legal, names)).toEqual(names.map(() => true));
    });
    test('another subdivision, another piece of land, or a form that was never seen', async () => {
      const names = ['RYE RANCH ESTATES', 'RYE RANCH ESTATES PH I PB81/1', 'RYE RANCH WEST PB81/1', 'RYE RANCH VILLAS PH VA-1 PB81/1', 'RYE RANCH IA PB81/1',
        'RYE RANCH III SUBDIVISION PB81/1', 'RYE RANCHES PH I', 'RYE RANCH PH II REPLAT OF LOT 4', 'RYE RANCH PH III-A TOWNHOMES PB81/1', 'RYE RANCH PH IC & ID WEST PB81/1',
        'RYE RANCH PH I LOTS 1-40 PB81/1', 'RYE RANCH PH I FKA SAMPLE ASSEMBLAGE PH I-A', 'RYE RANCH PH IB, IC, ID AND COLLECTOR ROAD II PB81/1', 'RYE RANCH PHILLIPS ADD',
        'RYE RANCH PH', 'RYE RANCH PH I PB81', 'RYE RANCH PH I PB81/1 EXTRA', 'RYE RANCH UNIT 3', 'RYE RANCH PB81/1 PH I'];
      expect(await flags(legal, names)).toEqual(names.map(() => false));
    });
    test('a phase on the deed is not the phase that only starts with it', async () => {
      const phaseOne = { lot: '171', block: null, subdivision: 'RYE RANCH PH I' };
      expect(await flags(phaseOne, ['RYE RANCH PH I', 'Rye Ranch Ph I PB81/1', 'RYE RANCH PH II', 'RYE RANCH PH IA PB81/1', 'RYE RANCH PH I-A', 'RYE RANCH PH IV']))
        .toEqual([true, true, false, false, false, false]);
    });
    test('a deed that already names the phase: its subphase and plat book on the map are the same plat', async () => {
      const phaseOne = { lot: '171', block: null, subdivision: 'RYE RANCH PH I' };
      expect(await flags(phaseOne, ['RYE RANCH PH I SUBPH A PB81/1', 'RYE RANCH PH I SUBPHASE IA AND IB', 'RYE RANCH PH I PB 81/1',
        'RYE RANCH PH I PH II', 'RYE RANCH PH I AND II PB81/1', 'RYE RANCH PH I SUBDIVISION', 'RYE RANCH PH I ESTATES']))
        .toEqual([true, true, true, false, false, false, false]);
      const subphase = { lot: '171', block: null, subdivision: 'RYE RANCH PH I SUBPH A' };
      expect(await flags(subphase, ['RYE RANCH PH I SUBPH A', 'RYE RANCH PH I SUBPH A PB81/1', 'RYE RANCH PH I SUBPH A SUBPH B', 'RYE RANCH PH I SUBPH A AND B']))
        .toEqual([true, true, false, false]);
    });
    // No clock in this test: a pattern that backtracks over these lists does not return before Jest's time limit.
    test('a very long list of phase ids is read token by token', async () => {
      const long = `RYE RANCH PH ${'I '.repeat(400)}${'IV-A-1-B, '.repeat(400)}NOT A PHASE`;
      expect(await flags(legal, [long, `RYE RANCH PH ${'I AND '.repeat(400)}I PB81/1`])).toEqual([false, true]);
    });
    test('the map\'s spacing and punctuation do not change the name', async () => {
      expect(await flags(legal, ['RYE  RANCH PH I PB81/1', 'RYE RANCH  PH IIA PB81/1', 'RYE-RANCH', 'RYERANCH PB81/1', 'RYE   RANCH']))
        .toEqual([true, true, true, true, true]);
      const saint = { lot: '171', block: null, subdivision: 'ST JOHNS' };
      expect(await flags(saint, ['ST. JOHNS PH I PB81/1', 'ST.JOHNS', 'ST. JOHNSON PH I', 'ST. JOHNS. PH I'])).toEqual([true, true, false, false]);
      // Known limit: a mark inside one of the deed's words on the map only. The query does not return such a name,
      // so an answer that holds one is not the answer to this question.
      await expect(queryParcels(saint, { fetchImpl: answer({ features: [feature({ PAR_SUBDIV_NAME: "ST JOHN'S PH I" })] }) })).rejects.toThrow(/not the lot asked for/);
      const phaseOne = { lot: '171', block: null, subdivision: 'RYE RANCH PH I' };
      expect(await flags(phaseOne, ['RYE RANCH  PH I', 'RYE  RANCH PH I SUBPH A PB81/1', 'RYE RANCH  PH II'])).toEqual([true, true, false]);
    });
    test('a parcel under other words is not a candidate; every other parcel stays', async () => {
      const features = [
        feature(),
        feature({ PARID: '513309060', PAR_SUBDIV_NAME: 'RYE CREEK RANCH PH I PB81/1' }),
        feature({ PARID: '513309061', PAR_SUBDIV_NAME: 'RYE RANCHO PH I' }),
        feature({ PARID: '513309062', PAR_SUBDIV_NAME: 'RYE  RANCH PH IV PB81/1' }),
      ];
      const parcels = await queryParcels(legal, { fetchImpl: answer({ features }) });
      expect(parcels.map((p) => [p.parid, p.platKnown])).toEqual([['513309059', true], ['513309061', false], ['513309062', true]]);
    });
    test('the lot and the block may have another form on the map; the map\'s own text is kept', async () => {
      const [padded] = await queryParcels(legal, { fetchImpl: answer({ features: [feature({ PAR_SUBDIV_LOT: '0171' })] }) });
      expect(padded.lot).toBe('0171');
      const lettered = { lot: '12A', block: '8', subdivision: 'RYE RANCH' };
      const [lower] = await queryParcels(lettered, { fetchImpl: answer({ features: [feature({ PAR_SUBDIV_LOT: '12a', PAR_SUBDIV_BLOCK: '08' })] }) });
      expect([lower.lot, lower.block]).toEqual(['12a', '08']);
      for (const other of [{ PAR_SUBDIV_LOT: '12B', PAR_SUBDIV_BLOCK: '8' }, { PAR_SUBDIV_LOT: '112A', PAR_SUBDIV_BLOCK: '8' }, { PAR_SUBDIV_LOT: '12A', PAR_SUBDIV_BLOCK: '18' }, { PAR_SUBDIV_LOT: '12A', PAR_SUBDIV_BLOCK: null }]) {
        await expect(queryParcels(lettered, { fetchImpl: answer({ features: [feature(other)] }) })).rejects.toThrow(/not the lot asked for/);
      }
    });
    test('no parcel of the answer is dropped, so a full page is still a cut-off answer', async () => {
      const full = Array.from({ length: 25 }, (_, i) => feature({ PARID: String(513309100 + i), PAR_SUBDIV_NAME: 'RYE RANCH ESTATES' }));
      await expect(queryParcels(legal, { fetchImpl: answer({ features: full }) })).rejects.toThrow(/cut off/);
      expect(await queryParcels(legal, { fetchImpl: answer({ features: full.slice(0, 24) }) })).toHaveLength(24);
    });
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
