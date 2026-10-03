// GATE_LAWN_VISIT_MEMORY (lawn report rebuild P12) through the real report
// builder (buildReportV1Data). Synthetic data only.
//
// Pins: gate off = no reads, no writes and a payload key-for-key what it was;
// gate on = this visit's memory is frozen at the first render and reportV2.sinceLast
// carries the PRIOR visit's frozen entry; a re-render replays byte for byte after
// later visits land; the prior is the earlier visit at the SAME property only (a
// later-dated row never; none without property history, so a moved home has none);
// a failed freeze marks the render uncacheable and never breaks the report.

jest.mock('../services/lawn-assessment-history', () => ({
  installedForVisit: jest.fn(),
  historyForReport: jest.fn(),
  historyForAssessment: jest.fn(),
  restrictVisitHistory: (query) => query,
}));

jest.mock('../services/service-report/application-conditions', () => {
  const actual = jest.requireActual('../services/service-report/application-conditions');
  return { ...actual, fetchServiceWeekWeather: jest.fn(actual.fetchServiceWeekWeather) };
});
jest.mock('../services/irrigation-week-plan', () => {
  const actual = jest.requireActual('../services/irrigation-week-plan');
  return { ...actual, loadCurrentWeekPlan: jest.fn(actual.loadCurrentWeekPlan) };
});

const history = require('../services/lawn-assessment-history');
const featureGates = require('../config/feature-gates');
const conditions = require('../services/service-report/application-conditions');
const weekPlan = require('../services/irrigation-week-plan');
const { buildReportV1Data } = require('../services/service-report/report-data');
const { storedVisitMemoryFor } = require('../services/service-report/lawn-visit-memory');

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


// service_records: an in-memory table with the freeze's semantics (the real SQL
// runs in lawn-visit-memory-postgres.test.js); every other table is the generic
// fixture reader above.
function withRecords(fixtures, records, hooks = {}) {
  const generic = makeKnex(fixtures);
  const log = { reads: [], updates: [] };
  const knex = (table) => {
    if (table !== 'service_records') return generic(table);
    const ctx = { where: {}, binding: null };
    const chain = {
      where(cond) { Object.assign(ctx.where, cond); return chain; },
      whereRaw(_sql, bindings) { ctx.binding = bindings?.[0] ?? null; return chain; },
      async update(patch) {
        const sql = patch.structured_notes?.__raw || '';
        if (!sql.includes('lawnVisitMemory')) return 1; // week-weather / other freezes: out of scope here
        if (hooks.failUpdate) throw new Error('update failed');
        const rec = records[ctx.where.id];
        if (!rec) return 0;
        const map = (rec.structured_notes && rec.structured_notes.lawnVisitMemory) || {};
        if (map[ctx.binding] != null) return 0;
        const add = JSON.parse(patch.structured_notes.bindings[0]);
        rec.structured_notes = { ...rec.structured_notes, lawnVisitMemory: { ...map, ...add } };
        log.updates.push(add);
        return 1;
      },
      async first() {
        log.reads.push({ ...ctx.where });
        const rec = records[ctx.where.id];
        return rec ? { structured_notes: rec.structured_notes } : undefined;
      },
    };
    return chain;
  };
  knex.raw = (sql, bindings) => ({ __raw: sql, bindings });
  return { knex, log };
}

const CUSTOMER = 'cust-lawn-p12';
const SCORES = { turf_density: 78, weed_suppression: 82, color_health: 75, stress_damage: 30 };
const assessmentRow = (id, date, recordId) => ({
  id, customer_id: CUSTOMER, service_record_id: recordId, confirmed_by_tech: true,
  service_date: date, visit_date: date, created_at: `${date}T14:00:00Z`, history_record_id: recordId, ...SCORES,
});
const PRIOR_ENTRY = {
  v: 1, assessmentId: 'la-prior', serviceDate: '2026-08-01',
  applied: [{ name: 'Prior Product', activeIngredient: 'Azoxystrobin', kind: 'fungicide', tag: 'fungus protection', targets: [] }],
  checks: [{ key: 'weeds', status: 'watch' }], sinceLast: null,
};

const CUR = assessmentRow('la-cur', '2026-09-30', 'svc-cur');
const PRIOR = assessmentRow('la-prior', '2026-08-01', 'svc-prior');

