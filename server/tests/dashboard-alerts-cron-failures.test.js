/**
 * dashboard-alerts-cron: an alert whose read failed this tick (listed in
 * computeDashboardAlerts().failures) was treated as cleared, so its state row
 * was deleted and the next tick pushed it again as new. The row is now kept,
 * the run reports failedIds, and the scheduler body throws after the state
 * write so job_health records the failure.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/dashboard-alerts', () => ({ computeDashboardAlerts: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => undefined) }));
jest.mock('../models/db', () => {
  const state = { rows: [], deleted: [], inserted: [], updated: [] };
  const trxFn = (table) => {
    if (table !== 'dashboard_alert_state') throw new Error(`unexpected table ${table}`);
    const q = {
      select: async () => state.rows,
      insert: (row) => { state.inserted.push(row.alert_id); return { onConflict: () => ({ merge: async () => undefined }) }; },
      where: (filter) => ({
        update: async () => { state.updated.push(filter.alert_id); },
        del: async () => { state.deleted.push(filter.alert_id); },
      }),
    };
    return q;
  };
  trxFn.raw = jest.fn(async () => undefined);
  const db = jest.fn();
  db.transaction = jest.fn(async (fn) => fn(trxFn));
  db.__state = state;
  return db;
});

const db = require('../models/db');
const logger = require('../services/logger');
const { computeDashboardAlerts } = require('../services/dashboard-alerts');
const { triggerNotification } = require('../services/notification-triggers');
const { runDashboardAlertsCheck } = require('../services/dashboard-alerts-cron');

const row = (alert_id, count = 1) => ({
  alert_id, severity: 'critical', current_count: count, last_pushed_count: count,
  first_seen_at: new Date(), last_seen_at: new Date(), last_pushed_at: new Date(),
});

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(db.__state, { rows: [], deleted: [], inserted: [], updated: [] });
});

describe('failed alert reads', () => {
  test('keep the state row of an id whose read failed; a really cleared id is still deleted', async () => {
    db.__state.rows = [row('payments_failed_today'), row('ar_overdue_60'), row('stale_draft_invoices')];
    computeDashboardAlerts.mockResolvedValue({
      alerts: [{ id: 'stale_draft_invoices', label: 'Stale drafts', severity: 'warning', count: 1, href: '/admin/invoices' }],
      failures: [{ id: 'payments_failed_today' }],
    });

    const result = await runDashboardAlertsCheck();

    expect(db.__state.deleted).toEqual(['ar_overdue_60']);
    expect(result).toMatchObject({ fired: 0, cleared: 1, current: 1, failedIds: ['payments_failed_today'] });
    // Nothing fires for the failed id this tick, and next tick it is not "new".
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('the same failed read on consecutive ticks never re-fires the push', async () => {
    db.__state.rows = [row('payments_failed_today', 3)];
    computeDashboardAlerts.mockResolvedValue({ alerts: [], failures: [{ id: 'payments_failed_today' }] });
    await runDashboardAlertsCheck();
    await runDashboardAlertsCheck();
    expect(db.__state.deleted).toEqual([]);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a clean tick reports no failedIds', async () => {
    computeDashboardAlerts.mockResolvedValue({ alerts: [], failures: [] });
    const result = await runDashboardAlertsCheck();
    expect(result).toEqual({ fired: 0, cleared: 0, current: 0 });
  });

  test('a new alert still fires once even when another read failed', async () => {
    computeDashboardAlerts.mockResolvedValue({
      alerts: [{ id: 'leads_awaiting_contact', label: 'Leads waiting', severity: 'critical', count: 2, href: '/admin/leads' }],
      failures: [{ id: 'ar_overdue_60' }],
    });
    const result = await runDashboardAlertsCheck();
    expect(result.fired).toBe(1);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
