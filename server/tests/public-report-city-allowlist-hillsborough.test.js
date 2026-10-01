/**
 * The public-report city allowlist covers the served south-Hillsborough towns
 * (reused from config/locations.js) and still excludes towns Waves does not
 * serve (DeSoto, owner ruling 2026-09-30).
 */
const { safePublicCity, PUBLIC_CITY_ALLOWLIST } = require('../utils/public-report-egress');
const { SOUTH_HILLSBOROUGH_CITIES } = require('../config/locations');

describe('PUBLIC_CITY_ALLOWLIST south Hillsborough', () => {
  test('contains every served south-Hillsborough town', () => {
    expect(SOUTH_HILLSBOROUGH_CITIES).toHaveLength(6);
    for (const city of SOUTH_HILLSBOROUGH_CITIES) {
      expect(PUBLIC_CITY_ALLOWLIST.has(city)).toBe(true);
    }
  });

  test.each([
    ['ruskin', 'Ruskin'],
    ['Apollo Beach', 'Apollo Beach'],
    ['  sun city center ', 'Sun City Center'],
    ['WIMAUMA', 'Wimauma'],
    ['gibsonton', 'Gibsonton'],
    ['Riverview', 'Riverview'],
  ])('safePublicCity(%j) renders %j', (input, expected) => {
    expect(safePublicCity(input)).toBe(expected);
  });

  test('existing Manatee/Sarasota/Charlotte towns still render', () => {
    expect(safePublicCity('venice')).toBe('Venice');
    expect(safePublicCity('Punta Gorda')).toBe('Punta Gorda');
  });

  test('DeSoto towns and free-text values are still omitted', () => {
    for (const city of ['arcadia', 'desoto', 'nocatee', 'Ruskin gate code 1234', 'tampa']) {
      expect(safePublicCity(city)).toBeNull();
    }
  });
});
