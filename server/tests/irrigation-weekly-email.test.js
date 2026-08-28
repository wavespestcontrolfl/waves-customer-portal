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
// The week-plan gate stays OFF here: these suites pin the legacy sweep
// (plan mode has its own suites).
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn((gate) => gate !== 'irrigationWeekPlan') }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true, message: { provider_message_id: 'sg-1', sent_at: '2026-07-06T11:00:00Z' } })),
  activeSuppressionsFor: jest.fn(async () => []),
}));
jest.mock('../services/service-report/application-conditions', () => ({
  // Real unit helpers — the forecast fetcher's ET₀ conversion is under test.
  sumPrecipInches: jest.requireActual('../services/service-report/application-conditions').sumPrecipInches,
  et0SumToInches: jest.requireActual('../services/service-report/application-conditions').et0SumToInches,
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
  findEligibleCustomers,
  fetchUpcomingWeekForecast,
  TEMPLATE_CUT_BACK,
  TEMPLATE_ADD_WATER,
  TEMPLATE_ON_TRACK,
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
      total_inches: '3.1', // printed components add exactly: 2.1 + 1
      target_inches: '1.25', // ET₀ 1.6 × Kc 0.8, peak season
      difference_inches: '1.85', // printed total − printed target: 3.1 − 1.25
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

  test('balanced week sends the on-track email with a right-in-line summary', () => {
    const decision = buildWeeklyEmailDecision({
      ...base,
      irrigationInchesPerWeek: 1.25,
      rainfallInches7d: 0,
    });
    expect(decision.shouldSend).toBe(true);
    expect(decision.templateKey).toBe(TEMPLATE_ON_TRACK);
    expect(decision.reason).toBe('balanced');
    expect(decision.payload.summary_line).toContain('right in line');
    expect(decision.payload.summary_line).toContain('1.25"');
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

  // Was "no usable irrigation schedule sends nothing" until the owner
  // directive 2026-08-01 widened the sweep: a missing schedule is now a
  // SETUP variant, not a silence. The advice numbers must still be withheld —
  // full variant coverage lives in irrigation-setup-email-templates.test.js.
  test('no usable irrigation schedule sends the setup variant instead of nothing', () => {
    const decision = buildWeeklyEmailDecision({
      ...base,
      irrigationInchesPerWeek: null,
      rainfallInches7d: 1,
    });
    expect(decision.shouldSend).toBe(true);
    expect(decision.reason).toBe('setup_system');
    expect(decision.payload.rain_last_week).toBe('1');
    // No balance is claimed when we don't know what they apply.
    expect(decision.payload.total_inches).toBeUndefined();
    expect(decision.payload.difference_inches).toBeUndefined();
  });

  test('deficit is REROUTED to on-track when the forecast alone covers the weekly target', () => {
    const decision = buildWeeklyEmailDecision({
      ...base,
      irrigationInchesPerWeek: 0.25,
      rainfallInches7d: 0,
      forecastRainInches: 1.5, // ≥ the 1.25" target — don't say "add water"
    });
    expect(decision.shouldSend).toBe(true);
    expect(decision.templateKey).toBe(TEMPLATE_ON_TRACK);
    expect(decision.reason).toBe('deficit_rain_forecast');
    // The summary carries the forecast explanation; no separate forecast line.
    expect(decision.payload.summary_line).toContain('1.5"');
    expect(decision.payload.summary_line).toContain('has it covered');
    expect(decision.payload.forecast_line).toBe('');
  });

  test('deficit is REROUTED to on-track when schedule + forecast together cover the week ahead', () => {
    // 0.5" scheduled irrigation keeps running; 0.8" forecast rain (alone below
    // the 1.25" target) brings the projected week to 1.3" — no longer a
    // deficit, so "add water" must not send.
    const decision = buildWeeklyEmailDecision({
      ...base,
      irrigationInchesPerWeek: 0.5,
      rainfallInches7d: 0,
      forecastRainInches: 0.8,
    });
    expect(decision.shouldSend).toBe(true);
    expect(decision.templateKey).toBe(TEMPLATE_ON_TRACK);
    expect(decision.reason).toBe('deficit_rain_forecast');
  });

  test('deficit still says add-water when schedule + forecast stay short, and when the forecast is unknown', () => {
    const short = buildWeeklyEmailDecision({
      ...base, irrigationInchesPerWeek: 0.25, rainfallInches7d: 0, forecastRainInches: 0.5,
    });
    expect(short.templateKey).toBe(TEMPLATE_ADD_WATER); // projected 0.75" vs 1.25" — still a deficit
    expect(short.payload.summary_line).toContain('short of the 1.25"');
    const noForecast = buildWeeklyEmailDecision({
      ...base, irrigationInchesPerWeek: 0.25, rainfallInches7d: 0, forecastRainInches: null,
    });
    expect(noForecast.templateKey).toBe(TEMPLATE_ADD_WATER); // fail soft to last week's facts
  });

  test('a rain-fed balanced week followed by a dry forecast says add-water, not on-track', () => {
    // 0.25" schedule + 1" rain hit last week's 1.25" target, but the schedule
    // alone cannot carry a dry week — "no changes needed" would under-water.
    const decision = buildWeeklyEmailDecision({
      ...base,
      irrigationInchesPerWeek: 0.25,
      rainfallInches7d: 1,
      forecastRainInches: 0,
    });
    expect(decision.shouldSend).toBe(true);
    expect(decision.templateKey).toBe(TEMPLATE_ADD_WATER);
    expect(decision.reason).toBe('balanced_dry_forecast');
    expect(decision.payload.summary_line).toContain('rain did part of the work');
    expect(decision.payload.summary_line).toContain('1" short'); // 1.25 − 0.25 − 0
    expect(decision.payload.forecast_line).toBe('');
  });

  test('a balanced week whose schedule carries the dry week ahead stays on-track', () => {
    // Schedule 1.25" alone meets the target — no rain dependence, no reroute.
    const decision = buildWeeklyEmailDecision({
      ...base,
      irrigationInchesPerWeek: 1.25,
      rainfallInches7d: 0,
      forecastRainInches: 0,
    });
    expect(decision.templateKey).toBe(TEMPLATE_ON_TRACK);
    expect(decision.reason).toBe('balanced');
  });

  test('surplus is NOT forecast-vetoed — a saturated lawn should ease back regardless', () => {
    const decision = buildWeeklyEmailDecision({
      ...base,
      irrigationInchesPerWeek: 1,
      rainfallInches7d: 2.1,
      forecastRainInches: 3,
    });
    expect(decision.shouldSend).toBe(true);
    expect(decision.templateKey).toBe(TEMPLATE_CUT_BACK);
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

  test('surplus + heavy forecast reinforces easing back', () => {
    const line = forecastLine({ forecastRainInches: 2, status: 'surplus', targetInches: 1.25 });
    expect(line).toMatch(/easing back now will really pay off/);
  });

  test('moderate forecast is informational only', () => {
    const line = forecastLine({ forecastRainInches: 0.5, status: 'deficit', targetInches: 1.25 });
    expect(line).toBe('Looking ahead: about 0.5" of rain is in the forecast for your area over the next 7 days.');
  });
});

describe('fetchUpcomingWeekForecast', () => {
  // The module caches by coordinates — every case uses distinct coords.
  const okJson = (precipitation_sum, et0_fao_evapotranspiration, et0Unit = 'inch') => ({ ok: true, json: async () => ({ daily: { precipitation_sum, ...(et0_fao_evapotranspiration ? { et0_fao_evapotranspiration } : {}) }, daily_units: { precipitation_sum: 'inch', ...(et0_fao_evapotranspiration ? { et0_fao_evapotranspiration: et0Unit } : {}) } }) });

  test('a full 7-day window sums to inches', async () => {
    // Under precipitation_unit=inch Open-Meteo reports ET₀ in inches too (daily_units).
    global.fetch = jest.fn(async () => okJson([0.1, 0, 0.25, 0.5, 0, 0.3, 0.05], [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2], 'inch'));
    await expect(fetchUpcomingWeekForecast({ latitude: 28.01, longitude: -81.01 })).resolves.toMatchObject({ rainInches: 1.2, et0Inches: 1.4, days: 7 });
    // …and a mm series (no precipitation_unit, or a unit change upstream) is converted, never divided twice.
    global.fetch = jest.fn(async () => okJson([0.1, 0, 0.25, 0.5, 0, 0.3, 0.05], [5.08, 5.08, 5.08, 5.08, 5.08, 5.08, 5.08], 'mm'));
    await expect(fetchUpcomingWeekForecast({ latitude: 28.06, longitude: -81.06 })).resolves.toMatchObject({ rainInches: 1.2, et0Inches: 1.4 });
    // Bounded to the plan week: a Thursday retry asks for Thu→Sun (4 days), never a rolling 7.
    const thursday = new Date('2026-08-27T16:00:00Z');
    global.fetch = jest.fn(async () => okJson([0.1, 0, 0.25, 0.5], [0.2, 0.2, 0.2, 0.2], 'inch'));
    await expect(fetchUpcomingWeekForecast({ latitude: 28.07, longitude: -81.07, horizonEnd: '2026-08-30', now: thursday })).resolves.toMatchObject({ rainInches: 0.85, et0Inches: 0.8, startDate: '2026-08-27', endDate: '2026-08-30', days: 4 });
    const url = String(global.fetch.mock.calls[0][0]);
    expect(url).toContain('start_date=2026-08-27');
    expect(url).toContain('end_date=2026-08-30');
    expect(url).not.toContain('forecast_days');
    // A 7-day answer to a 4-day ask is a window mismatch → null.
    global.fetch = jest.fn(async () => okJson([0.1, 0, 0.25, 0.5, 0, 0.3, 0.05]));
    await expect(fetchUpcomingWeekForecast({ latitude: 28.08, longitude: -81.08, horizonEnd: '2026-08-30', now: thursday })).resolves.toBe(null);
    expect(String(global.fetch.mock.calls[0][0])).toContain('daily=precipitation_sum%2Cet0_fao_evapotranspiration');
  });

  test('a SHORT window (Open-Meteo 200 with a partial series) is unknown, not "little rain"', async () => {
    global.fetch = jest.fn(async () => okJson([0.1, 0.2, 0.3]));
    await expect(fetchUpcomingWeekForecast({ latitude: 28.02, longitude: -81.02 })).resolves.toBe(null);
  });

  test('a null day inside the window is unknown', async () => {
    global.fetch = jest.fn(async () => okJson([0.1, 0, null, 0.5, 0, 0.3, 0.05]));
    await expect(fetchUpcomingWeekForecast({ latitude: 28.03, longitude: -81.03 })).resolves.toBe(null);
    // A missing/partial ET₀ series leaves et0Inches null without dropping the rain window.
    global.fetch = jest.fn(async () => okJson([0.1, 0, 0.25, 0.5, 0, 0.3, 0.05], [5, 5, 5]));
    await expect(fetchUpcomingWeekForecast({ latitude: 28.05, longitude: -81.05 })).resolves.toMatchObject({ rainInches: 1.2, et0Inches: null });
  });

  test('a non-2xx response fails soft to null', async () => {
    global.fetch = jest.fn(async () => ({ ok: false }));
    await expect(fetchUpcomingWeekForecast({ latitude: 28.04, longitude: -81.04 })).resolves.toBe(null);
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
      'join', 'leftJoin', 'where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw',
      'orWhereRaw', 'orWhereNotNull', 'orWhereExists', 'whereExists', 'select', 'orderBy', 'from', 'first',
    ]) b[m] = jest.fn(() => b);
    b.insert = jest.fn((row) => { inserts.push(row); return Promise.resolve([1]); });
    b.then = (resolve, reject) => Promise.resolve(cfg.rows ?? []).then(resolve, reject);
    return b;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    inserts.length = 0;
    // clearAllMocks keeps implementations — re-pin the default send success so
    // a mockRejectedValue from one test cannot leak into the next.
    EmailTemplateLibrary.sendTemplate.mockImplementation(async () => ({ sent: true, message: { provider_message_id: 'sg-1', sent_at: '2026-07-06T11:00:00Z' } }));
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
    isEnabled.mockImplementation((gate) => gate !== 'irrigationWeekPlan'); // legacy sweep: plan gate off
    const summary = await runWeeklyIrrigationEmailSweep({ now: NOW });
    expect(summary).toMatchObject({ shadow: false, candidates: 1, sent: 1, failed: 0 });

    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    const call = EmailTemplateLibrary.sendTemplate.mock.calls[0][0];
    expect(call.templateKey).toBe(TEMPLATE_CUT_BACK);
    expect(call.to).toBe('dana@example.com');
    expect(call.recipientId).toBe('cust-1');
    expect(call.suppressionGroupKey).toBe('service_operational');
    expect(call.idempotencyKey).toMatch(new RegExp(`^irrigation\\.weekly:cust-1:${WEEK_ENDING}:[0-9a-f]{16}$`));
    expect(call.payload.total_inches).toBe('3.1');
    // Raw SendGrid bodies can echo the address — the transport log must be
    // suppressed; this sweep logs its own sanitized reason.
    expect(call.suppressProviderErrorLog).toBe(true);

    // Audit trail row recorded for the send.
    expect(inserts.some((row) => row.interaction_type === 'email_outbound')).toBe(true);
  });

  test('balanced week → the on-track email sends', async () => {
    isEnabled.mockImplementation((gate) => gate !== 'irrigationWeekPlan'); // legacy sweep: plan gate off
    fetchServiceWeekWeather.mockResolvedValue({ rainInches: 0.25, et0Inches: 1.6, dailyRain: [] });
    const summary = await runWeeklyIrrigationEmailSweep({ now: NOW });
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    const call = EmailTemplateLibrary.sendTemplate.mock.calls[0][0];
    expect(call.templateKey).toBe(TEMPLATE_ON_TRACK);
    expect(call.payload.summary_line).toContain('right in line');
    expect(summary.sent).toBe(1);
  });

  test('legacy lawn_type customer without a turf profile is scored against their real grass', async () => {
    isEnabled.mockImplementation((gate) => gate !== 'irrigationWeekPlan'); // legacy sweep: plan gate off
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
    isEnabled.mockImplementation((gate) => gate !== 'irrigationWeekPlan'); // legacy sweep: plan gate off
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

  test('deficit week with a target-covering forecast → on-track email, not add-water', async () => {
    isEnabled.mockImplementation((gate) => gate !== 'irrigationWeekPlan'); // legacy sweep: plan gate off
    fetchServiceWeekWeather.mockResolvedValue({ rainInches: 0, et0Inches: 1.6, dailyRain: [] });
    // 7 full days summing 1.4"; with the 1" schedule the projected week is
    // covered (the customer's irrigation is 1"/week vs the 1.25" target).
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ daily: { precipitation_sum: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2] } }) }));
    const summary = await runWeeklyIrrigationEmailSweep({ now: NOW });
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    const call = EmailTemplateLibrary.sendTemplate.mock.calls[0][0];
    expect(call.templateKey).toBe(TEMPLATE_ON_TRACK);
    expect(call.categories).toContain('deficit_rain_forecast');
    expect(summary.sent).toBe(1);
  });

  test('incomplete rainfall window → nothing sends, rain_unknown counted, no forecast call is spent', async () => {
    isEnabled.mockImplementation((gate) => gate !== 'irrigationWeekPlan'); // legacy sweep: plan gate off
    fetchServiceWeekWeather.mockResolvedValue({ rainInches: null, et0Inches: null, dailyRain: null });
    const summary = await runWeeklyIrrigationEmailSweep({ now: NOW });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(summary.skipped.rain_unknown).toBe(1);
    // A no-send customer must not cost an Open-Meteo forecast request.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('template-library dedupe (re-run same week) counts as deduped, not sent', async () => {
    isEnabled.mockImplementation((gate) => gate !== 'irrigationWeekPlan'); // legacy sweep: plan gate off
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ deduped: true });
    const summary = await runWeeklyIrrigationEmailSweep({ now: NOW });
    expect(summary.sent).toBe(0);
    expect(summary.deduped).toBe(1);
  });

  test('the run cap counts ATTEMPTS, not successes — downstream failures cannot bypass it', async () => {
    isEnabled.mockImplementation((gate) => gate !== 'irrigationWeekPlan'); // legacy sweep: plan gate off
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

  test('deduped and suppressed results refund the cap — they cannot starve the rest of the list', async () => {
    isEnabled.mockImplementation((gate) => gate !== 'irrigationWeekPlan'); // legacy sweep: plan gate off
    db.mockImplementation((table) => makeBuilder(
      String(table).startsWith('customers')
        ? { rows: [CANDIDATE, { ...CANDIDATE, id: 'cust-2', email: 'sam@example.com' }] }
        : {},
    ));
    // First candidate already sent this week (pre-send idempotency dedupe: the
    // library reports sent+deduped WITHOUT providerAttempted — no SendGrid
    // call); with a cap of 1, the second candidate must still be attempted.
    EmailTemplateLibrary.sendTemplate
      .mockResolvedValueOnce({ sent: true, deduped: true })
      .mockResolvedValueOnce({ sent: true, providerAttempted: true, message: {} });
    const summary = await runWeeklyIrrigationEmailSweep({ now: NOW, maxSendAttempts: 1 });
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(2);
    expect(summary.deduped).toBe(1);
    expect(summary.sent).toBe(1);
    expect(summary.skipped.capped).toBe(0);
    expect(summary.attempted).toBe(1); // only the real provider attempt counts
  });

  test('a deduped result that DID reach the provider (webhook/supersede race) keeps its attempt', async () => {
    isEnabled.mockImplementation((gate) => gate !== 'irrigationWeekPlan'); // legacy sweep: plan gate off
    db.mockImplementation((table) => makeBuilder(
      String(table).startsWith('customers')
        ? { rows: [CANDIDATE, { ...CANDIDATE, id: 'cust-2', email: 'sam@example.com' }] }
        : {},
    ));
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true, deduped: true, providerAttempted: true, message: {} });
    const summary = await runWeeklyIrrigationEmailSweep({ now: NOW, maxSendAttempts: 1 });
    // Provider was reached — the cap must hold: second candidate is capped.
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    expect(summary.attempted).toBe(1);
    expect(summary.skipped.capped).toBe(1);
  });

  test('per-customer failure is contained: one bad send does not abort the sweep', async () => {
    isEnabled.mockImplementation((gate) => gate !== 'irrigationWeekPlan'); // legacy sweep: plan gate off
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

  test('audience selection compiles the opt-out and eligibility clauses (real knex)', async () => {
    // The sweep tests above inject candidate rows past a no-op builder, so
    // they cannot notice a deleted WHERE clause. Compile the real query with
    // knex and pin every load-bearing audience clause — this is what stands
    // between the sweep and emailing customers who opted out.
    const realKnex = require('knex')({ client: 'pg' });
    const originalRaw = db.raw;
    let captured;
    try {
      db.mockImplementation((table) => {
        const b = realKnex(table);
        if (String(table).startsWith('customers')) captured = b;
        // Compile-only: resolve instead of executing (no DB in unit tests).
        b.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
        return b;
      });
      db.raw = realKnex.raw.bind(realKnex);

      await findEligibleCustomers({ now: NOW });
      const { sql, bindings } = captured.toSQL();

      // Portal-wide email kill switch and the seasonal-tips opt-out (this
      // email IS a seasonal tip). IS DISTINCT FROM keeps missing-prefs rows in.
      expect(sql).toContain('np.email_enabled IS DISTINCT FROM false');
      expect(sql).toContain('np.seasonal_tips IS DISTINCT FROM false');
      // Live customers with a contactable email + mappable coordinates only.
      expect(sql).toContain('"c"."active" = ?');
      expect(bindings).toContain(true);
      expect(sql).toContain('"c"."deleted_at" is null');
      expect(sql).toContain('"c"."email" is not null');
      // Irrigation columns are NOT eligibility (owner 2026-08-01) — they pick
      // the copy variant downstream. Gating on them reached 3 of 23 otherwise
      // eligible recurring-lawn customers, so these predicates must stay out
      // of the query or the widening silently reverts.
      expect(sql).not.toContain('"pp"."irrigation_system" = ?');
      expect(sql).not.toContain('"pp"."irrigation_inches_per_week" is not null');
      expect(sql).not.toContain('"pp"."irrigation_inches_per_week" > ?');
      // …and the prefs table must be LEFT joined, or a customer who never
      // opened Property Preferences disappears from the sweep entirely.
      expect(sql).toMatch(/left join "property_preferences"/i);
      expect(sql).not.toMatch(/inner join "property_preferences"/i);
      // Both columns still have to be SELECTED — the variant decision reads them.
      expect(sql).toContain('"pp"."irrigation_system"');
      expect(sql).toContain('"pp"."irrigation_inches_per_week"');
      // Tech-recorded schedules are read too, so the email agrees with the
      // lawn report (codex r1 P2) — but ONLY confirmed assessments, since
      // confirmed_by_tech defaults false and a draft must never drive
      // customer email (codex r2 P1). The latest reading wins INCLUDING a
      // zero, so a newer "they stopped watering" row can't be skipped.
      expect(sql).toContain('la.confirmed_by_tech = true');
      expect(sql).not.toMatch(/la\.irrigation_inches_per_week\s*>\s*0/);
      expect(sql).toMatch(/ORDER BY la\.service_date DESC NULLS LAST/);
      // Real customers only (owner 2026-07-09): pipeline_stage separates
      // customers from leads — customers.active is TRUE on lead rows.
      expect(sql).toContain('"c"."pipeline_stage" in (?, ?, ?)');
      // REQUIRED recurring-lawn evidence (owner 2026-07-09 refined): an
      // upcoming live lawn-flavored visit ON A RECURRING SERIES OR ≥2 in
      // the trailing window.
      expect(sql).toContain('exists');
      expect(sql).toContain('"scheduled_services"');
      expect(sql).toMatch(/SELECT COUNT\(\*\) FROM scheduled_services ss2[\s\S]*>= 2/);
      // The trailing-window count is bounded on BOTH sides (pre-push P1:
      // lower-bound-only let two future one-time bookings count).
      expect(sql).toMatch(/ss2\.scheduled_date >= \?[\s\S]*ss2\.scheduled_date <= \?/);
      // Recurring-series marker on the upcoming branch (Codex #2954 P2):
      // a future ONE-TIME lawn job must not qualify.
      expect(sql).toContain('"ss"."is_recurring" = ?');
      expect(sql).toContain('"ss"."recurring_parent_id" is not null');
      expect(sql).toContain('"ss"."recurring_pattern" is not null');
      // r2: a same-day COMPLETED row is not upcoming evidence…
      expect(sql).toMatch(/not "ss"\."status" = \?/);
      // …follow-up children never pad the cadence count…
      expect(sql).toContain('ss2.parent_service_id IS NULL');
      // …and generic WaveGuard membership/setup rows are not lawn evidence.
      expect(bindings).not.toContain('%waveguard%');
      expect(bindings).toContain('%lawn%');
      // Tier and lawn_type are NOT eligibility — WaveGuard tiers are shared
      // across pest and lawn programs (86% of the tier-qualified audience
      // was verified pest-only), and the turf profile is grass-type
      // corroboration only. The old membership branches must stay gone.
      expect(sql).not.toContain('waveguard_tier');
      expect(sql).not.toMatch(/"c"\."lawn_type" is not null/);
      expect(sql).not.toContain('"tp"."id" is not null');
    } finally {
      db.raw = originalRaw;
    }
  });
});

