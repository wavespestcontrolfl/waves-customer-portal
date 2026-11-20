/**
 * The Waves Pest Insider warm audience on real Postgres (services/pest-insider/audience.js,
 * warmAudienceQuery): an open event in the SendGrid webhook log, on the subscriber's CURRENT
 * address, inside the window on the open's own time, under every send-path rule. Covers what
 * the toSQL shape test cannot: a repeat open inside the window counts when the first open was
 * before it, an open by a former address does not qualify a corrected one, a batch logged late
 * counts by when the open happened, and both window bounds hold. Also the customers behind a
 * mailbox (newsletter-sender withMailboxCustomers), which the holdout asks.
 * Self-skips unless DATABASE_URL is set (CI's DB-gated suites step).
 * Safe on a shared database: synthetic rows, asserted by id, removed after.
 */
jest.setTimeout(60000);

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../models/db', () => require('knex')({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 0, max: 4 },
}));
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const { randomUUID } = require('crypto');

postgres('warmAudienceQuery (real Postgres)', () => {
  const db = require('../models/db');
  const { warmAudienceQuery } = require('../services/pest-insider/audience');
  const { withMailboxCustomers } = require('../services/newsletter-sender');
  const DAY = 24 * 60 * 60 * 1000;
  const until = new Date('2026-12-02T12:00:00Z');
  const since = new Date(until.getTime() - 90 * DAY);
  const at = (base, days) => new Date(base.getTime() + days * DAY);
  const tag = randomUUID().slice(0, 8);
  const address = (name) => `pi-warm-${tag}-${name}@example.invalid`;
  const created = { subscribers: [], events: [], customers: [] };
  const ids = {};

  async function subscriber(name, { email = address(name), status = 'active', customerId = null } = {}) {
    const [row] = await db('newsletter_subscribers').insert({ email, status, customer_id: customerId }).returning(['id']);
    created.subscribers.push(row.id);
    ids[name] = row.id;
  }

  // A synthetic customer (no real person).
  async function customer({ email = null } = {}) {
    const id = randomUUID();
    await db('customers').insert({
      id, first_name: 'Synthetic', last_name: 'PiMailbox', phone: `+1555${id.replace(/-/g, '').slice(0, 7)}`, email,
    });
    created.customers.push(id);
    return id;
  }

  // An event SendGrid reported at `when` and the webhook logged at `loggedAt` (the same moment
  // unless a late batch); occurredAt null = a row logged before the column existed.
  async function logged(email, eventType, when, { loggedAt = when, occurredAt = when } = {}) {
    const eventId = `pi-warm-${tag}-${created.events.length}`;
    await db('sendgrid_webhook_events').insert({
      event_id: eventId, event_type: eventType, email, status: 'processed',
      occurred_at: occurredAt, processed_at: loggedAt, created_at: loggedAt, updated_at: loggedAt,
    });
    created.events.push(eventId);
  }

  beforeAll(async () => {
    await subscriber('recent');
    await logged(address('recent'), 'open', at(until, -5));
    // The first open was before the window; a repeat open falls inside it.
    await subscriber('repeat');
    await logged(address('repeat'), 'open', at(since, -10));
    await logged(address('repeat'), 'open', at(since, 3));
    await subscriber('stale');
    await logged(address('stale'), 'open', new Date(since.getTime() - 1000));
    // Address corrected: the former mailbox opened, the current one never did.
    await subscriber('corrected', { email: address('corrected-new') });
    await logged(address('corrected-old'), 'open', at(until, -2));
    await subscriber('afterPlan');
    await logged(address('afterPlan'), 'open', new Date(until.getTime() + 1000));
    await subscriber('delivered');
    await logged(address('delivered'), 'delivered', at(until, -2));
    // The log keeps SendGrid's spelling of the address; the match ignores case.
    await subscriber('mixedCase');
    await logged(address('mixedCase').toUpperCase(), 'open', at(until, -2));
    await subscriber('atStart');
    await logged(address('atStart'), 'open', since);
    await subscriber('atEnd');
    await logged(address('atEnd'), 'open', until);
    // A late batch: opened before the window, logged inside it. The open's own time decides.
    await subscriber('lateBatch');
    await logged(address('lateBatch'), 'open', at(since, -1), { loggedAt: at(since, 2) });
    // Logged before occurred_at existed: the log time stands in.
    await subscriber('legacyRow');
    await logged(address('legacyRow'), 'open', at(until, -3), { occurredAt: null });
    // The send path's own rules still apply: an unsubscribed reader who opened is left out.
    await subscriber('unsubscribed', { status: 'unsubscribed' });
    await logged(address('unsubscribed'), 'open', at(until, -2));

    // The customers behind a mailbox. A lead and a Gmail alias of the same mailbox (dots and
    // +tag ignored) linked to a customer; a lead whose address is a customer's own email (case
    // aside); a lead with nobody behind it.
    ids.aliasCustomer = await customer();
    await subscriber('aliasLead', { email: `pi.alias.${tag}@gmail.com` });
    await subscriber('aliasLinked', { email: `pialias${tag}+news@gmail.com`, customerId: ids.aliasCustomer });
    ids.sharedCustomer = await customer({ email: address('shared') });
    await subscriber('sharedLead', { email: address('shared').toUpperCase() });
    await subscriber('plainLead');
  });

  afterAll(async () => {
    if (created.events.length) await db('sendgrid_webhook_events').whereIn('event_id', created.events).del();
    if (created.subscribers.length) await db('newsletter_subscribers').whereIn('id', created.subscribers).del();
    if (created.customers.length) await db('customers').whereIn('id', created.customers).del();
    await db.destroy();
  });

  test('counts an open on the current address inside the window, a repeat open included, and nothing else', async () => {
    const mine = new Set(created.subscribers);
    const warm = (await warmAudienceQuery({ since, until })).map((row) => row.id).filter((id) => mine.has(id));
    const byId = (a, b) => a - b;
    expect(warm).toEqual([ids.recent, ids.repeat, ids.mixedCase, ids.atStart, ids.atEnd, ids.legacyRow].sort(byId));
  });

  test('withMailboxCustomers reads the customer behind a mailbox through an alias row or a customer email, one row per reader', async () => {
    const mine = [ids.aliasLead, ids.aliasLinked, ids.sharedLead, ids.plainLead];
    const rows = await withMailboxCustomers(db('newsletter_subscribers').whereIn('newsletter_subscribers.id', mine));
    expect(rows.map((row) => row.id).sort((a, b) => a - b)).toEqual([...mine].sort((a, b) => a - b));
    const behind = new Map(rows.map((row) => [row.id, row.mailbox_customer_ids]));
    expect(behind.get(ids.aliasLead)).toEqual([ids.aliasCustomer]);
    expect(behind.get(ids.aliasLinked)).toEqual([ids.aliasCustomer]);
    expect(behind.get(ids.sharedLead)).toEqual([ids.sharedCustomer]);
    expect(behind.get(ids.plainLead)).toEqual([]);
    // The same snapshot carries the address on file and the customer linked now.
    expect(rows.find((row) => row.id === ids.aliasLinked)).toMatchObject({ customer_id: ids.aliasCustomer, email: `pialias${tag}+news@gmail.com` });
  });
});
