// Canonical publisher: every reply writer goes draft → verify → liveness
// recheck → publish → persist → audit through here. The Intelligence Bar
// tool used to write locally and claim Google would sync it; these tests pin
// that any human path with GBP configured really calls replyToReview, and
// that automation never fakes a local-only post.
const mockGbp = {
  configured: true,
  getReview: jest.fn(async () => ({ reviewReply: null, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } })),
  isLocationConfigured: jest.fn(async () => true),
  getAllLocationReviews: jest.fn(async () => []),
  replyToReview: jest.fn(async () => ({ comment: 'ok' })),
  deleteReply: jest.fn(async () => true),
};
const mockLock = jest.fn();
const state = { rows: [], activity: [], failNextUpdate: false };

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/google-business', () => mockGbp);
jest.mock('../services/social-content-studio', () => ({ publishWithReviewLivenessLock: (...a) => mockLock(...a) }));
const mockNotify = jest.fn(async () => ({}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotify(...a) }));
const mockAccountFacts = jest.fn(async () => null);
jest.mock('../services/review-reply/grounding', () => ({
  loadAccountFacts: (...a) => mockAccountFacts(...a),
  accountFingerprint: (a) => (a ? `fp:${a.city || ''}|${a.tenure || ''}` : 'fp:none'),
  groundingCustomerId: (r) => (r && r.customer_id && r.link_source !== 'click_auto' ? r.customer_id : null),
}));
jest.mock('../config/locations', () => ({
  WAVES_LOCATIONS: [{ id: 'sarasota', name: 'Sarasota', googleLocationResourceName: 'accounts/1/locations/2' }],
}));
jest.mock('../models/db', () => {
  const dbFn = (table) => {
    const filters = [];
    const api = {
      where(obj) {
        if (typeof obj === 'function') {
          // ownSlot() / stateOwned(): OR-branches
          const branches = [];
          const sub = {
            whereNull(col) { branches.push((r) => r[col] == null); return sub; },
            orWhere(col, val) { branches.push((r) => r[col] === val); return sub; },
            orWhereNotIn(col, vals) { branches.push((r) => r[col] != null && !vals.includes(r[col])); return sub; },
          };
          obj.call(sub);
          filters.push((r) => branches.some((b) => b(r)));
        } else if (typeof obj === 'string') {
          const val = arguments[1];
          filters.push((r) => r[obj] === val);
        } else {
          filters.push((r) => Object.entries(obj).every(([k, v]) => r[k] === v));
        }
        return api;
      },
      modify(fn) { fn(api); return api; },
      whereNotIn(col, vals) { filters.push((r) => !vals.includes(r[col])); return api; },
      orWhereNotIn() { return api; },
      forUpdate() { return api; },
      select() { return api; },
      whereNull(col) { filters.push((r) => r[col] == null); return api; },
      async first() { return state.rows.filter((r) => filters.every((f) => f(r)))[0] || null; },
      async update(patch) {
        if (state.failNextUpdate) { state.failNextUpdate = false; throw new Error('connection reset'); }
        const hits = state.rows.filter((r) => filters.every((f) => f(r)));
        hits.forEach((r) => Object.assign(r, patch));
        return hits.length;
      },
      async insert(row) { if (table === 'activity_log') state.activity.push(row); return [1]; },
    };
    return api;
  };
  dbFn.fn = { now: () => 'NOW()' };
  dbFn.raw = (sql) => ({ sql });
  // Transaction = same in-memory store (row locks are a no-op here).
  dbFn.transaction = async (fn) => fn(dbFn);
  return dbFn;
});

const { publishReviewReply, retractReviewReply, CODES } = require('../services/review-reply/publisher');

function liveLock() {
  return { blocked: false, result: true, releaseClaim: jest.fn(async () => {}), abandonClaim: jest.fn() };
}

afterEach(() => { jest.useRealTimers(); });

beforeEach(() => {
  jest.clearAllMocks();
  mockGbp.configured = true;
  state.activity = [];
  state.rows = [{
    id: 'rev-1', location_id: 'sarasota', reviewer_name: 'Dana W.', star_rating: 5,
    review_text: 'Great', review_reply: null, gbp_review_name: 'accounts/1/locations/2/reviews/9', missing_since: null,
  }];
  mockLock.mockImplementation(async (id, fn) => { const out = liveLock(); out.result = await fn(); return out; });
});

