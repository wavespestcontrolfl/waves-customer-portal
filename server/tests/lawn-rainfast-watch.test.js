// GATE_LAWN_RAINFAST_WATCH (lawn report rebuild P31): measured rain of at least
// 0.25 inch inside a product's stated rainfast interval records ONE retreat-check
// on the frozen visit memory and adds ONE fixed Watching sentence on the live
// view. Pure module + the real Open-Meteo hour math (HTTP mocked) + the memory
// write against an in-memory table. Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const featureGates = require('../config/feature-gates');
const { fetchPropertyForecast } = require('../services/service-report/application-conditions');
const {
  RAINFAST_WATCH_LINE, rainfastWindows, judgeRainfastBreach, validRetreatCheck, resolveRainfastWatch,
} = require('../services/service-report/lawn-rainfast-watch');
const { deriveLawnLead, LEAD_WORD_BUDGET, leadWords } = require('../services/service-report/lawn-report-lead');
const {
  buildSinceLast, publicSinceLast, storedVisitMemoryFor, recordRetreatCheck,
} = require('../services/service-report/lawn-visit-memory');

const HOUR = 3600000;
const COMPLETED = '2026-09-10T14:20:00Z'; // 10:20 AM ET
const product = (name, rainfastMinutes) => ({ product_name: name, approved_report_product_facts: { rainfastMinutes } });
const SPRAY = product('Test Herbicide A', 180);

describe('rainfastWindows: only a stated interval is judged', () => {
  test('products with no usable interval are skipped; equal intervals group; the list is ordered', () => {
    expect(rainfastWindows([
      product('No Interval', null),
      product('Zero', 0),
      product('Negative', -30),
      product('Text', 'soon'),
      { product_name: 'No Facts' },
      { product_name: 'Unapproved', approved_report_product_facts: null },
      product('Too Long', 100000),
      product('Test Herbicide A', 180),
      product('Test Growth Regulator', 60),
      product('Test Iron', 60),
    ])).toEqual([
      { minutes: 60, products: ['Test Growth Regulator', 'Test Iron'] },
      { minutes: 180, products: ['Test Herbicide A'] },
    ]);
    expect(rainfastWindows(null)).toEqual([]);
    expect(rainfastWindows([])).toEqual([]);
  });
});

describe('the customer sentence', () => {
  test('is fixed, short, and claims no more than the source: no number, no product, no promise of a free visit', () => {
    expect(RAINFAST_WATCH_LINE).toBe('Our weather data shows rain soon after your treatment, so we will re-check it at your next visit.');
    expect(RAINFAST_WATCH_LINE.split(/\s+/).length).toBeLessThanOrEqual(20);
    expect(RAINFAST_WATCH_LINE).not.toMatch(/\d|%|percent|chance|free|guarantee|no charge|redo|re-?treat|on your lawn|washed/i);
  });
});

// A mocked Open-Meteo hourly payload: `rain` maps an hour stamp (ISO, end of the
// hour) to inches; every other hour in the span reads 0.
function mockMeteo(rain, { dropHour = null } = {}) {
  const start = Date.parse('2026-09-09T00:00:00Z');
  const times = [];
  const precipitation = [];
  for (let t = start; t <= start + 72 * HOUR; t += HOUR) {
    if (dropHour && new Date(t).toISOString() === dropHour) { times.push(t / 1000); precipitation.push(null); continue; }
    times.push(t / 1000);
    precipitation.push(rain[new Date(t).toISOString()] || 0);
  }
  return {
    ok: true,
    json: async () => ({ hourly: { time: times, precipitation, temperature_2m: times.map(() => 80) } }),
  };
}
let lonSeed = 0;
const coords = () => { lonSeed += 1; return { latitude: 27.3, longitude: -82.4 - lonSeed / 1000 }; };
const NOW = new Date('2026-09-10T20:00:00Z'); // interval ended 17:20Z, 2 h 40 min ago

