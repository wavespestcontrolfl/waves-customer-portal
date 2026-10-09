/**
 * Several area add-ons are ONE visit (GATE_AREA_ADDONS, owner ruling 2026-10-08):
 *   B. every add-on is on the appointment record (area-addon-visit-rows.js);
 *   C. the visit is sized to the sum of the add-ons' on-site minutes;
 *   and the readers that must see every add-on: the completion invoice, the
 *   closeout license check and the completion route.
 *
 * No database: the writer runs against a small in-memory fake of the three
 * tables it touches. The DATABASE_URL suite (area-addon-visit-rows-postgres)
 * drives the real accept transaction in CI.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
const { generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { AREA_ADDONS, isAreaAddOnCatalogKey } = require('../services/pricing-engine/constants');
const availability = require('../services/estimate-slot-availability');
const rows = require('../services/area-addon-visit-rows');

const PROFILE = { homeSqFt: 2000, lotSqFt: 7500 };
const savedGate = process.env.GATE_AREA_ADDONS;
beforeEach(() => { process.env.GATE_AREA_ADDONS = 'true'; });
afterEach(() => {
  delete process.env.GATE_SCHEDULING_CAPACITY;
  delete process.env.GATE_VISIT_COMBINED_CAPACITY;
});
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_AREA_ADDONS;
  else process.env.GATE_AREA_ADDONS = savedGate;
});

function priced(areaAddOns, { selected = [], options = {} } = {}) {
  const v1Input = translateV2CallToV1Input(PROFILE, selected, { grassType: 'A', ...options, areaAddOns });
  const result = generateEstimate(v1Input);
  const mapped = mapV1ToLegacyShape(result);
  return { result, mapped, estData: { result: mapped, engineInputs: v1Input } };
}

// A one-time estimate row for the slot profile: the add-on rows the engine priced,
// with an ordinary one-time pest row beside them when asked.
function oneTimeEstimate(areaAddOns, { withPest = false } = {}) {
  const { mapped, result } = priced(areaAddOns);
  const items = [...(withPest ? [{ service: 'one_time_pest', name: 'One-Time Pest Control', price: 150 }] : []), ...mapped.oneTime.items];
  const total = items.reduce((sum, item) => sum + item.price, 0);
  return {
    estimate: { service_interest: 'One-time service', estimate_data: { result: { oneTime: { total, items } } } },
    onSiteMinutes: result.lineItems.filter((l) => l.service === 'area_addon').reduce((sum, l) => sum + Math.ceil(l.costs.onSiteMin), 0),
    total,
  };
}

const ALL_SIX = Object.entries(AREA_ADDONS.items).map(([key, cfg]) => ({
  key, ...(cfg.tiers ? { areaSqFt: cfg.tiers[cfg.tiers.length - 1], grassType: 'st_augustine' } : {}),
}));
const THREE = [
  { key: 'bed_pre_emergent', areaSqFt: 3500 },
  { key: 'fire_ant_yard', areaSqFt: 8000 },
  { key: 'hardscape_weed', areaSqFt: 1000 },
];
const ceil15 = (n) => Math.ceil(n / 15) * 15;

describe('C. the visit is sized to the sum of the add-ons (capacity gate off)', () => {
  test('add-ons alone reserve at least their summed on-site minutes, not the default hour', () => {
    const { estimate, onSiteMinutes } = oneTimeEstimate(THREE);
    expect(onSiteMinutes).toBeGreaterThan(60);
    const profile = availability.resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' });
    expect(profile.durationMinutes).toBeGreaterThanOrEqual(onSiteMinutes);
    expect(profile.durationMinutes).toBe(ceil15(onSiteMinutes));
    expect(profile.services.map((s) => s.engineKey)).toEqual(['area_addon', 'area_addon', 'area_addon']);
  });

  test('a small add-on keeps today\'s hour (the sum never lowers the default)', () => {
    const { estimate, onSiteMinutes } = oneTimeEstimate([{ key: 'web_sweep' }]);
    expect(onSiteMinutes).toBeLessThan(60);
    expect(availability.resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' }).durationMinutes).toBe(60);
  });

  test('with an ordinary one-time service the add-ons come on top of its usual hour', () => {
    const { estimate, onSiteMinutes } = oneTimeEstimate(THREE, { withPest: true });
    const profile = availability.resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' });
    expect(profile.durationMinutes).toBe(ceil15(60 + onSiteMinutes));
    expect(profile.durationMinutes).toBeGreaterThanOrEqual(60 + onSiteMinutes);
  });

  test('all six at their top tier exceed the old 180-minute cap and are not capped', () => {
    const { estimate, onSiteMinutes } = oneTimeEstimate(ALL_SIX, { withPest: true });
    const profile = availability.resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' });
    expect(onSiteMinutes + 60).toBeGreaterThan(180);
    expect(profile.durationMinutes).toBeGreaterThanOrEqual(onSiteMinutes + 60);
  });

  test('an estimate with no area add-on sizes exactly as before', () => {
    const plain = { service_interest: 'x', estimate_data: { result: { oneTime: { total: 150, items: [{ service: 'one_time_pest', name: 'One-Time Pest Control', price: 150 }] } } } };
    expect(availability.resolveEstimateSlotProfile(plain, { serviceMode: 'one_time' }).durationMinutes).toBe(60);
    expect(availability.resolveEstimateSlotProfile(plain, { serviceMode: 'one_time', durationMinutes: 100 }).durationMinutes).toBe(105);
  });

  test('the catalog pass with the combined-capacity gate on or off gives the same floor', async () => {
    const { estimate, onSiteMinutes } = oneTimeEstimate(THREE);
    for (const gate of [undefined, 'true']) {
      if (gate) process.env.GATE_VISIT_COMBINED_CAPACITY = gate;
      const profile = await availability.resolveCatalogSlotProfile(estimate, { serviceMode: 'one_time' });
      expect(profile.durationMinutes).toBeGreaterThanOrEqual(onSiteMinutes);
    }
  });

  test('capacity on: each add-on books max(catalog default, its engine minutes) and the visit is their sum', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const reservation = require('../services/slot-reservation');
    const link = jest.spyOn(reservation, 'catalogLinkForProfile').mockImplementation(async () => ({ default_duration_minutes: 10 }));
    try {
      const { estimate, onSiteMinutes } = oneTimeEstimate(THREE);
      const profile = await availability.resolveCatalogSlotProfile(estimate, { serviceMode: 'one_time' });
      expect(profile.services).toHaveLength(3);
      expect(profile.durationMinutes).toBeGreaterThanOrEqual(onSiteMinutes);
      expect(profile.services.reduce((sum, s) => sum + s.durationMinutes, 0)).toBe(profile.durationMinutes);
    } finally { link.mockRestore(); }
  });

  test('the add-on price rides the profile row (internal) and is the engine price', () => {
    const { estimate, total } = oneTimeEstimate(THREE);
    const profile = availability.resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' });
    expect(profile.services.reduce((sum, s) => sum + s.addOnPrice, 0)).toBe(total);
    expect(profile.services.every((s) => s.catalogServiceKey?.startsWith('area_addon_'))).toBe(true);
  });
});

// ── B. the writer, against an in-memory fake of the three tables it touches ──────
function fakeTrx({ catalog = [], existing = [] } = {}) {
  const state = { addons: [...existing], calls: [], visitScope: {} };
  const trx = (table) => {
    state.calls.push(table);
    if (table === 'scheduled_services') {
      return { where: ({ id }) => ({ update: async (data) => { state.visitScope[id] = JSON.parse(data.area_addon_scope); } }) };
    }
    if (table === 'scheduled_service_addons') {
      return {
        where: ({ scheduled_service_id: id }) => ({
          select: async () => state.addons.filter((r) => r.scheduled_service_id === id).map((r) => ({ service_key_snapshot: r.service_key_snapshot })),
        }),
        columnInfo: async () => ({
          id: {}, scheduled_service_id: {}, service_id: {}, service_name: {}, estimated_price: {}, created_at: {},
          base_price: {}, service_key_snapshot: {}, service_category_snapshot: {}, estimated_duration_minutes: {}, recurring_pattern: {}, area_addon_scope: {},
        }),
        insert: async (data) => { state.addons.push(data); },
      };
    }
    if (table === 'services') {
      return { whereIn: (_col, keys) => ({ select: async () => catalog.filter((c) => keys.includes(c.service_key)) }) };
    }
    throw new Error(`unexpected table ${table}`);
  };
  trx.raw = (sql) => ({ raw: sql });
  trx.schema = { hasColumn: async () => true };
  trx.state = state;
  return trx;
}
const catalogFor = (keys) => keys.map((key) => {
  const cfg = Object.values(AREA_ADDONS.items).find((c) => c.serviceKey === key);
  return { id: `id-${key}`, service_key: key, name: cfg.name, category: cfg.category };
});
const addOnRow = (key, extra = {}) => {
  const cfg = Object.values(AREA_ADDONS.items).find((c) => c.serviceKey === key);
  return { service: cfg.category, label: cfg.name, engineKey: 'area_addon', catalogServiceKey: key, durationMinutes: 20, addOnPrice: 69, ...extra };
};
const KEYS = ['area_addon_bed_pre_emergent', 'area_addon_fire_ant_yard', 'area_addon_hardscape_weed'];

describe('B. every add-on other than the visit\'s own becomes a structured row', () => {
  test('three add-ons: the stamped one is the appointment, the other two are rows with identity, price and minutes', async () => {
    const trx = fakeTrx({ catalog: catalogFor(KEYS) });
    const serviceProfile = { serviceMode: 'one_time', services: KEYS.map((key, i) => addOnRow(key, { addOnPrice: 99 + i * 10, durationMinutes: 20 + i })) };
    const written = await rows.writeAreaAddOnVisitRows(trx, { scheduledServiceId: 'visit-1', serviceProfile, ownServiceKey: KEYS[0] });
    expect(written).toBe(2);
    expect(trx.state.addons.map((r) => [r.service_key_snapshot, r.service_id, r.service_name, r.estimated_price, r.base_price, r.estimated_duration_minutes, r.service_category_snapshot, r.scheduled_service_id, r.recurring_pattern])).toEqual([
      [KEYS[1], `id-${KEYS[1]}`, AREA_ADDONS.items.fire_ant_yard.name, 109, 109, 21, 'lawn_care', 'visit-1', 'one_time'],
      [KEYS[2], `id-${KEYS[2]}`, AREA_ADDONS.items.hardscape_weed.name, 119, 119, 22, 'lawn_care', 'visit-1', 'one_time'],
    ]);
  });

  test('with an ordinary one-time service as the visit\'s own, both add-ons are rows', async () => {
    const trx = fakeTrx({ catalog: catalogFor(KEYS) });
    const serviceProfile = { serviceMode: 'one_time', services: [{ service: 'pest_control', label: 'One-Time Pest Control', engineKey: 'one_time_pest' }, addOnRow(KEYS[0]), addOnRow(KEYS[1])] };
    const written = await rows.writeAreaAddOnVisitRows(trx, { scheduledServiceId: 'visit-1', serviceProfile, ownServiceKey: 'pest_initial_cleanout' });
    expect(written).toBe(2);
    expect(trx.state.addons.map((r) => r.service_key_snapshot)).toEqual([KEYS[0], KEYS[1]]);
  });

  test('exactly once: a replayed write adds nothing, and a row an admin already added is not doubled', async () => {
    const trx = fakeTrx({ catalog: catalogFor(KEYS) });
    const serviceProfile = { serviceMode: 'one_time', services: KEYS.map((key) => addOnRow(key)) };
    expect(await rows.writeAreaAddOnVisitRows(trx, { scheduledServiceId: 'visit-1', serviceProfile, ownServiceKey: KEYS[0] })).toBe(2);
    expect(await rows.writeAreaAddOnVisitRows(trx, { scheduledServiceId: 'visit-1', serviceProfile, ownServiceKey: KEYS[0] })).toBe(0);
    expect(trx.state.addons).toHaveLength(2);
    const withAdmin = fakeTrx({ catalog: catalogFor(KEYS), existing: [{ scheduled_service_id: 'visit-2', service_key_snapshot: KEYS[1] }] });
    expect(await rows.writeAreaAddOnVisitRows(withAdmin, { scheduledServiceId: 'visit-2', serviceProfile, ownServiceKey: KEYS[0] })).toBe(1);
    expect(withAdmin.state.addons.map((r) => r.service_key_snapshot)).toEqual([KEYS[1], KEYS[2]]);
  });

  test('a visit with no area add-on reads and writes nothing', async () => {
    const trx = fakeTrx();
    const serviceProfile = { serviceMode: 'one_time', services: [{ service: 'pest_control', label: 'One-Time Pest Control', engineKey: 'one_time_pest' }] };
    expect(await rows.writeAreaAddOnVisitRows(trx, { scheduledServiceId: 'visit-1', serviceProfile })).toBe(0);
    expect(trx.state.calls).toEqual([]);
    // The only add-on IS the appointment: no row, but its sold scope is stamped on the visit.
    expect(await rows.writeAreaAddOnVisitRows(trx, { scheduledServiceId: 'visit-1', serviceProfile: { services: [addOnRow(KEYS[0])] }, ownServiceKey: KEYS[0] })).toBe(0);
    expect(trx.state.calls).toEqual(['scheduled_services']);
  });

  // The sold scope (Codex round 6 P1): the treated area, the priced tier and the grass that
  // authorized the rate ride onto the booked visit, for both shapes.
  test('the sold scope is stamped on the appointment (its own add-on) and on each add-on row', async () => {
    const trx = fakeTrx({ catalog: catalogFor([...KEYS, 'area_addon_lawn_insect_spot']) });
    const SPOT = 'area_addon_lawn_insect_spot';
    const serviceProfile = { serviceMode: 'one_time', services: [
      addOnRow(SPOT, { addOnKey: 'lawn_insect_spot', areaSqFt: 1450, tierSqFt: 2000, grassType: 'st_augustine' }),
      addOnRow(KEYS[0], { addOnKey: 'bed_pre_emergent', areaSqFt: 800, tierSqFt: 1000 }),
    ] };
    expect(await rows.writeAreaAddOnVisitRows(trx, { scheduledServiceId: 'visit-1', serviceProfile, ownServiceKey: SPOT })).toBe(1);
    expect(trx.state.visitScope['visit-1']).toEqual({ v: 1, addOnKey: 'lawn_insect_spot', catalogServiceKey: SPOT, areaSqFt: 1450, tierSqFt: 2000, grassType: 'st_augustine' });
    expect(JSON.parse(trx.state.addons[0].area_addon_scope)).toEqual({ v: 1, addOnKey: 'bed_pre_emergent', catalogServiceKey: KEYS[0], areaSqFt: 800, tierSqFt: 1000, grassType: null });
  });

  test('the public slot payload strips the sold scope with the other internal fields', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'estimate-slot-availability.js'), 'utf8');
    for (const field of ['addOnPrice', 'addOnKey', 'areaSqFt', 'tierSqFt', 'grassType']) expect(src).toContain(`delete publicService.${field};`);
  });

  test('the slot profile row carries the sold scope from the priced line, grass included for the insect spot', () => {
    const { estimate } = oneTimeEstimate([
      { key: 'bed_pre_emergent', areaSqFt: 1450 }, { key: 'lawn_insect_spot', areaSqFt: 900, grassType: 'st_augustine' }, { key: 'web_sweep' },
    ]);
    const profile = availability.resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' });
    const byKey = Object.fromEntries(profile.services.map((svc) => [svc.catalogServiceKey, svc]));
    expect(byKey.area_addon_bed_pre_emergent).toMatchObject({ addOnKey: 'bed_pre_emergent', areaSqFt: 1450, tierSqFt: 2000 });
    expect(byKey.area_addon_bed_pre_emergent.grassType).toBeUndefined();
    expect(byKey.area_addon_lawn_insect_spot).toMatchObject({ addOnKey: 'lawn_insect_spot', areaSqFt: 900, tierSqFt: 1000, grassType: 'st_augustine' });
    expect(byKey.area_addon_web_sweep.areaSqFt).toBeUndefined();
  });

  test('a sold add-on that cannot be a structured row fails the booking instead of being dropped', async () => {
    for (const broken of [{ catalogServiceKey: null }, { addOnPrice: null }, { addOnPrice: 0 }]) {
      const trx = fakeTrx({ catalog: catalogFor(KEYS) });
      const serviceProfile = { services: [addOnRow(KEYS[0]), addOnRow(KEYS[1], broken)] };
      await expect(rows.writeAreaAddOnVisitRows(trx, { scheduledServiceId: 'visit-1', serviceProfile, ownServiceKey: KEYS[0] }))
        .rejects.toMatchObject({ code: 'AREA_ADDON_ROW_UNRESOLVED', statusCode: 409 });
      expect(trx.state.addons).toEqual([]);
    }
  });

  test('a missing catalog row still writes the row from its key snapshot (the recipe and closeout readers key on it)', async () => {
    const trx = fakeTrx({ catalog: [] });
    await rows.writeAreaAddOnVisitRows(trx, { scheduledServiceId: 'visit-1', serviceProfile: { services: [addOnRow(KEYS[1])] }, ownServiceKey: null });
    expect(trx.state.addons).toHaveLength(1);
    expect(trx.state.addons[0]).toMatchObject({ service_id: null, service_key_snapshot: KEYS[1], estimated_price: 69 });
  });

  test('the one rule for the visit\'s own service: pest control first, else the first row', () => {
    expect(rows.primaryProfileService({ services: [{ service: 'lawn_care', label: 'a' }, { service: 'pest_control', label: 'b' }] }).label).toBe('b');
    expect(rows.primaryProfileService({ services: [{ service: 'lawn_care', label: 'a' }, { service: 'mosquito', label: 'c' }] }).label).toBe('a');
    expect(rows.primaryProfileService({ services: [] })).toBeNull();
  });

  test('a service that is not an area add-on outranks an add-on, even a pest-family web sweep', () => {
    const lawn = { service: 'lawn_care', label: 'One-Time Lawn Care', engineKey: 'one_time_lawn' };
    const sweep = addOnRow('area_addon_web_sweep');
    const fireAnt = addOnRow('area_addon_fire_ant_yard');
    expect(sweep.service).toBe('pest_control');
    // The lawn treatment keeps the appointment (its own completion profile and closeout rules).
    expect(rows.primaryProfileService({ services: [sweep, lawn] })).toBe(lawn);
    expect(rows.primaryProfileService({ services: [fireAnt, sweep, lawn] })).toBe(lawn);
    // The sweep is then an add-on row, not dropped.
    expect(rows.secondaryAreaAddOns({ services: [sweep, lawn] }, null)).toEqual([sweep]);
    // The booking label follows the same row as the catalog stamp: a lawn job with a sweep is not "Pest Control".
    const { canonicalServiceTypeForProfile } = require('../services/slot-reservation')._internals;
    expect(canonicalServiceTypeForProfile({ services: [sweep, lawn] }, 'Estimate service', { serviceMode: 'one_time' })).toBe('Lawn Care');
    expect(canonicalServiceTypeForProfile({ services: [fireAnt, sweep] }, 'Estimate service', { serviceMode: 'one_time' })).toBe('Pest Control');
    // Add-ons only: pest control first, else the first, as before.
    expect(rows.primaryProfileService({ services: [fireAnt, sweep] })).toBe(sweep);
    expect(rows.primaryProfileService({ services: [fireAnt, addOnRow('area_addon_bed_pre_emergent')] })).toBe(fireAnt);
  });

  test('a job card product shared by the visit and a chemical add-on keeps the add-on\'s governed text', () => {
    const { mergeProductLines } = require('../services/job-card');
    const product = { id: 'prod-1', name: 'Topchoice Granular Insecticide' };
    const own = { raw: 'Program line', role: 'base', selected: true, product };
    const governed = { rate: '2 lb per 1,000 sq ft', area: 'Lawn', limit: 'Once per 12 months', safety: 'Restricted-use product' };
    const addOn = { raw: 'Broadcast the granules over the lawn.', role: 'base', selected: true, product, governed, source: 'Fire Ant Yard Treatment' };
    for (const order of [[own, addOn], [addOn, own], [{ ...own, selected: false }, addOn], [addOn, { ...own, selected: false }]]) {
      const merged = mergeProductLines(order);
      expect(merged).toHaveLength(1);
      expect(merged[0].governed).toEqual(governed);
      expect(merged[0].extraLines).toHaveLength(1);
    }
    // Ordinary lines gain no governed field.
    const plain = mergeProductLines([own, { ...own, raw: 'Conditional line' }]);
    expect(plain[0]).not.toHaveProperty('governed');
  });

  test('a priced two-add-on estimate becomes one stamped service plus one row that sum to the one-time total', async () => {
    const { estimate, total } = oneTimeEstimate([{ key: 'bed_pre_emergent', areaSqFt: 1500 }, { key: 'web_sweep' }]);
    const profile = availability.resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' });
    const own = rows.primaryProfileService(profile);
    expect(own.catalogServiceKey).toBe('area_addon_web_sweep'); // pest control family is the stamp
    const trx = fakeTrx({ catalog: catalogFor(['area_addon_bed_pre_emergent', 'area_addon_web_sweep']) });
    await rows.writeAreaAddOnVisitRows(trx, { scheduledServiceId: 'v', serviceProfile: profile, ownServiceKey: own.catalogServiceKey });
    const ownPrice = own.addOnPrice;
    expect(trx.state.addons.map((r) => r.service_key_snapshot)).toEqual(['area_addon_bed_pre_emergent']);
    expect(ownPrice + trx.state.addons.reduce((sum, r) => sum + r.estimated_price, 0)).toBe(total);
  });
});

describe('adopting an existing appointment never squeezes the add-on visit into a shorter stop', () => {
  test('booked minutes come from the recorded duration, else the window', () => {
    expect(rows.bookedVisitMinutes({ estimated_duration_minutes: 90, window_start: '09:00', window_end: '09:30' })).toBe(90);
    expect(rows.bookedVisitMinutes({ window_start: '09:00:00', window_end: '10:30:00' })).toBe(90);
    expect(rows.bookedVisitMinutes({ window_start: '10:00', window_end: '09:00' })).toBe(0);
    expect(rows.bookedVisitMinutes({})).toBe(0);
  });

  test('a shorter or unsized appointment fails the accept closed and writes nothing', async () => {
    const { estimate } = oneTimeEstimate(THREE);
    const needed = availability.resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' }).durationMinutes;
    expect(needed).toBeGreaterThan(60);
    for (const adoptedRow of [{ estimated_duration_minutes: 60 }, { window_start: '09:00', window_end: '09:30' }, {}]) {
      const trx = fakeTrx({ catalog: catalogFor(KEYS) });
      await expect(rows.writeAdoptedAreaAddOns(trx, { scheduledServiceId: 'visit-1', estimate, adoptedRow }))
        .rejects.toMatchObject({ status: 409, code: 'AREA_ADDON_VISIT_NEEDS_NEW_SLOT' });
      expect(trx.state.addons).toEqual([]);
    }
  });

  test('an appointment that already holds the whole visit takes the add-on rows', async () => {
    const { estimate } = oneTimeEstimate(THREE);
    const needed = availability.resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' }).durationMinutes;
    const trx = fakeTrx({ catalog: catalogFor(KEYS) });
    await rows.writeAdoptedAreaAddOns(trx, {
      scheduledServiceId: 'visit-1', estimate, ownServiceKey: KEYS[0], adoptedRow: { estimated_duration_minutes: needed },
    });
    // The appointment's own service is not repeated as a row.
    expect(trx.state.addons.map((r) => r.service_key_snapshot)).toEqual(KEYS.slice(1));
  });

  test('an estimate with no area add-on adopts as before, whatever the appointment length', async () => {
    const estimate = { service_interest: 'One-time service', estimate_data: { result: { oneTime: { total: 150, items: [{ service: 'one_time_pest', name: 'One-Time Pest Control', price: 150 }] } } } };
    const trx = fakeTrx();
    await expect(rows.writeAdoptedAreaAddOns(trx, { scheduledServiceId: 'visit-1', estimate, adoptedRow: {} })).resolves.toBe(0);
    expect(trx.state.addons).toEqual([]);
  });
});

describe('the completion invoice equals the one-time total with no double count', () => {
  const InvoiceService = require('../services/invoice');
  // The visit row and its add-on rows as the accept leaves them: estimated_price is
  // the whole one-time total, each add-on row carries only its own price.
  function invoiceDb(visit, addons) {
    const thenable = (value) => ({ then: (res, rej) => Promise.resolve(value).then(res, rej), catch: (fn) => Promise.resolve(value).catch(fn) });
    const conn = (table) => {
      if (table === 'scheduled_services') return { where: () => ({ first: () => thenable(visit) }) };
      if (table === 'scheduled_service_addons') return { where: () => ({ orderBy: () => thenable(addons) }) };
      throw new Error(`unexpected ${table}`);
    };
    return conn;
  }

  test.each([
    ['an add-on is the visit itself and two are rows', 'Web Sweep', 59 + 99 + 119, [99, 119]],
    ['an ordinary service is the visit and both add-ons are rows', 'One-Time Pest Control', 150 + 99 + 119, [99, 119]],
  ])('%s', async (_label, serviceType, total, addonPrices) => {
    const visit = { id: 'v1', service_type: serviceType, estimated_price: total, primary_line_price: null };
    const addons = addonPrices.map((price, i) => ({ id: `a${i}`, service_name: `Add-on ${i}`, estimated_price: price, base_price: price, service_key_snapshot: `area_addon_${i}`, service_category_snapshot: 'lawn_care' }));
    const { lineItems } = await InvoiceService.buildLineItemsForScheduledService('v1', { fallbackAmount: total, fallbackDescription: serviceType, database: invoiceDb(visit, addons) });
    const sum = Math.round(lineItems.reduce((s, l) => s + Number(l.amount), 0) * 100) / 100;
    expect(sum).toBe(total);
    expect(lineItems.filter((l) => /_addon_/.test(l.client_id))).toHaveLength(2);
    expect(lineItems.find((l) => /_primary$/.test(l.client_id)).amount).toBe(total - addonPrices.reduce((a, b) => a + b, 0));
    expect(lineItems.some((l) => l._kind === 'discount')).toBe(false);
  });
});

describe('closeout requires the L&O license when any add-on on the visit is chemical', () => {
  const reqs = require('../services/service-closeout-requirements');
  const VISIT_ID = '7c1b0a5e-2f3d-4a6b-9c8d-0e1f2a3b4c5d';
  const { deriveCloseoutFacts } = require('../services/closeout-status');
  const CAT = (key, over = {}) => ({
    id: `id-${key}`, service_key: key, name: key, category: 'lawn_care', requires_service_report: true, requires_application_log: true,
    required_photo_count: 0, requires_customer_signature: false, requires_customer_notice: true, requires_license: false,
    license_category: null, closeout_requirements_source: 'catalog_v2', ...over,
  });
  // A knex stub for the tables the resolver reads: `services` and the visit's add-on rows.
  function stub({ services, addons }) {
    const k = (table) => {
      const qb = { _table: table, _keys: null };
      k.queries.push(table);
      qb.leftJoin = () => qb;
      qb.where = () => qb;
      qb.whereIn = (col, vals) => { qb._keys = vals; return qb; };
      qb.orWhereIn = () => qb;
      qb.select = () => qb;
      qb.then = (res, rej) => {
        const out = table.startsWith('scheduled_service_addons') ? addons : services.filter((s) => !qb._keys || qb._keys.includes(s.id) || qb._keys.includes(s.service_key));
        return Promise.resolve(out).then(res, rej);
      };
      qb.catch = (fn) => qb.then(undefined, fn);
      return qb;
    };
    k.raw = (sql) => sql;
    k.queries = [];
    k.schema = { hasColumn: async () => true };
    return k;
  }
  const sweep = CAT('area_addon_web_sweep', { category: 'pest_control' });
  const bed = CAT('area_addon_bed_pre_emergent', { requires_license: true, license_category: 'L&O' });
  const ant = CAT('area_addon_fire_ant_yard', { requires_license: true, license_category: 'L&O' });
  const pest = CAT('pest_initial_cleanout', { category: 'pest_control', requires_license: true, license_category: 'GHP' });
  const job = (serviceId) => ({ id: VISIT_ID, service_id: serviceId, service_type: 'x' });

  test('a web sweep visit (no license) with a chemical add-on row requires the L&O license', async () => {
    const knex = stub({ services: [{ ...sweep, id: 'sweep' }, bed], addons: [{ scheduled_service_id: VISIT_ID, service_key: 'area_addon_bed_pre_emergent' }] });
    const map = await reqs.resolveCloseoutRequirementsForJobs([job('sweep')], { knex, strict: true });
    expect(map.get(VISIT_ID)).toMatchObject({ requiresLicense: true, licenseCategory: 'L&O', requiresApplicationLog: true });
    const alone = await reqs.resolveCloseoutRequirementsForJobs([job('sweep')], { knex: stub({ services: [{ ...sweep, id: 'sweep' }], addons: [] }), strict: true });
    expect(alone.get(VISIT_ID)).toMatchObject({ requiresLicense: false, licenseCategory: null });
  });

  test('the license verdict is not "no license required": a web-sweep-primary visit with a chemical add-on is judged against the technician', async () => {
    const knex = stub({ services: [{ ...sweep, id: 'sweep' }, bed, ant], addons: [
      { scheduled_service_id: VISIT_ID, service_key: 'area_addon_bed_pre_emergent' },
      { scheduled_service_id: VISIT_ID, service_key: 'area_addon_fire_ant_yard' },
    ] });
    const requirements = (await reqs.resolveCloseoutRequirementsForJobs([job('sweep')], { knex, strict: true })).get(VISIT_ID);
    const base = {
      completed: true, requirements, technician: { id: 't', fl_applicator_license: 'JF1', license_expiry: '2099-01-01', license_categories: ['General Household Pest'] },
      visit: { technician_id: 't', scheduled_date: '2026-10-08', status: 'completed' }, record: { id: 'r', status: 'completed', service_date: '2026-10-08' },
    };
    const run = (technician) => deriveCloseoutFacts({ ...base, technician, requirements }).facts.license;
    expect(run(base.technician)).toMatchObject({ state: 'failed', reason: 'technician_license_category_mismatch' });
    expect(run({ ...base.technician, license_categories: ['Lawn & Ornamental'] })).toMatchObject({ state: 'done', reason: 'technician_licensed' });
    // With no chemical add-on the same visit would have read "not required".
    const plain = (await reqs.resolveCloseoutRequirementsForJobs([job('sweep')], { knex: stub({ services: [{ ...sweep, id: 'sweep' }], addons: [] }), strict: true })).get(VISIT_ID);
    expect(deriveCloseoutFacts({ ...base, requirements: plain }).facts.license).toMatchObject({ state: 'not_required' });
  });

  test('a visit that needs two categories needs both: a household-pest primary with a lawn add-on', async () => {
    const knex = stub({ services: [{ ...pest, id: 'pest' }, bed], addons: [{ scheduled_service_id: VISIT_ID, service_key: 'area_addon_bed_pre_emergent' }] });
    const requirements = (await reqs.resolveCloseoutRequirementsForJobs([job('pest')], { knex, strict: true })).get(VISIT_ID);
    expect(requirements).toMatchObject({ licenseCategory: 'GHP', licenseCategories: ['GHP', 'L&O'] });
    const tech = (cats) => ({ id: 't', fl_applicator_license: 'JF1', license_expiry: '2099-01-01', license_categories: cats });
    const facts = (cats) => deriveCloseoutFacts({
      completed: true, requirements, technician: tech(cats), visit: { technician_id: 't', scheduled_date: '2026-10-08', status: 'completed' }, record: { id: 'r', status: 'completed', service_date: '2026-10-08' },
    }).facts.license;
    expect(facts(['General Household Pest'])).toMatchObject({ state: 'failed', reason: 'technician_license_category_mismatch', requiredCategories: ['ghp', 'lo'] });
    expect(facts(['General Household Pest', 'Lawn & Ornamental'])).toMatchObject({ state: 'done' });
    // The frozen snapshot keeps the list.
    const snap = reqs.buildCloseoutRequirementsSnapshot(requirements);
    expect(snap.licenseCategories).toEqual(['GHP', 'L&O']);
    expect(reqs.frozenCloseoutRequirements({ closeoutRequirements: snap }).licenseCategories).toEqual(['GHP', 'L&O']);
  });

  test('another add-on row (not an area add-on) is left alone: admin-built visits resolve as before', async () => {
    const knex = stub({ services: [{ ...sweep, id: 'sweep' }], addons: [{ scheduled_service_id: VISIT_ID, service_key: 'lawn_aeration' }] });
    const map = await reqs.resolveCloseoutRequirementsForJobs([job('sweep')], { knex, strict: true });
    expect(map.get(VISIT_ID).requiresLicense).toBe(false);
  });

  test('an unreadable add-on catalog row is "unavailable" for the strict reader, not a green', async () => {
    const knex = stub({ services: [{ ...sweep, id: 'sweep' }], addons: [{ scheduled_service_id: VISIT_ID, service_key: 'area_addon_bed_pre_emergent' }] });
    await expect(reqs.resolveCloseoutRequirementsForJobs([job('sweep')], { knex, strict: true })).rejects.toThrow(/catalog row/);
    const lenient = await reqs.resolveCloseoutRequirementsForJobs([job('sweep')], { knex, strict: false });
    expect(lenient.get(VISIT_ID).requiresLicense).toBe(false);
  });

  // The 20260831000080 backfill calls the live resolver with the synthetic id
  // 'combo'; a non-uuid in a uuid-column IN list is a Postgres cast error that
  // failed the whole migrate on CI.
  test('a synthetic job id (the closeout backfill migration) issues no add-on query', async () => {
    const knex = stub({ services: [{ ...sweep, id: 'sweep' }], addons: [] });
    const map = await reqs.resolveCloseoutRequirementsForJobs([{ id: 'combo', service_id: 'sweep', service_type: 'x' }], { knex, strict: true });
    expect(map.get('combo')).toMatchObject({ requiresLicense: false });
    expect(knex.queries.filter((t) => t.startsWith('scheduled_service_addons'))).toHaveLength(0);
  });

  test('a mix of a synthetic id and a real uuid queries the add-on rows for the uuid only', async () => {
    const seen = [];
    const base = stub({ services: [{ ...sweep, id: 'sweep' }, bed], addons: [{ scheduled_service_id: VISIT_ID, service_key: 'area_addon_bed_pre_emergent' }] });
    const knex = (table) => {
      const qb = base(table);
      const whereIn = qb.whereIn;
      qb.whereIn = (col, vals) => { if (table.startsWith('scheduled_service_addons')) seen.push(vals); return whereIn(col, vals); };
      return qb;
    };
    Object.assign(knex, base);
    const map = await reqs.resolveCloseoutRequirementsForJobs([
      { id: 'combo', service_id: 'sweep', service_type: 'x' }, job('sweep'),
    ], { knex, strict: true });
    expect(seen).toEqual([[VISIT_ID]]);
    expect(map.get(VISIT_ID)).toMatchObject({ requiresLicense: true, licenseCategory: 'L&O' });
    expect(map.get('combo')).toMatchObject({ requiresLicense: false });
  });

  test('an old migration that runs before the add-on column exists gets no add-on fold, not an error', async () => {
    jest.resetModules();
    const fresh = require('../services/service-closeout-requirements');
    const knex = stub({ services: [{ ...sweep, id: 'sweep' }], addons: [{ scheduled_service_id: VISIT_ID, service_key: 'area_addon_bed_pre_emergent' }] });
    knex.schema = { hasColumn: async () => false };
    const map = await fresh.resolveCloseoutRequirementsForJobs([job('sweep')], { knex, strict: true });
    expect(map.get(VISIT_ID)).toMatchObject({ requiresLicense: false });
    expect(knex.queries.filter((t) => t.startsWith('scheduled_service_addons'))).toHaveLength(0);
  });
});

describe('completion route: an area add-on is generic work whatever its name says', () => {
  const NAMES = Object.values(AREA_ADDONS.items).map((cfg) => [cfg.name, cfg.serviceKey, cfg.category]);

  test.each(NAMES)('%s (%s) is an area add-on catalog key', (_name, serviceKey) => {
    expect(isAreaAddOnCatalogKey(serviceKey)).toBe(true);
  });
  test('no other key is, including look-alikes', () => {
    for (const key of ['lawn_care_recurring', 'fire_ant', 'area_addon', 'area_addon_', 'area_addon_nope', 'one_time_lawn', null, undefined, 7]) {
      expect(isAreaAddOnCatalogKey(key)).toBe(false);
    }
  });

  test.each(NAMES)('%s never takes the lawn fast-complete sheet or the pest recap', async (_name, serviceKey, category) => {
    const { lawnFastIneligibleReason } = require('../services/lawn-fast-complete');
    const profile = { serviceKey, category, findingsType: null, companions: [], projectBacked: false, requiresProject: false };
    // The lawn rule: the five lawn-care add-ons are refused as not a lawn visit; the sweep never was one.
    expect(lawnFastIneligibleReason({ svc: { status: 'pending' }, profile })).toBe('not_lawn');
    // The same profile under an ordinary lawn key stays eligible (the rule only excludes add-ons).
    if (category === 'lawn_care') {
      expect(lawnFastIneligibleReason({ svc: { status: 'pending' }, profile: { ...profile, serviceKey: 'lawn_care_recurring' } })).toBeNull();
    }
  });

  test('the pest recap is not offered for the web sweep (pest control by family) but is for an ordinary pest visit', () => {
    const { recapEligibleProfile } = require('../services/pest-recap');
    const profile = (serviceKey, over = {}) => ({ serviceKey, category: 'pest_control', findingsType: null, projectBacked: false, requiresProject: false, ...over });
    expect(recapEligibleProfile(profile('area_addon_web_sweep'))).toBe(false);
    expect(recapEligibleProfile(profile('pest_general_quarterly'))).toBe(true);
    expect(recapEligibleProfile(profile('pest_general_quarterly', { findingsType: 'cockroach' }))).toBe(false);
  });
});


describe('an attached area add-on row keeps the lightweight completion flows off (Codex r6 P1)', () => {
  const { lawnFastIneligibleReason } = require('../services/lawn-fast-complete');
  const rows = require('../services/area-addon-visit-rows');
  const VISIT = '7c1b0a5e-2f3d-4a6b-9c8d-0e1f2a3b4c5d';
  const lawnProfile = { serviceKey: 'lawn_care_recurring', category: 'lawn_care', companions: [] };

  test('the lawn sheet refuses a lawn visit that carries an add-on row, and still accepts one that does not', () => {
    const svc = { id: VISIT, status: 'confirmed' };
    expect(lawnFastIneligibleReason({ svc, profile: lawnProfile })).toBeNull();
    expect(lawnFastIneligibleReason({ svc, profile: lawnProfile, hasAreaAddOnRows: true })).toBe('area_addon_attached');
  });

  test('areaAddOnKeysByVisit is one batched read of uuids only, and a visit without rows is absent', async () => {
    const seen = [];
    const knex = (table) => {
      const qb = { leftJoin: () => qb, whereRaw: () => qb, select: () => qb, whereIn: (_c, ids) => { seen.push([table, ids]); return qb; },
        then: (res, rej) => Promise.resolve([
          { scheduled_service_id: VISIT, service_key: 'area_addon_bed_pre_emergent' },
          { scheduled_service_id: VISIT, service_key_snapshot: 'area_addon_web_sweep', service_key: 'lawn_care' },
          { scheduled_service_id: VISIT, service_key: 'area_addon_web_sweep' },
          { scheduled_service_id: VISIT, service_key: 'dethatching' },
        ]).then(res, rej) };
      return qb;
    };
    knex.raw = (sql) => sql;
    const map = await rows.areaAddOnKeysByVisit(knex, [VISIT, 'combo', null, VISIT]);
    expect(seen).toEqual([['scheduled_service_addons as a', [VISIT]]]);
    expect(map.get(VISIT)).toEqual(['area_addon_bed_pre_emergent', 'area_addon_web_sweep']);
    seen.length = 0;
    expect((await rows.areaAddOnKeysByVisit(knex, ['combo'])).size).toBe(0);
    expect(seen).toEqual([]);
  });
});

describe('resolveEligibility reads the attached add-on rows (Codex r6 P1)', () => {
  const VISIT = '7c1b0a5e-2f3d-4a6b-9c8d-0e1f2a3b4c5d';
  function load(addOnRows) {
    jest.resetModules();
    jest.doMock('../models/db', () => jest.fn());
    jest.doMock('../services/service-completion-profiles', () => ({
      ...jest.requireActual('../services/service-completion-profiles'),
      resolveCompletionProfileForScheduledService: async () => ({ serviceKey: 'pest_general_quarterly', category: 'pest_control', findingsType: null, companions: [] }),
    }));
    const recap = require('../services/pest-recap');
    const knex = (table) => {
      const qb = { where: () => qb, leftJoin: () => qb, whereRaw: () => qb, whereIn: () => qb, select: () => qb,
        first: async () => ({ id: VISIT, status: 'confirmed' }),
        then: (res, rej) => (addOnRows instanceof Error ? Promise.reject(addOnRows) : Promise.resolve(addOnRows)).then(res, rej) };
      return qb;
    };
    knex.raw = (sql) => sql;
    return { recap, knex };
  }

  test('a pest visit with no add-on row is eligible; with one it is not (the generic form records the add-on)', async () => {
    const plain = load([]);
    expect(await plain.recap.resolveEligibility(VISIT, plain.knex)).toMatchObject({ ok: true, eligible: true, hasAreaAddOnRows: false });
    const withRow = load([{ scheduled_service_id: VISIT, service_key: 'area_addon_bed_pre_emergent' }]);
    expect(await withRow.recap.resolveEligibility(VISIT, withRow.knex)).toMatchObject({ ok: true, eligible: false, hasAreaAddOnRows: true });
  });

  test('a failed row read is "has rows" (the full form), never an eligible verdict', async () => {
    const failing = load(new Error('connection lost'));
    expect(await failing.recap.resolveEligibility(VISIT, failing.knex)).toMatchObject({ ok: true, eligible: false, hasAreaAddOnRows: true });
  });
});
