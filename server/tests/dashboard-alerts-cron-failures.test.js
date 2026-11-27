/**
 * dashboard-alerts-cron: an alert whose read failed this tick (listed in
 * computeDashboardAlerts().failures) was treated as cleared, so its state row
 * was deleted and the next tick pushed it again as new. The row is now kept,
 * the run reports failedIds, and the scheduler body throws after the state
 * write so job_health records the failure.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/dashboard-alerts', () => ({ computeDashboardAlerts: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => undefined) }));
jest.mock('../services/audit-log', () => ({ auditBellPolicyMuted: jest.fn(async () => 0) }));
jest.mock('../models/db', () => {
  const state = { rows: [], deleted: [], inserted: [], updated: [], insertedRows: [], mergePatches: [], updatePatches: [] };
  const trxFn = (table) => {
    if (table !== 'dashboard_alert_state') throw new Error(`unexpected table ${table}`);
    const q = {
      select: async () => state.rows,
      insert: (row) => {
        state.inserted.push(row.alert_id);
        state.insertedRows.push(row);
        return {
          onConflict: () => ({
            merge: async (patch) => { state.mergePatches.push({ alert_id: row.alert_id, patch }); },
          }),
        };
      },
      where: (filter) => ({
        update: async (patch) => {
          state.updated.push(filter.alert_id);
          state.updatePatches.push({ alert_id: filter.alert_id, patch });
        },
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
const { isEnabled } = require('../config/feature-gates');
const { computeDashboardAlerts } = require('../services/dashboard-alerts');
const { triggerNotification } = require('../services/notification-triggers');
const { auditBellPolicyMuted } = require('../services/audit-log');
const { runDashboardAlertsCheck } = require('../services/dashboard-alerts-cron');

const row = (alert_id, count = 1) => ({
  alert_id, severity: 'critical', current_count: count, last_pushed_count: count,
  first_seen_at: new Date(), last_seen_at: new Date(), last_pushed_at: new Date(),
});

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockReturnValue(false);
  Object.assign(db.__state, { rows: [], deleted: [], inserted: [], updated: [], insertedRows: [], mergePatches: [], updatePatches: [] });
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

  test('a grouped read that failed keeps the state row of every alert id it emits', async () => {
    db.__state.rows = [row('admin_waveguard_inventory_forecast'), row('admin_lawn_pricing_invariant_sweep'), row('ar_overdue_60')];
    computeDashboardAlerts.mockResolvedValue({
      alerts: [],
      failures: [{ id: 'persisted_admin_alerts', alertIds: ['admin_waveguard_inventory_forecast', 'admin_lawn_pricing_invariant_sweep'] }],
    });

    const result = await runDashboardAlertsCheck();

    expect(db.__state.deleted).toEqual(['ar_overdue_60']);
    expect(result.failedIds).toEqual(['admin_waveguard_inventory_forecast', 'admin_lawn_pricing_invariant_sweep']);
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

describe('bell policy silenced (GATE_ADMIN_BELL_POLICY=true)', () => {
  test('maintains dashboard_alert_state without stamping fake last_pushed_* and audits new/escalated muted alerts post-commit', async () => {
    isEnabled.mockImplementation((g) => g === 'adminBellPolicy');
    db.__state.rows = [row('ar_overdue_60', 2), row('churn_at_risk', 10), row('stale_draft_invoices', 1)];
    computeDashboardAlerts.mockResolvedValue({
      alerts: [
        { id: 'closeout_gaps_today', label: '2 visits not closed out', severity: 'warn', count: 2, href: '/admin/dispatch' },
        { id: 'ar_overdue_60', label: '5 invoices overdue', severity: 'critical', count: 5, amount: 1200, href: '/admin/invoices' },
        { id: 'churn_at_risk', label: '10 customers at risk', severity: 'warn', count: 10, href: '/admin/customers' },
      ],
      failures: [],
    });

    const result = await runDashboardAlertsCheck();

    expect(result).toEqual({ fired: 0, cleared: 1, current: 3 });
    expect(triggerNotification).not.toHaveBeenCalled();
    expect(db.__state.deleted).toEqual(['stale_draft_invoices']);
    expect(db.__state.insertedRows).toEqual([
      expect.objectContaining({
        alert_id: 'closeout_gaps_today',
        current_count: 2,
        last_pushed_count: null,
        last_pushed_at: null,
        last_label: '2 visits not closed out',
      }),
    ]);
    expect(db.__state.mergePatches[0].patch).not.toHaveProperty('last_pushed_at');
    expect(db.__state.mergePatches[0].patch).not.toHaveProperty('last_pushed_count');
    expect(db.__state.updatePatches).toEqual([
      {
        alert_id: 'ar_overdue_60',
        patch: expect.objectContaining({
          severity: 'critical',
          current_count: 5,
          last_label: '5 invoices overdue',
        }),
      },
      {
        alert_id: 'churn_at_risk',
        patch: expect.objectContaining({
          severity: 'warn',
          current_count: 10,
          last_label: '10 customers at risk',
        }),
      },
    ]);
    for (const u of db.__state.updatePatches) {
      expect(u.patch).not.toHaveProperty('last_pushed_at');
      expect(u.patch).not.toHaveProperty('last_pushed_count');
    }
    // New + growing alerts leave the muted-policy audit record; steady churn_at_risk does not repeat.
    expect(auditBellPolicyMuted).toHaveBeenCalledTimes(2);
    expect(auditBellPolicyMuted).toHaveBeenCalledWith({
      category: 'alert',
      triggerKey: 'dashboard_alert',
      title: '2 visits not closed out',
    });
    expect(auditBellPolicyMuted).toHaveBeenCalledWith({
      category: 'alert',
      triggerKey: 'dashboard_alert',
      title: '5 invoices overdue ($1,200)',
    });
  });
});

describe('every alert id the dashboard emits has a failure entry', () => {
  // A generator whose failure names a different id (or none) loses its alerts'
  // state rows on a failed read, and the next clean tick pushes them as new.
  test('each emitted alert id is a failure id or listed in a failure\'s alertIds', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'dashboard-alerts.js'), 'utf8');
    const emitted = new Set([...src.matchAll(/^\s+id: '([a-z0-9_]+)'/gm)].map((m) => m[1]));
    const covered = new Set();
    for (const m of src.matchAll(/failures\.push\(\{ id: '([a-z0-9_]+)'(?:, alertIds: \[([^\]]*)\])? \}\)/g)) {
      covered.add(m[1]);
      for (const a of (m[2] || '').matchAll(/'([a-z0-9_]+)'/g)) covered.add(a[1]);
    }
    expect(emitted.size).toBeGreaterThan(10);
    expect([...emitted].filter((id) => !covered.has(id)).sort()).toEqual([]);
  });
});
