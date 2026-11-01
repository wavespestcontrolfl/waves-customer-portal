/**
 * visitAtCustomerHome (server/services/stamped-address.js): the unit-aware "is this visit at the customer's home?"
 * the member perks use (pet-named text, Away Watch). Stricter than stampedDivergesSql: a stamp for another unit at
 * the same street is elsewhere.
 */
const { visitAtCustomerHome, VISIT_HOME_COLUMNS } = require('../services/stamped-address');

const HOME = { address_line1: '100 Fixture Street', address_line2: 'Apt 3', city: 'Fixture City', zip: '34201' };
const at = (stamp, home = HOME) => visitAtCustomerHome({ ...home, ...stamp });

describe('visitAtCustomerHome', () => {
  test('no stamp, or a stamp naming the home (an omitted unit borrows the home\'s): home', () => {
    expect(at({})).toBe(true);
    expect(at({ service_address_line1: '100 Fixture Street' })).toBe(true);
    expect(at({ service_address_line1: '100 Fixture St', service_address_line2: 'Apt 3', service_address_zip: '34201' })).toBe(true);
  });

  test('another unit at the same street, on line 2 or inline on line 1: elsewhere', () => {
    expect(at({ service_address_line1: '100 Fixture Street', service_address_line2: 'Apt 4' })).toBe(false);
    expect(at({ service_address_line1: '100 Fixture Street Apt 4' })).toBe(false);
  });

  test('another street, or the same street in another zip or city: elsewhere', () => {
    expect(at({ service_address_line1: '200 Other Road' })).toBe(false);
    expect(at({ service_address_line1: '100 Fixture Street', service_address_line2: 'Apt 3', service_address_zip: '34202' })).toBe(false);
    expect(at({ service_address_line1: '100 Fixture Street', service_address_line2: 'Apt 3', service_address_city: 'Other City' })).toBe(false);
  });

  test('a unit stamped on a home with no unit on file is elsewhere; a home with no street on file cannot conflict', () => {
    expect(at({ service_address_line1: '100 Fixture Street', service_address_line2: 'Apt 4' }, { ...HOME, address_line2: null })).toBe(false);
    expect(at({ service_address_line1: '200 Other Road' }, { address_line1: null })).toBe(true);
  });

  test('the readers select both sides from scheduled_services as ss and customers as c', () => {
    expect(VISIT_HOME_COLUMNS).toEqual(expect.arrayContaining(['ss.service_address_line1', 'ss.service_address_line2', 'c.address_line1', 'c.address_line2']));
  });
});