describe('publishReviewReply', () => {
  test('IB path posts to Google inside the liveness lock and records the reply', async () => {
    const r = await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'ib' }, allowOverwrite: true });
    expect(r.googlePosted).toBe(true);
    expect(mockLock).toHaveBeenCalledWith('rev-1', expect.any(Function));
    expect(mockGbp.replyToReview).toHaveBeenCalledWith('accounts/1/locations/2/reviews/9', 'Thanks Dana.', 'sarasota', expect.objectContaining({ signal: expect.anything() }));
    expect(state.rows[0].review_reply).toBe('Thanks Dana.');
    expect(state.activity[0].action).toBe('review_replied');
    expect(JSON.parse(state.activity[0].metadata).source).toBe('ib');
  });

  test('P0: a human reply that lands between the pre-check and the publish claim aborts inside the claim', async () => {
    mockLock.mockImplementationOnce(async (id, fn) => {
      state.rows[0].review_reply = 'A person replied meanwhile';
      const out = liveLock();
      await fn();
      return out;
    });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' } }))
      .rejects.toMatchObject({ code: CODES.HAS_REPLY });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
    expect(state.rows[0].review_reply).toBe('A person replied meanwhile');
  });

  test('P0: the caller guard runs on the fresh row inside the claim and can abort with STALE', async () => {
    const guard = jest.fn((fresh) => (fresh.auto_reply_claimed_until === 'tok-1' ? null : 'auto-reply claim was lost'));
    state.rows[0].auto_reply_claimed_until = 'tok-2';
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' }, guard }))
      .rejects.toMatchObject({ code: CODES.STALE, status: 409 });
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ id: 'rev-1', auto_reply_claimed_until: 'tok-2' }));
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
    state.rows[0].auto_reply_claimed_until = 'tok-1';
    const r = await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'auto' }, guard });
    expect(r.googlePosted).toBe(true);
  });

  test('automation checks Google\'s LIVE owner reply inside the claim and yields to it', async () => {
    state.rows[0].auto_reply_status = 'queued';
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: { comment: 'Owner replied in Google directly', updateTime: '2026-08-27T10:00:00Z' } });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' } }))
      .rejects.toMatchObject({ code: CODES.HAS_REPLY });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
    expect(state.rows[0].review_reply).toBe('Owner replied in Google directly');
    // Pending pipeline state is closed in the same write, through the sync's
    // own status writer (codex r37).
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'skipped', auto_reply_reason: 'owner_replied_on_google' });
    expect(state.rows[0].auto_reply_claimed_until).toBeNull();
    // A read failure fails closed (retry later), never posts.
    state.rows[0].review_reply = null;
    mockGbp.getReview.mockRejectedValueOnce(new Error('GBP 503'));
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' } }))
      .rejects.toMatchObject({ code: CODES.GOOGLE_FAILED });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
    // Human overwrite paths consult the live resource too (codex r21): the
    // reply they observed locally must still be what Google shows.
    await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'admin' }, allowOverwrite: true });
    expect(mockGbp.getReview).toHaveBeenCalledTimes(3);
  });

  test('the ownership guard is re-run on a fresh read after the live GET, right before the PUT', async () => {
    let calls = 0;
    const guard = jest.fn(() => (++calls === 2 ? 'auto-reply claim was lost' : null));
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' }, guard }))
      .rejects.toMatchObject({ code: CODES.STALE });
    expect(guard).toHaveBeenCalledTimes(2);
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
  });

  test('automation compares the LIVE review (rating/text/reviewer) with the synced row before the PUT', async () => {
    state.rows[0].review_text = 'Great';
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: null, starRating: 'ONE', comment: 'Terrible now', reviewer: { displayName: 'Dana W.' } });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' } }))
      .rejects.toMatchObject({ code: CODES.REVIEW_CHANGED });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: null, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    const r = await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'auto' } });
    expect(r.googlePosted).toBe(true);
  });

  test('overwriting callers also compare the LIVE review content (codex r22): a reviewer rewrite on Google blocks the admin PUT', async () => {
    state.rows[0].review_text = 'Great';
    state.rows[0].review_reply = 'Already answered.';
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: { comment: 'Already answered.' }, starRating: 'ONE', comment: 'Terrible now', reviewer: { displayName: 'Dana W.' } });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Replacement.', actor: { type: 'admin' }, allowOverwrite: true }))
      .rejects.toMatchObject({ code: CODES.REVIEW_CHANGED, status: 409 });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
    // No owner reply yet, text rewritten: still blocked.
    state.rows[0].review_reply = null;
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: null, starRating: 'FIVE', comment: 'Rewritten complaint', reviewer: { displayName: 'Dana W.' } });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Replacement.', actor: { type: 'ib' }, allowOverwrite: true }))
      .rejects.toMatchObject({ code: CODES.REVIEW_CHANGED });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: null, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    const r = await publishReviewReply({ reviewId: 'rev-1', text: 'Replacement.', actor: { type: 'admin' }, allowOverwrite: true });
    expect(r.googlePosted).toBe(true);
  });

  test('retract re-validates pipeline ownership inside the claim (codex r39): an identical human replacement posted meanwhile is theirs', async () => {
    state.rows[0].review_reply = 'Thanks Dana.';
    state.rows[0].auto_reply_status = 'posted';
    mockLock.mockImplementationOnce(async (id, fn) => {
      // Between the pre-claim read and the claim, an admin posted the same text via the editor.
      state.rows[0].auto_reply_status = 'skipped'; state.rows[0].auto_reply_reason = 'manual_reply';
      return fn();
    });
    await expect(retractReviewReply({ reviewId: 'rev-1', actor: { type: 'admin' } })).rejects.toMatchObject({ code: CODES.STALE });
    expect(mockGbp.deleteReply).not.toHaveBeenCalled();
    expect(state.rows[0].review_reply).toBe('Thanks Dana.');
  });

  test('activity_log never carries the reviewer name', async () => {
    await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'ib' }, allowOverwrite: true });
    expect(state.activity[0].description).not.toContain('Dana');
    expect(state.activity[0].description).toContain('rev-1');
  });

  test('auto actor stamps its pipeline columns in the same write and audits as auto', async () => {
    await publishReviewReply({
      reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'auto' },
      autoFields: { auto_reply_status: 'posted', auto_reply_mode: 'service_quality' },
    });
    expect(state.rows[0].auto_reply_status).toBe('posted');
    expect(state.rows[0].auto_reply_mode).toBe('service_quality');
    expect(state.activity[0].action).toBe('review_auto_replied');
  });

  test('auto never overwrites a real reply; humans may', async () => {
    state.rows[0].review_reply = 'Already answered.';
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' } }))
      .rejects.toMatchObject({ code: CODES.HAS_REPLY, status: 409 });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
    // The live reply matches what the admin saw locally → they may replace it.
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: { comment: 'Already answered.' }, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    const r = await publishReviewReply({ reviewId: 'rev-1', text: 'Replacement.', actor: { type: 'admin' }, allowOverwrite: true });
    expect(r.googlePosted).toBe(true);
  });

  test('overwriting callers compare the LIVE reply with the one they observed locally: a newer Google reply blocks the PUT and is recorded', async () => {
    state.rows[0].review_reply = 'Already answered.';
    state.rows[0].auto_reply_status = 'posted';
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: { comment: 'Owner rewrote this in Google', updateTime: '2026-08-28T01:00:00Z' }, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Replacement.', actor: { type: 'admin' }, allowOverwrite: true }))
      .rejects.toMatchObject({ code: CODES.STALE, status: 409 });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
    expect(state.rows[0].review_reply).toBe('Owner rewrote this in Google');
    // codex r37: recording the owner's Google edit over OUR posted reply closes
    // the automatic state the same way the sync does — Retract must not be
    // offered for their text.
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'skipped', auto_reply_reason: 'edited_on_google' });
    // Matching live reply → the overwrite proceeds.
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: { comment: 'Owner rewrote this in Google' }, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    let r = await publishReviewReply({ reviewId: 'rev-1', text: 'Replacement.', actor: { type: 'admin' }, allowOverwrite: true });
    expect(r.googlePosted).toBe(true);
    expect(mockGbp.replyToReview).toHaveBeenCalledTimes(1);
    // codex r23: the owner DELETED the reply on Google since the page loaded
    // → a stale editor must not recreate it; the removal is recorded locally
    // (posted auto reply → retracted/removed_on_google) and they reload.
    state.rows[0].review_reply = 'Replacement.';
    state.rows[0].auto_reply_status = 'posted';
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: null, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Replacement two.', actor: { type: 'ib' }, allowOverwrite: true }))
      .rejects.toMatchObject({ code: CODES.STALE, status: 409 });
    expect(mockGbp.replyToReview).toHaveBeenCalledTimes(1);
    expect(state.rows[0].review_reply).toBeNull();
    expect(state.rows[0].auto_reply_status).toBe('retracted');
    expect(state.rows[0].auto_reply_reason).toBe('removed_on_google');
    // No reply locally and none live → nothing changed, proceeds.
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: null, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    r = await publishReviewReply({ reviewId: 'rev-1', text: 'Replacement two.', actor: { type: 'ib' }, allowOverwrite: true });
    expect(r.googlePosted).toBe(true);
    expect(mockGbp.replyToReview).toHaveBeenCalledTimes(2);
  });
  test('overwriting callers re-run the guard on a fresh read after the live GET, right before the PUT (codex r24)', async () => {
    let calls = 0;
    const guard = jest.fn(() => (++calls === 2 ? 'the customer facts changed since this draft was written' : null));
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: null, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'admin' }, allowOverwrite: true, guard }))
      .rejects.toMatchObject({ code: CODES.STALE, status: 409 });
    expect(guard).toHaveBeenCalledTimes(2);
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
    // Both verdicts clean → posts, guard still consulted twice.
    const ok = jest.fn(() => null);
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: null, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    const r = await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'admin' }, allowOverwrite: true, guard: ok });
    expect(r.googlePosted).toBe(true);
    expect(ok).toHaveBeenCalledTimes(2);
  });

  test('a caller that states the reply it observed is held to it (codex r27): a sync-recorded owner edit since page load blocks the PUT', async () => {
    // Page loaded with 'Already answered.'; the hourly sync then recorded the owner's Google edit locally.
    state.rows[0].review_reply = 'Owner edited this in Google';
    // (fails inside the claim before any live GET — no getReview mock queued)
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Replacement.', actor: { type: 'admin' }, allowOverwrite: true, expectedReply: 'Already answered.' }))
      .rejects.toMatchObject({ code: CODES.STALE, status: 409 });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
    // Observed null, row now has a reply → stale too.
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Replacement.', actor: { type: 'admin' }, allowOverwrite: true, expectedReply: null }))
      .rejects.toMatchObject({ code: CODES.STALE });
    // Observed matches the row and Google → proceeds.
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: { comment: 'Owner edited this in Google' }, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    const r = await publishReviewReply({ reviewId: 'rev-1', text: 'Replacement.', actor: { type: 'admin' }, allowOverwrite: true, expectedReply: 'Owner edited this in Google' });
    expect(r.googlePosted).toBe(true);
  });

  test('the browser-observed DRAFT slot is enforced too (codex r30): a human draft replaced after page load blocks the stale editor', async () => {
    state.rows[0].review_reply = '[DRAFT] Newer draft from Agent Ops';
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Old editor text.', actor: { type: 'admin' }, allowOverwrite: true, expectedReply: null, expectedDraft: 'Older draft the editor was seeded from' }))
      .rejects.toMatchObject({ code: CODES.STALE, status: 409 });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
    // Observed draft matches → proceeds.
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: null, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    const r = await publishReviewReply({ reviewId: 'rev-1', text: 'Newer draft from Agent Ops', actor: { type: 'admin' }, allowOverwrite: true, expectedReply: null, expectedDraft: 'Newer draft from Agent Ops' });
    expect(r.googlePosted).toBe(true);
  });

  test('the browser-observed REVIEW token is enforced (codex r33): a reviewer rewrite the sync recorded since page load refuses manual text', async () => {
    const { reviewFingerprint } = require('../services/review-reply/fingerprint');
    const stale = reviewFingerprint({ ...state.rows[0], review_text: 'What the page showed' });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Written for the old review.', actor: { type: 'admin' }, allowOverwrite: true, expectedReview: stale }))
      .rejects.toMatchObject({ code: CODES.REVIEW_CHANGED, status: 409 });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: null, starRating: 'FIVE', comment: state.rows[0].review_text, reviewer: { displayName: 'Dana W.' } });
    const r = await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'admin' }, allowOverwrite: true, expectedReview: reviewFingerprint(state.rows[0]) });
    expect(r.googlePosted).toBe(true);
  });

  test('a reviewer edit recorded while the PUT was in flight persists as parked/review_edited_after_post with an action bell, never a clean posted (codex r33)', async () => {
    mockNotify.mockClear();
    mockGbp.replyToReview.mockImplementationOnce(async () => { state.rows[0].review_text = 'Rewritten complaint'; state.rows[0].star_rating = 1; return {}; });
    const r = await publishReviewReply({
      reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'auto' },
      autoFields: { auto_reply_status: 'posted', auto_reply_reason: null, auto_reply_published_at: '2026-08-27T15:00:00Z' },
    });
    expect(r).toMatchObject({ googlePosted: true, editedDuringPut: true });
    expect(state.rows[0]).toMatchObject({ review_reply: 'Thanks Dana.', auto_reply_status: 'parked', auto_reply_reason: 'review_edited_after_post', auto_reply_published_at: '2026-08-27T15:00:00Z' });
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][3].metadata).toMatchObject({ reason: 'review_edited_after_post', needsAction: true });
    // codex r47: the bell goes through the retrying notifier — a null result is retried and then stamped for the sweep.
    mockNotify.mockClear(); mockNotify.mockResolvedValue(null);
    state.rows[0] = { ...state.rows[0], review_reply: null, auto_reply_status: 'queued', auto_reply_reason: null, review_text: 'Great', star_rating: 5 };
    mockGbp.replyToReview.mockImplementationOnce(async () => { state.rows[0].review_text = 'Rewritten complaint'; return {}; });
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: null, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'auto' }, autoFields: { auto_reply_status: 'posted' } });
    expect(mockNotify).toHaveBeenCalledTimes(3);
    expect(state.rows[0].auto_reply_error).toMatch(/^bell_failed:review_edited_after_post:/);
    mockNotify.mockReset().mockResolvedValue({});
    // codex r38: account-derived facts changed while the PUT was in flight
    // (review fingerprint unchanged) → parked for a person, never clean posted.
    mockNotify.mockClear();
    state.rows[0] = { ...state.rows[0], review_reply: null, auto_reply_status: 'queued', auto_reply_reason: null, review_text: 'Great', star_rating: 5, customer_id: 'c1' };
    mockAccountFacts.mockResolvedValueOnce({ city: 'Sarasota', tenure: 'new' });
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: null, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    const ra = await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'auto' }, autoFields: { auto_reply_status: 'posted', auto_reply_grounding: JSON.stringify({ accountFingerprint: 'fp:Venice|new' }) } });
    expect(ra.editedDuringPut).toBe(true);
    expect(state.rows[0]).toMatchObject({ review_reply: 'Thanks Dana.', auto_reply_status: 'parked', auto_reply_reason: 'review_edited_after_post' });
    expect(mockNotify).toHaveBeenCalledTimes(1);
    // Matching account facts → clean posted.
    mockNotify.mockClear();
    state.rows[0] = { ...state.rows[0], review_reply: null, auto_reply_status: 'queued', auto_reply_reason: null };
    mockAccountFacts.mockReset().mockResolvedValue({ city: 'Venice', tenure: 'new' });
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: null, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    const rb = await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'auto' }, autoFields: { auto_reply_status: 'posted', auto_reply_grounding: JSON.stringify({ accountFingerprint: 'fp:Venice|new' }) } });
    expect(mockAccountFacts).toHaveBeenCalledWith('c1', expect.anything());
    expect(rb.editedDuringPut).toBe(false);
    expect(state.rows[0].auto_reply_status).toBe('posted');
    // codex r40: an editor / IB AI draft passes the account half of its
    // grounding token; changed facts during the PUT still park + bell even
    // though no pipeline snapshot is stamped (human path keeps close fields).
    mockNotify.mockClear();
    state.rows[0] = { ...state.rows[0], review_reply: null, auto_reply_status: null, auto_reply_reason: null, review_text: 'Great', star_rating: 5, customer_id: 'c1' };
    mockAccountFacts.mockReset().mockResolvedValue({ city: 'Sarasota', tenure: 'new' });
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: null, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    const rc = await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'admin' }, allowOverwrite: true, autoFields: { auto_reply_status: null }, expectedAccountFingerprint: 'fp:Venice|new' });
    expect(rc.editedDuringPut).toBe(true);
    expect(state.rows[0]).toMatchObject({ review_reply: 'Thanks Dana.', auto_reply_status: null });
    expect(mockNotify).toHaveBeenCalledTimes(1);
    // A HUMAN reply edited-during-PUT keeps the caller's own close fields
    // (never the automatic park — no auto-reply Retract for a person's text)
    // but the bell still rings (hook P1).
    mockNotify.mockClear();
    state.rows[0] = { ...state.rows[0], review_reply: null, auto_reply_status: null, auto_reply_reason: null, review_text: 'Great', star_rating: 5 };
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: null, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    mockGbp.replyToReview.mockImplementationOnce(async () => { state.rows[0].review_text = 'Rewritten again'; return {}; });
    const rh = await publishReviewReply({ reviewId: 'rev-1', text: 'A person wrote this.', actor: { type: 'admin' }, allowOverwrite: true, autoFields: { auto_reply_status: null, auto_reply_reason: null } });
    expect(rh.editedDuringPut).toBe(true);
    expect(state.rows[0]).toMatchObject({ review_reply: 'A person wrote this.', auto_reply_status: null });
    expect(mockNotify).toHaveBeenCalledTimes(1);
    // No edit → clean posted, no bell.
    mockNotify.mockClear();
    state.rows[0] = { ...state.rows[0], review_reply: null, auto_reply_status: 'queued', auto_reply_reason: null, review_text: 'Great', star_rating: 5 };
    const r2 = await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks again.', actor: { type: 'auto' }, autoFields: { auto_reply_status: 'posted' } });
    expect(r2.editedDuringPut).toBe(false);
    expect(state.rows[0].auto_reply_status).toBe('posted');
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('the dev/preview local-only path runs the SAME row checks (hook P1): observed tokens, foreign draft and guard apply, and the write is a CAS on the observed slot', async () => {
    const wasConfigured = mockGbp.configured;
    mockGbp.configured = false;
    try {
      const { reviewFingerprint } = require('../services/review-reply/fingerprint');
      // Stale observed reply → refused, nothing written.
      state.rows[0].review_reply = 'Newer local reply';
      await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Stale editor text', actor: { type: 'admin' }, allowOverwrite: true, expectedReply: 'What the page showed' }))
        .rejects.toMatchObject({ code: CODES.STALE });
      expect(state.rows[0].review_reply).toBe('Newer local reply');
      // Stale observed review token → refused.
      await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x', actor: { type: 'admin' }, allowOverwrite: true, expectedReview: reviewFingerprint({ ...state.rows[0], review_text: 'old' }) }))
        .rejects.toMatchObject({ code: CODES.REVIEW_CHANGED });
      // Guard verdict → refused.
      await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x', actor: { type: 'admin' }, allowOverwrite: true, guard: async () => 'the customer facts changed since this draft was generated' }))
        .rejects.toMatchObject({ code: CODES.STALE });
      // Foreign human draft, non-overwriting caller → refused before any write.
      state.rows[0].review_reply = '[DRAFT] somebody else wrote this';
      await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x', actor: { type: 'ib' } })).rejects.toMatchObject({ code: CODES.STALE });
      // codex r44: an AI draft's account facts are re-checked in the same
      // transaction as the local write.
      state.rows[0].review_reply = null; state.rows[0].customer_id = 'c1';
      mockAccountFacts.mockReset().mockResolvedValue({ city: 'Sarasota', tenure: 'new' });
      await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Grounded on Venice.', actor: { type: 'admin' }, allowOverwrite: true, expectedAccountFingerprint: 'fp:Venice|new' }))
        .rejects.toMatchObject({ code: CODES.STALE });
      expect(state.rows[0].review_reply).toBeNull();
      mockAccountFacts.mockReset().mockResolvedValue(null);
      // Everything matches → local-only write.
      state.rows[0].review_reply = null;
      const r = await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'admin' }, allowOverwrite: true, expectedReply: null, expectedDraft: null, expectedReview: reviewFingerprint(state.rows[0]) });
      expect(r).toMatchObject({ googlePosted: false, localOnly: true });
      expect(state.rows[0].review_reply).toBe('Thanks Dana.');
      expect(mockGbp.replyToReview).not.toHaveBeenCalled();
    } finally {
      mockGbp.configured = wasConfigured;
    }
  });

  test('the review token is re-compared immediately before a human PUT (codex r44): a rewrite recorded during the live GET is refused', async () => {
    const { reviewFingerprint } = require('../services/review-reply/fingerprint');
    const token = reviewFingerprint(state.rows[0]);
    mockGbp.getReview.mockImplementationOnce(async () => { state.rows[0].review_text = 'Rewritten complaint'; state.rows[0].star_rating = 1; return { reviewReply: null, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } }; });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Handwritten for the old review.', actor: { type: 'admin' }, allowOverwrite: true, expectedReview: token }))
      .rejects.toMatchObject({ code: CODES.REVIEW_CHANGED });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
  });

  test('recording a landed uncertain draft found by the live GET validates account facts before promoting it (codex r49)', async () => {
    const draft = 'Hi Dana, glad to keep looking after your Venice home.';
    state.rows[0] = { ...state.rows[0], review_reply: null, customer_id: 'c1', auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain', auto_reply_draft: draft, auto_reply_grounding: JSON.stringify({ accountFingerprint: 'fp:Venice|new' }) };
    // Facts moved since the timed-out PUT → recorded, but parked for a person.
    mockAccountFacts.mockReset().mockResolvedValue({ city: 'Sarasota', tenure: 'new' });
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: { comment: draft }, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    mockNotify.mockClear();
    const parkedErr = await publishReviewReply({ reviewId: 'rev-1', text: 'Another auto attempt.', actor: { type: 'auto' } }).catch((e) => e);
    expect(parkedErr).toMatchObject({ code: CODES.HAS_REPLY });
    expect(parkedErr.reconciled).toBeUndefined();
    expect(state.rows[0]).toMatchObject({ review_reply: draft, auto_reply_status: 'parked', auto_reply_reason: 'review_edited_after_post' });
    // codex r54: the parked promotion rings the retrying edited-after-post bell.
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][3].metadata).toMatchObject({ reason: 'review_edited_after_post', needsAction: true });
    // Facts unchanged → clean posted.
    state.rows[0] = { ...state.rows[0], review_reply: null, auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain' };
    mockAccountFacts.mockReset().mockResolvedValue({ city: 'Venice', tenure: 'new' });
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: { comment: draft }, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    // codex r69: the promotion is reported to the caller (Post now → success + reload).
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Another auto attempt.', actor: { type: 'auto' } })).rejects.toMatchObject({ code: CODES.HAS_REPLY, reconciled: true });
    expect(state.rows[0]).toMatchObject({ review_reply: draft, auto_reply_status: 'posted', auto_reply_reason: null });
    mockAccountFacts.mockReset().mockResolvedValue(null);
  });

  test('a live owner reply whose local record fails surfaces reconcile_failed, never already_replied (codex r74)', async () => {
    const draft = 'Hi Dana, glad to keep looking after your Venice home.';
    state.rows[0] = { ...state.rows[0], review_reply: null, auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain', auto_reply_draft: draft };
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: { comment: draft }, starRating: 'FIVE', comment: 'Great', reviewer: { displayName: 'Dana W.' } });
    state.failNextUpdate = true;
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Another auto attempt.', actor: { type: 'auto' } })).rejects.toMatchObject({ code: CODES.RECONCILE_FAILED, status: 503 });
    // The reconciliation park is intact for the next attempt.
    expect(state.rows[0]).toMatchObject({ review_reply: null, auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain' });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
  });

  test('a dismissal that landed since the caller\'s read is honoured inside the claim (codex r54)', async () => {
    state.rows[0].dismissed = true;
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'admin' }, allowOverwrite: true })).rejects.toMatchObject({ code: CODES.STALE, status: 409 });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
    expect(state.rows[0].review_reply).toBeNull();
    // Local-only path too.
    const wasConfigured = mockGbp.configured; mockGbp.configured = false;
    try {
      await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'admin' }, allowOverwrite: true })).rejects.toMatchObject({ code: CODES.STALE });
      expect(state.rows[0].review_reply).toBeNull();
    } finally { mockGbp.configured = wasConfigured; }
    state.rows[0].dismissed = false;
  });

  test('overwriting callers fail closed when the live review cannot be read', async () => {
    state.rows[0].review_reply = 'Already answered.';
    mockGbp.getReview.mockRejectedValueOnce(new Error('503'));
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Replacement.', actor: { type: 'admin' }, allowOverwrite: true }))
      .rejects.toMatchObject({ code: CODES.GOOGLE_FAILED });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
  });

  test('a local [DRAFT] is not a real reply — the pipeline\'s own draft is replaced, a foreign one blocks before the PUT', async () => {
    state.rows[0].review_reply = '[DRAFT] Thanks Dana.';
    const r = await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'auto' } });
    expect(r.googlePosted).toBe(true);
    state.rows[0].review_reply = '[DRAFT] someone else wrote this';
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'auto' } }))
      .rejects.toMatchObject({ code: CODES.STALE });
    expect(mockGbp.replyToReview).toHaveBeenCalledTimes(1);
  });

  test('stamped (missing) reviews and _stats rows are rejected before any Google call', async () => {
    state.rows[0].missing_since = '2026-08-20T00:00:00Z';
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'admin' } }))
      .rejects.toMatchObject({ code: CODES.MISSING, status: 409 });
    state.rows = [{ id: 'stats', reviewer_name: '_stats', location_id: 'sarasota' }];
    await expect(publishReviewReply({ reviewId: 'stats', text: 'x y z', actor: { type: 'admin' } }))
      .rejects.toMatchObject({ code: CODES.NOT_FOUND });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
  });

  test('liveness lock blocked → typed error, nothing recorded locally', async () => {
    mockLock.mockResolvedValueOnce({ blocked: true, lockBusy: true });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'admin' } }))
      .rejects.toMatchObject({ code: CODES.LOCK_BUSY, status: 409 });
    mockLock.mockResolvedValueOnce({ blocked: true, missing: false });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'admin' } }))
      .rejects.toMatchObject({ code: CODES.MISSING });
    expect(state.rows[0].review_reply).toBeNull();
  });

  test('a Google PUT that fails at the transport layer after sending (ECONNRESET) → GOOGLE_UNCERTAIN, row parked, claim abandoned (codex r64)', async () => {
    const out = { blocked: false, result: true, releaseClaim: jest.fn(async () => {}), abandonClaim: jest.fn() };
    mockLock.mockImplementationOnce(async (id, fn) => { out.result = await fn(); return out; });
    mockGbp.replyToReview.mockImplementationOnce(async () => { const e = new Error('fetch failed: ECONNRESET'); e.transport = true; throw e; });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' } })).rejects.toMatchObject({ code: CODES.GOOGLE_UNCERTAIN });
    expect(out.abandonClaim).toHaveBeenCalled();
    expect(out.releaseClaim).not.toHaveBeenCalled();
    expect(state.rows[0].review_reply).toBeNull();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain' });
  });

  test('a definitive HTTP rejection from Google (no transport flag) stays GOOGLE_FAILED / retryable', async () => {
    const out = { blocked: false, result: true, releaseClaim: jest.fn(async () => {}), abandonClaim: jest.fn() };
    mockLock.mockImplementationOnce(async (id, fn) => { out.result = await fn(); return out; });
    mockGbp.replyToReview.mockImplementationOnce(async () => { throw new Error('GBP replyToReview 429: quota'); });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' } })).rejects.toMatchObject({ code: CODES.GOOGLE_FAILED });
    expect(out.abandonClaim).not.toHaveBeenCalled();
    expect(state.rows[0].review_reply).toBeNull();
  });

  test('a Google PUT that never completes hits the total deadline → GOOGLE_UNCERTAIN, row parked for reconciliation', async () => {
    process.env.REVIEW_REPLY_GOOGLE_TIMEOUT_MS = '5000';
    const out = { blocked: false, result: true, releaseClaim: jest.fn(async () => {}), abandonClaim: jest.fn() };
    mockLock.mockImplementationOnce(async (id, fn) => { out.result = await fn(); return out; });
    let putSignal = null;
    mockGbp.replyToReview.mockImplementationOnce((name, text, loc, { signal } = {}) => { putSignal = signal; return new Promise(() => {}); });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const p = publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' } });
    const assertion = expect(p).rejects.toMatchObject({ code: CODES.GOOGLE_UNCERTAIN });
    await jest.advanceTimersByTimeAsync(31000);
    await assertion;
    jest.useRealTimers();
    // The request was actually aborted at the deadline (socket closed).
    expect(putSignal && putSignal.aborted).toBe(true);
    // A timed-out PUT may have landed: the claim is ABANDONED (never released
    // while the request is in flight), the row parks for reconciliation.
    expect(out.abandonClaim).toHaveBeenCalled();
    expect(out.releaseClaim).not.toHaveBeenCalled();
    expect(state.rows[0].review_reply).toBeNull();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain' });
  });

  test('the uncertain-timeout park is a compare-and-set: a sync that already recorded the late reply is not clobbered', async () => {
    process.env.REVIEW_REPLY_GOOGLE_TIMEOUT_MS = '5000';
    // The PUT hangs; while it hangs the hourly sync lands the late reply.
    mockGbp.replyToReview.mockImplementationOnce(() => {
      state.rows[0].review_reply = 'x y z';
      state.rows[0].auto_reply_status = 'skipped';
      state.rows[0].auto_reply_reason = 'already_replied';
      return new Promise(() => {});
    });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const p = publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' } });
    const assertion = expect(p).rejects.toMatchObject({ code: CODES.GOOGLE_UNCERTAIN });
    await jest.advanceTimersByTimeAsync(31000);
    await assertion;
    jest.useRealTimers();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'skipped', auto_reply_reason: 'already_replied', review_reply: 'x y z' });
  });

  test('a human (overwriting) PUT that times out persists google_uncertain on the reply slot it observed', async () => {
    process.env.REVIEW_REPLY_GOOGLE_TIMEOUT_MS = '5000';
    state.rows[0].auto_reply_status = null; // never queued
    const out = { blocked: false, result: true, releaseClaim: jest.fn(async () => {}), abandonClaim: jest.fn() };
    mockLock.mockImplementationOnce(async (id, fn) => { out.result = await fn(); return out; });
    mockGbp.replyToReview.mockImplementationOnce(() => new Promise(() => {}));
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const p = publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'admin' }, allowOverwrite: true });
    const assertion = expect(p).rejects.toMatchObject({ code: CODES.GOOGLE_UNCERTAIN });
    await jest.advanceTimersByTimeAsync(31000);
    await assertion;
    jest.useRealTimers();
    expect(out.abandonClaim).toHaveBeenCalled();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain' });
  });

  test('a non-overwriting PUT timeout on a never-queued (NULL state) row still records google_uncertain', async () => {
    process.env.REVIEW_REPLY_GOOGLE_TIMEOUT_MS = '5000';
    state.rows[0].auto_reply_status = null;
    const out = { blocked: false, result: true, releaseClaim: jest.fn(async () => {}), abandonClaim: jest.fn() };
    mockLock.mockImplementationOnce(async (id, fn) => { out.result = await fn(); return out; });
    mockGbp.replyToReview.mockImplementationOnce(() => new Promise(() => {}));
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const p = publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'ib' } });
    const assertion = expect(p).rejects.toMatchObject({ code: CODES.GOOGLE_UNCERTAIN });
    await jest.advanceTimersByTimeAsync(31000);
    await assertion;
    jest.useRealTimers();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain' });
  });

  test('a live GET that never completes → GOOGLE_FAILED (retryable), no PUT attempted', async () => {
    mockGbp.getReview.mockImplementationOnce(() => new Promise(() => {}));
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const p = publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' } });
    const assertion = expect(p).rejects.toMatchObject({ code: CODES.GOOGLE_FAILED });
    await jest.advanceTimersByTimeAsync(31000);
    await assertion;
    jest.useRealTimers();
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
  });

  test('Google rejection → GOOGLE_FAILED, local row untouched', async () => {
    mockGbp.replyToReview.mockRejectedValueOnce(new Error('GBP replyToReview 403'));
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' } }))
      .rejects.toMatchObject({ code: CODES.GOOGLE_FAILED, status: 502 });
    expect(state.rows[0].review_reply).toBeNull();
  });

  test('resolves a missing GBP resource name only on an UNAMBIGUOUS name+time+rating+text match, else NO_RESOURCE', async () => {
    state.rows[0].gbp_review_name = null;
    state.rows[0].review_created_at = '2026-08-20T10:00:00Z';
    // Two same-name reviews inside the window: ambiguous → no resolution.
    mockGbp.getAllLocationReviews.mockResolvedValueOnce([
      { name: 'accounts/1/locations/2/reviews/77', reviewer: { displayName: 'Dana W.' }, createTime: '2026-08-20T11:00:00Z', starRating: 'FIVE', comment: 'Great' },
      { name: 'accounts/1/locations/2/reviews/78', reviewer: { displayName: 'Dana W.' }, createTime: '2026-08-20T12:00:00Z', starRating: 'FIVE', comment: 'Great' },
    ]);
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' } }))
      .rejects.toMatchObject({ code: CODES.NO_RESOURCE });
    // Same name + time but different text: not a match.
    mockGbp.getAllLocationReviews.mockResolvedValueOnce([
      { name: 'accounts/1/locations/2/reviews/79', reviewer: { displayName: 'Dana W.' }, createTime: '2026-08-20T11:00:00Z', starRating: 'FIVE', comment: 'Different review' },
    ]);
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' } }))
      .rejects.toMatchObject({ code: CODES.NO_RESOURCE });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
    mockGbp.getAllLocationReviews.mockResolvedValueOnce([
      { name: 'accounts/1/locations/2/reviews/77', reviewer: { displayName: 'Dana W.' }, createTime: '2026-08-20T11:00:00Z', starRating: 'FIVE', comment: 'Great' },
    ]);
    const r = await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'auto' } });
    expect(r.googlePosted).toBe(true);
    expect(state.rows[0].gbp_review_name).toBe('accounts/1/locations/2/reviews/77');

    state.rows[0].gbp_review_name = null;
    state.rows[0].review_reply = null;
    mockGbp.getAllLocationReviews.mockResolvedValueOnce([]);
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' } }))
      .rejects.toMatchObject({ code: CODES.NO_RESOURCE });
  });

  test('location without credentials → NOT_CONFIGURED', async () => {
    mockGbp.isLocationConfigured.mockResolvedValueOnce(false);
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'admin' } }))
      .rejects.toMatchObject({ code: CODES.NOT_CONFIGURED, status: 503 });
  });

  test('no GBP at all (dev): humans get the historical local-only save, automation is refused', async () => {
    mockGbp.configured = false;
    state.rows[0].auto_reply_status = 'drafted';
    const r = await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'admin' }, autoFields: { auto_reply_status: 'skipped', auto_reply_reason: 'manual_reply' } });
    expect(r).toMatchObject({ googlePosted: false, localOnly: true });
    expect(state.rows[0].review_reply).toBe('Thanks Dana.');
    // Pipeline fields apply on the local-only path too.
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'skipped', auto_reply_reason: 'manual_reply' });
    state.rows[0].review_reply = null;
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' } }))
      .rejects.toMatchObject({ code: CODES.NOT_CONFIGURED });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'admin' }, requireGoogle: true }))
      .rejects.toMatchObject({ code: CODES.NOT_CONFIGURED });
    expect(state.rows[0].review_reply).toBeNull();
  });
});

