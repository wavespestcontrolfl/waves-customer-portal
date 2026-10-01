/**
 * Codex #4331 P2 — "Reserve manual asks while still holding the review lock"
 * (admin-communications.js:1754). The fix moves the inline-claimed-link
 * seam's sms_log reservation INSIDE the review-send:<customer> lock, before
 * it releases, so a concurrent sender racing the gap between that lock and
 * dispatchReviewAsk's own re-acquisition sees the reservation instead of
 * nothing. That means the reservation now exists BEFORE
 * dispatchReviewAsk's own 72h spacing check (lastManualAskAt) runs — which
 * would otherwise treat the caller's own just-created reservation as PRIOR
 * evidence and immediately self-block every claimed-link send. This file
 * proves the exclusion parameter that prevents that self-block, directly
 * against review-ask-history.js's real (unmocked) implementation.
 */

jest.mock('../models/db', () => jest.fn());
const db = require('../models/db');
const { lastManualAskAt, lastUnresolvedAskAt } = require('../services/review-ask-history');

function makeSmsLogQuery(rows) {
  let filtered = rows.slice();
  const q = {
    where(a, b, c) {
      if (a && typeof a === 'object') {
        filtered = filtered.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        return q;
      }
      const [field, op, val] = c === undefined ? [a, '=', b] : [a, b, c];
      filtered = filtered.filter((r) => {
        if (op === '>=') return new Date(r[field]).getTime() >= new Date(val).getTime();
        if (op === '>') return new Date(r[field]).getTime() > new Date(val).getTime();
        return r[field] === val;
      });
      return q;
    },
    whereNotIn(field, list) { filtered = filtered.filter((r) => !list.includes(r[field])); return q; },
    // Only the lastManualAskAt fetch-floor predicate is exercised here:
    // '(created_at >= ? OR updated_at >= ?)' with both bindings the same
    // fetchFloor value (review-ask-history.js).
    whereRaw(sql, bindings) {
      if (/created_at >= \? OR updated_at >= \?/.test(sql)) {
        const [floor] = bindings;
        filtered = filtered.filter((r) => new Date(r.created_at).getTime() >= new Date(floor).getTime()
          || (r.updated_at && new Date(r.updated_at).getTime() >= new Date(floor).getTime()));
        return q;
      }
      throw new Error(`fake whereRaw: unsupported SQL ${sql}`);
    },
    orderBy() { return q; },
    select() { return Promise.resolve(filtered); },
  };
  return q;
}

describe('lastManualAskAt excludeReservationId — a caller does not self-block on its own reservation', () => {
  const now = new Date('2040-01-10T16:00:00Z');
  beforeEach(() => { jest.useFakeTimers().setSystemTime(now); });
  afterEach(() => { jest.useRealTimers(); });

  test('an unresolved reservation counts as spacing evidence by default', async () => {
    db.mockImplementation((table) => (table === 'sms_log'
      ? makeSmsLogQuery([{
        id: 'resv-1', customer_id: 'cust-A', direction: 'outbound', status: 'sending',
        metadata: { review_ask_reservation: true }, created_at: new Date(now.getTime() - 60000),
      }])
      : { where: () => ({ whereNotNull: () => ({ select: async () => [] }) }) }));

    const at = await lastManualAskAt('cust-A', { since: new Date(now.getTime() - 3600000) });
    expect(at).toEqual(new Date(now.getTime() - 60000));
  });

  test('excludeReservationId drops the CALLER\'S OWN just-created reservation from that evidence', async () => {
    db.mockImplementation((table) => (table === 'sms_log'
      ? makeSmsLogQuery([{
        id: 'resv-1', customer_id: 'cust-A', direction: 'outbound', status: 'sending',
        metadata: { review_ask_reservation: true }, created_at: new Date(now.getTime() - 60000),
      }])
      : { where: () => ({ whereNotNull: () => ({ select: async () => [] }) }) }));

    const at = await lastManualAskAt('cust-A', {
      since: new Date(now.getTime() - 3600000), excludeReservationId: 'resv-1',
    });
    expect(at).toBeNull();
  });

  test('excludeReservationId leaves a DIFFERENT (real, prior) reservation blocking as usual', async () => {
    db.mockImplementation((table) => (table === 'sms_log'
      ? makeSmsLogQuery([
        {
          id: 'resv-own', customer_id: 'cust-A', direction: 'outbound', status: 'sending',
          metadata: { review_ask_reservation: true }, created_at: new Date(now.getTime() - 30000),
        },
        {
          id: 'resv-other', customer_id: 'cust-A', direction: 'outbound', status: 'sending',
          metadata: { review_ask_reservation: true }, created_at: new Date(now.getTime() - 60000),
        },
      ])
      : { where: () => ({ whereNotNull: () => ({ select: async () => [] }) }) }));

    const at = await lastManualAskAt('cust-A', {
      since: new Date(now.getTime() - 3600000), excludeReservationId: 'resv-own',
    });
    expect(at).toEqual(new Date(now.getTime() - 60000));
  });
});

