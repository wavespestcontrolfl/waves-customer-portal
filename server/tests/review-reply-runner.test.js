// Auto-reply runner: gate modes, jitter anchor, atomic claims, and the
// per-row state machine (park / shadow / post / retry). The drafter,
// publisher, grounding, GBP client and bells are mocked; the runner's own
// decisions are what is under test.
const mockDraft = jest.fn();
const mockPublish = jest.fn();
const mockNotify = jest.fn(async () => ({}));
const mockGbp = { isLocationConfigured: jest.fn(async () => true) };
const state = { rows: [], raws: [] };

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/google-business', () => mockGbp);
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotify(...a) }));
jest.mock('../config/locations', () => ({ WAVES_LOCATIONS: [{ id: 'sarasota', name: 'Sarasota' }, { id: 'venice', name: 'Venice' }] }));
jest.mock('../services/review-reply/grounding', () => ({
  buildReplyGrounding: jest.fn(async (row) => ({ version: 'grounding-v1', reviewId: row.id, review: { rating: row.star_rating, text: row.review_text || '' }, account: null, provenance: {} })),
  loadActiveTechFirstNames: jest.fn(async () => ['Marcus']),
}));
jest.mock('../services/review-reply/drafter', () => ({
  draftReviewReply: (...a) => mockDraft(...a),
  loadRecentPostedReplies: jest.fn(async () => []),
  classifyReplyMode: jest.fn(() => 'service_quality'),
  REPLY_VERSION: 'reply-v1',
}));
jest.mock('../services/review-reply/publisher', () => {
  class ReviewReplyError extends Error {
    constructor(code, message, { status = 500 } = {}) { super(message); this.code = code; this.status = status; }
  }
  return {
    publishReviewReply: (...a) => mockPublish(...a),
    ReviewReplyError,
    CODES: { HAS_REPLY: 'already_replied', MISSING: 'review_missing', RACE: 'removed_during_publish', LOCK_BUSY: 'lock_busy', GOOGLE_FAILED: 'google_failed', NOT_CONFIGURED: 'gbp_not_configured', NO_RESOURCE: 'no_gbp_resource', STALE: 'stale_claim', PERSIST_FAILED: 'persist_failed' },
  };
});
jest.mock('../models/db', () => {
  const dbFn = (table) => {
    const filters = [];
    const api = {
      where(a) {
        if (typeof a === 'function') {
          // needsRealReply branch: whereNull(review_reply) OR like '[DRAFT]%'
          filters.push((r) => r.review_reply == null || String(r.review_reply).startsWith('[DRAFT]'));
        } else {
          filters.push((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        }
        return api;
      },
      whereNull(col) { filters.push((r) => r[col] == null); return api; },
      whereIn(col, vals) { filters.push((r) => vals.includes(r[col])); return api; },
      whereNotNull(col) { filters.push((r) => r[col] != null); return api; },
      orWhere() { return api; },
      select() { return api; },
      groupBy() { return api; },
      count() { return api; },
      min() { return api; },
      async first(...cols) { return state.rows.filter((r) => filters.every((f) => f(r)))[0] || null; },
      async update(patch) {
        const hits = state.rows.filter((r) => filters.every((f) => f(r)));
        hits.forEach((r) => Object.assign(r, patch));
        return hits.length;
      },
      then(res) { return Promise.resolve(state.rows.filter((r) => filters.every((f) => f(r)))).then(res); },
    };
    return api;
  };
  // claimDueRows uses db.raw — emulate the atomic claim over state.rows.
  dbFn.raw = async (sql, params) => {
    state.raws.push(sql);
    const force = /AND id = \?/.test(sql);
    const hasLoc = /lower\(location_id\) = ANY\(\?\)/.test(sql);
    const [token, ...rest] = params;
    const now = new Date(force ? rest[1] : rest[0]);
    const locs = hasLoc ? rest[1] : null;
    const limit = rest[rest.length - 1];
    const hits = state.rows.filter((r) => r.reviewer_name !== '_stats' && r.missing_since == null && !r.dismissed
      && (!locs || locs.includes(String(r.location_id).toLowerCase()))
      && (force ? r.id === rest[0] : (['queued', 'failed'].includes(r.auto_reply_status) && new Date(r.auto_reply_due_at) <= now))
      && (r.auto_reply_claimed_until == null || new Date(r.auto_reply_claimed_until) < now)).slice(0, limit);
    hits.forEach((r) => { r.auto_reply_claimed_until = token; });
    return { rows: hits.map((r) => ({ ...r })) };
  };
  return dbFn;
});

const Runner = require('../services/review-reply/runner');

const NOW = new Date('2026-08-27T15:00:00Z');
function row(over = {}) {
  return {
    id: 'rev-1', location_id: 'sarasota', reviewer_name: 'Dana W.', star_rating: 5, review_text: 'Great work',
    review_reply: null, missing_since: null, review_created_at: '2026-08-27T14:50:00Z',
    auto_reply_status: 'queued', auto_reply_due_at: '2026-08-27T14:55:00Z', auto_reply_claimed_until: null, auto_reply_attempts: 0,
    ...over,
  };
}
const GOOD_DRAFT = { ok: true, text: 'Hi Dana,\n\nThanks.\n\nThe 🌊 Waves Pest Control Sarasota Team', mode: 'service_quality', version: 'reply-v1', attempts: 1, rejections: [] };

beforeEach(() => {
  jest.clearAllMocks();
  state.rows = [];
  state.raws = [];
  delete process.env.GATE_REVIEW_AUTO_REPLY;
  delete process.env.REVIEW_AUTO_REPLY_MIN_STARS;
  delete process.env.REVIEW_AUTO_REPLY_LOCATIONS;
  mockDraft.mockResolvedValue(GOOD_DRAFT);
  mockPublish.mockImplementation(async ({ reviewId, autoFields, guard }) => {
    const r = state.rows.find((x) => x.id === reviewId);
    // Mirrors the real publisher's in-claim recheck: the guard runs on a fresh row.
    const stale = guard ? await guard({ ...r }) : null;
    if (stale) {
      const { ReviewReplyError } = require('../services/review-reply/publisher');
      throw new ReviewReplyError('stale_claim', stale, { status: 409 });
    }
    Object.assign(r, { review_reply: 'posted', ...(autoFields || {}) });
    return { googlePosted: true };
  });
});

describe('gate + config', () => {
  test('mode parses off/shadow/auto, anything else is off', () => {
    expect(Runner.mode()).toBe('off');
    process.env.GATE_REVIEW_AUTO_REPLY = 'true'; expect(Runner.mode()).toBe('off');
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow'; expect(Runner.mode()).toBe('shadow');
    process.env.GATE_REVIEW_AUTO_REPLY = 'AUTO'; expect(Runner.mode()).toBe('auto');
  });
  test('cron tick is a no-op when the gate is off (nothing claimed)', async () => {
    state.rows = [row()];
    const stats = await Runner.processDueAutoReplies();
    expect(stats).toMatchObject({ mode: 'off', claimed: 0 });
    expect(state.raws).toHaveLength(0);
  });
});

describe('computeDueAt — jitter anchored on review creation, clamped when overdue', () => {
  const cfg = { delayMin: 15, delayMax: 180 };
  test('fresh review: created + [15, 180] minutes', () => {
    const created = new Date(NOW.getTime() - 5 * 60000);
    const lo = Runner.computeDueAt(created, { now: NOW, cfg, rand: () => 0 });
    const hi = Runner.computeDueAt(created, { now: NOW, cfg, rand: () => 1 });
    expect(lo.getTime() - created.getTime()).toBe(15 * 60000);
    expect(hi.getTime() - created.getTime()).toBe(180 * 60000);
  });
  test('overdue review (found late by the hourly sync): short delay from now, never instant', () => {
    const created = new Date(NOW.getTime() - 6 * 3600000);
    const due = Runner.computeDueAt(created, { now: NOW, cfg, rand: () => 0 });
    expect(due.getTime() - NOW.getTime()).toBe(5 * 60000);
    const due2 = Runner.computeDueAt(created, { now: NOW, cfg, rand: () => 1 });
    expect(due2.getTime() - NOW.getTime()).toBe(20 * 60000);
  });
  test('missing creation time anchors on now', () => {
    const due = Runner.computeDueAt(null, { now: NOW, cfg, rand: () => 0 });
    expect(due.getTime() - NOW.getTime()).toBe(15 * 60000);
  });
});

describe('autoReplyInsertFields (merged into the sync INSERT)', () => {
  const base = { location_id: 'sarasota', reviewer_name: 'Dana W.', owner_reply: null, review_created_at: '2026-08-27T14:50:00Z' };
  test('gate off → nothing; shadow/auto → queued with a due time', () => {
    expect(Runner.autoReplyInsertFields(base, { now: NOW })).toEqual({});
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow';
    const f = Runner.autoReplyInsertFields(base, { now: NOW });
    expect(f.auto_reply_status).toBe('queued');
    expect(new Date(f.auto_reply_due_at).getTime()).toBeGreaterThan(NOW.getTime());
  });
  test('never queues _stats rows, dismissed rows, replied rows, or disabled locations', () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    expect(Runner.autoReplyInsertFields({ ...base, reviewer_name: '_stats' })).toEqual({});
    expect(Runner.autoReplyInsertFields({ ...base, dismissed: true })).toEqual({});
    expect(Runner.autoReplyInsertFields({ ...base, owner_reply: 'Owner already replied on Google' })).toEqual({});
    expect(Runner.autoReplyInsertFields({ ...base, owner_reply: '[DRAFT] local' }).auto_reply_status).toBe('queued');
    process.env.REVIEW_AUTO_REPLY_LOCATIONS = 'sarasota';
    expect(Runner.autoReplyInsertFields({ ...base, location_id: 'venice' })).toEqual({});
    expect(Runner.autoReplyInsertFields(base).auto_reply_status).toBe('queued');
  });
});

describe('processDueAutoReplies — state machine', () => {
  test('auto mode: 5★ due row is drafted, published via the publisher as actor auto, and bells FYI', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row()];
    const stats = await Runner.processDueAutoReplies();
    expect(stats).toMatchObject({ claimed: 1, posted: 1 });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const call = mockPublish.mock.calls[0][0];
    expect(call.actor).toEqual({ type: 'auto', adminUserId: null });
    expect(call.text).toBe(GOOD_DRAFT.text);
    expect(call.autoFields).toMatchObject({ auto_reply_status: 'posted', auto_reply_mode: 'service_quality', auto_reply_version: 'reply-v1', auto_reply_claimed_until: null });
    expect(JSON.parse(call.autoFields.auto_reply_grounding).review.text).toBeUndefined();
    expect(mockNotify).toHaveBeenCalledWith('review', 'Auto-replied to a review', expect.stringContaining('5★'), expect.objectContaining({ bell: true, dedupeKey: 'review-auto-reply:rev-1:auto_posted' }));
  });

  test('shadow mode: draft lands as [DRAFT] on review_reply, nothing publishes', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow';
    state.rows = [row()];
    const stats = await Runner.processDueAutoReplies();
    expect(stats).toMatchObject({ claimed: 1, drafted: 1, posted: 0 });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(state.rows[0].review_reply).toBe(`[DRAFT] ${GOOD_DRAFT.text}`);
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'drafted', auto_reply_reason: 'shadow', auto_reply_claimed_until: null, auto_reply_draft: GOOD_DRAFT.text });
  });

  test('1-3★ and unrated always park with a draft + action bell, even in auto', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row({ star_rating: 2 }), row({ id: 'rev-0', star_rating: 0 })];
    const stats = await Runner.processDueAutoReplies();
    expect(stats).toMatchObject({ claimed: 2, parked: 2, posted: 0 });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'low_rating' });
    expect(state.rows[0].review_reply.startsWith('[DRAFT]')).toBe(true);
    expect(state.rows[1]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'unrated' });
    expect(mockNotify.mock.calls.every((c) => c[3].metadata.needsAction === true)).toBe(true);
  });

  test('MIN_STARS can only raise the bar; 1-3★ stay human-only even if configured lower', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    process.env.REVIEW_AUTO_REPLY_MIN_STARS = '5';
    state.rows = [row({ star_rating: 4 })];
    await Runner.processDueAutoReplies();
    expect(state.rows[0].auto_reply_status).toBe('parked');
    process.env.REVIEW_AUTO_REPLY_MIN_STARS = '1';
    expect(Runner.config().minStars).toBe(4);
    state.rows = [row({ id: 'r3', star_rating: 3 })];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'low_rating' });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  test('publish calls always require a real Google post (no local-only "posted")', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row()];
    await Runner.processDueAutoReplies();
    expect(mockPublish.mock.calls[0][0].requireGoogle).toBe(true);
  });

  test('already replied on Google / removed / not due / claimed rows are skipped or untouched', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [
      row({ id: 'a', review_reply: 'Owner replied meanwhile' }),
      row({ id: 'b', missing_since: '2026-08-27T14:59:00Z' }),
      row({ id: 'c', auto_reply_due_at: '2099-01-01T00:00:00Z' }),
      row({ id: 'd', auto_reply_claimed_until: '2099-01-01T00:00:00Z' }),
    ];
    const stats = await Runner.processDueAutoReplies();
    expect(stats).toMatchObject({ claimed: 1, skipped: 1 });
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'skipped', auto_reply_reason: 'already_replied' });
    expect(state.rows[1].auto_reply_status).toBe('queued');
    expect(state.rows[2].auto_reply_status).toBe('queued');
    expect(state.rows[3].auto_reply_status).toBe('queued');
    expect(mockDraft).not.toHaveBeenCalled();
  });

  test('dismissed reviews are never claimed, and one dismissed while claimed is skipped', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row({ id: 'd1', dismissed: true })];
    expect(await Runner.processDueAutoReplies()).toMatchObject({ claimed: 0 });
    // Dismissed between claim and processing.
    state.rows = [row({ id: 'd2' })];
    const [claimed] = await Runner.claimDueRows({ limit: 1 });
    state.rows[0].dismissed = true;
    const r = await Runner.processClaimedRow(claimed, { cfg: Runner.config() });
    expect(r).toEqual({ outcome: 'skipped', reason: 'dismissed' });
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'skipped', auto_reply_reason: 'dismissed' });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  test('claim lost before the Google call (admin skip / dismiss cleared the token) → skipped, never posted', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row()];
    const [claimed] = await Runner.claimDueRows({ limit: 1 });
    // Simulate skipAutoReply landing while we draft: token gone, status skipped.
    state.rows[0].auto_reply_claimed_until = null;
    state.rows[0].auto_reply_status = 'skipped';
    const r = await Runner.processClaimedRow(claimed, { cfg: Runner.config() });
    expect(r).toMatchObject({ outcome: 'skipped', reason: 'stale_claim' });
    expect(state.rows[0].review_reply).toBeNull();
  });

  test('dismissCancelFields cancels pending states only', () => {
    const raw = jest.fn((sql) => ({ sql }));
    const f = Runner.dismissCancelFields({ raw });
    expect(f.auto_reply_claimed_until).toBeNull();
    expect(f.auto_reply_status.sql).toContain("THEN 'skipped'");
    expect(f.auto_reply_reason.sql).toContain("THEN 'dismissed'");
  });

  test('verifier reject → parked, no draft text offered, action bell', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    mockDraft.mockResolvedValueOnce({ ok: false, reason: 'verifier_reject', rejections: ['forbidden_name', 'url'], mode: 'service_quality', version: 'reply-v1' });
    state.rows = [row()];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'verifier_reject' });
    expect(state.rows[0].auto_reply_draft).toBeFalsy();
    expect(state.rows[0].review_reply).toBeNull();
    expect(JSON.parse(state.rows[0].auto_reply_error).rejections).toEqual(['forbidden_name', 'url']);
  });

  test('provider outage → failed with backoff, parks after MAX_ATTEMPTS', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    mockDraft.mockResolvedValue({ ok: false, reason: 'provider_unavailable', error: 'all_failed', mode: 'service_quality', version: 'reply-v1' });
    state.rows = [row()];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'failed', auto_reply_attempts: 1, auto_reply_claimed_until: null });
    expect(new Date(state.rows[0].auto_reply_due_at).getTime()).toBeGreaterThan(Date.now());
    state.rows[0].auto_reply_due_at = '2026-08-27T14:00:00Z';
    state.rows[0].auto_reply_attempts = Runner.MAX_ATTEMPTS - 1;
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'provider_down' });
  });

  test('Google failure → retry with backoff (draft kept), then park', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    mockPublish.mockRejectedValue(new ReviewReplyError('google_failed', 'GBP 500', { status: 502 }));
    state.rows = [row()];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'failed', auto_reply_reason: 'google_failed', auto_reply_attempts: 1, auto_reply_draft: GOOD_DRAFT.text });
    state.rows[0].auto_reply_due_at = '2026-08-27T14:00:00Z';
    state.rows[0].auto_reply_attempts = Runner.MAX_ATTEMPTS - 1;
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'google_failed' });
    expect(state.rows[0].review_reply.startsWith('[DRAFT]')).toBe(true);
  });

  test('lock contention shares the retry ceiling and parks after MAX_ATTEMPTS', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    mockPublish.mockRejectedValue(new ReviewReplyError('lock_busy', 'busy', { status: 409 }));
    state.rows = [row()];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'failed', auto_reply_reason: 'lock_busy', auto_reply_attempts: 1 });
    state.rows[0].auto_reply_due_at = '2026-08-27T14:00:00Z';
    state.rows[0].auto_reply_attempts = Runner.MAX_ATTEMPTS - 1;
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'lock_busy' });
    expect(mockNotify.mock.calls.at(-1)[3].metadata.needsAction).toBe(true);
  });

  test('a publish retry reuses the stored verified draft instead of calling the model again', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row({ auto_reply_status: 'failed', auto_reply_reason: 'google_failed', auto_reply_attempts: 1, auto_reply_draft: GOOD_DRAFT.text, auto_reply_version: 'reply-v1', auto_reply_mode: 'service_quality' })];
    await Runner.processDueAutoReplies();
    expect(mockDraft).not.toHaveBeenCalled();
    expect(mockPublish.mock.calls[0][0].text).toBe(GOOD_DRAFT.text);
    expect(state.rows[0].auto_reply_status).toBe('posted');
    // A stale prompt version goes back to the model.
    state.rows = [row({ id: 'v0', auto_reply_status: 'failed', auto_reply_reason: 'google_failed', auto_reply_attempts: 1, auto_reply_draft: 'old', auto_reply_version: 'reply-v0' })];
    await Runner.processDueAutoReplies();
    expect(mockDraft).toHaveBeenCalledTimes(1);
  });

  test('a provider outage after a Google failure does not erase the stored draft', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    mockDraft.mockResolvedValue({ ok: false, reason: 'provider_unavailable', error: 'down', mode: 'service_quality', version: 'reply-v1' });
    state.rows = [row({ auto_reply_status: 'failed', auto_reply_reason: 'provider_unavailable', auto_reply_attempts: Runner.MAX_ATTEMPTS - 1, auto_reply_draft: 'kept', auto_reply_version: 'reply-v1' })];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'provider_down', auto_reply_draft: 'kept' });
  });

  test('PERSIST_FAILED (Google accepted, local write failed) parks for reconciliation and never republishes', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    mockPublish.mockRejectedValueOnce(new ReviewReplyError('persist_failed', 'live but unrecorded', { status: 500 }));
    state.rows = [row()];
    const stats = await Runner.processDueAutoReplies();
    expect(stats.parked).toBe(1);
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'persist_failed', auto_reply_draft: GOOD_DRAFT.text });
    expect(mockNotify.mock.calls.at(-1)[3].metadata).toMatchObject({ reason: 'persist_failed', needsAction: true });
    // Parked rows are not re-claimed.
    await Runner.processDueAutoReplies();
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  test('a draft write that loses the race to a human reply sends no bell and reports skipped', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow';
    state.rows = [row()];
    mockDraft.mockImplementationOnce(async () => { state.rows[0].review_reply = 'Human replied while drafting'; return GOOD_DRAFT; });
    const stats = await Runner.processDueAutoReplies();
    expect(stats).toMatchObject({ skipped: 1, drafted: 0 });
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'skipped', auto_reply_reason: 'changed_during_draft', review_reply: 'Human replied while drafting' });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('narrowing REVIEW_AUTO_REPLY_LOCATIONS stops already-queued rows at claim and at processing', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    process.env.REVIEW_AUTO_REPLY_LOCATIONS = 'sarasota';
    state.rows = [row({ id: 'v', location_id: 'venice' }), row({ id: 's', location_id: 'sarasota' })];
    const stats = await Runner.processDueAutoReplies();
    expect(stats).toMatchObject({ claimed: 1, posted: 1 });
    expect(state.rows[0].auto_reply_status).toBe('queued');
    expect(state.raws[0]).toContain('lower(location_id) = ANY(?)');
    // Processing-time belt: a claimed row whose location was removed parks.
    delete process.env.REVIEW_AUTO_REPLY_LOCATIONS;
    state.rows = [row({ id: 'v2', location_id: 'venice' })];
    const [claimed] = await Runner.claimDueRows({ limit: 1 });
    process.env.REVIEW_AUTO_REPLY_LOCATIONS = 'sarasota';
    const r = await Runner.processClaimedRow(claimed, { cfg: Runner.config() });
    expect(r).toEqual({ outcome: 'parked', reason: 'location_disabled' });
  });

  test('an unhandled runner exception parks with a bell after MAX_ATTEMPTS', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    mockGbp.isLocationConfigured.mockRejectedValue(new Error('boom'));
    state.rows = [row({ auto_reply_attempts: Runner.MAX_ATTEMPTS - 1 })];
    const stats = await Runner.processDueAutoReplies();
    expect(stats.errors).toBe(1);
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'runner_error', auto_reply_attempts: Runner.MAX_ATTEMPTS });
    expect(mockNotify.mock.calls.at(-1)[3].metadata).toMatchObject({ reason: 'runner_error', needsAction: true });
    mockGbp.isLocationConfigured.mockResolvedValue(true);
  });

  test('publisher HAS_REPLY (race with a human) → skipped, not retried', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    mockPublish.mockRejectedValueOnce(new ReviewReplyError('already_replied', 'dup', { status: 409 }));
    state.rows = [row()];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'skipped', auto_reply_reason: 'already_replied' });
  });

  test('location without GBP credentials parks without drafting', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    mockGbp.isLocationConfigured.mockResolvedValueOnce(false);
    state.rows = [row({ location_id: 'venice' })];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'gbp_not_configured' });
    expect(mockDraft).not.toHaveBeenCalled();
  });

  test('a second runner cannot claim a row the first one holds', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row()];
    const [claimed] = await Runner.claimDueRows({ limit: 5 });
    expect(claimed.id).toBe('rev-1');
    const again = await Runner.claimDueRows({ limit: 5 });
    expect(again).toHaveLength(0);
  });
});

