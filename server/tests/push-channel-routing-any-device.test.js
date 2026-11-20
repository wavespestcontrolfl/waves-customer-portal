// App first on any device (owner 2026-11-04): a push_first notice reaches a
// customer whose app has an active device however long ago the app was opened,
// and the text still goes whenever no device accepts. A contact's device never
// counts for the holder. The companion push and an explicit App choice keep the
// 72 hour rule.

const mockDevices = [];
const mockProofRows = [];
let mockPrefs;
const mockSendToCustomer = jest.fn();
const mockCustomerStatus = jest.fn();
const mockNotifyCustomer = jest.fn(async () => ({ id: 'bell-1' }));

function subscriptionQuery() {
  const filters = [];
  const q = {
    where(arg, op, val) {
      if (typeof arg === 'object') filters.push((row) => Object.entries(arg).every(([k, v]) => row[k] === v));
      else if (op === '>=') filters.push((row) => new Date(row[arg]).getTime() >= new Date(val).getTime());
      return q;
    },
    whereNull(col) { filters.push((row) => row[col] == null); return q; },
    whereIn(col, values) { filters.push((row) => values.includes(row[col])); return q; },
    async first() {
      const row = mockDevices.find((device) => filters.every((f) => f(device)));
      return row ? { id: row.id } : undefined;
    },
    async select() {
      return mockDevices.filter((device) => filters.every((f) => f(device)));
    },
  };
  return q;
}

function plainQuery(first) {
  const q = {
    where: jest.fn(() => q),
    first: jest.fn(async () => first),
    update: jest.fn(() => Promise.resolve(1)),
  };
  return q;
}

function tableFor(table) {
  if (table === 'push_subscriptions') return subscriptionQuery();
  if (table === 'customers') return plainQuery({ id: 'c-1', phone: '+19415550123', account_id: null });
  if (table === 'notification_prefs') return plainQuery(mockPrefs);
  return plainQuery(undefined);
}

const mockDb = jest.fn(tableFor);
mockDb.raw = jest.fn((sql) => sql);
mockDb.transaction = jest.fn(async (cb) => {
  const trx = jest.fn((table) => {
    if (table === 'sms_log') {
      const q = {
        where: jest.fn(() => q),
        whereRaw: jest.fn(() => q),
        first: jest.fn(async () => undefined),
        insert: jest.fn((row) => { mockProofRows.push(row); return { returning: async () => [{ id: 'proof-1' }] }; }),
      };
      return q;
    }
    return plainQuery(undefined);
  });
  trx.raw = jest.fn();
  return cb(trx);
});

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/push-notifications', () => ({
  PUSH_HEARTBEAT_HOURS: 72,
  customerStatus: (...args) => mockCustomerStatus(...args),
  appFirstStaleFloor: () => (process.env.GATE_APP_FIRST_STALE_TEXT === 'true' ? new Date(Date.now() - 30 * 24 * 3600000) : null),
  sendToCustomer: (...args) => mockSendToCustomer(...args),
}));
jest.mock('../services/notification-service', () => ({ notifyCustomer: (...args) => mockNotifyCustomer(...args) }));
// Provider configuration the legacy lookup reads under the stale floor (as customerStatus does).
const mockProviders = { ios: true, android: true };
jest.mock('../services/apns', () => ({ status: () => ({ configured: mockProviders.ios }) }));
jest.mock('../services/fcm', () => ({ status: () => ({ configured: mockProviders.android }) }));
jest.mock('../services/messaging/notice-scope', () => ({ noticeScope: jest.fn(async () => ({})) }));
jest.mock('../services/account-properties', () => ({ resolvePrimaryProfileId: jest.fn(async () => 'c-1') }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(async () => {}) }));

const PushRouting = require('../services/messaging/push-channel-routing');

const hoursAgo = (hours) => new Date(Date.now() - hours * 3600000);
const send = (overrides = {}) => PushRouting.attemptPushFirst({
  customerId: 'c-1',
  to: '9415550123',
  body: 'Reminder: your visit is tomorrow.',
  messageType: 'appointment_reminder',
  fromNumber: '+19415550000',
  appointmentId: 'visit-1',
  notificationEventKey: 'reminder_24h:visit-1',
  ...overrides,
});

