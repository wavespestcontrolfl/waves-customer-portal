jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/internal-test-customers', () => ({
  isInternalTestCustomerId: jest.fn(() => false),
}));
jest.mock('../services/push-notifications', () => ({
  sendToCustomer: jest.fn(),
  resolveNotificationPropertyId: jest.fn(async () => null),
}));
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const logger = require('../services/logger');
const PushService = require('../services/push-notifications');
const NotificationService = require('../services/notification-service');

function preferenceQuery(row) {
  const q = {
    where: jest.fn(() => q),
    first: jest.fn(async () => row),
  };
  return q;
}

function notificationQuery({ existing = null, inserted = null } = {}) {
  const q = {
    where: jest.fn(() => q),
    whereRaw: jest.fn(() => q),
    first: jest.fn(async () => existing),
    insert: jest.fn(() => q),
    returning: jest.fn(async () => inserted ? [inserted] : []),
  };
  return q;
}

function setupDb({ prefs = null, existing = null, inserted = { id: 'notification-1' } } = {}) {
  const prefQ = preferenceQuery(prefs);
  const notifQ = notificationQuery({ existing, inserted });
  const trx = jest.fn((table) => {
    if (table === 'notifications') return notifQ;
    throw new Error(`Unexpected transaction table ${table}`);
  });
  trx.raw = jest.fn(async () => ({}));
  db.transaction = jest.fn(async (fn) => fn(trx));
  db.mockImplementation((table) => {
    if (table === 'notification_prefs') return prefQ;
    if (table === 'notifications') return notifQ;
    throw new Error(`Unexpected table ${table}`);
  });
  return { prefQ, notifQ, trx };
}

