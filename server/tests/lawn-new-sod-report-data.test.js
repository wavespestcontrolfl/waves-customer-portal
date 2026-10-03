// GATE_LAWN_NEW_SOD_MODE through the real report builder (buildReportV1Data):
// a visit inside the property's sod_laid_on window gets the fixed new-sod banner,
// week plan and expectation line; gate off is byte-identical even with the date
// set; the engine's own watering instruction is never built for it, so nothing is
// frozen, forecast or texted. Synthetic data only.

const { buildReportV1Data, resolveCanonicalLawnRender } = require('../services/service-report/report-data');
const { buildReportIdentitySnapshot } = require('../services/service-report/report-identity-snapshot');

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

const PRODUCT_ID = '11111111-2222-4333-8444-555555555555';
const facts = (rule) => ({
  productType: 'pesticide', name: 'Celsius WG', category: 'herbicide', activeIngredient: 'thiencarbazone',
  epaRegNumber: '432-1524', irrigationRequired: false, wateringRule: rule,
});
const HOLD = { mode: 'hold', hold_hours: 24, source: 'label' };
const WATER_IN = { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'default' };

function serviceWith(rule) {
  const snapshot = buildReportIdentitySnapshot({ visit: {}, productFacts: { [PRODUCT_ID]: facts(rule) } });
  return {
    id: 'svc-lawn-w1',
    scheduled_service_id: 'ss-current',
    customer_id: 'cust-lawn-w1',
    service_line: 'lawn',
    service_type: 'Lawn Care Treatment Program',
    service_date: '2026-09-30',
    completed_at: '2026-09-30T18:40:00Z',
    first_name: 'Test',
    last_name: 'Customer',
    areas_serviced: JSON.stringify(['Front Lawn']),
    structured_notes: '{}',
    service_data: JSON.stringify({ reportIdentitySnapshot: snapshot }),
  };
}

const fixtures = (prefs = []) => ({
  service_products: [{ id: 'sp-1', service_record_id: 'svc-lawn-w1', product_id: PRODUCT_ID, product_name: 'Celsius WG', product_category: 'herbicide', created_at: '2026-09-30T18:00:00Z' }],
  property_geometries: [],
  property_zones: [],
  service_findings: [],
  service_photos: [],
  lawn_assessment_photos: [],
  lawn_water_intake_snapshots: [],
  scheduled_services: [{ id: 'ss-current', customer_id: 'cust-lawn-w1', scheduled_date: '2026-09-30', status: 'completed', service_type: 'Lawn Care Treatment Program' }],
  property_preferences: prefs,
  lawn_assessments: [{
    id: 'la-w1', customer_id: 'cust-lawn-w1', service_record_id: 'svc-lawn-w1', confirmed_by_tech: true,
    service_date: '2026-09-30', created_at: '2026-09-30T14:00:00Z',
    turf_density: 78, weed_suppression: 82, color_health: 75, stress_damage: 30,
  }],
});


const SOD_PREFS = (sod_laid_on) => [{ customer_id: 'cust-lawn-w1', sod_laid_on }];
const GATES = ['GATE_LAWN_NEW_SOD_MODE', 'GATE_LAWN_WATERING_RULE', 'GATE_LAWN_WATERING_FORECAST'];

