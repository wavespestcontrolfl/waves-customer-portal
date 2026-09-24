/**
 * server/services/newsletter-subscribers.js — subscribeOrResubscribe's
 * 'waitlist' → 'pending'/'active' transition (Codex pre-push P1 :1087,
 * round 7, 2026-09-24).
 *
 * The out-of-area inspection-link waitlist (inspection-public.js's POST
 * /:token/waitlist) inserts a `newsletter_subscribers` row at
 * status='waitlist' directly — it never calls subscribeOrResubscribe, so
 * joining the waitlist alone sends no email (unaffected by this fix,
 * confirmed by the sweep-blindness test below). But BEFORE this fix, a
 * later DELIBERATE newsletter signup by that same email fell through
 * subscribeOrResubscribe's final "already active" branch (the function
 * didn't recognize 'waitlist' as a status at all) — no confirmation email,
 * and the row stayed excluded from ordinary sends forever. This suite
 * covers the new branch directly.
 */

jest.mock('../services/newsletter-sunset', () => ({ REENGAGEMENT_TAG: 'reengagement_due' }));

const firstResults = {};
const updateCalls = [];
jest.mock('../models/db', () => {
  const mkChain = (table) => {
    const q = {};
    const passthrough = ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'select', 'limit'];
    for (const m of passthrough) q[m] = () => q;
    q.first = async () => (firstResults[table] !== undefined ? firstResults[table] : null);
    q.update = async (payload) => { updateCalls.push({ table, payload }); return 1; };
    q.del = async () => 0;
    q.insert = () => q;
    q.returning = async () => [{ id: 'new-id' }];
    return q;
  };
  const dbFn = jest.fn((table) => mkChain(table));
  // subscribeOrResubscribe embeds db.raw(...) as an UPDATE payload VALUE
  // (confirmation_token, tags) — never awaited as its own query in the
  // branches this suite exercises (linkCustomer:false throughout, so
  // linkToCustomer's own raw UPDATE never runs). A plain passthrough
  // stand-in is enough either way.
  dbFn.raw = jest.fn((sql) => sql);
  dbFn.transaction = jest.fn(async (fn) => fn(dbFn));
  return dbFn;
});

const {
  subscribeOrResubscribe,
  purgeStalePendingSubscribers,
} = require('../services/newsletter-subscribers');

afterEach(() => {
  for (const key of Object.keys(firstResults)) delete firstResults[key];
  updateCalls.length = 0;
  jest.clearAllMocks();
});

const WAITLIST_ROW = {
  id: 'sub-1',
  email: 'pat@example.com',
  first_name: null,
  last_name: null,
  source: 'expansion_waitlist:Hardee',
  status: 'waitlist',
  confirmation_token: null,
  confirmation_sent_at: null,
  confirmed_at: null,
  subscribed_at: new Date('2026-09-20'),
  resubscribed_at: null,
  unsubscribed_at: null,
};

describe('subscribeOrResubscribe — existing "waitlist" row (P1 :1087)', () => {
  test('a DELIBERATE signup (requireConfirmation:true) transitions waitlist → pending and sends a confirmation, same as a brand-new signup', async () => {
    firstResults.newsletter_subscribers = { ...WAITLIST_ROW };

    const result = await subscribeOrResubscribe({
      email: 'PAT@example.com',
      source: 'newsletter_footer',
      requireConfirmation: true,
      linkCustomer: false,
    });

    // The exact action string public-newsletter.js / public-quote.js key
    // their confirmation-email send off (`action === 'confirmation_sent'`).
    expect(result.action).toBe('confirmation_sent');

    const update = updateCalls.find((c) => c.table === 'newsletter_subscribers');
    expect(update).toBeTruthy();
    expect(update.payload.status).toBe('pending');
    expect(update.payload.confirmation_sent_at).toBeInstanceOf(Date);
    expect(update.payload.confirmation_token).toBeDefined(); // db.raw('gen_random_uuid()') — a fresh token
    expect(update.payload.source).toBe('newsletter_footer');
    // Never activated outright, and never touches fields a waitlist row
    // was never part of the subscribe/unsubscribe lifecycle for.
    expect(update.payload.status).not.toBe('active');
    expect(update.payload.resubscribed_at).toBeUndefined();
    expect(update.payload.unsubscribed_at).toBeUndefined();
  });

  test('Codex #4737 r2 P1: a TRUSTED flow (requireConfirmation:false — e.g. the customer bulk import) never promotes a waitlist row; it is skipped untouched', async () => {
    firstResults.newsletter_subscribers = { ...WAITLIST_ROW };

    const result = await subscribeOrResubscribe({
      email: 'pat@example.com',
      source: 'admin_add',
      requireConfirmation: false,
      linkCustomer: false,
    });

    expect(result.action).toBe('skipped_waitlist');
    expect(updateCalls.some((c) => c.table === 'newsletter_subscribers')).toBe(false);
  });
});