describe('judgeRainfastBreach with the real Open-Meteo hour math', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const judge = (over = {}) => judgeRainfastBreach({
    products: [SPRAY], completedAt: COMPLETED, now: NOW, ...coords(), fetchForecast: fetchPropertyForecast, ...over,
  });

  test('0.25 inch or more inside the interval is a breach; only the whole hours inside the window count', async () => {
    // 10:20 to 13:20 ET: the whole hours inside are the ones stamped 12:00 and 13:00 ET (16:00Z, 17:00Z).
    global.fetch = jest.fn(async () => mockMeteo({ '2026-09-10T16:00:00.000Z': 0.15, '2026-09-10T17:00:00.000Z': 0.1 }));
    const item = await judge();
    expect(item).toMatchObject({
      v: 1, kind: 'rainfast_breach', source: 'open_meteo', windowFrom: '2026-09-10T14:20:00.000Z',
      breaches: [{ minutes: 180, inches: 0.25, windowTo: '2026-09-10T17:20:00.000Z', products: ['Test Herbicide A'] }],
    });
    expect(validRetreatCheck(item)).toBe(true);
  });

  test('just under 0.25 inch is not a breach', async () => {
    global.fetch = jest.fn(async () => mockMeteo({ '2026-09-10T16:00:00.000Z': 0.15, '2026-09-10T17:00:00.000Z': 0.09 }));
    await expect(judge()).resolves.toBeNull();
  });

  test('rain in the hour that holds the completion minute, or after the interval, is not counted', async () => {
    global.fetch = jest.fn(async () => mockMeteo({
      '2026-09-10T15:00:00.000Z': 0.6, // 14:00-15:00Z: partly before completion
      '2026-09-10T18:00:00.000Z': 0.6, // 17:00-18:00Z: runs past 17:20Z
    }));
    await expect(judge()).resolves.toBeNull();
  });

  test('an hour with no reading inside the window is unknown, never zero: no item', async () => {
    global.fetch = jest.fn(async () => mockMeteo({ '2026-09-10T16:00:00.000Z': 0.5 }, { dropHour: '2026-09-10T17:00:00.000Z' }));
    await expect(judge()).resolves.toBeNull();
  });

  test('a 60-minute interval that starts off the hour has no whole hour inside it: never judged', async () => {
    global.fetch = jest.fn(async () => mockMeteo({ '2026-09-10T15:00:00.000Z': 0.9, '2026-09-10T16:00:00.000Z': 0.9 }));
    await expect(judge({ products: [product('Test Iron', 60)] })).resolves.toBeNull();
  });

  test('a 60-minute interval that starts on the hour is judged on the one hour inside it', async () => {
    global.fetch = jest.fn(async () => mockMeteo({ '2026-09-10T15:00:00.000Z': 0.3 }));
    const item = await judge({ completedAt: '2026-09-10T14:00:00Z', products: [product('Test Iron', 60)] });
    expect(item.breaches).toEqual([expect.objectContaining({ minutes: 60, inches: 0.3 })]);
  });

  test('a failed, slow or malformed weather read is no item', async () => {
    global.fetch = jest.fn(async () => ({ ok: false }));
    await expect(judge()).resolves.toBeNull();
    global.fetch = jest.fn(async () => { throw new Error('network'); });
    await expect(judge()).resolves.toBeNull();
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ nothing: true }) }));
    await expect(judge()).resolves.toBeNull();
  });

  test('missing coordinates or completion time is no item and no weather call', async () => {
    global.fetch = jest.fn(async () => mockMeteo({ '2026-09-10T16:00:00.000Z': 0.9, '2026-09-10T17:00:00.000Z': 0.9 }));
    await expect(judge({ latitude: null, longitude: null })).resolves.toBeNull();
    await expect(judge({ latitude: 0, longitude: 0 })).resolves.toBeNull();
    await expect(judge({ completedAt: null })).resolves.toBeNull();
    await expect(judge({ completedAt: 'not a time' })).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('not judged until an hour after the interval ended, and not after seven days', async () => {
    global.fetch = jest.fn(async () => mockMeteo({ '2026-09-10T16:00:00.000Z': 0.5, '2026-09-10T17:00:00.000Z': 0.5 }));
    await expect(judge({ now: new Date('2026-09-10T17:00:00Z') })).resolves.toBeNull(); // still inside the interval
    await expect(judge({ now: new Date('2026-09-10T18:19:00Z') })).resolves.toBeNull(); // ended 59 min ago
    expect(global.fetch).not.toHaveBeenCalled();
    await expect(judge({ now: new Date('2026-09-18T00:00:00Z') })).resolves.toBeNull(); // past the look-back
    expect(global.fetch).not.toHaveBeenCalled();
    await expect(judge({ now: new Date('2026-09-10T18:20:00Z') })).resolves.toMatchObject({ kind: 'rainfast_breach' });
  });

  test('no product with a stated interval: no weather call', async () => {
    global.fetch = jest.fn();
    await expect(judge({ products: [product('No Interval', null), { product_name: 'Bare' }] })).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('two intervals are judged separately; only the breached one is listed', async () => {
    global.fetch = jest.fn(async () => mockMeteo({ '2026-09-10T16:00:00.000Z': 0.3 }));
    const item = await judge({ completedAt: '2026-09-10T14:00:00Z', products: [SPRAY, product('Test Iron', 60)] });
    // 14:00 to 15:00Z holds one hour (stamp 15:00Z, 0 in): clear. 14:00 to 17:00Z holds three hours (0.3 at 16:00Z).
    expect(item.breaches).toEqual([expect.objectContaining({ minutes: 180, inches: 0.3, products: ['Test Herbicide A'] })]);
  });
});

// In-memory service_records with the compare-and-set semantics recordRetreatCheck
// relies on (the real SQL runs in lawn-visit-memory-postgres.test.js).
function memoryKnex(record, { failUpdate = false } = {}) {
  const log = { reads: 0, updates: 0 };
  const knex = () => {
    let binding = null;
    const chain = {
      where() { return chain; },
      whereRaw(_sql, bindings) { binding = bindings; return chain; },
      async first() { log.reads += 1; return { structured_notes: JSON.stringify(record.structured_notes) }; },
      async update(patch) {
        if (failUpdate) throw new Error('update failed');
        const [assessmentId, expected] = binding;
        const map = record.structured_notes.lawnVisitMemory || {};
        if (JSON.stringify(canon(map[assessmentId])) !== JSON.stringify(canon(JSON.parse(expected)))) return 0;
        const add = JSON.parse(patch.structured_notes.bindings[0]);
        record.structured_notes = { ...record.structured_notes, lawnVisitMemory: { ...map, ...add } };
        log.updates += 1;
        return 1;
      },
    };
    return chain;
  };
  knex.raw = (sql, bindings) => ({ __raw: sql, bindings });
  return { knex, log };
}
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o; }, {});
  return v;
}
const ENTRY = { v: 1, assessmentId: 'la-1', serviceDate: '2026-09-10', applied: [], checks: [], sinceLast: null };
const ITEM = {
  v: 1, kind: 'rainfast_breach', source: 'open_meteo', windowFrom: '2026-09-10T14:20:00.000Z',
  breaches: [{ minutes: 180, inches: 0.4, windowTo: '2026-09-10T17:20:00.000Z', products: ['Test Herbicide A'] }],
  recordedAt: '2026-09-10T20:00:00.000Z',
};

