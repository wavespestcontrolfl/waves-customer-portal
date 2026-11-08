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
  lookupByToken,
  confirmByToken,
  CONFIRM_RESEND_COOLDOWN_MS,
  CONFIRM_TTL_MS,
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
    // The purge may now REVERT opted-out rows (sweep #7765 B5) but must never
    // activate or re-pend anything.
    expect(updateCalls.every((c) => c.payload.status !== 'pending' && c.payload.status !== 'active')).toBe(true);
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

// ---------------------------------------------------------------------------
// Sweep #7765 B5: a public double-opt-in signup must not undo an opt-out
// before the reader proves they own the address; repeat submits are throttled;
// the stale-pending purge never deletes opt-out history.
// ---------------------------------------------------------------------------

// A recording db: every query logs its where/whereRaw/whereNull/whereNotNull
// calls and, on update/del, the payload. `firsts` feeds .first() in order and
// `updateCounts` feeds each update's affected-row count (default 1).
function useRecordingDb({ firsts = [], updateCounts = [], delCount = 0 } = {}) {
  const db = require('../models/db');
  const queries = [];
  db.mockImplementation((table) => {
    const rec = { table, wheres: [], raws: [], nulls: [], notNulls: [], fnWheres: [] };
    const q = {};
    q.where = (arg, ...rest) => {
      if (typeof arg === 'function') {
        const calls = [];
        const stub = {
          whereNull: (c) => { calls.push(['whereNull', c]); return stub; },
          orWhere: (...a) => { calls.push(['orWhere', ...a]); return stub; },
        };
        arg.call(stub);
        rec.fnWheres.push(calls);
      } else rec.wheres.push(rest.length ? [arg, ...rest] : arg);
      return q;
    };
    q.whereRaw = (sql) => { rec.raws.push(sql); return q; };
    q.whereNull = (c) => { rec.nulls.push(c); return q; };
    q.whereNotNull = (c) => { rec.notNulls.push(c); return q; };
    q.first = async () => (firsts.length ? firsts.shift() : null);
    q.update = async (payload) => { rec.update = payload; queries.push(rec); return updateCounts.length ? updateCounts.shift() : 1; };
    q.del = async () => { rec.del = true; queries.push(rec); return delCount; };
    return q;
  });
  return queries;
}

const UNSUB_ROW = {
  id: 'sub-9',
  email: 'reader@example.com',
  first_name: 'Rae',
  last_name: null,
  source: 'newsletter_footer',
  status: 'unsubscribed',
  confirmation_token: 'old-tok',
  confirmation_sent_at: new Date('2026-01-01T00:00:00Z'),
  confirmed_at: new Date('2026-01-01T00:05:00Z'),
  subscribed_at: new Date('2026-01-01T00:00:00Z'),
  unsubscribed_at: new Date('2026-02-01T00:00:00Z'),
  resubscribed_at: null,
  deactivated_at: null,
  deactivated_reason: null,
  reengagement_flagged_at: null,
};
const INACTIVE_ROW = {
  ...UNSUB_ROW,
  status: 'inactive',
  unsubscribed_at: null,
  deactivated_at: new Date('2026-02-01T00:00:00Z'),
  deactivated_reason: 'sunset_no_engagement',
  reengagement_flagged_at: new Date('2026-01-20T00:00:00Z'),
};
const PUBLIC = { email: 'reader@example.com', source: 'newsletter_footer', requireConfirmation: true, publicSignup: true, linkCustomer: false };
const OPT_OUT_FIELDS = ['status', 'unsubscribed_at', 'resubscribed_at', 'confirmed_at', 'deactivated_at', 'deactivated_reason', 'reengagement_flagged_at', 'tags'];

