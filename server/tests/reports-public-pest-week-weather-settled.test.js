jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  mock.transaction = jest.fn(async (cb) => cb(mock));
  return mock;
});
// Default OFF so the existing limiter test still sees the dark-gate 400;
// the cross-sell click tests turn it on for themselves.
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/service-report/cross-sell', () => ({ buildReportCrossSell: jest.fn() }));
jest.mock('../services/service-report/click-estimate-mint', () => ({ mintReportClickEstimate: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn().mockResolvedValue(null) }));
jest.mock('../config', () => ({
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  GetObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));
jest.mock('../services/pest-pressure/orchestrate', () => ({
  runAndSwallowErrors: jest.fn().mockResolvedValue(null),
  calculateAndPersistForServiceRecord: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/pest-pressure/store', () => ({
  loadActiveConfig: jest.fn(),
  loadScoreForServiceRecord: jest.fn(),
  loadHistoryForCustomer: jest.fn().mockResolvedValue([]),
}));


// Pest report expectations (GATE_PEST_REPORT_EXPECTATIONS): a PDF/static
// render must never bake a still-accumulating trailing 7-day rain window
// into a permanently cached document. application-conditions.js stamps
// every week-weather result with `windowClosed` (true once the window ends
// before today, ET). The live page may show an unsettled reading; every
// other render gets NO weekWeather while the window is open, so the rain
// block is absent rather than frozen on a number that later changes.
const fs = require('fs');
const path = require('path');
const { settledWeekWeatherForRender } = require('../routes/reports-public');

const SETTLED = { rainInches: 0.6, rainConfidence: 'high', et0Inches: null, dailyRain: null, rainSource: 'open-meteo', windowClosed: true };
const UNSETTLED = { ...SETTLED, rainInches: 0.2, windowClosed: false };

describe('settledWeekWeatherForRender', () => {
  test('live view keeps the week weather whether or not the window has closed', () => {
    expect(settledWeekWeatherForRender(SETTLED, 'live')).toBe(SETTLED);
    expect(settledWeekWeatherForRender(UNSETTLED, 'live')).toBe(UNSETTLED);
  });

  test('a PDF/static render keeps a settled week', () => {
    expect(settledWeekWeatherForRender(SETTLED, 'pdf')).toBe(SETTLED);
    expect(settledWeekWeatherForRender(SETTLED, 'static')).toBe(SETTLED);
  });

  test('a PDF/static render drops an unsettled week entirely (no rain-derived bytes cached)', () => {
    expect(settledWeekWeatherForRender(UNSETTLED, 'pdf')).toBeNull();
    expect(settledWeekWeatherForRender(UNSETTLED, 'static')).toBeNull();
  });

  test('a result without the windowClosed stamp is treated as unsettled off the live page (fail closed)', () => {
    const { windowClosed, ...unstamped } = SETTLED;
    expect(settledWeekWeatherForRender(unstamped, 'pdf')).toBeNull();
    expect(settledWeekWeatherForRender(null, 'pdf')).toBeNull();
    expect(settledWeekWeatherForRender(undefined, 'live')).toBeUndefined();
  });

  test('the v1 response builder routes the fetched week through the settle check before buildPestReportV2', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports-public.js'), 'utf8');
    expect(source).toMatch(/const \[fetchedWeekWeather, forecastHeavyRain\] = expectationsGateOn/);
    expect(source).toMatch(/const weekWeather = settledWeekWeatherForRender\(fetchedWeekWeather, mode\);[\s\S]{0,2500}buildPestReportV2\(\{/);
  });
});

// Codex P0 2026-09-28: a PDF/static render whose week never SETTLED (still
// an open window) dropped its rain fact via settledWeekWeatherForRender
// above, but nothing marked the document uncacheable — so it was stored
// under the stable pest-line PDF key with no rain block, and later
// downloads kept serving that "no rain block" copy forever even once the
// window closed. Mirrors the lawn week-weather freeze's own
// weekWeatherUncacheable contract (lawn-week-weather-freeze.test.js).
describe('pestWeekWeatherUncacheable — PDF/static renders never bake an unsettled window into the cache', () => {
  test('reports-public.js computes it from the SAME fetched week/mode the rain block used, and sets it on `data` regardless of pestReportV2 composing', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports-public.js'), 'utf8');
    // codex P1 2026-09-29: `windowClosed` alone is not enough — a provider
    // failure can return `{ rainInches: null, windowClosed: true }` for a
    // geocoded property, which reads exactly like a settled reading unless
    // rainInches is also checked. Pin BOTH conditions and the "had
    // coordinates at all" gate (`!== null`, not `!!`, so a fetch that ran
    // and failed is never conflated with "no coordinates").
    expect(source).toMatch(
      /const pestWeekWeatherUncacheable = expectationsGateOn[\s\S]{0,200}fetchedWeekWeather !== null[\s\S]{0,200}fetchedWeekWeather\.rainInches != null && fetchedWeekWeather\.windowClosed === true/,
    );
    expect(source).toMatch(/data\.pestWeekWeatherUncacheable = pestWeekWeatherUncacheable;/);
  });

  // codex P1 2026-09-29: fetchPestWeekWeatherSafe's return contract is what
  // makes the check above sound — a bare `null` must mean ONLY "no
  // coordinates", never "a fetch ran and failed", or the two collapse into
  // the same (wrongly cacheable) outcome.
  test('fetchPestWeekWeatherSafe never folds a provider failure into the same `null` "no coordinates" uses', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports-public.js'), 'utf8');
    const fn = source.slice(
      source.indexOf('async function fetchPestWeekWeatherSafe'),
      source.indexOf('async function fetchPestRainForecastHeavySafe'),
    );
    // No-coordinates early return is the ONLY bare `return null;`.
    expect(fn).toMatch(/if \(lat == null \|\| lng == null\) return null;/);
    // Every other outcome (a fetch exception OR a fetch that outran the
    // deadline) resolves to the SAME distinguishable UNAVAILABLE sentinel,
    // never a bare `null`.
    expect(fn).toMatch(/const UNAVAILABLE = \{ rainInches: null, windowClosed: false, unavailable: true \};/);
    expect(fn).toMatch(/return \(result === DEADLINE \|\| result == null\) \? UNAVAILABLE : result;/);
  });

  // codex P2 2026-09-29 (round 2): a direct, unbounded await on
  // fetchServiceWeekWeather could hold every live pest report render up to
  // ~7s on a cold cache or provider outage. Bounded the same way the
  // forecast helper already bounds its own NWS call.
  describe('fetchPestWeekWeatherSafe is bounded by a short deadline', () => {
    const GEOCODED = { customer_latitude: 27.4, customer_longitude: -82.5, service_date: '2026-07-16' };

    function toCoordinateStub(value) {
      if (value == null || value === '') return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }

    beforeEach(() => { jest.resetModules(); });
    afterEach(() => { jest.dontMock('../services/service-report/application-conditions'); });

    test('a slow fetch (never settling within the deadline) resolves to the UNAVAILABLE sentinel, bounded to ~1200ms', async () => {
      jest.useFakeTimers();
      jest.doMock('../services/service-report/application-conditions', () => ({
        toCoordinate: toCoordinateStub,
        fetchServiceWeekWeather: () => new Promise(() => {}), // never settles
      }));
      const { fetchPestWeekWeatherSafe } = require('../routes/reports-public');
      const promise = fetchPestWeekWeatherSafe(GEOCODED);
      jest.advanceTimersByTime(1200);
      await expect(promise).resolves.toEqual({ rainInches: null, windowClosed: false, unavailable: true });
      jest.useRealTimers();
    });

    test('a fast fetch resolves with the normal result, not the sentinel', async () => {
      const SETTLED = { rainInches: 0.6, windowClosed: true, rainConfidence: null };
      jest.doMock('../services/service-report/application-conditions', () => ({
        toCoordinate: toCoordinateStub,
        fetchServiceWeekWeather: jest.fn().mockResolvedValue(SETTLED),
      }));
      const { fetchPestWeekWeatherSafe } = require('../routes/reports-public');
      await expect(fetchPestWeekWeatherSafe(GEOCODED)).resolves.toEqual(SETTLED);
    });
  });

  test('BOTH PDF cache-decision sites consult it — the direct route (reports-public.js) and the queued renderer (pdf-queue.js)', () => {
    const reportsPublic = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports-public.js'), 'utf8');
    const pdfQueue = fs.readFileSync(path.join(__dirname, '..', 'services', 'service-report', 'pdf-queue.js'), 'utf8');
    for (const src of [reportsPublic, pdfQueue]) {
      expect(src).toMatch(/renderedData\?\.pestWeekWeatherUncacheable/);
    }
    // reports-public.js branches AROUND the putReportPdf call, same as the
    // lawn guard immediately above it.
    expect(reportsPublic).toMatch(/renderedData\?\.pestWeekWeatherUncacheable\)[\s\S]{0,600}\} else if/);
    // pdf-queue.js returns the bytes with no key rather than storing.
    expect(pdfQueue).toMatch(/renderedData\?\.pestWeekWeatherUncacheable\)[\s\S]{0,300}uncached: true/);
  });

  test('pdf-queue.js never composes pestReportV2 itself — it learns the fact through pestWeekWeatherUncacheableForPdf, mode: "static"', () => {
    const pdfQueue = fs.readFileSync(path.join(__dirname, '..', 'services', 'service-report', 'pdf-queue.js'), 'utf8');
    expect(pdfQueue).not.toMatch(/buildPestReportV2/);
    expect(pdfQueue).toMatch(/pestWeekWeatherUncacheableForPdf\(service, \{ mode: 'static' \}\)/);
  });

  test('never live, and gate off is always false regardless of mode', () => {
    const { pestWeekWeatherUncacheableForPdf } = require('../services/service-report/pest-report-v2');
    const ORIGINAL_GATE = process.env.GATE_PEST_REPORT_EXPECTATIONS;
    const ORIGINAL_V2 = process.env.PEST_REPORT_V2;
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    process.env.PEST_REPORT_V2 = 'true';
    return Promise.resolve()
      .then(async () => {
        // LIVE is never uncacheable this way, even with a broken service row.
        await expect(pestWeekWeatherUncacheableForPdf({}, { mode: 'live' })).resolves.toBe(false);
        // Gate off => always false regardless of mode.
        process.env.GATE_PEST_REPORT_EXPECTATIONS = 'false';
        await expect(pestWeekWeatherUncacheableForPdf({ service_line: 'pest' }, { mode: 'static' })).resolves.toBe(false);
      })
      .finally(() => {
        process.env.GATE_PEST_REPORT_EXPECTATIONS = ORIGINAL_GATE;
        process.env.PEST_REPORT_V2 = ORIGINAL_V2;
      });
  });

  // codex P1 2026-09-29 (pre-push audit): windowClosed alone conflated a
  // genuine settled reading with a provider outage disguised as one, and a
  // fetch exception was swallowed into the SAME `null` "no coordinates"
  // uses. These four cases are the exact regression matrix that finding
  // named: provider throws, closed-window-but-empty, no coordinates, and
  // recovery once the provider is healthy again.
  describe('settled vs provider-failure vs no-coordinates (codex P1 2026-09-29)', () => {
    const ORIGINAL_GATE = process.env.GATE_PEST_REPORT_EXPECTATIONS;
    const ORIGINAL_V2 = process.env.PEST_REPORT_V2;
    const GEOCODED = {
      service_line: 'pest',
      customer_latitude: 27.4,
      customer_longitude: -82.5,
      service_date: '2026-07-16',
    };

    function toCoordinateStub(value) {
      if (value === null || value === undefined || value === '') return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }

    function mockWeekWeather(impl) {
      jest.doMock('../services/service-report/application-conditions', () => ({
        toCoordinate: toCoordinateStub,
        fetchServiceWeekWeather: impl,
      }));
    }

    beforeEach(() => {
      process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
      process.env.PEST_REPORT_V2 = 'true';
      jest.resetModules();
    });
    afterEach(() => {
      process.env.GATE_PEST_REPORT_EXPECTATIONS = ORIGINAL_GATE;
      process.env.PEST_REPORT_V2 = ORIGINAL_V2;
      jest.dontMock('../services/service-report/application-conditions');
    });

    test('(1) geocoded visit, provider throws => marker TRUE (transient, PDF must not be stored)', async () => {
      mockWeekWeather(jest.fn().mockRejectedValue(new Error('provider unavailable')));
      const { pestWeekWeatherUncacheableForPdf } = require('../services/service-report/pest-report-v2');
      await expect(pestWeekWeatherUncacheableForPdf(GEOCODED, { mode: 'static' })).resolves.toBe(true);
    });

    test('(2) geocoded visit, closed window but rainInches null => marker TRUE (provider outage disguised as settled)', async () => {
      mockWeekWeather(jest.fn().mockResolvedValue({ rainInches: null, windowClosed: true }));
      const { pestWeekWeatherUncacheableForPdf } = require('../services/service-report/pest-report-v2');
      await expect(pestWeekWeatherUncacheableForPdf(GEOCODED, { mode: 'static' })).resolves.toBe(true);
    });

    test('(3) no coordinates at all => marker FALSE (legitimately cacheable — nothing will ever retry)', async () => {
      const fetchServiceWeekWeather = jest.fn();
      mockWeekWeather(fetchServiceWeekWeather);
      const { pestWeekWeatherUncacheableForPdf } = require('../services/service-report/pest-report-v2');
      await expect(pestWeekWeatherUncacheableForPdf({ service_line: 'pest' }, { mode: 'static' })).resolves.toBe(false);
      // Never even attempts the fetch when there is nowhere to fetch for.
      expect(fetchServiceWeekWeather).not.toHaveBeenCalled();
    });

    test('(4) recovery: the SAME geocoded visit, provider now returns a settled populated reading => marker FALSE', async () => {
      mockWeekWeather(jest.fn().mockResolvedValue({ rainInches: 1.2, windowClosed: true }));
      const { pestWeekWeatherUncacheableForPdf } = require('../services/service-report/pest-report-v2');
      await expect(pestWeekWeatherUncacheableForPdf(GEOCODED, { mode: 'static' })).resolves.toBe(false);
    });

    test('geocoded visit, window still open (no failure, just accumulating) => marker TRUE', async () => {
      mockWeekWeather(jest.fn().mockResolvedValue({ rainInches: 0.2, windowClosed: false }));
      const { pestWeekWeatherUncacheableForPdf } = require('../services/service-report/pest-report-v2');
      await expect(pestWeekWeatherUncacheableForPdf(GEOCODED, { mode: 'static' })).resolves.toBe(true);
    });
  });
});