describe('customer notification native push dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    PushService.sendToCustomer.mockResolvedValue({ subscriptions: 1, sent: 1, expired: 0, failed: 0, skipped: 0 });
  });

  test('persists one bell and queues its native push with a stable event tag without awaiting the provider', async () => {
    const { notifQ, trx } = setupDb({ prefs: { tech_en_route: true } });
    let resolvePush;
    PushService.sendToCustomer.mockReturnValue(new Promise((resolve) => {
      resolvePush = resolve;
    }));

    const result = await NotificationService.notifyCustomer(
      'customer-1',
      'service',
      'Technician en route',
      'Your technician is on the way.',
      {
        link: '/?tab=visits',
        preferenceKey: 'tech_en_route',
        dedupeKey: 'scheduled-service:service-1:en-route',
        metadata: { scheduledServiceId: 'service-1' },
      },
    );

    expect(notifQ.insert).toHaveBeenCalledWith(expect.objectContaining({
      recipient_type: 'customer',
      recipient_id: 'customer-1',
      metadata: JSON.stringify({
        scheduledServiceId: 'service-1',
        dedupeKey: 'scheduled-service:service-1:en-route',
      }),
    }));
    expect(trx.raw).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext(?))',
      ['customer-1:scheduled-service:service-1:en-route'],
    );
    expect(PushService.sendToCustomer).toHaveBeenCalledWith('customer-1', {
      title: 'Technician en route',
      body: 'Your technician is on the way.',
      url: '/?tab=visits',
      category: 'service',
      notificationId: 'notification-1',
      tag: 'scheduled-service:service-1:en-route',
    }, { notificationId: 'notification-1' });
    expect(result.push).toEqual({ queued: true });
    resolvePush({ subscriptions: 1, sent: 1, expired: 0, failed: 0, skipped: 0 });
  });

  test('honors a disabled customer event preference before bell or push', async () => {
    const { notifQ } = setupDb({ prefs: { service_completed: false } });

    const result = await NotificationService.notifyCustomer(
      'customer-1',
      'service',
      'Service completed',
      'Your service is complete.',
      { preferenceKey: 'service_completed', dedupeKey: 'service-1:completed' },
    );

    expect(result).toEqual({ id: null, suppressed: true, reason: 'preference_disabled' });
    expect(notifQ.insert).not.toHaveBeenCalled();
    expect(PushService.sendToCustomer).not.toHaveBeenCalled();
  });

  test('dedupes a replayed lifecycle event before a second push', async () => {
    const existing = { id: 'existing-notification', title: 'Service completed' };
    const { notifQ } = setupDb({ prefs: { service_completed: true }, existing });

    const result = await NotificationService.notifyCustomer(
      'customer-1',
      'service',
      'Service completed',
      'Your service is complete.',
      { preferenceKey: 'service_completed', dedupeKey: 'service-1:completed' },
    );

    expect(result).toEqual({ ...existing, deduped: true, push: null });
    expect(notifQ.insert).not.toHaveBeenCalled();
    expect(PushService.sendToCustomer).not.toHaveBeenCalled();
  });

  test('keeps the durable bell successful when queued push dispatch fails', async () => {
    setupDb();
    PushService.sendToCustomer.mockRejectedValue(new Error('provider unavailable'));

    const result = await NotificationService.notifyCustomer(
      'customer-1',
      'account',
      'Estimate accepted',
      'Your service plan is confirmed.',
      { dedupeKey: 'estimate:estimate-1:accepted' },
    );

    expect(result).toMatchObject({ id: 'notification-1', push: { queued: true } });
    await Promise.resolve();
    expect(logger.warn).toHaveBeenCalledWith('[notifications] Customer push dispatch failed: provider unavailable');
  });

  test('awaited advisory returns sanitized provider acceptance and passes the final-send guard', async () => {
    setupDb();
    const shouldContinue = async () => true;
    PushService.sendToCustomer.mockResolvedValue({ subscriptions: 3, sent: 1, failed: 1, expired: 1, skipped: 0, results: ['provider-private-detail'] });
    const result = await NotificationService.notifyCustomer('customer-1', 'lawn_health', 'Plan', 'Conditional instructions', {
      preferenceKey: 'weather_alerts', dedupeKey: 'weekly:week-1', awaitPush: true,
      pushOptions: { ephemeral: true, shouldContinue },
    });
    expect(result.push).toEqual({ queued: true, subscriptions: 3, accepted: 1, failed: 1, expired: 1, skipped: 0 });
    expect(PushService.sendToCustomer).toHaveBeenCalledWith('customer-1', expect.objectContaining({ ephemeral: true }), { ephemeral: true, shouldContinue, notificationId: 'notification-1' });
  });

  test('an awaited provider rejection preserves the bell and records failure without claiming acceptance', async () => {
    setupDb();
    PushService.sendToCustomer.mockRejectedValue(new Error('offline'));
    const result = await NotificationService.notifyCustomer('customer-1', 'lawn_health', 'Plan', 'Body', { awaitPush: true });
    expect(result).toMatchObject({ id: 'notification-1', push: { queued: true, error: 'dispatch_failed' } });
    expect(result.push).not.toHaveProperty('accepted');
  });

  test.each(['refused', 'throws'])('a guard %s after waiting for the dedupe lock prevents bell and push', async (mode) => {
    const { notifQ, trx } = setupDb();
    let releaseLock;
    let lockEntered;
    const entered = new Promise((resolve) => { lockEntered = resolve; });
    trx.raw.mockImplementationOnce(() => new Promise((resolve) => {
      releaseLock = resolve;
      lockEntered();
    }));
    let valid = true;
    const shouldContinue = jest.fn(async () => {
      if (!valid && mode === 'throws') throw new Error('ownership lost');
      return valid;
    });
    const pending = NotificationService.notifyCustomer('customer-1', 'lawn_health', 'Report ready', 'Current tip', {
      dedupeKey: 'assessment-1', awaitPush: true, pushOptions: { shouldContinue },
    });
    await entered;
    valid = false;
    releaseLock();
    const result = await pending;
    if (mode === 'throws') expect(result).toBeNull();
    else expect(result).toMatchObject({ suppressed: true, reason: 'pre_send_check_blocked' });
    expect(shouldContinue).toHaveBeenCalledTimes(1);
    expect(notifQ.insert).not.toHaveBeenCalled();
    expect(PushService.sendToCustomer).not.toHaveBeenCalled();
  });

  test.each([
    ['legacy true', true, true, true],
    ['structured success', { ok: true, validUntil: Date.now() + 60000 }, true, true],
    ['structured refusal', { ok: false }, true, false],
    ['expired authority', { ok: true, validUntil: 0 }, true, false],
    ['invalid authority', { ok: true, validUntil: NaN }, true, false],
    ['closed window', { ok: true }, false, false],
  ])('bell and push enforce %s at the structured guard boundary', async (_label, verdict, windowOpen, allowed) => {
    const { notifQ } = setupDb();
    const preSendCheck = Object.assign(jest.fn(async () => verdict), { isStillValid: () => windowOpen });
    const shouldContinue = require('../services/messaging/push-channel-routing')._test.windowGuardFrom(preSendCheck);
    const result = await NotificationService.notifyCustomer('customer-1', 'lawn_health', 'Report ready', 'Current tip', {
      dedupeKey: 'assessment-1', awaitPush: true, pushOptions: { shouldContinue },
    });
    if (allowed) {
      expect(notifQ.insert).toHaveBeenCalledTimes(1);
      expect(PushService.sendToCustomer).toHaveBeenCalledTimes(1);
      expect(result.id).toBe('notification-1');
    } else {
      expect(result).toMatchObject({ suppressed: true });
      expect(notifQ.insert).not.toHaveBeenCalled();
      expect(PushService.sendToCustomer).not.toHaveBeenCalled();
    }
  });

  test('fails closed when an unknown preference key is supplied', async () => {
    const { notifQ } = setupDb();

    const result = await NotificationService.notifyCustomer(
      'customer-1',
      'account',
      'Account update',
      'Your account changed.',
      { preferenceKey: 'not_a_real_preference' },
    );

    expect(result.suppressed).toBe(true);
    expect(notifQ.insert).not.toHaveBeenCalled();
    expect(PushService.sendToCustomer).not.toHaveBeenCalled();
  });
});

