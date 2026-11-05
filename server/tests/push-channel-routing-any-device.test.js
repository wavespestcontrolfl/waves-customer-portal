// GATE_APP_FIRST_ANY_DEVICE (owner 2026-11-04): with the gate on, a push_first
// notice reaches a customer whose app has an active device however long ago the
// app was opened, and the text still goes whenever no device accepts. Gate off
// keeps the 72 hour rule. A contact's device never counts for the holder.

const mockDevices = [];
const mockProofRows = [];
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
    async first() {
      const row = mockDevices.find((device) => filters.every((f) => f(device)));
      return row ? { id: row.id } : undefined;
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

const ENV_KEYS = ['GATE_APP_FIRST_ANY_DEVICE', 'GATE_CUSTOMER_APP_NOTIFICATIONS'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ENV_KEYS.forEach((k) => delete process.env[k]);
  mockDevices.length = 0;
  mockProofRows.length = 0;
  mockSendToCustomer.mockReset();
  mockSendToCustomer.mockResolvedValue({ sent: 1 });
  mockCustomerStatus.mockReset();
  mockNotifyCustomer.mockClear();
});
afterEach(() => {
  ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
});

const device = (extra = {}) => ({ id: 'd-1', customer_id: 'c-1', active: true, contact_phone_key: null, updated_at: hoursAgo(240), ...extra });

describe('reachability without a recent check-in (legacy device query)', () => {
  it('gate on: a device last seen 10 days ago takes the push, no text, and the heartbeat floor is dropped', async () => {
    process.env.GATE_APP_FIRST_ANY_DEVICE = 'true';
    mockDevices.push(device());
    const result = await send();
    expect(result.delivered).toBe(true);
    expect(mockSendToCustomer).toHaveBeenCalledTimes(1);
    expect(mockSendToCustomer.mock.calls[0][2].minUpdatedAt).toBeUndefined();
    expect(mockSendToCustomer.mock.calls[0][2].nativeOnly).toBe(true);
  });

  it('gate off: the same stale device falls back to the text (72 hour rule)', async () => {
    mockDevices.push(device());
    const result = await send();
    expect(result).toMatchObject({ delivered: false, reason: 'no_fresh_device' });
    expect(mockSendToCustomer).not.toHaveBeenCalled();
  });

  it('gate off: a fresh device still gets the push, with the heartbeat floor', async () => {
    mockDevices.push(device({ updated_at: hoursAgo(2) }));
    const result = await send();
    expect(result.delivered).toBe(true);
    expect(mockSendToCustomer.mock.calls[0][2].minUpdatedAt).toBeInstanceOf(Date);
    expect(mockSendToCustomer.mock.calls[0][2].nativeOnly).toBeUndefined();
  });

  it('gate on: a contact device never counts as the holder having the app', async () => {
    process.env.GATE_APP_FIRST_ANY_DEVICE = 'true';
    mockDevices.push(device({ contact_phone_key: '9415550999' }));
    const result = await send();
    expect(result).toMatchObject({ delivered: false, reason: 'no_fresh_device' });
    expect(mockSendToCustomer).not.toHaveBeenCalled();
  });

  it('gate on: an inactive device does not count', async () => {
    process.env.GATE_APP_FIRST_ANY_DEVICE = 'true';
    mockDevices.push(device({ active: false }));
    expect(await send()).toMatchObject({ delivered: false, reason: 'no_fresh_device' });
  });

  it('gate on: no device accepting the push returns not delivered, so the text goes', async () => {
    process.env.GATE_APP_FIRST_ANY_DEVICE = 'true';
    mockDevices.push(device());
    mockSendToCustomer.mockResolvedValue({ sent: 0 });
    expect(await send()).toMatchObject({ delivered: false, deliveryOutcome: 'not_sent' });
    expect(mockProofRows).toHaveLength(0);
  });
});

describe('reachability with GATE_CUSTOMER_APP_NOTIFICATIONS (account device status)', () => {
  beforeEach(() => { process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'true'; });

  it('gate on: reachable counts, fresh does not matter', async () => {
    process.env.GATE_APP_FIRST_ANY_DEVICE = 'true';
    mockCustomerStatus.mockResolvedValue({ enabled: true, registered: true, fresh: false, reachable: true });
    expect((await send()).delivered).toBe(true);
    expect(mockSendToCustomer.mock.calls[0][2].minUpdatedAt).toBeUndefined();
    expect(mockSendToCustomer.mock.calls[0][2].nativeOnly).toBe(true);
    // Only routing asks for `reachable`; the customer-facing status routes keep their shape.
    expect(mockCustomerStatus.mock.calls[0][2]).toEqual({ withReachable: true });
  });

  it('gate on: app notifications switched off for the account still means text', async () => {
    process.env.GATE_APP_FIRST_ANY_DEVICE = 'true';
    mockCustomerStatus.mockResolvedValue({ enabled: false, registered: true, fresh: false, reachable: true });
    expect(await send()).toMatchObject({ delivered: false, reason: 'no_fresh_device' });
    expect(mockSendToCustomer).not.toHaveBeenCalled();
  });

  it('gate on: no configured provider (reachable false) means text', async () => {
    process.env.GATE_APP_FIRST_ANY_DEVICE = 'true';
    mockCustomerStatus.mockResolvedValue({ enabled: true, registered: true, fresh: false, reachable: false });
    expect(await send()).toMatchObject({ delivered: false, reason: 'no_fresh_device' });
  });

  it('gate off: a stale device is not enough', async () => {
    mockCustomerStatus.mockResolvedValue({ enabled: true, registered: true, fresh: false, reachable: true });
    expect(await send()).toMatchObject({ delivered: false, reason: 'no_fresh_device' });
    expect(mockCustomerStatus.mock.calls[0][2]).toBeUndefined();
  });
});

describe('a push-routed reminder leaves the proof the reminder sweep reads', () => {
  it('writes a sent sms_log row of the reminder type, linked to the notice event, and reports an accepted push id', async () => {
    process.env.GATE_APP_FIRST_ANY_DEVICE = 'true';
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

  it('gate off: the type-wide tag, as before', () => {
    expect(pushTag('appointment_reminder', { appointmentId: 'visit-1', eventKey: 'k' })).toBe('push-routed:appointment_reminder');
  });

  it('gate on: names the visit, else the invoice, else the notice event, else the type alone', () => {
    process.env.GATE_APP_FIRST_ANY_DEVICE = 'true';
    expect(pushTag('appointment_reminder', { appointmentId: 'visit-1', invoiceId: 'inv-1', eventKey: 'k' })).toBe('push-routed:appointment_reminder:visit-1');
    expect(pushTag('receipt', { invoiceId: 'inv-1', eventKey: 'k' })).toBe('push-routed:receipt:inv-1');
    expect(pushTag('tech_arrived', { eventKey: 'arrived:visit-2' })).toBe('push-routed:tech_arrived:arrived:visit-2');
    expect(pushTag('tech_arrived', {})).toBe('push-routed:tech_arrived');
  });

  it('gate on: reminders for two visits reach the device with different tags', async () => {
    process.env.GATE_APP_FIRST_ANY_DEVICE = 'true';
    mockDevices.push(device());
    await send({ appointmentId: 'visit-1', notificationEventKey: 'reminder_24h:visit-1' });
    await send({ appointmentId: 'visit-2', notificationEventKey: 'reminder_24h:visit-2' });
    const tags = mockSendToCustomer.mock.calls.map((call) => call[1].tag);
    expect(tags).toEqual(['push-routed:appointment_reminder:visit-1', 'push-routed:appointment_reminder:visit-2']);
  });
});
