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
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: WEB, price: both.prices[WEB] }])).not.toThrow();
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: 'pest_control' }])).not.toThrow();
  });

  // Codex round 28: the first priced add-on carries the visit's one drive and booking cost; the others are priced without it.
  test('the add-on that carries the visit cost must stay when another sold add-on is booked', () => {
    const message = 'Web Sweep carries the visit\'s drive and booking cost on the estimate, so the other add-on treatments are priced without it. Keep Web Sweep on this appointment, or build a new estimate for the add-on treatments you want to book.';
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: BED, price: both.prices[BED] }])).toThrow(expect.objectContaining({ status: 409, code: 'AREA_ADDON_CARRIER_REQUIRED', message }));
    // an edit that adds one add-on to a visit judges only what it adds
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: BED }], { wholeVisit: false })).not.toThrow();
  });

  // Codex round 41: a same-visit add-on is priced with no drive; it cannot become a visit of its own.
  describe('an add-on sold for the same visit as a host service', () => {
    const sameVisit = {
      id: 'est-3', pricing_authority: null,
      estimate_data: { result: { oneTime: { total: 209, items: [
        { service: 'one_time_pest', name: 'One-Time Pest Control', price: 150 },
        { service: 'area_addon', addOnKey: 'web_sweep', catalogServiceKey: WEB, name: 'Web Sweep', price: 59, visitContext: 'sameTripAddOn', carriesJobAdmin: true },
      ] } } },
    };
    const message = 'Web Sweep was sold as a same-visit add-on, priced without a trip of its own. Keep the main service on this appointment, or build a new estimate that sells it as its own visit.';
    test('booked with its host: allowed; booked alone: refused', () => {
      expect(() => rows.assertPostedAreaAddOnsSold(sameVisit, [{ key: 'one_time_pest', price: 150 }, { key: WEB, price: 59 }])).not.toThrow();
      expect(() => rows.assertPostedAreaAddOnsSold(sameVisit, [{ key: WEB, price: 59 }])).toThrow(expect.objectContaining({ status: 409, code: 'AREA_ADDON_HOST_REQUIRED', message }));
    });
    // Codex round 50: the engine's own non-host list (fees, riders, agreements) is not a host here either.
    test('a fee or agreement line is not a host: a same-visit add-on beside only that is refused', () => {
      for (const key of ['rodent_bait_setup', 'termite_bond', 'termite_station_rental', 'trap_only_retainer', 'waveguard_setup']) {
        expect(() => rows.assertPostedAreaAddOnsSold(sameVisit, [{ key, price: 50 }, { key: WEB, price: 59 }])).toThrow(expect.objectContaining({ code: 'AREA_ADDON_HOST_REQUIRED' }));
      }
      expect(() => rows.assertPostedAreaAddOnsSold(sameVisit, [{ key: 'pest_initial_roach', price: 150 }, { key: WEB, price: 59 }])).not.toThrow();
    });

    test('an add-on sold for its own visit is booked alone as before', () => {
      expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: WEB, price: both.prices[WEB] }])).not.toThrow();
    });
    test('Update Details: moving the visit\'s own service to the same-visit add-on is refused; keeping the host is allowed', async () => {
      const trxFor = (v) => { const fake = (table) => { const q = {}; for (const m of ['where', 'leftJoin', 'whereIn', 'select', 'forShare']) q[m] = () => q;
        const result = table === 'scheduled_services' ? v : (table === 'estimates' ? sameVisit : (table.startsWith('scheduled_service_addons') ? [{ scheduled_service_id: VISIT, service_key_snapshot: WEB, service_key: WEB, base_price: 59, estimated_price: 59 }] : null));
        q.first = async () => result; q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject); return q; }; return fake; };
      const hosted = { id: VISIT, service_key_snapshot: 'one_time_pest', is_recurring: false, recurring_parent_id: null, source_estimate_id: 'est-3', primary_line_price: 150 };
      await expect(rows.assertEditedAreaAddOns(trxFor(hosted), VISIT, { updates: {}, rowLines: [{ key: WEB, price: 59 }] })).resolves.toEqual({ keys: [WEB], added: [] });
      await expect(rows.assertEditedAreaAddOns(trxFor(hosted), VISIT, { updates: { service_key_snapshot: WEB, primary_line_price: 59 }, rowLines: [] }))
        .rejects.toMatchObject({ code: 'AREA_ADDON_HOST_REQUIRED' });
      // the host replaced by a fee line that has no visit of its own
      await expect(rows.assertEditedAreaAddOns(trxFor(hosted), VISIT, { updates: { service_key_snapshot: 'rodent_bait_setup' }, rowLines: [{ key: WEB, price: 59 }] }))
        .rejects.toMatchObject({ code: 'AREA_ADDON_HOST_REQUIRED' });
    });
  });

  // Codex round 52: the gross can equal the estimate while a line discount bills less.
  test('a discounted add-on line is refused, at booking and when Update Details keeps or adds it; a discount on another service is not its concern', () => {
    const message = 'Web Sweep is priced by its estimate and is never discounted. Remove the discount from its line.';
    const off = { discountType: 'fixed', discountAmount: 10, discountDollars: 10 };
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: WEB, price: both.prices[WEB], discount: off }])).toThrow(expect.objectContaining({ status: 409, code: 'AREA_ADDON_NO_DISCOUNT', message }));
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: 'one_time_pest', price: 150, discount: off }, { key: WEB, price: both.prices[WEB] }])).not.toThrow();
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: WEB, price: both.prices[WEB], discount: { discountDollars: 0, discountAmount: 0 } }])).not.toThrow();
  });

  // Codex round 55 (security): an appointment-wide discount must not reach an add-on.
  describe('an appointment-wide discount', () => {
    const message = 'Web Sweep is priced by its estimate and is never discounted. The discount on this appointment reaches it: remove the discount, or limit it to the other service.';
    const web = () => ({ key: WEB, price: both.prices[WEB] });
    test('an add-on-only visit with an appointment discount is refused (the reported $89 credit on an $89 Web Sweep)', () => {
      expect(() => rows.assertPostedAreaAddOnsSold(both, [web()], { totals: { finalPrice: 0, appointmentDiscountDollars: both.prices[WEB] } }))
        .toThrow(expect.objectContaining({ status: 409, code: 'AREA_ADDON_NO_DISCOUNT', message }));
    });
    test('a share of it allocated to the add-on line is refused; a discount the host bears alone is allowed', () => {
      const host = { key: 'one_time_pest', price: 150 };
      expect(() => rows.assertPostedAreaAddOnsSold(both, [host, { ...web(), credit: 5 }], { totals: { finalPrice: 150 + both.prices[WEB] - 20, appointmentDiscountDollars: 20 } }))
        .toThrow(expect.objectContaining({ code: 'AREA_ADDON_NO_DISCOUNT' }));
      expect(() => rows.assertPostedAreaAddOnsSold(both, [host, web()], { totals: { finalPrice: 150 + both.prices[WEB] - 20, appointmentDiscountDollars: 20 } })).not.toThrow();
      // larger than the host: it would eat into the add-on
      expect(() => rows.assertPostedAreaAddOnsSold(both, [host, web()], { totals: { finalPrice: both.prices[WEB] - 10, appointmentDiscountDollars: 160 } }))
        .toThrow(expect.objectContaining({ code: 'AREA_ADDON_NO_DISCOUNT' }));
    });
    test('a share allocated to a PRIMARY add-on line is refused too', () => {
      expect(() => rows.assertPostedAreaAddOnsSold(both, [{ ...web(), credit: 6 }, { key: 'one_time_pest', price: 400 }], { totals: { finalPrice: 400 + both.prices[WEB] - 20, appointmentDiscountDollars: 20 } }))
        .toThrow(expect.objectContaining({ code: 'AREA_ADDON_NO_DISCOUNT' }));
    });
    test('no appointment discount: nothing is judged; the route hands the totals over (source)', () => {
      expect(() => rows.assertPostedAreaAddOnsSold(both, [web()], { totals: { finalPrice: 0, appointmentDiscountDollars: 0 } })).not.toThrow();
      expect(router._test.postedAreaAddOnTotals({ finalPrice: 59, appointmentDiscount: { discountDollars: 30 } })).toEqual({ finalPrice: 59, appointmentDiscountDollars: 30 });
      expect(router._test.postedAreaAddOnTotals({ finalPrice: 59, appointmentDiscount: null })).toEqual({ finalPrice: 59, appointmentDiscountDollars: 0 });
    });
  });

  // Codex round 28: one estimate sells one application of an add-on.
  test('the same add-on twice (two lines, or the visit\'s own service and a line) is refused', () => {
    const message = 'Bed Pre-Emergent Weed Control is on this appointment more than once. An estimate sells one application: remove the extra line.';
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: WEB }, { key: BED, price: both.prices[BED] }, { key: BED, price: both.prices[BED] }])).toThrow(expect.objectContaining({ status: 409, code: 'AREA_ADDON_DUPLICATE', message }));
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: WEB, price: both.prices[WEB] }, { key: WEB, price: both.prices[WEB] }])).toThrow(refused('AREA_ADDON_DUPLICATE'));
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
    expect(() => rows.assertPostedAreaAddOnsSold(both, [{ key: WEB }, { key: BED, price: String(both.prices[BED]) }])).not.toThrow();
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

