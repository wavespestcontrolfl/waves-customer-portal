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
    whereNot: jest.fn().mockReturnThis(),
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
    // scheduled_date is a DATE column — node-pg hydrates it as a JS Date at
    // UTC midnight under prod's TZ=UTC. The sweep must take the UTC calendar
    // day, NOT format the instant in ET (which would yield 2026-07-31).
    const bookedAt = new Date('2026-07-09T15:00:00.000Z');
    const visit = {
      id: 'svc-1',
      customer_id: 'cust-1',
      scheduled_date: new Date('2026-08-01T00:00:00.000Z'),
      window_start: '15:00:00',
      service_type: 'Quarterly Pest Control Service',
      created_at: bookedAt,
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
      createdAt: bookedAt,
    });
  });

  test('defaults a missing window_start to 08:00', async () => {
    const visit = {
      id: 'svc-2',
      customer_id: 'cust-2',
      scheduled_date: new Date('2026-08-02T00:00:00.000Z'),
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

  test('registerVisitReminderInTx stamps the caller-provided booking time as created_at', async () => {
    const bookedAt = new Date('2026-07-09T15:00:00.000Z');
    const lookup = { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) };
    const sameTime = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      whereExists: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    };
    const insertRow = {
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'rem-9' }]),
    };
    const queue = [lookup, sameTime, insertRow];
    const conn = jest.fn(() => queue.shift());
    conn.raw = jest.fn().mockResolvedValue();

    await AppointmentReminders.registerVisitReminderInTx(conn, {
      scheduledServiceId: 'svc-9',
      customerId: 'cust-9',
      appointmentTime: '2026-08-01T15:00',
      serviceType: 'Quarterly Pest Control Service',
      source: 'cron_selfheal',
      createdAt: bookedAt,
    });

    expect(insertRow.insert).toHaveBeenCalledWith(expect.objectContaining({
      source: 'cron_selfheal',
      confirmation_sent: true,
      created_at: bookedAt,
    }));
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
