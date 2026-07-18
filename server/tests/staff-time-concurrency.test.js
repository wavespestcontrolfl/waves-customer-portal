const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.transaction = jest.fn();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return db;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const timeTracking = require('../services/time-tracking');
const {
  ACTIVE_WRITE_GENERATION,
  WEEKLY_OT_THRESHOLD_MINUTES,
} = require('../constants/staff-time');

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
    'limit',
    'offset',
    'whereNull',
    'whereNotNull',
  ]) {
    chain[method] = chainMethod(method);
  }
  chain.forUpdate = chainMethod('forUpdate');
  chain.first = async (...args) => {
    events.push(`${spec.label}.first`);
    spec.firstArgs = args;
    return spec.firstValue;
  };
  chain.insert = (payload) => {
    events.push(`${spec.label}.insert`);
    spec.insertPayload = payload;
    return chain;
  };
  chain.update = (payload) => {
    events.push(`${spec.label}.update`);
    spec.updatePayload = payload;
    return chain;
  };
  chain.onConflict = (...args) => {
    events.push(`${spec.label}.onConflict`);
    spec.onConflictArgs = args;
    return chain;
  };
  chain.merge = (payload) => {
    events.push(`${spec.label}.merge`);
    spec.mergePayload = payload;
    return chain;
  };
  chain.returning = async (...args) => {
    events.push(`${spec.label}.returning`);
    spec.returningArgs = args;
    if (spec.returningError) throw spec.returningError;
    return spec.returningValue;
  };
  chain.then = (resolve, reject) => Promise.resolve(spec.thenValue).then(resolve, reject);
  return chain;
}

function installTransaction(specs, events) {
  const queue = [...specs];
  const trx = jest.fn((table) => {
    const spec = queue.shift();
    if (!spec) throw new Error(`Unexpected transaction query for ${table}`);
    expect(table).toBe(spec.table);
    events.push(`${spec.label}.table`);
    return queryBuilder(spec, events);
  });
  trx.raw = jest.fn((sql, bindings) => {
    events.push('transaction.raw');
    return { sql, bindings };
  });
  db.transaction.mockImplementation(async (callback) => {
    events.push('transaction.begin');
    try {
      const result = await callback(trx);
      events.push('transaction.commit');
      return result;
    } catch (error) {
      events.push('transaction.rollback');
      throw error;
    }
  });
  return { trx, queue };
}

function expectOrdered(events, labels) {
  let prior = -1;
  for (const label of labels) {
    const index = events.indexOf(label);
    expect(index).toBeGreaterThan(prior);
    prior = index;
  }
}

