/**
 * The store's one rule that needs no database (services/mail/prospect-store.js): the forms a county parcel number
 * takes in the permit table. The reads and writes themselves are proven on real PostgreSQL in
 * mail-prospect-store-postgres.test.js. Parcel numbers are made up.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/property-lookup/manatee-permit-sync', () => ({ looseAddressKey: jest.fn() }));

const { permitPinForms } = require('../services/mail/prospect-store');

describe('permitPinForms', () => {
  test('a 10-digit PARID is its own pin; a 9-digit one also matches with a trailing 0', () => {
    expect(permitPinForms('1234567890')).toEqual(['1234567890']);
    expect(permitPinForms('513309059')).toEqual(['513309059', '5133090590']);
  });
  test('anything else has no form', () => {
    for (const bad of ['12345678', '12345678901', 'ABC123456', '', null, undefined]) expect(permitPinForms(bad)).toEqual([]);
  });
});
