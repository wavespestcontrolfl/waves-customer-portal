/** Real reservation transactions in an isolated schema; no provider calls or application DATABASE_URL. */
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => false, gateEnvValue: () => false }));
jest.mock('../services/scheduling/blackout-dates', () => ({ isBlackoutDate: async () => false }));
jest.mock('../services/slot-zone', () => ({ resolveEstimateZone: async () => null, zoneSlugOf: () => null }));
jest.mock('../services/inspection-credit', () => ({ markBookingForInspectionCredit: async () => {} }));
jest.mock('../services/tech-visit-notifications', () => ({ notifyTechVisitChange: async () => {} }));
jest.mock('../services/estimate-slot-availability', () => ({
  ...jest.requireActual('../services/estimate-slot-availability'),
  resolveEstimateCoords: async () => null,
}));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { reserveSlot, commitReservation } = require('../services/slot-reservation');
const { _internals: { filterCollidingSlots } } = require('../services/estimate-slot-availability');
const { signSlotOffer, appendOfferToSlotId } = require('../utils/slot-offer-token');
const { addETDays, etDateString } = require('../utils/datetime-et');
const migration = require('../models/migrations/20260906000010_reservation_service_mix');
const connection = process.env.COMBINED_VISIT_TEST_DATABASE_URL;
jest.setTimeout(30000);
const postgres = connection ? describe : describe.skip;
const schema = `visit_capacity_${randomUUID().replaceAll('-', '')}`;
const technicianId = randomUUID();
const customerId = randomUUID();
const firstEstimateId = randomUUID();
const secondEstimateId = randomUUID();
const date = etDateString(addETDays(new Date(), 14));
let admin;
let mockPg;

function estimateData(keys = ['pest_control', 'lawn_care']) {
  return { result: { recurring: { services: keys.map((service) => ({ service, name: service, visitsPerYear: 4 })) } } };
}

function signedSlot(estimateId, start = '09:00', durationMinutes = 120) {
  const offer = signSlotOffer({ surface: 'estimate', scopeId: String(estimateId), date,
    startMinutes: Number(start.slice(0, 2)) * 60, technicianId, durationMinutes });
  return appendOfferToSlotId(`${date}_${start.replace(':', '-')}_${technicianId}`, offer);
}

