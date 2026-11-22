/**
 * Sweep #7765 B5 on real PostgreSQL: a public double-opt-in signup on an
 * unsubscribed/inactive row changes nothing about the opt-out until the
 * emailed link is clicked; repeat submits are throttled for 10 minutes; the
 * stale-pending purge reverts opted-out rows instead of deleting them.
 * The SQL here (cooldown predicate, live-token ordering in the CAS,
 * jsonb tag removal) is what the mocked suite in newsletter-subscribers.test.js
 * cannot prove. Synthetic example.com addresses only; every row is removed.
 */
const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

(SKIP ? describe.skip : describe)('newsletter public re-signup defers to the confirm click (B5)', () => {
  let db;
  let svc;
  let n = 0;
  const made = [];
  const MIN = 60 * 1000;
  const DAY = 24 * 60 * MIN;
  const ago = (ms) => new Date(Date.now() - ms);

  beforeAll(() => {
    db = require('../models/db');
    svc = require('../services/newsletter-subscribers');
  });
  afterEach(async () => {
    if (made.length) await db('newsletter_subscribers').whereIn('email', made).del();
    made.length = 0;
  });
  afterAll(async () => { await db.destroy(); });

  const addr = () => { const e = `b5-${Date.now()}-${++n}@example.com`; made.push(e); return e; };
  const insert = async (row) => {
    const [r] = await db('newsletter_subscribers').insert({ source: 'newsletter_footer', ...row }).returning('*');
    return r;
  };
  const reload = (id) => db('newsletter_subscribers').where({ id }).first();
  const signup = (email) => svc.subscribeOrResubscribe({
    email, source: 'newsletter_footer', strict: true, requireConfirmation: true, publicSignup: true, linkCustomer: false,
  });

  const unsubscribedRow = (email, over = {}) => insert({
    email,
    status: 'unsubscribed',
    confirmation_sent_at: ago(60 * DAY),
    confirmed_at: ago(60 * DAY - MIN),
    unsubscribed_at: ago(30 * DAY),
    ...over,
  });

  test('unsubscribed row: submit keeps every opt-out field; the confirm click applies the comeback', async () => {
    const email = addr();
    const row = await unsubscribedRow(email);
    const result = await signup(email);
    expect(result.action).toBe('confirmation_sent');

    const after = await reload(row.id);
    expect(after.status).toBe('unsubscribed');
    expect(after.unsubscribed_at).toEqual(row.unsubscribed_at);
    expect(after.resubscribed_at).toBeNull();
    expect(after.confirmed_at).toEqual(row.confirmed_at);
    // The submit is no click: the reader-confirmed stamps stay empty until the link is used.
    expect(after.reader_confirmed_at).toBeNull();
    expect(after.reader_confirmed_email).toBeNull();
    expect(after.confirmation_token).not.toBe(row.confirmation_token);
    expect(after.confirmation_sent_at.getTime()).toBeGreaterThan(row.unsubscribed_at.getTime());

    expect((await svc.lookupByToken(after.confirmation_token)).action).toBe('pending');
    const confirmed = await svc.confirmByToken(after.confirmation_token);
    expect(confirmed.action).toBe('confirmed');
    const done = await reload(row.id);
    expect(done.status).toBe('active');
    expect(done.unsubscribed_at).toBeNull();
    expect(done.resubscribed_at).toBeInstanceOf(Date);
    expect(done.confirmed_at.getTime()).toBeGreaterThan(row.confirmed_at.getTime());
    // The click wrote the reader's proof: one instant with confirmed_at, bound to this address.
    expect(done.reader_confirmed_at.getTime()).toBe(done.confirmed_at.getTime());
    expect(done.reader_confirmed_email).toBe(email.toLowerCase());
    // A second click on the same link is the idempotent already-active page.
    expect((await svc.confirmByToken(after.confirmation_token)).action).toBe('already_active');
  });

  test('a new public signup: the confirm click stamps the reader proof; a trusted add of a pending row stamps confirmed_at and nothing else', async () => {
    const clicked = addr();
    expect((await signup(clicked)).action).toBe('confirmation_sent');
    const pending = await db('newsletter_subscribers').where({ email: clicked }).first();
    expect(pending.status).toBe('pending');
    expect(pending.reader_confirmed_at).toBeNull();
    expect((await svc.confirmByToken(pending.confirmation_token)).action).toBe('confirmed');
    const done = await reload(pending.id);
    expect(done.status).toBe('active');
    expect(done.reader_confirmed_at.getTime()).toBe(done.confirmed_at.getTime());
    expect(done.reader_confirmed_email).toBe(clicked.toLowerCase());

    const trusted = addr();
    await signup(trusted);
    const promoted = await svc.subscribeOrResubscribe({ email: trusted, source: 'admin_add', strict: true, requireConfirmation: false, linkCustomer: false });
    expect(promoted.action).toBe('confirmed');
    const row = await db('newsletter_subscribers').where({ email: trusted }).first();
    expect(row.status).toBe('active');
    expect(row.confirmed_at).toBeInstanceOf(Date);
    expect(row.reader_confirmed_at).toBeNull();
    expect(row.reader_confirmed_email).toBeNull();
  });

  // A trusted add can activate a pending row after the confirmation email went out and before the
  // reader presses the button. The click then finds an active row and must still leave the proof.
  test('a confirm click on a row a trusted add activated first records the reader proof once, and changes nothing else', async () => {
    const email = addr();
    await signup(email);
    const pending = await db('newsletter_subscribers').where({ email }).first();
    await svc.subscribeOrResubscribe({ email, source: 'admin_add', strict: true, requireConfirmation: false, linkCustomer: false });
    const promoted = await reload(pending.id);
    expect(promoted.status).toBe('active');
    expect(promoted.reader_confirmed_at).toBeNull();
    // The read-only page lookup offers the button, and writes nothing.
    expect(await svc.lookupByToken(pending.confirmation_token)).toMatchObject({ action: 'already_active', confirmable: true });
    expect((await reload(pending.id)).reader_confirmed_at).toBeNull();

    const clicked = await svc.confirmByToken(pending.confirmation_token);
    expect(clicked.action).toBe('already_active');
    // The answer's row is the one the write returned.
    expect(clicked.subscriber.id).toBe(pending.id);
    expect(clicked.subscriber.reader_confirmed_at).toBeInstanceOf(Date);
    const done = await reload(pending.id);
    expect(clicked.subscriber.reader_confirmed_email).toBe(email.toLowerCase());
    expect(done.reader_confirmed_email).toBe(email.toLowerCase());
    expect(done.reader_confirmed_at.getTime()).toBeGreaterThanOrEqual(done.confirmed_at.getTime());
    expect(done.status).toBe('active');
    expect(done.confirmed_at).toEqual(promoted.confirmed_at);
    expect(done.confirmation_token).toBe(pending.confirmation_token);
    expect(done.unsubscribed_at).toBeNull();
    expect(done.resubscribed_at).toBeNull();

    // A second click writes nothing: the proof keeps its first instant, and the page shows no button.
    expect((await svc.lookupByToken(pending.confirmation_token)).confirmable).toBe(false);
    expect((await svc.confirmByToken(pending.confirmation_token)).action).toBe('already_active');
    expect((await reload(pending.id)).reader_confirmed_at).toEqual(done.reader_confirmed_at);
  });

  test('a click on an active row writes no reader proof for an expired link, a link older than an opt-out or a comeback, or a link with no send on record', async () => {
    const activeRow = (over) => insert({ email: addr(), status: 'active', confirmation_sent_at: ago(2 * DAY), confirmed_at: ago(DAY), ...over });
    const rows = {
      // The link aged past 7 days before the click.
      expired: await activeRow({ confirmation_sent_at: ago(8 * DAY) }),
      // The original link, then an opt-out, then a trusted resubscribe: that write clears
      // unsubscribed_at and sets resubscribed_at, later than the send.
      afterComeback: await activeRow({ confirmed_at: ago(MIN), resubscribed_at: ago(MIN) }),
      // Opt-out and sunset stamps later than the send (not a state the writers leave on an active row).
      afterOptOut: await activeRow({ unsubscribed_at: ago(DAY) }),
      afterSunset: await activeRow({ deactivated_at: ago(DAY) }),
      // A row a trusted flow inserted: it has a token, and no link went out.
      neverSent: await activeRow({ confirmation_sent_at: null }),
    };
    for (const [label, row] of Object.entries(rows)) {
      // The page lookup (JS) and the write (SQL) agree: no button, and a POST writes nothing.
      const looked = await svc.lookupByToken(row.confirmation_token);
      const result = await svc.confirmByToken(row.confirmation_token);
      const after = await reload(row.id);
      expect([label, looked.confirmable, result.action, after.reader_confirmed_at, after.reader_confirmed_email, after.status])
        .toEqual([label, false, 'already_active', null, null, 'active']);
    }
  });

  test('a trusted add promotes only a row that is still pending: after the reader\'s click it changes no stamp', async () => {
    const email = addr();
    await signup(email);
    const pending = await db('newsletter_subscribers').where({ email }).first();
    expect((await svc.confirmByToken(pending.confirmation_token)).action).toBe('confirmed');
    const clicked = await reload(pending.id);
    const added = await svc.subscribeOrResubscribe({ email, source: 'admin_add', strict: true, requireConfirmation: false, linkCustomer: false });
    expect(added.action).toBe('already_active');
    const after = await reload(pending.id);
    expect(after.confirmed_at).toEqual(clicked.confirmed_at);
    expect(after.reader_confirmed_at).toEqual(clicked.reader_confirmed_at);
    expect(after.reader_confirmed_at.getTime()).toBe(after.confirmed_at.getTime());
  });

  test('inactive row: sunset markers and the re-engagement tag survive the submit and go at confirm', async () => {
    const email = addr();
    const row = await insert({
      email,
      status: 'inactive',
      confirmation_sent_at: ago(60 * DAY),
      confirmed_at: ago(60 * DAY - MIN),
      deactivated_at: ago(20 * DAY),
      deactivated_reason: 'sunset_no_engagement',
      reengagement_flagged_at: ago(40 * DAY),
      tags: JSON.stringify(['reengagement_due', 'keep_me']),
    });
    expect((await signup(email)).action).toBe('confirmation_sent');
    const mid = await reload(row.id);
    expect(mid.status).toBe('inactive');
    expect(mid.deactivated_at).toEqual(row.deactivated_at);
    expect(mid.deactivated_reason).toBe('sunset_no_engagement');
    expect(mid.reengagement_flagged_at).toEqual(row.reengagement_flagged_at);
    expect(mid.tags).toEqual(['reengagement_due', 'keep_me']);

    expect((await svc.confirmByToken(mid.confirmation_token)).action).toBe('confirmed');
    const done = await reload(row.id);
    expect(done.status).toBe('active');
    expect(done.deactivated_at).toBeNull();
    expect(done.deactivated_reason).toBeNull();
    expect(done.reengagement_flagged_at).toBeNull();
    expect(done.tags).toEqual(['keep_me']);
  });

  test('waitlist tags follow a re-signup on an opted-out row (token-fenced) and never touch an active row', async () => {
    const email = addr();
    const row = await unsubscribedRow(email, { tags: JSON.stringify(['keep_me']) });
    const result = await signup(email);
    const wrote = await svc.applyWaitlistTags(result.subscriber, ['zip:33570', 'city:ruskin'], {});
    expect(wrote).toBe(1);
    const tagged = await reload(row.id);
    expect(tagged.status).toBe('unsubscribed');
    expect(tagged.tags).toEqual(expect.arrayContaining(['keep_me', 'out_of_area_waitlist', 'zip:33570', 'city:ruskin']));
    // A stale/other token does not match; an active row is never matched.
    expect(await svc.applyWaitlistTags({ id: row.id, confirmation_token: '00000000-0000-4000-8000-000000000000' }, [], {})).toBe(0);
    await svc.confirmByToken(tagged.confirmation_token);
    expect(await svc.applyWaitlistTags({ id: row.id, confirmation_token: tagged.confirmation_token }, ['zip:34205'], {})).toBe(0);
  });

  test('a second submit inside 10 minutes is throttled; after 10 minutes it sends with a new token', async () => {
    const email = addr();
    const row = await unsubscribedRow(email);
    const first = await signup(email);
    expect(first.action).toBe('confirmation_sent');
    const stamped = await reload(row.id);

    const again = await signup(email);
    expect(again.action).toBe('confirmation_throttled');
    const same = await reload(row.id);
    expect(same.confirmation_token).toBe(stamped.confirmation_token);
    expect(same.confirmation_sent_at).toEqual(stamped.confirmation_sent_at);

    await db('newsletter_subscribers').where({ id: row.id }).update({ confirmation_sent_at: ago(11 * MIN) });
    const later = await signup(email);
    expect(later.action).toBe('confirmation_sent');
    const fresh = await reload(row.id);
    expect(fresh.confirmation_token).not.toBe(stamped.confirmation_token);
    expect(fresh.status).toBe('unsubscribed');
  });

  test('pending row: resend is throttled inside 10 minutes and allowed after', async () => {
    const email = addr();
    const row = await insert({ email, status: 'pending', confirmation_sent_at: ago(2 * MIN) });
    expect((await signup(email)).action).toBe('confirmation_throttled');
    expect((await reload(row.id)).confirmation_sent_at).toEqual(row.confirmation_sent_at);

    await db('newsletter_subscribers').where({ id: row.id }).update({ confirmation_sent_at: ago(11 * MIN) });
    const result = await signup(email);
    expect(result.action).toBe('confirmation_resent');
    expect(result.subscriber.confirmation_token).toBe(row.confirmation_token); // same link as before
    await db('newsletter_subscribers').where({ id: row.id }).update({ confirmation_sent_at: null });
    expect((await signup(email)).action).toBe('confirmation_resent');
  });

  test('the original signup link on an unsubscribed row stays stale and never reactivates it', async () => {
    const email = addr();
    const row = await unsubscribedRow(email, {
      confirmation_sent_at: ago(3 * DAY),
      confirmed_at: ago(3 * DAY - MIN),
      unsubscribed_at: ago(2 * DAY),
    });
    expect((await svc.lookupByToken(row.confirmation_token)).action).toBe('unsubscribed');
    expect((await svc.confirmByToken(row.confirmation_token)).action).toBe('unsubscribed');
    expect((await reload(row.id)).status).toBe('unsubscribed');
  });

  test('a one-click-style opt-out after the re-signup email kills the new link, even though the row is already unsubscribed', async () => {
    const email = addr();
    const row = await unsubscribedRow(email);
    await signup(email);
    const minted = await reload(row.id);
    // The same statement shape the unsubscribe route and the SendGrid
    // unsubscribe events use.
    const hit = await svc.whereOptOutNeedsWrite(db('newsletter_subscribers').where({ id: row.id }))
      .update({ status: 'unsubscribed', unsubscribed_at: new Date(), updated_at: new Date() });
    expect(hit).toBe(1);
    expect((await svc.confirmByToken(minted.confirmation_token)).action).toBe('unsubscribed');
    expect((await reload(row.id)).status).toBe('unsubscribed');
    // A repeat opt-out with no outstanding re-signup never rewrites the date.
    const stamped = (await reload(row.id)).unsubscribed_at;
    const again = await svc.whereOptOutNeedsWrite(db('newsletter_subscribers').where({ id: row.id }))
      .update({ unsubscribed_at: new Date() });
    expect(again).toBe(0);
    expect((await reload(row.id)).unsubscribed_at).toEqual(stamped);
  });

  test('an inactive row that opts out after a re-signup email also loses the link', async () => {
    const email = addr();
    const row = await insert({ email, status: 'inactive', confirmation_sent_at: ago(60 * DAY), confirmed_at: ago(60 * DAY - MIN), deactivated_at: ago(20 * DAY) });
    await signup(email);
    const minted = await reload(row.id);
    await svc.whereOptOutNeedsWrite(db('newsletter_subscribers').where({ id: row.id }))
      .update({ status: 'unsubscribed', unsubscribed_at: new Date(), updated_at: new Date() });
    expect((await svc.confirmByToken(minted.confirmation_token)).action).toBe('unsubscribed');
  });

  test('an expired re-signup link (past 7 days) confirms nothing', async () => {
    const email = addr();
    const row = await unsubscribedRow(email);
    await signup(email);
    const minted = await reload(row.id);
    await db('newsletter_subscribers').where({ id: row.id }).update({ confirmation_sent_at: ago(8 * DAY) });
    expect((await svc.confirmByToken(minted.confirmation_token)).action).toBe('expired');
    expect((await reload(row.id)).status).toBe('unsubscribed');
  });

  test('purge reverts stale pending rows that carry opt-out history and deletes the ones without', async () => {
    const stale = ago(40 * DAY);
    const unsub = await insert({ email: addr(), status: 'pending', confirmation_sent_at: stale, unsubscribed_at: ago(50 * DAY) });
    const sunset = await insert({ email: addr(), status: 'pending', confirmation_sent_at: stale, deactivated_at: ago(50 * DAY), deactivated_reason: 'sunset_no_engagement' });
    const both = await insert({ email: addr(), status: 'pending', confirmation_sent_at: stale, deactivated_at: ago(60 * DAY), unsubscribed_at: ago(50 * DAY) });
    const wiped = await insert({ email: addr(), status: 'pending', confirmation_sent_at: stale });
    const fresh = await insert({ email: addr(), status: 'pending', confirmation_sent_at: ago(2 * MIN), unsubscribed_at: ago(50 * DAY) });

    await svc.purgeStalePendingSubscribers();

    const u = await reload(unsub.id);
    expect(u.status).toBe('unsubscribed');
    expect(u.confirmation_token).toBeNull();
    expect(u.unsubscribed_at).toEqual(unsub.unsubscribed_at);
    const s = await reload(sunset.id);
    expect(s.status).toBe('inactive');
    expect(s.confirmation_token).toBeNull();
    expect(s.deactivated_reason).toBe('sunset_no_engagement');
    expect((await reload(both.id)).status).toBe('unsubscribed');
    expect(await reload(wiped.id)).toBeUndefined();
    expect((await reload(fresh.id)).status).toBe('pending');
  });
});
