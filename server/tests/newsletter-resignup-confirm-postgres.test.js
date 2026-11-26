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

  test('a trusted resubscribe after an opt-out clears the reader proof; the reader\'s next confirm click writes it again', async () => {
    const email = addr();
    await signup(email);
    const pending = await db('newsletter_subscribers').where({ email }).first();
    await svc.confirmByToken(pending.confirmation_token);
    expect((await reload(pending.id)).reader_confirmed_at).toBeInstanceOf(Date);
    // The reader opts out, then a trusted add brings the row back.
    await db('newsletter_subscribers').where({ id: pending.id }).update({ status: 'unsubscribed', unsubscribed_at: new Date() });
    const back = await svc.subscribeOrResubscribe({ email, source: 'admin_add', strict: true, requireConfirmation: false, linkCustomer: false });
    expect(back.action).toBe('resubscribed');
    const row = await reload(pending.id);
    expect([row.status, row.unsubscribed_at, row.reader_confirmed_at, row.reader_confirmed_email]).toEqual(['active', null, null, null]);

    // Opt out again, sign up on the public form, click the new link: the proof is the new click.
    // The stamps are set back so the new link is later than each of them by minutes, not by the
    // milliseconds between two statements, and the last confirmation is past the 10-minute cooldown.
    await db('newsletter_subscribers').where({ id: pending.id }).update({
      status: 'unsubscribed', unsubscribed_at: ago(5 * MIN), confirmed_at: ago(20 * MIN), resubscribed_at: ago(20 * MIN), confirmation_sent_at: ago(30 * MIN),
    });
    expect((await signup(email)).action).toBe('confirmation_sent');
    const armed = await reload(pending.id);
    expect((await svc.confirmByToken(armed.confirmation_token)).action).toBe('confirmed');
    const done = await reload(pending.id);
    expect(done.status).toBe('active');
    expect(done.reader_confirmed_at.getTime()).toBe(done.confirmed_at.getTime());
    expect(done.reader_confirmed_email).toBe(email.toLowerCase());
  });

  // A trusted add reads an opted-out row; the reader's click on a live re-signup link lands before
  // the trusted write (which is by id). `racing` is a connection whose UPDATE waits for that click.
  test.each([
    ['the reader confirms: the row is active at the write, and the new proof stays', false],
    ['the reader confirms and opts out again: the row is opted out at the write, and the proof goes', true],
  ])('a trusted comeback that lands after the reader\'s click on a re-signup link (%s)', async (_label, optsOutAgain) => {
    const email = addr();
    const row = await unsubscribedRow(email, { reader_confirmed_at: ago(60 * DAY - MIN), reader_confirmed_email: email });
    await signup(email);
    const armed = await reload(row.id);
    let clicked = null;
    const racing = (table) => {
      const q = db(table);
      const update = q.update.bind(q);
      q.update = async (...args) => {
        if (!clicked) {
          clicked = await svc.confirmByToken(armed.confirmation_token);
          if (optsOutAgain) await db('newsletter_subscribers').where({ id: row.id }).update({ status: 'unsubscribed', unsubscribed_at: new Date() });
        }
        return update(...args);
      };
      return q;
    };
    racing.raw = (...args) => db.raw(...args);
    const added = await svc.subscribeOrResubscribe({ email, source: 'admin_add', strict: true, requireConfirmation: false, linkCustomer: false, dbh: racing });
    expect(clicked.action).toBe('confirmed');
    expect(added.action).toBe('resubscribed');
    const after = await reload(row.id);
    expect(after.status).toBe('active');
    expect(after.unsubscribed_at).toBeNull();
    if (optsOutAgain) {
      expect([after.reader_confirmed_at, after.reader_confirmed_email]).toEqual([null, null]);
    } else {
      expect(after.reader_confirmed_email).toBe(email.toLowerCase());
      // The proof is the click on the re-signup link, not the old one, and it is not before confirmed_at.
      expect(after.reader_confirmed_at.getTime()).toBeGreaterThan(row.reader_confirmed_at.getTime());
      expect(after.reader_confirmed_at.getTime()).toBeGreaterThanOrEqual(after.confirmed_at.getTime());
    }
  });

  test('a trusted add after the reader\'s click changes no stamp, and a click after a trusted add writes no proof (accepted)', async () => {
    // The reader clicks first: a later trusted add leaves confirmed_at and the proof as the click wrote them.
    const clickedFirst = addr();
    await signup(clickedFirst);
    const pending = await db('newsletter_subscribers').where({ email: clickedFirst }).first();
    expect((await svc.confirmByToken(pending.confirmation_token)).action).toBe('confirmed');
    const clicked = await reload(pending.id);
    const added = await svc.subscribeOrResubscribe({ email: clickedFirst, source: 'admin_add', strict: true, requireConfirmation: false, linkCustomer: false });
    expect(added.action).toBe('already_active');
    const after = await reload(pending.id);
    expect(after.confirmed_at).toEqual(clicked.confirmed_at);
    expect(after.reader_confirmed_at).toEqual(clicked.reader_confirmed_at);
    expect(after.reader_confirmed_at.getTime()).toBe(after.confirmed_at.getTime());

    // The trusted add lands first: the reader's link then reads already_active and writes nothing.
    const addedFirst = addr();
    await signup(addedFirst);
    const row = await db('newsletter_subscribers').where({ email: addedFirst }).first();
    await svc.subscribeOrResubscribe({ email: addedFirst, source: 'admin_add', strict: true, requireConfirmation: false, linkCustomer: false });
    expect((await svc.confirmByToken(row.confirmation_token)).action).toBe('already_active');
    const promoted = await reload(row.id);
    expect(promoted.status).toBe('active');
    expect(promoted.reader_confirmed_at).toBeNull();
    expect(promoted.reader_confirmed_email).toBeNull();
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

  // Migration 20261125200000 (owner 2026-11-25, "YES THEY DID"): the Beehiiv import rows that still
  // hold their sign-up get the reader proof; a source label alone, or any opt-out, sunset or
  // comeback stamp, does not.
  test('the Beehiiv sign-up step writes the proof only on import-day rows nobody wrote since, with the sign-up intact', async () => {
    const migration = require('../models/migrations/20261125200000_newsletter_beehiiv_signup_proof');
    const day = new Date('2026-04-19T16:00:00Z');
    const confirmed = new Date('2026-04-19T16:00:01Z');
    // Everything runs in one transaction that always rolls back: the step updates every
    // matching row of the database, not only these fixtures.
    const trx = await db.transaction();
    try {
      const bee = async (over = {}) => {
        const [r] = await trx('newsletter_subscribers').insert({
          email: addr(), source: 'beehiiv_migration', status: 'active', created_at: day, updated_at: day, confirmed_at: confirmed, ...over,
        }).returning('*');
        return r;
      };
      const rows = {
        kept: await bee(),
        orphan: await bee({ source: 'beehiiv_migration_orphan' }),
        upper: await bee({ email: `UPPER-${addr()}`.toUpperCase() }),
        written: await bee({ updated_at: new Date('2026-08-01T12:00:00Z') }),
        lateLabel: await bee({ created_at: new Date('2026-06-01T12:00:00Z'), updated_at: new Date('2026-06-01T12:00:00Z') }),
        website: await bee({ source: 'newsletter_footer' }),
        optedOut: await bee({ status: 'unsubscribed', unsubscribed_at: day }),
        unsubStamp: await bee({ unsubscribed_at: day }),
        sunset: await bee({ deactivated_at: day }),
        cameBack: await bee({ resubscribed_at: day }),
        noConfirm: await bee({ confirmed_at: null }),
        clicked: await bee({ reader_confirmed_at: new Date('2026-11-24T12:00:00Z'), reader_confirmed_email: 'clicked@example.com' }),
      };
      await migration.up(trx);
      await migration.up(trx);
      const after = {};
      for (const [name, r] of Object.entries(rows)) after[name] = await trx('newsletter_subscribers').where({ id: r.id }).first();
      const proofed = Object.keys(rows).filter((name) => after[name].reader_confirmed_at !== null);
      expect(proofed.sort()).toEqual(['clicked', 'kept', 'orphan', 'upper']);
      expect(after.kept.reader_confirmed_at.getTime()).toBe(confirmed.getTime());
      expect(after.kept.reader_confirmed_email).toBe(rows.kept.email.toLowerCase());
      expect(after.upper.reader_confirmed_email).toBe(rows.upper.email.toLowerCase());
      // A reader's own earlier click is left as it was.
      expect(after.clicked.reader_confirmed_email).toBe('clicked@example.com');
    } finally {
      await trx.rollback();
    }
  });
});
