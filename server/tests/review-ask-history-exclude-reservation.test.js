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
const { lastManualAskAt } = require('../services/review-ask-history');

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
