// GATE_PEST_RAIN_OUTLOOK with the real forecast slicer (application-conditions.js
// sliceForecast): rain in the partial hour at either end of the 48 hours after a
// 14:30 completion reaches the frozen total, so the card never reads it as dry.
// Synthetic coordinates only; fetch is mocked (no network).

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { unix } = require('./helpers/open-meteo-unixtime');

// Hourly rows 2026-10-02 00:00 .. 2026-10-09 23:00 ET (past_days=1 + forecast_days=7).
// A stamp's rain fell in the hour before it.
function payload(rainAt = {}) {
  const hourly = { time: [], precipitation: [], temperature_2m: [], relative_humidity_2m: [], precipitation_probability: [] };
  for (let d = 2; d <= 9; d += 1) {
    for (let h = 0; h < 24; h += 1) {
      const t = `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00`;
      hourly.time.push(unix(t));
      hourly.precipitation.push(rainAt[t] ?? 0);
      hourly.temperature_2m.push(78);
      hourly.relative_humidity_2m.push(70);
      hourly.precipitation_probability.push(rainAt[t] ? 80 : 5);
    }
  }
  return {
    current: {
      time: unix('2026-10-03T14:15'), temperature_2m: 82, relative_humidity_2m: 66, wind_speed_10m: 6, wind_gusts_10m: 10,
      precipitation_probability: 10, weather_code: 1,
    },
    hourly,
  };
}

// Saturday 2026-10-03, 14:30 EDT.
const DONE = new Date('2026-10-03T18:30:00Z');
const svc = { service_type: 'Quarterly Pest Control', customer_latitude: 27.1234, customer_longitude: -82.5678 };
const FIPRONIL = { method: 'perimeter_spray', activeIngredient: 'Fipronil', productName: 'Test fipronil' };

const realFetch = global.fetch;
let savedGate;
beforeEach(() => {
  savedGate = process.env.GATE_PEST_RAIN_OUTLOOK;
  process.env.GATE_PEST_RAIN_OUTLOOK = 'true';
  jest.resetModules();
});
afterEach(() => {
  global.fetch = realFetch;
  if (savedGate === undefined) delete process.env.GATE_PEST_RAIN_OUTLOOK;
  else process.env.GATE_PEST_RAIN_OUTLOOK = savedGate;
});

async function outlookFor(rainAt) {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => payload(rainAt) }));
  const { capturePestRainOutlook, buildRainOutlookLine, DRY_LINE } = require('../services/service-report/pest-rain-outlook');
  const outlook = await capturePestRainOutlook({ svc, now: DONE });
  return { outlook, line: buildRainOutlookLine({ outlook, serviceLine: 'pest', applications: [FIPRONIL] }), DRY_LINE };
}

test('a dry 48 hours reads dry', async () => {
  const { outlook, line, DRY_LINE } = await outlookFor({});
  expect(outlook).toMatchObject({ complete: true, totalIn: 0, firstRainAt: null });
  expect(line).toBe(DRY_LINE);
});

test('a storm in the last partial hour (14:00-15:00 two days on) is in the total: never "dry"', async () => {
  const { outlook, line } = await outlookFor({ '2026-10-05T15:00': 0.3 });
  expect(outlook).toMatchObject({ complete: true, totalIn: 0.3 });
  expect(line).toBeNull();
});

test('a shower in the hour that holds the completion is in the total and starts at the completion: no line', async () => {
  const { outlook, line } = await outlookFor({ '2026-10-03T15:00': 0.3 });
  expect(outlook).toMatchObject({ complete: true, totalIn: 0.3, firstRainAt: DONE.toISOString() });
  expect(line).toBeNull();
});

test('rain the next evening: the rain line', async () => {
  const { outlook, line } = await outlookFor({ '2026-10-04T19:00': 0.4 });
  expect(outlook.firstRainAt).toBe(new Date(unix('2026-10-04T18:00') * 1000).toISOString());
  expect(line).toMatch(/^When we finished, the forecast showed rain on Sunday evening\. Once dry, /);
});