const ENV_KEYS = ['GATE_APP_FIRST_STALE_TEXT', 'GATE_CUSTOMER_APP_NOTIFICATIONS'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ENV_KEYS.forEach((k) => delete process.env[k]);
  mockDevices.length = 0;
  mockPrefs = undefined;
  mockProofRows.length = 0;
  mockSendToCustomer.mockReset();
  mockSendToCustomer.mockResolvedValue({ sent: 1 });
  mockCustomerStatus.mockReset();
  mockNotifyCustomer.mockClear();
});
afterEach(() => {
  ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
});

const device = (extra = {}) => ({ id: 'd-1', customer_id: 'c-1', platform: 'ios', active: true, contact_phone_key: null, updated_at: hoursAgo(240), ...extra });

describe('reachability without a recent check-in (legacy device query)', () => {
  it('a device last seen 10 days ago takes the push, no text, and the heartbeat floor is dropped', async () => {
    mockDevices.push(device());
    const result = await send();
    expect(result.delivered).toBe(true);
    expect(mockSendToCustomer).toHaveBeenCalledTimes(1);
    expect(mockSendToCustomer.mock.calls[0][2].minUpdatedAt).toBeUndefined();
    expect(mockSendToCustomer.mock.calls[0][2].nativeOnly).toBe(true);
  });

  it('a contact device never counts as the holder having the app', async () => {
    mockDevices.push(device({ contact_phone_key: '9415550999' }));
    const result = await send();
    expect(result).toMatchObject({ delivered: false, reason: 'no_fresh_device' });
    expect(mockSendToCustomer).not.toHaveBeenCalled();
  });

  it('an inactive device does not count', async () => {
    mockDevices.push(device({ active: false }));
    expect(await send()).toMatchObject({ delivered: false, reason: 'no_fresh_device' });
  });

  it('no device accepting the push returns not delivered, so the text goes', async () => {
    mockDevices.push(device());
    mockSendToCustomer.mockResolvedValue({ sent: 0 });
    expect(await send()).toMatchObject({ delivered: false, deliveryOutcome: 'not_sent' });
    expect(mockProofRows).toHaveLength(0);
  });
});

describe('reachability with GATE_CUSTOMER_APP_NOTIFICATIONS (account device status)', () => {
  beforeEach(() => { process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'true'; });

  it('reachable counts, fresh does not matter', async () => {
    mockCustomerStatus.mockResolvedValue({ enabled: true, registered: true, fresh: false, reachable: true });
    expect((await send()).delivered).toBe(true);
    expect(mockSendToCustomer.mock.calls[0][2].minUpdatedAt).toBeUndefined();
    expect(mockSendToCustomer.mock.calls[0][2].nativeOnly).toBe(true);
    // Only routing asks for `reachable`; the customer-facing status routes keep their shape.
    expect(mockCustomerStatus.mock.calls[0][2]).toEqual({ withReachable: true });
  });

  it('app notifications switched off for the account still means text', async () => {
    mockCustomerStatus.mockResolvedValue({ enabled: false, registered: true, fresh: false, reachable: true });
    expect(await send()).toMatchObject({ delivered: false, reason: 'no_fresh_device' });
    expect(mockSendToCustomer).not.toHaveBeenCalled();
  });

  it('no configured provider (reachable false) means text', async () => {
    mockCustomerStatus.mockResolvedValue({ enabled: true, registered: true, fresh: false, reachable: false });
    expect(await send()).toMatchObject({ delivered: false, reason: 'no_fresh_device' });
  });
});