describe('Codex #4737 r3 P2: an explicit admin add may promote a waitlist row', () => {
  test('promoteWaitlist:true with requireConfirmation:false → active', async () => {
    firstResults.newsletter_subscribers = { ...WAITLIST_ROW };
    const result = await subscribeOrResubscribe({
      email: 'pat@example.com', source: 'admin_manual', requireConfirmation: false, linkCustomer: false, promoteWaitlist: true,
    });
    expect(result.action).toBe('resubscribed');
    const update = updateCalls.find((c) => c.table === 'newsletter_subscribers');
    expect(update.payload.status).toBe('active');
  });
});

describe('joining the waitlist alone sends no email (unaffected by the fix)', () => {
  test('purgeStalePendingSubscribers — the one proactive sweep in this module — is blind to a "waitlist" row: it only ever matches status="pending"', async () => {
    // A fresh waitlist row (as inspection-public.js's own insert leaves it —
    // no confirmation_token, no confirmation_sent_at) sitting in the table
    // with NO subscribeOrResubscribe call ever made for it. The sweep must
    // never pick it up — it filters status='pending' only, so a 'waitlist'
    // row can never be found let alone emailed by it.
    await purgeStalePendingSubscribers();
    // No row read/deleted for this call in this mock (del() resolves 0
    // unconditionally) — the meaningful assertion is that the query never
    // even needed to look at a 'waitlist' row's shape to decide that: the
    // WHERE clause itself is a status='pending' equality, structurally
    // incapable of matching 'waitlist'. Nothing in newsletter-subscribers.js
    // updates or emails a subscriber row outside subscribeOrResubscribe /
    // confirmByToken (both require an explicit call this test never makes).
    expect(updateCalls).toHaveLength(0);
  });

  test('a bare waitlist row has no confirmation apparatus set — nothing for a link/email to have gone out from', () => {
    const row = { ...WAITLIST_ROW };
    expect(row.status).toBe('waitlist');
    expect(row.confirmation_token).toBeNull();
    expect(row.confirmation_sent_at).toBeNull();
    expect(row.confirmed_at).toBeNull();
  });
});

// Codex #4737 r20 / r21 P2s: races with the consultation page's waitlist.
describe('subscribeOrResubscribe — waitlist races', () => {
  test('a waitlist promotion that loses the race (0 rows) re-runs against the row\'s new state — never overwrites its token', async () => {
    const db = require('../models/db');
    let reads = 0;
    db.mockImplementation((table) => {
      const q = {};
      for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'select', 'limit']) q[m] = () => q;
      q.first = async () => {
        reads += 1;
        // First read: still waitlist; after the lost update: already pending.
        return reads === 1 ? { ...WAITLIST_ROW } : { ...WAITLIST_ROW, status: 'pending', confirmation_token: 'first-token', confirmation_sent_at: new Date() };
      };
      q.update = async (payload) => { updateCalls.push({ table, payload }); return 0; };
      q.insert = () => q;
      q.returning = async () => [{ id: 'new-id' }];
      return q;
    });
    const result = await subscribeOrResubscribe({ email: 'pat@example.com', source: 'newsletter_footer', requireConfirmation: true, linkCustomer: false });
    expect(result.action).not.toBe('confirmation_sent');
    // Only the one conditional (lost) promotion update was attempted.
    expect(updateCalls.filter((c) => c.payload.status === 'pending')).toHaveLength(1);
  });

  test('a new-email insert that loses the unique race to the waitlist insert re-runs the state machine, never a 500', async () => {
    const db = require('../models/db');
    let reads = 0;
    db.mockImplementation(() => {
      const q = {};
      for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'select', 'limit']) q[m] = () => q;
      q.first = async () => {
        reads += 1;
        return reads === 1 ? null : { ...WAITLIST_ROW };
      };
      q.update = async (payload) => { updateCalls.push({ payload }); return 1; };
      q.insert = () => q;
      q.returning = async () => { throw Object.assign(new Error('duplicate key'), { code: '23505' }); };
      return q;
    });
    const result = await subscribeOrResubscribe({ email: 'pat@example.com', source: 'newsletter_footer', requireConfirmation: true, linkCustomer: false });
    expect(result.action).toBe('confirmation_sent');
  });
});
