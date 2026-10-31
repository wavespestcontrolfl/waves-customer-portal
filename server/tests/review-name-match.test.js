/**
 * services/review-name-match.js — the review matcher's pass (GATE_REVIEW_NAME_MATCH_V2) and the
 * Reviews "Not this customer" action. Pins: off reads nothing; shadow writes nothing; on writes only
 * the decisions that changed, each conditioned on the link state it was made for; a dismissed
 * customer is never named again for that review; a linked review is disputed when its customer's
 * first contact came after it, unless a person kept the link. All names are synthetic.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/review-link-candidates', () => ({ loadEvidenceCandidates: jest.fn() }));

const { runReviewNameMatch, dismissNameMatch } = require('../services/review-name-match');
const { loadEvidenceCandidates } = require('../services/review-link-candidates');

const REVIEW_AT = '2026-10-20T18:00:00.000Z';

function fakeConn(reviews) {
  const updates = [];
  const conn = jest.fn(() => {
    const q = {
      wheres: [],
      whereRaw() { return q; },
      whereNull(column) { q.wheres.push(['null', column]); return q; },
      whereNotNull(column) { q.wheres.push(['notNull', column]); return q; },
      where(arg) { q.wheres.push(['eq', arg]); return q; },
      select: async () => reviews,
      update: async (patch) => { updates.push({ wheres: q.wheres, patch }); return 1; },
    };
    return q;
  });
  conn.updates = updates;
  return conn;
}

const candidate = (customerId, first, last, extra = {}) => ({
  customerId,
  holder: { first, last },
  contacts: [],
  timeline: { memberSince: '2025-01-15' },
  activity: {},
  linkedProfiles: [],
  ...extra,
});

const review = (id, reviewerName, extra = {}) => ({
  id,
  location_id: 'parrish',
  reviewer_name: reviewerName,
  review_created_at: REVIEW_AT,
  customer_id: null,
  name_match_result: null,
  name_match_customer_id: null,
  name_match_reason: null,
  name_match_dismissed_customer_id: null,
  ...extra,
});

describe('runReviewNameMatch', () => {
  beforeEach(() => loadEvidenceCandidates.mockReset());

  test('off reads nothing', async () => {
    const conn = fakeConn([]);
    expect(await runReviewNameMatch({ conn, mode: 'off' })).toEqual({ mode: 'off', skipped: true });
    expect(conn).not.toHaveBeenCalled();
    expect(loadEvidenceCandidates).not.toHaveBeenCalled();
  });

  test('shadow scores every review and writes nothing', async () => {
    const conn = fakeConn([review('r1', 'Dana Fenwikc')]);
    loadEvidenceCandidates.mockResolvedValue([candidate('c1', 'Dana', 'Fenwick')]);
    const out = await runReviewNameMatch({ conn, mode: 'shadow' });
    expect(out).toMatchObject({ mode: 'shadow', reviews: 1, counts: { pause: 1 }, changed: 1, written: 0 });
    expect(conn.updates).toEqual([]);
  });

  test('on writes the decisions that changed, each onto the link state it was made for', async () => {
    const now = new Date('2026-10-31T13:00:00Z');
    const conn = fakeConn([
      review('r1', 'Dana Fenwikc'),
      // Already holds today's decision: no write.
      review('r2', 'Marlow Pemberton', { name_match_result: 'link', name_match_customer_id: 'c2', name_match_reason: 'exact' }),
      // Linked to a customer whose first contact came after the review.
      review('r3', 'Gwen Harlowe', { customer_id: 'c3' }),
    ]);
    loadEvidenceCandidates.mockResolvedValue([
      candidate('c1', 'Dana', 'Fenwick'),
      candidate('c2', 'Marlow', 'Pemberton'),
      candidate('c3', 'Gwen', 'Harlowe', { timeline: { createdAt: '2026-10-25T14:00:00Z' } }),
    ]);
    const out = await runReviewNameMatch({ conn, mode: 'on', now });
    expect(out).toMatchObject({ mode: 'on', reviews: 3, changed: 2, written: 2 });
    expect(conn.updates).toEqual([
      {
        wheres: [['eq', { id: 'r1' }], ['null', 'missing_since'], ['null', 'customer_id']],
        patch: { name_match_result: 'pause', name_match_customer_id: 'c1', name_match_reason: 'near', name_match_at: now },
      },
      {
        wheres: [['eq', { id: 'r3' }], ['null', 'missing_since'], ['eq', { customer_id: 'c3' }]],
        patch: { name_match_result: 'disputed', name_match_customer_id: 'c3', name_match_reason: 'clash', name_match_at: now },
      },
    ]);
  });

  test('a customer a person ruled out is never named again for that review; a kept link is not disputed', async () => {
    const conn = fakeConn([
      review('r1', 'Dana Fenwikc', { name_match_dismissed_customer_id: 'c1' }),
      review('r3', 'Gwen Harlowe', { customer_id: 'c3', name_match_dismissed_customer_id: 'c3' }),
    ]);
    loadEvidenceCandidates.mockResolvedValue([
      candidate('c1', 'Dana', 'Fenwick'),
      candidate('c3', 'Gwen', 'Harlowe', { timeline: { createdAt: '2026-10-25T14:00:00Z' } }),
    ]);
    const out = await runReviewNameMatch({ conn, mode: 'on' });
    expect(out).toMatchObject({ counts: { none: 2 }, changed: 0, written: 0 });
  });

  test('a decision that no longer holds is cleared', async () => {
    const conn = fakeConn([review('r1', 'Trent Oakhurst', { name_match_result: 'pause', name_match_customer_id: 'c1', name_match_reason: 'near' })]);
    loadEvidenceCandidates.mockResolvedValue([candidate('c1', 'Dana', 'Fenwick')]);
    await runReviewNameMatch({ conn, mode: 'on' });
    expect(conn.updates.map((u) => u.patch)).toEqual([
      expect.objectContaining({ name_match_result: null, name_match_customer_id: null, name_match_reason: null }),
    ]);
  });
});

describe('dismissNameMatch', () => {
  test('rules the shown customer out and clears the decision', async () => {
    const conn = fakeConn([]);
    await expect(dismissNameMatch({ reviewId: 'r1', customerId: 'c1', conn })).resolves.toEqual({ dismissed: true });
    expect(conn.updates).toEqual([{
      wheres: [['eq', { id: 'r1', name_match_customer_id: 'c1' }], ['notNull', 'name_match_result']],
      patch: expect.objectContaining({
        name_match_dismissed_customer_id: 'c1', name_match_result: null, name_match_customer_id: null, name_match_reason: null,
      }),
    }]);
  });

  test('answers 409 when the decision moved since the page loaded, 400 without ids', async () => {
    const conn = jest.fn(() => {
      const q = { where: () => q, whereNotNull: () => q, update: async () => 0 };
      return q;
    });
    await expect(dismissNameMatch({ reviewId: 'r1', customerId: 'c1', conn })).rejects.toMatchObject({ statusCode: 409 });
    await expect(dismissNameMatch({ reviewId: 'r1', conn })).rejects.toMatchObject({ statusCode: 400 });
  });
});
