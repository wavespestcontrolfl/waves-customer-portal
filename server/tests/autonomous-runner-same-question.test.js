/**
 * Same-question check in the autonomous runner (owner 2026-10-30, step 2d-bis,
 * GATE_SAME_QUESTION_CHECK). A new supporting blog whose topic words a live
 * post already holds in its title / slug / primary keyword:
 *   - gate OFF (default): SHADOW. The verdict is recorded on
 *     run.topic_targeting_result.same_question; the row still reaches the writer.
 *   - gate ON: skipped by design (topic_targeting:TOPIC_SAME_QUESTION_LIVE) and
 *     one refresh of the owner page is queued.
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
      whereRaw: jest.fn(function whereRaw(...args) { chain._wheres.push(['raw', ...args]); return chain; }),
      update: jest.fn((patch) => { updates.push({ table, wheres: chain._wheres, patch }); return Promise.resolve(1); }),
    };
    return chain;
  });
  dbMock.raw = jest.fn((sql, bindings = []) => ({ __raw: sql, bindings }));
  dbMock._updates = updates;
  return dbMock;
}

const MILLIPEDE = {
  path: 'src/content/blog/pest-control/millipede-vs-centipede-southwest-florida.mdx',
  url: '/pest-control/millipede-vs-centipede-southwest-florida/',
  body: "---\ntitle: 'Millipede vs Centipede in Southwest Florida: Which One Is in Your House?'\nslug: /pest-control/millipede-vs-centipede-southwest-florida/\nprimary_keyword: millipede vs centipede\ncategory: pest-control\n---\n\n## How to tell them apart\n",
};
const COCKROACH = {
  path: 'src/content/blog/pest-control/get-rid-of-german-cockroaches.mdx',
  url: '/pest-control/get-rid-of-german-cockroaches/',
  body: "---\ntitle: How to Get Rid of German Cockroaches\nslug: /pest-control/get-rid-of-german-cockroaches/\nprimary_keyword: german cockroach\ncategory: pest-control\n---\n\n## Why they come back\n",
};

const claimedAt = new Date('2026-08-27T13:00:00Z');

function loadRunner({ sameQuestionRefresh = null, queue, briefBuilder, dispatcher = { runWithBrief: jest.fn() }, corpus = [MILLIPEDE, COCKROACH], corpusError = null, topicGate, dbMock = makeDbMock(), factsOk = false, guardrails = { pass: true, findings: [] } }) {
  jest.resetModules();
  // A brief that carries a city makes the facts-sufficiency gate (step 2b,
  // before the topic gate) applicable; `factsOk` stubs it sufficient so the
  // test reaches step 2d.
  // (doMock survives resetModules — undo it for the next load.)
  if (factsOk) jest.doMock('../services/content/facts-sufficiency', () => ({ check: jest.fn().mockResolvedValue({ applicable: true, sufficient: true }) }));
  else jest.dontMock('../services/content/facts-sufficiency');
  jest.doMock('../models/db', () => dbMock);
  jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  // A pending-review park schedules the owner notification via setImmediate;
  // the real module's require would land after Jest teardown. No-op it and
  // drain the immediate in afterEach (same harness as autonomous-runner.test).
  jest.doMock('../services/content/email-approvals', () => ({
    notifyParkedRun: jest.fn().mockResolvedValue(undefined),
    _internals: { draftPreview: jest.fn().mockReturnValue('') },
  }));
  jest.doMock('../services/content/opportunity-queue', () => queue);
  if (sameQuestionRefresh) jest.doMock('../services/content/same-question-refresh', () => sameQuestionRefresh);
  else jest.dontMock('../services/content/same-question-refresh');
  jest.doMock('../services/content/content-brief-builder', () => briefBuilder);
  jest.doMock('../services/content/agents/agent-dispatcher', () => dispatcher);
  jest.doMock('../services/content/protected-pages', () => ({ isProtected: jest.fn().mockResolvedValue({ protected: false }) }));
  jest.doMock('../services/content/internal-link-planner', () => ({
    loadAstroCorpusFromGitHub: corpusError
      ? jest.fn().mockRejectedValue(new Error(corpusError))
      : jest.fn().mockResolvedValue(corpus),
  }));
  jest.doMock('../services/content/content-guardrails', () => ({ evaluate: jest.fn().mockReturnValue(guardrails) }));
  jest.doMock('../services/content/seo-completion-gate', () => ({ evaluate: jest.fn().mockReturnValue({ passed: true, score: 100, summary: { p0: 0, p1: 0, p2: 0 }, findings: [] }) }));
  jest.doMock('../services/content/ai-visibility-gate', () => ({ evaluateStatic: jest.fn().mockReturnValue({ passed: true, findings: [], summary: { p0: 0, p1: 0, p2: 0, p3: 0, needs_review: false } }) }));
  if (topicGate) jest.doMock('../services/content/topic-targeting-gate', () => topicGate);
  else jest.dontMock('../services/content/topic-targeting-gate');
  jest.dontMock('../services/content/uniqueness-gate');
  jest.dontMock('../services/content/content-quality-gate');
  jest.dontMock('../services/content/comparison-table-gate');
  jest.dontMock('../services/content/claims-ledger-validator');
  const runner = require('../services/content/autonomous-runner');
  return { runner, dbMock };
}

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

function blogBrief(over = {}) {
  return {
    compose: jest.fn().mockResolvedValue({
      id: 'brief_topic', action_type: 'new_supporting_blog', page_type: 'supporting-blog', human_review_required: false,
      target_keyword: over.query || 'house came with taexx',
      service: over.service || 'pest',
      city: over.city || null,
      voice_constraints: over.operator_brief ? { operator_brief: over.operator_brief } : {},
    }),
  };
}

beforeEach(() => {
  process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
  process.env.AUTONOMOUS_CONTENT_BLOG_UNIQUENESS = 'false';
});
afterEach(async () => {
  // Drain the runner's setImmediate-scheduled notification before Jest
  // tears the environment down.
  await new Promise((resolve) => { setImmediate(resolve); });
  delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
  delete process.env.AUTONOMOUS_CONTENT_BLOG_UNIQUENESS;
});


const OLD_GATE = process.env.GATE_SAME_QUESTION_CHECK;
beforeEach(() => {
  process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
  process.env.AUTONOMOUS_CONTENT_BLOG_UNIQUENESS = 'false';
});
afterEach(async () => {
  await new Promise((resolve) => { setImmediate(resolve); });
  delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
  delete process.env.AUTONOMOUS_CONTENT_BLOG_UNIQUENESS;
  if (OLD_GATE === undefined) delete process.env.GATE_SAME_QUESTION_CHECK; else process.env.GATE_SAME_QUESTION_CHECK = OLD_GATE;
});

describe('step 2d-bis — same-question check', () => {
  const millipedeOpp = () => ({ id: 'opp_milli', action_type: 'new_supporting_blog', query: 'florida millipede', service: 'pest', claimed_at: claimedAt, signal_metadata: {} });

  test('gate OFF: shadow — the verdict is recorded, nothing is queued, the row still reaches the writer', async () => {
    delete process.env.GATE_SAME_QUESTION_CHECK;
    const queue = makeQueue(millipedeOpp());
    const dispatcher = { runWithBrief: jest.fn().mockResolvedValue({ ok: false, error: 'writer_stub' }) };
    const sameQuestionRefresh = { enqueueOwnerRefresh: jest.fn() };
    const { runner } = loadRunner({ queue, dispatcher, sameQuestionRefresh, briefBuilder: blogBrief({ query: 'florida millipede' }) });

    const result = await runner.runNext();

    expect(result.topic_targeting_result.same_question).toMatchObject({
      mode: 'shadow', would_block: true, reason: 'owner_found', owner_url: '/pest-control/millipede-vs-centipede-southwest-florida/', tokens: ['millipede'],
    });
    expect(result.skip_reason || '').not.toMatch(/TOPIC_SAME_QUESTION_LIVE/);
    expect(queue.skip).not.toHaveBeenCalledWith('opp_milli', 'topic_targeting:TOPIC_SAME_QUESTION_LIVE', expect.anything());
    expect(sameQuestionRefresh.enqueueOwnerRefresh).not.toHaveBeenCalled();
    expect(dispatcher.runWithBrief).toHaveBeenCalled();
  });

  test('gate ON: the new-post row is skipped by design and ONE owner refresh is queued with the question', async () => {
    process.env.GATE_SAME_QUESTION_CHECK = 'true';
    const queue = makeQueue(millipedeOpp());
    const dispatcher = { runWithBrief: jest.fn() };
    const sameQuestionRefresh = { enqueueOwnerRefresh: jest.fn().mockResolvedValue({ queued: true, reason: 'queued' }) };
    const { runner } = loadRunner({ queue, dispatcher, sameQuestionRefresh, briefBuilder: blogBrief({ query: 'florida millipede' }) });

    const result = await runner.runNext();

    expect(result.outcome).toBe('skipped_gate_fail');
    expect(result.skip_reason).toBe('topic_targeting:TOPIC_SAME_QUESTION_LIVE');
    expect(queue.skip).toHaveBeenCalledWith('opp_milli', 'topic_targeting:TOPIC_SAME_QUESTION_LIVE', { claimToken: claimedAt });
    expect(queue.pendingReview).not.toHaveBeenCalled();
    expect(dispatcher.runWithBrief).not.toHaveBeenCalled();
    expect(sameQuestionRefresh.enqueueOwnerRefresh).toHaveBeenCalledTimes(1);
    expect(sameQuestionRefresh.enqueueOwnerRefresh).toHaveBeenCalledWith(expect.objectContaining({
      owner: expect.objectContaining({ url: '/pest-control/millipede-vs-centipede-southwest-florida/' }),
      tokens: ['millipede'],
      question: 'florida millipede',
      sourceOpportunityId: 'opp_milli',
    }));
    expect(result.topic_targeting_result.same_question).toMatchObject({ mode: 'on', would_block: true, refresh: { queued: true } });
    expect(result.reviewer_notes).toMatch(/millipede-vs-centipede/);
  });

  test('gate ON: a refused or failed owner refresh still skips the new post (the block stands) and says why', async () => {
    process.env.GATE_SAME_QUESTION_CHECK = 'true';
    const queue = makeQueue(millipedeOpp());
    const sameQuestionRefresh = { enqueueOwnerRefresh: jest.fn().mockRejectedValue(new Error('db_down')) };
    const { runner } = loadRunner({ queue, dispatcher: { runWithBrief: jest.fn() }, sameQuestionRefresh, briefBuilder: blogBrief({ query: 'florida millipede' }) });

    const result = await runner.runNext();

    expect(result.skip_reason).toBe('topic_targeting:TOPIC_SAME_QUESTION_LIVE');
    expect(result.topic_targeting_result.same_question.refresh).toMatchObject({ queued: false });
    expect(result.topic_targeting_result.same_question.refresh.reason).toMatch(/enqueue_error:db_down/);
  });

  test('a broad one-word topic ("cockroach types in florida" vs the German cockroach post) never blocks, gate ON', async () => {
    process.env.GATE_SAME_QUESTION_CHECK = 'true';
    const queue = makeQueue({ id: 'opp_roach', action_type: 'new_supporting_blog', query: 'cockroach types in florida', service: 'pest', claimed_at: claimedAt, signal_metadata: {} });
    const dispatcher = { runWithBrief: jest.fn().mockResolvedValue({ ok: false, error: 'writer_stub' }) };
    const sameQuestionRefresh = { enqueueOwnerRefresh: jest.fn() };
    const { runner } = loadRunner({ queue, dispatcher, sameQuestionRefresh, briefBuilder: blogBrief({ query: 'cockroach types in florida' }) });

    const result = await runner.runNext();

    expect(result.topic_targeting_result.same_question).toMatchObject({ would_block: false, reason: 'broad_single_word' });
    expect(dispatcher.runWithBrief).toHaveBeenCalled();
    expect(sameQuestionRefresh.enqueueOwnerRefresh).not.toHaveBeenCalled();
  });

  test('a whole-module feature-gates mock without the reader reads as OFF (shadow), never throws', async () => {
    process.env.GATE_SAME_QUESTION_CHECK = 'true';
    const queue = makeQueue(millipedeOpp());
    const dispatcher = { runWithBrief: jest.fn().mockResolvedValue({ ok: false, error: 'writer_stub' }) };
    const { runner } = loadRunner({ queue, dispatcher, briefBuilder: blogBrief({ query: 'florida millipede' }) });
    jest.doMock('../config/feature-gates', () => ({ isEnabled: () => false, gates: {} }));

    const result = await runner.runNext();

    expect(result.topic_targeting_result.same_question.mode).toBe('shadow');
    expect(dispatcher.runWithBrief).toHaveBeenCalled();
    jest.dontMock('../config/feature-gates');
  });
});
