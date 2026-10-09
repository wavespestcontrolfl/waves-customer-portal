/**
 * Codex round 18 P1 on #6135: a booked visit that carries a limited area add-on kept the booking verdict of its old date and place
 * when it was moved. assertMovedVisitLimitsOpen judges the add-on's yearly limit again for the NEW day and property on the place-based
 * history, this visit left out, inside the mover's own transaction. Every mover of a booked visit's date or property calls it (the
 * source-order tests at the end pin the call sites); a time-only or technician change is not a move.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/application-limits', () => ({
  scopeHistoryToTreatment: (query, _db, { propertyId } = {}) => {
    if (propertyId) query.where(function placedHereOrUnplaced() { this.whereNull('property_id').orWhere('property_id', propertyId); });
    return query;
  },
}));
jest.mock('../services/slot-reservation', () => ({ commitGraceMinutes: () => 10 }));

const fs = require('fs');
const path = require('path');
const { fakeDb } = require('./helpers/area-addon-fake-db');
const limits = require('../services/area-addon-limits');
const { addDays } = require('../services/pricing-engine/area-addon-limits');
const { addressKey } = require('../services/customer-property-address-keys');

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OTHER_CUSTOMER = '11111111-1111-4111-8111-1111111111b2';
const HOME = '22222222-2222-4222-8222-222222222222';
const OTHER_HOME = '22222222-2222-4222-8222-2222222222b2';
const VISIT = '33333333-3333-4333-8333-333333333333';
const OTHER_VISIT = '33333333-3333-4333-8333-3333333333b2';
const TODAY = '2026-10-09';
const FROM = addDays(TODAY, 3);
const BED = 'area_addon_bed_pre_emergent';
const CATALOG = [
  { id: 'p-snap', name: 'Snapshot 2.5TG', active: true }, { id: 'p-arena', name: 'Arena 50 WDG', active: true },
  { id: 'p-top', name: 'Topchoice Granular Insecticide', active: true }, { id: 'p-acel', name: 'Acelepryn Insecticide', active: true },
  { id: 'p-round', name: 'Roundup QuikPro SC', active: true },
];
const KEY = (line1) => addressKey({ address_line1: line1, city: 'Bradenton', zip: '34202' });
const moving = (over = {}) => ({
  id: VISIT, 's.id': VISIT, customer_id: CUSTOMER, property_id: HOME, scheduled_date: FROM, source_estimate_id: null, service_key_snapshot: BED, ...over,
});
const world = (over = {}) => ({
  products_catalog: CATALOG,
  product_aliases: [],
  customer_properties: [
    { id: HOME, customer_id: CUSTOMER, active: true, address_key: KEY('1 Test Way') },
    { id: OTHER_HOME, customer_id: CUSTOMER, active: true, address_key: KEY('9 Other St') },
  ],
  property_application_history: [],
  scheduled_services: [moving()],
  scheduled_service_addons: [],
  estimates: [],
  ...over,
});
const ledger = (day, extra = {}) => ({ customer_id: CUSTOMER, product_id: 'p-snap', application_date: day, property_id: HOME, retracted_at: null, ...extra });
const otherBooking = (day, extra = {}) => ({
  's.service_key_snapshot': BED, 's.customer_id': CUSTOMER, 's.status': 'confirmed', 's.property_id': HOME, 's.source_estimate_id': null, 's.id': OTHER_VISIT, 's.scheduled_date': day, ...extra,
});
// A pass resolves to what was judged ({ keys, day }) or null when there was nothing to ask; these tests only need "no refusal".
const judge = (tables, args = {}, calls = []) => limits.assertMovedVisitLimitsOpen(fakeDb(tables, calls), { visitId: VISIT, ...args });
const move = (tables, args, calls) => judge(tables, args, calls).then(() => undefined);
const NEW_DAY = addDays(TODAY, 30);

describe('a moved visit that carries a limited add-on is judged for the new day', () => {
  test('Snapshot applied 20 days before the new day: refused; staff get the dates, a customer-facing caller gets the office hand-off', async () => {
    const tables = () => world({ property_application_history: [ledger(addDays(NEW_DAY, -20))] });
    await expect(move(tables(), { scheduledDate: NEW_DAY, staff: true })).rejects.toMatchObject({
      status: 409, statusCode: 409, isOperational: true, code: 'AREA_ADDON_YEARLY_LIMIT_REACHED', addOnKey: 'bed_pre_emergent',
      message: expect.stringContaining(`The next one is allowed on ${addDays(addDays(NEW_DAY, -20), 60)}.`),
    });
    const customer = await move(tables(), { scheduledDate: NEW_DAY }).catch((err) => err);
    expect(customer).toMatchObject({ status: 409, code: 'AREA_ADDON_YEARLY_LIMIT_REACHED', message: limits.MOVE_CUSTOMER_MESSAGE });
    expect(customer.message).toBe('An add-on treatment on this appointment cannot be moved to that day. Please contact our office and we will find a day that works.');
    expect(customer.message).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test('a day far enough from every application is open, and so is the day the visit already holds', async () => {
    const tables = () => world({ property_application_history: [ledger(addDays(NEW_DAY, -70))] });
    await expect(move(tables(), { scheduledDate: NEW_DAY, staff: true })).resolves.toBeUndefined();
    // moved BEFORE a booked application of another customer record at the place, 20 days apart
    await expect(move(world({ scheduled_services: [moving(), otherBooking(addDays(NEW_DAY, 20), { 's.customer_id': OTHER_CUSTOMER })] }), { scheduledDate: NEW_DAY, staff: true }))
      .rejects.toMatchObject({ code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' });
  });

  test('the visit is never counted against itself: its own booked day and its own row leave the history', async () => {
    const tables = world({ scheduled_services: [moving({ 's.service_key_snapshot': BED, 's.scheduled_date': FROM, 's.customer_id': CUSTOMER, 's.property_id': HOME, 's.status': 'confirmed' })] });
    await expect(move(tables, { scheduledDate: addDays(FROM, 5), staff: true })).resolves.toBeUndefined();
  });

  test('an add-on ROW on a host visit is judged the same way (a Tree & Shrub visit carrying the bed add-on)', async () => {
    const tables = world({
      scheduled_services: [moving({ service_key_snapshot: 'tree_shrub' })],
      scheduled_service_addons: [{ scheduled_service_id: VISIT, service_key_snapshot: BED }],
      property_application_history: [ledger(addDays(NEW_DAY, -20))],
    });
    await expect(move(tables, { scheduledDate: NEW_DAY, staff: true })).rejects.toMatchObject({ code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' });
  });

  test('a new PROPERTY is judged at the new place, even on the same day', async () => {
    const tables = world({ property_application_history: [ledger(addDays(FROM, -20), { property_id: OTHER_HOME })] });
    await expect(move(tables, { propertyId: HOME, staff: true })).resolves.toBeUndefined();
    await expect(move(tables, { propertyId: OTHER_HOME, staff: true })).rejects.toMatchObject({ code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' });
  });

  test('a count limit: Topchoice (once in 12 months) moved to a day within a year of the last application', async () => {
    const tables = world({
      scheduled_services: [moving({ service_key_snapshot: 'area_addon_fire_ant_yard' })],
      property_application_history: [ledger(addDays(NEW_DAY, -200), { product_id: 'p-top' })],
    });
    await expect(move(tables, { scheduledDate: NEW_DAY, staff: true })).rejects.toMatchObject({ code: 'AREA_ADDON_YEARLY_LIMIT_REACHED', addOnKey: 'fire_ant_yard' });
  });
});

// Codex round 34: the 12 months are counted back from the day the visit lands on.
describe('a backdated move is judged against its own window', () => {
  test('an application over a year before today but within 60 days of the backdated day closes that day', async () => {
    const BACK = addDays(TODAY, -340);
    const tables = () => world({ property_application_history: [ledger(addDays(BACK, -30))] });
    await expect(judge(tables(), { scheduledDate: BACK, staff: true })).rejects.toMatchObject({ code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' });
    // the same application does not close a day near today
    await expect(judge(tables(), { scheduledDate: NEW_DAY, staff: true })).resolves.toEqual({ keys: ['bed_pre_emergent'], day: NEW_DAY });
  });
});

// Codex round 27: a batch mover hands the visits it already judged for the same destination.
describe('visits moved in the same batch count at the destination', () => {
  test('a pass returns what was judged; a sibling handed over as alsoMoving closes the day', async () => {
    const tables = () => world({ property_application_history: [ledger(addDays(NEW_DAY, -70))] });
    await expect(judge(tables(), { scheduledDate: NEW_DAY, staff: true })).resolves.toEqual({ keys: ['bed_pre_emergent'], day: NEW_DAY });
    await expect(judge(tables(), { scheduledDate: NEW_DAY, staff: true, alsoMoving: { bed_pre_emergent: [NEW_DAY] } }))
      .rejects.toMatchObject({ code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' });
    await expect(judge(tables(), { scheduledDate: NEW_DAY, staff: true, alsoMoving: { fire_ant_yard: [NEW_DAY] } })).resolves.toEqual({ keys: ['bed_pre_emergent'], day: NEW_DAY });
  });
});

describe('what is not a move, and what costs nothing', () => {
  test('the same day and property with the row in hand: no query at all', async () => {
    const calls = [];
    await expect(move(world(), { visit: moving(), scheduledDate: FROM, staff: true }, calls)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('a visit with no limited add-on (an unlimited web sweep row, a plain pest visit) reads no history', async () => {
    const calls = [];
    const tables = world({ scheduled_services: [moving({ service_key_snapshot: 'pest_control' })], scheduled_service_addons: [{ scheduled_service_id: VISIT, service_key_snapshot: 'area_addon_web_sweep' }], property_application_history: [ledger(addDays(NEW_DAY, -5))] });
    await expect(move(tables, { scheduledDate: NEW_DAY, staff: true }, calls)).resolves.toBeUndefined();
    expect(calls).not.toContain('property_application_history');
  });

  test('an unknown visit passes (the mover owns the not-found answer)', async () => {
    await expect(limits.assertMovedVisitLimitsOpen(fakeDb(world({ scheduled_services: [] })), { visitId: VISIT, scheduledDate: NEW_DAY })).resolves.toBeNull();
    await expect(limits.assertMovedVisitLimitsOpen(fakeDb(world()), { visitId: 'not-a-uuid', scheduledDate: NEW_DAY })).resolves.toBeNull();
  });

  test('it never asks GATE_AREA_ADDONS (a visit booked gate-on is moved gate-off)', async () => {
    const prev = process.env.GATE_AREA_ADDONS;
    delete process.env.GATE_AREA_ADDONS;
    try {
      await expect(move(world({ property_application_history: [ledger(addDays(NEW_DAY, -20))] }), { scheduledDate: NEW_DAY, staff: true })).rejects.toMatchObject({ code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' });
    } finally {
      if (prev !== undefined) process.env.GATE_AREA_ADDONS = prev;
    }
  });

  test('an edit that ADDS an add-on asks even with day and property unchanged (force), on the keys the visit will carry', async () => {
    const tables = world({ scheduled_services: [moving({ service_key_snapshot: 'tree_shrub' })], property_application_history: [ledger(addDays(FROM, -20))] });
    await expect(move(tables, { scheduledDate: FROM, staff: true })).resolves.toBeUndefined();
    await expect(move(tables, { scheduledDate: FROM, staff: true, force: true, serviceKeys: [BED] })).rejects.toMatchObject({ code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' });
  });
});

describe('a history that cannot be read fails closed', () => {
  test('staff and customer-facing callers each get their own sentence under the history code', async () => {
    const tables = world();
    delete tables.property_application_history;
    await expect(move(tables, { scheduledDate: NEW_DAY, staff: true })).rejects.toMatchObject({
      status: 409, code: 'AREA_ADDON_HISTORY_UNAVAILABLE',
      message: 'The treatment history for this property could not be read, so the add-on yearly limits cannot be confirmed for the new day. Try again.',
    });
    await expect(move(tables, { scheduledDate: NEW_DAY })).rejects.toMatchObject({ code: 'AREA_ADDON_HISTORY_UNAVAILABLE', message: limits.MOVE_CUSTOMER_MESSAGE });
  });
});

describe('every mover of a booked visit\'s date or property asks it, in its own transaction, after its row is locked', () => {
  const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
  const call = 'assertMovedVisitLimitsOpen(trx, ';

  test('rebooker.rescheduleOnce (dispatch, drag / Quick Move, rain-out, the customer link, SMS, voice, auto-dispatch, tech-out, combine, unit members): after the CAS write, before the log', () => {
    const src = read('services', 'rebooker.js');
    expect(src).toContain("assertMovedVisitLimitsOpen(trx, { visitId: serviceId, visit: service, scheduledDate: newDateStr, staff: initiatedBy === 'admin' });");
    expect(src.indexOf("job transitioned to a non-reschedulable state concurrently'), {\n          statusCode: 409,\n        });\n      }\n\n      // A visit that carries a limited area add-on")).toBeGreaterThan(0);
    expect(src.indexOf(call)).toBeLessThan(src.indexOf("await trx('reschedule_log').insert({\n        scheduled_service_id: serviceId,"));
    // the series path moves recurring cadence rows (a repeating series never carries an area add-on) and the one-time
    // partners it carries, which have their own check (next test)
    expect(src.split(call).length - 1).toBe(2);
  });

  test('the bulk board reschedule: after its CAS write, per id, so a refusal fails that id and the batch goes on', () => {
    const src = read('routes', 'admin-schedule.js');
    const at = src.indexOf('assertMovedVisitLimitsOpen(trx, { visitId: id, visit: svc, scheduledDate: bulkTargetDate, staff: true });');
    expect(at).toBeGreaterThan(src.indexOf('const bulkCommittedRows = await require'));
    expect(src.indexOf('failed.push({ id, reason: e.message });', at)).toBeGreaterThan(at);
  });

  test('Update Details: date, a new property (address plan) and an added add-on, through the one route helper', () => {
    const src = read('routes', 'admin-schedule.js');
    expect(src).toContain("visitId, scheduledDate: updates.scheduled_date, propertyId: addressPlan ? addressPlan.propertyId : null, serviceKeys: keys, force: Boolean(addressPlan) || added.length > 0, staff: true,");
  });

  // Codex round 33: a series move can carry a grouped one-time partner; the partner is written by its own CAS.
  test('a carried partner of a series move is judged for its new day before its CAS write', () => {
    const src = read('services', 'rebooker.js');
    const carry = src.slice(src.indexOf('const carryVisitPartners = async ('));
    const ask = carry.indexOf("assertMovedVisitLimitsOpen(trx, { visitId: partner.id, scheduledDate: dateStr, staff: initiatedBy === 'admin' });");
    expect(ask).toBeGreaterThan(0);
    expect(ask).toBeLessThan(carry.indexOf('await writePartnerCas(trx, partner, pUpdate);'));
    expect(carry.slice(ask - 120, ask)).toContain('if (partnerDateChanges) {');
  });

  test('the Intelligence Bar movers (single and batch) call it under their own transaction', () => {
    expect(read('services', 'intelligence-bar', 'tools.js')).toContain("assertMovedVisitLimitsOpen(trx, { visitId: appointment_id, visit: appt, scheduledDate: dateStr, staff: true });");
    expect(read('services', 'intelligence-bar', 'schedule-tools.js')).toContain("assertMovedVisitLimitsOpen(trx, { visitId: s.id, visit: s, scheduledDate: dateStr, staff: true });");
  });
});

// Codex round 24: an address change moves every row of its plan (grouped siblings, series rows), from every caller.
describe('an address change rechecks every visit it moves, at the destination property', () => {
  const address = require('../services/appointment-address');
  const limitsModule = require('../services/area-addon-limits');
  const rowsModule = require('../services/area-addon-visit-rows');
  const A = '10000000-0000-4000-8000-00000000000a';
  const B = '10000000-0000-4000-8000-00000000000b';
  const C = '10000000-0000-4000-8000-00000000000c';

  test('the anchor with no add-on and its sibling that carries one: the sibling is judged at the new property; rows already there are skipped', async () => {
    const keysByVisit = jest.spyOn(rowsModule, 'areaAddOnKeysByVisit').mockResolvedValue(new Map([[B, ['area_addon_fire_ant_yard']]]));
    const moved = jest.spyOn(limitsModule, 'assertMovedVisitLimitsOpen').mockResolvedValue(undefined);
    try {
      const rows = [
        { id: A, property_id: 'old', service_key_snapshot: 'pest_control' },
        { id: B, property_id: 'old', service_key_snapshot: 'lawn_care' },
        { id: C, property_id: 'new', service_key_snapshot: 'area_addon_bed_pre_emergent' },
      ];
      await address._test.assertAreaAddOnLimitsAtDestination({ tag: 'trx' }, rows, 'new');
      expect(keysByVisit).toHaveBeenCalledWith({ tag: 'trx' }, [A, B]);
      expect(moved).toHaveBeenCalledTimes(1);
      expect(moved).toHaveBeenCalledWith({ tag: 'trx' }, { visitId: B, visit: rows[1], propertyId: 'new', serviceKeys: ['area_addon_fire_ant_yard'], staff: true, alsoMoving: {} });
    } finally { keysByVisit.mockRestore(); moved.mockRestore(); }
  });

  // Codex round 27: two visits moved together are one batch; the second sees the first at the destination.
  test('each row that passes is handed to the rows judged after it, by limit key and day', async () => {
    const keysByVisit = jest.spyOn(rowsModule, 'areaAddOnKeysByVisit').mockResolvedValue(new Map());
    const seen = [];
    const moved = jest.spyOn(limitsModule, 'assertMovedVisitLimitsOpen').mockImplementation(async (_trx, options) => {
      seen.push(JSON.parse(JSON.stringify(options.alsoMoving)));
      return { keys: ['hardscape_weed'], day: options.visit.scheduled_date };
    });
    try {
      const rows = [
        { id: A, property_id: 'old', service_key_snapshot: 'area_addon_hardscape_weed', scheduled_date: '2026-11-02' },
        { id: B, property_id: 'old', service_key_snapshot: 'area_addon_hardscape_weed', scheduled_date: '2026-11-02' },
      ];
      await address._test.assertAreaAddOnLimitsAtDestination({ tag: 'trx' }, rows, 'new');
      expect(seen).toEqual([{}, { hardscape_weed: ['2026-11-02'] }]);
    } finally { keysByVisit.mockRestore(); moved.mockRestore(); }
  });

  test('source: applyAppointmentAddress asks it on the locked rows, before any row is written', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'appointment-address.js'), 'utf8');
    const apply = src.slice(src.indexOf('async function applyAppointmentAddress('));
    const ask = apply.indexOf('await assertAreaAddOnLimitsAtDestination(trx, locked, plan.propertyId);');
    expect(ask).toBeGreaterThan(apply.indexOf('.forUpdate()'));
    expect(ask).toBeLessThan(apply.indexOf('const stamp = {'));
  });
});
