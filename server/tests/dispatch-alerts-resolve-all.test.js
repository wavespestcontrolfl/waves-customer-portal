jest.mock('../models/db', () => jest.fn());
jest.mock('../sockets', () => ({
  getIo: jest.fn(),
}));
jest.mock('../services/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const { getIo } = require('../sockets');
const dispatchAlerts = require('../services/dispatch-alerts');

function mockTransactionReturning(rows) {
  const returning = jest.fn().mockResolvedValue(rows);
  const update = jest.fn().mockReturnValue({ returning });
  const whereNull = jest.fn().mockReturnValue({ update });
  const table = jest.fn().mockReturnValue({ whereNull });
  table.fn = { now: jest.fn(() => 'NOW()') };
  db.transaction = jest.fn(async (cb) => cb(table));
  return { table, whereNull, update, returning };
}

describe('dispatch alerts bulk resolve', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('resolveAllOpenAlerts resolves every open alert and broadcasts each cleared id', async () => {
    const rows = [
      { id: 'alert-1', type: 'tech_late', severity: 'warn', resolved_at: 'NOW()', resolved_by: 'tech-1' },
      { id: 'alert-2', type: 'tech_late', severity: 'warn', resolved_at: 'NOW()', resolved_by: 'tech-1' },
      { id: 'alert-3', type: 'unassigned_overdue', severity: 'critical', resolved_at: 'NOW()', resolved_by: 'tech-1' },
    ];
    const chain = mockTransactionReturning(rows);
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    getIo.mockReturnValue({ to });

    const result = await dispatchAlerts.resolveAllOpenAlerts({ resolvedBy: 'tech-1' });

    expect(chain.table).toHaveBeenCalledWith('dispatch_alerts');
    expect(chain.whereNull).toHaveBeenCalledWith('resolved_at');
    expect(chain.update).toHaveBeenCalledWith({
      resolved_at: 'NOW()',
      resolved_by: 'tech-1',
    });
    expect(chain.returning).toHaveBeenCalledWith([
      'id', 'type', 'severity', 'tech_id', 'job_id', 'payload', 'created_at', 'resolved_at', 'resolved_by',
    ]);
    expect(result.resolved).toBe(3);
    expect(result.counts).toEqual([
      { type: 'tech_late', severity: 'warn', count: 2 },
      { type: 'unassigned_overdue', severity: 'critical', count: 1 },
    ]);
    expect(to).toHaveBeenCalledTimes(3);
    expect(to).toHaveBeenCalledWith(dispatchAlerts.ROOM);
    expect(emit).toHaveBeenCalledWith(dispatchAlerts.EVENT_RESOLVED, {
      id: 'alert-1',
      resolved_at: 'NOW()',
      resolved_by: 'tech-1',
    });
    expect(emit).toHaveBeenCalledWith(dispatchAlerts.EVENT_RESOLVED, {
      id: 'alert-2',
      resolved_at: 'NOW()',
      resolved_by: 'tech-1',
    });
    expect(emit).toHaveBeenCalledWith(dispatchAlerts.EVENT_RESOLVED, {
      id: 'alert-3',
      resolved_at: 'NOW()',
      resolved_by: 'tech-1',
    });
  });

  test('resolveAllOpenAlerts is a no-op when the queue is already clear', async () => {
    mockTransactionReturning([]);
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    getIo.mockReturnValue({ to });

    const result = await dispatchAlerts.resolveAllOpenAlerts({ resolvedBy: 'tech-1' });

    expect(result).toEqual({ resolved: 0, counts: [], alerts: [] });
    expect(to).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
