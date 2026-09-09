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

});
