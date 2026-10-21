'use strict';

const { resolveLiveChip } = require('../services/service-report/lawn-live-chip');
const COPY = require('../../shared/report-live-chip-copy.json');

// GATE_REPORT_WEB_LIVE_CHIP: one fixed sentence from measured past-hour rain since the visit, or nothing.
const HOUR = 3600000;
const NOW = new Date('2026-10-21T18:30:00Z');
const COMPLETED = '2026-10-21T10:15:00Z';

// Hour rows stamped at the END of their hour, as fetchPropertyForecast returns them.
function forecastWith(rainStamps = {}, { from = COMPLETED, now = NOW, missing = null } = {}) {
  const hourly = [];
  const fromMs = Date.parse(from);
  // the first row is the hour that CONTAINS the completion (10:15 -> the 11:00 row)
  for (let s = Math.floor(fromMs / HOUR) * HOUR + HOUR; s <= now.getTime(); s += HOUR) {
    if (missing === s) continue;
    hourly.push({ at: new Date(s).toISOString(), precipitation_in: rainStamps[new Date(s).toISOString()] || 0 });
  }
  // the water-in coverage reader asks for the unrounded total of the same rows
  return { status: 'ok', hourly, precipitationInTotalExact: missing === null ? hourly.reduce((a, r) => a + r.precipitation_in, 0) : null };
}
const run = (forecast, extra = {}) => resolveLiveChip({
  completedAt: COMPLETED, instruction: null, products: [], latitude: 27.1, longitude: -82.4, now: NOW, fetchForecast: async () => forecast, ...extra,
});

