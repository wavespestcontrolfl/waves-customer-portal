/**
 * Public lawn watering plan service (GET /api/public/watering-plan,
 * GATE_PUBLIC_WATERING_PLAN): the pure decision + copy, the query parser, the
 * county -> rules page table, and the per-location weather cache with its
 * fail-soft paths. The route (gate, limiter, CORS, status codes, cache
 * headers) is pinned in public-watering-plan-route.test.js.
 *
 * Owner rulings under test: the legal restriction is a hard ceiling above the
 * model and is never invented (no policy -> need_only, no event count, no legal
 * maximum); copy says "each turf zone" / "skip your turf watering" / "your
 * permitted watering day" and never names a weekday.
 */
jest.mock('../models/db', () => { const m = jest.fn(); m.fn = { now: () => 'now()' }; return m; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-report/application-conditions', () => ({ fetchServiceWeekWeather: jest.fn() }));
jest.mock('../services/irrigation-weekly-email', () => ({ fetchUpcomingWeekForecast: jest.fn() }));

const { buildWeekPlan } = require('../../packages/irrigation-runtime');
const { fetchServiceWeekWeather } = require('../services/service-report/application-conditions');
const { fetchUpcomingWeekForecast } = require('../services/irrigation-weekly-email');
const { buildIrrigationAdvice } = require('../services/service-report/irrigation-advice');
const { LOCATIONS, BY_SLUG } = require('../services/pest-forecast/locations');
const svc = require('../services/public-watering-plan');

const { computePublicWateringPlan, getPublicWateringPlan, parseWateringQuery, planWeekBounds, rulesFor } = svc;

// Wed 2026-10-28, 10:00 AM ET.
const NOW = new Date('2026-10-28T14:00:00Z');
const BRADENTON = BY_SLUG.get('bradenton-fl');
const ONE_DAY = {
  maxDaysPerWeek: 1,
  effectiveFrom: '2026-08-27',
  expiresOn: '2027-03-31',
  label: 'SWFWMD Modified Phase III water shortage order',
  source: 'https://www.swfwmd.state.fl.us/the-newsroom/2026/district-extends-modified-phase-iii-water-shortage',
  hoursNote: 'on your assigned day, during your area\'s allowed hours',
  county: 'Manatee',
};
const OBSERVED = { rainInches: 0.3, et0Inches: 1.4, rainSource: 'mrms' };
const FORECAST = { rainInches: 0.1, et0Inches: 1.5, days: 7, startDate: '2026-10-28', endDate: '2026-11-01' };
const WEEKDAY = /\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b|\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/;

function compute(extra = {}) {
  return computePublicWateringPlan({ location: BRADENTON, observed: OBSERVED, forecast: FORECAST, policy: ONE_DAY, now: NOW, ...extra });
}
function allText(body) {
  return [body.text.headline, body.text.action, ...body.text.notes].join(' ');
}

describe('computePublicWateringPlan', () => {
  test('covered county, dry-ish week: a run plan under the legal ceiling, with the contract keys', () => {
    const body = compute();
    expect(Object.keys(body)).toEqual([
      'location', 'asOf', 'week', 'rain', 'forecast', 'need', 'plan', 'restriction', 'rulesUrl', 'text', 'landing', 'brand', 'disclaimer',
    ]);
    expect(body.location).toEqual({ slug: 'bradenton-fl', label: 'Bradenton, FL', county: 'Manatee' });
    expect(body.asOf).toBe('2026-10-28');
    expect(body.week).toEqual({ start: '2026-10-26', end: '2026-11-01' });
    expect(body.rain).toEqual({ last7Inches: 0.3, source: 'mrms' });
    expect(body.forecast).toEqual({ rainInches: 0.1, et0Inches: 1.5 });
    expect(body.need.basis).toBe('evapotranspiration');
    expect(body.plan).toMatchObject({ action: 'run', conditionalOnForecast: false, legalMaxEvents: 1, events: 1 });
    expect(body.plan.depthInches).toBeGreaterThanOrEqual(0.5);
    expect(body.plan.depthInches).toBeLessThanOrEqual(0.75);
    expect(body.restriction).toEqual({ label: ONE_DAY.label, maxDaysPerWeek: 1, source: ONE_DAY.source });
    expect(body.rulesUrl).toBe('https://www.swfwmd.state.fl.us/business/epermitting/district-water-restrictions');
    expect(body.landing).toBe('https://www.wavespestcontrol.com/tools/lawn-watering-calculator/');
    expect(body.brand).toBe('Waves Pest Control');
    expect(body.disclaimer).toMatch(/weather-based estimate, not a measurement/);
    expect(body.disclaimer).toMatch(/local watering rules always come first/);
    expect(body.text.headline).toMatch(/per turf zone|one full cycle per turf zone/);
    expect(body.text.action).toContain('your permitted watering day');
    expect(body.text.notes.join(' ')).toContain('one day a week');
  });

  test('net need is the engine\'s own: target less rain carryover, bounded at root-zone storage', () => {
    const body = compute({ grass: 'bahia', observed: { ...OBSERVED, rainInches: 1.6 } });
    const lastTarget = buildIrrigationAdvice({ grassType: 'bahia', month: 10, rainfallInches7d: 1.6, referenceEt0InchesWeek: OBSERVED.et0Inches }).recommendedInchesPerWeek;
    const engine = buildWeekPlan({
      targetInchesPerWeek: body.need.targetInches,
      lastWeekAppliedInches: null,
      lastWeekRainInches: 1.6,
      lastWeekTargetInches: lastTarget,
      forecastRainInches: 0.1,
      season: 'shoulder',
      restriction: ONE_DAY,
      rainOnlyCarryover: true,
    });
    expect(body.need.netInches).toBe(engine.needInches);
  });

  test('covered county, big rain week on a thirsty-light grass: hold, skip your turf watering', () => {
    const body = compute({ grass: 'bahia', observed: { ...OBSERVED, rainInches: 1.6 } });
    expect(body.plan).toMatchObject({ action: 'hold', events: 0, depthInches: null, conditionalOnForecast: false, legalMaxEvents: 1 });
    expect(body.text.headline).toMatch(/skip your turf watering/);
    expect(body.need.netInches).toBeLessThan(0.5);
  });

  test('forecast rain of a half inch or more: conditional on the forecast, leave the turf irrigation off for now', () => {
    const body = compute({ forecast: { ...FORECAST, rainInches: 0.8 } });
    expect(body.plan.action).toBe('run');
    expect(body.plan.conditionalOnForecast).toBe(true);
    expect(body.text.headline).toMatch(/check the rain before you water/);
    expect(body.text.action).toContain('Leave the turf irrigation off for now');
  });

  test('head type gives minutes per zone; the minutes you run now drive the comparison; none without a head', () => {
    const spray = compute({ head: 'spray', minutes: 10 });
    const rotor = compute({ head: 'rotor', minutes: 10 });
    const none = compute({ minutes: 10 });
    expect(spray.plan.minutesPerEvent).toBeGreaterThan(0);
    expect(rotor.plan.minutesPerEvent).toBeGreaterThan(spray.plan.minutesPerEvent);
    expect(spray.text.headline).toContain(`${spray.plan.minutesPerEvent} minutes per turf zone`);
    expect(spray.text.action).toMatch(/minutes more than you run now/);
    expect(none.plan.minutesPerEvent).toBeNull();
    expect(none.text.notes.join(' ')).toMatch(/about \d+ minutes on spray zones and \d+ on rotor zones/);
  });

  test('uncovered county (no policy): need_only, the week\'s need in inches, no event count, no legal maximum', () => {
    const body = compute({ policy: null });
    expect(body.plan).toEqual({
      action: 'need_only', events: null, depthInches: null, minutesPerEvent: null, conditionalOnForecast: false, legalMaxEvents: null,
    });
    expect(body.restriction).toBeNull();
    expect(body.need.targetInches).toBeGreaterThan(0);
    expect(body.text.headline).toMatch(/needs about .* of water this week/);
    expect(body.text.action).toContain('Water only on the days your county allows');
    expect(body.text.action).toContain(body.rulesUrl);
    expect(JSON.stringify(body)).not.toMatch(/maxDaysPerWeek|permitted watering day/);
  });

  test('head and minutes never invent a schedule when there is no policy', () => {
    const body = compute({ policy: null, head: 'spray', minutes: 20 });
    expect(body.plan.minutesPerEvent).toBeNull();
    expect(body.plan.events).toBeNull();
    expect(body.plan.legalMaxEvents).toBeNull();
  });

  test('a policy that bans lawn irrigation: hold with no override cycle', () => {
    const body = compute({ policy: { ...ONE_DAY, maxDaysPerWeek: 0 } });
    expect(body.plan).toMatchObject({ action: 'hold', events: 0, legalMaxEvents: 0 });
    expect(body.text.headline).toBe('This week: no lawn watering');
    expect(body.text.notes[0]).toMatch(/not permitted/);
  });

  test('fails soft: no forecast plans from observed rain with the seasonal need; no observed rain says so', () => {
    const noForecast = compute({ forecast: null });
    expect(noForecast.forecast).toBeNull();
    expect(noForecast.need.basis).toBe('seasonal');
    expect(noForecast.plan.action).toBe('run');
    expect(noForecast.text.notes.join(' ')).toContain('assumes a dry week');

    const noRain = compute({ observed: null });
    expect(noRain.rain).toEqual({ last7Inches: null, source: null });
    expect(noRain.plan.action).toBe('run');
    expect(noRain.text.notes.join(' ')).toContain('could not get the last 7 days of rainfall');
  });

  test('a forecast window shorter or longer than 7 days is scaled to a weekly need', () => {
    const week = compute({ forecast: { ...FORECAST, et0Inches: 1.4, days: 7 } });
    const partial = compute({ forecast: { ...FORECAST, et0Inches: 0.4, days: 2 } }); // 0.4 over 2 days = 1.4 a week
    expect(partial.need.targetInches).toBe(week.need.targetInches);
  });

  test('an unnamed grass says so; a named one does not; sensor adds its sentence', () => {
    expect(compute().text.notes.join(' ')).toContain('assumes St. Augustine');
    const bermuda = compute({ grass: 'bermuda', sensor: true });
    expect(bermuda.text.notes.join(' ')).not.toContain('assumes St. Augustine');
    expect(bermuda.text.notes.join(' ')).toContain('rain sensor will skip a run');
  });

  test('copy never names a weekday and uses the owner-approved phrases, in every plan shape', () => {
    const shapes = [
      compute(),
      compute({ head: 'spray', minutes: 20, sensor: true }),
      compute({ head: 'rotor' }),
      compute({ grass: 'bahia', observed: { ...OBSERVED, rainInches: 1.6 } }),
      compute({ forecast: { ...FORECAST, rainInches: 0.8 } }),
      compute({ forecast: null, observed: null }),
      compute({ policy: { ...ONE_DAY, maxDaysPerWeek: 2 } }),
      compute({ policy: { ...ONE_DAY, maxDaysPerWeek: 0 } }),
      compute({ policy: null }),
      compute({ policy: null, head: 'spray', minutes: 20 }),
    ];
    for (const body of shapes) {
      const text = allText(body);
      expect(text).not.toMatch(WEEKDAY);
      expect(text).not.toMatch(/each zone\b/);
      expect(text).not.toMatch(/controller/i);
    }
    expect(allText(shapes[3])).toMatch(/skip your turf watering/);
  });

  test('the week is Monday to Sunday: Monday starts today, Sunday looks ahead to the coming week', () => {
    expect(planWeekBounds(new Date('2026-10-26T14:00:00Z'))).toEqual({ start: '2026-10-26', end: '2026-11-01' });
    expect(planWeekBounds(NOW)).toEqual({ start: '2026-10-26', end: '2026-11-01' });
    expect(planWeekBounds(new Date('2026-10-31T14:00:00Z'))).toEqual({ start: '2026-10-26', end: '2026-11-01' });
    expect(planWeekBounds(new Date('2026-11-01T14:00:00Z'))).toEqual({ start: '2026-11-02', end: '2026-11-08' });
  });
});

describe('county -> water management district rules page', () => {
  test('every county in the curated location list resolves to a district page', () => {
    const counties = [...new Set(LOCATIONS.map((l) => l.county))];
    expect(counties.length).toBeGreaterThanOrEqual(14);
    for (const county of counties) {
      expect(svc._private.COUNTY_DISTRICT[county]).toBeTruthy();
      expect(rulesFor(county).url).toMatch(/^https:\/\//);
    }
  });

  test('district assignments', () => {
    const d = svc._private.COUNTY_DISTRICT;
    for (const c of ['Manatee', 'Sarasota', 'Charlotte', 'Hillsborough', 'Pinellas', 'Polk']) expect(d[c]).toBe('swfwmd');
    for (const c of ['Lee', 'Collier', 'Miami-Dade', 'Broward', 'Palm Beach']) expect(d[c]).toBe('sfwmd');
    for (const c of ['Orange', 'Duval']) expect(d[c]).toBe('sjrwmd');
    expect(d.Leon).toBe('nwfwmd');
  });
});

describe('parseWateringQuery', () => {
  test('location or zip is required; a slug resolves to its curated location and county', () => {
    expect(parseWateringQuery({}).error).toBe('location_required');
    const ok = parseWateringQuery({ location: 'sarasota-fl' });
    expect(ok.ok).toBe(true);
    expect(ok.value).toMatchObject({ county: 'Sarasota', policyCounty: 'Sarasota', grass: null, head: null, minutes: null, sensor: false });
    expect(ok.value.location.slug).toBe('sarasota-fl');
  });

  test('a ZIP takes its legal county from the ZIP itself, not from the nearest curated city', () => {
    const sarasotaZip = parseWateringQuery({ zip: '34231' });
    expect(sarasotaZip.value.location.slug).toBe('bradenton-fl'); // nearest curated weather point
    expect(sarasotaZip.value.policyCounty).toBe('Sarasota'); // the ZIP's own county
    expect(sarasotaZip.value.county).toBe('Sarasota');
    // A ZIP that straddles a county line fails closed.
    const straddle = parseWateringQuery({ zip: '34243' });
    expect(straddle.ok).toBe(true);
    expect(straddle.value.policyCounty).toBeNull();
    // A ZIP outside the supported Florida prefixes is refused, not answered with another place.
    expect(parseWateringQuery({ zip: '90210' }).error).toBe('unsupported_zip');
  });

  test('every optional param is validated strictly', () => {
    const base = { location: 'bradenton-fl' };
    expect(parseWateringQuery({ ...base, grass: 'bahia', head: 'rotor', minutes: '45', sensor: '1' }).value)
      .toMatchObject({ grass: 'bahia', head: 'rotor', minutes: 45, sensor: true });
    expect(parseWateringQuery({ ...base, grass: 'unknown' }).value.grass).toBeNull();
    expect(parseWateringQuery({ ...base, minutes: '45' }).value.minutes).toBeNull(); // no head: ignored
    expect(parseWateringQuery({ ...base, grass: '', head: ' ', minutes: '', sensor: '' }).ok).toBe(true); // blanks are absent

    const cases = [
      [{ location: 'Not A Slug!' }, 'invalid_location'],
      [{ location: 'atlantis-fl' }, 'unknown_location'],
      [{ location: ['a', 'b'] }, 'invalid_location'],
      [{ zip: '3420' }, 'invalid_zip'],
      [{ zip: '34205x' }, 'invalid_zip'],
      [{ zip: { a: 1 } }, 'invalid_zip'],
      [{ ...base, grass: 'fescue' }, 'invalid_grass'],
      [{ ...base, head: 'drip' }, 'invalid_head'],
      [{ ...base, head: 'spray', minutes: '0' }, 'invalid_minutes'],
      [{ ...base, head: 'spray', minutes: '241' }, 'invalid_minutes'],
      [{ ...base, head: 'spray', minutes: '12.5' }, 'invalid_minutes'],
      [{ ...base, head: 'spray', minutes: '-5' }, 'invalid_minutes'],
      [{ ...base, head: 'spray', minutes: 'abc' }, 'invalid_minutes'],
      [{ ...base, minutes: '999' }, 'invalid_minutes'], // validated even though it would be ignored
      [{ ...base, sensor: '2' }, 'invalid_sensor'],
      [{ ...base, sensor: 'true' }, 'invalid_sensor'],
    ];
    for (const [query, error] of cases) {
      const r = parseWateringQuery(query);
      expect([JSON.stringify(query), r.error]).toEqual([JSON.stringify(query), error]);
      expect(typeof r.message).toBe('string');
    }
  });
});

describe('getPublicWateringPlan: restriction policy and weather cache', () => {
  const POLICY_ENV = JSON.stringify({
    maxDaysPerWeek: 1,
    effectiveFrom: '2026-08-27',
    expiresOn: '2027-03-31',
    label: ONE_DAY.label,
    source: ONE_DAY.source,
    hoursNote: ONE_DAY.hoursNote,
    coverage: { counties: ['Manatee', 'Sarasota'], partial: ['Charlotte'] },
  });
  const savedPolicyEnv = process.env.IRRIGATION_RESTRICTION_POLICY;

  beforeEach(() => {
    jest.clearAllMocks();
    svc._private._clearCache();
    process.env.IRRIGATION_RESTRICTION_POLICY = POLICY_ENV;
    fetchServiceWeekWeather.mockResolvedValue({ ...OBSERVED, dailyRain: null, windowClosed: true });
    fetchUpcomingWeekForecast.mockResolvedValue(FORECAST);
  });
  afterAll(() => {
    if (savedPolicyEnv === undefined) delete process.env.IRRIGATION_RESTRICTION_POLICY;
    else process.env.IRRIGATION_RESTRICTION_POLICY = savedPolicyEnv;
  });

  test('covered Manatee: a full plan; asks for the 7 days ending yesterday and the plan week\'s Sunday', async () => {
    const r = await getPublicWateringPlan({ location: 'bradenton-fl' }, { now: NOW });
    expect(r.status).toBe('ok');
    expect(r.body.plan.legalMaxEvents).toBe(1);
    expect(fetchServiceWeekWeather).toHaveBeenCalledWith({ latitude: BRADENTON.lat, longitude: BRADENTON.lng, serviceDate: '2026-10-27' });
    expect(fetchUpcomingWeekForecast).toHaveBeenCalledWith({ latitude: BRADENTON.lat, longitude: BRADENTON.lng, horizonEnd: '2026-11-01', now: NOW });
  });

  test('Charlotte is partially covered: the policy fails closed to need_only', async () => {
    const r = await getPublicWateringPlan({ location: 'punta-gorda-fl' }, { now: NOW });
    expect(r.body.plan.action).toBe('need_only');
    expect(r.body.restriction).toBeNull();
    expect(r.body.plan.legalMaxEvents).toBeNull();
    expect(r.body.rulesUrl).toBe(rulesFor('Charlotte').url);
  });

  test('a county outside coverage (Hillsborough) is need_only with the district rules page', async () => {
    const r = await getPublicWateringPlan({ location: 'tampa-fl' }, { now: NOW });
    expect(r.body.plan.action).toBe('need_only');
    expect(r.body.location.county).toBe('Hillsborough');
  });

  test('a ZIP request judges the county by the ZIP: Sarasota ZIP is covered, a straddling ZIP is not', async () => {
    const sarasota = await getPublicWateringPlan({ zip: '34231' }, { now: NOW });
    expect(sarasota.body.location).toMatchObject({ slug: 'bradenton-fl', county: 'Sarasota' });
    expect(sarasota.body.plan.action).toBe('run');
    const straddle = await getPublicWateringPlan({ zip: '34243' }, { now: NOW });
    expect(straddle.body.plan.action).toBe('need_only');
  });

  test('a policy that ends inside the plan week does not cover it', async () => {
    process.env.IRRIGATION_RESTRICTION_POLICY = POLICY_ENV.replace('2027-03-31', '2026-10-30');
    const r = await getPublicWateringPlan({ location: 'bradenton-fl' }, { now: NOW });
    expect(r.body.plan.action).toBe('need_only');
    expect(r.body.restriction).toBeNull();
  });

  test('an invalid query is reported, with no weather fetch', async () => {
    const r = await getPublicWateringPlan({ location: 'bradenton-fl', grass: 'fescue' }, { now: NOW });
    expect(r).toMatchObject({ status: 'invalid', error: 'invalid_grass' });
    expect(fetchServiceWeekWeather).not.toHaveBeenCalled();
  });

  test('weather is cached per location until the earlier of 3 hours or ET midnight', async () => {
    const first = await getPublicWateringPlan({ location: 'bradenton-fl' }, { now: NOW });
    expect(first.freshUntil).toBe(NOW.getTime() + 3 * 3600 * 1000);
    await getPublicWateringPlan({ location: 'bradenton-fl', head: 'spray' }, { now: new Date(NOW.getTime() + 2 * 3600 * 1000) });
    expect(fetchServiceWeekWeather).toHaveBeenCalledTimes(1);
    // another location is its own entry
    await getPublicWateringPlan({ location: 'venice-fl' }, { now: NOW });
    expect(fetchServiceWeekWeather).toHaveBeenCalledTimes(2);
    // past the 3 hours: fetched again
    await getPublicWateringPlan({ location: 'bradenton-fl' }, { now: new Date(NOW.getTime() + 3 * 3600 * 1000 + 1) });
    expect(fetchServiceWeekWeather).toHaveBeenCalledTimes(3);
  });

  test('never fresh past the next ET midnight, when yesterday and the plan week move', async () => {
    const lateEvening = new Date('2026-10-29T02:30:00Z'); // 10:30 PM ET on Oct 28; ET midnight is 04:00Z
    const r = await getPublicWateringPlan({ location: 'bradenton-fl' }, { now: lateEvening });
    expect(r.freshUntil).toBe(new Date('2026-10-29T04:00:00Z').getTime());
  });

  test('concurrent misses for one location share a single in-flight fetch', async () => {
    let release;
    fetchServiceWeekWeather.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ ...OBSERVED }); }));
    const calls = [1, 2, 3, 4, 5].map(() => getPublicWateringPlan({ location: 'bradenton-fl' }, { now: NOW }));
    await new Promise((r) => setImmediate(r));
    release();
    const results = await Promise.all(calls);
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(fetchServiceWeekWeather).toHaveBeenCalledTimes(1);
    expect(fetchUpcomingWeekForecast).toHaveBeenCalledTimes(1);
  });

  test('fails soft: a failed forecast plans from observed rain and retries sooner', async () => {
    fetchUpcomingWeekForecast.mockResolvedValue(null);
    const r = await getPublicWateringPlan({ location: 'bradenton-fl' }, { now: NOW });
    expect(r.status).toBe('ok');
    expect(r.body.forecast).toBeNull();
    expect(r.body.rain.last7Inches).toBe(0.3);
    expect(r.freshUntil).toBe(NOW.getTime() + 15 * 60 * 1000);
  });

  test('fails soft: a thrown observed lookup plans from the forecast', async () => {
    fetchServiceWeekWeather.mockRejectedValue(new Error('IEM down'));
    const r = await getPublicWateringPlan({ location: 'bradenton-fl' }, { now: NOW });
    expect(r.status).toBe('ok');
    expect(r.body.rain.last7Inches).toBeNull();
    expect(r.body.forecast).not.toBeNull();
  });

  test('no weather at all is unavailable, retried after a minute rather than cached for hours', async () => {
    fetchServiceWeekWeather.mockResolvedValue({ rainInches: null, et0Inches: null, rainSource: null });
    fetchUpcomingWeekForecast.mockRejectedValue(new Error('Open-Meteo down'));
    const r = await getPublicWateringPlan({ location: 'bradenton-fl' }, { now: NOW });
    expect(r).toEqual({ status: 'unavailable' });
    fetchServiceWeekWeather.mockResolvedValue({ ...OBSERVED });
    fetchUpcomingWeekForecast.mockResolvedValue(FORECAST);
    const soon = await getPublicWateringPlan({ location: 'bradenton-fl' }, { now: new Date(NOW.getTime() + 61 * 1000) });
    expect(soon.status).toBe('ok');
  });
});
