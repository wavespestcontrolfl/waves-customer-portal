// GATE_NEIGHBORHOOD_ADDRESS_LOOKUP: when a home's stored pin sits on another
// lot, the county roll is asked for the home's own address. All addresses are
// synthetic; nothing here reaches the network (fetch and the lot search are stubbed).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { homeParcel, sameHouse } = require('../services/neighborhood-access');
const { lookupCountyParcelsByAddress } = require('../services/property-lookup/county-parcel-gis');
const gates = require('../config/feature-gates');

const GATES = ['GATE_NEIGHBORHOOD_ACCESS', 'GATE_NEIGHBORHOOD_NAMING', 'GATE_NEIGHBORHOOD_ADDRESS_LOOKUP'];
const saved = Object.fromEntries(GATES.map((k) => [k, process.env[k]]));
const setGates = (values) => GATES.forEach((k, i) => {
  if (values[i] === undefined) delete process.env[k]; else process.env[k] = values[i];
});
afterEach(() => setGates(GATES.map((k) => saved[k])));

const lot = (situs, extra = {}) => ({
  county: 'Manatee', parcelId: `P-${situs}`, subdivision: 'HERON POINTE PH I PB1/1', situsAddress: situs, situsZip: '34202', ...extra,
});
const home = (street, zip = '34202') => ({ address_line1: street, city: 'Lakewood Ranch', zip });

describe('neighborhoodAddressLookupLive', () => {
  test.each([
    ['true', 'true', 'true', true],
    ['true', 'true', undefined, false],
    ['true', 'true', 'yes', false],
    ['true', undefined, 'true', false],
    [undefined, 'true', 'true', false],
  ])('access=%s naming=%s address=%s → %s', (access, naming, address, live) => {
    setGates([access, naming, address]);
    expect(gates.neighborhoodAddressLookupLive()).toBe(live);
  });
});

