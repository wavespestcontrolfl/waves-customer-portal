/**
 * The public property lookup's `satellite.inServiceArea` verdict (the quote wizard reads it) applies the shared
 * excluded-place list beside the coordinate box, fresh and cached alike: DeSoto, Punta Gorda and the places held
 * until a second technician is hired (owner ruling 2026-11-23; Englewood and Port Charlotte are served again). Fictitious
 * addresses only.
 */
process.env.GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'test-key';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const { buildSatelliteUrlSet } = require('../routes/property-lookup-v2');
const { namesExcludedPlace, namesPortCharlotteWithoutZip } = require('../services/service-area');

const PORT_CHARLOTTE = [26.9759, -82.0909];
const VENICE = [27.0998, -82.4543];

describe('buildSatelliteUrlSet verdict', () => {
  test.each([
    [{ county: 'Charlotte', city: 'Gulf Cove', zip: '33981' }],
    [{ county: 'Charlotte', zip: '33981' }],
    [{ county: 'Charlotte', zip: '33983' }],
    [{ county: 'Charlotte', zip: '33980' }],
    [{ county: 'Charlotte', city: 'Port Charlotte', zip: '33980' }], // a Port Charlotte address on a shared ZIP is held by ZIP
    [{ city: 'Deep Creek' }],
    [{ county: 'Charlotte', text: '1 Sample Way, Port Charlotte, FL 33981, USA' }],
    [{ county: 'Charlotte', text: '1 Sample Way, Rotonda West, FL' }],
    [{ county: 'Charlotte', text: '1 Sample Way, Placida, FL 33946' }],
    [{ county: 'Charlotte', text: '1 Sample Way, Boca Grande, FL' }],
    [{ county: 'Charlotte', text: '1 Sample Way, Babcock Ranch FL' }],
    [{ county: 'Charlotte', text: '1 Sample Way, Punta Gorda, FL 33950' }],
  ])('a held or excluded place %j is out of area even inside the box', (evidence) => {
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, evidence).inServiceArea).toBe(false);
  });

  test('conflicting evidence: a typed held place beats a served formatted address, and the reverse', () => {
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', text: ['1 Sample Way, Venice, FL 34285', '1 Sample Way, Rotonda West, FL 33947'] }).inServiceArea).toBe(false);
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', text: ['1 Sample Way, Rotonda West, FL 33947', '1 Sample Way, Venice, FL 34285'] }).inServiceArea).toBe(false);
  });

  test('Port Charlotte and Englewood are in area again (owner "ok do this", 2026-11-23)', () => {
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', city: 'Port Charlotte', zip: '33948' }).inServiceArea).toBe(true);
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', text: '1 Sample Way, Port Charlotte, FL 33952, USA' }).inServiceArea).toBe(true);
    expect(buildSatelliteUrlSet(26.96, -82.35, { county: 'Sarasota', text: '1 Sample Way, Englewood, FL 34223' }).inServiceArea).toBe(true);
    expect(buildSatelliteUrlSet(26.96, -82.35, { county: 'Charlotte', city: 'Englewood', zip: '34224' }).inServiceArea).toBe(true);
  });

  test('a served place stays in area, North Port included', () => {
    expect(buildSatelliteUrlSet(...VENICE, { county: 'Sarasota', city: 'Venice', zip: '34285', text: '1 Sample Way, Venice, FL 34285' }).inServiceArea).toBe(true);
    expect(buildSatelliteUrlSet(27.0443, -82.2359, { county: 'Sarasota', city: 'North Port', zip: '34287', text: '1 Sample Way, North Port, FL 34287' }).inServiceArea).toBe(true);
    expect(buildSatelliteUrlSet(...VENICE, {}).inServiceArea).toBe(true);
  });
});

describe('namesExcludedPlace', () => {
  test('reads the city, the ZIP and each comma part of the text', () => {
    expect(namesExcludedPlace({ city: 'Placida' })).toBe(true);
    expect(namesExcludedPlace({ zip: '33947-1234' })).toBe(true);
    expect(namesExcludedPlace({ text: '9 Sample Rd, Boca Grande, FL 33921' })).toBe(true);
    expect(namesExcludedPlace({ text: '9 Sample Rd, Babcock Ranch FL' })).toBe(true); // the city shares its part with the state
    expect(namesExcludedPlace({ text: '9 Sample Rd Rotonda West FL' })).toBe(true); // no commas at all
    expect(namesExcludedPlace({ text: ['1 Sample Way, Venice, FL', '9 Sample Rd, Babcock Ranch FL'] })).toBe(true);
    expect(namesExcludedPlace({ places: [{ city: 'Venice', zip: '34285' }, { city: null, zip: '33947' }] })).toBe(true);
    expect(namesExcludedPlace({ places: [{ city: 'Venice', zip: '34285' }] })).toBe(false);
    expect(namesExcludedPlace({ text: '9 Sample Rd, Babcock Ranch, FL 33982' })).toBe(true);
    expect(namesExcludedPlace({ text: '9 Sample Rd, North Port, FL 34286' })).toBe(false);
    // each text on its own: a served ZIP in one never masks a held place in another
    expect(namesExcludedPlace({ text: ['1 Sample Way, Venice, FL 34285', '1 Sample Way, Rotonda West, FL 33947'] })).toBe(true);
    expect(namesExcludedPlace({ text: ['1 Sample Way, Rotonda West, FL 33947', '1 Sample Way, Venice, FL 34285'] })).toBe(true);
    // Englewood and Port Charlotte are served again
    expect(namesExcludedPlace({ text: '9 Sample Rd, Port Charlotte, FL 33948' })).toBe(false);
    expect(namesExcludedPlace({ text: '9 Sample Rd Englewood FL' })).toBe(false);
    expect(namesExcludedPlace({ zip: '34224-1234' })).toBe(false);
    expect(namesExcludedPlace({ text: ['1 Sample Way, Venice, FL 34285', null, ''] })).toBe(false);
    expect(namesExcludedPlace({})).toBe(false);
    expect(namesExcludedPlace()).toBe(false);
  });
});

