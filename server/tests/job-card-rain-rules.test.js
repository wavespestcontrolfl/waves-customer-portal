/**
 * GATE_SPRAY_RAIN_RULES (owner 2026-10-26, plan page "Visit-Day Rain Rule", D1 = A, D2 = A): the
 * visit-day spray check judges each product's label rain rule, else the Waves rule of the visit's
 * service for a tank spray, on one odds table (caution above 60%, hold above 80%). Without rainRules
 * the check is today's (job-card-service.test.js covers that path).
 */
const jobCard = require('../services/job-card');
const { LABEL_RAIN_RULES, labelRainRuleFor } = require('../config/label-rain-rules');
const { recordSprayRainShadow, _test: shadowTest } = require('../services/spray-rain-rule-shadow');

const { buildSprayCheck } = jobCard;
const { weatherIssue, wavesRainRule } = jobCard._test;

// A 2:00 pm ET start (18:00Z). Hours are the NWS hourly rows the card reads.
const NOW = new Date('2026-09-04T18:00:00Z');
const hours = (pops, extra = {}) => pops.map((rainChance, i) => ({
  startTime: new Date(NOW.getTime() + i * 3600000).toISOString(), temperatureF: 85, windMph: 5, rainChance, ...extra,
}));
const talak = { id: 't', name: 'Atticus Talak 7.9 F', category: 'insecticide', epa_reg_number: '91234-145' };
const sedgehammer = { id: 's', name: 'Sedgehammer Plus', category: 'herbicide', epa_reg_number: '81880-24' };
const heritage = { id: 'h', name: 'Heritage G', category: 'fungicide', epa_reg_number: '100-1323', application_method: 'granular' };
const alpine = { id: 'a', name: 'Alpine WSG', category: 'insecticide', epa_reg_number: '499-561' };
const celsius = { id: 'c', name: 'Celsius WG', category: 'herbicide', epa_reg_number: '101563-141', rainfast_minutes: 180, label_verified_at: '2026-05-28' };
const pest = { waves: wavesRainRule('Quarterly Pest Control Service') };
const check = (products, pops, rainRules = pest) => buildSprayCheck({ products, hourly: hours(pops), now: NOW, rainRules });
const verdict = (product, pops, rainRules) => check([product], pops, rainRules).verdicts[0];

describe('label rain rules config', () => {
  test('every rule carries its label file and page, and quotes the label', () => {
    for (const [reg, entry] of Object.entries(LABEL_RAIN_RULES)) {
      expect(reg).toMatch(/^\d+-\d+(-\d+)?$/);
      expect(entry.label).toMatch(/^\d{6}-\d{5}-\d{8}\.pdf$/);
      const rules = ['duringRain', 'dryBeforeRain', 'waterIn'].filter((k) => entry[k]);
      expect(rules.length).toBeGreaterThan(0);
      for (const k of rules) {
        expect(Number.isInteger(entry[k].page)).toBe(true);
        expect(entry[k].quote.length).toBeGreaterThan(20);
      }
      if (entry.dryBeforeRain) expect(entry.dryBeforeRain.hours).toBeGreaterThan(0);
    }
  });

  test('looks a product up by its catalog EPA number', () => {
    expect(labelRainRuleFor({ epa_reg_number: ' 91234-145 ' }).duringRain.quote).toBe('Do not make applications during rain.');
    expect(labelRainRuleFor({ epa_reg_number: '499-561' })).toBeNull();
    expect(labelRainRuleFor({})).toBeNull();
  });
});

describe('the Waves rule of a service (reschedule-rules.js)', () => {
  test('pest outside 2 h, lawn spray 4 h, tree & shrub 3 h, mosquito 2 h; none for granular lawn or interior pest', () => {
    expect(wavesRainRule('Quarterly Pest Control Service')).toEqual({ key: 'pest_exterior', hours: 2 });
    expect(wavesRainRule('Monthly Lawn Care Service')).toEqual({ key: 'lawn_spray', hours: 4 });
    expect(wavesRainRule('Bi-Monthly Tree & Shrub Care Service')).toEqual({ key: 'tree_shrub_spray', hours: 3 });
    expect(wavesRainRule('Seasonal Mosquito Control Service')).toEqual({ key: 'mosquito', hours: 2 });
    expect(wavesRainRule('Lawn Granular Fertilizer')).toBeNull();
    expect(wavesRainRule('Interior Pest Treatment')).toBeNull();
  });
});

