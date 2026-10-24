// GATE_PEST_RAIN_OUTLOOK (owner 2026-10-24): the frozen 48-hour rain outlook, its
// completion-time capture, and the pest report's Weather call card.
// Synthetic data only.

const fs = require('fs');
const path = require('path');

jest.mock('../services/service-report/application-conditions', () => ({
  fetchPropertyForecast: jest.fn(),
  fetchApplicationConditions: jest.fn(),
}));

const { fetchPropertyForecast } = require('../services/service-report/application-conditions');
const {
  capturePestRainOutlook,
  buildRainOutlookSummary,
  buildRainOutlookCardCopy,
  FIPRONIL_LINE,
  PYRETHROID_LINE,
} = require('../services/service-report/pest-rain-outlook');
const {
  buildWeatherCallContext,
  buildPremiumExperienceContextFromRows,
} = require('../services/service-report/premium-experience');
const { validateCustomerCopy } = require('../services/service-report/customer-copy-forbidden');
const { shouldCaptureApplicationConditions } = require('../services/complete-scheduled-service');

const HOUR = 3600000;
// 2026-10-24 14:00 EDT, a Saturday.
const COMPLETED = '2026-10-24T18:00:00.000Z';
const at = (hoursAfter) => new Date(Date.parse(COMPLETED) + hoursAfter * HOUR).toISOString();

const CONDITIONS = { temp_f: 82, humidity_pct: 64, wind_mph: 8, rain_24h_in: 0.04, source: 'FAWN' };
const BASE_CARD = { headline: 'Good treatment window.', body: 'Low rainfall in the 24 hours before the visit and moderate wind supported exterior application.' };

const outlook = (overrides = {}) => ({
  v: 1,
  source: 'open_meteo',
  fetchedAt: COMPLETED,
  completedAt: COMPLETED,
  windowHours: 48,
  totalIn: 0.6,
  firstRainAt: at(20),
  complete: true,
  ...overrides,
});
const record = (rainOutlook, overrides = {}) => ({
  service_line: 'pest',
  conditions: JSON.stringify(CONDITIONS),
  structured_notes: rainOutlook === undefined ? {} : { rainOutlook },
  ...overrides,
});
const app = (activeIngredient, method = 'perimeter_spray', productName = 'Test product') => ({
  id: `${productName}-${activeIngredient}`, method, activeIngredient, productName,
});
const FIPRONIL = app('Fipronil', 'perimeter_spray', 'Test fipronil');
const BIFENTHRIN = app('Bifenthrin', 'perimeter_spray', 'Test bifenthrin');
const DINOTEFURAN = app('Dinotefuran', 'perimeter_spray', 'Test dinotefuran');

let savedGate;
beforeEach(() => {
  savedGate = process.env.GATE_PEST_RAIN_OUTLOOK;
  process.env.GATE_PEST_RAIN_OUTLOOK = 'true';
  fetchPropertyForecast.mockReset();
});
afterEach(() => {
  if (savedGate === undefined) delete process.env.GATE_PEST_RAIN_OUTLOOK;
  else process.env.GATE_PEST_RAIN_OUTLOOK = savedGate;
});

const card = (rec, applications) => buildWeatherCallContext({ record: rec, applications });
const unchanged = (rec, applications) => {
  const c = card(rec, applications);
  expect(c).toMatchObject(BASE_CARD);
  expect(c.factsLine).toBe('82°F · 64% humidity · 8 mph wind · 0.04 in rain');
};

