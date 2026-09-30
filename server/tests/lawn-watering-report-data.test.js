// GATE_LAWN_WATERING_RULE through the real report builder (buildReportV1Data):
// the frozen per-product rule drives the banner, the aftercare and the plan
// overlay; gate off leaves the payload exactly as it was. Synthetic data only.

const { buildReportV1Data } = require('../services/service-report/report-data');
const { buildReportIdentitySnapshot } = require('../services/service-report/report-identity-snapshot');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');

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

describe('GATE_LAWN_WATERING_RULE on the report payload', () => {
  const OLD = process.env.GATE_LAWN_WATERING_RULE;
  afterEach(() => {
    if (OLD === undefined) delete process.env.GATE_LAWN_WATERING_RULE; else process.env.GATE_LAWN_WATERING_RULE = OLD;
  });
  const render = async (rule, prefs) => buildReportV1Data(serviceWith(rule), 'token-w1', makeKnex(fixtures(prefs)));

  test('gate on, Celsius hold: banner, aftercare and hero task all carry the same hold', async () => {
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    const data = await render(HOLD);
    const v2 = data.reportV2;
    expect(v2.banner).toMatchObject({ state: 'hold', holdUntil: '2026-10-01T19:00:00.000Z', waterInBy: null, expiresAt: '2026-10-01T19:00:00.000Z', ruleSource: 'label' });
    expect(v2.banner.lines[0]).toBe('Skip your turf watering until Thu 3 PM.');
    expect(v2.aftercare).toMatchObject({ evidenceSource: 'product_instruction', wateringHold: true, holdTask: v2.banner.lines[0] });
    expect(v2.aftercare.watering).toBe(`${v2.banner.lines[0]} ${v2.banner.lines[1]}`);
    expect(v2.snapshot.customerAction).toContain(v2.banner.lines[0]);
    for (const line of v2.banner.lines) expect(findBannedCustomerCopy(line)).toEqual([]);
    // The rule never rides the public applications[].product payload.
    expect(JSON.stringify(data.applications)).not.toMatch(/wateringRule|water_in_inches|hold_hours|post_application_watering/);
    expect(JSON.stringify(data)).not.toContain('{holdUntil}');
  });

  test('gate on, mixed hold + water-in: hold then water-in with the customer\'s own head type', async () => {
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    const snapshot = buildReportIdentitySnapshot({ visit: {}, productFacts: { [PRODUCT_ID]: facts(HOLD), [PRODUCT_ID.replace('5555', '6666')]: { ...facts(WATER_IN), name: 'Arena 50 WDG' } } });
    const service = { ...serviceWith(HOLD), service_data: JSON.stringify({ reportIdentitySnapshot: snapshot }) };
    const knex = makeKnex({
      ...fixtures([{ customer_id: 'cust-lawn-w1', irrigation_system_type: ['rotor'], irrigation_system: true }]),
      service_products: [
        { id: 'sp-1', service_record_id: 'svc-lawn-w1', product_id: PRODUCT_ID, product_name: 'Celsius WG', created_at: '2026-09-30T18:00:00Z' },
        { id: 'sp-2', service_record_id: 'svc-lawn-w1', product_id: PRODUCT_ID.replace('5555', '6666'), product_name: 'Arena 50 WDG', created_at: '2026-09-30T18:01:00Z' },
      ],
    });
    const v2 = (await buildReportV1Data(service, 'token-w1', knex)).reportV2;
    expect(v2.banner.state).toBe('hold_then_water_in');
    expect(v2.banner.lines[1]).toBe('After that, run each zone about 40 minutes within 24 hours.');
    expect(v2.banner.expiresAt).toBe('2026-10-02T19:00:00.000Z');
  });

  test('gate on, product with no rule: no banner and the legacy aftercare', async () => {
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    const v2 = (await render(null)).reportV2;
    expect(v2.banner).toBeUndefined();
    expect(v2.aftercare.evidenceSource).toBeUndefined();
    expect(v2.aftercare.wateringHold).toBeUndefined();
  });

  test('gate off: no banner, no overlay, and the payload does not depend on the rule at all', async () => {
    delete process.env.GATE_LAWN_WATERING_RULE;
    const withRule = await render(HOLD);
    const withoutRule = await render(null);
    expect(withRule.reportV2.banner).toBeUndefined();
    expect(withRule.reportV2.aftercare.evidenceSource).toBeUndefined();
    expect(JSON.stringify(withRule)).not.toMatch(/afterHold|holdUntil|product_instruction/);
    expect(JSON.parse(JSON.stringify(withRule))).toEqual(JSON.parse(JSON.stringify(withoutRule)));
  });
});