describe('homeParcel', () => {
  beforeEach(() => setGates(['true', 'true', 'true']));

  test('a pin on the home\'s own lot is used as is; the county is not asked again', async () => {
    const addressLookup = jest.fn();
    const pin = lot('104 SAMPLE WAY');
    expect(await homeParcel(home('104 Sample Way'), pin, { addressLookup })).toBe(pin);
    expect(addressLookup).not.toHaveBeenCalled();
  });

  test('a pin on a neighbour\'s lot: the home\'s own lot is found by house number and street word', async () => {
    const own = lot('104 SAMPLE WAY');
    const addressLookup = jest.fn(async () => [own, lot('1040 SAMPLE WAY')]);
    expect(await homeParcel(home('104 Sample Way'), lot('100 SAMPLE WAY'), { addressLookup })).toBe(own);
    expect(addressLookup).toHaveBeenCalledWith('Manatee', { houseNumber: '104', streetWord: 'SAMPLE' });
  });

  // The term is the longest NAME word as the home's address spells it: never the
  // canonical form ("%LK%"), the suffix ("%DRIVE%"), a directional or a bare number.
  test.each([
    ['7 N Sample Ave', 'SAMPLE'],
    ['104 Lake Sample Dr', 'SAMPLE'],
    ['104 Lake Drive', 'LAKE'],
    ['12 River Grove Way', 'RIVER'],
    ['5 99th St West', '99TH'],
    ['12 Oak St Apt 100', 'OAK'],
    ['1200 US 41', 'US'],
    ['100 Broadway', 'BROADWAY'],
  ])('%s is searched as %s', async (street, streetWord) => {
    const addressLookup = jest.fn(async () => []);
    await homeParcel(home(street), null, { addressLookup });
    expect(addressLookup).toHaveBeenCalledWith('Manatee', { houseNumber: street.split(' ')[0], streetWord });
  });

  // The stub answers as the county does: LIKE '<number> %<word>%' over the roll's own spellings.
  const rollLike = (situses) => jest.fn(async (_county, { houseNumber, streetWord }) => situses
    .filter((s) => s.startsWith(`${houseNumber} `) && s.slice(`${houseNumber} `.length).includes(streetWord)).map((s) => lot(s)));
  test.each([
    ['104 Lake Drive', '104 LAKE DR'],
    ['104 Lake Sample Dr', '104 LAKE SAMPLE DR'],
    ['12 River Grove Way', '12 RIVER GROVE WAY'],
    ['5 99th St West', '5 99TH ST W'],
    ['500 Sample Loop #201', '500 SAMPLE LOOP UNIT 201'],
  ])('%s finds the roll\'s %s', async (street, situs) => {
    const roll = rollLike([situs, `${street.split(' ')[0]} OTHER CT`, `9${situs}`]);
    expect((await homeParcel(home(street), null, { addressLookup: roll }))?.situsAddress).toBe(situs);
  });

  test('no lot under the pin is searched by address too; one building\'s units name one community', async () => {
    const units = [lot('200 SAMPLE WAY UNIT 3'), lot('200 SAMPLE WAY UNIT 4', { subdivision: 'HERON POINTE PH II PB1/2' })];
    expect(await homeParcel(home('200 Sample Way'), null, { addressLookup: async () => units })).toBe(units[0]);
  });

  test('lots that name two communities, or none that pass the proof, leave the pin\'s answer', async () => {
    const pin = lot('100 SAMPLE WAY');
    const two = async () => [lot('300 SAMPLE WAY'), lot('300 SAMPLE WAY', { subdivision: 'OTHER GLEN PB2/2' })];
    expect(await homeParcel(home('300 Sample Way'), pin, { addressLookup: two })).toBe(pin);
    // Another ZIP, another suffix, another number: never the home.
    const none = async () => [lot('400 SAMPLE WAY', { situsZip: '34211' }), lot('400 SAMPLE CT'), lot('4000 SAMPLE WAY')];
    expect(await homeParcel(home('400 Sample Way'), pin, { addressLookup: none })).toBe(pin);
    expect(await homeParcel(home('400 Sample Way'), null, { addressLookup: none })).toBeNull();
  });

  test('a Sarasota plat is one community by its number', async () => {
    const sarasota = (situs, subdivision) => lot(situs, { county: 'Sarasota', subdivision, situsZip: '34238' });
    const units = [sarasota('6 SAMPLE LN UNIT 2, SARASOTA FL, 34238', '9901'), sarasota('6 SAMPLE LN UNIT 3, SARASOTA FL, 34238', '9901')];
    expect(await homeParcel(home('6 Sample Ln', '34238'), null, { addressLookup: async () => units })).toBe(units[0]);
    const split = [units[0], sarasota('6 SAMPLE LN UNIT 3, SARASOTA FL, 34238', '9902')];
    expect(await homeParcel(home('6 Sample Ln', '34238'), null, { addressLookup: async () => split })).toBeNull();
    // Known limit: a unit row written "<number> <street> <unit> BLD <n>" keeps its bare unit number in the street.
    const bld = [sarasota('6 SAMPLE LN 3 BLD 2, SARASOTA FL, 34238', '9901')];
    expect(await homeParcel(home('6 Sample Ln', '34238'), null, { addressLookup: async () => bld })).toBeNull();
  });

  test('a ZIP on no county list searches the pin\'s county; no county at all, no search', async () => {
    const addressLookup = jest.fn(async () => []);
    await homeParcel(home('9 Sample Way', '99999'), lot('1 SAMPLE WAY', { county: 'Sarasota' }), { addressLookup });
    expect(addressLookup).toHaveBeenCalledWith('Sarasota', expect.any(Object));
    addressLookup.mockClear();
    expect(await homeParcel(home('9 Sample Way', '99999'), null, { addressLookup })).toBeNull();
    expect(addressLookup).not.toHaveBeenCalled();
  });

  test('a failed search throws, so the caller never reads an outage as no lot', async () => {
    await expect(homeParcel(home('500 Sample Way'), null, { addressLookup: async () => { throw new Error('county down'); } }))
      .rejects.toThrow('county down');
  });

  test('off: the pin alone decides and the county is never asked by address', async () => {
    setGates(['true', 'true', undefined]);
    const addressLookup = jest.fn();
    const pin = lot('100 SAMPLE WAY');
    expect(await homeParcel(home('104 Sample Way'), pin, { addressLookup })).toBe(pin);
    expect(addressLookup).not.toHaveBeenCalled();
  });
});