describe('Weather call card with the frozen rain outlook', () => {
  test('dry window: "Dry days ahead", no application needed', () => {
    const c = card(record(outlook({ totalIn: 0.04, firstRainAt: null })), []);
    expect(c).toMatchObject({
      headline: 'Dry days ahead',
      body: 'When we finished, the forecast showed dry weather for the next two days.',
      factsLine: '82°F · 64% humidity · 8 mph wind · 0.04 in rain',
      sourceLabel: 'FAWN',
      sourceKeys: ['condition'],
    });
    expect(card(record(outlook({ totalIn: 0, firstRainAt: null })), [FIPRONIL]).headline).toBe('Dry days ahead');
  });

  test('rain with a fipronil outside spray: soil-binding line', () => {
    const c = card(record(outlook({ firstRainAt: at(20) })), [FIPRONIL]);
    expect(c.headline).toBe('Rain in the forecast');
    // 2026-10-25 10:00 EDT (a Sunday), the next ET day.
    expect(c.body).toBe(`When we finished, the forecast showed rain on Sunday morning. ${FIPRONIL_LINE}`);
    expect(FIPRONIL_LINE).toBe('Once dry, the spray around the outside of the house binds to the soil, so a storm moves only a small part of it.');
    expect(c.sourceKeys).toEqual(['condition']);
  });

  test('rain with pyrethroid-only outside sprays: tighter binding line', () => {
    const c = card(record(outlook({ firstRainAt: at(20) })), [BIFENTHRIN, app('Lambda-cyhalothrin'), app('Beta-cyfluthrin')]);
    expect(c.body).toBe(`When we finished, the forecast showed rain on Sunday morning. ${PYRETHROID_LINE}`);
    expect(PYRETHROID_LINE).toBe('Once dry, the spray around the outside of the house binds tightly to soil, mulch and plants, so a storm moves only a small part of it.');
  });

  test.each([
    'Bifenthrin', 'Cypermethrin', 'Alpha-cypermethrin', 'Lambda-cyhalothrin', 'lambda cyhalothrin', 'Deltamethrin',
    'Cyfluthrin', 'Beta-cyfluthrin', 'Permethrin', 'Esfenvalerate', 'BIFENTHRIN 7.9%',
  ])('%s counts as a pyrethroid', (ai) => {
    expect(card(record(outlook()), [app(ai)]).body).toContain(PYRETHROID_LINE);
  });

  test('fipronil with a pyrethroid: the fipronil line', () => {
    expect(card(record(outlook()), [BIFENTHRIN, FIPRONIL]).body).toContain(FIPRONIL_LINE);
  });

  test('a surfactant row is ignored', () => {
    const surfactant = app('', 'perimeter_spray', 'Nonionic surfactant');
    expect(card(record(outlook()), [BIFENTHRIN, surfactant]).body).toContain(PYRETHROID_LINE);
    // ...but an unnamed or unknown active is not ignored.
    unchanged(record(outlook()), [BIFENTHRIN, app('', 'perimeter_spray', 'Test product')]);
  });

  test('rain inside the 4-hour drying time: today\'s card', () => {
    unchanged(record(outlook({ firstRainAt: at(3.5) })), [FIPRONIL]);
    unchanged(record(outlook({ firstRainAt: at(0) })), [FIPRONIL]);
    // Exactly 4 hours is enough.
    expect(card(record(outlook({ firstRainAt: at(4) })), [FIPRONIL]).headline).toBe('Rain in the forecast');
  });

  test('any soluble outside spray: today\'s card', () => {
    unchanged(record(outlook()), [DINOTEFURAN]);
    unchanged(record(outlook()), [FIPRONIL, DINOTEFURAN]);
    unchanged(record(outlook()), [BIFENTHRIN, app('Imidacloprid')]);
    unchanged(record(outlook()), [app('Thiamethoxam')]);
    unchanged(record(outlook()), [app('Clothianidin')]);
    unchanged(record(outlook()), [app('Acetamiprid')]);
    unchanged(record(outlook()), [app('Bifenthrin + Imidacloprid')]);
  });

  test('an unknown or missing active, or no outside spray: today\'s card', () => {
    unchanged(record(outlook()), [app('Indoxacarb')]);
    unchanged(record(outlook()), [BIFENTHRIN, app(null)]);
    unchanged(record(outlook()), [BIFENTHRIN, app(undefined)]);
    unchanged(record(outlook()), []);
    unchanged(record(outlook()), undefined);
    // Only the outside spray counts: interior and bait rows do not support the line or block it.
    unchanged(record(outlook()), [app('Bifenthrin', 'spot_treatment')]);
    expect(card(record(outlook()), [BIFENTHRIN, app('Dinotefuran', 'bait_placement')]).body).toContain(PYRETHROID_LINE);
  });

  test('light rain (0.05 to under 0.25 in): today\'s card', () => {
    unchanged(record(outlook({ totalIn: 0.05, firstRainAt: at(20) })), [FIPRONIL]);
    unchanged(record(outlook({ totalIn: 0.24, firstRainAt: at(20) })), [FIPRONIL]);
    expect(card(record(outlook({ totalIn: 0.25, firstRainAt: at(20) })), [FIPRONIL]).headline).toBe('Rain in the forecast');
  });

  test('wet total with no first rain hour on record: today\'s card', () => {
    unchanged(record(outlook({ totalIn: 0.6, firstRainAt: null })), [FIPRONIL]);
    unchanged(record(outlook({ totalIn: 0.6, firstRainAt: 'not a date' })), [FIPRONIL]);
  });

  test('incomplete, malformed or missing outlook: today\'s card', () => {
    unchanged(record(outlook({ complete: false, totalIn: null, firstRainAt: null })), [FIPRONIL]);
    unchanged(record(outlook({ complete: false, totalIn: 0 })), []);
    unchanged(record(outlook({ totalIn: null })), [FIPRONIL]);
    unchanged(record(outlook({ v: 2 })), [FIPRONIL]);
    unchanged(record(undefined), [FIPRONIL]);
    unchanged(record(null), [FIPRONIL]);
    unchanged(record('garbage'), [FIPRONIL]);
    unchanged(record(outlook(), { structured_notes: null }), [FIPRONIL]);
  });

  test('a record whose structured_notes arrives as a JSON string reads the same', () => {
    const rec = record(undefined, { structured_notes: JSON.stringify({ rainOutlook: outlook({ totalIn: 0, firstRainAt: null }) }) });
    expect(card(rec, []).headline).toBe('Dry days ahead');
  });

  test('gate off (unset, "1", "on", "false", "TRUE"): today\'s card, same keys and values', () => {
    const recs = [record(outlook({ totalIn: 0, firstRainAt: null })), record(outlook())];
    for (const value of [undefined, '1', 'on', 'false', 'TRUE']) {
      if (value === undefined) delete process.env.GATE_PEST_RAIN_OUTLOOK;
      else process.env.GATE_PEST_RAIN_OUTLOOK = value;
      recs.forEach((rec) => {
        const c = card(rec, [FIPRONIL]);
        expect(c).toMatchObject(BASE_CARD);
        expect(Object.keys(c)).toEqual(['headline', 'body', 'factsLine', 'sourceLabel', 'sourceKeys']);
      });
    }
  });

  test('a record with no outlook key renders the same with the gate on and off', () => {
    const rec = record(undefined);
    const on = JSON.stringify(card(rec, [FIPRONIL]));
    delete process.env.GATE_PEST_RAIN_OUTLOOK;
    expect(JSON.stringify(card(rec, [FIPRONIL]))).toBe(on);
  });

  test('non-pest lines: today\'s card', () => {
    for (const line of ['lawn', 'tree_shrub', 'mosquito', 'termite']) {
      unchanged(record(outlook({ totalIn: 0, firstRainAt: null }), { service_line: line }), [FIPRONIL]);
      unchanged(record(outlook(), { service_line: line }), [FIPRONIL]);
    }
    // A legacy row with no service_line is typed by its service type.
    unchanged(record(outlook({ totalIn: 0, firstRainAt: null }), { service_line: null, service_type: 'Lawn Care Visit' }), []);
  });

  test('no conditions on the record: no card at all, as today', () => {
    expect(card(record(outlook(), { conditions: null }), [FIPRONIL])).toBeUndefined();
  });

  test('card copy never over-claims, counts days, or invites contact', () => {
    const copies = [
      card(record(outlook({ totalIn: 0, firstRainAt: null })), []),
      card(record(outlook()), [FIPRONIL]),
      card(record(outlook()), [BIFENTHRIN]),
    ].map((c) => `${c.headline} ${c.body}`);
    for (const text of copies) {
      expect(validateCustomerCopy(text)).toBe(true);
      expect(text).not.toMatch(/rainproof|waterproof|rainfast|won.?t wash|wash(?:es)? off|guarantee|protected|\d+\s*days?\b|\bcall\b|\btext\b|\breport\b|contact|let us know|tell us|changed|adjusted|because/i);
    }
  });

  test('buildPremiumExperienceContextFromRows passes the active ingredients through', () => {
    const ctx = buildPremiumExperienceContextFromRows({
      record: record(outlook()),
      applications: [{ id: 'a1', product_name: 'Test fipronil', application_method: 'perimeter_spray', active_ingredient: 'Fipronil' }],
    });
    expect(ctx.weatherCall.body).toContain(FIPRONIL_LINE);
    const soluble = buildPremiumExperienceContextFromRows({
      record: record(outlook()),
      applications: [{ id: 'a2', productName: 'Test dinotefuran', method: 'perimeter_spray', activeIngredient: 'Dinotefuran' }],
    });
    expect(soluble.weatherCall).toMatchObject(BASE_CARD);
  });
});

