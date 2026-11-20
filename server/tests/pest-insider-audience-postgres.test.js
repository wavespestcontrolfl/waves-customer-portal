/**
 * The Waves Pest Insider warm audience on real Postgres (services/pest-insider/audience.js,
 * warmAudienceQuery): an open event in the SendGrid webhook log, on the subscriber's CURRENT
 * address, inside the window, under every send-path rule. Covers what the toSQL shape test
 * cannot: a repeat open inside the window counts when the first open was before it, an open
 * by a former address does not qualify a corrected one, and both window bounds hold.
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
  const DAY = 24 * 60 * 60 * 1000;
  const until = new Date('2026-12-02T12:00:00Z');
  const since = new Date(until.getTime() - 90 * DAY);
  const at = (base, days) => new Date(base.getTime() + days * DAY);
  const tag = randomUUID().slice(0, 8);
  const address = (name) => `pi-warm-${tag}-${name}@example.invalid`;
  const created = { subscribers: [], events: [] };
  const ids = {};

  async function subscriber(name, { email = address(name), status = 'active' } = {}) {
    const [row] = await db('newsletter_subscribers').insert({ email, status }).returning(['id']);
    created.subscribers.push(row.id);
    ids[name] = row.id;
  }

  async function logged(email, eventType, when) {
    const eventId = `pi-warm-${tag}-${created.events.length}`;
    await db('sendgrid_webhook_events').insert({
      event_id: eventId, event_type: eventType, email, status: 'processed', processed_at: when, created_at: when, updated_at: when,
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
    // The send path's own rules still apply: an unsubscribed reader who opened is left out.
    await subscriber('unsubscribed', { status: 'unsubscribed' });
    await logged(address('unsubscribed'), 'open', at(until, -2));
  });

  afterAll(async () => {
    if (created.events.length) await db('sendgrid_webhook_events').whereIn('event_id', created.events).del();
    if (created.subscribers.length) await db('newsletter_subscribers').whereIn('id', created.subscribers).del();
    await db.destroy();
  });

  test('counts an open on the current address inside the window, a repeat open included, and nothing else', async () => {
    const mine = new Set(created.subscribers);
    const warm = (await warmAudienceQuery({ since, until })).map((row) => row.id).filter((id) => mine.has(id));
    const byId = (a, b) => a - b;
    expect(warm).toEqual([ids.recent, ids.repeat, ids.mixedCase, ids.atStart, ids.atEnd].sort(byId));
  });
});
