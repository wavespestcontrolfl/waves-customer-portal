/**
 * Weekly irrigation recommendation email.
 *
 * Pins the contract: only a clear surplus/deficit with a FULL rainfall window
 * sends (balanced / rain-unknown / no-schedule weeks send nothing), the
 * completed-week window resolution, the deterministic forecast line, the
 * gate-off shadow mode (count, never send), and the send path's idempotency
 * key + suppression stream.
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true, message: { provider_message_id: 'sg-1', sent_at: '2026-07-06T11:00:00Z' } })),
}));
jest.mock('../services/service-report/application-conditions', () => ({
  fetchServiceWeekWeather: jest.fn(async () => ({ rainInches: null, et0Inches: null, dailyRain: null })),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const EmailTemplateLibrary = require('../services/email-template-library');
const { fetchServiceWeekWeather } = require('../services/service-report/application-conditions');
const {
  runWeeklyIrrigationEmailSweep,
  buildWeeklyEmailDecision,
  fetchUpcomingWeekRainForecast,
  TEMPLATE_CUT_BACK,
  TEMPLATE_ADD_WATER,
  _private,
} = require('../services/irrigation-weekly-email');

// July (peak season) Sunday; St. Augustine target from ET₀ 1.6 × 0.8 = 1.25".
const WEEK_ENDING = '2026-07-05';

describe('lastCompletedWeekEnding', () => {
  test('Monday-morning run resolves to yesterday (Sunday)', () => {
    expect(_private.lastCompletedWeekEnding(new Date('2026-07-06T07:00:00-04:00'))).toBe('2026-07-05');
  });

  test('mid-week manual run resolves to the same most recent Sunday', () => {
    expect(_private.lastCompletedWeekEnding(new Date('2026-07-08T15:00:00-04:00'))).toBe('2026-07-05');
  });

  test('a run ON Sunday reaches back to the previous completed week', () => {
    expect(_private.lastCompletedWeekEnding(new Date('2026-07-05T09:00:00-04:00'))).toBe('2026-06-28');
  });

  test('late-night ET boundary: Monday 00:30 ET (04:30 UTC) is still Monday in ET', () => {
    expect(_private.lastCompletedWeekEnding(new Date('2026-07-06T04:30:00Z'))).toBe('2026-07-05');
  });
});

describe('buildWeeklyEmailDecision', () => {
  const base = {
    firstName: 'Dana',
    grassType: 'st_augustine',
    weekEnding: WEEK_ENDING,
    et0Inches: 1.6,
  };

  test('surplus → cut_back template with the water-balance numbers', () => {
    const decision = buildWeeklyEmailDecision({
      ...base,
      irrigationInchesPerWeek: 1,
      rainfallInches7d: 2.1,
    });
    expect(decision.shouldSend).toBe(true);
    expect(decision.templateKey).toBe(TEMPLATE_CUT_BACK);
    expect(decision.reason).toBe('surplus');
    expect(decision.payload).toMatchObject({
      first_name: 'Dana',
      grass_label: 'St. Augustine',
      rain_last_week: '2.1',
      irrigation_inches: '1',
      total_inches: '3', // roundQuarter(2.1 + 1) = 3.0
      target_inches: '1.25', // ET₀ 1.6 × Kc 0.8, peak season
      difference_inches: '1.75', // roundQuarter(3 − 1.25)
    });
    expect(decision.payload.customer_portal_url).toContain('tab=property');
  });

  test('deficit → add_water template with the shortfall amount', () => {
    const decision = buildWeeklyEmailDecision({
      ...base,
      irrigationInchesPerWeek: 0.25,
      rainfallInches7d: 0,
    });
    expect(decision.shouldSend).toBe(true);
    expect(decision.templateKey).toBe(TEMPLATE_ADD_WATER);
    expect(decision.reason).toBe('deficit');
    expect(decision.payload).toMatchObject({
      rain_last_week: '0',
      total_inches: '0.25',
      difference_inches: '1',
    });
  });

  test('balanced week sends nothing', () => {
    const decision = buildWeeklyEmailDecision({
      ...base,
      irrigationInchesPerWeek: 1.25,
      rainfallInches7d: 0,
    });
    expect(decision.shouldSend).toBe(false);
    expect(decision.reason).toBe('balanced');
  });

  test('surplus WITHOUT a full rainfall window sends nothing — never quote 0" rain we do not know about', () => {
    const decision = buildWeeklyEmailDecision({
      ...base,
      irrigationInchesPerWeek: 3, // alone above target → advice says surplus
      rainfallInches7d: null,
    });
    expect(decision.shouldSend).toBe(false);
    expect(decision.reason).toBe('rain_unknown');
  });

  test('no usable irrigation schedule sends nothing', () => {
    const decision = buildWeeklyEmailDecision({
      ...base,
      irrigationInchesPerWeek: null,
      rainfallInches7d: 1,
    });
    expect(decision.shouldSend).toBe(false);
    expect(decision.reason).toBe('unknown');
  });

  test('no ET₀ falls back to the grass×season target', () => {
    const decision = buildWeeklyEmailDecision({
      ...base,
      et0Inches: null,
      irrigationInchesPerWeek: 1,
      rainfallInches7d: 2.1,
    });
    // July = peak → St. Augustine seasonal lookup is also 1.25"
    expect(decision.payload.target_inches).toBe('1.25');
  });
});

describe('resolveGrassType', () => {
  const { resolveGrassType } = _private;

  test('turf-profile grass wins over legacy lawn_type', () => {
    expect(resolveGrassType({ grass_type: 'bahia', lawn_type: 'Zoysia Empire' })).toBe('bahia');
  });

  test('legacy free-text customers.lawn_type normalizes to a canonical key', () => {
    expect(resolveGrassType({ grass_type: null, lawn_type: 'Zoysia Empire' })).toBe('zoysia');
    expect(resolveGrassType({ grass_type: null, lawn_type: 'Floratam' })).toBe('st_augustine');
    expect(resolveGrassType({ grass_type: null, lawn_type: 'Argentine Bahia' })).toBe('bahia');
  });

  test('unrecognizable lawn_type falls through to null (advice uses its own default)', () => {
    expect(resolveGrassType({ grass_type: null, lawn_type: 'nice green one' })).toBe(null);
    expect(resolveGrassType({})).toBe(null);
  });
});

describe('customerGrassLabel', () => {
  const { customerGrassLabel } = _private;

  test('real grasses render by name', () => {
    expect(customerGrassLabel('st_augustine')).toBe('St. Augustine');
    expect(customerGrassLabel('bahia')).toBe('Bahia');
  });

  test("unknown / mixed / missing render as 'lawn' — never 'your Unknown'", () => {
    expect(customerGrassLabel('unknown')).toBe('lawn');
    expect(customerGrassLabel('mixed')).toBe('lawn');
    expect(customerGrassLabel(null)).toBe('lawn');
  });
});

describe('sanitizeFailureReason', () => {
  const { sanitizeFailureReason } = _private;

  test('redacts email addresses echoed by provider errors and keeps the status', () => {
    const err = new Error('SendGrid 403: does not match a verified Sender Identity: dana@example.com');
    err.status = 403;
    const reason = sanitizeFailureReason(err);
    expect(reason).not.toContain('dana@example.com');
    expect(reason).toContain('[redacted-email]');
    expect(reason).toContain('status=403');
  });

  test('passes plain errors through', () => {
    expect(sanitizeFailureReason(new Error('timeout'))).toBe('timeout');
  });
});

describe('forecastLine', () => {
  const { forecastLine } = _private;

  test('null forecast → empty string (paragraph renders nothing)', () => {
    expect(forecastLine({ forecastRainInches: null, status: 'deficit', targetInches: 1.25 })).toBe('');
  });

  test('dry forecast reads as little-to-no rain', () => {
    expect(forecastLine({ forecastRainInches: 0.05, status: 'deficit', targetInches: 1.25 }))
      .toMatch(/little to no rain/);
  });

  test('deficit + forecast covering the full target adds the hold-off caveat', () => {
    const line = forecastLine({ forecastRainInches: 1.5, status: 'deficit', targetInches: 1.25 });
    expect(line).toContain('1.5"');
    expect(line).toMatch(/watch the weather before adding sprinkler time/);
  });

  test('surplus + heavy forecast reinforces easing back', () => {
    const line = forecastLine({ forecastRainInches: 2, status: 'surplus', targetInches: 1.25 });
    expect(line).toMatch(/easing back now will really pay off/);
  });

  test('moderate forecast is informational only', () => {
    const line = forecastLine({ forecastRainInches: 0.5, status: 'deficit', targetInches: 1.25 });
    expect(line).toBe('Looking ahead: about 0.5" of rain is in the forecast for your area over the next 7 days.');
  });
});

describe('fetchUpcomingWeekRainForecast', () => {
  // The module caches by coordinates — every case uses distinct coords.
  const okJson = (precipitation_sum) => ({ ok: true, json: async () => ({ daily: { precipitation_sum } }) });

  test('a full 7-day window sums to inches', async () => {
    global.fetch = jest.fn(async () => okJson([0.1, 0, 0.25, 0.5, 0, 0.3, 0.05]));
    await expect(fetchUpcomingWeekRainForecast({ latitude: 28.01, longitude: -81.01 })).resolves.toBe(1.2);
  });

  test('a SHORT window (Open-Meteo 200 with a partial series) is unknown, not "little rain"', async () => {
    global.fetch = jest.fn(async () => okJson([0.1, 0.2, 0.3]));
    await expect(fetchUpcomingWeekRainForecast({ latitude: 28.02, longitude: -81.02 })).resolves.toBe(null);
  });

  test('a null day inside the window is unknown', async () => {
    global.fetch = jest.fn(async () => okJson([0.1, 0, null, 0.5, 0, 0.3, 0.05]));
    await expect(fetchUpcomingWeekRainForecast({ latitude: 28.03, longitude: -81.03 })).resolves.toBe(null);
  });

  test('a non-2xx response fails soft to null', async () => {
    global.fetch = jest.fn(async () => ({ ok: false }));
    await expect(fetchUpcomingWeekRainForecast({ latitude: 28.04, longitude: -81.04 })).resolves.toBe(null);
  });
});

describe('runWeeklyIrrigationEmailSweep', () => {
  const CANDIDATE = {
    id: 'cust-1',
    first_name: 'Dana',
    email: 'dana@example.com',
    latitude: 27.42,
    longitude: -82.4,
    irrigation_inches_per_week: 1,
    grass_type: 'st_augustine',
  };

  const inserts = [];

  function makeBuilder(cfg = {}) {
    const b = {};
    for (const m of [
      'join', 'leftJoin', 'where', 'whereNull', 'whereNotNull', 'whereRaw',
      'orWhereRaw', 'orWhereNotNull', 'orWhereExists', 'select', 'orderBy', 'from', 'first',
    ]) b[m] = jest.fn(() => b);
    b.insert = jest.fn((row) => { inserts.push(row); return Promise.resolve([1]); });
    b.then = (resolve, reject) => Promise.resolve(cfg.rows ?? []).then(resolve, reject);
    return b;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    inserts.length = 0;
    // Forecast fetch fails soft → null forecast → email still sends without the line.
    global.fetch = jest.fn(async () => ({ ok: false }));
    db.mockImplementation((table) => makeBuilder(
      String(table).startsWith('customers') ? { rows: [CANDIDATE] } : {},
    ));
    fetchServiceWeekWeather.mockResolvedValue({ rainInches: 2.1, et0Inches: 1.6, dailyRain: [] });
  });

  // Monday after WEEK_ENDING, fixed so the idempotency key is predictable.
  const NOW = new Date('2026-07-06T07:00:00-04:00');

  test('gate off → shadow mode: counts candidates, never fetches weather or sends', async () => {
    isEnabled.mockReturnValue(false);
    const summary = await runWeeklyIrrigationEmailSweep({ now: NOW });
    expect(summary).toMatchObject({ shadow: true, candidates: 1, sent: 0, weekEnding: WEEK_ENDING });
    expect(fetchServiceWeekWeather).not.toHaveBeenCalled();
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test('gate on + surplus week → sends cut_back with week-scoped idempotency key on the suppressible stream', async () => {
    isEnabled.mockReturnValue(true);
    const summary = await runWeeklyIrrigationEmailSweep({ now: NOW });
    expect(summary).toMatchObject({ shadow: false, candidates: 1, sent: 1, failed: 0 });

    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    const call = EmailTemplateLibrary.sendTemplate.mock.calls[0][0];
    expect(call.templateKey).toBe(TEMPLATE_CUT_BACK);
    expect(call.to).toBe('dana@example.com');
    expect(call.recipientId).toBe('cust-1');
    expect(call.suppressionGroupKey).toBe('service_operational');
    expect(call.idempotencyKey).toMatch(new RegExp(`^irrigation\\.weekly:cust-1:${WEEK_ENDING}:[0-9a-f]{16}$`));
    expect(call.payload.total_inches).toBe('3');
    // Raw SendGrid bodies can echo the address — the transport log must be
    // suppressed; this sweep logs its own sanitized reason.
    expect(call.suppressProviderErrorLog).toBe(true);

    // Audit trail row recorded for the send.
    expect(inserts.some((row) => row.interaction_type === 'email_outbound')).toBe(true);
  });

  test('balanced week → nothing sends, skip is counted, and no forecast call is spent', async () => {
    isEnabled.mockReturnValue(true);
    fetchServiceWeekWeather.mockResolvedValue({ rainInches: 0.25, et0Inches: 1.6, dailyRain: [] });
    const summary = await runWeeklyIrrigationEmailSweep({ now: NOW });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(summary.sent).toBe(0);
    expect(summary.skipped.balanced).toBe(1);
    // The forecast only decorates copy — a skipped customer must not cost an
    // Open-Meteo forecast request.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('legacy lawn_type customer without a turf profile is scored against their real grass', async () => {
    isEnabled.mockReturnValue(true);
    db.mockImplementation((table) => makeBuilder(
      String(table).startsWith('customers')
        ? { rows: [{ ...CANDIDATE, grass_type: null, lawn_type: 'Argentine Bahia' }] }
        : {},
    ));
    // Bahia target at ET₀ 1.6 is 0.75" (Kc 0.45, roundQuarter) — 1" irrigation
    // + 0.5" rain = 1.5" applied → surplus for bahia (St. Augustine's 1.25"
    // target would have read balanced-ish; the fallback changes the outcome).
    fetchServiceWeekWeather.mockResolvedValue({ rainInches: 0.5, et0Inches: 1.6, dailyRain: [] });
    await runWeeklyIrrigationEmailSweep({ now: NOW });
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    const call = EmailTemplateLibrary.sendTemplate.mock.calls[0][0];
    expect(call.templateKey).toBe(TEMPLATE_CUT_BACK);
    expect(call.payload.grass_label).toBe('Bahia');
    expect(call.payload.target_inches).toBe('0.75');
  });

  test('a provider error carrying an email address is logged redacted', async () => {
    isEnabled.mockReturnValue(true);
    const err = new Error('SendGrid 403: sender identity mismatch for dana@example.com');
    err.status = 403;
    EmailTemplateLibrary.sendTemplate.mockRejectedValue(err);
    const summary = await runWeeklyIrrigationEmailSweep({ now: NOW });
    expect(summary.failed).toBe(1);
    const audit = inserts.find((row) => row.interaction_type === 'email_outbound');
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit)).not.toContain('dana@example.com');
    expect(audit.body).toContain('[redacted-email]');
  });

  test('incomplete rainfall window → nothing sends, rain_unknown counted', async () => {
    isEnabled.mockReturnValue(true);
    fetchServiceWeekWeather.mockResolvedValue({ rainInches: null, et0Inches: null, dailyRain: null });
    const summary = await runWeeklyIrrigationEmailSweep({ now: NOW });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(summary.skipped.rain_unknown).toBe(1);
  });

  test('template-library dedupe (re-run same week) counts as deduped, not sent', async () => {
    isEnabled.mockReturnValue(true);
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ deduped: true });
    const summary = await runWeeklyIrrigationEmailSweep({ now: NOW });
    expect(summary.sent).toBe(0);
    expect(summary.deduped).toBe(1);
  });

  test('the run cap counts ATTEMPTS, not successes — downstream failures cannot bypass it', async () => {
    isEnabled.mockReturnValue(true);
    db.mockImplementation((table) => makeBuilder(
      String(table).startsWith('customers')
        ? { rows: [CANDIDATE, { ...CANDIDATE, id: 'cust-2', email: 'sam@example.com' }] }
        : {},
    ));
    // The first attempt throws AFTER the provider might have accepted (e.g. a
    // DB/audit failure). sent stays 0, but the attempt must consume the cap so
    // the second candidate is capped, not attempted.
    EmailTemplateLibrary.sendTemplate.mockRejectedValue(new Error('audit write failed'));
    const summary = await runWeeklyIrrigationEmailSweep({ now: NOW, maxSendAttempts: 1 });
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    expect(summary.attempted).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.skipped.capped).toBe(1);
  });

  test('per-customer failure is contained: one bad send does not abort the sweep', async () => {
    isEnabled.mockReturnValue(true);
    db.mockImplementation((table) => makeBuilder(
      String(table).startsWith('customers')
        ? { rows: [CANDIDATE, { ...CANDIDATE, id: 'cust-2', email: 'sam@example.com' }] }
        : {},
    ));
    EmailTemplateLibrary.sendTemplate
      .mockRejectedValueOnce(new Error('sendgrid 500'))
      .mockResolvedValueOnce({ sent: true, message: {} });
    const summary = await runWeeklyIrrigationEmailSweep({ now: NOW });
    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(1);
  });
});
