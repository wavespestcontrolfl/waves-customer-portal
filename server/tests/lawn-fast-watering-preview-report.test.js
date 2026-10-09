// The Fast Complete watering preview against the REPORT'S real entry point.
// For one visit fixture (assessment, property irrigation entries, this week's
// plan, products) the report is rendered through buildReportV1Data and the
// preview through buildLawnFastWateringPreview on the SAME fake database; the
// preview's lines, sentence, state and mow hold must deep-equal the rendered
// reportV2.banner. Synthetic data only.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/irrigation-week-plan', () => ({
  ...jest.requireActual('../services/irrigation-week-plan'),
  loadCurrentWeekPlan: jest.fn(async () => null),
}));

const { buildReportV1Data, approvedReportProductFacts } = require('../services/service-report/report-data');
const { buildReportIdentitySnapshot } = require('../services/service-report/report-identity-snapshot');
const { loadCurrentWeekPlan } = require('../services/irrigation-week-plan');
const { buildWeekPlan } = require('../../packages/irrigation-runtime');
const { buildLawnFastWateringPreview } = require('../services/lawn-fast-complete');
const { gates } = require('../config/feature-gates');

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


const SERVICE = '00000000-0000-4000-8000-0000000000aa';
const COMPLETED = '2026-09-30T18:40:00Z';
const NOW = new Date(COMPLETED);
const ID = (n) => `11111111-2222-4333-8444-55555555555${n}`;
const catalogRow = (n, extra = {}) => ({
  id: ID(n), name: `Test Product ${n}`, category: 'herbicide', product_type: 'pesticide', formulation: 'WG',
  epa_reg_number: '100-1', approved_for_service_report: true, ...extra,
});
const HOLD_ROW = catalogRow(1, { post_application_watering: { mode: 'hold', hold_hours: 24, source: 'label' } });
const WATER_IN_ROW = catalogRow(2, { category: 'fertilizer', product_type: 'fertilizer', formulation: 'granular', post_application_watering: { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'label' } });
const LATE_WATER_IN_ROW = catalogRow(3, { category: 'fertilizer', product_type: 'fertilizer', formulation: 'granular', post_application_watering: { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 72, source: 'label' } });
const MOW_HOLD_ROW = catalogRow(4, { post_application_watering: { mode: 'hold', hold_hours: 24, source: 'label' }, mow_hold_days: 3 });

const CONFIRMED_PREFS = {
  customer_id: 'cust-lawn-w1', irrigation_system: true, irrigation_system_type: ['rotor'], irrigation_run_minutes: 30,
  watering_days: ['Mon', 'Thu'], irrigation_confirmed_fields: ['irrigation_system_type', 'irrigation_run_minutes', 'watering_days'],
};
// A moved home whose sprinkler entries have not been re-saved: the report
// withholds them (scheduleUnconfirmed) and words the minutes generically.
const MOVED_PREFS = { ...CONFIRMED_PREFS, irrigation_home_changed_at: '2026-09-20T12:00:00Z', irrigation_confirmed_fields: [] };

function fixtureFor(rows, prefs) {
  const factsById = Object.fromEntries(rows.map((row) => [row.id, approvedReportProductFacts(row)]));
  const snapshot = buildReportIdentitySnapshot({ visit: {}, productFacts: factsById });
  const service = {
    id: 'svc-lawn-w1', scheduled_service_id: SERVICE, customer_id: 'cust-lawn-w1', service_line: 'lawn',
    service_type: 'Lawn Care Treatment Program', service_date: '2026-09-30', completed_at: COMPLETED,
    first_name: 'Test', last_name: 'Customer', areas_serviced: JSON.stringify(['Front Lawn']), structured_notes: '{}',
    service_data: JSON.stringify({ reportIdentitySnapshot: snapshot }),
  };
  const tables = {
    service_products: rows.map((row, n) => ({ id: `sp-${n}`, service_record_id: 'svc-lawn-w1', product_id: row.id, product_name: row.name, product_category: row.category, created_at: `2026-09-30T18:0${n}:00Z` })),
    property_geometries: [], property_zones: [], service_findings: [], service_photos: [], lawn_assessment_photos: [],
    lawn_water_intake_snapshots: [],
    // 'scheduled_services.id' is the key the preview's joined visit read filters on.
    scheduled_services: [{ id: SERVICE, 'scheduled_services.id': SERVICE, customer_id: 'cust-lawn-w1', scheduled_date: '2026-09-30', status: 'completed', service_type: 'Lawn Care Treatment Program' }],
    property_preferences: prefs ? [prefs] : [],
    lawn_assessments: [{
      id: 'la-w1', customer_id: 'cust-lawn-w1', service_id: SERVICE, service_record_id: 'svc-lawn-w1', confirmed_by_tech: true,
      service_date: '2026-09-30', created_at: '2026-09-30T14:00:00Z',
      turf_density: 78, weed_suppression: 82, color_health: 75, stress_damage: 30,
    }],
    products_catalog: rows,
  };
  return { service, knex: makeKnex(tables) };
}

