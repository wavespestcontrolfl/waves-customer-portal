/**
 * Exceptions-only review queue (owner directive 2026-07-18): the runner must
 * never park routine dispositions for human review.
 *
 *   - A full day/week publish cap defers the opportunity to the next cap
 *     window BEFORE drafting (no generation spend, no review item).
 *   - A hard-gate failure (content guardrails / comparison table) gets ONE
 *     feedback-informed redraft: the blocking findings are recorded on the
 *     opportunity's signal_metadata and the row is deferred back to pending.
 *     A second failure skips silently — never pending_review.
 */

function makeDbMock() {
  const updates = [];
  const dbMock = jest.fn((table) => {
    const chain = {
      _table: table,
      _wheres: [],
      insert: jest.fn(() => ({
        returning: jest.fn().mockResolvedValue([{ id: 'run_1' }]),
        onConflict: jest.fn(() => ({ ignore: jest.fn(() => ({ returning: jest.fn().mockResolvedValue([{ id: 'run_1' }]) })) })),
      })),
      where: jest.fn(function where(...args) { chain._wheres.push(args); return chain; }),
      update: jest.fn((patch) => { updates.push({ table, wheres: chain._wheres, patch }); return Promise.resolve(1); }),
    };
    return chain;
  });
  dbMock.raw = jest.fn((sql) => ({ __raw: sql }));
  dbMock._updates = updates;
  return dbMock;
}

// The pre-draft topic-targeting gate (step 2d) needs the live blog corpus
// for its entity-ownership check and fails CLOSED on an empty/unavailable
// corpus — stub one benign post so new_supporting_blog runs reach drafting.
const STUB_CORPUS = [{
  path: 'src/content/blog/pest-control/seasonal-ant-pressure.md',
  url: '/pest-control/seasonal-ant-pressure/',
  body: '---\ntitle: Seasonal Ant Pressure in SWFL\nslug: /pest-control/seasonal-ant-pressure/\nprimary_keyword: seasonal ant pressure\n---\n\n## Why ants surge\n',
}];

function loadRunner({ queue, briefBuilder, dispatcher = {}, contentGuardrails, uniquenessGate, qualityGate, dbMock = makeDbMock() }) {
  jest.resetModules();
  jest.doMock('../models/db', () => dbMock);
  jest.doMock('../services/content/internal-link-planner', () => ({
    loadAstroCorpusFromGitHub: jest.fn().mockResolvedValue(STUB_CORPUS),
  }));
  jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  jest.doMock('../services/content/opportunity-queue', () => queue);
  jest.doMock('../services/content/content-brief-builder', () => briefBuilder);
  jest.doMock('../services/content/agents/agent-dispatcher', () => dispatcher);
  jest.doMock('../services/content/protected-pages', () => ({ isProtected: jest.fn().mockResolvedValue({ protected: false }) }));
  jest.doMock('../services/content/seo-completion-gate', () => ({ evaluate: jest.fn().mockReturnValue({ passed: true, score: 100, summary: { p0: 0, p1: 0, p2: 0 }, findings: [] }) }));
  jest.doMock('../services/content/ai-visibility-gate', () => ({ evaluateStatic: jest.fn().mockReturnValue({ passed: true, findings: [], summary: { p0: 0, p1: 0, p2: 0, p3: 0, needs_review: false } }) }));
  if (contentGuardrails) jest.doMock('../services/content/content-guardrails', () => contentGuardrails);
  else jest.dontMock('../services/content/content-guardrails');
  if (uniquenessGate) jest.doMock('../services/content/uniqueness-gate', () => uniquenessGate);
  else jest.dontMock('../services/content/uniqueness-gate');
  if (qualityGate) jest.doMock('../services/content/content-quality-gate', () => qualityGate);
  else jest.dontMock('../services/content/content-quality-gate');
  jest.dontMock('../services/content/comparison-table-gate');
  jest.dontMock('../services/content/claims-ledger-validator');
  const runner = require('../services/content/autonomous-runner');
  return { runner, dbMock };
}

const claimedAt = new Date('2026-07-17T13:00:00Z');

function makeQueue(opp) {
  return {
    claimNext: jest.fn().mockResolvedValue(opp),
    complete: jest.fn().mockResolvedValue(true),
    pendingReview: jest.fn().mockResolvedValue(true),
    skip: jest.fn().mockResolvedValue(true),
    defer: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(true),
  };
}

afterEach(() => {
  delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
  delete process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_WEEK;
  delete process.env.AUTONOMOUS_CONTENT_BLOG_UNIQUENESS;
});

