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
    CODES: { HAS_REPLY: 'already_replied', MISSING: 'review_missing', RACE: 'removed_during_publish', LOCK_BUSY: 'lock_busy', GOOGLE_FAILED: 'google_failed', NOT_CONFIGURED: 'gbp_not_configured', NO_RESOURCE: 'no_gbp_resource', STALE: 'stale_claim', PERSIST_FAILED: 'persist_failed', REVIEW_CHANGED: 'review_changed', GOOGLE_UNCERTAIN: 'google_uncertain', RECONCILE_FAILED: 'reconcile_failed' },
  };
});
jest.mock('../models/db', () => {
  const dbFn = (table) => {
    if (table === 'knex_migrations') {
      const mig = { where() { return mig; }, orderBy() { return mig; }, async first() { return state.migration || null; } };
      return mig;
    }
    const filters = [];
    let agg = null; let groupCol = null; let order = null; let limitN = null;
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
          if (arguments.length === 3) { filters.push((r) => (b === '>=' ? r[a] >= c : b === '<' ? r[a] < c : (b === '!=' || b === '<>') ? r[a] !== c : b === 'like' ? (r[a] != null && new RegExp('^' + String(c).split('%').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 's').test(String(r[a]))) : r[a] === c)); return api; }
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
      forUpdate() { return api; },
      whereRaw(sql, params) {
        if (/publish_claimed_until/.test(sql)) filters.push((r) => r.publish_claimed_until == null || new Date(r.publish_claimed_until) < new Date(params[0]));
        if (/auto_reply_claimed_until IS NULL OR auto_reply_claimed_until </.test(sql)) filters.push((r) => r.auto_reply_claimed_until == null || new Date(r.auto_reply_claimed_until) < new Date(params[0]));
        if (/auto_reply_grounding->'review'->>'rating'/.test(sql)) filters.push((r) => (Number(r.auto_reply_grounding?.review?.rating) || Number(r.star_rating) || 0) >= params[0]);
        if (/COALESCE\(dismissed, false\) = false/.test(sql)) filters.push((r) => !r.dismissed);
        if (/auto_reply_version, ''\) NOT IN/.test(sql)) filters.push((r) => !['human', 'agent_ops'].includes(r.auto_reply_version || ''));
        if (/lower\(location_id\) = ANY/.test(sql)) filters.push((r) => params[0].includes(String(r.location_id).toLowerCase()));
        return api;
      },
      orWhere() { return api; },
      modify(fn, ...args) { fn(api, ...args); return api; },
      orderBy(col, dir) { order = { col, dir: dir || 'asc' }; return api; },
      limit(n) { limitN = n; return api; },
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
        let out = hits();
        if (order) out = [...out].sort((x, y) => (x[order.col] < y[order.col] ? -1 : x[order.col] > y[order.col] ? 1 : 0) * (order.dir === 'desc' ? -1 : 1));
        if (limitN != null) out = out.slice(0, limitN);
        return Promise.resolve(out).then(res);
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
    const cutoff = force ? null : rest[1];
    const locs = hasLoc ? rest[2] : null;
    const limit = rest[rest.length - 1];
    const hits = state.rows.filter((r) => r.reviewer_name !== '_stats' && r.missing_since == null && !r.dismissed
      && (!locs || locs.includes(String(r.location_id).toLowerCase()))
      && (force ? (r.id === rest[0] && !['skipped', 'retracted'].includes(r.auto_reply_status)) : (['queued', 'failed'].includes(r.auto_reply_status) && new Date(r.auto_reply_due_at) <= now && r.review_created_at >= cutoff))
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
    // Relative: the claim applies the 48h deploy-forward cutoff against the
    // real clock (codex r74), so a fixed date would rot.
    review_reply: null, missing_since: null, review_created_at: new Date(Date.now() - 10 * 60000).toISOString(),
    auto_reply_status: 'queued', auto_reply_due_at: '2026-08-27T14:55:00Z', auto_reply_claimed_until: null, auto_reply_attempts: 0,
    ...over,
  };
}
const GOOD_DRAFT = { ok: true, text: 'Hi Dana,\n\nThanks.\n\nThe 🌊 Waves Pest Control Sarasota Team', mode: 'service_quality', version: 'reply-v1', attempts: 1, rejections: [] };

beforeEach(() => {
  jest.clearAllMocks();
  state.rows = [];
  state.raws = [];
  state.migration = { migration_time: '2026-08-27T12:00:00Z' };
  Runner._resetRolloutCutoffCache();
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
    // Frozen clock (codex r23): the fixture's review_created_at is a fixed
    // date and the 48h max queue age is measured from `now`.
    expect(Runner.autoReplyInsertFields({ ...base, reviewer_name: '_stats' }, { now: NOW })).toEqual({});
    expect(Runner.autoReplyInsertFields({ ...base, dismissed: true }, { now: NOW })).toEqual({});
    expect(Runner.autoReplyInsertFields({ ...base, owner_reply: 'Owner already replied on Google' }, { now: NOW })).toEqual({});
    expect(Runner.autoReplyInsertFields({ ...base, owner_reply: '[DRAFT] local' }, { now: NOW }).auto_reply_status).toBe('queued');
    process.env.REVIEW_AUTO_REPLY_LOCATIONS = 'sarasota';
    expect(Runner.autoReplyInsertFields({ ...base, location_id: 'venice' }, { now: NOW })).toEqual({});
    expect(Runner.autoReplyInsertFields(base, { now: NOW }).auto_reply_status).toBe('queued');
  });
});