describe('a composer-sent staff review ask stays spacing evidence for the automatic sequence', () => {
  const now = new Date('2040-01-10T16:00:00Z');
  beforeEach(() => { jest.useFakeTimers().setSystemTime(now); });
  afterEach(() => { jest.useRealTimers(); });

  test('lastManualAskAt sees a sent manual sms_log row carrying a review link', async () => {
    const sentAt = new Date(now.getTime() - 60000);
    db.mockImplementation((table) => (table === 'sms_log'
      ? makeSmsLogQuery([{
        id: 'composer-1', customer_id: 'cust-A', direction: 'outbound', status: 'sent', message_type: 'manual',
        message_body: 'Here is the link: https://g.page/r/example/review', metadata: {}, created_at: sentAt,
      }])
      : { where: () => ({ whereNotNull: () => ({ select: async () => [] }) }) }));
    expect(await lastManualAskAt('cust-A', { since: new Date(now.getTime() - 72 * 3600000) })).toEqual(sentAt);
  });
});

describe('lastUnresolvedAskAt — only in-flight or uncertain sends, never confirmed asks', () => {
  const now = new Date('2040-01-10T16:00:00Z');
  const since = new Date(now.getTime() - 72 * 3600000);
  const emptyRequests = () => { const q = { joinRaw: () => q, where: () => q, whereRaw: () => q, select: () => q, then: (resolve, reject) => Promise.resolve([]).then(resolve, reject) }; return q; };
  const wire = rows => db.mockImplementation((table) => (table === 'sms_log' ? makeSmsLogQuery(rows) : emptyRequests()));
  beforeEach(() => { jest.useFakeTimers().setSystemTime(now); });
  afterEach(() => { jest.useRealTimers(); });

  test('an unresolved (sending) or recovered-failed reservation counts', async () => {
    const at = new Date(now.getTime() - 60000);
    wire([{ id: 'r1', customer_id: 'cust-A', direction: 'outbound', status: 'sending', metadata: { review_ask_reservation: true }, created_at: at }]);
    expect(await lastUnresolvedAskAt('cust-A', { since })).toEqual(at);
    wire([{ id: 'r2', customer_id: 'cust-A', direction: 'outbound', status: 'failed', metadata: { review_ask_reservation: true }, created_at: at }]);
    expect(await lastUnresolvedAskAt('cust-A', { since })).toEqual(at);
  });

  test('a confirmed reservation or a confirmed manual ask does not count', async () => {
    const at = new Date(now.getTime() - 60000);
    wire([
      { id: 'r1', customer_id: 'cust-A', direction: 'outbound', status: 'sent', metadata: { review_ask_reservation: true }, created_at: at },
      { id: 'm1', customer_id: 'cust-A', direction: 'outbound', status: 'delivered', message_body: 'Review us: https://g.page/r/example/review', metadata: {}, created_at: at },
    ]);
    expect(await lastUnresolvedAskAt('cust-A', { since })).toBeNull();
  });

  test('the caller\'s own reservation and another customer\'s reservation do not count', async () => {
    const at = new Date(now.getTime() - 60000);
    wire([
      { id: 'own', customer_id: 'cust-A', direction: 'outbound', status: 'sending', metadata: { review_ask_reservation: true }, created_at: at },
      { id: 'other', customer_id: 'cust-B', direction: 'outbound', status: 'sending', metadata: { review_ask_reservation: true }, created_at: at },
    ]);
    expect(await lastUnresolvedAskAt('cust-A', { since, excludeReservationId: 'own' })).toBeNull();
  });

  test('an unresolved reservation older than the window does not count', async () => {
    wire([{ id: 'old', customer_id: 'cust-A', direction: 'outbound', status: 'sending', metadata: { review_ask_reservation: true }, created_at: new Date(now.getTime() - 80 * 3600000) }]);
    expect(await lastUnresolvedAskAt('cust-A', { since })).toBeNull();
  });
});

