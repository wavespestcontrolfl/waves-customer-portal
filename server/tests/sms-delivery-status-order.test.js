/**
 * A delivery status never moves backward (services/sms-delivery-status-order.js),
 * and POST /api/webhooks/twilio/status applies that rule inside both UPDATEs
 * (sms_log.status and messages.delivery_status). Twilio does not order its
 * callbacks: a late `sent` must not undo `delivered`. Invented data only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockWrites = [];
jest.mock('../models/db', () => {
  // A real knex builder that never connects: awaiting it records the SQL instead of running it.
  const knex = require('knex')({ client: 'pg' });
  const db = (table) => {
    const qb = knex(table);
    qb.then = (resolve, reject) => {
      const { sql, bindings } = qb.toSQL().toNative();
      mockWrites.push({ sql, bindings });
      return Promise.resolve([]).then(resolve, reject);
    };
    return qb;
  };
  db.raw = jest.fn(async () => ({ rows: [] }));
  db.transaction = async (fn) => fn(db);
  db.fn = { now: () => new Date() };
  return db;
});
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => {}), isFailureStatus: (s) => ['failed', 'undelivered'].includes(String(s)) }));
jest.mock('../services/appointment-reminders', () => ({ handleUndeliveredSms: jest.fn(async () => {}) }));
const mockReconcile = jest.fn(async () => []);
jest.mock('../services/rate-review-comms', () => ({ handleSmsDeliveryFailure: (...a) => mockReconcile(...a) }));
const mockDeadNumber = jest.fn(async () => {});
jest.mock('../services/dead-number-alert', () => ({ handleDeadNumberCallback: (...a) => mockDeadNumber(...a) }));

const express = require('express');
const router = require('../routes/twilio-webhook');
const { storedStatusesBlocking } = require('../services/sms-delivery-status-order');

// Does a callback with this incoming status replace this stored one?
const writes = (stored, incoming) => stored == null || stored === '' || !storedStatusesBlocking(incoming).includes(stored);

describe('delivery status order rule', () => {
  test.each([
    ['delivered', 'sent', false],
    ['sent', 'delivered', true],
    ['sent', 'queued', false],
    ['queued', 'sent', true],
    ['sending', 'sent', true],
    ['sent', 'sending', false],
    ['delivered', 'undelivered', false],
    ['failed', 'delivered', false],
    ['delivered', 'read', true],
    ['read', 'delivered', false],
    ['sent', 'sent', false],
    ['delivered', 'delivered', false],
    ['accepted', 'queued', true],
  ])('stored %s, incoming %s -> written: %s', (stored, incoming, expected) => {
    expect(writes(stored, incoming)).toBe(expected);
  });

  test('an unknown incoming status is written over a live status, never over a final one', () => {
    expect(writes('sent', 'partially_delivered')).toBe(true);
    expect(writes('queued', 'partially_delivered')).toBe(true);
    expect(writes('delivered', 'partially_delivered')).toBe(false);
    expect(writes('failed', 'partially_delivered')).toBe(false);
    expect(writes('read', 'partially_delivered')).toBe(false);
  });

  test('a stored NULL, empty or unlisted value is always written', () => {
    for (const incoming of ['queued', 'sent', 'delivered', 'read', 'partially_delivered']) {
      expect(writes(null, incoming)).toBe(true);
      expect(writes('', incoming)).toBe(true);
      expect(writes('received', incoming)).toBe(true);
    }
  });
});

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

describe('Twilio status callback bookkeeping', () => {
  beforeEach(() => {
    mockWrites.length = 0;
    mockReconcile.mockReset().mockResolvedValue([]);
    mockDeadNumber.mockClear();
  });

  test('both UPDATEs refuse to move the stored status backward, in the statement itself', async () => {
    expect(await status({ MessageSid: 'SM1', MessageStatus: 'sent', To: '+15555550101' })).toBe(200);
    const smsLog = mockWrites.find((w) => w.sql.startsWith('update "sms_log"'));
    const messages = mockWrites.find((w) => w.sql.startsWith('update "messages"'));
    expect(smsLog.sql).toContain('("status" is null or "status" not in (');
    expect(smsLog.bindings).toEqual(expect.arrayContaining(['SM1', 'sent', 'delivered', 'read']));
    expect(smsLog.bindings).not.toContain('queued');
    expect(messages.sql).toContain('("delivery_status" is null or "delivery_status" not in (');
    expect(messages.sql).toContain('"updated_at"');
    expect(messages.bindings).toEqual(expect.arrayContaining(['SM1', 'sent', 'delivered', 'read']));
  });

  test('the handlers after the bookkeeping run for every callback, even one the guard blocks', async () => {
    // A `failed` that arrives after a stored `delivered` is blocked by the UPDATEs; the alerts still run.
    expect(await status({ MessageSid: 'SM2', MessageStatus: 'failed', ErrorCode: '30003', To: '+15555550101' })).toBe(200);
    expect(mockWrites.some((w) => w.sql.startsWith('update "sms_log"') && w.sql.includes('not in ('))).toBe(true);
    expect(mockDeadNumber).toHaveBeenCalledWith(expect.objectContaining({ sid: 'SM2', status: 'failed', errorCode: '30003' }));
    expect(mockReconcile).toHaveBeenCalledWith({ sid: 'SM2', status: 'failed', errorCode: '30003' }, { strict: true });
  });
});