describe('publishReviewReply — human draft saved during the Google PUT', () => {
  test('non-overwrite persistence is conditional on the reply slot: a human [DRAFT] saved mid-PUT is kept and the row parks', async () => {
    const out = { blocked: false, result: true, releaseClaim: jest.fn(async () => {}), abandonClaim: jest.fn() };
    mockLock.mockImplementationOnce(async (id, fn) => { await fn(); return out; });
    mockGbp.replyToReview.mockImplementationOnce(async () => { state.rows[0].review_reply = '[DRAFT] Agent Ops saved this mid-flight'; return {}; });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'auto' } }))
      .rejects.toMatchObject({ code: CODES.PERSIST_FAILED });
    expect(state.rows[0].review_reply).toBe('[DRAFT] Agent Ops saved this mid-flight');
    expect(out.abandonClaim).toHaveBeenCalled();
  });
  test('the pipeline\'s own shadow draft in the slot is replaced normally', async () => {
    state.rows[0].review_reply = '[DRAFT] Thanks Dana.';
    state.rows[0].auto_reply_draft = 'Thanks Dana.';
    const r = await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'auto' } });
    expect(r.googlePosted).toBe(true);
    expect(state.rows[0].review_reply).toBe('Thanks Dana.');
  });
});

describe('publishReviewReply — post-publish persistence failure', () => {
  test('Google accepted but the local write threw → PERSIST_FAILED, claim abandoned (not released), no audit', async () => {
    const out = { blocked: false, result: true, releaseClaim: jest.fn(async () => {}), abandonClaim: jest.fn() };
    mockLock.mockImplementationOnce(async (id, fn) => { await fn(); return out; });
    mockGbp.replyToReview.mockImplementationOnce(async () => { state.failNextUpdate = true; return {}; });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'auto' } }))
      .rejects.toMatchObject({ code: CODES.PERSIST_FAILED });
    expect(mockGbp.replyToReview).toHaveBeenCalledTimes(1);
    expect(out.abandonClaim).toHaveBeenCalled();
    expect(out.releaseClaim).not.toHaveBeenCalled();
    expect(state.activity).toHaveLength(0);
    expect(state.rows[0].review_reply).toBeNull();
    // Every caller gets the row parked out of the auto lane (best effort).
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'persist_failed', auto_reply_claimed_until: null });
  });
  test('a zero-row local write after Google accepted (RACE) is a persistence failure too: claim abandoned, row parked', async () => {
    const out = { blocked: false, result: true, releaseClaim: jest.fn(async () => {}), abandonClaim: jest.fn() };
    mockLock.mockImplementationOnce(async (id, fn) => { await fn(); return out; });
    mockGbp.replyToReview.mockImplementationOnce(async () => { state.rows = [{ ...state.rows[0], missing_since: '2026-08-27T00:00:00Z' }]; return {}; });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'auto' } }))
      .rejects.toMatchObject({ code: CODES.PERSIST_FAILED });
    expect(out.abandonClaim).toHaveBeenCalled();
    expect(out.releaseClaim).not.toHaveBeenCalled();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'persist_failed' });
  });
});

