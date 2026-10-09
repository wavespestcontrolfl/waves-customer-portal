// The v13 Celsius and Certainty yearly caps count a rolling 365 days (cap entry `yearWindow: 'rolling365'`), where every other
// product keeps the calendar year. Real Postgres in an own cloned schema, synthetic data only. Covers the plan's limit reader, the
// per-place read, the weed-mix decision and the closeout audit.
const { createLawnHistoryDb, fixture } = require('./helpers/lawn-history-db');
const applicationLimits = require('../services/application-limits');
const { V13_COUNT_CAPS, resetV13CapIdentity } = require('../config/lawn-v13-count-caps');
const { refusesAtPlace } = require('../services/lawn-trouble-areas');
const engine = require('../services/waveguard-plan-engine');
const { buildWeedMix } = require('../services/lawn-weed-mix');
const { LAWN_V13_VERSION } = require('../services/lawn-program');
const { getProtocolWindowContext, summarizeProtocolContext } = require('../services/lawn-protocol-operating-layer');
const { chinchLadderIds } = require('../services/lawn-treatment-guide');

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const [CELSIUS, CERTAINTY, BLINDSIDE, ARENA] = ['Celsius WG', 'Certainty Turf Herbicide', 'Blindside Herbicide', 'Arena 50 WDG'];
const GATES = ['GATE_LAWN_V13', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_TREATMENT_GUIDE', 'GATE_LAWN_TROUBLE_AREAS'];
// The per-place read is live only while all four gates are (feature-gates lawnTroubleAreasLive).
const placesOn = () => { for (const name of GATES) process.env[name] = 'true'; };

describe('the cap entries (no database)', () => {
  test('only Celsius and Certainty carry the rolling window; every other entry has none', () => {
    const rolling = V13_COUNT_CAPS.filter((entry) => entry.yearWindow).map((entry) => [entry.name, entry.yearWindow]);
    expect(rolling).toEqual([[CELSIUS, 'rolling365'], [CERTAINTY, 'rolling365']]);
  });

  test('a rolling entry is count-only: yearWindow with annualAmount is refused with a clear message; Arena (amount, calendar) and entries with neither pass', () => {
    expect(() => applicationLimits.assertRollingIsCountOnly(V13_COUNT_CAPS)).not.toThrow();
    expect(V13_COUNT_CAPS.find((entry) => entry.name === ARENA).annualAmount).toBeTruthy();
    expect(() => applicationLimits.assertRollingIsCountOnly([{ name: 'Fixture WG', cap: 2, yearWindow: 'rolling365', annualAmount: { cap: 1 } }]))
      .toThrow(/"Fixture WG" declares yearWindow "rolling365" and annualAmount; a rolling window is supported for the yearly count only/);
    // The program lane's entries (a yearly amount, no yearWindow) must not trip it.
    expect(() => applicationLimits.assertRollingIsCountOnly([{ name: 'Blindside Herbicide', cap: 2, annualAmount: { cap: 1 } }, { name: 'Velista', cap: 2, annualAmount: { cap: 1 } }])).not.toThrow();
  });

  test('windowForName: the cap entry\'s window while GATE_LAWN_V13 is live, the calendar year otherwise', () => {
    const saved = process.env.GATE_LAWN_V13;
    try {
      process.env.GATE_LAWN_V13 = 'true';
      expect(applicationLimits.windowForName('Celsius WG', '2026-01-12')).toMatchObject({ rolling: true, start: '2025-01-13' });
      expect(applicationLimits.windowForName('Blindside Herbicide', '2026-01-12')).toMatchObject({ rolling: false, start: '2026-01-01' });
      expect(applicationLimits.windowForName('Not a product', '2026-01-12')).toMatchObject({ rolling: false, start: '2026-01-01' });
      delete process.env.GATE_LAWN_V13;
      expect(applicationLimits.windowForName('Celsius WG', '2026-01-12')).toMatchObject({ rolling: false, start: '2026-01-01' });
    } finally { if (saved === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = saved; }
  });

  test('windowFor: the calendar year unless rolling365; the rolling window is the 365 days ending on the day', () => {
    expect(applicationLimits.windowFor('2026-01-12', undefined)).toMatchObject({ rolling: false, start: '2026-01-01', when: 'this year' });
    expect(applicationLimits.windowFor('2026-01-12', 'other')).toMatchObject({ rolling: false, start: '2026-01-01' });
    expect(applicationLimits.windowFor('2026-01-12', 'rolling365')).toMatchObject({ rolling: true, start: '2025-01-13', when: 'in the last 365 days' });
    // A leap day inside the window moves the start one day later: 2023-03-01 to 2024-03-01 is 366 days.
    expect(applicationLimits.windowFor('2024-03-01', 'rolling365').start).toBe('2023-03-03');
    expect(applicationLimits.windowFor('2025-03-01', 'rolling365').start).toBe('2024-03-02');
  });
});

describeDb('rolling 365-day yearly caps through PostgreSQL', () => {
  const saved = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
  let owned;
  let knex;
  const catalog = {};

  async function clone(table) {
    await knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [owned.schema, table, table]);
    const columns = await knex(table).columnInfo();
    if (String(columns.id?.defaultValue || '').includes('nextval(')) {
      await knex.raw('ALTER TABLE ??.?? ALTER COLUMN id DROP DEFAULT', [owned.schema, table]);
      await knex.raw('ALTER TABLE ??.?? ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY', [owned.schema, table]);
    }
  }
  const product = async (name, fields = {}) => {
    const [row] = await knex('products_catalog').insert({
      name, category: 'herbicide', default_rate_per_1000: 0.1, rate_unit: 'oz', label_verified_at: new Date(),
      inventory_on_hand: 1000, inventory_unit: 'oz', active: true, ...fields,
    }).returning('*');
    catalog[name] = row;
    return row;
  };

  beforeAll(async () => {
    owned = await createLawnHistoryDb(); knex = owned.knex;
    for (const table of ['products_catalog', 'product_aliases', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_gates', 'service_products', 'product_limits', 'property_application_history']) {
      await clone(table);
    }
    for (const name of [CELSIUS, CERTAINTY, BLINDSIDE]) await product(name);
    await product(ARENA, { category: 'insecticide', default_rate_per_1000: 0.147 });
  }, 60000);
  afterAll(async () => { if (owned) await owned.dispose(); });
  beforeEach(() => { resetV13CapIdentity(); process.env.GATE_LAWN_V13 = 'true'; });
  afterEach(() => {
    for (const name of GATES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  });

  // The ledger rows of a lawn: each one on a visit and service record of its own (so the closeout can leave one visit's rows out).
  async function lawn(name, dates, { place = null, rate = 0.085 } = {}) {
    const f = await fixture(knex);
    const visits = [];
    for (const date of dates) visits.push(await record(f, name, date, { place, rate }));
    return { f, visits };
  }
  async function record(f, name, date, { place = null, rate = 0.085, propertyId = f.property.id } = {}) {
    const [visit] = await knex('scheduled_services').insert({ customer_id: f.customerId, property_id: propertyId, scheduled_date: date, service_type: 'Lawn fixture' }).returning('*');
    const [rec] = await knex('service_records').insert({ customer_id: f.customerId, scheduled_service_id: visit.id, service_date: date, service_type: 'Lawn fixture' }).returning('*');
    await knex('property_application_history').insert({
      customer_id: f.customerId, product_id: catalog[name].id, application_date: date, application_rate: rate, rate_unit: 'oz',
      service_record_id: rec.id, property_id: propertyId, ...(place ? { treated_place: place } : {}),
    });
    return visit;
  }
  const check = (f, name, date, opts = {}) => applicationLimits.checkLimits(f.customerId, catalog[name].id, new Date(`${date}T16:00:00Z`), knex, { propertyId: f.property.id, ...opts });
  const types = (result) => result.blocks.map((block) => block.type);

  describe('the proposal reader (checkLimits: the plan, the sheet, the preflight)', () => {
    test('two December applications and a January one: refused for Celsius and Certainty, allowed for a calendar-year product', async () => {
      for (const name of [CELSIUS, CERTAINTY]) {
        const { f } = await lawn(name, ['2025-12-05', '2025-12-20']);
        const result = await check(f, name, '2026-01-12');
        expect(types(result)).toEqual(['annual_max_apps']);
        expect(result.blocks[0]).toMatchObject({ current: 2, max: 2 });
        expect(result.blocks[0].message).toBe(`${name}: 2/2 applications in the last 365 days — LIMIT REACHED.`);
      }
      const { f } = await lawn(BLINDSIDE, ['2025-12-05', '2025-12-20']);
      expect(types(await check(f, BLINDSIDE, '2026-01-12'))).toEqual([]);
      // ...and the calendar-year product still stops at two in the same calendar year, with its old wording.
      const same = await lawn(BLINDSIDE, ['2026-01-05', '2026-01-20']);
      expect((await check(same.f, BLINDSIDE, '2026-02-12')).blocks[0].message).toBe(`${BLINDSIDE}: 2/2 applications this year — LIMIT REACHED.`);
    });

    test('the window is exactly 365 days: 364 days after the first application it still counts, 365 days after it is free', async () => {
      const { f } = await lawn(CELSIUS, ['2025-03-01', '2025-06-01']);
      expect(types(await check(f, CELSIUS, '2026-02-28'))).toEqual(['annual_max_apps']); // window 2025-03-01 .. 2026-02-28 holds both
      expect(types(await check(f, CELSIUS, '2026-03-01'))).toEqual([]); // window 2025-03-02 .. 2026-03-01 holds one
    });

    test('one application is the LAST allowed (info), not a block; an application dated after the day judged is not held against it', async () => {
      const { f } = await lawn(CELSIUS, ['2025-12-05', '2026-03-01']);
      expect(types(await check(f, CELSIUS, '2026-01-12'))).toEqual([]);
      const result = await check(f, CELSIUS, '2026-01-12');
      expect(result.warnings.find((warning) => warning.severity === 'info').message).toBe(`${CELSIUS}: 1/2 in the last 365 days — this would be the LAST allowed.`);
    });

    test('per place: a row placed elsewhere does not count, a row with no place counts at every place; gate off ignores the place', async () => {
      placesOn();
      const front = await lawn(CELSIUS, ['2025-12-05', '2025-12-20'], { place: 'front' });
      expect(types(await check(front.f, CELSIUS, '2026-01-12', { place: 'front' }))).toEqual(['annual_max_apps']);
      expect(types(await check(front.f, CELSIUS, '2026-01-12', { place: 'back' }))).toEqual([]);
      expect(types(await check(front.f, CELSIUS, '2026-01-12'))).toEqual(['annual_max_apps']);
      const unplaced = await lawn(CELSIUS, ['2025-12-05', '2025-12-20']);
      expect(types(await check(unplaced.f, CELSIUS, '2026-01-12', { place: 'back' }))).toEqual(['annual_max_apps']);
      // The type the /complete preflight refuses at a place is unchanged.
      expect(refusesAtPlace((await check(unplaced.f, CELSIUS, '2026-01-12', { place: 'back' })).blocks[0])).toBe(true);
      delete process.env.GATE_LAWN_TROUBLE_AREAS;
      expect(types(await check(front.f, CELSIUS, '2026-01-12', { place: 'back' }))).toEqual(['annual_max_apps']);
    });

    test('the stored Celsius rows keep their own mechanism: the 3 is lowered to the v13 2 and made hard (rolling), the 0.171 rate row stays on the calendar year', async () => {
      const rows = [
        { limit_type: 'annual_max_apps', limit_value: 3, limit_unit: 'applications' },
        { limit_type: 'annual_max_rate', limit_value: 0.171, limit_unit: 'oz/1000sf/year' },
        { limit_type: 'min_interval_days', limit_value: 60, limit_unit: 'days' },
      ].map((row) => ({ product_id: catalog[CELSIUS].id, match_type: 'product', severity: 'warning', description: 'stored', ...row }));
      await knex('product_limits').insert(rows);
      try {
        const { f } = await lawn(CELSIUS, ['2025-12-05', '2025-12-20']);
        const result = await check(f, CELSIUS, '2026-01-12');
        expect(result.blocks.map((block) => [block.type, block.max])).toEqual([['annual_max_apps', 2]]);
        // Two 0.085 oz passes would reach the stored 0.171 oz rate row inside one calendar year; they straddle the new year, so it stays quiet.
        expect(result.warnings.map((warning) => warning.type)).toEqual(['min_interval_days']);
        const sameYear = await lawn(CELSIUS, ['2026-01-02', '2026-01-09']);
        expect((await check(sameYear.f, CELSIUS, '2026-01-12')).warnings.map((warning) => warning.type)).toEqual(['annual_max_rate', 'min_interval_days']);
      } finally {
        await knex('product_limits').where({ product_id: catalog[CELSIUS].id }).del();
      }
    });

    test('gate off: the legacy calendar year and no v13 cap at all', async () => {
      const { f } = await lawn(CELSIUS, ['2025-12-05', '2025-12-20']);
      delete process.env.GATE_LAWN_V13;
      resetV13CapIdentity();
      expect(types(await check(f, CELSIUS, '2026-01-12'))).toEqual([]);
    });
  });

  describe('the portal\'s Celsius count follows the cap\'s window (celsiusApplicationsThisYear with windowForName)', () => {
    const { celsiusApplicationsThisYear } = require('../services/celsius-application-count');
    test('two December passes read 2 on 12 January under v13 (the cap blocks a third); the calendar start reads 0; gate off is the calendar year', async () => {
      const { f } = await lawn(CELSIUS, ['2025-12-05', '2025-12-20']);
      const count = (start, opts = {}) => celsiusApplicationsThisYear(f.customerId, start, { knex, ...opts });
      expect(await count(applicationLimits.windowForName('Celsius WG', '2026-01-12').start)).toBe(2);
      expect(await count('2026-01-01')).toBe(0);
      expect(types(await check(f, CELSIUS, '2026-01-12'))).toEqual(['annual_max_apps']);
      delete process.env.GATE_LAWN_V13;
      expect(await count(applicationLimits.windowForName('Celsius WG', '2026-01-12').start)).toBe(0);
      process.env.GATE_LAWN_V13 = 'true';
      expect(await count(applicationLimits.windowForName('Celsius WG', '2026-12-21').start)).toBe(0); // 366 days on: out of the window
    });
  });

  describe('the plan reader and the weed-mix decision', () => {
    const svcOf = (f, date) => ({ id: '00000000-0000-4000-8000-000000000001', customer_id: f.customerId, property_id: f.property.id, scheduled_date: date });
    const addOn = (name, gates) => ({ product: catalog[name], gates });
    const structured = { version: LAWN_V13_VERSION, products: [] };
    const mix = (f, date) => buildWeedMix({
      addOns: [addOn(CELSIUS, { annualCounter: 'celsius' }), addOn(CERTAINTY, { tankMixWith: CELSIUS }), addOn(BLINDSIDE, { trigger: 'celsius_annual_cap_reached', annualMaxApps: 2 })],
      svc: svcOf(f, date), structured, knex,
    });

    test('v13VisitLimits caps Celsius when its two applications were in December and the visit is in January', async () => {
      const { f } = await lawn(CELSIUS, ['2025-12-05', '2025-12-20']);
      const found = await engine.v13VisitLimits(knex, svcOf(f, '2026-01-12'), [{ selected: true, product: catalog[CELSIUS] }], new Map(), {});
      expect([...found.capped.keys()]).toEqual([String(catalog[CELSIUS].id)]);
      expect(found.capped.get(String(catalog[CELSIUS].id))[0]).toMatchObject({ type: 'annual_max_apps' });
    });

    test('weed mix: at the rolling cap the replacement is offered; outside the 365 days the lead is back', async () => {
      const { f } = await lawn(CELSIUS, ['2025-12-05', '2025-12-20']);
      const capped = await mix(f, '2026-01-12');
      expect(capped).toMatchObject({ mode: 'replacement', productIds: [catalog[BLINDSIDE].id] });
      expect(capped.note).toContain('Celsius yearly limit reached');
      const freed = await mix(f, '2026-12-21');
      expect(freed.mode).toBe('lead');
      expect(freed.productIds).toEqual([catalog[CELSIUS].id, catalog[CERTAINTY].id]);
    });
  });

  describe('the closeout audit (auditHardCountLimits): any 365-day window that contains the recorded day', () => {
    const audit = (f, visit, name, day) => applicationLimits.auditHardCountLimits(f.customerId, catalog[name].id, day, knex, { propertyId: f.property.id, excludeScheduledServiceId: visit.id });
    const countViolation = (found) => found.find((violation) => violation.type === 'annual_max_apps');

    test('two December applications fill the cap for a January closeout (Celsius, Certainty), not for a calendar-year product', async () => {
      for (const name of [CELSIUS, CERTAINTY]) {
        const { f } = await lawn(name, ['2025-12-10', '2025-12-20']);
        const visit = await record(f, name, '2026-01-15');
        expect(countViolation(await audit(f, visit, name, '2026-01-15'))).toMatchObject({ current: 2, max: 2 });
      }
      const { f } = await lawn(BLINDSIDE, ['2025-12-10', '2025-12-20']);
      const visit = await record(f, BLINDSIDE, '2026-01-15');
      expect(await audit(f, visit, BLINDSIDE, '2026-01-15')).toEqual([]);
    });

    test('a backdated row is flagged when a window that contains it holds two others, in either direction', async () => {
      // Others on 2025-12-28 and 2026-12-20 (357 days apart): one window holds both and the backdated day 2026-06-01.
      const { f } = await lawn(CELSIUS, ['2025-12-28', '2026-12-20']);
      const visit = await record(f, CELSIUS, '2026-06-01');
      expect(countViolation(await audit(f, visit, CELSIUS, '2026-06-01'))).toMatchObject({ current: 2, max: 2 });
      // The calendar year of 2026 holds only one of them: the old reading would not flag it.
      const blind = await lawn(BLINDSIDE, ['2025-12-28', '2026-12-20']);
      const blindVisit = await record(blind.f, BLINDSIDE, '2026-06-01');
      expect(await audit(blind.f, blindVisit, BLINDSIDE, '2026-06-01')).toEqual([]);
    });

    test('the window edge: others 365 days before the day are out, 364 days before are in', async () => {
      const closeout = async (day) => {
        const { f } = await lawn(CELSIUS, ['2025-06-01', '2025-06-10']);
        const visit = await record(f, CELSIUS, day);
        return countViolation(await audit(f, visit, CELSIUS, day));
      };
      expect(await closeout('2026-06-10')).toBeUndefined(); // 365 days after 2025-06-10: both out
      expect(await closeout('2026-06-09')).toBeUndefined(); // 2025-06-10 in, 2025-06-01 out: one other
      expect(await closeout('2026-05-31')).toMatchObject({ current: 2 }); // both in
    });

    test('per place: the same scoping as the proposal reader (a row placed elsewhere is out, an unplaced row counts)', async () => {
      placesOn();
      const { f } = await lawn(CELSIUS, ['2025-12-10', '2025-12-20'], { place: 'front' });
      const visit = await record(f, CELSIUS, '2026-01-15', { place: 'back' });
      const run = (place) => applicationLimits.auditHardCountLimits(f.customerId, catalog[CELSIUS].id, '2026-01-15', knex, { propertyId: f.property.id, excludeScheduledServiceId: visit.id, place });
      expect(countViolation(await run('back'))).toBeUndefined();
      expect(countViolation(await run('front'))).toMatchObject({ current: 2 });
    });
  });

  // Owner rulings: Blindside replaces Celsius only when Celsius is at its yearly cap, and February is Celsius alone. The data says it with
  // a retired flag on the month's Blindside row (gates.retired = true); no reader keeps a month list.
  describe('a retired staged row is never offered (Blindside in a month the program does not stage it)', () => {
    let protocol;
    const windows = {};
    const rowOf = (windowKey, name, gates, extra = {}) => knex('lawn_protocol_products').insert({
      lawn_protocol_window_id: windows[windowKey].id, product_id: catalog[name].id, product_name: name, role: 'post_emergent_spot', application_mode: 'spot',
      default_in_plan: false, gates: JSON.stringify(gates), sort_order: 1, ...extra,
    });

    beforeAll(async () => {
      [protocol] = await knex('lawn_protocols').insert({ protocol_key: 'fixture_retired', version: LAWN_V13_VERSION, name: 'Fixture', status: 'staged', grass_track: 'bermuda', region: 'swfl', effective_from: '2000-01-01' }).returning('*');
      for (const [month, key] of [[2, 'feb_v13'], [3, 'mar_v13']]) {
        [windows[key]] = await knex('lawn_protocol_windows').insert({ lawn_protocol_id: protocol.id, month, window_key: key, title: key, visit_type: 'x' }).returning('*');
        await rowOf(key, CELSIUS, { annualCounter: 'celsius' });
        await rowOf(key, CERTAINTY, { tankMixWith: CELSIUS });
      }
      await rowOf('feb_v13', BLINDSIDE, { trigger: 'celsius_annual_cap_reached', annualMaxApps: 2, retired: true });
      await rowOf('mar_v13', BLINDSIDE, { trigger: 'celsius_annual_cap_reached', annualMaxApps: 2 });
      // A chinch first rung staged only in a retired row.
      await rowOf('feb_v13', ARENA, { trigger: 'chinch_20_to_25_per_sqft', retired: true });
    });

    const contextFor = async (windowKey, date) => {
      const context = await getProtocolWindowContext(knex, { serviceDate: new Date(`${date}T17:00:00Z`), grassTrack: 'bermuda', region: 'swfl', planning: true, windowKey, protocolKey: 'fixture_retired', protocolVersion: LAWN_V13_VERSION });
      const summary = summarizeProtocolContext(context);
      const byId = new Map(Object.values(catalog).map((row) => [String(row.id), row]));
      return { summary, addOns: summary.products.map((row) => ({ product: byId.get(String(row.productId)), gates: row.gates })) };
    };

    test('the window context leaves the retired row out and keeps the active one', async () => {
      expect((await contextFor('feb_v13', '2027-02-10')).summary.products.map((row) => row.protocolProductName).sort()).toEqual([CELSIUS, CERTAINTY]);
      expect((await contextFor('mar_v13', '2027-03-10')).summary.products.map((row) => row.protocolProductName).sort()).toEqual([BLINDSIDE, CELSIUS, CERTAINTY]);
    });

    test('Celsius at its cap: a month with a retired Blindside row offers nothing; a month with an active row offers Blindside', async () => {
      const { f } = await lawn(CELSIUS, ['2026-11-05', '2026-12-20']);
      const feb = await contextFor('feb_v13', '2027-02-10');
      const february = await buildWeedMix({ addOns: feb.addOns, svc: { id: '00000000-0000-4000-8000-000000000002', customer_id: f.customerId, property_id: f.property.id, scheduled_date: '2027-02-10' }, structured: feb.summary, knex });
      expect(february).toMatchObject({ mode: 'none', productIds: [], replacementProductId: null, note: 'The yearly weed-spray limit is reached for this lawn.' });
      const mar = await contextFor('mar_v13', '2027-03-10');
      const march = await buildWeedMix({ addOns: mar.addOns, svc: { id: '00000000-0000-4000-8000-000000000003', customer_id: f.customerId, property_id: f.property.id, scheduled_date: '2027-03-10' }, structured: mar.summary, knex });
      expect(march).toMatchObject({ mode: 'replacement', productIds: [catalog[BLINDSIDE].id], replacementProductId: catalog[BLINDSIDE].id });
    });

    test('the chinch ladder reads no retired row (and reads the same row once it is not retired)', async () => {
      expect(await chinchLadderIds({ structured: { id: protocol.id }, knex })).toEqual([]);
      await knex('lawn_protocol_products').where({ product_id: catalog[ARENA].id }).update({ gates: JSON.stringify({ trigger: 'chinch_20_to_25_per_sqft' }) });
      expect(await chinchLadderIds({ structured: { id: protocol.id }, knex })).toEqual([String(catalog[ARENA].id)]);
    });
  });
});
