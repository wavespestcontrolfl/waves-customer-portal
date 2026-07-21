/**
 * Health-alert complimentary-visit writer.
 *
 * The free_service action inserted a `price` column that does not exist on
 * scheduled_services — every execution threw and the failure was reported
 * only inside the action's result blob. Pins:
 *   - the insert uses estimated_price (0 = genuine complimentary price) and
 *     only real columns
 *   - an insert failure is logged via logger.error, not silently swallowed
 *   - the reminder row is registered IMMEDIATELY as a windowless pre-closed
 *     placeholder (same closeReminderWindows registration the IB
 *     create_appointment path uses). Left row-less, the windowless
 *     NULL-source_action visit would be picked up by
 *     selfHealMissingReminderRows within 15 minutes and registered with
 *     ARMED 72h/24h reminders telling the customer "8:00 AM" for a time
 *     nobody chose; with the row present the sweep no-ops (it only registers
 *     visits with NO reminder row).
 *   - a registration failure is logged best-effort and never fails the
 *     already-committed insert.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/appointment-reminders', () => ({
  registerAppointment: jest.fn().mockResolvedValue({ id: 'rem-1' }),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const AppointmentReminders = require('../services/appointment-reminders');
const HealthAlerts = require('../services/health-alerts');

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue(),
    ...overrides,
  });
  return builder;
}

// The comp-visit insert chains .returning('id') to feed the reminder
// registration — mock the builder shape accordingly.
function compInsertChain(overrides = {}) {
  return chain({
    insert: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 'svc-comp-1' }]),
    ...overrides,
  });
}

const ALERT = {
  id: 'alert-1',
  customer_id: 'cust-1',
  recommended_actions: JSON.stringify([
    { type: 'free_service', label: 'Comp visit', serviceType: 'General Pest - Complimentary' },
  ]),
  auto_action_taken: '[]',
};

function wire({ insertChain }) {
  const queues = {
    customer_health_alerts: [
      chain({ first: jest.fn().mockResolvedValue(ALERT) }),
      chain(), // status update
    ],
    customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace' }) })],
    scheduled_services: [insertChain],
    activity_log: [chain()],
  };
  db.mockImplementation((table) => {
    const q = queues[table];
    if (!q || q.length === 0) throw new Error(`Unexpected db('${table}') call`);
    return q.shift();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  AppointmentReminders.registerAppointment.mockResolvedValue({ id: 'rem-1' });
});

test('complimentary visit inserts estimated_price (no phantom price column)', async () => {
  const insertChain = compInsertChain();
  wire({ insertChain });

  const result = await HealthAlerts.executeAction('alert-1', 0);

  expect(result.result || result).toBeTruthy();
  const payload = insertChain.insert.mock.calls[0][0];
  expect(payload).toMatchObject({
    customer_id: 'cust-1',
    service_type: 'General Pest - Complimentary',
    status: 'pending',
    estimated_price: 0,
  });
  expect(payload).not.toHaveProperty('price');
  expect(payload.scheduled_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('comp visit registers its reminder row immediately as a windowless PRE-CLOSED placeholder — the self-heal sweep then has nothing to arm at 08:00', async () => {
  const insertChain = compInsertChain();
  wire({ insertChain });

  const result = await HealthAlerts.executeAction('alert-1', 0);

  expect(result.success).toBe(true);
  const insertPayload = insertChain.insert.mock.calls[0][0];
  expect(AppointmentReminders.registerAppointment).toHaveBeenCalledTimes(1);
  expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
    'svc-comp-1',
    'cust-1',
    // The canonical windowless slot convention — same date the visit was
    // inserted for, at the 08:00 anchor the DB sync trigger / self-heal /
    // dedupe all COALESCE on.
    `${insertPayload.scheduled_date}T08:00`,
    'General Pest - Complimentary',
    'health_alert_comp',
    // Registration only, pre-closed: no confirmation SMS, and no ARMED
    // 72h/24h windows promising "8:00 AM" for a time nobody chose. (The
    // placeholder also can't own or suppress the 08:00 slot — see
    // registerAppointment's closeReminderWindows JSDoc.)
    { sendConfirmation: false, closeReminderWindows: true },
  );
});

test('a reminder-registration failure is logged best-effort and never fails the comp action', async () => {
  AppointmentReminders.registerAppointment.mockRejectedValueOnce(new Error('reminders down'));
  const insertChain = compInsertChain();
  wire({ insertChain });

  const result = await HealthAlerts.executeAction('alert-1', 0);

  // The visit insert already committed — the action still reports success…
  expect(result.success).toBe(true);
  expect(result.message).toContain('Complimentary service scheduled');
  // …and the failure is loud in the logs, not swallowed.
  expect(logger.error).toHaveBeenCalledWith(
    expect.stringContaining('Complimentary-visit reminder registration failed'),
  );
});

test('an insert failure is logged loudly, not just swallowed into the result blob', async () => {
  const insertChain = compInsertChain({
    returning: jest.fn().mockRejectedValue(new Error('column boom')),
  });
  wire({ insertChain });

  await HealthAlerts.executeAction('alert-1', 0);

  expect(logger.error).toHaveBeenCalledWith(
    expect.stringContaining('Complimentary service insert failed'),
  );
  // No visit row → no reminder registration for it either.
  expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
});
