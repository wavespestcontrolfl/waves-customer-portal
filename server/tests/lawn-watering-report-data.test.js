// GATE_LAWN_WATERING_RULE through the real report builder (buildReportV1Data):
// the frozen per-product rule drives the banner, the aftercare and the plan
// overlay; gate off leaves the payload exactly as it was. Synthetic data only.

const { buildReportV1Data } = require('../services/service-report/report-data');
const { buildReportIdentitySnapshot } = require('../services/service-report/report-identity-snapshot');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');

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
    const snapshot = buildReportIdentitySnapshot({ visit: {}, productFacts: { [PRODUCT_ID]: facts(HOLD), [PRODUCT_ID.replace('5555', '6666')]: { ...facts({ ...WATER_IN, water_in_by_hours: 72 }), name: 'Arena 50 WDG' } } });
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
    // The water-in deadline stays completion + 72 h (never re-anchored to the hold end).
    expect(v2.banner.lines[1]).toBe('After that, water in today’s treatment by Sat 2 PM: run each zone about 40 minutes.');
    expect(v2.banner.expiresAt).toBe('2026-10-03T18:00:00.000Z');
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

  describe('later reads replay the frozen instruction', () => {
    const PREFS = (headTypes) => [{ customer_id: 'cust-lawn-w1', irrigation_system_type: headTypes, irrigation_system: true }];
    const withFrozen = (service, instruction) => ({ ...service, structured_notes: JSON.stringify({ lawnWateringFreeze: { wateringInstruction: instruction } }) });
    const pick = (data) => JSON.stringify({ banner: data.reportV2.banner, aftercare: data.reportV2.aftercare, customerAction: data.reportV2.snapshot.customerAction });

    test('a head-type / run-minutes edit after completion does not change a frozen report', async () => {
      process.env.GATE_LAWN_WATERING_RULE = 'true';
      const service = serviceWith(WATER_IN);
      const out = {};
      const first = await buildReportV1Data(service, 'token-w1', makeKnex(fixtures(PREFS(['rotor']))), { wateringInstructionOut: out });
      expect(first.reportV2.banner.lines[1]).toBe('Run each zone about 40 minutes.');
      expect(out.instruction.state).toBe('water_in');

      // Frozen at completion; the customer then edits their sprinkler entries
      // (head type and run minutes; the water balance is deliberately live).
      const frozenService = withFrozen(service, JSON.parse(JSON.stringify(out.instruction)));
      const edited = { ...fixtures(PREFS(['spray'])), property_preferences: [{ customer_id: 'cust-lawn-w1', irrigation_system_type: ['spray'], irrigation_run_minutes: 20, irrigation_system: true }] };
      const replay = await buildReportV1Data(frozenService, 'token-w1', makeKnex(edited));
      expect(pick(replay)).toBe(pick(first));

      // No snapshot: the instruction is regenerated from the current entries.
      const regenerated = await buildReportV1Data(service, 'token-w1', makeKnex(edited));
      expect(regenerated.reportV2.banner.lines[1]).not.toBe(first.reportV2.banner.lines[1]);
      expect(regenerated.reportV2.banner.lines[1]).toBe('Run each zone about 15 minutes.');
    });

    test('gate rollback then back on: the preserved snapshot replays, not a regenerated instruction', async () => {
      const service = serviceWith(WATER_IN);
      const out = {};
      process.env.GATE_LAWN_WATERING_RULE = 'true';
      await buildReportV1Data(service, 'token-w1', makeKnex(fixtures(PREFS(['rotor']))), { wateringInstructionOut: out });
      const frozenService = withFrozen(service, JSON.parse(JSON.stringify(out.instruction)));
      const edited = fixtures(PREFS(['spray']));
      // Rolled back: the customer sees today's un-gated report and the frozen keys are ignored, not erased.
      delete process.env.GATE_LAWN_WATERING_RULE;
      expect((await buildReportV1Data(frozenService, 'token-w1', makeKnex(edited))).reportV2.banner).toBeUndefined();
      // Back on: the ORIGINAL 40-minute instruction, although the entries now say spray (15).
      process.env.GATE_LAWN_WATERING_RULE = 'true';
      const back = await buildReportV1Data(frozenService, 'token-w1', makeKnex(edited));
      expect(back.reportV2.banner.lines[1]).toBe('Run each zone about 40 minutes.');
    });

    test('a snapshot frozen at the earlier lawnReportV2 location is still replayed', async () => {
      process.env.GATE_LAWN_WATERING_RULE = 'true';
      const out = {};
      const first = await buildReportV1Data(serviceWith(WATER_IN), 'token-w1', makeKnex(fixtures(PREFS(['rotor']))), { wateringInstructionOut: out });
      const legacy = { ...serviceWith(WATER_IN), structured_notes: JSON.stringify({ lawnReportV2: { wateringInstruction: JSON.parse(JSON.stringify(out.instruction)) } }) };
      const replay = await buildReportV1Data(legacy, 'token-w1', makeKnex(fixtures(PREFS(['spray']))));
      expect(replay.reportV2.banner).toEqual(first.reportV2.banner);
    });

    test('a failed property_preferences read builds no instruction and freezes nothing; the next render gets the right minutes', async () => {
      process.env.GATE_LAWN_WATERING_RULE = 'true';
      const out = {};
      const failed = await buildReportV1Data(serviceWith(WATER_IN), 'token-w1', makeKnex({ ...fixtures(), property_preferences: FAIL }), { wateringInstructionOut: out });
      expect(failed.reportV2.banner).toBeUndefined();
      expect(failed.reportV2.aftercare.evidenceSource).toBeUndefined(); // legacy path
      expect(out.instruction).toBeNull(); // the write gate freezes only a truthy claim
      // The render omitted the direction: PDF storage must refuse it (the
      // uncacheable flag pdf-queue / reports-public gate on) and a pinned
      // delivery defers.
      expect(failed.lawnAssessment.wateringInputsUnavailable).toBe(true);
      expect(failed.lawnAssessment.weekWeatherUncacheable).toBe(true);
      expect(failed.lawnAssessment.weekWeatherPendingReason).toBeTruthy(); // 'unfrozen' (retry ladder) unless the week was already pending
      expect(failed.lawnAssessment.portalPrefsReadFailed).toBe(true);
      const next = await buildReportV1Data(serviceWith(WATER_IN), 'token-w1', makeKnex(fixtures(PREFS(['rotor']))));
      expect(next.reportV2.banner.lines[1]).toBe('Run each zone about 40 minutes.');
      // The next successful render caches again.
      expect(next.lawnAssessment.wateringInputsUnavailable).toBeUndefined();
      expect(next.lawnAssessment.portalPrefsReadFailed).toBe(false);
    });

    test('a failed live legacy-catalog lookup, or a failed product read, is uncacheable too; a frozen render never is', async () => {
      process.env.GATE_LAWN_WATERING_RULE = 'true';
      const productsFail = await buildReportV1Data(serviceWith(HOLD), 'token-w1', makeKnex({ ...fixtures(), service_products: FAIL }));
      expect(productsFail.lawnAssessment.wateringInputsUnavailable).toBe(true);
      expect(productsFail.lawnAssessment.weekWeatherUncacheable).toBe(true);
      // Frozen instruction: nothing was read, so a failing prefs table changes nothing.
      const frozenService = { ...serviceWith(HOLD), structured_notes: JSON.stringify({ lawnWateringFreeze: { wateringInstruction: { state: 'hold', lines: ['a.', 'b.'], minutes: {}, holdUntil: null } } }) };
      const frozen = await buildReportV1Data(frozenService, 'token-w1', makeKnex({ ...fixtures(), property_preferences: FAIL }));
      expect(frozen.lawnAssessment.wateringInputsUnavailable).toBeUndefined();
      // Gate off: never flagged by this feature.
      delete process.env.GATE_LAWN_WATERING_RULE;
      const off = await buildReportV1Data(serviceWith(HOLD), 'token-w1', makeKnex({ ...fixtures(), property_preferences: FAIL }));
      expect(off.lawnAssessment.wateringInputsUnavailable).toBeUndefined();
    });

    test('plan-dependent sentences follow the plan on THIS render, not the completion', async () => {
      process.env.GATE_LAWN_WATERING_RULE = 'true';
      const NONE_RULE = { mode: 'none', source: 'label' };
      // A frozen no-plan instruction, rendered with a plan present is not reachable through
      // fixtures (the plan comes from a snapshot table), so pin the composition seam directly.
      const { buildWateringBanner } = require('../services/service-report/report-data');
      const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
      const frozen = JSON.parse(JSON.stringify(buildWateringInstruction({ rules: [NONE_RULE], completedAt: '2026-09-30T18:40:00Z' })));
      expect(buildWateringBanner(frozen, null).lines).toEqual(['No watering change from today’s treatment.']);
      expect(buildWateringBanner(frozen, { title: 'This week: run once', visitInPlanWeek: true }).lines)
        .toEqual(['No watering change from today’s treatment.', 'Follow this week’s plan below.']);
      // A plan for another week never adds the sentence.
      expect(buildWateringBanner(frozen, { title: 'x', visitInPlanWeek: false }).lines).toHaveLength(1);
      const hold = JSON.parse(JSON.stringify(buildWateringInstruction({ rules: [HOLD], completedAt: '2026-09-30T18:40:00Z' })));
      expect(buildWateringBanner(hold, null).lines).toHaveLength(2);
      expect(buildWateringBanner(hold, { title: 'x' }).lines[2]).toBe('Then follow this week’s plan below.');
      // Shallow water-in against a half-inch run; a null depth or no run never adds it.
      const water = JSON.parse(JSON.stringify(buildWateringInstruction({ rules: [WATER_IN], completedAt: '2026-09-30T18:40:00Z' })));
      expect(buildWateringBanner(water, { title: 'x', prescribesRun: true, depthInches: 0.5 }).lines[2]).toMatch(/counts toward this week’s watering/);
      expect(buildWateringBanner(water, { title: 'x', prescribesRun: true, depthInches: null }).lines[2]).toBe('Run it even if it is not your usual day.');
      expect(buildWateringBanner(water, { title: 'x', prescribesRun: false, depthInches: 0.5 }).lines[2]).toBe('Run it even if it is not your usual day.');
    });

    test('a live rule lookup that fails for a legacy product leaves a partial rule set: no instruction, nothing to freeze', async () => {
      process.env.GATE_LAWN_WATERING_RULE = 'true';
      const LEGACY_ID = PRODUCT_ID.replace('5555', '7777');
      const { wateringRule, ...legacyFacts } = facts(null);
      const snapshot = buildReportIdentitySnapshot({ visit: {}, productFacts: { [PRODUCT_ID]: facts(HOLD), [LEGACY_ID]: { ...legacyFacts, name: 'Legacy Product' } } });
      const service = { ...serviceWith(HOLD), service_data: JSON.stringify({ reportIdentitySnapshot: snapshot }) };
      const rows = [
        { id: 'sp-1', service_record_id: 'svc-lawn-w1', product_id: PRODUCT_ID, product_name: 'Celsius WG', created_at: '2026-09-30T18:00:00Z' },
        { id: 'sp-2', service_record_id: 'svc-lawn-w1', product_id: LEGACY_ID, product_name: 'Legacy Product', created_at: '2026-09-30T18:01:00Z' },
      ];
      const out = {};
      const broken = await buildReportV1Data(service, 'token-w1', makeKnex({ ...fixtures(), service_products: rows, products_catalog: FAIL }), { wateringInstructionOut: out });
      expect(out.productsLoadFailed).toBe(true);
      expect(out.instruction).toBeNull();
      expect(broken.reportV2.banner).toBeUndefined();
      // Catalog back: the live lookup resolves the legacy product (a liquid
      // fertilizer defaults to none) and the render completes.
      const okOut = {};
      const ok = await buildReportV1Data(service, 'token-w1', makeKnex({ ...fixtures(), service_products: rows, products_catalog: [{ id: LEGACY_ID, name: 'Legacy Product', category: 'fertilizer', formulation: 'liquid' }] }), { wateringInstructionOut: okOut });
      expect(okOut.productsLoadFailed).toBe(false);
      expect(ok.reportV2.banner.state).toBe('hold');
    });

    test('a failed base catalog read on products that already carry their category: rules unknown, uncacheable, nothing to freeze', async () => {
      process.env.GATE_LAWN_WATERING_RULE = 'true';
      const LEGACY_ID = PRODUCT_ID.replace('5555', '7777');
      const service = serviceWith(HOLD);
      const rows = [
        { id: 'sp-1', service_record_id: 'svc-lawn-w1', product_id: PRODUCT_ID, product_name: 'Celsius WG', product_category: 'herbicide', created_at: '2026-09-30T18:00:00Z' },
        { id: 'sp-2', service_record_id: 'svc-lawn-w1', product_id: LEGACY_ID, product_name: 'Legacy Product', product_category: 'fertilizer', created_at: '2026-09-30T18:01:00Z' },
      ];
      const out = {};
      const data = await buildReportV1Data(service, 'token-w1', makeKnex({ ...fixtures(), service_products: rows, products_catalog: FAIL }), { wateringInstructionOut: out });
      expect(out.productsLoadFailed).toBe(true);
      expect(out.instruction).toBeNull();
      expect(data.lawnAssessment.wateringInputsUnavailable).toBe(true);
      expect(data.lawnAssessment.weekWeatherUncacheable).toBe(true);
    });

    test('a pre-toggle preferences row (irrigation_system false) still gets the head-type minutes, never "no system"', async () => {
      process.env.GATE_LAWN_WATERING_RULE = 'true';
      const render = async (prefs) => (await buildReportV1Data(serviceWith(WATER_IN), 'token-w1', makeKnex(fixtures([{ customer_id: 'cust-lawn-w1', ...prefs }])))).reportV2.banner.lines;
      expect((await render({ irrigation_system: false, irrigation_system_type: ['rotor'] }))[1]).toBe('Run each zone about 40 minutes.');
      const bare = await render({ irrigation_system: false });
      expect(bare[1]).toBe('Run spray heads about 15 minutes a zone and rotors about 40 minutes.');
      expect(bare.join(' ')).not.toMatch(/hose/i);
    });

    test('the frozen instruction also fills the afterHold overlay the same way', () => {
      const { applyAfterHoldOverlay } = require('../services/service-report/report-data');
      const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
      const fresh = buildWateringInstruction({ rules: [HOLD], completedAt: '2026-09-30T18:40:00Z' });
      const frozen = JSON.parse(JSON.stringify(fresh));
      const wc = { weekPlan: { title: 'x', afterHold: { title: 'x', detail: 'Not before {holdUntil}: skip.' } } };
      expect(JSON.stringify(applyAfterHoldOverlay(wc, frozen))).toBe(JSON.stringify(applyAfterHoldOverlay(wc, fresh)));
    });

    test('a malformed or state-null frozen object is never replayed: the instruction is regenerated', async () => {
      process.env.GATE_LAWN_WATERING_RULE = 'true';
      const service = serviceWith(HOLD);
      const bad = await buildReportV1Data(withFrozen(service, { state: 'bogus', lines: 'x' }), 'token-w1', makeKnex(fixtures()));
      expect(bad.reportV2.banner.state).toBe('hold');
      const nullState = await buildReportV1Data(withFrozen(service, { state: null, lines: [], minutes: {} }), 'token-w1', makeKnex(fixtures()));
      expect(nullState.reportV2.banner.state).toBe('hold');
    });

    test('a product read that fails at completion is reported, builds no claim, and freezes nothing; the next render sees the hold', async () => {
      process.env.GATE_LAWN_WATERING_RULE = 'true';
      const out = {};
      const failed = await buildReportV1Data(serviceWith(HOLD), 'token-w1', makeKnex({ ...fixtures(), service_products: FAIL }), { wateringInstructionOut: out });
      expect(out.productsLoadFailed).toBe(true);
      expect(out.instruction.state).toBeNull();
      expect(failed.reportV2.banner).toBeUndefined();
      // The write gate freezes only a real claim from a clean product read.
      // (lawn-report-write-gate-watering.test.js pins that decision.) With nothing
      // frozen, the next render regenerates from the products now present.
      const next = {};
      const later = await buildReportV1Data(serviceWith(HOLD), 'token-w1', makeKnex(fixtures()), { wateringInstructionOut: next });
      expect(next.productsLoadFailed).toBe(false);
      expect(later.reportV2.banner.state).toBe('hold');
    });

    test('gate off ignores a frozen instruction entirely', async () => {
      delete process.env.GATE_LAWN_WATERING_RULE;
      const out = {};
      const data = await buildReportV1Data(withFrozen(serviceWith(HOLD), { state: 'hold', lines: ['x.', 'y.'], minutes: {}, holdUntil: null }), 'token-w1', makeKnex(fixtures()), { wateringInstructionOut: out });
      expect(data.reportV2.banner).toBeUndefined();
      expect(data.reportV2.aftercare.evidenceSource).toBeUndefined();
      expect(out.instruction).toBeUndefined();
    });
  });

  describe('cache signature', () => {
    const { resolveCanonicalLawnRender } = require('../services/service-report/report-data');
    const CATALOG = (hours) => ({ id: PRODUCT_ID, name: 'Celsius WG', category: 'herbicide', post_application_watering: { mode: 'hold', hold_hours: hours, source: 'owner' } });
    // A visit completed before the rule was frozen with its product facts: the rule comes from the live catalog.
    const record = (notes = {}) => {
      const snapshot = buildReportIdentitySnapshot({ visit: {}, productFacts: { [PRODUCT_ID]: (({ wateringRule, ...rest }) => rest)(facts(null)) } });
      return { id: 'svc-lawn-w1', customer_id: 'cust-lawn-w1', structured_notes: JSON.stringify(notes), service_data: JSON.stringify({ reportIdentitySnapshot: snapshot }) };
    };
    const signatureFor = async (row, hours) => {
      const knex = makeKnex({ ...fixtures(), products_catalog: [CATALOG(hours)], service_records: [row] });
      return (await resolveCanonicalLawnRender({ id: row.id, customer_id: row.customer_id, service_line: 'lawn' }, knex)).signature;
    };
    const FROZEN = { lawnWateringFreeze: { wateringInstruction: { state: 'hold', lines: ['a.', 'b.'], minutes: {}, holdUntil: null } } };

    test('an unfrozen visit re-keys when the live catalog rule it renders from changes', async () => {
      process.env.GATE_LAWN_WATERING_RULE = 'true';
      const a = await signatureFor(record(), 24);
      expect(await signatureFor(record(), 24)).toBe(a);
      expect(await signatureFor(record(), 48)).not.toBe(a);
    });

    test('a frozen visit keeps the constant stamp: a catalog edit does not re-key it', async () => {
      process.env.GATE_LAWN_WATERING_RULE = 'true';
      expect(await signatureFor(record(FROZEN), 24)).toBe(await signatureFor(record(FROZEN), 48));
      // ...and it differs from the unfrozen key (the stamp carries a hash there).
      expect(await signatureFor(record(FROZEN), 24)).not.toBe(await signatureFor(record(), 24));
    });

    test('a failed live rule lookup is a non-reusable stamp, never the null-rule hash', async () => {
      process.env.GATE_LAWN_WATERING_RULE = 'true';
      const failedFor = async () => {
        const row = record();
        const knex = makeKnex({ ...fixtures(), products_catalog: FAIL, service_records: [row] });
        return (await resolveCanonicalLawnRender({ id: row.id, customer_id: row.customer_id, service_line: 'lawn' }, knex)).signature;
      };
      const first = await failedFor();
      expect(await failedFor()).not.toBe(first);
      expect(first).not.toBe(await signatureFor(record(), 24));
    });

    test('a failed base catalog enrichment is a non-reusable stamp too', async () => {
      process.env.GATE_LAWN_WATERING_RULE = 'true';
      const failedFor = async () => {
        const row = record();
        const knex = makeKnex({ ...fixtures(), products_catalog: FAIL, service_records: [row] });
        return (await resolveCanonicalLawnRender({ id: row.id, customer_id: row.customer_id, service_line: 'lawn' }, knex)).signature;
      };
      expect(await failedFor()).not.toBe(await failedFor());
    });

    test('an A -> B -> A catalog edit re-keys by the row revision, not only the final value', async () => {
      process.env.GATE_LAWN_WATERING_RULE = 'true';
      const at = async (updatedAt) => {
        const row = record();
        const knex = makeKnex({ ...fixtures(), products_catalog: [{ ...CATALOG(24), updated_at: updatedAt }], service_records: [row] });
        return (await resolveCanonicalLawnRender({ id: row.id, customer_id: row.customer_id, service_line: 'lawn' }, knex)).signature;
      };
      expect(await at('2026-09-30T10:00:00Z')).toBe(await at('2026-09-30T10:00:00Z'));
      expect(await at('2026-09-30T10:05:00Z')).not.toBe(await at('2026-09-30T10:00:00Z'));
    });

    test('gate off: no stamp at all, so the signature ignores the rule', async () => {
      delete process.env.GATE_LAWN_WATERING_RULE;
      expect(await signatureFor(record(), 24)).toBe(await signatureFor(record(), 48));
      expect(await signatureFor(record(FROZEN), 24)).toBe(await signatureFor(record(), 24));
    });
  });
});

