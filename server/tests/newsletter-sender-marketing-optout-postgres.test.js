/**
 * Send-time explicit marketing opt-out (owner ruling 2026-09-28, #5165),
 * against real Postgres: excludeMarketingOptedOut's correlated anti-join —
 * linked customer OR any live profile on the same mailbox (exact, or the
 * Google dot/+tag/googlemail identity), explicit false / 'sms' only — and
 * the resume path terminalizing an opted-out recipient's ledger row instead
 * of mailing it. Self-skips unless DATABASE_URL is set (CI's "DB-gated
 * suites" step runs it against the migrated database). Safe on a shared
 * database: every fixture is synthetic and uniquely named, every audience
 * read is narrowed to this file's own subscriber ids, the resume runs on its
 * own send's ledger only, and fixtures commit (the sender reads through the
 * shared db module) and are removed in afterEach.
 */
jest.setTimeout(30000);

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../models/db', () => require('knex')({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 0, max: 4 },
}));
const mockSendBroadcast = jest.fn(async ({ recipients }) => ({ messageId: 'sg-test', recipientCount: recipients.length }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: () => true,
  sendBroadcast: mockSendBroadcast,
  unsubscribeUrl: (t) => `https://portal.invalid/unsub/${t}`,
}));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/content-scheduler', () => ({ sharePublishedNewsletter: jest.fn(async () => {}) }));

const { randomUUID } = require('crypto');