// Codex round 39: the preflight limit check judges only the add-ons the request posts.
describe('the posted service keys of a booking request (the limit preflight)', () => {
  const { requestedAreaAddOnServiceKeys } = router._test;
  const ID_A = '10000000-0000-4000-8000-0000000000a1';
  const ID_B = '10000000-0000-4000-8000-0000000000b2';
  const catalog = (rowsById) => () => ({ whereIn: (_col, ids) => ({ select: async () => ids.map((id) => ({ service_key: rowsById[id] })) }) });
  test('the request\'s own service and its add-on lines, by catalog id and by key', async () => {
    const database = catalog({ [ID_A]: 'one_time_pest', [ID_B]: WEB });
    await expect(requestedAreaAddOnServiceKeys(database, ID_A, [{ serviceId: ID_B }, { serviceKey: ' Area_Addon_Bed_Pre_Emergent ' }, null]))
      .resolves.toEqual([BED, 'one_time_pest', WEB]);
    await expect(requestedAreaAddOnServiceKeys(database, null, undefined)).resolves.toEqual([]);
  });
  test('a failed catalog read judges every sold add-on (null)', async () => {
    const broken = () => ({ whereIn: () => ({ select: async () => { throw new Error('down'); } }) });
    await expect(requestedAreaAddOnServiceKeys(broken, ID_A, [])).resolves.toBeNull();
  });
});