describe('buildSprayCheck with rain rules', () => {
  test('"Do not make applications during rain": the start hour, caution above 60%, hold above 80%', () => {
    expect(verdict(talak, [60, 0, 0])).toEqual({ productId: 't', verdict: 'ok', reason: null });
    expect(verdict(talak, [61, 0, 0])).toEqual({ productId: 't', verdict: 'caution', reason: 'rain 61% at 2 pm — label: no spraying during rain', kind: 'rain', source: 'label', at: '2 pm' });
    expect(verdict(talak, [81, 0, 0])).toMatchObject({ verdict: 'hold', source: 'label', at: '2 pm' });
    // Only the start hour counts: rain at 3 pm is not "during" a 2 pm application.
    expect(verdict(talak, [10, 95, 95]).verdict).toBe('ok');
    // No reading for the start hour is unknown, never a pass.
    expect(verdict(talak, [null, 0, 0])).toEqual({ productId: 't', verdict: 'unknown', reason: 'No rain forecast' });
  });

  test('a label dry-before-rain advice is a caution only, and a gap in it is not "unknown"', () => {
    expect(verdict(sedgehammer, [0, 0, 0, 95, 0]).verdict).toBe('caution');
    expect(verdict(sedgehammer, [0, 0, 0, 95, 0]).reason).toBe('rain 95% within 4 h — label advises 4 h to dry');
    expect(verdict(sedgehammer, [0, 0, 0, 0, 95]).verdict).toBe('ok');
    expect(verdict(sedgehammer, [0, null, 0, 0]).verdict).toBe('ok');
  });

  test('a water-in product and a non-spray get no rain check', () => {
    expect(verdict(heritage, [100, 100, 100, 100])).toEqual({ productId: 'h', verdict: 'ok', reason: null });
    expect(verdict({ id: 'g', name: 'Advion Ant Bait Gel', application_method: 'gel' }, [100, 100]).verdict).toBe('ok');
  });

  test('a tank spray with no label rain rule gets the Waves rule of the service, on the same tiers', () => {
    expect(verdict(alpine, [0, 65, 0])).toMatchObject({ verdict: 'caution', source: 'Waves rule', reason: 'rain 65% inside 2 h — Waves rule' });
    expect(verdict(alpine, [0, 85, 0])).toMatchObject({ verdict: 'hold', source: 'Waves rule' });
    // Outside the service's 2 dry hours.
    expect(verdict(alpine, [0, 0, 95]).verdict).toBe('ok');
    // A service with no rain-free need judges nothing.
    expect(verdict(alpine, [100, 100], { waves: null }).verdict).toBe('ok');
  });

  test('a catalog rain number uses the same tiers (it held at 50% before)', () => {
    expect(verdict(celsius, [55, 55, 55]).verdict).toBe('ok');
    expect(verdict(celsius, [55, 65, 55])).toMatchObject({ verdict: 'caution', source: 'product limit', reason: 'rain 65% inside 3 h' });
    expect(verdict(celsius, [55, 85, 55])).toMatchObject({ verdict: 'hold', source: 'product limit' });
    // Today's check holds the same row at 55%.
    expect(buildSprayCheck({ products: [celsius], hourly: hours([55, 55, 55]), now: NOW }).verdicts[0].verdict).toBe('hold');
  });

  test('unverified catalog values are skipped and the Waves rule judges rain instead', () => {
    const unverified = { ...celsius, label_verified_at: null, max_wind_mph: 15 };
    expect(verdict(unverified, [0, 0, 0, 0], { waves: wavesRainRule('Monthly Lawn Care Service') })).toEqual({ productId: 'c', verdict: 'ok', reason: null });
    // The lawn rule needs 4 hours of forecast: a gap is unknown, never a pass.
    expect(verdict(unverified, [0, 0, 0], { waves: wavesRainRule('Monthly Lawn Care Service') })).toEqual({ productId: 'c', verdict: 'unknown', reason: 'No rain 4 h forecast' });
    expect(verdict(unverified, [0, 0, 0, 65], { waves: wavesRainRule('Monthly Lawn Care Service') })).toMatchObject({ verdict: 'caution', source: 'Waves rule' });
  });

  test('temperature and wind limits still hold, named as weather', () => {
    const windy = { ...celsius, max_wind_mph: 10 };
    const out = buildSprayCheck({ products: [windy], hourly: hours([0, 0, 0], { windMph: 14 }), now: NOW, rainRules: pest }).verdicts[0];
    expect(out).toMatchObject({ verdict: 'hold', kind: 'wind', source: 'product limit', reason: 'wind over 10 mph' });
  });

  test('a reviewed label with only conditional restrictions stays unknown when nothing else applies', () => {
    // An approved review (GATE_LABEL_PIPELINE) whose four facts are conditional: no numeric limit, unresolved.
    const conditional = { status: 'conditional', value: null, quote: 'Do not apply if rain is expected (sites vary).', page: 3, note: 'Site-specific.' };
    const snapshotOf = (p) => Object.fromEntries(['name', 'epa_reg_number', 'formulation', 'min_temp_f', 'max_temp_f', 'max_wind_mph', 'rainfast_minutes', 'rain_free_hours']
      .map((k) => [k, p[k] == null ? null : String(p[k])]));
    const granule = { id: 'r', name: 'Reviewed Granule G', epa_reg_number: '999-1', application_method: 'granular' };
    const reviewed = { ...granule, label_weather_review: { active: { status: 'approved', productSnapshot: snapshotOf(granule),
      facts: { minTempF: conditional, maxTempF: conditional, maxWindMph: conditional, rainFreeHours: conditional } } } };
    process.env.GATE_LABEL_PIPELINE = 'true';
    try {
      const out = buildSprayCheck({ products: [reviewed], hourly: hours([0, 0, 0, 0]), now: NOW, rainRules: pest, labelSources: { r: 'current' } }).verdicts[0];
      expect(out).toEqual({ productId: 'r', verdict: 'unknown', reason: 'Conditional label restrictions need review' });
    } finally { delete process.env.GATE_LABEL_PIPELINE; }
  });

  test('no forecast at all is unknown for a product with a rule, and nothing to judge stays ok', () => {
    expect(buildSprayCheck({ products: [talak, heritage], hourly: null, now: NOW, rainRules: pest }).verdicts)
      .toEqual([{ productId: 't', verdict: 'unknown', reason: 'No forecast' }, { productId: 'h', verdict: 'ok', reason: null }]);
  });

  test('the check says which path ran', () => {
    expect(check([talak], [0]).rainRules).toBe(true);
    expect(buildSprayCheck({ products: [talak], hourly: hours([0]), now: NOW })).not.toHaveProperty('rainRules');
  });
});

