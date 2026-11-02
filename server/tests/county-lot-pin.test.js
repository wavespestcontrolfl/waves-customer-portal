const { parseCountyLotAddress, pinCountyForZip, lookupCountyLotPin, countyLotPinForAddress } = require('../services/property-lookup/county-lot-pin');

// ~14 m square lot centered on (lat, lng), as an ArcGIS polygon in WGS84.
function lot({ lat, lng, parcelId = '1000', zip = '34219', situs = '104 SAMPLE WAY' }) {
  const d = 0.00006;
  const ring = [[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]];
  return { attributes: { PARID: parcelId, SITUS_ADDRESS: situs, SITUS_POSTAL_ZIP: zip }, geometry: { rings: [ring] } };
}
const answer = (features, extra = {}) => { global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ features, ...extra }) })); };
const ASK = { county: 'Manatee', houseNumber: '104', streetWord: 'SAMPLE', zip: '34219' };

describe('parseCountyLotAddress', () => {
  test.each([
    ['104 Sample Way', '104', 'SAMPLE'],
    ['2101 J. Maple Ter', '2101', 'MAPLE'],
    ['3302 Demo Loop', '3302', 'DEMO'],
    ['4410 Test Pt Trl', '4410', 'TEST'],
    ['123 N Main St', '123', 'MAIN'],
    ['55 SE Lakeview Dr', '55', 'LAKEVIEW'],
  ])('%s', (line, houseNumber, streetWord) => {
    expect(parseCountyLotAddress(line)).toEqual({ houseNumber, streetWord });
  });

  test.each(['Sample Ter', '', null, '12 N St'])('no usable number or street word: %p', (line) => {
    expect(parseCountyLotAddress(line)).toBeNull();
  });
});

describe('pinCountyForZip', () => {
  test('Manatee and Sarasota resolve through the shared address-county map; the rest do not', () => {
    expect(pinCountyForZip('34219')).toBe('Manatee');
    expect(pinCountyForZip('34285')).toBe('Sarasota');
    expect(pinCountyForZip('33950')).toBeNull(); // Charlotte: no situs ZIP field
    expect(pinCountyForZip('34243')).toBeNull(); // on the Manatee/Sarasota line: fails closed
    expect(pinCountyForZip('abc')).toBeNull();
  });
});

describe('lookupCountyLotPin', () => {
  afterEach(() => { delete global.fetch; });

  test('one lot with the same ZIP gives its center, asking for geometry in WGS84', async () => {
    answer([lot({ lat: 27.58, lng: -82.42 })]);
    const pin = await lookupCountyLotPin(ASK);
    expect(pin.parcelId).toBe('1000');
    expect(pin.county).toBe('Manatee');
    expect(pin.lat).toBeCloseTo(27.58, 5);
    expect(pin.lng).toBeCloseTo(-82.42, 5);
    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.searchParams.get('returnGeometry')).toBe('true');
    expect(url.searchParams.get('outSR')).toBe('4326');
    expect(url.searchParams.get('where')).toBe("UPPER(SITUS_ADDRESS) LIKE '104 %SAMPLE%'");
  });

  test('a lot in another ZIP is ignored', async () => {
    answer([lot({ lat: 27.58, lng: -82.42, zip: '34202' })]);
    expect(await lookupCountyLotPin(ASK)).toBeNull();
  });

  test('two far lots are ambiguous', async () => {
    answer([lot({ lat: 27.58, lng: -82.42 }), lot({ lat: 27.59, lng: -82.42, parcelId: '1001' })]);
    expect(await lookupCountyLotPin(ASK)).toBeNull();
  });

  test('two lots within 60 m are one building: their mean', async () => {
    answer([lot({ lat: 27.58, lng: -82.42 }), lot({ lat: 27.58020, lng: -82.42, parcelId: '1001' })]);
    const pin = await lookupCountyLotPin(ASK);
    expect(pin.lat).toBeCloseTo(27.5801, 5);
    expect(pin.lng).toBeCloseTo(-82.42, 5);
  });

  test('a lot with no polygon makes the answer ambiguous', async () => {
    const bare = lot({ lat: 27.58, lng: -82.42 });
    delete bare.geometry;
    answer([bare]);
    expect(await lookupCountyLotPin(ASK)).toBeNull();
  });

  test('a center outside the service area is refused', async () => {
    answer([lot({ lat: 40.7, lng: -74.0 })]);
    expect(await lookupCountyLotPin(ASK)).toBeNull();
  });

  test('Charlotte, Hillsborough and unknown counties never reach the county', async () => {
    answer([lot({ lat: 27.58, lng: -82.42 })]);
    for (const county of ['Charlotte', 'Hillsborough', 'Lee', null]) {
      expect(await lookupCountyLotPin({ ...ASK, county })).toBeNull();
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['an HTTP error', () => { global.fetch = jest.fn(async () => ({ ok: false, status: 503 })); }],
    ['an ArcGIS error', () => answer(undefined, { error: { code: 400, message: 'bad' } })],
    ['a network failure', () => { global.fetch = jest.fn(async () => { throw new Error('socket'); }); }],
  ])('%s throws, so a caller never reads an outage as no lot', async (_name, arrange) => {
    arrange();
    await expect(lookupCountyLotPin(ASK)).rejects.toThrow();
  });

  test('a page-capped answer is not a lot', async () => {
    answer([lot({ lat: 27.58, lng: -82.42 })], { exceededTransferLimit: true });
    expect(await lookupCountyLotPin(ASK)).toBeNull();
  });

  test('countyLotPinForAddress parses the line and resolves the county from the ZIP', async () => {
    answer([lot({ lat: 27.58, lng: -82.42 })]);
    const pin = await countyLotPinForAddress({ address_line1: '104 Sample Way', zip: '34219' });
    expect(pin.parcelId).toBe('1000');
    expect(await countyLotPinForAddress({ address_line1: 'Sample Ter', zip: '34219' })).toBeNull();
    expect(await countyLotPinForAddress({ address_line1: '104 Sample Way', zip: '33950' })).toBeNull();
  });
});