describe('GATE_APP_FIRST_STALE_TEXT: an app not opened in 30 days gets the text too, and the app alert still goes (owner 2026-11-18)', () => {
  const DAY_MS = 24 * 3600000;

  it('with the stale-text gate on: a device last seen 40 days ago is not reachable: stale_app_text, no push before the text (twilio.js sends the text, then the alert)', async () => {
    process.env.GATE_APP_FIRST_STALE_TEXT = 'true';
    mockDevices.push(device({ updated_at: hoursAgo(40 * 24) }));
    expect(await send()).toMatchObject({ delivered: false, deliveryOutcome: 'not_sent', reason: 'stale_app_text', staleAppCompanion: true });
    expect(mockSendToCustomer).not.toHaveBeenCalled();
    expect(mockProofRows).toHaveLength(0);
  });

  it('with the stale-text gate on: a holder with no phone app at all is no_fresh_device with no flag, as today', async () => {
    process.env.GATE_APP_FIRST_STALE_TEXT = 'true';
    expect(await send()).toMatchObject({ delivered: false, reason: 'no_fresh_device' });
    expect(await send()).not.toHaveProperty('staleAppCompanion');
  });

  it('legacy lookup: a recent phone on an unconfigured provider never makes the holder fresh', async () => {
    process.env.GATE_APP_FIRST_STALE_TEXT = 'true';
    mockProviders.android = false;
    try {
      mockDevices.push(device({ id: 'd-a', platform: 'android', updated_at: hoursAgo(2) }));
      mockDevices.push(device({ id: 'd-i', platform: 'ios', updated_at: hoursAgo(40 * 24) }));
      // The only deliverable phone (iOS) is stale: text first, then the app alert; no push before the text.
      expect(await send()).toMatchObject({ delivered: false, reason: 'stale_app_text', staleAppCompanion: true });
      expect(mockSendToCustomer).not.toHaveBeenCalled();
    } finally {
      mockProviders.android = true;
    }
  });

  it('a browser-only holder (no phone app) is neither fresh nor stale with the floor on', async () => {
    process.env.GATE_APP_FIRST_STALE_TEXT = 'true';
    mockDevices.push(device({ platform: 'web', updated_at: hoursAgo(2) }));
    expect(await send()).toMatchObject({ reason: 'no_fresh_device' });
    expect(await send()).not.toHaveProperty('staleAppCompanion');
  });

  it('app notifications gate on: ONE status read decides the text and the alert (customerStatus.appStale)', async () => {
    process.env.GATE_APP_FIRST_STALE_TEXT = 'true';
    process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'true';
    mockCustomerStatus.mockResolvedValue({ enabled: true, reachable: false, appStale: true });
    expect(await send()).toMatchObject({ reason: 'stale_app_text', staleAppCompanion: true });
    expect(mockCustomerStatus).toHaveBeenCalledTimes(1);
    mockCustomerStatus.mockResolvedValue({ enabled: true, reachable: false, appStale: false });
    expect(await send()).toMatchObject({ reason: 'no_fresh_device' });
    expect(await send()).not.toHaveProperty('staleAppCompanion');
    mockCustomerStatus.mockResolvedValue({ enabled: false, reachable: false, appStale: true });
    expect(await send()).not.toHaveProperty('staleAppCompanion');
  });

  it('no stale-app flag with the new gate off', async () => {
    mockDevices.push(device({ updated_at: hoursAgo(40 * 24) }));
    expect(await send()).not.toHaveProperty('staleAppCompanion');
  });

  it('sendCompanionPush staleApp: no 72 hour gate, the any-device presentation (link-free, phone apps only), no floors, a bell when the holder accepted', async () => {
    process.env.GATE_APP_FIRST_STALE_TEXT = 'true';
    const text = 'Reminder: your visit is tomorrow.\n\nManage it: https://example.invalid/r/abc';
    // Reference: what an any-device push for a fresh holder sends.
    mockDevices.push(device({ updated_at: hoursAgo(2) }));
    await send({ body: text });
    const reference = mockSendToCustomer.mock.calls[0][1];
    mockSendToCustomer.mockClear();
    mockNotifyCustomer.mockClear();
    mockProofRows.length = 0;
    mockDevices.length = 0; // the holder phone is stale: a 72 hour check would refuse it
    mockCustomerStatus.mockClear();
    mockSendToCustomer.mockResolvedValue({ sent: 1 });
    await PushRouting.sendCompanionPush({ customerId: 'c-1', to: '9415550123', body: text, messageType: 'appointment_reminder', appointmentId: 'visit-1', staleApp: true });
    expect(mockSendToCustomer).toHaveBeenCalledTimes(1);
    const [, notification, opts] = mockSendToCustomer.mock.calls[0];
    expect(notification).toMatchObject({ title: reference.title, body: reference.body, url: reference.url, category: reference.category, tag: reference.tag });
    expect(notification.body).not.toContain('example.invalid');
    expect(opts.nativeOnly).toBe(true);
    expect(opts.minUpdatedAt).toBeUndefined();
    expect(opts.holderMinUpdatedAt).toBeUndefined();
    expect(mockCustomerStatus).not.toHaveBeenCalled();
    expect(mockNotifyCustomer).toHaveBeenCalledTimes(1);
    expect(mockProofRows).toHaveLength(0); // the text's sms_log row is the record; no push proof row
    mockNotifyCustomer.mockClear();
    mockSendToCustomer.mockResolvedValue({ sent: 0 });
    await PushRouting.sendCompanionPush({ customerId: 'c-1', to: '9415550123', body: text, messageType: 'appointment_reminder', staleApp: true });
    expect(mockNotifyCustomer).not.toHaveBeenCalled();
  });

  it('sendCompanionPush staleApp with an event key goes through the event claim (notifyCustomer), never straight to the fan-out', async () => {
    const text = 'Your technician is on the way.\n\nTrack: https://example.invalid/t/abc';
    await PushRouting.sendCompanionPush({ customerId: 'c-1', to: '9415550123', body: text, messageType: 'tech_en_route', appointmentId: 'visit-1',
      staleApp: true, notificationEventKey: 'visit:v-1:en-route:2026-11-18T14:00:00.000Z' });
    expect(mockSendToCustomer).not.toHaveBeenCalled();
    expect(mockNotifyCustomer).toHaveBeenCalledTimes(1);
    const [customerId, category, title, body, opts] = mockNotifyCustomer.mock.calls[0];
    expect(customerId).toBe('c-1');
    const presentation = PushRouting._test.pushPresentation('tech_en_route');
    expect({ category, title, link: opts.link }).toEqual({ category: presentation.category, title: presentation.title, link: presentation.link });
    expect(body).not.toContain('example.invalid');
    expect(opts).toMatchObject({ dedupeKey: 'visit:v-1:en-route:2026-11-18T14:00:00.000Z', awaitPush: true, appointmentId: 'visit-1' });
    expect(opts.pushOptions).toMatchObject({ nativeOnly: true, messageType: 'tech_en_route' });
    expect(opts.pushOptions.minUpdatedAt).toBeUndefined();
    expect(opts.pushOptions.holderMinUpdatedAt).toBeUndefined();
    expect(mockProofRows).toHaveLength(0);
  });

  it('a bell already holding the event key (the lifecycle bell ran first) sends no second push and records no second bell', async () => {
    mockNotifyCustomer.mockResolvedValueOnce({ id: 'bell-lifecycle', deduped: true, push: { queued: false, accepted: 0, reason: 'dedupe_payload_changed' } });
    await PushRouting.sendCompanionPush({ customerId: 'c-1', to: '9415550123', body: 'Your technician is on the way.', messageType: 'tech_en_route',
      staleApp: true, notificationEventKey: 'visit:v-1:en-route:2026-11-18T14:00:00.000Z' });
    expect(mockNotifyCustomer).toHaveBeenCalledTimes(1);
    expect(mockSendToCustomer).not.toHaveBeenCalled();
  });

  it('sendCompanionPush staleApp without an event key: the old path (direct fan-out, bell after acceptance); an invoice keeps its own tag and bell destination', async () => {
    mockPrefs = { payment_receipt_channel: 'sms' };
    mockSendToCustomer.mockResolvedValue({ sent: 1 });
    const companion = (invoiceId) => PushRouting.sendCompanionPush({ customerId: 'c-1', to: '9415550123', body: 'Your receipt is ready.', messageType: 'receipt',
      staleApp: true, invoiceId });
    await companion('inv-1');
    await companion('inv-2');
    expect(mockSendToCustomer).toHaveBeenCalledTimes(2);
    const tags = mockSendToCustomer.mock.calls.map((c) => c[1].tag);
    expect(new Set(tags).size).toBe(2);
    expect(tags[0]).toContain('inv-1');
    expect(mockNotifyCustomer).toHaveBeenCalledTimes(2);
  });

  it('sendCompanionPush without staleApp passes no identifiers (push_and_sms unchanged): the type-wide bell, no dedupe key', async () => {
    mockDevices.push(device({ updated_at: hoursAgo(2) }));
    await PushRouting.sendCompanionPush({ customerId: 'c-1', to: '9415550123', body: 'Reminder.', messageType: 'appointment_reminder', appointmentId: 'visit-1' });
    expect(mockNotifyCustomer.mock.calls[0][4].dedupeKey).toBeUndefined();
  });

  it('fresh phone rejects and a stale phone accepts: delivered false, not_sent, no proof row, the text goes (same as contact accepted, holder failed)', async () => {
    process.env.GATE_APP_FIRST_STALE_TEXT = 'true';
    mockDevices.push(device({ updated_at: hoursAgo(2) }));
    mockSendToCustomer.mockResolvedValue({ sent: 0, staleHolderDevices: { sent: 1, subscriptions: 1 }, acceptedCheckedInAt: null });
    expect(await send()).toEqual({ delivered: false, deliveryOutcome: 'not_sent' });
    expect(mockProofRows).toHaveLength(0);
    const opts = mockSendToCustomer.mock.calls[0][2];
    expect(opts.holderMinUpdatedAt).toBeInstanceOf(Date);
    // The stale phone took the alert: it gets its in-app bell, once, on the event key (no push from the bell).
    expect(mockNotifyCustomer).toHaveBeenCalledTimes(1);
    expect(mockNotifyCustomer.mock.calls[0][4]).toMatchObject({ dedupeKey: 'reminder_24h:visit-1', push: false });
  });

  it('fresh phone rejects and no stale phone accepted: not_sent, no bell', async () => {
    process.env.GATE_APP_FIRST_STALE_TEXT = 'true';
    mockDevices.push(device({ updated_at: hoursAgo(2) }));
    mockSendToCustomer.mockResolvedValue({ sent: 0 });
    expect(await send()).toEqual({ delivered: false, deliveryOutcome: 'not_sent' });
    expect(mockNotifyCustomer).not.toHaveBeenCalled();
  });

  it('fresh phone accepts (the stale phone was sent too): delivered, and the stamp is the fresh phone\'s check-in only', async () => {
    process.env.GATE_APP_FIRST_STALE_TEXT = 'true';
    const fresh = hoursAgo(2);
    mockDevices.push(device({ updated_at: fresh }));
    mockSendToCustomer.mockResolvedValue({ sent: 1, staleHolderDevices: { sent: 1, subscriptions: 1 }, acceptedCheckedInAt: fresh });
    expect((await send()).delivered).toBe(true);
    expect(JSON.parse(mockProofRows[0].metadata).app_checked_in_at).toBe(fresh.toISOString());
  });

  it('sendCompanionPush without staleApp: unchanged (the holder freshness gate and the heartbeat floor apply)', async () => {
    await PushRouting.sendCompanionPush({ customerId: 'c-1', to: '9415550123', body: 'Reminder.', messageType: 'appointment_reminder' });
    expect(mockSendToCustomer).not.toHaveBeenCalled();
    mockDevices.push(device({ updated_at: hoursAgo(2) }));
    await PushRouting.sendCompanionPush({ customerId: 'c-1', to: '9415550123', body: 'Reminder.', messageType: 'appointment_reminder' });
    expect(mockSendToCustomer.mock.calls[0][2].minUpdatedAt).toBeInstanceOf(Date);
    expect(mockSendToCustomer.mock.calls[0][2].nativeOnly).toBeUndefined();
  });

  it('with the stale-text gate on: a device last seen 10 days ago still takes the push, with a 30-day floor and phone apps only', async () => {
    process.env.GATE_APP_FIRST_STALE_TEXT = 'true';
    mockDevices.push(device());
    expect((await send()).delivered).toBe(true);
    const opts = mockSendToCustomer.mock.calls[0][2];
    expect(opts.nativeOnly).toBe(true);
    // Holder-only floor: a contact's phone keeps its reach (sendToCustomer filters holder rows).
    expect(opts.minUpdatedAt).toBeUndefined();
    expect(opts.holderMinUpdatedAt).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - opts.holderMinUpdatedAt.getTime() - 30 * DAY_MS)).toBeLessThan(60000);
  });

  it('stale-text gate off: a device last seen 40 days ago takes the push as today, no floor', async () => {
    mockDevices.push(device({ updated_at: hoursAgo(40 * 24) }));
    expect((await send()).delivered).toBe(true);
    expect(mockSendToCustomer.mock.calls[0][2].minUpdatedAt).toBeUndefined();
  });

  it('legacy lookup with the floor ignores a fresh browser subscription: a stale phone app plus a fresh web row still gets the text', async () => {
    process.env.GATE_APP_FIRST_STALE_TEXT = 'true';
    mockDevices.push(device({ id: 'd-app', updated_at: hoursAgo(40 * 24) }));
    mockDevices.push(device({ id: 'd-web', platform: 'web', updated_at: hoursAgo(1) }));
    expect(await send()).toMatchObject({ delivered: false, reason: 'stale_app_text', staleAppCompanion: true });
    expect(mockSendToCustomer).not.toHaveBeenCalled();
  });

  it('stale-text gate off: a browser-only holder gets the text, since the any-device send goes to phone apps only', async () => {
    mockDevices.push(device({ platform: 'web', updated_at: hoursAgo(40 * 24) }));
    // Like sendToCustomer: with nativeOnly the browser row is skipped, so no device accepts.
    mockSendToCustomer.mockImplementation(async (_customerId, _notification, opts = {}) => ({ sent: opts.nativeOnly ? 0 : 1 }));
    const result = await send();
    for (const call of mockSendToCustomer.mock.calls) expect(call[2].nativeOnly).toBe(true);
    expect(result.delivered).toBe(false);
    expect(mockProofRows).toHaveLength(0);
  });

  it('account device status: routing asks plainly; the floor is customerStatus\'s own', async () => {
    process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'true';
    process.env.GATE_APP_FIRST_STALE_TEXT = 'true';
    mockCustomerStatus.mockResolvedValue({ enabled: true, registered: true, fresh: false, reachable: true });
    await send();
    expect(mockCustomerStatus.mock.calls[0][2]).toEqual({ withReachable: true });
  });

  it('the proof row carries the check-in of the phone that accepted the push, with the stale-text gate off too', async () => {
    const checkedIn = hoursAgo(40 * 24);
    mockDevices.push(device({ updated_at: checkedIn }));
    mockSendToCustomer.mockResolvedValue({ sent: 1, acceptedCheckedInAt: checkedIn });
    expect((await send()).delivered).toBe(true);
    expect(JSON.parse(mockProofRows[0].metadata)).toMatchObject({ requestedChannel: 'sms', app_checked_in_at: checkedIn.toISOString() });
  });

  it('no accepted holder leg with a check-in (unknown): no stamp', async () => {
    mockDevices.push(device());
    mockSendToCustomer.mockResolvedValue({ sent: 1 });
    expect((await send()).delivered).toBe(true);
    expect(JSON.parse(mockProofRows[0].metadata)).not.toHaveProperty('app_checked_in_at');
  });

  it('an explicit App send carries no stamp', async () => {
    process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'true';
    mockPrefs = { en_route_channel: 'push' };
    mockCustomerStatus.mockResolvedValue({ enabled: true, registered: true, fresh: true });
    mockNotifyCustomer.mockResolvedValueOnce({ id: 'bell-9', push: { accepted: 1 } });
    const result = await send({ messageType: 'tech_en_route', explicitPushOnly: true, notificationEventKey: 'visit-1:en-route' });
    expect(result.delivered).toBe(true);
    expect(JSON.parse(mockProofRows[0].metadata)).toMatchObject({ requestedChannel: 'push' });
    expect(JSON.parse(mockProofRows[0].metadata)).not.toHaveProperty('app_checked_in_at');
  });

  it('explicit App choice: keeps its own path, no 30-day floor and no reachable read', async () => {
    process.env.GATE_APP_FIRST_STALE_TEXT = 'true';
    process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'true';
    mockPrefs = { en_route_channel: 'push' };
    mockCustomerStatus.mockResolvedValue({ enabled: true, registered: true, fresh: true });
    await send({ messageType: 'tech_en_route', explicitPushOnly: true, notificationEventKey: 'visit-1:en-route' });
    expect(mockCustomerStatus.mock.calls[0][2]).toBeUndefined();
  });
});

