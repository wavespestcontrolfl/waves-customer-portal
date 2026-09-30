// SQL-level proof for the newsletter subscriber-merge delivery re-point on a
// real Postgres. Runs only with ACTIVITY_TIMELINE_TEST_DATABASE_URL (or CI's
// DATABASE_URL); TEMP tables on a single connection, nothing durable.
jest.mock('../models/db', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');
const knex = require('knex');
const { repointNewsletterDeliveries } = require('../services/customer-email-fanout');

const url = process.env.ACTIVITY_TIMELINE_TEST_DATABASE_URL || process.env.DATABASE_URL;
const pg = url ? describe : describe.skip;

pg('repointNewsletterDeliveries on Postgres', () => {
  let db;
  const cust = randomUUID();
  const otherCust = randomUUID();
  const now = new Date(Date.UTC(2026, 8, 20, 12, 0, 0));

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: url, pool: { min: 1, max: 1 } });
    await db.raw(`
      CREATE TEMP TABLE newsletter_subscribers (id int PRIMARY KEY, customer_id uuid, email text);
      CREATE TEMP TABLE newsletter_send_deliveries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), send_id int, status text, subscriber_id int REFERENCES newsletter_subscribers(id) ON DELETE SET NULL, email text, updated_at timestamp, UNIQUE (send_id, subscriber_id));
    `);
  });
  afterAll(async () => { if (db) await db.destroy(); });

  const seed = async (rows) => {
    await db('newsletter_send_deliveries').del();
    await db('newsletter_subscribers').del();
    await db('newsletter_subscribers').insert(rows.subs);
    await db('newsletter_send_deliveries').insert(rows.deliveries.map((d) => ({ status: 'sent', ...d })));
  };
  const owners = async () => (await db('newsletter_send_deliveries').orderBy(['send_id', 'email'])).map((d) => `${d.send_id}:${d.subscriber_id}`);

  test('history follows the merge: re-pointed before the delete, so it survives it', async () => {
    await seed({
      subs: [{ id: 739, customer_id: cust, email: 'typo@example.test' }, { id: 900, customer_id: cust, email: 'fixed@example.test' }],
      deliveries: [{ send_id: 1, subscriber_id: 739, email: 'typo@example.test', status: 'delivered' }, { send_id: 2, subscriber_id: 739, email: 'typo@example.test', status: 'opened' }],
    });
    expect(await repointNewsletterDeliveries(db, { fromId: 739, toId: 900, customerId: cust, now })).toBe(2);
    await db('newsletter_subscribers').where({ id: 739 }).del();
    expect(await owners()).toEqual(['1:900', '2:900']);
  });

  test('a survivor linked to ANOTHER customer never inherits the history', async () => {
    await seed({
      subs: [{ id: 739, customer_id: cust, email: 'typo@example.test' }, { id: 900, customer_id: otherCust, email: 'fixed@example.test' }],
      deliveries: [{ send_id: 1, subscriber_id: 739, email: 'typo@example.test' }],
    });
    expect(await repointNewsletterDeliveries(db, { fromId: 739, toId: 900, customerId: cust, now })).toBe(0);
    expect(await owners()).toEqual(['1:739']);
  });

  test('a survivor with no customer link (not adopted) does not inherit either', async () => {
    await seed({
      subs: [{ id: 739, customer_id: cust, email: 'typo@example.test' }, { id: 900, customer_id: null, email: 'fixed@example.test' }],
      deliveries: [{ send_id: 1, subscriber_id: 739, email: 'typo@example.test' }],
    });
    expect(await repointNewsletterDeliveries(db, { fromId: 739, toId: 900, customerId: cust, now })).toBe(0);
  });

  test('an issue the survivor already has a delivery for is skipped, not a unique violation', async () => {
    await seed({
      subs: [{ id: 739, customer_id: cust, email: 'typo@example.test' }, { id: 900, customer_id: cust, email: 'fixed@example.test' }],
      deliveries: [
        { send_id: 1, subscriber_id: 739, email: 'typo@example.test' },
        { send_id: 2, subscriber_id: 739, email: 'typo@example.test' },
        { send_id: 2, subscriber_id: 900, email: 'fixed@example.test' },
      ],
    });
    expect(await repointNewsletterDeliveries(db, { fromId: 739, toId: 900, customerId: cust, now })).toBe(1);
    await db('newsletter_subscribers').where({ id: 739 }).del();
    expect(await owners()).toEqual(['1:900', '2:900', '2:null']);
  });

  test('retryable deliveries (queued / failed / sending) stay put: Resume mails the survivor\'s current address', async () => {
    await seed({
      subs: [{ id: 739, customer_id: cust, email: 'typo@example.test' }, { id: 900, customer_id: cust, email: 'fixed@example.test' }],
      deliveries: [
        { send_id: 1, subscriber_id: 739, email: 'typo@example.test', status: 'queued' },
        { send_id: 2, subscriber_id: 739, email: 'typo@example.test', status: 'failed' },
        { send_id: 3, subscriber_id: 739, email: 'typo@example.test', status: 'sending' },
        { send_id: 4, subscriber_id: 739, email: 'typo@example.test', status: 'bounced' },
        { send_id: 5, subscriber_id: 739, email: 'typo@example.test', status: 'sent' },
      ],
    });
    expect(await repointNewsletterDeliveries(db, { fromId: 739, toId: 900, customerId: cust, now })).toBe(2);
    expect(await owners()).toEqual(['1:739', '2:739', '3:739', '4:900', '5:900']);
  });
});
