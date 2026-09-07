/** Real conversion on the migrated dev schema; each synthetic case rolls back. */
jest.mock('../models/db', () => new Proxy((...args) => mockPg(...args), {
  get: (_, key) => typeof mockPg[key] === 'function' ? mockPg[key].bind(mockPg) : mockPg[key],
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/new-recurring-welcome-sms', () => ({
  isNewRecurringSignupCandidate: async () => false, sendNewRecurringWelcome: jest.fn(),
}));
jest.mock('../services/account-membership-email', () => ({ sendMembershipStarted: jest.fn() }));
jest.mock('../services/tech-visit-notifications', () => ({ notifyTechVisitChange: async () => {} }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: async () => {} }));
jest.mock('../services/inspection-credit', () => ({ markBookingForInspectionCredit: async () => {} }));
jest.mock('../services/scheduling/blackout-dates', () => ({ isBlackoutDate: async () => false }));
jest.mock('../services/slot-zone', () => ({ resolveEstimateZone: async () => null, zoneSlugOf: () => null }));
jest.mock('../services/estimate-slot-availability', () => ({
  ...jest.requireActual('../services/estimate-slot-availability'),
  resolveEstimateCoords: async () => null,
}));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { addETDays, etDateString, etParts } = require('../utils/datetime-et');
const { capacityForServices } = require('../services/combined-visit-capacity');
const converter = require('../services/estimate-converter');
const { reserveSlot, commitReservation } = require('../services/slot-reservation');
const { resolveEstimateSlotProfile } = require('../services/estimate-slot-availability');
const { signSlotOffer, appendOfferToSlotId } = require('../utils/slot-offer-token');
const AppointmentReminders = require('../services/appointment-reminders');
const connection = process.env.COMBINED_VISIT_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let mockPg;
jest.setTimeout(120000);

const lines = [
  { service: 'pest_control', name: 'Quarterly Pest Control', visitsPerYear: 4, frequency: 'quarterly', catalog: 'pest_general_quarterly', pattern: 'quarterly' },
  { service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 6, frequency: 'bimonthly', catalog: 'lawn_care_recurring', pattern: 'bimonthly' },
  { service: 'tree_shrub', name: 'Tree & Shrub', visitsPerYear: 9, frequency: 'every_6_weeks', catalog: 'tree_shrub_6week', pattern: 'every_6_weeks' },
  { service: 'mosquito', name: 'Monthly Mosquito Control', visitsPerYear: 12, frequency: 'monthly', catalog: 'mosquito_monthly', pattern: 'monthly' },
];

async function fixture(trx, selected) {
  const customerId = randomUUID();
  const technicianId = randomUUID();
  const estimateId = randomUUID();
  let visitDate = addETDays(new Date(), 14);
  while ([0, 6].includes(etParts(visitDate).dayOfWeek)) visitDate = addETDays(visitDate, 1);
  const date = etDateString(visitDate);
  await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
    email: `${customerId}@example.invalid`, phone: '+19415550100', active: true, property_type: 'residential',
    address_line1: '100 Example Court', city: 'Parrish', state: 'FL', zip: '34219',
    pipeline_stage: 'active_customer', autopay_enabled: false });
  await trx('technicians').insert({ id: technicianId, name: 'Synthetic Technician',
    email: `${technicianId}@example.invalid`, password_hash: 'synthetic-not-a-login-hash', role: 'technician', active: true,
    employment_status: 'active', field_dispatchable: true });
  await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted',
    token: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
    category: 'RESIDENTIAL', monthly_total: selected.length * 50, annual_total: selected.length * 600,
    estimate_data: { result: { recurring: { services: selected.map(({ catalog, pattern, ...line }) => ({
      ...line, annual: 600, mo: 50, perTreatment: 600 / line.visitsPerYear,
    })) } } } });
  const service = await trx('services').where({ service_key: selected[0].catalog }).first();
  if (!service) throw new Error('Migrated fixture catalog is missing');
  const [anchor] = await trx('scheduled_services').insert({ customer_id: null, technician_id: technicianId,
    source_estimate_id: estimateId, service_id: service.id, service_key_snapshot: service.service_key,
    service_type: selected[0].name, scheduled_date: date, window_start: '09:00',
    window_end: `${String(9 + selected.length).padStart(2, '0')}:00`, status: 'pending',
    reservation_expires_at: new Date(Date.now() + 15 * 60000),
    estimated_duration_minutes: selected.length * 60, reservation_service_mix: capacityForServices(selected),
  }).returning('*');
  return { customerId, estimateId, anchor, date };
}