describe('GATE_LAWN_NEW_SOD_MODE on the report payload', () => {
  const saved = {};
  beforeEach(() => { for (const g of GATES) { saved[g] = process.env[g]; delete process.env[g]; } });
  afterEach(() => { for (const g of GATES) { if (saved[g] === undefined) delete process.env[g]; else process.env[g] = saved[g]; } });
  const render = (rule, prefs, extra = {}, opts = {}) => buildReportV1Data(serviceWith(rule), 'token-w1', makeKnex({ ...fixtures(prefs), ...extra }), opts);

  test('gate off: the payload is byte-identical with the date set or not', async () => {
    // Control: the same prefs row with no sod date (a row's mere presence already shapes turfProfile).
    const withDate = await render(HOLD, SOD_PREFS('2026-09-25'));
    const without = await render(HOLD, SOD_PREFS(null));
    expect(JSON.stringify(withDate)).toBe(JSON.stringify(without));
    expect(JSON.stringify(withDate)).not.toMatch(/new_sod|New sod/i);
  });

  test('gate off with the watering rule on: still byte-identical', async () => {
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    const withDate = await render(HOLD, SOD_PREFS('2026-09-25'));
    const without = await render(HOLD, SOD_PREFS(null));
    expect(JSON.stringify(withDate)).toBe(JSON.stringify(without));
    expect(withDate.reportV2.banner.state).toBe('hold');
  });

  test('the PDF cache key moves only while the gate is live and a sod date is set', async () => {
    const sig = async (prefs) => (await resolveCanonicalLawnRender(
      { id: 'svc-lawn-w1', customer_id: 'cust-lawn-w1', service_line: 'lawn', service_date: '2026-09-30' },
      makeKnex(fixtures(prefs)),
    )).signature;
    const noDate = await sig(SOD_PREFS(null));
    // Gate off: the date changes nothing (a prefs edit moves updated_at, not this).
    expect(await sig(SOD_PREFS('2026-09-25'))).toBe(noDate);
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    expect(await sig(SOD_PREFS(null))).toBe(noDate);
    const on = await sig(SOD_PREFS('2026-09-25'));
    expect(on).not.toBe(noDate);
    expect(await sig(SOD_PREFS('2026-09-26'))).not.toBe(on);
    delete process.env.GATE_LAWN_NEW_SOD_MODE;
    expect(await sig(SOD_PREFS('2026-09-25'))).toBe(noDate);
  });

  test('gate on, inside the window, herbicide applied: water and mow lines only, no weed-control sentence', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const data = await render(HOLD, SOD_PREFS('2026-09-25'));
    const v2 = data.reportV2;
    expect(v2.banner).toEqual({
      state: 'new_sod',
      lines: ['Water your new sod lightly every day.', 'Please hold off on mowing until the sod has rooted.'],
      holdUntil: null, waterInBy: null, expiresAt: null, ruleSource: 'new_sod',
    });
    expect(v2.water.weekPlan).toEqual({
      title: 'New sod: water lightly every day',
      detail: 'Keep the sod moist with a light watering each day until it has rooted.',
      action: 'new_sod', visitInPlanWeek: true, prescribesRun: false,
    });
    expect(data.lawnAssessment.waterContext.weekPlan.title).toBe('New sod: water lightly every day');
    expect(v2.snapshot.seasonalNote).toBe('Once the sod has rooted, you can start mowing and we can begin your regular lawn care.');
    expect(v2.water.status).toBe('unknown');
    expect(v2.water.explanation).toBeNull();
    expect(v2.mowing).toBeNull();
    expect(JSON.stringify(data)).not.toMatch(/weed control until|hold off on weed|21 days|forecastLine|observedRain/);
    // No public key gains a flag: the verdict rides the in-process object only.
    expect(JSON.stringify(data.lawnAssessment)).not.toMatch(/"newSod"/);
  });

  test('gate on, inside the window, no weed control on the visit: the third sentence prints', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const snapshot = buildReportIdentitySnapshot({ visit: {}, productFacts: { [PRODUCT_ID]: { ...facts(null), name: 'Iron Plus', category: 'supplement', activeIngredient: 'iron' } } });
    const service = { ...serviceWith(null), service_data: JSON.stringify({ reportIdentitySnapshot: snapshot }) };
    const knex = makeKnex({
      ...fixtures(SOD_PREFS('2026-09-25')),
      service_products: [{ id: 'sp-1', service_record_id: 'svc-lawn-w1', product_id: PRODUCT_ID, product_name: 'Iron Plus', product_category: 'supplement', created_at: '2026-09-30T18:00:00Z' }],
    });
    const v2 = (await buildReportV1Data(service, 'token-w1', knex)).reportV2;
    expect(v2.banner.lines).toEqual([
      'Water your new sod lightly every day.',
      'Please hold off on mowing until the sod has rooted.',
      'We are holding weed control until the sod has rooted.',
    ]);
  });

  test('gate on but the products cannot be read: the weed-control sentence is left out', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const v2 = (await render(HOLD, SOD_PREFS('2026-09-25'), { service_products: FAIL })).reportV2;
    expect(v2.banner.state).toBe('new_sod');
    expect(v2.banner.lines).toHaveLength(2);
  });

  test('gate on, the visit is past day 21 or before the sod went down: the normal report', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    const normal = await render(HOLD, SOD_PREFS(null));
    for (const laid of ['2026-09-01', '2026-10-01']) {
      const data = await render(HOLD, SOD_PREFS(laid));
      expect(JSON.stringify(data)).toBe(JSON.stringify(normal));
      expect(data.reportV2.banner.state).toBe('hold');
    }
  });

  test('gate on, day 21 is still new sod and day 22 is not', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    expect((await render(HOLD, SOD_PREFS('2026-09-09'))).reportV2.banner.state).toBe('new_sod');
    expect((await render(HOLD, SOD_PREFS('2026-09-08'))).reportV2.banner?.state).not.toBe('new_sod');
  });

  test('gate on, preferences unreadable: the normal report (fail closed)', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const data = await render(HOLD, [], { property_preferences: FAIL });
    expect(data.reportV2.banner?.state).not.toBe('new_sod');
    expect(data.reportV2.water.weekPlan?.title || '').not.toMatch(/New sod/);
  });

  test('gate on with the watering rule: no instruction is built or frozen, so there is nothing to text or forecast', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    process.env.GATE_LAWN_WATERING_FORECAST = 'true';
    const out = {};
    const data = await render(WATER_IN, SOD_PREFS('2026-09-25'), {}, { wateringInstructionOut: out });
    expect(out.instruction).toBeUndefined();
    expect(data.reportV2.banner.state).toBe('new_sod');
    expect(data.reportV2.banner.forecastLine).toBeUndefined();
    expect(data.reportV2.aftercare.evidenceSource).toBeUndefined();
    // Control: the same visit on a normal property builds its water-in instruction.
    const control = {};
    await render(WATER_IN, [], {}, { wateringInstructionOut: control });
    expect(control.instruction.state).toBe('water_in');
  });

  test('an instruction frozen before the sod date was entered is replaced, not replayed', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    const service = serviceWith(HOLD);
    const frozen = { ...service, structured_notes: JSON.stringify({ lawnWateringFreeze: { wateringInstruction: { state: 'hold', lines: ['Skip your turf watering until Thu 3 PM.'], minutes: {}, ruleSource: 'label' } } }) };
    const data = await buildReportV1Data(frozen, 'token-w1', makeKnex(fixtures(SOD_PREFS('2026-09-25'))));
    expect(data.reportV2.banner.state).toBe('new_sod');
    expect(JSON.stringify(data.reportV2)).not.toMatch(/Skip your turf watering/);
  });
});