describe('resolveRainfastWatch: judge once, record once, replay after', () => {
  const run = (record, knex, over = {}) => resolveRainfastWatch({
    structuredNotes: record.structured_notes, serviceRecordId: 'svc-1', assessmentId: 'la-1', products: [SPRAY],
    completedAt: COMPLETED, now: NOW, latitude: 27.3, longitude: -82.4, knex, fetchForecast: over.fetchForecast, ...over,
  });
  const breachFetch = () => jest.fn(async () => ({ status: 'ok', precipitationInTotal: 0.4, fetchedAt: '2026-09-10T20:00:00.000Z' }));

  test('a measured breach is recorded on the entry and the sentence returned; the next view replays it with no weather call', async () => {
    const record = { structured_notes: { lawnVisitMemory: { 'la-1': ENTRY }, other: 'kept' } };
    const { knex, log } = memoryKnex(record);
    const fetchForecast = breachFetch();
    await expect(run(record, knex, { fetchForecast })).resolves.toEqual({ line: RAINFAST_WATCH_LINE });
    expect(fetchForecast).toHaveBeenCalledTimes(1);
    expect(log.updates).toBe(1);
    const stored = storedVisitMemoryFor(record.structured_notes, 'la-1');
    expect(stored.retreatCheck).toMatchObject({ kind: 'rainfast_breach', breaches: [{ minutes: 180, inches: 0.4, products: ['Test Herbicide A'] }] });
    expect(record.structured_notes.other).toBe('kept');
    // second view: replay, no fetch, no write
    const again = breachFetch();
    await expect(run(record, knex, { fetchForecast: again })).resolves.toEqual({ line: RAINFAST_WATCH_LINE });
    expect(again).not.toHaveBeenCalled();
    expect(log.updates).toBe(1);
  });

  test('two views that both measured it end with one stored item and both say the sentence', async () => {
    const record = { structured_notes: { lawnVisitMemory: { 'la-1': ENTRY } } };
    const { knex, log } = memoryKnex(record);
    const stale = JSON.parse(JSON.stringify(record.structured_notes)); // both views started from the same read
    const results = await Promise.all([
      run({ structured_notes: stale }, knex, { fetchForecast: breachFetch() }),
      run({ structured_notes: stale }, knex, { fetchForecast: breachFetch() }),
    ]);
    expect(results).toEqual([{ line: RAINFAST_WATCH_LINE }, { line: RAINFAST_WATCH_LINE }]);
    expect(log.updates).toBe(1);
  });

  test('no frozen entry: nothing is said and nothing is fetched (the verdict would have nowhere to live)', async () => {
    const record = { structured_notes: {} };
    const { knex, log } = memoryKnex(record);
    const fetchForecast = breachFetch();
    await expect(run(record, knex, { fetchForecast })).resolves.toBeNull();
    expect(fetchForecast).not.toHaveBeenCalled();
    expect(log.updates).toBe(0);
  });

  test('a failed write says nothing (a sentence that could vanish on the next view is worse than none)', async () => {
    const record = { structured_notes: { lawnVisitMemory: { 'la-1': ENTRY } } };
    const { knex } = memoryKnex(record, { failUpdate: true });
    await expect(run(record, knex, { fetchForecast: breachFetch() })).resolves.toBeNull();
    expect(storedVisitMemoryFor(record.structured_notes, 'la-1').retreatCheck).toBeUndefined();
  });

  test('below the threshold or a missing hour: no item, no sentence, no write', async () => {
    const record = { structured_notes: { lawnVisitMemory: { 'la-1': ENTRY } } };
    const { knex, log } = memoryKnex(record);
    await expect(run(record, knex, { fetchForecast: jest.fn(async () => ({ status: 'ok', precipitationInTotal: 0.24 })) })).resolves.toBeNull();
    await expect(run(record, knex, { fetchForecast: jest.fn(async () => ({ status: 'ok', precipitationInTotal: null })) })).resolves.toBeNull();
    await expect(run(record, knex, { fetchForecast: jest.fn(async () => ({ status: 'unavailable', reason: 'timeout' })) })).resolves.toBeNull();
    await expect(run(record, knex, { fetchForecast: jest.fn(async () => { throw new Error('boom'); }) })).resolves.toBeNull();
    expect(log.updates).toBe(0);
  });

  test('a stored item of an unknown shape is ignored, never repaired and never re-judged', async () => {
    const record = { structured_notes: { lawnVisitMemory: { 'la-1': { ...ENTRY, retreatCheck: { v: 2, kind: 'other' } } } } };
    const { knex } = memoryKnex(record);
    const fetchForecast = breachFetch();
    await expect(run(record, knex, { fetchForecast })).resolves.toBeNull();
    expect(fetchForecast).not.toHaveBeenCalled();
  });
});

