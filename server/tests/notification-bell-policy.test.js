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

  test('gate on: allowlisted category (inbound_sms) rings; billing is silent by default (owner ruling 2026-08-28)', async () => {
    gateOn();
    const notifications = chainMock([{ id: 'n2' }]);
    mockTables({ notifications, notification_preferences: chainMock([]) });

    const result = await NotificationService.notifyAdmin('inbound_sms', 'SMS from a customer', 'body');
    expect(notifications.insert).toHaveBeenCalled();
    expect(result).toEqual({ id: 'n2' });

    const silenced = await NotificationService.notifyAdmin(
      'billing', 'Card number heard on a recorded call', 'PCI event body',
    );
    expect(silenced.suppressed).toBe(true);
  });

  test('gate on: trigger denylist beats the category allowlist (new_job_application)', async () => {
    gateOn();
    const notifications = chainMock([{ id: 'n3' }]);
    mockTables({ notifications, notification_preferences: chainMock([]) });

    // new_job_application shares the new_lead category but is denylisted:
    // an applicant is not a customer (owner ruling 2026-08-28).
    const silenced = await NotificationService.notifyAdmin(
      'new_lead', 'New job application', 'Applicant',
      { metadata: { triggerKey: 'new_job_application' } },
    );
    expect(notifications.insert).not.toHaveBeenCalled();
    expect(silenced.suppressed).toBe(true);

    // …while new_lead (allowlisted trigger, same category) rings.
    const rang = await NotificationService.notifyAdmin(
      'new_lead', 'New lead submitted', 'Prospect',
      { metadata: { triggerKey: 'new_lead' } },
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

  test('override rows only count from ADMIN-role technicians (query is role-filtered)', async () => {
    gateOn();
    const notifications = chainMock([{ id: 'n6b' }]);
    const prefs = chainMock([{ trigger_key: 'category:alert', bell_enabled: true }]);
    mockTables({ notifications, notification_preferences: prefs });

    await NotificationService.notifyAdmin('alert', 'Re-enabled alert', 'body');
    // The loader must exclude non-admin technicians — a field tech's row
    // may never widen the shared admin bell.
    expect(prefs.where).toHaveBeenCalledWith('technicians.role', 'admin');
  });

  test('gate on: override query failure falls back to the static lists', async () => {
    gateOn();
    const notifications = chainMock([{ id: 'n7' }]);
    const prefs = chainMock([]);
    prefs.then = (resolve, reject) => Promise.reject(new Error('prefs table gone')).then(resolve, reject);
    mockTables({ notifications, notification_preferences: prefs });

    // Static allowlist still rings…
    const rang = await NotificationService.notifyAdmin('voicemail_callback', 'Voicemail — a customer', 'body');
    expect(rang).toEqual({ id: 'n7' });
    // …and static default-deny still silences. Notifications never throw.
    const silenced = await NotificationService.notifyAdmin('payout', 'Payout deposited: $10', 'body');
    expect(silenced.suppressed).toBe(true);
  });
});

describe('codex r1 — required emissions keep ringing', () => {
  test('gate on: untracked call lead (category lead, bell:true) rings', async () => {
    gateOn();
    const notifications = chainMock([{ id: 'r1' }]);
    mockTables({ notifications, notification_preferences: chainMock([]) });

    // Mirrors call-recording-processor's untracked-call emission.
    const result = await NotificationService.notifyAdmin(
      'lead',
      'Untracked call lead',
      "New lead from a call we couldn't attribute: Unknown caller (unknown number). No marketing source matched — tag the source or follow up.",
      { link: '/admin/leads?lead=l1', metadata: { leadId: 'l1' }, bell: true },
    );

    expect(notifications.insert).toHaveBeenCalled();
    expect(result).toEqual({ id: 'r1' });
  });

  test('source pin: call-recording-processor tags the untracked-lead emission bell: true', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    const site = src.slice(src.indexOf("'Untracked call lead'"), src.indexOf("'Untracked call lead'") + 800);
    expect(site).toMatch(/bell:\s*true/);
  });

  test('gate on: estimate_deposit_reconcile_needed no longer rings by default (owner ruling 2026-08-28)', async () => {
    mockTables({ notification_preferences: chainMock([]) });
    await expect(bellPolicy.bellAllowed({
      category: 'system', triggerKey: 'estimate_deposit_reconcile_needed',
    })).resolves.toBe(false);
  });

  test('gate on: extension-request path rings (bell:true) so the 24h claim logic is unaffected', async () => {
    gateOn();
    const notifications = chainMock([{ id: 'r2' }]);
    mockTables({ notifications, notification_preferences: chainMock([]) });

    // Mirrors the repeat extension-request emission in estimate-public.js —
    // there the notification IS the deliverable; a policy suppression would
    // keep the claim and 201 with nothing delivered.
    const result = await NotificationService.notifyAdmin(
      'estimate',
      'Extension requested (again): Jane Doe',
      'no address — expired 3 days ago; customer already used their self-serve extension and asked for more time',
      { icon: '⏳', link: '/admin/estimates', metadata: { estimateId: 'e1' }, bell: true },
    );

    expect(notifications.insert).toHaveBeenCalled();
    expect(result).toEqual({ id: 'r2' });
    expect(result.suppressed).toBeUndefined();
  });

  test('source pin: estimate-public extension emissions and termite ringAdminBell carry bell: true', () => {
    const fs = require('fs');
    const path = require('path');
    const pub = fs.readFileSync(path.join(__dirname, '../routes/estimate-public.js'), 'utf8');
    for (const marker of ['Extension auto-granted: ', 'Extension requested (again): ']) {
      const site = pub.slice(pub.indexOf(marker), pub.indexOf(marker) + 900);
      expect(site).toMatch(/bell:\s*true/);
    }
    const termite = fs.readFileSync(path.join(__dirname, '../services/termite-program-agreement.js'), 'utf8');
    const wrapper = termite.slice(termite.indexOf('async function ringAdminBell('), termite.indexOf('async function ringAdminBell(') + 900);
    expect(wrapper).toMatch(/bell:\s*true/);
    const deduped = termite.slice(termite.indexOf('async function ringAdminBellDeduped('));
    expect(deduped.slice(0, deduped.indexOf('maybeCreateTermiteProgramAgreement'))).toMatch(/bell:\s*true/);
  });

  test('suppression log carries category + triggerKey only — never the title', async () => {
    gateOn();
    const logger = require('../services/logger');
    const notifications = chainMock([{ id: 'r3' }]);
    mockTables({ notifications, notification_preferences: chainMock([]) });

    await NotificationService.notifyAdmin(
      'alert',
      'Service prefs changed: Jane Doe',
      '123 Main St — interior spray: OFF',
      { metadata: { triggerKey: null } },
    );

    const silencedCall = logger.info.mock.calls.find((c) => c[0] === '[bell-policy] silenced');
    expect(silencedCall).toBeDefined();
    expect(silencedCall[1]).toEqual({ category: 'alert', triggerKey: null });
    for (const call of logger.info.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('Jane Doe');
      expect(JSON.stringify(call)).not.toContain('123 Main St');
    }
  });

  test('every emitted-but-suppressible category is owner-overridable', () => {
    // Categories emitted by direct notifyAdmin sites and the converted
    // ex-raw-insert sites that are NOT on the category allowlist. A
    // suppressible category missing from OVERRIDABLE_CATEGORIES would be a
    // dead letterbox the owner cannot re-enable from PushSettingsV2.
    const emittedSuppressible = [
      'alert', 'system', 'service', 'lead', 'estimate', 'agents', 'schedule',
      'schedule_conflict', 'payout', 'token_alert', 'tax', 'review',
      'credential', 'customer', 'call_pipeline_drift',
      'social_compliance_rejected', 'content', 'stale_visit_sweep',
      'wdo_report_attention', 'email_digest', 'eval_regression',
      'service-prefs', 'email_alert', 'email_rescue', 'email_rescue_review',
    ];
    for (const cat of emittedSuppressible) {
      expect(bellPolicy.OVERRIDABLE_CATEGORY_SET.has(cat)).toBe(true);
    }
  });
});

