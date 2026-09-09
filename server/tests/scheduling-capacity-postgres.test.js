/** Real offer/hold/commit queries and locks in a synthetic, private schema. */
let mockPg;
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  Object.defineProperty(db, 'fn', { get: () => mockPg.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/slot-zone', () => ({ resolveEstimateZone: async () => null, zoneSlugOf: () => null }));
jest.mock('../services/inspection-credit', () => ({ markBookingForInspectionCredit: async () => {} }));
jest.mock('../services/tech-visit-notifications', () => ({
  notifyTechVisitChange: async () => {}, notifyAssignmentChange: async () => {},
}));
jest.mock('../services/estimate-slot-availability', () => ({
  ...jest.requireActual('../services/estimate-slot-availability'),
  resolveEstimateCoords: async () => require('../services/route-optimizer').HQ,
}));

const knex = require('knex');
const PIN = require('../services/route-optimizer').HQ;
const { randomUUID } = require('node:crypto');
const { addETDays, etDateString } = require('../utils/datetime-et');
const { signSlotOffer, appendOfferToSlotId } = require('../utils/slot-offer-token');
const { reserveSlot, commitReservation, prepareReservationCommit } = require('../services/slot-reservation');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const connection = process.env.SCHEDULING_CAPACITY_TEST_DATABASE_URL;
const describeDb = connection ? describe : describe.skip;
const schema = `scheduling_capacity_${randomUUID().replaceAll('-', '')}`;
const date = etDateString(addETDays(new Date(), 14));
const technicianId = randomUUID();
const otherTechId = randomUUID();
const customerId = randomUUID();
const estimateIds = [randomUUID(), randomUUID()];
let admin;
jest.setTimeout(30000);

const estimateData = (keys = ['pest_control']) => ({ result: { recurring: { services:
  keys.map(service => ({ service, name: service, visitsPerYear: service === 'pest_control' ? 4 : 6 })) } } });
const signedSlot = (estimateId, durationMinutes = 30, start = '10:00') => appendOfferToSlotId(
  `${date}_${start.replace(':', '-')}_${technicianId}`,
  signSlotOffer({ surface: 'estimate', scopeId: estimateId, date,
    startMinutes: Number(start.slice(0, 2)) * 60, technicianId, durationMinutes }),
);
const baseStop = (extra = {}) => ({ id: randomUUID(), scheduled_date: date, technician_id: technicianId,
  customer_id: customerId, service_type: 'Pest Control', status: 'confirmed',
  window_start: '08:00', window_end: '08:30', estimated_duration_minutes: 30,
  ...PIN, ...extra });

describeDb('scheduling capacity on PostgreSQL', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const localCi = process.env.CI === 'true' && process.env.NODE_ENV === 'test'
      && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!localCi && !/^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname)) {
      throw new Error('Use a verified nonproduction, task-private QA database');
    }
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 5 } });
    for (const table of ['customers', 'estimates', 'services', 'scheduled_services', 'technicians',
      'technician_capabilities', 'tech_schedule_blocks', 'schedule_blackout_dates', 'system_settings',
      'audit_log']) {
      await mockPg.raw('CREATE TABLE ?? (LIKE public.?? INCLUDING ALL)', [table, table]);
    }
    await mockPg.raw('ALTER TABLE scheduled_services ALTER COLUMN id SET DEFAULT gen_random_uuid()');
    await mockPg('technicians').insert([technicianId, otherTechId].map(id => ({ id, name: 'Fixture technician',
      role: 'technician', active: true, employment_status: 'active', field_dispatchable: true })));
    await mockPg('customers').insert({ id: customerId, first_name: 'Fixture', last_name: 'Account',
      phone: '+12025550141', email: 'capacity-fixture@example.invalid', city: 'Bradenton', latitude: PIN.lat, longitude: PIN.lng });
    await mockPg('services').insert([
      { id: randomUUID(), service_key: 'pest_general_quarterly', name: 'Quarterly Pest Control',
        category: 'pest', billing_type: 'recurring', is_active: true, engine_keys: JSON.stringify(['pest_control']),
        default_duration_minutes: 60, scheduling_duration_policy: { version: 1,
          default_duration_minutes: 30, min_duration_minutes: 30, max_duration_minutes: 40 } },
      { id: randomUUID(), service_key: 'lawn_care_recurring', name: 'Lawn Care',
        category: 'lawn', billing_type: 'recurring', is_active: true, engine_keys: JSON.stringify(['lawn_care']),
        default_duration_minutes: 40 },
    ]);
  });
  afterAll(async () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    delete process.env.GATE_SEPARATE_COMBO_VISITS;
    delete process.env.GATE_VISIT_COMBINED_CAPACITY;
    if (mockPg) await mockPg.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });
  beforeEach(async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    process.env.GATE_SEPARATE_COMBO_VISITS = 'true';
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    for (const table of ['scheduled_services', 'estimates', 'tech_schedule_blocks', 'technician_capabilities',
      'schedule_blackout_dates', 'system_settings', 'audit_log']) await mockPg(table).del();
    await mockPg('estimates').insert(estimateIds.map(id => ({ id, customer_id: customerId, status: 'sent',
      estimate_data: estimateData(), expires_at: addETDays(new Date(), 30) })));
  });

  test.each([
    ['pest_control', 30, null, '10:30'],
    ['lawn_care', 40, null, '10:40'],
    ['pest_control', 90, 90, '11:30'],
  ])('offer, hold, retry and commit retain %s work of %i minutes', async (service, duration, explicitDuration, expectedEnd) => {
    const data = estimateData([service]);
    if (explicitDuration) data.result.recurring.services[0].estimatedDurationMinutes = explicitDuration;
    await mockPg('estimates').where({ id: estimateIds[0] }).update({ estimate_data: data });
    const offers = await findAvailableSlots({ ...PIN, dateFrom: date, dateTo: date,
      technicianId, serviceType: service, durationMinutes: duration, includeWeekends: true, topN: 99 });
    expect(offers.slots.some(slot => slot.start_time === '10:00' && slot.end_time === expectedEnd)).toBe(true);
    expect(offers.slots.some(slot => slot.start_time >= '17:00')).toBe(false);
    const args = { estimateId: estimateIds[0], slotId: signedSlot(estimateIds[0], duration) };
    const hold = await reserveSlot(args);
    expect((await reserveSlot(args)).scheduledServiceId).toBe(hold.scheduledServiceId);
    const booked = await commitReservation({ scheduledServiceId: hold.scheduledServiceId, customerId });
    expect(booked).toMatchObject({ estimated_duration_minutes: duration, window_start: '10:00:00',
      window_end: `${expectedEnd}:00`, reservation_expires_at: null });
    expect((await mockPg('scheduled_services').where({ id: booked.id }).first()).route_order).toBe(1);
  });

  test('a technician disabled after the offer returns a recoverable reservation conflict', async () => {
    await mockPg('technicians').where({ id: technicianId }).update({ field_dispatchable: false });
    try {
      await expect(reserveSlot({ estimateId: estimateIds[0], slotId: signedSlot(estimateIds[0]) }))
        .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', status: 409, reason: 'technician_unavailable' });
      expect(await mockPg('scheduled_services')).toHaveLength(0);
    } finally {
      await mockPg('technicians').where({ id: technicianId }).update({ field_dispatchable: true });
    }
  });

  test.each([20, 90])('changed single-service allowance of %i minutes rejects prepare and live commit', async duration => {
    const held = await reserveSlot({ estimateId: estimateIds[0], slotId: signedSlot(estimateIds[0]) });
    const preparedCapacity = await prepareReservationCommit(held.scheduledServiceId);
    await mockPg('services').where({ service_key: 'pest_general_quarterly' }).update({
      scheduling_duration_policy: { version: 1, default_duration_minutes: duration,
        min_duration_minutes: duration, max_duration_minutes: duration },
    });
    try {
      await expect(prepareReservationCommit(held.scheduledServiceId))
        .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'service_duration_changed' });
      await expect(commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId, preparedCapacity }))
        .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'service_duration_changed' });
      expect(await mockPg('scheduled_services').where({ id: held.scheduledServiceId }).first())
        .toMatchObject({ customer_id: null, estimated_duration_minutes: 30 });
    } finally {
      await mockPg('services').where({ service_key: 'pest_general_quarterly' }).update({
        scheduling_duration_policy: { version: 1, default_duration_minutes: 30,
          min_duration_minutes: 30, max_duration_minutes: 40 },
      });
    }
  });

  test('concurrent customers cannot both consume the final thirty minutes', async () => {
    await mockPg('scheduled_services').insert(baseStop({ window_start: '08:00', window_end: '16:00',
      estimated_duration_minutes: 480, route_order: 1 }));
    await mockPg('tech_schedule_blocks').insert({ id: randomUUID(), date, technician_id: technicianId,
      block_type: 'blocked', start_time: '16:45', end_time: '18:00' });
    const outcomes = await Promise.allSettled(estimateIds.map(estimateId => reserveSlot({
      estimateId, slotId: signedSlot(estimateId, 30, '16:00'),
    })));
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await mockPg('scheduled_services').whereNotNull('reservation_expires_at')).toHaveLength(1);
  });

  test('a changed route invalidates a prepared commit and leaves the hold intact', async () => {
    const held = await reserveSlot({ estimateId: estimateIds[0], slotId: signedSlot(estimateIds[0]) });
    const preparedCapacity = await prepareReservationCommit(held.scheduledServiceId);
    await mockPg('scheduled_services').insert(baseStop({ window_start: '10:00', window_end: '12:00' }));
    await expect(mockPg.transaction(trx => commitReservation({ scheduledServiceId: held.scheduledServiceId,
      customerId, preparedCapacity, trx }))).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'route_changed' });
    expect((await mockPg('scheduled_services').where({ id: held.scheduledServiceId }).first()).customer_id).toBeNull();
  });

  test('a combined hold preserves each resolved allowance when the release gate is disabled', async () => {
    await mockPg('estimates').where({ id: estimateIds[0] }).update({ estimate_data: estimateData(['pest_control', 'lawn_care']) });
    const held = await reserveSlot({ estimateId: estimateIds[0], slotId: signedSlot(estimateIds[0], 70) });
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const booked = await commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId });
    expect(booked.estimated_duration_minutes).toBe(70);
    expect(booked.reservation_service_mix).toMatchObject({ version: 2, durations: [30, 40], durationMinutes: 70 });
  });

  test('legacy combined holds retain hourly members beside a new catalog-sized hold', async () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    await mockPg('estimates').where({ id: estimateIds[0] }).update({ estimate_data: estimateData(['pest_control', 'lawn_care']) });
    const legacy = await reserveSlot({ estimateId: estimateIds[0], slotId: signedSlot(estimateIds[0], 120, '09:00') });
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const current = await reserveSlot({ estimateId: estimateIds[1], slotId: signedSlot(estimateIds[1], 30, '13:00') });
    const booked = await commitReservation({ scheduledServiceId: legacy.scheduledServiceId, customerId });
    expect(booked).toMatchObject({ estimated_duration_minutes: 120,
      reservation_service_mix: { version: 1, durationMinutes: 120 }, window_end: '11:00:00' });
    expect((await mockPg('scheduled_services').where({ id: current.scheduledServiceId }).first()).estimated_duration_minutes).toBe(30);
  });

  test('acceptance refuses a changed single-service selection with a different allowance', async () => {
    const held = await reserveSlot({ estimateId: estimateIds[0], slotId: signedSlot(estimateIds[0]) });
    await mockPg('estimates').where({ id: estimateIds[0] }).update({ estimate_data: estimateData(['lawn_care']) });
    await mockPg('technician_capabilities').insert({ technician_id: technicianId, service_category: 'lawn', active: false });
    await expect(commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId }))
      .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'service_duration_changed' });
    expect((await mockPg('scheduled_services').where({ id: held.scheduledServiceId }).first()).customer_id).toBeNull();
  });

  test('conversion keeps companions beside their anchor ahead of the next appointment', async () => {
    const { persistCapacityAllocation, groupRouteStops } = require('../services/scheduling/arrival-route');
    const visit_id = randomUUID();
    const anchor = baseStop({ visit_id, route_order: 1 });
    const companion = baseStop({ visit_id, service_type: 'Lawn Care', route_order: null });
    const next = baseStop({ window_start: '12:00', window_end: '12:30', route_order: 2 });
    await mockPg('scheduled_services').insert([anchor, companion, next]);
    await mockPg.transaction(trx => persistCapacityAllocation(trx, anchor, [anchor.id, companion.id]));
    const rows = await mockPg('scheduled_services').orderBy('route_order');
    expect(rows.map(row => row.id)).toEqual([anchor.id, companion.id, next.id]);
    expect(groupRouteStops(rows)[0].memberIds).toEqual([anchor.id, companion.id]);
    expect(await mockPg('audit_log').where({ action: 'schedule.capacity_allocated' })).toHaveLength(1);
  });

  test('a multi-program estimate with combined capacity off holds only the primary allowance', async () => {
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'false';
    await mockPg('estimates').where({ id: estimateIds[0] }).update({ estimate_data: estimateData(['lawn_care', 'pest_control']) });
    const held = await reserveSlot({ estimateId: estimateIds[0], slotId: signedSlot(estimateIds[0], 30) });
    const booked = await commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId });
    expect(booked.estimated_duration_minutes).toBe(30);
    expect(booked.reservation_service_mix).toBeNull();
    expect(booked.service_type).toContain('Pest');
  });

  test('commit waits for the tech-day fence before row locks and rejects a reorder that wins first', async () => {
    const { lockTechDays } = require('../services/scheduling/tech-day-lock');
    const held = await reserveSlot({ estimateId: estimateIds[0], slotId: signedSlot(estimateIds[0]) });
    const preparedCapacity = await prepareReservationCommit(held.scheduledServiceId);
    const reorder = await mockPg.transaction();
    let outcome;
    try {
      await lockTechDays(reorder, [{ techId: technicianId, date }]);
      outcome = commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId, preparedCapacity })
        .then(value => ({ value }), error => ({ error }));
      let waiting = false;
      for (let attempt = 0; attempt < 50 && !waiting; attempt++) {
        const result = await admin.raw(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
          AND NOT granted AND classid = hashtext('slot-reserve')::oid AND objid = hashtext(?::text)::oid) AS waiting`, [`${technicianId}:${date}`]);
        waiting = result.rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      // A row-first acceptance would make this NOWAIT lock fail.
      await reorder('scheduled_services').where({ id: held.scheduledServiceId }).forUpdate().noWait().first();
      await reorder('scheduled_services').where({ id: held.scheduledServiceId }).update({ route_order: 9 });
      await reorder.commit();
      expect((await outcome).error).toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'route_changed' });
      expect((await mockPg('scheduled_services').where({ id: held.scheduledServiceId }).first()).customer_id).toBeNull();
    } finally {
      if (!reorder.isCompleted()) await reorder.rollback();
      if (outcome) await outcome;
    }
  });

  test('allocation refuses a busy tech-day fence without waiting behind its row locks', async () => {
    const { persistCapacityAllocation } = require('../services/scheduling/arrival-route');
    const { lockTechDays } = require('../services/scheduling/tech-day-lock');
    const anchor = baseStop({ route_order: 1 });
    const companion = baseStop({ service_type: 'Lawn Care', route_order: null });
    await mockPg('scheduled_services').insert([anchor, companion]);
    const reorder = await mockPg.transaction();
    try {
      await lockTechDays(reorder, [{ techId: technicianId, date }]);
      await expect(mockPg.transaction(trx => persistCapacityAllocation(trx, anchor, [anchor.id, companion.id])))
        .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
      expect((await mockPg('scheduled_services').where({ id: companion.id }).first()).route_order).toBeNull();
    } finally { await reorder.rollback(); }
  });

  test('same-day insertion persists the completed prefix before pending work', async () => {
    const { evaluateArrivalPlacement, persistArrivalOrder } = require('../services/scheduling/arrival-route');
    const { lockTechDays } = require('../services/scheduling/tech-day-lock');
    const { parseETDateTime } = require('../utils/datetime-et');
    const first = baseStop({ status: 'completed', route_order: 1, actual_end_time: parseETDateTime(`${date}T08:30`) });
    const second = baseStop({ status: 'completed', window_start: '09:00', window_end: '09:30', route_order: 2,
      actual_end_time: parseETDateTime(`${date}T09:30`) });
    const pending = baseStop({ window_start: '13:00', window_end: '13:30', route_order: 3 });
    const candidate = baseStop({ window_start: '12:00', window_end: '12:30', route_order: null });
    const fit = evaluateArrivalPlacement({ date, now: parseETDateTime(`${date}T11:00`),
      target: { ...candidate, id: '__candidate__' }, rows: [first, second, pending], prospective: true },
    { windowStart: '12:00', windowEnd: '12:30', durationMinutes: 30 });
    expect(fit.feasible).toBe(true);
    expect(fit.routeOrder).toEqual([first.id, second.id, '__candidate__', pending.id]);
    await mockPg('scheduled_services').insert([first, second, pending, candidate]);
    await mockPg.transaction(async trx => {
      await lockTechDays(trx, [{ techId: technicianId, date }]);
      await persistArrivalOrder(trx, fit, candidate.id);
    });
    const rows = await mockPg('scheduled_services').orderBy('route_order');
    expect(rows.map(row => row.id)).toEqual([first.id, second.id, candidate.id, pending.id]);
    expect(rows.map(row => row.route_order)).toEqual([1, 2, 3, 4]);
  });

  test('a hold moved to another technician cannot reuse the old route certification', async () => {
    const held = await reserveSlot({ estimateId: estimateIds[0], slotId: signedSlot(estimateIds[0]) });
    const preparedCapacity = await prepareReservationCommit(held.scheduledServiceId);
    await mockPg('scheduled_services').where({ id: held.scheduledServiceId }).update({ technician_id: otherTechId, route_order: null });
    await expect(commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId, preparedCapacity }))
      .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'route_changed' });
    expect((await mockPg('scheduled_services').where({ id: held.scheduledServiceId }).first()).customer_id).toBeNull();
  });

  test.each([false, true])('gate-off changed selection rejects a v2 hold (combined=%s)', async combined => {
    if (combined) await mockPg('estimates').where({ id: estimateIds[0] })
      .update({ estimate_data: estimateData(['pest_control', 'lawn_care']) });
    const held = await reserveSlot({ estimateId: estimateIds[0], slotId: signedSlot(estimateIds[0], combined ? 70 : 30) });
    const preparedCapacity = await prepareReservationCommit(held.scheduledServiceId);
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const changed = estimateData(combined ? ['pest_control', 'lawn_care'] : ['lawn_care']);
    if (combined) changed.result.recurring.services[0].estimatedDurationMinutes = 90;
    await mockPg('estimates').where({ id: estimateIds[0] }).update({ estimate_data: changed });
    await expect(prepareReservationCommit(held.scheduledServiceId))
      .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'service_duration_changed' });
    await expect(commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId, preparedCapacity }))
      .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'service_duration_changed' });
  });

  test('invalid signed offers never prepare route traffic', async () => {
    const optimizer = require('../services/route-optimizer');
    const travel = jest.spyOn(optimizer, 'createSchedulingTravel');
    try {
      const good = signedSlot(estimateIds[0]);
      const bad = good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a');
      await expect(reserveSlot({ estimateId: estimateIds[0], slotId: bad }))
        .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'invalid_offer' });
      expect(travel).not.toHaveBeenCalled();
    } finally { travel.mockRestore(); }
  });

  test('another technician changing their route does not invalidate acceptance', async () => {
    const held = await reserveSlot({ estimateId: estimateIds[0], slotId: signedSlot(estimateIds[0]) });
    const preparedCapacity = await prepareReservationCommit(held.scheduledServiceId);
    await mockPg('scheduled_services').insert(baseStop({ technician_id: otherTechId }));
    const booked = await commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId, preparedCapacity });
    expect(booked.customer_id).toBe(customerId);
  });

  test('a completion holding a route row makes acceptance retry without waiting', async () => {
    const stop = baseStop({ route_order: 1 });
    await mockPg('scheduled_services').insert(stop);
    const held = await reserveSlot({ estimateId: estimateIds[0], slotId: signedSlot(estimateIds[0]) });
    const preparedCapacity = await prepareReservationCommit(held.scheduledServiceId);
    const completion = await mockPg.transaction();
    try {
      await completion('scheduled_services').where({ id: stop.id }).forUpdate().first();
      await expect(commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId, preparedCapacity }))
        .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'route_busy' });
      await completion('scheduled_services').where({ id: stop.id }).update({ status: 'completed' });
      await completion.commit();
      await expect(commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId, preparedCapacity }))
        .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'route_changed' });
    } finally { if (!completion.isCompleted()) await completion.rollback(); }
  });

  test('verified route rows remain locked through order persistence', async () => {
    const { verifyArrivalCapacity, persistArrivalOrder } = require('../services/scheduling/arrival-route');
    const stop = baseStop({ route_order: 1 });
    await mockPg('scheduled_services').insert(stop);
    const held = await reserveSlot({ estimateId: estimateIds[0], slotId: signedSlot(estimateIds[0]) });
    const prepared = await prepareReservationCommit(held.scheduledServiceId);
    await mockPg.transaction(async trx => {
      const fit = await verifyArrivalCapacity(prepared, { conn: trx });
      await expect(mockPg.transaction(other => other('scheduled_services').where({ id: stop.id }).forUpdate().noWait().first()))
        .rejects.toMatchObject({ code: '55P03' });
      await persistArrivalOrder(trx, fit, held.scheduledServiceId);
    });
  });

  test('an unchanged single-service hold keeps its catalog allowance after gate shutdown', async () => {
    const held = await reserveSlot({ estimateId: estimateIds[0], slotId: signedSlot(estimateIds[0]) });
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const booked = await commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId });
    expect(booked).toMatchObject({ estimated_duration_minutes: 30, customer_id: customerId,
      reservation_expires_at: null });
  });

});