// Admin bell role scoping (2026-08-25 recruiting lane): adminRoleOnly
// trigger rows are hidden from non-admin readers on list, badge, AND the
// read-marking mutations — a technician must not see, count, or mark read
// a bell whose linked surface is requireAdmin.
describe('admin feed role scoping (adminRoleOnly triggers)', () => {
  function adminFeedQuery({ rows = [], count = '2', updated = 1 } = {}) {
    const q = {};
    for (const m of ['whereNull', 'orWhereRaw', 'whereRaw', 'orderBy', 'limit']) {
      q[m] = jest.fn(() => q);
    }
    q.where = jest.fn((arg) => {
      if (typeof arg === 'function') arg(q);
      return q;
    });
    q.offset = jest.fn(async () => rows);
    q.count = jest.fn(async () => [{ count }]);
    q.update = jest.fn(async () => updated);
    return q;
  }

  function setupAdminDb(opts) {
    const q = adminFeedQuery(opts);
    db.mockImplementation((table) => {
      if (table === 'notifications') return q;
      throw new Error(`Unexpected table ${table}`);
    });
    return q;
  }

  beforeEach(() => jest.clearAllMocks());

  test('admin role reads the full feed — no metadata predicate applied', async () => {
    const q = setupAdminDb({ rows: [{ id: 'n1' }] });
    const rows = await NotificationService.getAdminNotifications(50, 0, { role: 'admin' });
    expect(rows).toEqual([{ id: 'n1' }]);
    expect(q.orWhereRaw).not.toHaveBeenCalled();
  });

  test('callers passing no role (internal jobs) also see the full feed', async () => {
    const q = setupAdminDb({});
    await NotificationService.getAdminNotifications(50, 0);
    expect(q.orWhereRaw).not.toHaveBeenCalled();
  });

  test('technician list is a fail-closed techVisible allowlist', async () => {
    const q = setupAdminDb({ rows: [] });
    await NotificationService.getAdminNotifications(50, 0, { role: 'technician' });
    expect(q.whereRaw).toHaveBeenCalled();
    const [sql, bindings] = q.whereRaw.mock.calls[0];
    expect(sql).toContain("metadata->>'triggerKey'");
    expect(sql).toContain(' IN (');
    // Tech-visible triggers are IN the allowlist; owner-only ones are not.
    expect(bindings).toContain('sms_reply');
    expect(bindings).toContain('sms_operational_followup');
    expect(bindings).toContain('appointment_reschedule_intent');
    expect(bindings).not.toContain('new_job_application');
  });

  test('technician unread count applies the same allowlist and parses the count', async () => {
    const q = setupAdminDb({ count: '4' });
    const count = await NotificationService.getAdminUnreadCount({ role: 'technician' });
    expect(count).toBe(4);
    expect(q.whereRaw).toHaveBeenCalled();
    expect(q.whereNull).toHaveBeenCalledWith('read_at');
  });

  test('markReadAdmin as technician cannot touch a hidden row', async () => {
    const q = setupAdminDb({ updated: 0 });
    const ok = await NotificationService.markReadAdmin('n-hidden', { role: 'technician' });
    expect(ok).toBe(false);
    expect(q.whereRaw).toHaveBeenCalled();
  });

  test('markAllReadAdmin scopes by role; admin stays global', async () => {
    const techQ = setupAdminDb({});
    await NotificationService.markAllReadAdmin({ role: 'technician' });
    expect(techQ.whereRaw).toHaveBeenCalled();

    const adminQ = setupAdminDb({});
    await NotificationService.markAllReadAdmin({ role: 'admin' });
    expect(adminQ.whereRaw).not.toHaveBeenCalled();
    expect(adminQ.update).toHaveBeenCalled();
  });
});