describe('pre-brief routed disposition', () => {
  test.each([
    ['refresh_existing_page', 'new_supporting_blog', 'skip'],
    ['new_supporting_blog', 'refresh_existing_page', 'pendingReview'],
  ])('%s routed to %s uses %s on a protected-page lookup failure', async (provisional, effective, disposition) => {
    const queue = makeQueue({ id: 'opp_routed', action_type: provisional, effective_action_type: effective, claimed_at: claimedAt });
    const briefBuilder = { compose: jest.fn() };
    const { runner } = loadRunner({ queue, briefBuilder });
    runner._checkProtectedPage = jest.fn().mockResolvedValue({ protected: true, is_error: true, reason: 'lookup_unavailable' });

    const result = await runner.runNext();

    expect(result.action_type).toBe(effective);
    expect(queue[disposition]).toHaveBeenCalledWith('opp_routed', 'protected_page:lookup_unavailable', { claimToken: claimedAt });
    expect(queue[disposition === 'skip' ? 'pendingReview' : 'skip']).not.toHaveBeenCalled();
    expect(briefBuilder.compose).not.toHaveBeenCalled();
  });
});

describe('publish-cap pre-check (step 1a.3)', () => {
  test('a full weekly cap defers AFTER brief composition (final action type) but BEFORE drafting — no writer spend, no review item', async () => {
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_WEEK = '7';
    const queue = makeQueue({ id: 'opp_cap', action_type: 'new_supporting_blog', claimed_at: claimedAt });
    const briefBuilder = {
      compose: jest.fn().mockResolvedValue({
        id: 'brief_cap', action_type: 'new_supporting_blog', page_type: 'supporting-blog', human_review_required: false,
      }),
    };
    const dispatcher = { runWithBrief: jest.fn() };
    const { runner } = loadRunner({ queue, briefBuilder, dispatcher });
    runner._countPublishedSince = jest.fn().mockResolvedValue(7);

    const result = await runner.runNext();

    expect(result.outcome).toBe('deferred_publish_cap');
    expect(result.skip_reason).toBe('canary_weekly_publish_cap');
    // The brief IS composed (the router can retarget the action type — the
    // cap must key on the FINAL action), but the writer never dispatches.
    expect(briefBuilder.compose).toHaveBeenCalled();
    expect(dispatcher.runWithBrief).not.toHaveBeenCalled();
    expect(queue.pendingReview).not.toHaveBeenCalled();
    expect(queue.defer).toHaveBeenCalledTimes(1);
    const [oppId, availableAt, payload] = queue.defer.mock.calls[0];
    expect(oppId).toBe('opp_cap');
    expect(availableAt).toBeInstanceOf(Date);
    expect(availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(payload).toEqual({ claimToken: claimedAt });
  });

  test('shadow runs are exempt — the cap never blocks a shadow draft', async () => {
    // Shadow default is ON for unset SHADOW_MODE_* — leave it unset.
    process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_WEEK = '7';
    const queue = makeQueue({ id: 'opp_cap_shadow', action_type: 'new_supporting_blog', claimed_at: claimedAt });
    // Brief compose rejecting keeps the test cheap: reaching compose at all
    // proves the pre-check did not intercept the shadow run.
    const briefBuilder = { compose: jest.fn().mockRejectedValue(new Error('stop here')) };
    const { runner } = loadRunner({ queue, briefBuilder });
    runner._countPublishedSince = jest.fn().mockResolvedValue(7);

    const result = await runner.runNext();

    expect(queue.defer).not.toHaveBeenCalled();
    expect(briefBuilder.compose).toHaveBeenCalled();
    expect(result.outcome).not.toBe('deferred_publish_cap');
  });
});

describe('hard-gate failure: one feedback redraft, then silent skip', () => {
  const failingGuardrails = {
    evaluate: jest.fn().mockReturnValue({
      pass: false,
      findings: [{ severity: 'P0', code: 'HARDCODED_PRICE', message: 'body contains $199' }],
    }),
  };
  const makeBriefBuilder = () => ({
    compose: jest.fn().mockResolvedValue({
      id: 'brief_gate', action_type: 'new_supporting_blog', page_type: 'supporting-blog', human_review_required: false,
    }),
  });
  const makeDispatcher = () => ({
    runWithBrief: jest.fn().mockResolvedValue({
      ok: true,
      draft: { url: '/blog/gate-fail/', title: 'Gate Fail Post', body: 'Benign copy about seasonal ant pressure in Southwest Florida homes.' },
    }),
  });

  test('first failure records feedback on the opportunity and defers for a redraft', async () => {
    const queue = makeQueue({ id: 'opp_gate_1', action_type: 'new_supporting_blog', claimed_at: claimedAt, signal_metadata: {} });
    const { runner, dbMock } = loadRunner({
      queue, briefBuilder: makeBriefBuilder(), dispatcher: makeDispatcher(), contentGuardrails: failingGuardrails,
    });

    const result = await runner.runNext();

    expect(result.outcome).toBe('deferred_gate_retry');
    expect(result.skip_reason).toBe('content_guardrails_failed');
    expect(queue.defer).toHaveBeenCalledWith('opp_gate_1', expect.any(Date), { claimToken: claimedAt });
    expect(queue.pendingReview).not.toHaveBeenCalled();
    expect(queue.skip).not.toHaveBeenCalled();
    const retryWrite = dbMock._updates.find((u) => u.table === 'opportunity_queue');
    expect(retryWrite).toBeTruthy();
    expect(String(retryWrite.patch.signal_metadata)).toContain('HARDCODED_PRICE');
  });

  test('aggregate quality-gate MISS (no infra error) also gets the redraft-then-skip disposition', async () => {
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    // Blog dedup needs the astro corpus, which is unavailable in unit tests
    // and would surface as a gate INFRA error (which parks, by design).
    // Disable it so the QUALITY miss is what drives the disposition.
    process.env.AUTONOMOUS_CONTENT_BLOG_UNIQUENESS = 'false';
    const queue = makeQueue({ id: 'opp_agg', action_type: 'new_supporting_blog', claimed_at: claimedAt, signal_metadata: {} });
    const { runner, dbMock } = loadRunner({
      queue,
      briefBuilder: makeBriefBuilder(),
      dispatcher: makeDispatcher(),
      uniquenessGate: { evaluateBlog: jest.fn().mockReturnValue({ ok: true }), evaluate: jest.fn().mockReturnValue({ ok: true }) },
      // A real quality MISS: ok:false with hard failures and NO `.error`
      // (an `.error` shape is a gate infra fault and must still park).
      qualityGate: { evaluate: jest.fn().mockReturnValue({ ok: false, hard_failures: ['word_count'], soft_failures: [], total_score: 40, min_total_score: 80 }) },
    });

    const result = await runner.runNext();

    expect(result.outcome).toBe('deferred_gate_retry');
    expect(result.skip_reason).toBe('auto_publish_gate_fail');
    expect(queue.defer).toHaveBeenCalledWith('opp_agg', expect.any(Date), { claimToken: claimedAt });
    expect(queue.pendingReview).not.toHaveBeenCalled();
    const retryWrite = dbMock._updates.find((u) => u.table === 'opportunity_queue');
    expect(String(retryWrite.patch.signal_metadata)).toContain('QUALITY_GATE');
  });

  test('second failure (gate_retry already recorded) skips silently — never pending_review', async () => {
    const queue = makeQueue({
      id: 'opp_gate_2',
      action_type: 'new_supporting_blog',
      claimed_at: claimedAt,
      signal_metadata: { gate_retry: { at: '2026-07-17T13:05:00Z', skip_reason: 'content_guardrails_failed', findings: [] } },
    });
    const { runner } = loadRunner({
      queue, briefBuilder: makeBriefBuilder(), dispatcher: makeDispatcher(), contentGuardrails: failingGuardrails,
    });

    const result = await runner.runNext();

    expect(result.outcome).toBe('skipped_gate_fail');
    expect(result.skip_reason).toBe('content_guardrails_failed');
    expect(queue.skip).toHaveBeenCalledWith('opp_gate_2', 'content_guardrails_failed', { claimToken: claimedAt });
    expect(queue.defer).not.toHaveBeenCalled();
    expect(queue.pendingReview).not.toHaveBeenCalled();
  });
});

describe('agent stream EOF retry (session_stream_eof)', () => {
  const makeBriefBuilder = () => ({
    compose: jest.fn().mockResolvedValue({
      id: 'brief_eof', action_type: 'new_supporting_blog', page_type: 'supporting-blog', human_review_required: false,
    }),
  });
  const eof = (session, duration_ms = 240000) => ({ ok: false, code: 'session_stream_eof', reason: `streaming_failed: session ${session} stream ended without a terminal event`, session_id: session, duration_ms });

  afterEach(() => { delete process.env.AUTONOMOUS_CONTENT_STREAM_EOF_RETRIES; });

  test('re-dispatches the same brief once after a provider stream EOF and uses the second result', async () => {
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.AUTONOMOUS_CONTENT_BLOG_UNIQUENESS = 'false';
    const queue = makeQueue({ id: 'opp_eof', action_type: 'new_supporting_blog', claimed_at: claimedAt, signal_metadata: {} });
    const dispatcher = {
      runWithBrief: jest.fn()
        .mockResolvedValueOnce(eof('sesn_1'))
        .mockResolvedValueOnce({ ok: true, session_id: 'sesn_2', duration_ms: 300000, draft: { url: '/blog/eof-retry/', title: 'EOF Retry Post', body: 'Benign copy about seasonal ant pressure in Southwest Florida homes.' } }),
    };
    const { runner } = loadRunner({
      queue, briefBuilder: makeBriefBuilder(), dispatcher,
      uniquenessGate: { evaluateBlog: jest.fn().mockReturnValue({ ok: true }), evaluate: jest.fn().mockReturnValue({ ok: true }) },
      qualityGate: { evaluate: jest.fn().mockReturnValue({ ok: false, hard_failures: ['word_count'], soft_failures: [], total_score: 40, min_total_score: 80 }) },
    });

    const result = await runner.runNext();

    expect(dispatcher.runWithBrief).toHaveBeenCalledTimes(2);
    expect(dispatcher.runWithBrief.mock.calls[0][0]).toBe(dispatcher.runWithBrief.mock.calls[1][0]);
    // The draft reached the gates (a quality MISS, not failed_agent) — the
    // retry delivered a draft where the first attempt had none.
    expect(result.outcome).not.toBe('failed_agent');
    expect(result.agent_session_id).toBe('sesn_2');
    // agent_ms is the "Write draft" stage duration — it spans BOTH sessions.
    expect(result.agent_ms).toBe(540000);
  });

  test('a second EOF files failed_agent; deadline timeouts are never retried', async () => {
    const queue = makeQueue({ id: 'opp_eof2', action_type: 'new_supporting_blog', claimed_at: claimedAt, signal_metadata: {} });
    const dispatcher = { runWithBrief: jest.fn().mockResolvedValue(eof('sesn_x')) };
    const { runner } = loadRunner({ queue, briefBuilder: makeBriefBuilder(), dispatcher });
    const result = await runner.runNext();
    expect(dispatcher.runWithBrief).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe('failed_agent');
    expect(result.failure_message).toMatch(/stream ended without a terminal event/);
    expect(queue.release).toHaveBeenCalledWith('opp_eof2', { claimToken: claimedAt });

    const timeoutDispatcher = { runWithBrief: jest.fn().mockResolvedValue({ ok: false, code: 'session_timeout', reason: 'streaming_failed: session sesn_t timed out at its deadline' }) };
    const { runner: runner2 } = loadRunner({ queue: makeQueue({ id: 'opp_to', action_type: 'new_supporting_blog', claimed_at: claimedAt, signal_metadata: {} }), briefBuilder: makeBriefBuilder(), dispatcher: timeoutDispatcher });
    const result2 = await runner2.runNext();
    expect(timeoutDispatcher.runWithBrief).toHaveBeenCalledTimes(1);
    expect(result2.outcome).toBe('failed_agent');
  });

  test('a retry that dies before creating a session keeps the first session pointer (Codex r3)', async () => {
    const queue = makeQueue({ id: 'opp_eof_nc', action_type: 'new_supporting_blog', claimed_at: claimedAt, signal_metadata: {} });
    const dispatcher = {
      runWithBrief: jest.fn()
        .mockResolvedValueOnce({ ...eof('sesn_real'), agent_id: 'agent_1' })
        .mockResolvedValueOnce({ ok: false, code: 'session_create_failed', reason: 'session_create_failed: 503', duration_ms: 1200 }),
    };
    const { runner } = loadRunner({ queue, briefBuilder: makeBriefBuilder(), dispatcher });
    const result = await runner.runNext();
    expect(dispatcher.runWithBrief).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe('failed_agent');
    expect(result.failure_message).toBe('session_create_failed: 503');
    // The only session that ever existed must stay correlatable.
    expect(result.agent_session_id).toBe('sesn_real');
    expect(result.agent_id).toBe('agent_1');
    expect(result.agent_ms).toBe(241200);
  });

  test('AUTONOMOUS_CONTENT_STREAM_EOF_RETRIES=0 disarms the retry', async () => {
    process.env.AUTONOMOUS_CONTENT_STREAM_EOF_RETRIES = '0';
    const queue = makeQueue({ id: 'opp_eof0', action_type: 'new_supporting_blog', claimed_at: claimedAt, signal_metadata: {} });
    const dispatcher = { runWithBrief: jest.fn().mockResolvedValue(eof('sesn_0')) };
    const { runner } = loadRunner({ queue, briefBuilder: makeBriefBuilder(), dispatcher });
    const result = await runner.runNext();
    expect(dispatcher.runWithBrief).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('failed_agent');
  });
});