describe('the "when" phrase, in Eastern time', () => {
  const when = (completedAt, firstRainAt) => card(
    record(outlook({ completedAt, firstRainAt })),
    [FIPRONIL],
  ).body.match(/showed rain (.*?)\. Once/)[1];

  test('same ET day: "that <part>"', () => {
    // Completed 10:00 EST (winter), 2027-01-12.
    expect(when('2027-01-12T15:00:00.000Z', '2027-01-12T22:30:00.000Z')).toBe('that evening'); // 17:30 EST
    expect(when('2027-01-12T15:00:00.000Z', '2027-01-12T19:00:00.000Z')).toBe('that afternoon'); // 14:00 EST
    // Completed 14:00 EDT: rain 19:00 EDT.
    expect(when(COMPLETED, at(5))).toBe('that evening');
  });

  test('a later ET day: "on <Weekday> <part>"', () => {
    expect(when('2027-01-12T15:00:00.000Z', '2027-01-13T17:00:00.000Z')).toBe('on Wednesday afternoon'); // 12:00 EST
    expect(when(COMPLETED, '2026-10-26T12:30:00.000Z')).toBe('on Monday morning'); // 08:30 EDT
  });

  test('across ET midnight, not UTC midnight', () => {
    // Completed Sat 22:00 EDT (02:00Z Sunday); rain Sun 03:00 EDT (07:00Z) is the next ET day.
    expect(when('2026-10-25T02:00:00.000Z', '2026-10-25T07:00:00.000Z')).toBe('on Sunday night');
    // Completed Sat 12:00 EDT (16:00Z); rain Sat 21:30 EDT is 01:30Z Sunday, still Saturday in ET.
    expect(when('2026-10-24T16:00:00.000Z', '2026-10-25T01:30:00.000Z')).toBe('that night');
    // Completed 00:30 EDT Saturday (04:30Z); rain 05:00 EDT the same ET day.
    expect(when('2026-10-24T04:30:00.000Z', '2026-10-24T09:00:00.000Z')).toBe('that morning');
  });

  test('part-of-day boundaries (morning 5:00-11:59, afternoon 12:00-16:59, evening 17:00-20:59, else night)', () => {
    // Completed Fri 2026-10-23 10:00 EDT; all rains fall on Saturday 10-24 (EDT = UTC-4).
    const done = '2026-10-23T14:00:00.000Z';
    expect(when(done, '2026-10-24T08:59:00.000Z')).toBe('on Saturday night'); // 04:59
    expect(when(done, '2026-10-24T09:00:00.000Z')).toBe('on Saturday morning'); // 05:00
    expect(when(done, '2026-10-24T15:59:00.000Z')).toBe('on Saturday morning'); // 11:59
    expect(when(done, '2026-10-24T16:00:00.000Z')).toBe('on Saturday afternoon'); // 12:00
    expect(when(done, '2026-10-24T20:59:00.000Z')).toBe('on Saturday afternoon'); // 16:59
    expect(when(done, '2026-10-24T21:00:00.000Z')).toBe('on Saturday evening'); // 17:00
    expect(when(done, '2026-10-25T00:59:00.000Z')).toBe('on Saturday evening'); // 20:59
    expect(when(done, '2026-10-25T01:00:00.000Z')).toBe('on Saturday night'); // 21:00
  });
});

