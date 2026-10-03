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


// The shared resolver's reads (lawn-new-sod-visit.js): the service record's own day, its
// appointment (stamped at the customer's primary address) and the customer's primary address.
const HOME = { line1: '100 Example Court', city: 'Bradenton', zip: '34201' };
const withIdentity = (prefs, { record = {}, appointment = {}, customer = {} } = {}) => ({
  ...fixtures(prefs),
  'service_records as sr': [{ 'sr.id': 'svc-lawn-w1', service_date: '2026-09-30', scheduled_service_id: 'ss-current', customer_id: 'cust-lawn-w1', ...record }],
  'scheduled_services as ss': [{
    'ss.id': 'ss-current', id: 'ss-current', customer_id: 'cust-lawn-w1', scheduled_date: '2026-09-30', property_id: null, source_estimate_id: null,
    service_address_line1: HOME.line1, service_address_line2: null, service_address_city: HOME.city, service_address_zip: HOME.zip, ...appointment,
  }],
  'customers as c': [{ 'c.id': 'cust-lawn-w1', address_line1: HOME.line1, address_line2: null, city: HOME.city, zip: HOME.zip, has_multi_home: false, ...customer }],
});

const SOD_PREFS = (sod_laid_on) => [{ customer_id: 'cust-lawn-w1', sod_laid_on }];
const GATES = ['GATE_LAWN_NEW_SOD_MODE', 'GATE_LAWN_WATERING_RULE', 'GATE_LAWN_WATERING_FORECAST'];

describe('GATE_LAWN_NEW_SOD_MODE on the report payload', () => {
  const saved = {};
  beforeEach(() => { for (const g of GATES) { saved[g] = process.env[g]; delete process.env[g]; } });
  afterEach(() => { for (const g of GATES) { if (saved[g] === undefined) delete process.env[g]; else process.env[g] = saved[g]; } });
  const render = (rule, prefs, extra = {}, opts = {}) => buildReportV1Data(serviceWith(rule), 'token-w1', makeKnex({ ...withIdentity(prefs), ...extra }), opts);

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
      makeKnex(withIdentity(prefs)),
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

  test('the PDF cache key carries the resolved verdict: visit day, property and reason, not the date alone', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const sig = async (parts, prefs = SOD_PREFS('2026-09-25')) => (await resolveCanonicalLawnRender(
      { id: 'svc-lawn-w1', customer_id: 'cust-lawn-w1', service_line: 'lawn', service_date: '2026-09-30' },
      makeKnex({ ...withIdentity(prefs, parts), ...(parts && parts.extra) }),
    )).signature;
    const active = await sig({});
    // The same date, a visit at ANOTHER property: a different render, so a different key.
    const elsewhere = await sig({ appointment: { service_address_line1: '200 Sample Lane', service_address_zip: '34202' } });
    expect(elsewhere).not.toBe(active);
    // The same date, the visit moved across day 21 (service record day): a different key.
    const day22 = await sig({ record: { service_date: '2026-10-17' } });
    expect(day22).not.toBe(active);
    expect(await sig({})).toBe(active); // and it is stable
    // A verdict that cannot be read is a unique token (never a shared, cacheable key).
    const failing = async () => (await resolveCanonicalLawnRender(
      { id: 'svc-lawn-w1', customer_id: 'cust-lawn-w1', service_line: 'lawn', service_date: '2026-09-30' },
      makeKnex({ ...withIdentity(SOD_PREFS('2026-09-25')), 'service_records as sr': FAIL }),
    )).signature;
    expect(await failing()).not.toBe(await failing());
  });

  test('gate on, inside the window: the watering and mowing banner, the plan card and the expectation line', async () => {
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
    // The mode says nothing about weed control, whatever the products were (a herbicide here).
    expect(JSON.stringify(data)).not.toMatch(/holding weed control|weed control until|21 days|forecastLine|observedRain/);
    // No public key gains a flag: the verdict rides the in-process object only.
    expect(JSON.stringify(data.lawnAssessment)).not.toMatch(/"newSod"/);
  });

  test('the banner is the same two sentences whatever the products were, or when they cannot be read', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const two = ['Water your new sod lightly every day.', 'Please hold off on mowing until the sod has rooted.'];
    expect((await render(HOLD, SOD_PREFS('2026-09-25'))).reportV2.banner.lines).toEqual(two);
    expect((await render(HOLD, SOD_PREFS('2026-09-25'), { service_products: FAIL })).reportV2.banner.lines).toEqual(two);
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
    const data = await buildReportV1Data(frozen, 'token-w1', makeKnex(withIdentity(SOD_PREFS('2026-09-25'))));
    expect(data.reportV2.banner.state).toBe('new_sod');
    expect(JSON.stringify(data.reportV2)).not.toMatch(/Skip your turf watering/);
  });
});