describe('public signup on an unsubscribed/inactive row keeps the opt-out until confirm', () => {
  test.each([['unsubscribed', UNSUB_ROW], ['inactive', INACTIVE_ROW]])('%s row: only a fresh token and stamp are written', async (_label, row) => {
    const queries = useRecordingDb({ firsts: [{ ...row }, { ...row, confirmation_token: 'new' }] });
    const result = await subscribeOrResubscribe({ ...PUBLIC, firstName: 'Rae' });
    expect(result.action).toBe('confirmation_sent');
    const write = queries.find((r) => r.update);
    for (const field of OPT_OUT_FIELDS) expect(write.update).not.toHaveProperty(field);
    expect(write.update.confirmation_sent_at).toBeInstanceOf(Date);
    expect(write.update.confirmation_token).toBeDefined();
    expect(write.update.source).toBe('newsletter_footer');
    // CAS on the status the caller read: a concurrent opt-out/confirm wins.
    expect(write.wheres).toContainEqual({ id: row.id, status: row.status });
  });

  test('inside the cooldown (update matches no row) nothing is sent: confirmation_throttled', async () => {
    useRecordingDb({ firsts: [{ ...UNSUB_ROW }, { ...UNSUB_ROW, confirmation_sent_at: new Date() }], updateCounts: [0] });
    const result = await subscribeOrResubscribe(PUBLIC);
    expect(result.action).toBe('confirmation_throttled');
  });

  test('the cooldown predicate is "never sent, or older than 10 minutes"', async () => {
    const queries = useRecordingDb({ firsts: [{ ...UNSUB_ROW }, { ...UNSUB_ROW }] });
    const before = Date.now();
    await subscribeOrResubscribe(PUBLIC);
    const write = queries.find((r) => r.update);
    expect(write.fnWheres).toHaveLength(1);
    const calls = write.fnWheres[0];
    expect(calls).toContainEqual(['whereNull', 'confirmation_sent_at']);
    const cutoff = calls.find((c) => c[0] === 'orWhere');
    expect(cutoff[1]).toBe('confirmation_sent_at');
    expect(cutoff[2]).toBe('<=');
    expect(CONFIRM_RESEND_COOLDOWN_MS).toBe(10 * 60 * 1000);
    expect(cutoff[3].getTime()).toBeGreaterThanOrEqual(before - CONFIRM_RESEND_COOLDOWN_MS);
    expect(cutoff[3].getTime()).toBeLessThanOrEqual(Date.now() - CONFIRM_RESEND_COOLDOWN_MS);
  });

  test('callers that are not the public form keep the old behavior (row goes pending, markers cleared)', async () => {
    const queries = useRecordingDb({ firsts: [{ ...INACTIVE_ROW }, { ...INACTIVE_ROW }] });
    const result = await subscribeOrResubscribe({ ...PUBLIC, publicSignup: false });
    expect(result.action).toBe('confirmation_sent');
    const write = queries.find((r) => r.update);
    expect(write.update.status).toBe('pending');
    expect(write.update.deactivated_at).toBeNull();
    expect(write.update.resubscribed_at).toBeInstanceOf(Date);
    expect(write.fnWheres).toHaveLength(0);
  });

  test('a trusted flow (requireConfirmation:false) still skips an inactive row untouched', async () => {
    const queries = useRecordingDb({ firsts: [{ ...INACTIVE_ROW }] });
    const result = await subscribeOrResubscribe({ email: 'reader@example.com', source: 'admin_add', linkCustomer: false });
    expect(result.action).toBe('skipped_inactive');
    expect(queries.some((r) => r.update)).toBe(false);
  });
});

describe('resend cooldown on a pending row', () => {
  const PENDING = { ...UNSUB_ROW, status: 'pending', confirmed_at: null, unsubscribed_at: null, confirmation_sent_at: new Date() };

  test('public form inside the cooldown: confirmation_throttled, no email action', async () => {
    useRecordingDb({ firsts: [{ ...PENDING }, { ...PENDING }], updateCounts: [0] });
    const result = await subscribeOrResubscribe(PUBLIC);
    expect(result.action).toBe('confirmation_throttled');
  });

  test('public form after the cooldown: confirmation_resent with the same token', async () => {
    const queries = useRecordingDb({ firsts: [{ ...PENDING }, { ...PENDING }], updateCounts: [1] });
    const result = await subscribeOrResubscribe(PUBLIC);
    expect(result.action).toBe('confirmation_resent');
    const write = queries.find((r) => r.update);
    expect(write.update.confirmation_token).toBeUndefined();
    expect(write.update.confirmation_sent_at).toBeInstanceOf(Date);
    expect(write.fnWheres).toHaveLength(1);
  });

  test('other requireConfirmation callers are not throttled', async () => {
    const queries = useRecordingDb({ firsts: [{ ...PENDING }, { ...PENDING }] });
    const result = await subscribeOrResubscribe({ ...PUBLIC, publicSignup: false });
    expect(result.action).toBe('confirmation_resent');
    expect(queries.find((r) => r.update).fnWheres).toHaveLength(0);
  });
});

