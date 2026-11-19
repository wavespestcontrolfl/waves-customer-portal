// The day board's forecast zone per stop (admin-schedule stopForecastZone), read from the
// stop's scheduled_services row with the route's own getZone: 11-19, stops stored with a
// location id as their zone showed no rain.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { stopForecastZone } = require('../routes/admin-schedule');

const row = (zone, city, zip) => ({ zone, city, zip });

describe('stopForecastZone', () => {
  it('keeps a stored zone that has a forecast point', () => {
    expect(stopForecastZone(row('sarasota', 'Bradenton', '34211'))).toBe('sarasota');
  });

  it('reads a stored location id from the row city and ZIP', () => {
    expect(stopForecastZone(row('bradenton', 'Bradenton', '34211'))).toBe('lakewood_ranch');
    expect(stopForecastZone(row('bradenton', 'Bradenton', '34211-1234'))).toBe('lakewood_ranch');
    expect(stopForecastZone(row('bradenton', 'Bradenton', '34205'))).toBe('bradenton_north');
    expect(stopForecastZone(row('venice', 'North Port', '34287'))).toBe('venice_north_port');
  });

  it('falls back to the stored zone read as a place name, never the Lakewood Ranch default', () => {
    expect(stopForecastZone(row('venice', null, '34285'))).toBe('venice_north_port');
    expect(stopForecastZone(row('bradenton', null, null))).toBe('bradenton_north');
    // Self-booking stores the "Port Charlotte" service zone as 'port charlotte'.
    expect(stopForecastZone(row('port charlotte', null, '33980'))).toBe('venice_north_port');
  });

  it('places a row with no stored zone by its city and ZIP only, not the display default', () => {
    expect(stopForecastZone(row(null, 'Sarasota', '34236'))).toBe('sarasota');
    // The card's display zone reads Lakewood Ranch for these rows; their forecast zone is none.
    expect(stopForecastZone(row(null, 'Tampa', '33601'))).toBeNull();
    expect(stopForecastZone(row('', null, null))).toBeNull();
  });

  it('gives no forecast zone to an unknown stored zone the row cannot place', () => {
    expect(stopForecastZone(row('somewhere', 'Tampa', '33601'))).toBeNull();
    // A board zone key with no forecast point is not read as a place name ('bradenton' is in it).
    expect(stopForecastZone(row('bradenton_south', null, null))).toBeNull();
    expect(stopForecastZone(row('bradenton_south', 'Bradenton', '34207'))).toBe('bradenton_north');
  });

  // The day query fills each missing stamp field from the primary address (COALESCE per field).
  const lakewoodPrimary = { customer_address_line1: '500 Main St', customer_city: 'Lakewood Ranch', customer_zip: '34211' };
  const stamped = (zone, line1, city, zip, primary = lakewoodPrimary) => ({
    zone, ...primary,
    service_address_line1: line1, service_address_city: city, service_address_zip: zip,
    city: city || primary.customer_city, zip: zip || primary.customer_zip,
  });

  it('reads a stamp for another property by its own city and ZIP, never the primary ZIP', () => {
    // Coalesced, this row reads Venice + 34211, and getZone checks the ZIP first: Lakewood Ranch.
    expect(stopForecastZone(stamped('venice', '100 Gulf Dr', 'Venice', null))).toBe('venice_north_port');
    // Neither city nor ZIP on the stamp: the location id's own zone, not the primary's area.
    expect(stopForecastZone(stamped('bradenton', '100 Gulf Dr', null, null))).toBe('bradenton_north');
    expect(stopForecastZone(stamped(null, '100 Gulf Dr', null, null))).toBeNull();
  });

  it('lets a stamp of the primary address borrow the primary ZIP', () => {
    // Same street and city as the primary: its ZIP 34202 places the stop (the city alone reads Bradenton N).
    const bradentonPrimary = { customer_address_line1: '500 Main St', customer_city: 'Bradenton', customer_zip: '34202' };
    expect(stopForecastZone(stamped('bradenton', '500 Main Street', 'Bradenton', null, bradentonPrimary))).toBe('lakewood_ranch');
  });
});