describe('saved-property destination on customer bells (GATE_APP_PROPERTY_SCOPE)', () => {
  const originalGate = process.env.GATE_APP_PROPERTY_SCOPE;
  afterEach(() => { if (originalGate === undefined) delete process.env.GATE_APP_PROPERTY_SCOPE; else process.env.GATE_APP_PROPERTY_SCOPE = originalGate; });
  beforeEach(() => {
    jest.clearAllMocks();
    PushService.sendToCustomer.mockResolvedValue({ subscriptions: 1, sent: 1, expired: 0, failed: 0, skipped: 0 });
  });
  const enRoute = (extra = {}) => NotificationService.notifyCustomer('customer-1', 'service', 'Technician en route', 'On the way.', {
    link: '/?tab=visits', preferenceKey: 'tech_en_route', metadata: { scheduledServiceId: 'service-1' }, ...extra,
  });

  test('gate on, stamped visit (from the emitter\'s metadata.scheduledServiceId): the STORED link and the push name the house, the push carries the visit', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    PushService.resolveNotificationPropertyId.mockResolvedValue('prop-b');
    const { notifQ } = setupDb({ prefs: { tech_en_route: true } });
    await enRoute();
    expect(PushService.resolveNotificationPropertyId).toHaveBeenCalledWith('customer-1', { propertyId: undefined, appointmentId: 'service-1' });
    expect(notifQ.insert).toHaveBeenCalledWith(expect.objectContaining({ link: '/?tab=visits&notificationProperty=customer-1&notificationPropertyId=prop-b' }));
    expect(PushService.sendToCustomer).toHaveBeenCalledWith('customer-1', expect.objectContaining({
      url: '/?tab=visits&notificationProperty=customer-1&notificationPropertyId=prop-b', appointmentId: 'service-1',
    }), expect.any(Object));
  });

  test('gate on, UNSTAMPED visit: the stored link is still profile-qualified (the app\'s profile-only rule opens the primary), no house', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    PushService.resolveNotificationPropertyId.mockResolvedValue(null);
    const { notifQ } = setupDb({ prefs: { tech_en_route: true } });
    await enRoute();
    expect(notifQ.insert).toHaveBeenCalledWith(expect.objectContaining({ link: '/?tab=visits&notificationProperty=customer-1' }));
    expect(PushService.sendToCustomer).toHaveBeenCalledWith('customer-1', expect.objectContaining({ url: '/?tab=visits&notificationProperty=customer-1', appointmentId: 'service-1' }), expect.any(Object));
  });

  test('gate on, a notification about NO visit: untouched', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    const { notifQ } = setupDb({ prefs: { tech_en_route: true } });
    await NotificationService.notifyCustomer('customer-1', 'billing', 'Receipt', 'Paid.', { link: '/?tab=billing', preferenceKey: 'tech_en_route' });
    expect(PushService.resolveNotificationPropertyId).not.toHaveBeenCalled();
    expect(notifQ.insert).toHaveBeenCalledWith(expect.objectContaining({ link: '/?tab=billing' }));
    expect(PushService.sendToCustomer).toHaveBeenCalledWith('customer-1', expect.not.objectContaining({ appointmentId: expect.anything() }), expect.any(Object));
  });

  test('gate OFF: nothing is resolved, qualified or forwarded — today\'s link and payload', async () => {
    delete process.env.GATE_APP_PROPERTY_SCOPE;
    const { notifQ } = setupDb({ prefs: { tech_en_route: true } });
    await enRoute();
    expect(PushService.resolveNotificationPropertyId).not.toHaveBeenCalled();
    expect(notifQ.insert).toHaveBeenCalledWith(expect.objectContaining({ link: '/?tab=visits' }));
    expect(PushService.sendToCustomer).toHaveBeenCalledWith('customer-1', expect.objectContaining({ url: '/?tab=visits' }), expect.any(Object));
    expect(PushService.sendToCustomer.mock.calls[0][1]).not.toHaveProperty('appointmentId');
  });
});
