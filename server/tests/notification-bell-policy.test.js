/**
 * Admin bell policy (GATE_ADMIN_BELL_POLICY) — gate off must be
 * byte-identical to today; gate on rings only leads / inbound SMS /
 * voicemail callbacks / accepted estimates / money failures, with
 * per-category owner overrides via 'category:<cat>' pseudo-keys.
 */
const express = require('express');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
}));
jest.mock('../services/internal-test-customers', () => ({
  isInternalTestCustomerId: jest.fn(() => false),
}));
jest.mock('../services/push-notifications', () => ({
  status: jest.fn(() => ({ available: true, configured: true })),
  sendToAdminUsers: jest.fn(async () => ({ sent: 0 })),
}));
jest.mock('../services/dashboard-alerts', () => ({
  computeDashboardAlerts: jest.fn(async () => ({ alerts: [] })),
  toNotifications: jest.fn((alerts) => alerts.map((a) => ({
    id: `live:${a.id}`, title: a.title, category: 'alert', live: true,
  }))),
}));
jest.mock('../services/dashboard-alerts-cron', () => ({
  COUNT_ESCALATION_COOLDOWN_MS: {},
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireAdmin: (req, res, next) => next(),
}));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { computeDashboardAlerts } = require('../services/dashboard-alerts');
const NotificationService = require('../services/notification-service');
const bellPolicy = require('../services/notification-bell-policy');

