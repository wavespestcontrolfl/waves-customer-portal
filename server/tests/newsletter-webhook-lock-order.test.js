/**
 * B13 (Codex r3): ONE lock order everywhere — address/mailbox key(s) first,
 * then newsletter_subscribers rows.
 *
 * The DOI resend holds the address key and then locks the subscriber row FOR
 * UPDATE. handleNewsletterEvent used to update the subscriber row first and
 * only then reach recordEmailSuppressionForEvent (same key): an AB-BA that
 * PostgreSQL resolves by aborting the webhook transaction, after which /events
 * answers 200 and the provider never retries — the suppression / opt-out was
 * lost. Mocked order assertions here; the real-Postgres overlap test is
 * newsletter-webhook-lock-order-postgres.test.js.
 */
process.env.PUBLIC_PORTAL_URL = 'https://portal.wavespestcontrol.com';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const { handleNewsletterEvent } = require('../routes/webhooks-sendgrid');

const order = [];
function builder(table) {
  const touch = (kind) => order.push(`${kind}:${table}`);
  const terminal = {
    first: async () => { touch('read'); return table === 'newsletter_send_deliveries' ? { c: 0 } : undefined; },
    update: async () => { touch('write'); return 1; },
    insert: async () => { touch('write'); return [{ id: 1 }]; },
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve().then(() => { touch('read'); return []; }).then(res, rej);
      if (terminal[prop]) return terminal[prop];
      return () => q; // every other builder method chains
    },
  });
  return q;
}
function fakeClient({ transaction = true } = {}) {
  const client = jest.fn((table) => builder(table));
  if (transaction) client.isTransaction = true;
  client.raw = jest.fn(async (sql, bindings) => {
    if (/pg_advisory_xact_lock/.test(sql)) order.push(`lock:${bindings[0]}`);
    return { rows: [] };
  });
  client.transaction = jest.fn(async (fn) => fn(client));
  return client;
}
const firstIndex = (prefix) => order.findIndex((e) => e.startsWith(prefix));

beforeEach(() => { order.length = 0; });

describe('handleNewsletterEvent lock order', () => {
  const events = [
    ['group unsubscribe drop (unsubscribe_if_active)', { event: 'dropped', reason: 'Group Unsubscribe', email: 'Sub@Example.com' }],
    ['spam-report drop (force_unsubscribe)', { event: 'dropped', reason: 'Spam Reporting Address', email: 'Sub@Example.com' }],
    ['hard bounce (bounce_increment)', { event: 'dropped', reason: 'Bounced Address', email: 'Sub@Example.com' }],
  ];
  const delivery = { id: 'd1', send_id: 's1', subscriber_id: 12, email: 'sub@example.com' };

  test.each(events)('%s: the address key is taken BEFORE the subscriber row is touched', async (_name, ev) => {
    const client = fakeClient();
    await handleNewsletterEvent(ev, delivery, client);
    const key = order.indexOf('lock:customer-email:sub@example.com');
    const subscriber = firstIndex('write:newsletter_subscribers');
    expect(key).toBeGreaterThanOrEqual(0);
    expect(subscriber).toBeGreaterThan(key);
    // Nothing else touches subscribers ahead of the key either.
    expect(order.slice(0, key).some((e) => e.endsWith(':newsletter_subscribers'))).toBe(false);
  });

  test('the suppression write re-enters the SAME key on the SAME connection (one transaction, no second handle)', async () => {
    const client = fakeClient();
    await handleNewsletterEvent(events[0][1], delivery, client);
    expect(client.transaction).not.toHaveBeenCalled(); // write(client) ran on the caller's trx
    expect(order.filter((e) => e === 'lock:customer-email:sub@example.com').length).toBeGreaterThanOrEqual(2);
    expect(firstIndex('write:email_suppressions')).toBeGreaterThan(order.lastIndexOf('write:newsletter_subscribers') - 1);
  });

  test('a Google address takes both keys in the sorted global order before the subscriber row', async () => {
    const client = fakeClient();
    await handleNewsletterEvent({ event: 'dropped', reason: 'Group Unsubscribe', email: 'Pat.Smith+x@gmail.com' },
      { ...delivery, email: 'pat.smith+x@gmail.com' }, client);
    const email = order.indexOf('lock:customer-email:pat.smith+x@gmail.com');
    const mailbox = order.indexOf('lock:customer-mailbox:patsmith@gmail.com');
    expect(email).toBeGreaterThanOrEqual(0);
    expect(mailbox).toBeGreaterThan(email);
    expect(firstIndex('write:newsletter_subscribers')).toBeGreaterThan(mailbox);
  });

  test('the delivery address is used when the event carries none', async () => {
    const client = fakeClient();
    await handleNewsletterEvent({ event: 'dropped', reason: 'Group Unsubscribe' }, delivery, client);
    expect(order.indexOf('lock:customer-email:sub@example.com')).toBeLessThan(firstIndex('write:newsletter_subscribers'));
  });

  test('an event that records no suppression takes no address lock (unchanged)', async () => {
    const client = fakeClient();
    await handleNewsletterEvent({ event: 'delivered', email: 'sub@example.com' }, delivery, client);
    expect(order.some((e) => e.startsWith('lock:'))).toBe(false);
  });

  test('a non-transaction client is untouched (statements auto-commit, nothing is held across the two)', async () => {
    const client = fakeClient({ transaction: false });
    await handleNewsletterEvent(events[0][1], delivery, client);
    expect(client.raw).toHaveBeenCalled(); // only the suppression write's own transaction lock
    expect(client.transaction).toHaveBeenCalledTimes(1);
  });
});
