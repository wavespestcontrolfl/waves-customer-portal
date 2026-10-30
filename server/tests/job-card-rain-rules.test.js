/**
 * GATE_SPRAY_RAIN_RULES (owner 2026-10-26, plan page "Visit-Day Rain Rule", D1 = A, D2 = A): the
 * visit-day spray check judges each product's label rain rule, else the Waves rule of the services
 * whose lines name it for a tank spray, on one odds table (caution above 60%). Owner 2026-10-29 ("i just want
 * to warn techs"): nothing holds; a reading past the 80% tier or a wind / temperature limit is a caution that
 * names it, and the dose always shows. Without rainRules the check is today's (job-card-service.test.js covers
 * that path).
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
const PEST = 'Quarterly Pest Control Service';
// The rain rules as the card builds them: each product's Waves rule from the services whose lines name it.
const rulesOn = (products, ...services) => ({ waves: Object.fromEntries(products.map((p) => [p.id, wavesRainRule(services)])) });
const check = (products, pops, services = [PEST]) => buildSprayCheck({ products, hourly: hours(pops), now: NOW, rainRules: rulesOn(products, ...services) });
const verdict = (product, pops, services) => check([product], pops, services).verdicts[0];

describe('label rain rules config', () => {
  test('every rule carries its label file and page, and quotes the label', () => {
    for (const [reg, entry] of Object.entries(LABEL_RAIN_RULES)) {
      expect(reg).toMatch(/^\d+-\d+(-\d+)?$/);
      // The EPA PPLS file, or the company's current label URL with the day it was read.
      if (/^https:\/\//.test(entry.label)) expect(entry.read).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      else expect(entry.label).toMatch(/^\d{6}-\d{5}-\d{8}\.pdf$/);
      const rules = ['duringRain', 'dryBeforeRain', 'waterIn', 'heat'].filter((k) => entry[k]);
      expect(rules.length).toBeGreaterThan(0);
      for (const k of rules) {
        expect(Number.isInteger(entry[k].page)).toBe(true);
        expect(entry[k].quote.length).toBeGreaterThan(20);
      }
      if (entry.dryBeforeRain) expect(entry.dryBeforeRain.hours).toBeGreaterThan(0);
      if (entry.heat) {
        expect(entry.heat.aboveF).toBeGreaterThan(0);
        expect(entry.heat.text.length).toBeGreaterThan(5);
        expect(entry.heat.action.length).toBeGreaterThan(10);
      }
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
    expect(wavesRainRule([PEST])).toEqual({ key: 'pest_exterior', hours: 2 });
    expect(wavesRainRule(['Monthly Lawn Care Service'])).toEqual({ key: 'lawn_spray', hours: 4 });
    expect(wavesRainRule(['Bi-Monthly Tree & Shrub Care Service'])).toEqual({ key: 'tree_shrub_spray', hours: 3 });
    expect(wavesRainRule(['Seasonal Mosquito Control Service'])).toEqual({ key: 'mosquito', hours: 2 });
    expect(wavesRainRule(['Lawn Granular Fertilizer'])).toBeNull();
    expect(wavesRainRule(['Interior Pest Treatment'])).toBeNull();
  });

  test('a product named by two services takes the stricter rule (Codex P2: an add-on\'s own rule)', () => {
    expect(wavesRainRule([PEST, 'Tree & Shrub Care'])).toEqual({ key: 'tree_shrub_spray', hours: 3 });
    expect(wavesRainRule(['Interior Pest Treatment', PEST])).toEqual({ key: 'pest_exterior', hours: 2 });
    expect(wavesRainRule([])).toBeNull();
  });
});

describe('buildSprayCheck with rain rules', () => {
  test('"Do not make applications during rain": the start hour, a caution above 60%, the Warning level above 80%', () => {
    const SPRAY_AROUND = 'Spray before the rain starts, or after it stops.';
    expect(verdict(talak, [60, 0, 0])).toEqual({ productId: 't', verdict: 'ok', reason: null });
    expect(verdict(talak, [61, 0, 0])).toEqual({ productId: 't', verdict: 'caution', reason: 'rain 61% at 2 pm — label: no spraying during rain', kind: 'rain', source: 'label', at: '2 pm', action: SPRAY_AROUND });
    expect(verdict(talak, [81, 0, 0])).toEqual({ productId: 't', verdict: 'caution', reason: 'rain 81% at 2 pm — label: no spraying during rain', kind: 'rain', source: 'label', at: '2 pm', level: 'warning', action: SPRAY_AROUND });
    // Rain at 3 pm is not "during" a 2 pm application, but it is inside the Waves rule's 2 dry hours (step 2).
    expect(verdict(talak, [10, 95, 95])).toMatchObject({ verdict: 'caution', level: 'warning', source: 'Waves rule', reason: 'rain 95% inside 2 h — Waves rule', action: 'Skip it today and note why, or plan a re-treat.' });
    expect(verdict(talak, [10, 10, 95]).verdict).toBe('ok');
    // No reading for the start hour is unknown, never a pass.
    expect(verdict(talak, [null, 0, 0])).toEqual({ productId: 't', verdict: 'unknown', reason: 'No rain / rain 2 h forecast', forecastGap: true });
  });

  test('a dust with a "during rain" label gets the start hour only, no Waves dry time', () => {
    const deltaDust = { id: 'd', name: 'Delta Dust', category: 'insecticide', epa_reg_number: '101563-6' };
    expect(verdict(deltaDust, [10, 95, 95]).verdict).toBe('ok');
    expect(verdict(deltaDust, [65, 0, 0])).toMatchObject({ verdict: 'caution', source: 'label' });
  });

  test('a label dry-before-rain advice is a caution, the Warning level above 80%, and a gap in it is not "unknown"', () => {
    expect(verdict(sedgehammer, [0, 0, 0, 65, 0])).toMatchObject({ verdict: 'caution', source: 'label advice', reason: 'rain 65% within 4 h — label advises 4 h to dry', action: 'Spray it first.' });
    expect(verdict(sedgehammer, [0, 0, 0, 65, 0])).not.toHaveProperty('level');
    // Label audit 2026-10-30: the label's own dry time warns like the Waves rule does.
    expect(verdict(sedgehammer, [0, 0, 0, 95, 0])).toMatchObject({ verdict: 'caution', level: 'warning', reason: 'rain 95% within 4 h — label advises 4 h to dry', action: 'Skip it today and note why, or plan a re-treat.' });
    expect(verdict(sedgehammer, [0, 0, 0, 0, 95]).verdict).toBe('ok');
    expect(verdict(sedgehammer, [0, null, 0, 0]).verdict).toBe('ok');
  });

  test('label audit 2026-10-30: Merit 2F waters in; a mosquito dunk tablet and a surfactant get no Waves dry time', () => {
    const merit = { id: 'm', name: 'Merit 2F', category: 'insecticide', formulation: 'flowable', rate_unit: 'fl_oz', epa_reg_number: '101563-60', label_verified_at: '2026-01-01' };
    expect(verdict(merit, [95, 95, 95, 95, 95], ['Every 6 Weeks Lawn Care Service'])).toEqual({ productId: 'm', verdict: 'ok', reason: null });
    const dunks = { id: 'k', name: 'Summit Mosquito Dunk Tablets', category: 'mosquito', formulation: 'tablet', application_method: 'spot_treatment', epa_reg_number: '6218-87', label_verified_at: '2026-01-01' };
    expect(verdict(dunks, [95, 95, 95], ['Mosquito Barrier Treatment']).verdict).toBe('ok');
    const nis = { id: 'n', name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant', formulation: 'liquid adjuvant', epa_reg_number: 'N/A', label_verified_at: '2026-01-01' };
    expect(verdict(nis, [95, 95, 95], [PEST]).verdict).toBe('ok');
    expect(verdict(nis, [95, 95, 95, 95, 95], ['Monthly Lawn Care Service']).verdict).toBe('ok');
    // A real spray beside them still gets its Waves dry time.
    expect(verdict(alpine, [0, 95], [PEST])).toMatchObject({ verdict: 'caution', level: 'warning', source: 'Waves rule' });
  });

  test('a water-in product and a non-spray get no rain check', () => {
    expect(verdict(heritage, [100, 100, 100, 100])).toEqual({ productId: 'h', verdict: 'ok', reason: null });
    expect(verdict({ id: 'g', name: 'Advion Ant Bait Gel', application_method: 'gel' }, [100, 100]).verdict).toBe('ok');
  });

  test('a tank spray with no label rain rule gets the Waves rule of the service, on the same tiers', () => {
    expect(verdict(alpine, [0, 65, 0])).toMatchObject({ verdict: 'caution', source: 'Waves rule', reason: 'rain 65% inside 2 h — Waves rule' });
    expect(verdict(alpine, [0, 85, 0])).toMatchObject({ verdict: 'caution', source: 'Waves rule', reason: 'rain 85% inside 2 h — Waves rule' });
    // Outside the service's 2 dry hours.
    expect(verdict(alpine, [0, 0, 95]).verdict).toBe('ok');
    // A service with no rain-free need judges nothing.
    expect(verdict(alpine, [100, 100], ['Interior Pest Treatment']).verdict).toBe('ok');
  });

  test('a catalog rain number uses the same tiers (it held at 50% before)', () => {
    expect(verdict(celsius, [55, 55, 55]).verdict).toBe('ok');
    expect(verdict(celsius, [55, 65, 55])).toMatchObject({ verdict: 'caution', source: 'product limit', reason: 'rain 65% inside 3 h' });
    expect(verdict(celsius, [55, 85, 55])).toMatchObject({ verdict: 'caution', source: 'product limit', reason: 'rain 85% inside 3 h' });
    // Today's check holds the same row at 55%.
    expect(buildSprayCheck({ products: [celsius], hourly: hours([55, 55, 55]), now: NOW }).verdicts[0].verdict).toBe('hold');
  });

  test('unverified catalog values are skipped and the Waves rule judges rain instead', () => {
    const unverified = { ...celsius, label_verified_at: null, max_wind_mph: 15 };
    const lawn = ['Monthly Lawn Care Service'];
    expect(verdict(unverified, [0, 0, 0, 0], lawn)).toEqual({ productId: 'c', verdict: 'ok', reason: null });
    // The lawn rule needs 4 hours of forecast: a gap is unknown, never a pass.
    expect(verdict(unverified, [0, 0, 0], lawn)).toEqual({ productId: 'c', verdict: 'unknown', reason: 'No rain 4 h forecast', forecastGap: true });
    expect(verdict(unverified, [0, 0, 0, 65], lawn)).toMatchObject({ verdict: 'caution', source: 'Waves rule' });
  });

  test('wind and temperature are a caution at the start hour and the next one, naming the reading and its hour', () => {
    const windy = { ...celsius, max_wind_mph: 10 };
    const out = buildSprayCheck({ products: [windy], hourly: hours([0, 0, 0], { windMph: 14 }), now: NOW, rainRules: rulesOn([windy], PEST) }).verdicts[0];
    expect(out).toMatchObject({ verdict: 'caution', kind: 'wind', source: 'product limit', reason: 'wind 14 mph at 2 pm — over the 10 mph limit', action: 'Check the wind at the nozzle. Do not spray if it drifts onto beds.' });
    expect(out).not.toHaveProperty('level');
    // Wind past the limit at 4 pm is past the tech's two hours on site.
    const later = hours([0, 0, 0, 0]).map((h, i) => (i === 2 ? { ...h, windMph: 20 } : h));
    expect(buildSprayCheck({ products: [windy], hourly: later, now: NOW, rainRules: rulesOn([windy], PEST) }).verdicts[0].verdict).toBe('ok');
    // A catalog maximum with no label heat line names its own limit.
    const cooled = { id: 'k', name: 'Catalog Limit Spray', category: 'herbicide', max_temp_f: 95, label_verified_at: '2026-05-28' };
    expect(buildSprayCheck({ products: [cooled], hourly: hours([0, 0, 0, 0], { temperatureF: 97 }), now: NOW, rainRules: rulesOn([cooled], PEST) }).verdicts[0])
      .toMatchObject({ verdict: 'caution', kind: 'temperature', source: 'product limit', reason: '97°F at 2 pm — over the 95°F limit' });
    // One hour of the window has no reading: the known breach is still said, not "unknown".
    const gappy = hours([0, 0, 0], { windMph: 14 }).map((h, i) => (i === 1 ? { ...h, windMph: null } : h));
    expect(buildSprayCheck({ products: [windy], hourly: gappy, now: NOW, rainRules: rulesOn([windy], PEST) }).verdicts[0]).toMatchObject({ verdict: 'caution', kind: 'wind' });
    // Today's check still holds the same reading.
    expect(buildSprayCheck({ products: [windy], hourly: hours([0, 0, 0], { windMph: 14 }), now: NOW }).verdicts[0].verdict).toBe('hold');
  });

  test('a mid-hour start reads the hour it starts in and the next one, never a third (pre-push audit P1)', () => {
    const windy = { ...celsius, max_wind_mph: 15 };
    const at201 = new Date(NOW.getTime() + 60000); // 2:01 pm ET
    const rows = (winds) => winds.map((windMph, i) => ({ startTime: new Date(NOW.getTime() + i * 3600000).toISOString(), temperatureF: 85, windMph, rainChance: 0 }));
    const judgeAt = (hourly) => buildSprayCheck({ products: [windy], hourly, now: at201, rainRules: rulesOn([windy], PEST) }).verdicts[0];
    // Wind at 4 pm only: outside the 2 pm and 3 pm periods.
    expect(judgeAt(rows([5, 5, 20, 5])).verdict).toBe('ok');
    expect(judgeAt(rows([5, 20, 5, 5]))).toMatchObject({ verdict: 'caution', reason: 'wind 20 mph at 3 pm — over the 15 mph limit' });
    // The 2 pm and 3 pm periods are enough; no 4 pm row is needed (Celsius's 3 h rain window is, so it reads 3 rows).
    expect(buildSprayCheck({ products: [{ id: 'w', name: 'Wind Only Spray', category: 'herbicide', max_wind_mph: 15, label_verified_at: '2026-05-28' }],
      hourly: rows([5, 5]), now: at201, rainRules: rulesOn([], 'Interior Pest Treatment') }).verdicts[0].verdict).toBe('ok');
  });

  test('Celsius heat: the label line (no surfactant above 90°F) is a caution with its action, and replaces the catalog 95°F', () => {
    const hotCelsius = { ...celsius, max_temp_f: 95, min_temp_f: 50 };
    const at = (temps) => buildSprayCheck({ products: [hotCelsius], hourly: hours([0, 0, 0, 0]).map((h, i) => ({ ...h, temperatureF: temps[i] ?? 85 })), now: NOW, rainRules: rulesOn([hotCelsius], PEST) }).verdicts[0];
    expect(at([88, 90, 99])).toEqual({ productId: 'c', verdict: 'ok', reason: null });
    expect(at([88, 92])).toEqual({
      productId: 'c', verdict: 'caution', reason: '92°F at 3 pm — label: no surfactant above 90°F', kind: 'temperature', source: 'label', at: null,
      action: 'Leave the NIS out of the tank. Spot sprays on St. Augustine may slow its growth for a while (label).',
    });
    // Above the catalog's 95°F too: one line, the label's.
    expect(at([97]).reason).toBe('97°F at 2 pm — label: no surfactant above 90°F');
    // The catalog minimum still names its own limit.
    expect(at([45]).reason).toBe('45°F at 2 pm — under the 50°F limit');
    // Off: today's check, the catalog limits on the 4-hour window.
    expect(buildSprayCheck({ products: [hotCelsius], hourly: hours([0, 0, 0, 0], { temperatureF: 92 }), now: NOW }).verdicts[0].verdict).toBe('ok');
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
      const out = buildSprayCheck({ products: [reviewed], hourly: hours([0, 0, 0, 0]), now: NOW, rainRules: rulesOn([reviewed], PEST), labelSources: { r: 'current' } }).verdicts[0];
      expect(out).toEqual({ productId: 'r', verdict: 'unknown', reason: 'Conditional label restrictions need review' });
    } finally { delete process.env.GATE_LABEL_PIPELINE; }
  });

  test('no forecast at all is unknown for a product with a rule, and nothing to judge stays ok', () => {
    expect(buildSprayCheck({ products: [talak, heritage], hourly: null, now: NOW, rainRules: rulesOn([talak, heritage], PEST) }).verdicts)
      .toEqual([{ productId: 't', verdict: 'unknown', reason: 'No forecast', forecastGap: true }, { productId: 'h', verdict: 'ok', reason: null }]);
  });

  test('the check says which path ran, and the rain rules never hold', () => {
    expect(check([talak], [0]).rainRules).toBe(true);
    expect(check([talak, alpine, celsius], [100, 100, 100, 100]).hold).toBe(false);
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

  test('with rain rules the chip names the caution, its level and the product, and is never a hold', () => {
    expect(chip([talak], [85, 0])).toEqual({ kind: 'weather', status: 'caution', label: 'Rain very likely 2 pm' });
    expect(chip([talak], [65, 0])).toEqual({ kind: 'weather', status: 'caution', label: 'Rain likely 2 pm' });
    expect(chip([alpine], [0, 85])).toEqual({ kind: 'weather', status: 'caution', label: 'Rain warning' });
    expect(chip([alpine], [0, 65])).toEqual({ kind: 'weather', status: 'caution', label: 'Rain caution' });
    expect(chip([sedgehammer], [0, 0, 95])).toEqual({ kind: 'weather', status: 'caution', label: 'Rain warning' });
    expect(chip([sedgehammer], [0, 0, 70])).toEqual({ kind: 'weather', status: 'caution', label: 'Rain caution' });
    expect(chip([celsius], [0, 85, 0])).toEqual({ kind: 'weather', status: 'caution', label: 'Rain warning' });
    // The product goes on the chip, and a Warning beats an earlier product's caution.
    const names = new Map([['t', 'Atticus Talak 7.9 F'], ['s', 'Sedgehammer Plus']]);
    // Talak: 65% at the start (a caution); Sedgehammer: 85% at 5 pm, inside its 4 h (a Warning).
    expect(weatherIssue(check([talak, sedgehammer], [65, 0, 0, 85]), true, names)).toEqual({ kind: 'weather', status: 'caution', label: 'Rain warning · Sedgehammer Plus' });
    const windy = { ...celsius, max_wind_mph: 10 };
    const hot = { ...celsius, max_temp_f: 95 };
    expect(weatherIssue(buildSprayCheck({ products: [windy], hourly: hours([0, 0, 0], { windMph: 14 }), now: NOW, rainRules: rulesOn([windy], PEST) }), true))
      .toEqual({ kind: 'weather', status: 'caution', label: 'Wind caution' });
    expect(weatherIssue(buildSprayCheck({ products: [windy], hourly: hours([0, 0, 0], { windMph: 14 }), now: NOW, rainRules: rulesOn([windy], PEST) }), true, new Map([['c', 'Celsius WG']])))
      .toEqual({ kind: 'weather', status: 'caution', label: 'Wind caution · Celsius WG' });
    expect(weatherIssue(buildSprayCheck({ products: [hot], hourly: hours([0, 0, 0], { temperatureF: 97 }), now: NOW, rainRules: rulesOn([hot], PEST) }), true))
      .toEqual({ kind: 'weather', status: 'caution', label: 'Temperature caution' });
    expect(chip([talak, alpine], [10, 10])).toBeNull();
  });

  test('a caution comes before "Weather unknown" (a missing forecast), and other days wait', () => {
    // Talak has no start-hour reading (unknown); Sedgehammer's rain is still said.
    expect(chip([talak, sedgehammer], [null, 0, 70])).toEqual({ kind: 'weather', status: 'caution', label: 'Rain caution' });
    expect(chip([talak], [null])).toEqual({ kind: 'weather', status: 'unknown', label: 'Weather unknown' });
    expect(chip([talak], [10], false)).toEqual({ kind: 'weather', status: 'unknown', label: 'Weather on visit day' });
  });
});

describe('the tank search follows the same rule', () => {
  afterEach(() => { delete process.env.GATE_SPRAY_RAIN_RULES; });
  const product = { ...talak, id: 'p1', default_rate: '1', default_unit: 'fl_oz/gal', label_verified_at: '2026-07-12' };
  const visit = { customer_id: 'c1', scheduled_date: '2026-09-04', service_type: 'Quarterly Pest Control', window_start: '14:00', latitude: 27.4, longitude: -82.5 };
  let tables;
  beforeEach(() => { tables = { scheduled_services: [visit], products_catalog: [product], equipment_calibrations: [], scheduled_service_addons: [] }; });
  const dbh = (table) => {
    const rows = tables[String(table).split(' as ')[0]] ?? [];
    const chain = {};
    for (const m of ['join', 'leftJoin', 'where', 'whereIn', 'whereNotNull', 'select', 'orderByRaw', 'orderBy', 'modify']) chain[m] = () => chain;
    chain.first = async () => rows[0] ?? null;
    chain.catch = (fn) => Promise.resolve(rows).catch(fn);
    chain.then = (res, rej) => Promise.resolve(rows).then(res, rej);
    return chain;
  };
  dbh.raw = (sql) => sql;
  const mix = (pop) => jobCard.mixForProduct('p1', 2, { serviceId: 'svc1', dbh, deps: { getHourly: async () => hours([pop, 0, 0, 0]) }, now: NOW });

  test('on: every reading keeps the dose, above 80% too (owner 2026-10-29); off: today\'s check', async () => {
    process.env.GATE_SPRAY_RAIN_RULES = 'true';
    const caution = await mix(65);
    expect(caution.sprayCheck).toEqual({ verdict: 'caution', reason: 'rain 65% at 2 pm — label: no spraying during rain', action: 'Spray before the rain starts, or after it stops.' });
    expect(caution.amount).not.toBeNull();
    const likely = await mix(85);
    expect(likely.sprayCheck).toEqual({ verdict: 'caution', reason: 'rain 85% at 2 pm — label: no spraying during rain', level: 'warning', action: 'Spray before the rain starts, or after it stops.' });
    expect(likely.amount).not.toBeNull();
    delete process.env.GATE_SPRAY_RAIN_RULES;
    const legacy = await mix(85);
    expect(legacy.sprayCheck).toEqual({ verdict: 'unknown', reason: 'No limit on file' });
    expect(legacy.amount).not.toBeNull();
  });

  test('a product an add-on\'s line names takes the add-on\'s Waves rule, as on the card (Codex P2)', async () => {
    process.env.GATE_SPRAY_RAIN_RULES = 'true';
    const talus = { id: 'p2', name: 'Talus IGR', category: 'insecticide', default_rate: '0.5', default_unit: 'fl_oz/gal', label_verified_at: '2026-07-12' };
    const protocols = {
      pest: { visits: [{ visit: 1, month: 'Any', primary: 'Talus IGR 0.5 fl oz/gal' }] },
      tree_shrub: { visits: [{ visit: 9, month: 'Sep', primary: 'Talus IGR 0.5 fl oz/gal for whitefly/scale nymphs' }] },
    };
    tables.products_catalog = [talus];
    // Rain at 4 pm: inside the Tree & Shrub 3 h from a 2 pm start, outside the pest visit's 2 h.
    const search = () => jobCard.mixForProduct('p2', 2, { serviceId: 'svc1', dbh, deps: { protocols, getHourly: async () => hours([0, 0, 95, 0]) }, now: NOW });
    const onPest = await search();
    expect(onPest.sprayCheck).toEqual({ verdict: 'ok', reason: null });
    tables.scheduled_service_addons = [{ service_name: 'Tree & Shrub Care', category: 'tree_shrub' }];
    protocols.pest.visits[0] = { visit: 1, month: 'Any', primary: 'Talstar P 1 fl oz/gal' };
    const viaAddon = await search();
    const SKIP = 'Skip it today and note why, or plan a re-treat.';
    expect(viaAddon.sprayCheck).toEqual({ verdict: 'caution', reason: 'rain 95% inside 3 h — Waves rule', level: 'warning', action: SKIP });
    expect(viaAddon.amount).not.toBeNull();
    // Named by both, the stricter rule judges it.
    protocols.pest.visits[0] = { visit: 1, month: 'Any', primary: 'Talus IGR 0.5 fl oz/gal' };
    expect((await search()).sprayCheck).toEqual({ verdict: 'caution', reason: 'rain 95% inside 3 h — Waves rule', level: 'warning', action: SKIP });
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
    // A Warning ranks above a plain caution inside the 'caution' status (step 2), on both sides of the comparison.
    expect(sql).toMatch(/jsonb_array_elements\(EXCLUDED\.products\) AS e WHERE e->>'level' = 'warning'/);
    expect(sql).toMatch(/jsonb_array_elements\(spray_rain_rule_shadow\.products\) AS e WHERE e->>'level' = 'warning'/);
    // The start time and service are the peak read's: they move only with it (Codex P2).
    expect(sql).toMatch(/start_at = CASE WHEN .* THEN EXCLUDED\.start_at ELSE spray_rain_rule_shadow\.start_at END/);
    expect(sql).toMatch(/service_type = CASE WHEN .* THEN EXCLUDED\.service_type ELSE spray_rain_rule_shadow\.service_type END/);
    expect(sql).not.toMatch(/start_at = EXCLUDED\.start_at/);
    expect(sql).toMatch(/OR \(EXCLUDED\.live_hold AND NOT spray_rain_rule_shadow\.live_hold\)/);
    expect(sql).toMatch(/OR spray_rain_rule_shadow\.last_seen_at < now\(\) - interval '10 minutes'/);
    expect(bindings).toEqual(['svc1', '2026-09-04', NOW.toISOString(), 'Quarterly Pest Control', 'Weather unknown', false, 'ok', null, 70, 85, false,
      JSON.stringify([{ name: 'Atticus Talak 7.9 F', verdict: 'ok', reason: null, source: null }])]);
  });

  test('a Warning keeps its level in the row, so warnings stay countable', () => {
    const row = shadowTest.shadowRow(input([{ productId: 'a', verdict: 'caution', level: 'warning', reason: 'rain 85% inside 2 h — Waves rule', source: 'Waves rule' }],
      { kind: 'weather', status: 'caution', label: 'Rain warning · Alpine WSG' }));
    expect(row.shadow_status).toBe('caution');
    expect(row.dose_hidden).toBe(false);
    expect(JSON.parse(row.products)).toEqual([{ name: 'Alpine WSG', verdict: 'caution', level: 'warning', reason: 'rain 85% inside 2 h — Waves rule', source: 'Waves rule' }]);
  });

  test('no visit id or date writes nothing', async () => {
    const raw = jest.fn();
    const out = await recordSprayRainShadow({ dbh: { raw }, ...input([], null), facts: { serviceId: null, scheduledDate: '2026-09-04' } });
    expect(out).toBeNull();
    expect(raw).not.toHaveBeenCalled();
  });
});