// ── Label mow hold (P2b) ─────────────────────────────────────────────────
describe('label mow hold on the report payload (GATE_LAWN_WATERING_RULE)', () => {
  const OLD = process.env.GATE_LAWN_WATERING_RULE;
  beforeEach(() => { process.env.GATE_LAWN_WATERING_RULE = 'true'; });
  afterEach(() => {
    if (OLD === undefined) delete process.env.GATE_LAWN_WATERING_RULE; else process.env.GATE_LAWN_WATERING_RULE = OLD;
  });
  const MOW_LINE = 'Mowing: hold off until Fri 3 PM, 2 days after today\'s treatment.';
  const withMow = (rule, mowHoldDays) => ({ ...facts(rule), mowHoldDays });
  const serviceFacts = (map) => ({
    ...serviceWith(HOLD),
    service_data: JSON.stringify({ reportIdentitySnapshot: buildReportIdentitySnapshot({ visit: {}, productFacts: map }) }),
  });

  test('a hold with a label mow hold: the banner carries the mow line beside the unchanged watering lines', async () => {
    const out = {};
    const data = await buildReportV1Data(serviceFacts({ [PRODUCT_ID]: withMow(HOLD, 2) }), 'token-w1', makeKnex(fixtures()), { wateringInstructionOut: out });
    const banner = data.reportV2.banner;
    expect(banner.state).toBe('hold');
    expect(banner.lines).toEqual(['Skip your turf watering until Thu 3 PM.', 'That gives today’s treatment time to work.']);
    expect(banner.mowHold).toEqual({ days: 2, untilAt: '2026-10-02T19:00:00.000Z', untilDate: '2026-10-02', untilLabel: 'Fri 3 PM', line: MOW_LINE });
    // The frozen instruction carries it too, outside `lines`.
    expect(out.instruction.mowHold).toEqual(banner.mowHold);
    expect(out.instruction.lines.join(' ')).not.toMatch(/mow/i);
    // Aftercare, hero task and the rest of the report never restate it.
    expect(JSON.stringify(data.reportV2.aftercare)).not.toMatch(/mow/i);
  });

  test('no label mow hold: no mowHold key anywhere, and the payload equals a facts set without the key', async () => {
    const withNull = await buildReportV1Data(serviceFacts({ [PRODUCT_ID]: withMow(HOLD, null) }), 'token-w1', makeKnex(fixtures()));
    const without = await buildReportV1Data(serviceFacts({ [PRODUCT_ID]: facts(HOLD) }), 'token-w1', makeKnex(fixtures()));
    expect(withNull.reportV2.banner).not.toHaveProperty('mowHold');
    expect(JSON.stringify(withNull)).not.toMatch(/mowHold|mow_hold|Mowing: hold/);
    expect(JSON.parse(JSON.stringify(withNull))).toEqual(JSON.parse(JSON.stringify(without)));
  });

  test('the max across products wins, and an invalid stored value is ignored', async () => {
    const second = PRODUCT_ID.replace('5555', '6666');
    const third = PRODUCT_ID.replace('5555', '7777');
    const service = serviceFacts({
      [PRODUCT_ID]: withMow(HOLD, 2),
      [second]: { ...withMow(WATER_IN, 4), name: 'Arena 50 WDG' },
      [third]: { ...withMow(HOLD, 99), name: 'Third Product' },
    });
    const rows = [PRODUCT_ID, second, third].map((id, i) => ({ id: `sp-${i}`, service_record_id: 'svc-lawn-w1', product_id: id, product_name: `P${i}`, created_at: `2026-09-30T18:0${i}:00Z` }));
    const data = await buildReportV1Data(service, 'token-w1', makeKnex({ ...fixtures(), service_products: rows }));
    expect(data.reportV2.banner.mowHold).toMatchObject({ days: 4, untilDate: '2026-10-04', untilLabel: 'Sun 3 PM' });
  });

  test('a visit whose watering rule is unknown still gets its mow line (banner with no watering lines)', async () => {
    const out = {};
    const data = await buildReportV1Data(serviceFacts({ [PRODUCT_ID]: withMow(null, 3) }), 'token-w1', makeKnex(fixtures()), { wateringInstructionOut: out });
    expect(data.reportV2.banner).toMatchObject({ state: null, lines: [], expiresAt: null, mowHold: { days: 3, untilLabel: 'Sat 3 PM' } });
    expect(out.instruction.state).toBeNull();
    // The watering side stays the legacy path.
    expect(data.reportV2.aftercare.evidenceSource).toBeUndefined();
  });

  test('gate off: the mow hold changes nothing in the payload', async () => {
    delete process.env.GATE_LAWN_WATERING_RULE;
    const withValue = await buildReportV1Data(serviceFacts({ [PRODUCT_ID]: withMow(HOLD, 2) }), 'token-w1', makeKnex(fixtures()));
    const without = await buildReportV1Data(serviceFacts({ [PRODUCT_ID]: facts(HOLD) }), 'token-w1', makeKnex(fixtures()));
    expect(withValue.reportV2.banner).toBeUndefined();
    expect(JSON.parse(JSON.stringify(withValue))).toEqual(JSON.parse(JSON.stringify(without)));
  });

  test('the public applications[] payload never carries mowHoldDays or the mow column', async () => {
    const data = await buildReportV1Data(serviceFacts({ [PRODUCT_ID]: withMow(HOLD, 2) }), 'token-w1', makeKnex(fixtures()));
    expect(JSON.stringify(data.applications)).not.toMatch(/mowHold|mow_hold/i);
  });

  test('old frozen facts (no mowHoldDays key) make no claim, even when the live catalog now has a value', async () => {
    const data = await buildReportV1Data(
      serviceFacts({ [PRODUCT_ID]: facts(HOLD) }),
      'token-w1',
      makeKnex({ ...fixtures(), products_catalog: [{ id: PRODUCT_ID, name: 'Celsius WG', category: 'herbicide', mow_hold_days: 5, post_application_watering: HOLD }] }),
    );
    expect(data.reportV2.banner.state).toBe('hold');
    expect(data.reportV2.banner).not.toHaveProperty('mowHold');
  });

  describe('frozen replay', () => {
    const frozenWith = (service, instruction) => ({ ...service, structured_notes: JSON.stringify({ lawnWateringFreeze: { wateringInstruction: instruction } }) });

    test('a frozen instruction replays its own mow hold; a later catalog or facts change never rewrites it', async () => {
      const out = {};
      const first = await buildReportV1Data(serviceFacts({ [PRODUCT_ID]: withMow(HOLD, 2) }), 'token-w1', makeKnex(fixtures()), { wateringInstructionOut: out });
      const frozen = JSON.parse(JSON.stringify(out.instruction));
      const replay = await buildReportV1Data(frozenWith(serviceFacts({ [PRODUCT_ID]: withMow(HOLD, 9) }), frozen), 'token-w1', makeKnex(fixtures()));
      expect(replay.reportV2.banner).toEqual(first.reportV2.banner);
    });

    test('an instruction frozen before this change (no mowHold key) stays without one', async () => {
      const out = {};
      await buildReportV1Data(serviceFacts({ [PRODUCT_ID]: facts(HOLD) }), 'token-w1', makeKnex(fixtures()), { wateringInstructionOut: out });
      const frozen = JSON.parse(JSON.stringify(out.instruction));
      delete frozen.mowHold;
      const replay = await buildReportV1Data(frozenWith(serviceFacts({ [PRODUCT_ID]: withMow(HOLD, 9) }), frozen), 'token-w1', makeKnex(fixtures()));
      expect(replay.reportV2.banner.state).toBe('hold');
      expect(replay.reportV2.banner).not.toHaveProperty('mowHold');
    });

    test('a state-null frozen instruction is never replayed: the mow line is regenerated from the frozen facts', async () => {
      const mowOnly = { state: null, lines: [], minutes: {}, mowHold: { days: 2, untilAt: '2026-10-02T19:00:00.000Z', untilDate: '2026-10-02', untilLabel: 'Fri 3 PM', line: MOW_LINE } };
      const service = serviceFacts({ [PRODUCT_ID]: withMow(null, 7) });
      const replay = await buildReportV1Data(frozenWith(service, mowOnly), 'token-w1', makeKnex(fixtures()));
      expect(replay.reportV2.banner).toMatchObject({ state: null, lines: [], mowHold: { days: 7 } });
    });

    test('a hold frozen with the first mow shape (no untilAt) replays its mow line as written', async () => {
      const { buildWateringBanner } = require('../services/service-report/report-data');
      const legacyMow = { days: 2, untilDate: '2026-10-02', untilLabel: 'Fri', line: 'Mowing: hold off until Fri, 2 days after today\'s treatment.' };
      const hold = { state: 'hold', lines: ['a.', 'b.'], minutes: {}, holdUntil: null, expiresAt: null, ruleSource: 'label', mowHold: legacyMow };
      expect(buildWateringBanner(hold, null).mowHold).toEqual(legacyMow);
    });

    test('a frozen banner with a malformed mow hold prints no mow line', async () => {
      const { buildWateringBanner } = require('../services/service-report/report-data');
      const hold = { state: 'hold', lines: ['a.', 'b.'], minutes: {}, holdUntil: null, expiresAt: null, ruleSource: 'label' };
      expect(buildWateringBanner({ ...hold, mowHold: { days: 2, line: 'no date' } }, null)).not.toHaveProperty('mowHold');
      expect(buildWateringBanner({ ...hold, state: null, lines: [], mowHold: { days: 2 } }, null)).toBeNull();
    });
  });

  describe('cache signature', () => {
    const { resolveCanonicalLawnRender } = require('../services/service-report/report-data');
    const record = (mowHoldDays, notes = {}) => ({
      id: 'svc-lawn-w1', customer_id: 'cust-lawn-w1', structured_notes: JSON.stringify(notes),
      service_data: JSON.stringify({ reportIdentitySnapshot: buildReportIdentitySnapshot({ visit: {}, productFacts: { [PRODUCT_ID]: withMow(HOLD, mowHoldDays) } }) }),
    });
    const signatureFor = async (row) => {
      const knex = makeKnex({ ...fixtures(), products_catalog: [{ id: PRODUCT_ID, name: 'Celsius WG', category: 'herbicide' }], service_records: [row] });
      return (await resolveCanonicalLawnRender({ id: row.id, customer_id: row.customer_id, service_line: 'lawn' }, knex)).signature;
    };

    test('an unfrozen visit re-keys when its mowHoldDays changes, and is stable otherwise', async () => {
      const two = await signatureFor(record(2));
      expect(await signatureFor(record(2))).toBe(two);
      expect(await signatureFor(record(3))).not.toBe(two);
      expect(await signatureFor(record(null))).not.toBe(two);
    });

    test('a visit with no mow hold keeps the stamp it had before this field existed', async () => {
      const legacy = { id: 'svc-lawn-w1', customer_id: 'cust-lawn-w1', structured_notes: '{}',
        service_data: JSON.stringify({ reportIdentitySnapshot: buildReportIdentitySnapshot({ visit: {}, productFacts: { [PRODUCT_ID]: facts(HOLD) } }) }) };
      expect(await signatureFor(record(null))).toBe(await signatureFor(legacy));
    });

    test('an invalid stored value stamps like no value', async () => {
      expect(await signatureFor(record(99))).toBe(await signatureFor(record(null)));
    });
  });
});