describe('a "#" unit tail', () => {
  test('on, "#201" is a unit like UNIT 201; off, it stays a street word', () => {
    setGates(['true', 'true', 'true']);
    expect(sameHouse('500 Sample Loop #201', '500 SAMPLE LOOP')).toBe(true);
    expect(sameHouse('500 Sample Loop # 201, Lakewood Ranch FL', '500 SAMPLE LOOP UNIT 101')).toBe(true);
    expect(sameHouse('500 Sample Loop #201', '500 SAMPLE CT')).toBe(false);
    setGates(['true', 'true', undefined]);
    expect(sameHouse('500 Sample Loop #201', '500 SAMPLE LOOP')).toBe(false);
  });
});

describe('lookupCountyParcelsByAddress', () => {
  const realFetch = global.fetch;
  const answer = (body, ok = true) => jest.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => body }));
  afterEach(() => { global.fetch = realFetch; });

  test('one LIKE on the situs field (no AND or OR), every lot parsed with its county', async () => {
    global.fetch = answer({ features: [
      { attributes: { PARID: '111', SITUS_ADDRESS: '104 SAMPLE WAY', SITUS_POSTAL_ZIP: '34202', PAR_SUBDIV_NAME: 'HERON POINTE PH I PB1/1' } },
      { attributes: { SITUS_ADDRESS: 'NO PARCEL ID' } },
    ] });
    const lots = await lookupCountyParcelsByAddress('Manatee', { houseNumber: '104', streetWord: 'sample' });
    expect(lots).toEqual([expect.objectContaining({ county: 'Manatee', parcelId: '111', situsAddress: '104 SAMPLE WAY', situsZip: '34202', subdivision: 'HERON POINTE PH I PB1/1' })]);
    const url = new URL(String(global.fetch.mock.calls[0][0]));
    expect(url.searchParams.get('where')).toBe("UPPER(SITUS_ADDRESS) LIKE '104 %SAMPLE%'");
    expect(url.searchParams.get('where')).not.toMatch(/\b(?:AND|OR)\b/);
  });

  test('Sarasota reads its own situs field', async () => {
    global.fetch = answer({ features: [] });
    expect(await lookupCountyParcelsByAddress('Sarasota', { houseNumber: '6', streetWord: 'SAMPLE' })).toEqual([]);
    expect(new URL(String(global.fetch.mock.calls[0][0])).searchParams.get('where')).toBe("UPPER(fulladdress) LIKE '6 %SAMPLE%'");
  });

  test('a page-capped answer is no lot; an HTTP or layer error throws', async () => {
    global.fetch = answer({ exceededTransferLimit: true, features: [{ attributes: { PARID: '1', SITUS_ADDRESS: '1 SAMPLE WAY' } }] });
    expect(await lookupCountyParcelsByAddress('Manatee', { houseNumber: '1', streetWord: 'SAMPLE' })).toEqual([]);
    global.fetch = answer({}, false);
    await expect(lookupCountyParcelsByAddress('Manatee', { houseNumber: '1', streetWord: 'SAMPLE' })).rejects.toThrow('503');
    global.fetch = answer({ error: { message: 'boom' } });
    await expect(lookupCountyParcelsByAddress('Manatee', { houseNumber: '1', streetWord: 'SAMPLE' })).rejects.toThrow('boom');
  });

  test('nothing to search (no number, a bad number, a one-letter word, an unknown county) asks nothing', async () => {
    global.fetch = answer({ features: [] });
    for (const args of [['Manatee', { streetWord: 'SAMPLE' }], ['Manatee', { houseNumber: "1' OR '1'='1", streetWord: 'SAMPLE' }],
      ['Manatee', { houseNumber: '1', streetWord: 'S' }], ['Nowhere', { houseNumber: '1', streetWord: 'SAMPLE' }]]) {
      expect(await lookupCountyParcelsByAddress(...args)).toEqual([]);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('the street word is reduced to letters and digits before it reaches the query', async () => {
    global.fetch = answer({ features: [] });
    await lookupCountyParcelsByAddress('Manatee', { houseNumber: '1', streetWord: "SAM'PLE%" });
    expect(new URL(String(global.fetch.mock.calls[0][0])).searchParams.get('where')).toBe("UPPER(SITUS_ADDRESS) LIKE '1 %SAMPLE%'");
  });
});
