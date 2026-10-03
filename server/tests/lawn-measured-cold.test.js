// GATE_LAWN_MEASURED_COLD (lawn report rebuild P36): the seasonal-dip sentence
// prints only when >= 2 of the 7 ET nights before the VISIT's day were 55F or
// colder. Pure rule, the nightly-low fetch, the freeze, the report payload with
// the gate off and on, the PDF key stamp, the tip lift and the opt-in wiring.
// Synthetic data only; the weather provider is mocked.

jest.mock('../services/lawn-assessment-history', () => ({
  installedForVisit: jest.fn(),
  historyForReport: jest.fn(),
  historyForAssessment: jest.fn(),
  restrictVisitHistory: (query) => query,
}));
jest.mock('../services/llm/call', () => {
  const actual = jest.requireActual('../services/llm/call');
  return { ...actual, dispatchWithFallback: jest.fn() };
});
jest.mock('../services/service-report/application-conditions', () => {
  const actual = jest.requireActual('../services/service-report/application-conditions');
  return { ...actual, fetchNightlyMinsF: jest.fn() };
});

const fs = require('fs');
const path = require('path');
const history = require('../services/lawn-assessment-history');
const { dispatchWithFallback } = require('../services/llm/call');
const conditions = require('../services/service-report/application-conditions');
const seasonality = require('../services/service-report/lawn-seasonality');
const {
  storedMeasuredColdFor, resolveVisitMeasuredCold, readMeasuredCold,
} = require('../services/service-report/lawn-measured-cold');
const { buildReportV1Data, resolveCanonicalLawnRender } = require('../services/service-report/report-data');
const { tipsForVisit, measuredColdLiftApplies } = require('../services/service-report/tip-library');
const { ISSUE_ROWS } = require('../config/lawn-expectations');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const DIP = ISSUE_ROWS.seasonal_dip.visibleChange;
const NO_DIP_CLAUSE = /often returns as nights warm/;

