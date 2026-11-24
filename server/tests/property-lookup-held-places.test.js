/**
 * The public property lookup's `satellite.inServiceArea` verdict (the quote wizard reads it) applies the shared
 * excluded-place list beside the coordinate box, fresh and cached alike: DeSoto, Punta Gorda and any place held
 * until a second technician is hired. Owner ruling 2026-11-23 held eight places; the hold ended with the hire, so the
 * not-yet-served lists are empty and those places are in area. Fictitious addresses only.
 */
process.env.GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'test-key';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const { buildSatelliteUrlSet } = require('../routes/property-lookup-v2');
const { namesExcludedPlace, namesSharedZipWithoutCity } = require('../services/service-area');

const PORT_CHARLOTTE = [26.9759, -82.0909];
const VENICE = [27.0998, -82.4543];

describe('buildSatelliteUrlSet verdict', () => {
  test.each([
    [{ county: 'Charlotte', city: 'Gulf Cove', zip: '33981' }],
    [{ county: 'Charlotte', zip: '33981' }],
    [{ county: 'Charlotte', city: 'Port Charlotte', zip: '33980' }],
    [{ county: 'Charlotte', city: 'Port Charlotte', zip: '33948' }],
    [{ city: 'Deep Creek' }],
    [{ county: 'Charlotte', text: '1 Sample Way, Port Charlotte, FL 33981, USA' }],
    [{ county: 'Charlotte', text: '1 Sample Way, Port Charlotte, FL, USA' }],
    [{ county: 'Charlotte', text: '1 Sample Way, Rotonda West, FL' }],
    [{ county: 'Charlotte', text: '1 Sample Way, Placida, FL 33946' }],
    [{ county: 'Charlotte', text: '1 Sample Way, Boca Grande, FL' }],
    [{ county: 'Charlotte', text: '1 Sample Way, Babcock Ranch FL' }],
  ])('a place held on 2026-11-23 %j is in area inside the box again', (evidence) => {
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, evidence).inServiceArea).toBe(true);
  });

  test('Punta Gorda is still out of area inside the box', () => {
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', text: '1 Sample Way, Punta Gorda, FL 33950' }).inServiceArea).toBe(false);
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', text: ['1 Sample Way, Venice, FL 34285', '1 Sample Way, Punta Gorda, FL 33950'] }).inServiceArea).toBe(false);
  });

  test('Englewood is in area', () => {
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
    expect(namesExcludedPlace({ city: 'Punta Gorda' })).toBe(true);
    // the parse can leave a state / ZIP tail on the city
    expect(namesExcludedPlace({ text: '9 Sample Rd, Apt 4, Punta Gorda FL 33982' })).toBe(true);
    expect(namesExcludedPlace({ city: 'Punta Gorda FL 33982' })).toBe(true);
    expect(namesExcludedPlace({ places: [{ city: 'Punta Gorda, FL 33983-1234' }] })).toBe(true);
    expect(namesExcludedPlace({ zip: '33950-1234' })).toBe(true);
    expect(namesExcludedPlace({ text: '9 Sample Rd, Punta Gorda, FL 33950' })).toBe(true);
    expect(namesExcludedPlace({ text: '9 Sample Rd Punta Gorda FL' })).toBe(true); // no commas at all
    expect(namesExcludedPlace({ text: ['1 Sample Way, Venice, FL', '9 Sample Rd, Punta Gorda, FL'] })).toBe(true);
    expect(namesExcludedPlace({ places: [{ city: 'Venice', zip: '34285' }, { city: null, zip: '33950' }] })).toBe(true);
    expect(namesExcludedPlace({ places: [{ city: 'Venice', zip: '34285' }] })).toBe(false);
    // each text on its own: a served ZIP in one never masks an excluded place in another
    expect(namesExcludedPlace({ text: ['1 Sample Way, Venice, FL 34285', '1 Sample Way, Punta Gorda, FL 33950'] })).toBe(true);
    expect(namesExcludedPlace({ text: ['1 Sample Way, Punta Gorda, FL 33950', '1 Sample Way, Venice, FL 34285'] })).toBe(true);
    // the places held on 2026-11-23 are served again
    expect(namesExcludedPlace({ city: 'Placida' })).toBe(false);
    expect(namesExcludedPlace({ zip: '33947-1234' })).toBe(false);
    expect(namesExcludedPlace({ text: '9 Sample Rd, Boca Grande, FL 33921' })).toBe(false);
    expect(namesExcludedPlace({ text: '9 Sample Rd, Babcock Ranch FL' })).toBe(false);
    expect(namesExcludedPlace({ text: '9 Sample Rd Rotonda West FL' })).toBe(false);
    expect(namesExcludedPlace({ text: '9 Sample Rd, Port Charlotte, FL 33948' })).toBe(false);
    expect(namesExcludedPlace({ text: '9 Sample Rd, North Port, FL 34286' })).toBe(false);
    expect(namesExcludedPlace({ text: '9 Sample Rd Englewood FL' })).toBe(false);
    expect(namesExcludedPlace({ zip: '34224-1234' })).toBe(false);
    expect(namesExcludedPlace({ text: ['1 Sample Way, Venice, FL 34285', null, ''] })).toBe(false);
    expect(namesExcludedPlace({})).toBe(false);
    expect(namesExcludedPlace()).toBe(false);
  });
});

