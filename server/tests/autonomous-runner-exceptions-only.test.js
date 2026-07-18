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

function loadRunner({ queue, briefBuilder, dispatcher = {}, contentGuardrails, dbMock = makeDbMock() }) {
  jest.resetModules();
  jest.doMock('../models/db', () => dbMock);
  jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  jest.doMock('../services/content/opportunity-queue', () => queue);
  jest.doMock('../services/content/content-brief-builder', () => briefBuilder);
  jest.doMock('../services/content/agents/agent-dispatcher', () => dispatcher);
  jest.doMock('../services/content/protected-pages', () => ({ isProtected: jest.fn().mockResolvedValue({ protected: false }) }));
  jest.doMock('../services/content/seo-completion-gate', () => ({ evaluate: jest.fn().mockReturnValue({ passed: true, score: 100, summary: { p0: 0, p1: 0, p2: 0 }, findings: [] }) }));
  jest.doMock('../services/content/ai-visibility-gate', () => ({ evaluateStatic: jest.fn().mockReturnValue({ passed: true, findings: [], summary: { p0: 0, p1: 0, p2: 0, p3: 0, needs_review: false } }) }));
  if (contentGuardrails) jest.doMock('../services/content/content-guardrails', () => contentGuardrails);
  else jest.dontMock('../services/content/content-guardrails');
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
