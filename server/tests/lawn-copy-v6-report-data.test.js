// GATE_LAWN_REPORT_COPY_V6 (lawn report rebuild P14) through the real report
// builder (buildReportV1Data) and the reconcile pass. The model is mocked at
// the shared dispatcher: no production LLM API is called. Synthetic data only.
//
// Pins: gate off (or lead gate off) = no model call, no write, no key, the same
// payload and PDF signature as before; gate on = the writer's fields freeze at
// the first render (first writer wins per assessment) and reach the customer
// only through reportV2.lead (the carrier never leaves the process); a later
// render replays byte for byte and never calls the model; a degraded read or an
// unavailable model creates no freeze and ships the deterministic lead copy.

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

const history = require('../services/lawn-assessment-history');
const { dispatchWithFallback } = require('../services/llm/call');
const { buildReportV1Data, resolveCanonicalLawnRender } = require('../services/service-report/report-data');
const { applyLawnReportReconciliation } = require('../services/service-report/report-consistency');
const { storedLawnCopyV6For, _test: v6Test } = require('../services/service-report/lawn-copy-v6');

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
        if (!sql.includes('lawnCopyV6')) return 1; // week-weather / other freezes: out of scope here
        if (hooks.failUpdate) throw new Error('update failed');
        const rec = records[ctx.where.id];
        if (!rec) return 0;
        const map = (rec.structured_notes && rec.structured_notes.lawnCopyV6) || {};
        if (map[ctx.binding] != null) return 0;
        const add = JSON.parse(patch.structured_notes.bindings[0]);
        rec.structured_notes = { ...rec.structured_notes, lawnCopyV6: { ...map, ...add } };
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


const CUSTOMER = 'cust-lawn-p14';
const SCORES = { turf_density: 78, weed_suppression: 82, color_health: 75, stress_damage: 30 };
const CUR = {
  id: 'la-cur', customer_id: CUSTOMER, service_record_id: 'svc-cur', confirmed_by_tech: true,
  service_date: '2026-09-30', visit_date: '2026-09-30', created_at: '2026-09-30T14:00:00Z', history_record_id: 'svc-cur', ...SCORES,
};
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

const MODEL_OUT = {
  headline: 'Healthy overall, with a few spots to watch',
  whatWeDid: 'We applied a selective weed control to the weeds we found.',
  watching: 'Thin areas along the driveway edge, which may be signs of heat stress.',
};
const WEEK = { assessmentId: 'la-cur', serviceDate: '2026-09-30', rainInches: 1, et0Inches: 1, dailyRain: [], rainConfidence: 'high' };
const V6_LANE = 'lawn_visit_narratives';
const v6Calls = () => dispatchWithFallback.mock.calls.filter(([, payload]) => payload && payload.laneId === V6_LANE);