describe('buildRainOutlookCardCopy', () => {
  test('is null for the gate off and for a non-pest line, whatever the outlook', () => {
    expect(buildRainOutlookCardCopy({ outlook: outlook(), serviceLine: 'pest', applications: [FIPRONIL] })).not.toBeNull();
    expect(buildRainOutlookCardCopy({ outlook: outlook(), serviceLine: 'lawn', applications: [FIPRONIL] })).toBeNull();
    process.env.GATE_PEST_RAIN_OUTLOOK = 'false';
    expect(buildRainOutlookCardCopy({ outlook: outlook(), serviceLine: 'pest', applications: [FIPRONIL] })).toBeNull();
    expect(buildRainOutlookCardCopy()).toBeNull();
  });
});

describe('buildRainOutlookSummary', () => {
  const row = (stampHoursAfter, inches) => ({ at: at(stampHoursAfter), precipitation_in: inches });
  const done = new Date(COMPLETED);

  test('summarizes a complete forecast: total to 2 decimals, first rain hour starts an hour before its stamp', () => {
    const summary = buildRainOutlookSummary({
      status: 'ok',
      fetchedAt: '2026-10-24T17:59:00.000Z',
      precipitationInTotal: 0.3149,
      hourly: [row(1, 0), row(2, 0.04), row(3, 0.05), row(4, 0.2)],
    }, done);
    expect(summary).toEqual({
      v: 1,
      source: 'open_meteo',
      fetchedAt: '2026-10-24T17:59:00.000Z',
      completedAt: COMPLETED,
      windowHours: 48,
      totalIn: 0.31,
      firstRainAt: at(2),
      complete: true,
    });
  });

  test('the hour that ends after completion but began before it is not counted', () => {
    // Completed 14:30 EDT: the row stamped 15:00 is the 14:00-15:00 hour, partly before completion.
    const half = new Date(Date.parse(COMPLETED) + 30 * 60000);
    const summary = buildRainOutlookSummary({
      status: 'ok',
      precipitationInTotal: 0.5,
      hourly: [row(1, 0.4), row(2, 0.1)],
    }, half);
    expect(summary.firstRainAt).toBe(at(1));
  });

  test('a missing hour (null total) is complete false with no total', () => {
    const summary = buildRainOutlookSummary({ status: 'ok', precipitationInTotal: null, hourly: [row(2, 0.4)] }, done);
    expect(summary).toMatchObject({ complete: false, totalIn: null });
  });

  test('dry forecast: first rain null', () => {
    const summary = buildRainOutlookSummary({ status: 'ok', precipitationInTotal: 0.02, hourly: [row(2, 0.01), row(3, 0.01)] }, done);
    expect(summary).toMatchObject({ complete: true, totalIn: 0.02, firstRainAt: null });
  });

  test('unavailable or missing forecast: nothing', () => {
    expect(buildRainOutlookSummary({ status: 'unavailable', reason: 'timeout' }, done)).toBeNull();
    expect(buildRainOutlookSummary(null, done)).toBeNull();
    expect(buildRainOutlookSummary(undefined, done)).toBeNull();
  });
});

