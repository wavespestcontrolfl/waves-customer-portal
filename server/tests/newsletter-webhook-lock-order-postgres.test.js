/**
 * B13 (Codex r3) on real PostgreSQL: a DOI resend holding the address key and
 * then locking the subscriber row must overlap a SendGrid newsletter event for
 * the same address without a deadlock, and the event's opt-out must land.
 *
 * Old webhook order (subscriber row, THEN the address key) is an AB-BA against
 * the resend (address key, THEN the subscriber row); PostgreSQL aborts one side
 * (40P01), /events swallows it with a 200, and the suppression is lost. The
 * control case below proves this harness detects that inversion.
 */
const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { randomUUID } = require('crypto');

(SKIP ? describe.skip : describe)('newsletter webhook vs DOI resend lock order on PostgreSQL (B13)', () => {
  let db;
  let locks;
  let handleNewsletterEvent;
  const made = [];

  beforeAll(() => {
    db = require('../models/db');
    locks = require('../utils/customer-comms-lock');
    ({ handleNewsletterEvent } = require('../routes/webhooks-sendgrid'));
  });
  afterAll(async () => {
    if (made.length) {
      await db('email_suppressions').whereIn('email', made).del();
      await db('newsletter_subscribers').whereIn('email', made).del();
    }
    await db.destroy();
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function subscriber() {
    const email = `b13-lock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    made.push(email);
    const [row] = await db('newsletter_subscribers').insert({
      email, status: 'pending', source: 'public_form', confirmation_token: randomUUID(), confirmation_sent_at: new Date(),
    }).returning('*');
    return row;
  }
  const dropEvent = (email) => ({ event: 'dropped', reason: 'Group Unsubscribe', email });
  const deliveryFor = (row) => ({ id: randomUUID(), send_id: randomUUID(), subscriber_id: row.id, email: row.email });

  test('resend (address key, then subscriber row) overlaps the webhook without deadlock; the opt-out lands', async () => {
    const row = await subscriber();
    let signalKey;
    const resendHasKey = new Promise((r) => { signalKey = r; });
    let signalWebhook;
    const webhookStarted = new Promise((r) => { signalWebhook = r; });

    const resend = db.transaction(async (trx) => {
      await locks.lockCustomerEmail(trx, row.email);
      signalKey();
      await webhookStarted;
      await sleep(400); // the webhook is now running; the OLD order would already hold the subscriber row here
      await trx('newsletter_subscribers').where({ id: row.id }).forUpdate().first('id');
    });
    await resendHasKey;
    const webhook = (async () => {
      signalWebhook();
      await db.transaction((trx) => handleNewsletterEvent(dropEvent(row.email), deliveryFor(row), trx));
    })();

    await expect(Promise.all([resend, webhook])).resolves.toBeDefined();
    const after = await db('newsletter_subscribers').where({ id: row.id }).first();
    expect(after.status).toBe('unsubscribed');
    const suppression = await db('email_suppressions').where({ email: row.email, status: 'active' }).first();
    expect(suppression).toBeTruthy();
    expect(suppression.group_key).toBe('marketing_newsletter');
  });

  test('a Gmail-spelled address (two keys) also completes', async () => {
    const box = `b13g${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const email = `${box}@gmail.com`;
    made.push(email);
    const [row] = await db('newsletter_subscribers').insert({
      email, status: 'pending', source: 'public_form', confirmation_token: randomUUID(), confirmation_sent_at: new Date(),
    }).returning('*');
    let signalKey;
    const resendHasKey = new Promise((r) => { signalKey = r; });
    const resend = db.transaction(async (trx) => {
      await locks.lockCustomerEmail(trx, email);
      signalKey();
      await sleep(400);
      await trx('newsletter_subscribers').where({ id: row.id }).forUpdate().first('id');
    });
    await resendHasKey;
    const webhook = db.transaction((trx) => handleNewsletterEvent(dropEvent(email.toUpperCase()), deliveryFor(row), trx));
    await expect(Promise.all([resend, webhook])).resolves.toBeDefined();
    expect((await db('newsletter_subscribers').where({ id: row.id }).first()).status).toBe('unsubscribed');
  });

  test('control: the OLD order (subscriber row, then address key) does deadlock against the resend', async () => {
    const row = await subscriber();
    let signalKey;
    const resendHasKey = new Promise((r) => { signalKey = r; });
    let signalRow;
    const oldHasRow = new Promise((r) => { signalRow = r; });
    const resend = db.transaction(async (trx) => {
      await locks.lockCustomerEmail(trx, row.email);
      signalKey();
      await oldHasRow;
      await trx('newsletter_subscribers').where({ id: row.id }).forUpdate().first('id');
    });
    await resendHasKey;
    const oldWebhook = db.transaction(async (trx) => {
      await trx('newsletter_subscribers').where({ id: row.id }).update({ updated_at: new Date() });
      signalRow();
      await locks.lockCustomerEmail(trx, row.email);
    });
    const settled = await Promise.allSettled([resend, oldWebhook]);
    const failures = settled.filter((s) => s.status === 'rejected');
    expect(failures).toHaveLength(1);
    expect(failures[0].reason.code).toBe('40P01');
  });
});