describe('GATE_LAWN_REPORT_COPY_V6 on the report payload', () => {
  const ENV = ['GATE_LAWN_REPORT_COPY_V6', 'GATE_LAWN_REPORT_LEAD', 'LAWN_REPORT_V2_NARRATIVE'];
  const saved = {};
  beforeEach(() => {
    ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
    jest.clearAllMocks();
    v6Test._cache.clear();
    history.installedForVisit.mockResolvedValue(CUR);
    history.historyForReport.mockResolvedValue({ current: CUR, rows: [CUR], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    history.historyForAssessment.mockResolvedValue({ current: CUR, rows: [CUR], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    dispatchWithFallback.mockImplementation(async (_policy, payload) => (
      payload && payload.laneId === V6_LANE ? { ok: true, json: MODEL_OUT } : { ok: false, reason: 'no_key' }
    ));
  });
  afterEach(() => { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

  const records = () => ({ 'svc-cur': { structured_notes: { lawnWeekWeather: { 'la-cur': WEEK } } } });
  const render = (recs, patch = {}, svc = service(recs['svc-cur'].structured_notes), hooks) => {
    const { knex, log } = withRecords({ ...fixtures(), ...patch }, recs, hooks);
    return buildReportV1Data(svc, 'token-p14', knex, {}).then((data) => ({ data, log }));
  };
  const live = () => { process.env.GATE_LAWN_REPORT_COPY_V6 = 'true'; process.env.GATE_LAWN_REPORT_LEAD = 'true'; };
  // The hand-off is non-enumerable (a clone would drop it): reconcile a shallow copy, as the route does.
  const reconciled = (data) => applyLawnReportReconciliation({ ...data }, null);

  test('gate off: no model call, no write, no key, and the payload is what it was', async () => {
    const recs = records();
    const { data, log } = await render(recs);
    expect(v6Calls()).toHaveLength(0);
    expect(log.updates).toHaveLength(0);
    expect(recs['svc-cur'].structured_notes.lawnCopyV6).toBeUndefined();
    expect(data.reportV2.copyV6).toBeUndefined();
    expect(JSON.stringify(reconciled(data))).not.toMatch(/copyV6|lawnCopyV6/);
  });

  test('the v6 gate alone (lead gate off) is inert: byte-identical payload, no call, no write', async () => {
    const base = (await render(records())).data;
    process.env.GATE_LAWN_REPORT_COPY_V6 = 'true';
    const recs = records();
    const { data, log } = await render(recs);
    expect(v6Calls()).toHaveLength(0);
    expect(log.updates).toHaveLength(0);
    expect(JSON.parse(JSON.stringify(data))).toEqual(JSON.parse(JSON.stringify(base)));
  });

  test('while v6 is live the old narrative overlay does not run, even with LAWN_REPORT_V2_NARRATIVE set (v6 prompt and version ride the one call)', async () => {
    process.env.LAWN_REPORT_V2_NARRATIVE = 'true';
    live();
    await render(records());
    expect(dispatchWithFallback.mock.calls.filter(([, p]) => p && p.laneId === 'lawn_visit_narratives')).toHaveLength(1);
    // The old path's prompt carries the old structured facts; v6's carries the v6 contract.
    const [, payload] = v6Calls()[0];
    expect(payload.system).toContain('OUTPUT CONTRACT');
    expect(payload.promptVersion).toBe('lawn_report_v6_structural_1');
  });

  test('gate on: the first render freezes the fields once and the lead carries them; the carrier never leaves the payload', async () => {
    live();
    const recs = records();
    const { data, log } = await render(recs);
    expect(v6Calls()).toHaveLength(1);
    expect(log.updates).toHaveLength(1);
    const frozen = storedLawnCopyV6For(recs['svc-cur'].structured_notes, 'la-cur');
    // Today's expectation table has no approved row, so whatToExpect is null.
    expect(frozen.fields).toEqual({
      headline: MODEL_OUT.headline, whatWeDid: MODEL_OUT.whatWeDid, whatToExpect: null, watching: MODEL_OUT.watching,
    });
    expect(data.reportV2.copyV6).toEqual(frozen.fields);
    const out = reconciled(data);
    expect(out.reportV2.lead.headline).toBe(MODEL_OUT.headline);
    expect(out.reportV2.lead.applied).toBe(MODEL_OUT.whatWeDid);
    // Today's table has no approved row: the optional key is absent, not null.
    expect(Object.keys(out.reportV2.lead)).not.toContain('whatToExpect');
    expect(out.reportV2.lead.watching).toBe(MODEL_OUT.watching);
    expect(Object.prototype.hasOwnProperty.call(out.reportV2, 'copyV6')).toBe(false);
    expect(JSON.stringify(out)).not.toContain('copyV6');
    // Even before reconciliation the carrier is not an enumerable payload key.
    expect(Object.keys(data.reportV2)).not.toContain('copyV6');
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(false);
  });

  test('a later render replays byte for byte and never calls the model, whatever the model would now say', async () => {
    live();
    const recs = records();
    const first = (await render(recs)).data;
    jest.clearAllMocks();
    v6Test._cache.clear();
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { headline: 'Something else entirely', whatWeDid: 'We applied a feed.', watching: 'Thin areas.' } });
    const again = (await render(recs, {}, service(recs['svc-cur'].structured_notes))).data;
    expect(v6Calls()).toHaveLength(0);
    expect(JSON.stringify(again.reportV2.copyV6)).toBe(JSON.stringify(first.reportV2.copyV6));
  });

  test('a failed freeze serves the copy and marks the render uncacheable', async () => {
    live();
    const { data } = await render(records(), {}, undefined, { failUpdate: true });
    expect(data.reportV2.copyV6.headline).toBe(MODEL_OUT.headline);
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(true);
  });

  test('a degraded read (a failed service_products read) calls no model, creates no freeze, and ships the deterministic copy', async () => {
    live();
    const recs = records();
    const { data, log } = await render(recs, { service_products: FAIL });
    expect(v6Calls()).toHaveLength(0);
    expect(log.updates).toHaveLength(0);
    expect(recs['svc-cur'].structured_notes.lawnCopyV6).toBeUndefined();
    expect(data.reportV2.copyV6).toBeUndefined();
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(true);
    // The next healthy render freezes.
    const next = await render(recs);
    expect(storedLawnCopyV6For(recs['svc-cur'].structured_notes, 'la-cur')).toBeTruthy();
    expect(next.data.lawnAssessment.weekWeatherUncacheable).toBe(false);
  });

  test("a failed read of this visit's photos (progress confidence) is a degraded read: no model, no freeze; recovery freezes", async () => {
    live();
    const recs = records();
    const { data } = await render(recs, { lawn_assessment_photos: FAIL });
    expect(v6Calls()).toHaveLength(0);
    expect(recs['svc-cur'].structured_notes.lawnCopyV6).toBeUndefined();
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(true);
    await render(recs);
    expect(storedLawnCopyV6For(recs['svc-cur'].structured_notes, 'la-cur')).toBeTruthy();
  });

  test('a failed next-visit read (the visit gap the writer reads) is a degraded read: no model, no freeze', async () => {
    live();
    const recs = records();
    // Only the next-visit lookup fails; every other scheduled_services read answers.
    const { knex: base } = withRecords(fixtures(), recs);
    const knex = (table) => {
      const q = base(table);
      if (table !== 'scheduled_services') return q;
      const first = q.first;
      q.first = (...args) => (args[0] === 'scheduled_date' ? Promise.reject(new Error('read failed')) : first(...args));
      return q;
    };
    knex.raw = base.raw;
    const data = await buildReportV1Data(service(recs['svc-cur'].structured_notes), 'token-p14', knex, {});
    expect(v6Calls()).toHaveLength(0);
    expect(recs['svc-cur'].structured_notes.lawnCopyV6).toBeUndefined();
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(true);
  });

  test('an unavailable model: deterministic lead, no freeze, uncacheable; the retry freezes', async () => {
    live();
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'openai_timeout' });
    const recs = records();
    const { data, log } = await render(recs);
    expect(log.updates).toHaveLength(0);
    expect(data.reportV2.copyV6).toBeUndefined();
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(true);
    const out = reconciled(data);
    expect(out.reportV2.lead.headline).toBe(data.reportV2.snapshot.statusHeadline);
    expect(Object.keys(out.reportV2.lead).sort()).toEqual(['applied', 'headline', 'next', 'why', 'yourPart']);
    dispatchWithFallback.mockImplementation(async (_p, payload) => (payload && payload.laneId === V6_LANE ? { ok: true, json: MODEL_OUT } : { ok: false }));
    v6Test._cache.clear();
    await render(recs);
    expect(storedLawnCopyV6For(recs['svc-cur'].structured_notes, 'la-cur')).toBeTruthy();
  });

  test('a model answer that breaks every guard falls back field by field: the lead keeps its deterministic sentences', async () => {
    live();
    dispatchWithFallback.mockImplementation(async (_p, payload) => (payload && payload.laneId === V6_LANE
      ? { ok: true, json: { headline: 'Up 5 points since August', whatWeDid: 'Today we applied Test Herbicide B within a week.', watching: 'Chinch bugs.' } }
      : { ok: false }));
    const { data } = await render(records());
    const out = reconciled(data);
    expect(out.reportV2.lead.headline).toBe(data.reportV2.snapshot.statusHeadline);
    expect(out.reportV2.lead.applied).toBe(data.reportV2.snapshot.treatmentSummary);
  });

  test('the PDF cache signature moves with the gate only while it is live (gate off is the signature it was)', async () => {
    const sig = async () => {
      const knex = makeKnex({ ...fixtures(), service_records: [] });
      return (await resolveCanonicalLawnRender({ id: 'svc-cur', customer_id: CUSTOMER, service_line: 'lawn', service_date: '2026-09-30' }, knex)).signature;
    };
    const off = await sig();
    process.env.GATE_LAWN_REPORT_COPY_V6 = 'true';
    expect(await sig()).toBe(off); // lead gate off: inert
    process.env.GATE_LAWN_REPORT_LEAD = 'true';
    delete process.env.GATE_LAWN_REPORT_COPY_V6;
    const leadOnlySig = await sig();
    process.env.GATE_LAWN_REPORT_COPY_V6 = 'true';
    const both = await sig();
    expect(leadOnlySig).not.toBe(off);
    expect(both).not.toBe(leadOnlySig);
  });
});
