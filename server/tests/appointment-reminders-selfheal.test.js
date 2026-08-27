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
  // The per-visit transaction now FOR-UPDATE re-reads the visit's owner
  // (Codex #3109 r26) — the trx stub serves that read from the sweep's own
  // rows so the pin still asserts which conn registerVisitReminderInTx got.
  let trxVisitRows;
  const makeTrxConn = () => {
    const trx = jest.fn((table) => ({
      where: jest.fn(({ id }) => ({
        forUpdate: jest.fn(() => ({
          first: jest.fn(async () => {
            const row = (trxVisitRows || []).find((v) => v.id === id);
            return row ? { ...row } : null;
          }),
        })),
      })),
    }));
    trx.__isTrxConn = true;
    return trx;
  };
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    trxVisitRows = [];
    db.transaction = jest.fn(async (callback) => callback(makeTrxConn()));
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
    trxVisitRows = [visit];
    const register = jest.spyOn(AppointmentReminders, 'registerVisitReminderInTx')
      .mockResolvedValue({ id: 'rem-1' });

    const healed = await AppointmentReminders.selfHealMissingReminderRows();

    expect(healed).toBe(1);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ __isTrxConn: true }), {
      scheduledServiceId: 'svc-1',
      customerId: 'cust-1',
      appointmentTime: '2026-08-01T15:00',
      serviceType: 'Quarterly Pest Control Service',
      source: 'cron_selfheal',
      createdAt: bookedAt,
    });
  });

  test('a missing window_start heals as the PRE-CLOSED placeholder, never an armed 08:00 registration', async () => {
    // codex #3504 r10: a windowless visit has no chosen time — the legacy
    // armed-08:00 registration texted 72/24h reminders for a time nobody
    // picked. The sync trigger re-arms the row when a real window is set.
    const visit = {
      id: 'svc-2',
      customer_id: 'cust-2',
      scheduled_date: new Date('2026-08-02T00:00:00.000Z'),
      window_start: null,
      service_type: 'Every 6 Weeks Lawn Care Service',
    };
    db.mockImplementation(() => sweepChain([visit]));
    trxVisitRows = [visit];
    const register = jest.spyOn(AppointmentReminders, 'registerVisitReminderInTx')
      .mockResolvedValue({ id: 'rem-2' });
    const placeholder = jest.spyOn(AppointmentReminders, 'insertPreClosedPlaceholderRowInTx')
      .mockResolvedValue({ id: 'rem-2-preclosed' });

    await AppointmentReminders.selfHealMissingReminderRows();

    expect(register).not.toHaveBeenCalled();
    expect(placeholder).toHaveBeenCalledWith(expect.objectContaining({ __isTrxConn: true }), expect.objectContaining({
      scheduledServiceId: 'svc-2',
      customerId: 'cust-2',
      source: 'cron_selfheal',
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
    trxVisitRows = visits;
    jest.spyOn(AppointmentReminders, 'registerVisitReminderInTx')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'rem-4' });

    const healed = await AppointmentReminders.selfHealMissingReminderRows();

    expect(healed).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Self-heal registration failed for svc-3'));
  });

  test('registerVisitReminderInTx stamps the caller-provided booking time as created_at', async () => {
    const bookedAt = new Date('2026-07-09T15:00:00.000Z');
    // estimateBackedServiceName's enrichment lookup runs first on conn; null
    // row → label passes through unchanged.
    const estimateLookup = {
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    };
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
    const queue = [estimateLookup, lookup, sameTime, insertRow];
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

describe('owner ruling 2026-08-17 — reminders arm for every future visit', () => {
  let trxVisitRows;
  const makeTrxConn = () => {
    const trx = jest.fn((table) => ({
      where: jest.fn(({ id }) => ({
        forUpdate: jest.fn(() => ({
          first: jest.fn(async () => {
            const row = (trxVisitRows || []).find((v) => v.id === id);
            return row ? { ...row } : null;
          }),
        })),
      })),
    }));
    trx.__isTrxConn = true;
    return trx;
  };
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    trxVisitRows = [];
    db.transaction = jest.fn(async (callback) => callback(makeTrxConn()));
  });

  test('the sweep no longer builds the dispatch-owned pending carve-out', async () => {
    const chain = sweepChain([]);
    db.mockImplementation(() => chain);

    await AppointmentReminders.selfHealMissingReminderRows();

    // The carve-out was the only whereNot in the sweep query; the ruling
    // removed it so call-created pending visits arm like every other visit.
    expect(chain.whereNot).not.toHaveBeenCalled();
    expect(chain.where).not.toHaveBeenCalledWith(expect.any(Function));
  });

  test('a dispatch-owned pending call-followup visit registers via the sweep', async () => {
    const visit = {
      id: 'svc-followup',
      customer_id: 'cust-f',
      scheduled_date: new Date('2026-08-25T00:00:00.000Z'),
      window_start: '13:00:00',
      service_type: 'Cockroach Treatment',
      source_action: 'ai_call_pipeline_followup',
      status: 'pending',
    };
    db.mockImplementation(() => sweepChain([visit]));
    trxVisitRows = [visit];
    const register = jest.spyOn(AppointmentReminders, 'registerVisitReminderInTx')
      .mockResolvedValue({ id: 'rem-f' });

    const healed = await AppointmentReminders.selfHealMissingReminderRows();

    expect(healed).toBe(1);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ __isTrxConn: true }), expect.objectContaining({
      scheduledServiceId: 'svc-followup',
      appointmentTime: '2026-08-25T13:00',
      source: 'cron_selfheal',
    }));
  });

  test('a silent null return from registration is logged with the visit inputs', async () => {
    const visit = {
      id: 'svc-null',
      customer_id: 'cust-n',
      scheduled_date: new Date('2026-08-25T00:00:00.000Z'),
      window_start: '13:00:00',
      service_type: 'Cockroach Treatment',
    };
    db.mockImplementation(() => sweepChain([visit]));
    trxVisitRows = [visit];
    jest.spyOn(AppointmentReminders, 'registerVisitReminderInTx').mockResolvedValue(null);

    const healed = await AppointmentReminders.selfHealMissingReminderRows();

    expect(healed).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('returned null for svc-null'));
  });
});

