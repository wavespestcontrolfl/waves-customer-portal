// GATE_LAWN_REPORT_LAYOUT: the lawn web report is reordered for a phone and trimmed (owner
// 2026-10-08/09). The server adds ONE payload key while the gate is live; the page does the rest from
// data the report already carries. Gate off = the payload, the PDF and its cache key it has always had.
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
const featureGates = require('../config/feature-gates');
const { buildReportV1Data, resolveCanonicalLawnRender } = require('../services/service-report/report-data');
const { lawnLayoutPayload, mowingRangeFor } = require('../services/service-report/lawn-report-layout');
const { HEIGHT_BAND_BY_GRASS } = require('../services/service-report/turf-height');
const { customerCopyViolations } = require('../services/service-report/technician-report-copy');
const { lawnResultTimingViolation } = require('../services/service-report/report-writer-rules');
const COPY = require('../../shared/lawn-report-layout-copy.json');

const GATE = 'GATE_LAWN_REPORT_LAYOUT';
const saved = process.env[GATE];
const gateOn = () => { process.env[GATE] = 'true'; };
const gateOff = () => { delete process.env[GATE]; };
afterEach(() => { if (saved === undefined) gateOff(); else process.env[GATE] = saved; });

describe('the gate reader', () => {
  test('strict opt-in: only the exact string true', () => {
    gateOff();
    expect(featureGates.lawnReportLayoutLive()).toBe(false);
    for (const v of ['1', 'on', 'TRUE', 'True', 'yes', '']) {
      process.env[GATE] = v;
      expect(featureGates.lawnReportLayoutLive()).toBe(false);
    }
    gateOn();
    expect(featureGates.lawnReportLayoutLive()).toBe(true);
  });
});

describe('the payload key', () => {
  const v2 = { snapshot: {} };

  test('gate off, not a lawn report, or no reportV2: nothing is added', () => {
    gateOff();
    expect(lawnLayoutPayload({ serviceLine: 'lawn', reportV2: v2 })).toEqual({});
    gateOn();
    expect(lawnLayoutPayload({ serviceLine: 'pest', reportV2: v2 })).toEqual({});
    expect(lawnLayoutPayload({ serviceLine: 'tree_shrub', reportV2: v2 })).toEqual({});
    expect(lawnLayoutPayload({ serviceLine: 'lawn', reportV2: null })).toEqual({});
    expect(lawnLayoutPayload()).toEqual({});
  });

  test('gate on, a lawn report: the key carries the mowing range for a grass the table lists', () => {
    gateOn();
    const out = lawnLayoutPayload({ serviceLine: 'lawn', reportV2: v2, lawnAssessment: { turfProfile: { grassType: 'st_augustine' } } });
    expect(out).toEqual({ lawnLayout: { mowingRange: { minInches: 3.5, maxInches: 4, grassLabel: 'St. Augustine' } } });
  });

  test('the mowing range comes only from the Mowing Height table, grass by grass', () => {
    expect(mowingRangeFor('st_augustine')).toEqual({ minInches: HEIGHT_BAND_BY_GRASS.st_augustine.min, maxInches: HEIGHT_BAND_BY_GRASS.st_augustine.max, grassLabel: 'St. Augustine' });
    expect(mowingRangeFor('Bahia')).toMatchObject({ minInches: 3, maxInches: 4, grassLabel: 'Bahia' });
    expect(mowingRangeFor('bermuda')).toMatchObject({ minInches: 1, maxInches: 2, grassLabel: 'Bermuda' });
    expect(mowingRangeFor('zoysia')).toMatchObject({ minInches: 1.5, maxInches: 2, grassLabel: 'Zoysia' });
    // The table defaults a grass it does not list to St. Augustine. The sentence never does.
    for (const unlisted of ['centipede', 'mixed', 'mystery grass', '', null, undefined, 'constructor', '__proto__']) {
      expect(mowingRangeFor(unlisted)).toBeNull();
    }
  });

  test('a reading on this visit names the grass the reading was taken for', () => {
    gateOn();
    const out = lawnLayoutPayload({
      serviceLine: 'lawn', reportV2: v2, mowingHeight: { grassType: 'bahia' }, lawnAssessment: { turfProfile: { grassType: 'bermuda' } },
    });
    expect(out.lawnLayout.mowingRange.grassLabel).toBe('Bahia');
  });

  test('an unlisted grass keeps the key (the layout still applies) with no mowing range', () => {
    gateOn();
    expect(lawnLayoutPayload({ serviceLine: 'lawn', reportV2: v2, lawnAssessment: { turfProfile: { grassType: 'centipede' } } }))
      .toEqual({ lawnLayout: { mowingRange: null } });
  });
});

