/**
 * Topic-targeting gate wiring in the autonomous runner (owner rulings
 * 2026-08-27 after astro #476 Tampa / #490 second-Taexx / #491 "in Florida"):
 *
 *   - step 2d (pre-draft, NO writer spend): out-of-area demand, pinned
 *     statewide framing, or an entity a live post owns → silent by-design
 *     skip with a topic_targeting:<CODE> reason (exceptions-only queue);
 *     module/corpus unavailable → engine fault → pending_review (fail closed);
 *     refreshes never enter the gate.
 *   - post-draft: the writer's own statewide/out-of-area title → the same
 *     one-redraft-then-skip loop the guardrails use (topic_framing_failed).
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

const IN_WALL = {
  path: 'src/content/blog/pest-control/in-wall-pest-control.mdx',
  url: '/pest-control/in-wall-pest-control/',
  body: "---\ntitle: 'So…You’re Pumping Pesticides Into Your Walls on Purpose?'\nslug: /pest-control/in-wall-pest-control/\nmeta_description: What Taexx in-wall pest control actually pumps into your walls.\nprimary_keyword: in wall pest control\ncategory: pest-control\n---\n\n## What Is Taexx Pest Control?\n\n## So What Is the Taexx System Actually Doing?\n\n## Already Have Taexx? No Judgment.\n",
};
const BENIGN = {
  path: 'src/content/blog/pest-control/seasonal-ant-pressure.md',
  url: '/pest-control/seasonal-ant-pressure/',
  body: '---\ntitle: Seasonal Ant Pressure in SWFL\nslug: /pest-control/seasonal-ant-pressure/\nprimary_keyword: seasonal ant pressure\n---\n\n## Why ants surge\n',
};

const claimedAt = new Date('2026-08-27T13:00:00Z');

function loadRunner({ queue, briefBuilder, dispatcher = { runWithBrief: jest.fn() }, corpus = [IN_WALL, BENIGN], corpusError = null, topicGate, dbMock = makeDbMock() }) {
  jest.resetModules();
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
  jest.doMock('../services/content/content-brief-builder', () => briefBuilder);
  jest.doMock('../services/content/agents/agent-dispatcher', () => dispatcher);
  jest.doMock('../services/content/protected-pages', () => ({ isProtected: jest.fn().mockResolvedValue({ protected: false }) }));
  jest.doMock('../services/content/internal-link-planner', () => ({
    loadAstroCorpusFromGitHub: corpusError
      ? jest.fn().mockRejectedValue(new Error(corpusError))
      : jest.fn().mockResolvedValue(corpus),
  }));
  jest.doMock('../services/content/content-guardrails', () => ({ evaluate: jest.fn().mockReturnValue({ pass: true, findings: [] }) }));
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

describe('step 2d — pre-draft topic-targeting gate', () => {
  test('#476 shape: out-of-area demand skips BEFORE the corpus loads and before any writer spend (by-design → silent skip, not review)', async () => {
    const queue = makeQueue({ id: 'opp_tampa', action_type: 'new_supporting_blog', query: 'wdo inspection tampa', service: 'termite', claimed_at: claimedAt, signal_metadata: {} });
    const dispatcher = { runWithBrief: jest.fn() };
    const { runner } = loadRunner({ queue, briefBuilder: blogBrief({ query: 'wdo inspection tampa', service: 'termite' }), dispatcher, corpusError: 'github_down' });

    const result = await runner.runNext();

    expect(result.outcome).toBe('skipped_gate_fail');
    expect(result.skip_reason).toBe('topic_targeting:TOPIC_GEO_OUT_OF_AREA');
    expect(result.topic_targeting_result.findings[0].code).toBe('TOPIC_GEO_OUT_OF_AREA');
    expect(queue.skip).toHaveBeenCalledWith('opp_tampa', 'topic_targeting:TOPIC_GEO_OUT_OF_AREA', { claimToken: claimedAt });
    expect(queue.pendingReview).not.toHaveBeenCalled();
    expect(dispatcher.runWithBrief).not.toHaveBeenCalled();
  });

  test('#490 shape: an entity a live post owns (Taexx → in-wall post) skips with the owner named; no writer spend', async () => {
    const queue = makeQueue({ id: 'opp_taexx', action_type: 'new_supporting_blog', query: 'house came with taexx', service: 'pest', claimed_at: claimedAt, signal_metadata: {} });
    const dispatcher = { runWithBrief: jest.fn() };
    const { runner } = loadRunner({
      queue, dispatcher,
      briefBuilder: blogBrief({ operator_brief: { working_title: 'Your New Lakewood Ranch Home Came With Taexx: What It Misses', slug: '/pest-control/taexx-system-new-home-lakewood-ranch/' } }),
    });

    const result = await runner.runNext();

    expect(result.outcome).toBe('skipped_gate_fail');
    expect(result.skip_reason).toBe('topic_targeting:TOPIC_CANNIBALIZES_EXISTING');
    expect(result.topic_targeting_result.entity_owners.map((o) => o.url)).toEqual(['/pest-control/in-wall-pest-control/']);
    expect(result.reviewer_notes).toMatch(/in-wall-pest-control/);
    expect(queue.skip).toHaveBeenCalledWith('opp_taexx', 'topic_targeting:TOPIC_CANNIBALIZES_EXISTING', { claimToken: claimedAt });
    expect(dispatcher.runWithBrief).not.toHaveBeenCalled();
  });

  test('#491 shape: a PINNED statewide working title skips pre-draft', async () => {
    const queue = makeQueue({ id: 'opp_fl', action_type: 'new_supporting_blog', query: 'new construction pest control florida', service: 'pest', claimed_at: claimedAt, signal_metadata: {} });
    const dispatcher = { runWithBrief: jest.fn() };
    const { runner } = loadRunner({
      queue, dispatcher,
      briefBuilder: blogBrief({ query: 'new construction pest control florida', operator_brief: { working_title: 'New-Construction Pest Control in Florida: First-Year Plan', slug: '/pest-control/new-construction-pest-control-first-year-plan/' } }),
    });

    const result = await runner.runNext();

    expect(result.skip_reason).toBe('topic_targeting:TOPIC_GEO_STATEWIDE');
    expect(dispatcher.runWithBrief).not.toHaveBeenCalled();
  });

  test('a clean brief passes the gate and reaches the writer', async () => {
    const queue = makeQueue({ id: 'opp_ok', action_type: 'new_supporting_blog', query: 'ghost ants sarasota kitchen', service: 'pest', claimed_at: claimedAt, signal_metadata: {} });
    const dispatcher = { runWithBrief: jest.fn().mockResolvedValue({ ok: false, error: 'writer_stub' }) };
    const { runner } = loadRunner({ queue, dispatcher, briefBuilder: blogBrief({ query: 'ghost ants sarasota kitchen' }) });

    const result = await runner.runNext();

    expect(dispatcher.runWithBrief).toHaveBeenCalled();
    expect(result.topic_targeting_result).toMatchObject({ ok: true, corpus_size: 2 });
    expect(result.skip_reason || '').not.toMatch(/topic_targeting/);
  });

  test('corpus unavailable is an ENGINE fault: held for review, never drafted unchecked', async () => {
    const queue = makeQueue({ id: 'opp_corpus', action_type: 'new_supporting_blog', query: 'ghost ants sarasota kitchen', service: 'pest', claimed_at: claimedAt, signal_metadata: {} });
    const dispatcher = { runWithBrief: jest.fn() };
    const { runner } = loadRunner({ queue, dispatcher, briefBuilder: blogBrief({ query: 'ghost ants sarasota kitchen' }), corpusError: 'github_down' });

    const result = await runner.runNext();

    expect(result.outcome).toBe('skipped_gate_fail');
    expect(result.skip_reason).toBe('topic_targeting_unavailable');
    expect(queue.pendingReview).toHaveBeenCalledWith('opp_corpus', 'topic_targeting_unavailable', { claimToken: claimedAt });
    expect(queue.skip).not.toHaveBeenCalled();
    expect(dispatcher.runWithBrief).not.toHaveBeenCalled();
  });

  test('an EMPTY corpus is treated as a loader fault, not a pass', async () => {
    const queue = makeQueue({ id: 'opp_empty', action_type: 'new_supporting_blog', query: 'house came with taexx', service: 'pest', claimed_at: claimedAt, signal_metadata: {} });
    const dispatcher = { runWithBrief: jest.fn() };
    const { runner } = loadRunner({ queue, dispatcher, briefBuilder: blogBrief(), corpus: [] });

    const result = await runner.runNext();

    expect(result.skip_reason).toBe('topic_targeting_unavailable');
    expect(result.topic_targeting_result.error).toMatch(/empty_blog_corpus/);
    expect(dispatcher.runWithBrief).not.toHaveBeenCalled();
  });

  test('a refresh of the entity owner never enters the gate (that IS the sanctioned move)', async () => {
    const queue = makeQueue({ id: 'opp_refresh', action_type: 'refresh_existing_page', query: 'taexx system review', page_url: 'https://www.wavespestcontrol.com/pest-control/in-wall-pest-control/', claimed_at: claimedAt, signal_metadata: {} });
    const briefBuilder = {
      compose: jest.fn().mockResolvedValue({
        id: 'brief_refresh', action_type: 'refresh_existing_page', page_type: 'supporting-blog', human_review_required: false,
        target_keyword: 'taexx system review', target_url: 'https://www.wavespestcontrol.com/pest-control/in-wall-pest-control/',
      }),
    };
    const topicGate = { isApplicable: jest.fn().mockReturnValue(false), evaluate: jest.fn(), evaluateDraftFraming: jest.fn() };
    const { runner } = loadRunner({ queue, briefBuilder, topicGate, corpusError: 'github_down' });

    // The refresh lane needs publisher/prior-body plumbing this harness does
    // not provide; the run may fault downstream. What is pinned here is only
    // that the topic gate was consulted for applicability and never evaluated.
    const result = await runner.runNext().catch(() => null);

    expect(topicGate.isApplicable).toHaveBeenCalledWith({ actionType: 'refresh_existing_page', pageType: 'supporting-blog' });
    expect(topicGate.evaluate).not.toHaveBeenCalled();
    expect(result?.skip_reason || '').not.toMatch(/topic_targeting/);
  });
});

describe('post-draft topic framing', () => {
  const draftWith = (title) => ({
    runWithBrief: jest.fn().mockResolvedValue({
      ok: true,
      draft: {
        url: '/pest-control/kinds-of-ants/',
        title,
        frontmatter: { title, slug: '/pest-control/kinds-of-ants/', primary_keyword: 'kinds of ants in florida', meta_description: 'Which ants show up in Southwest Florida homes and what each one means for your kitchen and lawn.' },
        body: 'Benign copy about ant pressure in Southwest Florida homes.',
      },
    }),
  });

  test('statewide demand passes pre-draft, but a writer title framed "… in Florida" gets ONE feedback redraft (topic_framing_failed)', async () => {
    const queue = makeQueue({ id: 'opp_frame', action_type: 'new_supporting_blog', query: 'kinds of ants in florida', service: 'pest', claimed_at: claimedAt, signal_metadata: {} });
    const dispatcher = draftWith('Kinds of Ants in Florida: A Field Guide');
    const { runner } = loadRunner({ queue, dispatcher, briefBuilder: blogBrief({ query: 'kinds of ants in florida' }) });

    const result = await runner.runNext();

    expect(dispatcher.runWithBrief).toHaveBeenCalled();
    expect(result.outcome).toBe('deferred_gate_retry');
    expect(result.skip_reason).toBe('topic_framing_failed');
    expect(result.topic_targeting_result.framing.findings[0].code).toBe('TOPIC_GEO_STATEWIDE');
    expect(queue.defer).toHaveBeenCalledWith('opp_frame', expect.any(Date), { claimToken: claimedAt });
    expect(queue.pendingReview).not.toHaveBeenCalled();
  });

  test('a clean brief whose writer emits an OWNED primary_keyword is caught post-draft (topic_ownership_failed, one redraft)', async () => {
    const queue = makeQueue({ id: 'opp_own', action_type: 'new_supporting_blog', query: 'new home pest control lakewood ranch', service: 'pest', claimed_at: claimedAt, signal_metadata: {} });
    const dispatcher = {
      runWithBrief: jest.fn().mockResolvedValue({
        ok: true,
        draft: {
          url: '/pest-control/lakewood-ranch-in-wall-system/',
          title: 'Your New Lakewood Ranch Home Came With an In-Wall System',
          frontmatter: { title: 'Your New Lakewood Ranch Home Came With an In-Wall System', slug: '/pest-control/lakewood-ranch-in-wall-system/', primary_keyword: 'taexx in wall system', meta_description: 'What the in-wall tubes in a new Lakewood Ranch build actually do, and what they miss.' },
          body: 'Benign copy about new-construction pest control in Lakewood Ranch.',
        },
      }),
    };
    const { runner } = loadRunner({ queue, dispatcher, briefBuilder: blogBrief({ query: 'new home pest control lakewood ranch' }) });

    const result = await runner.runNext();

    expect(dispatcher.runWithBrief).toHaveBeenCalled();
    expect(result.outcome).toBe('deferred_gate_retry');
    expect(result.skip_reason).toBe('topic_ownership_failed');
    expect(result.topic_targeting_result.framing.stage).toBe('ownership');
    expect(result.topic_targeting_result.framing.findings[0].code).toBe('TOPIC_CANNIBALIZES_EXISTING');
    expect(queue.pendingReview).not.toHaveBeenCalled();
  });

  test('a localized title clears the framing check', async () => {
    const queue = makeQueue({ id: 'opp_frame_ok', action_type: 'new_supporting_blog', query: 'kinds of ants in florida', service: 'pest', claimed_at: claimedAt, signal_metadata: {} });
    const dispatcher = draftWith('Kinds of Ants in Sarasota Homes: A Field Guide');
    const { runner } = loadRunner({ queue, dispatcher, briefBuilder: blogBrief({ query: 'kinds of ants in florida' }) });

    const result = await runner.runNext();

    expect(result.skip_reason || '').not.toBe('topic_framing_failed');
    expect(result.topic_targeting_result.framing.ok).toBe(true);
  });
});