postgres('newsletter sender — explicit marketing opt-out at send time (real Postgres)', () => {
  const db = require('../models/db');
  const {
    buildSubscriberQuery, resumeCampaign, outstandingEligibleDeliveries, hasOutstandingDeliveries,
  } = require('../services/newsletter-sender');

  const created = { customers: [], subscribers: [], sends: [] };
  const tag = () => randomUUID().slice(0, 8);

  async function customer(overrides = {}, prefs = null) {
    const row = {
      id: randomUUID(),
      first_name: 'Synthetic',
      last_name: 'Optout',
      email: `optout-${tag()}@example.invalid`,
      phone: `+1555${String(Math.floor(1000000 + Math.random() * 8999999))}`,
      city: 'Venice',
      active: true,
      pipeline_stage: 'active_customer',
      ...overrides,
    };
    await db('customers').insert(row);
    created.customers.push(row.id);
    if (prefs) await db('notification_prefs').insert({ customer_id: row.id, ...prefs });
    return row;
  }

  async function subscriber(email, overrides = {}) {
    const [row] = await db('newsletter_subscribers')
      .insert({ email, status: 'active', source: 'public_form', ...overrides })
      .returning(['id', 'email']);
    created.subscribers.push(row.id);
    return row;
  }

  const audienceIds = async (ids) => (await buildSubscriberQuery(null).whereIn('newsletter_subscribers.id', ids).select('newsletter_subscribers.id'))
    .map((r) => r.id);

  afterEach(async () => {
    if (created.sends.length) {
      await db('newsletter_send_deliveries').whereIn('send_id', created.sends).del();
      await db('newsletter_sends').whereIn('id', created.sends).del();
    }
    if (created.subscribers.length) await db('newsletter_subscribers').whereIn('id', created.subscribers).del();
    if (created.customers.length) {
      await db('notification_prefs').whereIn('customer_id', created.customers).del();
      await db('customers').whereIn('id', created.customers).del();
    }
    created.customers = []; created.subscribers = []; created.sends = [];
    mockSendBroadcast.mockClear();
  });
  afterAll(async () => { await db.destroy(); });

  test('an imported subscriber whose customer opted out after the import is not mailed', async () => {
    const c = await customer({}, { marketing_offers: true, email_enabled: true });
    const sub = await subscriber(c.email, { source: 'customer_import', customer_id: c.id });
    expect(await audienceIds([sub.id])).toEqual([sub.id]);
    await db('notification_prefs').where({ customer_id: c.id }).update({ marketing_offers: false });
    expect(await audienceIds([sub.id])).toEqual([]);
  });

  test.each([
    ['marketing_offers = false', { marketing_offers: false, email_enabled: true }],
    ['email_enabled = false', { marketing_offers: true, email_enabled: false }],
    ["marketing_channel 'sms'", { marketing_offers: true, email_enabled: true, marketing_channel: 'sms' }],
  ])('a self-signup whose linked customer has %s is not mailed', async (_label, prefs) => {
    const c = await customer({}, prefs);
    const sub = await subscriber(c.email, { customer_id: c.id });
    expect(await audienceIds([sub.id])).toEqual([]);
  });

  test('an opt-out on a live profile holding a Google alias of the mailbox excludes an unlinked subscriber, in both directions', async () => {
    const t = tag().replace(/-/g, '');
    await customer({ email: `J.Doe${t}+work@googlemail.com`, pipeline_stage: 'new_lead' }, { marketing_offers: false });
    const plain = await subscriber(`jdoe${t}@gmail.com`);
    await customer({ email: `amy${t}@gmail.com` }, { email_enabled: false });
    const dotted = await subscriber(`a.m.y${t}+news@gmail.com`);
    expect(await audienceIds([plain.id, dotted.id])).toEqual([]);
  });

  // Codex #5165 (:141): GOOGLE_MAILBOX_SQL.mailbox() strips everything from
  // '+' onward and every '.', so a local part that is JUST a '+tag' (no text
  // before the '+') reduces to '' — the profile side already guarded against
  // matching on that empty string; this proves the SUBSCRIBER side must too,
  // or two UNRELATED addresses that both happen to degenerate to '' would
  // wrongly read as the same mailbox and the opt-out would leak across them.
  test('two different Google addresses that both reduce to an empty mailbox identity ("+tag@gmail.com" shape) do NOT cross-match', async () => {
    const t = tag().replace(/-/g, '');
    await customer({ email: `+optout${t}@gmail.com` }, { marketing_offers: false });
    const keep = await customer({ email: `+keep${t}@gmail.com` });
    const sub = await subscriber(keep.email, { customer_id: keep.id });
    expect(await audienceIds([sub.id])).toEqual([sub.id]); // NOT excluded — a different real mailbox
  });

  test('NULL / missing prefs, an archived opted-out sharer, and a non-Google +tag profile do NOT exclude', async () => {
    const nullFlags = await customer({}, { marketing_offers: null, email_enabled: null, marketing_channel: null });
    const noPrefs = await customer();
    const archivedTwin = await customer({ deleted_at: new Date() }, { marketing_offers: false });
    const t = tag();
    await customer({ email: `bob${t}+x@example.invalid` }, { marketing_offers: false });
    const subs = [
      await subscriber(nullFlags.email, { customer_id: nullFlags.id }),
      await subscriber(noPrefs.email, { customer_id: noPrefs.id }),
      await subscriber(archivedTwin.email),
      await subscriber(`bob${t}@example.invalid`),
    ];
    expect((await audienceIds(subs.map((s) => s.id))).sort()).toEqual(subs.map((s) => s.id).sort());
  });

  // #5187's "correctable" predicate and GET /sends' correlated EXISTS must
  // agree with what a resume would mail: a campaign whose only outstanding
  // recipient opted out has nothing outstanding.
  test('hasOutstandingDeliveries and the GET /sends correlated EXISTS read false when the only outstanding recipient opted out', async () => {
    const c = await customer({}, { marketing_offers: true, email_enabled: true });
    const sub = await subscriber(c.email, { customer_id: c.id });
    const [send] = await db('newsletter_sends').insert({
      subject: 'Synthetic outstanding', html_body: '<p>B</p>', text_body: 'B', status: 'failed', auto_share_social: false,
    }).returning(['id']);
    created.sends.push(send.id);
    await db('newsletter_send_deliveries').insert({ send_id: send.id, subscriber_id: sub.id, email: sub.email, status: 'failed' });
    const correlated = async () => (await db('newsletter_sends').where({ id: send.id }).select(db.raw('EXISTS (?) AS has_outstanding', [
      outstandingEligibleDeliveries('newsletter_sends.id', { correlate: true }).select(db.raw('1')),
    ])).first()).has_outstanding;

    expect(await hasOutstandingDeliveries(send.id)).toBe(true);
    expect(await correlated()).toBe(true);
    await db('notification_prefs').where({ customer_id: c.id }).update({ marketing_channel: 'sms' });
    expect(await hasOutstandingDeliveries(send.id)).toBe(false);
    expect(await correlated()).toBe(false);
  });

  test('resume: a retryable ledger row for an opted-out recipient is terminalized as skipped, never mailed', async () => {
    const keep = await customer({}, { marketing_offers: true, email_enabled: true });
    const optedOut = await customer({}, { marketing_offers: true, email_enabled: true });
    const keepSub = await subscriber(keep.email, { customer_id: keep.id });
    const outSub = await subscriber(optedOut.email, { customer_id: optedOut.id, source: 'customer_import' });
    const [send] = await db('newsletter_sends').insert({
      subject: 'Synthetic resume',
      html_body: '<p>Body</p>',
      text_body: 'Body',
      status: 'sent',
      sent_at: new Date(Date.now() - 3600 * 1000),
      auto_share_social: false,
    }).returning(['id']);
    created.sends.push(send.id);
    await db('newsletter_send_deliveries').insert([
      { send_id: send.id, subscriber_id: keepSub.id, email: keepSub.email, status: 'failed' },
      { send_id: send.id, subscriber_id: outSub.id, email: outSub.email, status: 'failed' },
    ]);
    // Opt-out lands after the original (partial) send.
    await db('notification_prefs').where({ customer_id: optedOut.id }).update({ marketing_offers: false });

    const result = await resumeCampaign(send.id);

    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    expect(mockSendBroadcast.mock.calls[0][0].recipients.map((r) => r.email)).toEqual([keepSub.email]);
    expect(result.skipped_ineligible).toBe(1);
    const skipped = await db('newsletter_send_deliveries').where({ send_id: send.id, subscriber_id: outSub.id }).first();
    expect(skipped).toMatchObject({ status: 'skipped', bounce_reason: 'ineligible_at_dispatch' });
  });
});
