// attemptPushFirst and sendCompanionPush, called directly. A routed send never
// replaces its text by default (owner 2026-11-20: decidePushRoute never returns
// push_first, push-channel-routing.test.js pins it); a customer's own App choice
// is the only thing that does (explicitPushOnly, the 72 hour heartbeat rule, the
// text fallback). The companion push still follows a billing text. A customer's
// own Text choice (the explicit marker) stops both.


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
  sendToCustomer: (...args) => mockSendToCustomer(...args),
}));
jest.mock('../services/notification-service', () => ({ notifyCustomer: (...args) => mockNotifyCustomer(...args) }));
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

const ENV_KEYS = ['GATE_CUSTOMER_APP_NOTIFICATIONS'];
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

const device = (extra = {}) => ({ id: 'd-1', customer_id: 'c-1', platform: 'ios', active: true, contact_phone_key: null, updated_at: hoursAgo(2), ...extra });

describe('the 72 hour rule (legacy device query)', () => {
  it('a device that checked in within 72 hours takes the push, no text, and the heartbeat floor applies', async () => {
    mockDevices.push(device());
    const result = await send();
    expect(result.delivered).toBe(true);
    expect(mockSendToCustomer).toHaveBeenCalledTimes(1);
    expect(mockSendToCustomer.mock.calls[0][2].minUpdatedAt).toBeInstanceOf(Date);
  });

  it('a device last seen 10 days ago does not count: the text goes', async () => {
    mockDevices.push(device({ updated_at: hoursAgo(240) }));
    expect(await send()).toMatchObject({ delivered: false, reason: 'no_fresh_device' });
    expect(mockSendToCustomer).not.toHaveBeenCalled();
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

describe('the 72 hour rule with GATE_CUSTOMER_APP_NOTIFICATIONS (account device status)', () => {
  beforeEach(() => { process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'true'; });

  it('a fresh device counts, and the account status is asked plainly', async () => {
    mockCustomerStatus.mockResolvedValue({ enabled: true, registered: true, fresh: true });
    expect((await send()).delivered).toBe(true);
    expect(mockSendToCustomer.mock.calls[0][2].minUpdatedAt).toBeInstanceOf(Date);
    expect(mockCustomerStatus.mock.calls[0]).toEqual(['c-1']);
  });

  it('a device that is not fresh means text', async () => {
    mockCustomerStatus.mockResolvedValue({ enabled: true, registered: true, fresh: false });
    expect(await send()).toMatchObject({ delivered: false, reason: 'no_fresh_device' });
    expect(mockSendToCustomer).not.toHaveBeenCalled();
  });

  it('app notifications switched off for the account still means text', async () => {
    mockCustomerStatus.mockResolvedValue({ enabled: false, registered: true, fresh: true });
    expect(await send()).toMatchObject({ delivered: false, reason: 'no_fresh_device' });
    expect(mockSendToCustomer).not.toHaveBeenCalled();
  });

  it('explicit App choice: keeps its own path, and its proof row says push', async () => {
    mockPrefs = { en_route_channel: 'push' };
    mockCustomerStatus.mockResolvedValue({ enabled: true, registered: true, fresh: true });
    mockNotifyCustomer.mockResolvedValueOnce({ id: 'bell-9', push: { accepted: 1 } });
    const result = await send({ messageType: 'tech_en_route', explicitPushOnly: true, notificationEventKey: 'visit-1:en-route' });
    expect(result.delivered).toBe(true);
    expect(mockCustomerStatus.mock.calls[0]).toEqual(['c-1']);
    expect(mockSendToCustomer).not.toHaveBeenCalled();
    expect(JSON.parse(mockProofRows[0].metadata)).toMatchObject({ requestedChannel: 'push' });
  });
});

describe('sendCompanionPush (the app alert after a billing text)', () => {
  it('needs a fresh holder device, and the heartbeat floor applies', async () => {
    await PushRouting.sendCompanionPush({ customerId: 'c-1', to: '9415550123', body: 'Reminder.', messageType: 'appointment_reminder' });
    expect(mockSendToCustomer).not.toHaveBeenCalled();
    mockDevices.push(device());
    await PushRouting.sendCompanionPush({ customerId: 'c-1', to: '9415550123', body: 'Reminder.', messageType: 'appointment_reminder' });
    expect(mockSendToCustomer.mock.calls[0][2].minUpdatedAt).toBeInstanceOf(Date);
    expect(mockSendToCustomer.mock.calls[0][2].nativeOnly).toBeUndefined();
  });

  it('sends the text body unchanged, and records the type-wide bell with no dedupe key', async () => {
    mockDevices.push(device());
    await PushRouting.sendCompanionPush({ customerId: 'c-1', to: '9415550123', body: 'Reminder: see https://example.com/l/Zx9', messageType: 'appointment_reminder', appointmentId: 'visit-1' });
    expect(mockSendToCustomer.mock.calls[0][1].body).toBe('Reminder: see https://example.com/l/Zx9');
    expect(mockNotifyCustomer.mock.calls[0][4].dedupeKey).toBeUndefined();
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