describe('the fixed customer sentences', () => {
  const FIGURES = { phone: '(941) 297-5749', grass: 'St. Augustine', min: '3.5', max: '4' };
  const fill = (text) => text.replace(/\{(\w+)\}/g, (_, key) => FIGURES[key]);
  const strings = [
    COPY.yourPartTitle, COPY.walkOnLabel, COPY.alsoLabel, COPY.nothingToDo, COPY.scoreToggle,
    COPY.whenToCallTitle, ...COPY.whenToCall, COPY.mowing,
  ].map(fill);

  test.each(strings)('passes the customer-copy rules: %s', (text) => {
    expect(customerCopyViolations(text)).toEqual([]);
    expect(lawnResultTimingViolation(text)).toBeFalsy();
  });

  test('no safety claim, no minute or hour figure, no chemical name, no re-service promise', () => {
    for (const text of strings) {
      expect(text).not.toMatch(/\bsafe\b/i);
      expect(text).not.toMatch(/\b\d+\s*(min|minute|minutes|hour|hours|hr|day|days|week|weeks)\b/i);
      expect(text).not.toMatch(/re-?service|free|guarantee|promise|within/i);
    }
  });

  test('every token in a sentence is one the page fills', () => {
    const tokens = new Set(strings.length ? [...JSON.stringify(COPY).matchAll(/\{(\w+)\}/g)].map((m) => m[1]) : []);
    expect([...tokens].sort()).toEqual(['grass', 'max', 'min', 'phone']);
  });
});

function makeKnex(fixtures) {
  const knex = (table) => {
    let rows = [...(fixtures[table] || [])];
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
          const likes = [];
          const sub = {
            whereRaw(_sql, params) { likes.push(String(params[0]).replace(/%/g, '').toLowerCase()); return sub; },
            orWhereRaw(_sql, params) { likes.push(String(params[0]).replace(/%/g, '').toLowerCase()); return sub; },
          };
          a(sub);
          if (likes.length) rows = rows.filter((r) => likes.some((needle) => String(r.service_type || '').toLowerCase().includes(needle)));
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
      first() { return Promise.resolve(rows[0] || null); },
      columnInfo: () => Promise.resolve({}),
      catch: () => Promise.resolve(rows),
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    });
    return q;
  };
  knex.raw = (sql) => sql;
  return knex;
}

const CUSTOMER = 'cust-lawn-layout';
const CUR = {
  id: 'la-cur', customer_id: CUSTOMER, service_record_id: 'svc-cur', confirmed_by_tech: true,
  service_date: '2026-10-08', visit_date: '2026-10-08', created_at: '2026-10-08T14:00:00Z', history_record_id: 'svc-cur',
  turf_density: 78, weed_suppression: 82, color_health: 75, stress_damage: 30,
};
const fixtures = () => ({
  service_products: [], property_geometries: [], property_zones: [], service_findings: [], service_photos: [],
  lawn_assessment_photos: [], lawn_water_intake_snapshots: [],
  scheduled_services: [{ id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-10-08', status: 'completed', service_type: 'Lawn Care Treatment Program' }],
  property_preferences: [], service_records: [], lawn_assessments: [CUR],
});
const lawnService = () => ({
  id: 'svc-cur', scheduled_service_id: 'ss-cur', customer_id: CUSTOMER, service_line: 'lawn',
  service_type: 'Lawn Care Treatment Program', service_date: '2026-10-08', completed_at: '2026-10-08T18:40:00Z',
  first_name: 'Test', last_name: 'Customer', areas_serviced: JSON.stringify(['Front Lawn']),
  structured_notes: JSON.stringify({}), service_data: JSON.stringify({}),
});


describe('the real report builder (in-memory reader)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    history.installedForVisit.mockResolvedValue(CUR);
    history.historyForReport.mockResolvedValue({ current: CUR, rows: [CUR], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    history.historyForAssessment.mockResolvedValue({ current: CUR, rows: [CUR], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    require('../services/llm/call').dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'no_key' });
  });

  test('gate off: no lawnLayout key; gate on: the lawn payload gains it and nothing else changes', async () => {
    gateOff();
    const off = await buildReportV1Data(lawnService(), 'tok-layout', makeKnex(fixtures()), {});
    expect('lawnLayout' in off).toBe(false);
    gateOn();
    const on = await buildReportV1Data(lawnService(), 'tok-layout', makeKnex(fixtures()), {});
    expect(on.lawnLayout).toEqual({ mowingRange: null });
    const { lawnLayout, ...rest } = on;
    expect(lawnLayout).toBeDefined();
    expect(JSON.parse(JSON.stringify(rest))).toEqual(JSON.parse(JSON.stringify(off)));
  });

  test('gate on, a pest report: no key', async () => {
    gateOn();
    const pest = { ...lawnService(), service_line: 'pest', service_type: 'Quarterly Pest Control' };
    const data = await buildReportV1Data(pest, 'tok-layout', makeKnex(fixtures()), {});
    expect('lawnLayout' in data).toBe(false);
  });

  test('the lawn PDF cache signature never moves with this gate (the PDF does not use the layout)', async () => {
    const sig = async () => (await resolveCanonicalLawnRender(
      { id: 'svc-cur', customer_id: CUSTOMER, service_line: 'lawn', service_date: '2026-10-08' },
      makeKnex(fixtures()),
    )).signature;
    gateOff();
    const before = await sig();
    gateOn();
    expect(await sig()).toBe(before);
  });
});