describe('a push-routed reminder leaves the proof the reminder sweep reads', () => {
  it('writes a sent sms_log row of the reminder type, linked to the notice event, and reports an accepted push id', async () => {
    mockDevices.push(device());
    const result = await send({ messageType: 'reminder_72h', notificationEventKey: 'reminder_72h:visit-1' });
    expect(result).toMatchObject({ delivered: true, deliveryOutcome: 'accepted' });
    expect(result.sid).toMatch(/^push:/);
    expect(mockProofRows).toHaveLength(1);
    expect(mockProofRows[0]).toMatchObject({
      customer_id: 'c-1', direction: 'outbound', from_phone: 'push', status: 'sent', message_type: 'reminder_72h',
    });
    expect(JSON.parse(mockProofRows[0].metadata)).toMatchObject({
      channel: 'push', providerAccepted: true, notificationEventKey: 'reminder_72h:visit-1',
    });
  });
});

describe('collapse tag: two visits never replace each other on the phone (Codex #7581 r1)', () => {
  const { pushTag } = PushRouting._test;

  it('names the visit, else the invoice, else the notice event, else the type alone', () => {
    expect(pushTag('appointment_reminder', { appointmentId: 'visit-1', invoiceId: 'inv-1', eventKey: 'k' })).toBe('push-routed:appointment_reminder:visit-1');
    expect(pushTag('receipt', { invoiceId: 'inv-1', eventKey: 'k' })).toBe('push-routed:receipt:inv-1');
    expect(pushTag('tech_arrived', { eventKey: 'arrived:visit-2' })).toBe('push-routed:tech_arrived:arrived:visit-2');
    expect(pushTag('tech_arrived', {})).toBe('push-routed:tech_arrived');
  });

  it('reminders for two visits reach the device with different tags', async () => {
    mockDevices.push(device());
    await send({ appointmentId: 'visit-1', notificationEventKey: 'reminder_24h:visit-1' });
    await send({ appointmentId: 'visit-2', notificationEventKey: 'reminder_24h:visit-2' });
    const tags = mockSendToCustomer.mock.calls.map((call) => call[1].tag);
    expect(tags).toEqual(['push-routed:appointment_reminder:visit-1', 'push-routed:appointment_reminder:visit-2']);
  });
});

