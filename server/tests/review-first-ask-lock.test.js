'use strict';

// First review ask (GATE_REVIEW_FIRST_ASK_LOCK): "never asked" and the saved-choice rule, with a fake
// database. The real transaction is covered by complete-scheduled-service-first-review-ask-postgres.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ReviewService = require('../services/review-request');
const { reviewFirstAskLockLive } = require('../config/feature-gates');

// customers row + review_requests rows; `fail` makes every read throw.
function fakeDb({ customer, requests = [], fail = false }) {
  return (table) => {
    const q = {};
    q.where = (...args) => {
      if (typeof args[0] === 'function') {
        // The "texted or emailed" filter: keep rows with sms_sent_at or sent_at.
        q.rows = (q.rows || requests).filter((r) => r.sms_sent_at || r.sent_at);
      } else if (table === 'review_requests') {
        q.rows = requests;
      }
      return q;
    };
    q.first = async () => {
      if (fail) throw new Error('read failed');
      if (table === 'customers') return customer;
      return (q.rows || requests)[0];
    };
    return q;
  };
}

describe('customerNeverAskedForReview', () => {
  const never = (opts) => ReviewService.customerNeverAskedForReview('cust-1', fakeDb(opts));

  test('no ask row and not marked reviewed: never asked', async () => {
    expect(await never({ customer: { id: 'cust-1', has_left_google_review: false } })).toBe(true);
  });

  test('a row that was only created (not texted or emailed) is not an ask', async () => {
    expect(await never({ customer: { id: 'cust-1' }, requests: [{ id: 'r1', sms_sent_at: null, sent_at: null }] })).toBe(true);
  });

  test('a texted row or an emailed row is an ask', async () => {
    expect(await never({ customer: { id: 'cust-1' }, requests: [{ id: 'r1', sms_sent_at: new Date() }] })).toBe(false);
    expect(await never({ customer: { id: 'cust-1' }, requests: [{ id: 'r2', sent_at: new Date() }] })).toBe(false);
  });

  test('marked as already reviewed, a missing customer, no id and a read failure are all not never-asked', async () => {
    expect(await never({ customer: { id: 'cust-1', has_left_google_review: true } })).toBe(false);
    expect(await never({ customer: undefined })).toBe(false);
    expect(await ReviewService.customerNeverAskedForReview(null, fakeDb({ customer: { id: 'x' } }))).toBe(false);
    expect(await never({ customer: { id: 'cust-1' }, fail: true })).toBe(false);
  });
});

describe('firstAskLockChoice', () => {
  const gateWas = process.env.GATE_REVIEW_FIRST_ASK_LOCK;
  afterEach(() => { if (gateWas === undefined) delete process.env.GATE_REVIEW_FIRST_ASK_LOCK; else process.env.GATE_REVIEW_FIRST_ASK_LOCK = gateWas; });
  const neverAsked = fakeDb({ customer: { id: 'cust-1' } });
  const asked = fakeDb({ customer: { id: 'cust-1' }, requests: [{ id: 'r1', sms_sent_at: new Date() }] });
  const choose = (db, requestReview, optOutReason) => ReviewService.firstAskLockChoice({ customerId: 'cust-1', requestReview, optOutReason }, db);

  test('the gate is strict: only the exact string true turns it on', () => {
    for (const value of [undefined, '', 'TRUE', '1', 'yes', 'false']) {
      if (value === undefined) delete process.env.GATE_REVIEW_FIRST_ASK_LOCK; else process.env.GATE_REVIEW_FIRST_ASK_LOCK = value;
      expect(reviewFirstAskLockLive()).toBe(false);
    }
    process.env.GATE_REVIEW_FIRST_ASK_LOCK = 'true';
    expect(reviewFirstAskLockLive()).toBe(true);
  });

  test('gate off: the lock never applies', async () => {
    delete process.env.GATE_REVIEW_FIRST_ASK_LOCK;
    expect(await choose(neverAsked, false)).toBeNull();
  });

  test('gate on, never asked: off without the reason stays on; off with the complaint reason is off', async () => {
    process.env.GATE_REVIEW_FIRST_ASK_LOCK = 'true';
    expect(await choose(neverAsked, false)).toEqual({ requestReview: true, forcedOn: true, optOutReason: null });
    expect(await choose(neverAsked, false, 'something_else')).toEqual({ requestReview: true, forcedOn: true, optOutReason: null });
    expect(await choose(neverAsked, false, 'complaint_on_site')).toEqual({ requestReview: false, forcedOn: false, optOutReason: 'complaint_on_site' });
    expect(await choose(neverAsked, true)).toEqual({ requestReview: true, forcedOn: false, optOutReason: null });
  });

  test('gate on, asked before: the lock does not apply', async () => {
    process.env.GATE_REVIEW_FIRST_ASK_LOCK = 'true';
    expect(await choose(asked, false)).toBeNull();
  });
});