describe('admin actions', () => {
  test('postNow publishes an existing verified draft immediately (shadow mode, low rating included) as the admin actor', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow';
    state.rows = [row({ star_rating: 2, auto_reply_status: 'parked', auto_reply_reason: 'low_rating', auto_reply_draft: 'Hi Dana,\n\nSorry.\n\nThe 🌊 Waves Pest Control Sarasota Team', auto_reply_mode: 'low_rating', auto_reply_version: 'reply-v1', review_reply: '[DRAFT] Hi Dana' })];
    const r = await Runner.postNow('rev-1', { type: 'admin', adminUserId: 'u1' });
    expect(r.outcome).toBe('posted');
    expect(mockDraft).not.toHaveBeenCalled();
    expect(mockPublish.mock.calls[0][0]).toMatchObject({ actor: { type: 'admin', adminUserId: 'u1' }, text: expect.stringContaining('Sorry'), requireGoogle: true });
    expect(state.rows[0].auto_reply_status).toBe('posted');
  });
  test('postNow with no draft drafts fresh and publishes even in shadow', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow';
    state.rows = [row({ auto_reply_due_at: '2099-01-01T00:00:00Z' })];
    const r = await Runner.postNow('rev-1', { type: 'admin', adminUserId: 'u1' });
    expect(r.outcome).toBe('posted');
    expect(mockDraft).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });
  test('postNow refuses a row that already has a real reply', async () => {
    state.rows = [row({ review_reply: 'Real reply' })];
    await expect(Runner.postNow('rev-1', { type: 'admin' })).rejects.toMatchObject({ code: 'already_replied' });
    expect(state.rows[0].auto_reply_claimed_until).toBeNull();
  });
  test('skipAutoReply only touches pipeline-pending rows', async () => {
    state.rows = [row(), row({ id: 'p', auto_reply_status: 'posted' })];
    expect(await Runner.skipAutoReply('rev-1')).toBe(true);
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'skipped', auto_reply_reason: 'admin_skip' });
    expect(await Runner.skipAutoReply('p')).toBe(false);
  });
});