describe('owner ruling 2026-08-17 — no catch-up texts for the healed backlog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });
  const makeConn = (captured) => {
    const estimateLookup = {
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    };
    const lookup = { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) };
    const sameTime = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      whereExists: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    };
    const insertRow = {
      insert: jest.fn((row) => { captured.row = row; return insertRow; }),
      returning: jest.fn().mockResolvedValue([{ id: 'rem-x' }]),
    };
    const queue = [estimateLookup, lookup, sameTime, insertRow];
    const conn = jest.fn(() => queue.shift());
    conn.raw = jest.fn().mockResolvedValue();
    return conn;
  };
  const isoHoursFromNow = (h) => {
    const d = new Date(Date.now() + h * 3600000);
    // registerVisitReminderInTx parses ET wall-time strings; build one from the instant
    const et = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
    const get = (t) => et.find((p) => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`;
  };

  test('a STALE self-healed row inside a started window pre-closes it (no late text)', async () => {
    const captured = {};
    await AppointmentReminders.registerVisitReminderInTx(makeConn(captured), {
      scheduledServiceId: 'svc-old',
      customerId: 'cust-old',
      appointmentTime: isoHoursFromNow(10), // inside BOTH bands
      serviceType: 'Quarterly Pest Control Service',
      source: 'cron_selfheal',
      createdAt: new Date('2026-08-10T00:00:00Z'), // backlog: booked before the rollout cutoff
    });
    expect(captured.row.reminder_72h_sent).toBe(true);
    expect(captured.row.reminder_24h_sent).toBe(true);
  });

  test('a POST-CUTOFF booking keeps its 24h reminder however late the heal (codex r3+r4 P1)', async () => {
    const captured = {};
    await AppointmentReminders.registerVisitReminderInTx(makeConn(captured), {
      scheduledServiceId: 'svc-fresh',
      customerId: 'cust-fresh',
      appointmentTime: isoHoursFromNow(10), // booked <24h out, heal delayed hours by an outage
      serviceType: 'Quarterly Pest Control Service',
      source: 'cron_selfheal',
      createdAt: new Date('2026-09-01T00:00:00Z'), // any post-cutoff booking
    });
    // Booking-path boundaries: 72h band already missed, 24h still sendable.
    expect(captured.row.reminder_72h_sent).toBe(true);
    expect(captured.row.reminder_24h_sent).toBe(false);
  });

  test('a self-healed row ahead of both windows arms them normally', async () => {
    const captured = {};
    await AppointmentReminders.registerVisitReminderInTx(makeConn(captured), {
      scheduledServiceId: 'svc-future',
      customerId: 'cust-future',
      appointmentTime: isoHoursFromNow(200),
      serviceType: 'Quarterly Pest Control Service',
      source: 'cron_selfheal',
      createdAt: new Date('2026-08-10T00:00:00Z'),
    });
    expect(captured.row.reminder_72h_sent).toBe(false);
    expect(captured.row.reminder_24h_sent).toBe(false);
  });

  test('booking-path registrations keep the original late-send boundaries', async () => {
    const captured = {};
    await AppointmentReminders.registerVisitReminderInTx(makeConn(captured), {
      scheduledServiceId: 'svc-seed',
      customerId: 'cust-seed',
      appointmentTime: isoHoursFromNow(10),
      serviceType: 'Quarterly Pest Control Service',
      source: 'system_seed',
    });
    // 10h out: 72h band already missed under original rule, 24h still sendable
    expect(captured.row.reminder_72h_sent).toBe(true);
    expect(captured.row.reminder_24h_sent).toBe(false);
  });
});

describe('codex #3429 r2 — locked-row slot re-read and terminal skip', () => {
  let trxVisitRows;
  const makeTrxConn = () => {
    const trx = jest.fn(() => ({
      where: jest.fn(({ id }) => ({
        forUpdate: jest.fn(() => ({
          first: jest.fn(async () => {
            const row = (trxVisitRows || []).find((v) => v.id === id);
            return row ? { ...row } : null;
          }),
        })),
      })),
    }));
    trx.__isTrxConn = true;
    return trx;
  };
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    trxVisitRows = [];
    db.transaction = jest.fn(async (callback) => callback(makeTrxConn()));
  });

  test('a mid-sweep staff move registers the LOCKED slot, not the sweep snapshot', async () => {
    const sweepSnapshot = {
      id: 'svc-moved',
      customer_id: 'cust-m',
      scheduled_date: new Date('2026-08-20T00:00:00.000Z'),
      window_start: '09:00:00',
      service_type: 'Quarterly Pest Control Service',
      created_at: new Date('2026-08-01T12:00:00.000Z'),
    };
    db.mockImplementation(() => sweepChain([sweepSnapshot]));
    // Staff moved the visit between the sweep read and the row lock.
    trxVisitRows = [{
      ...sweepSnapshot,
      scheduled_date: new Date('2026-08-22T00:00:00.000Z'),
      window_start: '14:00:00',
      service_type: 'Quarterly Pest + Termite Control Service',
    }];
    const register = jest.spyOn(AppointmentReminders, 'registerVisitReminderInTx')
      .mockResolvedValue({ id: 'rem-m' });

    const healed = await AppointmentReminders.selfHealMissingReminderRows();

    expect(healed).toBe(1);
    expect(register).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      appointmentTime: '2026-08-22T14:00',
      serviceType: 'Quarterly Pest + Termite Control Service',
    }));
  });

  test('a visit that went terminal mid-sweep skips silently — no heal, no error', async () => {
    const visit = {
      id: 'svc-gone',
      customer_id: 'cust-g',
      scheduled_date: new Date('2026-08-20T00:00:00.000Z'),
      window_start: '09:00:00',
      service_type: 'Quarterly Pest Control Service',
    };
    db.mockImplementation(() => sweepChain([visit]));
    trxVisitRows = [{ ...visit, status: 'cancelled' }];
    const register = jest.spyOn(AppointmentReminders, 'registerVisitReminderInTx');

    const healed = await AppointmentReminders.selfHealMissingReminderRows();

    expect(healed).toBe(0);
    expect(register).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