// GATE_REVIEW_ALREADY_REVIEWED (owner 2026-11-04): the second off reason, "Already left a review".
describe('the second off reason (GATE_REVIEW_ALREADY_REVIEWED)', () => {
  const lockWas = process.env.GATE_REVIEW_FIRST_ASK_LOCK;
  const gateWas = process.env.GATE_REVIEW_ALREADY_REVIEWED;
  afterEach(() => {
    if (lockWas === undefined) delete process.env.GATE_REVIEW_FIRST_ASK_LOCK; else process.env.GATE_REVIEW_FIRST_ASK_LOCK = lockWas;
    if (gateWas === undefined) delete process.env.GATE_REVIEW_ALREADY_REVIEWED; else process.env.GATE_REVIEW_ALREADY_REVIEWED = gateWas;
  });
  const { reviewAlreadyReviewedLive } = require('../config/feature-gates');
  const neverAsked = fakeDb({ customer: { id: 'cust-1' } });
  const choose = (optOutReason) => ReviewService.firstAskLockChoice({ customerId: 'cust-1', requestReview: false, optOutReason }, neverAsked);

  test('the gate is strict: only the exact string true turns it on', () => {
    for (const value of [undefined, '', 'TRUE', '1', 'yes', 'false']) {
      if (value === undefined) delete process.env.GATE_REVIEW_ALREADY_REVIEWED; else process.env.GATE_REVIEW_ALREADY_REVIEWED = value;
      expect(reviewAlreadyReviewedLive()).toBe(false);
      expect(ReviewService.firstAskOptOutReasons()).toEqual(['complaint_on_site']);
    }
    process.env.GATE_REVIEW_ALREADY_REVIEWED = 'true';
    expect(reviewAlreadyReviewedLive()).toBe(true);
    expect(ReviewService.firstAskOptOutReasons()).toEqual(['complaint_on_site', 'already_left_review']);
  });

  test('gate off: "Already left a review" is not a reason, so the first ask stays on', async () => {
    process.env.GATE_REVIEW_FIRST_ASK_LOCK = 'true';
    delete process.env.GATE_REVIEW_ALREADY_REVIEWED;
    expect(await choose('already_left_review')).toEqual({ requestReview: true, forcedOn: true, optOutReason: null });
  });

  test('gate on: "Already left a review" turns the first ask off and is saved; the complaint still works', async () => {
    process.env.GATE_REVIEW_FIRST_ASK_LOCK = 'true';
    process.env.GATE_REVIEW_ALREADY_REVIEWED = 'true';
    expect(await choose('already_left_review')).toEqual({ requestReview: false, forcedOn: false, optOutReason: 'already_left_review' });
    expect(await choose('complaint_on_site')).toEqual({ requestReview: false, forcedOn: false, optOutReason: 'complaint_on_site' });
    expect(await choose('customer_busy')).toEqual({ requestReview: true, forcedOn: true, optOutReason: null });
    expect(ReviewService.ALREADY_LEFT_REVIEW_REASON).toBe('already_left_review');
  });

  test('the first-ask lock off: the new gate alone changes nothing', async () => {
    delete process.env.GATE_REVIEW_FIRST_ASK_LOCK;
    process.env.GATE_REVIEW_ALREADY_REVIEWED = 'true';
    expect(await choose('already_left_review')).toBeNull();
  });
});

describe('alreadyReviewedForVisit', () => {
  // scheduled_services joined to customers, then the newest linked live google_reviews row.
  function reviewedDb({ customer, review, fail = false }) {
    const seen = {};
    const conn = (table) => {
      const q = {};
      for (const name of ['join', 'where', 'whereNull', 'whereNotNull']) q[name] = (...args) => { (seen[table] = seen[table] || []).push([name, ...args]); return q; };
      q.orderBy = (...args) => { (seen[table] = seen[table] || []).push(['orderBy', ...args]); return q; };
      q.first = async () => {
        if (fail) throw new Error('read failed');
        return table === 'google_reviews' ? review : customer;
      };
      return q;
    };
    return { conn, seen };
  }
  const read = (opts) => ReviewService.alreadyReviewedForVisit('svc-1', reviewedDb(opts).conn);

  test('marked, with a linked live review: the Eastern date of the newest review', async () => {
    const fake = reviewedDb({ customer: { id: 'cust-1', has_left_google_review: true, review_marked_at: new Date('2026-03-01T15:00:00Z') },
      review: { review_created_at: new Date('2025-01-01T20:06:00Z') } });
    expect(await ReviewService.alreadyReviewedForVisit('svc-1', fake.conn)).toEqual({ reviewedOn: '2025-01-01' });
    expect(fake.seen.google_reviews).toEqual(expect.arrayContaining([['where', { customer_id: 'cust-1' }], ['whereNull', 'missing_since'], ['orderBy', 'review_created_at', 'desc']]));
  });

  test('the date is the Eastern calendar day, not the UTC one', async () => {
    expect(await read({ customer: { id: 'cust-1', has_left_google_review: true }, review: { review_created_at: new Date('2025-01-01T03:00:00Z') } }))
      .toEqual({ reviewedOn: '2024-12-31' });
  });

  test('marked, no linked review: the day the mark was set; neither known: no date', async () => {
    expect(await read({ customer: { id: 'cust-1', has_left_google_review: true, review_marked_at: new Date('2026-10-14T16:00:00Z') }, review: undefined }))
      .toEqual({ reviewedOn: '2026-10-14' });
    expect(await read({ customer: { id: 'cust-1', has_left_google_review: true, review_marked_at: null }, review: undefined }))
      .toEqual({ reviewedOn: null });
  });

  test('not marked, an unknown visit, no id and a read failure are all null (today\'s box)', async () => {
    expect(await read({ customer: { id: 'cust-1', has_left_google_review: false }, review: { review_created_at: new Date() } })).toBeNull();
    expect(await read({ customer: { id: 'cust-1', has_left_google_review: null } })).toBeNull();
    expect(await read({ customer: undefined })).toBeNull();
    expect(await ReviewService.alreadyReviewedForVisit(null, reviewedDb({ customer: { id: 'x', has_left_google_review: true } }).conn)).toBeNull();
    expect(await read({ customer: { id: 'cust-1', has_left_google_review: true }, fail: true })).toBeNull();
  });
});