const fixtures = () => ({
  service_products: [{ id: 'sp-1', service_record_id: 'svc-cur', product_name: 'Test Herbicide B', product_category: 'herbicide', created_at: '2026-09-30T18:00:00Z' }],
  property_geometries: [], property_zones: [], service_findings: [], service_photos: [], lawn_assessment_photos: [],
  lawn_water_intake_snapshots: [],
  scheduled_services: [{ id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-09-30', status: 'completed', service_type: 'Lawn Care Treatment Program' }],
  property_preferences: [],
  lawn_assessments: [CUR],
});

const service = (notes = {}) => ({
  id: 'svc-cur', scheduled_service_id: 'ss-cur', customer_id: CUSTOMER, service_line: 'lawn',
  service_type: 'Lawn Care Treatment Program', service_date: '2026-09-30', completed_at: '2026-09-30T18:40:00Z',
  first_name: 'Test', last_name: 'Customer', areas_serviced: JSON.stringify(['Front Lawn']),
  structured_notes: JSON.stringify(notes), service_data: JSON.stringify({}),
});

const setHistory = (rows, current = CUR) => {
  history.installedForVisit.mockResolvedValue(current);
  history.historyForReport.mockResolvedValue({ current, rows, identity: 'h', eligibleVisitIds: [], isBaseline: rows[0]?.id === current.id });
  history.historyForAssessment.mockResolvedValue({ current, rows, identity: 'h', eligibleVisitIds: [], isBaseline: rows[0]?.id === current.id });
};

describe('GATE_LAWN_VISIT_MEMORY on the report payload', () => {
  const ENV = ['GATE_LAWN_VISIT_MEMORY', 'GATE_LAWN_PROPERTY_HISTORY', 'GATE_IRRIGATION_WEEK_PLAN'];
  const saved = {};
  beforeEach(() => { ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); jest.clearAllMocks(); });
  afterEach(() => { if (featureGates.isEnabled.mockRestore) featureGates.isEnabled.mockRestore(); });
  afterEach(() => { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });
  // The week's weather is frozen on the record so the baseline render is
  // cacheable and the memory's own effect on cacheability is visible.
  const WEEK = { assessmentId: 'la-cur', serviceDate: '2026-09-30', rainInches: 1, et0Inches: 1, dailyRain: [], rainConfidence: 'high' };
  const records = (extra = {}) => ({
    'svc-cur': { structured_notes: { lawnWeekWeather: { 'la-cur': WEEK } } },
    'svc-prior': { structured_notes: { lawnVisitMemory: { 'la-prior': PRIOR_ENTRY } } },
    ...extra,
  });
  const live = () => { process.env.GATE_LAWN_VISIT_MEMORY = 'true'; process.env.GATE_LAWN_PROPERTY_HISTORY = 'true'; };
  const render = (recs, hooks, svc = service(recs['svc-cur'].structured_notes)) => {
    const { knex, log } = withRecords(fixtures(), recs, hooks);
    return buildReportV1Data(svc, 'token-p12', knex, {}).then((data) => ({ data, log }));
  };

  test('gate off (even with property history on): no read, no write, no sinceLast, and the payload is what it was', async () => {
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    setHistory([PRIOR, CUR]);
    const recs = records();
    const { data, log } = await render(recs);
    expect(data.reportV2.sinceLast).toBeUndefined();
    expect(JSON.stringify(data)).not.toMatch(/sinceLast|lawnVisitMemory|visitMemory/);
    expect(log.reads).toHaveLength(0);
    expect(log.updates).toHaveLength(0);
    expect(recs['svc-cur'].structured_notes.lawnVisitMemory).toBeUndefined();
  });

  test('gate on with no prior: the visit still freezes its own entry, the payload differs from gate off only by that write', async () => {
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    setHistory([CUR]);
    const off = (await render(records())).data;
    live();
    const recs = records();
    const { data } = await render(recs);
    expect(data.reportV2.sinceLast).toBeUndefined();
    expect(JSON.parse(JSON.stringify(data))).toEqual(JSON.parse(JSON.stringify(off)));
    const frozen = storedVisitMemoryFor(recs['svc-cur'].structured_notes, 'la-cur');
    expect(frozen).toMatchObject({ v: 1, assessmentId: 'la-cur', serviceDate: '2026-09-30', sinceLast: null });
    expect(frozen.applied.map((p) => p.name)).toEqual(['Test Herbicide B']);
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(false);
  });

  test('gate on with a prior that froze its memory: sinceLast carries it, and the entry freezes the same block', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const recs = records();
    const { data } = await render(recs);
    expect(data.reportV2.sinceLast).toEqual({
      v: 1, priorAssessmentId: 'la-prior', priorDate: '2026-08-01', applied: PRIOR_ENTRY.applied, checks: PRIOR_ENTRY.checks,
    });
    expect(storedVisitMemoryFor(recs['svc-cur'].structured_notes, 'la-cur').sinceLast).toEqual(data.reportV2.sinceLast);
    // Internal ids stay internal: the public lawn payload names no record id.
    expect(JSON.stringify(data)).not.toContain('svc-prior');
    expect(data.lawnAssessment.priorVisit).toBeUndefined();
  });

  test('a later render replays byte for byte: a newer visit, an edited prior memory and different inputs change nothing', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const recs = records();
    const first = (await render(recs)).data;
    const frozenNotes = recs['svc-cur'].structured_notes;

    // An October visit lands, the prior's memory is rewritten, and the history now has a closer prior.
    const NEWER = assessmentRow('la-newer', '2026-10-20', 'svc-newer');
    const CLOSER = assessmentRow('la-closer', '2026-09-15', 'svc-closer');
    setHistory([PRIOR, CLOSER, CUR, NEWER]);
    recs['svc-prior'].structured_notes = { lawnVisitMemory: { 'la-prior': { ...PRIOR_ENTRY, applied: [{ name: 'Changed' }], checks: [] } } };
    recs['svc-closer'] = { structured_notes: { lawnVisitMemory: { 'la-closer': { ...PRIOR_ENTRY, assessmentId: 'la-closer', serviceDate: '2026-09-15' } } } };
    const again = (await render(recs, undefined, service(frozenNotes))).data;
    expect(JSON.stringify(again.reportV2.sinceLast)).toBe(JSON.stringify(first.reportV2.sinceLast));
  });

  test('a later-dated row is never the prior: a render whose only other row is in its future has no sinceLast', async () => {
    live();
    const FUTURE = assessmentRow('la-future', '2026-11-01', 'svc-future');
    setHistory([CUR, FUTURE]);
    const recs = records({ 'svc-future': { structured_notes: { lawnVisitMemory: { 'la-future': { ...PRIOR_ENTRY, assessmentId: 'la-future', serviceDate: '2026-11-01' } } } } });
    const { data, log } = await render(recs);
    expect(data.reportV2.sinceLast).toBeUndefined();
    expect(log.reads.filter((r) => r.id === 'svc-future')).toHaveLength(0);
  });

  test('a moved home (the new property\'s history holds only this visit) has no prior', async () => {
    live();
    setHistory([CUR]);
    const { data, log } = await render(records());
    expect(data.reportV2.sinceLast).toBeUndefined();
    expect(log.reads.filter((r) => r.id === 'svc-prior')).toHaveLength(0);
  });

  test('without GATE_LAWN_PROPERTY_HISTORY the customer-wide history cannot prove "same home": no prior, still frozen', async () => {
    process.env.GATE_LAWN_VISIT_MEMORY = 'true';
    const f = fixtures();
    f.lawn_assessments = [PRIOR, CUR];
    const recs = records();
    const { knex } = withRecords(f, recs);
    const data = await buildReportV1Data(service(), 'token-p12', knex, {});
    expect(data.reportV2.sinceLast).toBeUndefined();
    expect(storedVisitMemoryFor(recs['svc-cur'].structured_notes, 'la-cur')).toMatchObject({ sinceLast: null });
  });

  test('a prior that has no frozen memory yields no block (no live fallback), and still freezes', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const recs = records();
    recs['svc-prior'].structured_notes = {};
    const { data, log } = await render(recs);
    expect(data.reportV2.sinceLast).toBeUndefined();
    expect(log.updates).toHaveLength(1);
  });

  test('a freeze that fails serves the report, carries sinceLast, and marks the render uncacheable', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const { data } = await render(records(), { failUpdate: true });
    expect(data.reportV2).toBeTruthy();
    expect(data.reportV2.sinceLast.priorAssessmentId).toBe('la-prior');
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(true);
    expect(data.lawnAssessment.weekWeatherUnfrozen).toBe(false); // delivery is not held, only caching
  });

  // The first-writer-wins entry may only be CREATED from a complete read.
  const withFixtures = (recs, patch, svc = service(recs['svc-cur'].structured_notes)) => {
    const { knex, log } = withRecords({ ...fixtures(), ...patch }, recs);
    return buildReportV1Data(svc, 'token-p12', knex, {}).then((data) => ({ data, log }));
  };
  const applied = (recs) => storedVisitMemoryFor(recs['svc-cur'].structured_notes, 'la-cur')?.applied.map((p) => p.name);

  test('a failed service_products read writes nothing; the next render freezes the real applied list', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const recs = records();
    const failed = await withFixtures(recs, { service_products: FAIL });
    expect(failed.log.updates).toHaveLength(0);
    expect(recs['svc-cur'].structured_notes.lawnVisitMemory).toBeUndefined();
    expect(failed.data.lawnAssessment.weekWeatherUncacheable).toBe(true);
    // The prior's frozen block is independent of this visit's products: still served.
    expect(failed.data.reportV2.sinceLast.priorAssessmentId).toBe('la-prior');

    const next = await withFixtures(recs, {});
    expect(applied(recs)).toEqual(['Test Herbicide B']);
    expect(next.data.lawnAssessment.weekWeatherUncacheable).toBe(false);
  });

  test('a failed catalog enrichment writes nothing (the watering freeze\'s own guard), and recovery freezes', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const recs = records();
    const catalogRow = (over) => ({ id: '11111111-2222-4333-8444-555555555555', ...over });
    const products = [{ id: 'sp-1', service_record_id: 'svc-cur', product_id: '11111111-2222-4333-8444-555555555555', product_name: 'Test Herbicide B', product_category: 'herbicide', created_at: '2026-09-30T18:00:00Z' }];
    const failed = await withFixtures(recs, { service_products: products, products_catalog: FAIL });
    expect(failed.log.updates).toHaveLength(0);
    expect(recs['svc-cur'].structured_notes.lawnVisitMemory).toBeUndefined();
    expect(failed.data.lawnAssessment.weekWeatherUncacheable).toBe(true);

    await withFixtures(recs, { service_products: products, products_catalog: [catalogRow({ name: 'Test Herbicide B', category: 'herbicide' })] });
    expect(applied(recs)).toEqual(['Test Herbicide B']);
  });

  test('a failed property_preferences read (the water insights\' input) writes nothing; recovery freezes', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const recs = records();
    const failed = await withFixtures(recs, { property_preferences: FAIL });
    expect(failed.log.updates).toHaveLength(0);
    expect(failed.data.lawnAssessment.weekWeatherUncacheable).toBe(true);
    await withFixtures(recs, {});
    expect(applied(recs)).toEqual(['Test Herbicide B']);
  });

  test('replay is unaffected by a later failed read: the frozen entry and block are served as frozen', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const recs = records();
    const first = (await withFixtures(recs, {})).data;
    const later = await withFixtures(recs, { service_products: FAIL, property_preferences: FAIL });
    expect(later.log.updates).toHaveLength(0);
    expect(JSON.stringify(later.data.reportV2.sinceLast)).toBe(JSON.stringify(first.reportV2.sinceLast));
    expect(applied(recs)).toEqual(['Test Herbicide B']);
  });

  // ── every input read reports failure; any failure blocks the FIRST freeze ────
  const TURF_READING = {
    id: 'th-1', service_record_id: 'svc-cur', customer_id: CUSTOMER, manual_height_in: 1.5, range_status: 'below',
    target_min_in: 3.5, target_max_in: 4.0, measured_at: '2026-09-30T17:00:00Z',
  };
  const PRODUCT_ID = '11111111-2222-4333-8444-555555555555';
  const CATALOG_PRODUCTS = [{ id: 'sp-1', service_record_id: 'svc-cur', product_id: PRODUCT_ID, product_name: 'Test Herbicide B', product_category: 'herbicide', created_at: '2026-09-30T18:00:00Z' }];

  test('a failed turf-height read writes nothing; the recovery render freezes WITH the mowing check', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const recs = records();
    const failed = await withFixtures(recs, { turf_height_readings: FAIL });
    expect(failed.log.updates).toHaveLength(0);
    expect(recs['svc-cur'].structured_notes.lawnVisitMemory).toBeUndefined();
    expect(failed.data.lawnAssessment.weekWeatherUncacheable).toBe(true);
    // Delivery is not blocked: the report still renders without the mowing card.
    expect(failed.data.reportV2.mowing).toBeFalsy();
    expect(failed.data.reportV2.sinceLast.priorAssessmentId).toBe('la-prior');

    const ok = await withFixtures(recs, { turf_height_readings: [TURF_READING] });
    expect(ok.data.reportV2.mowing).toBeTruthy();
    expect(storedVisitMemoryFor(recs['svc-cur'].structured_notes, 'la-cur').checks).toContainEqual({ key: 'mowing', status: 'watch' });
    expect(ok.data.lawnAssessment.weekWeatherUncacheable).toBe(false);
  });

  // Each audited input read, run as a failure: no freeze, uncacheable, report still served.
  const FAILING_READS = [
    ['service_products', () => ({ service_products: FAIL })],
    ['catalog enrichment', () => ({ service_products: CATALOG_PRODUCTS, products_catalog: FAIL })],
    ['customer_turf_profiles', () => ({ customer_turf_profiles: FAIL })],
    ['property_preferences', () => ({ property_preferences: FAIL })],
    ['turf_height_readings', () => ({ turf_height_readings: FAIL })],
    ['lawn_water_intake_snapshots (area snapshot and gap history)', () => ({ lawn_water_intake_snapshots: FAIL })],
    ['week weather fetch', () => {
      conditions.fetchServiceWeekWeather.mockRejectedValueOnce(new Error('provider down'));
      return {};
    }, { customer_latitude: 27.5, customer_longitude: -82.5 }, true],
    ['week plan lookup', () => {
      const real = featureGates.isEnabled.bind(featureGates);
      jest.spyOn(featureGates, 'isEnabled').mockImplementation((name) => (name === 'irrigationWeekPlan' ? true : real(name)));
      weekPlan.loadCurrentWeekPlan.mockImplementationOnce(async (_id, opts) => { opts.onFailure(new Error('db down')); return null; });
      return {};
    }],
  ];
  test.each(FAILING_READS)('failing read: %s writes nothing and is uncacheable; recovery freezes', async (_name, arrange, serviceExtra = {}, unfrozenWeek = false) => {
    live();
    setHistory([PRIOR, CUR]);
    const recs = records();
    // The frozen week replays instead of fetching; this case needs a live fetch.
    if (unfrozenWeek) delete recs['svc-cur'].structured_notes.lawnWeekWeather;
    const svc = { ...service(recs['svc-cur'].structured_notes), ...serviceExtra };
    const patch = arrange();
    const failed = await withFixtures(recs, patch, svc);
    expect(failed.data.reportV2).toBeTruthy();
    expect(failed.log.updates).toHaveLength(0);
    expect(recs['svc-cur'].structured_notes.lawnVisitMemory).toBeUndefined();
    expect(failed.data.lawnAssessment.weekWeatherUncacheable).toBe(true);

    // Recovery: the same record, every read healthy this time.
    if (featureGates.isEnabled('irrigationWeekPlan')) weekPlan.loadCurrentWeekPlan.mockResolvedValueOnce(null);
    const recovered = await withFixtures(recs, patch.service_products && patch.products_catalog
      ? { service_products: CATALOG_PRODUCTS, products_catalog: [{ id: PRODUCT_ID, name: 'Test Herbicide B', category: 'herbicide' }] }
      : {});
    expect(recovered.log.updates).toHaveLength(1);
    expect(applied(recs)).toEqual(['Test Herbicide B']);
  });

  test('a degraded read never blocks delivery: only caching (the delivery flags stay clear)', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const { data } = await withFixtures(records(), { turf_height_readings: FAIL });
    expect(data.lawnAssessment.weekWeatherUnfrozen).toBe(false);
    expect(data.lawnAssessment.portalPrefsReadFailed).toBe(false);
  });

  test('the first (no turf-height) freeze is never repaired by a later render, which is why a failed read must not create it', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const recs = records();
    await withFixtures(recs, {}); // a HEALTHY read with no reading: a legitimate absence freezes
    expect(storedVisitMemoryFor(recs['svc-cur'].structured_notes, 'la-cur').checks.find((c) => c.key === 'mowing')).toBeUndefined();
    await withFixtures(recs, { turf_height_readings: [TURF_READING] });
    expect(storedVisitMemoryFor(recs['svc-cur'].structured_notes, 'la-cur').checks.find((c) => c.key === 'mowing')).toBeUndefined();
  });

  test('a frozen render is cacheable and never re-reads the prior record', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const recs = records();
    await render(recs);
    const { data, log } = await render(recs);
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(false);
    expect(log.reads).toHaveLength(0);
    expect(log.updates).toHaveLength(0);
  });

  test('the public payload carries no raw memory entry or record id', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const { data } = await render(records());
    expect(JSON.stringify(data)).not.toMatch(/lawnVisitMemory|svc-prior/);
  });
});

