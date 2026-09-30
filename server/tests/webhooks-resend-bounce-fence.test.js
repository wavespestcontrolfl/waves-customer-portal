// A delivery re-pointed at a surviving subscriber (customer-email-fanout merge)
// must not let a late Resend bounce from the OLD mailed address bounce-count the
// corrected address. Bounces are fenced to the delivery's mailed email, exactly
// as the SendGrid handler does; a spam complaint (opt-out) is NEVER fenced.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockLog = [];
let mockDelivery = null;
jest.mock('../models/db', () => {
  const mk = (table) => {
    const rec = { table, ops: [] };
    const b = {
      where(w) { rec.ops.push(['where', w]); return b; },
      whereRaw(sql, bind) { rec.ops.push(['whereRaw', sql, bind]); return b; },
      first() { return Promise.resolve(table === 'newsletter_send_deliveries' ? mockDelivery : null); },
      update(u) { rec.ops.push(['update', u]); mockLog.push(rec); return Promise.resolve(1); },
      increment() { return Promise.resolve(1); },
    };
    return b;
  };
  const dbh = (t) => mk(t);
  dbh.raw = (sql) => ({ sql });
  return dbh;
});

const crypto = require('crypto');
const express = require('express');
const router = require('../routes/webhooks-resend');

const SECRET = `whsec_${Buffer.from('synthetic-secret').toString('base64')}`;
let server; let base;

beforeAll(async () => {
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  const app = express();
  app.use('/', router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/events`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => { mockLog.length = 0; });

async function post(type) {
  const body = JSON.stringify({ type, data: { email_id: 'm1' } });
  const id = 'msg_1'; const ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(SECRET.slice(6), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  const res = await fetch(base, { method: 'POST', body, headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` } });
  expect(res.status).toBe(200);
}
const subscriberUpdates = () => mockLog.filter((r) => r.table === 'newsletter_subscribers');

describe('Resend webhook subscriber writes after a subscriber merge', () => {
  test('a bounce is fenced to the address the delivery was mailed to (LOWER/TRIM)', async () => {
    mockDelivery = { id: 'd1', send_id: 's1', subscriber_id: 7, email: '  Old.Address@Example.test ', bounced_at: null };
    await post('email.bounced');
    const [u] = subscriberUpdates();
    expect(u.ops).toContainEqual(['where', { id: 7 }]);
    expect(u.ops).toContainEqual(['whereRaw', 'LOWER(TRIM(email)) = ?', ['old.address@example.test']]);
    expect(u.ops.find((o) => o[0] === 'update')[1]).toHaveProperty('last_bounced_at');
  });

  test('a delivery with no recorded address keeps the plain id match', async () => {
    mockDelivery = { id: 'd1', send_id: 's1', subscriber_id: 7, email: null, bounced_at: null };
    await post('email.bounced');
    const [u] = subscriberUpdates();
    expect(u.ops.some((o) => o[0] === 'whereRaw')).toBe(false);
  });

  test('a spam complaint (opt-out) is never fenced on the mailed address', async () => {
    mockDelivery = { id: 'd1', send_id: 's1', subscriber_id: 7, email: 'old.address@example.test', complained_at: null };
    await post('email.complained');
    const [u] = subscriberUpdates();
    expect(u.ops.some((o) => o[0] === 'whereRaw')).toBe(false);
    expect(u.ops.find((o) => o[0] === 'update')[1]).toMatchObject({ status: 'unsubscribed' });
  });
});