// The report's banner for the fixture, and the preview for the same fixture.
async function both(rows, prefs) {
  const { service, knex } = fixtureFor(rows, prefs);
  const data = await buildReportV1Data(service, 'token-w1', knex);
  const preview = await buildLawnFastWateringPreview({ serviceId: SERVICE, productIds: rows.map((r) => r.id), knex, now: NOW });
  return { banner: data.reportV2.banner, preview };
}

function expectSameAsReport({ banner, preview }) {
  expect(banner).toBeTruthy();
  expect(preview.ok).toBe(true);
  expect(preview.lines).toEqual(banner.lines);
  expect(preview.sentence).toBe(banner.lines.join(' '));
  expect(preview.state).toBe(banner.state);
  expect(preview.mowHold).toEqual(banner.mowHold || null);
}

describe('watering preview equals the report banner (real buildReportV1Data)', () => {
  // isEnabled('irrigationWeekPlan') is read from the gates map (set at load).
  const saved = [process.env.GATE_LAWN_WATERING_RULE, gates.irrigationWeekPlan];
  const weekPlanGate = (on) => { gates.irrigationWeekPlan = on; };
  beforeEach(() => {
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    weekPlanGate(false);
    loadCurrentWeekPlan.mockReset().mockResolvedValue(null);
  });
  afterAll(() => {
    const [a, b] = saved;
    if (a === undefined) delete process.env.GATE_LAWN_WATERING_RULE; else process.env.GATE_LAWN_WATERING_RULE = a;
    weekPlanGate(b);
  });

  test('a hold', async () => {
    const result = await both([HOLD_ROW], CONFIRMED_PREFS);
    expectSameAsReport(result);
    expect(result.preview.state).toBe('hold');
    expect(result.preview.lines[0]).toBe('Skip your turf watering until Thu 3 PM.');
  });

  test('a water-in, sized from the customer\'s own sprinkler entries', async () => {
    const result = await both([WATER_IN_ROW], CONFIRMED_PREFS);
    expectSameAsReport(result);
    expect(result.preview.state).toBe('water_in');
    expect(result.preview.lines[1]).toMatch(/^Run each zone about \d+ minutes\.$/);
  });

  // GATE_LAWN_REPORT_CLARITY: the report freezes the amount-only wording at
  // completion, so the preview shows that wording, and equals the banner the
  // completion pass builds. Off: the minutes wording, as before.
  test('GATE_LAWN_REPORT_CLARITY: a water-in with no sprinkler entries previews the amount the completion will freeze', async () => {
    const saved = process.env.GATE_LAWN_REPORT_CLARITY;
    try {
      const completion = async () => {
        const { service, knex } = fixtureFor([WATER_IN_ROW], null);
        const data = await buildReportV1Data(service, 'token-w1', knex, { wateringInstructionOut: {} });
        const preview = await buildLawnFastWateringPreview({ serviceId: SERVICE, productIds: [WATER_IN_ROW.id], knex, now: NOW });
        return { banner: data.reportV2.banner, preview };
      };
      delete process.env.GATE_LAWN_REPORT_CLARITY;
      const off = await completion();
      expectSameAsReport(off);
      expect(off.preview.lines[1]).toMatch(/minutes/);
      process.env.GATE_LAWN_REPORT_CLARITY = 'true';
      const on = await completion();
      expectSameAsReport(on);
      expect(on.preview.lines).toEqual(['Water in today’s treatment with about ¼ inch by Thu 2 PM.', 'Run it even if it is not your usual day.']);
      expect(on.preview.sentence).not.toMatch(/minute|sprinkler setup/);
    } finally {
      if (saved === undefined) delete process.env.GATE_LAWN_REPORT_CLARITY; else process.env.GATE_LAWN_REPORT_CLARITY = saved;
    }
  });

  test('a hold then a water-in', async () => {
    const result = await both([HOLD_ROW, LATE_WATER_IN_ROW], CONFIRMED_PREFS);
    expectSameAsReport(result);
    expect(result.preview.state).toBe('hold_then_water_in');
  });

  test('a label mow hold rides beside the watering lines', async () => {
    const result = await both([MOW_HOLD_ROW], CONFIRMED_PREFS);
    expectSameAsReport(result);
    expect(result.banner.mowHold).toBeTruthy();
    expect(result.preview.mowHold).toEqual(result.banner.mowHold);
  });

  test('a visit whose assessment context (a moved home) changes the wording', async () => {
    const confirmed = await both([WATER_IN_ROW], CONFIRMED_PREFS);
    const moved = await both([WATER_IN_ROW], MOVED_PREFS);
    expectSameAsReport(confirmed);
    expectSameAsReport(moved);
    // The move guard really changes what the report says, and the preview follows.
    expect(moved.banner.lines).not.toEqual(confirmed.banner.lines);
    expect(moved.preview.lines).not.toEqual(confirmed.preview.lines);
  });

  describe("this week's plan (GATE_IRRIGATION_WEEK_PLAN)", () => {
    const RESTRICTION = { maxDaysPerWeek: 1, label: 'Test order', expiresOn: '2026-12-01', hoursNote: 'on your assigned day' };
    const snapshotFor = (targetInchesPerWeek) => ({
      plan: buildWeekPlan({ targetInchesPerWeek, season: 'peak', restriction: RESTRICTION, runMinutes: 30, wateringDays: ['Mon', 'Thu'], systemType: ['rotor'] }),
      weekEnding: '2026-09-27',
      availableAt: '2026-09-28T12:00:00Z',
      decisionInputs: { runMinutes: 30 },
      restriction: RESTRICTION,
    });

    test('a hold under a plan gains the plan sentence, in the preview exactly as in the report', async () => {
      const without = await both([HOLD_ROW], CONFIRMED_PREFS);
      weekPlanGate(true);
      loadCurrentWeekPlan.mockResolvedValue(snapshotFor(1.25));
      const withPlan = await both([HOLD_ROW], CONFIRMED_PREFS);
      expectSameAsReport(withPlan);
      expect(withPlan.banner.lines.length).toBe(without.banner.lines.length + 1);
      expect(withPlan.preview.provisional).toEqual(expect.arrayContaining(['completionTime', 'weekPlanLine']));
    });

    test('a shallow water-in under a deeper plan words the credit line, in both', async () => {
      weekPlanGate(true);
      loadCurrentWeekPlan.mockResolvedValue(snapshotFor(1.25));
      const result = await both([WATER_IN_ROW], CONFIRMED_PREFS);
      expectSameAsReport(result);
      weekPlanGate(false);
      const noPlan = await both([WATER_IN_ROW], CONFIRMED_PREFS);
      expect(result.banner.lines).not.toEqual(noPlan.banner.lines);
    });

    test('a failed plan read withholds the whole sentence: without the plan the wording could differ from the report\'s', async () => {
      weekPlanGate(true);
      loadCurrentWeekPlan.mockRejectedValue(new Error('plan store down'));
      const { knex } = fixtureFor([WATER_IN_ROW], CONFIRMED_PREFS);
      const preview = await buildLawnFastWateringPreview({ serviceId: SERVICE, productIds: [WATER_IN_ROW.id], knex, now: NOW });
      expect(preview.omitted).toEqual(['week_plan']);
      expect(preview.sentence).toBeNull();
      expect(preview.lines).toEqual([]);
    });
  });

  test('the response says which inputs are provisional', async () => {
    const { preview } = await both([HOLD_ROW], CONFIRMED_PREFS);
    expect(preview.asOf).toBe(NOW.toISOString());
    expect(preview.provisional).toEqual(['completionTime']);
    expect(preview.omitted).toEqual([]);
  });

  test('without a confirmed assessment the assessment is provisional too', async () => {
    const bare = makeKnex({
      scheduled_services: [{ id: SERVICE, 'scheduled_services.id': SERVICE, customer_id: 'cust-lawn-w1', scheduled_date: '2026-09-30' }],
      products_catalog: [HOLD_ROW], property_preferences: [CONFIRMED_PREFS], lawn_assessments: [],
    });
    const preview = await buildLawnFastWateringPreview({ serviceId: SERVICE, productIds: [HOLD_ROW.id], knex: bare, now: NOW });
    expect(preview.provisional).toEqual(['completionTime', 'assessment']);
    expect(preview.lines[0]).toBe('Skip your turf watering until Thu 3 PM.');
  });

  test('prefs that cannot be read: no sentence at all, as the report builds none', async () => {
    const { knex } = fixtureFor([HOLD_ROW], CONFIRMED_PREFS);
    const failing = (table) => {
      if (table === 'property_preferences') {
        const q = { where: () => q, first: () => Promise.reject(new Error('read failed')) };
        return q;
      }
      return knex(table);
    };
    failing.raw = knex.raw;
    const preview = await buildLawnFastWateringPreview({ serviceId: SERVICE, productIds: [HOLD_ROW.id], knex: failing, now: NOW });
    expect(preview.sentence).toBeNull();
    expect(preview.lines).toEqual([]);
    expect(preview.omitted).toEqual(expect.arrayContaining(['irrigation_context']));
  });
});