// ── P13: the progress engine on the report object ───────────────────────────
// Server-internal until P14: reportV2.progress exists in process, but is not an
// enumerable key, so it never reaches the public payload.
describe('GATE_LAWN_VISIT_MEMORY progress block (P13)', () => {
  const ENV = ['GATE_LAWN_VISIT_MEMORY', 'GATE_LAWN_PROPERTY_HISTORY', 'GATE_IRRIGATION_WEEK_PLAN'];
  const saved = {};
  beforeEach(() => { ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); jest.clearAllMocks(); });
  afterEach(() => { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

  const WEEK = { assessmentId: 'la-cur', serviceDate: '2026-09-30', rainInches: 1, et0Inches: 1, dailyRain: [], rainConfidence: 'high' };
  const records = (priorEntry = PRIOR_ENTRY) => ({
    'svc-cur': { structured_notes: { lawnWeekWeather: { 'la-cur': WEEK } } },
    'svc-prior': { structured_notes: { lawnVisitMemory: { 'la-prior': priorEntry } } },
  });
  const live = () => { process.env.GATE_LAWN_VISIT_MEMORY = 'true'; process.env.GATE_LAWN_PROPERTY_HISTORY = 'true'; };
  const photo = (id, quality, assessmentId = 'la-cur') => ({
    id, assessment_id: assessmentId, customer_visible: true, is_best_photo: false, quality_score: quality, photo_order: 1, photo_type: 'general',
  });
  // The prior read's own photos: its confidence gates the comparison too.
  const PRIOR_PHOTOS = [photo('pp1', 80, 'la-prior'), photo('pp2', 80, 'la-prior')];
  const render = (recs, patch = {}) => {
    const { knex } = withRecords({ ...fixtures(), ...patch }, recs);
    return buildReportV1Data(service(recs['svc-cur'].structured_notes), 'token-p13', knex, {});
  };

  test('gate off: no progress, and nothing in the payload names it', async () => {
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    setHistory([PRIOR, CUR]);
    const { reportV2 } = await render(records());
    expect(reportV2.progress).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(reportV2, 'progress')).toBeUndefined();
  });

  test('gate on with a prior: progress is built from the prior\'s frozen memory and both visits\' scores', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const recs = records({ ...PRIOR_ENTRY, applied: [{ name: 'Celsius WG', kind: 'herbicide', tag: 'weed control', targets: [] }] });
    const data = await render(recs, { lawn_assessment_photos: [photo('p1', 80), photo('p2', 80), ...PRIOR_PHOTOS] });
    const progress = data.reportV2.progress;
    expect(progress).toMatchObject({ v: 1, eligible: true, daysSincePrior: 60, confidence: { level: 'moderate', comparable: true } });
    expect(progress.overall.direction).toBe('flat'); // the two visits carry the same scores
    const weed = progress.items.find((i) => i.rowId === 'herbicide_broadleaf');
    // 60 days after the herbicide with no gain in weed suppression: the window has closed.
    expect(weed).toMatchObject({ kind: 'applied', metric: 'weed_suppression', state: 'behind', approved: true });
    // The prior's "weeds" check was never rechecked by a technician: unclear, not_recorded.
    expect(progress.items.find((i) => i.kind === 'check')).toMatchObject({ key: 'weeds', state: 'unclear', recheck: 'not_recorded' });
  });

  test('no photo evidence on this render reads as unclear, never a verdict', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const recs = records({ ...PRIOR_ENTRY, applied: [{ name: 'Celsius WG', kind: 'herbicide', tag: 'weed control', targets: [] }] });
    const { reportV2 } = await render(recs); // fixtures() has no lawn_assessment_photos rows
    expect(reportV2.progress.confidence.level).toBe('insufficient');
    expect(reportV2.progress.items.find((i) => i.rowId === 'herbicide_broadleaf').state).toBe('unclear');
    expect(reportV2.progress.overall.direction).toBe('unknown');
  });

  test('the progress block is NOT part of the public payload: not enumerable, not in JSON, not in a spread', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const data = await render(records(), { lawn_assessment_photos: [photo('p1', 80), photo('p2', 80), ...PRIOR_PHOTOS] });
    expect(data.reportV2.progress).toBeTruthy();
    expect(Object.keys(data.reportV2)).not.toContain('progress');
    expect(JSON.stringify(data)).not.toMatch(/"progress"|lawn_progress|engineVersion/);
    expect({ ...data.reportV2 }.progress).toBeUndefined();
  });

  test('the public payload with the gate on differs from gate off by sinceLast alone (the engine adds no key)', async () => {
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    setHistory([PRIOR, CUR]);
    const patch = { lawn_assessment_photos: [photo('p1', 80), photo('p2', 80), ...PRIOR_PHOTOS] };
    const off = JSON.parse(JSON.stringify(await render(records(), patch)));
    live();
    const on = JSON.parse(JSON.stringify(await render(records(), patch)));
    expect(on.reportV2.sinceLast.priorAssessmentId).toBe('la-prior');
    delete on.reportV2.sinceLast;
    expect(on).toEqual(off);
  });

  test('a first (baseline) visit has no comparison, and says so only in process', async () => {
    live();
    setHistory([CUR]);
    const data = await render(records());
    expect(data.reportV2.progress).toMatchObject({ eligible: false, reason: 'baseline', items: [] });
    expect(JSON.stringify(data)).not.toContain('"baseline"');
  });

  test('a visit whose only other row is in its future has no prior: no_prior, not a comparison', async () => {
    live();
    const FUTURE = assessmentRow('la-future', '2026-11-01', 'svc-future');
    setHistory([FUTURE, CUR]);
    const data = await render(records());
    expect(data.reportV2.progress).toMatchObject({ eligible: false, reason: 'no_prior', items: [] });
  });

  test('decimal quality scores arrive from pg as strings and still count ("80.00" is adequate)', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const data = await render(records(), { lawn_assessment_photos: [photo('p1', '80.00'), photo('p2', '80.00'), ...PRIOR_PHOTOS] });
    expect(data.reportV2.progress.confidence).toMatchObject({ level: 'moderate', comparable: true });
  });

  test('legacy photos (health-blend quality_score) count by their binary gate: usable, never adequate', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const legacy = (id, blend) => ({ ...photo(id, blend), turf_density: 20, weed_coverage: 70, color_health: 3, quality_gate_passed: true });
    // A low blend no longer reads as a bad photo, and a high blend no longer as a good one.
    const data = await render(records(), { lawn_assessment_photos: [legacy('p1', '30.00'), legacy('p2', '95.00'), ...PRIOR_PHOTOS] });
    expect(data.reportV2.progress.confidence).toMatchObject({ level: 'low', comparable: false });
  });

  test('a frozen sinceLast pins the prior: a visit added between them later never supplies the scores', async () => {
    live();
    const MID = assessmentRow('la-mid', '2026-09-01', 'svc-mid');
    setHistory([PRIOR, MID, CUR]);
    const recs = records();
    const FROZEN_SINCE = {
      v: 1, priorAssessmentId: 'la-prior', priorDate: '2026-08-01',
      applied: PRIOR_ENTRY.applied, checks: PRIOR_ENTRY.checks,
    };
    recs['svc-cur'].structured_notes.lawnVisitMemory = {
      'la-cur': { v: 1, assessmentId: 'la-cur', serviceDate: '2026-09-30', applied: [], checks: [], sinceLast: FROZEN_SINCE },
    };
    const data = await render(recs, { lawn_assessment_photos: [photo('p1', 80), photo('p2', 80), ...PRIOR_PHOTOS] });
    expect(data.reportV2.sinceLast.priorAssessmentId).toBe('la-prior');
    // Judged against la-prior (60 days), not the later-added la-mid (29 days).
    expect(data.reportV2.progress).toMatchObject({ eligible: true, daysSincePrior: 60 });
  });

  test('a frozen prior that is no longer in history judges nothing', async () => {
    live();
    const MID = assessmentRow('la-mid', '2026-09-01', 'svc-mid');
    setHistory([MID, CUR]);
    const recs = records();
    recs['svc-cur'].structured_notes.lawnVisitMemory = {
      'la-cur': {
        v: 1, assessmentId: 'la-cur', serviceDate: '2026-09-30', applied: [], checks: [],
        sinceLast: { v: 1, priorAssessmentId: 'la-gone', priorDate: '2026-08-01', applied: PRIOR_ENTRY.applied, checks: PRIOR_ENTRY.checks },
      },
    };
    const data = await render(recs, { lawn_assessment_photos: [photo('p1', 80), photo('p2', 80), ...PRIOR_PHOTOS] });
    expect(data.reportV2.progress).toMatchObject({ eligible: false, items: [] });
  });

  test('a prior read with no usable photos makes the comparison unclear (fail closed)', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const recs = records({ ...PRIOR_ENTRY, applied: [{ name: 'Celsius WG', kind: 'herbicide', tag: 'weed control', targets: [] }] });
    const data = await render(recs, { lawn_assessment_photos: [photo('p1', 80), photo('p2', 80)] });
    expect(data.reportV2.progress.confidence).toMatchObject({ level: 'moderate', comparable: false });
    expect(data.reportV2.progress.items.find((i) => i.rowId === 'herbicide_broadleaf').state).toBe('unclear');
    expect(data.reportV2.progress.overall.direction).toBe('unknown');
  });

  test('a prior that froze no memory pins nothing, so nothing is compared (no live fallback)', async () => {
    live();
    setHistory([PRIOR, CUR]);
    const recs = records();
    recs['svc-prior'].structured_notes = {};
    const data = await render(recs, { lawn_assessment_photos: [photo('p1', 80), photo('p2', 80), ...PRIOR_PHOTOS] });
    expect(data.reportV2.sinceLast).toBeUndefined();
    expect(data.reportV2.progress).toMatchObject({ eligible: false, reason: 'no_prior', items: [] });
  });
});