postgres('combined booking capacity on PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    const localTest = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/waves_test';
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!localTest && !privateQa) throw new Error('Use a verified nonproduction, task-private QA database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 4 } });
    await mockPg.schema.createTable('estimates', (t) => {
      t.uuid('id').primary(); t.uuid('customer_id'); t.text('address'); t.text('service_interest');
      t.text('status'); t.jsonb('estimate_data'); t.timestamp('expires_at'); t.timestamp('archived_at');
    });
    await mockPg.schema.createTable('technicians', (t) => {
      t.uuid('id').primary(); t.text('name'); t.text('role'); t.text('employment_status'); t.boolean('field_dispatchable'); t.boolean('active');
    });
    await mockPg.schema.createTable('technician_capabilities', (t) => {
      t.uuid('technician_id'); t.text('service_category'); t.boolean('active');
      t.unique(['technician_id', 'service_category']);
    });
    await mockPg.schema.createTable('services', (t) => {
      t.uuid('id').primary(); t.text('service_key'); t.text('name'); t.boolean('is_active'); t.jsonb('engine_keys');
    });
    await mockPg.schema.createTable('customers', (t) => { t.uuid('id').primary(); t.text('city'); });
    await mockPg.schema.createTable('scheduled_services', (t) => {
      t.uuid('id').primary().defaultTo(mockPg.raw('gen_random_uuid()'));
      for (const c of ['customer_id', 'technician_id', 'service_id', 'recurring_parent_id']) t.uuid(c);
      t.uuid('source_estimate_id'); t.date('scheduled_date'); t.time('window_start'); t.time('window_end');
      for (const c of ['service_type', 'status', 'notes', 'zone', 'service_key_snapshot', 'payment_method_preference']) t.text(c);
      t.integer('estimated_duration_minutes'); t.decimal('estimated_price', 12, 2);
      t.boolean('is_recurring').defaultTo(false); t.boolean('customer_confirmed').defaultTo(false);
      t.decimal('lat'); t.decimal('lng'); t.timestamp('reservation_expires_at'); t.timestamps(true, true);
    });
    await migration.up(mockPg);
    await migration.up(mockPg);
    await mockPg('technicians').insert({ id: technicianId, name: 'Fixture Technician', role: 'technician', employment_status: 'active', field_dispatchable: true, active: true });
    await mockPg('customers').insert({ id: customerId, city: 'Fixture City' });
    await mockPg('services').insert({ id: randomUUID(), name: 'Quarterly Pest Control', service_key: 'pest_general_quarterly', is_active: true, engine_keys: JSON.stringify(['pest_control']) });
  }, 60000);

  afterAll(async () => {
    delete process.env.GATE_SEPARATE_COMBO_VISITS;
    delete process.env.GATE_VISIT_COMBINED_CAPACITY;
    if (mockPg) await mockPg.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  beforeEach(async () => {
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    process.env.GATE_SEPARATE_COMBO_VISITS = 'true';
    await mockPg('scheduled_services').del();
    await mockPg('technician_capabilities').del();
    await mockPg('estimates').del();
    await mockPg('estimates').insert([firstEstimateId, secondEstimateId].map((id) => ({ id, customer_id: customerId, status: 'sent',
      estimate_data: estimateData(), expires_at: addETDays(new Date(), 30) })));
  });

  test('migration rollback and reapplication work transactionally', async () => {
    await mockPg.transaction(async (trx) => {
      await migration.down(trx);
      expect(await trx.schema.hasColumn('scheduled_services', 'reservation_service_mix')).toBe(false);
      await migration.up(trx);
      expect(await trx.schema.hasColumn('scheduled_services', 'reservation_service_mix')).toBe(true);
    });
  });

  test('reserve and retry keep one full block; gate-off acceptance preserves its capacity and JSONB mix', async () => {
    const held = await reserveSlot({ estimateId: firstEstimateId, slotId: signedSlot(firstEstimateId) });
    const retried = await reserveSlot({ estimateId: firstEstimateId, slotId: signedSlot(firstEstimateId) });
    expect(retried.scheduledServiceId).toBe(held.scheduledServiceId);
    delete process.env.GATE_VISIT_COMBINED_CAPACITY;
    const booked = await commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId });
    expect(booked.window_start).toBe('09:00:00');
    expect(booked.window_end).toBe('11:00:00');
    expect(booked.estimated_duration_minutes).toBe(120);
    expect(booked.reservation_service_mix.services).toEqual(['pest_control', 'lawn_care']);
    expect(booked.reservation_expires_at).toBeNull();
    expect((await mockPg('scheduled_services')).length).toBe(1);
  });

  test('unassigned work in the second service hour prevents reservation', async () => {
    await mockPg('scheduled_services').insert({ customer_id: customerId, scheduled_date: date,
      window_start: '10:00', window_end: '11:00', status: 'pending', service_type: 'Fixture work' });
    await expect(reserveSlot({ estimateId: firstEstimateId, slotId: signedSlot(firstEstimateId) })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect((await mockPg('scheduled_services').whereNotNull('reservation_expires_at')).length).toBe(0);
  });

  test('concurrent reservations cannot both claim the combined block', async () => {
    const results = await Promise.allSettled([firstEstimateId, secondEstimateId].map((estimateId) => reserveSlot({ estimateId, slotId: signedSlot(estimateId) })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await mockPg('scheduled_services')).length).toBe(1);
  });

  test('acceptance rechecks additional service capacity against unassigned work', async () => {
    const held = await reserveSlot({ estimateId: firstEstimateId, slotId: signedSlot(firstEstimateId) });
    await mockPg('estimates').where({ id: firstEstimateId }).update({ estimate_data: estimateData(['pest_control', 'lawn_care', 'tree_shrub']) });
    await mockPg('scheduled_services').insert({ customer_id: customerId, scheduled_date: date,
      window_start: '11:00', window_end: '12:00', status: 'pending', service_type: 'Fixture work' });
    await expect(commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    const row = await mockPg('scheduled_services').where({ id: held.scheduledServiceId }).first();
    expect(row.customer_id).toBeNull();
    expect(row.reservation_expires_at).not.toBeNull();
    expect(row.window_end).toBe('11:00:00');
  });

  test('a service category turned off after reservation refuses acceptance', async () => {
    const held = await reserveSlot({ estimateId: firstEstimateId, slotId: signedSlot(firstEstimateId) });
    await mockPg('technician_capabilities').insert({ technician_id: technicianId, service_category: 'lawn', active: false });
    await expect(commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId })).rejects.toMatchObject({ code: 'COMBINED_VISIT_UNAVAILABLE' });
    expect((await mockPg('scheduled_services').where({ id: held.scheduledServiceId }).first()).customer_id).toBeNull();
  });

  test('offer filtering excludes unassigned and category-disabled technicians', async () => {
    const slot = { date, windowStart: '09:00', windowEnd: '11:00', techId: technicianId };
    const opts = { dateFrom: date, dateTo: date, serviceMix: { services: ['pest_control', 'lawn_care'] } };
    expect(await filterCollidingSlots([slot, { ...slot, techId: null }], opts)).toEqual([slot]);
    await mockPg('technician_capabilities').insert({ technician_id: technicianId, service_category: 'lawn', active: false });
    expect(await filterCollidingSlots([slot], opts)).toEqual([]);
  });
});
