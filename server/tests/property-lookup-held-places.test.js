/**
 * The public property lookup's `satellite.inServiceArea` verdict (the quote wizard reads it) applies the shared
 * excluded-place list beside the coordinate box, fresh and cached alike: DeSoto, Punta Gorda and the six places held
 * until a second technician is hired (owner ruling 2026-11-23). Fictitious addresses only.
 */
process.env.GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'test-key';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const { buildSatelliteUrlSet } = require('../routes/property-lookup-v2');
const { namesExcludedPlace, isInHeldLocalityPinBox } = require('../services/service-area');

const PORT_CHARLOTTE = [26.9759, -82.0909];
const VENICE = [27.0998, -82.4543];

describe('buildSatelliteUrlSet verdict', () => {
  test.each([
    [{ county: 'Charlotte', city: 'Port Charlotte', zip: '33948' }],
    [{ county: 'Charlotte', zip: '33981' }],
    [{ county: 'Charlotte', zip: '33983' }],
    [{ city: 'Deep Creek' }],
    [{ county: 'Sarasota', text: '1 Sample Way, Englewood, FL' }],
    [{ county: 'Charlotte', text: '1 Sample Way, Port Charlotte, FL 33952, USA' }],
    [{ county: 'Charlotte', text: '1 Sample Way, Rotonda West, FL' }],
    [{ county: 'Charlotte', text: '1 Sample Way, Punta Gorda, FL 33950' }],
  ])('a held or excluded place %j is out of area even inside the box', (evidence) => {
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, evidence).inServiceArea).toBe(false);
  });

  test('conflicting evidence: a typed held place beats a served formatted address, and the reverse', () => {
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', text: ['1 Sample Way, Venice, FL 34285', '1 Sample Way, Port Charlotte, FL 33948'] }).inServiceArea).toBe(false);
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', text: ['1 Sample Way, Port Charlotte, FL 33948', '1 Sample Way, Venice, FL 34285'] }).inServiceArea).toBe(false);
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
    expect(namesExcludedPlace({ zip: '34224-1234' })).toBe(true);
    expect(namesExcludedPlace({ text: '9 Sample Rd, Boca Grande, FL 33921' })).toBe(true);
    expect(namesExcludedPlace({ text: '9 Sample Rd, Babcock Ranch FL' })).toBe(true); // the city shares its part with the state
    expect(namesExcludedPlace({ text: '9 Sample Rd Port Charlotte FL' })).toBe(true); // no commas at all
    expect(namesExcludedPlace({ text: ['1 Sample Way, Venice, FL', '9 Sample Rd, Babcock Ranch FL'] })).toBe(true);
    expect(namesExcludedPlace({ places: [{ city: 'Venice', zip: '34285' }, { city: null, zip: '33948' }] })).toBe(true);
    expect(namesExcludedPlace({ places: [{ city: 'Venice', zip: '34285' }] })).toBe(false);
    expect(namesExcludedPlace({ text: '9 Sample Rd, Babcock Ranch, FL 33982' })).toBe(true);
    expect(namesExcludedPlace({ text: '9 Sample Rd, North Port, FL 34286' })).toBe(false);
    // each text on its own: a served ZIP in one never masks a held place in another
    expect(namesExcludedPlace({ text: ['1 Sample Way, Venice, FL 34285', '1 Sample Way, Port Charlotte, FL 33948'] })).toBe(true);
    expect(namesExcludedPlace({ text: ['1 Sample Way, Port Charlotte, FL 33948', '1 Sample Way, Venice, FL 34285'] })).toBe(true);
    expect(namesExcludedPlace({ text: ['1 Sample Way, Venice, FL 34285', null, ''] })).toBe(false);
    expect(namesExcludedPlace({})).toBe(false);
    expect(namesExcludedPlace()).toBe(false);
  });
});

describe('Englewood-area pin box', () => {
  test('covers Englewood and the Charlotte line, not Venice, Sarasota or Bradenton', () => {
    expect(isInHeldLocalityPinBox(26.96, -82.35)).toBe(true);
    expect(isInHeldLocalityPinBox(27.0443, -82.2359)).toBe(true); // North Port edge: a lookup runs only when city/ZIP are blank
    expect(isInHeldLocalityPinBox(...VENICE)).toBe(false);
    expect(isInHeldLocalityPinBox(27.3365, -82.5307)).toBe(false);
    expect(isInHeldLocalityPinBox(null, null)).toBe(false);
  });
});

describe('the fresh lookup uses the same rule', () => {
  test('the geocoded city and ZIP ride on the cached record, so a cache hit reaches the same verdict', () => {
    const source = fs.readFileSync(require.resolve('../routes/property-lookup-v2'), 'utf8');
    expect(source).toContain('result.propertyRecord._geoLocality = { city: geo.city || null, zip: geo.zip || null, formattedAddress: geo.formattedAddress || null };');
    expect(source).toContain('places: [record?._geoLocality].filter(Boolean),');
    // a street-only AI record (no city, no ZIP, a street-only formatted address) with the stored geocoded evidence
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', places: [{ city: 'Port Charlotte', zip: '33948' }], text: ['1 Sample Way'] }).inServiceArea).toBe(false);
    expect(buildSatelliteUrlSet(...PORT_CHARLOTTE, { county: 'Charlotte', places: [], text: ['1 Sample Way'] }).inServiceArea).toBe(true);
  });

  test('the geocoded verdict is the box AND no excluded place', () => {
    const source = fs.readFileSync(require.resolve('../routes/property-lookup-v2'), 'utf8');
    expect(source).toContain('inServiceArea: isInServiceAreaBox(lat, lng, { county: geo.county, zip: geo.zip })');
    expect(source).toContain('&& !namesExcludedPlace({');
    expect(source).toContain('places: [{ city: result.propertyRecord?.city, zip: result.propertyRecord?.zipCode }],');
    expect(source).toContain('text: [geo.formattedAddress, result.propertyRecord?.formattedAddress, address],');
    expect(source).toMatch(/city: record\?\.city \|\| null,/);
  });
});
