/**
 * Booking rain rank (owner 2026-10-06, GATE_BOOKING_RAIN_RANK, dark).
 *
 *  1. rainFitFor: a booking is rain-OK only when every service is
 *     (assessment, estimate, inspection, WDO, rodent, trapping, interior).
 *  2. isWetWindow: 60%+ in any hour from the start through 2 h after the end,
 *     next 3 dates only; no reading = unknown, not dry.
 *  3. The New Appointment rows rank by rain fit before drive with the gate
 *     on; off, the order is drive-only and the forecast is read once.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { rainFitFor, isWetWindow, rainTier, rainClassOf, withCatalogKeys } = require('../services/scheduling/rain-fit');
const { _test: traceRules } = require('../services/service-report/trace-eligibility');
const { buildBestRows } = require('../services/scheduling/find-time-hints');

const TODAY = '2026-10-07';
const hourly = [];
for (let h = 6; h <= 20; h += 1) {
  const hh = String(h).padStart(2, '0');
  // 7 Oct: storm 14:00-16:00. 8 Oct: dry. 10 Oct: storm all day (past the 3-day horizon).
  hourly.push({ startTime: `2026-10-07T${hh}:00:00-04:00`, rainChance: h >= 14 && h <= 16 ? 80 : 10 });
  hourly.push({ startTime: `2026-10-08T${hh}:00:00-04:00`, rainChance: 10 });
  hourly.push({ startTime: `2026-10-10T${hh}:00:00-04:00`, rainChance: 90 });
}

describe('rainFitFor', () => {
  test.each([
    [['General Pest Control'], 'avoid'],
    [['Lawn Care'], 'avoid'],
    [['Tree & Shrub'], 'avoid'],
    [['Mosquito'], 'avoid'],
    [['Termite Liquid Treatment'], 'avoid'],
    [['WaveGuard Assessment'], 'prefer'],
    [['Free Estimate'], 'prefer'],
    [['WDO Inspection'], 'prefer'],
    [['Rodent Trapping Check'], 'prefer'],
    [['Rodent Monitoring'], 'prefer'],
    [['Rodent Trapping + Exclusion'], 'avoid'],
    [['Rodent Wire Mesh Exclusion'], 'avoid'],
    [['Rodent Trapping'], 'avoid'],
    [['Interior + Exterior Pest'], 'avoid'],
    [['Accepted estimate'], 'avoid'],
    [['Termite Liquid Treatment & Inspection'], 'avoid'],
    [['Termite Inspection & Spot Treatment'], 'avoid'],
    [['Rodent Bait Station Check'], 'prefer'],
    [['Bed Bug Treatment'], 'prefer'],
    [['German Cockroach Treatment'], 'prefer'],
    [['German Cockroach Exterior Treatment'], 'avoid'],
    [['Cockroach Treatment'], 'avoid'],
    [['Interior Pest Only'], 'prefer'],
    [['WDO Inspection', 'General Pest Control'], 'avoid'],
    [[], 'neutral'],
    [[''], 'neutral'],
  ])('%j → %s', (types, fit) => {
    expect(rainFitFor(types)).toBe(fit);
  });
});

describe('catalog identity beats the words in a name', () => {
  const svc = (serviceKey, findingsType = null, name = 'Any label') => ({ name, serviceKey, findingsType });

  test.each([
    // [catalog key, findings type, class]
    ['pest_general_quarterly', null, 'outdoor'],
    ['lawn_care_monthly', null, 'outdoor'],
    ['mosquito_monthly', null, 'outdoor'],
    ['termite_liquid', null, 'outdoor'],
    ['bee_wasp_removal', null, 'outdoor'],
    ['dethatching', null, 'outdoor'],
    ['palm_treatment', null, 'outdoor'],
    ['termite_installation_setup', null, 'outdoor'],
    ['some_new_admin_key', null, 'outdoor'],
    [null, 'rodent_exclusion', 'outdoor'],
    [null, 'termite_bait_station', 'outdoor'],
    [null, 'cockroach', 'outdoor'],
    ['wdo_inspection', null, 'ok'],
    ['lawn_inspection', null, 'ok'],
    ['bed_bug_treatment', null, 'ok'],
    ['german_roach', null, 'ok'],
    [null, 'termite_inspection', 'ok'],
    [null, 'pest_inspection', 'ok'],
    [null, 'rodent_inspection', 'ok'],
    [null, 'rodent_trapping', 'ok'],
    [null, 'rodent_sanitation', 'ok'],
    ['rodent_bait_quarterly', 'rodent_bait_station', 'ok'],
    // The one-time station install shares the check's findings type: outdoor.
    ['rodent_bait_setup', 'rodent_bait_station', 'outdoor'],
    [null, 'rodent_bait_station', 'outdoor'],
    [null, 'bed_bug', 'ok'],
    [null, 'german_roach_knockdown', 'ok'],
    ['general_appointment', null, 'skip'],
    // Same registry lane, but an onboarding visit with initial treatments.
    ['waveguard_initial_setup', null, 'outdoor'],
    ['waveguard_membership', null, 'skip'],
  ])('key %s / type %s → %s', (key, type, cls) => {
    expect(rainClassOf(svc(key, type))).toBe(cls);
  });

  test('the identity decides even when the label says otherwise', () => {
    expect(rainClassOf(svc('pest_general_quarterly', null, 'Interior Inspection'))).toBe('outdoor');
    expect(rainClassOf(svc('wdo_inspection', null, 'Exterior Spray Treatment'))).toBe('ok');
  });

  test('a booking: riders are left out; one outdoor service makes it outdoor', () => {
    expect(rainFitFor([svc('wdo_inspection'), svc('waveguard_membership')])).toBe('prefer');
    expect(rainFitFor([svc('wdo_inspection'), svc('pest_general_quarterly')])).toBe('avoid');
    expect(rainFitFor([svc('general_appointment')])).toBe('neutral');
    // No identity: the word rules still answer.
    expect(rainFitFor([{ name: 'Waves Assessment', serviceKey: null, findingsType: null }])).toBe('prefer');
  });

  // The complete rain-OK list. A new registry identity lands as outdoor (or
  // skipped) until someone adds it here on purpose.
  test('exactly these registry identities are rain-OK', () => {
    const ok = (rules, field) => Object.keys(rules)
      .filter((id) => rainClassOf({ name: 'x', [field]: id }) === 'ok').sort();
    expect({
      serviceKeys: ok(traceRules.SERVICE_KEY_RULES, 'serviceKey'),
      findingsTypes: ok(traceRules.FINDINGS_TYPE_RULES, 'findingsType'),
    }).toMatchSnapshot();
  });
});

describe('withCatalogKeys', () => {
  afterEach(() => { delete process.env.GATE_BOOKING_RAIN_RANK; jest.dontMock('../services/service-completion-profiles'); jest.resetModules(); });

  function load(resolver) {
    jest.resetModules();
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/service-completion-profiles', () => ({ resolveCompletionProfileForScheduledService: resolver }));
    return require('../services/scheduling/rain-fit').withCatalogKeys;
  }

  test('gate off: names pass through, nothing is read', async () => {
    const resolver = jest.fn();
    expect(await load(resolver)(['Bed Bug Treatment'], {})).toEqual(['Bed Bug Treatment']);
    expect(resolver).not.toHaveBeenCalled();
  });

  test('gate on: each name gets the identity its visit would have', async () => {
    process.env.GATE_BOOKING_RAIN_RANK = 'true';
    const resolver = jest.fn(async ({ service_type: name }) => (name === 'Rodent Trapping Service'
      ? { serviceKey: 'rodent_trapping_svc', findingsType: 'rodent_trapping' }
      : { serviceKey: null, findingsType: null, synthesized: true }));
    const db = {};
    expect(await load(resolver)(['Rodent Trapping Service', 'Waves Assessment'], db)).toEqual([
      { name: 'Rodent Trapping Service', serviceKey: 'rodent_trapping_svc', findingsType: 'rodent_trapping' },
      { name: 'Waves Assessment', serviceKey: null, findingsType: null },
    ]);
    expect(resolver).toHaveBeenCalledWith({ service_type: 'Rodent Trapping Service', service_key_snapshot: undefined }, db);
  });

  test('gate on: a key the screen sent settles the identity ahead of the name', async () => {
    process.env.GATE_BOOKING_RAIN_RANK = 'true';
    const resolver = jest.fn(async ({ service_key_snapshot: key }) => ({ serviceKey: key || null, findingsType: null }));
    const out = await load(resolver)([{ name: 'Shared Label', serviceKey: 'wdo_inspection' }], {});
    expect(resolver).toHaveBeenCalledWith({ service_type: 'Shared Label', service_key_snapshot: 'wdo_inspection' }, {});
    expect(out).toEqual([{ name: 'Shared Label', serviceKey: 'wdo_inspection', findingsType: null }]);
  });

  test('bookingServices: only a best-rows request reads; keys ride with names; duplicates dropped', async () => {
    process.env.GATE_BOOKING_RAIN_RANK = 'true';
    const resolver = jest.fn(async ({ service_key_snapshot: key }) => ({ serviceKey: key || null, findingsType: null }));
    load(resolver);
    const { bookingServices } = require('../services/scheduling/rain-fit');
    expect(await bookingServices({ bestRows: false, serviceType: 'Lawn Care' }, {})).toEqual([]);
    expect(resolver).not.toHaveBeenCalled();
    const out = await bookingServices({
      bestRows: true,
      serviceType: 'Lawn Care',
      serviceTypes: ['Lawn Care', ' ', 7, 'WDO Inspection', 'Lawn Care'],
      serviceKeys: ['lawn_care_monthly', '', '', 'wdo_inspection', 'lawn_care_monthly'],
    }, {});
    expect(out).toEqual([
      { name: 'Lawn Care', serviceKey: 'lawn_care_monthly', findingsType: null },
      { name: 'WDO Inspection', serviceKey: 'wdo_inspection', findingsType: null },
    ]);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  test('bookingServices: a malformed key or a keys list of the wrong length is ignored', async () => {
    process.env.GATE_BOOKING_RAIN_RANK = 'true';
    const resolver = jest.fn(async ({ service_key_snapshot: key }) => ({ serviceKey: key || null, findingsType: null }));
    load(resolver);
    const { bookingServices } = require('../services/scheduling/rain-fit');
    await bookingServices({ bestRows: true, serviceTypes: ['A'], serviceKeys: ["x'; drop"] }, {});
    await bookingServices({ bestRows: true, serviceTypes: ['B', 'C'], serviceKeys: ['only_one'] }, {});
    for (const call of resolver.mock.calls) expect(call[0].service_key_snapshot).toBeUndefined();
  });

  test('bookingServices: a huge list is capped at a booking-sized number of lookups', async () => {
    process.env.GATE_BOOKING_RAIN_RANK = 'true';
    const resolver = jest.fn(async () => ({ serviceKey: null, findingsType: null }));
    load(resolver);
    const { bookingServices } = require('../services/scheduling/rain-fit');
    const out = await bookingServices({ bestRows: true, serviceTypes: Array.from({ length: 5000 }, (_, i) => `Service ${i}`) }, {});
    expect(out).toHaveLength(12);
    expect(resolver).toHaveBeenCalledTimes(12);
  });

  test('gate on, lookup fails: that name stays bare (word rules)', async () => {
    process.env.GATE_BOOKING_RAIN_RANK = 'true';
    const resolver = jest.fn(async () => { throw new Error('db down'); });
    expect(await load(resolver)(['Lawn Care'], {})).toEqual(['Lawn Care']);
  });
});

describe('isWetWindow', () => {
  const chip = (date, start, end) => ({ date, start_time: start, end_time: end });
  test('rain in the visit window is wet', () => {
    expect(isWetWindow(hourly, chip('2026-10-07', '14:00', '15:00'), TODAY)).toBe(true);
  });
  test('rain within 2 h after the visit is wet (drying time)', () => {
    expect(isWetWindow(hourly, chip('2026-10-07', '12:00', '13:00'), TODAY)).toBe(true);
  });
  test('rain 3 h after the visit is dry', () => {
    expect(isWetWindow(hourly, chip('2026-10-07', '09:00', '10:00'), TODAY)).toBe(false);
  });
  test('a date past the 3-day horizon is unknown', () => {
    expect(isWetWindow(hourly, chip('2026-10-10', '09:00', '10:00'), TODAY)).toBeNull();
  });
  test('no reading for the window is unknown', () => {
    expect(isWetWindow(hourly, chip('2026-10-09', '09:00', '10:00'), TODAY)).toBeNull();
    expect(isWetWindow(null, chip('2026-10-07', '09:00', '10:00'), TODAY)).toBeNull();
  });
  test('one dry reading does not cover a window with a missing hour', () => {
    const gappy = [
      { startTime: '2026-10-08T09:00:00-04:00', rainChance: 10 },
      { startTime: '2026-10-08T10:00:00-04:00', rainChance: null },
      { startTime: '2026-10-08T11:00:00-04:00', rainChance: 10 },
    ];
    expect(isWetWindow(gappy, chip('2026-10-08', '09:00', '10:00'), TODAY)).toBeNull();
    // A wet reading is known even when another hour is missing.
    gappy[2].rainChance = 70;
    expect(isWetWindow(gappy, chip('2026-10-08', '09:00', '10:00'), TODAY)).toBe(true);
  });
  test('tiers', () => {
    expect([rainTier('avoid', false), rainTier('avoid', null), rainTier('avoid', true)]).toEqual([0, 1, 2]);
    expect([rainTier('prefer', true), rainTier('prefer', null), rainTier('prefer', false)]).toEqual([0, 1, 2]);
    expect(rainTier('neutral', true)).toBe(0);
  });
});

describe('best rows rank by rain fit (GATE_BOOKING_RAIN_RANK)', () => {
  const h = (date, start, detour) => ({
    date, start_time: start, end_time: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`,
    detour_minutes: detour, drive_in_minutes: detour, technician: { id: 't1', name: 'Tech One' },
  });
  // The wet 14:00 hour has the least drive; the dry ones cost more.
  const days = [{ date: TODAY, status: 'open', hours: [h(TODAY, '14:00', 5), h(TODAY, '08:00', 20), h(TODAY, '09:00', 25)] }];
  const run = (serviceTypes, hourlyRain = jest.fn(async () => hourly)) => buildBestRows(days, {
    pickedDate: TODAY, today: TODAY, lat: 1, lng: 2, serviceTypes,
    deps: { priceChipsOnRoads: async (chips) => chips, hourlyRain },
  });
  afterEach(() => { delete process.env.GATE_BOOKING_RAIN_RANK; });

  test('gate off: drive-only order, forecast read once', async () => {
    const hourlyRain = jest.fn(async () => hourly);
    const out = await run(['General Pest Control'], hourlyRain);
    expect(out.rows.day.map((c) => c.start_time)).toEqual(['14:00', '08:00', '09:00']);
    expect(hourlyRain).toHaveBeenCalledTimes(1);
  });

  test('gate on, outdoor booking: the wet hour sorts last', async () => {
    process.env.GATE_BOOKING_RAIN_RANK = 'true';
    const hourlyRain = jest.fn(async () => hourly);
    const out = await run(['General Pest Control'], hourlyRain);
    expect(out.rows.day.map((c) => c.start_time)).toEqual(['08:00', '09:00', '14:00']);
    expect(out.rows.day[2].rain_chance).toBe(80);
    // One forecast read serves both the ranking and the rain labels.
    expect(hourlyRain).toHaveBeenCalledTimes(1);
  });

  test('gate on, rain-OK booking: the wet hour sorts first', async () => {
    process.env.GATE_BOOKING_RAIN_RANK = 'true';
    const out = await run(['WaveGuard Assessment']);
    expect(out.rows.day[0].start_time).toBe('14:00');
  });

  test('gate on, every candidate past the 3-day horizon: rows do not wait for the forecast', async () => {
    process.env.GATE_BOOKING_RAIN_RANK = 'true';
    const far = '2026-10-14';
    const farDays = [{ date: far, status: 'open', hours: [h(far, '14:00', 5), h(far, '08:00', 20)] }];
    let priced = false;
    let release;
    const hourlyRain = jest.fn(() => new Promise((resolve) => { release = () => resolve(hourly); }));
    const pending = buildBestRows(farDays, {
      pickedDate: far, today: TODAY, lat: 1, lng: 2, serviceTypes: ['General Pest Control'],
      deps: { priceChipsOnRoads: async (chips) => { priced = true; return chips; }, hourlyRain },
    });
    await new Promise((r) => setImmediate(r));
    // Pricing started while the forecast is still out.
    expect(priced).toBe(true);
    release();
    const out = await pending;
    expect(out.rows.day.map((c) => c.start_time)).toEqual(['14:00', '08:00']);
    // Labels only: the lookup is told it is not ranking, so it keeps the
    // rows' short label wait instead of the ranking one (Codex #6102 r5).
    expect(hourlyRain).toHaveBeenCalledWith(1, 2, false);
  });

  test('a closed day inside the horizon does not trigger the ranking wait', async () => {
    process.env.GATE_BOOKING_RAIN_RANK = 'true';
    const far = '2026-10-14';
    const hourlyRain = jest.fn(async () => hourly);
    await buildBestRows([
      { date: TODAY, status: 'open', closed: true, hours: [h(TODAY, '09:00', 5)] },
      { date: '2026-10-08', status: 'off', hours: [h('2026-10-08', '09:00', 5)] },
      { date: far, status: 'open', hours: [h(far, '09:00', 5)] },
    ], {
      pickedDate: far, today: TODAY, lat: 1, lng: 2, serviceTypes: ['General Pest Control'],
      deps: { priceChipsOnRoads: async (chips) => chips, hourlyRain },
    });
    expect(hourlyRain).toHaveBeenCalledWith(1, 2, false);
  });

  test('a date inside the horizon asks for the ranking wait', async () => {
    process.env.GATE_BOOKING_RAIN_RANK = 'true';
    const hourlyRain = jest.fn(async () => hourly);
    await run(['General Pest Control'], hourlyRain);
    expect(hourlyRain).toHaveBeenCalledWith(1, 2, true);
  });

  test('gate on, no forecast: drive-only order (fail open)', async () => {
    process.env.GATE_BOOKING_RAIN_RANK = 'true';
    const out = await run(['General Pest Control'], jest.fn(async () => null));
    expect(out.rows.day.map((c) => c.start_time)).toEqual(['14:00', '08:00', '09:00']);
  });
});
