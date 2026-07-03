/**
 * Unit-aware customer matching for self-booking.
 *
 * Street + zip alone is not identity in a multi-unit building: the address
 * lookup used to match any customer on the same street line, so a visitor in
 * Apt B could be linked to (and confirm a booking under) Apt A's account.
 * addressMatchesCustomer / findUniqueCustomerByAddress now reject a match
 * when BOTH sides carry a unit and they disagree; a blank side stays
 * compatible because most on-file addresses predate unit capture.
 */
const { addressMatchesCustomer, unitsConflict } = require('../routes/booking')._internals;

describe('unitsConflict', () => {
  test('no conflict when either side is blank', () => {
    expect(unitsConflict('', 'Apt 4')).toBe(false);
    expect(unitsConflict('Apt 4', '')).toBe(false);
    expect(unitsConflict(null, null)).toBe(false);
  });

  test('normalized forms of the same unit do not conflict', () => {
    expect(unitsConflict('Apt 4B', 'apt 4b')).toBe(false);
    expect(unitsConflict('Unit 4B', '#4B')).toBe(false);
    expect(unitsConflict('4b', 'Unit 4B')).toBe(false);
  });

  test('different units conflict', () => {
    expect(unitsConflict('Apt A', 'Apt B')).toBe(true);
    expect(unitsConflict('Unit 101', '#102')).toBe(true);
  });
});

describe('addressMatchesCustomer with units', () => {
  const customer = {
    address_line1: '123 Main St',
    address_line2: 'Apt A',
    zip: '34231',
  };

  test('same street, disagreeing unit → no match (Apt B is not Apt A)', () => {
    expect(addressMatchesCustomer(customer, '123 Main St', '34231', 'Apt B')).toBe(false);
  });

  test('same street, same unit (any normalized spelling) → match', () => {
    expect(addressMatchesCustomer(customer, '123 Main St', '34231', 'apt a')).toBe(true);
    expect(addressMatchesCustomer(customer, '123 Main St', '34231', '#A')).toBe(true);
  });

  test('blank submitted unit keeps the pre-unit-capture behavior', () => {
    expect(addressMatchesCustomer(customer, '123 Main St', '34231', '')).toBe(true);
    expect(addressMatchesCustomer(customer, '123 Main St', '34231', undefined)).toBe(true);
  });

  test('customer without a unit on file accepts a submitted unit', () => {
    const noUnit = { ...customer, address_line2: null };
    expect(addressMatchesCustomer(noUnit, '123 Main St', '34231', 'Apt B')).toBe(true);
  });

  test('street mismatch still fails regardless of units', () => {
    expect(addressMatchesCustomer(customer, '999 Oak Ave', '34231', 'Apt A')).toBe(false);
  });
});
