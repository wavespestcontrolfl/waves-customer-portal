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
    expect(source).toMatch(/const weekWeather = settledWeekWeatherForRender\(fetchedWeekWeather, mode\);[\s\S]{0,400}buildPestReportV2\(\{/);
  });
});