// GATE_LAWN_WATERING_FORECAST (P30) through the real report builder: the frozen
// forecast sentence reaches the LIVE banner only; everything the PDF, the text
// and the assistant read stays as written.
describe('GATE_LAWN_WATERING_FORECAST on the report payload', () => {
  const { stripLiveOnlyScheduleFields, attachLawnWateringCloseOut } = require('../services/service-report/report-data');
  const SAVED = { rule: process.env.GATE_LAWN_WATERING_RULE, fc: process.env.GATE_LAWN_WATERING_FORECAST };
  afterEach(() => {
    for (const [k, v] of [['GATE_LAWN_WATERING_RULE', SAVED.rule], ['GATE_LAWN_WATERING_FORECAST', SAVED.fc]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const FORECAST = {
    line: 'About 0.4 inch of rain is forecast by Thu 8 AM. If at least ¼ inch has fallen by then, it counts as watering in today’s treatment. If it has not, run the watering above right away.',
    inches: 0.4, source: 'open_meteo', fetchedAt: '2026-09-30T18:41:00.000Z', windowFrom: '2026-09-30T18:40:00.000Z', windowTo: '2026-10-01T18:00:00.000Z',
  };
  async function frozenRender(rule, withForecast) {
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    const service = serviceWith(rule);
    const out = {};
    await buildReportV1Data(service, 'token-w1', makeKnex(fixtures()), { wateringInstructionOut: out });
    const instruction = JSON.parse(JSON.stringify(out.instruction));
    if (withForecast) instruction.forecast = FORECAST;
    return { ...service, structured_notes: JSON.stringify({ lawnWateringFreeze: { wateringInstruction: instruction } }) };
  }
  const pickPdfSurfaces = (data) => JSON.stringify({
    lines: data.reportV2.banner.lines, aftercare: data.reportV2.aftercare, customerAction: data.reportV2.snapshot.customerAction,
  });

  test('gate on: the live banner carries the frozen sentence beside unchanged lines', async () => {
    const frozen = await frozenRender(WATER_IN, true);
    const plain = await frozenRender(WATER_IN, false);
    process.env.GATE_LAWN_WATERING_FORECAST = 'true';
    const data = await buildReportV1Data(frozen, 'token-w1', makeKnex(fixtures()));
    expect(data.reportV2.banner.forecastLine).toBe(FORECAST.line);
    expect(data.reportV2.banner.lines.join(' ')).not.toMatch(/forecast/i);
    // Aftercare (the PDF's watering text), the hero task and the lines are exactly what they are without the sentence.
    const baseline = await buildReportV1Data(plain, 'token-w1', makeKnex(fixtures()));
    expect(pickPdfSurfaces(data)).toBe(pickPdfSurfaces(baseline));
    expect(data.reportV2.aftercare.watering).not.toMatch(/forecast/i);
  });

  test('gate off: payload byte-identical with or without a frozen sentence', async () => {
    const frozen = await frozenRender(WATER_IN, true);
    const plain = await frozenRender(WATER_IN, false);
    delete process.env.GATE_LAWN_WATERING_FORECAST;
    const a = await buildReportV1Data(frozen, 'token-w1', makeKnex(fixtures()));
    const b = await buildReportV1Data(plain, 'token-w1', makeKnex(fixtures()));
    expect(a.reportV2.banner).not.toHaveProperty('forecastLine');
    expect(JSON.stringify(a.reportV2)).toBe(JSON.stringify(b.reportV2));
  });

  test('a hold carrying a (stray) forecast block never shows it', async () => {
    const frozen = await frozenRender(HOLD, true);
    process.env.GATE_LAWN_WATERING_FORECAST = 'true';
    const data = await buildReportV1Data(frozen, 'token-w1', makeKnex(fixtures()));
    expect(data.reportV2.banner.state).toBe('hold');
    expect(data.reportV2.banner).not.toHaveProperty('forecastLine');
  });

  test('PDF / static: the live-only strip removes both live additions, nothing else', async () => {
    const frozen = await frozenRender(WATER_IN, true);
    process.env.GATE_LAWN_WATERING_FORECAST = 'true';
    const data = await buildReportV1Data(frozen, 'token-w1', makeKnex(fixtures()));
    data.reportV2.banner.observedRain = { inches: 0.5, line: 'Radar measured about 0.5 inch of rain near your address since your visit.', source: 'mrms', days: [] };
    const before = { ...data.reportV2.banner };
    stripLiveOnlyScheduleFields(data);
    expect(data.reportV2.banner).not.toHaveProperty('forecastLine');
    expect(data.reportV2.banner).not.toHaveProperty('observedRain');
    // The amount-only invitation (no sprinkler setup on file) is live-only too.
    const { forecastLine, observedRain, setupLine, ...rest } = before;
    expect(forecastLine).toBe(FORECAST.line);
    expect(observedRain).toBeTruthy();
    expect(setupLine).toBeTruthy();
    expect(data.reportV2.banner).not.toHaveProperty('setupLine');
    expect(data.reportV2.banner).toEqual(rest);
    expect(JSON.stringify(data)).not.toContain(FORECAST.line);
  });

  test('live close-out: radar-measured days inside a long window only; gate off, hold and unfrozen visits stay as they are', async () => {
    const mrms = require('../services/mrms-qpe');
    const spy = jest.spyOn(mrms, 'fetchMrmsDailyRain').mockResolvedValue({
      days: [{ date: '2026-10-01', inches: 0.3 }, { date: '2026-10-02', inches: 0.2 }], complete: true,
    });
    const real = Date;
    jest.useFakeTimers().setSystemTime(new real('2026-10-03T12:00:00Z'));
    try {
      const long = { ...WATER_IN, water_in_by_hours: 96 };
      const frozen = await frozenRender(long, false);
      frozen.customer_latitude = 27.5; frozen.customer_longitude = -82.5;
      const make = async () => buildReportV1Data(frozen, 'token-w1', makeKnex(fixtures()));

      delete process.env.GATE_LAWN_WATERING_FORECAST;
      let data = await make();
      await attachLawnWateringCloseOut(data, frozen);
      expect(data.reportV2.banner).not.toHaveProperty('observedRain');
      expect(spy).not.toHaveBeenCalled();

      process.env.GATE_LAWN_WATERING_FORECAST = 'true';
      data = await make();
      await attachLawnWateringCloseOut(data, frozen);
      expect(data.reportV2.banner.state).toBe('water_in');
      expect(data.reportV2.banner.observedRain).toMatchObject({ inches: 0.5, source: 'mrms' });
      expect(spy).toHaveBeenCalledWith({ latitude: 27.5, longitude: -82.5, start: '2026-10-01', end: '2026-10-02', signal: expect.any(AbortSignal) });

      // Unfrozen visit: no window to measure.
      spy.mockClear();
      const unfrozen = { ...serviceWith(long), customer_latitude: 27.5, customer_longitude: -82.5 };
      data = await buildReportV1Data(unfrozen, 'token-w1', makeKnex(fixtures()));
      await attachLawnWateringCloseOut(data, unfrozen);
      expect(spy).not.toHaveBeenCalled();

      // Hold: never.
      const hold = { ...(await frozenRender(HOLD, false)), customer_latitude: 27.5, customer_longitude: -82.5 };
      data = await buildReportV1Data(hold, 'token-w1', makeKnex(fixtures()));
      await attachLawnWateringCloseOut(data, hold);
      expect(spy).not.toHaveBeenCalled();
      expect(data.reportV2.banner).not.toHaveProperty('observedRain');
    } finally {
      jest.useRealTimers();
      spy.mockRestore();
    }
  });
});

// Amount-only water-in through the real report builder (owner 2026-10-08,
// permanent and ungated since 2026-10-09): a water-in BUILT AT COMPLETION with no
// sprinkler setup on file freezes the amount and no minutes; an instruction
// already frozen, and an unfrozen render, are unchanged; the invitation is a
// live-only banner key under a frozen amount-only instruction.
describe('amount-only water-in on the report payload', () => {
  const { stripLiveOnlyScheduleFields } = require('../services/service-report/report-data');
  const { lawnWateringSmsPlan } = require('../services/service-report/lawn-watering-sms');
  const { leadWords } = require('../services/service-report/lawn-report-lead');
  const KEYS = ['GATE_LAWN_WATERING_RULE', 'GATE_LAWN_REPORT_CLARITY'];
  const SAVED = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  beforeEach(() => { process.env.GATE_LAWN_WATERING_RULE = 'true'; delete process.env.GATE_LAWN_REPORT_CLARITY; });
  afterEach(() => { for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });

  const AMOUNT_LINE = 'Water in today’s treatment with about ¼ inch by Thu 2 PM.';
  const MINUTES_LINE = 'Run spray heads about 15 minutes a zone and rotors about 40 minutes.';
  const SETUP_LINE = 'Add your sprinkler setup and we’ll give you minutes for each zone.';
  const PREFS = (headTypes) => [{ customer_id: 'cust-lawn-w1', irrigation_system_type: headTypes, irrigation_system: true }];
  const surfaces = (data) => JSON.stringify({
    lines: data.reportV2.banner.lines, aftercare: data.reportV2.aftercare, customerAction: data.reportV2.snapshot.customerAction,
  });
  // The completion pass (the write gate passes wateringInstructionOut) and the instruction it freezes.
  async function completion(rule, prefs = []) {
    const service = serviceWith(rule);
    const out = {};
    const data = await buildReportV1Data(service, 'token-w1', makeKnex(fixtures(prefs)), { wateringInstructionOut: out });
    const frozen = { ...service, structured_notes: JSON.stringify({ lawnWateringFreeze: { wateringInstruction: JSON.parse(JSON.stringify(out.instruction)) } }) };
    return { data, out, frozen };
  }
  const replay = (frozen, prefs = []) => buildReportV1Data(frozen, 'token-w1', makeKnex(fixtures(prefs)));

  test('completion, nothing on file: the amount in the banner, aftercare and hero task; no minutes anywhere; the instruction is flagged', async () => {
    const { data, out } = await completion(WATER_IN);
    const v2 = data.reportV2;
    expect(v2.banner.lines).toEqual([AMOUNT_LINE, 'Run it even if it is not your usual day.']);
    expect(out.instruction.amountOnly).toBe(true);
    expect(out.instruction.minutes).toEqual({ spray: null, rotor: null, unknown: false, measured: null });
    expect(v2.aftercare.watering).toBe(`${AMOUNT_LINE} Run it even if it is not your usual day.`);
    expect(JSON.stringify(v2)).not.toMatch(/about \d+ minutes|minutes a zone/);
    expect(v2.banner.setupLine).toBe(SETUP_LINE);
    // The invitation is not part of any text that reads `lines`.
    expect(v2.banner.lines.join(' ')).not.toMatch(/sprinkler setup/);
    expect(v2.aftercare.watering).not.toMatch(/sprinkler setup/);
    expect(JSON.stringify(v2.snapshot.customerAction)).not.toMatch(/sprinkler setup/);
  });

  test('completion with a head type on file: minutes from the portal setup and no invitation', async () => {
    const { data, out } = await completion(WATER_IN, PREFS(['rotor']));
    expect(data.reportV2.banner.lines[1]).toBe('Run each zone about 40 minutes.');
    expect(data.reportV2.banner).not.toHaveProperty('setupLine');
    expect(out.instruction).not.toHaveProperty('amountOnly');
  });

  test('completion, a hold: no invitation', async () => {
    const { data, out } = await completion(HOLD);
    expect(data.reportV2.banner.state).toBe('hold');
    expect(data.reportV2.banner).not.toHaveProperty('setupLine');
    expect(out.instruction).not.toHaveProperty('amountOnly');
  });

  test('completion, hold then water-in: the hold line stays, the water-in clause is the amount, the invitation shows', async () => {
    const rule = { mode: 'hold', hold_hours: 6, source: 'label' };
    const service = serviceWith(rule);
    // Two products: a hold and a water-in.
    const snapshot = buildReportIdentitySnapshot({ visit: {}, productFacts: { [PRODUCT_ID]: facts(rule), 'aaaaaaaa-2222-4333-8444-555555555555': facts(WATER_IN) } });
    const two = { ...service, service_data: JSON.stringify({ reportIdentitySnapshot: snapshot }) };
    const fx = fixtures();
    fx.service_products = [...fx.service_products, { id: 'sp-2', service_record_id: 'svc-lawn-w1', product_id: 'aaaaaaaa-2222-4333-8444-555555555555', product_name: 'Second', product_category: 'fertilizer', created_at: '2026-09-30T18:01:00Z' }];
    const out = {};
    const data = await buildReportV1Data(two, 'token-w1', makeKnex(fx), { wateringInstructionOut: out });
    expect(data.reportV2.banner.state).toBe('hold_then_water_in');
    expect(data.reportV2.banner.lines[0]).toMatch(/^Skip your turf watering until /);
    expect(data.reportV2.banner.lines[1]).toMatch(/^After that, water in today’s treatment with about ¼ inch by /);
    expect(data.reportV2.banner.setupLine).toBe(SETUP_LINE);
    expect(data.reportV2.aftercare.holdTask).toBe(`${data.reportV2.banner.lines[0]} ${data.reportV2.banner.lines[1]}`);
  });

  test('an UNFROZEN render (no completion pass): the generic minutes as before, and no invitation', async () => {
    const data = await replay(serviceWith(WATER_IN));
    expect(data.reportV2.banner.lines[1]).toBe(MINUTES_LINE);
    expect(data.reportV2.banner).not.toHaveProperty('setupLine');
  });

  test('a frozen amount-only instruction renders as frozen after the customer adds a head type; only the live invitation is stripped', async () => {
    const { frozen } = await completion(WATER_IN);
    const live = await replay(frozen, PREFS(['rotor'])); // the customer has since added a head type
    expect(live.reportV2.banner.lines[0]).toBe(AMOUNT_LINE);
    expect(live.reportV2.banner.setupLine).toBe(SETUP_LINE);
    const before = surfaces(live);
    // The lawn PDF's replay stamp carries no invitation and the same lines.
    stripLiveOnlyScheduleFields(live);
    expect(live.reportV2.banner).not.toHaveProperty('setupLine');
    expect(surfaces(live)).toBe(before);
  });

  test('a frozen minutes instruction (an older visit) renders as frozen with no invitation', async () => {
    const { frozen } = await completion(WATER_IN, PREFS(['rotor']));
    const data = await replay(frozen);
    expect(data.reportV2.banner.lines[1]).toBe('Run each zone about 40 minutes.');
    expect(data.reportV2.banner).not.toHaveProperty('setupLine');
  });

  test('the watering text carries the frozen lines only: the amount, no minutes, no invitation', async () => {
    const { out } = await completion(WATER_IN);
    const plan = lawnWateringSmsPlan({
      instruction: out.instruction, deliveryMode: 'auto_send', phone: '+15555550100', gateOn: true, ruleGateOn: true,
      completedAt: out.instruction.completedAt, nowMs: Date.parse(out.instruction.completedAt) + 60000,
    });
    expect(plan.send).toBe(true);
    expect(plan.vars.watering_lines).toBe("Water in today's treatment with about ¼ inch by Thu 2 PM. Run it even if it is not your usual day.");
    expect(plan.vars.watering_lines).not.toMatch(/minute|sprinkler setup/);
  });

  test('the live invitation counts toward the lead word budget, and the strip removes it', () => {
    const base = { banner: { state: 'water_in', lines: [AMOUNT_LINE, 'Run it even if it is not your usual day.'] } };
    expect(leadWords({ ...base, banner: { ...base.banner, setupLine: SETUP_LINE } }) - leadWords(base)).toBe(SETUP_LINE.split(' ').length);
    const data = { reportV2: { banner: { ...base.banner, setupLine: SETUP_LINE } } };
    stripLiveOnlyScheduleFields(data);
    expect(data.reportV2.banner).not.toHaveProperty('setupLine');
  });
});
