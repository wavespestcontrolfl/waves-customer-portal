// The day board's forecast zone per stop (admin-schedule stopForecastZone), with the
// route's own getZone: 11-19, stops stored with a location id as their zone showed no rain.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { stopForecastZone } = require('../routes/admin-schedule');

const stop = (zone, city, zip) => ({ zone, premise: { city, zip } });

describe('stopForecastZone', () => {
  it('keeps a stored zone that has a forecast point', () => {
    expect(stopForecastZone(stop('sarasota', 'Bradenton', '34211'))).toBe('sarasota');
  });

  it('reads a stored location id from the stop city and ZIP', () => {
    expect(stopForecastZone(stop('bradenton', 'Bradenton', '34211'))).toBe('lakewood_ranch');
    expect(stopForecastZone(stop('bradenton', 'Bradenton', '34205'))).toBe('bradenton_north');
    expect(stopForecastZone(stop('venice', 'North Port', '34287'))).toBe('venice_north_port');
  });

  it('falls back to the zone the location id names, never the Lakewood Ranch default', () => {
    expect(stopForecastZone(stop('venice', null, '34285'))).toBe('venice_north_port');
    expect(stopForecastZone(stop('bradenton', null, null))).toBe('bradenton_north');
  });

  it('gives no forecast zone to an unknown stored zone the premise cannot place', () => {
    expect(stopForecastZone(stop('somewhere', 'Tampa', '33601'))).toBeNull();
  });
});
