// Auto-reply runner: gate modes, jitter anchor, atomic claims, and the
// per-row state machine (park / shadow / post / retry). The drafter,
// publisher, grounding, GBP client and bells are mocked; the runner's own
// decisions are what is under test.
const mockDraft = jest.fn();
const mockPublish = jest.fn();
const mockNotify = jest.fn(async () => ({}));
const mockAccountFacts = jest.fn(async () => null);
const mockVerify = jest.fn(() => null);
const mockGbp = { isLocationConfigured: jest.fn(async () => true) };
const state = { rows: [], raws: [] };

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/google-business', () => mockGbp);
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotify(...a) }));
jest.mock('../config/locations', () => ({ WAVES_LOCATIONS: [{ id: 'sarasota', name: 'Sarasota' }, { id: 'venice', name: 'Venice' }] }));
jest.mock('../services/review-reply/grounding', () => ({
  buildReplyGrounding: jest.fn(async (row) => ({ version: 'grounding-v1', reviewId: row.id, reviewerName: row.reviewer_name, customerId: row.customer_id || null, review: { rating: row.star_rating, text: row.review_text || '' }, account: null, provenance: {} })),
  loadActiveTechFirstNames: jest.fn(async () => ['Marcus']),
  loadAccountFacts: (...a) => mockAccountFacts(...a),
  accountFingerprint: (a) => (a ? `fp:${a.city || ''}|${a.tenure || ''}` : 'fp:none'),
  groundingCustomerId: (r) => (r && r.customer_id && r.link_source !== 'click_auto' ? r.customer_id : null),
}));
jest.mock('../services/review-reply/drafter', () => ({
  draftReviewReply: (...a) => mockDraft(...a),
  verifyReplyText: (...a) => mockVerify(...a),
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
    CODES: { HAS_REPLY: 'already_replied', MISSING: 'review_missing', RACE: 'removed_during_publish', LOCK_BUSY: 'lock_busy', GOOGLE_FAILED: 'google_failed', NOT_CONFIGURED: 'gbp_not_configured', NO_RESOURCE: 'no_gbp_resource', STALE: 'stale_claim', PERSIST_FAILED: 'persist_failed', REVIEW_CHANGED: 'review_changed', GOOGLE_UNCERTAIN: 'google_uncertain' },
  };
});
jest.mock('../models/db', () => {
  const dbFn = (table) => {
    const filters = [];
    let agg = null; let groupCol = null;
    const hits = () => state.rows.filter((r) => filters.every((f) => f(r)));
    const aggregate = (rows) => {
      const as = agg.as;
      if (agg.kind === 'count') return { [as]: rows.length };
      const vals = rows.map((r) => r[agg.col]).filter((v) => v != null).sort();
      return { [as]: vals[0] || null };
    };
    const api = {
      where(a, b, c) {
        if (typeof a === 'string') {
          if (arguments.length === 3) { filters.push((r) => (b === '>=' ? r[a] >= c : b === '<' ? r[a] < c : r[a] === c)); return api; }
          filters.push((r) => r[a] === b); return api;
        }
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
      whereRaw(sql, params) {
        if (/publish_claimed_until/.test(sql)) filters.push((r) => r.publish_claimed_until == null || new Date(r.publish_claimed_until) < new Date(params[0]));
        return api;
      },
      orWhere() { return api; },
      select() { return api; },
      groupBy(col) { groupCol = col; return api; },
      count(expr) { agg = { kind: 'count', as: (/as (\w+)/.exec(String(expr)) || [])[1] || 'n' }; return api; },
      min(expr) { const [col, as] = String(expr).split(/ as /); agg = { kind: 'min', col, as: as || col }; return api; },
      async first(...cols) { return agg ? aggregate(hits()) : hits()[0] || null; },
      async update(patch) {
        const hits = state.rows.filter((r) => filters.every((f) => f(r)));
        hits.forEach((r) => Object.assign(r, patch));
        return hits.length;
      },
      then(res) {
        if (agg && groupCol) {
          const groups = new Map();
          for (const r of hits()) groups.set(r[groupCol], [...(groups.get(r[groupCol]) || []), r]);
          return Promise.resolve([...groups].map(([k, rows]) => ({ [groupCol]: k, ...aggregate(rows) }))).then(res);
        }
        return Promise.resolve(hits()).then(res);
      },
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
  mockAccountFacts.mockReset().mockResolvedValue(null);
  mockVerify.mockReset().mockReturnValue(null);
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
  test('never queues a review older than the max queue age (fresh-sync rebuilds re-import history)', () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    expect(Runner.autoReplyInsertFields({ ...base, review_created_at: '2026-08-01T00:00:00Z' }, { now: NOW })).toEqual({});
    expect(Runner.autoReplyInsertFields({ ...base, review_created_at: null }, { now: NOW })).toEqual({});
    expect(Runner.autoReplyInsertFields({ ...base, review_created_at: '2026-08-26T20:00:00Z' }, { now: NOW }).auto_reply_status).toBe('queued');
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

  test('manualReplyCloseFields closes pending/posted state only (raw CASE keeps NULL as NULL)', () => {
    const raw = jest.fn((sql) => ({ sql }));
    const f = Runner.manualReplyCloseFields({ raw });
    expect(f.auto_reply_status.sql).toContain("IN ('queued','drafted','parked','failed','posted') THEN 'skipped' ELSE auto_reply_status");
    expect(f.auto_reply_reason.sql).toContain("THEN 'manual_reply' ELSE auto_reply_reason");
    expect(f.auto_reply_claimed_until).toBeNull();
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
    const fp = Runner.reviewFingerprint(row());
    state.rows = [row({ auto_reply_status: 'failed', auto_reply_reason: 'google_failed', auto_reply_attempts: 1, auto_reply_draft: GOOD_DRAFT.text, auto_reply_version: 'reply-v1', auto_reply_mode: 'service_quality', auto_reply_grounding: { fingerprint: fp, accountFingerprint: 'fp:none' } })];
    await Runner.processDueAutoReplies();
    expect(mockDraft).not.toHaveBeenCalled();
    expect(mockPublish.mock.calls[0][0].text).toBe(GOOD_DRAFT.text);
    expect(state.rows[0].auto_reply_status).toBe('posted');
    // A stale prompt version goes back to the model.
    state.rows = [row({ id: 'v0', auto_reply_status: 'failed', auto_reply_reason: 'google_failed', auto_reply_attempts: 1, auto_reply_draft: 'old', auto_reply_version: 'reply-v0', auto_reply_grounding: { fingerprint: fp, accountFingerprint: 'fp:none' } })];
    await Runner.processDueAutoReplies();
    expect(mockDraft).toHaveBeenCalledTimes(1);
    // So does a draft written for different review text (reviewer edited it).
    state.rows = [row({ id: 'ed', review_text: 'Edited: actually not great', auto_reply_status: 'failed', auto_reply_reason: 'google_failed', auto_reply_attempts: 1, auto_reply_draft: GOOD_DRAFT.text, auto_reply_version: 'reply-v1', auto_reply_grounding: { fingerprint: fp, accountFingerprint: 'fp:none' } })];
    await Runner.processDueAutoReplies();
    expect(mockDraft).toHaveBeenCalledTimes(2);
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
    expect(mockNotify.mock.calls.at(-1)[3].link).toBe('/admin/reviews?responded=all&review=rev-1');
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

  test('shadow: a draft written for a review that was edited meanwhile is not saved — the row is re-queued', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow';
    state.rows = [row()];
    mockDraft.mockImplementationOnce(async () => { state.rows[0].star_rating = 2; return GOOD_DRAFT; });
    const stats = await Runner.processDueAutoReplies();
    expect(stats.drafted).toBe(0);
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'queued', auto_reply_reason: 'review_changed', auto_reply_claimed_until: null });
    expect(state.rows[0].review_reply).toBeNull();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('a review edited while drafting (rating/text changed) is re-queued for a fresh draft, never posted stale', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row()];
    mockDraft.mockImplementationOnce(async () => { state.rows[0].star_rating = 2; return GOOD_DRAFT; });
    const stats = await Runner.processDueAutoReplies();
    expect(stats).toMatchObject({ retry: 1, posted: 0 });
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'queued', auto_reply_reason: 'review_changed', auto_reply_claimed_until: null });
    expect(state.rows[0].review_reply).toBeNull();
    // Next tick sees the 2★ and parks it for a human.
    mockDraft.mockResolvedValueOnce({ ...GOOD_DRAFT, mode: 'low_rating' });
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'low_rating' });
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  test('a failed publish persists the grounding snapshot so the retry can reuse the draft', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    mockPublish.mockRejectedValueOnce(new ReviewReplyError('google_failed', 'GBP 500', { status: 502 }));
    state.rows = [row()];
    await Runner.processDueAutoReplies();
    expect(JSON.parse(state.rows[0].auto_reply_grounding).fingerprint).toBe(Runner.reviewFingerprint(row()));
    state.rows[0].auto_reply_due_at = '2026-08-27T14:00:00Z';
    state.rows[0].auto_reply_grounding = JSON.parse(state.rows[0].auto_reply_grounding);
    await Runner.processDueAutoReplies();
    expect(mockDraft).toHaveBeenCalledTimes(1);
    expect(state.rows[0].auto_reply_status).toBe('posted');
  });

  test('NO_RESOURCE (Places-first row) retries on a long backoff and the sync re-queues it when identity lands', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    mockPublish.mockRejectedValueOnce(new ReviewReplyError('no_gbp_resource', 'no match', { status: 502 }));
    state.rows = [row()];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'failed', auto_reply_reason: 'no_gbp_resource', auto_reply_attempts: 1 });
    expect(new Date(state.rows[0].auto_reply_due_at).getTime() - Date.now()).toBeGreaterThan(50 * 60000);
    const parked = { auto_reply_status: 'parked', auto_reply_reason: 'no_gbp_resource', gbp_review_name: null, dismissed: false };
    expect(Runner.requeueFieldsOnIdentity(parked, { gbp_review_name: 'accounts/1/locations/2/reviews/9', owner_reply: null })).toMatchObject({ auto_reply_status: 'queued', auto_reply_reason: 'identity_attached', auto_reply_attempts: 0 });
    expect(Runner.requeueFieldsOnIdentity(parked, { gbp_review_name: 'x', owner_reply: 'Owner replied' })).toEqual({});
    expect(Runner.requeueFieldsOnIdentity({ ...parked, auto_reply_reason: 'low_rating' }, { gbp_review_name: 'x', owner_reply: null })).toEqual({});
  });

  test('postNow on a saved draft after someone already replied closes the draft state', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    mockPublish.mockRejectedValueOnce(new ReviewReplyError('already_replied', 'owner replied on Google', { status: 409 }));
    state.rows = [row({ auto_reply_status: 'drafted', auto_reply_reason: 'shadow', auto_reply_draft: GOOD_DRAFT.text, auto_reply_version: 'reply-v1', auto_reply_grounding: { fingerprint: Runner.reviewFingerprint(row()), accountFingerprint: 'fp:none' }, review_reply: `[DRAFT] ${GOOD_DRAFT.text}` })];
    await expect(Runner.postNow('rev-1', { type: 'admin' })).rejects.toMatchObject({ code: 'already_replied' });
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'skipped', auto_reply_reason: 'already_replied', auto_reply_claimed_until: null });
  });

  test('verifier reject after an admin skip: lost claim → no bell, not reported parked', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row()];
    mockDraft.mockImplementationOnce(async () => {
      state.rows[0].auto_reply_claimed_until = null; state.rows[0].auto_reply_status = 'skipped';
      return { ok: false, reason: 'verifier_reject', rejections: ['url'], mode: 'service_quality', version: 'reply-v1' };
    });
    const stats = await Runner.processDueAutoReplies();
    expect(stats).toMatchObject({ parked: 0, skipped: 1 });
    expect(state.rows[0].auto_reply_status).toBe('skipped');
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('syncReplyFields: owner reply on Google replaces a local draft and closes auto state; live claim defers; empty feed keeps a draft', () => {
    const now = new Date('2026-08-27T15:00:00Z');
    const drafted = { review_reply: '[DRAFT] hi', auto_reply_status: 'drafted', publish_claimed_until: null };
    expect(Runner.syncReplyFields(drafted, { owner_reply: 'Owner replied in Google', owner_reply_updated_at: '2026-08-27T14:00:00Z' }, { now }))
      .toEqual({ review_reply: 'Owner replied in Google', reply_updated_at: '2026-08-27T14:00:00Z', auto_reply_status: 'skipped', auto_reply_reason: 'owner_replied_on_google', auto_reply_claimed_until: null });
    expect(Runner.syncReplyFields(drafted, { owner_reply: null }, { now })).toEqual({});
    expect(Runner.syncReplyFields({ review_reply: 'live', publish_claimed_until: '2099-01-01T00:00:00Z' }, { owner_reply: null }, { now })).toEqual({});
    expect(Runner.syncReplyFields({ review_reply: 'old', auto_reply_status: 'skipped', publish_claimed_until: null }, { owner_reply: null }, { now })).toEqual({ review_reply: null, reply_updated_at: null });
    expect(Runner.syncReplyFields({ review_reply: 'old', auto_reply_status: 'skipped', publish_claimed_until: null }, { owner_reply: 'edited' }, { now, fnNow: 'NOW()' })).toEqual({ review_reply: 'edited', reply_updated_at: 'NOW()' });
  });

  test('a human draft saved while the model was drafting aborts the publish and parks human_draft', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row()];
    mockDraft.mockImplementationOnce(async () => { state.rows[0].review_reply = '[DRAFT] Agent Ops template'; return GOOD_DRAFT; });
    const stats = await Runner.processDueAutoReplies();
    expect(stats).toMatchObject({ parked: 1, posted: 0 });
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'human_draft', review_reply: '[DRAFT] Agent Ops template' });
  });

  test('a reviewer display-name change while drafting invalidates the draft (fingerprint + guard)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row()];
    mockDraft.mockImplementationOnce(async () => { state.rows[0].reviewer_name = 'D. Whitfield'; return GOOD_DRAFT; });
    const stats = await Runner.processDueAutoReplies();
    expect(stats).toMatchObject({ retry: 1, posted: 0 });
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'queued', auto_reply_reason: 'review_changed' });
    expect(Runner.reviewFingerprint(row())).not.toBe(Runner.reviewFingerprint(row({ reviewer_name: 'D. Whitfield' })));
  });

  test('gbp_not_configured retries on the identity backoff, parks after the ceiling, and the GBP sync revives it', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    mockGbp.isLocationConfigured.mockResolvedValueOnce(false);
    state.rows = [row({ location_id: 'venice' })];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'failed', auto_reply_reason: 'gbp_not_configured', auto_reply_attempts: 1 });
    mockGbp.isLocationConfigured.mockResolvedValueOnce(false);
    state.rows[0].auto_reply_due_at = '2026-08-27T14:00:00Z';
    state.rows[0].auto_reply_attempts = Runner.MAX_ATTEMPTS - 1;
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'gbp_not_configured' });
    expect(Runner.requeueFieldsOnIdentity(state.rows[0], { gbp_review_name: 'accounts/1/locations/2/reviews/9', owner_reply: null }))
      .toMatchObject({ auto_reply_status: 'queued', auto_reply_reason: 'gbp_connected', auto_reply_attempts: 0 });
  });

  test('syncReplyFields on a POSTED row: an owner edit in Google closes auto state; a deletion marks it retracted', () => {
    const now = new Date('2026-08-27T15:00:00Z');
    const posted = { review_reply: 'Our auto reply', auto_reply_status: 'posted', publish_claimed_until: null };
    expect(Runner.syncReplyFields(posted, { owner_reply: 'Our auto reply' }, { now })).toEqual({ review_reply: 'Our auto reply', reply_updated_at: now.toISOString() });
    expect(Runner.syncReplyFields(posted, { owner_reply: 'Owner rewrote it' }, { now })).toMatchObject({ review_reply: 'Owner rewrote it', auto_reply_status: 'skipped', auto_reply_reason: 'edited_on_google' });
    expect(Runner.syncReplyFields(posted, { owner_reply: null }, { now })).toEqual({ review_reply: null, reply_updated_at: null, auto_reply_status: 'retracted', auto_reply_reason: 'removed_on_google' });
  });

  test('a customer re-attribution while drafting invalidates the draft (account facts derive from it)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row({ customer_id: 'cust-a' })];
    mockDraft.mockImplementationOnce(async () => { state.rows[0].customer_id = 'cust-b'; return GOOD_DRAFT; });
    const stats = await Runner.processDueAutoReplies();
    expect(stats).toMatchObject({ retry: 1, posted: 0 });
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'queued', auto_reply_reason: 'review_changed' });
    expect(Runner.reviewFingerprint(row({ customer_id: 'cust-a' }))).not.toBe(Runner.reviewFingerprint(row({ customer_id: 'cust-b' })));
  });

  test('an account-fact change (city corrected) while drafting or before a retry invalidates the draft', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row({ customer_id: 'cust-a' })];
    mockAccountFacts.mockResolvedValueOnce({ city: 'Venice', tenure: 'new' }); // at draft time (via snapshot)
    mockAccountFacts.mockResolvedValueOnce({ city: 'Sarasota', tenure: 'new' }); // at the pre-PUT guard
    // The grounding mock has account null; make the snapshot carry the draft-time fingerprint.
    const { buildReplyGrounding } = require('../services/review-reply/grounding');
    buildReplyGrounding.mockImplementationOnce(async (r) => ({ version: 'grounding-v1', reviewId: r.id, reviewerName: r.reviewer_name, customerId: r.customer_id, review: { rating: r.star_rating, text: r.review_text || '' }, account: await mockAccountFacts(r.customer_id), provenance: {} }));
    const stats = await Runner.processDueAutoReplies();
    expect(stats).toMatchObject({ retry: 1, posted: 0 });
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'queued', auto_reply_reason: 'review_changed' });
    // Reuse on retry also requires the account fingerprint to match.
    state.rows = [row({ customer_id: 'cust-a', auto_reply_status: 'failed', auto_reply_reason: 'google_failed', auto_reply_attempts: 1, auto_reply_draft: GOOD_DRAFT.text, auto_reply_version: 'reply-v1', auto_reply_grounding: { fingerprint: Runner.reviewFingerprint(row({ customer_id: 'cust-a' })), accountFingerprint: 'fp:Venice|new' } })];
    mockAccountFacts.mockResolvedValue({ city: 'Sarasota', tenure: 'new' });
    await Runner.processDueAutoReplies();
    expect(mockDraft).toHaveBeenCalledTimes(2); // 1 = the original draft, 2 = redraft (stale account facts)
  });

  test('applySyncReplyFields is conditioned on the publish claim at WRITE time (claim acquired after the sync read)', async () => {
    // Snapshot said "no claim", but a publisher claimed + persisted before the write.
    state.rows = [row({ review_reply: 'Just posted by the publisher', publish_claimed_until: '2099-01-01T00:00:00Z', auto_reply_status: 'posted' })];
    const n = await Runner.applySyncReplyFields('rev-1', { review_reply: null, reply_updated_at: null });
    expect(n).toBe(0);
    expect(state.rows[0].review_reply).toBe('Just posted by the publisher');
    state.rows[0].publish_claimed_until = null;
    expect(await Runner.applySyncReplyFields('rev-1', { review_reply: 'from feed', reply_updated_at: 'x' })).toBe(1);
    expect(state.rows[0].review_reply).toBe('from feed');
    expect(await Runner.applySyncReplyFields('rev-1', {})).toBe(0);
    // Compare-and-set: a draft saved after the snapshot is never cleared by a stale empty-feed write.
    state.rows[0].review_reply = '[DRAFT] saved after the sync read';
    expect(await Runner.applySyncReplyFields('rev-1', { review_reply: null, reply_updated_at: null }, { expectedReply: 'from feed' })).toBe(0);
    expect(state.rows[0].review_reply).toBe('[DRAFT] saved after the sync read');
    state.rows[0].review_reply = null;
    expect(await Runner.applySyncReplyFields('rev-1', { review_reply: 'owner', reply_updated_at: 'x' }, { expectedReply: null })).toBe(1);
  });

  test('a reused draft is re-verified against current replies; a failing one is redrafted', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const fp = Runner.reviewFingerprint(row());
    state.rows = [row({ auto_reply_status: 'failed', auto_reply_reason: 'google_failed', auto_reply_attempts: 1, auto_reply_draft: GOOD_DRAFT.text, auto_reply_version: 'reply-v1', auto_reply_grounding: { fingerprint: fp, accountFingerprint: 'fp:none' } })];
    mockVerify.mockReturnValueOnce('repetitive_opening');
    await Runner.processDueAutoReplies();
    expect(mockVerify).toHaveBeenCalledWith(GOOD_DRAFT.text, expect.any(Object), expect.objectContaining({ recentReplies: expect.any(Array) }));
    expect(mockDraft).toHaveBeenCalledTimes(1);
    expect(state.rows[0].auto_reply_status).toBe('posted');
  });

  test('applyRequeueOnIdentity only revives a row STILL parked for the snapshot reason (an admin Skip wins)', async () => {
    const parked = row({ id: 'p', auto_reply_status: 'parked', auto_reply_reason: 'no_gbp_resource', gbp_review_name: null, dismissed: false });
    state.rows = [{ ...parked, auto_reply_status: 'skipped', auto_reply_reason: 'admin_skip' }];
    expect(await Runner.applyRequeueOnIdentity('p', parked, { gbp_review_name: 'accounts/1/locations/2/reviews/9', owner_reply: null })).toBe(0);
    expect(state.rows[0].auto_reply_status).toBe('skipped');
    state.rows = [{ ...parked }];
    expect(await Runner.applyRequeueOnIdentity('p', parked, { gbp_review_name: 'accounts/1/locations/2/reviews/9', owner_reply: null })).toBe(1);
    expect(state.rows[0].auto_reply_status).toBe('queued');
  });

  test('publisher REVIEW_CHANGED (live review differs from the synced row) → re-queued AFTER the next sync window, not every tick', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    mockPublish.mockRejectedValueOnce(new ReviewReplyError('review_changed', 'changed on Google', { status: 409 }));
    state.rows = [row()];
    const stats = await Runner.processDueAutoReplies();
    expect(stats).toMatchObject({ retry: 1 });
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'queued', auto_reply_reason: 'review_changed' });
    expect(new Date(state.rows[0].auto_reply_due_at).getTime() - Date.now()).toBeGreaterThan(50 * 60000);
  });

  test('postNow with a draft whose account facts went stale drafts fresh instead of failing', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow';
    state.rows = [row({ customer_id: 'cust-a', auto_reply_status: 'drafted', auto_reply_reason: 'shadow', auto_reply_draft: 'old draft', auto_reply_version: 'reply-v1', auto_reply_grounding: { fingerprint: Runner.reviewFingerprint(row({ customer_id: 'cust-a' })), accountFingerprint: 'fp:Venice|new' }, review_reply: '[DRAFT] old draft' })];
    mockAccountFacts.mockResolvedValue({ city: 'Sarasota', tenure: 'new' });
    const { buildReplyGrounding } = require('../services/review-reply/grounding');
    buildReplyGrounding.mockImplementationOnce(async (r) => ({ version: 'grounding-v1', reviewId: r.id, reviewerName: r.reviewer_name, customerId: r.customer_id, review: { rating: r.star_rating, text: r.review_text || '' }, account: await mockAccountFacts(r.customer_id), provenance: {} }));
    const r = await Runner.postNow('rev-1', { type: 'admin', adminUserId: 'u1' });
    expect(r.outcome).toBe('posted');
    expect(mockDraft).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0][0].text).toBe(GOOD_DRAFT.text);
  });

  test('an exhausted runner error after an admin cancelled the claim sends no bell', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    mockGbp.isLocationConfigured.mockImplementationOnce(async () => { state.rows[0].auto_reply_claimed_until = null; state.rows[0].auto_reply_status = 'skipped'; throw new Error('boom'); });
    state.rows = [row({ auto_reply_attempts: Runner.MAX_ATTEMPTS - 1 })];
    const stats = await Runner.processDueAutoReplies();
    expect(stats.errors).toBe(1);
    expect(state.rows[0].auto_reply_status).toBe('skipped');
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('postNow releases its claim when an error happens before the publish stage', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    mockGbp.isLocationConfigured.mockRejectedValueOnce(new Error('token store down'));
    state.rows = [row({ auto_reply_due_at: '2099-01-01T00:00:00Z' })];
    await expect(Runner.postNow('rev-1', { type: 'admin' })).rejects.toThrow('token store down');
    expect(state.rows[0].auto_reply_claimed_until).toBeNull();
    expect(state.rows[0].auto_reply_status).toBe('queued');
  });

  test('GOOGLE_UNCERTAIN (PUT timed out, may be live) → parked with an action bell, never retried', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    mockPublish.mockImplementationOnce(async ({ reviewId }) => { const r = state.rows.find((x) => x.id === reviewId); Object.assign(r, { auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain', auto_reply_claimed_until: null }); throw new ReviewReplyError('google_uncertain', 'timed out', { status: 502 }); });
    state.rows = [row()];
    const stats = await Runner.processDueAutoReplies();
    expect(stats.parked).toBe(1);
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain', auto_reply_draft: GOOD_DRAFT.text });
    expect(mockNotify.mock.calls.at(-1)[3].metadata).toMatchObject({ reason: 'google_uncertain', needsAction: true });
    await Runner.processDueAutoReplies();
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  test('reviewEditFields: a reviewer edit on a POSTED row parks it for a person', () => {
    const posted = row({ auto_reply_status: 'posted' });
    expect(Runner.reviewEditFields(posted, { star_rating: 5, review_text: 'Great work', reviewer_name: 'Dana W.' })).toEqual({});
    expect(Runner.reviewEditFields(posted, { star_rating: 1, review_text: 'Actually terrible', reviewer_name: 'Dana W.' })).toEqual({ auto_reply_status: 'parked', auto_reply_reason: 'review_edited_after_post' });
    expect(Runner.reviewEditFields(row({ auto_reply_status: 'skipped' }), { star_rating: 1, review_text: 'x', reviewer_name: 'Dana W.' })).toEqual({});
  });
  test('reviewEditFields: a reviewer edit clears a pipeline-owned draft and requeues; human drafts and reconciliation parks are left alone', () => {
    const edit = { star_rating: 1, review_text: 'Actually terrible', reviewer_name: 'Dana W.' };
    const draft = 'Hi Dana,\n\nGlad the ants are gone.\n\nThe 🌊 Waves Pest Control Sarasota Team';
    const shadow = row({ auto_reply_status: 'drafted', auto_reply_reason: 'shadow', auto_reply_draft: draft, review_reply: `[DRAFT] ${draft}`, auto_reply_attempts: 2 });
    expect(Runner.reviewEditFields(shadow, edit)).toEqual(expect.objectContaining({
      auto_reply_status: 'queued', auto_reply_reason: 'review_changed', auto_reply_attempts: 0,
      auto_reply_draft: null, auto_reply_drafted_at: null, auto_reply_grounding: null, review_reply: null, reply_updated_at: null,
    }));
    // Same review → nothing.
    expect(Runner.reviewEditFields(shadow, { star_rating: 5, review_text: 'Great work', reviewer_name: 'Dana W.' })).toEqual({});
    // Parked with a pipeline draft (e.g. google_failed) → requeue as well; a draft-less queued row has nothing to clear.
    expect(Runner.reviewEditFields(row({ auto_reply_status: 'parked', auto_reply_reason: 'google_failed', auto_reply_draft: draft }), edit).auto_reply_status).toBe('queued');
    expect(Runner.reviewEditFields(row({ auto_reply_status: 'queued' }), edit)).toEqual({});
    // A human's [DRAFT] is theirs; reconciliation parks may have a live PUT.
    expect(Runner.reviewEditFields(row({ auto_reply_status: 'parked', auto_reply_reason: 'human_draft', auto_reply_draft: draft, review_reply: '[DRAFT] the owner wrote this' }), edit)).toEqual({});
    expect(Runner.reviewEditFields(row({ auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain', auto_reply_draft: draft, review_reply: `[DRAFT] ${draft}` }), edit)).toEqual({});
  });
  test('applyReviewEditFields is a compare-and-set on the snapshot state and reply slot', async () => {
    const draft = 'Hi Dana,\n\nGlad.\n\nThe 🌊 Waves Pest Control Sarasota Team';
    const snap = row({ auto_reply_status: 'drafted', auto_reply_reason: 'shadow', auto_reply_draft: draft, review_reply: `[DRAFT] ${draft}` });
    const edit = { star_rating: 1, review_text: 'Actually terrible', reviewer_name: 'Dana W.' };
    // A human saved their own draft after the snapshot: the sync must not clear it.
    state.rows = [{ ...snap, review_reply: '[DRAFT] owner text' }];
    expect(await Runner.applyReviewEditFields('rev-1', snap, edit)).toBe(0);
    expect(state.rows[0].review_reply).toBe('[DRAFT] owner text');
    // Unchanged since the snapshot: cleared and requeued.
    state.rows = [{ ...snap }];
    expect(await Runner.applyReviewEditFields('rev-1', snap, edit)).toBe(1);
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'queued', auto_reply_reason: 'review_changed', auto_reply_draft: null, review_reply: null });
  });
  test('autoReplyStatus counts shadow-eligible drafts historically (acted-on drafts stay in the sample; 1-3★ never count)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow';
    state.rows = [
      row({ id: 'a', star_rating: 5, auto_reply_status: 'drafted', auto_reply_reason: 'shadow', auto_reply_drafted_at: '2026-08-21T00:00:00Z' }),
      row({ id: 'b', star_rating: 5, auto_reply_status: 'posted', auto_reply_drafted_at: '2026-08-20T00:00:00Z', review_reply: 'posted' }), // Post now
      row({ id: 'c', star_rating: 4, auto_reply_status: 'skipped', auto_reply_reason: 'manual_reply', auto_reply_drafted_at: '2026-08-22T00:00:00Z', review_reply: 'by hand' }),
      row({ id: 'd', star_rating: 2, auto_reply_status: 'parked', auto_reply_reason: 'low_rating', auto_reply_drafted_at: '2026-08-19T00:00:00Z' }),
      row({ id: 'e', star_rating: 5, auto_reply_status: 'queued' }),
    ];
    const st = await Runner.autoReplyStatus();
    expect(st.shadowDrafts).toBe(3);
    expect(st.firstShadowDraftAt).toBe('2026-08-20T00:00:00Z');
    expect(st.draftsTotal).toBe(4);
    expect(st.byStatus).toEqual({ drafted: 1, posted: 1, skipped: 1, parked: 1, queued: 1 });
  });

  test('a review skipped as missing is re-queued when the authoritative sync sees it live again', async () => {
    const skipped = row({ id: 'm', auto_reply_status: 'skipped', auto_reply_reason: 'missing', missing_since: '2026-08-20T00:00:00Z' });
    expect(Runner.requeueFieldsOnIdentity(skipped, { gbp_review_name: 'accounts/1/locations/2/reviews/9', owner_reply: null })).toMatchObject({ auto_reply_status: 'queued', auto_reply_reason: 'reinstated' });
    expect(Runner.requeueFieldsOnIdentity({ ...skipped, auto_reply_reason: 'admin_skip' }, { gbp_review_name: 'x', owner_reply: null })).toEqual({});
    state.rows = [{ ...skipped }];
    expect(await Runner.applyRequeueOnIdentity('m', skipped, { gbp_review_name: 'x', owner_reply: null })).toBe(1);
    expect(state.rows[0].auto_reply_status).toBe('queued');
  });

  test('publisher HAS_REPLY (race with a human) → skipped, not retried', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    mockPublish.mockRejectedValueOnce(new ReviewReplyError('already_replied', 'dup', { status: 409 }));
    state.rows = [row()];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'skipped', auto_reply_reason: 'already_replied' });
  });

  test('location without GBP credentials defers without drafting', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    mockGbp.isLocationConfigured.mockResolvedValueOnce(false);
    state.rows = [row({ location_id: 'venice' })];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'failed', auto_reply_reason: 'gbp_not_configured' });
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
    state.rows = [row({ star_rating: 2, auto_reply_status: 'parked', auto_reply_reason: 'low_rating', auto_reply_draft: 'Hi Dana,\n\nSorry.\n\nThe 🌊 Waves Pest Control Sarasota Team', auto_reply_mode: 'low_rating', auto_reply_version: 'reply-v1', review_reply: '[DRAFT] Hi Dana,\n\nSorry.\n\nThe 🌊 Waves Pest Control Sarasota Team', auto_reply_grounding: { fingerprint: Runner.reviewFingerprint(row({ star_rating: 2 })), accountFingerprint: 'fp:none' } })];
    const r = await Runner.postNow('rev-1', { type: 'admin', adminUserId: 'u1' });
    expect(r.outcome).toBe('posted');
    expect(mockDraft).not.toHaveBeenCalled();
    expect(mockPublish.mock.calls[0][0]).toMatchObject({ actor: { type: 'admin', adminUserId: 'u1' }, text: expect.stringContaining('Sorry'), requireGoogle: true });
    expect(state.rows[0].auto_reply_status).toBe('posted');
  });
  test('postNow re-verifies a stored AUTO draft against current posted replies; a failing verdict drafts fresh', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow';
    const stored = 'Hi Dana,\n\nGlad the ants are gone.\n\nThe 🌊 Waves Pest Control Sarasota Team';
    const mk = () => row({ auto_reply_status: 'drafted', auto_reply_reason: 'shadow', auto_reply_draft: stored, auto_reply_mode: 'results', auto_reply_version: 'reply-v1', auto_reply_grounding: { fingerprint: Runner.reviewFingerprint(row()), accountFingerprint: 'fp:none' } });
    // Still verifies → published as stored, no model call, verifier saw the current replies.
    state.rows = [mk()];
    let r = await Runner.postNow('rev-1', { type: 'admin', adminUserId: 'u1' });
    expect(r.outcome).toBe('posted');
    expect(mockDraft).not.toHaveBeenCalled();
    expect(mockVerify).toHaveBeenCalledWith(stored, expect.objectContaining({ reviewId: 'rev-1' }), expect.objectContaining({ recentReplies: [], mode: 'results' }));
    expect(mockPublish.mock.calls[0][0].text).toBe(stored);
    // Another review posted the same opening since → verdict fails → fresh draft, not the stale text.
    jest.clearAllMocks();
    mockVerify.mockReturnValueOnce('repeated_opening');
    state.rows = [mk()];
    r = await Runner.postNow('rev-1', { type: 'admin', adminUserId: 'u1' });
    expect(r.outcome).toBe('posted');
    expect(mockDraft).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0][0].text).toBe(GOOD_DRAFT.text);
    expect(state.rows[0].auto_reply_status).toBe('posted');
  });
  test('postNow does not re-verify a human [DRAFT] (the admin\'s own text is the payload)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow';
    const human = 'Hi Dana,\n\nThe owner wrote this.\n\nThe 🌊 Waves Pest Control Sarasota Team';
    state.rows = [row({ auto_reply_status: 'parked', auto_reply_reason: 'human_draft', review_reply: `[DRAFT] ${human}`, auto_reply_draft: 'Hi Dana,\n\nOld auto draft.\n\nThe 🌊 Waves Pest Control Sarasota Team', auto_reply_version: 'reply-v1', auto_reply_grounding: { fingerprint: Runner.reviewFingerprint(row()), accountFingerprint: 'fp:none' } })];
    const r = await Runner.postNow('rev-1', { type: 'admin', adminUserId: 'u1' });
    expect(r.outcome).toBe('posted');
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockPublish.mock.calls[0][0].text).toBe(human);
  });
  test('postNow with no draft drafts fresh and publishes even in shadow', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow';
    state.rows = [row({ auto_reply_due_at: '2099-01-01T00:00:00Z' })];
    const r = await Runner.postNow('rev-1', { type: 'admin', adminUserId: 'u1' });
    expect(r.outcome).toBe('posted');
    expect(mockDraft).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });
  test('postNow: PERSIST_FAILED on an existing draft parks for reconciliation, never back to the retry lane', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    mockPublish.mockRejectedValueOnce(new ReviewReplyError('persist_failed', 'live but unrecorded', { status: 500 }));
    state.rows = [row({ auto_reply_status: 'failed', auto_reply_reason: 'google_failed', auto_reply_draft: GOOD_DRAFT.text, auto_reply_version: 'reply-v1', auto_reply_mode: 'service_quality', auto_reply_grounding: { fingerprint: Runner.reviewFingerprint(row()), accountFingerprint: 'fp:none' } })];
    await expect(Runner.postNow('rev-1', { type: 'admin', adminUserId: 'u1' })).rejects.toMatchObject({ code: 'persist_failed' });
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'persist_failed', auto_reply_claimed_until: null });
    // The cron must not pick it up again.
    await Runner.processDueAutoReplies();
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  test('a human [DRAFT] on a queued row is a human intervention: cron parks it untouched, Post-now publishes THAT text', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row({ review_reply: '[DRAFT] Hi Dana, thank you for the kind review. - Waves Pest Control' })];
    const stats = await Runner.processDueAutoReplies();
    expect(stats).toMatchObject({ parked: 1, posted: 0 });
    expect(mockDraft).not.toHaveBeenCalled();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'human_draft', review_reply: '[DRAFT] Hi Dana, thank you for the kind review. - Waves Pest Control' });
    const r = await Runner.postNow('rev-1', { type: 'admin', adminUserId: 'u1' });
    expect(r.outcome).toBe('posted');
    expect(mockDraft).not.toHaveBeenCalled();
    expect(mockPublish.mock.calls[0][0].text).toBe('Hi Dana, thank you for the kind review. - Waves Pest Control');
  });

  test('posted bells deep-link to the responded view and the review; parked bells to the review', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row(), row({ id: 'low', star_rating: 2 })];
    await Runner.processDueAutoReplies();
    const links = mockNotify.mock.calls.map((c) => c[3].link);
    expect(links).toContain('/admin/reviews?responded=responded&review=rev-1');
    expect(links).toContain('/admin/reviews?review=low');
  });

  test('postNow refuses a row that already has a real reply', async () => {
    state.rows = [row({ review_reply: 'Real reply' })];
    await expect(Runner.postNow('rev-1', { type: 'admin' })).rejects.toMatchObject({ code: 'already_replied' });
    expect(state.rows[0].auto_reply_claimed_until).toBeNull();
  });
  test('skipAutoReply only touches pipeline-pending rows and refuses while a publish claim is live', async () => {
    state.rows = [row(), row({ id: 'p', auto_reply_status: 'posted' }), row({ id: 'inflight', publish_claimed_until: '2099-01-01T00:00:00Z' })];
    expect(await Runner.skipAutoReply('rev-1')).toBe(true);
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'skipped', auto_reply_reason: 'admin_skip' });
    expect(await Runner.skipAutoReply('p')).toBe(false);
    expect(await Runner.skipAutoReply('inflight')).toBe(false);
    expect(state.rows[2].auto_reply_status).toBe('queued');
  });
});
