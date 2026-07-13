jest.mock('../models/db', () => {
  const db = jest.fn();
  db.transaction = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/time-tracking', () => ({
  computeDailySummaryInTransaction: jest.fn(),
  computeWeeklySummary: jest.fn(),
  computeWeeklySummaryInTransaction: jest.fn(),
  isCompletedEntryIntervalValid: jest.fn(),
  lockStaffWeek: jest.fn(),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const timeTracking = require('../services/time-tracking');
const approval = require('../services/timesheet-approval');
const WEEK_CLOCK_IN = new Date('2020-01-06T14:00:00.000Z');

function queryBuilder(spec, events) {
  const chain = {};
  const chainMethod = (name) => (...args) => {
    events.push(`${spec.label}.${name}`);
    spec[`${name}Args`] = args;
    return chain;
  };

  for (const method of [
    'where',
    'whereIn',
    'whereNot',
    'whereRaw',
    'leftJoin',
    'select',
    'orderBy',
    'orderByRaw',
    'whereNull',
  ]) {
    chain[method] = chainMethod(method);
  }
  chain.forUpdate = chainMethod('forUpdate');
  chain.first = async (...args) => {
    events.push(`${spec.label}.first`);
    spec.firstArgs = args;
    return spec.firstValue;
  };
  chain.update = (payload) => {
    events.push(`${spec.label}.update`);
    spec.updatePayload = payload;
    return chain;
  };
  chain.returning = async (...args) => {
    events.push(`${spec.label}.returning`);
    spec.returningArgs = args;
    return spec.returningValue;
  };
  chain.then = (resolve, reject) => Promise.resolve(spec.thenValue).then(resolve, reject);
  return chain;
}

function installDatabase(transactionSpecs, directSpecs, events) {
  const transactionQueue = [...transactionSpecs];
  const trx = jest.fn((table) => {
    const spec = transactionQueue.shift();
    if (!spec) throw new Error(`Unexpected transaction query for ${table}`);
    expect(table).toBe(spec.table);
    events.push(`${spec.label}.table`);
    return queryBuilder(spec, events);
  });
  trx.raw = jest.fn(async (...args) => {
    events.push('transaction.raw');
    trx.rawArgs = args;
    return { rows: [] };
  });
  db.transaction.mockImplementation(async (callback) => {
    events.push('transaction.begin');
    try {
      const value = await callback(trx);
      events.push('transaction.commit');
      return value;
    } catch (error) {
      events.push('transaction.rollback');
      throw error;
    }
  });

  const directQueue = [...directSpecs];
  db.mockImplementation((table) => {
    const spec = directQueue.shift();
    if (!spec) throw new Error(`Unexpected direct query for ${table}`);
    expect(table).toBe(spec.table);
    events.push(`${spec.label}.table`);
    return queryBuilder(spec, events);
  });
  return { directQueue, transactionQueue, trx };
}

function detailSpecs(weekly, dailies, entries) {
  return [
    { table: 'time_weekly_summary', label: 'detailWeekly', firstValue: weekly },
    { table: 'time_weekly_summary', label: 'detailSnapshotWeekly', firstValue: weekly },
    { table: 'time_entry_daily_summary', label: 'detailDailies', thenValue: dailies },
    { table: 'time_entries', label: 'detailEntries', thenValue: entries },
    { table: 'technicians', label: 'detailTech', firstValue: { id: 'tech-1' } },
  ];
}

function expectOrdered(events, labels) {
  let prior = -1;
  for (const label of labels) {
    const index = events.indexOf(label);
    expect(index).toBeGreaterThan(prior);
    prior = index;
  }
}

describe('weekly timesheet approval safety', () => {
  beforeEach(() => {
    db.mockReset();
    db.transaction.mockReset();
    logger.info.mockReset();
    timeTracking.computeWeeklySummary.mockReset();
    timeTracking.computeDailySummaryInTransaction.mockReset();
    timeTracking.computeWeeklySummaryInTransaction.mockReset();
    timeTracking.isCompletedEntryIntervalValid.mockReset();
    timeTracking.isCompletedEntryIntervalValid.mockReturnValue(true);
    timeTracking.lockStaffWeek.mockReset();
  });

  test('accepts only a completed Monday-Sunday ET week', () => {
    const now = new Date('2026-07-13T16:00:00.000Z');

    expect(approval._test.validateApprovalWeek('2026-07-06', now)).toEqual({
      start: '2026-07-06',
      end: '2026-07-12',
    });
    expect(() => approval._test.validateApprovalWeek('2026-07-07', now)).toThrow(
      expect.objectContaining({ statusCode: 400, message: expect.stringMatching(/Monday/) }),
    );
    expect(() => approval._test.validateApprovalWeek('2026-07-13', now)).toThrow(
      expect.objectContaining({ statusCode: 409, message: expect.stringMatching(/completed/) }),
    );
    expect(() => approval._test.validateApprovalWeek('2026-02-31', now)).toThrow(
      expect.objectContaining({
        statusCode: 400,
        isOperational: true,
        message: expect.stringMatching(/valid calendar date/),
      }),
    );
  });

  test.each([
    ['pending-week read', () => approval.getPendingWeeks('2020-01-07')],
    ['week-detail read', () => approval.getWeekDetail('tech-1', '2020-01-07')],
    ['payroll export', () => approval.generateWeeklyPayrollExport('2020-01-07')],
    ['week unlock', () => approval.unlockWeek({
      technicianId: 'tech-1',
      weekStart: '2020-01-07',
      adminId: 'admin-1',
    })],
  ])('rejects a non-canonical Monday before any DB access for %s', async (_label, invoke) => {
    await expect(invoke()).rejects.toMatchObject({
      statusCode: 400,
      isOperational: true,
      message: expect.stringMatching(/Monday/),
    });
    expect(db).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('returns the same approved weekly revision used by the review token', async () => {
    const events = [];
    const firstRead = {
      id: 'weekly-1',
      technician_id: 'tech-1',
      week_start: '2020-01-06',
      status: 'approved',
      total_shift_minutes: 480,
      approved_at: new Date('2020-01-13T12:00:00.000Z'),
    };
    const snapshotWeekly = {
      ...firstRead,
      total_shift_minutes: 500,
      approved_at: new Date('2020-01-20T12:00:00.000Z'),
    };
    const dailies = [{
      id: 'daily-1', work_date: '2020-01-06', status: 'approved', total_shift_minutes: 500,
    }];
    const entries = [{
      id: 'shift-1',
      entry_type: 'shift',
      status: 'completed',
      approval_status: 'approved',
      clock_in: WEEK_CLOCK_IN,
      clock_out: new Date('2020-01-06T22:20:00.000Z'),
      duration_minutes: 500,
    }];
    installDatabase([], [
      { table: 'time_weekly_summary', label: 'initialWeekly', firstValue: firstRead },
      { table: 'time_weekly_summary', label: 'snapshotWeekly', firstValue: snapshotWeekly },
      { table: 'time_entry_daily_summary', label: 'snapshotDailies', thenValue: dailies },
      { table: 'time_entries', label: 'snapshotEntries', thenValue: entries },
      { table: 'technicians', label: 'technician', firstValue: { id: 'tech-1' } },
    ], events);

    const detail = await approval.getWeekDetail('tech-1', '2020-01-06');

    expect(detail.weekly.total_shift_minutes).toBe(500);
    expect(detail.weekly.approved_at).toEqual(snapshotWeekly.approved_at);
    expect(detail.reviewToken).toBe(approval._test.reviewSnapshotToken({
      weekly: snapshotWeekly,
      dailies,
      entries,
    }));
  });

  test('locks, recomputes, and signs one immutable weekly snapshot', async () => {
    const events = [];
    const entries = [{
      id: 'shift-1',
      entry_type: 'shift',
      status: 'completed',
      approval_status: 'pending',
      clock_in: WEEK_CLOCK_IN,
      clock_out: new Date('2020-01-06T22:00:00.000Z'),
      duration_minutes: 480,
    }];
    const dailies = [{
      id: 'daily-1',
      work_date: '2020-01-06',
      total_shift_minutes: 480,
      job_count: 0,
      status: 'pending',
    }];
    const weekly = {
      id: 'weekly-1',
      status: 'pending',
      week_start: '2020-01-06',
      total_shift_minutes: 480,
      tech_signed_at: null,
    };
    const signed = {
      ...weekly,
      tech_signed_at: new Date('2026-07-13T14:00:00.000Z'),
      tech_signature: 'Tech One',
    };
    const specs = [
      { table: 'time_entries', label: 'entries', thenValue: entries },
      { table: 'time_entry_daily_summary', label: 'dailiesBefore', thenValue: dailies },
      { table: 'time_entry_daily_summary', label: 'dailiesAfter', thenValue: dailies },
      {
        table: 'time_weekly_summary',
        label: 'signUpdate',
        returningValue: [signed],
      },
    ];
    const { trx } = installDatabase(specs, [], events);
    timeTracking.lockStaffWeek.mockImplementation(async () => events.push('week.lock'));
    timeTracking.computeWeeklySummaryInTransaction.mockImplementation(async () => {
      events.push('week.compute');
      return weekly;
    });
    timeTracking.computeDailySummaryInTransaction.mockImplementation(async () => {
      events.push('day.compute');
    });
    const reviewToken = approval._test.reviewSnapshotToken({ weekly, dailies, entries });

    await expect(approval.signWeek({
      technicianId: 'tech-1',
      weekStart: '2020-01-06',
      signature: ' Tech One ',
      reviewToken,
    })).resolves.toEqual({ weekly: signed, alreadySigned: false });

    expectOrdered(events, [
      'transaction.begin',
      'week.lock',
      'entries.forUpdate',
      'dailiesBefore.forUpdate',
      'day.compute',
      'week.compute',
      'dailiesAfter.forUpdate',
      'signUpdate.update',
      'transaction.commit',
    ]);
    expect(timeTracking.computeWeeklySummaryInTransaction).toHaveBeenCalledWith(
      trx,
      'tech-1',
      '2020-01-06',
      { lock: false },
    );
    expect(specs[3].updatePayload.tech_signature).toBe('Tech One');
  });

  test('refuses sign-off while a day is disputed', async () => {
    const events = [];
    const entries = [{
      id: 'shift-1',
      entry_type: 'shift',
      status: 'completed',
      approval_status: 'pending',
      clock_in: WEEK_CLOCK_IN,
    }];
    const dailies = [{
      id: 'daily-1',
      work_date: '2020-01-06',
      total_shift_minutes: 480,
      status: 'disputed',
    }];
    const weekly = { id: 'weekly-1', status: 'pending', week_start: '2020-01-06' };
    installDatabase([
      { table: 'time_entries', label: 'entries', thenValue: entries },
      { table: 'time_entry_daily_summary', label: 'dailiesBefore', thenValue: dailies },
      { table: 'time_entry_daily_summary', label: 'dailiesAfter', thenValue: dailies },
    ], [], events);
    timeTracking.lockStaffWeek.mockResolvedValue('2020-01-06');
    timeTracking.computeWeeklySummaryInTransaction.mockResolvedValue(weekly);

    await expect(approval.signWeek({
      technicianId: 'tech-1',
      weekStart: '2020-01-06',
      signature: 'Tech One',
      reviewToken: approval._test.reviewSnapshotToken({ weekly, dailies, entries }),
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/disputed/) });
    expect(events).not.toContain('signUpdate.update');
  });

  test('locks entries and rejects an active timer before computing or signing', async () => {
    const events = [];
    const activeEntry = {
      id: 'shift-1',
      technician_id: 'tech-1',
      entry_type: 'shift',
      status: 'active',
      approval_status: 'pending',
      clock_in: WEEK_CLOCK_IN,
    };
    installDatabase([
      { table: 'time_entries', label: 'entries', thenValue: [activeEntry] },
    ], [], events);
    timeTracking.lockStaffWeek.mockImplementation(async () => events.push('week.lock'));

    await expect(approval.signWeek({
      technicianId: 'tech-1',
      weekStart: '2020-01-06',
      signature: 'Tech One',
      reviewToken: 'reviewed-snapshot',
    })).rejects.toMatchObject({
      statusCode: 409,
      isOperational: true,
      message: expect.stringMatching(/active timer/),
    });

    expectOrdered(events, [
      'transaction.begin',
      'week.lock',
      'entries.forUpdate',
      'transaction.rollback',
    ]);
    expect(timeTracking.computeDailySummaryInTransaction).not.toHaveBeenCalled();
    expect(timeTracking.computeWeeklySummaryInTransaction).not.toHaveBeenCalled();
  });

  test('locks entries and rejects an active timer before computing or approving', async () => {
    const events = [];
    const activeEntry = {
      id: 'shift-1',
      technician_id: 'tech-1',
      entry_type: 'shift',
      status: 'active',
      approval_status: 'pending',
      clock_in: WEEK_CLOCK_IN,
    };
    installDatabase([
      { table: 'time_entries', label: 'entries', thenValue: [activeEntry] },
    ], [], events);
    timeTracking.lockStaffWeek.mockImplementation(async () => events.push('week.lock'));

    await expect(approval.approveWeek({
      technicianId: 'tech-1',
      weekStart: '2020-01-06',
      adminId: 'admin-1',
      reviewToken: 'reviewed-snapshot',
    })).rejects.toMatchObject({
      statusCode: 409,
      isOperational: true,
      message: expect.stringMatching(/active timer/),
    });

    expectOrdered(events, [
      'transaction.begin',
      'week.lock',
      'entries.orderByRaw',
      'entries.forUpdate',
      'transaction.rollback',
    ]);
    expect(timeTracking.computeWeeklySummaryInTransaction).not.toHaveBeenCalled();
  });

  test('rejects a malformed completed interval before approval', async () => {
    const events = [];
    installDatabase([
      {
        table: 'time_entries',
        label: 'entries',
        thenValue: [{
          id: 'shift-1',
          status: 'completed',
          approval_status: 'pending',
          clock_in: WEEK_CLOCK_IN,
          clock_out: new Date('2020-01-06T13:00:00.000Z'),
          duration_minutes: -60,
        }],
      },
    ], [], events);
    timeTracking.lockStaffWeek.mockResolvedValue('2020-01-06');
    timeTracking.isCompletedEntryIntervalValid.mockReturnValue(false);

    await expect(approval.approveWeek({
      technicianId: 'tech-1',
      weekStart: '2020-01-06',
      adminId: 'admin-1',
      reviewToken: 'reviewed-snapshot',
    })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/invalid time interval/),
    });

    expect(events).toContain('transaction.rollback');
    expect(timeTracking.computeWeeklySummaryInTransaction).not.toHaveBeenCalled();
  });

  test('rejects child time outside every completed shift', async () => {
    const events = [];
    installDatabase([
      {
        table: 'time_entries',
        label: 'entries',
        thenValue: [
          {
            id: 'shift-1',
            entry_type: 'shift',
            status: 'completed',
            approval_status: 'pending',
            clock_in: new Date('2020-01-06T14:00:00.000Z'),
            clock_out: new Date('2020-01-06T22:00:00.000Z'),
            duration_minutes: 480,
          },
          {
            id: 'job-1',
            entry_type: 'job',
            status: 'completed',
            approval_status: 'pending',
            clock_in: new Date('2020-01-06T12:00:00.000Z'),
            clock_out: new Date('2020-01-06T13:00:00.000Z'),
            duration_minutes: 60,
          },
        ],
      },
    ], [], events);
    timeTracking.lockStaffWeek.mockResolvedValue('2020-01-06');

    await expect(approval.approveWeek({
      technicianId: 'tech-1',
      weekStart: '2020-01-06',
      adminId: 'admin-1',
      reviewToken: 'reviewed-snapshot',
    })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/outside a completed shift/),
    });

    expect(events).toContain('transaction.rollback');
  });

  test('rejects overlapping completed shifts before approval', async () => {
    const events = [];
    installDatabase([
      {
        table: 'time_entries',
        label: 'entries',
        thenValue: [
          {
            id: 'shift-1', entry_type: 'shift', status: 'completed',
            approval_status: 'pending', clock_in: new Date('2020-01-06T14:00:00Z'),
            clock_out: new Date('2020-01-06T18:00:00Z'), duration_minutes: 240,
          },
          {
            id: 'shift-2', entry_type: 'shift', status: 'completed',
            approval_status: 'pending', clock_in: new Date('2020-01-06T17:00:00Z'),
            clock_out: new Date('2020-01-06T20:00:00Z'), duration_minutes: 180,
          },
        ],
      },
    ], [], events);
    timeTracking.lockStaffWeek.mockResolvedValue('2020-01-06');

    await expect(approval.approveWeek({
      technicianId: 'tech-1',
      weekStart: '2020-01-06',
      adminId: 'admin-1',
      reviewToken: 'reviewed-snapshot',
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/overlapping/) });
  });

  test.each([
    ['a disputed entry', 'disputed', 'pending'],
    ['a rejected day', 'pending', 'rejected'],
  ])('rejects %s instead of flattening conflicting review state', async (_label, entryApproval, dailyStatus) => {
    const events = [];
    installDatabase([
      {
        table: 'time_entries',
        label: 'entries',
        thenValue: [{
          id: 'shift-1',
          status: 'completed',
          approval_status: entryApproval,
          clock_in: WEEK_CLOCK_IN,
        }],
      },
      {
        table: 'time_entry_daily_summary',
        label: 'dailies',
        thenValue: [{ id: 'daily-1', status: dailyStatus }],
      },
    ], [], events);
    timeTracking.lockStaffWeek.mockResolvedValue('2020-01-06');

    await expect(approval.approveWeek({
      technicianId: 'tech-1',
      weekStart: '2020-01-06',
      adminId: 'admin-1',
      reviewToken: 'reviewed-snapshot',
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(events).toContain('transaction.rollback');
    expect(timeTracking.computeWeeklySummaryInTransaction).not.toHaveBeenCalled();
  });

  test('recomputes and approves entries, dailies, and weekly summary atomically', async () => {
    const events = [];
    const entries = [
      {
        id: 'shift-1',
        status: 'completed',
        approval_status: 'pending',
        clock_in: WEEK_CLOCK_IN,
      },
      {
        id: 'job-1',
        status: 'edited',
        approval_status: null,
        clock_in: WEEK_CLOCK_IN,
      },
    ];
    const dailies = [{ id: 'daily-1', status: 'pending', work_date: '2020-01-06' }];
    const pendingWeekly = { id: 'weekly-1', status: 'pending', week_start: '2020-01-06' };
    const approvedWeekly = { ...pendingWeekly, status: 'approved' };
    const transactionSpecs = [
      { table: 'time_entries', label: 'entries', thenValue: entries },
      { table: 'time_entry_daily_summary', label: 'dailiesBefore', thenValue: dailies },
      { table: 'time_entry_daily_summary', label: 'dailies', thenValue: dailies },
      { table: 'time_entry_daily_summary', label: 'dailiesAfterWeekly', thenValue: dailies },
      { table: 'time_entries', label: 'entryApproval', thenValue: entries.length },
      { table: 'time_entry_daily_summary', label: 'dailyApproval', thenValue: dailies.length },
      { table: 'time_weekly_summary', label: 'weeklyApproval', returningValue: [approvedWeekly] },
    ];
    installDatabase(
      transactionSpecs,
      detailSpecs(approvedWeekly, dailies, entries),
      events,
    );
    timeTracking.lockStaffWeek.mockImplementation(async () => events.push('week.lock'));
    timeTracking.computeDailySummaryInTransaction.mockImplementation(async () => {
      events.push('day.compute');
    });
    timeTracking.computeWeeklySummaryInTransaction.mockImplementation(async () => {
      events.push('week.compute');
      return pendingWeekly;
    });
    const reviewToken = approval._test.reviewSnapshotToken({
      weekly: pendingWeekly,
      dailies,
      entries,
    });

    const detail = await approval.approveWeek({
      technicianId: 'tech-1',
      weekStart: '2020-01-06',
      adminId: 'admin-1',
      notes: 'reviewed',
      reviewToken,
    });

    expectOrdered(events, [
      'week.lock',
      'entries.forUpdate',
      'dailiesBefore.forUpdate',
      'day.compute',
      'dailies.forUpdate',
      'week.compute',
      'dailiesAfterWeekly.forUpdate',
      'entryApproval.update',
      'dailyApproval.update',
      'weeklyApproval.update',
      'transaction.commit',
      'detailWeekly.first',
    ]);
    expect(transactionSpecs[4].updatePayload).toMatchObject({
      approval_status: 'approved',
      approved_by: 'admin-1',
      approval_notes: 'reviewed',
    });
    expect(transactionSpecs[5].updatePayload.status).toBe('approved');
    expect(transactionSpecs[6].whereArgs).toEqual([{ id: 'weekly-1', status: 'pending' }]);
    expect(timeTracking.computeWeeklySummaryInTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      'tech-1',
      '2020-01-06',
      { lock: false },
    );
    expect(detail.weekly).toMatchObject(approvedWeekly);
  });

  test('treats a fully consistent approved week as idempotent', async () => {
    const events = [];
    const entries = [{
      id: 'shift-1',
      status: 'completed',
      approval_status: 'approved',
      clock_in: WEEK_CLOCK_IN,
    }];
    const dailies = [{
      id: 'daily-1',
      status: 'approved',
      work_date: '2020-01-06',
    }];
    const weekly = { id: 'weekly-1', status: 'approved', week_start: '2020-01-06' };
    const { transactionQueue } = installDatabase([
      { table: 'time_entries', label: 'entries', thenValue: entries },
      { table: 'time_entry_daily_summary', label: 'dailiesBefore', thenValue: dailies },
      { table: 'time_entry_daily_summary', label: 'dailies', thenValue: dailies },
      { table: 'time_entry_daily_summary', label: 'dailiesAfterWeekly', thenValue: dailies },
    ], detailSpecs(weekly, dailies, entries), events);
    timeTracking.lockStaffWeek.mockResolvedValue('2020-01-06');
    timeTracking.computeWeeklySummaryInTransaction.mockResolvedValue(weekly);

    await approval.approveWeek({
      technicianId: 'tech-1',
      weekStart: '2020-01-06',
      adminId: 'admin-1',
      reviewToken: approval._test.reviewSnapshotToken({ weekly, dailies, entries }),
    });

    expect(transactionQueue).toHaveLength(0);
    expect(events).not.toContain('entryApproval.update');
    expect(events).toContain('transaction.commit');
  });

  test('requires a fresh review token after totals change', async () => {
    const events = [];
    const entries = [{
      id: 'shift-1',
      entry_type: 'shift',
      status: 'completed',
      approval_status: 'pending',
      clock_in: WEEK_CLOCK_IN,
      clock_out: new Date('2020-01-06T22:00:00.000Z'),
      duration_minutes: 480,
    }];
    const dailies = [{
      id: 'daily-1', status: 'pending', work_date: '2020-01-06',
      total_shift_minutes: 480,
    }];
    const weekly = {
      id: 'weekly-1', status: 'pending', week_start: '2020-01-06',
      total_shift_minutes: 480,
    };
    installDatabase([
      { table: 'time_entries', label: 'entries', thenValue: entries },
      { table: 'time_entry_daily_summary', label: 'dailiesBefore', thenValue: dailies },
      { table: 'time_entry_daily_summary', label: 'dailies', thenValue: dailies },
      { table: 'time_entry_daily_summary', label: 'dailiesAfterWeekly', thenValue: dailies },
    ], [], events);
    timeTracking.lockStaffWeek.mockResolvedValue('2020-01-06');
    timeTracking.computeWeeklySummaryInTransaction.mockResolvedValue(weekly);

    await expect(approval.approveWeek({
      technicianId: 'tech-1',
      weekStart: '2020-01-06',
      adminId: 'admin-1',
      reviewToken: 'stale-token',
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/changed/) });
    expect(events).not.toContain('entryApproval.update');
  });

  test('rejects a partially approved snapshot instead of mutating it', async () => {
    const events = [];
    const weekly = { id: 'weekly-1', status: 'approved', week_start: '2020-01-06' };
    const entries = [{
      id: 'shift-1',
      status: 'completed',
      approval_status: 'pending',
      clock_in: WEEK_CLOCK_IN,
    }];
    const dailies = [{ id: 'daily-1', status: 'approved', work_date: '2020-01-06' }];
    installDatabase([
      {
        table: 'time_entries',
        label: 'entries',
        thenValue: entries,
      },
      {
        table: 'time_entry_daily_summary',
        label: 'dailies',
        thenValue: dailies,
      },
      {
        table: 'time_entry_daily_summary',
        label: 'dailiesAfter',
        thenValue: dailies,
      },
      { table: 'time_entry_daily_summary', label: 'dailiesAfterWeekly', thenValue: dailies },
    ], [], events);
    timeTracking.lockStaffWeek.mockResolvedValue('2020-01-06');
    timeTracking.computeWeeklySummaryInTransaction.mockResolvedValue(weekly);

    await expect(approval.approveWeek({
      technicianId: 'tech-1',
      weekStart: '2020-01-06',
      adminId: 'admin-1',
      reviewToken: approval._test.reviewSnapshotToken({ weekly, dailies, entries }),
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/inconsistent/) });

    expect(events).toContain('transaction.rollback');
    expect(events).not.toContain('entryApproval.update');
  });

  test('rejects approved components under a still-pending weekly summary', async () => {
    const events = [];
    const weekly = { id: 'weekly-1', status: 'pending', week_start: '2020-01-06' };
    const entries = [{
      id: 'shift-1',
      status: 'completed',
      approval_status: 'pending',
      clock_in: WEEK_CLOCK_IN,
    }];
    const dailies = [{ id: 'daily-1', status: 'approved', work_date: '2020-01-06' }];
    installDatabase([
      {
        table: 'time_entries',
        label: 'entries',
        thenValue: entries,
      },
      {
        table: 'time_entry_daily_summary',
        label: 'dailies',
        thenValue: dailies,
      },
      {
        table: 'time_entry_daily_summary',
        label: 'dailiesAfter',
        thenValue: dailies,
      },
      { table: 'time_entry_daily_summary', label: 'dailiesAfterWeekly', thenValue: dailies },
    ], [], events);
    timeTracking.lockStaffWeek.mockResolvedValue('2020-01-06');
    timeTracking.computeWeeklySummaryInTransaction.mockResolvedValue(weekly);

    await expect(approval.approveWeek({
      technicianId: 'tech-1',
      weekStart: '2020-01-06',
      adminId: 'admin-1',
      reviewToken: approval._test.reviewSnapshotToken({ weekly, dailies, entries }),
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/inconsistent/) });

    expect(events).toContain('transaction.rollback');
    expect(events).not.toContain('dailyApproval.update');
  });

  test('exports only approved weekly snapshots with a date-only week value', async () => {
    const events = [];
    const dailyCandidates = {
      table: 'time_entry_daily_summary',
      label: 'dailyCandidates',
      thenValue: [{ technician_id: 'tech-1' }],
    };
    const entryCandidates = {
      table: 'time_entries',
      label: 'entryCandidates',
      thenValue: [{ technician_id: 'tech-1' }],
    };
    const payrollRows = {
      table: 'time_weekly_summary',
      label: 'payrollRows',
      thenValue: [{
        id: 'weekly-1',
        technician_id: 'tech-1',
        tech_name: 'Tech One',
        week_start: new Date('2020-01-06T00:00:00.000Z'),
        total_shift_minutes: 2460,
        overtime_minutes: 60,
        job_count: 10,
        status: 'approved',
      }],
    };
    const { trx } = installDatabase(
      [dailyCandidates, entryCandidates, payrollRows],
      [],
      events,
    );

    const csv = await approval.generateWeeklyPayrollExport('2020-01-06');

    expect(db).not.toHaveBeenCalled();
    expect(trx.raw).toHaveBeenCalledWith(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
    );
    expectOrdered(events, [
      'transaction.begin',
      'transaction.raw',
      'dailyCandidates.table',
      'entryCandidates.table',
      'payrollRows.table',
      'transaction.commit',
    ]);
    expect(payrollRows.whereInArgs).toEqual([
      'time_weekly_summary.technician_id',
      ['tech-1'],
    ]);
    expect(csv).toContain('Tech One,2020-01-06,40.00,1.00,41.00');
    expect(csv).not.toMatch(/GMT|Mon Jan/);
  });

  test('fails payroll export when any worked technician is pending or missing a snapshot', async () => {
    const events = [];
    installDatabase([
      {
        table: 'time_entry_daily_summary',
        label: 'dailyCandidates',
        thenValue: [
          { technician_id: 'tech-approved' },
          { technician_id: 'tech-pending' },
        ],
      },
      {
        table: 'time_entries',
        label: 'entryCandidates',
        thenValue: [
          { technician_id: 'tech-approved' },
          { technician_id: 'tech-missing' },
        ],
      },
      {
        table: 'time_weekly_summary',
        label: 'payrollRows',
        thenValue: [
          {
            technician_id: 'tech-approved',
            tech_name: 'Approved Tech',
            week_start: '2020-01-06',
            status: 'approved',
          },
          {
            technician_id: 'tech-pending',
            tech_name: 'Pending Tech',
            week_start: '2020-01-06',
            status: 'pending',
          },
        ],
      },
    ], [], events);

    await expect(approval.generateWeeklyPayrollExport('2020-01-06')).rejects.toMatchObject({
      statusCode: 409,
      isOperational: true,
      message: expect.stringMatching(/every worked technician.*approved weekly snapshot/i),
    });
    expect(events).toContain('transaction.rollback');
  });

  test('refuses to export an in-progress payroll week before any DB access', async () => {
    await expect(approval.generateWeeklyPayrollExport(
      '2026-07-13',
      new Date('2026-07-15T16:00:00.000Z'),
    )).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/completed Monday-Sunday week/),
    });
    expect(db).not.toHaveBeenCalled();
  });

  test('stale unlock cannot unlock a newer re-approved snapshot', async () => {
    const events = [];
    const weekly = {
      id: 'weekly-1',
      technician_id: 'tech-1',
      week_start: '2020-01-06',
      status: 'approved',
      approved_by: 'admin-2',
      approved_at: new Date('2020-01-20T12:00:00.000Z'),
    };
    const dailies = [{
      id: 'daily-1',
      work_date: '2020-01-06',
      status: 'approved',
      total_shift_minutes: 480,
    }];
    const entries = [{
      id: 'shift-1',
      entry_type: 'shift',
      status: 'completed',
      approval_status: 'approved',
      clock_in: WEEK_CLOCK_IN,
      clock_out: new Date('2020-01-06T22:00:00.000Z'),
      duration_minutes: 480,
    }];
    installDatabase([
      {
        table: 'time_weekly_summary',
        label: 'weeklyLock',
        firstValue: weekly,
      },
      { table: 'time_entry_daily_summary', label: 'dailyLocks', thenValue: dailies },
      { table: 'time_entries', label: 'entryLocks', thenValue: entries },
    ], [], events);
    timeTracking.lockStaffWeek.mockImplementation(async () => events.push('week.lock'));

    const staleReviewToken = approval._test.reviewSnapshotToken({
      weekly: {
        ...weekly,
        approved_by: 'admin-1',
        approved_at: new Date('2020-01-13T12:00:00.000Z'),
      },
      dailies,
      entries,
    });

    await expect(approval.unlockWeek({
      technicianId: 'tech-1',
      weekStart: '2020-01-06',
      adminId: 'admin-2',
      reason: 'stale retry after another admin disputed an entry',
      reviewToken: staleReviewToken,
    })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/changed after review/),
    });

    expectOrdered(events, [
      'transaction.begin',
      'week.lock',
      'weeklyLock.forUpdate',
      'weeklyLock.first',
      'dailyLocks.forUpdate',
      'entryLocks.forUpdate',
      'transaction.rollback',
    ]);
    expect(events).not.toContain('entries.update');
    expect(events).not.toContain('dailies.update');
    expect(events).not.toContain('weeklyUpdate.update');
  });

  test('unlocks a reviewed snapshot without logging its free-form reason', async () => {
    const events = [];
    const reason = 'private payroll correction details';
    const approvedWeekly = {
      id: 'weekly-1',
      technician_id: 'tech-1',
      week_start: '2020-01-06',
      status: 'approved',
      approved_by: 'admin-1',
      approved_at: new Date('2020-01-13T12:00:00.000Z'),
    };
    const approvedDailies = [{
      id: 'daily-1',
      technician_id: 'tech-1',
      work_date: '2020-01-06',
      status: 'approved',
      total_shift_minutes: 480,
    }];
    const approvedEntries = [{
      id: 'shift-1',
      technician_id: 'tech-1',
      entry_type: 'shift',
      status: 'completed',
      approval_status: 'approved',
      clock_in: WEEK_CLOCK_IN,
      clock_out: new Date('2020-01-06T22:00:00.000Z'),
      duration_minutes: 480,
    }];
    const pendingWeekly = {
      ...approvedWeekly,
      status: 'pending',
      approved_by: null,
      approved_at: null,
    };
    const pendingDailies = approvedDailies.map(daily => ({
      ...daily,
      status: 'pending',
    }));
    const pendingEntries = approvedEntries.map(entry => ({
      ...entry,
      approval_status: 'pending',
    }));
    const transactionSpecs = [
      { table: 'time_weekly_summary', label: 'weeklyLock', firstValue: approvedWeekly },
      { table: 'time_entry_daily_summary', label: 'dailyLocks', thenValue: approvedDailies },
      { table: 'time_entries', label: 'entryLocks', thenValue: approvedEntries },
      { table: 'time_entries', label: 'entriesUpdate', thenValue: 1 },
      { table: 'time_entry_daily_summary', label: 'dailyUpdate', thenValue: 1 },
      { table: 'time_weekly_summary', label: 'weeklyUpdate', thenValue: 1 },
      { table: 'time_entries', label: 'refreshEntries', thenValue: pendingEntries },
      {
        table: 'time_entry_daily_summary',
        label: 'refreshDailiesBefore',
        thenValue: pendingDailies,
      },
      {
        table: 'time_entry_daily_summary',
        label: 'refreshDailiesAfter',
        thenValue: pendingDailies,
      },
    ];
    installDatabase(transactionSpecs, [
      { table: 'time_weekly_summary', label: 'initialWeekly', firstValue: pendingWeekly },
      { table: 'technicians', label: 'detailTech', firstValue: { id: 'tech-1' } },
    ], events);
    timeTracking.lockStaffWeek.mockImplementation(async () => events.push('week.lock'));
    timeTracking.computeWeeklySummaryInTransaction.mockResolvedValue(pendingWeekly);

    const detail = await approval.unlockWeek({
      technicianId: 'tech-1',
      weekStart: '2020-01-06',
      adminId: 'admin-1',
      reason,
      reviewToken: approval._test.reviewSnapshotToken({
        weekly: approvedWeekly,
        dailies: approvedDailies,
        entries: approvedEntries,
      }),
    });

    expect(detail.weekly).toMatchObject({ id: 'weekly-1', status: 'pending' });
    expect(transactionSpecs[3].updatePayload.approval_notes).toBe(`[unlock] ${reason}`);
    expect(logger.info).toHaveBeenCalledWith('[timesheet-approval] Week unlocked', {
      weekStart: '2020-01-06',
      technicianId: 'tech-1',
      adminId: 'admin-1',
    });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(reason);
  });

  test('requires unlock before disputing an entry in an approved snapshot', async () => {
    const events = [];
    const entry = {
      id: 'shift-1',
      technician_id: 'tech-1',
      status: 'completed',
      approval_status: 'approved',
      clock_in: WEEK_CLOCK_IN,
    };
    installDatabase([
      { table: 'time_entries', label: 'entryPreview', firstValue: entry },
      { table: 'time_entries', label: 'entryLock', firstValue: entry },
      {
        table: 'time_entry_daily_summary',
        label: 'dailyLock',
        firstValue: { id: 'daily-1', status: 'approved' },
      },
      {
        table: 'time_weekly_summary',
        label: 'weeklyLock',
        firstValue: { id: 'weekly-1', status: 'approved' },
      },
    ], [], events);
    timeTracking.lockStaffWeek.mockImplementation(async () => events.push('week.lock'));

    await expect(approval.disputeEntry({
      entryId: 'shift-1',
      adminId: 'admin-1',
      reason: 'incorrect stop',
    })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/Unlock the approved week/),
    });

    expectOrdered(events, [
      'entryPreview.first',
      'week.lock',
      'entryLock.forUpdate',
      'dailyLock.forUpdate',
      'weeklyLock.forUpdate',
      'transaction.rollback',
    ]);
    expect(events).not.toContain('entryUpdate.update');
  });

  test('disputes a pending entry and clears sign-off in one transaction', async () => {
    const events = [];
    const entry = {
      id: 'shift-1',
      technician_id: 'tech-1',
      status: 'completed',
      approval_status: 'pending',
      clock_in: WEEK_CLOCK_IN,
    };
    const disputed = { ...entry, approval_status: 'disputed' };
    const specs = [
      { table: 'time_entries', label: 'entryPreview', firstValue: entry },
      { table: 'time_entries', label: 'entryLock', firstValue: entry },
      {
        table: 'time_entry_daily_summary',
        label: 'dailyLock',
        firstValue: { id: 'daily-1', status: 'pending' },
      },
      {
        table: 'time_weekly_summary',
        label: 'weeklyLock',
        firstValue: { id: 'weekly-1', status: 'pending' },
      },
      { table: 'time_entries', label: 'entryUpdate', returningValue: [disputed] },
      { table: 'time_entry_daily_summary', label: 'dailyUpdate', thenValue: 1 },
      { table: 'time_weekly_summary', label: 'weeklyUpdate', thenValue: 1 },
    ];
    installDatabase(specs, [], events);
    timeTracking.lockStaffWeek.mockImplementation(async () => events.push('week.lock'));

    await expect(approval.disputeEntry({
      entryId: 'shift-1',
      adminId: 'admin-1',
      reason: 'incorrect stop',
    })).resolves.toBe(disputed);

    expectOrdered(events, [
      'week.lock',
      'entryLock.forUpdate',
      'dailyLock.forUpdate',
      'weeklyLock.forUpdate',
      'entryUpdate.update',
      'dailyUpdate.update',
      'weeklyUpdate.update',
      'transaction.commit',
    ]);
    expect(specs[6].updatePayload).toMatchObject({
      tech_signed_at: null,
      tech_signature: null,
    });
    expect(specs[4].updatePayload.approval_notes).toBe('incorrect stop');
    expect(logger.info).toHaveBeenCalledWith('[timesheet-approval] Entry disputed', {
      entryId: 'shift-1',
      adminId: 'admin-1',
    });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('incorrect stop');
  });
});