describe('retractReviewReply', () => {
  test('deletes on Google under the lock, clears locally, audits', async () => {
    state.rows[0].review_reply = 'Posted reply';
    state.rows[0].auto_reply_status = 'posted';
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: { comment: 'Posted reply' } });
    const r = await retractReviewReply({ reviewId: 'rev-1', actor: { type: 'admin' }, autoFields: { auto_reply_status: 'retracted' } });
    expect(r.googleDeleted).toBe(true);
    expect(mockGbp.deleteReply).toHaveBeenCalledWith('accounts/1/locations/2/reviews/9', 'sarasota', expect.objectContaining({ signal: expect.anything() }));
    expect(state.rows[0].review_reply).toBeNull();
    expect(state.rows[0].auto_reply_status).toBe('retracted');
    expect(state.activity[0].action).toBe('review_reply_retracted');
  });
  test('a row parked because the review was edited after posting can still be retracted', async () => {
    state.rows[0].review_reply = 'Posted reply';
    state.rows[0].auto_reply_status = 'parked';
    state.rows[0].auto_reply_reason = 'review_edited_after_post';
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: { comment: 'Posted reply' } });
    const r = await retractReviewReply({ reviewId: 'rev-1', actor: { type: 'admin' } });
    expect(r.googleDeleted).toBe(true);
  });
  test('nothing to retract on a draft-only or unreplied row', async () => {
    state.rows[0].review_reply = '[DRAFT] not posted';
    await expect(retractReviewReply({ reviewId: 'rev-1', actor: { type: 'admin' } })).rejects.toMatchObject({ code: CODES.HAS_REPLY });
    expect(mockGbp.deleteReply).not.toHaveBeenCalled();
  });
  test('P0: a reply edited directly in Google (unseen locally) is never deleted; the live text is recorded and the posted state closes', async () => {
    state.rows[0].review_reply = 'Posted reply';
    state.rows[0].auto_reply_status = 'posted';
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: { comment: 'Edited in Google', updateTime: '2026-08-27T11:00:00Z' } });
    await expect(retractReviewReply({ reviewId: 'rev-1', actor: { type: 'admin' } })).rejects.toMatchObject({ code: CODES.STALE });
    expect(mockGbp.deleteReply).not.toHaveBeenCalled();
    expect(state.rows[0]).toMatchObject({ review_reply: 'Edited in Google', auto_reply_status: 'skipped', auto_reply_reason: 'edited_on_google' });
    // A repeat Retract now refuses: the reply is the human's, not the pipeline's.
    await expect(retractReviewReply({ reviewId: 'rev-1', actor: { type: 'admin' } })).rejects.toMatchObject({ code: CODES.STALE });
    expect(mockGbp.deleteReply).not.toHaveBeenCalled();
    // Read failure fails closed.
    state.rows[0].review_reply = 'Posted reply';
    state.rows[0].auto_reply_status = 'posted';
    mockGbp.getReview.mockRejectedValueOnce(new Error('GBP 503'));
    await expect(retractReviewReply({ reviewId: 'rev-1', actor: { type: 'admin' } })).rejects.toMatchObject({ code: CODES.GOOGLE_FAILED });
    expect(mockGbp.deleteReply).not.toHaveBeenCalled();
  });
  test('a reply edited by someone else between confirm and lock is not deleted', async () => {
    state.rows[0].review_reply = 'Posted reply';
    state.rows[0].auto_reply_status = 'posted';
    mockLock.mockImplementationOnce(async (id, fn) => {
      // A fresh row object (the real DB returns a new row per read).
      state.rows = [{ ...state.rows[0], review_reply: 'Edited replacement posted first' }];
      const out = liveLock();
      await fn();
      return out;
    });
    await expect(retractReviewReply({ reviewId: 'rev-1', actor: { type: 'admin' } })).rejects.toMatchObject({ code: CODES.STALE });
    expect(mockGbp.deleteReply).not.toHaveBeenCalled();
    expect(state.rows[0].review_reply).toBe('Edited replacement posted first');
  });
  test('deleted on Google but the local clear failed → PERSIST_FAILED, claim abandoned, no audit', async () => {
    state.rows[0].review_reply = 'Posted reply';
    state.rows[0].auto_reply_status = 'posted';
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: { comment: 'Posted reply' } });
    const out = { blocked: false, result: true, releaseClaim: jest.fn(async () => {}), abandonClaim: jest.fn() };
    mockLock.mockImplementationOnce(async (id, fn) => { await fn(); return out; });
    mockGbp.deleteReply.mockImplementationOnce(async () => { state.failNextUpdate = true; return true; });
    await expect(retractReviewReply({ reviewId: 'rev-1', actor: { type: 'admin' } })).rejects.toMatchObject({ code: CODES.PERSIST_FAILED });
    expect(out.abandonClaim).toHaveBeenCalled();
    expect(out.releaseClaim).not.toHaveBeenCalled();
    expect(state.activity).toHaveLength(0);
  });
  test('a DELETE that never completes → GOOGLE_UNCERTAIN, claim abandoned (not released), reply left recorded', async () => {
    process.env.REVIEW_REPLY_GOOGLE_TIMEOUT_MS = '5000';
    state.rows[0].review_reply = 'Posted reply';
    state.rows[0].auto_reply_status = 'posted';
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: { comment: 'Posted reply' } });
    const out = { blocked: false, result: true, releaseClaim: jest.fn(async () => {}), abandonClaim: jest.fn() };
    mockLock.mockImplementationOnce(async (id, fn) => { out.result = await fn(); return out; });
    mockGbp.deleteReply.mockImplementationOnce(() => new Promise(() => {}));
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const p = retractReviewReply({ reviewId: 'rev-1', actor: { type: 'admin' } });
    const assertion = expect(p).rejects.toMatchObject({ code: CODES.GOOGLE_UNCERTAIN });
    await jest.advanceTimersByTimeAsync(31000);
    await assertion;
    jest.useRealTimers();
    expect(out.abandonClaim).toHaveBeenCalled();
    expect(out.releaseClaim).not.toHaveBeenCalled();
    expect(state.rows[0].review_reply).toBe('Posted reply');
  });
  test('a stamped review keeps its recorded reply (evidence row)', async () => {
    state.rows[0].review_reply = 'Posted reply';
    state.rows[0].auto_reply_status = 'posted';
    mockLock.mockResolvedValueOnce({ blocked: true, missing: false });
    await expect(retractReviewReply({ reviewId: 'rev-1', actor: { type: 'admin' } })).rejects.toMatchObject({ code: CODES.MISSING });
    expect(state.rows[0].review_reply).toBe('Posted reply');
  });
});