describe('GATE_LAWN_NEW_SOD_MODE: the documented payload keys, with a product that needs watering in', () => {
  const saved = process.env.GATE_LAWN_NEW_SOD_MODE;
  afterEach(() => { if (saved === undefined) delete process.env.GATE_LAWN_NEW_SOD_MODE; else process.env.GATE_LAWN_NEW_SOD_MODE = saved; });

  // A fertilizer whose label says to water it in (irrigation_required + a legacy note): the normal
  // engine turns that into a watering restriction that overwrites the card's explanation.
  const needsWateringIn = () => {
    const snapshot = buildReportIdentitySnapshot({ visit: {}, productFacts: { [PRODUCT_ID]: {
      ...facts(null), name: 'Test Fertilizer', category: 'fertilizer', activeIngredient: 'urea',
      irrigationRequired: true, irrigationNotes: 'Water in with 1/4 inch after application.',
    } } });
    const service = { ...serviceWith(null), service_data: JSON.stringify({ reportIdentitySnapshot: snapshot }) };
    const fx = {
      ...withIdentity(SOD_PREFS('2026-09-25')),
      service_products: [{ id: 'sp-1', service_record_id: 'svc-lawn-w1', product_id: PRODUCT_ID, product_name: 'Test Fertilizer', product_category: 'fertilizer', created_at: '2026-09-30T18:00:00Z' }],
    };
    return buildReportV1Data(service, 'token-w1', makeKnex(fx));
  };

  test('control: without new-sod mode the product\'s watering restriction fills the card explanation', async () => {
    const v2 = (await needsWateringIn()).reportV2;
    expect(v2.water.explanation).toBeTruthy();
    expect(v2.snapshot.customerAction).toBe(v2.water.explanation);
  });

  test('new-sod mode pins every documented key, and no late assignment brings watering text back', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const data = await needsWateringIn();
    const v2 = data.reportV2;
    expect(v2.banner).toEqual({
      state: 'new_sod',
      lines: ['Water your new sod lightly every day.', 'Please hold off on mowing until the sod has rooted.'],
      holdUntil: null, waterInBy: null, expiresAt: null, ruleSource: 'new_sod',
    });
    expect(v2.water).toMatchObject({
      status: 'unknown', explanation: null, coverageWatch: false,
      weekPlan: { title: 'New sod: water lightly every day', detail: 'Keep the sod moist with a light watering each day until it has rooted.', action: 'new_sod', visitInPlanWeek: true, prescribesRun: false },
    });
    expect(data.lawnAssessment.waterContext.weekPlan.title).toBe('New sod: water lightly every day');
    expect(v2.snapshot.seasonalNote).toBe('Once the sod has rooted, you can start mowing and we can begin your regular lawn care.');
    expect(v2.snapshot.seasonalNoteSource).toBeUndefined();
    expect(v2.mowing).toBeNull();
    expect(v2.insights.filter((c) => c.category === 'water' || c.category === 'mowing')).toEqual([]);
    // "Your next step" is not the product's watering task (the control above carries it).
    expect(v2.snapshot.customerAction).toBeNull();
    // The product's own aftercare note is the separate legacy block, and it stays.
    expect(v2.aftercare.watering).toBeTruthy();
    // No engine watering voice anywhere else in the reconciled customer text.
    const customerText = JSON.stringify({ water: v2.water, snapshot: { ...v2.snapshot, treatmentSummary: null }, insights: v2.insights });
    expect(customerText).not.toMatch(/ease back|easing back|too much water|dry out between|skip your|lower the mower|raise the mower/i);
  });
});

describe('GATE_LAWN_NEW_SOD_MODE: no remaining card or sentence talks about watering or mowing, or claims weed control', () => {
  const saved = process.env.GATE_LAWN_NEW_SOD_MODE;
  afterEach(() => { if (saved === undefined) delete process.env.GATE_LAWN_NEW_SOD_MODE; else process.env.GATE_LAWN_NEW_SOD_MODE = saved; });

  // Weed pressure and stress both flagged, a feeding on the record and NO herbicide: the weed card
  // is retained ("Spot-treated where appropriate"), and nothing in the mode may disagree with it.
  test('a weedy, stressed new-sod visit with a feeding and no herbicide', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const snapshot = buildReportIdentitySnapshot({ visit: {}, productFacts: { [PRODUCT_ID]: { ...facts(null), name: 'Iron Plus', category: 'supplement', activeIngredient: 'iron' } } });
    const service = { ...serviceWith(null), service_data: JSON.stringify({ reportIdentitySnapshot: snapshot }) };
    const fx = withIdentity(SOD_PREFS('2026-09-25'));
    fx.lawn_assessments = [{ ...fx.lawn_assessments[0], weed_suppression: 35, stress_damage: 80 }];
    fx.service_products = [{ id: 'sp-1', service_record_id: 'svc-lawn-w1', product_id: PRODUCT_ID, product_name: 'Iron Plus', product_category: 'supplement', created_at: '2026-09-30T18:00:00Z' }];
    const v2 = (await buildReportV1Data(service, 'token-w1', makeKnex(fx))).reportV2;
    expect(v2.banner.lines).toEqual(['Water your new sod lightly every day.', 'Please hold off on mowing until the sod has rooted.']);
    const weedCard = v2.insights.find((c) => c.category === 'weeds');
    expect(weedCard).toBeTruthy();
    // Everything the engine printed other than the fixed new-sod blocks and the product's own aftercare note.
    const printed = JSON.stringify({
      insights: v2.insights,
      diagnosis: v2.diagnosis,
      snapshot: { ...v2.snapshot, treatmentSummary: null, seasonalNote: null },
      smsSummary: v2.smsSummary,
      card: { status: v2.water.status, explanation: v2.water.explanation },
    });
    expect(printed).not.toMatch(/water|irrigat|sprinkl|moist|\bmow|mower|\bdry\b|drought|damp|ease back|holding weed control|hold(?:ing)? off on weed/i);
    // And no sentence claims weed control is on hold anywhere in the payload.
    expect(JSON.stringify(v2)).not.toMatch(/holding weed control|weed control until/i);
  });
});

