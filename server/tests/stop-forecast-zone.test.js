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
    expect(stopForecastZone(row('bradenton', 'Bradenton', '34205'))).toBe('bradenton_north');
    expect(stopForecastZone(row('venice', 'North Port', '34287'))).toBe('venice_north_port');
  });

  it('falls back to the zone the location id names, never the Lakewood Ranch default', () => {
    expect(stopForecastZone(row('venice', null, '34285'))).toBe('venice_north_port');
    expect(stopForecastZone(row('bradenton', null, null))).toBe('bradenton_north');
  });

  it('places a row with no stored zone by its city and ZIP only, not the display default', () => {
    expect(stopForecastZone(row(null, 'Sarasota', '34236'))).toBe('sarasota');
    // The card's display zone reads Lakewood Ranch for these rows; their forecast zone is none.
    expect(stopForecastZone(row(null, 'Tampa', '33601'))).toBeNull();
    expect(stopForecastZone(row('', null, null))).toBeNull();
  });

  it('gives no forecast zone to an unknown stored zone the row cannot place', () => {
    expect(stopForecastZone(row('somewhere', 'Tampa', '33601'))).toBeNull();
  });
});
