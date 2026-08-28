// Canonical publisher: every reply writer goes draft → verify → liveness
// recheck → publish → persist → audit through here. The Intelligence Bar
// tool used to write locally and claim Google would sync it; these tests pin
// that any human path with GBP configured really calls replyToReview, and
// that automation never fakes a local-only post.
const mockGbp = {
  configured: true,
  getReview: jest.fn(async () => ({ reviewReply: null })),
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
jest.mock('../config/locations', () => ({
  WAVES_LOCATIONS: [{ id: 'sarasota', name: 'Sarasota', googleLocationResourceName: 'accounts/1/locations/2' }],
}));
jest.mock('../models/db', () => {
  const dbFn = (table) => {
    const filters = [];
    const api = {
      where(obj) {
        if (typeof obj === 'function') {
          // ownSlot(): review_reply IS NULL OR review_reply = '[DRAFT] <own draft>'
          const branches = [];
          const sub = {
            whereNull(col) { branches.push((r) => r[col] == null); return sub; },
            orWhere(col, val) { branches.push((r) => r[col] === val); return sub; },
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
  return dbFn;
});

const { publishReviewReply, retractReviewReply, CODES } = require('../services/review-reply/publisher');

function liveLock() {
  return { blocked: false, result: true, releaseClaim: jest.fn(async () => {}), abandonClaim: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGbp.configured = true;
  state.activity = [];
  state.rows = [{
    id: 'rev-1', location_id: 'sarasota', reviewer_name: 'Dana W.', star_rating: 5,
    review_text: 'Great', review_reply: null, gbp_review_name: 'accounts/1/locations/2/reviews/9', missing_since: null,
  }];
  mockLock.mockImplementation(async (id, fn) => { const out = liveLock(); await fn(); return out; });
});

describe('publishReviewReply', () => {
  test('IB path posts to Google inside the liveness lock and records the reply', async () => {
    const r = await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'ib' }, allowOverwrite: true });
    expect(r.googlePosted).toBe(true);
    expect(mockLock).toHaveBeenCalledWith('rev-1', expect.any(Function));
    expect(mockGbp.replyToReview).toHaveBeenCalledWith('accounts/1/locations/2/reviews/9', 'Thanks Dana.', 'sarasota');
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
    mockGbp.getReview.mockResolvedValueOnce({ reviewReply: { comment: 'Owner replied in Google directly', updateTime: '2026-08-27T10:00:00Z' } });
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' } }))
      .rejects.toMatchObject({ code: CODES.HAS_REPLY });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
    expect(state.rows[0].review_reply).toBe('Owner replied in Google directly');
    // A read failure fails closed (retry later), never posts.
    state.rows[0].review_reply = null;
    mockGbp.getReview.mockRejectedValueOnce(new Error('GBP 503'));
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' } }))
      .rejects.toMatchObject({ code: CODES.GOOGLE_FAILED });
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
    // Human overwrite paths do not consult the live resource.
    await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'admin' }, allowOverwrite: true });
    expect(mockGbp.getReview).toHaveBeenCalledTimes(2);
  });

  test('the ownership guard is re-run on a fresh read after the live GET, right before the PUT', async () => {
    let calls = 0;
    const guard = jest.fn(() => (++calls === 2 ? 'auto-reply claim was lost' : null));
    await expect(publishReviewReply({ reviewId: 'rev-1', text: 'x y z', actor: { type: 'auto' }, guard }))
      .rejects.toMatchObject({ code: CODES.STALE });
    expect(guard).toHaveBeenCalledTimes(2);
    expect(mockGbp.replyToReview).not.toHaveBeenCalled();
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
    const r = await publishReviewReply({ reviewId: 'rev-1', text: 'Replacement.', actor: { type: 'admin' }, allowOverwrite: true });
    expect(r.googlePosted).toBe(true);
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
    const r = await publishReviewReply({ reviewId: 'rev-1', text: 'Thanks Dana.', actor: { type: 'admin' } });
    expect(r).toMatchObject({ googlePosted: false, localOnly: true });
    expect(state.rows[0].review_reply).toBe('Thanks Dana.');
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
    expect(mockGbp.deleteReply).toHaveBeenCalledWith('accounts/1/locations/2/reviews/9', 'sarasota');
    expect(state.rows[0].review_reply).toBeNull();
    expect(state.rows[0].auto_reply_status).toBe('retracted');
    expect(state.activity[0].action).toBe('review_reply_retracted');
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
  test('a stamped review keeps its recorded reply (evidence row)', async () => {
    state.rows[0].review_reply = 'Posted reply';
    state.rows[0].auto_reply_status = 'posted';
    mockLock.mockResolvedValueOnce({ blocked: true, missing: false });
    await expect(retractReviewReply({ reviewId: 'rev-1', actor: { type: 'admin' } })).rejects.toMatchObject({ code: CODES.MISSING });
    expect(state.rows[0].review_reply).toBe('Posted reply');
  });
});