describe('Port Charlotte with no usable ZIP is unknown (null), never true (owner ruling 2026-11-23)', () => {
  test('namesPortCharlotteWithoutZip reads the city, the places and the text; a five-digit or ZIP+4 ZIP anywhere clears it', () => {
    expect(namesPortCharlotteWithoutZip({ city: 'Port Charlotte' })).toBe(true);
    expect(namesPortCharlotteWithoutZip({ places: [{ city: 'port charlotte', zip: '' }] })).toBe(true);
    expect(namesPortCharlotteWithoutZip({ text: '9 Sample Rd, Port Charlotte, FL, USA' })).toBe(true);
    expect(namesPortCharlotteWithoutZip({ text: '9 Sample Rd Port Charlotte FL' })).toBe(true);
    expect(namesPortCharlotteWithoutZip({ city: 'Port Charlotte', zip: '3398' })).toBe(true); // a fragment is not a ZIP
    expect(namesPortCharlotteWithoutZip({ city: 'Port Charlotte', zip: 'abcde' })).toBe(true);
    expect(namesPortCharlotteWithoutZip({ city: 'Port Charlotte', zip: '33948' })).toBe(false);
    expect(namesPortCharlotteWithoutZip({ city: 'Port Charlotte', zip: '33948-1234' })).toBe(false);
    expect(namesPortCharlotteWithoutZip({ city: 'Port Charlotte', places: [{ zip: '33952' }] })).toBe(false);
    expect(namesPortCharlotteWithoutZip({ text: ['9 Sample Rd, Port Charlotte, FL', '9 Sample Rd, Port Charlotte, FL 33954'] })).toBe(false);
    expect(namesPortCharlotteWithoutZip({ city: 'Venice' })).toBe(false);
    expect(namesPortCharlotteWithoutZip({})).toBe(false);
    expect(namesPortCharlotteWithoutZip()).toBe(false);
  });

  test('buildSatelliteUrlSet: null for a ZIP-less Port Charlotte, true with a ZIP, false for a held place or outside the box', () => {
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', text: '1 Sample Way, Port Charlotte, FL, USA' }).inServiceArea).toBeNull();
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', city: 'Port Charlotte', zip: '3398' }).inServiceArea).toBeNull();
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', city: 'Port Charlotte', zip: '33948' }).inServiceArea).toBe(true);
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', city: 'Port Charlotte', zip: '33981' }).inServiceArea).toBe(false);
    expect(buildSatelliteUrlSet(40.7, -74.0, { city: 'Port Charlotte' }).inServiceArea).toBe(false);
  });
});

describe('the fresh lookup uses the same rule', () => {
  test('the geocoded city and ZIP ride on the cached record, so a cache hit reaches the same verdict', () => {
    const source = fs.readFileSync(require.resolve('../routes/property-lookup-v2'), 'utf8');
    expect(source).toContain('result.propertyRecord._geoLocality = { city: geo.city || null, zip: geo.zip || null, formattedAddress: geo.formattedAddress || null };');
    expect(source).toContain('places: [record?._geoLocality].filter(Boolean),');
    // a street-only AI record (no city, no ZIP, a street-only formatted address) with the stored geocoded evidence
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', places: [{ city: 'Gulf Cove', zip: '33981' }], text: ['1 Sample Way'] }).inServiceArea).toBe(false);
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', places: [], text: ['1 Sample Way'] }).inServiceArea).toBe(true);
  });

  test('the geocoded verdict is the box AND no excluded place', () => {
    const source = fs.readFileSync(require.resolve('../routes/property-lookup-v2'), 'utf8');
    expect(source).toContain('inServiceArea: serviceAreaVerdict(isInServiceAreaBox(lat, lng, { county: geo.county, zip: geo.zip }), {');
    expect(source).toContain('inServiceArea: serviceAreaVerdict(isInServiceAreaBox(lat, lng, areaEvidence), areaEvidence),');
    expect(source).toContain('places: [{ city: result.propertyRecord?.city, zip: result.propertyRecord?.zipCode }],');
    expect(source).toContain('text: [geo.formattedAddress, result.propertyRecord?.formattedAddress, address],');
    expect(source).toMatch(/city: record\?\.city \|\| null,/);
  });
});