// codex P2 2026-09-29 (round 2): rainChance is the PROBABILITY of any
// measurable precipitation, not its intensity — a 70% chance of light rain
// is not "heavy rain right after a treatment can reduce it". Intensity now
// reads ONLY from the forecast text (storm/thunderstorm/heavy rain).
describe('fetchPestRainForecastHeavySafe — probability alone never marks heavy rain', () => {
  const SERVICE = { customer_latitude: 27.4, customer_longitude: -82.5 };

  beforeEach(() => { jest.resetModules(); });
  afterEach(() => { jest.dontMock('../services/weather-forecast'); });

  test('rainChance 70 + "Light Rain" text: NOT heavy', async () => {
    jest.doMock('../services/weather-forecast', () => ({
      getDailyRainOutlookBounded: jest.fn().mockResolvedValue({
        '2026-07-16': { rainChance: 70, shortForecast: 'Light Rain' },
      }),
    }));
    const { fetchPestRainForecastHeavySafe } = require('../routes/reports-public');
    await expect(fetchPestRainForecastHeavySafe(SERVICE)).resolves.toBe(false);
  });

  test('a high rainChance with no storm/heavy-rain text anywhere: NOT heavy, regardless of the percentage', async () => {
    jest.doMock('../services/weather-forecast', () => ({
      getDailyRainOutlookBounded: jest.fn().mockResolvedValue({
        '2026-07-16': { rainChance: 95, shortForecast: 'Mostly Cloudy' },
      }),
    }));
    const { fetchPestRainForecastHeavySafe } = require('../routes/reports-public');
    await expect(fetchPestRainForecastHeavySafe(SERVICE)).resolves.toBe(false);
  });

  test('"Thunderstorms" forecast text: heavy, even with a low rainChance', async () => {
    jest.doMock('../services/weather-forecast', () => ({
      getDailyRainOutlookBounded: jest.fn().mockResolvedValue({
        '2026-07-16': { rainChance: 30, shortForecast: 'Thunderstorms' },
      }),
    }));
    const { fetchPestRainForecastHeavySafe } = require('../routes/reports-public');
    await expect(fetchPestRainForecastHeavySafe(SERVICE)).resolves.toBe(true);
  });

  test('"heavy rain" forecast text also qualifies', async () => {
    jest.doMock('../services/weather-forecast', () => ({
      getDailyRainOutlookBounded: jest.fn().mockResolvedValue({
        '2026-07-16': { rainChance: null, shortForecast: 'Heavy Rain Likely' },
      }),
    }));
    const { fetchPestRainForecastHeavySafe } = require('../routes/reports-public');
    await expect(fetchPestRainForecastHeavySafe(SERVICE)).resolves.toBe(true);
  });

  test('no outlook at all: fail-open false', async () => {
    jest.doMock('../services/weather-forecast', () => ({
      getDailyRainOutlookBounded: jest.fn().mockResolvedValue(null),
    }));
    const { fetchPestRainForecastHeavySafe } = require('../routes/reports-public');
    await expect(fetchPestRainForecastHeavySafe(SERVICE)).resolves.toBe(false);
  });
});
