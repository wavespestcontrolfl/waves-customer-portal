'use strict';

// GATE_REPORT_WEB_LIVE_CHIP + GATE_LAWN_WATER_IN_RAIN: one /data view makes ONE weather read. The banner's water-in
// coverage (built with the report) and the chip (attached after) share one completion-to-now series. Synthetic data.

const { waterInRainInstruction } = require('../services/service-report/report-data');
const { resolveLiveChip, createSharedSeries } = require('../services/service-report/lawn-live-chip');

const HOUR = 3600000;
const NOW = new Date('2026-10-21T18:30:00Z');
const COMPLETED = '2026-10-21T10:15:00Z';
const instruction = () => ({
  state: 'water_in',
  lines: ['Water in with about 1/2 inch within 24 hours.'],
  completedAt: COMPLETED,
  // the deadline is BEFORE now: the banner's own window would stop at 14:15, not at now
  waterInBy: '2026-10-21T14:15:00Z',
});

function series(rain = {}) {
  const hourly = [];
  for (let s = Date.parse('2026-10-21T11:00:00Z'); s <= NOW.getTime(); s += HOUR) {
    const at = new Date(s).toISOString();
    hourly.push({ at, precipitation_in: rain[at] || 0 });
  }
  return { status: 'ok', hourly, precipitationInTotalExact: hourly.reduce((a, r) => a + r.precipitation_in, 0) };
}
// the water-in reader remembers closed windows per place, so each test uses its own synthetic point
const point = (lat) => ({ service: { customer_latitude: lat, customer_longitude: -82.4 }, latitude: lat, longitude: -82.4 });

describe('one weather read per view', () => {
  test('banner coverage then chip: a single fetchPropertyForecast call, window completion-to-now', async () => {
    const fetchForecast = jest.fn(async () => series({ '2026-10-21T12:00:00.000Z': 0.6 }));
    const shared = createSharedSeries(fetchForecast, NOW);

    const banner = await waterInRainInstruction(instruction(), { products: [], service: point(27.1).service, sharedSeries: shared, completionTime: COMPLETED });
    expect(banner.state).toBe('water_in_by_rain');

    const chip = await resolveLiveChip({
      completedAt: COMPLETED, instruction: instruction(), products: [], latitude: 27.1, longitude: -82.4, series: shared,
    });
    expect(chip).toEqual({ state: 'watered_in', text: 'Rain since your visit has watered the treatment in.' });

    expect(fetchForecast).toHaveBeenCalledTimes(1);
    expect(fetchForecast.mock.calls[0][0].to).toEqual(NOW);
  });

  test('a banner that rain has not covered and a dry chip still share the one read', async () => {
    const fetchForecast = jest.fn(async () => series());
    const shared = createSharedSeries(fetchForecast, NOW);
    const banner = await waterInRainInstruction(instruction(), { products: [], service: point(27.2).service, sharedSeries: shared, completionTime: COMPLETED });
    expect(banner.state).toBe('water_in');
    const chip = await resolveLiveChip({
      completedAt: COMPLETED, instruction: instruction(), products: [], latitude: 27.2, longitude: -82.4, series: shared,
    });
    expect(chip.state).toBe('no_rain');
    expect(fetchForecast).toHaveBeenCalledTimes(1);
  });

  test('chip first (no banner read yet): the shared series gets a valid Date window', async () => {
    const fetchForecast = jest.fn(async () => series());
    const shared = createSharedSeries(fetchForecast, NOW);
    const chip = await resolveLiveChip({
      completedAt: COMPLETED, instruction: instruction(), products: [], latitude: 27.4, longitude: -82.4, series: shared,
    });
    expect(chip.state).toBe('no_rain');
    expect(fetchForecast).toHaveBeenCalledTimes(1);
    const { from } = fetchForecast.mock.calls[0][0];
    expect(from).toBeInstanceOf(Date);
    expect(from.getTime()).toBe(Date.parse(COMPLETED));
  });

  test('a failed read is a miss for both and is not retried within the view', async () => {
    const fetchForecast = jest.fn(async () => { throw new Error('down'); });
    const shared = createSharedSeries(fetchForecast, NOW);
    const frozen = instruction();
    expect(await waterInRainInstruction(frozen, { products: [], service: point(27.3).service, sharedSeries: shared, completionTime: COMPLETED })).toBe(frozen);
    expect(await resolveLiveChip({
      completedAt: COMPLETED, instruction: frozen, products: [], latitude: 27.3, longitude: -82.4, series: shared,
    })).toBeNull();
    expect(fetchForecast).toHaveBeenCalledTimes(1);
  });

  test('a report older than the chip window keeps the banner\'s own deadline-bounded read (empty cache, no long window)', async () => {
    // 30 days old: a completion-to-now window would be refused (bad_window past 16 days) and the banner would lose its state
    const old = new Date('2026-09-21T10:15:00Z');
    const oldInstruction = {
      state: 'water_in', lines: ['Water in with about 1/2 inch within 24 hours.'], completedAt: old.toISOString(), waterInBy: '2026-09-22T10:15:00Z',
    };
    const shared = createSharedSeries(jest.fn(async () => ({ status: 'unavailable', reason: 'bad_window' })), NOW);
    const bannerFetch = jest.fn(async ({ from, to }) => {
      // the banner's own window: completion to its deadline, one day, well inside the reader's horizon
      expect(Date.parse(to) - Date.parse(from)).toBeLessThanOrEqual(24 * HOUR);
      return { status: 'ok', precipitationInTotalExact: 0.8 };
    });
    jest.resetModules();
    jest.doMock('../services/service-report/application-conditions', () => ({
      ...jest.requireActual('../services/service-report/application-conditions'), fetchPropertyForecast: bannerFetch,
    }));
    const { waterInRainInstruction: fresh } = require('../services/service-report/report-data');
    const out = await fresh(oldInstruction, {
      products: [], service: point(27.9).service, now: NOW, sharedSeries: shared, completionTime: old.toISOString(),
    });
    expect(out.state).toBe('water_in_by_rain');
    expect(bannerFetch).toHaveBeenCalledTimes(1);
    jest.dontMock('../services/service-report/application-conditions');
  });
});
