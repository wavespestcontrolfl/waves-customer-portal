/**
 * B13: undoing the DOI pre-stamp after a failed send must never null a stamp
 * that records a real delivery (a pending resubscribe re-mails the SAME
 * token). A null stamp is exempt from the DOI expiry (lookupByToken) and from
 * purgeStalePendingSubscribers, which would make an already-delivered link
 * permanent. Real newsletter_subscribers + the real state machine; rows use a
 * unique address and are removed afterwards.
 */
const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

(SKIP ? describe.skip : describe)('newsletter confirmation stamp release on PostgreSQL (B13)', () => {
  let db;
  let subs;
  let confirm;
  const made = [];
  const DAY = 24 * 60 * 60 * 1000;

  beforeAll(() => {
    db = require('../models/db');
    subs = require('../services/newsletter-subscribers');
    confirm = require('../services/newsletter-confirm');
  });
  afterAll(async () => {
    if (made.length) await db('newsletter_subscribers').whereIn('email', made).del();
    await db.destroy();
  });

  const signup = (email) => subs.subscribeOrResubscribe({ email, requireConfirmation: true, linkCustomer: false, source: 'public_form' });
  const row = (email) => db('newsletter_subscribers').where({ email }).first();
  const newEmail = () => { const e = `b13-stamp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`; made.push(e); return e; };
  const failure = () => new confirm.ConfirmationVetoedError('ownership_busy');

  test('first-ever attempt failing clears the stamp, so a re-signup re-sends', async () => {
    const email = newEmail();
    const first = await signup(email);
    expect(first.action).toBe('confirmation_sent');
    expect(first.subscriber.confirmation_sent_at).toBeTruthy();
    expect(await confirm.releaseUnsentConfirmationStamp(first.subscriber, failure(), { restoreTo: first.priorConfirmationSentAt })).toBe(true);
    expect((await row(email)).confirmation_sent_at).toBeNull();
    const again = await signup(email);
    expect(again.action).toBe('confirmation_resent');
    expect(again.subscriber.confirmation_sent_at).toBeTruthy();
  });

  test('delivered first email, then a FAILED resend: the delivery stamp is restored, so expiry and purge still apply', async () => {
    const email = newEmail();
    const first = await signup(email);
    // The first email was delivered long ago (past the 7-day link TTL and the 30-day purge window).
    const delivered = new Date(Date.now() - 45 * DAY);
    await db('newsletter_subscribers').where({ id: first.subscriber.id }).update({ confirmation_sent_at: delivered });

    const resend = await signup(email);
    expect(resend.action).toBe('confirmation_resent');
    expect(resend.subscriber.confirmation_token).toBe(first.subscriber.confirmation_token);
    expect(new Date(resend.priorConfirmationSentAt).getTime()).toBe(delivered.getTime());

    expect(await confirm.releaseUnsentConfirmationStamp(resend.subscriber, failure(), { restoreTo: resend.priorConfirmationSentAt })).toBe(true);
    const after = await row(email);
    expect(after.confirmation_sent_at).not.toBeNull();
    expect(new Date(after.confirmation_sent_at).getTime()).toBe(delivered.getTime());
    // Expiry still applies to the link that was actually delivered...
    expect((await subs.lookupByToken(first.subscriber.confirmation_token)).action).toBe('expired');
    // ...and the row stays inside the purge sweep's predicate (pending, non-null
    // stamp older than the window). Mirrored rather than running the sweep: it
    // deletes every stale pending row in a shared test database.
    const purgeable = await db('newsletter_subscribers')
      .where({ email, status: 'pending' })
      .whereNotNull('confirmation_sent_at')
      .where('confirmation_sent_at', '<', new Date(Date.now() - 30 * DAY))
      .first('id');
    expect(purgeable).toBeTruthy();
  });

  test('concurrent attempts: a failure never clears a newer attempt\'s stamp, and restores the earlier real one', async () => {
    const email = newEmail();
    const first = await signup(email);
    const a = await signup(email); // attempt A (stamp tA, prior = first delivery)
    await new Promise((r) => setTimeout(r, 15));
    const b = await signup(email); // attempt B (stamp tB overwrites tA)
    expect(new Date(b.subscriber.confirmation_sent_at).getTime()).toBeGreaterThan(new Date(a.subscriber.confirmation_sent_at).getTime());

    // A's send fails AFTER B re-stamped: compare-and-set no-ops, B's stamp stays.
    expect(await confirm.releaseUnsentConfirmationStamp(a.subscriber, failure(), { restoreTo: a.priorConfirmationSentAt })).toBe(false);
    expect(new Date((await row(email)).confirmation_sent_at).getTime()).toBe(new Date(b.subscriber.confirmation_sent_at).getTime());

    // B's send fails while A's had succeeded: B's undo restores the value it overwrote
    // (A's stamp, the real delivery), not null.
    expect(await confirm.releaseUnsentConfirmationStamp(b.subscriber, failure(), { restoreTo: b.priorConfirmationSentAt })).toBe(true);
    expect(new Date((await row(email)).confirmation_sent_at).getTime()).toBe(new Date(a.subscriber.confirmation_sent_at).getTime());
    expect(first.subscriber.confirmation_token).toBe(b.subscriber.confirmation_token);
  });

  test('a rotated token (correction) is left alone', async () => {
    const email = newEmail();
    const first = await signup(email);
    await db('newsletter_subscribers').where({ id: first.subscriber.id }).update({ confirmation_token: db.raw('gen_random_uuid()') });
    expect(await confirm.releaseUnsentConfirmationStamp(first.subscriber, failure())).toBe(false);
    expect((await row(email)).confirmation_sent_at).not.toBeNull();
  });
});