describe('the visit memory carries the item to the next visit', () => {
  const priorVisit = { assessmentId: 'la-1', date: '2026-09-10' };
  test('buildSinceLast adds retreatCheck only when the prior entry has one; the public block never shows it', () => {
    const plain = buildSinceLast({ priorVisit, priorMemory: { ...ENTRY, checks: [{ key: 'weeds', status: 'watch' }] } });
    expect(plain).not.toHaveProperty('retreatCheck');
    expect(publicSinceLast(plain)).toBe(plain); // same object: byte-identical when there is no item

    const withItem = buildSinceLast({ priorVisit, priorMemory: { ...ENTRY, checks: [{ key: 'weeds', status: 'watch' }], retreatCheck: ITEM } });
    expect(withItem.retreatCheck).toEqual(ITEM);
    const pub = publicSinceLast(withItem);
    expect(pub).not.toHaveProperty('retreatCheck');
    expect(pub.checks).toEqual([{ key: 'weeds', status: 'watch' }]);
    expect(JSON.stringify(pub)).not.toMatch(/rainfast|retreat/);
  });

  test('recordRetreatCheck never creates an entry and refuses a bad call', async () => {
    const record = { structured_notes: {} };
    const { knex, log } = memoryKnex(record);
    await expect(recordRetreatCheck('svc-1', 'la-1', ITEM, knex)).resolves.toBeNull();
    await expect(recordRetreatCheck(null, 'la-1', ITEM, knex)).resolves.toBeNull();
    await expect(recordRetreatCheck('svc-1', 'la-1', null, knex)).resolves.toBeNull();
    expect(log.updates).toBe(0);
  });
});