const FAIL = Symbol('table read fails');
function makeKnex(fixtures) {
  const knex = (table) => {
    const failing = fixtures[table] === FAIL;
    let rows = failing ? [] : [...(fixtures[table] || [])];
    const sortKeys = [];
    const q = {};
    const applySort = () => {
      rows = [...rows].sort((a, b) => {
        for (const { col, dir } of sortKeys) {
          const cmp = String(a[col] ?? '').localeCompare(String(b[col] ?? ''));
          if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    };
    Object.assign(q, {
      select: () => q,
      leftJoin: () => q,
      modify(fn) { fn(q); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      where(a, b, c) {
        if (typeof a === 'function') return q;
        if (a && typeof a === 'object') {
          rows = rows.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        } else if (arguments.length === 2) {
          rows = rows.filter((r) => r[a] === b);
        } else if (arguments.length === 3) {
          rows = rows.filter((r) => {
            const left = String(r[a] ?? '');
            const right = String(c);
            if (b === '>') return left > right;
            if (b === '>=') return left >= right;
            if (b === '<') return left < right;
            if (b === '<=') return left <= right;
            return true;
          });
        }
        return q;
      },
      andWhere(a, b, c) {
        if (typeof a === 'function') {
          // the lawn/turf service-type scope: whereRaw('LOWER(service_type) LIKE ?')
          const likes = [];
          const sub = {
            whereRaw(_sql, params) { likes.push(String(params[0]).replace(/%/g, '').toLowerCase()); return sub; },
            orWhereRaw(_sql, params) { likes.push(String(params[0]).replace(/%/g, '').toLowerCase()); return sub; },
          };
          a(sub);
          if (likes.length) {
            rows = rows.filter((r) => likes.some((needle) => String(r.service_type || '').toLowerCase().includes(needle)));
          }
          return q;
        }
        return q.where(a, b, c);
      },
      whereIn(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      whereNot(a, b) {
        if (a && typeof a === 'object') rows = rows.filter((r) => !Object.entries(a).every(([k, v]) => r[k] === v));
        else rows = rows.filter((r) => r[a] !== b);
        return q;
      },
      whereNotNull(col) { rows = rows.filter((r) => r[col] != null); return q; },
      whereNull(col) { rows = rows.filter((r) => r[col] == null); return q; },
      orderBy(col, dir = 'asc') { sortKeys.push({ col, dir }); applySort(); return q; },
      first() { return failing ? Promise.reject(new Error('read failed')) : Promise.resolve(rows[0] || null); },
      columnInfo: () => Promise.resolve({}),
      catch: (fn) => (failing ? Promise.resolve(fn(new Error('read failed'))) : Promise.resolve(rows)),
      then: (resolve, reject) => (failing ? Promise.reject(new Error('read failed')) : Promise.resolve(rows)).then(resolve, reject),
    });
    return q;
  };
  knex.raw = (sql) => sql;
  return knex;
}



// service_records: an in-memory table with the freeze's semantics for the
// measured-cold key (the real SQL is the same shape as the week-weather freeze);
// every other freeze (week weather, visit memory...) is out of scope here.
function withRecords(fixtures, records, hooks = {}) {
  const generic = makeKnex(fixtures);
  const log = { reads: 0, updates: [] };
  const knex = (table) => {
    if (table !== 'service_records') return generic(table);
    const ctx = { where: {}, binding: null };
    const chain = {
      where(cond) { Object.assign(ctx.where, cond); return chain; },
      whereRaw(_sql, bindings) { ctx.binding = bindings?.[0] ?? null; return chain; },
      async update(patch) {
        const sql = patch.structured_notes?.__raw || '';
        if (!sql.includes('lawnMeasuredCold')) return 1;
        if (hooks.failUpdate) throw new Error('update failed');
        const rec = records[ctx.where.id];
        if (!rec) return 0;
        const map = (rec.structured_notes && rec.structured_notes.lawnMeasuredCold) || {};
        if (map[ctx.binding] != null) return 0;
        const add = JSON.parse(patch.structured_notes.bindings[0]);
        rec.structured_notes = { ...rec.structured_notes, lawnMeasuredCold: { ...map, ...add } };
        log.updates.push(add);
        return 1;
      },
      async first() {
        log.reads += 1;
        const rec = records[ctx.where.id];
        return rec ? { structured_notes: rec.structured_notes } : undefined;
      },
    };
    return chain;
  };
  knex.raw = (sql, bindings) => ({ __raw: sql, bindings });
  return { knex, log };
}

describe('the pure rule', () => {
  const { coldNightsInTrailingWeek, measuredColdMet, trailingNightDates, measuredColdApplies } = seasonality;
  const nights = (...v) => v;

  test('counts nights at or below 55F; 55 itself is cold, 56 is not', () => {
    expect(coldNightsInTrailingWeek(nights(55, 56, 54, 70, 70, 70, 70))).toEqual({ cold: 2, known: 7, missing: 0 });
  });
  test('two cold nights is met; one is not; the boundary is exactly two', () => {
    expect(measuredColdMet(nights(50, 54, 70, 70, 70, 70, 70))).toBe(true);
    expect(measuredColdMet(nights(50, 56, 70, 70, 70, 70, 70))).toBe(false);
  });
  test('a missing night is a missing night, never 0F (Number(null) would be a freezing night)', () => {
    expect(coldNightsInTrailingWeek([null, undefined, '', NaN, 'cold', 70, 70])).toEqual({ cold: 0, known: 2, missing: 5 });
    expect(measuredColdMet([null, null, null, null, null, null, null])).toBeNull();
  });
  test('unknown unless proven: missing nights with fewer than 2 cold is null, not false', () => {
    expect(measuredColdMet(nights(50, 70, 70, 70, 70, 70, null))).toBeNull();
    expect(measuredColdMet(nights(50, 70, 70, 70))).toBeNull();
    expect(measuredColdMet([])).toBeNull();
    expect(measuredColdMet(undefined)).toBeNull();
  });
  test('two cold nights is a fact even when other nights are missing', () => {
    expect(measuredColdMet(nights(50, 50, null, null, null, null, null))).toBe(true);
  });
  test('only the last 7 readings count', () => {
    expect(measuredColdMet(nights(40, 40, 70, 70, 70, 70, 70, 70, 70))).toBe(false);
  });
  test('the nights are the 7 ET calendar days BEFORE the visit day, oldest first, across a month and year boundary', () => {
    expect(trailingNightDates('2026-11-08')).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
    expect(trailingNightDates('2027-01-03')[0]).toBe('2026-12-27');
    expect(trailingNightDates('2027-01-03')[6]).toBe('2027-01-02');
    expect(trailingNightDates('not a day')).toBeNull();
    expect(trailingNightDates(undefined)).toBeNull();
  });
  test('the clock never decides: the same visit day gives the same nights today and in a year', () => {
    jest.useFakeTimers().setSystemTime(new Date('2030-06-01T12:00:00Z'));
    try { expect(trailingNightDates('2026-11-08')[6]).toBe('2026-11-07'); } finally { jest.useRealTimers(); }
  });
  test('the rule only applies to the cooler calendar: Mar-Apr and Oct-Feb, never May-Sep', () => {
    ['2026-10-01', '2026-11-30', '2026-12-15', '2027-01-10', '2027-02-28', '2026-03-01', '2026-04-30'].forEach((d) => expect(measuredColdApplies(d)).toBe(true));
    ['2026-05-01', '2026-07-15', '2026-09-30'].forEach((d) => expect(measuredColdApplies(d)).toBe(false));
    expect(measuredColdApplies('')).toBe(false);
  });
  test('the cross-season notes drop only the returns clause when the dip claim is not measured', () => {
    expect(seasonality.crossSeasonNote('2026-07-01', '2026-01-10')).toMatch(NO_DIP_CLAUSE);
    expect(seasonality.crossSeasonNote('2026-07-01', '2026-01-10', { dipClaim: false })).toBe('Most of the color difference here is seasonal — St. Augustine slows and colors off in the cooler months.');
    expect(seasonality.crossSeasonNoteFromSeasons('peak', 'dormant', { dipClaim: false })).toBe('Most of the change across these visits is seasonal — color naturally dips in the cooler months.');
  });
});

describe('fetchNightlyMinsF (the real fetcher, provider mocked)', () => {
  const real = jest.requireActual('../services/service-report/application-conditions');
  const dates = seasonality.trailingNightDates('2026-11-08');
  const okJson = (mins) => ({ ok: true, json: async () => ({ daily: { time: dates, temperature_2m_min: mins } }) });
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('reads the archive, keeps null as null (never 0), and does not fetch for a failed geocode', async () => {
    global.fetch = jest.fn(async () => okJson([50, 52, 60, 61, 62, 63, 64]));
    const nights = await real.fetchNightlyMinsF({ latitude: 27.1234, longitude: -82.4321, dates });
    expect(nights.map((n) => n.minF)).toEqual([50, 52, 60, 61, 62, 63, 64]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(String(global.fetch.mock.calls[0][0])).toMatch(/archive-api\.open-meteo\.com/);
    global.fetch = jest.fn();
    expect(await real.fetchNightlyMinsF({ latitude: 0, longitude: 0, dates })).toBeNull();
    expect(await real.fetchNightlyMinsF({ latitude: null, longitude: -82, dates })).toBeNull();
    expect(await real.fetchNightlyMinsF({ latitude: 27, longitude: -82, dates: ['x'] })).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('the forecast endpoint fills the nights the archive lacks; an archive value is never replaced', async () => {
    global.fetch = jest.fn(async (url) => (String(url).includes('archive')
      ? okJson([50, 52, 60, 61, 62, null, null])
      : okJson([10, 10, 10, 10, 10, 58, 57])));
    const nights = await real.fetchNightlyMinsF({ latitude: 27.2222, longitude: -82.2222, dates });
    expect(nights.map((n) => n.minF)).toEqual([50, 52, 60, 61, 62, 58, 57]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('both endpoints down = null; some nights read = those nights, the rest null', async () => {
    global.fetch = jest.fn(async () => ({ ok: false }));
    expect(await real.fetchNightlyMinsF({ latitude: 27.3333, longitude: -82.3333, dates })).toBeNull();
    global.fetch = jest.fn(async () => okJson([50, null, null, null, null, null, null]));
    const part = await real.fetchNightlyMinsF({ latitude: 27.4444, longitude: -82.4444, dates });
    expect(part.map((n) => n.minF)).toEqual([50, null, null, null, null, null, null]);
  });
});

describe('resolveVisitMeasuredCold (the freeze)', () => {
  const DAY = '2026-11-08';
  const COLD = [50, 52, 60, 61, 62, 63, 64].map((minF, i) => ({ date: `n${i}`, minF }));
  const WARM = [70, 71, 72, 73, 74, 75, 76].map((minF, i) => ({ date: `n${i}`, minF }));
  const svc = (notes = {}, extra = {}) => ({ id: 'svc-1', structured_notes: JSON.stringify(notes), customer_latitude: 27.1, customer_longitude: -82.4, ...extra });
  const run = (records, args, hooks) => {
    const { knex, log } = withRecords({}, records, hooks);
    return resolveVisitMeasuredCold({ knex, day: DAY, ...args }).then((result) => ({ result, log }));
  };
  beforeEach(() => conditions.fetchNightlyMinsF.mockReset());

  test('a frozen verdict replays with no weather call, even when the opt-in is off', async () => {
    const frozen = { [DAY]: { met: true, serviceDate: DAY } };
    const { result } = await run({}, { service: svc({ lawnMeasuredCold: frozen }), allowFetch: false });
    expect(result).toEqual({ met: true, unfrozen: false, pendingReason: null });
    expect(conditions.fetchNightlyMinsF).not.toHaveBeenCalled();
  });
  test('a verdict frozen for another day does not answer this day', async () => {
    conditions.fetchNightlyMinsF.mockResolvedValue(COLD);
    const notes = { lawnMeasuredCold: { '2026-11-07': { met: false } } };
    const { result } = await run({ 'svc-1': { structured_notes: notes } }, { service: svc(notes), allowFetch: true });
    expect(result.met).toBe(true);
  });
  test('no opt-in and nothing frozen = unknown with no weather call and no uncacheable flag (Ask Waves)', async () => {
    const { result, log } = await run({ 'svc-1': { structured_notes: {} } }, { service: svc(), allowFetch: false });
    expect(result).toEqual({ met: null, unfrozen: false, pendingReason: null });
    expect(conditions.fetchNightlyMinsF).not.toHaveBeenCalled();
    expect(log.updates).toHaveLength(0);
  });
  test('no coordinates = pending (the geocoder may fill them), nothing fetched or frozen; 0,0 counts as none', async () => {
    for (const extra of [{ customer_latitude: null, customer_longitude: null }, { customer_latitude: 0, customer_longitude: 0 }, { customer_latitude: '', customer_longitude: '' }]) {
      const { result, log } = await run({ 'svc-1': { structured_notes: {} } }, { service: svc({}, extra), allowFetch: true });
      expect(result).toEqual({ met: null, unfrozen: false, pendingReason: 'no_coordinates' });
      expect(log.updates).toHaveLength(0);
    }
    expect(conditions.fetchNightlyMinsF).not.toHaveBeenCalled();
  });
  test('cold: freezes the verdict for the visit day once, with the nights it read', async () => {
    conditions.fetchNightlyMinsF.mockResolvedValue(COLD);
    const recs = { 'svc-1': { structured_notes: {} } };
    const { result, log } = await run(recs, { service: svc(), allowFetch: true });
    expect(result).toEqual({ met: true, unfrozen: false, pendingReason: null });
    expect(log.updates).toHaveLength(1);
    const entry = storedMeasuredColdFor(recs['svc-1'].structured_notes, DAY);
    expect(entry).toMatchObject({ met: true, coldNights: 2, serviceDate: DAY, source: 'open_meteo' });
    expect(entry.nights).toHaveLength(7);
    // the question asked is the 7 nights before the visit day
    expect(conditions.fetchNightlyMinsF.mock.calls[0][0].dates).toEqual(seasonality.trailingNightDates(DAY));
  });
  test('warm with all 7 nights read is a settled false, frozen', async () => {
    conditions.fetchNightlyMinsF.mockResolvedValue(WARM);
    const recs = { 'svc-1': { structured_notes: {} } };
    const { result } = await run(recs, { service: svc(), allowFetch: true });
    expect(result).toEqual({ met: false, unfrozen: false, pendingReason: null });
    expect(storedMeasuredColdFor(recs['svc-1'].structured_notes, DAY).met).toBe(false);
  });
  test('a failed or incomplete read is unknown, NOT frozen, and flagged unfrozen so nothing caches it', async () => {
    const recs = { 'svc-1': { structured_notes: {} } };
    conditions.fetchNightlyMinsF.mockResolvedValue(null);
    expect((await run(recs, { service: svc(), allowFetch: true })).result).toEqual({ met: null, unfrozen: true, pendingReason: null });
    conditions.fetchNightlyMinsF.mockRejectedValue(new Error('boom'));
    expect((await run(recs, { service: svc(), allowFetch: true })).result.unfrozen).toBe(true);
    conditions.fetchNightlyMinsF.mockResolvedValue([...WARM.slice(0, 6), { date: 'x', minF: null }]);
    const incomplete = await run(recs, { service: svc(), allowFetch: true });
    expect(incomplete.result).toEqual({ met: null, unfrozen: true, pendingReason: null });
    expect(incomplete.log.updates).toHaveLength(0);
    expect(recs['svc-1'].structured_notes.lawnMeasuredCold).toBeUndefined();
  });
  test('first writer wins: a render that loses the race adopts the winner\'s verdict', async () => {
    conditions.fetchNightlyMinsF.mockResolvedValue(COLD);
    const recs = { 'svc-1': { structured_notes: { lawnMeasuredCold: { [DAY]: { met: false, serviceDate: DAY } } } } };
    // this render's own row (read before the winner wrote) shows nothing frozen
    const { result, log } = await run(recs, { service: svc(), allowFetch: true });
    expect(result).toEqual({ met: false, unfrozen: false, pendingReason: null });
    expect(log.updates).toHaveLength(0);
  });
  test('a freeze that cannot be written serves the live verdict but marks it unfrozen', async () => {
    conditions.fetchNightlyMinsF.mockResolvedValue(COLD);
    const { result } = await run({ 'svc-1': { structured_notes: {} } }, { service: svc(), allowFetch: true }, { failUpdate: true });
    expect(result).toEqual({ met: true, unfrozen: true, pendingReason: null });
  });
  test('the freeze writes through the first-writer-wins predicate with no preceding read and no row lock', () => {
    const src = read('services/service-report/lawn-measured-cold.js');
    expect(src).toMatch(/lawnMeasuredCold' -> \? IS NULL/);
    expect(src).not.toMatch(/forUpdate|FOR UPDATE|transaction/);
  });
  test('readMeasuredCold: a bad visit day or no readings is null', async () => {
    expect(await readMeasuredCold({ latitude: 27, longitude: -82, visitDay: 'x' })).toBeNull();
    conditions.fetchNightlyMinsF.mockResolvedValue(null);
    expect(await readMeasuredCold({ latitude: 27, longitude: -82, visitDay: DAY })).toBeNull();
  });
});

describe('the lawn_cooler_nights tip lift', () => {
  const order = (opts) => tipsForVisit({ serviceLine: 'lawn', date: '2026-10-20', ...opts }).groups.find((g) => g.id === 'lawn').tips.map((t) => t.id);
  const FIRST = 'lawn_cooler_nights';

  const at = (opts) => order(opts).indexOf(FIRST);

  test('gate off (measuredCold undefined): unchanged, the tip keeps its October lift', () => {
    expect(JSON.stringify(order({}))).toBe(JSON.stringify(order({ measuredCold: undefined })));
    // lifted: ahead of every tip that has no month, finding or season lift of its own
    expect(at({})).toBeLessThan(order({}).indexOf('lawn_early_spring_low_mow'));
  });
  test('measured cold met keeps the lift: the order is the gate-off order', () => {
    expect(JSON.stringify(order({ measuredCold: true }))).toBe(JSON.stringify(order({})));
  });
  test('not cold, or a failed read, loses the lift but the tip stays in the list', () => {
    for (const measuredCold of [false, null]) {
      const ids = order({ measuredCold });
      expect(at({ measuredCold })).toBeGreaterThan(at({}));
      expect(ids).toContain(FIRST);
      expect([...ids].sort()).toEqual([...order({})].sort());
      // every other tip keeps its relative order
      expect(ids.filter((id) => id !== FIRST)).toEqual(order({}).filter((id) => id !== FIRST));
    }
  });
  test('other months and other tips are not touched', () => {
    const jan = (measuredCold) => tipsForVisit({ serviceLine: 'lawn', date: '2026-02-20', measuredCold }).groups.flatMap((g) => g.tips.map((t) => t.id));
    expect(jan(false)).toEqual(jan(undefined));
    expect(measuredColdLiftApplies('2026-10-20')).toBe(true);
    expect(measuredColdLiftApplies('2026-11-02')).toBe(true);
    expect(measuredColdLiftApplies('2026-07-02')).toBe(false);
  });
  test('the served tip objects gain no field', () => {
    const tip = tipsForVisit({ serviceLine: 'lawn', date: '2026-10-20', measuredCold: false }).groups.flatMap((g) => g.tips).find((t) => t.id === FIRST);
    expect(Object.keys(tip).sort()).toEqual(['copy', 'group', 'id', 'keywords', 'label', 'lines', 'months', 'season']);
  });
  test('the tech-tips route reads the gate and the customer\'s coordinates only for a lawn visit in a lifted month', () => {
    const src = read('routes/admin-dispatch.js');
    expect(src).toMatch(/lawnMeasuredColdLive\(\)\s*&& measuredColdLiftApplies\(visitDay\)/);
    expect(src).toMatch(/\.\.\.\(measuredCold === undefined \? \{\} : \{ measuredCold \}\)/);
  });
});

describe('the gate reader', () => {
  const gates = require('../config/feature-gates');
  const saved = process.env.GATE_LAWN_MEASURED_COLD;
  afterEach(() => { if (saved === undefined) delete process.env.GATE_LAWN_MEASURED_COLD; else process.env.GATE_LAWN_MEASURED_COLD = saved; });
  test('dark by default, 1/true/on only, read at call time', () => {
    delete process.env.GATE_LAWN_MEASURED_COLD;
    expect(gates.lawnMeasuredColdLive()).toBe(false);
    ['1', 'true', 'on', 'TRUE'].forEach((v) => { process.env.GATE_LAWN_MEASURED_COLD = v; expect(gates.lawnMeasuredColdLive()).toBe(true); });
    ['0', 'false', 'yes', ''].forEach((v) => { process.env.GATE_LAWN_MEASURED_COLD = v; expect(gates.lawnMeasuredColdLive()).toBe(false); });
  });
  test('the reader is exported on its own line at the end of the file and documented in the header, the gates doc and the route contracts', () => {
    const lines = read('config/feature-gates.js').trimEnd().split('\n');
    expect(lines[lines.length - 1]).toBe('module.exports.lawnMeasuredColdLive = lawnMeasuredColdLive;');
    expect(read('config/feature-gates.js')).toMatch(/\* {3}GATE_LAWN_MEASURED_COLD=true/);
    expect(fs.readFileSync(path.join(__dirname, '../../docs/gates-and-env.md'), 'utf8')).toMatch(/`GATE_LAWN_MEASURED_COLD`/);
    expect(fs.readFileSync(path.join(__dirname, '../../docs/public-route-contracts.md'), 'utf8')).toMatch(/GATE_LAWN_MEASURED_COLD/);
  });
});

describe('opt-in wiring: only a rendering caller makes the weather call', () => {
  test('the /data render and the direct PDF route opt in; Ask Waves does not', () => {
    const src = read('routes/reports-public.js');
    expect(src).toMatch(/lawnWateringCloseOut: true,\s*lawnMeasuredCold: true,/);
    expect(src).toMatch(/mode: 'pdf', pestPressureConfig,[\s\S]{0,900}?lawnMeasuredCold: true,/);
    expect(src).toMatch(/lawnMeasuredCold = false,/);
    expect(src).toMatch(/const data = await buildServiceReportV1ResponseData\(service, req\.params\.token, \{ mode: 'live' \}\);/);
  });
  test('the PDF queue opts in; email, recap and the write gate never do', () => {
    expect(read('services/service-report/pdf-queue.js')).toMatch(/lawnMeasuredCold: true/);
    ['services/service-report/email-delivery.js', 'services/service-report/recap-payload.js', 'services/service-report/lawn-report-write-gate.js']
      .forEach((f) => expect(read(f)).not.toMatch(/lawnMeasuredCold/));
  });
  test('report-data hands the loader the fetch permission only from the caller\'s opt-in, and only with the gate on', () => {
    const src = read('services/service-report/report-data.js');
    expect(src).toMatch(/measuredColdFetch: opts\.lawnMeasuredCold === true/);
    expect(src).toMatch(/featureGates\.lawnMeasuredColdLive\(\)\s*\? \{\} : null/);
  });
});

// ── The report payload through the real builder ────────────────────────────────
const CUSTOMER = 'cust-lawn-p36';
const DAY = '2026-11-10';
const LOW_COLOR = { turf_density: 78, weed_suppression: 82, color_health: 45, stress_damage: 80, fungus_control: 80, thatch_level: 80 };
const CUR = (day = DAY) => ({
  id: 'la-cur', customer_id: CUSTOMER, service_record_id: 'svc-cur', confirmed_by_tech: true,
  service_date: day, visit_date: day, created_at: `${day}T14:00:00Z`, history_record_id: 'svc-cur', ...LOW_COLOR,
});
const fixtures = (day = DAY) => ({
  service_products: [{ id: 'sp-1', service_record_id: 'svc-cur', product_name: 'Test Herbicide B', product_category: 'herbicide', created_at: `${day}T18:00:00Z` }],
  property_geometries: [], property_zones: [], service_findings: [], service_photos: [], lawn_assessment_photos: [],
  lawn_water_intake_snapshots: [],
  scheduled_services: [{ id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: day, status: 'completed', service_type: 'Lawn Care Treatment Program' }],
  property_preferences: [],
  lawn_assessments: [CUR(day)],
});
const service = (notes = {}, day = DAY, extra = {}) => ({
  id: 'svc-cur', scheduled_service_id: 'ss-cur', customer_id: CUSTOMER, service_line: 'lawn',
  service_type: 'Lawn Care Treatment Program', service_date: day, completed_at: `${day}T18:40:00Z`,
  first_name: 'Test', last_name: 'Customer', areas_serviced: JSON.stringify(['Front Lawn']),
  structured_notes: JSON.stringify(notes), service_data: JSON.stringify({}),
  customer_latitude: 27.1, customer_longitude: -82.4, ...extra,
});
const WEEK = (day = DAY) => ({ assessmentId: 'la-cur', serviceDate: day, rainInches: 1, et0Inches: 1, dailyRain: [], rainConfidence: 'high' });
const nights = (mins) => mins.map((minF, i) => ({ date: `n${i}`, minF }));
const COLD = nights([50, 52, 60, 61, 62, 63, 64]);
const WARM = nights([70, 71, 72, 73, 74, 75, 76]);

describe('GATE_LAWN_MEASURED_COLD on the lawn report payload', () => {
  const saved = process.env.GATE_LAWN_MEASURED_COLD;
  beforeEach(() => {
    delete process.env.GATE_LAWN_MEASURED_COLD;
    jest.clearAllMocks();
    conditions.fetchNightlyMinsF.mockReset();
    history.installedForVisit.mockResolvedValue(CUR());
    history.historyForReport.mockResolvedValue({ current: CUR(), rows: [CUR()], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    history.historyForAssessment.mockResolvedValue({ current: CUR(), rows: [CUR()], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'no_key' });
  });
  afterEach(() => { if (saved === undefined) delete process.env.GATE_LAWN_MEASURED_COLD; else process.env.GATE_LAWN_MEASURED_COLD = saved; });

  const records = (extra = {}) => ({ 'svc-cur': { structured_notes: { lawnWeekWeather: { 'la-cur': WEEK() }, ...extra } } });
  const render = (recs = records(), { opts = {}, day = DAY, hooks, svc } = {}) => {
    const { knex, log } = withRecords(fixtures(day), recs, hooks);
    return buildReportV1Data(svc || service(recs['svc-cur'].structured_notes, day), 'token-p36', knex, opts).then((data) => ({ data, log }));
  };
  const on = () => { process.env.GATE_LAWN_MEASURED_COLD = 'true'; };
  const colorCard = (data) => data.reportV2.diagnosis.find((c) => c.key === 'color_vigor');
  const json = (v) => JSON.parse(JSON.stringify(v));

  test('baseline (gate off): the calendar alone prints the dip sentence for a low-color November visit', async () => {
    const { data } = await render();
    expect(colorCard(data)).toMatchObject({ seasonal: true, status: 'healthy', customerExplanation: DIP });
  });

  test('gate off: no weather call, no write, no new key, and the payload is byte-identical', async () => {
    const base = (await render()).data;
    conditions.fetchNightlyMinsF.mockResolvedValue(WARM);
    const recs = records();
    const { data, log } = await render(recs, { opts: { lawnMeasuredCold: true } });
    expect(conditions.fetchNightlyMinsF).not.toHaveBeenCalled();
    expect(log.updates).toHaveLength(0);
    expect(recs['svc-cur'].structured_notes.lawnMeasuredCold).toBeUndefined();
    expect(json(data)).toEqual(json(base));
    expect(JSON.stringify(data)).not.toMatch(/measuredCold|lawnMeasuredCold/);
  });

  test('gate on + cold: fetches the nights before the visit day, freezes, and the dip sentence prints as before', async () => {
    const base = json((await render()).data);
    on();
    conditions.fetchNightlyMinsF.mockResolvedValue(COLD);
    const recs = records();
    const { data, log } = await render(recs, { opts: { lawnMeasuredCold: true } });
    expect(conditions.fetchNightlyMinsF).toHaveBeenCalledTimes(1);
    expect(conditions.fetchNightlyMinsF.mock.calls[0][0].dates).toEqual(seasonality.trailingNightDates(DAY));
    expect(log.updates).toHaveLength(1);
    expect(storedMeasuredColdFor(recs['svc-cur'].structured_notes, DAY).met).toBe(true);
    expect(colorCard(data)).toMatchObject({ seasonal: true, status: 'healthy', customerExplanation: DIP });
    // a cold week changes nothing in the payload, and the payload gains no key
    expect(json(data)).toEqual(base);
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(false);
  });

  test('gate on + warm: no dip sentence, no seasonal reframing; the color card keeps its own status and words', async () => {
    on();
    conditions.fetchNightlyMinsF.mockResolvedValue(WARM);
    const { data } = await render(records(), { opts: { lawnMeasuredCold: true } });
    const card = colorCard(data);
    expect(card.seasonal).toBeUndefined();
    expect(card.status).not.toBe('healthy');
    expect(JSON.stringify(data.reportV2)).not.toContain(DIP);
    expect(JSON.stringify(data.reportV2)).not.toMatch(NO_DIP_CLAUSE);
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(false);
  });

  test('gate on + a failed read: no dip sentence (fail closed) and the render is uncacheable, not frozen', async () => {
    on();
    conditions.fetchNightlyMinsF.mockResolvedValue(null);
    const recs = records();
    const { data, log } = await render(recs, { opts: { lawnMeasuredCold: true } });
    expect(colorCard(data).seasonal).toBeUndefined();
    expect(JSON.stringify(data.reportV2)).not.toContain(DIP);
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(true);
    expect(data.lawnAssessment.weekWeatherUnfrozen).toBe(true);
    expect(log.updates).toHaveLength(0);
    // recovery: the next view reads, freezes and prints
    conditions.fetchNightlyMinsF.mockResolvedValue(COLD);
    const next = await render(recs, { opts: { lawnMeasuredCold: true } });
    expect(colorCard(next.data).customerExplanation).toBe(DIP);
    expect(next.data.lawnAssessment.weekWeatherUncacheable).toBe(false);
  });

  test('gate on, no coordinates yet: no dip sentence, uncacheable as pending (not a delivery block)', async () => {
    on();
    const { data } = await render(records(), { opts: { lawnMeasuredCold: true }, svc: service(records()['svc-cur'].structured_notes, DAY, { customer_latitude: null, customer_longitude: null }) });
    expect(conditions.fetchNightlyMinsF).not.toHaveBeenCalled();
    expect(colorCard(data).seasonal).toBeUndefined();
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(true);
    expect(data.lawnAssessment.weekWeatherPendingReason).toBe('no_coordinates');
    expect(data.lawnAssessment.weekWeatherUnfrozen).toBe(false);
  });

  test('a caller that did not opt in (Ask Waves, email) makes no weather call; unfrozen = no dip sentence, no uncacheable flag', async () => {
    on();
    conditions.fetchNightlyMinsF.mockResolvedValue(COLD);
    const { data, log } = await render(records());
    expect(conditions.fetchNightlyMinsF).not.toHaveBeenCalled();
    expect(log.updates).toHaveLength(0);
    expect(colorCard(data).seasonal).toBeUndefined();
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(false);
  });

  test('a frozen verdict replays for every caller with no weather call, whatever the weather now says', async () => {
    on();
    conditions.fetchNightlyMinsF.mockResolvedValue(WARM);
    const recs = records({ lawnMeasuredCold: { [DAY]: { met: true, serviceDate: DAY } } });
    const { data } = await render(recs);
    expect(colorCard(data).customerExplanation).toBe(DIP);
    const warm = records({ lawnMeasuredCold: { [DAY]: { met: false, serviceDate: DAY } } });
    expect(colorCard((await render(warm, { opts: { lawnMeasuredCold: true } })).data).seasonal).toBeUndefined();
    expect(conditions.fetchNightlyMinsF).not.toHaveBeenCalled();
  });

  test('a peak-season visit is untouched: no weather call, no write, the same payload', async () => {
    const day = '2026-07-14';
    const base = (await render(records(), { day })).data;
    on();
    conditions.fetchNightlyMinsF.mockResolvedValue(WARM);
    const recs = records();
    const { data, log } = await render(recs, { opts: { lawnMeasuredCold: true }, day });
    expect(conditions.fetchNightlyMinsF).not.toHaveBeenCalled();
    expect(log.updates).toHaveLength(0);
    expect(json(data)).toEqual(json(base));
  });

  test('a visit that is not a lawn visit never reads the gate path', async () => {
    on();
    const { data } = await render(records(), { svc: { ...service(records()['svc-cur'].structured_notes), service_line: 'pest', service_type: 'Pest Control' } });
    expect(conditions.fetchNightlyMinsF).not.toHaveBeenCalled();
    expect(data.lawnAssessment).toBeFalsy();
  });

  describe('the PDF cache key', () => {
    const sig = async (day = DAY) => {
      history.installedForVisit.mockResolvedValue(CUR(day));
      const { knex } = withRecords(fixtures(day), records());
      return (await resolveCanonicalLawnRender(service({}, day), knex, { propertyHistoryEnabled: false })).signature;
    };
    test('gate off: the key is what it was; gate on re-keys a cooler-calendar visit once', async () => {
      const off = await sig();
      on();
      const onSig = await sig();
      expect(onSig).not.toBe(off);
      expect(await sig()).toBe(onSig);
    });
    test('gate on leaves a peak-season visit\'s key alone, and the verdict is not in the key (it is frozen before any store)', async () => {
      const off = await sig('2026-07-14');
      on();
      expect(await sig('2026-07-14')).toBe(off);
    });
  });
});
