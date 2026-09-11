/** Shared real-Postgres fixture for scheduling-capacity suites. */
let mockPg;
let mockBeforeOuterCommit;
jest.mock('../../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  db.transaction = async (...args) => {
    if (!mockBeforeOuterCommit || typeof args[0] !== 'function') return mockPg.transaction(...args);
    const trx = await mockPg.transaction();
    try {
      const value = await args[0](trx);
      // Catalog resolution may open an earlier transaction. Consume the
      // pause only after reserve's write body has returned its hold id.
      if (value?.scheduledServiceId) {
        const hook = mockBeforeOuterCommit;
        mockBeforeOuterCommit = null;
        await hook(trx, value);
      }
      await trx.commit();
      return value;
    } catch (error) {
      if (!trx.isCompleted()) await trx.rollback();
      throw error;
    }
  };
  Object.defineProperty(db, 'fn', { get: () => mockPg.fn });
  return db;
});
jest.mock('../../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../services/slot-zone', () => ({ resolveEstimateZone: async () => null, zoneSlugOf: () => null }));
jest.mock('../../services/inspection-credit', () => ({ markBookingForInspectionCredit: async () => {} }));
jest.mock('../../services/tech-visit-notifications', () => ({
  notifyTechVisitChange: async () => {}, notifyAssignmentChange: async () => {},
}));
jest.mock('../../services/estimate-slot-availability', () => ({
  ...jest.requireActual('../../services/estimate-slot-availability'),
  resolveEstimateCoords: async () => require('../../services/route-optimizer').HQ,
}));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const PIN = require('../../services/route-optimizer').HQ;
const { addETDays, etDateString } = require('../../utils/datetime-et');
const { signSlotOffer, appendOfferToSlotId, CAPACITY_OFFER_POLICY } = require('../../utils/slot-offer-token');
const connection = process.env.SCHEDULING_CAPACITY_TEST_DATABASE_URL;
const describeDb = connection ? describe : describe.skip;

function estimateData(keys = ['pest_control']) {
  return { result: { recurring: { services: keys.map(service => ({ service, name: service,
    visitsPerYear: service === 'pest_control' ? 4 : 6 })) } } };
}

function createCapacityDbFixture(prefix = 'scheduling_capacity') {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const date = etDateString(addETDays(new Date(), 14));
  const ids = { technician: randomUUID(), otherTech: randomUUID(), customer: randomUUID(),
    estimates: [randomUUID(), randomUUID()] };
  let admin;
  beforeAll(async () => {
    const target = new URL(connection);
    const localCi = process.env.CI === 'true' && process.env.NODE_ENV === 'test'
      && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!localCi && !/^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname)) {
      throw new Error('Use a verified nonproduction, task-private QA database');
    }
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection: { connectionString: connection, application_name: schema },
      searchPath: [schema], pool: { min: 0, max: 5 } });
    for (const table of ['customers', 'estimates', 'services', 'scheduled_services', 'technicians',
      'technician_capabilities', 'tech_schedule_blocks', 'schedule_blackout_dates', 'system_settings', 'audit_log']) {
      await mockPg.raw('CREATE TABLE ?? (LIKE public.?? INCLUDING ALL)', [table, table]);
    }
    await mockPg.raw('ALTER TABLE scheduled_services ALTER COLUMN id SET DEFAULT gen_random_uuid()');
    await mockPg('technicians').insert([ids.technician, ids.otherTech].map(id => ({ id, name: 'Fixture technician',
      role: 'technician', active: true, employment_status: 'active', field_dispatchable: true })));
    await mockPg('customers').insert({ id: ids.customer, first_name: 'Fixture', last_name: 'Account',
      phone: '+12025550141', email: 'capacity-fixture@example.invalid', city: 'Bradenton', latitude: PIN.lat, longitude: PIN.lng });
    await mockPg('services').insert([
      { id: randomUUID(), service_key: 'pest_general_quarterly', name: 'Quarterly Pest Control', category: 'pest',
        billing_type: 'recurring', is_active: true, engine_keys: JSON.stringify(['pest_control']), default_duration_minutes: 60,
        scheduling_duration_policy: { version: 1, default_duration_minutes: 30, min_duration_minutes: 30, max_duration_minutes: 40 } },
      { id: randomUUID(), service_key: 'lawn_care_recurring', name: 'Lawn Care', category: 'lawn', billing_type: 'recurring',
        is_active: true, engine_keys: JSON.stringify(['lawn_care']), default_duration_minutes: 40 },
    ]);
  });
  afterAll(async () => {
    for (const gate of ['GATE_SCHEDULING_CAPACITY', 'GATE_SEPARATE_COMBO_VISITS', 'GATE_VISIT_COMBINED_CAPACITY']) delete process.env[gate];
    if (mockPg) await mockPg.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });
  beforeEach(async () => {
    mockBeforeOuterCommit = null;
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    process.env.GATE_SEPARATE_COMBO_VISITS = 'true';
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    for (const table of ['scheduled_services', 'estimates', 'tech_schedule_blocks', 'technician_capabilities',
      'schedule_blackout_dates', 'system_settings', 'audit_log']) await mockPg(table).del();
    await mockPg('estimates').insert(ids.estimates.map(id => ({ id, customer_id: ids.customer, status: 'sent',
      estimate_data: estimateData(), expires_at: addETDays(new Date(), 30) })));
  });
  return {
    schema, date, ids, PIN, estimateData,
    get db() { return mockPg; }, get admin() { return admin; },
    // `policy` override lets a test mint an explicit-policy (or, with
    // `policy: null`, a legacy no-policy) offer; by default the offer signs
    // under CAPACITY_OFFER_POLICY whenever the capacity gate is on, matching
    // what reserveSlot verifies against.
    signedSlot(estimateId, durationMinutes = 30, start = '10:00', { policy } = {}) {
      const effectivePolicy = policy !== undefined
        ? policy
        : (process.env.GATE_SCHEDULING_CAPACITY === 'true' ? CAPACITY_OFFER_POLICY : undefined);
      return appendOfferToSlotId(`${date}_${start.replace(':', '-')}_${ids.technician}`,
        signSlotOffer({ surface: 'estimate', scopeId: estimateId, date,
          startMinutes: Number(start.slice(0, 2)) * 60, technicianId: ids.technician, durationMinutes,
          policy: effectivePolicy }));
    },
    baseStop(extra = {}) { return { id: randomUUID(), scheduled_date: date, technician_id: ids.technician,
      customer_id: ids.customer, service_type: 'Pest Control', status: 'confirmed', window_start: '08:00',
      window_end: '08:30', estimated_duration_minutes: 30, ...PIN, ...extra }; },
    beforeNextOuterCommit(hook) { mockBeforeOuterCommit = hook; },
  };
}

module.exports = { createCapacityDbFixture, describeDb };