describe('GATE_LAWN_NEW_SOD_MODE: one visit day and one property for the report', () => {
  const saved = process.env.GATE_LAWN_NEW_SOD_MODE;
  beforeEach(() => { process.env.GATE_LAWN_NEW_SOD_MODE = 'true'; });
  afterEach(() => { if (saved === undefined) delete process.env.GATE_LAWN_NEW_SOD_MODE; else process.env.GATE_LAWN_NEW_SOD_MODE = saved; });
  const render = (extra) => buildReportV1Data(serviceWith(HOLD), 'token-w1', makeKnex({ ...withIdentity(SOD_PREFS('2026-09-25')), ...extra }));

  const renderWith = (parts) => buildReportV1Data(serviceWith(HOLD), 'token-w1', makeKnex(withIdentity(SOD_PREFS('2026-09-25'), parts)));

  test('a visit at another property (the stamp is another address) is the normal report', async () => {
    const data = await renderWith({ appointment: { service_address_line1: '200 Sample Lane', service_address_zip: '34202' } });
    expect(data.reportV2.banner?.state).not.toBe('new_sod');
    expect(JSON.stringify(data)).not.toMatch(/New sod/);
  });

  test('an UNSTAMPED appointment linked to a secondary property by property_id is the normal report (not demonstrably elsewhere is not proof)', async () => {
    const fx = withIdentity(SOD_PREFS('2026-09-25'), {
      appointment: { service_address_line1: null, service_address_city: null, service_address_zip: null, property_id: 'p2' },
    });
    fx.customer_properties = [{ id: 'p2', address_line1: '200 Sample Lane', address_line2: null, city: 'Bradenton', zip: '34202' }];
    const data = await buildReportV1Data(serviceWith(HOLD), 'token-w1', makeKnex(fx));
    expect(data.reportV2.banner?.state).not.toBe('new_sod');
  });

  test('the same street in another unit is the normal report (the unit counts)', async () => {
    const data = await renderWith({ customer: { address_line2: 'Apt 4' }, appointment: { service_address_line2: 'Apt 7' } });
    expect(data.reportV2.banner?.state).not.toBe('new_sod');
  });

  test('a visit that cannot be proven at the home (multi-home account, no stamp, no link) is the normal report', async () => {
    const data = await renderWith({
      customer: { has_multi_home: true },
      appointment: { service_address_line1: null, service_address_city: null, service_address_zip: null },
    });
    expect(data.reportV2.banner?.state).not.toBe('new_sod');
  });

  test('an unreadable visit identity is the normal report, and the render is uncacheable and defers delivery', async () => {
    const data = await render({ 'service_records as sr': FAIL });
    expect(data.reportV2.banner?.state).not.toBe('new_sod');
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(true);
    expect(data.lawnAssessment.portalPrefsReadFailed).toBe(true);
  });

  test('the verdict follows the service record day, not the assessment: a redo on another day does not move it across day 21', async () => {
    // Visit 2026-09-30, sod 2026-09-09: day 21, active. Redo the assessment on later days.
    const sodDay21 = withIdentity(SOD_PREFS('2026-09-09'));
    for (const redoDay of ['2026-09-30', '2026-10-02', '2026-10-20', '2026-09-20']) {
      const fx = { ...sodDay21, lawn_assessments: [{ ...sodDay21.lawn_assessments[0], service_date: redoDay, created_at: `${redoDay}T14:00:00Z` }] };
      const data = await buildReportV1Data(serviceWith(HOLD), 'token-w1', makeKnex(fx));
      expect(data.reportV2.banner?.state).toBe('new_sod');
    }
    // And day 22 stays out whatever the assessment's day.
    const day22 = withIdentity(SOD_PREFS('2026-09-08'));
    for (const redoDay of ['2026-09-30', '2026-09-10']) {
      const fx = { ...day22, lawn_assessments: [{ ...day22.lawn_assessments[0], service_date: redoDay, created_at: `${redoDay}T14:00:00Z` }] };
      const data = await buildReportV1Data(serviceWith(HOLD), 'token-w1', makeKnex(fx));
      expect(data.reportV2.banner?.state).not.toBe('new_sod');
    }
  });
});
