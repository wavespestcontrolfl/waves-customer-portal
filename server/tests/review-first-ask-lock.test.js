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
