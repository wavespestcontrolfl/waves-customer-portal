/**
 * Pest rides the lawn from accept (GATE_PEST_RIDES_LAWN_AT_ACCEPT, owner
 * rulings 2026-10-01). Real conversion against the
 * migrated schema, synthetic customers, every test rolled back.
 *
 * Proves: the accept seeds quarterly pest follow-ups on lawn dates and groups
 * them into the lawn visit; rides_parent_id links the two series; the gate off
 * and every other mix (bi-monthly pest) keep today's quarterly walk. Series
 * EXTENSION riding the lawn is a follow-up PR (branch
 * feat/rider-extension-20261001); the gate stays off until it lands.
 */
jest.mock('../models/db', () => new Proxy((...args) => mockPg(...args), {
  get: (_, key) => (typeof mockPg[key] === 'function' ? mockPg[key].bind(mockPg) : mockPg[key]),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/new-recurring-welcome-sms', () => ({
  isNewRecurringSignupCandidate: async () => false, sendNewRecurringWelcome: jest.fn(),
}));
jest.mock('../services/account-membership-email', () => ({ sendMembershipStarted: jest.fn() }));
jest.mock('../services/tech-visit-notifications', () => ({ notifyTechVisitChange: async () => {} }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: async () => {} }));
jest.mock('../services/inspection-credit', () => ({ markBookingForInspectionCredit: async () => {} }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { addETDays, etDateString, etParts, parseETDateTime } = require('../utils/datetime-et');
const converter = require('../services/estimate-converter');

const connection = process.env.DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let mockPg;
jest.setTimeout(60000);

const options = {
  skipSetupInvoice: true, autoSendInvoice: false, skipMembershipEmail: true,
  deferFollowUpReminderRegistration: true, deferCommercialScheduleNotification: true,
};
const GATE = 'GATE_PEST_RIDES_LAWN_AT_ACCEPT';

const addDays = (d, n) => etDateString(addETDays(parseETDateTime(`${d}T12:00`), n));
const dateOf = (v) => (v instanceof Date ? etDateString(v) : String(v).slice(0, 10));

const LAWN_LINE = {
  service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 9, frequency: 'every_6_weeks', annual: 540, mo: 45, perTreatment: 60,
};
const PEST_QUARTERLY = {
  service: 'pest_control', name: 'Quarterly Pest Control', visitsPerYear: 4, frequency: 'quarterly', annual: 480, mo: 40, perTreatment: 120,
};
const LAWN_MONTHLY = {
  service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 12, frequency: 'monthly', annual: 540, mo: 45, perTreatment: 45,
};
const TERMITE_BAIT_QUARTERLY = {
  service: 'termite_bait', name: 'Termite Bait Station Monitoring', visitsPerYear: 4, frequency: 'quarterly', annual: 480, mo: 40, perTreatment: 120,
};
const PEST_BIMONTHLY = {
  service: 'pest_control', name: 'Bi-Monthly Pest Control', visitsPerYear: 6, frequency: 'bimonthly', annual: 480, mo: 40, perTreatment: 80,
};

postgres('pest rides the lawn from accept', () => {
  let gates;
  let originalVisitGroups;
  let originalGate;

  beforeAll(async () => {
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!localCI && !privateQa) throw new Error('Use disposable CI or this worktree\'s private QA database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    gates = require('../config/feature-gates').gates;
  });

  beforeEach(() => {
    originalVisitGroups = gates.visitGroups;
    originalGate = process.env[GATE];
    Object.assign(gates, { visitGroups: true });
  });

  afterEach(() => {
    Object.assign(gates, { visitGroups: originalVisitGroups });
    if (originalGate === undefined) delete process.env[GATE];
    else process.env[GATE] = originalGate;
  });

  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  function weekdayAhead(days) {
    let d = addETDays(new Date(), days);
    while ([0, 6].includes(etParts(d).dayOfWeek)) d = addETDays(d, 1);
    return etDateString(d);
  }

  async function customerFixture(trx) {
    const customerId = randomUUID();
    const technicianId = randomUUID();
    const propertyId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Rider',
      email: `${customerId}@example.invalid`, phone: '+19415550177', active: true,
      property_type: 'residential', address_line1: '300 Example Court', city: 'Parrish',
      state: 'FL', zip: '34219', pipeline_stage: 'active_customer', autopay_enabled: false,
    });
    await trx('technicians').insert({
      id: technicianId, name: 'Synthetic Technician', email: `${technicianId}@example.invalid`,
      password_hash: 'synthetic-not-a-login-hash', role: 'technician', active: true,
      employment_status: 'active', field_dispatchable: true,
    });
    await trx('customer_properties').insert({
      id: propertyId, customer_id: customerId, is_primary: true, active: true,
      address_line1: '300 Example Court', city: 'Parrish', state: 'FL', zip: '34219', source: 'estimate_accept',
    });
    return { customerId, technicianId, propertyId };
  }

  // Slot-reserved accept: the first pest visit is already on the books, the lawn
  // line promotes as a same-trip standalone row.
  async function reservedAccept(trx, services, { before } = {}) {
    const base = await customerFixture(trx);
    if (before) await before(base);
    const estimateId = randomUUID();
    const date = weekdayAhead(21);
    await trx('estimates').insert({
      id: estimateId, customer_id: base.customerId, property_id: base.propertyId, status: 'accepted',
      token: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
      category: 'RESIDENTIAL', monthly_total: 85, annual_total: 1020,
      estimate_data: { result: { recurring: { services } } },
    });
    const [reserved] = await trx('scheduled_services').insert({
      customer_id: base.customerId, property_id: base.propertyId, technician_id: base.technicianId,
      source_estimate_id: estimateId, service_id: null, service_type: services[0].name,
      scheduled_date: date, window_start: '09:00', window_end: '10:00', status: 'pending',
      reservation_expires_at: null, estimated_duration_minutes: 60,
    }).returning('*');
    await converter.convertEstimate(estimateId, { ...options, database: trx });
    return { ...base, estimateId, date, reserved };
  }

  async function seriesRows(trx, estimateId) {
    const rows = await trx('scheduled_services').where({ source_estimate_id: estimateId }).orderBy('scheduled_date');
    const parents = rows.filter((r) => !r.recurring_parent_id);
    const family = (name) => parents.find((p) => new RegExp(name, 'i').test(p.service_type));
    const lawnParent = family('lawn');
    const pestParent = family('pest');
    return {
      lawnParent,
      pestParent,
      lawn: rows.filter((r) => r.id === lawnParent?.id || r.recurring_parent_id === lawnParent?.id),
      pest: rows.filter((r) => r.id === pestParent?.id || r.recurring_parent_id === pestParent?.id),
    };
  }

  test('gate on: quarterly pest follow-ups land on every other lawn date, grouped, and linked', async () => {
    process.env[GATE] = 'true';
    const trx = await mockPg.transaction();
    try {
      const f = await reservedAccept(trx, [PEST_QUARTERLY, LAWN_LINE]);
      const { lawnParent, pestParent, lawn, pest } = await seriesRows(trx, f.estimateId);
      expect(lawnParent).toBeDefined();
      expect(pestParent.id).toBe(f.reserved.id);

      const lawnDates = lawn.map((r) => dateOf(r.scheduled_date));
      expect(lawnDates.slice(0, 3)).toEqual([f.date, addDays(f.date, 42), addDays(f.date, 84)]);
      expect(pest.map((r) => dateOf(r.scheduled_date))).toEqual([
        f.date, addDays(f.date, 84), addDays(f.date, 168), addDays(f.date, 252),
      ]);

      expect(pestParent.rides_parent_id).toBe(lawnParent.id);
      expect(lawnParent.rides_parent_id).toBeNull();
      // Pest keeps its own identity and cadence.
      expect(pest.every((r) => r.recurring_pattern === 'quarterly' || r.id === pestParent.id)).toBe(true);
      expect(pest.every((r) => /pest/i.test(r.service_type))).toBe(true);

      // Same stop on the same day => one visit group.
      for (const row of pest) {
        const host = lawn.find((l) => dateOf(l.scheduled_date) === dateOf(row.scheduled_date));
        expect(host).toBeDefined();
        expect(row.visit_id).not.toBeNull();
        expect(row.visit_id).toBe(host.visit_id);
      }
    } finally { await trx.rollback(); }
  });

  test('gate on, monthly lawn host: the quarterly pest takes every third lawn date (77-105 day gaps)', async () => {
    process.env[GATE] = 'true';
    const trx = await mockPg.transaction();
    try {
      const f = await reservedAccept(trx, [PEST_QUARTERLY, LAWN_MONTHLY]);
      const { lawnParent, pestParent, lawn, pest } = await seriesRows(trx, f.estimateId);
      expect(pestParent.rides_parent_id).toBe(lawnParent.id);
      const lawnDates = new Set(lawn.map((r) => dateOf(r.scheduled_date)));
      const pestDates = pest.map((r) => dateOf(r.scheduled_date));
      expect(pestDates).toHaveLength(4);
      for (const d of pestDates) expect(lawnDates.has(d)).toBe(true);
      for (let i = 1; i < pestDates.length; i++) {
        const gap = (parseETDateTime(`${pestDates[i]}T12:00`) - parseETDateTime(`${pestDates[i - 1]}T12:00`)) / 86400000;
        expect(gap).toBeGreaterThanOrEqual(77);
        expect(gap).toBeLessThanOrEqual(105);
      }
    } finally { await trx.rollback(); }
  });

  test('gate off: the accept seeds the quarterly walk and links nothing', async () => {
    delete process.env[GATE];
    const trx = await mockPg.transaction();
    try {
      const f = await reservedAccept(trx, [PEST_QUARTERLY, LAWN_LINE]);
      const { pestParent, pest } = await seriesRows(trx, f.estimateId);
      expect(pestParent.rides_parent_id).toBeNull();
      const dates = pest.map((r) => dateOf(r.scheduled_date));
      expect(dates).toHaveLength(4);
      expect(dates).not.toContain(addDays(f.date, 84));
    } finally { await trx.rollback(); }
  });

  test('gate on, bi-monthly pest: unchanged walk, no link', async () => {
    process.env[GATE] = 'true';
    const trx = await mockPg.transaction();
    try {
      const f = await reservedAccept(trx, [PEST_BIMONTHLY, LAWN_LINE]);
      const { pestParent, pest } = await seriesRows(trx, f.estimateId);
      expect(pestParent.rides_parent_id).toBeNull();
      const dates = pest.map((r) => dateOf(r.scheduled_date));
      expect(dates).toHaveLength(6);
      expect(dates).not.toContain(addDays(f.date, 84));
    } finally { await trx.rollback(); }
  });

  // A reserved lawn visit seeds AFTER the promoted programs, so the quarterly
  // rider promoted beside it (termite bait) must find the lawn through noteLawn.
  test('gate on, reserved LAWN start with termite bait promoted before it seeds: the lawn has not seeded yet, so the bait walks its own cadence unlinked', async () => {
    process.env[GATE] = 'true';
    const trx = await mockPg.transaction();
    try {
      const f = await reservedAccept(trx, [LAWN_LINE, TERMITE_BAIT_QUARTERLY]);
      const rows = await trx('scheduled_services').where({ source_estimate_id: f.estimateId }).orderBy('scheduled_date');
      const baitParent = rows.find((r) => !r.recurring_parent_id && /termite/i.test(r.service_type));
      expect(baitParent).toBeDefined();
      expect(baitParent.rides_parent_id).toBeNull();
      const baitDates = rows.filter((r) => r.recurring_parent_id === baitParent.id).map((r) => dateOf(r.scheduled_date));
      expect(baitDates).not.toContain(addDays(f.date, 84));
    } finally { await trx.rollback(); }
  });

  test('gate on, reserved LAWN start but the customer already has an active lawn series: the rider does not ride a lawn series that never seeds', async () => {
    process.env[GATE] = 'true';
    const trx = await mockPg.transaction();
    try {
      const lawnId = (await trx('services').where({ service_key: 'lawn_care_6week' }).first('id')).id;
      const f = await reservedAccept(trx, [LAWN_LINE, TERMITE_BAIT_QUARTERLY], {
        before: async (base) => {
          const [existing] = await trx('scheduled_services').insert({
            customer_id: base.customerId, property_id: base.propertyId, service_id: lawnId, service_type: 'Lawn Care',
            status: 'pending', is_recurring: true, recurring_ongoing: true, recurring_pattern: 'every_6_weeks',
            scheduled_date: weekdayAhead(5), window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60,
          }).returning('*');
          await trx('scheduled_services').insert({
            customer_id: base.customerId, property_id: base.propertyId, service_id: lawnId, service_type: 'Lawn Care',
            status: 'pending', is_recurring: true, recurring_ongoing: true, recurring_pattern: 'every_6_weeks',
            recurring_parent_id: existing.id, scheduled_date: addDays(weekdayAhead(5), 42),
            window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60,
          });
        },
      });
      const rows = await trx('scheduled_services').where({ source_estimate_id: f.estimateId }).orderBy('scheduled_date');
      // The existing lawn series was kept: no lawn follow-ups from this accept.
      expect(rows.filter((r) => r.recurring_parent_id === f.reserved.id)).toHaveLength(0);
      const baitParent = rows.find((r) => !r.recurring_parent_id && /termite/i.test(r.service_type));
      expect(baitParent).toBeDefined();
      expect(baitParent.rides_parent_id).toBeNull();
      const baitDates = rows.filter((r) => r.recurring_parent_id === baitParent.id).map((r) => dateOf(r.scheduled_date));
      expect(baitDates).not.toContain(addDays(f.date, 84));
    } finally { await trx.rollback(); }
  });

  test('a failing rider link write rolls back to its savepoint and leaves the transaction usable', async () => {
    const RiderAcceptSeeding = require('../services/rider-accept-seeding');
    const trx = await mockPg.transaction();
    try {
      const base = await customerFixture(trx);
      const [row] = await trx('scheduled_services').insert({
        customer_id: base.customerId, property_id: base.propertyId, service_type: 'Quarterly Pest Control',
        status: 'pending', scheduled_date: weekdayAhead(10), window_start: '09:00', window_end: '10:00',
      }).returning('*');
      // A host id that does not exist violates the self-FK inside the write.
      await RiderAcceptSeeding.afterSeed({ lawn: null }, trx, row, { hostParentId: randomUUID() }, { insertedRows: [] });
      const again = await trx('scheduled_services').where({ id: row.id }).first('rides_parent_id');
      expect(again.rides_parent_id).toBeNull();
    } finally { await trx.rollback(); }
  });

  test('gate on, no reservation (auto-schedule): the unplaced first visits cannot group, so the pest walks its own cadence unlinked', async () => {
    process.env[GATE] = 'true';
    const trx = await mockPg.transaction();
    try {
      const base = await customerFixture(trx);
      const estimateId = randomUUID();
      await trx('estimates').insert({
        id: estimateId, customer_id: base.customerId, property_id: base.propertyId, status: 'accepted',
        token: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
        category: 'RESIDENTIAL', monthly_total: 85, annual_total: 1020,
        estimate_data: { result: { recurring: { services: [PEST_QUARTERLY, LAWN_LINE] } } },
      });
      await converter.convertEstimate(estimateId, { ...options, database: trx });
      const { lawnParent, pestParent, pest } = await seriesRows(trx, estimateId);
      expect(lawnParent).toBeDefined();
      // Auto-scheduled parents carry no window, and visit groups never group a
      // windowless row — so this is not one stop, and nothing is linked.
      expect(lawnParent.window_start).toBeNull();
      expect(pestParent.rides_parent_id).toBeNull();
      const first = dateOf(pestParent.scheduled_date);
      expect(pest.map((r) => dateOf(r.scheduled_date))).not.toContain(addDays(first, 84));
    } finally { await trx.rollback(); }
  });
});