describe('the Watching line on the lead', () => {
  const reportV2 = (extra = {}) => ({
    snapshot: { statusHeadline: 'Looking steady', rootCause: null, scoreExplanation: null, treatmentSummary: 'We applied a weed control treatment.' },
    insights: [],
    banner: null,
    ...extra,
  });

  test('no rainfast carrier: the lead is exactly what it was', () => {
    const base = deriveLawnLead(reportV2(), { copyV6: { headline: null, whatWeDid: 'We applied a weed control treatment.', whatToExpect: null, watching: 'We are also keeping an eye on watering.' } });
    expect(deriveLawnLead(reportV2(), { copyV6: { headline: null, whatWeDid: 'We applied a weed control treatment.', whatToExpect: null, watching: 'We are also keeping an eye on watering.' }, rainfastWatch: null })).toEqual(base);
    expect(base.watching).toBe('We are also keeping an eye on watering.');
  });

  test('the sentence is the Watching line alone, or follows the writer sentence', () => {
    const copyV6 = { headline: null, whatWeDid: 'We applied a weed control treatment.', whatToExpect: null, watching: null };
    expect(deriveLawnLead(reportV2(), { copyV6, rainfastWatch: { line: RAINFAST_WATCH_LINE } }).watching).toBe(RAINFAST_WATCH_LINE);
    expect(deriveLawnLead(reportV2(), { rainfastWatch: { line: RAINFAST_WATCH_LINE } }).watching).toBe(RAINFAST_WATCH_LINE);
    const both = deriveLawnLead(reportV2(), { copyV6: { ...copyV6, watching: 'We are also keeping an eye on weed pressure.' }, rainfastWatch: { line: RAINFAST_WATCH_LINE } });
    expect(both.watching).toBe(`We are also keeping an eye on weed pressure. ${RAINFAST_WATCH_LINE}`);
  });

  test('only the exact module sentence is accepted; any other text is ignored', () => {
    expect(deriveLawnLead(reportV2(), { rainfastWatch: { line: 'Rain ruined your treatment.' } })).not.toHaveProperty('watching');
    expect(deriveLawnLead(reportV2(), { rainfastWatch: {} })).not.toHaveProperty('watching');
    expect(deriveLawnLead(reportV2(), { rainfastWatch: 'x' })).not.toHaveProperty('watching');
  });

  test('it gives no watering advice, so a watering banner does not hide it; the word budget still holds', () => {
    const banner = { state: 'hold', lines: ['Hold off on watering for 24 hours.'] };
    const lead = deriveLawnLead(reportV2({ banner }), { rainfastWatch: { line: RAINFAST_WATCH_LINE } });
    expect(lead.watching).toBe(RAINFAST_WATCH_LINE);
    expect(leadWords({ ...reportV2({ banner }), lead })).toBeLessThanOrEqual(LEAD_WORD_BUDGET);
    // over budget: Watching is given up whole, like any other writer line
    const crowdedBanner = { state: 'hold', lines: [Array.from({ length: 235 }, () => 'alpha').join(' ')] };
    const crowded = deriveLawnLead(reportV2({ banner: crowdedBanner }), { rainfastWatch: { line: RAINFAST_WATCH_LINE } });
    expect(crowded).not.toHaveProperty('watching');
  });
});

describe('the gate', () => {
  const ENV = ['GATE_LAWN_RAINFAST_WATCH', 'GATE_LAWN_VISIT_MEMORY'];
  const saved = {};
  beforeEach(() => { ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); });
  afterEach(() => { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

  test('ships dark, is read at call time, and needs the visit memory it writes onto', () => {
    expect(featureGates.lawnRainfastWatchLive()).toBe(false);
    process.env.GATE_LAWN_RAINFAST_WATCH = 'true';
    expect(featureGates.lawnRainfastWatchLive()).toBe(false);
    process.env.GATE_LAWN_VISIT_MEMORY = 'true';
    expect(featureGates.lawnRainfastWatchLive()).toBe(true);
    delete process.env.GATE_LAWN_RAINFAST_WATCH;
    expect(featureGates.lawnRainfastWatchLive()).toBe(false);
  });
});
