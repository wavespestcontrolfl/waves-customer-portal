/**
 * Service-line map shadow (GATE_SERVICE_LINE_MAP=shadow, owner 2026-10-25), night-run
 * side: every recommended (dry_run) or changed (apply) decision logs one night_run row
 * beside the technician the engine chose. Other decisions log nothing; a recorder
 * failure changes nothing. Synthetic ids only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const mockInserts = [];
const mockOrder = [];
let mockInsertError = null;
const mockDb = jest.fn((table) => ({
  insert: jest.fn(async (row) => {
    mockOrder.push(`insert:${table}`);
    if (mockInsertError) throw mockInsertError;
    mockInserts.push({ table, row });
  }),
}));
mockDb.fn = { now: () => 'NOW()' };
jest.mock('../models/db', () => mockDb);
jest.mock('../services/scheduling/line-technician', () => {
  const actual = jest.requireActual('../services/scheduling/line-technician');
  return { ...actual, recordLinePickShadow: jest.fn(async () => { mockOrder.push('shadow'); return null; }) };
});

const { recordLinePickShadow } = require('../services/scheduling/line-technician');
const audit = require('../services/auto-dispatch/audit');

const SERVICE = {
  id: 'visit-1', customer_id: 'cust-1', scheduled_date: '2099-07-06', window_start: '09:00', window_end: '10:00',
  technician_id: 'tech-old', status: 'confirmed', service_id: 'svc-1', service_type: 'Lawn Care Visit',
};
const NEW_PLACEMENT = { date: '2099-07-07', window_start: '10:00', window_end: '11:00', technician_id: 'tech-new' };

beforeEach(() => {
  jest.clearAllMocks();
  mockInserts.length = 0;
  mockOrder.length = 0;
  mockInsertError = null;
});

describe('auto-dispatch logDecision -> service-line shadow', () => {
  test('a dry-run recommendation records a night_run row for the new placement, after the audit row', async () => {
    await audit.logDecision('run-9', { action: 'recommended', service: SERVICE, newPlacement: NEW_PLACEMENT });
    expect(recordLinePickShadow).toHaveBeenCalledTimes(1);
    expect(recordLinePickShadow).toHaveBeenCalledWith(expect.objectContaining({
      source: 'night_run', runId: 'run-9', scheduledServiceId: 'visit-1', customerId: 'cust-1',
      date: '2099-07-07', windowStart: '10:00', windowEnd: '11:00',
      serviceId: 'svc-1', serviceType: 'Lawn Care Visit', actualTechnicianId: 'tech-new',
    }));
    expect(mockOrder).toEqual(['insert:auto_dispatch_audit_logs', 'shadow']);
  });

  test('an applied move (apply mode) records a row too', async () => {
    await audit.logDecision('run-9', { action: 'changed', service: SERVICE, newPlacement: NEW_PLACEMENT });
    expect(recordLinePickShadow).toHaveBeenCalledTimes(1);
  });

  test('a recommendation that keeps the technician names the current one as the actual', async () => {
    await audit.logDecision('run-9', { action: 'recommended', service: SERVICE, newPlacement: { date: '2099-07-07', window_start: '10:00' } });
    expect(recordLinePickShadow.mock.calls[0][0].actualTechnicianId).toBe('tech-old');
  });

  test.each(['no_change', 'skipped', 'failed'])('a %s decision records nothing', async (action) => {
    await audit.logDecision('run-9', { action, service: SERVICE });
    expect(recordLinePickShadow).not.toHaveBeenCalled();
  });

  test('a run-level decision with no visit records nothing', async () => {
    await audit.logDecision('run-9', { action: 'recommended' });
    expect(recordLinePickShadow).not.toHaveBeenCalled();
  });

  test('a failing audit insert is still swallowed and the shadow still runs', async () => {
    mockInsertError = new Error('audit down');
    await expect(audit.logDecision('run-9', { action: 'recommended', service: SERVICE, newPlacement: NEW_PLACEMENT })).resolves.toBeUndefined();
    expect(recordLinePickShadow).toHaveBeenCalledTimes(1);
  });
});