describe('firstAskLockVisit', () => {
  // scheduled_services joined to services: one row, or a read that throws.
  function visitDb(row, { fail = false } = {}) {
    return () => {
      const q = {};
      q.leftJoin = () => q;
      q.where = () => q;
      q.first = async () => { if (fail) throw new Error('read failed'); return row; };
      return q;
    };
  }
  const visit = (row, opts) => ReviewService.firstAskLockVisit('svc-1', visitDb(row, opts));

  test('a regular visit is returned with its customer', async () => {
    expect(await visit({ customer_id: 'cust-1', is_callback: false, service_type: 'Pest Control', service_key: 'pest_quarterly' }))
      .toMatchObject({ customer_id: 'cust-1' });
  });

  test('a re-service is never a first ask, with or without the callback flag', async () => {
    expect(await visit({ customer_id: 'cust-1', is_callback: true, service_type: 'Pest Control', service_key: null })).toBeNull();
    // 5 of 49 re-service visits from June to October 2026 carried is_callback false.
    expect(await visit({ customer_id: 'cust-1', is_callback: false, service_type: 'Pest Control', service_key: 'pest_re_service' })).toBeNull();
    expect(await visit({ customer_id: 'cust-1', is_callback: false, service_type: 'Lawn Care Re-Service', service_key: null })).toBeNull();
  });

  test('no visit, no id and a read failure are null (today\'s behavior)', async () => {
    expect(await visit(undefined)).toBeNull();
    expect(await ReviewService.firstAskLockVisit(null, visitDb({ customer_id: 'cust-1' }))).toBeNull();
    expect(await visit({ customer_id: 'cust-1' }, { fail: true })).toBeNull();
  });
});

describe('inside a transaction (the visit-closeout packet records phase)', () => {
  // A transaction stand-in: table reads answer from `rows`, raw() records the savepoint statements.
  function fakeTrx({ rows = {}, fail = false } = {}) {
    const statements = [];
    const trx = (table) => {
      const q = {};
      q.leftJoin = () => q;
      q.where = () => q;
      q.first = async () => { if (fail) throw new Error('read failed'); return rows[table]; };
      return q;
    };
    trx.isTransaction = true;
    trx.raw = async (sql) => { statements.push(sql.split(' ').slice(0, 2).join(' ')); };
    return { trx, statements };
  }
  const globalDb = require('../models/db');
  beforeEach(() => globalDb.mockClear());

  test('the reads ride the caller\'s transaction inside a savepoint, never a pool connection', async () => {
    const { trx, statements } = fakeTrx({ rows: { customers: { id: 'cust-1' }, review_requests: undefined } });
    expect(await ReviewService.customerNeverAskedForReview('cust-1', trx)).toBe(true);
    const visit = fakeTrx({ rows: { 'scheduled_services as s': { customer_id: 'cust-1', is_callback: false, service_type: 'Pest Control', service_key: 'pest_quarterly' } } });
    expect(await ReviewService.firstAskLockVisit('svc-1', visit.trx)).toMatchObject({ customer_id: 'cust-1' });
    expect(globalDb).not.toHaveBeenCalled();
    expect(statements[0]).toMatch(/^SAVEPOINT fail_soft_/);
    expect(statements.slice(1)).toEqual(['RELEASE SAVEPOINT']);
    expect(visit.statements.slice(1)).toEqual(['RELEASE SAVEPOINT']);
  });

  test('a failed read rolls back only its savepoint and answers "no lock"', async () => {
    const never = fakeTrx({ fail: true });
    expect(await ReviewService.customerNeverAskedForReview('cust-1', never.trx)).toBe(false);
    expect(never.statements.slice(1)).toEqual(['ROLLBACK TO', 'RELEASE SAVEPOINT']);
    const visit = fakeTrx({ fail: true });
    expect(await ReviewService.firstAskLockVisit('svc-1', visit.trx)).toBeNull();
    expect(visit.statements.slice(1)).toEqual(['ROLLBACK TO', 'RELEASE SAVEPOINT']);
    expect(globalDb).not.toHaveBeenCalled();
  });
});