describe('findLawnEmailAudienceGaps', () => {
  const { findLawnEmailAudienceGaps } = require('../services/irrigation-weekly-email');

  // Thenable knex-chain stub. The customers query resolves the book rows;
  // any other table (the correlated upcoming-evidence subquery builder)
  // returns an inert chain — it is only embedded as SQL, never awaited.
  function mockBookRows(rows) {
    db.mockImplementation((table) => {
      const c = {};
      for (const m of ['leftJoin', 'whereNull', 'where', 'whereRaw', 'whereNot', 'whereNotIn', 'whereIn', 'orWhereRaw', 'select', 'from']) {
        c[m] = jest.fn(() => c);
      }
      if (table === 'customers as c') c.then = (res, rej) => Promise.resolve(rows).then(res, rej);
      return c;
    });
  }

  const member = (over = {}) => ({
    id: 'cust-1', first_name: 'Pat', last_name: 'Sample',
    email: 'pat@example.com', latitude: 27.3, longitude: -82.5,
    active: true, pipeline_stage: 'active_customer',
    email_pref_ok: true, tips_pref_ok: true, has_future_evidence: true,
    ...over,
  });

  test('a fully-reachable member produces no gap row', async () => {
    mockBookRows([member()]);
    expect(await findLawnEmailAudienceGaps()).toEqual([]);
  });

  test('missing email / coordinates / lead-stage are FIXABLE gaps', async () => {
    mockBookRows([
      member({ id: 'a', email: null }),
      member({ id: 'b', latitude: null }),
      member({ id: 'c', pipeline_stage: 'lead' }),
    ]);
    const gaps = await findLawnEmailAudienceGaps();
    expect(gaps.map((g) => [g.customerId, g.fixable[0]])).toEqual([
      ['a', 'no_email'],
      ['b', 'no_coordinates'],
      ['c', 'pipeline_stage=lead'],
    ]);
  });

  test("uses the sender's validators — unusable email and non-finite coordinates are gaps", async () => {
    // The send path selects these rows and then skips them (isEmailLike /
    // numberOrNull), so null-checks alone would report a clean audience
    // while the customer silently never hears (Codex #3209 r1).
    mockBookRows([
      member({ id: 'a', email: 'not-an-email' }),
      member({ id: 'b', latitude: 'garbage' }),
    ]);
    const gaps = await findLawnEmailAudienceGaps();
    expect(gaps.map((g) => [g.customerId, g.fixable[0]])).toEqual([
      ['a', 'unusable_email'],
      ['b', 'no_coordinates'],
    ]);
  });

  test('0,0 placeholder coordinates are a gap — the sender skips them as rain_unknown', async () => {
    // fetchServiceWeekWeather returns empty weather for 0,0 (failed
    // geocode), so the sender selects and silently skips the customer.
    mockBookRows([member({ latitude: 0, longitude: 0 })]);
    const gaps = await findLawnEmailAudienceGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].fixable).toEqual(['placeholder_coordinates']);
  });

  test('opted-out rows are suppressed ENTIRELY, even with other missing fields', async () => {
    mockBookRows([
      member({ tips_pref_ok: false }),
      member({ id: 'z', email_pref_ok: false, email: null, latitude: null }),
    ]);
    expect(await findLawnEmailAudienceGaps()).toEqual([]);
  });

  describe('findUnstampedRecurringLawnMembers (membership-evidence leg, owner ruling 2026-08-10)', () => {
    const { findUnstampedRecurringLawnMembers } = require('../services/irrigation-weekly-email');

    const unstamped = (over = {}) => ({
      id: 'cust-7', first_name: 'Stu', last_name: 'Sample',
      email: 'stu@example.com', latitude: 27.3, longitude: -82.5,
      // Authoritative membership state (hasMembership): paid monthly plan.
      waveguard_tier: null, monthly_rate: 45, waveguard_tier_source: null, billing_mode: 'monthly',
      email_pref_ok: true, tips_pref_ok: true,
      ...over,
    });

    test('an enrolled member with unstamped lawn visits maps to a stamp-the-series gap', async () => {
      // The QUERY excludes evidence-positive customers (whereNot on the shared
      // predicate) — rows resolving here are already the blind-spot class.
      mockBookRows([unstamped()]);
      expect(await findUnstampedRecurringLawnMembers()).toEqual([
        { customerId: 'cust-7', name: 'Stu Sample', kind: 'unstamped_member', fixable: ['no_recurring_marked_lawn_visit'], triggerVisitId: null },
      ]);
    });

    test("a pure BOUNCE suppression rides the card; any consent suppression never pages, even beside a bounce (codex r2+r3 P2)", async () => {
      // Evaluated with the sender's own gate (activeSuppressionsFor —
      // plural: several rows can be active at once, and an arbitrary first
      // match let a bounce mask a coexisting opt-out). A pure bounce is a
      // fixable deliverability failure; any consent row (do_not_email /
      // spam / unsubscribe) wins — same never-pageable rule as prefs
      // opt-outs.
      EmailTemplateLibrary.activeSuppressionsFor
        .mockResolvedValueOnce([{ suppression_type: 'bounce' }])
        .mockResolvedValueOnce([{ suppression_type: 'bounce' }, { suppression_type: 'do_not_email' }])
        .mockResolvedValueOnce([{ suppression_type: 'unsubscribe', group_key: 'service_operational' }]);
      mockBookRows([unstamped({ id: 'a' }), unstamped({ id: 'b' }), unstamped({ id: 'c' })]);
      const gaps = await findUnstampedRecurringLawnMembers();
      expect(gaps.map((g) => [g.customerId, ...g.fixable])).toEqual([
        ['a', 'no_recurring_marked_lawn_visit', 'bounced_email'],
      ]);
      expect(EmailTemplateLibrary.activeSuppressionsFor).toHaveBeenCalledWith(
        { suppression_group_key: 'service_operational' }, 'stu@example.com', 'service_operational',
      );
    });

    test('membership is judged by AUTHORITATIVE customer state, not email history (pre-push P1 chain)', async () => {
      // Email rows are delivery artifacts — a no-email member (exactly this
      // leg's target class) never accumulates them, cancellation leaves
      // started rows behind, reactivation emits a different key. The shared
      // hasMembership predicate on the row is current-state truth: cleared
      // tier + zero rate = cancelled = no page; auto-derived label-only
      // rows (tier from source 'auto', no paid rate) never count.
      mockBookRows([
        unstamped({ id: 'member' }),
        unstamped({ id: 'cancelled', waveguard_tier: null, monthly_rate: 0 }),
        unstamped({ id: 'label-only', waveguard_tier: 'Bronze', monthly_rate: 0, waveguard_tier_source: 'auto', billing_mode: 'per_visit' }),
        // Explicit one_time lane = no recurring relationship, whatever
        // tier/rate values linger (codex r5 P2, same lane gate
        // sendMembershipStarted suppresses on).
        unstamped({ id: 'one-time', waveguard_tier: 'Bronze', monthly_rate: 45, billing_mode: 'one_time' }),
      ]);
      const gaps = await findUnstampedRecurringLawnMembers();
      expect(gaps.map((g) => g.customerId)).toEqual(['member']);
    });

    test('the gap carries the triggering visit id so a later regression re-pages (codex r3 P2)', async () => {
      mockBookRows([unstamped({ trigger_visit_id: 'visit-42' })]);
      const gaps = await findUnstampedRecurringLawnMembers();
      expect(gaps[0].triggerVisitId).toBe('visit-42');
    });

    test("send prerequisites ride the SAME card — stamping alone can't deliver to a bad email/coords (codex r1 P2)", async () => {
      mockBookRows([
        unstamped({ id: 'a', email: null }),
        unstamped({ id: 'b', email: 'not-an-email', latitude: 'garbage' }),
        unstamped({ id: 'c', latitude: 0, longitude: 0 }),
      ]);
      const gaps = await findUnstampedRecurringLawnMembers();
      expect(gaps.map((g) => [g.customerId, ...g.fixable])).toEqual([
        ['a', 'no_recurring_marked_lawn_visit', 'no_email'],
        ['b', 'no_recurring_marked_lawn_visit', 'unusable_email', 'no_coordinates'],
        ['c', 'no_recurring_marked_lawn_visit', 'placeholder_coordinates'],
      ]);
    });

    test('opted-out members never page — same rule as the evidence legs', async () => {
      mockBookRows([
        unstamped({ tips_pref_ok: false }),
        unstamped({ id: 'z', email_pref_ok: false }),
      ]);
      expect(await findUnstampedRecurringLawnMembers()).toEqual([]);
    });
  });

  test('churned customers (trailing-only evidence, non-customer stage) are a legitimate drop', async () => {
    mockBookRows([
      member({ id: 'churned', pipeline_stage: 'churned', has_future_evidence: false, email: null }),
      // …but a non-customer stage WITH live future visits is a real
      // inconsistency and still pages.
      member({ id: 'odd', pipeline_stage: 'churned', has_future_evidence: true }),
    ]);
    const gaps = await findLawnEmailAudienceGaps();
    expect(gaps.map((g) => [g.customerId, g.fixable[0]])).toEqual([
      ['odd', 'pipeline_stage=churned'],
    ]);
  });
});

