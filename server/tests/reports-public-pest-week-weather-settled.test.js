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
    expect(source).toMatch(/const weekWeather = settledWeekWeatherForRender\(fetchedWeekWeather, mode\);[\s\S]{0,1600}buildPestReportV2\(\{/);
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
    expect(source).toMatch(
      /const pestWeekWeatherUncacheable = expectationsGateOn[\s\S]{0,200}mode !== 'live'[\s\S]{0,200}fetchedWeekWeather\.windowClosed !== true;/,
    );
    expect(source).toMatch(/data\.pestWeekWeatherUncacheable = pestWeekWeatherUncacheable;/);
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

  test('the shared pestWeekWeatherUncacheableForPdf is fail-open (false) and never live', () => {
    const { pestWeekWeatherUncacheableForPdf } = require('../services/service-report/pest-report-v2');
    const ORIGINAL_GATE = process.env.GATE_PEST_REPORT_EXPECTATIONS;
    const ORIGINAL_V2 = process.env.PEST_REPORT_V2;
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    process.env.PEST_REPORT_V2 = 'true';
    return Promise.resolve()
      .then(async () => {
        // LIVE is never uncacheable this way, even with a broken service row.
        await expect(pestWeekWeatherUncacheableForPdf({}, { mode: 'live' })).resolves.toBe(false);
        // No coordinates at all => the fetch resolves null => not uncacheable
        // (nothing rain-derived is at risk of being cached stale).
        await expect(pestWeekWeatherUncacheableForPdf({ service_line: 'pest' }, { mode: 'static' })).resolves.toBe(false);
        // Gate off => always false regardless of mode.
        process.env.GATE_PEST_REPORT_EXPECTATIONS = 'false';
        await expect(pestWeekWeatherUncacheableForPdf({ service_line: 'pest' }, { mode: 'static' })).resolves.toBe(false);
      })
      .finally(() => {
        process.env.GATE_PEST_REPORT_EXPECTATIONS = ORIGINAL_GATE;
        process.env.PEST_REPORT_V2 = ORIGINAL_V2;
      });
  });
});