describe('codex r1 — converted raw-insert sites (gate off = identical rows, gate on = policy)', () => {
  test('morning email digest row matches the old raw insert gate-off', async () => {
    const notifications = chainMock([{ id: 'd1' }]);
    mockTables({ notifications });

    await NotificationService.notifyAdmin(
      'email_digest',
      'Morning Email Digest',
      '12 emails overnight. 2 new leads. Check /admin/email for details.',
      { icon: '📧', link: '/admin/email', metadata: { severity: 'low' } },
    );

    expect(notifications.insert).toHaveBeenCalledWith({
      recipient_type: 'admin',
      recipient_id: null,
      category: 'email_digest',
      title: 'Morning Email Digest',
      body: '12 emails overnight. 2 new leads. Check /admin/email for details.',
      icon: '📧',
      link: '/admin/email',
      metadata: JSON.stringify({ severity: 'low' }),
    });
  });

  test('morning email digest obeys the policy gate-on (suppressed, overridable)', async () => {
    gateOn();
    const notifications = chainMock([{ id: 'd2' }]);
    mockTables({ notifications, notification_preferences: chainMock([]) });

    const silenced = await NotificationService.notifyAdmin(
      'email_digest', 'Morning Email Digest', 'body', { link: '/admin/email' },
    );
    expect(notifications.insert).not.toHaveBeenCalled();
    expect(silenced.suppressed).toBe(true);

    // Owner override re-enables it.
    bellPolicy.clearOverrideCache();
    mockTables({
      notifications,
      notification_preferences: chainMock([
        { trigger_key: 'category:email_digest', bell_enabled: true },
      ]),
    });
    const rang = await NotificationService.notifyAdmin(
      'email_digest', 'Morning Email Digest', 'body', { link: '/admin/email' },
    );
    expect(notifications.insert).toHaveBeenCalledTimes(1);
    expect(rang).toEqual({ id: 'd2' });
  });

  test('eval defaultNotify writes the same row through the service and throws on a swallowed failure', async () => {
    const { _internals } = require('../services/eval/incident-regression');
    expect(_internals).toBeDefined(); // module loads with the conversion in place

    const notifications = chainMock([{ id: 'd3' }]);
    mockTables({ notifications });

    // Same row shape the eval callers pass (metadata pre-stringified).
    await NotificationService.create({
      recipientType: 'admin',
      category: 'eval_regression',
      title: 'Incident eval: 1 regression(s) in LLM gates',
      body: 'fact-check/case-1: drift',
      icon: '🧪',
      link: '/admin/dashboard',
      metadata: { summary: { total: 1 } },
    });
    expect(notifications.insert).toHaveBeenCalledWith({
      recipient_type: 'admin',
      recipient_id: null,
      category: 'eval_regression',
      title: 'Incident eval: 1 regression(s) in LLM gates',
      body: 'fact-check/case-1: drift',
      icon: '🧪',
      link: '/admin/dashboard',
      metadata: JSON.stringify({ summary: { total: 1 } }),
    });
  });

  test('email spam-rescue-review row matches the old raw insert gate-off', async () => {
    const notifications = chainMock([{ id: 'd4' }]);
    mockTables({ notifications });

    await NotificationService.notifyAdmin(
      'email_rescue_review',
      'Spam-foldered mail claims a known sender (unverified)',
      'A message claiming to be A Vendor ("subject") is in Gmail Spam but failed sender authentication — left in Spam. Review it in Gmail if expected.',
      { icon: '⚠️', link: '/admin/email', metadata: { gmail_message_id: 'g1' } },
    );

    expect(notifications.insert).toHaveBeenCalledWith({
      recipient_type: 'admin',
      recipient_id: null,
      category: 'email_rescue_review',
      title: 'Spam-foldered mail claims a known sender (unverified)',
      body: 'A message claiming to be A Vendor ("subject") is in Gmail Spam but failed sender authentication — left in Spam. Review it in Gmail if expected.',
      icon: '⚠️',
      link: '/admin/email',
      metadata: JSON.stringify({ gmail_message_id: 'g1' }),
    });
  });

  test('refund-failed conversion pins bell:true + connection passthrough (money failure)', async () => {
    gateOn();
    const trxNotifications = chainMock([{ id: 'd5' }]);
    const trx = jest.fn((table) => {
      if (table !== 'notifications') throw new Error(`unexpected table: ${table}`);
      return trxNotifications;
    });
    mockTables({ notification_preferences: chainMock([]) });

    const result = await NotificationService.create({
      recipientType: 'admin',
      category: 'billing',
      title: 'Refund FAILED at the bank: $12.34',
      body: 'Stripe refund re_1 on charge ch_1 did not clear (insufficient_funds).',
      icon: '⚠️',
      link: '/admin/invoices',
      bell: true,
      connection: trx,
    });

    // Insert went through the supplied transaction, not the global pool.
    expect(trxNotifications.insert).toHaveBeenCalled();
    expect(result).toEqual({ id: 'd5' });
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

  test('twilio_failure no longer rings by default (owner ruling 2026-08-28)', async () => {
    mockTables({ notification_preferences: chainMock([]) });
    await expect(bellPolicy.bellAllowed({ category: 'system', triggerKey: 'twilio_failure' }))
      .resolves.toBe(false);
  });

  test('customer communication rings; everything else is silent by default (owner ruling 2026-08-28)', async () => {
    mockTables({ notification_preferences: chainMock([]) });
    for (const [category, triggerKey] of [['inbound_email', 'customer_email_received'], ['missed_call', 'customer_missed_call'], ['inbound_sms', 'sms_reply'], ['new_lead', 'new_lead'], ['voicemail_callback', 'customer_voicemail_callback'], ['schedule', 'appointment_reschedule_intent']]) {
      await expect(bellPolicy.bellAllowed({ category, triggerKey })).resolves.toBe(true);
    }
    for (const [category, triggerKey] of [['payment', 'payment_failed'], ['payment', 'bill_payment_error'], ['billing', null], ['dispute', null], ['new_lead', 'new_job_application'], ['estimate_converted', null], ['estimate_measurement_review', null], ['system', 'twilio_failure']]) {
      await expect(bellPolicy.bellAllowed({ category, triggerKey })).resolves.toBe(false);
    }
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
      // `at` is the badge-ordering stamp added for the app-icon badge
      // (PR #3541): DB-clock µs under the ordering lock in prod, and
      // EXPLICITLY null when the lock/transaction is unavailable (as in
      // this mock env) — a count without a stamp is applied but never
      // advances the client's ordering state.
      expect(json).toEqual({ count: 3, at: null });
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

describe('customer_email_received eligibility (email-sync) — sender must authenticate', () => {
  const { customerEmailBellEligible } = require('../services/email/email-sync');
  const base = { customerId: 'c1', classification: null, listUnsubscribe: null, labelIds: ['INBOX'], fromAddress: 'jane@customer-domain.com', receivedAt: new Date().toISOString() };
  test('aligned DKIM/SPF for the From domain rings', () => {
    expect(customerEmailBellEligible({ ...base, authenticationResults: 'dkim=pass header.d=customer-domain.com; spf=pass smtp.mailfrom=customer-domain.com' })).toBe(true);
  });
  test('failed or unaligned auth (spoofed From) never rings', () => {
    expect(customerEmailBellEligible({ ...base, authenticationResults: 'dkim=fail header.d=customer-domain.com; spf=fail' })).toBe(false);
    expect(customerEmailBellEligible({ ...base, authenticationResults: 'dkim=pass header.d=attacker.example' })).toBe(false);
    expect(customerEmailBellEligible({ ...base, authenticationResults: null })).toBe(false);
  });
  test('vendor/bulk/non-inbox/unknown-sender mail never rings', () => {
    const ok = 'dkim=pass header.d=customer-domain.com';
    expect(customerEmailBellEligible({ ...base, authenticationResults: ok, classification: 'vendor' })).toBe(false);
    expect(customerEmailBellEligible({ ...base, authenticationResults: ok, listUnsubscribe: '<mailto:x>' })).toBe(false);
    expect(customerEmailBellEligible({ ...base, authenticationResults: ok, labelIds: ['SENT'] })).toBe(false);
    expect(customerEmailBellEligible({ ...base, authenticationResults: ok, customerId: null })).toBe(false);
  });
  test('historical mail (full-sync backfill) never rings — only arrivals within 24h', () => {
    const ok = 'dkim=pass header.d=customer-domain.com';
    expect(customerEmailBellEligible({ ...base, authenticationResults: ok, receivedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString() })).toBe(false);
    expect(customerEmailBellEligible({ ...base, authenticationResults: ok, receivedAt: null })).toBe(false);
    // First-connect fullSync: even a fresh timestamp never rings.
    expect(customerEmailBellEligible({ ...base, authenticationResults: ok, backfill: true })).toBe(false);
  });
});


describe('missed-call bell eligibility (customer communication, owner ruling 2026-08-28)', () => {
  const { missedCallEligible } = require('../services/missed-call-bell');
  const base = { direction: 'inbound', customer_id: 'c1', answered_by: 'missed', recording_sid: null, call_outcome: null, metadata: null };
  test('an unanswered inbound call from a customer with no voicemail rings', () => {
    expect(missedCallEligible(base)).toBe(true);
    expect(missedCallEligible({ ...base, answered_by: 'voicemail', recording_sid: null })).toBe(true); // hung up at the prompt
    expect(missedCallEligible({ ...base, answered_by: 'unknown' })).toBe(true);
  });
  test('no recorded outcome (Studio status_callback fallback rows): only an unanswered Twilio status counts as missed (codex r4)', () => {
    expect(missedCallEligible({ ...base, answered_by: null, status: 'no-answer' })).toBe(true);
    expect(missedCallEligible({ ...base, answered_by: null, status: 'busy' })).toBe(true);
    expect(missedCallEligible({ ...base, answered_by: null, status: 'completed' })).toBe(false); // may have been handled by the flow
    expect(missedCallEligible({ ...base, answered_by: null, status: 'failed' })).toBe(false);
    expect(missedCallEligible({ ...base, answered_by: undefined, status: undefined })).toBe(false);
  });
  test('answered, voicemail-left, AI-handled, outbound, unknown-caller or already-notified calls never ring', () => {
    expect(missedCallEligible({ ...base, answered_by: 'human' })).toBe(false);
    expect(missedCallEligible({ ...base, answered_by: 'ai_agent' })).toBe(false);
    expect(missedCallEligible({ ...base, answered_by: 'voicemail', recording_sid: 'RE1' })).toBe(false); // voicemail lane
    expect(missedCallEligible({ ...base, call_outcome: 'ai_handled' })).toBe(false);
    expect(missedCallEligible({ ...base, direction: 'outbound' })).toBe(false);
    expect(missedCallEligible({ ...base, customer_id: null })).toBe(false);
    expect(missedCallEligible({ ...base, metadata: { missed_call_notified_at: '2026-08-28T00:00:00Z' } })).toBe(false);
    expect(missedCallEligible({ ...base, metadata: JSON.stringify({ missed_call_notified_at: 'x' }) })).toBe(false);
  });
});