describe('capturePestRainOutlook', () => {
  const svc = { service_type: 'Quarterly Pest Control', customer_latitude: 27.1, customer_longitude: -82.4 };
  const now = new Date(COMPLETED);
  const okForecast = {
    status: 'ok', fetchedAt: COMPLETED, precipitationInTotal: 0.4, hourly: [{ at: at(6), precipitation_in: 0.4 }],
  };

  test('gate off: no forecast call, nothing stored', async () => {
    delete process.env.GATE_PEST_RAIN_OUTLOOK;
    expect(await capturePestRainOutlook({ svc, now })).toBeNull();
    process.env.GATE_PEST_RAIN_OUTLOOK = '1';
    expect(await capturePestRainOutlook({ svc, now })).toBeNull();
    expect(fetchPropertyForecast).not.toHaveBeenCalled();
  });

  test('gate on, pest line: one forecast call over the next 48 hours with a 2.5 s deadline', async () => {
    fetchPropertyForecast.mockResolvedValue(okForecast);
    const summary = await capturePestRainOutlook({ svc, now });
    expect(fetchPropertyForecast).toHaveBeenCalledTimes(1);
    const args = fetchPropertyForecast.mock.calls[0][0];
    expect(args).toMatchObject({ latitude: 27.1, longitude: -82.4, timeoutMs: 2500 });
    expect(new Date(args.from).toISOString()).toBe(COMPLETED);
    expect(new Date(args.to).toISOString()).toBe(at(48));
    expect(summary).toMatchObject({ v: 1, completedAt: COMPLETED, totalIn: 0.4, firstRainAt: at(5), complete: true });
  });

  test('non-pest lines make no forecast call', async () => {
    for (const service_type of ['Lawn Care Visit', 'Tree & Shrub Care', 'Mosquito Control']) {
      expect(await capturePestRainOutlook({ svc: { ...svc, service_type }, now })).toBeNull();
    }
    expect(fetchPropertyForecast).not.toHaveBeenCalled();
  });

  test('unavailable forecast, a rejection or a throw: nothing stored', async () => {
    fetchPropertyForecast.mockResolvedValueOnce({ status: 'unavailable', reason: 'timeout', source: 'open_meteo' });
    expect(await capturePestRainOutlook({ svc, now })).toBeNull();
    fetchPropertyForecast.mockRejectedValueOnce(new Error('boom'));
    expect(await capturePestRainOutlook({ svc, now })).toBeNull();
    fetchPropertyForecast.mockImplementationOnce(() => { throw new Error('sync boom'); });
    expect(await capturePestRainOutlook({ svc, now })).toBeNull();
  });
});