describe('the Dispatch weather chip', () => {
  const chip = (products, pops, isToday = true) => weatherIssue(check(products, pops), isToday);

  test('without rain rules the chips are today\'s, word for word', () => {
    const legacy = (pops) => weatherIssue(buildSprayCheck({ products: [talak], hourly: hours(pops), now: NOW }), true);
    expect(legacy([0])).toEqual({ kind: 'weather', status: 'unknown', label: 'Weather unknown' });
    expect(weatherIssue({ hold: true, verdicts: [] }, true)).toEqual({ kind: 'weather', status: 'hold', label: 'Weather hold' });
    expect(weatherIssue({ hold: false, verdicts: [] }, false)).toEqual({ kind: 'weather', status: 'unknown', label: 'Weather on visit day' });
    expect(weatherIssue({ hold: false, verdicts: [{ verdict: 'ok' }] }, true)).toBeNull();
  });

  test('with rain rules the chip names the rule that fired', () => {
    expect(chip([talak], [85])).toEqual({ kind: 'weather', status: 'hold', label: 'Rain hold · label' });
    expect(chip([talak], [65])).toEqual({ kind: 'weather', status: 'caution', label: 'Rain likely 2 pm · label: no spraying in rain' });
    expect(chip([alpine], [0, 85])).toEqual({ kind: 'weather', status: 'hold', label: 'Rain hold · Waves rule' });
    expect(chip([alpine], [0, 65])).toEqual({ kind: 'weather', status: 'caution', label: 'Rain caution · Waves rule' });
    expect(chip([sedgehammer], [0, 0, 95])).toEqual({ kind: 'weather', status: 'caution', label: 'Rain caution · label advice' });
    expect(chip([celsius], [0, 85, 0])).toEqual({ kind: 'weather', status: 'hold', label: 'Rain hold' });
    expect(chip([talak, alpine], [10, 10])).toBeNull();
  });

  test('a hold beats a caution, "Weather unknown" means a missing forecast, other days wait', () => {
    expect(chip([sedgehammer, talak], [85, 0, 95])).toEqual({ kind: 'weather', status: 'hold', label: 'Rain hold · label' });
    expect(chip([talak], [null])).toEqual({ kind: 'weather', status: 'unknown', label: 'Weather unknown' });
    expect(chip([talak], [10], false)).toEqual({ kind: 'weather', status: 'unknown', label: 'Weather on visit day' });
  });
});

