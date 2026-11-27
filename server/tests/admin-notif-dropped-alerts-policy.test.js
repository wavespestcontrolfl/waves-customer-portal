/**
 * Regression guards for the 18 admin alerts rescued from silent suppression
 * under GATE_ADMIN_BELL_POLICY=true (combined Stripe refunds, held/blocked
 * appointment notices & emails, and content email-approval exceptions).
 *
 * Every rescued site must:
 *   1. Pass composeAdminAlert without rule violations (docs/admin-notifications.md).
 *   2. Ring with bell: true under GATE_ADMIN_BELL_POLICY=true.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((g) => g === 'adminBellPolicy'),
}));
jest.mock('../services/internal-test-customers', () => ({
  isInternalTestCustomerId: jest.fn(() => false),
}));
jest.mock('../services/property-notification-prefs', () => ({
  prefsForVisit: jest.fn(),
  resolveAppointmentPrefs: jest.fn(),
}));
jest.mock('../services/appointment-email', () => ({
  sendTechEnRouteEmail: jest.fn(),
  sendAppointmentNoShowEmail: jest.fn(),
}));
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: jest.fn(() => [{ phone: '+19415550199', name: 'Alex', role: 'primary' }]),
  getPrimaryContact: jest.requireActual('../services/customer-contact').getPrimaryContact,
  isServiceContactRole: jest.requireActual('../services/customer-contact').isServiceContactRole,
  firstNameFrom: jest.requireActual('../services/customer-contact').firstNameFrom,
  prefsUnavailable: jest.requireActual('../services/customer-contact').prefsUnavailable,
  PREFS_UNAVAILABLE: jest.requireActual('../services/customer-contact').PREFS_UNAVAILABLE,
}));
jest.mock('../services/recipient-optin', () => ({
  filterRecipientsByOptin: jest.fn(async (contacts) => contacts),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (u) => u),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async () => 'Hello'),
}));
jest.mock('../services/content/autonomous-review-queue', () => ({
  decideReviewItem: jest.fn(),
}));

const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const bellPolicy = require('../services/notification-bell-policy');
const Prefs = require('../services/property-notification-prefs');
const AppointmentEmail = require('../services/appointment-email');
const TwilioService = require('../services/twilio');
const approvals = require('../services/content/email-approvals');

function chain(result) {
  const c = {};
  for (const m of ['join', 'leftJoin', 'where', 'whereNull', 'whereNotNull', 'whereRaw', 'whereIn', 'orderBy', 'limit', 'select', 'first', 'insert', 'update', 'returning', 'onConflict', 'merge']) {
    c[m] = jest.fn(() => c);
  }
  c.first = jest.fn(async () => (Array.isArray(result) ? result[0] : result));
  c.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  c.catch = (reject) => Promise.resolve(result).catch(reject);
  return c;
}

beforeEach(() => {
  jest.clearAllMocks();
  bellPolicy.clearOverrideCache();
});

describe('rescued admin alerts ring under GATE_ADMIN_BELL_POLICY=true', () => {
  test('TwilioService._visitPrefsFor raises a structured bell:true alert when property prefs fail', async () => {
    const spy = jest.spyOn(NotificationService, 'notifyAdmin').mockResolvedValue({ id: 'n-1' });
    db.mockImplementation((table) => {
      if (table === 'notification_prefs') return chain([{ customer_id: 'cust-1', sms_enabled: true }]);
      return chain([]);
    });
    Prefs.prefsForVisit.mockRejectedValueOnce(new Error('property_prefs_down'));

    await expect(TwilioService._visitPrefsFor('cust-1', 'visit-1', 'reminder_24h_legacy'))
      .rejects.toThrow('property_prefs_down');

    expect(spy).toHaveBeenCalledWith(
      'appointment',
      'Schedule — contact customer after blocked visit text',
      'The reminder 24h text was not sent because the property notification settings could not be read.',
      expect.objectContaining({
        bell: true,
        link: '/admin/customers?customerId=cust-1',
        dedupeKey: 'property-prefs-unreadable:visit-1:reminder_24h_legacy',
      }),
    );
    spy.mockRestore();
  });

  test('TwilioService.sendTechEnRoute raises a structured bell:true alert when en-route email is held', async () => {
    const spy = jest.spyOn(NotificationService, 'notifyAdmin').mockResolvedValue({ id: 'n-2' });
    db.mockImplementation((table) => {
      if (table === 'customers') return chain([{ id: 'cust-2', first_name: 'Alex', phone: '+19415550199', email: 'alex@example.com' }]);
      if (table === 'notification_prefs') return chain([{ customer_id: 'cust-2', tech_en_route: true, sms_enabled: true, en_route_channel: 'email' }]);
      return chain([]);
    });
    Prefs.prefsForVisit.mockResolvedValueOnce({ customer_id: 'cust-2', tech_en_route: true, sms_enabled: true, en_route_channel: 'email' });
    AppointmentEmail.sendTechEnRouteEmail.mockResolvedValueOnce({ ok: false, held: true, reason: 'preferences_unavailable' });
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    sendCustomerMessage.mockResolvedValueOnce({ sent: true });

    await TwilioService.sendTechEnRoute('cust-2', 'Sam', 15, 'tok-1', { scheduledServiceId: 'visit-2' });

    expect(spy).toHaveBeenCalledWith(
      'appointment',
      'Schedule — contact customer after held en-route email',
      'Notification preferences could not be read, so the en-route email was not sent.',
      expect.objectContaining({
        bell: true,
        link: '/admin/customers?customerId=cust-2',
        dedupeKey: 'en-route-email-held:visit-2',
      }),
    );

    // Intentional holds (street_level_hold, visit_on_hold, move_hold) must NOT ring staff.
    spy.mockClear();
    for (const reason of ['street_level_hold', 'visit_on_hold', 'move_hold']) {
      Prefs.prefsForVisit.mockResolvedValueOnce({ customer_id: 'cust-2', tech_en_route: true, sms_enabled: true, en_route_channel: 'email' });
      AppointmentEmail.sendTechEnRouteEmail.mockResolvedValueOnce({ ok: false, held: true, reason });
      sendCustomerMessage.mockResolvedValueOnce({ sent: true });
      await TwilioService.sendTechEnRoute('cust-2', 'Sam', 15, 'tok-1', { scheduledServiceId: `visit-${reason}` });
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('no-show hold alerts distinguish CALLBACK_NUMBER_HOLD from prefs failures and ignore intentional holds', async () => {
    const AppointmentReminders = require('../services/appointment-reminders');
    const spy = jest.spyOn(NotificationService, 'notifyAdmin').mockResolvedValue({ id: 'n-ns' });
    const customer = { first_name: 'Alex', last_name: 'Rivera' };

    // Callback number check hold asks staff to verify number + prefs (never asserts caller disclaimed)
    // and refreshes on dedupe so an earlier generic instruction is replaced.
    await AppointmentReminders._alertHeldNoShowSms({
      customer,
      scheduledServiceId: 'visit-cb',
      customerId: 'cust-cb',
      outcome: { retryable: true, lastCode: 'CALLBACK_NUMBER_HOLD' },
    });
    expect(spy).toHaveBeenCalledWith(
      'appointment',
      expect.stringContaining('verify'),
      'A callback-number check held the no-show text; verify the number and preferences before reaching out.',
      expect.objectContaining({
        bell: true,
        refreshOnDedupe: true,
        dedupeKey: 'no-show-notice-held:visit-cb',
      }),
    );

    // Confirmed preferences-unreadable hold keeps the manual no-show text instruction.
    spy.mockClear();
    await AppointmentReminders._alertHeldNoShowSms({
      customer,
      scheduledServiceId: 'visit-pref-sms',
      customerId: 'cust-cb',
      outcome: { retryable: true, lastCode: 'PREFERENCES_UNAVAILABLE', blockedCode: 'REMINDER_PREFERENCES_HOLD' },
    });
    expect(spy).toHaveBeenCalledWith(
      'appointment',
      expect.stringContaining('no-show'),
      'Notification preferences could not be read, so the no-show text was not sent.',
      expect.objectContaining({
        bell: true,
        refreshOnDedupe: true,
        dedupeKey: 'no-show-notice-held:visit-pref-sms',
      }),
    );

    // Unknown / provider / consent lookup retryable failure directs staff to check delivery & permissions.
    spy.mockClear();
    await AppointmentReminders._alertHeldNoShowSms({
      customer,
      scheduledServiceId: 'visit-provider',
      customerId: 'cust-cb',
      outcome: { retryable: true, lastCode: 'PROVIDER_TIMEOUT' },
    });
    expect(spy).toHaveBeenCalledWith(
      'appointment',
      expect.stringContaining('delivery'),
      'The no-show text could not be delivered automatically; check delivery and contact permissions first.',
      expect.objectContaining({
        bell: true,
        refreshOnDedupe: true,
        dedupeKey: 'no-show-notice-held:visit-provider',
      }),
    );

    // Intentional SMS holds never ring staff.
    spy.mockClear();
    for (const blockedCode of ['STREET_LEVEL_HOLD', 'VISIT_ON_HOLD', 'MOVE_HOLD']) {
      await AppointmentReminders._alertHeldNoShowSms({
        customer,
        scheduledServiceId: `visit-${blockedCode}`,
        customerId: 'cust-cb',
        outcome: { retryable: true, blockedCode },
      });
    }
    expect(spy).not.toHaveBeenCalled();

    // No-show email holds ring ONLY on preferences_unavailable, not intentional holds.
    for (const reason of ['street_level_hold', 'visit_on_hold', 'move_hold']) {
      await AppointmentReminders._alertHeldNoShowEmail({
        customer,
        scheduledServiceId: `visit-${reason}`,
        customerId: 'cust-cb',
        noShowEmail: { ok: false, held: true, reason },
      });
    }
    expect(spy).not.toHaveBeenCalled();

    await AppointmentReminders._alertHeldNoShowEmail({
      customer,
      scheduledServiceId: 'visit-pref',
      customerId: 'cust-cb',
      noShowEmail: { ok: false, held: true, reason: 'preferences_unavailable' },
    });
    expect(spy).toHaveBeenCalledWith(
      'appointment',
      expect.stringContaining('no-show'),
      'Notification preferences could not be read, so the no-show email was not sent.',
      expect.objectContaining({
        bell: true,
        dedupeKey: 'no-show-email-held:visit-pref',
      }),
    );
    spy.mockRestore();
  });

  test('content email-approvals raises a bell:true alert on late/changed/oversized/failed decisions and never rings on normal success', async () => {
    const spy = jest.spyOn(NotificationService, 'notifyAdmin').mockResolvedValue({ id: 'n-3' });
    const reviewQueue = require('../services/content/autonomous-review-queue');

    // Oversized draft approval rejected -> rings with bell: true
    db.mockImplementation((table) => {
      if (table === 'autonomous_runs') {
        return chain([{ id: 'r1', action_type: 'blog', outcome: 'completed_pending_review', skip_reason: 'named_competitor_review', draft_payload: JSON.stringify({ title: 'T', body: 'B' }) }]);
      }
      if (table === 'opportunity_queue') return chain([{ id: 'o1', status: 'pending_review' }]);
      return chain([]);
    });
    const oversizedRow = { id: 'a1', token: 'EA-12345678', run_id: 'r1', opportunity_id: 'o1', kind: 'named_competitor_review', draft_sha: null, email_truncated: true, last_error: null };
    const res = await approvals._internals.executeDecision(oversizedRow, 'approved', 'owner@example.com');
    expect(res).toEqual({ skipped: 'requires_portal_review' });
    expect(spy).toHaveBeenCalledWith(
      'content',
      'Content — approve oversized content draft in portal',
      'This draft exceeded email size limits, so your emailed approval was not applied.',
      expect.objectContaining({
        bell: true,
        link: '/admin/seo',
        dedupeKey: 'content-approval-oversized:EA-12345678',
      }),
    );

    // Normal execution success -> does not ring a good-news bell (verified in finishExecution and pollReplies).
    spy.mockClear();
    reviewQueue.decideReviewItem.mockResolvedValueOnce({});
    const okRow = { id: 'a2', token: 'EA-87654321', run_id: 'r2', opportunity_id: 'o2', kind: 'named_competitor_review', draft_sha: 'sha1' };
    await approvals._internals.finishExecution(okRow, 'approved', 'owner@example.com');
    expect(spy).not.toHaveBeenCalled();
    const emailApprovalsSrc = fs.readFileSync(path.join(__dirname, '../services/content/email-approvals.js'), 'utf8');
    expect(emailApprovalsSrc).not.toMatch(/Content approved by email|Content rejected by email/);
    spy.mockRestore();
  });

  test('bellAllowed permits all rescued categories when called with bell:true under GATE_ADMIN_BELL_POLICY=true', async () => {
    db.mockImplementation(() => chain([]));
    for (const category of ['billing', 'comms', 'appointment', 'content']) {
      await expect(bellPolicy.bellAllowed({ category, options: { bell: true } })).resolves.toBe(true);
    }
  });

  test('source pin: all 4 combined-refund sites share one stable per-refund dedupeKey, link to live billing pages, and run after lifecycle work', () => {
    const stripeSrc = fs.readFileSync(path.join(__dirname, '../routes/stripe-webhook.js'), 'utf8');
    const syncIdx = stripeSrc.indexOf('syncTermForRefundedPayment(');
    const emitIdx = stripeSrc.indexOf('await emitCombinedRefundAlerts(combinedRefundAlerts);');
    expect(syncIdx).toBeGreaterThan(-1);
    expect(emitIdx).toBeGreaterThan(syncIdx);
    expect(stripeSrc).toMatch(/async function emitCombinedRefundAlerts\(alerts\)[\s\S]*?const res = await raiseAdminAlert\('billing', spec, opts\);\s*if \(!res\) \{\s*throw new Error/);
    const refundKeyMatches = stripeSrc.match(/dedupeKey:\s*`combined-refund:\$\{chargeId\}:\$\{refundId \|\| 'unknown'\}`/g) || [];
    expect(refundKeyMatches).toHaveLength(4);
    for (const action of [
      'reconcile a partial refund on a combined charge',
      'reconcile a combined charge refunded in parts',
      'reconcile a pre-settlement partial refund',
      'review a pre-settlement combined refund',
    ]) {
      const idx = stripeSrc.indexOf(action);
      expect(idx).toBeGreaterThan(-1);
      const snippet = stripeSrc.slice(Math.max(0, idx - 200), idx + 1100);
      expect(snippet).toMatch(/bell:\s*true/);
      expect(snippet).toMatch(/refreshOnDedupe:\s*true/);
      expect(snippet).toMatch(/link:\s*combinedRefundAlertLink\(/);
      expect(snippet).not.toMatch(/\/admin\/revenue/);
      expect(snippet).toMatch(/dedupeKey:\s*`combined-refund:\$\{chargeId\}:\$\{refundId \|\| 'unknown'\}`/);
      expect(snippet).not.toMatch(/await\s+raiseAdminAlert\(/);
    }
    expect(stripeSrc).toMatch(/combinedRefundAlerts\.push\(buildPreSettlementFullRefundAlert\(/);
    // Re-queued on retry when refundFence already committed.
    expect(stripeSrc).toMatch(/combinedRows\.every\(\(r\) => rowMeta\(r\)\.pre_settlement && r\.status === 'refunded'\)/);

    const apptSrc = fs.readFileSync(path.join(__dirname, '../services/appointment-reminders.js'), 'utf8');
    for (const key of ['held_notice_contact_enqueue_failed', 'no-show-notice-held:', 'no-show-email-held:']) {
      const idx = apptSrc.indexOf(key);
      expect(idx).toBeGreaterThan(-1);
      const snippet = apptSrc.slice(Math.max(0, idx - 1100), idx + 120);
      expect(snippet).toMatch(/raiseAdminAlert\(/);
      expect(snippet).toMatch(/bell:\s*true/);
    }
  });
});
