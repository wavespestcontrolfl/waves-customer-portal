/**
 * Reserved-accept first-visit grouping (fix/first-visit-grouping-at-accept):
 * a slot-reserved estimate accept that ALSO promotes a same-trip standalone
 * unit (pest reserved start + a rodent-bait standalone supplement,
 * STANDALONE_SUPPLEMENT_ROUTES.rodent_bait) must land both first-visit rows
 * in one visit group (shared scheduled_services.visit_id) — the same way
 * their seeded later-quarter children already do.
 *
 * Before the fix: the promoted row's own maybeGroupRow call runs while the
 * reserved start still carries no usable catalog identity (only stamped
 * later, when the reserved-block relinks it to its cadence catalog row), so
 * the partner query never finds it and nothing groups. Real conversion
 * against the migrated schema — no mocked SQL.
 */
jest.mock('../models/db', () => new Proxy((...args) => mockPg(...args), {
  get: (_, key) => (typeof mockPg[key] === 'function' ? mockPg[key].bind(mockPg) : mockPg[key]),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/new-recurring-welcome-sms', () => ({
  isNewRecurringSignupCandidate: async () => false, sendNewRecurringWelcome: jest.fn(),
}));
jest.mock('../services/account-membership-email', () => ({ sendMembershipStarted: jest.fn() }));
jest.mock('../services/tech-visit-notifications', () => ({ notifyTechVisitChange: async () => {} }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: async () => {} }));
jest.mock('../services/inspection-credit', () => ({ markBookingForInspectionCredit: async () => {} }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { addETDays, etDateString, etParts } = require('../utils/datetime-et');
const converter = require('../services/estimate-converter');

const connection = process.env.FIRST_VISIT_GROUPING_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let mockPg;
jest.setTimeout(60000);

const options = {
  skipSetupInvoice: true, autoSendInvoice: false, skipMembershipEmail: true,
  deferFollowUpReminderRegistration: true, deferCommercialScheduleNotification: true,
};

postgres('reserved accept groups a same-trip promoted unit with the reserved start', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!local && !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) throw new Error('Use the verified private dev database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    expect(await mockPg.schema.hasColumn('scheduled_services', 'visit_id')).toBe(true);
    expect(await mockPg.schema.hasTable('service_visits')).toBe(true);
  });

  afterAll(async () => {
    if (mockPg) await mockPg.destroy();
  });

  /** A single reserved-slot pest visit (no catalog identity yet — the
   * diagnosed gap) plus a rodentBaitMo supplement that promotes as its own
   * same-trip standalone unit. */
  async function buildFixture(trx, { autopayEnabled = false } = {}) {
    const customerId = randomUUID();
    const technicianId = randomUUID();
    const propertyId = randomUUID();
    const estimateId = randomUUID();
    let visitDate = addETDays(new Date(), 21);
    while ([0, 6].includes(etParts(visitDate).dayOfWeek)) visitDate = addETDays(visitDate, 1);
    const date = etDateString(visitDate);

    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Grouping',
      email: `${customerId}@example.invalid`, phone: '+19415550199', active: true,
      property_type: 'residential', address_line1: '200 Example Court', city: 'Parrish',
      state: 'FL', zip: '34219', pipeline_stage: 'active_customer', autopay_enabled: autopayEnabled,
    });
    await trx('technicians').insert({
      id: technicianId, name: 'Synthetic Technician', email: `${technicianId}@example.invalid`,
      password_hash: 'synthetic-not-a-login-hash', role: 'technician', active: true,
      employment_status: 'active', field_dispatchable: true,
    });
    await trx('customer_properties').insert({
      id: propertyId, customer_id: customerId, is_primary: true, active: true,
      address_line1: '200 Example Court', city: 'Parrish', state: 'FL', zip: '34219',
      source: 'estimate_accept',
    });
    await trx('estimates').insert({
      id: estimateId, customer_id: customerId, property_id: propertyId, status: 'accepted',
      token: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
      category: 'RESIDENTIAL', monthly_total: 90, annual_total: 1080,
      estimate_data: {
        result: {
          recurring: {
            services: [{
              service: 'pest_control', name: 'Quarterly Pest Control', visitsPerYear: 4,
              frequency: 'quarterly', annual: 480, mo: 40, perTreatment: 120,
            }],
            // Server-priced rodent bait rides OUTSIDE recurring.services —
            // supplementalCompanionLines picks this up and it promotes as
            // its own standalone same-trip unit (rodent_bait_quarterly).
            rodentBaitMo: 20,
          },
        },
      },
    });
    // The already-reserved first-visit row, exactly as a plain (non-
    // combined) reserved accept leaves it going into conversion: customer
    // bound, hold cleared, property linked — but NO catalog identity yet
    // (the diagnosed gap: the reservation resolver only stamps service_id
    // for engine-keyed one-time rows; a recurring cadence hold gets its
    // identity from the reserved-block's catalog relink INSIDE the
    // converter, which runs after this row is already committed).
    const [anchor] = await trx('scheduled_services').insert({
      customer_id: customerId, property_id: propertyId, technician_id: technicianId,
      source_estimate_id: estimateId, service_id: null, service_type: 'Quarterly Pest Control',
      scheduled_date: date, window_start: '09:00', window_end: '10:00', status: 'pending',
      reservation_expires_at: null, estimated_duration_minutes: 60,
    }).returning('*');
    return { customerId, technicianId, propertyId, estimateId, anchor, date };
  }

  test('pest reserved start + promoted rodent-bait supplement share one visit', async () => {
    const trx = await mockPg.transaction();
    const gates = require('../config/feature-gates').gates;
    const originalVisitGroups = gates.visitGroups;
    Object.assign(gates, { visitGroups: true });
    try {
      const f = await buildFixture(trx);

      await converter.convertEstimate(f.estimateId, { ...options, database: trx });

      const parents = await trx('scheduled_services')
        .where({ source_estimate_id: f.estimateId })
        .whereNull('recurring_parent_id')
        .orderBy('id');
      expect(parents).toHaveLength(2);

      const reservedRow = parents.find((row) => row.id === f.anchor.id);
      const rodentRow = parents.find((row) => row.id !== f.anchor.id);
      expect(reservedRow).toBeDefined();
      expect(rodentRow).toBeDefined();

      // The reserved-block relink still ran (unaffected by this fix): the
      // reserved row's identity is now the quarterly catalog row.
      const pestCatalog = await trx('services').where({ service_key: 'pest_general_quarterly' }).first();
      expect(reservedRow.service_id).toBe(pestCatalog.id);
      const rodentCatalog = await trx('services').where({ service_key: 'rodent_bait_quarterly' }).first();
      expect(rodentRow.service_id).toBe(rodentCatalog.id);
      // Same trip: same date/window/technician on both first-visit rows.
      expect(rodentRow.scheduled_date).toEqual(reservedRow.scheduled_date);
      expect(rodentRow.window_start).toBe(reservedRow.window_start);
      expect(rodentRow.technician_id).toBe(reservedRow.technician_id);

      // THE FIX: both first-visit rows share one visit group.
      expect(reservedRow.visit_id).not.toBeNull();
      expect(rodentRow.visit_id).not.toBeNull();
      expect(rodentRow.visit_id).toBe(reservedRow.visit_id);

      const visit = await trx('service_visits').where({ id: reservedRow.visit_id }).first();
      expect(visit).toBeDefined();
      expect(visit.status).toBe('open');
    } finally {
      await trx.rollback();
      Object.assign(gates, { visitGroups: originalVisitGroups });
    }
  });

  // The real prod pair this bug was found from is an autopay customer.
  // With visit closeout OFF, autopay customers are excluded from grouping
  // by design (customerExcludedByAutopay) — so this assertion needs
  // closeout ON to actually exercise the fix for that customer.
  test('groups an autopay customer once visit closeout is enabled', async () => {
    const trx = await mockPg.transaction();
    const gates = require('../config/feature-gates').gates;
    const originalVisitGroups = gates.visitGroups;
    const originalCloseoutEnv = process.env.GATE_VISIT_CLOSEOUT;
    const originalVaultKey = process.env.DATA_HYGIENE_VAULT_KEY;
    Object.assign(gates, { visitGroups: true });
    process.env.GATE_VISIT_CLOSEOUT = 'true';
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-test-vault-key';
    try {
      const f = await buildFixture(trx, { autopayEnabled: true });

      await converter.convertEstimate(f.estimateId, { ...options, database: trx });

      const parents = await trx('scheduled_services')
        .where({ source_estimate_id: f.estimateId })
        .whereNull('recurring_parent_id')
        .orderBy('id');
      expect(parents).toHaveLength(2);
      const reservedRow = parents.find((row) => row.id === f.anchor.id);
      const rodentRow = parents.find((row) => row.id !== f.anchor.id);
      expect(reservedRow.visit_id).not.toBeNull();
      expect(rodentRow.visit_id).toBe(reservedRow.visit_id);
    } finally {
      await trx.rollback();
      Object.assign(gates, { visitGroups: originalVisitGroups });
      if (originalCloseoutEnv === undefined) delete process.env.GATE_VISIT_CLOSEOUT;
      else process.env.GATE_VISIT_CLOSEOUT = originalCloseoutEnv;
      if (originalVaultKey === undefined) delete process.env.DATA_HYGIENE_VAULT_KEY;
      else process.env.DATA_HYGIENE_VAULT_KEY = originalVaultKey;
    }
  });
});
