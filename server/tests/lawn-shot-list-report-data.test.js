// GATE_LAWN_SHOT_LIST (lawn report rebuild P18) on the report payload: the
// photo limit 5 to 8, each photo's customer-facing zoneLabel, and the PDF cache
// signature. Gate off is the payload and signature this report has always had.
// Real report builder over an in-memory reader; synthetic data only.

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

function makeKnex(fixtures) {
  const knex = (table) => {
    const failing = false;
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



const CUSTOMER = 'cust-lawn-p18';
const CUR = {
  id: 'la-cur', customer_id: CUSTOMER, service_record_id: 'svc-cur', confirmed_by_tech: true,
  service_date: '2026-09-30', visit_date: '2026-09-30', created_at: '2026-09-30T14:00:00Z', history_record_id: 'svc-cur',
  turf_density: 78, weed_suppression: 82, color_health: 75, stress_damage: 30,
};
const ZONES = ['front', 'back', 'close_up', 'blade_crown', 'hot_edge', 'shade', 'trouble', 'trouble'];
const photoRows = () => ZONES.map((zone, i) => ({
  id: `ph-${i}`, assessment_id: 'la-cur', customer_visible: true, zone, photo_type: 'general',
  is_best_photo: i === 0, quality_score: 80 - i, photo_order: i,
}));
const fixtures = (photos = photoRows()) => ({
  service_products: [], property_geometries: [], property_zones: [], service_findings: [], service_photos: [],
  lawn_assessment_photos: photos, lawn_water_intake_snapshots: [],
  scheduled_services: [{ id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-09-30', status: 'completed', service_type: 'Lawn Care Treatment Program' }],
  property_preferences: [], service_records: [], lawn_assessments: [CUR],
});
const service = () => ({
  id: 'svc-cur', scheduled_service_id: 'ss-cur', customer_id: CUSTOMER, service_line: 'lawn',
  service_type: 'Lawn Care Treatment Program', service_date: '2026-09-30', completed_at: '2026-09-30T18:40:00Z',
  first_name: 'Test', last_name: 'Customer', areas_serviced: JSON.stringify(['Front Lawn']),
  structured_notes: JSON.stringify({}), service_data: JSON.stringify({}),
});

describe('GATE_LAWN_SHOT_LIST on the lawn report payload', () => {
  const saved = process.env.GATE_LAWN_SHOT_LIST;
  beforeEach(() => {
    jest.clearAllMocks();
    history.installedForVisit.mockResolvedValue(CUR);
    history.historyForReport.mockResolvedValue({ current: CUR, rows: [CUR], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    history.historyForAssessment.mockResolvedValue({ current: CUR, rows: [CUR], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'no_key' });
    delete process.env.GATE_LAWN_SHOT_LIST;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_LAWN_SHOT_LIST; else process.env.GATE_LAWN_SHOT_LIST = saved;
  });

  const render = async () => (await buildReportV1Data(service(), 'token-p18', makeKnex(fixtures()), {})).lawnAssessment;

  test('gate off: five photos, no zoneLabel key', async () => {
    const lawn = await render();
    expect(lawn.photos).toHaveLength(5);
    for (const photo of lawn.photos) expect(Object.prototype.hasOwnProperty.call(photo, 'zoneLabel')).toBe(false);
  });

  test('gate on: all eight photos, each with its customer-facing label, best photo first', async () => {
    process.env.GATE_LAWN_SHOT_LIST = 'true';
    const lawn = await render();
    expect(lawn.photos).toHaveLength(8);
    expect(lawn.photos[0]).toMatchObject({ zone: 'front', zoneLabel: 'Front yard', isBest: true });
    expect(lawn.photos.map((p) => p.zoneLabel)).toEqual([
      'Front yard', 'Back yard', 'Close-up', 'Blade close-up', 'Sunny edge', 'Shaded area', 'Trouble spot', 'Trouble spot',
    ]);
  });

  test('the PDF cache signature moves only while the gate is live', async () => {
    const sig = async () => (await resolveCanonicalLawnRender(
      { id: 'svc-cur', customer_id: CUSTOMER, service_line: 'lawn', service_date: '2026-09-30' },
      makeKnex(fixtures()),
    )).signature;
    const off = await sig();
    expect(await sig()).toBe(off);
    process.env.GATE_LAWN_SHOT_LIST = 'true';
    const on = await sig();
    expect(on).not.toBe(off);
    delete process.env.GATE_LAWN_SHOT_LIST;
    expect(await sig()).toBe(off);
  });
});