describe('completion wiring (complete-scheduled-service.js)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');

  test('backfill and no-capture visits get no forecast: the predicate still gates both fetches', () => {
    expect(shouldCaptureApplicationConditions({
      hasConditionsColumn: true, useServiceReportV1: true, isIncompleteVisit: false, productCount: 1, isBackfillCompletion: true,
    })).toBe(false);
    // Both calls sit in the true branch of the one predicate.
    expect(source).toMatch(/conditionsAtApplication = shouldCaptureApplicationConditions\(\{[\s\S]{0,700}isBackfillCompletion,\s*\n\s*\}\)\s*\n(?:\s*\/\/[^\n]*\n)*\s*\? await Promise\.all\(\[\s*\n\s*fetchApplicationConditions\(\{[\s\S]{0,200}\.catch\(\(\) => null\),\s*\n\s*capturePestRainOutlook\(\{ svc \}\),\s*\n\s*\]\)/);
    expect(source.match(/capturePestRainOutlook\(/g) || []).toHaveLength(1);
    expect(source.match(/fetchPropertyForecast/g) || []).toHaveLength(0);
  });

  test('the outlook is stored under structured_notes.rainOutlook only when captured, never in conditions', () => {
    expect(source).toMatch(/\.\.\.\(rainOutlookAtCompletion \? \{ rainOutlook: rainOutlookAtCompletion \} : \{\}\),/);
    expect(source).toMatch(/if \(serviceRecordCols\.conditions && conditionsAtApplication\) recordInsert\.conditions = serializeJsonb\(conditionsAtApplication\);/);
    expect(source.match(/rainOutlookAtCompletion/g) || []).toHaveLength(4);
    expect(source).not.toMatch(/conditionsAtApplication\s*=\s*\{[^}]*rainOutlook/);
  });
});