// Generic knex-ish chain: every builder method returns the chain; awaiting
// the chain resolves `result` (same pattern as notification-triggers.test.js).
function chainMock(result) {
  const chain = {};
  const methods = [
    'join', 'where', 'whereNull', 'whereRaw', 'whereIn', 'orderBy',
    'limit', 'offset', 'select', 'first', 'insert', 'update',
    'count', 'returning', 'onConflict', 'merge',
  ];
  for (const m of methods) chain[m] = jest.fn(() => chain);
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function mockTables(tables) {
  db.mockImplementation((table) => {
    if (!(table in tables)) throw new Error(`unexpected table: ${table}`);
    return tables[table];
  });
}

const gateOn = () => isEnabled.mockImplementation((g) => g === 'adminBellPolicy');
const gateOff = () => isEnabled.mockReturnValue(false);

beforeEach(() => {
  jest.clearAllMocks();
  gateOff();
  bellPolicy.clearOverrideCache();
});

describe('NotificationService.create under the bell policy', () => {
  test('gate off: inserts are unchanged and no policy tables are queried', async () => {
    const inserted = { id: 'n1' };
    const notifications = chainMock([inserted]);
    mockTables({ notifications });

    const result = await NotificationService.notifyAdmin(
      'alert', 'Some noisy alert', 'body text', { link: '/admin/dashboard' },
    );

    expect(notifications.insert).toHaveBeenCalledWith(expect.objectContaining({
      recipient_type: 'admin',
      category: 'alert',
      title: 'Some noisy alert',
      body: 'body text',
      link: '/admin/dashboard',
    }));
    expect(result).toEqual(inserted);
  });

  test('gate on: non-allowlisted category is silenced (no row, truthy sentinel)', async () => {
    gateOn();
    const notifications = chainMock([{ id: 'n1' }]);
    mockTables({ notifications, notification_preferences: chainMock([]) });

    const result = await NotificationService.notifyAdmin('alert', 'Noise', 'body');

    expect(notifications.insert).not.toHaveBeenCalled();
    // Truthy sentinel, NOT null — callers treat null as "insert failed".
    expect(result).toEqual({ id: null, suppressed: true, reason: 'bell_policy' });
  });

  test('gate on: allowlisted category (billing exception) still rings', async () => {
    gateOn();
    const notifications = chainMock([{ id: 'n2' }]);
    mockTables({ notifications, notification_preferences: chainMock([]) });

    const result = await NotificationService.notifyAdmin(
      'billing', 'Card number heard on a recorded call', 'PCI event body',
    );

    expect(notifications.insert).toHaveBeenCalled();
    expect(result).toEqual({ id: 'n2' });
  });

  test('gate on: trigger denylist beats the category allowlist (payment_succeeded FYI)', async () => {
    gateOn();
    const notifications = chainMock([{ id: 'n3' }]);
    mockTables({ notifications, notification_preferences: chainMock([]) });

    const silenced = await NotificationService.notifyAdmin(
      'payment', 'Payment received', '$50.00 from customer',
      { metadata: { triggerKey: 'payment_succeeded' } },
    );
    expect(notifications.insert).not.toHaveBeenCalled();
    expect(silenced.suppressed).toBe(true);

    // …while payment_failed (allowlisted trigger, same category) rings.
    const rang = await NotificationService.notifyAdmin(
      'payment', 'Payment failed', '$50.00 — customer',
      { metadata: { triggerKey: 'payment_failed' } },
    );
    expect(notifications.insert).toHaveBeenCalledTimes(1);
    expect(rang).toEqual({ id: 'n3' });
  });

  test('gate on: options.bell=false silences an otherwise-ringing billing FYI', async () => {
    gateOn();
    const notifications = chainMock([{ id: 'n4' }]);
    mockTables({ notifications, notification_preferences: chainMock([]) });

    const result = await NotificationService.notifyAdmin(
      'billing', 'Trip fee charged', 'A customer — $49 trip fee.', { bell: false },
    );

    expect(notifications.insert).not.toHaveBeenCalled();
    expect(result.suppressed).toBe(true);
  });

  test('gate on: options.bell=true rings a silenced-by-default category (accepted estimate)', async () => {
    gateOn();
    const notifications = chainMock([{ id: 'n5' }]);
    mockTables({ notifications, notification_preferences: chainMock([]) });

    const result = await NotificationService.notifyAdmin(
      'estimate', 'Estimate accepted: Jane Doe', 'Quarterly — $120/quarter', { bell: true },
    );

    expect(notifications.insert).toHaveBeenCalled();
    expect(result).toEqual({ id: 'n5' });
  });

  test('gate on: category:<cat> owner override flips a default deny to allow', async () => {
    gateOn();
    const notifications = chainMock([{ id: 'n6' }]);
    const prefs = chainMock([{ trigger_key: 'category:alert', bell_enabled: true }]);
    mockTables({ notifications, notification_preferences: prefs });

    const result = await NotificationService.notifyAdmin('alert', 'Re-enabled alert', 'body');

    expect(prefs.where).toHaveBeenCalledWith(
      'notification_preferences.trigger_key', 'like', 'category:%',
    );
    expect(notifications.insert).toHaveBeenCalled();
    expect(result).toEqual({ id: 'n6' });
  });

  test('gate on: override query failure falls back to the static lists', async () => {
    gateOn();
    const notifications = chainMock([{ id: 'n7' }]);
    const prefs = chainMock([]);
    prefs.then = (resolve, reject) => Promise.reject(new Error('prefs table gone')).then(resolve, reject);
    mockTables({ notifications, notification_preferences: prefs });

    // Static allowlist still rings…
    const rang = await NotificationService.notifyAdmin('dispute', 'Dispute opened: $80', 'body');
    expect(rang).toEqual({ id: 'n7' });
    // …and static default-deny still silences. Notifications never throw.
    const silenced = await NotificationService.notifyAdmin('payout', 'Payout deposited: $10', 'body');
    expect(silenced.suppressed).toBe(true);
  });
});

describe('bellAllowed decision order', () => {
  beforeEach(() => {
    mockTables({ notification_preferences: chainMock([]) });
  });

  test('explicit options.bell wins over everything', async () => {
    await expect(bellPolicy.bellAllowed({
      category: 'payment', triggerKey: 'payment_succeeded', options: { bell: true },
    })).resolves.toBe(true);
    await expect(bellPolicy.bellAllowed({
      category: 'new_lead', triggerKey: 'new_lead', options: { bell: false },
    })).resolves.toBe(false);
  });

  test('twilio_failure keeps ringing even with a category:system override off', async () => {
    mockTables({
      notification_preferences: chainMock([
        { trigger_key: 'category:system', bell_enabled: false },
      ]),
    });
    await expect(bellPolicy.bellAllowed({ category: 'system', triggerKey: 'twilio_failure' }))
      .resolves.toBe(true);
    // A plain system-category notification stays silenced.
    await expect(bellPolicy.bellAllowed({ category: 'system' })).resolves.toBe(false);
  });
});

describe('converted raw-insert sites (gate off = identical rows)', () => {
  test('stripe payout FYI produces the same row shape as the old raw insert', async () => {
    const notifications = chainMock([{ id: 'n8' }]);
    mockTables({ notifications });

    await NotificationService.notifyAdmin(
      'payout',
      'Payout deposited: $12.34',
      'Stripe payout of $12.34 has been deposited to your Capital One account.',
      { icon: '🏦', link: '/admin/banking' },
    );

    expect(notifications.insert).toHaveBeenCalledWith({
      recipient_type: 'admin',
      recipient_id: null,
      category: 'payout',
      title: 'Payout deposited: $12.34',
      body: 'Stripe payout of $12.34 has been deposited to your Capital One account.',
      icon: '🏦',
      link: '/admin/banking',
      metadata: null,
    });
  });

  test('stripe dispute row preserves category/title/body/icon/link exactly', async () => {
    const notifications = chainMock([{ id: 'n9' }]);
    mockTables({ notifications });

    await NotificationService.notifyAdmin(
      'dispute',
      'Dispute opened: $80.00',
      'Reason: fraudulent. Respond by soon. Charge: ch_123',
      { icon: '⚠️', link: '/admin/invoices' },
    );

    expect(notifications.insert).toHaveBeenCalledWith({
      recipient_type: 'admin',
      recipient_id: null,
      category: 'dispute',
      title: 'Dispute opened: $80.00',
      body: 'Reason: fraudulent. Respond by soon. Charge: ch_123',
      icon: '⚠️',
      link: '/admin/invoices',
      metadata: null,
    });
  });

  test('call-pipeline drift row keeps its category/title/body (icon falls back to the category default)', async () => {
    const notifications = chainMock([{ id: 'n10' }]);
    mockTables({ notifications });

    await NotificationService.notifyAdmin(
      'call_pipeline_drift',
      'Call pipeline drift alert',
      'Nightly self-audit breached thresholds: auditor down. Sample: 0 calls.',
    );

    expect(notifications.insert).toHaveBeenCalledWith({
      recipient_type: 'admin',
      recipient_id: null,
      category: 'call_pipeline_drift',
      title: 'Call pipeline drift alert',
      body: 'Nightly self-audit breached thresholds: auditor down. Sample: 0 calls.',
      // The service fills the category-default icon where the raw insert
      // left the column null — the only intentional field difference.
      icon: '🔔',
      link: null,
      metadata: null,
    });
  });
});

describe('live dashboard-alert overlay under the bell policy', () => {
  const adminNotificationsRouter = require('../routes/admin-notifications');

  function appServer() {
    const app = express();
    app.use(express.json());
    app.use('/admin/notifications', adminNotificationsRouter);
    app.use((err, _req, res, _next) => {
      res.status(err.status || 500).json({ error: err.message });
    });
    const server = app.listen(0);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return { server, baseUrl };
  }

  async function withServer(fn) {
    const { server, baseUrl } = appServer();
    try {
      await fn(baseUrl);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  test('gate on: GET / serves persisted rows only and never computes live alerts', async () => {
    gateOn();
    computeDashboardAlerts.mockResolvedValue({ alerts: [{ id: 'churn-risk', count: 143, title: '143 customers at churn risk' }] });
    const persisted = [{ id: 'p1', category: 'new_lead', title: 'New lead', metadata: null }];
    mockTables({ notifications: chainMock(persisted) });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/notifications/`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.notifications).toEqual(persisted);
    });
    expect(computeDashboardAlerts).not.toHaveBeenCalled();
  });

  test('gate on: unread-count is the persisted count only', async () => {
    gateOn();
    computeDashboardAlerts.mockResolvedValue({ alerts: [{ id: 'churn-risk', count: 143, title: '143 customers at churn risk' }] });
    mockTables({ notifications: chainMock([{ count: '3' }]) });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/notifications/unread-count`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json).toEqual({ count: 3 });
    });
    expect(computeDashboardAlerts).not.toHaveBeenCalled();
  });

  test('gate off: live alerts still merge in front of the persisted feed', async () => {
    gateOff();
    computeDashboardAlerts.mockResolvedValue({ alerts: [{ id: 'churn-risk', count: 143, title: '143 customers at churn risk' }] });
    const persisted = [{ id: 'p1', category: 'new_lead', title: 'New lead', metadata: null }];
    mockTables({
      notifications: chainMock(persisted),
      dashboard_alert_dismissed: chainMock([]),
    });
    // Dismissals load via db.raw in the live overlay path.
    db.raw = jest.fn(async () => ({ rows: [] }));

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/notifications/`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.notifications).toHaveLength(2);
      expect(json.notifications[0]).toMatchObject({ id: 'live:churn-risk', live: true });
      expect(json.notifications[1]).toMatchObject({ id: 'p1' });
    });
    expect(computeDashboardAlerts).toHaveBeenCalled();
  });
});