describe('no bearer link reaches a device that may be stale (Codex security #7581)', () => {
  const { linkFreeBody } = PushRouting._test;
  const REMINDER = 'Hi Jane, your Waves Lawn Care is Thu, Nov 6, 9-11 AM.\n\nNeed a change? Reply here or tap wavespestcontrol.com/l/Zx9';

  it('the body keeps the first paragraph and drops every link', () => {
    expect(linkFreeBody(REMINDER)).toBe('Hi Jane, your Waves Lawn Care is Thu, Nov 6, 9-11 AM.');
    expect(linkFreeBody('Hi Jane, your Waves Lawn Care report is ready: wavespestcontrol.com/l/Rp2')).toBe('Hi Jane, your Waves Lawn Care report is ready.');
    expect(linkFreeBody('Hi Jane, Waves received your payment of $65.00. Thank you!\n\nReceipt: https://wavespestcontrol.com/l/Rc1')).toBe('Hi Jane, Waves received your payment of $65.00. Thank you!');
    expect(linkFreeBody('Lawn watering:\nWater 1/2 inch tonight.')).toBe('Lawn watering:\nWater 1/2 inch tonight.');
    expect(linkFreeBody('wavespestcontrol.com/l/x')).toBe('Open the Waves app for the details.');
  });

  it('the push, and its proof row, carry the link-free body and open the signed-in tab', async () => {
    mockDevices.push(device());
    await send({ messageType: 'reminder_72h', body: REMINDER, notificationEventKey: 'reminder_72h:visit-1' });
    const pushed = mockSendToCustomer.mock.calls[0][1];
    expect(pushed.body).toBe('Hi Jane, your Waves Lawn Care is Thu, Nov 6, 9-11 AM.');
    expect(pushed.body).not.toMatch(/wavespestcontrol\.com\/l\//);
    expect(pushed.url).toBe('/?tab=visits');
    expect(mockProofRows[0].message_body).toBe(pushed.body);
  });

  it('a report push opens the Documents tab, never the report token page', async () => {
    mockDevices.push(device());
    await send({ messageType: 'service_report_v1', body: 'Hi Jane, your Waves Lawn Care report is ready: wavespestcontrol.com/l/Rp2' });
    expect(mockSendToCustomer.mock.calls[0][1].url).toBe('/?tab=documents');
    expect(mockSendToCustomer.mock.calls[0][1].body).toBe('Hi Jane, your Waves Lawn Care report is ready.');
  });

});

describe('only the customer switches back to text (explicit-choice markers)', () => {
  beforeEach(() => {
    mockDevices.push(device());
  });

  it('an explicit Text choice keeps the text: no push, no app notice', async () => {
    mockPrefs = { service_reminder_24h_channel: 'sms', service_reminder_24h_channel_explicit: true };
    expect(await send()).toMatchObject({ delivered: false, reason: 'preference_changed' });
    expect(mockSendToCustomer).not.toHaveBeenCalled();
  });

  it('the seeded default Text goes to the app', async () => {
    mockPrefs = { service_reminder_24h_channel: 'sms', service_reminder_24h_channel_explicit: false };
    expect((await send()).delivered).toBe(true);
    expect(mockSendToCustomer).toHaveBeenCalledTimes(1);
  });

  it('the 72 hour reminder uses its own marker', async () => {
    mockPrefs = { service_reminder_72h_channel: 'sms', service_reminder_72h_channel_explicit: true };
    expect(await send({ messageType: 'reminder_72h' })).toMatchObject({ delivered: false, reason: 'preference_changed' });
    mockPrefs = { service_reminder_72h_channel: 'sms', service_reminder_72h_channel_explicit: false };
    expect((await send({ messageType: 'reminder_72h' })).delivered).toBe(true);
  });

});

describe("a technician's On-my-way tap keeps the customer's channel (useCustomerChannel)", () => {
  // sendTechEnRoute marks a manual tap operatorInitiated (send-window marker) AND
  // metadata.useCustomerChannel. Before this rule the operator flag forced SMS, so
  // no tapped en-route notice ever reached the app (0 of 34 in 30 days, 11-04 audit).
  const route = (overrides = {}) => PushRouting.decidePushRoute({
    gateOn: true, customerId: 'c-1', messageType: 'tech_en_route', hasMedia: false, humanAuthored: false,
    operatorInitiated: true, useCustomerChannel: true, ...overrides,
  });

  it('a tapped en-route notice routes push_first like an automated one', () => {
    expect(route()).toBe('push_first');
  });

  it('a tapped reminder follows the any-device policy too', () => {
    expect(route({ messageType: 'appointment_reminder' })).toBe('push_first');
  });

  it('an operator send WITHOUT the mark still stays a text (staff chose Text)', () => {
    expect(route({ useCustomerChannel: undefined })).toBe('sms_only');
    expect(route({ useCustomerChannel: 'true' })).toBe('sms_only');
    expect(route({ messageType: 'receipt', useCustomerChannel: false })).toBe('sms_only');
  });

  it('an admin-attributed send with the mark follows the policy; without it, a text', () => {
    expect(route({ operatorInitiated: false, adminAttributed: true })).toBe('push_first');
    expect(route({ operatorInitiated: false, adminAttributed: true, useCustomerChannel: false })).toBe('sms_only');
  });

  it('the mark never lifts the other text-only rules', () => {
    expect(route({ humanAuthored: true })).toBe('sms_only');
    expect(route({ hasMedia: true })).toBe('sms_only');
    expect(route({ bundledReview: true, messageType: 'service_complete' })).toBe('sms_only');
    expect(route({ messageType: 'appointment_confirmation' })).toBe('sms_only');
    expect(route({ gateOn: false })).toBe('sms_only');
  });
});