describe('enqueueMissedReviews — catch-up for rows the insert-time gate skipped', () => {
  test('queues NULL-state rows inside the max age once the switch is on; history, replied, dismissed, out-of-scope and already-stated rows stay put; off = nothing', async () => {
    const now = new Date('2026-08-27T16:00:00Z');
    const rows = () => [
      row({ id: 'fresh', auto_reply_status: null, auto_reply_due_at: null, review_created_at: '2026-08-27T15:00:00Z' }),
      row({ id: 'old', auto_reply_status: null, auto_reply_due_at: null, review_created_at: '2026-08-20T15:00:00Z' }),
      row({ id: 'replied', auto_reply_status: null, auto_reply_due_at: null, review_created_at: '2026-08-27T15:00:00Z', review_reply: 'Owner replied' }),
      row({ id: 'dismissed', auto_reply_status: null, auto_reply_due_at: null, review_created_at: '2026-08-27T15:00:00Z', dismissed: true }),
      row({ id: 'venice', auto_reply_status: null, auto_reply_due_at: null, review_created_at: '2026-08-27T15:00:00Z', location_id: 'venice' }),
      row({ id: 'stats', auto_reply_status: null, auto_reply_due_at: null, review_created_at: '2026-08-27T15:00:00Z', reviewer_name: '_stats' }),
      row({ id: 'done', auto_reply_status: 'skipped', review_created_at: '2026-08-27T15:00:00Z' }),
      // Inserted BEFORE the auto-reply migration ran (pre-deploy history): never queued (owner ruling).
      row({ id: 'prehook', auto_reply_status: null, auto_reply_due_at: null, review_created_at: '2026-08-27T15:00:00Z', created_at: '2026-08-27T11:00:00Z' }),
    ].map((r) => ({ created_at: '2026-08-27T15:05:00Z', ...r }));
    state.rows = rows();
    expect(await Runner.enqueueMissedReviews({ now })).toBe(0); // gate unset = off
    expect(state.rows.every((r) => r.id === 'done' || r.auto_reply_status == null)).toBe(true);
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow';
    process.env.REVIEW_AUTO_REPLY_LOCATIONS = 'sarasota';
    expect(await Runner.enqueueMissedReviews({ now })).toBe(1);
    const by = Object.fromEntries(state.rows.map((r) => [r.id, r]));
    expect(by.fresh.auto_reply_status).toBe('queued');
    expect(new Date(by.fresh.auto_reply_due_at).getTime()).toBeGreaterThan(now.getTime());
    for (const id of ['old', 'replied', 'dismissed', 'venice', 'stats', 'prehook']) expect(by[id].auto_reply_status).toBeNull();
    expect(by.done.auto_reply_status).toBe('skipped');
    // Idempotent: a second tick finds nothing.
    expect(await Runner.enqueueMissedReviews({ now })).toBe(0);
    // Widening the location scope later picks Venice up while it is still inside the window.
    delete process.env.REVIEW_AUTO_REPLY_LOCATIONS;
    expect(await Runner.enqueueMissedReviews({ now })).toBe(1);
    expect(by.venice.auto_reply_status).toBe('queued');
    // No durable rollout cutoff (migration row missing) ⇒ catch-up disabled, fail closed.
    Runner._resetRolloutCutoffCache();
    state.migration = null;
    state.rows = rows();
    expect(await Runner.enqueueMissedReviews({ now })).toBe(0);
    expect(state.rows.every((r) => r.id === 'done' || r.auto_reply_status == null)).toBe(true);
  });
  test('eligibility is applied in SQL before the batch limit: a wall of replied rows cannot starve an eligible one (codex r26)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow';
    const now = new Date('2026-08-27T16:00:00Z');
    state.rows = Array.from({ length: 30 }, (_, i) => row({ id: `replied-${i}`, auto_reply_status: null, auto_reply_due_at: null, created_at: '2026-08-27T13:00:00Z', review_created_at: `2026-08-27T10:${String(i).padStart(2, '0')}:00Z`, review_reply: 'Owner replied' }));
    state.rows.push(row({ id: 'eligible', auto_reply_status: null, auto_reply_due_at: null, created_at: '2026-08-27T15:31:00Z', review_created_at: '2026-08-27T15:30:00Z' }));
    expect(await Runner.enqueueMissedReviews({ now, limit: 5 })).toBe(1);
    expect(state.rows.find((r) => r.id === 'eligible').auto_reply_status).toBe('queued');
    expect(state.rows.filter((r) => r.id !== 'eligible').every((r) => r.auto_reply_status == null)).toBe(true);
  });

  test('the cron runs the catch-up before claiming', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow';
    state.rows = [row({ id: 'fresh', auto_reply_status: null, auto_reply_due_at: null, created_at: new Date(Date.now() - 3500000).toISOString(), review_created_at: new Date(Date.now() - 3600000).toISOString() })];
    const stats = await Runner.processDueAutoReplies();
    expect(stats.enqueued).toBe(1);
    expect(state.rows[0].auto_reply_status).not.toBeNull();
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
    // codex r70: reconciliation parks are never rewritten by a dismiss.
    expect(f.auto_reply_status.sql).toContain("NOT COALESCE((auto_reply_status = 'parked' AND auto_reply_reason IN ('google_uncertain','persist_failed')), false)");
    const qb = { whereRaw: jest.fn() };
    Runner.whereNoReconcilePark(qb);
    // codex r71: NULL-safe — a NULL auto_reply_status row must still be dismissible.
    expect(qb.whereRaw).toHaveBeenCalledWith("NOT COALESCE((auto_reply_status = 'parked' AND auto_reply_reason IN ('google_uncertain','persist_failed')), false)");
  });

  test('Post now refuses a retracted row and the forced claim never picks one up (codex r75)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row({ id: 'rt', auto_reply_status: 'retracted', auto_reply_reason: 'removed_on_google', review_reply: null })];
    await expect(Runner.postNow('rt', { type: 'admin' }, { expectedDraft: null })).rejects.toMatchObject({ code: 'stale_claim', status: 409 });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockDraft).not.toHaveBeenCalled();
    expect(await Runner.claimDueRows({ limit: 1, force: 'rt' })).toEqual([]);
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'retracted', auto_reply_claimed_until: null });
  });

  test('whereNotAutoPosted keeps pipeline-posted replies out of Dismiss; human / IB posts stay dismissible (codex r75)', () => {
    const qb = { whereRaw: jest.fn() };
    Runner.whereNotAutoPosted(qb);
    expect(qb.whereRaw).toHaveBeenCalledWith("NOT (COALESCE(auto_reply_status, '') = 'posted' AND COALESCE(auto_reply_version, '') IN ('human','agent_ops') IS NOT TRUE)");
  });

  test('queued rows older than maxQueueAgeHours leave the lane before a claim instead of auto-posting after a pause (codex r74)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const stale = new Date(Date.now() - 49 * 3600000).toISOString();
    state.rows = [
      row({ id: 'old-q', review_created_at: stale }),
      row({ id: 'old-f', review_created_at: stale, auto_reply_status: 'failed', auto_reply_attempts: 1 }),
      row({ id: 'old-held', review_created_at: stale, auto_reply_claimed_until: '2099-01-01T00:00:00Z' }),
      row({ id: 'old-parked', review_created_at: stale, auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain' }),
      row({ id: 'fresh' }),
    ];
    const stats = await Runner.processDueAutoReplies();
    expect(stats).toMatchObject({ claimed: 1, posted: 1 });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0][0].reviewId).toBe('fresh');
    for (const id of ['old-q', 'old-f']) expect(state.rows.find((r) => r.id === id)).toMatchObject({ auto_reply_status: null, auto_reply_reason: 'queue_expired', auto_reply_due_at: null, auto_reply_claimed_until: null });
    // A live claim and a park are someone else's / a person's: untouched.
    expect(state.rows.find((r) => r.id === 'old-held')).toMatchObject({ auto_reply_status: 'queued', auto_reply_claimed_until: '2099-01-01T00:00:00Z' });
    expect(state.rows.find((r) => r.id === 'old-parked')).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain' });
    // Post now (force) still reaches an expired row — it is an admin action.
    const [forced] = await Runner.claimDueRows({ limit: 1, force: 'old-q' });
    expect(forced?.id).toBe('old-q');
  });

  test('a failed live-reply reconciliation retries instead of closing the row as already_replied (codex r74)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row()];
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    mockPublish.mockRejectedValueOnce(new ReviewReplyError('reconcile_failed', 'Google shows an owner reply but recording it failed: connection reset', { status: 503 }));
    const stats = await Runner.processDueAutoReplies();
    expect(stats).toMatchObject({ claimed: 1, retry: 1, skipped: 0 });
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'failed', auto_reply_reason: 'reconcile_failed', auto_reply_attempts: 1, auto_reply_claimed_until: null });
  });

  test('batch rows re-stamp their claim just before processing; a lost claim is skipped without drafting (codex r73)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow';
    state.rows = [row({ id: 'a' }), row({ id: 'b' })];
    const [ra, rb] = await Runner.claimDueRows({ limit: 2 });
    const stamped = rb.auto_reply_claimed_until;
    // Renewal is token-matched: a foreign token means the claim was lost.
    expect(await Runner.renewClaim({ ...rb, _claimToken: '2000-01-01T00:00:00.000Z' })).toBeNull();
    const renewed = await Runner.renewClaim(rb, new Date(Date.now() + 60000));
    expect(renewed._claimToken).not.toBe(ra._claimToken);
    expect(new Date(state.rows[1].auto_reply_claimed_until).getTime()).toBeGreaterThan(new Date(stamped).getTime());
    // Batch path: row a's draft takes long enough that b's claim is taken by
    // an admin (simulated by re-stamping b with a foreign token).
    state.rows.forEach((r) => { r.auto_reply_claimed_until = null; });
    mockDraft.mockImplementationOnce(async () => { state.rows[1].auto_reply_claimed_until = '2099-01-01T00:00:00.000Z'; return GOOD_DRAFT; });
    const stats = await Runner.processDueAutoReplies();
    expect(stats).toMatchObject({ claimed: 2, drafted: 1, skipped: 1, errors: 0 });
    expect(mockDraft).toHaveBeenCalledTimes(1);
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'drafted', auto_reply_claimed_until: null });
    // b is untouched: the foreign owner's stamp and state stand.
    expect(state.rows[1]).toMatchObject({ auto_reply_status: 'queued', auto_reply_claimed_until: '2099-01-01T00:00:00.000Z' });
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

  test('GBP access is required only to publish: shadow drafts and 1-3★ human parks happen at a Places-fallback location; the retry keeps the draft (codex r26)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow';
    mockGbp.isLocationConfigured.mockResolvedValue(false);
    state.rows = [row({ id: 's', location_id: 'venice' })];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'drafted', auto_reply_reason: 'shadow', auto_reply_draft: GOOD_DRAFT.text });
    state.rows = [row({ id: 'low', location_id: 'venice', star_rating: 2 })];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'low_rating' });
    expect(state.rows[0].auto_reply_draft).toBeTruthy();
    // auto mode: the draft is produced, then the missing credentials retry with the draft kept for reuse.
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row({ id: 'a', location_id: 'venice' })];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'failed', auto_reply_reason: 'gbp_not_configured', auto_reply_attempts: 1, auto_reply_draft: GOOD_DRAFT.text });
    expect(state.rows[0].auto_reply_grounding).toBeTruthy();
    // codex r27: the terminal park puts the draft in the "[DRAFT]" slot so the
    // Reviews page offers Use Draft (+ draftToken) when a person takes over.
    state.rows[0].auto_reply_due_at = '2026-08-27T14:00:00Z';
    state.rows[0].auto_reply_attempts = Runner.MAX_ATTEMPTS - 1;
    mockNotify.mockClear();
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'gbp_not_configured', auto_reply_attempts: Runner.MAX_ATTEMPTS, review_reply: '[DRAFT] ' + GOOD_DRAFT.text });
    // codex r45: the terminal credential park rings the action bell.
    expect(mockNotify.mock.calls.at(-1)[3].metadata).toMatchObject({ reason: 'gbp_not_configured', needsAction: true });
    mockGbp.isLocationConfigured.mockResolvedValue(true);
  });

  test('syncReplyFields on a reconciliation park: Google showing the pipeline\'s own draft closes it as POSTED (pipeline-owned); a different reply is the owner\'s', () => {
    const now = new Date('2026-08-27T15:00:00Z');
    const draft = 'Hi Dana, glad Marcus got the ants. Thanks for having us.';
    for (const reason of ['google_uncertain', 'persist_failed']) {
      const parked = { review_reply: '[DRAFT] ' + draft, auto_reply_status: 'parked', auto_reply_reason: reason, auto_reply_draft: draft, auto_reply_published_at: null, publish_claimed_until: null };
      expect(Runner.syncReplyFields(parked, { owner_reply: draft, owner_reply_updated_at: '2026-08-27T14:30:00Z' }, { now }))
        .toEqual({ review_reply: draft, reply_updated_at: '2026-08-27T14:30:00Z', auto_reply_status: 'posted', auto_reply_reason: null, auto_reply_published_at: '2026-08-27T14:30:00Z', auto_reply_error: null, auto_reply_claimed_until: null });
      expect(Runner.syncReplyFields(parked, { owner_reply: 'Something the owner wrote' }, { now }))
        .toMatchObject({ review_reply: 'Something the owner wrote', auto_reply_status: 'skipped', auto_reply_reason: 'owner_replied_on_google' });
    }
    // codex r44: a landed write whose grounding snapshot no longer matches the
    // row (re-attributed / edited before this sync) parks for a person.
    const moved = { review_reply: '[DRAFT] ' + draft, auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain', auto_reply_draft: draft, auto_reply_published_at: null, publish_claimed_until: null, star_rating: 5, review_text: 'Great', reviewer_name: 'Dana W.', customer_id: 'c2', auto_reply_grounding: { fingerprint: Runner.reviewFingerprint({ star_rating: 5, review_text: 'Great', reviewer_name: 'Dana W.', customer_id: 'c1' }), accountFingerprint: 'fp:x' } };
    expect(Runner.syncReplyFields(moved, { owner_reply: draft, owner_reply_updated_at: '2026-08-27T14:30:00Z' }, { now }))
      .toMatchObject({ review_reply: draft, auto_reply_status: 'parked', auto_reply_reason: 'review_edited_after_post', auto_reply_published_at: '2026-08-27T14:30:00Z' });
    // Other parks (low_rating etc.) with the same text on Google are NOT ours.
    expect(Runner.syncReplyFields({ review_reply: '[DRAFT] ' + draft, auto_reply_status: 'parked', auto_reply_reason: 'low_rating', auto_reply_draft: draft, publish_claimed_until: null }, { owner_reply: draft }, { now }))
      .toMatchObject({ auto_reply_status: 'skipped', auto_reply_reason: 'owner_replied_on_google' });
  });

  test('syncReplyFields keeps a review_edited_after_post park while Google still shows OUR reply; an owner edit hands it over (codex r28)', () => {
    const now = new Date('2026-08-27T15:00:00Z');
    const parked = { review_reply: 'Our auto reply', auto_reply_status: 'parked', auto_reply_reason: 'review_edited_after_post', auto_reply_draft: 'Our auto reply', publish_claimed_until: null };
    expect(Runner.syncReplyFields(parked, { owner_reply: 'Our auto reply' }, { now })).toEqual({ review_reply: 'Our auto reply', reply_updated_at: now.toISOString() });
    expect(Runner.syncReplyFields(parked, { owner_reply: 'Owner rewrote it' }, { now })).toMatchObject({ review_reply: 'Owner rewrote it', auto_reply_status: 'skipped', auto_reply_reason: 'edited_on_google' });
    expect(Runner.syncReplyFields(parked, { owner_reply: null }, { now })).toMatchObject({ review_reply: null, auto_reply_status: 'retracted', auto_reply_reason: 'removed_on_google' });
  });

  test('an authoritative snapshot with NO owner reply resolves a google_uncertain park into the retry lane (codex r41); persist_failed stays parked', () => {
    const now = new Date('2026-08-27T15:00:00Z');
    const uncertain = { review_reply: null, auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain', auto_reply_draft: 'Hi Dana, thanks.', publish_claimed_until: null };
    expect(Runner.syncReplyFields(uncertain, { owner_reply: null }, { now })).toMatchObject({ auto_reply_status: 'failed', auto_reply_reason: 'google_uncertain_cleared', auto_reply_due_at: now.toISOString(), auto_reply_claimed_until: null });
    // codex r75: a MANUAL attempt (editor / IB) never re-enters the automatic
    // lane — its exact text comes back as a human [DRAFT] for a person.
    for (const version of ['human', 'agent_ops']) {
      expect(Runner.syncReplyFields({ ...uncertain, auto_reply_version: version }, { owner_reply: null }, { now }))
        .toEqual({ review_reply: '[DRAFT] Hi Dana, thanks.', reply_updated_at: null, auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain_cleared', auto_reply_draft: null, auto_reply_due_at: null, auto_reply_claimed_until: null });
    }
    expect(Runner.syncReplyFields({ ...uncertain, auto_reply_version: 'human', auto_reply_draft: null }, { owner_reply: null }, { now }))
      .toMatchObject({ review_reply: null, auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain_cleared' });
    const persistFailed = { ...uncertain, auto_reply_reason: 'persist_failed' };
    expect(Runner.syncReplyFields(persistFailed, { owner_reply: null }, { now })).toEqual({ review_reply: null, reply_updated_at: null });
  });

  test('validatePromotionAccountFacts parks a landed uncertain write whose account facts moved (codex r45)', async () => {
    const existing = { auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain', customer_id: 'c1', auto_reply_grounding: JSON.stringify({ accountFingerprint: 'fp:Venice|new' }) };
    const promote = { review_reply: 'x', auto_reply_status: 'posted', auto_reply_reason: null };
    mockAccountFacts.mockResolvedValue({ city: 'Venice', tenure: 'new' });
    expect(await Runner.validatePromotionAccountFacts(existing, promote)).toEqual(promote);
    mockAccountFacts.mockResolvedValue({ city: 'Sarasota', tenure: 'new' });
    expect(await Runner.validatePromotionAccountFacts(existing, promote)).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'review_edited_after_post' });
    mockAccountFacts.mockRejectedValueOnce(new Error('db down'));
    expect(await Runner.validatePromotionAccountFacts(existing, promote)).toMatchObject({ auto_reply_status: 'parked' });
    // Not a promotion / not a reconciliation park → untouched.
    expect(await Runner.validatePromotionAccountFacts({ ...existing, auto_reply_reason: 'low_rating' }, promote)).toEqual(promote);
    expect(await Runner.validatePromotionAccountFacts(existing, { review_reply: 'x' })).toEqual({ review_reply: 'x' });
  });

  test('notifyReviewEditedAfterPost treats a null notifyAdmin result as failure, retries, stamps the row, and the cron sweep re-rings it (codex r46)', async () => {
    mockNotify.mockReset().mockResolvedValue(null);
    state.rows = [row({ id: 'nb', auto_reply_status: 'parked', auto_reply_reason: 'review_edited_after_post', review_reply: 'Our reply', auto_reply_error: null })];
    expect(await Runner.notifyReviewEditedAfterPost(state.rows[0], { location_id: 'sarasota', star_rating: 5, cause: 'edit' })).toBe(false);
    expect(mockNotify).toHaveBeenCalledTimes(3);
    expect(state.rows[0].auto_reply_error).toMatch(/^bell_failed:review_edited_after_post:edit/);
    // Sweep: the insert works again → bell rings, stamp cleared.
    mockNotify.mockReset().mockResolvedValue({ id: 'n1' });
    expect(await Runner.retryFailedEditedBells()).toBe(1);
    expect(state.rows[0].auto_reply_error).toBeNull();
    expect(mockNotify.mock.calls.at(-1)[3].metadata).toMatchObject({ reason: 'review_edited_after_post', cause: 'edit', needsAction: true });
    mockNotify.mockReset().mockResolvedValue({});
  });

  test('bell() treats a null notifyAdmin result as failure: retries, stamps the row (keeping the existing error text), and the sweep re-rings + clears (codex r48)', async () => {
    mockNotify.mockReset().mockResolvedValue(null);
    state.rows = [row({ id: 'bf', auto_reply_status: 'parked', auto_reply_reason: 'provider_down', auto_reply_error: 'all providers down' })];
    expect(await Runner.notifyReviewEditedAfterPost({ id: 'nope' }, { location_id: 'sarasota', star_rating: 5 })).toBe(false); // (unrelated row: no crash on absent row)
    mockNotify.mockClear();
    const ok = await (async () => { const r = state.rows[0]; return Runner.processDueAutoReplies && (await require('../services/review-reply/runner').retryFailedEditedBells(), true) && r; })();
    expect(ok).toBeTruthy();
    // Direct: a terminal-park bell that fails is stamped without losing the provider error.
    mockNotify.mockReset().mockResolvedValue(null);
    await Runner.__bellForTest(state.rows[0], { title: 'Review reply needs you', body: 'x', reason: 'provider_down', action: true });
    expect(mockNotify).toHaveBeenCalledTimes(3);
    expect(state.rows[0].auto_reply_error).toBe('all providers down || bell_failed:provider_down:1');
    // Sweep: notifier healthy → re-rung with needsAction, stamp stripped, original error kept.
    mockNotify.mockReset().mockResolvedValue({ id: 'n1' });
    expect(await Runner.retryFailedEditedBells()).toBe(1);
    expect(state.rows[0].auto_reply_error).toBe('all providers down');
    expect(mockNotify.mock.calls.at(-1)[3].metadata).toMatchObject({ reason: 'provider_down', needsAction: true });
    mockNotify.mockReset().mockResolvedValue({});
  });

  test('a reply that Google accepted but the publisher parked (edited during the PUT) reports parked and rings no "posted" bell (codex r57)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    mockPublish.mockImplementationOnce(async ({ reviewId }) => { const r = state.rows.find((x) => x.id === reviewId); Object.assign(r, { review_reply: 'Live', auto_reply_status: 'parked', auto_reply_reason: 'review_edited_after_post', auto_reply_claimed_until: null }); return { googlePosted: true, reviewId, editedDuringPut: true }; });
    state.rows = [row({ id: 'ep' })];
    mockNotify.mockClear();
    const stats = await Runner.processDueAutoReplies();
    expect(stats.parked).toBe(1);
    expect(stats.posted).toBe(0);
    expect(mockNotify.mock.calls.some((c) => c[1] === 'Auto-replied to a review')).toBe(false);
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'review_edited_after_post' });
  });

  test('a delayed click auto-link does not invalidate a stored review-only draft; a manual confirmation does (codex r57)', () => {
    const base = row({ customer_id: null, link_source: null });
    const fp = Runner.reviewFingerprint(base);
    expect(Runner.reviewFingerprint({ ...base, customer_id: 'c1', link_source: 'click_auto' })).toBe(fp);
    expect(Runner.reviewFingerprint({ ...base, customer_id: 'c1', link_source: 'manual' })).not.toBe(fp);
    // reviewEditFields sees the confirmation as an identity change too.
    const posted = row({ customer_id: 'c1', link_source: 'click_auto', auto_reply_status: 'posted', review_reply: 'Live' });
    expect(Runner.reviewEditFields(posted, { star_rating: posted.star_rating, review_text: posted.review_text, reviewer_name: posted.reviewer_name, customer_id: 'c1', link_source: 'manual' })).toEqual({ auto_reply_status: 'parked', auto_reply_reason: 'review_edited_after_post' });
  });

  test('a live review mismatch is bounded: after the ceiling the row parks review_changed_stale_sync with a bell (codex r56)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    mockPublish.mockImplementation(async () => { throw new ReviewReplyError('review_changed', 'The review changed on Google since it was synced — reply not posted.', { status: 409 }); });
    state.rows = [row({ id: 'rc', auto_reply_attempts: 0 })];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'queued', auto_reply_reason: 'review_changed', auto_reply_attempts: 1 });
    state.rows = [row({ id: 'rc2', auto_reply_attempts: Runner.MAX_ATTEMPTS - 1 })];
    mockNotify.mockClear();
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'review_changed_stale_sync', auto_reply_attempts: Runner.MAX_ATTEMPTS });
    expect(mockNotify.mock.calls.at(-1)[3].metadata).toMatchObject({ reason: 'review_changed_stale_sync', needsAction: true });
    mockPublish.mockReset();
  });

  test('the failed-bell sweep runs even when the gate is off (codex r53)', async () => {
    delete process.env.GATE_REVIEW_AUTO_REPLY;
    mockNotify.mockReset().mockResolvedValue({ id: 'n1' });
    state.rows = [row({ id: 'off', auto_reply_status: 'parked', auto_reply_reason: 'review_edited_after_post', review_reply: 'Our reply', auto_reply_error: 'bell_failed:review_edited_after_post:edit' })];
    const stats = await Runner.processDueAutoReplies();
    expect(stats.mode).toBe('off');
    expect(stats.bellsRetried).toBe(1);
    expect(stats.claimed).toBe(0);
    expect(state.rows[0].auto_reply_error).toBeNull();
    mockNotify.mockReset().mockResolvedValue({});
  });

  test('Use Draft on an Agent Ops draft: verbatim text is verified, a failing verdict refuses, edited text is the admin\'s own (codex r58)', async () => {
    const agentText = 'I am sorry to hear that. Regards, Waves';
    const fresh = row({ id: 'aou', review_reply: '[DRAFT] ' + agentText, ...Runner.agentDraftSavedFields(agentText) });
    mockVerify.mockReturnValueOnce('first_person_singular');
    expect(await Runner.pipelineDraftGuard(agentText, { draftToken: Runner.reviewFingerprint(fresh) })(fresh)).toMatch(/does not pass the public-reply checks \(first_person_singular\)/);
    mockVerify.mockReturnValueOnce(null);
    expect(await Runner.pipelineDraftGuard(agentText, { draftToken: Runner.reviewFingerprint(fresh) })(fresh)).toBeNull();
    expect(await Runner.pipelineDraftGuard('Hi Dana, edited by the admin.', { draftToken: Runner.reviewFingerprint(fresh) })(fresh)).toBeNull();
  });

  test('an Agent Ops draft is machine-authored: Post now re-verifies it, a failing verdict surfaces a canonical replacement (codex r46)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const agentText = 'I am sorry to hear that. Regards, Waves';
    const fields = Runner.agentDraftSavedFields(agentText);
    expect(fields).toMatchObject({ auto_reply_draft: agentText, auto_reply_status: 'parked', auto_reply_reason: 'agent_ops_draft', auto_reply_version: 'agent_ops', auto_reply_grounding: null });
    state.rows = [row({ id: 'ao', review_reply: '[DRAFT] ' + agentText, ...fields })];
    mockVerify.mockReturnValueOnce('first_person_singular');
    const r = await Runner.postNow('ao', { type: 'admin' }, { expectedDraft: agentText });
    expect(mockVerify).toHaveBeenCalledWith(agentText, expect.anything(), expect.anything());
    expect(r).toMatchObject({ outcome: 'parked', reason: 'draft_replaced', drafted: true });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(state.rows[0].auto_reply_draft).toBe(GOOD_DRAFT.text);
    // A conforming agent draft passes the verifier and posts (as the admin).
    const okText = 'Hi Dana, thanks for the note. The Waves team';
    state.rows = [row({ id: 'ao2', review_reply: '[DRAFT] ' + okText, ...Runner.agentDraftSavedFields(okText) })];
    const r2 = await Runner.postNow('ao2', { type: 'admin' }, { expectedDraft: okText });
    expect(r2.outcome).toBe('posted');
    expect(mockPublish.mock.calls[0][0].text).toBe(okText);
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
    // codex r36: the approved draft was discarded → the replacement is SURFACED, not published unseen.
    expect(r).toMatchObject({ outcome: 'parked', reason: 'draft_replaced', drafted: true });
    expect(mockDraft).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'draft_replaced', auto_reply_draft: GOOD_DRAFT.text, review_reply: '[DRAFT] ' + GOOD_DRAFT.text });
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

  test('PERSIST_FAILED park keeps drafted_at + grounding so a later sync confirmation has full metadata (codex r32)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    mockPublish.mockImplementationOnce(async () => { throw new ReviewReplyError('persist_failed', 'row write failed after the PUT', { status: 500 }); });
    state.rows = [row()];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'persist_failed', auto_reply_draft: GOOD_DRAFT.text });
    expect(state.rows[0].auto_reply_drafted_at).toBeTruthy();
    expect(JSON.parse(state.rows[0].auto_reply_grounding)).toMatchObject({ version: 'grounding-v1' });
  });

  test('Skip auto on a FAILED retry row surfaces its verified draft into the [DRAFT] slot (codex r51)', async () => {
    state.rows = [row({ id: 'sf', auto_reply_status: 'failed', auto_reply_reason: 'google_failed', auto_reply_draft: GOOD_DRAFT.text, review_reply: null })];
    expect(await Runner.skipAutoReply('sf')).toBe(true);
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'skipped', auto_reply_reason: 'admin_skip', review_reply: '[DRAFT] ' + GOOD_DRAFT.text });
    // A drafted row already shows its draft in the slot: unchanged slot.
    state.rows = [row({ id: 'sd', auto_reply_status: 'drafted', auto_reply_reason: 'shadow', auto_reply_draft: GOOD_DRAFT.text, review_reply: '[DRAFT] ' + GOOD_DRAFT.text })];
    expect(await Runner.skipAutoReply('sd')).toBe(true);
    expect(state.rows[0].review_reply).toBe('[DRAFT] ' + GOOD_DRAFT.text);
  });

  test('a skipped row keeps its pipeline draft usable: Use Draft passes the guard and Post now reuses it (codex r32)', async () => {
    const draft = 'Hi Dana, glad Marcus got the ants. Thanks for having us.';
    const base = row({ id: 'sk', customer_id: 'c1', auto_reply_status: 'skipped', auto_reply_reason: 'admin_skip', auto_reply_draft: draft, review_reply: '[DRAFT] ' + draft });
    const fresh = { ...base, auto_reply_grounding: { fingerprint: Runner.reviewFingerprint(base), accountFingerprint: 'fp:Venice|new' } };
    mockAccountFacts.mockResolvedValue({ city: 'Venice', tenure: 'new' });
    expect(await Runner.pipelineDraftGuard(draft, { draftToken: Runner.reviewFingerprint(base) })(fresh)).toBeNull();
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [fresh];
    // codex r57: Skip auto is authoritative for Post now — the pipeline never
    // publishes a skipped draft; a person posts it via Use Draft instead.
    await expect(Runner.postNow('sk', { type: 'admin' }, { expectedDraft: draft })).rejects.toMatchObject({ code: 'stale_claim', status: 409 });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(state.rows[0].auto_reply_claimed_until).toBeNull();
  });

  test('a reused (retry) draft keeps its original drafted_at through retries and the eventual publish (codex r30)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    const draftedAt = '2026-08-27T13:00:00Z';
    const stored = { fingerprint: Runner.reviewFingerprint(row()), accountFingerprint: 'fp:none', version: 'grounding-v1', review: { rating: 5 } };
    const base = () => row({ auto_reply_status: 'failed', auto_reply_reason: 'google_failed', auto_reply_attempts: 1, auto_reply_due_at: '2026-08-27T14:00:00Z', auto_reply_draft: GOOD_DRAFT.text, auto_reply_drafted_at: draftedAt, auto_reply_version: GOOD_DRAFT.version, auto_reply_mode: GOOD_DRAFT.mode, auto_reply_grounding: stored });
    // Retry fails again → still the original timestamp, no redraft.
    mockPublish.mockImplementationOnce(async () => { throw new ReviewReplyError('google_failed', 'GBP 503', { status: 502 }); });
    state.rows = [base()];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'failed', auto_reply_attempts: 2, auto_reply_drafted_at: draftedAt });
    expect(mockDraft).not.toHaveBeenCalled();
    // Retry succeeds → drafted_at preserved, published_at is now.
    state.rows = [base()];
    await Runner.processDueAutoReplies();
    expect(state.rows[0].auto_reply_status).toBe('posted');
    expect(state.rows[0].auto_reply_drafted_at).toBe(draftedAt);
    expect(state.rows[0].auto_reply_published_at).not.toBe(draftedAt);
  });

  test('terminal parks record the final attempt count (codex r29)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    mockPublish.mockImplementationOnce(async () => { throw new ReviewReplyError('google_failed', 'GBP 503', { status: 502 }); });
    state.rows = [row({ auto_reply_attempts: Runner.MAX_ATTEMPTS - 1, auto_reply_status: 'failed', auto_reply_reason: 'google_failed', auto_reply_due_at: '2026-08-27T14:00:00Z' })];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'google_failed', auto_reply_attempts: Runner.MAX_ATTEMPTS });
    expect(state.rows[0].auto_reply_error).toContain('GBP 503');
    mockDraft.mockResolvedValueOnce({ ok: false, reason: 'provider_unavailable', error: 'all providers down', rejections: [] });
    state.rows = [row({ id: 'p', auto_reply_attempts: Runner.MAX_ATTEMPTS - 1, auto_reply_status: 'failed', auto_reply_reason: 'provider_unavailable', auto_reply_due_at: '2026-08-27T14:00:00Z' })];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'provider_down', auto_reply_attempts: Runner.MAX_ATTEMPTS });
  });

  test('a transient account-facts read failure inside the claim retries (never skipped as lost to a person) — codex r28', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    mockPublish.mockImplementationOnce(async () => { throw new ReviewReplyError('stale_claim', 'Reply not posted: account facts could not be re-read', { status: 409 }); });
    state.rows = [row()];
    const stats = await Runner.processDueAutoReplies();
    expect(stats.retry).toBe(1);
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'failed', auto_reply_reason: 'account_read_failed', auto_reply_attempts: 1, auto_reply_draft: GOOD_DRAFT.text });
    // A genuine STALE (a person acted) is still terminal.
    mockPublish.mockImplementationOnce(async () => { throw new ReviewReplyError('stale_claim', 'Reply not posted: auto-reply claim was lost', { status: 409 }); });
    state.rows = [row({ id: 'g' })];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'skipped', auto_reply_reason: 'stale_claim' });
  });

  test('GOOGLE_UNCERTAIN (PUT timed out, may be live) → parked with an action bell, never retried', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    mockPublish.mockImplementationOnce(async ({ reviewId }) => { const r = state.rows.find((x) => x.id === reviewId); Object.assign(r, { auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain', auto_reply_claimed_until: null }); throw new ReviewReplyError('google_uncertain', 'timed out', { status: 502 }); });
    state.rows = [row()];
    const stats = await Runner.processDueAutoReplies();
    expect(stats.parked).toBe(1);
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain', auto_reply_draft: GOOD_DRAFT.text });
    // codex r26: drafted_at + grounding evidence persist too, so a sync that
    // later confirms the reply as posted leaves full metadata behind.
    expect(state.rows[0].auto_reply_drafted_at).toBeTruthy();
    expect(JSON.parse(state.rows[0].auto_reply_grounding)).toMatchObject({ version: 'grounding-v1' });
    expect(mockNotify.mock.calls.at(-1)[3].metadata).toMatchObject({ reason: 'google_uncertain', needsAction: true });
    await Runner.processDueAutoReplies();
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  test('reviewEditFields: a reviewer edit on a POSTED row parks it for a person', () => {
    const posted = row({ auto_reply_status: 'posted' });
    expect(Runner.reviewEditFields(posted, { star_rating: 5, review_text: 'Great work', reviewer_name: 'Dana W.' })).toEqual({});
    expect(Runner.reviewEditFields(posted, { star_rating: 1, review_text: 'Actually terrible', reviewer_name: 'Dana W.' })).toEqual({ auto_reply_status: 'parked', auto_reply_reason: 'review_edited_after_post' });
    // codex r36: a re-attribution (customer_id change) is a review change too.
    expect(Runner.reviewEditFields(posted, { star_rating: posted.star_rating, review_text: posted.review_text, reviewer_name: posted.reviewer_name, customer_id: 'someone-else' })).toEqual({ auto_reply_status: 'parked', auto_reply_reason: 'review_edited_after_post' });
    expect(Runner.reviewEditFields(posted, { star_rating: posted.star_rating, review_text: posted.review_text, reviewer_name: posted.reviewer_name, customer_id: posted.customer_id })).toEqual({});
    // codex r35: a HUMAN draft written for the old review is kept but marked stale.
    const humanDrafted = { ...posted, auto_reply_status: 'parked', auto_reply_reason: 'human_draft', review_reply: '[DRAFT] Owner wrote this for the 5-star version', auto_reply_draft: null };
    expect(Runner.reviewEditFields(humanDrafted, { star_rating: 1, review_text: 'Actually terrible', reviewer_name: 'Dana W.' })).toEqual({ auto_reply_status: 'parked', auto_reply_reason: 'human_draft_stale', auto_reply_claimed_until: null });
    const neverQueued = { ...humanDrafted, auto_reply_status: null, auto_reply_reason: null };
    expect(Runner.reviewEditFields(neverQueued, { star_rating: 1, review_text: 'Actually terrible', reviewer_name: 'Dana W.' })).toMatchObject({ auto_reply_reason: 'human_draft_stale' });
    expect(Runner.reviewEditFields(humanDrafted, { star_rating: 5, review_text: humanDrafted.review_text, reviewer_name: 'Dana W.' })).toEqual({});
    // A SECOND edit keeps that park (and Retract) — it must not requeue and
    // clear the draft while the real reply is still live (hook P1).
    const parkedAfterPost = { ...posted, star_rating: 1, review_text: 'Actually terrible', auto_reply_status: 'parked', auto_reply_reason: 'review_edited_after_post' };
    expect(Runner.reviewEditFields(parkedAfterPost, { star_rating: 2, review_text: 'Slightly less terrible', reviewer_name: 'Dana W.' })).toEqual({});
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
    // A human's [DRAFT] is theirs: the text is kept but marked stale (codex r35); reconciliation parks may have a live PUT.
    expect(Runner.reviewEditFields(row({ auto_reply_status: 'parked', auto_reply_reason: 'human_draft', auto_reply_draft: draft, review_reply: '[DRAFT] the owner wrote this' }), edit)).toEqual({ auto_reply_status: 'parked', auto_reply_reason: 'human_draft_stale', auto_reply_claimed_until: null });
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
      // codex r22: eligibility is the DRAFT-TIME rating. A posted 5★ draft whose
      // reviewer later dropped to 2★ stays in the sample; a 2★ human-only draft
      // whose reviewer later raised to 5★ never enters it.
      row({ id: 'f', star_rating: 2, auto_reply_status: 'parked', auto_reply_reason: 'review_edited_after_post', auto_reply_drafted_at: '2026-08-18T00:00:00Z', auto_reply_grounding: { review: { rating: 5 } } }),
      row({ id: 'g', star_rating: 5, auto_reply_status: 'parked', auto_reply_reason: 'low_rating', auto_reply_drafted_at: '2026-08-17T00:00:00Z', auto_reply_grounding: { review: { rating: 2 } } }),
      // codex r61: human / Agent Ops text posted via Post now never counts.
      row({ id: 'h', star_rating: 5, auto_reply_status: 'posted', auto_reply_version: 'human', auto_reply_drafted_at: '2026-08-16T00:00:00Z', review_reply: 'x' }),
      row({ id: 'i', star_rating: 5, auto_reply_status: 'posted', auto_reply_version: 'agent_ops', auto_reply_drafted_at: '2026-08-15T00:00:00Z', review_reply: 'y' }),
    ];
    const st = await Runner.autoReplyStatus();
    expect(st.shadowDrafts).toBe(4);
    expect(st.firstShadowDraftAt).toBe('2026-08-18T00:00:00Z');
    expect(st.draftsTotal).toBe(8);
    expect(st.byStatus).toEqual({ drafted: 1, posted: 3, skipped: 1, parked: 3, queued: 1 });
  });

  test('pipelineDraftGuard (Use Draft → human route): the stored draft posts only while its review + account fingerprints still match', async () => {
    const draft = 'Hi Dana, glad Marcus got the ants. Thanks for having us.';
    const base = row({ id: 'u', star_rating: 5, review_text: 'Great', customer_id: 'c1', auto_reply_status: 'drafted', auto_reply_draft: draft });
    const stored = { fingerprint: Runner.reviewFingerprint(base), accountFingerprint: 'fp:Venice|new' };
    const fresh = { ...base, auto_reply_grounding: stored };
    mockAccountFacts.mockResolvedValue({ city: 'Venice', tenure: 'new' });
    expect(await Runner.pipelineDraftGuard(draft)(fresh)).toBeNull();
    // A person's own words, or an edited draft, are never guarded.
    expect(await Runner.pipelineDraftGuard('My own reply.')({ ...fresh, auto_reply_grounding: null })).toBeNull();
    // City corrected after drafting → stale.
    mockAccountFacts.mockResolvedValue({ city: 'Sarasota', tenure: 'new' });
    expect(await Runner.pipelineDraftGuard(draft)(fresh)).toMatch(/customer facts changed/);
    mockAccountFacts.mockResolvedValue({ city: 'Venice', tenure: 'new' });
    // Re-attributed to another customer → review fingerprint moves → stale.
    expect(await Runner.pipelineDraftGuard(draft)({ ...fresh, customer_id: 'c2' })).toMatch(/customer link changed/);
    // No grounding record at all → refuse (fail closed).
    expect(await Runner.pipelineDraftGuard(draft)({ ...fresh, auto_reply_grounding: null })).toMatch(/no grounding record/);
    // Account read failure → fail closed.
    mockAccountFacts.mockRejectedValueOnce(new Error('db down'));
    expect(await Runner.pipelineDraftGuard(draft)(fresh)).toMatch(/could not be re-read/);
    // codex r25: "Use Draft" carries the draft's identity. The sync cleared
    // the draft after the editor loaded (reviewer edit → requeued) — the
    // editor still holds the old text and the row has nothing to compare:
    // the token alone refuses it, edited or not.
    const token = Runner.reviewFingerprint(base);
    const cleared = { ...base, auto_reply_status: 'queued', auto_reply_reason: 'review_changed', auto_reply_draft: null, auto_reply_grounding: null, star_rating: 1, review_text: 'Terrible now' };
    expect(await Runner.pipelineDraftGuard(draft, { draftToken: token })(cleared)).toMatch(/cleared since it was loaded/);
    expect(await Runner.pipelineDraftGuard(draft + ' Edited.', { draftToken: token })(cleared)).toMatch(/cleared since it was loaded/);
    // Draft still held but the review moved underneath → token mismatch.
    expect(await Runner.pipelineDraftGuard(draft, { draftToken: token })({ ...fresh, review_text: 'Edited review' , auto_reply_grounding: { ...stored, fingerprint: Runner.reviewFingerprint({ ...base, review_text: 'Edited review' }) } })).toMatch(/changed since this draft was loaded/);
    // Token matches and nothing changed → posts (even an edited draft).
    expect(await Runner.pipelineDraftGuard(draft + ' Edited.', { draftToken: token })(fresh)).toBeNull();
    // Posted meanwhile via Post now → refuse, the person must reload.
    expect(await Runner.pipelineDraftGuard(draft, { draftToken: token })({ ...fresh, auto_reply_status: 'posted', review_reply: draft })).toMatch(/cleared since it was loaded/);
    // codex r27: an editor AI draft (/ai-reply, never stored) carries a
    // grounding token = review fp | account fp; both must still hold.
    mockAccountFacts.mockResolvedValue({ city: 'Venice', tenure: 'new' });
    const plain = { ...base, auto_reply_status: null, auto_reply_draft: null, auto_reply_grounding: null };
    const gt = Runner.groundingToken(plain, { account: { city: 'Venice', tenure: 'new' } });
    expect(gt).toBe(`${Runner.reviewFingerprint(plain)}|fp:Venice|new`);
    expect(await Runner.pipelineDraftGuard('AI text', { groundingToken: gt })(plain)).toBeNull();
    // codex r67: a text-bound token accepts only the approved draft.
    const gtText = Runner.groundingToken(plain, { account: { city: 'Venice', tenure: 'new' } }, 'AI text');
    expect(await Runner.pipelineDraftGuard('AI text', { groundingToken: gtText })(plain)).toBeNull();
    expect(await Runner.pipelineDraftGuard('  AI text \n', { groundingToken: gtText })(plain)).toBeNull();
    expect(await Runner.pipelineDraftGuard('AI text B', { groundingToken: gtText })(plain)).toMatch(/differs from the draft that was approved/);
    expect(await Runner.pipelineDraftGuard('AI text', { groundingToken: gt })({ ...plain, customer_id: 'c2' })).toMatch(/changed since this draft was generated/);
    mockAccountFacts.mockResolvedValue({ city: 'Sarasota', tenure: 'new' });
    expect(await Runner.pipelineDraftGuard('AI text', { groundingToken: gt })(plain)).toMatch(/customer facts changed since this draft was generated/);
    mockAccountFacts.mockRejectedValueOnce(new Error('db down'));
    expect(await Runner.pipelineDraftGuard('AI text', { groundingToken: gt })(plain)).toMatch(/could not be re-read/);
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

  test('publisher HAS_REPLY flagged reconciled (our earlier uncertain PUT was live) → posted outcome, row NOT marked skipped (codex r69)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    const e = new ReviewReplyError('already_replied', 'landed', { status: 409 }); e.reconciled = true;
    mockPublish.mockImplementationOnce(async () => { state.rows[0] = { ...state.rows[0], auto_reply_status: 'posted', auto_reply_reason: null, review_reply: 'Landed text', auto_reply_claimed_until: null }; throw e; });
    state.rows = [row()];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'posted', review_reply: 'Landed text' });
    expect(state.rows[0].auto_reply_reason).not.toBe('already_replied');
  });

  test('location without GBP credentials: the draft is produced (shadow value, human parks), publishing defers with the draft kept', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    mockGbp.isLocationConfigured.mockResolvedValueOnce(false);
    state.rows = [row()];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'failed', auto_reply_reason: 'gbp_not_configured', auto_reply_draft: GOOD_DRAFT.text });
    expect(mockDraft).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();
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
  test('postNow on a stored draft whose earlier uncertain PUT turns out to be live reports posted (reconciled), not 409 (codex r76)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'shadow';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    const draft = 'Hi Dana,\n\nThanks.\n\nThe 🌊 Waves Pest Control Sarasota Team';
    state.rows = [row({ auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain', auto_reply_draft: draft, auto_reply_mode: 'service_quality', auto_reply_version: 'reply-v1', review_reply: `[DRAFT] ${draft}`, auto_reply_grounding: { fingerprint: Runner.reviewFingerprint(row()), accountFingerprint: 'fp:none' } })];
    const e = new ReviewReplyError('already_replied', 'landed', { status: 409 }); e.reconciled = true;
    mockPublish.mockImplementationOnce(async () => { state.rows[0] = { ...state.rows[0], auto_reply_status: 'posted', auto_reply_reason: null, review_reply: draft, auto_reply_claimed_until: null }; throw e; });
    const r = await Runner.postNow('rev-1', { type: 'admin', adminUserId: 'u1' }, { expectedDraft: draft });
    expect(r).toMatchObject({ outcome: 'posted', reconciled: true });
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'posted', review_reply: draft, auto_reply_claimed_until: null });
    expect(state.rows[0].auto_reply_reason).not.toBe('already_replied');
  });
  test('postNow on a 1-3★ / unrated row with NO surfaced draft never posts an unseen reply: it drafts + parks; the next Post now publishes it (hook P1)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    for (const star_rating of [2, 0]) {
      state.rows = [row({ id: 'lo', star_rating, auto_reply_status: 'queued' })];
      const r = await Runner.postNow('lo', { type: 'admin', adminUserId: 'u1' });
      expect(r).toMatchObject({ outcome: 'parked', reason: star_rating === 0 ? 'unrated' : 'low_rating', drafted: true });
      expect(mockPublish).not.toHaveBeenCalled();
      expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_draft: GOOD_DRAFT.text, review_reply: '[DRAFT] ' + GOOD_DRAFT.text, auto_reply_claimed_until: null });
      // Second Post now: the surfaced draft is published as the admin.
      // (jsonb comes back as an object from Postgres; the in-memory rig stored the string.)
      state.rows[0].auto_reply_grounding = JSON.parse(state.rows[0].auto_reply_grounding);
      const r2 = await Runner.postNow('lo', { type: 'admin', adminUserId: 'u1' });
      expect(r2.outcome).toBe('posted');
      expect(mockPublish).toHaveBeenCalledTimes(1);
      mockPublish.mockClear();
    }
  });

  test('postNow is bound to the draft the admin saw (hook P1): a replaced draft refuses with STALE and releases the claim', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    state.rows = [row({ id: 'b', auto_reply_status: 'drafted', auto_reply_reason: 'shadow', auto_reply_draft: 'Newer pipeline draft', review_reply: '[DRAFT] Newer pipeline draft', auto_reply_grounding: { fingerprint: Runner.reviewFingerprint(row()), accountFingerprint: 'fp:none' } })];
    await expect(Runner.postNow('b', { type: 'admin' }, { expectedDraft: 'The draft the page showed' })).rejects.toMatchObject({ code: 'stale_claim', status: 409 });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(state.rows[0].auto_reply_claimed_until).toBeNull();
    // Human draft replaced by Agent Ops after the page loaded → same refusal.
    state.rows = [row({ id: 'h', auto_reply_status: 'parked', auto_reply_reason: 'human_draft', review_reply: '[DRAFT] Agent Ops rewrote this' })];
    await expect(Runner.postNow('h', { type: 'admin' }, { expectedDraft: 'What the admin read' })).rejects.toMatchObject({ code: 'stale_claim' });
    // Matching draft → publishes it; queued with no draft and null observed → proceeds.
    state.rows = [row({ id: 'h2', auto_reply_status: 'parked', auto_reply_reason: 'human_draft', review_reply: '[DRAFT] Agent Ops rewrote this' })];
    const r = await Runner.postNow('h2', { type: 'admin' }, { expectedDraft: 'Agent Ops rewrote this' });
    expect(r.outcome).toBe('posted');
    state.rows = [row({ id: 'q' })];
    const r2 = await Runner.postNow('q', { type: 'admin' }, { expectedDraft: null });
    expect(r2.outcome).toBe('posted');
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
    // codex r36: a failing re-verification surfaces the fresh draft instead of publishing it unseen.
    expect(r).toMatchObject({ outcome: 'parked', reason: 'draft_replaced', drafted: true });
    expect(mockDraft).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'draft_replaced', auto_reply_draft: GOOD_DRAFT.text });
    // The surfaced draft posts on the next Post now.
    state.rows[0].auto_reply_grounding = JSON.parse(state.rows[0].auto_reply_grounding);
    r = await Runner.postNow('rev-1', { type: 'admin', adminUserId: 'u1' }, { expectedDraft: GOOD_DRAFT.text });
    expect(r.outcome).toBe('posted');
    expect(mockPublish.mock.calls[0][0].text).toBe(GOOD_DRAFT.text);
    expect(state.rows[0].auto_reply_status).toBe('posted');
  });
  test('postNow of a human [DRAFT] whose PUT timed out records the attempted text, so the sync can close a landed write as POSTED (codex r34)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const { ReviewReplyError } = require('../services/review-reply/publisher');
    const human = 'Thanks Dana, the owner here — glad it went well.';
    state.rows = [row({ id: 'hu', auto_reply_status: 'parked', auto_reply_reason: 'human_draft', review_reply: '[DRAFT] ' + human, auto_reply_draft: null })];
    mockPublish.mockImplementationOnce(async ({ reviewId }) => { const r = state.rows.find((x) => x.id === reviewId); Object.assign(r, { auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain', auto_reply_claimed_until: null }); throw new ReviewReplyError('google_uncertain', 'timed out', { status: 502 }); });
    await expect(Runner.postNow('hu', { type: 'admin' }, { expectedDraft: human })).rejects.toMatchObject({ code: 'google_uncertain' });
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain', auto_reply_draft: human });
    expect(state.rows[0].auto_reply_drafted_at).toBeTruthy();
    // The next sync sees the human text live on Google → ours, posted (Retract stays available).
    expect(Runner.syncReplyFields(state.rows[0], { owner_reply: human, owner_reply_updated_at: '2026-08-27T15:00:00Z' }, { now: new Date('2026-08-27T15:05:00Z') }))
      .toMatchObject({ review_reply: human, auto_reply_status: 'posted', auto_reply_reason: null, auto_reply_published_at: '2026-08-27T15:00:00Z' });
  });

  test('a stale human draft is refused verbatim by Use Draft and Post now until edited or re-saved (codex r35)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const text = 'Owner wrote this for the 5-star version';
    const stale = row({ id: 'st', star_rating: 1, review_text: 'Actually terrible', auto_reply_status: 'parked', auto_reply_reason: 'human_draft_stale', review_reply: '[DRAFT] ' + text, auto_reply_draft: null });
    expect(await Runner.pipelineDraftGuard(text)(stale)).toMatch(/written before the review changed/);
    expect(await Runner.pipelineDraftGuard(text + ' Edited for the new review.')(stale)).toBeNull();
    state.rows = [stale];
    await expect(Runner.postNow('st', { type: 'admin' }, { expectedDraft: text })).rejects.toMatchObject({ code: 'stale_claim', status: 409 });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(state.rows[0].auto_reply_claimed_until).toBeNull();
    // applyReviewEditFields works for a never-queued row (NULL state) too.
    const neverQueued = row({ id: 'nq', auto_reply_status: null, auto_reply_reason: null, review_reply: '[DRAFT] ' + text, auto_reply_draft: null });
    state.rows = [{ ...neverQueued }];
    expect(await Runner.applyReviewEditFields('nq', neverQueued, { star_rating: 1, review_text: 'Actually terrible', reviewer_name: 'Dana W.' })).toBe(1);
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'human_draft_stale', review_reply: '[DRAFT] ' + text });
  });

  test('a 4★ under REVIEW_AUTO_REPLY_MIN_STARS=5 parks below_threshold, never low_rating (codex r40)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    process.env.REVIEW_AUTO_REPLY_MIN_STARS = '5';
    state.rows = [row({ id: 't4', star_rating: 4 })];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'below_threshold' });
    expect(mockNotify.mock.calls.at(-1)[1]).toMatch(/below the auto-post threshold/);
    state.rows = [row({ id: 't2', star_rating: 2 })];
    await Runner.processDueAutoReplies();
    expect(state.rows[0]).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'low_rating' });
  });

  test('postNow of a stored AUTO draft carries its grounding snapshot + expected account fingerprint through the publisher (codex r42)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const stored = { fingerprint: Runner.reviewFingerprint(row()), accountFingerprint: 'fp:Venice|new', review: { rating: 5 } };
    state.rows = [row({ id: 'ag', auto_reply_status: 'drafted', auto_reply_reason: 'shadow', auto_reply_draft: GOOD_DRAFT.text, review_reply: '[DRAFT] ' + GOOD_DRAFT.text, auto_reply_version: GOOD_DRAFT.version, auto_reply_mode: GOOD_DRAFT.mode, auto_reply_grounding: stored })];
    mockAccountFacts.mockResolvedValue({ city: 'Venice', tenure: 'new' });
    const r = await Runner.postNow('ag', { type: 'admin' }, { expectedDraft: GOOD_DRAFT.text });
    expect(r.outcome).toBe('posted');
    const call = mockPublish.mock.calls[0][0];
    expect(call.expectedAccountFingerprint).toBe('fp:Venice|new');
    expect(JSON.parse(call.autoFields.auto_reply_grounding)).toMatchObject({ accountFingerprint: 'fp:Venice|new' });
  });

  test('postNow of a human [DRAFT] stamps human provenance, never the earlier model version / grounding (codex r40)', async () => {
    process.env.GATE_REVIEW_AUTO_REPLY = 'auto';
    const human = 'Thanks Dana, the owner here.';
    state.rows = [row({ id: 'hp', auto_reply_status: 'parked', auto_reply_reason: 'human_draft', review_reply: '[DRAFT] ' + human, auto_reply_draft: 'old model draft', auto_reply_version: 'reply-v1', auto_reply_mode: 'results', auto_reply_grounding: { accountFingerprint: 'fp:old' }, auto_reply_drafted_at: '2026-08-20T00:00:00Z' })];
    const r = await Runner.postNow('hp', { type: 'admin' }, { expectedDraft: human });
    expect(r.outcome).toBe('posted');
    const af = mockPublish.mock.calls[0][0].autoFields;
    expect(af).toMatchObject({ auto_reply_draft: human, auto_reply_version: 'human', auto_reply_mode: null, auto_reply_grounding: null });
    expect(mockPublish.mock.calls[0][0].auditMeta).toMatchObject({ version: 'human', mode: null, intent: 'post_now' });
    expect(af.auto_reply_drafted_at).not.toBe('2026-08-20T00:00:00Z');
  });

  test('a malformed grounding token is never an unguarded submission (codex r47)', async () => {
    const fp = Runner.reviewFingerprint(row());
    expect(Runner.parseGroundingToken(`${fp}|${'a'.repeat(40)}`)).toEqual({ review: fp, account: 'a'.repeat(40) });
    // codex r67: optional text segment binds the approved draft.
    const tfp = Runner.replyTextFingerprint('Hi Dana, thanks.');
    expect(Runner.parseGroundingToken(`${fp}|${'a'.repeat(40)}#${tfp}`)).toEqual({ review: fp, account: 'a'.repeat(40), text: tfp });
    expect(Runner.parseGroundingToken(`${fp}|fp:Venice|new#${tfp}`)).toEqual({ review: fp, account: 'fp:Venice|new', text: tfp });
    expect(Runner.parseGroundingToken(`${fp}|${'a'.repeat(40)}#nothex`)).toBeNull();
    expect(Runner.parseGroundingToken(`|${'a'.repeat(40)}`)).toBeNull();
    expect(Runner.parseGroundingToken('|')).toBeNull();
    expect(Runner.parseGroundingToken(`${fp}|`)).toBeNull();
    expect(Runner.parseGroundingToken('not-a-token')).toBeNull();
    for (const bad of [`|${'a'.repeat(40)}`, '|', 'garbage']) {
      expect(await Runner.pipelineDraftGuard('AI text', { groundingToken: bad })(row())).toMatch(/malformed/);
    }
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
    // codex r67: reconciliation parks (a PUT may be live) cannot be skipped.
    state.rows.push(row({ id: 'gu', auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain' }), row({ id: 'pf', auto_reply_status: 'parked', auto_reply_reason: 'persist_failed' }), row({ id: 'lr', auto_reply_status: 'parked', auto_reply_reason: 'low_rating' }));
    expect(await Runner.skipAutoReply('gu')).toBe(false);
    expect(await Runner.skipAutoReply('pf')).toBe(false);
    expect(state.rows.find((r) => r.id === 'gu')).toMatchObject({ auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain' });
    expect(await Runner.skipAutoReply('lr')).toBe(true);
  });
});