describe('hasLawnServiceEvidence (portal Weekly Inches gate)', () => {
  // A render/store gate, not a send: any live lawn-flavored visit in the
  // trailing window — future included, no recurring marker — so the
  // unstamped-first-visit member class can still enter inches.
  test('compiles to one live lawn-flavored visit since the trailing cutoff, no recurring marker', async () => {
    const { hasLawnServiceEvidence } = require('../services/irrigation-weekly-email');
    const realKnex = require('knex')({ client: 'pg' });
    const originalRaw = db.raw;
    let captured;
    try {
      db.mockImplementation((table) => {
        const b = realKnex(table);
        captured = b;
        b.then = (resolve, reject) => Promise.resolve(undefined).then(resolve, reject);
        return b;
      });
      db.raw = realKnex.raw.bind(realKnex);
      await expect(hasLawnServiceEvidence('cust-1', { now: new Date('2026-08-27T12:00:00Z') })).resolves.toBe(false);
      const { sql, bindings } = captured.toSQL();
      expect(sql).toMatch(/from "scheduled_services" as "ss"/);
      expect(sql).toContain('"ss"."customer_id" = ?');
      expect(bindings).toContain('cust-1');
      expect(sql).toContain('"ss"."status" not in');
      expect(sql).toContain('"ss"."scheduled_date" >= ?');
      expect(bindings).toContain('2026-02-28'); // 180 days back, ET
      expect(sql).toContain('LOWER(ss.service_type) LIKE ?');
      expect(sql).not.toMatch(/is_recurring|recurring_parent_id|recurring_pattern/);
      expect(sql).not.toContain('<= ?');
    } finally {
      db.raw = originalRaw;
      db.mockReset();
    }
  });

  test('no customer id → false without a query', async () => {
    const { hasLawnServiceEvidence } = require('../services/irrigation-weekly-email');
    db.mockReset();
    await expect(hasLawnServiceEvidence(null)).resolves.toBe(false);
    expect(db).not.toHaveBeenCalled();
  });
});
