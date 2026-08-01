// get_weather_conditions must DEGRADE, never dangle. The tool calls an
// external API (open-meteo) from both the tech portal and the CI contract
// smoke; without a fetch timeout, a hanging upstream left a field tech on a
// spinner and blew the contract harness's 10s budget, redding the whole
// server check (2026-08-01). The 6s AbortSignal budget is the contract.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { executeTechTool } = require('../services/intelligence-bar/tech-tools');

describe('get_weather_conditions timeout budget', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('passes an abort signal so a hanging API cannot dangle the tool', async () => {
    let seenSignal = null;
    global.fetch = jest.fn((url, opts) => {
      seenSignal = opts && opts.signal;
      // Simulate the upstream hanging: resolve only when the signal aborts.
      return new Promise((resolve, reject) => {
        if (!seenSignal) return; // no signal → this promise never settles
        seenSignal.addEventListener('abort', () => reject(seenSignal.reason));
      });
    });
    const started = Date.now();
    const out = await executeTechTool('get_weather_conditions', {}, {});
    const elapsed = Date.now() - started;
    expect(seenSignal).toBeTruthy();
    expect(out).toEqual({ error: 'Could not fetch weather' });
    // Must resolve on the tool's own ~6s budget, well inside the contract
    // smoke's 10s ceiling (real timers; the signal fires at 6000ms).
    expect(elapsed).toBeLessThan(9000);
  }, 15000);

  test('normal responses are unaffected', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ current: { temperature_2m: 88.2, wind_speed_10m: 6, wind_gusts_10m: 9, precipitation_probability: 10 } }),
    }));
    const out = await executeTechTool('get_weather_conditions', {}, {});
    expect(out.spray_conditions).toBe('good');
    expect(out.temperature).toBe(88);
  });
});