describe('lastUnresolvedAskAt — review_requests follow-up reservations (Codex r2 P1)', () => {
  const now = new Date('2040-01-10T16:00:00Z');
  const since = new Date(now.getTime() - 72 * 3600000);
  const minutesAgo = m => new Date(now.getTime() - m * 60000);
  let sql;
  let wheres;
  // review_requests chain: records the SQL/where calls deliveredAskRows makes
  // and resolves to the configured rows (the SQL itself is not evaluated).
  const wire = ({ requestRows = [], smsRows = [] } = {}) => {
    sql = [];
    wheres = [];
    db.mockImplementation((table) => {
      if (table === 'sms_log') return makeSmsLogQuery(smsRows);
      const q = {
        joinRaw() { return q; },
        where(...args) { wheres.push(args); return q; },
        whereRaw(text) { sql.push(text); return q; },
        select() { return q; },
        then(resolve, reject) { return Promise.resolve(requestRows).then(resolve, reject); },
      };
      return q;
    });
  };
  beforeEach(() => { jest.useFakeTimers().setSystemTime(now); });
  afterEach(() => { jest.useRealTimers(); });

  test('an uncertain follow-up (only followup_reserved_at set) counts, via the same columns the spacing reader uses', async () => {
    wire({ requestRows: [{ id: 'rr-1', sms_sent_at: minutesAgo(3000), followup_reserved_at: minutesAgo(10) }] });
    expect(await lastUnresolvedAskAt('cust-A', { since })).toEqual(minutesAgo(10));
    expect(sql.some(text => /followup_reserved_at IS NOT NULL/.test(text))).toBe(true);
  });

  test('a confirmed delivered ask (sent / follow-up delivered, reservation cleared) does not count', async () => {
    wire({ requestRows: [
      { id: 'rr-1', sms_sent_at: minutesAgo(10), followup_reserved_at: null },
      { id: 'rr-2', sent_at: minutesAgo(20), followup_delivered_at: minutesAgo(5), followup_recorded_at: minutesAgo(5), followup_reserved_at: null },
    ] });
    expect(await lastUnresolvedAskAt('cust-A', { since })).toBeNull();
  });

  test('the caller\'s own claimed request is excluded in the query', async () => {
    wire({ requestRows: [] });
    await lastUnresolvedAskAt('cust-A', { since, excludeRequestId: 'rr-own' });
    expect(wheres).toContainEqual(['review_requests.id', '!=', 'rr-own']);
  });

  test('a reservation older than the window does not count', async () => {
    wire({ requestRows: [{ id: 'rr-1', followup_reserved_at: new Date(now.getTime() - 80 * 3600000) }] });
    expect(await lastUnresolvedAskAt('cust-A', { since })).toBeNull();
  });

  test('returns the newer of the sms_log and review_requests evidence', async () => {
    const smsAt = minutesAgo(30);
    wire({
      requestRows: [{ id: 'rr-1', followup_reserved_at: minutesAgo(5) }],
      smsRows: [{ id: 'resv', customer_id: 'cust-A', direction: 'outbound', status: 'sending', metadata: { review_ask_reservation: true }, created_at: smsAt }],
    });
    expect(await lastUnresolvedAskAt('cust-A', { since })).toEqual(minutesAgo(5));
    wire({
      requestRows: [{ id: 'rr-1', followup_reserved_at: minutesAgo(50) }],
      smsRows: [{ id: 'resv', customer_id: 'cust-A', direction: 'outbound', status: 'sending', metadata: { review_ask_reservation: true }, created_at: smsAt }],
    });
    expect(await lastUnresolvedAskAt('cust-A', { since })).toEqual(smsAt);
  });

  test('a review_requests read failure throws so the dispatch fails closed', async () => {
    db.mockImplementation((table) => {
      if (table === 'sms_log') return makeSmsLogQuery([]);
      const q = { joinRaw() { return q; }, where() { return q; }, whereRaw() { return q; }, select() { return q; },
        then(_resolve, reject) { return Promise.reject(new Error('db down')).then(undefined, reject); } };
      return q;
    });
    await expect(lastUnresolvedAskAt('cust-A', { since })).rejects.toThrow('db down');
  });
});
