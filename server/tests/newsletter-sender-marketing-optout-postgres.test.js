/**
 * Send-time mailbox mailability (owner rulings 2026-09-28 + 2026-09-29,
 * #5165), against real Postgres: excludeMailboxNotMailable's correlated
 * anti-join — (a) linked customer OR any live profile on the same mailbox
 * (exact, or the Google dot/+tag/googlemail identity) with an explicit
 * false / 'sms' opt-out, and (b) ANY OTHER newsletter_subscribers row on
 * the same mailbox in a non-'active' status (unsubscribed/pending/
 * inactive/waitlist/unrecognised) — and the resume path terminalizing a
 * non-mailable recipient's ledger row instead of mailing it. Self-skips
 * unless DATABASE_URL is set (CI's "DB-gated suites" step runs it against
 * the migrated database). Safe on a shared database: every fixture is
 * synthetic and uniquely named, every audience read is narrowed to this
 * file's own subscriber ids, the resume runs on its own send's ledger
 * only, and fixtures commit (the sender reads through the shared db
 * module) and are removed in afterEach.
 *
 * Owner ruling 2026-09-29 (option A): per-writer mailbox locks (subscribe/
 * confirm/unsubscribe/webhook routes taking a lockCustomerEmail advisory
 * lock before writing) were reverted — they kept spreading into live paths
 * and produced a genuine deadlock. Mailbox mailability is judged here, at
 * send time, by reading current row STATE instead.
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

  // Owner ruling 2026-09-29 — mailbox mailability by SIBLING STATE: an
  // active subscriber is skipped when ANY OTHER row on the same mailbox
  // (exact, or the Google alias identity) is anything other than 'active'.
  // Both directions of the alias spelling are proven, plus each of the
  // non-active statuses the codebase actually writes to this column
  // (unsubscribed, pending, inactive, waitlist), plus the negative case
  // (a sibling on a genuinely DIFFERENT mailbox never blocks).
  test('an active johndoe@gmail.com with an unsubscribed j.o.h.n.d.o.e+x@gmail.com sibling is not mailed', async () => {
    const t = tag().replace(/-/g, '');
    const active = await subscriber(`johndoe${t}@gmail.com`);
    await subscriber(`j.o.h.n.d.o.e${t}+x@gmail.com`, { status: 'unsubscribed' });
    expect(await audienceIds([active.id])).toEqual([]);
  });

  test('the reverse spelling: an active j.o.h.n.d.o.e+x@gmail.com with an unsubscribed johndoe@gmail.com sibling is not mailed', async () => {
    const t = tag().replace(/-/g, '');
    const active = await subscriber(`j.o.h.n.d.o.e${t}+x@gmail.com`);
    await subscriber(`johndoe${t}@gmail.com`, { status: 'unsubscribed' });
    expect(await audienceIds([active.id])).toEqual([]);
  });

  test.each(['pending', 'waitlist', 'inactive'])(
    'a %s sibling on the same mailbox blocks the active row too',
    async (siblingStatus) => {
      const t = tag().replace(/-/g, '');
      const active = await subscriber(`sib${t}@gmail.com`);
      await subscriber(`s.i.b${t}+news@gmail.com`, { status: siblingStatus });
      expect(await audienceIds([active.id])).toEqual([]);
    },
  );

  test('an unrecognised/unknown status on a same-mailbox sibling fails closed (no CHECK constraint on status)', async () => {
    const t = tag().replace(/-/g, '');
    const active = await subscriber(`weird${t}@gmail.com`);
    await subscriber(`w.e.i.r.d${t}+x@gmail.com`, { status: 'bounced_forever_or_whatever' });
    expect(await audienceIds([active.id])).toEqual([]);
  });

  test('a sibling on a genuinely DIFFERENT mailbox does not block', async () => {
    const t = tag().replace(/-/g, '');
    const active = await subscriber(`unrelated1-${t}@gmail.com`);
    await subscriber(`unrelated2-${t}@gmail.com`, { status: 'unsubscribed' });
    expect(await audienceIds([active.id])).toEqual([active.id]);
  });

  // Codex P2 (:224) — "Exclude duplicate active rows for the same mailbox":
  // rule 2 above only catches a sibling whose status is NOT 'active', so a
  // pending Google-alias row that races the import and is later CONFIRMED —
  // both rows now 'active' — passed rule 2 entirely on both sides and both
  // would have been sent, a duplicate delivery to one inbox. Only the
  // CANONICAL row (earliest created_at, then id) is sendable.
  test('two ACTIVE alias rows for one Gmail inbox: exactly one is sendable, the canonical (earliest) one', async () => {
    const t = tag().replace(/-/g, '');
    const earlier = await subscriber(`dupealias${t}@gmail.com`, { created_at: new Date(Date.now() - 60000) });
    const later = await subscriber(`d.u.p.e.a.l.i.a.s${t}+work@gmail.com`, { created_at: new Date() });
    expect(await audienceIds([earlier.id, later.id])).toEqual([earlier.id]);
  });

  // The reverse spelling/order: the EARLIER row is the alias spelling, the
  // LATER row is the plain one — canonical is still whichever is earliest,
  // never a fixed "plain wins" rule.
  test('two ACTIVE alias rows, alias spelling created FIRST: the alias (earlier) row is the canonical one', async () => {
    const t = tag().replace(/-/g, '');
    const earlierAlias = await subscriber(`d.u.p.e.a.l.i.a.s.b${t}+work@gmail.com`, { created_at: new Date(Date.now() - 60000) });
    const laterPlain = await subscriber(`dupealiasb${t}@gmail.com`, { created_at: new Date() });
    expect(await audienceIds([earlierAlias.id, laterPlain.id])).toEqual([earlierAlias.id]);
  });

  // Codex P2 (:235) — the canonical pick runs only over rows that can be
  // mailed on their own. An older alias linked to an ARCHIVED customer, or
  // one whose exact address carries a global bounce, must not win the pick
  // and then be dropped by the archive/suppression predicate, leaving the
  // live sibling excluded as non-canonical (the mailbox got nothing).
  test('older alias linked to an archived customer: the newer live-linked alias is canonical and sent', async () => {
    const t = tag().replace(/-/g, '');
    const archived = await customer({ deleted_at: new Date() });
    const live = await customer();
    const older = await subscriber(`archcanon${t}@gmail.com`, { customer_id: archived.id, created_at: new Date(Date.now() - 60000) });
    const newer = await subscriber(`a.r.c.h.c.a.n.o.n${t}+x@gmail.com`, { customer_id: live.id, created_at: new Date() });
    expect(await audienceIds([older.id, newer.id])).toEqual([newer.id]);
  });

  test('older alias with an active global bounce on its exact address: the newer alias is canonical and sent', async () => {
    const t = tag().replace(/-/g, '');
    const olderEmail = `bouncecanon${t}@gmail.com`;
    const older = await subscriber(olderEmail, { created_at: new Date(Date.now() - 60000) });
    const newer = await subscriber(`b.o.u.n.c.e.c.a.n.o.n${t}+x@gmail.com`, { created_at: new Date() });
    await db('email_suppressions').insert({ email: olderEmail, suppression_type: 'bounce', status: 'active' });
    try {
      expect(await audienceIds([older.id, newer.id])).toEqual([newer.id]);
    } finally {
      await db('email_suppressions').where({ email: olderEmail }).del();
    }
  });

  test('an exact-duplicate-free normal active subscriber is unaffected by the new duplicate-active check', async () => {
    const t = tag().replace(/-/g, '');
    const solo = await subscriber(`solo${t}@gmail.com`);
    expect(await audienceIds([solo.id])).toEqual([solo.id]);
  });

  test('two ACTIVE rows on genuinely DIFFERENT mailboxes are both sendable — the check never cross-matches unrelated addresses', async () => {
    const t = tag().replace(/-/g, '');
    const a = await subscriber(`diffmailboxa${t}@gmail.com`);
    const b = await subscriber(`diffmailboxb${t}@gmail.com`);
    expect((await audienceIds([a.id, b.id])).sort()).toEqual([a.id, b.id].sort());
  });

  test('resume: a retryable ledger row for a recipient with a non-active same-mailbox sibling is terminalized as skipped, never mailed', async () => {
    const t = tag().replace(/-/g, '');
    const keep = await customer({}, { marketing_offers: true, email_enabled: true });
    const keepSub = await subscriber(keep.email, { customer_id: keep.id });
    const blockedEmail = `resumeblocked${t}@gmail.com`;
    const blockedSub = await subscriber(blockedEmail);
    const [send] = await db('newsletter_sends').insert({
      subject: 'Synthetic resume (mailbox state)',
      html_body: '<p>Body</p>',
      text_body: 'Body',
      status: 'sent',
      sent_at: new Date(Date.now() - 3600 * 1000),
      auto_share_social: false,
    }).returning(['id']);
    created.sends.push(send.id);
    await db('newsletter_send_deliveries').insert([
      { send_id: send.id, subscriber_id: keepSub.id, email: keepSub.email, status: 'failed' },
      { send_id: send.id, subscriber_id: blockedSub.id, email: blockedSub.email, status: 'failed' },
    ]);
    // A same-mailbox alias unsubscribes AFTER the original (partial) send.
    const aliasSub = await subscriber(`r.e.s.u.m.e.b.l.o.c.k.e.d${t}+x@gmail.com`, { status: 'unsubscribed' });
    created.subscribers.push(aliasSub.id);

    const result = await resumeCampaign(send.id);

    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    expect(mockSendBroadcast.mock.calls[0][0].recipients.map((r) => r.email)).toEqual([keepSub.email]);
    expect(result.skipped_ineligible).toBe(1);
    const skipped = await db('newsletter_send_deliveries').where({ send_id: send.id, subscriber_id: blockedSub.id }).first();
    expect(skipped).toMatchObject({ status: 'skipped', bounce_reason: 'ineligible_at_dispatch' });
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
