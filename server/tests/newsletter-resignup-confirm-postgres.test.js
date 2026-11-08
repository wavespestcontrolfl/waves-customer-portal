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
    // A second click on the same link is the idempotent already-active page.
    expect((await svc.confirmByToken(after.confirmation_token)).action).toBe('already_active');
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

  test('an opt-out after the re-signup email kills the new link', async () => {
    const email = addr();
    const row = await unsubscribedRow(email);
    await signup(email);
    const minted = await reload(row.id);
    await db('newsletter_subscribers').where({ id: row.id }).update({ unsubscribed_at: new Date() });
    expect((await svc.confirmByToken(minted.confirmation_token)).action).toBe('unsubscribed');
    expect((await reload(row.id)).status).toBe('unsubscribed');
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
