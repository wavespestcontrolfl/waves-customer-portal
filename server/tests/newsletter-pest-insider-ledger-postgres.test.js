/**
 * A planned Waves Pest Insider issue's delivery ledger (newsletter-sender ledgerProgress) on real
 * PostgreSQL: which readers got the issue and which refused it, read from rows that the SendGrid
 * webhook's own event mapping (computeNewsletterEventUpdates) wrote. The fake query builder in
 * newsletter-pest-insider-settle.test.js checks the query's shape only; PostgreSQL shows how a NULL
 * column reads (a comparison with NULL is unknown, and NOT unknown drops the row from a count).
 * Self-skips unless DATABASE_URL is set (CI's DB-gated suites run it). The fixtures are synthetic
 * (no subscriber, example.test addresses) and are removed in afterAll.
 */
jest.setTimeout(30000);

const SKIP = !process.env.DATABASE_URL;

jest.mock('../models/db', () => require('knex')({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 0, max: 2 },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

(SKIP ? describe.skip : describe)('a planned issue delivery ledger on PostgreSQL', () => {
  let db;
  let ledgerProgress;
  let computeNewsletterEventUpdates;
  const sendIds = [];

  beforeAll(() => {
    db = require('../models/db');
    ({ ledgerProgress } = require('../services/newsletter-sender'));
    ({ computeNewsletterEventUpdates } = require('../routes/webhooks-sendgrid'));
  });
  afterAll(async () => {
    if (sendIds.length) {
      await db('newsletter_send_deliveries').whereIn('send_id', sendIds).del();
      await db('newsletter_sends').whereIn('id', sendIds).del();
    }
    await db.destroy();
  });

  // Applies SendGrid events to one ledger row through the webhook's own mapping, in order.
  async function receive(id, ...events) {
    for (const ev of events) {
      const row = await db('newsletter_send_deliveries').where({ id }).first();
      const update = computeNewsletterEventUpdates(ev, row);
      if (update) await db('newsletter_send_deliveries').where({ id }).update(update.delivery);
    }
  }

  test("an accepted row with no reason is reached; a bounce and SendGrid's unsubscribe and spam-report drops are refused; a reader's own spam report or unsubscribe is reached", async () => {
    const [send] = await db('newsletter_sends').insert({
      subject: 'Synthetic ledger', html_body: '<p>Body</p>', text_body: 'Body', status: 'sent', sent_at: new Date(), auto_share_social: false,
    }).returning(['id', 'segment_filter']);
    sendIds.push(send.id);
    const kinds = ['accepted', 'delivered', 'bounced', 'unsubscribedrop', 'spamdrop', 'spamreport', 'unsubscribedafter'];
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rows = await db('newsletter_send_deliveries').insert(kinds.map((kind) => ({
      send_id: send.id, subscriber_id: null, email: `ledger-${kind}-${stamp}@example.test`, status: 'sent', sent_at: new Date(),
    }))).returning(['id', 'email']);
    const id = Object.fromEntries(kinds.map((kind) => [kind, rows.find((row) => row.email.startsWith(`ledger-${kind}-`)).id]));

    // accepted: SendGrid accepted it and no event came yet, so its reason and every later stamp are NULL.
    await receive(id.delivered, { event: 'delivered' });
    await receive(id.bounced, { event: 'bounce', type: 'bounce', reason: '550 5.1.1 mailbox does not exist' });
    await receive(id.unsubscribedrop, { event: 'dropped', reason: 'Unsubscribed Address' });
    await receive(id.spamdrop, { event: 'dropped', reason: 'Spam Reporting Address' });
    // A reader's own spam report, with no acceptance stamp (the sender lost SendGrid's answer) and no
    // delivered event.
    await db('newsletter_send_deliveries').where({ id: id.spamreport }).update({ sent_at: null });
    await receive(id.spamreport, { event: 'spamreport' });
    await receive(id.unsubscribedafter, { event: 'delivered' }, { event: 'unsubscribe' });

    expect(await db('newsletter_send_deliveries').where({ id: id.accepted }).first())
      .toMatchObject({ status: 'sent', bounce_reason: null, delivered_at: null });
    expect(await db('newsletter_send_deliveries').where({ id: id.spamdrop }).first())
      .toMatchObject({ status: 'complained', bounce_reason: 'spam reporting address' });
    expect(await db('newsletter_send_deliveries').where({ id: id.spamreport }).first())
      .toMatchObject({ status: 'complained', bounce_reason: null, sent_at: null });

    // Reached: accepted, delivered, the reader's spam report, the reader's unsubscribe after delivery.
    // Refused: the bounce and the two drops. Nobody is left: no row is retryable.
    expect(await ledgerProgress(db, send)).toEqual({ got: 4, left: 0, refused: 3 });
  });
});