describe('the tank search follows the same rule', () => {
  afterEach(() => { delete process.env.GATE_SPRAY_RAIN_RULES; });
  const product = { ...talak, id: 'p1', default_rate: '1', default_unit: 'fl_oz/gal', label_verified_at: '2026-07-12' };
  const visit = { customer_id: 'c1', scheduled_date: '2026-09-04', service_type: 'Quarterly Pest Control', window_start: '14:00', latitude: 27.4, longitude: -82.5 };
  const dbh = (table) => {
    const rows = { scheduled_services: [visit], products_catalog: [product], equipment_calibrations: [] }[String(table).split(' as ')[0]] ?? [];
    const chain = {};
    for (const m of ['join', 'leftJoin', 'where', 'whereIn', 'whereNotNull', 'select', 'orderByRaw', 'orderBy', 'modify']) chain[m] = () => chain;
    chain.first = async () => rows[0] ?? null;
    chain.catch = (fn) => Promise.resolve(rows).catch(fn);
    chain.then = (res, rej) => Promise.resolve(rows).then(res, rej);
    return chain;
  };
  dbh.raw = (sql) => sql;
  const mix = (pop) => jobCard.mixForProduct('p1', 2, { serviceId: 'svc1', dbh, deps: { getHourly: async () => hours([pop, 0, 0, 0]) }, now: NOW });

  test('on: a caution keeps the dose, a hold withholds it; off: today\'s check', async () => {
    process.env.GATE_SPRAY_RAIN_RULES = 'true';
    const caution = await mix(65);
    expect(caution.sprayCheck).toEqual({ verdict: 'caution', reason: 'rain 65% at 2 pm — label: no spraying during rain' });
    expect(caution.amount).not.toBeNull();
    const hold = await mix(85);
    expect(hold.sprayCheck.verdict).toBe('hold');
    expect(hold.amount).toBeNull();
    expect(hold.reason).toBe('Spray check: rain 85% at 2 pm — label: no spraying during rain');
    delete process.env.GATE_SPRAY_RAIN_RULES;
    const legacy = await mix(85);
    expect(legacy.sprayCheck).toEqual({ verdict: 'unknown', reason: 'No limit on file' });
    expect(legacy.amount).not.toBeNull();
  });
});

describe('the shadow record (GATE_SPRAY_RAIN_RULES=shadow)', () => {
  const input = (shadowVerdicts, issue) => ({
    facts: { serviceId: 'svc1', scheduledDate: '2026-09-04', serviceType: 'Quarterly Pest Control' },
    products: [talak, alpine],
    hourly: hours([70, 85, 20, 10, 90]),
    serviceInstant: NOW,
    live: { hold: false, issue: { kind: 'weather', status: 'unknown', label: 'Weather unknown' } },
    shadow: { verdicts: shadowVerdicts, issue },
  });

  test('the row keeps the worst verdict, the start and 4-hour rain chances, and each product', () => {
    const row = shadowTest.shadowRow(input([
      { productId: 't', verdict: 'caution', reason: 'rain 70% at 2 pm — label: no spraying during rain', source: 'label' },
      { productId: 'a', verdict: 'hold', reason: 'rain 85% inside 2 h — Waves rule', source: 'Waves rule' },
    ], { kind: 'weather', status: 'hold', label: 'Rain hold · Waves rule' }));
    expect(row).toEqual({
      scheduled_service_id: 'svc1', visit_date: '2026-09-04', start_at: NOW.toISOString(), service_type: 'Quarterly Pest Control',
      live_label: 'Weather unknown', live_hold: false, shadow_status: 'hold', shadow_label: 'Rain hold · Waves rule',
      start_pop: 70, max_pop_4h: 85, dose_hidden: true,
      products: JSON.stringify([
        { name: 'Atticus Talak 7.9 F', verdict: 'caution', reason: 'rain 70% at 2 pm — label: no spraying during rain', source: 'label' },
        { name: 'Alpine WSG', verdict: 'hold', reason: 'rain 85% inside 2 h — Waves rule', source: 'Waves rule' },
      ]),
    });
  });

  test('one upsert per visit and day: the peak moves only when worse, a refresh at most every 10 minutes', async () => {
    const raw = jest.fn(async () => ({ rowCount: 1 }));
    await recordSprayRainShadow({ dbh: { raw }, ...input([{ productId: 't', verdict: 'ok', reason: null }], null) });
    const [sql, bindings] = raw.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(scheduled_service_id, visit_date\) DO UPDATE SET/);
    expect(sql).toMatch(/shadow_status = CASE WHEN .* THEN EXCLUDED\.shadow_status ELSE spray_rain_rule_shadow\.shadow_status END/);
    expect(sql).toMatch(/OR \(EXCLUDED\.live_hold AND NOT spray_rain_rule_shadow\.live_hold\)/);
    expect(sql).toMatch(/OR spray_rain_rule_shadow\.last_seen_at < now\(\) - interval '10 minutes'/);
    expect(bindings).toEqual(['svc1', '2026-09-04', NOW.toISOString(), 'Quarterly Pest Control', 'Weather unknown', false, 'ok', null, 70, 85, false,
      JSON.stringify([{ name: 'Atticus Talak 7.9 F', verdict: 'ok', reason: null, source: null }])]);
  });

  test('no visit id or date writes nothing', async () => {
    const raw = jest.fn();
    const out = await recordSprayRainShadow({ dbh: { raw }, ...input([], null), facts: { serviceId: null, scheduledDate: '2026-09-04' } });
    expect(out).toBeNull();
    expect(raw).not.toHaveBeenCalled();
  });
});