const options = { skipSetupInvoice: true, autoSendInvoice: false, skipMembershipEmail: true,
  deferFollowUpReminderRegistration: true, deferCommercialScheduleNotification: true };

postgres('combined capacity conversion on the migrated application schema', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!local && !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) throw new Error('Use the verified private dev database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    process.env.GATE_SEPARATE_COMBO_VISITS = 'true';
    expect(await mockPg.schema.hasColumn('scheduled_services', 'reservation_service_mix')).toBe(true);
  });
  afterAll(async () => {
    delete process.env.GATE_VISIT_COMBINED_CAPACITY;
    delete process.env.GATE_SEPARATE_COMBO_VISITS;
    if (mockPg) await mockPg.destroy();
  });

  test.each([
    ['two services', lines.slice(0, 2)],
    ...[['monthly', 12], ['bimonthly', 6]].map(([pattern, visits]) => [
      `${pattern} pest with lawn`, [{ ...lines[0], visitsPerYear: visits, frequency: pattern,
        name: `${pattern} Pest Control`, catalog: `pest_general_${pattern}`, pattern }, lines[1]],
    ]),
    ['three services', lines.slice(0, 3)],
    ['four services', lines],
    ['lawn and tree with different cadences', [lines[1], lines[2]]],
    ['pest and tree without lawn', [lines[0], lines[2]]],
    ['pest and termite with rental and bond billing riders', [lines[0], {
      service: 'termite_bait', name: 'Termite Bait', visitsPerYear: 4, frequency: 'quarterly',
      catalog: 'termite_bait', pattern: 'quarterly',
    }], ['termite_station_rental', 'termite_bond_1yr']],
    ...['scalar', 'pinned'].map((shape) => [`pest and lawn with legacy ${shape} rodent`, [...lines.slice(0, 2), {
      service: 'rodent_bait', name: 'Rodent Bait', visitsPerYear: 4, frequency: 'quarterly',
      catalog: 'rodent_bait_quarterly', pattern: 'quarterly',
    }], [], shape]),
  ])('%s keep separate identities, sequential hours and their own cadences', async (_, selected, riders = [], legacyRodent = null) => {
    const trx = await mockPg.transaction();
    try {
      const count = selected.length;
      const f = await fixture(trx, selected);
      await trx('customers').where({ id: f.customerId }).update({ autopay_enabled: true });
      if (riders.length || legacyRodent) {
        const estimate = await trx('estimates').where({ id: f.estimateId }).first();
        estimate.estimate_data.result.recurring.services.push(...riders.map((service) => ({
          service, name: service, visitsPerYear: 4, annual: 120, mo: 10, perTreatment: 30,
        })));
        if (legacyRodent) {
          const recurring = estimate.estimate_data.result.recurring;
          recurring.services = recurring.services.filter((row) => row.service !== 'rodent_bait');
          if (legacyRodent === 'scalar') recurring.rodentBaitMo = 50;
          else recurring.services.push({ service: 'rodent_bait', name: 'Rodent Bait', mo: 50, legacyPinnedReplay: true });
        }
        await trx('estimates').where({ id: f.estimateId }).update({ estimate_data: estimate.estimate_data });
      }
      // Exercise the real public-accept transaction boundary: graduate the
      // hold, then convert using that same transaction.
      delete process.env.GATE_VISIT_COMBINED_CAPACITY;
      await commitReservation({ scheduledServiceId: f.anchor.id, customerId: f.customerId, trx });
      await converter.convertEstimate(f.estimateId, { ...options, database: trx });
      const parents = await trx('scheduled_services').where({ source_estimate_id: f.estimateId })
        .whereNull('recurring_parent_id').orderBy('window_start');
      expect(parents).toHaveLength(count);
      expect(parents.map((p) => p.window_start)).toEqual(['09:00:00', '10:00:00', '11:00:00', '12:00:00'].slice(0, count));
      expect(parents.map((p) => p.window_end)).toEqual(['10:00:00', '11:00:00', '12:00:00', '13:00:00'].slice(0, count));
      expect(parents.map((p) => p.estimated_duration_minutes)).toEqual(selected.map(() => 60));
      const stamp = parents.find((p) => p.id === f.anchor.id).reservation_service_mix;
      expect(new Set(stamp.allocatedServiceIds)).toEqual(new Set(parents.map((p) => p.id)));
      for (const parent of parents) {
        await expect(AppointmentReminders.resolveCommittedVisitTime(parent.id, {}, trx))
          .resolves.toEqual({ appointmentTime: `${f.date}T09:00`, windowless: false });
        // The public accept registrar uses registerAppointment after commit.
        // Point its shared connection at this test transaction so the real
        // registrar and confirmation formatter see the synthetic rows.
        const pool = mockPg;
        mockPg = trx;
        try {
          const registered = await AppointmentReminders.registerAppointment(
            parent.id, f.customerId, `${f.date}T${parent.window_start}`,
            parent.service_type, 'estimate_accept_slot',
            { sendConfirmation: false, fromCommittedRow: true },
          );
          expect(registered).not.toBeNull();
          await expect(AppointmentReminders.confirmationArrivalWindow({ scheduledServiceId: parent.id, windowStart: parent.window_start }))
            .resolves.toBe('between 9:00 AM and 11:00 AM');
        } finally { mockPg = pool; }
      }
      const reminders = await trx('appointment_reminders').where({ customer_id: f.customerId });
      expect(reminders).toHaveLength(count);
      expect(new Set(reminders.map((r) => r.appointment_time.toISOString())).size).toBe(1);
      expect(reminders.filter((r) => !r.suppressed_by_sibling)).toHaveLength(1);
      for (const line of selected) {
        const catalog = await trx('services').where({ service_key: line.catalog }).first('id');
        const parent = parents.find((p) => p.service_id === catalog.id);
        expect(parent).toBeDefined();
        expect(parent.recurring_pattern).toBe(line.pattern);
        const children = await trx('scheduled_services').where({ recurring_parent_id: parent.id });
        expect(children.length).toBeGreaterThan(0);
        expect(children.every((row) => row.service_id === catalog.id && row.recurring_pattern === line.pattern)).toBe(true);
        expect(children.every((row) => row.reservation_service_mix == null)).toBe(true);
      }
    } finally { await trx.rollback(); }
  });

  test.each([
    ['standard', 6, 'bimonthly'],
    ['enhanced', 9, 'every_6_weeks'], ['premium', 12, 'monthly'],
  ])('generated lawn tier %s survives reserve, acceptance rewrite and conversion with its companion', async (tier, visits, pattern) => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    try {
      const f = await fixture(trx, [lines[1], lines[2]]);
      await trx('scheduled_services').where({ id: f.anchor.id }).del();
      await trx('estimates').where({ id: f.estimateId }).update({ status: 'sent' });
      const estimate = await trx('estimates').where({ id: f.estimateId }).first();
      const profile = resolveEstimateSlotProfile(estimate, { selectedFrequency: tier });
      expect(profile.durationMinutes).toBe(120);
      expect(profile.services.map((row) => [row.service, row.visitsPerYear]))
        .toEqual([['lawn_care', visits], ['tree_shrub', 9]]);
      const offer = signSlotOffer({ surface: 'estimate', scopeId: f.estimateId, date: f.date,
        startMinutes: 540, technicianId: f.anchor.technician_id, durationMinutes: profile.durationMinutes });
      const slotId = appendOfferToSlotId(`${f.date}_09-00_${f.anchor.technician_id}`, offer);
      const held = await reserveSlot({ estimateId: f.estimateId, slotId, selectedFrequency: tier });
      const hold = await trx('scheduled_services').where({ id: held.scheduledServiceId }).first();
      expect(hold.window_end).toBe('11:00:00');
      expect(hold.reservation_service_mix.services).toEqual(['lawn_care', 'tree_shrub']);
      const { applySelectedLawnTierToEstimateData } = require('../routes/estimate-public');
      const acceptedData = applySelectedLawnTierToEstimateData(estimate.estimate_data, {
        key: tier, serviceCategory: 'lawn_care', visitsPerYear: visits,
        monthly: 50, annual: 600, perTreatment: 600 / visits,
      });
      await trx('estimates').where({ id: f.estimateId }).update({ status: 'accepted', estimate_data: acceptedData });
      delete process.env.GATE_VISIT_COMBINED_CAPACITY;
      await commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: f.customerId,
        selectedFrequency: tier, trx });
      await converter.convertEstimate(f.estimateId, { ...options, database: trx });
      const parents = await trx('scheduled_services').where({ source_estimate_id: f.estimateId })
        .whereNull('recurring_parent_id').orderBy('window_start');
      expect(parents).toHaveLength(2);
      expect(parents.map((row) => [row.window_start, row.window_end]))
        .toEqual([['09:00:00', '10:00:00'], ['10:00:00', '11:00:00']]);
      expect(parents.map((row) => row.recurring_pattern)).toEqual([pattern, 'every_6_weeks']);
      for (const row of parents) {
        expect(row.reservation_service_mix.allocatedServiceIds).toEqual(parents.map((member) => member.id));
        const children = await trx('scheduled_services').where({ recurring_parent_id: row.id });
        expect(children.length).toBeGreaterThan(0);
        expect(children.every((child) => child.recurring_pattern === row.recurring_pattern)).toBe(true);
      }
    } finally { mockPg = pool; await trx.rollback(); }
  });

  test('the retired quarterly lawn tier is refused before reserving combined work', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    try {
      const f = await fixture(trx, [lines[1], lines[2]]);
      await trx('scheduled_services').where({ id: f.anchor.id }).del();
      await trx('estimates').where({ id: f.estimateId }).update({ status: 'sent' });
      const estimate = await trx('estimates').where({ id: f.estimateId }).first();
      expect(() => resolveEstimateSlotProfile(estimate, { selectedFrequency: 'basic' }))
        .toThrow(expect.objectContaining({ code: 'COMBINED_VISIT_UNAVAILABLE' }));
      const offer = signSlotOffer({ surface: 'estimate', scopeId: f.estimateId, date: f.date,
        startMinutes: 540, technicianId: f.anchor.technician_id, durationMinutes: 120 });
      const slotId = appendOfferToSlotId(`${f.date}_09-00_${f.anchor.technician_id}`, offer);
      await expect(reserveSlot({ estimateId: f.estimateId, slotId, selectedFrequency: 'basic' }))
        .rejects.toMatchObject({ code: 'COMBINED_VISIT_UNAVAILABLE' });
      expect(await trx('scheduled_services').where({ source_estimate_id: f.estimateId })).toHaveLength(0);
    } finally { mockPg = pool; await trx.rollback(); }
  });

  test('retrying conversion preserves the same members, hours and recurring series', async () => {
    const trx = await mockPg.transaction();
    try {
      const f = await fixture(trx, lines.slice(0, 2));
      await commitReservation({ scheduledServiceId: f.anchor.id, customerId: f.customerId, trx });
      await converter.convertEstimate(f.estimateId, { ...options, database: trx });
      const before = await trx('scheduled_services').where({ source_estimate_id: f.estimateId })
        .orderBy('id').select('id', 'service_id', 'recurring_parent_id', 'recurring_pattern',
          'scheduled_date', 'window_start', 'window_end', 'reservation_service_mix');
      await converter.convertEstimate(f.estimateId, { ...options, database: trx });
      const after = await trx('scheduled_services').where({ source_estimate_id: f.estimateId })
        .orderBy('id').select('id', 'service_id', 'recurring_parent_id', 'recurring_pattern',
          'scheduled_date', 'window_start', 'window_end', 'reservation_service_mix');
      expect(after).toEqual(before);
    } finally { await trx.rollback(); }
  });

  test('an unfulfillable member rolls back the graduated hold and every seeded row', async () => {
    let f;
    await expect(mockPg.transaction(async (trx) => {
      f = await fixture(trx, lines.slice(0, 3));
      await commitReservation({ scheduledServiceId: f.anchor.id, customerId: f.customerId, trx });
      // A missing catalog binding must abort after the other programs seed.
      await trx('scheduled_services').where({ id: f.anchor.id }).update({ service_id: null });
      await converter.convertEstimate(f.estimateId, { ...options, database: trx });
    })).rejects.toMatchObject({ code: 'COMBINED_VISIT_UNAVAILABLE' });
    expect(await mockPg('scheduled_services').where({ source_estimate_id: f.estimateId })).toHaveLength(0);
    expect(await mockPg('customers').where({ id: f.customerId })).toHaveLength(0);
  });
});
