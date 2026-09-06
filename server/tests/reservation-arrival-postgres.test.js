/** Real reminder registration and sync on synthetic, rolled-back allocations. */
jest.mock('../models/db', () => new Proxy((...args) => mockPg(...args), {
  get: (_, key) => typeof mockPg[key] === 'function' ? mockPg[key].bind(mockPg) : mockPg[key],
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { addETDays, etDateString, parseETDateTime } = require('../utils/datetime-et');
const AppointmentReminders = require('../services/appointment-reminders');
const { appointmentSendHeld } = require('../services/visit-groups');
const migration = require('../models/migrations/20260906000020_reservation_arrival');
const connection = process.env.RESERVATION_ARRIVAL_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let mockPg;
jest.setTimeout(120000);

const programs = [
  ['pest_general_quarterly', 'Quarterly Pest Control', 'pest_control'],
  ['lawn_care_recurring', 'Lawn Care', 'lawn_care'],
  ['tree_shrub_6week', 'Tree & Shrub', 'tree_shrub'],
  ['mosquito_monthly', 'Monthly Mosquito Control', 'mosquito'],
];

async function withAllocation(count, run, { stamped = true } = {}) {
  const pool = mockPg;
  const trx = await pool.transaction();
  mockPg = trx;
  try {
    const customerId = randomUUID();
    const technicianId = randomUUID();
    const date = etDateString(addETDays(new Date(), 14));
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: '+19415550100', active: true,
      pipeline_stage: 'active_customer', autopay_enabled: true, property_type: 'residential' });
    await trx('technicians').insert({ id: technicianId, name: 'Synthetic Technician',
      email: `${technicianId}@example.invalid`, password_hash: 'synthetic-not-a-login-hash', role: 'technician', active: true });
    const selected = programs.slice(0, count);
    const ids = selected.map(() => randomUUID());
    const stamp = stamped ? { version: 1, services: selected.map(([, , family]) => family), durationMinutes: count * 60,
      scheduledDate: date, arrivalWindowStart: '09:00', allocatedServiceIds: ids } : null;
    const rows = [];
    for (const [index, [key, name]] of selected.entries()) {
      const service = await trx('services').where({ service_key: key }).first();
      if (!service) throw new Error(`Missing migrated fixture catalog: ${key}`);
      const [row] = await trx('scheduled_services').insert({ id: ids[index], customer_id: customerId,
        technician_id: technicianId, service_id: service.id, service_type: name,
        service_key_snapshot: key, scheduled_date: date, status: 'confirmed',
        window_start: `${String(9 + index).padStart(2, '0')}:00`, window_end: `${10 + index}:00`,
        estimated_duration_minutes: 60, reservation_service_mix: stamp,
      }).returning('*');
      rows.push(row);
    }
    await run({ trx, rows, customerId, date });
  } finally { mockPg = pool; await trx.rollback(); }
}

async function registerRows({ rows, customerId }) {
  const { registerAcceptedEstimateAppointmentReminder } = require('../routes/estimate-public');
  for (const appointment of rows) {
    const registered = await registerAcceptedEstimateAppointmentReminder({ appointment, customerId });
    expect(registered).not.toBeNull();
  }
}

postgres('reservation arrival through existing reminder mechanisms', () => {
  beforeAll(async () => {
    expect(require('../config/feature-gates').isEnabled('visitGroups')).toBe(false);
    const url = new URL(connection);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!local && !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) throw new Error('Use a verified private dev database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  test.each([2, 3, 4])('%i allocated members share one reminder time with Auto Pay and grouping off', async (count) => {
    await withAllocation(count, async (f) => {
      await registerRows(f);
      for (const row of f.rows) {
        const arrival = `${f.date}T09:00`;
        await expect(AppointmentReminders.resolveCommittedVisitTime(row.id, {}, f.trx))
          .resolves.toEqual({ appointmentTime: arrival, windowless: false });
        await expect(AppointmentReminders.confirmationArrivalWindow({ scheduledServiceId: row.id, windowStart: row.window_start }))
          .resolves.toBe('between 9:00 AM and 11:00 AM');
        await expect(appointmentSendHeld(row.id, parseETDateTime(arrival).getTime())).resolves.toBe(false);
      }
      const reminders = await f.trx('appointment_reminders').where({ customer_id: f.customerId });
      expect(reminders).toHaveLength(count);
      expect(new Set(reminders.map((row) => row.appointment_time.toISOString())).size).toBe(1);
      expect(reminders.filter((row) => !row.suppressed_by_sibling)).toHaveLength(1);
    });
  });

  test('a resize preserves arrival, reassignment preserves siblings, and cancellation promotes a deliverable reminder', async () => {
    await withAllocation(2, async (f) => {
      await registerRows(f);
      const [anchor, sibling] = f.rows;
      await f.trx('scheduled_services').where({ id: sibling.id }).update({ window_end: '11:30' });
      await AppointmentReminders.handleReschedule(sibling.id, `${f.date}T10:00`, {
        sendNotification: false, expectSchedule: { date: f.date, windowStart: '10:00' },
      });
      let reminder = await f.trx('appointment_reminders').where({ scheduled_service_id: sibling.id }).first();
      expect(reminder.appointment_time).toEqual(parseETDateTime(`${f.date}T09:00`));
      expect(reminder.suppressed_by_sibling).toBe(true);
      await f.trx('scheduled_services').where({ id: anchor.id }).update({ technician_id: null, status: 'cancelled' });
      reminder = await f.trx('appointment_reminders').where({ scheduled_service_id: sibling.id }).first();
      expect(reminder.cancelled).toBe(false);
      expect(reminder.suppressed_by_sibling).toBe(false);
      await expect(appointmentSendHeld(sibling.id, parseETDateTime(`${f.date}T09:00`).getTime())).resolves.toBe(false);
      await expect(appointmentSendHeld(sibling.id, parseETDateTime(`${f.date}T10:00`).getTime())).resolves.toBe(true);
      await f.trx('scheduled_services').where({ id: sibling.id }).update({ window_start: '13:00', window_end: '14:00' });
      reminder = await f.trx('appointment_reminders').where({ scheduled_service_id: sibling.id }).first();
      expect(reminder.appointment_time).toEqual(parseETDateTime(`${f.date}T13:00`));
      await expect(appointmentSendHeld(sibling.id, parseETDateTime(`${f.date}T09:00`).getTime())).resolves.toBe(true);
      await expect(appointmentSendHeld(sibling.id, parseETDateTime(`${f.date}T13:00`).getTime())).resolves.toBe(false);
    });
  });

  test('an active move hold still blocks the shared promise', async () => {
    await withAllocation(2, async (f) => {
      await registerRows(f);
      await f.trx('appointment_reminders').where({ scheduled_service_id: f.rows[0].id })
        .update({ move_hold_until: new Date(Date.now() + 60000) });
      await expect(appointmentSendHeld(f.rows[0].id, parseETDateTime(`${f.date}T09:00`).getTime())).resolves.toBe(true);
    });
  });

  test('ordinary appointments retain their own starts', async () => {
    await withAllocation(2, async (f) => {
      await registerRows(f);
      const reminders = await f.trx('appointment_reminders').where({ customer_id: f.customerId });
      expect(new Set(reminders.map((row) => row.appointment_time.toISOString())).size).toBe(2);
      expect(reminders.every((row) => !row.suppressed_by_sibling)).toBe(true);
    }, { stamped: false });
  });

  test('migration rollback and reapplication restore the existing reminder functions', async () => {
    const trx = await mockPg.transaction();
    try {
      await migration.down(trx);
      expect(await trx.schema.hasColumn('scheduled_services', 'reservation_service_mix')).toBe(false);
      await migration.up(trx);
      await migration.up(trx);
      const result = await trx.raw('SELECT reservation_arrival_start(?) AS start', [randomUUID()]);
      expect(result.rows[0].start).toBeNull();
    } finally { await trx.rollback(); }
  });
});