describe('the staff booking transaction asks it of the locked row, before anything is inserted', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');

  test('the posted lines are the visit\'s own service and each add-on line with its gross price', () => {
    expect(postedAreaAddOnLines({ primaryServiceKey: WEB, addonLines: [{ serviceKey: BED, base: 99, price: 89 }, { serviceKey: null, base: null }] }))
      .toEqual([{ key: WEB, price: null, discount: undefined, credit: undefined }, { key: BED, price: 99, discount: undefined, credit: undefined }, { key: null, price: null, discount: undefined, credit: undefined }]);
    // Codex round 20: the visit's own service carries its gross price too, so a primary add-on at a stale price is refused.
    expect(postedAreaAddOnLines({ primaryServiceKey: WEB, primaryBase: 89, addonLines: [] })).toEqual([{ key: WEB, price: 89, discount: undefined, credit: undefined }]);
    // Codex round 59: the primary line's share of an appointment discount rides along too.
    expect(postedAreaAddOnLines({ primaryServiceKey: WEB, primaryBase: 89, primaryAppointmentCreditDollars: 12, addonLines: [] })).toEqual([{ key: WEB, price: 89, discount: undefined, credit: 12 }]);
    // Codex round 52: each line's own discount rides along, so the guard can refuse a discounted add-on.
    const lineDiscount = { discountType: 'fixed', discountAmount: 10, discountDollars: 10 };
    expect(postedAreaAddOnLines({ primaryServiceKey: 'one_time_pest', primaryBase: 150, primaryDiscount: lineDiscount, addonLines: [{ serviceKey: WEB, base: 59, price: 49, discount: lineDiscount }] }))
      .toEqual([{ key: 'one_time_pest', price: 150, discount: lineDiscount, credit: undefined }, { key: WEB, price: 59, discount: lineDiscount, credit: undefined }]);
  });

  test('source order: the locked read, then the guard, then the first insert; the locked row carries pricing_authority', () => {
    const body = (name) => { const at = src.indexOf(`async function ${name}(`); return src.slice(at, src.indexOf('\n}\n', at)); };
    const call = 'assertPostedAreaAddOnsSold(c.lockedLinkedEstimate, postedAreaAddOnLines(pricing), { recurring: isRecurring, totals: postedAreaAddOnTotals(pricing) });';
    // The transaction runs lockBookingScope (the locked read, then the guard), then insertSeriesRows (the first insert).
    const lock = body('lockBookingScope');
    expect(body('revalidateBookingUnderLock')).toContain('lockedLinkedEstimate = freshLinkedEstimate;');
    expect(lock).toContain(call);
    expect(lock.indexOf('c.lockedLinkedEstimate = await revalidateBookingUnderLock(')).toBeLessThan(lock.indexOf(call));
    expect(lock.indexOf(call)).toBeLessThan(lock.indexOf('runApprovedBookingRails('));
    const commit = body('commitBooking');
    expect(commit.indexOf('await lockBookingScope(trx, c);')).toBeLessThan(commit.indexOf('await insertSeriesRows(trx, c);'));
    const parent = body('insertParentRow');
    expect(parent).toContain("[svc] = await trx('scheduled_services').insert(adminCreateInsert).returning('*');");
    expect(parent.indexOf("[svc] = await trx('scheduled_services')")).toBeLessThan(parent.indexOf('await insertScheduledServiceAddons(trx, svc.id, pricing.addonLines, addonCols);'));
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
function fakeTrx({ visit, rowKeys = [], rowPrices = {}, estimate = null, calls = [] }) {
  const chain = (result) => {
    const q = {};
    for (const m of ['where', 'leftJoin', 'whereIn', 'select']) q[m] = () => q;
    q.forShare = () => { calls.push('estimates FOR SHARE'); return q; };
    // The "already booked from this estimate" reads (assertAreaAddOnsNotYetBooked): none in these fixtures.
    for (const m of ['join', 'whereNotIn', 'whereNot']) q[m] = () => chain([]);
    q.first = async () => result;
    q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
    return q;
  };
  return (table) => {
    calls.push(table);
    if (table === 'scheduled_services') return chain(visit);
    if (table === 'scheduled_services as s') return chain([]);
    if (table.startsWith('scheduled_service_addons')) return chain(rowKeys.map((key) => ({ scheduled_service_id: VISIT, service_key_snapshot: key, service_key: key, base_price: rowPrices[key] ?? null, estimated_price: rowPrices[key] ?? null })));
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

  test('what the visit already carries is kept; a save that does not touch the rows or the service reads no estimate', async () => {
    const calls = [];
    await expect(edit({ visit: visit(), rowKeys: [WEB], calls }, { updates: { notes: 'x' }, rowKeys: null })).resolves.toEqual({ keys: [WEB], added: [] });
    expect(calls).not.toContain('estimates');
    await expect(edit({ visit: visit(), rowKeys: [WEB], estimate: sold, calls }, { updates: {}, rowKeys: [WEB] })).resolves.toEqual({ keys: [WEB], added: [] });
    // Codex round 29: a save that replaces the rows reads the source estimate FOR SHARE (held to the end of the save).
    expect(calls).toContain('estimates FOR SHARE');
  });

  // Codex round 29: the posted gross prices are judged too.
  describe('prices, the cost carrier and repeats on an edit', () => {
    const both = estimateSelling([{ key: 'web_sweep' }, { key: 'bed_pre_emergent', areaSqFt: 1000 }]);
    test('an added add-on must carry the estimate\'s price', async () => {
      await expect(edit({ visit: visit(), rowKeys: [WEB], rowPrices: { [WEB]: both.prices[WEB] }, estimate: both }, { updates: {}, rowLines: [{ key: WEB, price: both.prices[WEB] }, { key: BED, price: both.prices[BED] }] }))
        .resolves.toEqual({ keys: [WEB, BED], added: [BED] });
      await expect(edit({ visit: visit(), rowKeys: [WEB], rowPrices: { [WEB]: both.prices[WEB] }, estimate: both }, { updates: {}, rowLines: [{ key: WEB, price: both.prices[WEB] }, { key: BED, price: 5 }] }))
        .rejects.toMatchObject({ code: 'AREA_ADDON_PRICE_CHANGED' });
    });
    test('a kept add-on row cannot be discounted by hand', async () => {
      await expect(edit({ visit: visit(), rowKeys: [WEB], rowPrices: { [WEB]: both.prices[WEB] }, estimate: both }, { updates: {}, rowLines: [{ key: WEB, price: both.prices[WEB], discount: { discountDollars: 5 } }] }))
        .rejects.toMatchObject({ status: 409, code: 'AREA_ADDON_NO_DISCOUNT' });
    });
    test('a kept add-on row cannot be repriced by hand', async () => {
      const message = 'Web Sweep is priced by its estimate, so its price cannot be changed on the appointment. To change it, revise the estimate and book again from it.';
      await expect(edit({ visit: visit(), rowKeys: [WEB], rowPrices: { [WEB]: both.prices[WEB] }, estimate: both }, { updates: {}, rowLines: [{ key: WEB, price: 1 }] }))
        .rejects.toMatchObject({ status: 409, code: 'AREA_ADDON_PRICE_LOCKED', message });
    });
    // Codex round 32: a cleared Price field posts null; the row would be saved unpriced.
    test('a kept add-on row with a blank price is refused; keys alone (no price posted) are not judged', async () => {
      await expect(edit({ visit: visit(), rowKeys: [WEB], rowPrices: { [WEB]: both.prices[WEB] }, estimate: both }, { updates: {}, rowLines: [{ key: WEB, price: null }] }))
        .rejects.toMatchObject({ code: 'AREA_ADDON_PRICE_LOCKED' });
      await expect(edit({ visit: visit(), rowKeys: [WEB], rowPrices: { [WEB]: both.prices[WEB] }, estimate: both }, { updates: {}, rowKeys: [WEB] })).resolves.toEqual({ keys: [WEB], added: [] });
    });

    test('removing the add-on that carries the visit cost while another sold add-on stays is refused; removing the other one is allowed', async () => {
      const carried = { visit: visit(), rowKeys: [WEB, BED], rowPrices: both.prices, estimate: both };
      await expect(edit(carried, { updates: {}, rowLines: [{ key: BED, price: both.prices[BED] }] })).rejects.toMatchObject({ code: 'AREA_ADDON_CARRIER_REQUIRED' });
      await expect(edit(carried, { updates: {}, rowLines: [{ key: WEB, price: both.prices[WEB] }] })).resolves.toEqual({ keys: [WEB], added: [] });
      await expect(edit(carried, { updates: {}, rowLines: [] })).resolves.toEqual({ keys: [], added: [] });
    });
    // Codex round 30: the visit's OWN service.
    test('the visit\'s own service moved to an add-on must carry the estimate\'s price; a kept own add-on keeps its stored price', async () => {
      const only = estimateSelling([{ key: 'web_sweep' }]);
      await expect(edit({ visit: visit(), estimate: only }, { updates: { service_key_snapshot: WEB, primary_line_price: only.prices[WEB] }, rowKeys: null })).resolves.toEqual({ keys: [WEB], added: [WEB] });
      await expect(edit({ visit: visit(), estimate: only }, { updates: { service_key_snapshot: WEB, primary_line_price: 5 }, rowKeys: null })).rejects.toMatchObject({ code: 'AREA_ADDON_PRICE_CHANGED' });
      await expect(edit({ visit: visit(), estimate: only }, { updates: { service_key_snapshot: WEB }, rowKeys: null })).rejects.toMatchObject({ code: 'AREA_ADDON_PRICE_CHANGED' });
      const own = visit({ service_key_snapshot: WEB, primary_line_price: only.prices[WEB] });
      await expect(edit({ visit: own, estimate: only }, { updates: { primary_line_price: 1 }, rowLines: [] })).rejects.toMatchObject({ code: 'AREA_ADDON_PRICE_LOCKED' });
      await expect(edit({ visit: own, estimate: only }, { updates: { primary_line_price: String(only.prices[WEB]) }, rowLines: [] })).resolves.toEqual({ keys: [WEB], added: [] });
    });

    // Codex round 53: a discounted service changed INTO an add-on must not keep its primary-line discount.
    test('the visit\'s own add-on carries no primary-line discount, inherited or written', async () => {
      const only = estimateSelling([{ key: 'web_sweep' }]);
      const discounted = visit({ line_discount_dollars: '15.00' });
      const toAddOn = { service_key_snapshot: WEB, primary_line_price: only.prices[WEB] };
      await expect(edit({ visit: discounted, estimate: only }, { updates: toAddOn, rowKeys: null })).rejects.toMatchObject({ status: 409, code: 'AREA_ADDON_NO_DISCOUNT' });
      // the save clears it: allowed
      await expect(edit({ visit: discounted, estimate: only }, { updates: { ...toAddOn, line_discount_dollars: null }, rowKeys: null })).resolves.toEqual({ keys: [WEB], added: [WEB] });
      // a kept own add-on that the save discounts
      const own = visit({ service_key_snapshot: WEB, primary_line_price: only.prices[WEB] });
      await expect(edit({ visit: own, estimate: only }, { updates: { primary_line_price: only.prices[WEB], line_discount_dollars: 5 }, rowKeys: null })).rejects.toMatchObject({ code: 'AREA_ADDON_NO_DISCOUNT' });
      // an appointment discount on a visit whose own service is an add-on has no host to bear it
      await expect(edit({ visit: own, estimate: only }, { updates: { discount_dollars: 20 }, rowKeys: null })).rejects.toMatchObject({ code: 'AREA_ADDON_NO_DISCOUNT' });
      // a save that only writes a discount on the own add-on is judged too
      await expect(edit({ visit: own, estimate: only }, { updates: { line_discount_dollars: 5 }, rowKeys: null })).rejects.toMatchObject({ code: 'AREA_ADDON_NO_DISCOUNT' });
      // a host's own discount is not the add-on's concern
      await expect(edit({ visit: discounted, rowKeys: [WEB], rowPrices: only.prices, estimate: only }, { updates: {}, rowLines: [{ key: WEB, price: only.prices[WEB] }] })).resolves.toEqual({ keys: [WEB], added: [] });
    });

    // Codex round 56: the booking's appointment-discount rule on an edited HOST visit that carries an add-on row.
    test('an appointment discount on a host visit must leave its add-on rows billed in full', async () => {
      const host = (over = {}) => visit({ estimated_price: 150 + both.prices[WEB], discount_dollars: null, ...over });
      const carried = (v) => ({ visit: v, rowKeys: [WEB], rowPrices: both.prices, estimate: both });
      // the host bears it: allowed
      await expect(edit(carried(host()), { updates: { discount_dollars: 20, estimated_price: 130 + both.prices[WEB] }, rowKeys: null })).resolves.toEqual({ keys: [WEB], added: [] });
      // larger than the host: it eats into the add-on
      await expect(edit(carried(host()), { updates: { discount_dollars: 160, estimated_price: both.prices[WEB] - 10 }, rowKeys: null })).rejects.toMatchObject({ status: 409, code: 'AREA_ADDON_NO_DISCOUNT' });
      // a share allocated to the add-on row by the save
      await expect(edit(carried(host()), { updates: { discount_dollars: 20, estimated_price: 130 + both.prices[WEB] }, rowLines: [{ key: WEB, price: both.prices[WEB], credit: 4 }] })).rejects.toMatchObject({ code: 'AREA_ADDON_NO_DISCOUNT' });
      // a stored appointment discount is judged when the save replaces the rows
      await expect(edit(carried(host({ discount_dollars: '160.00', estimated_price: both.prices[WEB] - 10 })), { updates: {}, rowLines: [{ key: WEB, price: both.prices[WEB] }] })).rejects.toMatchObject({ code: 'AREA_ADDON_NO_DISCOUNT' });
      // no appointment discount: nothing is judged
      await expect(edit(carried(host()), { updates: { estimated_price: 1 }, rowLines: [{ key: WEB, price: both.prices[WEB] }] })).resolves.toEqual({ keys: [WEB], added: [] });
    });

    // Codex round 36: a price-only edit, and a visit the accept booked (no stored primary price: the estimate is the reference).
    test('a price-only edit of a visit whose own service is an add-on is judged, against the estimate when no primary price is stored', async () => {
      const only = estimateSelling([{ key: 'web_sweep' }]);
      const accepted = visit({ service_key_snapshot: WEB, primary_line_price: null });
      await expect(edit({ visit: accepted, estimate: only }, { updates: { primary_line_price: 5 }, rowKeys: null })).rejects.toMatchObject({ code: 'AREA_ADDON_PRICE_LOCKED' });
      await expect(edit({ visit: accepted, estimate: only }, { updates: { primary_line_price: null }, rowKeys: null })).rejects.toMatchObject({ code: 'AREA_ADDON_PRICE_LOCKED' });
      await expect(edit({ visit: accepted, estimate: only }, { updates: { primary_line_price: only.prices[WEB] }, rowKeys: null })).resolves.toEqual({ keys: [WEB], added: [] });
      // a save that writes no primary price is still not an add-on edit: no estimate read
      const calls = [];
      await expect(edit({ visit: accepted, estimate: only, calls }, { updates: { notes: 'x' }, rowKeys: null })).resolves.toEqual({ keys: [WEB], added: [] });
      expect(calls).not.toContain('estimates');
    });

    // Codex round 38.
    test('with the gate off no new add-on is added; what the visit carries is kept', async () => {
      process.env.GATE_AREA_ADDONS = 'false';
      try {
        await expect(edit({ visit: visit(), rowKeys: [WEB], rowPrices: both.prices, estimate: both }, { updates: {}, rowLines: [{ key: WEB, price: both.prices[WEB] }, { key: BED, price: both.prices[BED] }] }))
          .rejects.toMatchObject({ status: 409, code: 'AREA_ADDONS_GATED' });
        await expect(edit({ visit: visit(), rowKeys: [WEB], rowPrices: both.prices, estimate: both }, { updates: {}, rowLines: [{ key: WEB, price: both.prices[WEB] }] })).resolves.toEqual({ keys: [WEB], added: [] });
      } finally { process.env.GATE_AREA_ADDONS = 'true'; }
    });
    test('an add-on moved from the visit\'s own service into a row is judged at the estimate\'s price', async () => {
      const own = visit({ service_key_snapshot: WEB, primary_line_price: null });
      const move = (price) => edit({ visit: own, estimate: both }, { updates: { service_key_snapshot: 'pest_control' }, rowLines: [{ key: WEB, price }] });
      await expect(move(1)).rejects.toMatchObject({ code: 'AREA_ADDON_PRICE_LOCKED' });
      await expect(move(both.prices[WEB])).resolves.toEqual({ keys: [WEB], added: [] });
    });

    test('the same add-on twice after the edit is refused', async () => {
      await expect(edit({ visit: visit(), rowKeys: [WEB], rowPrices: both.prices, estimate: both }, { updates: {}, rowLines: [{ key: WEB, price: both.prices[WEB] }, { key: WEB, price: both.prices[WEB] }] }))
        .rejects.toMatchObject({ code: 'AREA_ADDON_DUPLICATE' });
    });
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

// Codex round 25: the Intelligence Bar books one catalog service by name, with no estimate, sold area or limit recheck.
describe('the Intelligence Bar never books an area add-on by name', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'intelligence-bar', 'tools.js'), 'utf8');
  const catalog = [
    { id: 's-1', name: 'Fire Ant Yard Treatment', short_name: null, service_key: 'area_addon_fire_ant_yard', base_price: null, price_range_min: 69, category: 'lawn_care', billing_type: 'one_time' },
    { id: 's-2', name: 'One-Time Pest Control', short_name: null, service_key: 'one_time_pest', base_price: 150, price_range_min: 150, category: 'pest_control', billing_type: 'one_time' },
  ];
  const conn = () => ({ where: () => ({ select: async () => catalog }) });

  test('the pricer refuses the add-on with or without a stated price, before any price is read', async () => {
    const { _ibBookingPricing } = require('../services/intelligence-bar/tools');
    for (const statedPrice of [undefined, 99]) {
      const out = await _ibBookingPricing({ customer: { id: 'c-1' }, serviceType: 'Fire Ant Yard Treatment', statedPrice, conn });
      expect(out).toEqual({ error: '"Fire Ant Yard Treatment" is an add-on treatment that is priced and limited from an estimate. Build an estimate that sells it, then book from that estimate on the Schedule screen. Nothing was booked.' });
    }
  });

  test('every booking path of the bar asks that pricer', () => {
    expect(src.split('await ibBookingPricing(').length - 1).toBeGreaterThanOrEqual(4);
    const fn = src.slice(src.indexOf('async function ibBookingPricing('));
    expect(fn.indexOf("startsWith('area_addon_')")).toBeLessThan(fn.indexOf('isAlwaysFreeServiceType(serviceType)'));
  });
});

// Codex round 44: a failed add-on lookup is not "no add-on".
describe('the schedule feed when the add-on row lookup fails', () => {
  const visitRows = require('../services/area-addon-visit-rows');
  test('the batch is marked failed, and every visit of it carries the marker with every lightweight flow off', async () => {
    const spy = jest.spyOn(visitRows, 'areaAddOnSoldByVisit').mockRejectedValue(new Error('connection lost'));
    try {
      const out = await router._test.areaAddOnVisitIdsForFeed([{ id: VISIT }]);
      expect(out.failed).toBe(true);
      expect([out.byVisit.size, out.own.size]).toEqual([0, 0]);
    } finally { spy.mockRestore(); }
    const marker = router._test.AREA_ADDON_LOOKUP_FAILED;
    expect(marker).toMatchObject({ areaAddOnsLookupFailed: true, areaAddOnRowsAttached: false, lawnFastCompleteEnabled: false, fastCompleteReportEnabled: false, treeShrubFastCompleteEnabled: false });
    // Codex round 52: the two routing shortcuts Tech Home reads are off too, and both schedule payloads forward the marker.
    expect(marker).toMatchObject({ stationFastCompleteEnabled: false, comboFastCompleteEnabled: false });
    expect(fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8').split('areaAddOnsLookupFailed: projectCompletionContext.areaAddOnsLookupFailed === true,').length - 1).toBe(2);
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    expect(src).toContain('...(addOnVisits.failed ? AREA_ADDON_LOOKUP_FAILED : {}),');
  });
});

// Codex round 51: one estimate sells one application of an add-on, across appointments too.
describe('assertAreaAddOnsNotYetBooked', () => {
  const estimate = { id: 'est-1' };
  // own = visits whose own service is the add-on; rows = add-on rows; each { key, status, visitId, date }
  const trxWith = ({ own = [], rows = [] }, calls = []) => (table) => {
    calls.push(table);
    let list = (table.startsWith('scheduled_service_addons') ? rows : own).map((r) => ({ ...r }));
    const q = {
      join: () => q,
      whereIn: (_col, keys) => { list = list.filter((r) => keys.includes(r.key)); return q; },
      // `where(fn)`: the "of this estimate" group (the link, or the estimate id kept on the sold scope).
      where: (fn) => {
        const group = { linkId: null, scopeId: null, where(_col, id) { group.linkId = id; return group; }, orWhereRaw(_sql, [id]) { group.scopeId = id; return group; } };
        fn.call(group);
        list = list.filter((r) => (r.estimateId === undefined ? 'est-1' : r.estimateId) === group.linkId || r.scopeEstimateId === group.scopeId);
        return q;
      },
      whereNotIn: (_col, dead) => { list = list.filter((r) => !dead.includes(r.status || 'confirmed')); return q; },
      whereNot: (_col, id) => { list = list.filter((r) => r.visitId !== id); return q; },
      select: async () => list.map((r) => ({ service_key: r.key, scheduled_date: r.date || '2026-11-02' })),
    };
    return q;
  };
  const ask = (state, keys, opts, calls) => rows.assertAreaAddOnsNotYetBooked(trxWith(state, calls), estimate, keys, opts);

  test('an add-on the estimate already has on a visit (own service or a row) is refused by name and day; a completed one counts', async () => {
    const message = 'Web Sweep from this estimate is already on an appointment (2026-11-02). An estimate sells one application: build a new estimate to book another.';
    await expect(ask({ own: [{ key: WEB }] }, [WEB])).rejects.toMatchObject({ status: 409, code: 'AREA_ADDON_ALREADY_BOOKED', message });
    await expect(ask({ rows: [{ key: WEB, status: 'completed' }] }, ['one_time_pest', WEB])).rejects.toMatchObject({ code: 'AREA_ADDON_ALREADY_BOOKED' });
  });

  test('a cancelled, rescheduled, skipped or no-show visit does not count; an add-on left off before is booked once; another estimate is not read', async () => {
    for (const status of ['cancelled', 'rescheduled', 'skipped', 'no_show']) {
      await expect(ask({ own: [{ key: WEB, status }] }, [WEB])).resolves.toBeUndefined();
    }
    await expect(ask({ own: [{ key: WEB }] }, [BED])).resolves.toBeUndefined();
    await expect(ask({ own: [{ key: WEB, estimateId: 'est-other' }] }, [WEB])).resolves.toBeUndefined();
  });

  // Codex round 57: an accept-on-book links the visit after it commits (never, when that acceptance fails).
  test('a visit with no estimate link is still this estimate\'s by the estimate id on its add-on scope', async () => {
    await expect(ask({ own: [{ key: WEB, estimateId: null, scopeEstimateId: 'est-1' }] }, [WEB])).rejects.toMatchObject({ code: 'AREA_ADDON_ALREADY_BOOKED' });
    await expect(ask({ rows: [{ key: WEB, estimateId: null, scopeEstimateId: 'est-1' }] }, [WEB])).rejects.toMatchObject({ code: 'AREA_ADDON_ALREADY_BOOKED' });
    await expect(ask({ own: [{ key: WEB, estimateId: null, scopeEstimateId: 'est-other' }] }, [WEB])).resolves.toBeUndefined();
  });
  test('the staff scope writer keeps the estimate id on the scope; the booking takes the estimate lock before the place locks (source)', () => {
    const rowsSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'area-addon-visit-rows.js'), 'utf8');
    expect(rowsSrc).toContain("return writeAreaAddOnVisitRows(trx, { scheduledServiceId, serviceProfile: profile, ownServiceKey, addMissingRows: false, estimateId: estimate.id });");
    expect(rowsSrc).toContain("...(estimateId ? { sourceEstimateId: String(estimateId) } : {}),");
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const lock = src.indexOf("lockEstimateAddOns(trx, freshLinkedEstimate.id);");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(src.indexOf('await assertLockedEstimateAddOns(trx, freshLinkedEstimate, {'));
    // Update Details: before the address change's place locks
    const editLock = src.indexOf('await areaAddOnRows.lockEstimateAddOns(trx, linked && linked.source_estimate_id);');
    expect(editLock).toBeGreaterThan(0);
    expect(editLock).toBeLessThan(src.indexOf('if (addressPlan) addressUpdatedIds = await applyAppointmentAddress(trx, addressPlan, req.technicianId);'));
    // Codex round 59: and before the stop locks of the address change
    expect(editLock).toBeLessThan(src.indexOf('if (addressPlan) await lockAppointmentAddress(trx, addressPlan, updates);'));
  });

  test('the reads run under a transaction lock keyed on the estimate (two bookings of one estimate are serialized)', async () => {
    const locks = [];
    const trx = trxWith({ own: [] });
    trx.raw = async (sql, bindings) => { locks.push([sql, bindings]); };
    await rows.assertAreaAddOnsNotYetBooked(trx, estimate, [WEB]);
    expect(locks).toEqual([["SELECT pg_advisory_xact_lock(hashtext('area-addon-estimate'), hashtext(?::text))", ['est-1']]]);
  });

  test('the visit an edit is saving is left out; no add-on key or no estimate reads nothing', async () => {
    await expect(ask({ rows: [{ key: WEB, visitId: VISIT }] }, [WEB], { exceptVisitId: VISIT })).resolves.toBeUndefined();
    const calls = [];
    await expect(ask({ own: [{ key: WEB }] }, ['one_time_pest'], {}, calls)).resolves.toBeUndefined();
    await expect(rows.assertAreaAddOnsNotYetBooked(trxWith({ own: [{ key: WEB }] }, calls), null, [WEB])).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('the staff booking asks it right after the sold-lines guard, inside the transaction (source)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const sold = src.indexOf('assertPostedAreaAddOnsSold(c.lockedLinkedEstimate, postedAreaAddOnLines(pricing), { recurring: isRecurring, totals: postedAreaAddOnTotals(pricing) });');
    const again = src.indexOf('assertAreaAddOnsNotYetBooked(trx, c.lockedLinkedEstimate, postedAreaAddOnLines(pricing).map((line) => line.key));');
    expect(again).toBeGreaterThan(sold);
    expect(again - sold).toBeLessThan(700);
  });
});
