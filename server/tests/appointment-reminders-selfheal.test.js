jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(),
}));
jest.mock('../services/estimate-card-holds', () => ({
  cardHoldReminderLine: jest.fn(async () => ''),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const AppointmentReminders = require('../services/appointment-reminders');

function sweepChain(rows) {
  return {
    leftJoin: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    whereNotExists: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue(rows),
  };
}

describe('selfHealMissingReminderRows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    db.transaction = jest.fn(async (callback) => callback('trx-conn'));
  });

  test('registers a row for a future visit missing one, via registerVisitReminderInTx with cron_selfheal source', async () => {
    // Midnight-ET timestamptz the way scheduled_services stores it (EDT = UTC-4).
    const visit = {
      id: 'svc-1',
      customer_id: 'cust-1',
      scheduled_date: new Date('2026-08-01T04:00:00.000Z'),
      window_start: '15:00:00',
      service_type: 'Quarterly Pest Control Service',
    };
    db.mockImplementation(() => sweepChain([visit]));
    const register = jest.spyOn(AppointmentReminders, 'registerVisitReminderInTx')
      .mockResolvedValue({ id: 'rem-1' });

    const healed = await AppointmentReminders.selfHealMissingReminderRows();

    expect(healed).toBe(1);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith('trx-conn', {
      scheduledServiceId: 'svc-1',
      customerId: 'cust-1',
      appointmentTime: '2026-08-01T15:00',
      serviceType: 'Quarterly Pest Control Service',
      source: 'cron_selfheal',
    });
  });

  test('defaults a missing window_start to 08:00', async () => {
    const visit = {
      id: 'svc-2',
      customer_id: 'cust-2',
      scheduled_date: new Date('2026-08-02T04:00:00.000Z'),
      window_start: null,
      service_type: 'Every 6 Weeks Lawn Care Service',
    };
    db.mockImplementation(() => sweepChain([visit]));
    const register = jest.spyOn(AppointmentReminders, 'registerVisitReminderInTx')
      .mockResolvedValue({ id: 'rem-2' });

    await AppointmentReminders.selfHealMissingReminderRows();

    expect(register).toHaveBeenCalledWith('trx-conn', expect.objectContaining({
      appointmentTime: '2026-08-02T08:00',
    }));
  });

  test('does nothing when no visit is missing a row', async () => {
    db.mockImplementation(() => sweepChain([]));
    const register = jest.spyOn(AppointmentReminders, 'registerVisitReminderInTx');

    const healed = await AppointmentReminders.selfHealMissingReminderRows();

    expect(healed).toBe(0);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  test('one failed registration does not stop the rest, and the sweep never throws', async () => {
    const visits = [
      { id: 'svc-3', customer_id: 'cust-3', scheduled_date: new Date('2026-08-03T04:00:00.000Z'), window_start: '09:00:00', service_type: 'A' },
      { id: 'svc-4', customer_id: 'cust-4', scheduled_date: new Date('2026-08-04T04:00:00.000Z'), window_start: '10:00:00', service_type: 'B' },
    ];
    db.mockImplementation(() => sweepChain(visits));
    jest.spyOn(AppointmentReminders, 'registerVisitReminderInTx')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'rem-4' });

    const healed = await AppointmentReminders.selfHealMissingReminderRows();

    expect(healed).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Self-heal registration failed for svc-3'));
  });

  test('sweep query failure logs and returns 0 instead of throwing', async () => {
    db.mockImplementation(() => sweepChain([]));
    db.mockImplementationOnce(() => ({
      ...sweepChain([]),
      select: jest.fn().mockRejectedValue(new Error('db down')),
    }));

    const healed = await AppointmentReminders.selfHealMissingReminderRows();

    expect(healed).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Self-heal registration sweep failed'));
  });
});