describe('live lawn status chip', () => {
  test('rain in the last hours: "Rain fell about N hours ago. Wait until the lawn is dry." (told from the hour\'s start)', async () => {
    // the 17:00Z stamp = rain 16:00-17:00Z; now 18:30Z -> that hour started 2.5 hours ago
    expect(await run(forecastWith({ '2026-10-21T17:00:00.000Z': 0.2 }))).toEqual({ state: 'recent_rain', text: 'Rain fell about 2 hours ago. Wait until the lawn is dry.' });
    expect((await run(forecastWith({ '2026-10-21T16:00:00.000Z': 0.2 }))).text).toBe('Rain fell about 3 hours ago. Wait until the lawn is dry.');
    expect((await run(forecastWith({ '2026-10-21T18:00:00.000Z': 0.05 }))).text).toBe('Rain fell about 1 hour ago. Wait until the lawn is dry.');
  });

  test('rain older than the recent window and no water-in coverage: hidden', async () => {
    expect(await run(forecastWith({ '2026-10-21T12:00:00.000Z': 0.3 }))).toBeNull();
  });

  test('a full dry read since the visit: "No rain since your treatment."', async () => {
    expect(await run(forecastWith())).toEqual({ state: 'no_rain', text: COPY.noRain });
  });

  test('boundary hours: the completion hour counts, the hour in progress is not read', async () => {
    // completed 10:15: the 11:00 row (10:00-11:00) is the completion hour. Rain in it is not "no rain".
    expect(await run(forecastWith({ '2026-10-21T11:00:00.000Z': 0.1 }))).toBeNull();
    // that row missing: unknown, never dry
    expect(await run(forecastWith({}, { missing: Date.parse('2026-10-21T11:00:00Z') }))).toBeNull();
    // now 11:20: the completion hour is the only closed hour; dry = no rain, rainy = hidden
    const early = new Date('2026-10-21T11:20:00Z');
    expect(await run(forecastWith({}, { now: early }), { now: early })).toEqual({ state: 'no_rain', text: COPY.noRain });
    expect(await run(forecastWith({ '2026-10-21T11:00:00.000Z': 0.1 }, { now: early }), { now: early })).toBeNull();
    // a completion exactly on the hour does not need the row before it (10:00 stamp = 09:00-10:00, before the visit)
    const onHour = { completedAt: '2026-10-21T10:00:00Z' };
    const rows = forecastWith({}, { from: '2026-10-21T10:00:00Z' });
    expect(rows.hourly[0].at).toBe('2026-10-21T11:00:00.000Z');
    expect(await run(rows, onHour)).toEqual({ state: 'no_rain', text: COPY.noRain });
  });

  test('rain in the partial completion hour is never a positive claim; an hour that starts at the completion is', async () => {
    // completed 10:55, rain at 10:05 sits in the 11:00 row (10:00-11:00): it may be before the visit
    const late = { completedAt: '2026-10-21T10:55:00Z', now: new Date('2026-10-21T11:10:00Z') };
    expect(await run(forecastWith({ '2026-10-21T11:00:00.000Z': 0.3 }, { from: late.completedAt, now: late.now }), late)).toBeNull();
    // later hours still speak: rain in the 12:00 row (11:00-12:00) starts after the completion
    const next = { completedAt: '2026-10-21T10:55:00Z', now: new Date('2026-10-21T12:10:00Z') };
    const rows = forecastWith({ '2026-10-21T11:00:00.000Z': 0.3, '2026-10-21T12:00:00.000Z': 0.2 }, { from: next.completedAt, now: next.now });
    expect((await run(rows, next)).text).toBe('Rain fell about 1 hour ago. Wait until the lawn is dry.');
    // completed exactly on the hour: the 11:00 row (10:00-11:00) starts AT the completion, so it counts
    const exact = { completedAt: '2026-10-21T10:00:00Z', now: new Date('2026-10-21T11:10:00Z') };
    expect((await run(forecastWith({ '2026-10-21T11:00:00.000Z': 0.3 }, { from: exact.completedAt, now: exact.now }), exact)).text).toBe('Rain fell about 1 hour ago. Wait until the lawn is dry.');
  });

  test('a missing hour is unknown, never dry', async () => {
    expect(await run(forecastWith({}, { missing: Date.parse('2026-10-21T15:00:00Z') }))).toBeNull();
  });

  test('no whole hour yet since the visit: hidden', async () => {
    const soon = new Date('2026-10-21T10:40:00Z');
    expect(await run(forecastWith({}, { now: soon }), { now: soon })).toBeNull();
  });

  test('the banner already says rain watered it in: the chip says so too', async () => {
    const out = await run(forecastWith({ '2026-10-21T12:00:00.000Z': 0.6 }), { instruction: { state: 'water_in_by_rain' } });
    expect(out).toEqual({ state: 'watered_in', text: COPY.wateredIn });
  });

  test('measured rain reaching the water-in amount: "Rain since your visit has watered the treatment in."', async () => {
    const instruction = {
      state: 'water_in', lines: ['Water in with about 1/2 inch within 24 hours.'], completedAt: COMPLETED, waterInBy: '2026-10-22T10:15:00Z',
    };
    const out = await run(forecastWith({ '2026-10-21T12:00:00.000Z': 0.6 }), { instruction });
    expect(out.text).toBe('Rain since your visit has watered the treatment in.');
  });

  test('trace rain: 56 hours of 0.009 in is never "No rain since your treatment."; many trace hours still water a treatment in', async () => {
    const now = new Date('2026-10-21T18:30:00Z');
    const completedAt = '2026-10-19T09:00:00Z'; // 57 hours earlier
    const hourly = [];
    for (let stamp = Date.parse('2026-10-19T10:00:00Z'); stamp <= now.getTime(); stamp += HOUR) {
      // the forecast rounds the hour to 0.01; the unrounded reading is 0.009
      hourly.push({ at: new Date(stamp).toISOString(), precipitation_in: 0.01, precipitation_exact_in: 0.009 });
    }
    const total = hourly.length * 0.009;
    expect(total).toBeGreaterThan(0.5);
    const forecast = { status: 'ok', hourly, precipitationInTotalExact: total };
    expect(await run(forecast, { completedAt, now })).toBeNull();
    // the same trace total reaches a half-inch water-in: covered through resolveRainCoverage on the total
    const instruction = {
      state: 'water_in', lines: ['Water in with about 1/2 inch within 24 hours.'], completedAt, waterInBy: '2026-10-30T10:00:00Z',
    };
    expect(await run(forecast, { completedAt, now, instruction })).toEqual({ state: 'watered_in', text: COPY.wateredIn });
    // a short dry spell of true zeros is still dry
    expect(await run(forecastWith())).toEqual({ state: 'no_rain', text: COPY.noRain });
  });

  test('one weather read per view, water-in coverage included', async () => {
    const instruction = {
      state: 'water_in', lines: ['Water in with about 1/2 inch within 24 hours.'], completedAt: COMPLETED, waterInBy: '2026-10-22T10:15:00Z',
    };
    const fetchForecast = jest.fn(async () => forecastWith({ '2026-10-21T12:00:00.000Z': 0.6 }));
    const out = await resolveLiveChip({
      completedAt: COMPLETED, instruction, products: [], latitude: 27.1, longitude: -82.4, now: NOW, fetchForecast,
    });
    expect(out.state).toBe('watered_in');
    expect(fetchForecast).toHaveBeenCalledTimes(1);
  });

  test('a visit older than 7 days, an unusable forecast and a throwing fetch all hide the chip', async () => {
    const old = new Date('2026-10-29T10:00:00Z');
    expect(await run(forecastWith({}, { now: old }), { now: old })).toBeNull();
    expect(await run({ status: 'unavailable' })).toBeNull();
    expect(await run(null)).toBeNull();
    expect(await resolveLiveChip({ completedAt: COMPLETED, now: NOW, fetchForecast: async () => { throw new Error('x'); } })).toBeNull();
    expect(await resolveLiveChip({ completedAt: null, now: NOW, fetchForecast: async () => forecastWith() })).toBeNull();
  });

  test('the result is a state word and one sentence; no coordinates leave the module', async () => {
    const out = await run(forecastWith());
    expect(Object.keys(out).sort()).toEqual(['state', 'text']);
    expect(JSON.stringify(out)).not.toMatch(/27\.1|82\.4/);
  });

  test('copy: no chemical name, price or promise word', () => {
    for (const v of Object.values(COPY).filter((x) => typeof x === 'string')) expect(v).not.toMatch(/\$|guarantee|roundup|bifenthrin/i);
  });
});