describe('Staff active timer serialization', () => {
  beforeEach(() => {
    db.mockReset();
    db.transaction.mockReset();
    db.raw.mockReset();
    db.raw.mockImplementation((sql, bindings) => ({ sql, bindings }));
  });

  test('rejects a zero-length completed payroll interval', () => {
    const instant = new Date('2026-07-07T14:00:00.000Z');
    expect(timeTracking.isCompletedEntryIntervalValid({
      clock_in: instant,
      clock_out: instant,
      duration_minutes: 0,
    })).toBe(false);
  });

  test('quantizes a real sub-resolution shift and child interval to 0.01 minutes', async () => {
    const events = [];
    const closedAt = new Date('2026-07-14T00:30:00.100Z');
    const shift = {
      id: 'shift-rapid',
      technician_id: 'tech-1',
      clock_in: new Date('2026-07-14T00:30:00.000Z'),
    };
    const specs = [
      { table: 'time_entries', label: 'shiftLock', firstValue: shift },
      { table: 'time_entries', label: 'children', thenValue: 1 },
      {
        table: 'time_entries',
        label: 'shiftClose',
        returningValue: [{ ...shift, status: 'completed', duration_minutes: 0.01 }],
      },
    ];
    installTransaction(specs, events);

    const result = await timeTracking.closeActiveShiftAtomically('tech-1', {
      shiftId: shift.id,
      now: closedAt,
    });

    expect(specs[1].updatePayload.duration_minutes.sql).toMatch(/GREATEST\(0\.01/);
    expect(specs[2].updatePayload.duration_minutes).toBe(0.01);
    expect(result.duration).toBe(0.01);
    expect(timeTracking.isCompletedEntryIntervalValid({
      clock_in: shift.clock_in,
      clock_out: closedAt,
      duration_minutes: result.duration,
    })).toBe(true);
  });

  test('rounds daily utilization like PostgreSQL NUMERIC at a half-cent boundary', async () => {
    const events = [];
    const specs = [
      {
        table: 'time_entries',
        label: 'dailyEntries',
        thenValue: [
          { entry_type: 'shift', status: 'completed', duration_minutes: '80.00' },
          { entry_type: 'job', status: 'completed', duration_minutes: '12.82' },
        ],
      },
      {
        table: 'time_entry_daily_summary',
        label: 'dailyUpsert',
        returningValue: [{ id: 'daily-1' }],
      },
    ];
    const { trx } = installTransaction(specs, events);

    await timeTracking.computeDailySummaryInTransaction(trx, 'tech-1', '2026-07-06');

    expect(specs[1].insertPayload.utilization_pct).toBe(16.03);
  });

  test('uses the canonical scheduled-service price for daily RPMH rounding', async () => {
    const events = [];
    const specs = [
      {
        table: 'time_entries',
        label: 'dailyEntries',
        thenValue: [
          { entry_type: 'shift', status: 'completed', duration_minutes: '64.00' },
          {
            entry_type: 'job',
            status: 'completed',
            duration_minutes: '10.00',
            job_id: 'job-1',
          },
        ],
      },
      {
        table: 'scheduled_services',
        label: 'jobRevenue',
        thenValue: [{ estimated_price: '69.04' }],
      },
      {
        table: 'time_entry_daily_summary',
        label: 'dailyUpsert',
        returningValue: [{ id: 'daily-1' }],
      },
    ];
    const { trx } = installTransaction(specs, events);

    await timeTracking.computeDailySummaryInTransaction(trx, 'tech-1', '2026-07-06');

    expect(specs[1].selectArgs).toEqual(['estimated_price']);
    expect(specs[2].insertPayload.revenue_generated).toBe(69.04);
    expect(specs[2].insertPayload.rpmh_actual).toBe(64.73);
  });

  test('rounds weekly RPMH like PostgreSQL NUMERIC at a half-cent boundary', async () => {
    const events = [];
    const specs = [
      {
        table: 'time_entry_daily_summary',
        label: 'weeklyDailies',
        thenValue: [{
          id: 'daily-1',
          work_date: '2026-07-06',
          total_shift_minutes: '64.00',
          total_job_minutes: '0.00',
          total_drive_minutes: '0.00',
          overtime_minutes: '0.00',
          revenue_generated: '69.04',
          job_count: 0,
        }],
      },
      {
        table: 'time_weekly_summary',
        label: 'weeklyExisting',
        firstValue: undefined,
      },
      {
        table: 'time_weekly_summary',
        label: 'weeklyUpsert',
        returningValue: [{ id: 'weekly-1' }],
      },
    ];
    const { trx } = installTransaction(specs, events);

    await timeTracking.computeWeeklySummaryInTransaction(
      trx,
      'tech-1',
      '2026-07-06',
      { lock: false },
    );

    expect(specs[2].insertPayload.avg_rpmh).toBe(64.73);
  });

  test('locks the shift before closing children and the shift in one transaction', async () => {
    const events = [];
    const closedAt = new Date('2026-07-14T02:30:00.000Z');
    const shift = {
      id: 'shift-1',
      technician_id: 'tech-1',
      clock_in: new Date('2026-07-14T00:30:00.000Z'),
      notes: 'existing',
    };
    const specs = [
      { table: 'time_entries', label: 'shiftLock', firstValue: shift },
      { table: 'time_entries', label: 'children', thenValue: 1 },
      {
        table: 'time_entries',
        label: 'shiftClose',
        returningValue: [{ ...shift, status: 'completed', duration_minutes: 120 }],
      },
    ];
    installTransaction(specs, events);

    const result = await timeTracking.closeActiveShiftAtomically('tech-1', {
      shiftId: 'shift-1',
      now: closedAt,
      childNoteSuffix: ' [auto-closed]',
      shiftNote: 'AUTO',
    });

    expectOrdered(events, [
      'transaction.begin',
      'shiftLock.forUpdate',
      'shiftLock.first',
      'children.update',
      'shiftClose.update',
      'transaction.commit',
    ]);
    expect(specs[1].updatePayload.clock_out).toBe(closedAt);
    expect(specs[2].updatePayload.notes).toBe('existing; AUTO');
    expect(result.workDate).toBe('2026-07-13');
    expect(result.duration).toBe(120);
  });

  test('serializes clock-in on the technician row before rechecking active shifts', async () => {
    const events = [];
    const specs = [
      { table: 'technicians', label: 'technicianLock', firstValue: { id: 'tech-1' } },
      { table: 'time_entries', label: 'activeShiftCheck', firstValue: undefined },
      {
        table: 'time_entries',
        label: 'shiftInsert',
        returningValue: [{ id: 'shift-1', entry_type: 'shift' }],
      },
    ];
    installTransaction(specs, events);

    await timeTracking.clockIn('tech-1');

    expectOrdered(events, [
      'technicianLock.forUpdate',
      'technicianLock.first',
      'activeShiftCheck.first',
      'shiftInsert.insert',
      'transaction.commit',
    ]);
    expect(specs[0].whereArgs).toEqual([{ id: 'tech-1', active: true }]);
    expect(specs[2].insertPayload.staff_write_generation).toBe(ACTIVE_WRITE_GENERATION);
  });

  test('aborts a fresh clock-in when deactivation wins the technician-row lock race', async () => {
    const events = [];
    const specs = [
      { table: 'technicians', label: 'technicianLock', firstValue: undefined },
    ];
    const { queue } = installTransaction(specs, events);

    await expect(timeTracking.clockIn('tech-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'ACCOUNT_INACTIVE',
      message: expect.stringMatching(/inactive.*cancelled/i),
    });

    expect(specs[0].whereArgs).toEqual([{ id: 'tech-1', active: true }]);
    expect(events).toEqual([
      'transaction.begin',
      'technicianLock.table',
      'technicianLock.where',
      'technicianLock.forUpdate',
      'technicianLock.first',
      'transaction.rollback',
    ]);
    expect(queue).toHaveLength(0);
  });

  test('locks the shift and rejects an already-active break before inserting', async () => {
    const events = [];
    const specs = [
      { table: 'time_entries', label: 'shiftLock', firstValue: { id: 'shift-1' } },
      { table: 'time_entries', label: 'breakCheck', firstValue: { id: 'break-1' } },
    ];
    installTransaction(specs, events);

    await expect(timeTracking.startBreak('tech-1')).rejects.toThrow(/Already on break/);

    expectOrdered(events, [
      'shiftLock.forUpdate',
      'shiftLock.first',
      'breakCheck.first',
      'transaction.rollback',
    ]);
    expect(events).not.toContain('breakInsert.insert');
  });

  test('locks the shift before inserting a new break', async () => {
    const events = [];
    const specs = [
      { table: 'time_entries', label: 'shiftLock', firstValue: { id: 'shift-1' } },
      { table: 'time_entries', label: 'breakCheck', firstValue: undefined },
      {
        table: 'time_entries',
        label: 'breakInsert',
        returningValue: [{ id: 'break-1', entry_type: 'break' }],
      },
    ];
    installTransaction(specs, events);

    await timeTracking.startBreak('tech-1');

    expectOrdered(events, [
      'shiftLock.forUpdate',
      'shiftLock.first',
      'breakCheck.first',
      'breakInsert.insert',
      'transaction.commit',
    ]);
    expect(specs[2].insertPayload.staff_write_generation).toBe(ACTIVE_WRITE_GENERATION);
  });

  test('keeps job replacement rollback-safe when the generation-fenced insert fails', async () => {
    const events = [];
    const generationError = new Error('active writer generation rejected');
    const specs = [
      { table: 'time_entries', label: 'shiftLock', firstValue: { id: 'shift-1' } },
      { table: 'time_entries', label: 'oldJobClose', thenValue: 1 },
      {
        table: 'time_entries',
        label: 'jobInsert',
        returningError: generationError,
      },
    ];
    installTransaction(specs, events);

    await expect(timeTracking.startJob('tech-1', null)).rejects.toBe(generationError);

    expectOrdered(events, [
      'shiftLock.forUpdate',
      'oldJobClose.update',
      'jobInsert.insert',
      'transaction.rollback',
    ]);
    expect(specs[1].updatePayload.duration_minutes.sql).toMatch(/GREATEST\(0\.01/);
    expect(specs[2].insertPayload.staff_write_generation).toBe(ACTIVE_WRITE_GENERATION);
  });

  test.each([
    ['job', 'endJob'],
    ['break', 'endBreak'],
  ])('locks the shift and active %s before conditionally ending it', async (entryType, method) => {
    const events = [];
    const child = {
      id: `${entryType}-1`,
      entry_type: entryType,
      status: 'active',
      clock_in: new Date(Date.now() - 5 * 60 * 1000),
    };
    const specs = [
      { table: 'time_entries', label: 'shiftLock', firstValue: { id: 'shift-1' } },
      { table: 'time_entries', label: 'childLock', firstValue: child },
      {
        table: 'time_entries',
        label: 'childClose',
        returningValue: [{ ...child, status: 'completed', duration_minutes: 5 }],
      },
    ];
    installTransaction(specs, events);

    await timeTracking[method]('tech-1');

    expectOrdered(events, [
      'shiftLock.forUpdate',
      'childLock.forUpdate',
      'childLock.first',
      'childClose.update',
      'transaction.commit',
    ]);
    expect(specs[2].whereArgs).toEqual([{ id: `${entryType}-1`, status: 'active' }]);
  });

  test('ending a rapid child timer stores the minimum positive payroll quantum', async () => {
    jest.useFakeTimers();
    try {
      const now = new Date('2026-07-14T00:30:00.100Z');
      jest.setSystemTime(now);
      const events = [];
      const child = {
        id: 'job-rapid',
        entry_type: 'job',
        status: 'active',
        clock_in: new Date('2026-07-14T00:30:00.000Z'),
      };
      const specs = [
        { table: 'time_entries', label: 'shiftLock', firstValue: { id: 'shift-1' } },
        { table: 'time_entries', label: 'childLock', firstValue: child },
        {
          table: 'time_entries',
          label: 'childClose',
          returningValue: [{ ...child, status: 'completed', clock_out: now, duration_minutes: 0.01 }],
        },
      ];
      installTransaction(specs, events);

      await timeTracking.endJob('tech-1');

      expect(specs[2].updatePayload.duration_minutes).toBe(0.01);
      expect(timeTracking.isCompletedEntryIntervalValid({
        ...child,
        clock_out: now,
        duration_minutes: specs[2].updatePayload.duration_minutes,
      })).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([
    ['edit', () => timeTracking.adminEditEntry('entry-1', { edited_by: 'admin-1' })],
    ['void', () => timeTracking.voidEntry('entry-1', { voided_by: 'admin-1' })],
  ])('rejects an admin %s of an active timer before mutation', async (_action, invoke) => {
    const events = [];
    const activeEntry = {
      id: 'entry-1',
      technician_id: 'tech-1',
      status: 'active',
      clock_in: new Date(),
    };
    installTransaction([
      {
        table: 'time_entries',
        label: 'entryPreview',
        firstValue: activeEntry,
      },
      { table: 'time_entries', label: 'entryLock', firstValue: activeEntry },
    ], events);

    await expect(invoke()).rejects.toMatchObject({ statusCode: 409, isOperational: true });
    expectOrdered(events, [
      'entryPreview.first',
      'transaction.raw',
      'entryLock.forUpdate',
      'entryLock.first',
      'transaction.rollback',
    ]);
    expect(events).not.toContain('entryUpdate.update');
  });

  test('rejects an admin edit whose clock-out is not after clock-in', async () => {
    const events = [];
    const entry = {
      id: 'entry-1',
      technician_id: 'tech-1',
      status: 'completed',
      approval_status: 'pending',
      clock_in: new Date('2026-07-07T14:00:00.000Z'),
      clock_out: new Date('2026-07-07T15:00:00.000Z'),
      duration_minutes: 60,
    };
    installTransaction([
      { table: 'time_entries', label: 'entryPreview', firstValue: entry },
      { table: 'time_entries', label: 'entryLock', firstValue: entry },
      { table: 'time_entry_daily_summary', label: 'dayState', firstValue: undefined },
      { table: 'time_weekly_summary', label: 'weekState', firstValue: undefined },
    ], events);

    await expect(timeTracking.adminEditEntry('entry-1', {
      clock_out: '2026-07-07T13:00:00.000Z',
      edited_by: 'admin-1',
    })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/clock_out must be after clock_in/),
    });
    expect(events).not.toContain('entryUpdate.update');
    expect(events).toContain('transaction.rollback');
  });

  test.each([
    ['edit', () => timeTracking.adminEditEntry('entry-1', { edited_by: 'admin-1' })],
    ['void', () => timeTracking.voidEntry('entry-1', { voided_by: 'admin-1' })],
  ])('requires unlock before an admin can %s an approved entry', async (_action, invoke) => {
    const events = [];
    const approvedEntry = {
      id: 'entry-1',
      technician_id: 'tech-1',
      status: 'completed',
      approval_status: 'approved',
      clock_in: new Date('2026-07-07T14:00:00.000Z'),
    };
    installTransaction([
      {
        table: 'time_entries',
        label: 'entryPreview',
        firstValue: approvedEntry,
      },
      { table: 'time_entries', label: 'entryLock', firstValue: approvedEntry },
    ], events);

    await expect(invoke()).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/Unlock/),
    });
    expect(events).not.toContain('entryUpdate.update');
  });

  test.each([
    [
      'day',
      [
        {
          table: 'time_entry_daily_summary',
          label: 'approvedDay',
          firstValue: { id: 'daily-1', status: 'approved' },
        },
      ],
      /Reopen the approved day/,
    ],
    [
      'week',
      [
        { table: 'time_entry_daily_summary', label: 'approvedDay', firstValue: undefined },
        {
          table: 'time_weekly_summary',
          label: 'approvedWeek',
          firstValue: { id: 'weekly-1', status: 'approved' },
        },
      ],
      /Unlock the approved week/,
    ],
  ])('refuses to void an entry inside an approved %s snapshot', async (_scope, checks, message) => {
    const events = [];
    const entry = {
      id: 'entry-1',
      technician_id: 'tech-1',
      status: 'completed',
      approval_status: 'pending',
      clock_in: new Date('2026-07-07T14:00:00.000Z'),
    };
    installTransaction([
      { table: 'time_entries', label: 'entryPreview', firstValue: entry },
      { table: 'time_entries', label: 'entryLock', firstValue: entry },
      ...checks,
    ], events);

    await expect(timeTracking.voidEntry('entry-1', { voided_by: 'admin-1' })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(message),
    });
    expect(events).not.toContain('entryUpdate.update');
  });

  test('serializes an admin edit with approval and recomputes its summaries before commit', async () => {
    const events = [];
    const entry = {
      id: 'shift-1',
      technician_id: 'tech-1',
      entry_type: 'shift',
      status: 'completed',
      approval_status: 'pending',
      clock_in: new Date('2026-07-07T13:00:00.000Z'),
      clock_out: new Date('2026-07-07T21:00:00.000Z'),
      duration_minutes: 480,
    };
    const saved = { ...entry, status: 'edited', notes: 'corrected' };
    const daily = {
      id: 'daily-1',
      work_date: '2026-07-07',
      total_shift_minutes: 480,
      overtime_minutes: 0,
      status: 'pending',
    };
    const specs = [
      { table: 'time_entries', label: 'entryPreview', firstValue: entry },
      { table: 'time_entries', label: 'entryLock', firstValue: entry },
      { table: 'time_entry_daily_summary', label: 'approvedDay', firstValue: undefined },
      { table: 'time_weekly_summary', label: 'approvedWeek', firstValue: undefined },
      { table: 'time_entries', label: 'entryUpdate', returningValue: [saved] },
      { table: 'time_entries', label: 'dailyEntries', thenValue: [saved] },
      { table: 'time_entry_daily_summary', label: 'dailyUpsert', returningValue: [daily] },
      { table: 'time_entry_daily_summary', label: 'weeklyDailies', thenValue: [daily] },
      { table: 'time_weekly_summary', label: 'weeklyExisting', firstValue: undefined },
      {
        table: 'time_weekly_summary',
        label: 'weeklyUpsert',
        returningValue: [{ id: 'weekly-1', status: 'pending', week_start: '2026-07-06' }],
      },
      { table: 'time_weekly_summary', label: 'signoffClear', thenValue: 0 },
    ];
    installTransaction(specs, events);

    const updated = await timeTracking.adminEditEntry('shift-1', {
      notes: 'corrected',
      edit_reason: 'fix note',
      edited_by: 'admin-1',
    });

    expectOrdered(events, [
      'entryPreview.first',
      'transaction.raw',
      'entryLock.forUpdate',
      'approvedDay.first',
      'approvedWeek.first',
      'entryUpdate.update',
      'dailyEntries.table',
      'dailyUpsert.onConflict',
      'weeklyDailies.forUpdate',
      'weeklyExisting.forUpdate',
      'weeklyUpsert.onConflict',
      'signoffClear.update',
      'transaction.commit',
    ]);
    expect(updated).toBe(saved);
  });

  test('an admin edit resolves the last disputed entry and day before recomputing', async () => {
    const events = [];
    const entry = {
      id: 'shift-1',
      technician_id: 'tech-1',
      entry_type: 'shift',
      status: 'completed',
      approval_status: 'disputed',
      clock_in: new Date('2026-07-07T13:00:00.000Z'),
      clock_out: new Date('2026-07-07T21:00:00.000Z'),
      duration_minutes: 480,
    };
    const saved = { ...entry, status: 'edited', approval_status: 'pending' };
    const daily = {
      id: 'daily-1',
      work_date: '2026-07-07',
      total_shift_minutes: 480,
      overtime_minutes: 0,
      status: 'pending',
    };
    const specs = [
      { table: 'time_entries', label: 'entryPreview', firstValue: entry },
      { table: 'time_entries', label: 'entryLock', firstValue: entry },
      {
        table: 'time_entry_daily_summary',
        label: 'dayState',
        firstValue: { id: 'daily-1', status: 'disputed' },
      },
      {
        table: 'time_weekly_summary',
        label: 'weekState',
        firstValue: { id: 'weekly-1', status: 'pending' },
      },
      { table: 'time_entries', label: 'entryUpdate', returningValue: [saved] },
      { table: 'time_entries', label: 'remainingDispute', firstValue: undefined },
      { table: 'time_entry_daily_summary', label: 'dayResolve', thenValue: 1 },
      { table: 'time_entries', label: 'dailyEntries', thenValue: [saved] },
      { table: 'time_entry_daily_summary', label: 'dailyUpsert', returningValue: [daily] },
      { table: 'time_entry_daily_summary', label: 'weeklyDailies', thenValue: [daily] },
      { table: 'time_weekly_summary', label: 'weeklyExisting', firstValue: undefined },
      {
        table: 'time_weekly_summary',
        label: 'weeklyUpsert',
        returningValue: [{ id: 'weekly-1', status: 'pending', week_start: '2026-07-06' }],
      },
      { table: 'time_weekly_summary', label: 'signoffClear', thenValue: 0 },
    ];
    installTransaction(specs, events);

    await timeTracking.adminEditEntry('shift-1', {
      notes: 'corrected',
      edit_reason: 'resolve dispute',
      edited_by: 'admin-1',
    });

    expect(specs[4].updatePayload).toMatchObject({
      approval_status: 'pending',
      approved_by: null,
      approved_at: null,
      approval_notes: null,
    });
    expect(specs[6].updatePayload.status).toBe('pending');
    expectOrdered(events, [
      'entryUpdate.update',
      'remainingDispute.first',
      'dayResolve.update',
      'dailyEntries.table',
      'transaction.commit',
    ]);
  });

  test('reopens a stopped child only after locking the active shift', async () => {
    const events = [];
    const now = Date.now();
    const specs = [
      {
        table: 'time_entries',
        label: 'shiftLock',
        firstValue: { id: 'shift-1', clock_in: new Date(now - 60 * 60 * 1000) },
      },
      {
        table: 'time_entries',
        label: 'stoppedEntry',
        firstValue: {
          id: 'job-1',
          entry_type: 'job',
          status: 'completed',
          clock_in: new Date(now - 20 * 60 * 1000),
          clock_out: new Date(now - 5 * 60 * 1000),
        },
      },
      { table: 'time_entries', label: 'laterJobCheck', firstValue: undefined },
      { table: 'time_entries', label: 'activeJobCheck', firstValue: undefined },
      {
        table: 'time_entries',
        label: 'reopen',
        returningValue: [{ id: 'job-1', entry_type: 'job', status: 'active' }],
      },
    ];
    installTransaction(specs, events);

    const reopened = await timeTracking.reopenStoppedEntry('tech-1', 'job-1');

    expectOrdered(events, [
      'shiftLock.forUpdate',
      'shiftLock.first',
      'stoppedEntry.forUpdate',
      'stoppedEntry.first',
      'laterJobCheck.first',
      'activeJobCheck.first',
      'reopen.update',
      'transaction.commit',
    ]);
    expect(specs[4].updatePayload.staff_write_generation).toBe(ACTIVE_WRITE_GENERATION);
    expect(reopened.status).toBe('active');
  });

  test('refuses to reopen a stale stopped timer after a later same-type child', async () => {
    const events = [];
    const now = Date.now();
    installTransaction([
      {
        table: 'time_entries',
        label: 'shiftLock',
        firstValue: { id: 'shift-1', clock_in: new Date(now - 90 * 60 * 1000) },
      },
      {
        table: 'time_entries',
        label: 'stoppedEntry',
        firstValue: {
          id: 'job-1',
          entry_type: 'job',
          status: 'completed',
          clock_in: new Date(now - 45 * 60 * 1000),
          clock_out: new Date(now - 20 * 60 * 1000),
        },
      },
      { table: 'time_entries', label: 'laterJobCheck', firstValue: { id: 'job-2' } },
    ], events);

    await expect(timeTracking.reopenStoppedEntry('tech-1', 'job-1')).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/later timer exists/),
    });
    expect(events).not.toContain('reopen.update');
    expect(events).toContain('transaction.rollback');
  });

  test('refuses to reopen a child when no active shift can be locked', async () => {
    const events = [];
    installTransaction([
      { table: 'time_entries', label: 'shiftLock', firstValue: undefined },
    ], events);

    await expect(timeTracking.reopenStoppedEntry('tech-1', 'job-1')).rejects.toMatchObject({
      statusCode: 409,
      message: 'Must be clocked in to restore a stopped timer.',
    });
    expectOrdered(events, [
      'shiftLock.forUpdate',
      'shiftLock.first',
      'transaction.rollback',
    ]);
    expect(events).not.toContain('reopen.update');
  });

  test.each(['edited', 'voided'])(
    'refuses to reopen a %s child entry',
    async (status) => {
      const events = [];
      installTransaction([
        {
          table: 'time_entries',
          label: 'shiftLock',
          firstValue: { id: 'shift-1', clock_in: new Date('2026-07-13T12:00:00.000Z') },
        },
        {
          table: 'time_entries',
          label: 'stoppedEntry',
          firstValue: {
            id: 'job-1',
            entry_type: 'job',
            status,
            clock_in: new Date('2026-07-13T13:00:00.000Z'),
          },
        },
      ], events);

      await expect(timeTracking.reopenStoppedEntry('tech-1', 'job-1')).rejects.toMatchObject({
        statusCode: 409,
        message: 'Only a completed child timer can be restored.',
      });
      expect(events).not.toContain('reopen.update');
    },
  );

  test('refuses an old-shift notification under a newer active shift', async () => {
    const events = [];
    installTransaction([
      {
        table: 'time_entries',
        label: 'shiftLock',
        firstValue: { id: 'shift-2', clock_in: new Date('2026-07-14T12:00:00.000Z') },
      },
      {
        table: 'time_entries',
        label: 'stoppedEntry',
        firstValue: {
          id: 'job-1',
          entry_type: 'job',
          status: 'completed',
          clock_in: new Date('2026-07-13T13:00:00.000Z'),
        },
      },
    ], events);

    await expect(timeTracking.reopenStoppedEntry('tech-1', 'job-1')).rejects.toMatchObject({
      statusCode: 409,
      message: 'Stopped timer belongs to an earlier shift.',
    });
    expect(events).not.toContain('reopen.update');
  });

  test('all shift-closing and child-start paths use the shared lock discipline', () => {
    const serviceSource = fs.readFileSync(
      path.join(__dirname, '../services/time-tracking.js'),
      'utf8',
    );
    const cronSource = fs.readFileSync(
      path.join(__dirname, '../services/time-tracking-crons.js'),
      'utf8',
    );
    const notificationSource = fs.readFileSync(
      path.join(__dirname, '../routes/tech-notifications.js'),
      'utf8',
    );

    expect(serviceSource).toMatch(/async function clockOut[\s\S]*closeActiveShiftAtomically/);
    expect(serviceSource).toMatch(/async function autoClockOutCheck[\s\S]*closeActiveShiftAtomically/);
    expect(cronSource).toMatch(/11 PM force auto-clock-out[\s\S]*closeActiveShiftAtomically/);
    expect(serviceSource).toMatch(/async function startJob[\s\S]*lockActiveShift\(trx/);
    expect(serviceSource).toMatch(/async function startBreak[\s\S]*lockActiveShift\(trx/);
    expect(serviceSource).toMatch(/async function reopenStoppedEntry[\s\S]*lockActiveShift\(trx/);
    expect(notificationSource).toMatch(/undo-stop[\s\S]*timeTracking\.reopenStoppedEntry/);
  });
});

describe('Staff weekly overtime allocation', () => {
  beforeEach(() => {
    db.mockReset();
    db.transaction.mockReset();
  });

  test('allocates only the over-40-hour portion to the later ET work day', async () => {
    expect(WEEKLY_OT_THRESHOLD_MINUTES).toBe(2400);
    const events = [];
    const dailies = [
      { id: 'mon', work_date: '2026-07-06', total_shift_minutes: 570, overtime_minutes: 0 },
      { id: 'tue', work_date: '2026-07-07', total_shift_minutes: 570, overtime_minutes: 0 },
      { id: 'wed', work_date: '2026-07-08', total_shift_minutes: 570, overtime_minutes: 0 },
      { id: 'thu', work_date: '2026-07-09', total_shift_minutes: 570, overtime_minutes: 0 },
      { id: 'fri', work_date: '2026-07-10', total_shift_minutes: 300, overtime_minutes: 0 },
    ];
    const specs = [
      {
        table: 'time_entry_daily_summary',
        label: 'dailySelect',
        thenValue: dailies,
      },
      {
        table: 'time_entry_daily_summary',
        label: 'fridayOtUpdate',
        thenValue: 1,
      },
      { table: 'time_weekly_summary', label: 'weeklyExisting', firstValue: undefined },
      {
        table: 'time_weekly_summary',
        label: 'weeklyUpsert',
        returningValue: [{
          id: 'weekly-1',
          status: 'pending',
          week_start: '2026-07-06',
          overtime_minutes: 180,
        }],
      },
    ];
    installTransaction(specs, events);

    const summary = await timeTracking.computeWeeklySummary('tech-1', '2026-07-06');

    expectOrdered(events, [
      'transaction.raw',
      'dailySelect.forUpdate',
      'fridayOtUpdate.update',
      'weeklyExisting.forUpdate',
      'weeklyUpsert.onConflict',
      'weeklyUpsert.merge',
      'transaction.commit',
    ]);
    expect(specs[1].whereArgs).toEqual([{ id: 'fri' }]);
    expect(specs[1].updatePayload).toEqual({ overtime_minutes: 180 });
    expect(specs[3].insertPayload).toMatchObject({
      week_start: '2026-07-06',
      week_end: '2026-07-12',
      regular_minutes: 2400,
      overtime_minutes: 180,
    });
    expect(summary.overtime_minutes).toBe(180);
  });

  test('daily and weekly upserts share one serialized transaction', async () => {
    const events = [];
    const specs = [
      { table: 'time_entries', label: 'entrySelect', thenValue: [] },
      {
        table: 'time_entry_daily_summary',
        label: 'dailyUpsert',
        returningValue: [{
          id: 'daily-1',
          work_date: '2026-07-07',
          total_shift_minutes: 0,
          status: 'pending',
        }],
      },
      {
        table: 'time_entry_daily_summary',
        label: 'weeklyDailySelect',
        thenValue: [{
          id: 'daily-1',
          work_date: '2026-07-07',
          total_shift_minutes: 0,
          status: 'pending',
        }],
      },
      { table: 'time_weekly_summary', label: 'weeklyExisting', firstValue: undefined },
      {
        table: 'time_weekly_summary',
        label: 'weeklyUpsert',
        returningValue: [{ id: 'weekly-1', week_start: '2026-07-06', status: 'pending' }],
      },
    ];
    installTransaction(specs, events);

    await timeTracking.computeDailySummary('tech-1', '2026-07-07');

    expectOrdered(events, [
      'transaction.begin',
      'transaction.raw',
      'entrySelect.table',
      'dailyUpsert.onConflict',
      'dailyUpsert.merge',
      'weeklyDailySelect.forUpdate',
      'weeklyExisting.forUpdate',
      'weeklyUpsert.onConflict',
      'weeklyUpsert.merge',
      'transaction.commit',
    ]);
    expect(specs[1].onConflictArgs).toEqual([['technician_id', 'work_date']]);
    expect(specs[4].onConflictArgs).toEqual([['technician_id', 'week_start']]);
  });

  test('conditional upserts preserve approved daily and weekly snapshots', async () => {
    const events = [];
    const approvedDaily = {
      id: 'daily-1',
      work_date: '2026-07-07',
      total_shift_minutes: 480,
      overtime_minutes: 0,
      status: 'approved',
      approved_by: 'admin-1',
    };
    const approvedWeekly = {
      id: 'weekly-1',
      week_start: '2026-07-06',
      status: 'approved',
      approved_by: 'admin-1',
    };
    const specs = [
      { table: 'time_entries', label: 'entrySelect', thenValue: [] },
      { table: 'time_entry_daily_summary', label: 'dailyUpsert', returningValue: [] },
      { table: 'time_entry_daily_summary', label: 'dailyFallback', firstValue: approvedDaily },
      { table: 'time_entry_daily_summary', label: 'weeklyDailySelect', thenValue: [approvedDaily] },
      { table: 'time_weekly_summary', label: 'weeklyExisting', firstValue: approvedWeekly },
      { table: 'time_weekly_summary', label: 'weeklyUpsert', returningValue: [] },
      { table: 'time_weekly_summary', label: 'weeklyFallback', firstValue: approvedWeekly },
    ];
    installTransaction(specs, events);

    const summary = await timeTracking.computeDailySummary('tech-1', '2026-07-07');

    expect(summary).toBe(approvedDaily);
    expect(specs[1].mergePayload).not.toHaveProperty('status');
    expect(specs[1].mergePayload).not.toHaveProperty('approved_by');
    expect(specs[5].mergePayload).not.toHaveProperty('status');
    expect(specs[5].mergePayload).not.toHaveProperty('approved_by');
    expect(specs[1].whereRawArgs[0]).toMatch(/status IS DISTINCT FROM 'approved'/);
    expect(specs[5].whereRawArgs[0]).toMatch(/status IS DISTINCT FROM 'approved'/);
  });
});