// ── GATE_LAWN_SINCE_LAST: the customer copy, through the real builder ────────
// The sentences are selected in buildReportV1Data (the progress block never
// leaves the process) and reach the payload only as reportV2.lead.sinceLast,
// after the reconcile tail derives the lead.
describe('GATE_LAWN_SINCE_LAST on the report payload', () => {
  const { applyLawnReportReconciliation } = require('../services/service-report/report-consistency');
  const ENV = ['GATE_LAWN_VISIT_MEMORY', 'GATE_LAWN_PROPERTY_HISTORY', 'GATE_IRRIGATION_WEEK_PLAN', 'GATE_LAWN_SINCE_LAST', 'GATE_LAWN_REPORT_LEAD'];
  const saved = {};
  beforeEach(() => { ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); jest.clearAllMocks(); });
  afterEach(() => { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

  const WEEK = { assessmentId: 'la-cur', serviceDate: '2026-09-30', rainInches: 1, et0Inches: 1, dailyRain: [], rainConfidence: 'high' };
  const HERBICIDE_ENTRY = { ...PRIOR_ENTRY, applied: [{ name: 'Celsius WG', kind: 'herbicide', tag: 'weed control', targets: [] }] };
  const records = (priorEntry = HERBICIDE_ENTRY) => ({
    'svc-cur': { structured_notes: { lawnWeekWeather: { 'la-cur': WEEK } } },
    'svc-prior': { structured_notes: { lawnVisitMemory: { 'la-prior': priorEntry } } },
  });
  const photo = (id, quality, assessmentId = 'la-cur') => ({
    id, assessment_id: assessmentId, customer_visible: true, is_best_photo: false, quality_score: quality, photo_order: 1, photo_type: 'general',
  });
  const PHOTOS = { lawn_assessment_photos: [photo('p1', 80), photo('p2', 80), photo('pp1', 80, 'la-prior'), photo('pp2', 80, 'la-prior')] };
  const live = (...gates) => {
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    gates.forEach((gate) => { process.env[gate] = 'true'; });
  };
  const ALL = ['GATE_LAWN_VISIT_MEMORY', 'GATE_LAWN_REPORT_LEAD', 'GATE_LAWN_SINCE_LAST'];
  // What the public route does with the built payload before it serializes it.
  const served = async (recs, patch = {}, mode = 'live') => {
    const { knex } = withRecords({ ...fixtures(), ...patch }, recs);
    const data = await buildReportV1Data(service(recs['svc-cur'].structured_notes), 'token-since-last', knex, mode ? { mode } : {});
    applyLawnReportReconciliation(data, null);
    return data;
  };

  test('all three gates on with a prior: the lead carries the block, and no other key appears', async () => {
    setHistory([PRIOR, CUR]);
    live('GATE_LAWN_VISIT_MEMORY', 'GATE_LAWN_REPORT_LEAD');
    const without = JSON.parse(JSON.stringify(await served(records(), PHOTOS)));
    live(...ALL);
    const data = await served(records(), PHOTOS);
    expect(data.reportV2.lead.sinceLast.priorDate).toBe('2026-08-01');
    // Same scores on both visits: overall flat. The herbicide row is owner
    // approved (2026-10-02), so its 'behind' state is spoken.
    expect(data.reportV2.lead.sinceLast.lines).toEqual([
      'Last visit we applied weed control.',
      'Your overall lawn score is holding steady.',
      'Weed control is behind where we expected.',
    ]);
    const json = JSON.parse(JSON.stringify(data));
    expect(JSON.stringify(json)).not.toMatch(/sinceLastCopy|"progress"|engineVersion/);
    delete json.reportV2.lead.sinceLast;
    expect(json).toEqual(without);
  });

  test.each([
    ['the since-last gate off', ['GATE_LAWN_VISIT_MEMORY', 'GATE_LAWN_REPORT_LEAD']],
    ['the memory gate off', ['GATE_LAWN_REPORT_LEAD', 'GATE_LAWN_SINCE_LAST']],
    ['the lead gate off', ['GATE_LAWN_VISIT_MEMORY', 'GATE_LAWN_SINCE_LAST']],
  ])('%s: no block is built and nothing names it', async (_label, gates) => {
    setHistory([PRIOR, CUR]);
    live(...gates);
    const data = await served(records(), PHOTOS);
    expect(Object.getOwnPropertyDescriptor(data.reportV2, 'sinceLastCopy')).toBeUndefined();
    expect(JSON.stringify(data)).not.toMatch(/"lines":\["Last visit/);
    if (data.reportV2.lead) expect(Object.prototype.hasOwnProperty.call(data.reportV2.lead, 'sinceLast')).toBe(false);
  });

  // The PDF and static renders mount the same lead card, and the PDF cache
  // key does not vary on this gate or on what the lines depend on.
  test.each([['pdf', 'pdf'], ['static', 'static'], ['the PDF queue (no mode)', null]])(
    'a %s build never carries the block: its payload is the live one minus lead.sinceLast',
    async (_label, mode) => {
      setHistory([PRIOR, CUR]);
      live(...ALL);
      const data = await served(records(), PHOTOS, mode);
      expect(Object.getOwnPropertyDescriptor(data.reportV2, 'sinceLastCopy')).toBeUndefined();
      expect(data.reportV2.lead).toBeTruthy();
      expect(Object.prototype.hasOwnProperty.call(data.reportV2.lead, 'sinceLast')).toBe(false);
    },
  );

  test('photos that cannot support a comparison: the applied line only, never a direction or a state', async () => {
    setHistory([PRIOR, CUR]);
    live(...ALL);
    const data = await served(records()); // no lawn_assessment_photos rows
    expect(data.reportV2.lead.sinceLast.lines).toEqual(['Last visit we applied weed control.']);
  });

  test('no prior, or a prior that froze no memory: no block', async () => {
    live(...ALL);
    setHistory([CUR]);
    const first = await served(records(), PHOTOS);
    expect(Object.prototype.hasOwnProperty.call(first.reportV2.lead, 'sinceLast')).toBe(false);
    setHistory([PRIOR, CUR]);
    const recs = records();
    recs['svc-prior'].structured_notes = {};
    const unfrozen = await served(recs, PHOTOS);
    expect(Object.prototype.hasOwnProperty.call(unfrozen.reportV2.lead, 'sinceLast')).toBe(false);
  });

  test('a re-render of the same frozen visit serves the same block', async () => {
    setHistory([PRIOR, CUR]);
    live(...ALL);
    const recs = records();
    const first = await served(recs, PHOTOS);
    const again = await served(recs, PHOTOS);
    expect(again.reportV2.lead.sinceLast).toEqual(first.reportV2.lead.sinceLast);
  });
});
