/**
 * Owner ruling 2026-09-30: DeSoto County is not served. The shared locality
 * list backs every text-evidence check, and the property-lookup cache hit
 * judges the DeSoto rectangle on the same county/ZIP evidence as a fresh
 * lookup. Fictitious data only.
 */
const fs = require('fs');
const {
  isDesotoLocality, isDesotoZip, isInServiceAreaBox, zipFromAddressText,
} = require('../services/service-area');

describe('DeSoto locality list', () => {
  test.each(['Arcadia', 'Lake Suzy', 'Ft. Ogden', 'ft ogden', 'Nocatee', 'Brownville', 'Southeast Arcadia'])(
    '%s is a DeSoto locality', (city) => {
      expect(isDesotoLocality(city)).toBe(true);
    },
  );

  test.each(['Port Charlotte', 'North Port', 'Venice', 'Riverview', 'Sarasota', '', null])(
    '%s is not a DeSoto locality', (city) => {
      expect(isDesotoLocality(city)).toBe(false);
    },
  );

  test('DeSoto ZIPs, ZIP+4 included', () => {
    expect(isDesotoZip('34266')).toBe(true);
    expect(isDesotoZip('34269-1234')).toBe(true);
    expect(isDesotoZip('34286')).toBe(false);
  });
});

describe('zipFromAddressText (Codex r5 P2)', () => {
  test.each([
    ['100 Example St, Sarasota, FL 34240, USA', '34240'],
    ['100 Example St, Sarasota FL 34240-1234', '34240'],
    ['100 Example St, Sarasota, Florida 34240', '34240'],
    ['100 Example St, Sarasota 34240', '34240'],
    ['12345 Example Rd, Port Charlotte, FL 33953, United States', '33953'],
  ])('%s -> %s', (text, zip) => {
    expect(zipFromAddressText(text)).toBe(zip);
  });

  test.each(['12345 Example Rd, Port Charlotte, FL', '', null])('no ZIP in %s', (text) => {
    expect(zipFromAddressText(text)).toBeNull();
  });
});

describe('property-lookup cache hit passes area evidence', () => {
  const source = fs.readFileSync(require.resolve('../routes/property-lookup-v2'), 'utf8');

  test('buildSatelliteUrlSet forwards its evidence to isInServiceAreaBox', () => {
    expect(source).toMatch(/function buildSatelliteUrlSet\(lat, lng, areaEvidence = \{\}\)/);
    expect(source).toMatch(/inServiceArea: isInServiceAreaBox\(lat, lng, areaEvidence\)/);
  });

  test('the cache-hit result passes the stored county and ZIP', () => {
    expect(source).toMatch(/satellite: buildSatelliteUrlSet\(lat, lng, \{\s*county: record\?\._parcel\?\.county/);
    expect(source).not.toMatch(/satellite: buildSatelliteUrlSet\(lat, lng\)/);
    expect(source).toContain('zipFromAddressText(record?.formattedAddress)');
    expect(source).toContain('zipFromAddressText(row?.normalized_address)');
  });

  test('a served county in the rectangle is in-area only when the evidence is passed', () => {
    // Inside the DeSoto rectangle: the coordinate alone fails closed.
    expect(isInServiceAreaBox(27.05, -82.0)).toBe(false);
    expect(isInServiceAreaBox(27.05, -82.0, { county: 'CHARLOTTE' })).toBe(true);
    expect(isInServiceAreaBox(27.05, -82.0, { county: 'DeSoto' })).toBe(false);
  });
});
