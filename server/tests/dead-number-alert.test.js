/**
 * GATE_DEAD_NUMBER_ALERT (owner 2026-11-04, "fix check"): a customer's number that keeps failing texts with Twilio
 * 30003 / 30005 raises ONE bell row naming the customer, from POST /api/webhooks/twilio/status, and the row closes
 * at the customer's next delivered text. The route runs for real; the database is a small fake keyed by table.
 * Invented names and numbers only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockState = {};
const mockResetState = () => {
  Object.assign(mockState, {
    logRow: { customer_id: 'cust-1', direction: 'outbound', to_phone: '+19415550142' },
    failedRows: [],
    customer: { id: 'cust-1', first_name: 'Jane', last_name: 'Doe', phone: '+19415550142', secondary_phone: null, active: true, deleted_at: null },
    openKeys: [],
  });
};
mockResetState();
const mockDbCalls = jest.fn();
jest.mock('../models/db', () => {
  const resolveList = (table) => {
    if (table === 'sms_log') return mockState.failedRows;
    if (table === 'notifications') return mockState.openKeys.map((k) => ({ dedupe_key: k }));
    return [];
  };
  const resolveFirst = (table) => {
    if (table === 'sms_log') return mockState.logRow;
    if (table === 'customers') return mockState.customer;
    return null;
  };
  const builder = (table) => new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve, reject) => Promise.resolve(resolveList(table)).then(resolve, reject);
      if (prop === 'catch') return (reject) => Promise.resolve(resolveList(table)).catch(reject);
      if (prop === 'first') return () => Promise.resolve(resolveFirst(table));
      return () => builder(table);
    },
  });
  const db = (table) => { mockDbCalls(table); return builder(table); };
  db.raw = jest.fn(async () => ({ rows: [] }));
  db.transaction = async (fn) => fn(db);
  db.fn = { now: () => new Date() };
  return db;
});

// notifyAdmin stands in for the database: one OPEN row per dedupeKey, as dedupeOpenOnly does.
const mockRows = new Map();
const mockNotify = jest.fn(async (category, title, body, opts) => {
  if (mockRows.has(opts.dedupeKey)) return { id: mockRows.get(opts.dedupeKey), deduped: true };
  mockRows.set(opts.dedupeKey, `row-${mockRows.size + 1}`);
  return { id: mockRows.get(opts.dedupeKey) };
});
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotify(...a) }));
const mockClose = jest.fn(async () => 1);
jest.mock('../services/admin-alert-episodes', () => ({ closeAdminAlertKeys: (...a) => mockClose(...a) }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => {}), isFailureStatus: (s) => ['failed', 'undelivered'].includes(String(s)) }));
const mockAppointment = jest.fn(async () => {});
jest.mock('../services/appointment-reminders', () => ({ handleUndeliveredSms: (...a) => mockAppointment(...a) }));
const mockReconcile = jest.fn(async () => []);
jest.mock('../services/rate-review-comms', () => ({ handleSmsDeliveryFailure: (...a) => mockReconcile(...a) }));

const express = require('express');
const router = require('../routes/twilio-webhook');
const deadNumber = require('../services/dead-number-alert');
const retention = require('../services/admin-alert-retention');

async function status(body) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use('/api/webhooks/twilio', router);
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/webhooks/twilio/status`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(),
    });
    return res.status;
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// Settled sms_log rows, oldest sent first (the order the real query returns).
const sentAt = (d) => new Date(`2026-${d}T15:00:00Z`);
const failedAt = (...days) => days.map((d, i) => ({ created_at: sentAt(d), status: 'undelivered', twilio_sid: `SM-old-${i}` }));
const deliveredRow = (d, twilio_sid = 'SM-ok') => ({ created_at: sentAt(d), status: 'delivered', twilio_sid });
const fail = (extra = {}) => status({ MessageSid: 'SM1', MessageStatus: 'undelivered', ErrorCode: '30005', To: '+19415550142', ...extra });

beforeEach(() => {
  mockResetState();
  mockRows.clear();
  jest.clearAllMocks();
  process.env.GATE_DEAD_NUMBER_ALERT = 'true';
});
afterAll(() => { delete process.env.GATE_DEAD_NUMBER_ALERT; });

describe('dead number alert: when it rings', () => {
  test('gate off: nothing is read or raised', async () => {
    delete process.env.GATE_DEAD_NUMBER_ALERT;
    mockState.failedRows = failedAt('06-29', '07-10', '11-04');
    expect(await fail()).toBe(200);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockDbCalls.mock.calls.filter(([t]) => t === 'customers' || t === 'notifications')).toHaveLength(0);
  });

  test('gate is on only for exactly "true"', async () => {
    process.env.GATE_DEAD_NUMBER_ALERT = '1';
    mockState.failedRows = failedAt('06-29', '11-04');
    await fail();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('the first failure alone raises nothing', async () => {
    mockState.failedRows = failedAt('11-04');
    expect(await fail()).toBe(200);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('the second failure raises one alert with the name, the masked number, the count and the customer link', async () => {
    mockState.failedRows = failedAt('06-29', '11-04');
    expect(await fail()).toBe(200);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = mockNotify.mock.calls[0];
    expect(category).toBe('customer');
    expect(title).toBe("Customers — Jane D.'s phone can't get texts");
    expect(body).toBe('2 texts in a row to …0142 failed since Jun 29: the carrier says the number does not exist.');
    expect(opts.detail).toBe(`${body} Get a new number from the customer.`);
    expect(opts.link).toBe('/admin/customers?customerId=cust-1');
    expect(opts.bell).toBe(true);
    expect(opts.dedupeKey).toBe('dead-number:cust-1:9415550142');
    expect(opts.dedupeOpenOnly).toBe(true);
    expect(opts.metadata).toMatchObject({ area: 'Customers', severity: 'needs-you', doneWhen: 'phone_replaced', who: 'person', subject: { type: 'customer', id: 'cust-1' } });
    for (const text of [title, body, opts.detail, JSON.stringify(opts.metadata)]) expect(text).not.toMatch(/9415550142|941-555|\(941\)/);
  });

  test('a third failure uses the same key, so the open row stays the only one', async () => {
    mockState.failedRows = failedAt('06-29', '07-10');
    await fail();
    mockState.failedRows = failedAt('06-29', '07-10', '11-04');
    await fail({ MessageSid: 'SM2' });
    expect(mockNotify).toHaveBeenCalledTimes(2);
    expect(mockNotify.mock.calls[1][3].dedupeKey).toBe(mockNotify.mock.calls[0][3].dedupeKey);
    expect(mockNotify.mock.calls[1][2]).toMatch(/^3 texts in a row to …0142/);
    expect(mockRows.size).toBe(1);
  });

  test('a 30003 failure says the phone is out of reach, not that the number is gone', async () => {
    mockState.failedRows = failedAt('06-29', '11-04');
    expect(await fail({ ErrorCode: '30003' })).toBe(200);
    const [, , body, opts] = mockNotify.mock.calls[0];
    expect(body).toBe("2 texts in a row to …0142 failed since Jun 29: the carrier can't reach the phone.");
    expect(opts.detail).toBe(`${body} Check the number with the customer.`);
  });

  test.each([
    ['30003 (unreachable handset)', '30003', true],
    ['30006 landline', '30006', false],
    ['30007 carrier filter', '30007', false],
    ['21610 opt-out', '21610', false],
    ['no code', '', false],
  ])('error %s', async (_label, ErrorCode, raises) => {
    mockState.failedRows = failedAt('06-29', '11-04');
    expect(await fail({ ErrorCode })).toBe(200);
    // The 21610 branch has its own, unrelated failure bell; only this alert's key counts here.
    const ours = mockNotify.mock.calls.filter(([, , , opts]) => String(opts?.dedupeKey || '').startsWith('dead-number:'));
    expect(ours).toHaveLength(raises ? 1 : 0);
  });

  test('a delivered text between two failures means the number works: nothing is raised', async () => {
    mockState.failedRows = [...failedAt('06-29'), deliveredRow('07-01'), { created_at: sentAt('11-04'), status: 'undelivered', twilio_sid: 'SM1' }];
    expect(await fail()).toBe(200);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('a late failure callback for a text sent before a delivered one raises nothing', async () => {
    // SM1 was sent Jul 15; its callback arrives after a text sent Aug 1 was delivered.
    mockState.failedRows = [...failedAt('06-29'), { created_at: sentAt('07-15'), status: 'sent', twilio_sid: 'SM1' }, deliveredRow('08-01')];
    expect(await fail()).toBe(200);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test("the callback's own text counts as failed even when the status update did not land", async () => {
    mockState.failedRows = [...failedAt('06-29'), { created_at: sentAt('11-04'), status: 'sent', twilio_sid: 'SM1' }];
    expect(await fail()).toBe(200);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  test('a delivered text never raises it', async () => {
    mockState.failedRows = failedAt('06-29', '11-04');
    expect(await status({ MessageSid: 'SM1', MessageStatus: 'delivered', ErrorCode: '30005', To: '+19415550142' })).toBe(200);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test.each([
    ['no customer on the text', () => { mockState.logRow = { customer_id: null, direction: 'outbound', to_phone: '+19415550142' }; }],
    ['an inbound row', () => { mockState.logRow = { customer_id: 'cust-1', direction: 'inbound', to_phone: '+19415550142' }; }],
    ['no row for the sid', () => { mockState.logRow = null; }],
    ['an inactive customer', () => { mockState.customer.active = false; }],
    ['a number the customer no longer has', () => { mockState.customer.phone = '+19415550999'; }],
  ])('nothing for %s', async (_label, arrange) => {
    mockState.failedRows = failedAt('06-29', '11-04');
    arrange();
    expect(await fail()).toBe(200);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test("the secondary phone counts as the customer's number", async () => {
    mockState.customer.phone = '+19415550999';
    mockState.customer.secondary_phone = '(941) 555-0142';
    mockState.failedRows = failedAt('06-29', '11-04');
    await fail();
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  test('a long name still fits the 60-character headline', async () => {
    mockState.customer.first_name = 'Bartholomew-Maximilian';
    mockState.customer.last_name = 'Featherstonehaugh';
    mockState.failedRows = failedAt('06-29', '11-04');
    await fail();
    expect(mockNotify.mock.calls[0][1].length).toBeLessThanOrEqual(60);
  });
});

describe('dead number alert: isolation', () => {
  test('a raise that fails never breaks the callback or the other handlers', async () => {
    mockState.failedRows = failedAt('06-29', '11-04');
    mockNotify.mockRejectedValueOnce(Object.assign(new Error('db down'), { code: 'ECONN' }));
    expect(await fail()).toBe(200);
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockAppointment).toHaveBeenCalledTimes(1);
  });

  test('a handler that throws outright is caught by the route', async () => {
    const spy = jest.spyOn(deadNumber, 'handleDeadNumberCallback').mockRejectedValue(new Error('boom'));
    try {
      expect(await fail()).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(mockReconcile).toHaveBeenCalledTimes(1);
      expect(mockAppointment).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('a handler that throws synchronously does not break a delivered callback either', async () => {
    const spy = jest.spyOn(deadNumber, 'handleDeadNumberCallback').mockImplementation(() => { throw new Error('boom'); });
    try {
      expect(await status({ MessageSid: 'SM9', MessageStatus: 'delivered', To: '+19415550142' })).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('dead number alert: when it closes', () => {
  const delivered = (To = '+19415550142') => status({ MessageSid: 'SM9', MessageStatus: 'delivered', To });
  const KEY = 'dead-number:cust-1:9415550142';

  test('a text sent after the last failure that is delivered closes the row', async () => {
    mockState.openKeys = [KEY];
    // SM9's own status update may not have landed yet: it still reads 'sent'.
    mockState.failedRows = [...failedAt('06-29', '07-10'), { created_at: sentAt('11-05'), status: 'sent', twilio_sid: 'SM9' }];
    await delivered();
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockClose.mock.calls[0][1]).toEqual([KEY]);
    expect(mockClose.mock.calls[0][2]).toBe('text_delivered');
  });

  test('a late delivered callback for a text sent before the last failure leaves the row', async () => {
    mockState.openKeys = [KEY];
    mockState.failedRows = [
      ...failedAt('06-29'), { created_at: sentAt('07-01'), status: 'sent', twilio_sid: 'SM9' }, ...failedAt('07-10', '11-04'),
    ];
    await delivered();
    expect(mockClose).not.toHaveBeenCalled();
  });

  test('a late delivered callback still closes the row once the dead number is off the customer', async () => {
    mockState.openKeys = [KEY];
    mockState.customer.phone = '+19415550777';
    mockState.failedRows = [
      ...failedAt('06-29'), { created_at: sentAt('07-01'), status: 'sent', twilio_sid: 'SM9' }, ...failedAt('07-10', '11-04'),
    ];
    await delivered();
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockClose.mock.calls[0][2]).toBe('phone_replaced');
  });

  test('a delivered text to a new number closes the row once the dead number is off the customer', async () => {
    mockState.openKeys = [KEY];
    mockState.logRow = { customer_id: 'cust-1', direction: 'outbound', to_phone: '+19415550777' };
    mockState.customer.phone = '+19415550777';
    await delivered('+19415550777');
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockClose.mock.calls[0][1]).toEqual([KEY]);
    expect(mockClose.mock.calls[0][2]).toBe('phone_replaced');
  });

  test('a delivered text to another number leaves the row while the dead number is still on file', async () => {
    mockState.openKeys = [KEY];
    mockState.logRow = { customer_id: 'cust-1', direction: 'outbound', to_phone: '+19415550777' };
    mockState.customer.secondary_phone = '+19415550777';
    await delivered('+19415550777');
    expect(mockClose).not.toHaveBeenCalled();
  });

  test('no open row: nothing is closed', async () => {
    await delivered();
    expect(mockClose).not.toHaveBeenCalled();
  });

  test('gate off: a delivered text reads nothing', async () => {
    delete process.env.GATE_DEAD_NUMBER_ALERT;
    mockState.openKeys = [KEY];
    await delivered();
    expect(mockClose).not.toHaveBeenCalled();
    expect(mockDbCalls).not.toHaveBeenCalledWith('notifications');
  });
});

describe('dead number alert: retention contract', () => {
  test('the open-only emitter has its RERING entry', () => {
    const entry = retention.RERING.find((e) => e.prefixes.includes('dead-number:'));
    expect(entry).toMatchObject({ kind: 'event', files: ['services/dead-number-alert.js'] });
  });
});
