/**
 * Codex round 18 P1 on #6135: a staff booking's posted lines against the LOCKED estimate. The Create Appointment modal builds its
 * request from the estimate as it read it; an estimate revision that adds or removes an area add-on before the booking
 * transaction's FOR SHARE read used to book the stale posted set (a removed add-on booked and billed without a scope, an added one
 * missing). Now the posted add-ons are judged on the locked row inside the transaction, before anything is inserted: one the
 * estimate does not sell, or sells at another price, is refused; fewer than sold stays the office's choice. The Update Details save
 * judges what it ADDS the same way, and a repeating series never carries an area add-on.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { generateEstimate } = require('../services/pricing-engine');
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const rows = require('../services/area-addon-visit-rows');
const router = require('../routes/admin-schedule');

const { postedAreaAddOnLines, assertAreaAddOnEdit, lineDueOnRecurringDate, addonRecursAfterAnchor } = router._test;
const WEB = 'area_addon_web_sweep';
const BED = 'area_addon_bed_pre_emergent';
const FIRE = 'area_addon_fire_ant_yard';
const VISIT = '33333333-3333-4333-8333-333333333333';

// The describe bodies price estimates while the suite is collected, so the gate is on before they run.
const savedGate = process.env.GATE_AREA_ADDONS;
process.env.GATE_AREA_ADDONS = 'true';
afterAll(() => { if (savedGate === undefined) delete process.env.GATE_AREA_ADDONS; else process.env.GATE_AREA_ADDONS = savedGate; });

// The estimate row an engine-priced one-time mix leaves: the same path the slot profile reads.
function estimateSelling(areaAddOns) {
  const v1Input = translateV2CallToV1Input({ homeSqFt: 2000, lotSqFt: 7500 }, [], { grassType: 'A', areaAddOns });
  const mapped = mapV1ToLegacyShape(generateEstimate(v1Input));
  const total = mapped.oneTime.items.reduce((sum, item) => sum + item.price, 0);
  return { id: 'est-1', pricing_authority: null, estimate_data: { result: { oneTime: { total, items: mapped.oneTime.items } } }, prices: Object.fromEntries(mapped.oneTime.items.map((i) => [i.catalogServiceKey, i.price])) };
}
const refused = (code) => expect.objectContaining({ status: 409, statusCode: 409, isOperational: true, code });

describe('assertPostedAreaAddOnsSold: the posted add-ons against the locked estimate', () => {
  const both = estimateSelling([{ key: 'web_sweep' }, { key: 'bed_pre_emergent', areaSqFt: 1000 }]);

  test('the posted set equals what was sold, at the sold prices: allowed (the first add-on is the visit\'s own service)', () => {
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: WEB }, { key: BED, price: both.prices[BED] }])).not.toThrow();
  });

  test('fewer than sold is the office\'s choice (round 9): a sold add-on left out is allowed', () => {
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: BED, price: both.prices[BED] }])).not.toThrow();
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: 'pest_control' }])).not.toThrow();
  });

  test('an add-on the revised estimate no longer sells is refused with the staff message, whether it is the visit\'s own service or a line', () => {
    const revised = estimateSelling([{ key: 'web_sweep' }]);
    const message = 'Bed Pre-Emergent Weed Control is not sold on the linked estimate any more. The estimate changed after this appointment was built: reopen the estimate and build the appointment again.';
    expect(() => rows.assertPostedAreaAddOnsSold(revised, [{ key: WEB }, { key: BED, price: both.prices[BED] }])).toThrow(expect.objectContaining({ code: 'AREA_ADDON_NOT_ON_ESTIMATE', message }));
    expect(() => rows.assertPostedAreaAddOnsSold(revised, [{ key: BED }])).toThrow(refused('AREA_ADDON_NOT_ON_ESTIMATE'));
  });

  test('an estimate revised to sell no add-on at all refuses every posted one', () => {
    const none = { id: 'est-2', estimate_data: { result: { oneTime: { total: 150, items: [{ service: 'one_time_pest', name: 'One-Time Pest Control', price: 150 }] } } } };
    expect(() => rows.assertPostedAreaAddOnsSold(none, [{ key: 'one_time_pest' }, { key: WEB, price: 59 }])).toThrow(refused('AREA_ADDON_NOT_ON_ESTIMATE'));
  });

  test('a stale price is refused: the sold price must equal the posted gross price', () => {
    const message = 'The price of Bed Pre-Emergent Weed Control on the estimate changed after this appointment was built: reopen the estimate and build the appointment again.';
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: BED, price: both.prices[BED] + 10 }])).toThrow(expect.objectContaining({ code: 'AREA_ADDON_PRICE_CHANGED', message }));
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: BED, price: null }])).toThrow(refused('AREA_ADDON_PRICE_CHANGED'));
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: BED, price: String(both.prices[BED]) }])).not.toThrow();
  });

  test('no estimate at all: an area add-on is priced and limited from an estimate, so a hand-made line is refused', () => {
    const message = 'Web Sweep is priced and limited from an estimate. Build an estimate that sells it, then book from that estimate.';
    expect(() => rows.assertPostedAreaAddOnsSold(null, [{ key: WEB, price: 89 }])).toThrow(expect.objectContaining({ code: 'AREA_ADDON_NEEDS_ESTIMATE', message }));
  });

  test('a booking with no area add-on line costs nothing: no estimate needed, nothing read', () => {
    expect(() => rows.assertPostedAreaAddOnsSold(null, [{ key: 'pest_control' }, { key: null }, { key: 'mosquito_one_time', price: 80 }])).not.toThrow();
    expect(() => rows.assertPostedAreaAddOnsSold(undefined, [])).not.toThrow();
  });

  test('a repeating series never carries one (own service or line)', () => {
    const message = 'Web Sweep is a one-time application. Book it as its own appointment, not in a repeating series.';
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: WEB }], { recurring: true })).toThrow(expect.objectContaining({ code: 'AREA_ADDON_ONE_TIME_ONLY', message }));
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: 'pest_control' }, { key: BED }], { recurring: true })).toThrow(refused('AREA_ADDON_ONE_TIME_ONLY'));
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: 'pest_control' }], { recurring: true })).not.toThrow();
  });
});

describe('the staff booking transaction asks it of the locked row, before anything is inserted', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');

  test('the posted lines are the visit\'s own service and each add-on line with its gross price', () => {
    expect(postedAreaAddOnLines({ primaryServiceKey: WEB, addonLines: [{ serviceKey: BED, base: 99, price: 89 }, { serviceKey: null, base: null }] }))
      .toEqual([{ key: WEB, price: null }, { key: BED, price: 99 }, { key: null, price: null }]);
    // Codex round 20: the visit's own service carries its gross price too, so a primary add-on at a stale price is refused.
    expect(postedAreaAddOnLines({ primaryServiceKey: WEB, primaryBase: 89, addonLines: [] })).toEqual([{ key: WEB, price: 89 }]);
  });

  test('source order: the locked read, then the guard, then the first insert; the locked row carries pricing_authority', () => {
    const call = "assertPostedAreaAddOnsSold(lockedLinkedEstimate, postedAreaAddOnLines(pricing), { recurring: isRecurring });";
    expect(src).toContain(call);
    expect(src.indexOf('lockedLinkedEstimate = freshLinkedEstimate;')).toBeLessThan(src.indexOf(call));
    expect(src.indexOf(call)).toBeLessThan(src.indexOf('[svc] = await trx(\'scheduled_services\').insert(adminCreateInsert).returning(\'*\');'));
    expect(src.indexOf(call)).toBeLessThan(src.indexOf('await insertScheduledServiceAddons(trx, svc.id, pricing.addonLines, addonCols);'));
    expect(router._test.LINKED_ESTIMATE_COLUMNS).toContain('pricing_authority');
  });
});

describe('a repeating series skips an area add-on after the anchor (every copy path goes through these two readers)', () => {
  const base = '2026-11-02';
  const later = '2026-12-07';
  test.each([[WEB], [BED], [FIRE]])('%s: due on the anchor only, whatever its stored pattern holds', (serviceKey) => {
    for (const recurringPattern of [null, undefined, 'monthly']) {
      expect(lineDueOnRecurringDate({ serviceKey, recurringPattern }, base, later)).toBe(false);
      expect(lineDueOnRecurringDate({ service_key_snapshot: serviceKey, recurring_pattern: recurringPattern }, base, later)).toBe(false);
      expect(lineDueOnRecurringDate({ serviceKey, recurringPattern }, base, base)).toBe(true);
    }
    expect(addonRecursAfterAnchor({ serviceKey })).toBe(false);
  });

  test('any other add-on keeps its rule: a NULL pattern rides every occurrence', () => {
    expect(lineDueOnRecurringDate({ serviceKey: 'mosquito_one_time', recurringPattern: null }, base, later)).toBe(true);
    expect(addonRecursAfterAnchor({ serviceKey: 'mosquito_one_time' })).toBe(true);
    expect(lineDueOnRecurringDate({ serviceKey: 'waveguard_membership' }, base, later)).toBe(false);
  });
});

// A tiny trx: the visit row, its add-on rows (the joined read areaAddOnKeysByVisit makes) and the source estimate.
function fakeTrx({ visit, rowKeys = [], estimate = null, calls = [] }) {
  const chain = (result) => {
    const q = {};
    for (const m of ['where', 'leftJoin', 'whereIn', 'select']) q[m] = () => q;
    q.first = async () => result;
    q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
    return q;
  };
  return (table) => {
    calls.push(table);
    if (table === 'scheduled_services') return chain(visit);
    if (table.startsWith('scheduled_service_addons')) return chain(rowKeys.map((key) => ({ scheduled_service_id: VISIT, service_key_snapshot: key, service_key: key })));
    if (table === 'estimates') return chain(estimate);
    throw new Error(`unexpected table ${table}`);
  };
}

describe('Update Details: what the edit adds', () => {
  const sold = estimateSelling([{ key: 'web_sweep' }]);
  const visit = (over = {}) => ({ id: VISIT, service_key_snapshot: 'pest_control', is_recurring: false, recurring_parent_id: null, source_estimate_id: 'est-1', ...over });
  const edit = (trxArgs, args) => rows.assertEditedAreaAddOns(fakeTrx(trxArgs), VISIT, args);

  test('a visit with no area add-on before or after the edit: no estimate read', async () => {
    const calls = [];
    await expect(edit({ visit: visit(), calls }, { updates: {}, rowKeys: ['mosquito_one_time'] })).resolves.toEqual({ keys: [], added: [] });
    expect(calls).not.toContain('estimates');
  });

  test('adding an add-on the source estimate sells is allowed; one it does not sell is refused, and so is one on a visit with no estimate', async () => {
    await expect(edit({ visit: visit(), estimate: sold }, { updates: {}, rowKeys: [WEB] })).resolves.toEqual({ keys: [WEB], added: [WEB] });
    await expect(edit({ visit: visit(), estimate: sold }, { updates: {}, rowKeys: [BED] })).rejects.toMatchObject({ code: 'AREA_ADDON_NOT_ON_ESTIMATE' });
    await expect(edit({ visit: visit({ source_estimate_id: null }) }, { updates: {}, rowKeys: [WEB] })).rejects.toMatchObject({ code: 'AREA_ADDON_NEEDS_ESTIMATE' });
  });

  test('moving the visit\'s own service to an area add-on counts as adding it', async () => {
    await expect(edit({ visit: visit(), estimate: sold }, { updates: { service_key_snapshot: BED }, rowKeys: null })).rejects.toMatchObject({ code: 'AREA_ADDON_NOT_ON_ESTIMATE' });
  });

  test('what the visit already carries is kept: re-saving the same rows reads no estimate', async () => {
    const calls = [];
    await expect(edit({ visit: visit(), rowKeys: [WEB], calls }, { updates: {}, rowKeys: [WEB] })).resolves.toEqual({ keys: [WEB], added: [] });
    await expect(edit({ visit: visit(), rowKeys: [WEB], calls }, { updates: { notes: 'x' }, rowKeys: null })).resolves.toEqual({ keys: [WEB], added: [] });
    expect(calls).not.toContain('estimates');
  });

  test('a repeating series never carries one: making the visit recurring, or adding to a series visit, is refused', async () => {
    await expect(edit({ visit: visit(), rowKeys: [WEB] }, { updates: { is_recurring: true }, rowKeys: null })).rejects.toMatchObject({ code: 'AREA_ADDON_ONE_TIME_ONLY' });
    await expect(edit({ visit: visit({ is_recurring: true }), estimate: sold }, { updates: {}, rowKeys: [WEB] })).rejects.toMatchObject({ code: 'AREA_ADDON_ONE_TIME_ONLY' });
    await expect(edit({ visit: visit({ recurring_parent_id: 'p-1' }), rowKeys: [WEB] }, { updates: {}, rowKeys: [WEB] })).resolves.toEqual({ keys: [WEB], added: [] });
  });

  test('the route helper runs both guards and rechecks the limits only for a visit that carries an area add-on', async () => {
    expect(typeof assertAreaAddOnEdit).toBe('function');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const call = 'await assertAreaAddOnEdit(trx, req.params.id, { updates, replaceAddons, addressPlan });';
    expect(src).toContain(call);
    // before the visit row is written, so the guards still see what the visit carries now
    expect(src.indexOf(call)).toBeLessThan(src.indexOf('await trx(\'scheduled_services\').where({ id: req.params.id }).update(updates);'));
  });
});