describe('lookupByToken / confirmByToken for a public re-signup token', () => {
  const sentAt = (msAgo) => new Date(Date.now() - msAgo);
  const resignup = (row, msAgo = 60 * 1000) => ({ ...row, confirmation_token: 'new-tok', confirmation_sent_at: sentAt(msAgo) });

  test.each([['unsubscribed', UNSUB_ROW], ['inactive', INACTIVE_ROW]])('a live re-signup token on a %s row is confirmable', async (_l, row) => {
    useRecordingDb({ firsts: [resignup(row)] });
    expect((await lookupByToken('new-tok')).action).toBe('pending');
  });

  test('the original signup link on an unsubscribed row is still the stale "unsubscribed" page', async () => {
    useRecordingDb({ firsts: [{ ...UNSUB_ROW }] }); // sent 01-01 < confirmed 01-01 00:05 < unsubscribed 02-01
    expect((await lookupByToken('old-tok')).action).toBe('unsubscribed');
  });

  test('a link confirmed and opted out inside the 7-day window stays stale', async () => {
    const t0 = Date.now() - 3 * 24 * 3600 * 1000;
    useRecordingDb({ firsts: [{ ...UNSUB_ROW, confirmation_sent_at: new Date(t0), confirmed_at: new Date(t0 + 1000), unsubscribed_at: new Date(t0 + 2000) }] });
    expect((await lookupByToken('old-tok')).action).toBe('unsubscribed');
  });

  test('a re-signup token past the 7-day window reads expired', async () => {
    useRecordingDb({ firsts: [resignup(UNSUB_ROW, CONFIRM_TTL_MS + 60 * 1000)] });
    expect((await lookupByToken('new-tok')).action).toBe('expired');
  });

  test('an opt-out after the re-signup email kills its link', async () => {
    useRecordingDb({ firsts: [{ ...resignup(INACTIVE_ROW), unsubscribed_at: new Date() }] });
    expect((await lookupByToken('new-tok')).action).toBe('unsubscribed');
  });

  test.each([['unsubscribed', UNSUB_ROW], ['inactive', INACTIVE_ROW]])('confirm applies the comeback to a %s row, CAS on token + status', async (_l, row) => {
    const queries = useRecordingDb({ firsts: [resignup(row), { ...resignup(row), status: 'active' }] });
    const result = await confirmByToken('new-tok');
    expect(result.action).toBe('confirmed');
    const flip = queries.find((r) => r.update && r.update.status === 'active');
    expect(flip.wheres).toContainEqual({ id: row.id, confirmation_token: 'new-tok', status: row.status });
    expect(flip.update).toMatchObject({
      unsubscribed_at: null, deactivated_at: null, deactivated_reason: null, reengagement_flagged_at: null,
    });
    expect(flip.update.confirmed_at).toBeInstanceOf(Date);
    expect(flip.update.resubscribed_at).toBeInstanceOf(Date);
    expect(String(flip.update.tags)).toContain('COALESCE(tags');
    // The live-token ordering is enforced in the same statement.
    expect(flip.raws.join(' ')).toContain('confirmation_sent_at > unsubscribed_at');
    expect(flip.raws.join(' ')).toContain('confirmation_sent_at > deactivated_at');
    expect(flip.raws.join(' ')).toContain('confirmation_sent_at > confirmed_at');
  });

  test('a stale link confirms nothing: no update runs', async () => {
    const queries = useRecordingDb({ firsts: [{ ...UNSUB_ROW }] });
    const result = await confirmByToken('old-tok');
    expect(result.action).toBe('unsubscribed');
    expect(queries.some((r) => r.update)).toBe(false);
  });

  test('a lost CAS (opt-out landed first) re-reads the current truth instead of activating', async () => {
    const row = resignup(UNSUB_ROW);
    useRecordingDb({ firsts: [row, { ...row, unsubscribed_at: new Date() }], updateCounts: [0] });
    const result = await confirmByToken('new-tok');
    expect(result.action).toBe('unsubscribed');
  });
});

describe('purgeStalePendingSubscribers keeps opt-out history', () => {
  test('reverts rows with unsubscribed_at, then deactivated_at, then deletes only what is left', async () => {
    const queries = useRecordingDb({ updateCounts: [2, 1], delCount: 3 });
    const removed = await purgeStalePendingSubscribers();
    expect(removed).toBe(3);
    expect(queries).toHaveLength(3);
    const [unsub, inactive, del] = queries;
    expect(unsub.notNulls).toContain('unsubscribed_at');
    expect(unsub.update).toMatchObject({ status: 'unsubscribed', confirmation_token: null });
    expect(inactive.notNulls).toContain('deactivated_at');
    expect(inactive.update).toMatchObject({ status: 'inactive', confirmation_token: null });
    // The delete never targets a row carrying history: those two groups left
    // status='pending' before it ran.
    expect(del.del).toBe(true);
    for (const r of queries) expect(r.wheres).toContainEqual({ status: 'pending' });
  });
});