describe('a ZIP Punta Gorda shares, with no city anywhere, is unknown (null), never true', () => {
  test('namesSharedZipWithoutCity reads the zip, the places and the text; a city anywhere resolves it', () => {
    for (const zip of ['33980', '33982', '33983', '33982-1234']) expect(namesSharedZipWithoutCity({ zip })).toBe(true);
    expect(namesSharedZipWithoutCity({ places: [{ city: '', zip: '33983' }] })).toBe(true);
    expect(namesSharedZipWithoutCity({ text: '9 Sample Rd, FL 33982' })).toBe(true);
    expect(namesSharedZipWithoutCity({ text: ['1 Sample Way', '9 Sample Rd, FL 33980'] })).toBe(true);
    expect(namesSharedZipWithoutCity({ zip: '33982', city: 'Babcock Ranch' })).toBe(false);
    expect(namesSharedZipWithoutCity({ zip: '33983', places: [{ city: 'Port Charlotte' }] })).toBe(false);
    expect(namesSharedZipWithoutCity({ text: '9 Sample Rd, Babcock Ranch, FL 33982' })).toBe(false);
    // a state / ZIP tail an address parse takes for a city (a unit address) is not a city
    expect(namesSharedZipWithoutCity({ text: '9 Sample Rd, Apt 4, FL 33982' })).toBe(true);
    expect(namesSharedZipWithoutCity({ city: 'FL 33982', zip: '33982' })).toBe(true);
    expect(namesSharedZipWithoutCity({ text: '9 Sample Rd, Apt 4, FL 33982-1234' })).toBe(true); // a ZIP+4 tail is not a city
    expect(namesSharedZipWithoutCity({ text: '9 Sample Rd, Unit 4, FL 33982' })).toBe(true);
    expect(namesSharedZipWithoutCity({ text: '9 Sample Rd, Apt 4, Babcock Ranch FL 33982' })).toBe(false);
    expect(namesSharedZipWithoutCity({ zip: '33948' })).toBe(false);
    expect(namesSharedZipWithoutCity({})).toBe(false);
    expect(namesSharedZipWithoutCity()).toBe(false);
  });

  test('buildSatelliteUrlSet (fresh and cached share it): null with no city, true with a served city, false for Punta Gorda or outside the box', () => {
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', zip: '33982' }).inServiceArea).toBeNull();
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', places: [{ city: null, zip: '33983' }], text: ['1 Sample Way'] }).inServiceArea).toBeNull();
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', zip: '33982', text: ['9 Sample Rd, Apt 4, FL 33982'] }).inServiceArea).toBeNull();
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', zip: '33982', text: ['9 Sample Rd, Apt 4, FL 33982-1234'] }).inServiceArea).toBeNull();
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', zip: '33982', text: ['9 Sample Rd, Apt 4, Punta Gorda FL 33982'] }).inServiceArea).toBe(false);
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', zip: '33982', city: 'Babcock Ranch' }).inServiceArea).toBe(true);
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', zip: '33983', text: '1 Sample Way, Port Charlotte, FL 33983' }).inServiceArea).toBe(true);
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', zip: '33982', city: 'Punta Gorda' }).inServiceArea).toBe(false);
    expect(buildSatelliteUrlSet(40.7, -74.0, { zip: '33982' }).inServiceArea).toBe(false);
  });
});

describe('the fresh lookup uses the same rule', () => {
  test('the geocoded city and ZIP ride on the cached record, so a cache hit reaches the same verdict', () => {
    const source = fs.readFileSync(require.resolve('../routes/property-lookup-v2'), 'utf8');
    expect(source).toContain('result.propertyRecord._geoLocality = { city: geo.city || null, zip: geo.zip || null, formattedAddress: geo.formattedAddress || null };');
    expect(source).toContain('places: [record?._geoLocality].filter(Boolean),');
    // a street-only AI record (no city, no ZIP, a street-only formatted address) with the stored geocoded evidence
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', places: [{ city: 'Punta Gorda', zip: '33950' }], text: ['1 Sample Way'] }).inServiceArea).toBe(false);
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', places: [{ city: 'Gulf Cove', zip: '33981' }], text: ['1 Sample Way'] }).inServiceArea).toBe(true);
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
