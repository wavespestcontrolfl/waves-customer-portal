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
      whereRaw(sql, bindings) { if (bindings) q.wheres.push(['raw', sql, bindings]); return q; },
      whereNull(column) { q.wheres.push(['null', column]); return q; },
      whereNotNull(column) { q.wheres.push(['notNull', column]); return q; },
      where(arg) { q.wheres.push(['eq', arg]); return q; },
      select: async () => reviews,
      update: async (patch) => { updates.push({ wheres: q.wheres, patch }); return 1; },
    };
    return q;
  });
  conn.updates = updates;
  conn.raw = (sql, bindings) => ({ raw: sql, bindings });
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
  name_match_dismissed_customer_ids: [],
  name_match_dismissed_at: null,
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
    const unchangedDismissal = ['raw', 'name_match_dismissed_at IS NOT DISTINCT FROM ?::timestamptz', [null]];
    expect(conn.updates).toEqual([
      {
        wheres: [['eq', { id: 'r1' }], ['null', 'missing_since'], unchangedDismissal, ['null', 'customer_id']],
        patch: { name_match_result: 'pause', name_match_customer_id: 'c1', name_match_reason: 'near', name_match_at: now },
      },
      {
        wheres: [['eq', { id: 'r3' }], ['null', 'missing_since'], unchangedDismissal, ['eq', { customer_id: 'c3' }]],
        patch: { name_match_result: 'disputed', name_match_customer_id: 'c3', name_match_reason: 'clash', name_match_at: now },
      },
    ]);
  });

  test('every customer a person ruled out is never named again for that review; a kept link is not disputed', async () => {
    const conn = fakeConn([
      // Two dismissals on one review: the first ruled-out customer stays out too.
      review('r1', 'Dana Fenwikc', { name_match_dismissed_customer_ids: ['c1', 'c2'] }),
      review('r3', 'Gwen Harlowe', { customer_id: 'c3', name_match_dismissed_customer_ids: ['c3'] }),
    ]);
    loadEvidenceCandidates.mockResolvedValue([
      candidate('c1', 'Dana', 'Fenwick'),
      // An exact name: it would be the link if its dismissal were forgotten.
      candidate('c2', 'Dana', 'Fenwikc'),
      candidate('c3', 'Gwen', 'Harlowe', { timeline: { createdAt: '2026-10-25T14:00:00Z' } }),
    ]);
    const out = await runReviewNameMatch({ conn, mode: 'on' });
    expect(out).toMatchObject({ counts: { none: 2 }, changed: 0, written: 0 });
  });

  test('a write is conditioned on the dismissal the pass read, so a dismissal made mid-pass stands', async () => {
    const dismissedAt = new Date('2026-10-31T12:00:00Z');
    const conn = fakeConn([review('r1', 'Dana Fenwikc', { name_match_dismissed_customer_ids: ['c9'], name_match_dismissed_at: dismissedAt })]);
    loadEvidenceCandidates.mockResolvedValue([candidate('c1', 'Dana', 'Fenwick')]);
    await runReviewNameMatch({ conn, mode: 'on' });
    expect(conn.updates[0].wheres).toContainEqual(['raw', 'name_match_dismissed_at IS NOT DISTINCT FROM ?::timestamptz', [dismissedAt]]);
  });

  test('a click auto-link is never disputed: it already waits in the queue for its own confirm', async () => {
    const conn = fakeConn([review('r3', 'Gwen Harlowe', { customer_id: 'c3', link_source: 'click_auto' })]);
    loadEvidenceCandidates.mockResolvedValue([candidate('c3', 'Gwen', 'Harlowe', { timeline: { createdAt: '2026-10-25T14:00:00Z' } })]);
    const out = await runReviewNameMatch({ conn, mode: 'on' });
    expect(out).toMatchObject({ counts: { none: 1 }, written: 0 });
  });

  test('an inactive customer is never suggested: the queue could not confirm them', async () => {
    const conn = fakeConn([review('r1', 'Marlow Pemberton')]);
    loadEvidenceCandidates.mockResolvedValue([candidate('c1', 'Marlow', 'Pemberton', { active: false })]);
    const out = await runReviewNameMatch({ conn, mode: 'on' });
    expect(out).toMatchObject({ counts: { none: 1 }, written: 0 });
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
  test('rules the shown customer out and clears the decision, only on the decision and link state shown', async () => {
    const conn = fakeConn([]);
    await expect(dismissNameMatch({ reviewId: 'r1', customerId: 'c1', result: 'pause', conn })).resolves.toEqual({ dismissed: true });
    expect(conn.updates).toEqual([{
      // Still unlinked: a suggestion someone matched meanwhile is not dismissed by a stale page.
      wheres: [['eq', { id: 'r1', name_match_customer_id: 'c1', name_match_result: 'pause' }], ['null', 'customer_id']],
      patch: expect.objectContaining({
        // Appended to the list: earlier dismissals stay.
        name_match_dismissed_customer_ids: { raw: 'array_append(name_match_dismissed_customer_ids, ?::uuid)', bindings: ['c1'] },
        name_match_result: null, name_match_customer_id: null, name_match_reason: null,
      }),
    }]);
  });

  test('Keep link on a dispute applies only while the review is still linked to that customer', async () => {
    const conn = fakeConn([]);
    await dismissNameMatch({ reviewId: 'r3', customerId: 'c3', result: 'disputed', conn });
    expect(conn.updates[0].wheres).toEqual([['eq', { id: 'r3', name_match_customer_id: 'c3', name_match_result: 'disputed' }], ['eq', { customer_id: 'c3' }]]);
  });

  test('answers 409 when the decision or link moved since the page loaded, 400 without ids or the shown result', async () => {
    const conn = jest.fn(() => {
      const q = { where: () => q, whereNull: () => q, update: async () => 0 };
      return q;
    });
    conn.raw = () => ({});
    await expect(dismissNameMatch({ reviewId: 'r1', customerId: 'c1', result: 'pause', conn })).rejects.toMatchObject({ statusCode: 409 });
    await expect(dismissNameMatch({ reviewId: 'r1', customerId: 'c1', conn })).rejects.toMatchObject({ statusCode: 400 });
    await expect(dismissNameMatch({ reviewId: 'r1', result: 'pause', conn })).rejects.toMatchObject({ statusCode: 400 });
  });
});
