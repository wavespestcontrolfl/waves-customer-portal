// GATE_LAWN_NEW_SOD_MODE with GATE_LAWN_REPORT_COPY_V6 (P35): while new-sod mode is
// ACTIVE for the visit, the v6 durable freeze is neither written nor replayed, and the
// lead's headline / watching / what-to-expect for that render come from fixed sentences
// computed in memory. Gate off, or the mode inactive, is the normal freeze path.
// Synthetic data only.

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
const { storedLawnCopyV6For } = require('../services/service-report/lawn-copy-v6');
const { buildTreatmentSummary } = require('../services/service-report/treatment-summary');

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

const WEEK = { assessmentId: 'la-cur', serviceDate: '2026-09-30', rainInches: 1, et0Inches: 1, dailyRain: [], rainConfidence: 'high' };
const NARRATIVE_LANE = 'lawn_visit_narratives';
const narrativeCalls = () => dispatchWithFallback.mock.calls.filter(([, payload]) => payload && payload.laneId === NARRATIVE_LANE);


const SOD = '2026-09-25'; // visit 2026-09-30 is day 5
const identity = () => ({
  'service_records as sr': [{ 'sr.id': 'svc-cur', service_date: '2026-09-30', scheduled_service_id: 'ss-cur', customer_id: CUSTOMER }],
  'scheduled_services as ss': [{
    'ss.id': 'ss-cur', id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-09-30', property_id: null, source_estimate_id: null,
    service_address_line1: '100 Example Court', service_address_line2: null, service_address_city: 'Bradenton', service_address_zip: '34201',
  }],
  'customers as c': [{ 'c.id': CUSTOMER, address_line1: '100 Example Court', address_line2: null, city: 'Bradenton', zip: '34201', has_multi_home: false }],
});

// A NORMAL freeze made before the sod date was entered: its copy is watering-derived.
const NORMAL_FREEZE = {
  v: 1, copyVersion: 'lawn_report_v6_fixed_1', assessmentId: 'la-cur', frozenAt: '2026-09-30T19:00:00.000Z',
  fields: { headline: 'Stable — watching watering', whatWeDid: 'We applied a weed control product.', whatToExpect: 'Ease back on irrigation for a week.', watching: 'We are also keeping an eye on watering and mowing height.' },
  expectRows: [], expectSentences: null, nextVisitIso: null,
};

describe('new-sod mode and the lawn v6 copy freeze', () => {
  const ENV = ['GATE_LAWN_REPORT_COPY_V6', 'GATE_LAWN_REPORT_LEAD', 'GATE_LAWN_NEW_SOD_MODE', 'LAWN_REPORT_V2_NARRATIVE'];
  const saved = {};
  beforeEach(() => {
    ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
    jest.clearAllMocks();
    history.installedForVisit.mockResolvedValue(CUR);
    history.historyForReport.mockResolvedValue({ current: CUR, rows: [CUR], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    history.historyForAssessment.mockResolvedValue({ current: CUR, rows: [CUR], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'no_key' });
    process.env.GATE_LAWN_REPORT_COPY_V6 = 'true';
    process.env.GATE_LAWN_REPORT_LEAD = 'true';
  });
  afterEach(() => { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

  const records = (extra = {}) => ({ 'svc-cur': { structured_notes: { lawnWeekWeather: { 'la-cur': WEEK }, ...extra } } });
  const render = async (recs, { sod = SOD } = {}) => {
    const { knex, log } = withRecords({ ...fixtures(), property_preferences: [{ customer_id: CUSTOMER, sod_laid_on: sod }], ...identity() }, recs);
    const data = await buildReportV1Data(service(recs['svc-cur'].structured_notes), 'token-p35', knex, {});
    return { data, log };
  };
  const lead = (data) => applyLawnReportReconciliation({ ...data }, null).reportV2.lead;
  const frozenKey = (recs) => (recs['svc-cur'].structured_notes || {}).lawnCopyV6;

  test('control (new-sod gate off, sod date set): the normal freeze is written and carried, byte-identical to today', async () => {
    const recs = records();
    const { data, log } = await render(recs);
    expect(log.updates).toHaveLength(1);
    expect(storedLawnCopyV6For(recs['svc-cur'].structured_notes, 'la-cur')).toBeTruthy();
    expect(data.reportV2.banner?.state).not.toBe('new_sod');
    expect(lead(data).headline).toBe(data.reportV2.copyV6.headline);
  });

  test('active: nothing is written to the v6 freeze, and the lead carries the fixed new-sod sentences', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const recs = records();
    const { data, log } = await render(recs);
    expect(data.reportV2.banner.state).toBe('new_sod');
    expect(log.updates).toHaveLength(0);
    expect(frozenKey(recs)).toBeUndefined();
    const l = lead(data);
    expect(l.whatToExpect).toBe('Once the sod has rooted, you can start mowing and we can begin your regular lawn care.');
    expect(l.applied).toBe(buildTreatmentSummary(data.reportV2.treatment, { noTiming: true }));
    expect(l.applied).toBeTruthy();
    expect(Object.keys(l)).not.toContain('watching');
    // Not marked unfrozen: nothing was meant to freeze.
    expect(data.lawnAssessment.lawnCopyV6Unfrozen).toBeUndefined();
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(false);
  });

  test('active: an older NORMAL freeze (watering-derived copy) is not replayed into the new-sod report', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const recs = records({ lawnCopyV6: { 'la-cur': NORMAL_FREEZE } });
    const { data, log } = await render(recs);
    expect(log.updates).toHaveLength(0);
    const l = lead(data);
    expect(JSON.stringify(l)).not.toMatch(/Stable — watching watering|Ease back on irrigation|keeping an eye on watering/);
    expect(l.whatToExpect).toBe('Once the sod has rooted, you can start mowing and we can begin your regular lawn care.');
    // And the stored entry is left exactly as it was.
    expect(frozenKey(recs)['la-cur']).toEqual(NORMAL_FREEZE);
  });

  test('the gate goes off later: the untouched normal freeze replays again', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const recs = records({ lawnCopyV6: { 'la-cur': NORMAL_FREEZE } });
    await render(recs);
    delete process.env.GATE_LAWN_NEW_SOD_MODE;
    const { data } = await render(recs);
    const l = lead(data);
    expect(l.headline).toBe('Stable — watching watering');
    expect(l.whatToExpect).toBe('Ease back on irrigation for a week.');
    expect(l.watching).toBe('We are also keeping an eye on watering and mowing height.');
  });

  test('a render while active never leaves new-sod copy behind for the gate-off render that follows', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const recs = records();
    await render(recs); // active: no freeze written
    delete process.env.GATE_LAWN_NEW_SOD_MODE;
    const { data, log } = await render(recs); // gate off: freezes from the NORMAL report
    expect(log.updates).toHaveLength(1);
    expect(JSON.stringify(lead(data))).not.toMatch(/sod/i);
    expect(JSON.stringify(frozenKey(recs))).not.toMatch(/sod/i);
  });

  test('mode inactive (the visit is past day 21): the normal freeze path, written and replayed', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const recs = records();
    const { log } = await render(recs, { sod: '2026-08-01' });
    expect(log.updates).toHaveLength(1);
    expect(storedLawnCopyV6For(recs['svc-cur'].structured_notes, 'la-cur')).toBeTruthy();
  });
});
