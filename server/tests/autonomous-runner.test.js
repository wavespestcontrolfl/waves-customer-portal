/**
 * Unit tests for autonomous-runner pure helpers.
 *
 * The runNext() orchestration touches every downstream module; it's
 * exercised end-to-end by the CLI smoke test + during shadow-mode
 * rollout, not jest.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { _internals } = require('../services/content/autonomous-runner');
const {
  isShadow,
  autoPublishEnabled,
  applyOperatorSlugRepair,
  FACTS_GATED_ACTIONS,
  TRUST_BUILD_THRESHOLD,
  DEFAULT_MIN_SCORE,
  countsTowardTrustBuild,
  isDeterministicPublishError,
  envBool,
  envInt,
  agentSessionTimeoutMs,
  dailyBatchLimit,
  firstReturnedId,
  queueInternalLinkTaskForDryRun,
  citabilityAdvisoryMessages,
} = _internals;

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SHADOW_MODE_') || k.startsWith('AUTO_PUBLISH_')) delete process.env[k];
  }
  for (const k of Object.keys(ORIGINAL_ENV)) {
    if (k.startsWith('SHADOW_MODE_') || k.startsWith('AUTO_PUBLISH_')) process.env[k] = ORIGINAL_ENV[k];
  }
});

test('every citability soft failure is preserved as a separate advisory message', () => {
  const soft_failures = [
    { name: 'voice_match', reason: 'generic' },
    { name: 'citability_named_sources', reason: 'no source' },
    { name: 'citability_concrete_specifics', reason: 'no measurement' },
    { name: 'citability_comparison', reason: 'no table' },
    { name: 'citability_how_to_choose', reason: 'no criteria' },
  ];
  expect(citabilityAdvisoryMessages({ soft_failures })).toEqual([
    { code: 'CITABILITY_NAMED_SOURCES', message: 'no source' },
    { code: 'CITABILITY_CONCRETE_SPECIFICS', message: 'no measurement' },
    { code: 'CITABILITY_COMPARISON', message: 'no table' },
    { code: 'CITABILITY_HOW_TO_CHOOSE', message: 'no criteria' },
  ]);
});

describe('internal-link dry-run queue helpers', () => {
  test('extracts returned ids from knex insert shapes', () => {
    expect(firstReturnedId([{ id: 'task_1' }])).toBe('task_1');
    expect(firstReturnedId(['task_2'])).toBe('task_2');
    expect(firstReturnedId([])).toBeNull();
  });

  test('refreshes retryable duplicate internal-link tasks for dry-run revalidation', async () => {
    const insertReturning = jest.fn().mockResolvedValue([]);
    const insertChain = {
      insert: jest.fn(() => ({
        onConflict: jest.fn(() => ({
          ignore: jest.fn(() => ({ returning: insertReturning })),
        })),
      })),
    };
    const lookupChain = {
      select: jest.fn(() => lookupChain),
      where: jest.fn(() => lookupChain),
      whereIn: jest.fn(() => lookupChain),
      first: jest.fn().mockResolvedValue({ id: 'task_existing', status: 'skipped' }),
    };
    const updateChain = {
      where: jest.fn(() => updateChain),
      whereIn: jest.fn(() => updateChain),
      update: jest.fn().mockResolvedValue(1),
    };
    db
      .mockImplementationOnce(() => insertChain)
      .mockImplementationOnce(() => lookupChain)
      .mockImplementationOnce(() => updateChain);

    const result = await queueInternalLinkTaskForDryRun({
      source_file: 'src/content/blog/source.md',
      target_url: '/target/',
      anchor_text: 'target anchor',
    }, 'opp_new');

    expect(result).toEqual({ id: 'task_existing', inserted: false, refreshed: true });
    expect(lookupChain.whereIn).toHaveBeenCalledWith('status', expect.arrayContaining(['skipped', 'failed', 'patch_candidate']));
    expect(updateChain.whereIn).toHaveBeenCalledWith('status', expect.arrayContaining(['skipped', 'failed', 'patch_candidate']));
    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'queued',
      opportunity_id: 'opp_new',
      skip_reason: null,
      failure_reason: null,
    }));
  });

  test('a replan never re-queues a link the reader check or Codex rejected', async () => {
    const insertChain = {
      insert: jest.fn(() => ({ onConflict: jest.fn(() => ({ ignore: jest.fn(() => ({ returning: jest.fn().mockResolvedValue([]) })) })) })),
    };
    const lookupChain = {
      select: jest.fn(() => lookupChain),
      where: jest.fn(() => lookupChain),
      whereIn: jest.fn(() => lookupChain),
      first: jest.fn().mockResolvedValue(undefined),
    };
    db.mockImplementationOnce(() => insertChain).mockImplementationOnce(() => lookupChain);

    await expect(queueInternalLinkTaskForDryRun({
      source_file: 'src/content/blog/source.md',
      target_url: '/target/',
      anchor_text: 'target anchor',
    }, 'opp_new')).resolves.toBeNull();

    // Render the grouped condition the lookup applied against real knex SQL.
    const grouped = lookupChain.where.mock.calls.map(([arg]) => arg).find((arg) => typeof arg === 'function');
    const knex = require('knex')({ client: 'pg' });
    const sql = knex('content_internal_link_tasks').where(grouped).toString();
    expect(sql).toContain('"skip_reason" is null');
    expect(sql).toContain('"skip_reason" not like \'llm_judge_rejected%\'');
    expect(sql).toContain('"skip_reason" not like \'codex_findings%\'');
  });

  test('does not dry-run duplicates that leave retryable state before refresh update', async () => {
    const insertReturning = jest.fn().mockResolvedValue([]);
    const insertChain = {
      insert: jest.fn(() => ({
        onConflict: jest.fn(() => ({
          ignore: jest.fn(() => ({ returning: insertReturning })),
        })),
      })),
    };
    const lookupChain = {
      select: jest.fn(() => lookupChain),
      where: jest.fn(() => lookupChain),
      whereIn: jest.fn(() => lookupChain),
      first: jest.fn().mockResolvedValue({ id: 'task_existing', status: 'skipped' }),
    };
    const updateChain = {
      where: jest.fn(() => updateChain),
      whereIn: jest.fn(() => updateChain),
      update: jest.fn().mockResolvedValue(0),
    };
    db
      .mockImplementationOnce(() => insertChain)
      .mockImplementationOnce(() => lookupChain)
      .mockImplementationOnce(() => updateChain);

    await expect(queueInternalLinkTaskForDryRun({
      source_file: 'src/content/blog/source.md',
      target_url: '/target/',
      anchor_text: 'target anchor',
    }, 'opp_new')).resolves.toBeNull();
    expect(updateChain.whereIn).toHaveBeenCalledWith('status', expect.arrayContaining(['skipped', 'failed', 'patch_candidate']));
  });
});

describe('rewrite_title_meta live adapter', () => {
  test.each(['BLOG_EDITORIAL_REVIEW_FAILED', 'BLOG_EDITORIAL_REVIEW_UNAVAILABLE'])(
    'routes metadata %s findings through the bounded editorial retry policy', async (code) => {
      process.env.SHADOW_MODE_REWRITE_TITLE_META = 'false';
      const claimedAt = new Date('2026-05-27T13:00:00Z');
      const opp = { id: 'opp_meta_editorial', action_type: 'rewrite_title_meta', claimed_at: claimedAt };
      const queue = {
        claimNext: jest.fn().mockResolvedValue(opp),
        release: jest.fn(), pendingReview: jest.fn(), complete: jest.fn(),
      };
      const brief = { id: 'brief_meta_editorial', action_type: 'rewrite_title_meta', page_type: 'metadata',
        target_url: 'https://www.wavespestcontrol.com/blog/pest-prevention/', human_review_required: false };
      const runner = loadRunnerWith({ queue,
        briefBuilder: { compose: jest.fn().mockResolvedValue(brief) },
        dispatcher: { runWithBrief: jest.fn().mockResolvedValue({ ok: true,
          draft: { type: 'metadata', title: 'Pest prevention', meta_description: 'A practical guide.' } }) },
      });
      const findings = [{ code: 'weak_answer', message: 'Answer the reader question.' }];
      jest.spyOn(runner, '_handleMetadataRewriteAction').mockRejectedValue(
        Object.assign(new Error('Editorial review rejected metadata'), { code, findings }),
      );
      const retry = jest.spyOn(runner, '_gateFailRetryOrSkip').mockResolvedValue({ outcome: 'editorial_retry' });

      await expect(runner.runNext()).resolves.toEqual({ outcome: 'editorial_retry' });
      expect(retry).toHaveBeenCalledWith(queue, expect.objectContaining({ id: opp.id }),
        expect.any(Object), expect.any(Number), expect.any(Function), {
          claimToken: claimedAt, skipReason: 'editorial_review_failed',
          notes: 'Editorial review rejected metadata', blocking: findings,
        });
      expect(queue.release).not.toHaveBeenCalled();
      expect(queue.pendingReview).not.toHaveBeenCalled();
    },
  );

  test('opens a metadata PR after title/meta spam gate passes', async () => {
    const previousShadow = process.env.SHADOW_MODE_REWRITE_TITLE_META;
    process.env.SHADOW_MODE_REWRITE_TITLE_META = 'false';
    try {
      const claimedAt = new Date('2026-05-27T13:00:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_meta_1',
          action_type: 'rewrite_title_meta',
          claimed_at: claimedAt,
          claim_id: 'd0059611-8e7e-4cab-8d2f-6c3c69fca979',
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const brief = {
        id: 'brief_meta_1',
        opportunity_id: 'opp_meta_1',
        action_type: 'rewrite_title_meta',
        page_type: 'metadata',
        target_url: 'https://www.wavespestcontrol.com/pest-control-lakewood-ranch-fl/',
        target_keyword: 'pest control lakewood ranch fl',
        city: 'Lakewood Ranch',
        service: 'pest',
        serp_signal: { dominant_intent: 'service' },
        gsc_signal: { impressions: 1168 },
        human_review_required: false,
      };
      const briefBuilder = { compose: jest.fn().mockResolvedValue(brief) };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: {
            type: 'metadata',
            title: 'Pest Control in Lakewood Ranch, FL | Waves',
            // Meets the 2026-07-29 PAGE meta contract (resolved service
            // target): {{cityPhone}} token, no literal number, 115-160
            // rendered.
            meta_description: 'Need pest control in Lakewood Ranch? Waves treats and prevents common Southwest Florida pest problems. Call ☎️ {{cityPhone}} for an estimate.',
          },
          agent_id: 'agent_meta',
          session_id: 'session_meta',
        }),
      };
      const publisher = {
        // Target resolution is now mandatory (unresolved parks) — resolve to
        // a service page with no metaTitle so the PAGE meta contract applies
        // and the title gates run on the draft title.
        getLiveFrontmatter: jest.fn().mockResolvedValue({
          _astro_source_path: 'src/content/services/pest-control-lakewood-ranch-fl.md',
          metaDescription: 'Old LWR meta description.',
        }),
        publishMetadataRewrite: jest.fn().mockResolvedValue({
          status: 'pr_open',
          live: false,
          url: 'https://www.wavespestcontrol.com/pest-control-lakewood-ranch-fl/',
          pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/55',
        }),
      };
      const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, publisher });

      const result = await runner.runNext();

      expect(result.queue_claim_id).toBe('d0059611-8e7e-4cab-8d2f-6c3c69fca979');
      const inserts = require('../models/db').mock.results.flatMap((call) => call.value.insert?.mock.calls || []);
      expect(inserts).toContainEqual([expect.objectContaining({ queue_claim_id: result.queue_claim_id })]);
      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('metadata_pr_pending_merge');
      expect(result.astro_pr_url).toBe('https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/55');
      expect(publisher.publishMetadataRewrite).toHaveBeenCalledWith(expect.objectContaining({
        type: 'metadata',
      }), brief);
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_meta_1', 'metadata_pr_pending_merge', { claimToken: claimedAt });
      expect(queue.release).not.toHaveBeenCalled();
      expect(queue.complete).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_REWRITE_TITLE_META;
      else process.env.SHADOW_MODE_REWRITE_TITLE_META = previousShadow;
    }
  });

  test('parks a metadata rewrite whose target cannot be resolved (fail closed — blog vs page contracts diverge)', async () => {
    const previousShadow = process.env.SHADOW_MODE_REWRITE_TITLE_META;
    process.env.SHADOW_MODE_REWRITE_TITLE_META = 'false';
    try {
      const claimedAt = new Date('2026-05-27T13:00:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({ id: 'opp_meta_unresolved', action_type: 'rewrite_title_meta', claimed_at: claimedAt }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_meta_unresolved',
          action_type: 'rewrite_title_meta',
          page_type: 'metadata',
          target_keyword: 'pest control lakewood ranch fl',
          city: 'Lakewood Ranch',
          service: 'pest',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: {
            type: 'metadata',
            title: 'Pest Control in Lakewood Ranch, FL | Waves',
            meta_description: 'Need pest control in Lakewood Ranch? Waves treats and prevents common Southwest Florida pest problems. Call ☎️ {{cityPhone}} for an estimate.',
          },
        }),
      };
      // getLiveFrontmatter resolves to null → target unresolved → park.
      const publisher = {
        getLiveFrontmatter: jest.fn().mockResolvedValue(null),
        publishMetadataRewrite: jest.fn(),
      };
      const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, publisher });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('metadata_target_unresolved');
      expect(publisher.publishMetadataRewrite).not.toHaveBeenCalled();
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_meta_unresolved', 'metadata_target_unresolved', { claimToken: claimedAt });
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_REWRITE_TITLE_META;
      else process.env.SHADOW_MODE_REWRITE_TITLE_META = previousShadow;
    }
  });

  test('a blog target with domains:null arms the brand-token guard fleet-wide (Codex PR r5 audit — null renders on ALL sites, never hub-only)', async () => {
    const previousShadow = process.env.SHADOW_MODE_REWRITE_TITLE_META;
    process.env.SHADOW_MODE_REWRITE_TITLE_META = 'false';
    try {
      const claimedAt = new Date('2026-05-27T13:00:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({ id: 'opp_meta_nulldom', action_type: 'rewrite_title_meta', claimed_at: claimedAt }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_meta_nulldom',
          action_type: 'rewrite_title_meta',
          page_type: 'metadata',
          target_url: 'https://www.wavespestcontrol.com/blog/signs-of-termites/',
          target_keyword: 'signs of termites',
          city: 'Sarasota',
          service: 'termite',
          serp_signal: { dominant_intent: 'informational' },
          gsc_signal: { impressions: 900 },
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: {
            type: 'metadata',
            title: 'Signs of Termites in Sarasota Homes | Waves',
            // Literal hub brand in the description — a leak on every spoke
            // domain the null-domains blog actually renders on.
            meta_description: 'Learn how Waves Pest Control technicians identify early drywood termite activity in Sarasota homes and what an inspection covers.',
          },
        }),
      };
      const publisher = {
        // Blog target with NO domains array: the Astro collection filter
        // renders null/empty target_sites on ALL sites, so the brand guard
        // must arm fleet-wide instead of assuming hub-only.
        getLiveFrontmatter: jest.fn().mockResolvedValue({ _astro_source_path: 'src/content/blog/signs-of-termites.md', domains: null }),
        publishMetadataRewrite: jest.fn(),
      };
      const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, publisher });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('content_guardrails_failed');
      expect(result.reviewer_notes).toMatch(/BRAND_TOKEN_LEAK/);
      expect(publisher.publishMetadataRewrite).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_REWRITE_TITLE_META;
      else process.env.SHADOW_MODE_REWRITE_TITLE_META = previousShadow;
    }
  });

  test('a spoke-host page with domains:[] still arms the brand guard by target host (Codex PR r13 audit)', async () => {
    const previousShadow = process.env.SHADOW_MODE_REWRITE_TITLE_META;
    process.env.SHADOW_MODE_REWRITE_TITLE_META = 'false';
    try {
      const claimedAt = new Date('2026-05-27T13:00:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({ id: 'opp_meta_spokedom', action_type: 'rewrite_title_meta', claimed_at: claimedAt }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_meta_spokedom',
          action_type: 'rewrite_title_meta',
          page_type: 'metadata',
          target_url: 'https://www.sarasotaflpestcontrol.com/pest-control-sarasota-fl/',
          target_keyword: 'pest control sarasota fl',
          city: 'Sarasota',
          service: 'pest',
          serp_signal: { dominant_intent: 'service' },
          gsc_signal: { impressions: 800 },
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: {
            type: 'metadata',
            title: 'Pest Control in Sarasota, FL | Waves',
            meta_description: 'Waves Pest Control treats Sarasota homes for ants, roaches, and rodents. Call ☎️ {{cityPhone}} for a same-week estimate and honest pricing.',
          },
        }),
      };
      const publisher = {
        // A spoke-host page whose frontmatter carries a PRESENT-EMPTY
        // domains array — the target host must arm the guard anyway.
        getLiveFrontmatter: jest.fn().mockResolvedValue({ _astro_source_path: 'src/content/services/pest-control-sarasota-fl.md', domains: [] }),
        publishMetadataRewrite: jest.fn(),
      };
      const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, publisher });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('content_guardrails_failed');
      expect(result.reviewer_notes).toMatch(/BRAND_TOKEN_LEAK/);
      expect(publisher.publishMetadataRewrite).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_REWRITE_TITLE_META;
      else process.env.SHADOW_MODE_REWRITE_TITLE_META = previousShadow;
    }
  });

  test('parks spammy metadata without opening a PR', async () => {
    const previousShadow = process.env.SHADOW_MODE_REWRITE_TITLE_META;
    process.env.SHADOW_MODE_REWRITE_TITLE_META = 'false';
    try {
      const claimedAt = new Date('2026-05-27T13:00:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_meta_spam',
          action_type: 'rewrite_title_meta',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_meta_spam',
          action_type: 'rewrite_title_meta',
          page_type: 'metadata',
          target_keyword: 'pest control lakewood ranch fl',
          city: 'Lakewood Ranch',
          service: 'pest',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: {
            type: 'metadata',
            title: 'Best Cheap Top-Rated Pest Control Near Me Lakewood Ranch',
            meta_description: 'Call Waves for pest control in Lakewood Ranch.',
          },
        }),
      };
      const publisher = {
        // Target resolution is mandatory (unresolved parks) — resolve to a
        // service page so the gates under test actually run.
        getLiveFrontmatter: jest.fn().mockResolvedValue({ _astro_source_path: 'src/content/services/pest-control-lakewood-ranch-fl.md' }),
        publishMetadataRewrite: jest.fn(),
      };
      const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, publisher });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('metadata_gate_fail');
      expect(publisher.publishMetadataRewrite).not.toHaveBeenCalled();
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_meta_spam', 'metadata_gate_fail', { claimToken: claimedAt });
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_REWRITE_TITLE_META;
      else process.env.SHADOW_MODE_REWRITE_TITLE_META = previousShadow;
    }
  });

  test('parks metadata that fails the shared metadata quality gate', async () => {
    const previousShadow = process.env.SHADOW_MODE_REWRITE_TITLE_META;
    process.env.SHADOW_MODE_REWRITE_TITLE_META = 'false';
    try {
      const claimedAt = new Date('2026-05-27T13:00:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_meta_short',
          action_type: 'rewrite_title_meta',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_meta_short',
          action_type: 'rewrite_title_meta',
          page_type: 'metadata',
          target_url: 'https://www.wavespestcontrol.com/pest-control-lakewood-ranch-fl/',
          target_keyword: 'pest control lakewood ranch fl',
          city: 'Lakewood Ranch',
          service: 'pest',
          serp_signal: { dominant_intent: 'service' },
          gsc_signal: { impressions: 1168 },
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: {
            type: 'metadata',
            title: 'Pest Control in Lakewood Ranch, FL | Waves',
            meta_description: 'Too short.',
          },
        }),
      };
      const publisher = {
        // Target resolution is mandatory (unresolved parks) — resolve to a
        // service page so the gates under test actually run.
        getLiveFrontmatter: jest.fn().mockResolvedValue({ _astro_source_path: 'src/content/services/pest-control-lakewood-ranch-fl.md' }),
        publishMetadataRewrite: jest.fn(),
      };
      const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, publisher });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('metadata_quality_gate_fail');
      expect(result.quality_gate_result.hard_failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'meta_length_in_bounds' }),
      ]));
      expect(publisher.publishMetadataRewrite).not.toHaveBeenCalled();
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_meta_short', 'metadata_quality_gate_fail', { claimToken: claimedAt });
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_REWRITE_TITLE_META;
      else process.env.SHADOW_MODE_REWRITE_TITLE_META = previousShadow;
    }
  });

  test('parks metadata when target keyword is missing from title even if score passes', async () => {
    const previousShadow = process.env.SHADOW_MODE_REWRITE_TITLE_META;
    process.env.SHADOW_MODE_REWRITE_TITLE_META = 'false';
    try {
      const claimedAt = new Date('2026-05-27T13:00:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_meta_keyword',
          action_type: 'rewrite_title_meta',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_meta_keyword',
          action_type: 'rewrite_title_meta',
          page_type: 'metadata',
          target_url: 'https://www.wavespestcontrol.com/pest-control-lakewood-ranch-fl/',
          target_keyword: 'pest control lakewood ranch fl',
          city: 'Lakewood Ranch',
          service: 'pest',
          serp_signal: { dominant_intent: 'service' },
          gsc_signal: { impressions: 1168 },
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: {
            type: 'metadata',
            title: 'Bug Help for Homes in Lakewood Ranch | Waves',
            meta_description: 'Protect your Lakewood Ranch home from common Southwest Florida bugs with Waves guidance on prevention, treatment timing, and when to call for help.',
          },
        }),
      };
      const publisher = {
        // Target resolution is mandatory (unresolved parks) — resolve to a
        // service page so the gates under test actually run.
        getLiveFrontmatter: jest.fn().mockResolvedValue({ _astro_source_path: 'src/content/services/pest-control-lakewood-ranch-fl.md' }),
        publishMetadataRewrite: jest.fn(),
      };
      const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, publisher });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('metadata_quality_gate_fail');
      expect(result.quality_gate_result.ok).toBe(false);
      expect(result.quality_gate_result.checks.primary_keyword_in_title.ok).toBe(false);
      expect(result.quality_gate_result.hard_failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'primary_keyword_in_title' }),
      ]));
      expect(publisher.publishMetadataRewrite).not.toHaveBeenCalled();
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_meta_keyword', 'metadata_quality_gate_fail', { claimToken: claimedAt });
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_REWRITE_TITLE_META;
      else process.env.SHADOW_MODE_REWRITE_TITLE_META = previousShadow;
    }
  });

  test('skips a rewrite_title_meta whose brief target is a protected money page (by-design refusal, not review)', async () => {
    // Regression guard: an in-place editor (rewrite_title_meta) resolves its
    // target from the brief (target_url) even when the opp carries no page_url,
    // so the protected-page guard sees the page the handler would actually edit.
    const previousShadow = process.env.SHADOW_MODE_REWRITE_TITLE_META;
    process.env.SHADOW_MODE_REWRITE_TITLE_META = 'false';
    try {
      const claimedAt = new Date('2026-05-27T13:00:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_meta_prot',
          action_type: 'rewrite_title_meta',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        skip: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_meta_prot',
          action_type: 'rewrite_title_meta',
          page_type: 'metadata',
          target_url: 'https://www.wavespestcontrol.com/pest-control-sarasota-fl/',
          target_keyword: 'pest control sarasota fl',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: { type: 'metadata', title: 'X', meta_description: 'Y' },
        }),
      };
      const publisher = {
        // Target resolution is mandatory (unresolved parks) — resolve to a
        // service page so the gates under test actually run.
        getLiveFrontmatter: jest.fn().mockResolvedValue({ _astro_source_path: 'src/content/services/pest-control-lakewood-ranch-fl.md' }),
        publishMetadataRewrite: jest.fn(),
      };
      const protectedPages = {
        isProtected: jest.fn().mockResolvedValue({ protected: true, reason: 'money_page', source: 'pattern' }),
      };
      const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, publisher, protectedPages });

      const result = await runner.runNext();

      expect(result.outcome).toBe('skipped_gate_fail');
      expect(result.skip_reason).toBe('protected_page:money_page');
      expect(protectedPages.isProtected).toHaveBeenCalledWith(
        'https://www.wavespestcontrol.com/pest-control-sarasota-fl/',
        { db: expect.any(Function) },
      );
      expect(publisher.publishMetadataRewrite).not.toHaveBeenCalled();
      // By-design protection is a refusal, not an exception — it must skip
      // silently, never occupy the human review queue (owner directive
      // 2026-07-18: review queue is exceptions-only).
      expect(queue.skip).toHaveBeenCalledWith('opp_meta_prot', 'protected_page:money_page', { claimToken: claimedAt });
      expect(queue.pendingReview).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_REWRITE_TITLE_META;
      else process.env.SHADOW_MODE_REWRITE_TITLE_META = previousShadow;
    }
  });
});

// ── blog uniqueness default-on ──────────────────────────────────────
describe('blog uniqueness gating', () => {
  test('new_supporting_blog fails closed when no blog corpus is available — held pre-draft by the topic-targeting gate (no writer spend), never drafted unchecked', async () => {
    const prevShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const prevThreshold = process.env.TRUST_BUILD_THRESHOLD;
    const prevUniq = process.env.AUTONOMOUS_CONTENT_BLOG_UNIQUENESS;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';
    delete process.env.AUTONOMOUS_CONTENT_BLOG_UNIQUENESS; // default ON
    try {
      const claimedAt = new Date('2026-05-23T05:30:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_blog_uniq',
          action_type: 'new_supporting_blog',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_blog_uniq',
          action_type: 'new_supporting_blog',
          page_type: 'blog',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: { url: '/blog/uniq-test/', title: 'Uniq Test', body: '<p>body</p>' },
        }),
      };
      const qualityGate = {
        evaluate: jest.fn().mockReturnValue({ ok: true, hard_failures: [], soft_failures: [], total_score: 100, min_total_score: 80 }),
      };
      const publisher = { publishOrUpdatePage: jest.fn() };
      // Corpus loader rejects → required blog corpus is unavailable.
      const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, qualityGate, publisher, linkPlanner: { loadAstroCorpusFromGitHub: jest.fn().mockRejectedValue(new Error('corpus_down')) } });

      const result = await runner.runNext();

      expect(result.outcome).toBe('skipped_gate_fail');
      expect(result.skip_reason).toBe('topic_targeting_unavailable');
      expect(queue.skip).toHaveBeenCalledWith('opp_blog_uniq', 'topic_targeting_unavailable', { claimToken: claimedAt });
      expect(dispatcher.runWithBrief).not.toHaveBeenCalled();
      expect(publisher.publishOrUpdatePage).not.toHaveBeenCalled();
    } finally {
      if (prevShadow === undefined) delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
      else process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = prevShadow;
      if (prevThreshold === undefined) delete process.env.TRUST_BUILD_THRESHOLD;
      else process.env.TRUST_BUILD_THRESHOLD = prevThreshold;
      if (prevUniq === undefined) delete process.env.AUTONOMOUS_CONTENT_BLOG_UNIQUENESS;
      else process.env.AUTONOMOUS_CONTENT_BLOG_UNIQUENESS = prevUniq;
    }
  });

  test('blog dedup corpus is network-wide — loads the entire blog/ collection (all spoke domains), never domain-filtered', async () => {
    // Every spoke is a build of the single wavespestcontrol-astro repo, so all
    // spoke-tagged posts live in the same src/content/blog/ directory. The dedup
    // corpus must stay UNFILTERED by domain: a new spoke post is compared against
    // hub posts AND sibling-spoke posts. If a future change scopes this corpus to
    // the current build domain, cross-spoke / spoke-vs-hub near-duplicates would
    // slip through silently — this test fails closed against that regression.
    const prevAstroDir = process.env.ASTRO_REPO_DIR;
    delete process.env.ASTRO_REPO_DIR; // force the production GitHub corpus loader path
    try {
      const linkPlanner = {
        loadAstroCorpusFromGitHub: jest.fn().mockResolvedValue([
          { file: 'src/content/blog/get-rid-of-cockroaches.md', body: 'Hub-tagged post body.', url: '/pest-control/get-rid-of-cockroaches/' },
          { file: 'src/content/blog/german-roaches-sarasota-condos.md', body: 'Sarasota-spoke-tagged post body.', url: '/pest-control/german-roaches-sarasota-condos/' },
        ]),
      };
      const runner = loadRunnerWith({ queue: {}, briefBuilder: {}, dispatcher: {}, linkPlanner });

      const corpus = await runner._loadBlogCorpus({ required: true });

      // The whole blog collection is requested — no per-domain filter argument.
      expect(linkPlanner.loadAstroCorpusFromGitHub).toHaveBeenCalledWith({ collections: ['blog'] });
      // Both the hub post and the spoke-tagged post are in the comparison set.
      expect(corpus.map((p) => p.file)).toEqual(expect.arrayContaining([
        'src/content/blog/get-rid-of-cockroaches.md',
        'src/content/blog/german-roaches-sarasota-condos.md',
      ]));
    } finally {
      if (prevAstroDir === undefined) delete process.env.ASTRO_REPO_DIR;
      else process.env.ASTRO_REPO_DIR = prevAstroDir;
    }
  });
});

// ── isShadow per-action env mapping ─────────────────────────────────

describe('isShadow', () => {
  test('default ON when env unset', () => {
    expect(isShadow('create_or_refresh_city_service_page')).toBe(true);
    expect(isShadow('refresh_existing_page')).toBe(true);
    expect(isShadow('rewrite_title_meta')).toBe(true);
  });
  test('SHADOW_MODE_<ACTION>=false flips to live', () => {
    process.env.SHADOW_MODE_REFRESH_EXISTING_PAGE = 'false';
    expect(isShadow('refresh_existing_page')).toBe(false);
    expect(isShadow('create_or_refresh_city_service_page')).toBe(true); // other actions still shadow
  });
  test('accepts "0" and "off" as live', () => {
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = '0';
    expect(isShadow('new_supporting_blog')).toBe(false);
    process.env.SHADOW_MODE_REWRITE_TITLE_META = 'off';
    expect(isShadow('rewrite_title_meta')).toBe(false);
  });
  test('handles dotted/hyphenated action names', () => {
    process.env.SHADOW_MODE_GBP_POST = 'false';
    expect(isShadow('gbp_post')).toBe(false);
    // hyphens / dots normalize to underscore
    process.env.SHADOW_MODE_FOO_BAR = 'false';
    expect(isShadow('foo-bar')).toBe(false);
    expect(isShadow('foo.bar')).toBe(false);
  });
  test('null/undefined/empty action_type → shadow', () => {
    expect(isShadow(null)).toBe(true);
    expect(isShadow(undefined)).toBe(true);
    expect(isShadow('')).toBe(true);
  });
});

describe('autoPublishEnabled', () => {
  test('blogs default to unattended publishing; other actions keep their ramp', () => {
    expect(autoPublishEnabled('new_supporting_blog')).toBe(true);
    expect(autoPublishEnabled('add_internal_links')).toBe(false);
  });
  test('AUTO_PUBLISH_<ACTION>=true enables auto-publish for that action only', () => {
    process.env.AUTO_PUBLISH_NEW_SUPPORTING_BLOG = 'true';
    expect(autoPublishEnabled('new_supporting_blog')).toBe(true);
    expect(autoPublishEnabled('create_or_refresh_city_service_page')).toBe(false);
  });
  test('accepts "1" and "on" as enabled', () => {
    process.env.AUTO_PUBLISH_NEW_SUPPORTING_BLOG = '1';
    expect(autoPublishEnabled('new_supporting_blog')).toBe(true);
    process.env.AUTO_PUBLISH_REFRESH_EXISTING_PAGE = 'on';
    expect(autoPublishEnabled('refresh_existing_page')).toBe(true);
  });
  test('any other value stays OFF (fail-safe)', () => {
    process.env.AUTO_PUBLISH_NEW_SUPPORTING_BLOG = 'yes';
    expect(autoPublishEnabled('new_supporting_blog')).toBe(false);
    process.env.AUTO_PUBLISH_NEW_SUPPORTING_BLOG = 'false';
    expect(autoPublishEnabled('new_supporting_blog')).toBe(false);
  });
  test('null/undefined action_type → not auto-publish', () => {
    expect(autoPublishEnabled(null)).toBe(false);
    expect(autoPublishEnabled(undefined)).toBe(false);
  });
});

describe('FACTS_GATED_ACTIONS', () => {
  test('covers the facts-gated content actions kept in sync with facts-sufficiency.js', () => {
    expect(FACTS_GATED_ACTIONS.has('new_supporting_blog')).toBe(true);
    expect(FACTS_GATED_ACTIONS.has('create_or_refresh_city_service_page')).toBe(true);
    expect(FACTS_GATED_ACTIONS.has('create_customer_question_page')).toBe(true);
    expect(FACTS_GATED_ACTIONS.has('refresh_existing_page')).toBe(true);
    // metadata-only / link / GBP actions are NOT facts-gated
    expect(FACTS_GATED_ACTIONS.has('add_internal_links')).toBe(false);
    expect(FACTS_GATED_ACTIONS.has('rewrite_title_meta')).toBe(false);
    expect(FACTS_GATED_ACTIONS.has('gbp_post')).toBe(false);
  });
});

describe('TRUST_BUILD_THRESHOLD default', () => {
  test('matches scoring-config.THRESHOLDS.autoPublishAfterApprovedRuns', () => {
    const { THRESHOLDS } = require('../services/content/scoring-config');
    // Either uses env override or the threshold from scoring-config.
    expect(TRUST_BUILD_THRESHOLD).toBeGreaterThanOrEqual(1);
    if (!process.env.TRUST_BUILD_THRESHOLD) {
      expect(TRUST_BUILD_THRESHOLD).toBe(THRESHOLDS.autoPublishAfterApprovedRuns);
    }
  });
});

describe('countsTowardTrustBuild', () => {
  test('counts published live runs and explicitly approved pending-review runs', () => {
    expect(countsTowardTrustBuild({ outcome: 'completed_published' })).toBe(true);
    expect(countsTowardTrustBuild({
      outcome: 'completed_pending_review',
      skip_reason: 'trust_build_2_of_3',
      trust_build_approved_at: new Date(),
    })).toBe(true);
  });
  test('does not count unapproved or non-trust pending-review rows or failures', () => {
    expect(countsTowardTrustBuild({
      outcome: 'completed_pending_review',
      skip_reason: 'trust_build_2_of_3',
      trust_build_approved_at: null,
    })).toBe(false);
    expect(countsTowardTrustBuild({
      outcome: 'completed_pending_review',
      skip_reason: 'gate_fail',
      trust_build_approved_at: new Date(),
    })).toBe(false);
    expect(countsTowardTrustBuild({
      outcome: 'completed_pending_review',
      skip_reason: 'brief_requires_human_review',
      trust_build_approved_at: new Date(),
    })).toBe(false);
    expect(countsTowardTrustBuild({ outcome: 'failed_agent' })).toBe(false);
    // A no-op refresh published nothing — it must not build trust.
    expect(countsTowardTrustBuild({ outcome: 'completed_no_changes' })).toBe(false);
  });
});

describe('isDeterministicPublishError', () => {
  test('COMPETITOR_LINK parks: a link in the live page outside the edit fails every retry (Codex r10 on #5191)', () => {
    const err = new Error('competitor link "https://www.orkin.com/x" in the page — publish refused');
    err.code = 'COMPETITOR_LINK';
    expect(isDeterministicPublishError(err)).toBe(true);
  });
  test('BLOG_BODY_IMAGES_FAILED parks like the hero failure', () => {
    const err = new Error('autonomous blog body image 1 generation failed');
    err.code = 'BLOG_BODY_IMAGES_FAILED';
    expect(isDeterministicPublishError(err)).toBe(true);
  });
  test('identifies draft validation errors that should not be retried automatically', () => {
    const frontmatterError = new Error('Astro frontmatter validation failed');
    frontmatterError.code = 'BLOG_FRONTMATTER_INVALID';

    expect(isDeterministicPublishError(frontmatterError)).toBe(true);
    expect(isDeterministicPublishError(new Error('autonomous draft canonical must match slug /x/'))).toBe(true);
    expect(isDeterministicPublishError(new Error('GitHub PUT https://api.github.com/repos/x/y -> 502'))).toBe(false);
  });

  test('unresolvable/missing refresh targets are deterministic (park for review, not retry)', () => {
    expect(isDeterministicPublishError(new Error('could not resolve refresh target: missing target_url'))).toBe(true);
    expect(isDeterministicPublishError(new Error('Astro file not found for refresh: src/content/services/x.md'))).toBe(true);
  });

  test('a fact-check block is edit-required → deterministic (park, not retry-loop)', () => {
    const factErr = new Error('fact-check failed: P1 wrong pathogen');
    factErr.code = 'BLOG_FACTCHECK_FAILED';
    expect(isDeterministicPublishError(factErr)).toBe(true);
  });

  test('a hero image generation failure is fail-closed → deterministic (park, not retry-loop)', () => {
    const heroErr = new Error('autonomous blog hero image generation failed for x: image API down');
    heroErr.code = 'BLOG_HERO_IMAGE_FAILED';
    expect(isDeterministicPublishError(heroErr)).toBe(true);
  });

  test('an off-site canonical rejection is deterministic (park, never retry or repair into a publish)', () => {
    expect(isDeterministicPublishError(new Error('autonomous draft canonical points off-site (evil.example.com) — refusing to repair a cross-site canonical'))).toBe(true);
  });
});

describe('applyOperatorSlugRepair (operator pin is authoritative — drift repaired, not parked)', () => {
  const PINNED = '/lawn-care/fall-lawn-mistakes-swfl/';
  function operatorBrief(slug = PINNED) {
    return { voice_constraints: { operator_brief: { slug } } };
  }
  function driftedDraft(overrides = {}) {
    return {
      type: 'draft',
      url: overrides.url !== undefined
        ? overrides.url
        : 'https://www.wavespestcontrol.com/fall-lawn-mistakes-southwest-florida/',
      frontmatter: {
        slug: '/fall-lawn-mistakes-southwest-florida/',
        canonical: 'https://www.wavespestcontrol.com/fall-lawn-mistakes-southwest-florida/',
        title: 'Fall Lawn Mistakes',
        ...overrides.frontmatter,
      },
      body: overrides.body !== undefined
        ? overrides.body
        : 'Intro. See [our checklist](/fall-lawn-mistakes-southwest-florida/) and the [same post again](/fall-lawn-mistakes-southwest-florida/#faq-adjacent).',
    };
  }

  test('returns null (no-op) when the draft already matches the pin — draft.url still stamped for parked-run review targets (Codex r13)', () => {
    const draft = driftedDraft({ frontmatter: { slug: PINNED, canonical: `https://www.wavespestcontrol.com${PINNED}`, category: 'lawn-care' } });
    delete draft.url; // production emit_draft never sets it
    const bodyBefore = draft.body;
    expect(applyOperatorSlugRepair(operatorBrief(), draft)).toBeNull();
    // Even the drift-free path stamps the own-route reference: a run parked
    // BEFORE publish (trust-build, named-competitor review) needs a non-null
    // review target_url.
    expect(draft.url).toBe(`https://www.wavespestcontrol.com${PINNED}`);
    // Nothing else moves.
    expect(draft.body).toBe(bodyBefore);
    expect(draft.frontmatter.slug).toBe(PINNED);
    expect(draft.frontmatter.canonical).toBe(`https://www.wavespestcontrol.com${PINNED}`);
  });

  test('an on-fleet BACKSLASH network-path canonical naming the drifted route is repaired — correspondence reads the parsed pathname (Codex r13)', () => {
    const draft = driftedDraft({
      frontmatter: { canonical: '\\\\www.wavespestcontrol.com\\fall-lawn-mistakes-southwest-florida\\' },
    });
    const result = applyOperatorSlugRepair(operatorBrief(), draft);
    expect(result.ok).toBe(true);
    expect(draft.frontmatter.canonical).toBe(`https://www.wavespestcontrol.com${PINNED}`);
    expect(result.repair.canonical_rewritten).toBe(true);
  });

  test('a CASE-drifted draft slug is repaired — normalized equality must not skip the repair (Codex r4)', () => {
    // operatorSlugMismatch lowercases both sides, so /Lawn-Care/… vs the pin
    // reads as "no drift" — but the publisher would keep the uppercase leaf
    // and schema-fail instead of publishing the pinned route.
    const draft = driftedDraft({
      frontmatter: { slug: '/Lawn-Care/Fall-Lawn-Mistakes-Swfl/', category: 'lawn-care' },
      body: 'See [our checklist](/Lawn-Care/Fall-Lawn-Mistakes-Swfl/) for details.',
    });
    const result = applyOperatorSlugRepair(operatorBrief(), draft);
    expect(result.ok).toBe(true);
    expect(draft.frontmatter.slug).toBe(PINNED);
    expect(draft.body).toContain(`(${PINNED})`);
    expect(result.repair.body_self_link_rewrites).toBe(1);
  });

  test('a drifted CATEGORY is forced to the pin even when the slug matches — the publisher derives the route from category (Codex r4)', () => {
    const draft = driftedDraft({
      frontmatter: { slug: PINNED, canonical: `https://www.wavespestcontrol.com${PINNED}`, category: 'pest-control' },
      body: 'No self links here.',
    });
    const result = applyOperatorSlugRepair(operatorBrief(), draft);
    expect(result.ok).toBe(true);
    expect(draft.frontmatter.category).toBe('lawn-care');
    expect(result.repair.category_repaired).toEqual({ from: 'pest-control', to: 'lawn-care' });
  });

  test('a single-segment pin is unrepairable — the publisher would prepend a category and change the route (Codex r4)', () => {
    const draft = driftedDraft();
    const before = JSON.stringify(draft);
    const result = applyOperatorSlugRepair(operatorBrief('/fall-lawn-mistakes-swfl/'), draft);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not a \/category\/leaf\/ route/);
    expect(JSON.stringify(draft)).toBe(before);
  });

  test('a NESTED pin (3+ segments) is unrepairable — normalizeAutonomousCategory cannot retain a slash-containing category (Codex r5)', () => {
    const draft = driftedDraft();
    const before = JSON.stringify(draft);
    const result = applyOperatorSlugRepair(operatorBrief('/lawn-care/fall/guide/'), draft);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not a \/category\/leaf\/ route/);
    expect(JSON.stringify(draft)).toBe(before);
  });

  test('a pin with a NON-CANONICAL category parks — publish-time normalization would rewrite the route (Codex r6)', () => {
    for (const badPin of ['/pest/example-post/', '/unknown/example-post/']) {
      const draft = driftedDraft();
      const before = JSON.stringify(draft);
      const result = applyOperatorSlugRepair(operatorBrief(badPin), draft);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/not a canonical post category/);
      expect(JSON.stringify(draft)).toBe(before);
    }
  });

  test('repairs drift in place: slug forced to the pin, canonical repointed, body self-links rewritten, repair recorded', () => {
    const draft = driftedDraft();
    const result = applyOperatorSlugRepair(operatorBrief(), draft);

    expect(result.ok).toBe(true);
    expect(draft.frontmatter.slug).toBe(PINNED);
    expect(draft.frontmatter.canonical).toBe(`https://www.wavespestcontrol.com${PINNED}`);
    // draft.url feeds the sitemap pre-check, visibility gate, uniqueness
    // self-exclusion, and published/pending-url fallback — it must describe
    // the pinned route after repair, not the rejected writer route (Codex r8).
    expect(draft.url).toBe(`https://www.wavespestcontrol.com${PINNED}`);
    expect(draft.body).not.toContain('/fall-lawn-mistakes-southwest-florida/');
    expect(draft.body).toContain(`(${PINNED})`);
    // Fragment link keeps its fragment — only the exact path is swapped.
    expect(draft.body).toContain(`${PINNED}#faq-adjacent`);
    expect(result.repair).toMatchObject({
      from_slug: '/fall-lawn-mistakes-southwest-florida/',
      to_slug: PINNED,
      canonical_rewritten: true,
      url_rewritten: true,
      body_self_link_rewrites: 2,
    });
    // A second pass reads clean afterwards — the repair is its own drift
    // detector (single definition of slug drift, Codex r9), so the pipeline
    // continues past the machine check instead of parking.
    expect(applyOperatorSlugRepair(operatorBrief(), draft)).toBeNull();
  });

  test('repairs a draft that emitted NO slug at all (slug set, body untouched)', () => {
    const draft = driftedDraft({ frontmatter: { slug: undefined }, body: 'No self links here.' });
    delete draft.frontmatter.slug;
    const result = applyOperatorSlugRepair(operatorBrief(), draft);
    expect(result.ok).toBe(true);
    expect(draft.frontmatter.slug).toBe(PINNED);
    expect(result.repair.body_self_link_rewrites).toBe(0);
    expect(draft.body).toBe('No self links here.');
  });

  test('does NOT rewrite unrelated content — only the exact old slug path', () => {
    const draft = driftedDraft({
      body: 'Talks about fall-lawn-mistakes-southwest-florida as a phrase (no slashes) and links [here](/fall-lawn-mistakes-southwest-florida/).',
    });
    applyOperatorSlugRepair(operatorBrief(), draft);
    expect(draft.body).toContain('fall-lawn-mistakes-southwest-florida as a phrase');
    expect(draft.body).toContain(`(${PINNED})`);
  });

  test('an invalid pinned slug is NOT repairable — draft untouched, caller keeps the park', () => {
    for (const badPin of ['/Fall Lawn Mistakes!!/', '/bad_underscore/', '//', '   ']) {
      const draft = driftedDraft();
      const before = JSON.stringify(draft);
      const result = applyOperatorSlugRepair(operatorBrief(badPin), draft);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/not a valid blog slug path/);
      expect(result.mismatch.expected_slug).toBe(badPin);
      expect(JSON.stringify(draft)).toBe(before);
    }
  });

  test('a pin malformed only by casing or missing boundary slashes PARKS — never silently normalized into a URL the operator did not write (Codex r1)', () => {
    for (const badPin of ['/Lawn-Care/Fall-Lawn-Mistakes-Swfl/', 'lawn-care/fall-lawn-mistakes-swfl', '/lawn-care/fall-lawn-mistakes-swfl']) {
      const draft = driftedDraft();
      const before = JSON.stringify(draft);
      const result = applyOperatorSlugRepair(operatorBrief(badPin), draft);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/not a valid blog slug path/);
      expect(JSON.stringify(draft)).toBe(before);
    }
  });

  test('an invalid pin that NORMALIZES equal to the draft slug still parks — normalized equality must not bypass raw validation (Codex r3)', () => {
    // Pin /Lawn-Care/…-Swfl/ lowercases to the draft slug, so a normalized
    // comparison alone reads "no drift" — the malformed pin must still park
    // instead of publishing.
    const draft = driftedDraft({ frontmatter: { slug: '/lawn-care/fall-lawn-mistakes-swfl/' } });
    const before = JSON.stringify(draft);
    const result = applyOperatorSlugRepair(operatorBrief('/Lawn-Care/Fall-Lawn-Mistakes-Swfl/'), draft);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not a valid blog slug path/);
    expect(result.mismatch.expected_slug).toBe('/Lawn-Care/Fall-Lawn-Mistakes-Swfl/');
    expect(JSON.stringify(draft)).toBe(before);
  });

  test('slug repair rewrites ONLY exact self-link destinations — foreign-host citations and longer internal routes survive verbatim (Codex r1)', () => {
    const draft = driftedDraft({
      body: [
        'See [our checklist](/fall-lawn-mistakes-southwest-florida/) and',
        '[the absolute form](https://www.wavespestcontrol.com/fall-lawn-mistakes-southwest-florida/) and',
        '[the bare-host form](https://wavespestcontrol.com/fall-lawn-mistakes-southwest-florida/).',
        'A citation: [report](https://source.example/fall-lawn-mistakes-southwest-florida/report) and',
        '[an exact foreign path](https://source.example/fall-lawn-mistakes-southwest-florida/) plus',
        '[a longer internal route](/fall-lawn-mistakes-southwest-florida/archive/) and',
        '[a query value](https://source.example/report?return=/fall-lawn-mistakes-southwest-florida/) and',
        '[an absolute query value](https://source.example/r?return=https://www.wavespestcontrol.com/fall-lawn-mistakes-southwest-florida/) and',
        '[a dot-prefixed child](/fall-lawn-mistakes-southwest-florida/.well-known/security.txt) and',
        '[a percent-encoded child](/fall-lawn-mistakes-southwest-florida/%61rchive/).',
      ].join(' '),
    });
    const result = applyOperatorSlugRepair(operatorBrief(), draft);
    expect(result.ok).toBe(true);
    expect(result.repair.body_self_link_rewrites).toBe(3);
    expect(draft.body).toContain(`(${PINNED})`);
    expect(draft.body).toContain(`https://www.wavespestcontrol.com${PINNED}`);
    // The bare-host hub form is the writer's own drifted route too (Codex
    // r6) — repaired AND normalized to the configured www origin.
    expect(draft.body).not.toContain('https://wavespestcontrol.com/fall-lawn-mistakes-southwest-florida/');
    expect(draft.body).not.toContain(`https://wavespestcontrol.com${PINNED}`);
    expect(draft.body).toContain('https://source.example/fall-lawn-mistakes-southwest-florida/report');
    expect(draft.body).toContain('[an exact foreign path](https://source.example/fall-lawn-mistakes-southwest-florida/)');
    expect(draft.body).toContain('(/fall-lawn-mistakes-southwest-florida/archive/)');
    // A query VALUE embedding the old path is part of a different
    // destination, not a self-link (Codex r2) — including the ABSOLUTE hub
    // form embedded in a foreign destination's query (Codex r7).
    expect(draft.body).toContain('?return=/fall-lawn-mistakes-southwest-florida/');
    expect(draft.body).toContain('?return=https://www.wavespestcontrol.com/fall-lawn-mistakes-southwest-florida/');
    // Child routes whose next segment starts with a non-alphanumeric URL
    // char are DIFFERENT pathnames (Codex r5).
    expect(draft.body).toContain('(/fall-lawn-mistakes-southwest-florida/.well-known/security.txt)');
    expect(draft.body).toContain('(/fall-lawn-mistakes-southwest-florida/%61rchive/)');
  });

  test('an APEX-host canonical is the SAME hub — repaired, not preserved as foreign (Codex r7)', () => {
    // Exact-host comparison would call this foreign, preserve the stale
    // old-leaf canonical, and the publisher would park a draft whose repair
    // should have succeeded.
    const draft = driftedDraft({
      frontmatter: { canonical: 'https://wavespestcontrol.com/fall-lawn-mistakes-southwest-florida/' },
    });
    const result = applyOperatorSlugRepair(operatorBrief(), draft);
    expect(result.ok).toBe(true);
    expect(draft.frontmatter.canonical).toBe(`https://www.wavespestcontrol.com${PINNED}`);
    expect(result.repair.canonical_rewritten).toBe(true);
  });

  test('a SPOKE-host canonical is a valid FLEET URL — repaired, not preserved as foreign (Codex r8)', () => {
    // The publisher's isFleetCanonicalHost accepts every spoke host, so a
    // hub-only check here would preserve the stale old-leaf canonical; the
    // publisher would then accept the host but reject the leaf, parking a
    // finished spoke draft. Stamping the hub canonical is safe — the
    // publisher derives the binding, origin-correct canonical from the slug.
    for (const spokeCanonical of [
      'https://www.sarasotaflpestcontrol.com/fall-lawn-mistakes-southwest-florida/',
      'https://sarasotaflpestcontrol.com/fall-lawn-mistakes-southwest-florida/',
    ]) {
      const draft = driftedDraft({ frontmatter: { canonical: spokeCanonical } });
      const result = applyOperatorSlugRepair(operatorBrief(), draft);
      expect(result.ok).toBe(true);
      expect(draft.frontmatter.canonical).toBe(`https://www.wavespestcontrol.com${PINNED}`);
      expect(result.repair.canonical_rewritten).toBe(true);
    }
  });

  test('an on-fleet canonical naming a genuinely DIFFERENT post is PRESERVED — the publisher leaf guard must see the confused draft (Codex r11)', () => {
    // Fleet host alone is not enough to repair: a canonical pointing at an
    // unrelated post is exactly what assertCanonicalMatchesSlug parks on,
    // and rewriting it here would publish a confused draft at the pin.
    const draft = driftedDraft({ frontmatter: { canonical: 'https://www.wavespestcontrol.com/unrelated-post/' } });
    const result = applyOperatorSlugRepair(operatorBrief(), draft);
    expect(result.ok).toBe(true);
    expect(draft.frontmatter.canonical).toBe('https://www.wavespestcontrol.com/unrelated-post/');
    expect(result.repair.canonical_rewritten).toBe(false);
  });

  test('unquoted HTML/MDX href self-links are rewritten — legal syntax the body scanners support (Codex r11; query suffix r12)', () => {
    const draft = driftedDraft({
      body: [
        'Click <a href=/fall-lawn-mistakes-southwest-florida/>here</a> or',
        '<a href=https://www.wavespestcontrol.com/fall-lawn-mistakes-southwest-florida/>the absolute form</a> or',
        '<a href=/fall-lawn-mistakes-southwest-florida/?utm_source=post>the tracked form</a>;',
        'a query param named src [x](https://source.example/r?src=/fall-lawn-mistakes-southwest-florida/) survives.',
      ].join(' '),
    });
    const result = applyOperatorSlugRepair(operatorBrief(), draft);
    expect(result.ok).toBe(true);
    expect(draft.body).toContain(`<a href=${PINNED}>`);
    expect(draft.body).toContain(`<a href=https://www.wavespestcontrol.com${PINNED}>`);
    // The query suffix identifies the old route and survives verbatim.
    expect(draft.body).toContain(`<a href=${PINNED}?utm_source=post>`);
    expect(draft.body).toContain('?src=/fall-lawn-mistakes-southwest-florida/');
    expect(result.repair.body_self_link_rewrites).toBe(3);
  });

  test('a URL-shaped drifted slug rewrites body links by its PATHNAME — raw-string candidates never match (Codex r12)', () => {
    const draft = driftedDraft({
      frontmatter: { slug: 'https://www.wavespestcontrol.com/fall-lawn-mistakes-southwest-florida/' },
    });
    const result = applyOperatorSlugRepair(operatorBrief(), draft);
    expect(result.ok).toBe(true);
    expect(draft.frontmatter.slug).toBe(PINNED);
    // The default body's two relative self-links on the drifted route are
    // found via the extracted pathname and rewritten.
    expect(draft.body).not.toContain('/fall-lawn-mistakes-southwest-florida/');
    expect(draft.body).toContain(`(${PINNED})`);
    expect(result.repair.body_self_link_rewrites).toBe(2);
  });

  test('absolute self-links classify by PARSED host — uppercase serialization and explicit :443 are the same hub (Codex r15)', () => {
    const draft = driftedDraft({
      body: [
        'See [shouty form](HTTPS://WWW.WAVESPESTCONTROL.COM/fall-lawn-mistakes-southwest-florida/) and',
        '[explicit port](https://www.wavespestcontrol.com:443/fall-lawn-mistakes-southwest-florida/) and',
        '[a foreign host with the same path](https://source.example/fall-lawn-mistakes-southwest-florida/).',
      ].join(' '),
    });
    const result = applyOperatorSlugRepair(operatorBrief(), draft);
    expect(result.ok).toBe(true);
    expect(draft.body).not.toContain('WAVESPESTCONTROL.COM/fall-lawn');
    expect(draft.body).not.toContain(':443');
    // Both hub forms normalized to the configured origin + pin.
    const normalized = draft.body.match(new RegExp(`https://www\\.wavespestcontrol\\.com${PINNED.replace(/\//g, '\\/')}`, 'g')) || [];
    expect(normalized.length).toBe(2);
    // A foreign host carrying the same pathname is someone else's page.
    expect(draft.body).toContain('https://source.example/fall-lawn-mistakes-southwest-florida/');
    expect(result.repair.body_self_link_rewrites).toBe(2);
  });

  test('a PROTOCOL-RELATIVE hub self-link is the same drifted route; a protocol-relative foreign host survives (Codex r16)', () => {
    const draft = driftedDraft({
      body: [
        'See [pr hub form](//www.wavespestcontrol.com/fall-lawn-mistakes-southwest-florida/) and',
        '[pr foreign form](//source.example/fall-lawn-mistakes-southwest-florida/).',
      ].join(' '),
    });
    const result = applyOperatorSlugRepair(operatorBrief(), draft);
    expect(result.ok).toBe(true);
    expect(draft.body).toContain(`https://www.wavespestcontrol.com${PINNED}`);
    expect(draft.body).not.toContain('//www.wavespestcontrol.com/fall-lawn-mistakes-southwest-florida/');
    expect(draft.body).toContain('(//source.example/fall-lawn-mistakes-southwest-florida/)');
    expect(result.repair.body_self_link_rewrites).toBe(1);
  });

  test('a FLAT drifted slug with a category also repairs links to the DERIVED category route (Codex r16)', () => {
    // The publisher derives the public route as category + leaf, so the
    // writer may self-link to /lawn-care/<flat-slug>/ even though its
    // frontmatter slug is flat.
    const draft = driftedDraft({
      frontmatter: { category: 'lawn-care' },
      body: 'See [derived route](/lawn-care/fall-lawn-mistakes-southwest-florida/) and [flat form](/fall-lawn-mistakes-southwest-florida/).',
    });
    const result = applyOperatorSlugRepair(operatorBrief(), draft);
    expect(result.ok).toBe(true);
    expect(draft.body).not.toContain('fall-lawn-mistakes-southwest-florida');
    const pinnedLinks = draft.body.match(new RegExp(PINNED.replace(/\//g, '\\/'), 'g')) || [];
    expect(pinnedLinks.length).toBe(2);
    expect(result.repair.body_self_link_rewrites).toBe(2);
  });

  test('an http:// hub self-link is the SAME drifted route — matched regardless of the configured scheme (Codex r14)', () => {
    const draft = driftedDraft({
      body: 'See [http www form](http://www.wavespestcontrol.com/fall-lawn-mistakes-southwest-florida/) and [http apex form](http://wavespestcontrol.com/fall-lawn-mistakes-southwest-florida/).',
    });
    const result = applyOperatorSlugRepair(operatorBrief(), draft);
    expect(result.ok).toBe(true);
    // Both rewritten AND normalized to the configured https origin.
    expect(draft.body).not.toContain('http://');
    expect(draft.body).toContain(`https://www.wavespestcontrol.com${PINNED}`);
    expect(result.repair.body_self_link_rewrites).toBe(2);
  });

  test('draft.url is stamped even when the writer omitted it — emit_draft never captures a url field (Codex r9)', () => {
    const draft = driftedDraft();
    delete draft.url;
    const result = applyOperatorSlugRepair(operatorBrief(), draft);
    expect(result.ok).toBe(true);
    expect(draft.url).toBe(`https://www.wavespestcontrol.com${PINNED}`);
    expect(result.repair.url_rewritten).toBe(true);
  });

  test('a spoke-targeted draft stamps draft.url on the SPOKE origin and rewrites spoke-absolute self-links (Codex r9)', () => {
    const prev = process.env.SPOKE_BLOG_NETWORK_ENABLED;
    process.env.SPOKE_BLOG_NETWORK_ENABLED = 'true';
    try {
      const brief = {
        target_sites: ['sarasotaflpestcontrol.com'],
        voice_constraints: { operator_brief: { slug: PINNED } },
      };
      const draft = driftedDraft({
        body: [
          'See [www form](https://www.sarasotaflpestcontrol.com/fall-lawn-mistakes-southwest-florida/) and',
          '[apex form](https://sarasotaflpestcontrol.com/fall-lawn-mistakes-southwest-florida/) and',
          '[a DIFFERENT spoke](https://www.veniceflpestcontrol.com/fall-lawn-mistakes-southwest-florida/).',
        ].join(' '),
      });
      const result = applyOperatorSlugRepair(brief, draft);
      expect(result.ok).toBe(true);
      expect(draft.url).toBe(`https://www.sarasotaflpestcontrol.com${PINNED}`);
      // Both host forms of the TARGETED spoke are the writer's own drifted
      // route — repaired and normalized to the spoke's canonical www origin.
      expect(draft.body).toContain(`https://www.sarasotaflpestcontrol.com${PINNED}`);
      expect(draft.body).not.toContain('sarasotaflpestcontrol.com/fall-lawn-mistakes-southwest-florida/');
      expect(draft.body).not.toContain(`https://sarasotaflpestcontrol.com${PINNED}`);
      // A different fleet site's route is someone else's page, not a self-link.
      expect(draft.body).toContain('https://www.veniceflpestcontrol.com/fall-lawn-mistakes-southwest-florida/');
      expect(result.repair.body_self_link_rewrites).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.SPOKE_BLOG_NETWORK_ENABLED;
      else process.env.SPOKE_BLOG_NETWORK_ENABLED = prev;
    }
  });

  test('with the spoke network DISABLED a spoke-targeted draft publishes on the hub — draft.url stays hub-origin (kill switch honored)', () => {
    const prev = process.env.SPOKE_BLOG_NETWORK_ENABLED;
    delete process.env.SPOKE_BLOG_NETWORK_ENABLED;
    try {
      const brief = {
        target_sites: ['sarasotaflpestcontrol.com'],
        voice_constraints: { operator_brief: { slug: PINNED } },
      };
      const draft = driftedDraft();
      const result = applyOperatorSlugRepair(brief, draft);
      expect(result.ok).toBe(true);
      expect(draft.url).toBe(`https://www.wavespestcontrol.com${PINNED}`);
    } finally {
      if (prev !== undefined) process.env.SPOKE_BLOG_NETWORK_ENABLED = prev;
    }
  });

  test('an off-site canonical is PRESERVED for the publisher guard — repair must not mask the unsafe input (Codex r1; protocol-relative r2; slash-backslash r9; network-path r10)', () => {
    for (const foreignCanonical of ['https://competitor.example/their-page/', '//competitor.example/their-page/', '/\\competitor.example/their-page/', '\\\\competitor.example/their-page/']) {
      const draft = driftedDraft({
        frontmatter: { canonical: foreignCanonical },
      });
      const result = applyOperatorSlugRepair(operatorBrief(), draft);
      expect(result.ok).toBe(true);
      expect(draft.frontmatter.slug).toBe(PINNED);
      expect(draft.frontmatter.canonical).toBe(foreignCanonical);
      expect(result.repair.canonical_rewritten).toBe(false);
    }
  });

  test('a draft without a frontmatter object is NOT repairable (cannot publish anyway)', () => {
    const draft = { type: 'draft', body: 'body only' };
    const result = applyOperatorSlugRepair(operatorBrief(), draft);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no frontmatter/);
  });

  test('no operator pin on the brief → null (non-intercept briefs unaffected)', () => {
    expect(applyOperatorSlugRepair({}, driftedDraft())).toBeNull();
  });
});

describe('DEFAULT_MIN_SCORE', () => {
  test('matches scoring-config.THRESHOLDS.minScoreToAct', () => {
    const { THRESHOLDS } = require('../services/content/scoring-config');
    expect(DEFAULT_MIN_SCORE).toBe(THRESHOLDS.minScoreToAct);
  });
});

describe('canary guard env parsing', () => {
  afterEach(() => {
    delete process.env.AUTONOMOUS_CONTENT_REQUIRE_ZERO_P0;
    delete process.env.AUTONOMOUS_CONTENT_MAX_P1_FINDINGS;
    delete process.env.AUTONOMOUS_CONTENT_AGENT_SESSION_TIMEOUT_MS;
  });

  test('envBool accepts common true/false forms', () => {
    process.env.AUTONOMOUS_CONTENT_REQUIRE_ZERO_P0 = 'true';
    expect(envBool('AUTONOMOUS_CONTENT_REQUIRE_ZERO_P0')).toBe(true);
    process.env.AUTONOMOUS_CONTENT_REQUIRE_ZERO_P0 = 'off';
    expect(envBool('AUTONOMOUS_CONTENT_REQUIRE_ZERO_P0', true)).toBe(false);
  });

  test('envInt parses non-negative integer caps', () => {
    process.env.AUTONOMOUS_CONTENT_MAX_P1_FINDINGS = '2';
    expect(envInt('AUTONOMOUS_CONTENT_MAX_P1_FINDINGS')).toBe(2);
    process.env.AUTONOMOUS_CONTENT_MAX_P1_FINDINGS = '-1';
    expect(envInt('AUTONOMOUS_CONTENT_MAX_P1_FINDINGS', 3)).toBe(3);
  });

  test('dailyBatchLimit defaults to 5 and caps at 10', () => {
    delete process.env.AUTONOMOUS_CONTENT_DAILY_BATCH_SIZE;
    expect(dailyBatchLimit()).toBe(5);
    process.env.AUTONOMOUS_CONTENT_DAILY_BATCH_SIZE = '8';
    expect(dailyBatchLimit()).toBe(8);
    process.env.AUTONOMOUS_CONTENT_DAILY_BATCH_SIZE = '50';
    expect(dailyBatchLimit()).toBe(10);
    expect(dailyBatchLimit(0)).toBe(5);
    expect(dailyBatchLimit(3)).toBe(3);
  });

  test('agentSessionTimeoutMs gives long-running content agents more time', () => {
    expect(agentSessionTimeoutMs('new_supporting_blog', { page_type: 'supporting-blog' })).toBe(20 * 60 * 1000);
    expect(agentSessionTimeoutMs('refresh_existing_page', { page_type: 'refresh' })).toBe(20 * 60 * 1000);
    expect(agentSessionTimeoutMs('rewrite_title_meta', { page_type: 'service' })).toBe(5 * 60 * 1000);
    process.env.AUTONOMOUS_CONTENT_AGENT_SESSION_TIMEOUT_MS = '720000';
    expect(agentSessionTimeoutMs('refresh_existing_page', { page_type: 'refresh' })).toBe(720000);
  });
});

// ── Sibling-title loader for metadata-rewrite dedupe ───────────────
//
// astro-publisher's metaRewriteFieldTargets writes the proposed title to
// `metaTitle` on camelCase (service/location) pages and `title` on blog
// pages — and those layouts render fm.metaTitle || fm.title. The sibling
// set behind checkNoDuplicateTitle must therefore include BOTH fields per
// sibling, or a rewrite could duplicate another page's rendered metaTitle
// and still pass the hard duplicate-title check.
describe('_loadSiblingTitlesForMetadata', () => {
  function runnerWithCorpus(corpus) {
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();
    runner._loadAstroCorpus = jest.fn(async () => corpus);
    return runner;
  }

  const corpus = [
    {
      url: '/blog/ants-bradenton/',
      body: '---\ntitle: "Ant Control Tips for Bradenton"\n---\nbody',
    },
    {
      url: '/pest-control-sarasota-fl/',
      body: '---\nmetaTitle: "Pest Control Sarasota FL | Waves"\nmetaDescription: "desc"\n---\nbody',
    },
    {
      url: '/pest-control-venice-fl/',
      body: '---\ntitle: "Venice Page Internal Name"\nmetaTitle: "Pest Control Venice FL | Waves"\n---\nbody',
    },
  ];

  test('collects both title and metaTitle from every sibling (lowercased)', async () => {
    const runner = runnerWithCorpus(corpus);
    const titles = await runner._loadSiblingTitlesForMetadata({ target_url: '/somewhere-else/' }, {});
    expect(titles.has('ant control tips for bradenton')).toBe(true);
    expect(titles.has('pest control sarasota fl | waves')).toBe(true); // metaTitle-only page
    expect(titles.has('venice page internal name')).toBe(true); // both fields collected
    expect(titles.has('pest control venice fl | waves')).toBe(true);
  });

  test('excludes the rewrite target page itself', async () => {
    const runner = runnerWithCorpus(corpus);
    const titles = await runner._loadSiblingTitlesForMetadata({ target_url: '/pest-control-sarasota-fl/' }, {});
    expect(titles.has('pest control sarasota fl | waves')).toBe(false);
    expect(titles.has('ant control tips for bradenton')).toBe(true);
  });

  test('returns an empty set when the corpus loader fails', async () => {
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();
    runner._loadAstroCorpus = jest.fn(async () => { throw new Error('corpus unavailable'); });
    const titles = await runner._loadSiblingTitlesForMetadata({ target_url: '/x/' }, {});
    expect(titles.size).toBe(0);
  });
});

// ── Module exports surface ──────────────────────────────────────────

describe('module exports', () => {
  test('exports runner singleton + AutonomousRunner class', () => {
    const mod = require('../services/content/autonomous-runner');
    expect(typeof mod.runNext).toBe('function');
    expect(typeof mod.runDaily).toBe('function');
    expect(typeof mod.AutonomousRunner).toBe('function');
  });
});

describe('runDaily reserved citability backfill slots', () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; });
  // loadRunnerWith's queue mock (with a row-returning peek) outlives this
  // block in the module registry; re-mock a queue with no peek so later
  // batching tests reserve nothing.
  afterAll(() => { loadRunnerWith({ queue: {} }); });

  function batchRunner(outcomes, reserved) {
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();
    runner.runNext = jest.fn();
    for (const o of outcomes) runner.runNext.mockResolvedValueOnce(o);
    runner.runNext.mockResolvedValue({ outcome: 'skipped_no_opportunity' });
    runner._appendToDailyDigest = jest.fn(async () => {});
    runner._withEngineLock = (label, fn) => fn();
    runner._claimableBackfillSlots = jest.fn(async () => reserved);
    return runner;
  }

  test('the first reserved slots claim backfill rows, then the batch claims by score', async () => {
    const done = { outcome: 'completed_pending_review', action_type: 'refresh_existing_page' };
    const runner = batchRunner([done, done, { outcome: 'completed_pending_review', action_type: 'new_supporting_blog' }], 2);

    const result = await runner.runDaily({ limit: 5 });

    expect(runner._claimableBackfillSlots).toHaveBeenCalledWith(5);
    expect(runner.runNext.mock.calls[0][0]).toMatchObject({ bucket: 'citability_backfill' });
    expect(runner.runNext.mock.calls[1][0]).toMatchObject({ bucket: 'citability_backfill' });
    expect(runner.runNext.mock.calls[2][0].bucket).toBeUndefined();
    // Reserved runs count toward the same batch of 5.
    expect(result).toMatchObject({ count: 4, limit: 5 });
  });

  test('a reserved slot whose row was claimed away returns to the general pool', async () => {
    const blog = { outcome: 'completed_pending_review', action_type: 'new_supporting_blog' };
    const runner = batchRunner([{ outcome: 'skipped_no_opportunity' }, blog, blog, blog, blog, blog], 2);

    const result = await runner.runDaily({ limit: 5 });

    expect(runner.runNext.mock.calls[0][0]).toMatchObject({ bucket: 'citability_backfill' });
    // The empty reserved probe is not recorded and uses no slot; the second
    // reservation is dropped, and all five slots go to scored work.
    expect(runner.runNext.mock.calls.slice(1).every(([args]) => args.bucket === undefined)).toBe(true);
    expect(runner._appendToDailyDigest).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({ count: 5 });
  });

  test('a scoped pass (the blog catch-up) reserves nothing', async () => {
    const runner = batchRunner([{ outcome: 'completed_pending_review', action_type: 'new_supporting_blog' }], 2);
    await runner.runDaily({ limit: 5, actionType: 'new_supporting_blog' });
    expect(runner._claimableBackfillSlots).not.toHaveBeenCalled();
    expect(runner.runNext.mock.calls.every(([args]) => args.bucket === undefined)).toBe(true);
  });

  test('_claimableBackfillSlots: default 2, never the whole batch, sized by what is claimable, 0 disables', async () => {
    const peek = jest.fn(async ({ limit }) => Array.from({ length: limit }, (_, i) => ({ id: i })));
    const runner = loadRunnerWith({ queue: { peek } });
    await expect(runner._claimableBackfillSlots(5)).resolves.toBe(2);
    expect(peek).toHaveBeenCalledWith({ bucket: 'citability_backfill', limit: 2 });
    await expect(runner._claimableBackfillSlots(1)).resolves.toBe(0);
    peek.mockResolvedValueOnce([{ id: 1 }]);
    await expect(runner._claimableBackfillSlots(5)).resolves.toBe(1);
    process.env.AUTONOMOUS_CONTENT_BACKFILL_DAILY_SLOTS = '0';
    await expect(runner._claimableBackfillSlots(5)).resolves.toBe(0);
    process.env.AUTONOMOUS_CONTENT_BACKFILL_DAILY_SLOTS = '9';
    await expect(runner._claimableBackfillSlots(5)).resolves.toBe(4);
    peek.mockRejectedValueOnce(new Error('db down'));
    await expect(runner._claimableBackfillSlots(5)).resolves.toBe(0);
  });
});

describe('runDaily batching', () => {
  test('claims best remaining opportunities until limit or empty queue', async () => {
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();
    runner.runNext = jest.fn()
      .mockResolvedValueOnce({ outcome: 'completed_pending_review', action_type: 'new_supporting_blog' })
      .mockResolvedValueOnce({ outcome: 'completed_pending_review', action_type: 'rewrite_title_meta' })
      .mockResolvedValueOnce({ outcome: 'skipped_no_opportunity' });
    runner._appendToDailyDigest = jest.fn(async () => {});
    runner._withEngineLock = (label, fn) => fn(); // batching tests bypass the engine lock

    const result = await runner.runDaily({ limit: 5 });

    expect(runner.runNext).toHaveBeenCalledTimes(3);
    expect(runner._appendToDailyDigest).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      outcome: 'skipped_no_opportunity',
      count: 3,
      limit: 5,
    });
  });

  test.each(['failed', 'failed_agent', 'failed_publish'])(
    'halts the batch after the consecutive-failure cap on persistent %s outcomes',
    async (outcome) => {
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();
    runner.runNext = jest.fn().mockResolvedValue({
      outcome,
      failure_message: 'brief_compose:dependency unavailable',
    });
    runner._appendToDailyDigest = jest.fn(async () => {});
    runner._withEngineLock = (label, fn) => fn(); // batching tests bypass the engine lock

    const result = await runner.runDaily({ limit: 5 });

    // Default AUTONOMOUS_CONTENT_MAX_CONSECUTIVE_FAILURES = 2: a persistent
    // failure no longer abandons the whole day after one hiccup, but a broken
    // engine still stops fast (2 attempts, not the full limit of 5).
    expect(runner.runNext).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      outcome,
      count: 2,
      limit: 5,
      failures: 2,
    });
  });

  test('continues to the next opportunity past a failure, excluding the failed one', async () => {
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();
    runner.runNext = jest.fn()
      .mockResolvedValueOnce({ outcome: 'failed_agent', failure_message: 'dispatch:transient blip', opportunity_id: 'opp_poison' })
      .mockResolvedValueOnce({ outcome: 'completed_pending_review', action_type: 'new_supporting_blog', opportunity_id: 'opp_2' })
      .mockResolvedValueOnce({ outcome: 'skipped_no_opportunity' });
    runner._appendToDailyDigest = jest.fn(async () => {});
    runner._withEngineLock = (label, fn) => fn(); // batching tests bypass the engine lock

    const result = await runner.runDaily({ limit: 5 });

    // The single failure should NOT stop the batch — the counter resets after
    // the subsequent success, and the loop drains until the queue empties.
    expect(runner.runNext).toHaveBeenCalledTimes(3);
    // The failed opportunity must be excluded from subsequent claims so the
    // released-to-pending poison row isn't just re-served at the top.
    expect(runner.runNext).toHaveBeenNthCalledWith(1, { excludeIds: [] });
    expect(runner.runNext).toHaveBeenNthCalledWith(2, { excludeIds: ['opp_poison'] });
    expect(runner.runNext).toHaveBeenNthCalledWith(3, { excludeIds: ['opp_poison'] });
    expect(result).toMatchObject({
      outcome: 'skipped_no_opportunity',
      count: 3,
      limit: 5,
      failures: 1,
    });
  });

  test('narrows to the blog lane when non-blog failures hit the cap before any blog attempt', async () => {
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();
    runner.runNext = jest.fn()
      .mockResolvedValueOnce({ outcome: 'failed_agent', action_type: 'create_or_refresh_city_service_page', failure_message: 'streaming_failed: deadline', opportunity_id: 'city_1' })
      .mockResolvedValueOnce({ outcome: 'failed_agent', action_type: 'create_or_refresh_city_service_page', failure_message: 'streaming_failed: deadline', opportunity_id: 'city_2' })
      .mockResolvedValueOnce({ outcome: 'completed_published', action_type: 'new_supporting_blog', opportunity_id: 'blog_1' })
      .mockResolvedValueOnce({ outcome: 'skipped_no_opportunity' });
    runner._appendToDailyDigest = jest.fn(async () => {});
    runner._sendBlogDroughtSms = jest.fn(async () => {});
    runner._withEngineLock = (label, fn) => fn();

    const result = await runner.runDaily({ limit: 5 });

    // The 9am batch used to halt here (2 consecutive failures) with zero blog
    // attempts; now the remaining slots claim blog-only, failed rows still excluded.
    expect(runner.runNext).toHaveBeenCalledTimes(4);
    // Not a halt: the drought sender must not be told one happened.
    expect(runner._sendBlogDroughtSms).toHaveBeenCalledWith(expect.any(Array), { haltBeforeBlog: null });
    expect(runner.runNext).toHaveBeenNthCalledWith(1, { excludeIds: [] });
    expect(runner.runNext).toHaveBeenNthCalledWith(2, { excludeIds: ['city_1'] });
    expect(runner.runNext).toHaveBeenNthCalledWith(3, { excludeIds: ['city_1', 'city_2'], actionType: 'new_supporting_blog' });
    expect(runner.runNext).toHaveBeenNthCalledWith(4, { excludeIds: ['city_1', 'city_2'], actionType: 'new_supporting_blog' });
    expect(result).toMatchObject({ outcome: 'skipped_no_opportunity', count: 4, failures: 2 });
  });

  test('reserves one blog-scoped claim when the cap lands on the final slot (Codex r2)', async () => {
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();
    const ok = (id) => ({ outcome: 'completed_pending_review', action_type: 'rewrite_title_meta', opportunity_id: id });
    runner.runNext = jest.fn()
      .mockResolvedValueOnce(ok('m1'))
      .mockResolvedValueOnce(ok('m2'))
      .mockResolvedValueOnce(ok('m3'))
      .mockResolvedValueOnce({ outcome: 'failed_agent', action_type: 'create_or_refresh_city_service_page', opportunity_id: 'city_1' })
      .mockResolvedValueOnce({ outcome: 'failed_agent', action_type: 'create_or_refresh_city_service_page', opportunity_id: 'city_2' })
      .mockResolvedValueOnce({ outcome: 'completed_published', action_type: 'new_supporting_blog', opportunity_id: 'blog_1' })
      .mockResolvedValueOnce({ outcome: 'skipped_no_opportunity' });
    runner._appendToDailyDigest = jest.fn(async () => {});
    runner._sendBlogDroughtSms = jest.fn(async () => {});
    runner._withEngineLock = (label, fn) => fn();

    const result = await runner.runDaily({ limit: 5 });

    // Slot 5 (the last) hit the cap: the narrowed claim still gets exactly
    // one extra slot instead of the loop exiting with it never made.
    expect(runner.runNext).toHaveBeenCalledTimes(6);
    expect(runner.runNext).toHaveBeenNthCalledWith(6, { excludeIds: ['city_1', 'city_2'], actionType: 'new_supporting_blog' });
    expect(runner._sendBlogDroughtSms).toHaveBeenCalledWith(expect.any(Array), { haltBeforeBlog: null });
    expect(result).toMatchObject({ outcome: 'completed_published', count: 6, limit: 5, failures: 2 });
  });

  test('the blog fallback fires once: blog-lane failures after narrowing halt for real', async () => {
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();
    runner.runNext = jest.fn()
      .mockResolvedValueOnce({ outcome: 'failed_agent', action_type: 'create_or_refresh_city_service_page', opportunity_id: 'city_1' })
      .mockResolvedValueOnce({ outcome: 'failed_agent', action_type: 'create_or_refresh_city_service_page', opportunity_id: 'city_2' })
      .mockResolvedValueOnce({ outcome: 'failed_agent', action_type: 'new_supporting_blog', opportunity_id: 'blog_1' })
      .mockResolvedValueOnce({ outcome: 'failed_agent', action_type: 'new_supporting_blog', opportunity_id: 'blog_2' })
      .mockResolvedValueOnce({ outcome: 'completed_published', action_type: 'new_supporting_blog' });
    runner._appendToDailyDigest = jest.fn(async () => {});
    runner._withEngineLock = (label, fn) => fn();

    const result = await runner.runDaily({ limit: 10 });

    expect(runner.runNext).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ count: 4, failures: 4 });
  });

  test('no fallback once a blog was already attempted, on a scoped pass, or when killed', async () => {
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const cityFail = (id) => ({ outcome: 'failed_agent', action_type: 'create_or_refresh_city_service_page', opportunity_id: id });

    // Blog already attempted earlier in the batch → plain halt.
    let runner = new AutonomousRunner();
    runner.runNext = jest.fn()
      .mockResolvedValueOnce({ outcome: 'completed_pending_review', action_type: 'new_supporting_blog', skip_reason: 'astro_pr_pending_merge' })
      .mockResolvedValueOnce(cityFail('c1'))
      .mockResolvedValueOnce(cityFail('c2'));
    runner._appendToDailyDigest = jest.fn(async () => {});
    runner._withEngineLock = (label, fn) => fn();
    await runner.runDaily({ limit: 10 });
    expect(runner.runNext).toHaveBeenCalledTimes(3);

    // Scoped (catch-up style) pass → plain halt.
    runner = new AutonomousRunner();
    runner.runNext = jest.fn().mockResolvedValue(cityFail('c1'));
    runner._appendToDailyDigest = jest.fn(async () => {});
    runner._withEngineLock = (label, fn) => fn();
    await runner._runDailyInner({ limit: 10, actionType: 'create_or_refresh_city_service_page' });
    expect(runner.runNext).toHaveBeenCalledTimes(2);

    // Kill switch → plain halt, and the drought SMS is told it was a halt
    // before any blog attempt (the only path that may say "batch halted").
    process.env.AUTONOMOUS_CONTENT_BLOG_FALLBACK = 'false';
    try {
      runner = new AutonomousRunner();
      runner.runNext = jest.fn().mockResolvedValue(cityFail('c1'));
      runner._appendToDailyDigest = jest.fn(async () => {});
      runner._sendBlogDroughtSms = jest.fn(async () => {});
      runner._withEngineLock = (label, fn) => fn();
      await runner.runDaily({ limit: 10 });
      expect(runner.runNext).toHaveBeenCalledTimes(2);
      expect(runner._sendBlogDroughtSms).toHaveBeenCalledWith(expect.any(Array), {
        haltBeforeBlog: { failures: 2, lanes: ['create_or_refresh_city_service_page'] },
      });
    } finally {
      delete process.env.AUTONOMOUS_CONTENT_BLOG_FALLBACK;
    }
  });
});

// ── engine publishing lock ──────────────────────────────────────────

describe('engine publishing lock (_withEngineLock)', () => {
  function fakeClient({ locked = true, acquireThrows = false } = {}) {
    const conn = {
      query: jest.fn(async (sql) => {
        if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked }] };
        if (/pg_advisory_unlock/.test(sql)) return { rows: [{ pg_advisory_unlock: true }] };
        return { rows: [] };
      }),
    };
    return {
      conn,
      acquireConnection: jest.fn(async () => {
        if (acquireThrows) throw new Error('pool exhausted');
        return conn;
      }),
      releaseConnection: jest.fn(async () => {}),
    };
  }

  function freshRunnerWithClient(client) {
    jest.resetModules();
    const db = require('../models/db');
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    db.client = client; // runner captured the same db instance; mutate its client
    return new AutonomousRunner();
  }

  test('skips (does not run fn) when another run already holds the lock', async () => {
    const client = fakeClient({ locked: false });
    const runner = freshRunnerWithClient(client);
    const fn = jest.fn(async () => ({ outcome: 'completed_published' }));

    const result = await runner._withEngineLock('test', fn);

    expect(fn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'skipped_locked', reason: 'engine_locked' });
    expect(client.releaseConnection).toHaveBeenCalledWith(client.conn);
    // never tried to unlock a lock it didn't hold
    expect(client.conn.query).not.toHaveBeenCalledWith(expect.stringContaining('pg_advisory_unlock'), expect.anything());
  });

  test('runs fn, then unlocks and releases the connection, when the lock is acquired', async () => {
    const client = fakeClient({ locked: true });
    const runner = freshRunnerWithClient(client);
    const fn = jest.fn(async () => ({ outcome: 'completed_published', count: 1 }));

    const result = await runner._withEngineLock('test', fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: 'completed_published', count: 1 });
    expect(client.conn.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_unlock'), [expect.any(Number)]);
    expect(client.releaseConnection).toHaveBeenCalledWith(client.conn);
  });

  test('unlocks even when fn throws, then re-throws', async () => {
    const client = fakeClient({ locked: true });
    const runner = freshRunnerWithClient(client);
    const fn = jest.fn(async () => { throw new Error('boom'); });

    await expect(runner._withEngineLock('test', fn)).rejects.toThrow('boom');
    expect(client.conn.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_unlock'), [expect.any(Number)]);
    expect(client.releaseConnection).toHaveBeenCalledWith(client.conn);
  });

  test('degrades (runs fn anyway) when the lock connection cannot be acquired', async () => {
    const client = fakeClient({ acquireThrows: true });
    const runner = freshRunnerWithClient(client);
    const fn = jest.fn(async () => ({ outcome: 'completed_published' }));

    const result = await runner._withEngineLock('test', fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: 'completed_published' });
  });
});

// ── Feature gate sanity ─────────────────────────────────────────────

describe('autonomousContentEngine feature gate is registered', () => {
  test('gates module exports autonomousContentEngine', () => {
    const gates = require('../config/feature-gates').gates;
    expect(gates).toHaveProperty('autonomousContentEngine');
  });
});

// ── dry-run claim handling ─────────────────────────────────────────

function loadRunnerWith({
  queue,
  briefBuilder,
  dispatcher = {},
  qualityGate = null,
  uniquenessGate = null,
  seoCompletionGate = { evaluate: jest.fn().mockReturnValue({ passed: true, score: 100, summary: { p0: 0, p1: 0, p2: 0 }, findings: [] }) },
  visibilityGate = { evaluateStatic: jest.fn().mockReturnValue({ passed: true, findings: [], summary: { p0: 0, p1: 0, p2: 0, p3: 0, needs_review: false } }) },
  publisher = null,
  indexNow = null,
  linkPlanner = null,
  internalLinkExecutor = null,
  // Default to "not protected" so publish/gate tests aren't blocked by the
  // protected-page guard (which now also runs for in-place editors like
  // rewrite_title_meta). Protection-specific tests pass their own mock.
  protectedPages = { isProtected: jest.fn().mockResolvedValue({ protected: false }) },
  factsSufficiency = null,
  // undefined = real module; the string 'unavailable' = simulate a module
  // LOAD failure (the doMock factory throws, so the runner's lazy() require
  // catches it and returns null); an object = plain mock.
  contentGuardrails = undefined,
  comparisonTableGate = undefined,
  claimsLedgerValidator = undefined,
  dbQuery = null,
  dbClient = null,
}) {
  queue.skip ||= jest.fn().mockResolvedValue(true);
  jest.resetModules();
  const dbMock = jest.fn((...args) => {
    if (dbQuery) return dbQuery(...args);
    const returning = jest.fn().mockResolvedValue([{ id: 'run_1' }]);
    const ignore = jest.fn(() => ({ returning }));
    const onConflict = jest.fn(() => ({ ignore }));
    return {
      insert: jest.fn(() => ({ returning, onConflict })),
    };
  });
  if (dbClient) dbMock.client = dbClient;
  jest.doMock('../models/db', () => dbMock);
  jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  // The runner fires the owner email-approval notification via setImmediate
  // after a pending-review park — the REAL module's require inside that
  // callback lands after Jest teardown ("import after the Jest environment
  // has been torn down", hook r12 P1). A resolved no-op keeps the drain
  // clean; suites asserting notification behavior have their own harness.
  jest.doMock('../services/content/email-approvals', () => ({
    notifyParkedRun: jest.fn().mockResolvedValue(undefined),
    _internals: { draftPreview: jest.fn().mockReturnValue('') },
  }));
  jest.doMock('../services/content/opportunity-queue', () => queue);
  jest.doMock('../services/content/content-brief-builder', () => briefBuilder);
  jest.doMock('../services/content/agents/agent-dispatcher', () => dispatcher);
  if (qualityGate) jest.doMock('../services/content/content-quality-gate', () => qualityGate);
  if (uniquenessGate) jest.doMock('../services/content/uniqueness-gate', () => uniquenessGate);
  if (seoCompletionGate) jest.doMock('../services/content/seo-completion-gate', () => seoCompletionGate);
  if (visibilityGate) jest.doMock('../services/content/ai-visibility-gate', () => visibilityGate);
  if (publisher) jest.doMock('../services/content-astro/astro-publisher', () => publisher);
  if (indexNow) jest.doMock('../services/seo/indexnow-submit', () => indexNow);
  // The pre-draft topic-targeting gate (step 2d) needs the live blog corpus
  // and fails CLOSED without one; default a benign stub loader under any
  // explicit planner so drafting-path tests keep reaching the writer.
  jest.doMock('../services/content/internal-link-planner', () => ({
    loadAstroCorpusFromGitHub: jest.fn().mockResolvedValue([{
      path: 'src/content/blog/pest-control/seasonal-ant-pressure.md',
      url: '/pest-control/seasonal-ant-pressure/',
      body: '---\ntitle: Seasonal Ant Pressure in SWFL\nslug: /pest-control/seasonal-ant-pressure/\nprimary_keyword: seasonal ant pressure\n---\n\n## Why ants surge\n',
    }]),
    ...(linkPlanner || {}),
  }));
  if (internalLinkExecutor) jest.doMock('../services/content/internal-link-pr-executor', () => internalLinkExecutor);
  if (protectedPages) jest.doMock('../services/content/protected-pages', () => protectedPages);
  if (factsSufficiency) jest.doMock('../services/content/facts-sufficiency', () => factsSufficiency);
  const mockOrLoadFail = (path, value) => {
    // doMock registrations survive jest.resetModules(), so an earlier test's
    // throwing factory would leak into later tests — explicitly restore the
    // real module when no mock is requested.
    if (value === undefined) { jest.dontMock(path); return; }
    if (value === 'unavailable') jest.doMock(path, () => { throw new Error('module load failed'); });
    else jest.doMock(path, () => value);
  };
  mockOrLoadFail('../services/content/content-guardrails', contentGuardrails);
  mockOrLoadFail('../services/content/comparison-table-gate', comparisonTableGate);
  mockOrLoadFail('../services/content/claims-ledger-validator', claimsLedgerValidator);
  return require('../services/content/autonomous-runner');
}

describe('runNext dry-run behavior', () => {
  test('previews with peek and does not claim, release, or call dispatcher setup checks', async () => {
    const queue = {
      peek: jest.fn().mockResolvedValue([{ id: 'opp_1', action_type: 'new_supporting_blog' }]),
      claimNext: jest.fn().mockResolvedValue(null),
      release: jest.fn().mockResolvedValue(),
      skip: jest.fn().mockResolvedValue(),
      complete: jest.fn().mockResolvedValue(),
    };
    const briefBuilder = {
      compose: jest.fn().mockResolvedValue({
        id: 'brief_1',
        action_type: 'create_or_refresh_city_service_page',
        page_type: 'city-service',
      }),
    };
    const dispatcher = {
      runWithBrief: jest.fn().mockResolvedValue({ ok: false, reason: 'missing_agent_id' }),
    };
    const runner = loadRunnerWith({ queue, briefBuilder, dispatcher });

    const result = await runner.runNext({ dryRun: true });

    expect(result.outcome).toBe('skipped_shadow_mode');
    expect(result.skip_reason).toBe('dry_run_via_cli');
    expect(result.action_type).toBe('create_or_refresh_city_service_page');
    expect(queue.peek).toHaveBeenCalledWith({ limit: 1, minScore: expect.any(Number) });
    expect(briefBuilder.compose).toHaveBeenCalledWith('opp_1', { persist: false, skipSerp: true });
    expect(dispatcher.runWithBrief).not.toHaveBeenCalled();
    expect(queue.claimNext).not.toHaveBeenCalled();
    expect(queue.release).not.toHaveBeenCalled();
    expect(queue.skip).not.toHaveBeenCalled();
    expect(queue.complete).not.toHaveBeenCalled();
  });

  test('do_not_publish dry-runs do not permanently skip queue item', async () => {
    const queue = {
      peek: jest.fn().mockResolvedValue([{ id: 'opp_2', action_type: 'new_supporting_blog' }]),
      claimNext: jest.fn().mockResolvedValue(null),
      release: jest.fn().mockResolvedValue(),
      skip: jest.fn().mockResolvedValue(),
      complete: jest.fn().mockResolvedValue(),
    };
    const briefBuilder = {
      compose: jest.fn().mockResolvedValue({
        id: 'brief_2',
        action_type: 'do_not_publish',
        human_review_reason: 'router_public_health',
      }),
    };
    const runner = loadRunnerWith({ queue, briefBuilder });

    const result = await runner.runNext({ dryRun: true });

    expect(result.outcome).toBe('skipped_gate_fail');
    expect(result.skip_reason).toBe('router_public_health');
    expect(queue.claimNext).not.toHaveBeenCalled();
    expect(queue.release).not.toHaveBeenCalled();
    expect(queue.skip).not.toHaveBeenCalled();
    expect(queue.complete).not.toHaveBeenCalled();
  });
});

describe('protected-page guard', () => {
  test('blocks derived city-service money pages even when opportunity page_url is absent', async () => {
    const claimedAt = new Date('2026-05-28T13:00:00Z');
    const queue = {
      claimNext: jest.fn().mockResolvedValue({
        id: 'opp_protected_city_service',
        action_type: 'create_or_refresh_city_service_page',
        page_url: null,
        service: 'pest',
        city: 'Sarasota',
        claimed_at: claimedAt,
      }),
      pendingReview: jest.fn().mockResolvedValue(true),
      skip: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    };
    const briefBuilder = { compose: jest.fn() };
    const dispatcher = { runWithBrief: jest.fn() };
    const protectedPages = {
      isProtected: jest.fn().mockResolvedValue({
        protected: true,
        reason: 'money_page',
        source: 'pattern',
        detail: 'pest-control city hub',
      }),
    };
    const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, protectedPages });

    const result = await runner.runNext();

    expect(protectedPages.isProtected).toHaveBeenCalledWith('/pest-control-sarasota-fl/', { db: expect.any(Function) });
    expect(result.outcome).toBe('skipped_gate_fail');
    expect(result.skip_reason).toBe('protected_page:money_page');
    expect(result.reviewer_notes).toContain('/pest-control-sarasota-fl/');
    expect(briefBuilder.compose).not.toHaveBeenCalled();
    expect(dispatcher.runWithBrief).not.toHaveBeenCalled();
    // By-design money-page protection skips silently — the review queue is
    // exceptions-only; only a protected-check ERROR still parks (see below).
    expect(queue.skip).toHaveBeenCalledWith('opp_protected_city_service', 'protected_page:money_page', { claimToken: claimedAt });
    expect(queue.pendingReview).not.toHaveBeenCalled();
  });

  test('add_internal_links is never blocked by target protection (the target page is not edited)', async () => {
    const protectedPages = {
      isProtected: jest.fn().mockResolvedValue({ protected: true, reason: 'money_page', source: 'pattern' }),
    };
    const runner = loadRunnerWith({ queue: { claimNext: jest.fn() }, briefBuilder: { compose: jest.fn() }, protectedPages });

    expect(await runner._checkProtectedPage({
      action_type: 'add_internal_links',
      page_url: '/pest-control-sarasota-fl/',
    })).toBeNull();
    expect(await runner._checkProtectedPage(
      { action_type: 'refresh_existing_page', page_url: '/pest-control-sarasota-fl/' },
      { action_type: 'add_internal_links', target_url: '/pest-control-sarasota-fl/' },
    )).toBeNull();
    expect(protectedPages.isProtected).not.toHaveBeenCalled();

    // Page-editing action types still get the guard.
    const verdict = await runner._checkProtectedPage({
      action_type: 'refresh_existing_page',
      page_url: '/pest-control-sarasota-fl/',
    });
    expect(verdict).toMatchObject({ protected: true, reason: 'money_page' });
  });

  test('a thrown protected-page check fails closed and is tagged is_error (not a routine skip)', async () => {
    const protectedPages = {
      isProtected: jest.fn().mockRejectedValue(new Error('db timeout')),
    };
    const runner = loadRunnerWith({ queue: { claimNext: jest.fn() }, briefBuilder: { compose: jest.fn() }, protectedPages });

    const verdict = await runner._checkProtectedPage({
      action_type: 'create_or_refresh_city_service_page',
      service: 'pest',
      city: 'Sarasota',
    });

    expect(verdict).toMatchObject({
      protected: true,
      reason: 'protected_check_error',
      is_error: true,
    });
    expect(verdict.detail).toContain('db timeout');
  });

  test('a thrown protected-page check still routes the run to review (fail-closed)', async () => {
    const claimedAt = new Date('2026-05-28T13:00:00Z');
    const queue = {
      claimNext: jest.fn().mockResolvedValue({
        id: 'opp_protected_err',
        action_type: 'create_or_refresh_city_service_page',
        page_url: null,
        service: 'pest',
        city: 'Sarasota',
        claimed_at: claimedAt,
      }),
      pendingReview: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    };
    const protectedPages = { isProtected: jest.fn().mockRejectedValue(new Error('db timeout')) };
    const runner = loadRunnerWith({ queue, briefBuilder: { compose: jest.fn() }, dispatcher: { runWithBrief: jest.fn() }, protectedPages });

    const result = await runner.runNext();

    expect(result.outcome).toBe('skipped_gate_fail');
    expect(result.skip_reason).toBe('protected_page:protected_check_error');
    expect(queue.pendingReview).toHaveBeenCalledWith('opp_protected_err', 'protected_page:protected_check_error', { claimToken: claimedAt });
  });

  test('the guard\'s own RETURNED error verdict (no throw) is also tagged is_error', async () => {
    // protected-pages.js catches registry failures itself and RETURNS
    // { protected:true, reason:'protected_check_error', source:'error' } — the
    // common DB-error path. The runner must tag this the same as a throw.
    const protectedPages = {
      isProtected: jest.fn().mockResolvedValue({
        protected: true,
        reason: 'protected_check_error',
        source: 'error',
        detail: 'registry read failed',
      }),
    };
    const runner = loadRunnerWith({ queue: { claimNext: jest.fn() }, briefBuilder: { compose: jest.fn() }, protectedPages });

    const verdict = await runner._checkProtectedPage({
      action_type: 'create_or_refresh_city_service_page',
      service: 'pest',
      city: 'Sarasota',
    });

    expect(verdict).toMatchObject({
      protected: true,
      reason: 'protected_check_error',
      source: 'error',
      is_error: true,
    });
    expect(verdict.detail).toContain('registry read failed');
  });
});

describe('runNext claim failures', () => {
  test('records claim exceptions as failed, not no-op', async () => {
    const queue = {
      claimNext: jest.fn().mockRejectedValue(new Error('database down')),
    };
    const runner = loadRunnerWith({ queue, briefBuilder: {} });

    const result = await runner.runNext();

    expect(result.outcome).toBe('failed');
    expect(result.failure_message).toBe('claim:database down');
  });
});

describe('runNext internal-link post-merge verification', () => {
  test('optionally verifies merged internal-link PRs before claiming a new opportunity', async () => {
    const previousVerify = process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN;
    process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN = 'true';
    try {
      const queue = {
        claimNext: jest.fn().mockResolvedValue(null),
      };
      const internalLinkExecutor = {
        runPostMergeVerification: jest.fn().mockResolvedValue({
          count: 2,
          results: [
            { task_id: 'task-1', status: 'verified' },
            { task_id: 'task-2', status: 'merged', failure_reason: 'internal_link_verify_empty_live_html' },
          ],
        }),
      };
      const runner = loadRunnerWith({ queue, briefBuilder: {}, internalLinkExecutor });

      const result = await runner.runNext();

      expect(internalLinkExecutor.runPostMergeVerification).toHaveBeenCalledWith({ limit: 10 });
      expect(queue.claimNext).toHaveBeenCalled();
      expect(result.outcome).toBe('skipped_no_opportunity');
      expect(result.internal_link_verify_count).toBe(2);
      expect(result.internal_link_verified_count).toBe(1);
      expect(result.internal_link_verify_failed_count).toBe(1);
    } finally {
      if (previousVerify === undefined) delete process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN;
      else process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN = previousVerify;
    }
  });

  test('verification errors do not block opportunity claiming', async () => {
    const previousVerify = process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN;
    process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN = 'true';
    try {
      const claimedAt = new Date('2026-05-28T07:30:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_verify_nonblocking',
          action_type: 'add_internal_links',
          claimed_at: claimedAt,
        }),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_verify_nonblocking',
          action_type: 'add_internal_links',
          page_type: 'internal-link',
          target_url: '/pest-control-bradenton-fl/',
          target_keyword: 'pest control bradenton',
        }),
      };
      const linkPlanner = {
        planForTarget: jest.fn().mockReturnValue([]),
      };
      const internalLinkExecutor = {
        runPostMergeVerification: jest.fn().mockRejectedValue(new Error('GitHub unavailable')),
      };
      const runner = loadRunnerWith({ queue, briefBuilder, linkPlanner, internalLinkExecutor });

      const result = await runner.runNext();

      expect(result.internal_link_verify_error).toBe('GitHub unavailable');
      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('internal_links_dry_run_shadow');
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_verify_nonblocking', 'internal_links_dry_run_shadow', { claimToken: claimedAt });
    } finally {
      if (previousVerify === undefined) delete process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN;
      else process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN = previousVerify;
    }
  });

  test('verification timeouts do not block opportunity claiming', async () => {
    const previousVerify = process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN;
    const previousTimeout = process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_TIMEOUT_MS;
    process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN = 'true';
    process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_TIMEOUT_MS = '1';
    try {
      const queue = {
        claimNext: jest.fn().mockResolvedValue(null),
      };
      const internalLinkExecutor = {
        runPostMergeVerification: jest.fn(() => new Promise(() => {})),
      };
      const runner = loadRunnerWith({ queue, briefBuilder: {}, internalLinkExecutor });

      const result = await runner.runNext();

      expect(result.outcome).toBe('skipped_no_opportunity');
      expect(result.internal_link_verify_error).toBe('internal_link_verify_timeout_1ms');
      expect(queue.claimNext).toHaveBeenCalled();
    } finally {
      if (previousVerify === undefined) delete process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN;
      else process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN = previousVerify;
      if (previousTimeout === undefined) delete process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_TIMEOUT_MS;
      else process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_TIMEOUT_MS = previousTimeout;
    }
  });
});

describe('runNext Astro corpus loading', () => {
  test('loads uniqueness sibling pages from GitHub when ASTRO_REPO_DIR is unset', async () => {
    const previousAstroDir = process.env.ASTRO_REPO_DIR;
    delete process.env.ASTRO_REPO_DIR;

    try {
      const claimedAt = new Date('2026-05-28T01:30:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_customer_question_1',
          action_type: 'create_customer_question_page',
          claimed_at: claimedAt,
        }),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_customer_question_1',
          action_type: 'create_customer_question_page',
          page_type: 'customer-question',
          service: 'pest',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: { body: 'Customer question draft body.' },
        }),
      };
      const uniquenessGate = {
        evaluate: jest.fn().mockReturnValue({ ok: true, failed_reasons: [] }),
      };
      const qualityGate = {
        evaluate: jest.fn().mockReturnValue({
          ok: true,
          hard_failures: [],
          soft_failures: [],
          total_score: 100,
          min_total_score: 80,
        }),
      };
      const linkPlanner = {
        loadAstroCorpusFromGitHub: jest.fn().mockResolvedValue([
          { file: 'src/content/services/pest-control-bradenton-fl.md', body: 'Sibling pest page body.', url: '/pest-control-bradenton-fl/' },
          { file: 'src/content/services/lawn-care-bradenton-fl.md', body: 'Sibling lawn page body.', url: '/lawn-care-bradenton-fl/' },
        ]),
      };
      const runner = loadRunnerWith({
        queue,
        briefBuilder,
        dispatcher,
        uniquenessGate,
        qualityGate,
        linkPlanner,
      });

      const result = await runner.runNext();

      expect(result.outcome).toBe('skipped_shadow_mode');
      expect(linkPlanner.loadAstroCorpusFromGitHub).toHaveBeenCalledWith({ collections: ['services', 'locations'] });
      expect(uniquenessGate.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'Customer question draft body.' }),
        expect.objectContaining({ page_type: 'customer-question' }),
        { siblingPages: [expect.objectContaining({ file: 'src/content/services/pest-control-bradenton-fl.md' })] }
      );
    } finally {
      if (previousAstroDir === undefined) delete process.env.ASTRO_REPO_DIR;
      else process.env.ASTRO_REPO_DIR = previousAstroDir;
    }
  });

  test('a live internal-link run releases the claim when the corpus cannot load (retry, not "no candidates")', async () => {
    const previousAstroDir = process.env.ASTRO_REPO_DIR;
    const previousShadow = process.env.SHADOW_MODE_ADD_INTERNAL_LINKS;
    delete process.env.ASTRO_REPO_DIR;
    process.env.SHADOW_MODE_ADD_INTERNAL_LINKS = 'false';

    try {
      const claimedAt = new Date('2026-05-28T01:45:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_links_optional_1',
          action_type: 'add_internal_links',
          claimed_at: claimedAt,
        }),
        pendingReview: jest.fn().mockResolvedValue(true),
        skip: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_links_optional_1',
          action_type: 'add_internal_links',
          page_type: 'internal-link',
          target_url: '/blog/ghost-ants/',
          target_keyword: 'ghost ants',
        }),
      };
      const linkPlanner = {
        loadAstroCorpusFromGitHub: jest.fn().mockRejectedValue(new Error('GitHub token missing')),
        planForTarget: jest.fn().mockReturnValue([]),
      };
      const runner = loadRunnerWith({ queue, briefBuilder, linkPlanner });

      const result = await runner.runNext();

      expect(result.outcome).toBe('failed');
      expect(result.failure_message).toContain('GitHub token missing');
      expect(linkPlanner.planForTarget).not.toHaveBeenCalled();
      expect(queue.release).toHaveBeenCalledWith('opp_links_optional_1', { claimToken: claimedAt });
      expect(queue.skip).not.toHaveBeenCalled();
      expect(queue.pendingReview).not.toHaveBeenCalled();
    } finally {
      if (previousAstroDir === undefined) delete process.env.ASTRO_REPO_DIR;
      else process.env.ASTRO_REPO_DIR = previousAstroDir;
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_ADD_INTERNAL_LINKS;
      else process.env.SHADOW_MODE_ADD_INTERNAL_LINKS = previousShadow;
    }
  });

  test('required GitHub corpus load failures still fail closed for uniqueness gates', async () => {
    const previousAstroDir = process.env.ASTRO_REPO_DIR;
    const previousShadow = process.env.SHADOW_MODE_CREATE_CUSTOMER_QUESTION_PAGE;
    delete process.env.ASTRO_REPO_DIR;
    process.env.SHADOW_MODE_CREATE_CUSTOMER_QUESTION_PAGE = 'false';

    try {
      const claimedAt = new Date('2026-05-28T01:50:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_required_corpus_1',
          action_type: 'create_customer_question_page',
          claimed_at: claimedAt,
        }),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_required_corpus_1',
          action_type: 'create_customer_question_page',
          page_type: 'customer-question',
          service: 'pest',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: { body: 'Customer question draft body.' },
        }),
      };
      const uniquenessGate = {
        evaluate: jest.fn().mockReturnValue({ ok: true, failed_reasons: [] }),
      };
      const linkPlanner = {
        loadAstroCorpusFromGitHub: jest.fn().mockRejectedValue(new Error('GitHub unavailable')),
      };
      const runner = loadRunnerWith({
        queue,
        briefBuilder,
        dispatcher,
        uniquenessGate,
        linkPlanner,
      });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('gate_infrastructure_error');
      expect(result.uniqueness_gate_result).toMatchObject({ ok: false, error: 'GitHub unavailable' });
      expect(uniquenessGate.evaluate).not.toHaveBeenCalled();
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_required_corpus_1', 'gate_infrastructure_error', { claimToken: claimedAt });
    } finally {
      if (previousAstroDir === undefined) delete process.env.ASTRO_REPO_DIR;
      else process.env.ASTRO_REPO_DIR = previousAstroDir;
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_CREATE_CUSTOMER_QUESTION_PAGE;
      else process.env.SHADOW_MODE_CREATE_CUSTOMER_QUESTION_PAGE = previousShadow;
    }
  });
});

describe('runNext internal-link shadow behavior', () => {
  test('queues shadow internal-link tasks and runs dry-run validation so the queue can advance', async () => {
    const claimedAt = new Date('2026-05-23T05:00:00Z');
    const queue = {
      claimNext: jest.fn().mockResolvedValue({
        id: 'opp_links_1',
        action_type: 'add_internal_links',
        claimed_at: claimedAt,
      }),
      complete: jest.fn().mockResolvedValue(true),
      pendingReview: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    };
    const briefBuilder = {
      compose: jest.fn().mockResolvedValue({
        id: 'brief_links_1',
        action_type: 'add_internal_links',
        page_type: 'internal-link',
        target_url: 'https://www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida/',
        target_keyword: 'ghost ants kitchen',
      }),
    };
    const linkPlanner = {
      planForTarget: jest.fn().mockReturnValue([
        {
          source_file: 'src/content/blog/ants-after-rain.md',
          target_url: '/blog/ghost-ants-kitchen-florida/',
          anchor_text: 'ghost ants in kitchens',
        },
      ]),
    };
    const internalLinkExecutor = {
      runDryRun: jest.fn().mockResolvedValue({
        count: 1,
        results: [{ task_id: 'run_1', status: 'patch_candidate' }],
      }),
    };
    const runner = loadRunnerWith({ queue, briefBuilder, linkPlanner, internalLinkExecutor });

    const result = await runner.runNext();

    expect(result.outcome).toBe('completed_pending_review');
    expect(result.skip_reason).toBe('internal_links_dry_run_shadow');
    expect(result.link_tasks_queued).toBe(1);
    expect(briefBuilder.compose).toHaveBeenCalledWith('opp_links_1', {
      persist: true,
      skipSerp: true,
    });
    expect(linkPlanner.planForTarget).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida/',
      keyword: 'ghost ants kitchen',
    }), expect.objectContaining({ opportunityId: 'opp_links_1' }));
    expect(internalLinkExecutor.runDryRun).toHaveBeenCalledWith({ taskIds: ['run_1'], limit: 1 });
    expect(queue.pendingReview).toHaveBeenCalledWith('opp_links_1', 'internal_links_dry_run_shadow', { claimToken: claimedAt });
    expect(queue.complete).not.toHaveBeenCalled();
    expect(queue.release).not.toHaveBeenCalled();
  });

  test('a dry-run that only hit transient load failures releases the claim for retry', async () => {
    const previousShadow = process.env.SHADOW_MODE_ADD_INTERNAL_LINKS;
    process.env.SHADOW_MODE_ADD_INTERNAL_LINKS = 'false';
    try {
      const claimedAt = new Date('2026-05-23T05:10:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({ id: 'opp_links_transient', action_type: 'add_internal_links', claimed_at: claimedAt }),
        complete: jest.fn(), pendingReview: jest.fn(), skip: jest.fn(),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = { compose: jest.fn().mockResolvedValue({ id: 'b', action_type: 'add_internal_links', page_type: 'internal-link', target_url: '/x/', target_keyword: 'x' }) };
      const linkPlanner = { planForTarget: jest.fn().mockReturnValue([{ source_file: 's.md', target_url: '/x/', anchor_text: 'x' }]) };
      const internalLinkExecutor = {
        runDryRun: jest.fn().mockResolvedValue({ count: 1, results: [{ task_id: 'run_1', status: 'failed', failure_reason: 'GitHub 502' }] }),
        isTransientLoadFailure: (r) => r === 'GitHub 502',
      };
      const runner = loadRunnerWith({ queue, briefBuilder, linkPlanner, internalLinkExecutor });
      const result = await runner.runNext();
      expect(result.outcome).toBe('deferred_gate_retry');
      expect(queue.release).toHaveBeenCalledWith('opp_links_transient', { claimToken: claimedAt });
      expect(queue.skip).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_ADD_INTERNAL_LINKS;
      else process.env.SHADOW_MODE_ADD_INTERNAL_LINKS = previousShadow;
    }
  });

  test('an unshadowed run plans candidates and completes; it never opens or waits on a PR', async () => {
    const previousShadow = process.env.SHADOW_MODE_ADD_INTERNAL_LINKS;
    process.env.SHADOW_MODE_ADD_INTERNAL_LINKS = 'false';
    try {
      const claimedAt = new Date('2026-05-23T05:10:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_links_live_1',
          action_type: 'add_internal_links',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_links_live_1',
          action_type: 'add_internal_links',
          page_type: 'internal-link',
          target_url: 'https://www.wavespestcontrol.com/pest-control-bradenton-fl/',
          target_keyword: 'pest control bradenton fl',
          city: 'Bradenton',
          service: 'pest',
        }),
      };
      const linkPlanner = {
        planForTarget: jest.fn().mockReturnValue([
          {
            source_file: 'src/content/services/pest-control-quote-bradenton-fl.md',
            target_url: '/pest-control-bradenton-fl/',
            anchor_text: 'Bradenton pest control',
          },
        ]),
      };
      const internalLinkExecutor = {
        runDryRun: jest.fn().mockResolvedValue({
          count: 1,
          results: [{ task_id: 'run_1', status: 'patch_candidate' }],
        }),
        runPrBatch: jest.fn().mockResolvedValue({
          status: 'pr_open',
          count: 1,
          pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/88',
        }),
        requeueTransientDryRunFailures: jest.fn(async () => 0),
      };
      const runner = loadRunnerWith({ queue, briefBuilder, linkPlanner, internalLinkExecutor });

      const result = await runner.runNext();

      // Mixed results: transient failures are requeued before completing.
      expect(internalLinkExecutor.requeueTransientDryRunFailures).toHaveBeenCalledWith([{ task_id: 'run_1', status: 'patch_candidate' }]);
      // Shipping is the candidate sweep's job alone (one PR path).
      expect(result.outcome).toBe('completed_planned');
      expect(result.astro_pr_url).toBeUndefined();
      expect(internalLinkExecutor.runDryRun).toHaveBeenCalledWith({ taskIds: ['run_1'], limit: 1 });
      expect(internalLinkExecutor.runPrBatch).not.toHaveBeenCalled();
      expect(queue.complete).toHaveBeenCalledWith('opp_links_live_1', expect.objectContaining({ claimToken: claimedAt }));
      expect(queue.pendingReview).not.toHaveBeenCalled();
      expect(queue.release).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_ADD_INTERNAL_LINKS;
      else process.env.SHADOW_MODE_ADD_INTERNAL_LINKS = previousShadow;
    }
  });
});

describe('runNext general shadow behavior', () => {
  test('parks shadow claims after persisting the run so one opportunity cannot starve the queue', async () => {
    const claimedAt = new Date('2026-05-23T05:05:00Z');
    const queue = {
      claimNext: jest.fn().mockResolvedValue({
        id: 'opp_blog_1',
        action_type: 'new_supporting_blog',
        claimed_at: claimedAt,
      }),
      complete: jest.fn().mockResolvedValue(true),
      pendingReview: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    };
    const briefBuilder = {
      compose: jest.fn().mockResolvedValue({
        id: 'brief_blog_1',
        action_type: 'new_supporting_blog',
        page_type: 'blog',
      }),
    };
    const dispatcher = {
      runWithBrief: jest.fn().mockResolvedValue({
        ok: true,
        draft: { url: '/blog/test-shadow/', title: 'Test Shadow' },
      }),
    };
    const qualityGate = {
      evaluate: jest.fn().mockReturnValue({
        ok: true,
        hard_failures: [],
        soft_failures: [],
        total_score: 100,
        min_total_score: 80,
      }),
    };
    const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, qualityGate });

    const result = await runner.runNext();

    expect(result.outcome).toBe('skipped_shadow_mode');
    expect(result.skip_reason).toBe('shadow_would_gate');
    expect(queue.skip).toHaveBeenCalledWith('opp_blog_1', 'shadow_would_gate', { claimToken: claimedAt });
    expect(queue.complete).not.toHaveBeenCalled();
    expect(queue.release).not.toHaveBeenCalled();
  });
});

describe('runNext post-publish bookkeeping', () => {
  function pageEditLockHarness(lockedRow, { unlockThrows = false, lockFree = true, resetThrows = false } = {}) {
    const events = [];
    const sessionSql = [];
    const conn = {
      query: jest.fn(async (sql) => {
        if (/^(SET|RESET) statement_timeout/.test(sql)) {
          sessionSql.push(sql);
          if (resetThrows && sql.startsWith('RESET')) throw new Error('reset failed');
          return { rows: [] };
        }
        if (sql.includes('unlock')) {
          events.push('unlock');
          if (unlockThrows) throw new Error('connection reset');
          return { rows: [] };
        }
        events.push(lockFree ? 'lock' : 'lock_busy');
        return { rows: [{ locked: lockFree }] };
      }),
    };
    const client = {
      acquireConnection: jest.fn(async () => conn),
      releaseConnection: jest.fn(async () => { events.push('release'); }),
      destroyRawConnection: jest.fn(async () => { events.push('destroy'); }),
    };
    const first = jest.fn(async () => lockedRow);
    const query = jest.fn(() => {
      const q = {
        connection: jest.fn(() => q),
        where: jest.fn(() => q),
        whereNull: jest.fn(() => q),
        first,
      };
      return q;
    });
    return { client, conn, events, first, query, sessionSql };
  }

  // publishRefresh runs only its GitHub write phase under the caller's
  // commitGuard; this stand-in does the same.
  function guardedPublishRefresh(onWrite) {
    return jest.fn(async (_draft, _brief, opts = {}) => {
      if (typeof opts.commitGuard !== 'function') throw new Error('backfill publish arrived without a commitGuard');
      return opts.commitGuard(async () => onWrite());
    });
  }

  test('rechecks citability page ownership before publisher side effects', async () => {
    const write = jest.fn();
    const publisher = { publishRefresh: guardedPublishRefresh(write) };
    const queue = {
      getById: jest.fn().mockResolvedValue({
        id: 'opp_backfill_1',
        bucket: 'citability_backfill',
        status: 'claimed',
        claim_id: 'claim-a',
        signal_metadata: {},
      }),
      _internals: {
        pageEditSuperseded: (row) => Boolean(row?.signal_metadata?.page_edit_superseded),
      },
    };
    const lock = pageEditLockHarness({
      bucket: 'citability_backfill',
      status: 'claimed',
      claim_id: 'claim-a',
      claimed_at: new Date('2026-09-26T13:00:00Z'),
      signal_metadata: { page_edit_superseded: { ordinary_dedupe_key: 'ordinary:1' } },
    });
    const runner = loadRunnerWith({
      queue,
      briefBuilder: {},
      publisher,
      dbQuery: lock.query,
      dbClient: lock.client,
    });

    await expect(runner._publishAndDistribute(
      { body: 'stale draft' },
      { action_type: 'refresh_existing_page' },
      {
        opportunity_id: 'opp_backfill_1',
        queue_claim_id: 'claim-a',
        queue_claimed_at: new Date('2026-09-26T13:00:00Z'),
      },
    )).rejects.toMatchObject({ code: 'PAGE_EDIT_SUPERSEDED' });
    expect(lock.conn.query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', ['opportunity_page_edit']);
    expect(lock.events).toEqual(['lock', 'unlock', 'release']);
    expect(write).not.toHaveBeenCalled();
  });

  test('refuses a recovered stale worker whose original queue claim no longer owns the backfill row', async () => {
    const write = jest.fn();
    const publisher = { publishRefresh: guardedPublishRefresh(write) };
    const queue = {
      getById: jest.fn().mockResolvedValue({
        id: 'opp_backfill_lost', bucket: 'citability_backfill', status: 'skipped', signal_metadata: {},
      }),
      _internals: { pageEditSuperseded: () => false },
    };
    const lock = pageEditLockHarness(null);
    const runner = loadRunnerWith({
      queue,
      briefBuilder: {},
      publisher,
      dbQuery: lock.query,
      dbClient: lock.client,
    });

    await expect(runner._publishAndDistribute(
      { body: 'stale recovered draft' },
      { action_type: 'refresh_existing_page' },
      {
        opportunity_id: 'opp_backfill_lost',
        queue_claim_id: 'claim-old',
        queue_claimed_at: new Date('2026-09-26T12:00:00Z'),
      },
    )).rejects.toMatchObject({ code: 'PAGE_EDIT_OWNERSHIP_LOST' });
    expect(lock.first).toHaveBeenCalledWith('bucket', 'signal_metadata', 'status', 'claim_id', 'claimed_at');
    expect(write).not.toHaveBeenCalled();
  });

  test('holds the session lock through publishing and does not lose a successful publish to unlock failure', async () => {
    const approvalClaimedAt = new Date('2026-09-26T14:00:00Z');
    const lock = pageEditLockHarness({
      bucket: 'citability_backfill', status: 'claimed', claim_id: 'claim-approval',
      claimed_at: approvalClaimedAt, signal_metadata: {},
    }, { unlockThrows: true });
    const publisher = {
      publishRefresh: guardedPublishRefresh(async () => {
        lock.events.push('publish');
        return { status: 'no_changes' };
      }),
    };
    const queue = {
      getById: jest.fn().mockResolvedValue({
        id: 'opp_backfill_approval', bucket: 'citability_backfill', status: 'claimed', signal_metadata: {},
      }),
      _internals: { pageEditSuperseded: () => false },
    };
    const runner = loadRunnerWith({
      queue, briefBuilder: {}, publisher, dbQuery: lock.query, dbClient: lock.client,
    });

    await expect(runner._publishAndDistribute(
      { body: 'approved draft' },
      { action_type: 'refresh_existing_page' },
      {
        opportunity_id: 'opp_backfill_approval',
        queue_claim_id: 'claim-approval',
        queue_claimed_at: approvalClaimedAt,
      },
    )).resolves.toMatchObject({ publish_status: 'no_changes' });
    expect(publisher.publishRefresh).toHaveBeenCalledTimes(1);
    // The write phase's lock, then the no-op ownership recheck's lock.
    expect(lock.events).toEqual(['lock', 'publish', 'unlock', 'destroy', 'release', 'lock', 'unlock', 'destroy', 'release']);
    expect(lock.conn.__knex__disposed).toMatch(/page-edit advisory unlock failed: connection reset/);
    expect(lock.client.releaseConnection).toHaveBeenCalledWith(lock.conn);
    expect(lock.client.destroyRawConnection).toHaveBeenCalledWith(lock.conn);
  });

  test('a backfill row routed to a non-refresh publisher fails closed before any write', async () => {
    const publisher = { publishOrUpdatePage: jest.fn() };
    const queue = {
      getById: jest.fn().mockResolvedValue({
        id: 'opp_backfill_new', bucket: 'citability_backfill', status: 'claimed', signal_metadata: {},
      }),
      _internals: { pageEditSuperseded: () => false },
    };
    const lock = pageEditLockHarness(null);
    const runner = loadRunnerWith({ queue, briefBuilder: {}, publisher, dbQuery: lock.query, dbClient: lock.client });

    await expect(runner._publishAndDistribute(
      { body: 'draft' }, { action_type: 'new_supporting_blog' },
      { opportunity_id: 'opp_backfill_new', queue_claim_id: 'c', queue_claimed_at: new Date('2026-09-28T18:00:00Z') },
    )).rejects.toMatchObject({ code: 'CITABILITY_BACKFILL_NOT_REFRESH' });
    expect(publisher.publishOrUpdatePage).not.toHaveBeenCalled();
    expect(lock.events).toEqual([]);
  });

  describe('page-edit lock bounds', () => {
    const originalEnv = { ...process.env };
    const originalFetch = global.fetch;
    afterEach(() => {
      process.env = { ...originalEnv };
      global.fetch = originalFetch;
    });

    function backfillRun(id) {
      return {
        opportunity_id: id,
        queue_claim_id: 'claim-bound',
        queue_claimed_at: new Date('2026-09-28T18:00:00Z'),
      };
    }

    function backfillQueue(id) {
      return {
        getById: jest.fn().mockResolvedValue({
          id, bucket: 'citability_backfill', status: 'claimed', signal_metadata: {},
        }),
        _internals: { pageEditSuperseded: () => false },
      };
    }

    const lockedRow = {
      bucket: 'citability_backfill', status: 'claimed', claim_id: 'claim-bound',
      claimed_at: new Date('2026-09-28T18:00:00Z'), signal_metadata: {},
    };

    test('gives up waiting for a busy page-edit lock and fails closed without publishing', async () => {
      process.env.CONTENT_PAGE_EDIT_LOCK_ACQUIRE_MS = '0';
      const lock = pageEditLockHarness(lockedRow, { lockFree: false });
      const write = jest.fn();
      const publisher = { publishRefresh: guardedPublishRefresh(write) };
      const runner = loadRunnerWith({
        queue: backfillQueue('opp_lock_busy'), briefBuilder: {}, publisher, dbQuery: lock.query, dbClient: lock.client,
      });

      await expect(runner._publishAndDistribute(
        { body: 'draft' }, { action_type: 'refresh_existing_page' }, backfillRun('opp_lock_busy'),
      )).rejects.toMatchObject({ code: 'PAGE_EDIT_OWNERSHIP_LOST', message: expect.stringMatching(/timed out after 0ms/) });
      expect(write).not.toHaveBeenCalled();
      // Never acquired, so never unlocked; the pooled connection still goes back.
      expect(lock.events).toEqual(['lock_busy', 'release']);
    });

    test('a backfill superseded during unlocked validation is not accepted as a no-op', async () => {
      // publishRefresh returns no_changes without running the write guard;
      // the page was superseded meanwhile.
      const lock = pageEditLockHarness({
        ...lockedRow, signal_metadata: { page_edit_superseded: { ordinary_dedupe_key: 'ordinary:2' } },
      });
      const publisher = { publishRefresh: jest.fn(async () => ({ status: 'no_changes' })) };
      const queue = {
        ...backfillQueue('opp_noop_superseded'),
        _internals: { pageEditSuperseded: (row) => Boolean(row?.signal_metadata?.page_edit_superseded) },
      };
      const runner = loadRunnerWith({ queue, briefBuilder: {}, publisher, dbQuery: lock.query, dbClient: lock.client });

      await expect(runner._publishAndDistribute(
        { body: 'draft' }, { action_type: 'refresh_existing_page' }, backfillRun('opp_noop_superseded'),
      )).rejects.toMatchObject({ code: 'PAGE_EDIT_SUPERSEDED' });
      expect(lock.events).toEqual(['lock', 'unlock', 'release']);
    });

    test('the acquire deadline also bounds a pool checkout that never returns', async () => {
      process.env.CONTENT_PAGE_EDIT_LOCK_ACQUIRE_MS = '20';
      const lock = pageEditLockHarness(lockedRow);
      let deliver;
      lock.client.acquireConnection = jest.fn(() => new Promise((resolve) => { deliver = resolve; }));
      const write = jest.fn();
      const runner = loadRunnerWith({
        queue: backfillQueue('opp_pool'), briefBuilder: {}, publisher: { publishRefresh: guardedPublishRefresh(write) },
        dbQuery: lock.query, dbClient: lock.client,
      });

      await expect(runner._publishAndDistribute(
        { body: 'draft' }, { action_type: 'refresh_existing_page' }, backfillRun('opp_pool'),
      )).rejects.toMatchObject({ code: 'PAGE_EDIT_OWNERSHIP_LOST', message: expect.stringMatching(/database connection/) });
      expect(write).not.toHaveBeenCalled();
      // A checkout that arrives late goes straight back to the pool.
      deliver(lock.conn);
      await new Promise((r) => setImmediate(r));
      expect(lock.client.releaseConnection).toHaveBeenCalledWith(lock.conn);
      expect(lock.conn.query).not.toHaveBeenCalled();
    });

    test('bounds every statement on the lock session and resets it before the pool gets it back', async () => {
      const lock = pageEditLockHarness(lockedRow);
      const runner = loadRunnerWith({
        queue: backfillQueue('opp_stmt'), briefBuilder: {},
        publisher: { publishRefresh: guardedPublishRefresh(async () => ({ status: 'pr_open', pr_url: 'u', url: 'x' })) },
        dbQuery: lock.query, dbClient: lock.client,
      });

      await runner._publishAndDistribute(
        { body: 'draft' }, { action_type: 'refresh_existing_page' }, backfillRun('opp_stmt'),
      ).catch(() => {});
      expect(lock.sessionSql).toEqual(['SET statement_timeout = 30000', 'RESET statement_timeout']);
      expect(lock.conn.query.mock.calls[0][0]).toBe('SET statement_timeout = 30000');
      expect(lock.client.destroyRawConnection).not.toHaveBeenCalled();
    });

    test('a session whose statement timeout cannot be reset is destroyed, not pooled', async () => {
      const lock = pageEditLockHarness(lockedRow, { resetThrows: true });
      const runner = loadRunnerWith({
        queue: backfillQueue('opp_reset'), briefBuilder: {},
        publisher: { publishRefresh: guardedPublishRefresh(async () => ({ status: 'pr_open', pr_url: 'u', url: 'x' })) },
        dbQuery: lock.query, dbClient: lock.client,
      });

      await runner._publishAndDistribute(
        { body: 'draft' }, { action_type: 'refresh_existing_page' }, backfillRun('opp_reset'),
      ).catch(() => {});
      expect(lock.client.destroyRawConnection).toHaveBeenCalledWith(lock.conn);
      expect(lock.conn.__knex__disposed).toMatch(/reset failed/);
    });

    test('a session that stalls configuring its statement timeout is destroyed, not pooled', async () => {
      process.env.CONTENT_PAGE_EDIT_LOCK_ACQUIRE_MS = '20';
      const lock = pageEditLockHarness(lockedRow);
      lock.conn.query.mockImplementationOnce(() => new Promise(() => {}));
      const write = jest.fn();
      const runner = loadRunnerWith({
        queue: backfillQueue('opp_set_stall'), briefBuilder: {}, publisher: { publishRefresh: guardedPublishRefresh(write) },
        dbQuery: lock.query, dbClient: lock.client,
      });

      await expect(runner._publishAndDistribute(
        { body: 'draft' }, { action_type: 'refresh_existing_page' }, backfillRun('opp_set_stall'),
      )).rejects.toMatchObject({ code: 'PAGE_EDIT_OWNERSHIP_LOST', message: expect.stringMatching(/configuring the page-edit lock session/) });
      expect(write).not.toHaveBeenCalled();
      expect(lock.client.destroyRawConnection).toHaveBeenCalledWith(lock.conn);
    });

    test('a GitHub call that outlives the hold deadline fails and the lock is still released', async () => {
      process.env.CONTENT_PAGE_EDIT_LOCK_HOLD_MS = '30';
      process.env.GITHUB_TOKEN = 'test-token';
      global.fetch = jest.fn((url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      }));
      const lock = pageEditLockHarness(lockedRow);
      let gh = null;
      const publisher = {
        publishRefresh: guardedPublishRefresh(async () => {
          lock.events.push('publish');
          await gh.getFile('src/content/blog/x.mdx');
          return { status: 'no_changes' };
        }),
      };
      const runner = loadRunnerWith({
        queue: backfillQueue('opp_hold'), briefBuilder: {}, publisher, dbQuery: lock.query, dbClient: lock.client,
      });
      // loadRunnerWith resets the module registry; take the same client
      // instance the runner's lazy require will resolve.
      gh = require('../services/content-astro/github-client');

      await expect(runner._publishAndDistribute(
        { body: 'draft' }, { action_type: 'refresh_existing_page' }, backfillRun('opp_hold'),
      )).rejects.toMatchObject({ code: 'GITHUB_REQUEST_DEADLINE_EXCEEDED' });
      expect(global.fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: expect.any(Object) }));
      expect(lock.events).toEqual(['lock', 'publish', 'unlock', 'release']);
    });
  });

  // These tests exercise publish/queue bookkeeping, not blog dedup. Blog
  // uniqueness now defaults ON (and requires a loaded corpus), so disable it
  // here to isolate the bookkeeping paths; dedup has its own coverage.
  let prevBlogUniqueness;
  beforeEach(() => {
    prevBlogUniqueness = process.env.AUTONOMOUS_CONTENT_BLOG_UNIQUENESS;
    process.env.AUTONOMOUS_CONTENT_BLOG_UNIQUENESS = 'false';
  });
  afterEach(() => {
    if (prevBlogUniqueness === undefined) delete process.env.AUTONOMOUS_CONTENT_BLOG_UNIQUENESS;
    else process.env.AUTONOMOUS_CONTENT_BLOG_UNIQUENESS = prevBlogUniqueness;
  });

  test('fails closed when SEO completion gate is unavailable for supporting blogs', async () => {
    const previousShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const previousThreshold = process.env.TRUST_BUILD_THRESHOLD;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';

    try {
      const claimedAt = new Date('2026-05-23T05:08:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_seo_unavailable',
          action_type: 'new_supporting_blog',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_seo_unavailable',
          action_type: 'new_supporting_blog',
          page_type: 'supporting-blog',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: { url: '/blog/seo-unavailable/', title: 'SEO Unavailable' },
        }),
      };
      const qualityGate = {
        evaluate: jest.fn().mockReturnValue({
          ok: true,
          hard_failures: [],
          soft_failures: [],
          total_score: 100,
          min_total_score: 80,
        }),
      };
      const publisher = { publishOrUpdatePage: jest.fn() };
      const runner = loadRunnerWith({
        queue,
        briefBuilder,
        dispatcher,
        qualityGate,
        seoCompletionGate: {},
        publisher,
      });

      const result = await runner.runNext();

      expect(result.outcome).toBe('skipped_gate_fail');
      expect(result.skip_reason).toBe('gate_infrastructure_error');
      expect(result.quality_gate_result.seo_completion).toMatchObject({
        passed: false,
        summary: { p0: 1 },
      });
      expect(publisher.publishOrUpdatePage).not.toHaveBeenCalled();
      expect(queue.skip).toHaveBeenCalledWith('opp_seo_unavailable', 'gate_infrastructure_error', { claimToken: claimedAt });
      expect(queue.pendingReview).not.toHaveBeenCalled();
      expect(queue.release).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
      else process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = previousShadow;
      if (previousThreshold === undefined) delete process.env.TRUST_BUILD_THRESHOLD;
      else process.env.TRUST_BUILD_THRESHOLD = previousThreshold;
    }
  });

  test('fails closed when SEO completion gate skips a runner-required supporting blog', async () => {
    const previousShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const previousThreshold = process.env.TRUST_BUILD_THRESHOLD;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';

    try {
      const claimedAt = new Date('2026-05-23T05:08:30Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_seo_skipped',
          action_type: 'new_supporting_blog',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_seo_skipped',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: { url: '/blog/seo-skipped/', title: 'SEO Skipped' },
        }),
      };
      const qualityGate = {
        evaluate: jest.fn().mockReturnValue({
          ok: true,
          hard_failures: [],
          soft_failures: [],
          total_score: 100,
          min_total_score: 80,
        }),
      };
      const seoCompletionGate = {
        evaluate: jest.fn().mockReturnValue({
          passed: true,
          skipped: 'not_supporting_blog',
          findings: [],
          summary: { p0: 0, p1: 0, p2: 0 },
        }),
      };
      const publisher = { publishOrUpdatePage: jest.fn() };
      const runner = loadRunnerWith({
        queue,
        briefBuilder,
        dispatcher,
        qualityGate,
        seoCompletionGate,
        publisher,
      });

      const result = await runner.runNext();

      expect(result.outcome).toBe('skipped_gate_fail');
      expect(result.skip_reason).toBe('gate_infrastructure_error');
      expect(result.quality_gate_result.seo_completion).toMatchObject({
        passed: false,
        error: 'seo_completion_gate_skipped_required',
        summary: { p0: 1 },
      });
      expect(result.quality_gate_result.seo_completion.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'P0_SEO_COMPLETION_GATE_SKIPPED' }),
      ]));
      expect(seoCompletionGate.evaluate).toHaveBeenCalledWith(expect.objectContaining({
        actionType: 'new_supporting_blog',
        pageType: 'supporting-blog',
      }));
      expect(publisher.publishOrUpdatePage).not.toHaveBeenCalled();
      expect(queue.skip).toHaveBeenCalledWith('opp_seo_skipped', 'gate_infrastructure_error', { claimToken: claimedAt });
      expect(queue.pendingReview).not.toHaveBeenCalled();
      expect(queue.release).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
      else process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = previousShadow;
      if (previousThreshold === undefined) delete process.env.TRUST_BUILD_THRESHOLD;
      else process.env.TRUST_BUILD_THRESHOLD = previousThreshold;
    }
  });

  test('summarizes SEO completion gate exceptions as P0 reviewer findings', async () => {
    const previousShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const previousThreshold = process.env.TRUST_BUILD_THRESHOLD;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';

    try {
      const claimedAt = new Date('2026-05-23T05:09:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_seo_throw',
          action_type: 'new_supporting_blog',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_seo_throw',
          action_type: 'new_supporting_blog',
          page_type: 'supporting-blog',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: { url: '/blog/seo-throw/', title: 'SEO Throw' },
        }),
      };
      const qualityGate = {
        evaluate: jest.fn().mockReturnValue({
          ok: true,
          hard_failures: [],
          soft_failures: [],
          total_score: 100,
          min_total_score: 80,
        }),
      };
      const runner = loadRunnerWith({
        queue,
        briefBuilder,
        dispatcher,
        qualityGate,
        seoCompletionGate: { evaluate: jest.fn(() => { throw new Error('parser failed'); }) },
        publisher: { publishOrUpdatePage: jest.fn() },
      });

      const result = await runner.runNext();

      expect(result.outcome).toBe('skipped_gate_fail');
      expect(result.skip_reason).toBe('gate_infrastructure_error');
      expect(result.quality_gate_result.seo_completion).toMatchObject({
        passed: false,
        summary: { p0: 1 },
      });
      expect(result.reviewer_notes).toContain('seo_completion: P0=1');
      expect(queue.skip).toHaveBeenCalledWith('opp_seo_throw', 'gate_infrastructure_error', { claimToken: claimedAt });
      expect(queue.pendingReview).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
      else process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = previousShadow;
      if (previousThreshold === undefined) delete process.env.TRUST_BUILD_THRESHOLD;
      else process.env.TRUST_BUILD_THRESHOLD = previousThreshold;
    }
  });

  test('does not release a claim after publish succeeds but queue completion fails', async () => {
    const previousShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const previousThreshold = process.env.TRUST_BUILD_THRESHOLD;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';

    try {
      const claimedAt = new Date('2026-05-23T05:10:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_publish_1',
          action_type: 'new_supporting_blog',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(false),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_publish_1',
          action_type: 'new_supporting_blog',
          page_type: 'blog',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: { url: '/blog/live-test/', title: 'Live Test' },
        }),
      };
      const uniquenessGate = {
        evaluate: jest.fn().mockReturnValue({ ok: true, failed_reasons: [] }),
      };
      const qualityGate = {
        evaluate: jest.fn().mockReturnValue({
          ok: true,
          hard_failures: [],
          soft_failures: [],
          total_score: 100,
          min_total_score: 80,
        }),
      };
      const publisher = {
        publishOrUpdatePage: jest.fn().mockResolvedValue({
          url: '/blog/live-test/',
          status: 'live',
          live: true,
          pr_url: 'https://github.com/wavespestcontrolfl/astro/pull/123',
        }),
      };
      const runner = loadRunnerWith({
        queue,
        briefBuilder,
        dispatcher,
        uniquenessGate,
        qualityGate,
        publisher,
        indexNow: { submit: jest.fn().mockResolvedValue({ ok: true, status: 'ok' }) },
        linkPlanner: {},
      });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_published');
      expect(publisher.publishOrUpdatePage).toHaveBeenCalled();
      expect(queue.complete).toHaveBeenCalledWith('opp_publish_1', {
        notes: 'published:/blog/live-test/',
        claimToken: claimedAt,
      });
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_publish_1', 'published_queue_complete_failed', { claimToken: claimedAt });
      expect(queue.release).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
      else process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = previousShadow;
      if (previousThreshold === undefined) delete process.env.TRUST_BUILD_THRESHOLD;
      else process.env.TRUST_BUILD_THRESHOLD = previousThreshold;
    }
  });

  test('completes a no_changes publish as a no-op (no PR, no published_url, not tracked) instead of parking it', async () => {
    const previousShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const previousThreshold = process.env.TRUST_BUILD_THRESHOLD;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';

    try {
      const claimedAt = new Date('2026-05-23T05:30:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({ id: 'opp_noop_1', action_type: 'new_supporting_blog', claimed_at: claimedAt }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({ id: 'brief_noop_1', action_type: 'new_supporting_blog', page_type: 'blog', human_review_required: false }),
      };
      const dispatcher = { runWithBrief: jest.fn().mockResolvedValue({ ok: true, draft: { url: '/blog/noop/', title: 'No-op' } }) };
      const uniquenessGate = { evaluate: jest.fn().mockReturnValue({ ok: true, failed_reasons: [] }) };
      const qualityGate = { evaluate: jest.fn().mockReturnValue({ ok: true, hard_failures: [], soft_failures: [], total_score: 100, min_total_score: 80 }) };
      const publisher = {
        publishOrUpdatePage: jest.fn().mockResolvedValue({ url: '/blog/noop/', status: 'no_changes', live: false }),
      };
      const indexNow = { submit: jest.fn().mockResolvedValue({ ok: true, status: 'ok' }) };
      const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, uniquenessGate, qualityGate, publisher, indexNow, linkPlanner: {} });

      const result = await runner.runNext();

      // Distinct no-op outcome with NO published_url → impact sweep
      // (whereNotNull('published_url')) and trust-build counting both skip it.
      expect(result.outcome).toBe('completed_no_changes');
      expect(result.published_url == null).toBe(true);
      expect(queue.complete).toHaveBeenCalledWith('opp_noop_1', { notes: 'no_changes', claimToken: claimedAt });
      expect(queue.pendingReview).not.toHaveBeenCalled();
      // No real change → no distribution.
      expect(indexNow.submit).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
      else process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = previousShadow;
      if (previousThreshold === undefined) delete process.env.TRUST_BUILD_THRESHOLD;
      else process.env.TRUST_BUILD_THRESHOLD = previousThreshold;
    }
  });

  test('parks opened Astro PRs for review instead of treating them as live published pages', async () => {
    const previousShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const previousThreshold = process.env.TRUST_BUILD_THRESHOLD;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';

    try {
      const claimedAt = new Date('2026-05-23T05:20:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_pr_1',
          action_type: 'new_supporting_blog',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_pr_1',
          action_type: 'new_supporting_blog',
          page_type: 'blog',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: { url: '/blog/pr-test/', title: 'PR Test' },
        }),
      };
      const uniquenessGate = {
        evaluate: jest.fn().mockReturnValue({ ok: true, failed_reasons: [] }),
      };
      const qualityGate = {
        evaluate: jest.fn().mockReturnValue({
          ok: true,
          hard_failures: [],
          soft_failures: [],
          total_score: 100,
          min_total_score: 80,
        }),
      };
      const indexNow = { submit: jest.fn().mockResolvedValue({ ok: true, status: 'ok' }) };
      const publisher = {
        publishOrUpdatePage: jest.fn().mockResolvedValue({
          url: '/blog/pr-test/',
          status: 'pr_open',
          live: false,
          pr_url: 'https://github.com/wavespestcontrolfl/astro/pull/124',
        }),
      };
      const runner = loadRunnerWith({
        queue,
        briefBuilder,
        dispatcher,
        uniquenessGate,
        qualityGate,
        publisher,
        indexNow,
        linkPlanner: {},
      });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('astro_pr_pending_merge');
      expect(result.published_url).toBeNull();
      expect(result.astro_pr_url).toBe('https://github.com/wavespestcontrolfl/astro/pull/124');
      expect(indexNow.submit).not.toHaveBeenCalled();
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_pr_1', 'astro_pr_pending_merge', { claimToken: claimedAt });
      expect(queue.complete).not.toHaveBeenCalled();
      expect(queue.release).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
      else process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = previousShadow;
      if (previousThreshold === undefined) delete process.env.TRUST_BUILD_THRESHOLD;
      else process.env.TRUST_BUILD_THRESHOLD = previousThreshold;
    }
  });

  test('parks an unreconciled timed-out refresh write for a person instead of retrying into a duplicate PR', async () => {
    const previousShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const previousThreshold = process.env.TRUST_BUILD_THRESHOLD;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';
    try {
      const claimedAt = new Date('2026-09-28T19:00:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({ id: 'opp_unreconciled_1', action_type: 'new_supporting_blog', claimed_at: claimedAt }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_unreconciled_1', action_type: 'new_supporting_blog', page_type: 'blog', human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({ ok: true, draft: { url: '/blog/x/', title: 'X' } }),
      };
      const qualityGate = {
        evaluate: jest.fn().mockReturnValue({ ok: true, hard_failures: [], soft_failures: [], total_score: 100, min_total_score: 80 }),
      };
      const err = new Error('refresh write to content/refresh-x-abc timed out and the PR lookup failed (503)');
      err.code = 'REFRESH_PUBLISH_UNRECONCILED';
      const publisher = { publishOrUpdatePage: jest.fn().mockRejectedValue(err) };
      const runner = loadRunnerWith({
        queue, briefBuilder, dispatcher, qualityGate, publisher, indexNow: { submit: jest.fn() }, linkPlanner: {},
      });

      const result = await runner.runNext();

      // finalize() reports new-blog pending reviews as skips (exceptions-only
      // lane); the queue row itself must still be PARKED, never skipped or
      // released, because a PR may exist.
      expect(result.skip_reason).toBe('refresh_publish_unreconciled');
      expect(result.reviewer_notes).toMatch(/Close any PR on that branch and delete the branch, then dismiss/);
      expect(queue.skip).not.toHaveBeenCalled();
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_unreconciled_1', 'refresh_publish_unreconciled', { claimToken: claimedAt });
      expect(queue.release).not.toHaveBeenCalled();
      expect(queue.complete).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
      else process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = previousShadow;
      if (previousThreshold === undefined) delete process.env.TRUST_BUILD_THRESHOLD;
      else process.env.TRUST_BUILD_THRESHOLD = previousThreshold;
    }
  });

  test('still parks an unreconciled refresh write when its audit record cannot be written', async () => {
    const previousShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const previousThreshold = process.env.TRUST_BUILD_THRESHOLD;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';
    try {
      const claimedAt = new Date('2026-09-28T19:30:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({ id: 'opp_unreconciled_2', action_type: 'new_supporting_blog', claimed_at: claimedAt }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_unreconciled_2', action_type: 'new_supporting_blog', page_type: 'blog', human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({ ok: true, draft: { url: '/blog/y/', title: 'Y' } }),
      };
      const qualityGate = {
        evaluate: jest.fn().mockReturnValue({ ok: true, hard_failures: [], soft_failures: [], total_score: 100, min_total_score: 80 }),
      };
      const err = new Error('refresh write to content/refresh-y-def timed out and the branch could not be deleted (500)');
      err.code = 'REFRESH_PUBLISH_UNRECONCILED';
      const publisher = { publishOrUpdatePage: jest.fn().mockRejectedValue(err) };
      const auditRejected = new Error('audit insert rejected');
      const dbQuery = () => {
        const returning = jest.fn().mockRejectedValue(auditRejected);
        return { insert: jest.fn(() => ({ returning, onConflict: () => ({ ignore: () => ({ returning }) }) })) };
      };
      const runner = loadRunnerWith({
        queue, briefBuilder, dispatcher, qualityGate, publisher, indexNow: { submit: jest.fn() }, linkPlanner: {}, dbQuery,
      });

      await expect(runner.runNext()).rejects.toBe(auditRejected);
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_unreconciled_2', 'refresh_publish_unreconciled', { claimToken: claimedAt });
      expect(queue.release).not.toHaveBeenCalled();
      expect(queue.skip).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
      else process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = previousShadow;
      if (previousThreshold === undefined) delete process.env.TRUST_BUILD_THRESHOLD;
      else process.env.TRUST_BUILD_THRESHOLD = previousThreshold;
    }
  });

  test('parks deterministic publish validation failures instead of retrying the same opportunity', async () => {
    const previousShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const previousThreshold = process.env.TRUST_BUILD_THRESHOLD;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';

    try {
      const claimedAt = new Date('2026-05-23T05:30:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_invalid_1',
          action_type: 'new_supporting_blog',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_invalid_1',
          action_type: 'new_supporting_blog',
          page_type: 'blog',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: { url: '/blog/invalid/', title: 'Invalid Draft' },
        }),
      };
      const qualityGate = {
        evaluate: jest.fn().mockReturnValue({
          ok: true,
          hard_failures: [],
          soft_failures: [],
          total_score: 100,
          min_total_score: 80,
        }),
      };
      const err = new Error('Astro frontmatter validation failed: title is required');
      err.code = 'BLOG_FRONTMATTER_INVALID';
      const publisher = {
        publishOrUpdatePage: jest.fn().mockRejectedValue(err),
      };
      const runner = loadRunnerWith({
        queue,
        briefBuilder,
        dispatcher,
        qualityGate,
        publisher,
        indexNow: { submit: jest.fn() },
        linkPlanner: {},
      });

      const result = await runner.runNext();

      expect(result.outcome).toBe('skipped');
      expect(result.skip_reason).toBe('publish_validation_failed');
      expect(result.failure_message).toBe(err.message);
      expect(publisher.publishOrUpdatePage).toHaveBeenCalled();
      expect(queue.skip).toHaveBeenCalledWith('opp_invalid_1', 'publish_validation_failed', { claimToken: claimedAt });
      expect(queue.release).not.toHaveBeenCalled();
      expect(queue.complete).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
      else process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = previousShadow;
      if (previousThreshold === undefined) delete process.env.TRUST_BUILD_THRESHOLD;
      else process.env.TRUST_BUILD_THRESHOLD = previousThreshold;
    }
  });

  // Operator slug pin: drift is repaired and the pipeline CONTINUES to the
  // publisher (the pinned slug is authoritative); only an unrepairable pin
  // (invalid slug) keeps the old operator_slug_mismatch park.
  function operatorPinScenario({ pinnedSlug, draftSlug, publisher }) {
    const claimedAt = new Date('2026-08-06T05:30:00Z');
    const queue = {
      claimNext: jest.fn().mockResolvedValue({
        id: 'opp_pin_1',
        action_type: 'new_supporting_blog',
        bucket: 'operator_intercept',
        claimed_at: claimedAt,
      }),
      complete: jest.fn().mockResolvedValue(true),
      pendingReview: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    };
    const briefBuilder = {
      compose: jest.fn().mockResolvedValue({
        id: 'brief_pin_1',
        action_type: 'new_supporting_blog',
        page_type: 'supporting-blog',
        human_review_required: false,
        voice_constraints: { operator_brief: { slug: pinnedSlug } },
      }),
    };
    const dispatcher = {
      runWithBrief: jest.fn().mockResolvedValue({
        ok: true,
        draft: {
          type: 'draft',
          url: `${draftSlug}`,
          title: 'Fall Lawn Mistakes in Southwest Florida',
          frontmatter: {
            slug: draftSlug,
            canonical: `https://www.wavespestcontrol.com${draftSlug}`,
            title: 'Fall Lawn Mistakes in Southwest Florida',
          },
          body: `Guidance for SWFL lawns. See [this post](${draftSlug}) for the checklist.`,
        },
      }),
    };
    const qualityGate = {
      evaluate: jest.fn().mockReturnValue({
        ok: true, hard_failures: [], soft_failures: [], total_score: 100, min_total_score: 80,
      }),
    };
    const runner = loadRunnerWith({
      queue,
      briefBuilder,
      dispatcher,
      qualityGate,
      publisher,
      indexNow: { submit: jest.fn() },
      linkPlanner: {},
      // Gate mocks pass so the test isolates the slug-repair step: the repair
      // runs BEFORE these gates, so they see the repaired draft.
      contentGuardrails: { evaluate: jest.fn().mockReturnValue({ pass: true, findings: [] }) },
      comparisonTableGate: { evaluate: jest.fn().mockReturnValue({ pass: true, findings: [], requiresHumanReview: false }) },
    });
    return { runner, queue, claimedAt };
  }

  test('operator slug drift is repaired and the run continues to publish with the pinned slug (repair recorded)', async () => {
    const previousShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const previousThreshold = process.env.TRUST_BUILD_THRESHOLD;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';

    try {
      const publisher = {
        publishOrUpdatePage: jest.fn().mockResolvedValue({
          url: 'https://www.wavespestcontrol.com/lawn-care/fall-lawn-mistakes-swfl/',
          status: 'pr_open',
          live: false,
          pr_url: 'https://github.com/wavespestcontrolfl/astro/pull/900',
        }),
      };
      const { runner, queue, claimedAt } = operatorPinScenario({
        pinnedSlug: '/lawn-care/fall-lawn-mistakes-swfl/',
        draftSlug: '/fall-lawn-mistakes-southwest-florida/',
        publisher,
      });

      const result = await runner.runNext();

      // NOT parked on the old operator_slug_mismatch remedy — the pipeline
      // ran through to the publisher.
      expect(result.skip_reason).not.toBe('operator_slug_mismatch');
      expect(publisher.publishOrUpdatePage).toHaveBeenCalledTimes(1);
      const publishedDraft = publisher.publishOrUpdatePage.mock.calls[0][0];
      expect(publishedDraft.frontmatter.slug).toBe('/lawn-care/fall-lawn-mistakes-swfl/');
      expect(publishedDraft.frontmatter.canonical).toBe('https://www.wavespestcontrol.com/lawn-care/fall-lawn-mistakes-swfl/');
      expect(publishedDraft.body).toContain('(/lawn-care/fall-lawn-mistakes-swfl/)');
      expect(publishedDraft.body).not.toContain('/fall-lawn-mistakes-southwest-florida/');
      // Repair recorded on the persisted draft payload.
      expect(publishedDraft.operator_slug_repair).toMatchObject({
        from_slug: '/fall-lawn-mistakes-southwest-florida/',
        to_slug: '/lawn-care/fall-lawn-mistakes-swfl/',
        canonical_rewritten: true,
        body_self_link_rewrites: 1,
      });
      expect(result.draft_payload.operator_slug_repair).toMatchObject({
        to_slug: '/lawn-care/fall-lawn-mistakes-swfl/',
      });
      // PR-open publish → the usual pending-merge park, claim NOT released.
      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('astro_pr_pending_merge');
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_pin_1', 'astro_pr_pending_merge', { claimToken: claimedAt });
      expect(queue.release).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
      else process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = previousShadow;
      if (previousThreshold === undefined) delete process.env.TRUST_BUILD_THRESHOLD;
      else process.env.TRUST_BUILD_THRESHOLD = previousThreshold;
    }
  });

  test('an INVALID pinned slug still parks as operator_slug_mismatch (repair cannot be made safe)', async () => {
    const previousShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const previousThreshold = process.env.TRUST_BUILD_THRESHOLD;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';

    try {
      const publisher = { publishOrUpdatePage: jest.fn() };
      const { runner, queue, claimedAt } = operatorPinScenario({
        pinnedSlug: '/Fall Lawn Mistakes!!/',
        draftSlug: '/fall-lawn-mistakes-southwest-florida/',
        publisher,
      });

      const result = await runner.runNext();

      expect(result.outcome).toBe('skipped');
      expect(result.skip_reason).toBe('operator_slug_mismatch');
      expect(result.reviewer_notes).toMatch(/not auto-repairable/);
      expect(publisher.publishOrUpdatePage).not.toHaveBeenCalled();
      expect(queue.skip).toHaveBeenCalledWith('opp_pin_1', 'operator_slug_mismatch', { claimToken: claimedAt });
      expect(queue.release).not.toHaveBeenCalled();
      expect(queue.complete).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
      else process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = previousShadow;
      if (previousThreshold === undefined) delete process.env.TRUST_BUILD_THRESHOLD;
      else process.env.TRUST_BUILD_THRESHOLD = previousThreshold;
    }
  });
});

// Named-competitor autopublish (owner directive 2026-08-26): a draft whose
// comparison gate PASSES but names operator-authorized/curated competitors
// (requiresHumanReview) parks at named_competitor_review by default; with
// GATE_NAMED_COMPETITOR_AUTOPUBLISH=true it continues down the normal
// publish path (astro PR → Codex-gated auto-merge) instead. Comparison-gate
// FAILURES are unaffected either way.
describe('named-competitor autopublish gate', () => {
  // A neutral slug: the publisher's final-text comparison gate scans the
  // slug too, and "taexx" in it would name HomeTeam.
  const SLUG = '/pest-control/in-wall-system-comparison/';

  function namedCompetitorScenario({ publisher, comparisonGate, intercept = true, contentGuardrails = null, body = null, operatorBrief = null, slug = SLUG, signalMetadata = undefined, frontmatterExtra = {} }) {
    const claimedAt = new Date('2026-08-26T05:30:00Z');
    const queue = {
      claimNext: jest.fn().mockResolvedValue({
        id: 'opp_named_1',
        action_type: 'new_supporting_blog',
        bucket: 'operator_intercept',
        claimed_at: claimedAt,
        ...(signalMetadata ? { signal_metadata: signalMetadata } : {}),
      }),
      complete: jest.fn().mockResolvedValue(true),
      pendingReview: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
      skip: jest.fn().mockResolvedValue(true),
      defer: jest.fn().mockResolvedValue(true),
    };
    const briefBuilder = {
      compose: jest.fn().mockResolvedValue({
        id: 'brief_named_1',
        action_type: 'new_supporting_blog',
        page_type: 'supporting-blog',
        human_review_required: false,
        // Category/spoke seeds share the bucket and operator_brief payload —
        // only gsc_signal.intercept marks a TRUE competitor intercept, and
        // that marker is the autopublish provenance predicate. No slug pin:
        // the pin path has its own coverage above.
        gsc_signal: { bucket: 'operator_intercept', intercept },
        voice_constraints: {
          operator_brief: operatorBrief || {
            working_title: 'In-Wall Systems Compared for SWFL Homes',
            primary_kw: 'taexx system review',
            thesis: 'Compare in-wall systems for SWFL homes.',
          },
        },
      }),
    };
    const dispatcher = {
      runWithBrief: jest.fn().mockResolvedValue({
        ok: true,
        draft: {
          type: 'draft',
          url: slug,
          title: 'In-Wall Systems Compared for SWFL Homes',
          frontmatter: {
            slug,
            canonical: `https://www.wavespestcontrol.com${slug}`,
            title: 'In-Wall Systems Compared for SWFL Homes',
            ...frontmatterExtra,
          },
          body: body || 'A sourced comparison of in-wall pest systems for Southwest Florida homes.',
        },
      }),
    };
    const qualityGate = {
      evaluate: jest.fn().mockReturnValue({
        ok: true, hard_failures: [], soft_failures: [], total_score: 100, min_total_score: 80,
      }),
    };
    const runner = loadRunnerWith({
      queue,
      briefBuilder,
      dispatcher,
      qualityGate,
      publisher,
      indexNow: { submit: jest.fn() },
      linkPlanner: {},
      contentGuardrails: contentGuardrails || { evaluate: jest.fn().mockReturnValue({ pass: true, findings: [] }) },
      // Default: the gate PASSES but flags the named-competitor human-review
      // signal — the exact shape a validated curated-competitor table
      // produces. Tests may override with a failing gate. The REAL shared
      // eligibility predicate rides along — the runner reads it from this
      // same module (comparison-table-gate owns it).
      comparisonTableGate: {
        namedCompetitorAutopublishEligible: jest.requireActual('../services/content/comparison-table-gate').namedCompetitorAutopublishEligible,
        namedCompetitorListVerdict: jest.requireActual('../services/content/comparison-table-gate').namedCompetitorListVerdict,
        ...(comparisonGate
          || { evaluate: jest.fn().mockReturnValue({ pass: true, findings: [], requiresHumanReview: true, namedCompetitors: ['Orkin'] }) }),
      },
    });
    return { runner, queue, claimedAt };
  }

  const ENV_KEYS = ['SHADOW_MODE_NEW_SUPPORTING_BLOG', 'TRUST_BUILD_THRESHOLD', 'GATE_NAMED_COMPETITOR_AUTOPUBLISH', 'AUTONOMOUS_CONTENT_BLOG_UNIQUENESS'];
  let previousEnv;
  beforeEach(() => {
    previousEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';
    // Blog-dedup corpus isn't loadable under this harness's db mock; the
    // uniqueness lane has its own coverage above.
    process.env.AUTONOMOUS_CONTENT_BLOG_UNIQUENESS = 'false';
  });
  afterEach(async () => {
    // Drain the runner's setImmediate-scheduled notification before Jest
    // tears the environment down (hook r12 P1).
    await new Promise((resolve) => { setImmediate(resolve); });
    for (const k of ENV_KEYS) {
      if (previousEnv[k] === undefined) delete process.env[k];
      else process.env[k] = previousEnv[k];
    }
  });

  test('explicit competitor kill switch skips without asking for approval', async () => {
    process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH = 'false';
    const publisher = { publishOrUpdatePage: jest.fn() };
    const { runner, queue } = namedCompetitorScenario({ publisher });
    const result = await runner.runNext();
    expect(result).toMatchObject({ outcome: 'skipped', skip_reason: 'named_competitor_disabled' });
    expect(publisher.publishOrUpdatePage).not.toHaveBeenCalled();
    expect(queue.pendingReview).not.toHaveBeenCalled();
    expect(queue.skip).toHaveBeenCalled();
  });

  // Owner rulings 2026-09-27 (D2) + 2026-09-28: unattended only when every
  // named competitor is on the owner list. These
  // run the REAL comparison gate over synthetic drafts, with the names
  // authorized by the (synthetic) operator brief.
  describe('owner-approved competitor list (real comparison gate)', () => {
    const realGate = jest.requireActual('../services/content/comparison-table-gate');
    const prPublisher = (n) => ({ publishOrUpdatePage: jest.fn().mockResolvedValue({
      url: `https://www.wavespestcontrol.com${SLUG}`, status: 'pr_open', live: false,
      pr_url: `https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/${n}`,
    }) });
    // The publisher's commit chokepoint, run for REAL
    // (business-name-confirmer assertOwnerListForCommit) with only the
    // model call stubbed: `companiesFor(draft)` is what the model lists.
    const chokepointPublisher = (n, companiesFor = () => []) => ({ publishOrUpdatePage: jest.fn(async (draft, briefArg, opts) => {
      const confirmer = jest.requireActual('../services/content/business-name-confirmer');
      const facts = jest.requireActual('../services/content/competitor-facts');
      const spy = jest.spyOn(confirmer, 'extractCompanyNames').mockImplementation(async (finalDraft) => ({
        ok: true, key: 'k', companies: companiesFor(finalDraft).map((c) => facts.findCompetitor(c)?.name || c),
      }));
      try {
        await confirmer.assertOwnerListForCommit({ draft, brief: briefArg, frontmatter: draft.frontmatter, body: draft.body, humanApproved: opts?.humanApproved });
      } finally { spy.mockRestore(); }
      return { url: `https://www.wavespestcontrol.com${SLUG}`, status: 'pr_open', live: false, pr_url: `https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/${n}` };
    }) });
    const refusingPublisher = (err) => ({ publishOrUpdatePage: jest.fn().mockRejectedValue(Object.assign(new Error(err.message || 'refused'), err)) });
    const brief = (names) => ({
      working_title: `${names} alternatives in Sarasota`,
      primary_kw: 'in-wall termite system review',
      thesis: `Compare ${names} with a local SWFL provider.`,
    });

    test('approved names only (incl. the TAEXX and bare HomeTeam spellings) publish and record the names the list cleared', async () => {
      delete process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH;
      const publisher = chokepointPublisher(911, () => ['HomeTeam', 'Orkin']);
      const { runner, queue } = namedCompetitorScenario({
        publisher, comparisonGate: realGate,
        operatorBrief: brief('Orkin and HomeTeam'),
        body: 'HomeTeam installs TAEXX tubes in new walls. Orkin offers recurring residential plans.',
      });

      const result = await runner.runNext();

      expect(result.skip_reason).toBe('astro_pr_pending_merge');
      expect(publisher.publishOrUpdatePage).toHaveBeenCalledTimes(1);
      expect(result.comparison_table_result.competitors_approved_by_list).toEqual(['HomeTeam Pest Defense', 'Orkin']);
      // The chokepoint's result on the committed text is what the poller judges.
      expect(result.comparison_table_result.companyExtraction).toMatchObject({ ok: true, companies: ['HomeTeam Pest Defense', 'Orkin'] });
      expect(result.comparison_table_result.namedCompetitors).toEqual(['HomeTeam Pest Defense', 'Orkin']);
      expect(queue.skip).not.toHaveBeenCalled();
    });

    test.each([
      ['Aptive', 'Aptive offers recurring residential plans across its markets.', 'Aptive Environmental'],
      ['Truly Nolen', 'Truly Nolen offers recurring residential plans.', 'Truly Nolen'],
    ])('%s alone clears the owner list (owner added it 2026-09-28) and publishes', async (who, body, canonical) => {
      process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH = 'true';
      const publisher = chokepointPublisher(921, () => [who]);
      const { runner, queue } = namedCompetitorScenario({ publisher, comparisonGate: realGate, operatorBrief: brief(who), body });

      const result = await runner.runNext();

      expect(result.skip_reason).toBe('astro_pr_pending_merge');
      expect(result.comparison_table_result.competitors_approved_by_list).toEqual([canonical]);
      expect(queue.skip).not.toHaveBeenCalled();
    });

    test('one name off the owner list skips as named_competitor_off_list — never published, never queued for approval', async () => {
      process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH = 'true';
      const publisher = prPublisher(912);
      const { runner, queue, claimedAt } = namedCompetitorScenario({
        publisher, comparisonGate: realGate,
        operatorBrief: brief('Orkin and Hughes Exterminators'),
        body: 'Orkin offers recurring residential plans. Hughes Exterminators offers recurring residential plans too.',
      });

      const result = await runner.runNext();

      expect(result).toMatchObject({ outcome: 'skipped', skip_reason: 'named_competitor_off_list' });
      expect(result.reviewer_notes).toMatch(/Hughes Exterminators/);
      expect(result.comparison_table_result.competitors_approved_by_list).toBeUndefined();
      expect(publisher.publishOrUpdatePage).not.toHaveBeenCalled();
      expect(queue.pendingReview).not.toHaveBeenCalled();
      expect(queue.skip).toHaveBeenCalledWith('opp_named_1', 'named_competitor_off_list', { claimToken: claimedAt });
    });

    // Companies the deterministic detection cannot see (Codex r3 on #5146):
    // the chokepoint's extraction adds them, and any name off the six skips.
    test.each([
      ['a suffix-less brand ("Bug Out")', { body: 'Bug Out competes with local providers in Sarasota.' }, ['Bug Out'], 'named_competitor_off_list'],
      // A detection-only brand in the slug is now also caught deterministically
      // by the final-text comparison gate, which scans the slug (Codex r8).
      ['a name only in the slug', { body: 'How to compare local termite providers before you switch.', slug: '/pest-control/hulett-alternatives/' }, ['Hulett'], 'comparison_table_failed'],
      ['a name used both generically and as a company', { body: 'Lawn Doctor can be an informal term for a turf specialist. Lawn Doctor competes with local providers for recurring plans.' }, ['Lawn Doctor'], 'named_competitor_off_list'],
      ['a name only in secondary_keywords', { body: 'How to compare local pest providers.', frontmatterExtra: { secondary_keywords: ['bug out alternatives sarasota'] } }, ['Bug Out'], 'named_competitor_off_list'],
    ])('%s the model lists is refused at the commit and the run skips', async (_label, draftOpts, companies, reason) => {
      process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH = 'true';
      const publisher = chokepointPublisher(915, () => companies);
      const { runner, queue, claimedAt } = namedCompetitorScenario({ publisher, comparisonGate: realGate, intercept: false, ...draftOpts });

      const result = await runner.runNext();

      expect(publisher.publishOrUpdatePage).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ outcome: 'skipped', skip_reason: reason });
      if (reason === 'named_competitor_off_list') {
        expect(result.reviewer_notes).toContain(companies[0]);
        expect(result.comparison_table_result.companyExtraction).toMatchObject({ companies });
      }
      expect(queue.skip).toHaveBeenCalledWith('opp_named_1', reason, { claimToken: claimedAt });
    });

    test('deterministic names found only in the FINAL text (publisher-added) are persisted on the verdict (pre-push r11)', async () => {
      process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH = 'true';
      const publisher = chokepointPublisher(920);
      const inner = publisher.publishOrUpdatePage.getMockImplementation();
      publisher.publishOrUpdatePage.mockImplementation(async (draft, briefArg, opts) => {
        // The publisher adds a reused image alt naming Orkin.
        draft.body = `${draft.body}\n\n![Orkin truck outside a Venice home](/images/blog/x/body-1.webp)`;
        return inner(draft, briefArg, opts);
      });
      // Orkin is operator-authorized, so the publisher's final-text
      // comparison gate passes it and only the name inventory changes.
      const { runner } = namedCompetitorScenario({ publisher, comparisonGate: realGate, operatorBrief: brief('Orkin'), body: 'How to compare local pest providers.' });

      const result = await runner.runNext();

      expect(result.skip_reason).toBe('astro_pr_pending_merge');
      expect(result.comparison_table_result.namedCompetitors).toEqual(['Orkin']);
    });

    test('publisher-added text that fails the comparison gate refuses the commit (Codex r7)', async () => {
      process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH = 'true';
      const publisher = chokepointPublisher(922, () => ['Orkin']);
      const inner = publisher.publishOrUpdatePage.getMockImplementation();
      publisher.publishOrUpdatePage.mockImplementation(async (draft, briefArg, opts) => {
        draft.body = `${draft.body}\n\n![Orkin scams customers with hidden fees](/images/blog/x/body-1.webp)`;
        return inner(draft, briefArg, opts);
      });
      const { runner, queue, claimedAt } = namedCompetitorScenario({ publisher, comparisonGate: realGate, operatorBrief: brief('Orkin'), body: 'How to compare local pest providers.' });

      const result = await runner.runNext();

      expect(result).toMatchObject({ outcome: 'skipped', skip_reason: 'comparison_table_failed' });
      expect(result.reviewer_notes).toMatch(/COMPARISON_DISPARAGEMENT/);
      expect(queue.skip).toHaveBeenCalledWith('opp_named_1', 'comparison_table_failed', { claimToken: claimedAt });
    });

    test('the model listing no company publishes an ordinary post, even with the kill switch off', async () => {
      process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH = 'false';
      const publisher = chokepointPublisher(916);
      const { runner } = namedCompetitorScenario({
        publisher, comparisonGate: realGate, intercept: false,
        body: 'Biological Pest Control offers a way to reduce chemical use around Sarasota homes.',
      });

      const result = await runner.runNext();

      expect(result.skip_reason).toBe('astro_pr_pending_merge');
      expect(result.comparison_table_result.companyExtraction).toMatchObject({ ok: true, companies: [] });
    });

    test('a company-check outage at the chokepoint defers the draft an hour — at most 3 times — and an over-long draft is skipped', async () => {
      process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH = 'true';
      const outage = () => refusingPublisher({ code: 'BLOG_OWNER_LIST_UNVERIFIED', retryable: true, message: 'company-name check unavailable for the final text (no_key)', extraction: { ok: false, reason: 'no_key' } });
      const { runner, queue, claimedAt } = namedCompetitorScenario({ publisher: outage(), comparisonGate: realGate });
      const recordRetry = jest.spyOn(runner, '_recordCompanyCheckRetry').mockResolvedValue(true);
      const before = Date.now();

      const result = await runner.runNext();

      expect(recordRetry).toHaveBeenCalledWith(expect.objectContaining({ id: 'opp_named_1' }), 1, claimedAt);
      expect(result).toMatchObject({ outcome: 'deferred_company_check', skip_reason: 'named_competitor_unverified_names' });
      expect(result.reviewer_notes).toMatch(/no_key/);
      expect(queue.skip).not.toHaveBeenCalled();
      const [id, availableAt, payload] = queue.defer.mock.calls[0];
      expect([id, payload]).toEqual(['opp_named_1', { claimToken: claimedAt }]);
      expect(availableAt.getTime() - before).toBeGreaterThanOrEqual(59 * 60 * 1000);

      // queue.defer refunds the claim attempt, so the retry count on the
      // opportunity is what bounds an outage (pre-push r7).
      const exhausted = namedCompetitorScenario({ publisher: outage(), comparisonGate: realGate, signalMetadata: { company_check_retries: 3 } });
      expect(await exhausted.runner.runNext()).toMatchObject({ outcome: 'skipped', skip_reason: 'named_competitor_unverified_names' });
      expect(exhausted.queue.defer).not.toHaveBeenCalled();
      expect(exhausted.queue.skip).toHaveBeenCalledWith('opp_named_1', 'named_competitor_unverified_names', { claimToken: exhausted.claimedAt });

      const tooLong = namedCompetitorScenario({
        publisher: refusingPublisher({ code: 'BLOG_OWNER_LIST_UNVERIFIED', retryable: false, message: 'company-name check unavailable for the final text (draft_too_long_for_extraction)' }),
        comparisonGate: realGate,
      });
      expect(await tooLong.runner.runNext()).toMatchObject({ outcome: 'skipped', skip_reason: 'named_competitor_unverified_names' });
      expect(tooLong.queue.skip).toHaveBeenCalledWith('opp_named_1', 'named_competitor_unverified_names', { claimToken: tooLong.claimedAt });
    });

    test('kill switch off: an approved-names-only draft is skipped exactly as before (named_competitor_disabled)', async () => {
      process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH = 'false';
      const publisher = prPublisher(914);
      const { runner, queue, claimedAt } = namedCompetitorScenario({
        publisher, comparisonGate: realGate,
        operatorBrief: brief('Orkin'),
        body: 'Orkin offers recurring residential plans.',
      });

      const result = await runner.runNext();

      expect(result).toMatchObject({ outcome: 'skipped', skip_reason: 'named_competitor_disabled' });
      expect(publisher.publishOrUpdatePage).not.toHaveBeenCalled();
      expect(queue.skip).toHaveBeenCalledWith('opp_named_1', 'named_competitor_disabled', { claimToken: claimedAt });
    });
  });

  test('clean affiliate blogs publish with no trust credit, approval, or intercept marker', async () => {
    delete process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH;
    delete process.env.AUTO_PUBLISH_NEW_SUPPORTING_BLOG;
    process.env.TRUST_BUILD_THRESHOLD = '5';
    const publisher = { publishOrUpdatePage: jest.fn().mockResolvedValue({
      url: `https://www.wavespestcontrol.com${SLUG}`, status: 'pr_open', live: false,
      pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/903',
    }) };
    const { runner, queue } = namedCompetitorScenario({
      publisher, intercept: false,
      contentGuardrails: { evaluate: () => ({ pass: true, findings: [] }), affiliateProductIdsIn: () => ['rain-gauge'] },
      body: '## Equipment\n\n<AffiliateLink product="rain-gauge" placement="primary-rec">Rain gauge</AffiliateLink>',
    });
    const result = await runner.runNext();
    expect(result.skip_reason).toBe('astro_pr_pending_merge');
    expect(publisher.publishOrUpdatePage).toHaveBeenCalledTimes(1);
    expect(queue.release).not.toHaveBeenCalled();
  });

  test('gate ON: the same clean draft publishes through the normal astro-PR path', async () => {
    process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH = 'true';
    const publisher = {
      publishOrUpdatePage: jest.fn().mockResolvedValue({
        url: `https://www.wavespestcontrol.com${SLUG}`,
        status: 'pr_open',
        live: false,
        pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/901',
      }),
    };
    const { runner, queue, claimedAt } = namedCompetitorScenario({ publisher });

    const result = await runner.runNext();

    expect(result.skip_reason).not.toBe('named_competitor_review');
    expect(publisher.publishOrUpdatePage).toHaveBeenCalledTimes(1);
    // PR-open publish → the usual pending-merge park (Codex-gated
    // auto-merge downstream), NOT a human-review park.
    expect(result.outcome).toBe('completed_pending_review');
    expect(result.skip_reason).toBe('astro_pr_pending_merge');
    expect(queue.pendingReview).toHaveBeenCalledWith('opp_named_1', 'astro_pr_pending_merge', { claimToken: claimedAt });
    expect(queue.release).not.toHaveBeenCalled();
  });

  test('gate ON also satisfies the trust-build ramp — a clean eligible draft publishes with a NONZERO threshold and no AUTO_PUBLISH env (hook r9 P1)', async () => {
    process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH = 'true';
    process.env.TRUST_BUILD_THRESHOLD = '5';
    delete process.env.AUTO_PUBLISH_NEW_SUPPORTING_BLOG;
    const publisher = {
      publishOrUpdatePage: jest.fn().mockResolvedValue({
        url: `https://www.wavespestcontrol.com${SLUG}`,
        status: 'pr_open',
        live: false,
        pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/902',
      }),
    };
    const { runner, queue } = namedCompetitorScenario({ publisher });

    const result = await runner.runNext();

    expect(result.skip_reason).not.toMatch(/^trust_build_/);
    expect(result.skip_reason).not.toBe('named_competitor_review');
    expect(publisher.publishOrUpdatePage).toHaveBeenCalledTimes(1);
    expect(result.skip_reason).toBe('astro_pr_pending_merge');
    expect(queue.release).not.toHaveBeenCalled();
  });

  test('autopublish requires namedCompetitorComparison too — comparison flag OFF keeps the review park (hook P1)', async () => {
    process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH = 'true';
    const publisher = { publishOrUpdatePage: jest.fn() };
    const { runner, queue, claimedAt } = namedCompetitorScenario({ publisher });
    // Non-prod feature-gates pins namedCompetitorComparison true, so flip it
    // at the isEnabled seam (same fresh module instance the runner reads).
    const fg = require('../config/feature-gates');
    const realIsEnabled = fg.isEnabled;
    jest.spyOn(fg, 'isEnabled').mockImplementation((g) => (
      g === 'namedCompetitorComparison' ? false : realIsEnabled(g)));

    const result = await runner.runNext();

    expect(result.outcome).toBe('skipped');
    expect(result.skip_reason).toBe('named_competitor_disabled');
    expect(publisher.publishOrUpdatePage).not.toHaveBeenCalled();
    expect(queue.skip).toHaveBeenCalledWith('opp_named_1', 'named_competitor_disabled', { claimToken: claimedAt });
    fg.isEnabled.mockRestore();
  });

  test('gate ON never rescues a comparison-gate FAILURE', async () => {
    process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH = 'true';
    const publisher = { publishOrUpdatePage: jest.fn() };
    const { runner } = namedCompetitorScenario({
      publisher,
      // Autopublish only lifts the review park on a PASSING draft — a P0
      // finding must still keep the draft away from the publisher.
      comparisonGate: {
        evaluate: jest.fn().mockReturnValue({
          pass: false,
          findings: [{ severity: 'P0', code: 'COMPARISON_DISPARAGEMENT', message: 'disparagement' }],
          requiresHumanReview: false,
        }),
      },
    });

    const result = await runner.runNext();

    expect(publisher.publishOrUpdatePage).not.toHaveBeenCalled();
    expect(result.outcome).not.toBe('completed_published');
    expect(result.skip_reason).not.toBe('astro_pr_pending_merge');
  });
});

// ── runCatchUp (mid-day catch-up pass) ──────────────────────────────

describe('runCatchUp (mid-day catch-up pass)', () => {
  afterEach(() => { delete process.env.AUTONOMOUS_CONTENT_CATCHUP; });

  function catchUpRunner({ blogStarted = false, claimable = true, lockHeld = false } = {}) {
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();
    runner._withEngineLock = jest.fn((label, fn) => (lockHeld
      ? { outcome: 'skipped_locked', skipped: true, reason: 'engine_locked', count: 0, runs: [] }
      : fn()));
    runner._blogStartedToday = jest.fn(async () => blogStarted);
    runner._queueHasClaimable = jest.fn(async () => claimable);
    runner._sendBlogDroughtSms = jest.fn(async () => {});
    runner._runDailyInner = jest.fn(async ({ limit, actionType } = {}) => ({ outcome: 'completed_published', count: 1, limit, actionType, runs: [] }));
    return runner;
  }

  test('runs a BLOG-SCOPED batch under the engine lock when no blog started and a blog row is claimable', async () => {
    const runner = catchUpRunner();
    const result = await runner.runCatchUp({ limit: 2 });
    expect(runner._withEngineLock).toHaveBeenCalledWith('runCatchUp', expect.any(Function));
    // Scoped claim: a finite unscoped batch could spend every slot on
    // higher-scored non-blog rows and still miss the claimable blog.
    expect(runner._runDailyInner).toHaveBeenCalledWith({ limit: 2, actionType: 'new_supporting_blog' });
    expect(result).toMatchObject({ outcome: 'completed_published', count: 1 });
  });

  test('lock held by a live morning batch → skips without touching queue state', async () => {
    const runner = catchUpRunner({ lockHeld: true });
    const result = await runner.runCatchUp();
    // Stale-claim recovery must never run outside the lock — it would
    // reset claims a slow-but-alive batch is actively working.
    expect(runner._blogStartedToday).not.toHaveBeenCalled();
    expect(runner._queueHasClaimable).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'skipped_locked', skipped: true });
  });

  test('skips when a blog already started today (DB-backed — survives a dead morning process)', async () => {
    const runner = catchUpRunner({ blogStarted: true });
    const result = await runner.runCatchUp();
    expect(runner._runDailyInner).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'skipped_blog_already_started', skipped: true, count: 0 });
  });

  test('nothing claimable → still ensures the drought alert (morning may have died pre-SMS)', async () => {
    const runner = catchUpRunner({ claimable: false });
    const result = await runner.runCatchUp();
    expect(runner._runDailyInner).not.toHaveBeenCalled();
    // The 06-12 shape: batch killed before its end-of-batch alert ran.
    // The sms_log day-dedupe inside the sender bounds this to one text/day.
    expect(runner._sendBlogDroughtSms).toHaveBeenCalledWith([]);
    expect(result).toMatchObject({ outcome: 'skipped_no_claimable', skipped: true, count: 0 });
  });

  test('kill switch AUTONOMOUS_CONTENT_CATCHUP=false short-circuits before the lock', async () => {
    process.env.AUTONOMOUS_CONTENT_CATCHUP = 'false';
    const runner = catchUpRunner();
    const result = await runner.runCatchUp();
    expect(runner._withEngineLock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'skipped_disabled', skipped: true, count: 0 });
  });

  test('module singleton exposes runCatchUp', () => {
    const mod = require('../services/content/autonomous-runner');
    expect(typeof mod.runCatchUp).toBe('function');
  });
});

describe('_queueHasClaimable (catch-up probe)', () => {
  // Same fresh-registry + doMock pattern as the runNext harness above:
  // module identity is NOT stable across this file's tests (resetModules),
  // so the queue must be mocked into the registry the runner will require.
  function probeSetup({ peekRows = [], recover = jest.fn().mockResolvedValue(0) } = {}) {
    jest.resetModules();
    const mockQueue = { recoverStaleClaims: recover, peek: jest.fn().mockResolvedValue(peekRows) };
    jest.doMock('../models/db', () => jest.fn());
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/content/opportunity-queue', () => mockQueue);
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    return { runner: new AutonomousRunner(), mockQueue };
  }

  test('recovers stale claims FIRST, then peeks blog rows only', async () => {
    const { runner, mockQueue } = probeSetup({ peekRows: [{ id: 'opp_blog' }], recover: jest.fn().mockResolvedValue(1) });

    await expect(runner._queueHasClaimable()).resolves.toBe(true);

    // Blog-scoped: a pending non-blog row must not re-trigger the batch
    // (and a second drought SMS) on a blog-supply-drought day.
    expect(mockQueue.peek).toHaveBeenCalledWith({ limit: 1, minScore: DEFAULT_MIN_SCORE, actionType: 'new_supporting_blog' });
    // Recovery precedes the probe: a morning batch that died HOLDING the
    // only blog row's claim must read as claimable here, like claimNext.
    expect(mockQueue.recoverStaleClaims.mock.invocationCallOrder[0])
      .toBeLessThan(mockQueue.peek.mock.invocationCallOrder[0]);
  });

  test('no claimable blog rows → false', async () => {
    const { runner } = probeSetup({ peekRows: [] });
    await expect(runner._queueHasClaimable()).resolves.toBe(false);
  });

  test('recovery failure degrades to the plain probe instead of throwing', async () => {
    const { runner, mockQueue } = probeSetup({
      peekRows: [{ id: 'opp_blog' }],
      recover: jest.fn().mockRejectedValue(new Error('db down')),
    });
    await expect(runner._queueHasClaimable()).resolves.toBe(true);
    expect(mockQueue.peek).toHaveBeenCalled();
  });
});

describe('citability reconciliation after publisher-boundary failures', () => {
  test('ownership-lock failure attempts a claim-token-fenced release without hiding a moved claim', async () => {
    jest.resetModules();
    jest.doMock('../models/db', () => jest.fn());
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();
    const queue = { release: jest.fn().mockResolvedValue(false) };
    const claimedAt = new Date('2026-09-27T03:00:00Z');

    await expect(runner._releaseClaimAfterOwnershipLoss(queue, 'opp-lost', { claimToken: claimedAt }))
      .resolves.toBeUndefined();
    expect(queue.release).toHaveBeenCalledWith('opp-lost', { claimToken: claimedAt });
  });

  test('audit failure persists current-claim PR evidence before parking a citability refresh', async () => {
    jest.resetModules();
    const inserts = [];
    const dbMock = jest.fn((table) => ({
      insert: jest.fn((patch) => {
        inserts.push({ table, patch });
        return { returning: jest.fn().mockResolvedValue([{ id: 'run-recovery' }]) };
      }),
    }));
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();
    runner._pendingReviewClaimOrThrow = jest.fn().mockResolvedValue(undefined);
    const claimedAt = new Date('2026-09-27T03:05:00Z');
    const queue = {
      getById: jest.fn().mockResolvedValue({ id: 'opp-cite', bucket: 'citability_backfill' }),
    };
    const run = {
      opportunity_id: 'opp-cite', queue_claim_id: 'claim-current', action_type: 'refresh_existing_page',
      page_type: 'blog', shadow_mode: false, astro_pr_url: 'https://github.com/waves/pull/77',
      claimed_at: claimedAt, draft_payload: { autopublish_head_sha: 'head-77' },
    };

    await runner._parkPublishedClaimForReconciliation(
      queue, 'opp-cite', 'astro_pr_audit_failed', { claimToken: claimedAt }, new Error('full audit rejected'), run,
    );

    expect(inserts).toEqual([expect.objectContaining({
      table: 'autonomous_runs',
      patch: expect.objectContaining({
        opportunity_id: 'opp-cite', queue_claim_id: 'claim-current',
        outcome: 'completed_pending_review', skip_reason: 'astro_pr_pending_merge',
        astro_pr_url: 'https://github.com/waves/pull/77',
      }),
    })]);
    expect(runner._pendingReviewClaimOrThrow).toHaveBeenCalledWith(
      queue, 'opp-cite', 'astro_pr_pending_merge', { claimToken: claimedAt }, 'refresh_existing_page',
      expect.objectContaining({ id: 'run-recovery', astro_pr_url: 'https://github.com/waves/pull/77' }),
    );
  });

  test('evidence insert failure still parks the claim for reconciliation instead of leaving it claimed', async () => {
    jest.resetModules();
    const dbMock = jest.fn(() => ({
      insert: jest.fn(() => ({ returning: jest.fn().mockRejectedValue(new Error('db unavailable')) })),
    }));
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();
    runner._pendingReviewClaimOrThrow = jest.fn().mockResolvedValue(undefined);
    const claimedAt = new Date('2026-09-27T03:05:00Z');
    const queue = { getById: jest.fn().mockResolvedValue({ id: 'opp-cite', bucket: 'citability_backfill' }) };
    const run = {
      opportunity_id: 'opp-cite', queue_claim_id: 'claim-current', action_type: 'refresh_existing_page',
      astro_pr_url: 'https://github.com/waves/pull/78', claimed_at: claimedAt,
    };

    await runner._parkPublishedClaimForReconciliation(
      queue, 'opp-cite', 'astro_pr_audit_failed', { claimToken: claimedAt }, new Error('full audit rejected'), run,
    );

    expect(runner._pendingReviewClaimOrThrow).toHaveBeenCalledTimes(1);
    expect(runner._pendingReviewClaimOrThrow).toHaveBeenCalledWith(
      queue, 'opp-cite', 'astro_pr_audit_failed', { claimToken: claimedAt }, null,
    );
  });

  test('a failed locked park after the PR run is recorded falls back with the run\'s own pending-merge reason', async () => {
    jest.resetModules();
    jest.doMock('../models/db', () => jest.fn());
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();
    runner._pendingReviewClaimOrThrow = jest.fn()
      .mockRejectedValueOnce(new Error('page-edit lock unavailable'))
      .mockResolvedValueOnce(undefined);
    const claimedAt = new Date('2026-09-27T03:05:00Z');
    const queue = { getById: jest.fn().mockResolvedValue({ id: 'opp-cite', bucket: 'citability_backfill' }) };
    const run = {
      id: 'run-recorded', opportunity_id: 'opp-cite', queue_claim_id: 'claim-current', action_type: 'refresh_existing_page',
      astro_pr_url: 'https://github.com/waves/pull/79', claimed_at: claimedAt,
    };

    await runner._parkPublishedClaimForReconciliation(
      queue, 'opp-cite', 'astro_pr_queue_transition_failed', { claimToken: claimedAt }, new Error('queue write failed'), run,
    );

    expect(runner._pendingReviewClaimOrThrow).toHaveBeenCalledTimes(2);
    expect(runner._pendingReviewClaimOrThrow).toHaveBeenLastCalledWith(
      queue, 'opp-cite', 'astro_pr_pending_merge', { claimToken: claimedAt }, null,
    );
  });
});

describe('_recordCompanyCheckRetry — claim-fenced, supersession-aware metadata merge', () => {
  test('merges the counter into current metadata and refuses a superseded claim in the same statement', async () => {
    jest.resetModules();
    const calls = { where: [], whereRaw: [], update: null };
    const q = {
      where: jest.fn((...args) => { calls.where.push(args); return q; }),
      whereRaw: jest.fn((sql) => { calls.whereRaw.push(sql); return q; }),
      update: jest.fn(async (patch) => { calls.update = patch; return 1; }),
    };
    const dbMock = jest.fn(() => q);
    dbMock.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const claimedAt = new Date('2026-09-28T13:00:00Z');

    const ok = await new AutonomousRunner()._recordCompanyCheckRetry(
      { id: 'opp-1', signal_metadata: { stale: 'snapshot' } }, 2, claimedAt,
    );

    expect(ok).toBe(true);
    expect(calls.where).toEqual(expect.arrayContaining([['id', 'opp-1'], ['status', 'claimed'], ['claimed_at', claimedAt]]));
    expect(calls.whereRaw.join(' ')).toContain("NOT jsonb_exists(COALESCE(signal_metadata, '{}'::jsonb), 'page_edit_superseded')");
    expect(calls.update.signal_metadata.__raw).toContain("jsonb_set(COALESCE(signal_metadata, '{}'::jsonb), ARRAY['company_check_retries']::text[]");
    expect(calls.update.signal_metadata.bindings).toEqual([2]);
    expect(JSON.stringify(calls.update)).not.toContain('snapshot');
  });
});

describe('approveAndPublishNamedCompetitor — superseded in-flight approval', () => {
  test('terminally retires both claims instead of restoring an unreviewable pending_review row', async () => {
    jest.resetModules();
    const updates = [];
    const wheres = [];
    const trx = jest.fn((table) => {
      const q = {
        where: jest.fn((...args) => { wheres.push({ table, args }); return q; }),
        whereRaw: jest.fn(() => q),
        first: jest.fn(async () => (table === 'autonomous_runs' ? { reviewer_notes: 'approved by owner' } : null)),
        update: jest.fn(async (patch) => { updates.push({ table, patch }); return 1; }),
      };
      return q;
    });
    const dbMock = jest.fn();
    dbMock.transaction = jest.fn(async (callback) => callback(trx));
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();

    const approvalClaimedAt = new Date('2026-09-27T01:30:00Z');
    await runner._retireSupersededApprovalClaim('opp-cite', { id: 'run-cite' }, approvalClaimedAt, 'page ownership moved');

    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'opportunity_queue',
        patch: expect.objectContaining({ status: 'skipped', skip_reason: 'superseded_by_ordinary_page_edit' }),
      }),
      expect.objectContaining({
        table: 'autonomous_runs',
        patch: expect.objectContaining({ outcome: 'skipped_gate_fail', skip_reason: 'superseded_by_ordinary_page_edit' }),
      }),
    ]));
    expect(updates.find((u) => u.table === 'autonomous_runs').patch.reviewer_notes)
      .toContain('page ownership moved');
    expect(wheres).toContainEqual({ table: 'opportunity_queue', args: ['claimed_at', approvalClaimedAt] });
  });

  test('an unreconciled timed-out write parks both approval records on a reason no approval accepts', async () => {
    jest.resetModules();
    const updates = [];
    const wheres = [];
    const trx = jest.fn((table) => {
      const q = {
        where: jest.fn((...args) => { wheres.push({ table, args }); return q; }),
        update: jest.fn(async (patch) => { updates.push({ table, patch }); return 1; }),
      };
      return q;
    });
    const dbMock = jest.fn(() => { throw new Error('approval park must run inside one transaction'); });
    dbMock.transaction = jest.fn(async (callback) => callback(trx));
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const approvalClaimedAt = new Date('2026-09-28T20:00:00Z');
    const err = Object.assign(new Error('refresh write to content/refresh-z timed out and no PR was found yet'), { code: 'REFRESH_PUBLISH_UNRECONCILED' });

    await new AutonomousRunner()._parkUnreconciledApproval('opp-z', { id: 'run-z' }, approvalClaimedAt, err);

    const runPatch = updates.find((u) => u.table === 'autonomous_runs').patch;
    const oppPatch = updates.find((u) => u.table === 'opportunity_queue').patch;
    expect(runPatch).toMatchObject({ outcome: 'completed_pending_review', skip_reason: 'refresh_publish_unreconciled' });
    expect(runPatch.reviewer_notes).toMatch(/content\/refresh-z/);
    expect(oppPatch).toMatchObject({ status: 'pending_review', skip_reason: 'refresh_publish_unreconciled' });
    // Only the in-flight approval claim is parked.
    expect(wheres).toContainEqual({ table: 'autonomous_runs', args: [{ id: 'run-z', outcome: 'publishing_named_competitor' }] });
    expect(wheres).toContainEqual({ table: 'opportunity_queue', args: ['claimed_at', approvalClaimedAt] });
    // No approval path claims this reason, and a superseded row stays for a person.
    const { RECONCILIATION_HOLD_REASONS } = jest.requireActual('../services/content/opportunity-queue')._internals;
    expect(RECONCILIATION_HOLD_REASONS).toContain('refresh_publish_unreconciled');
    expect(dbMock.transaction).toHaveBeenCalledTimes(1);
  });

  test('an approval park that cannot move both records rolls back as one', async () => {
    jest.resetModules();
    const trx = jest.fn((table) => {
      const q = {
        where: jest.fn(() => q),
        update: jest.fn(async () => (table === 'opportunity_queue' ? 0 : 1)),
      };
      return q;
    });
    const dbMock = jest.fn();
    let rolledBack = null;
    dbMock.transaction = jest.fn(async (callback) => {
      try { return await callback(trx); } catch (e) { rolledBack = e; throw e; }
    });
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => logger);
    const { AutonomousRunner } = require('../services/content/autonomous-runner');

    await expect(new AutonomousRunner()._parkUnreconciledApproval('opp-q', { id: 'run-q' }, new Date(), new Error('x')))
      .resolves.toBeUndefined();
    expect(rolledBack?.message).toMatch(/approval claims moved \(run 1, queue 0\)/);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/left in its publishing state for the janitor/));
  });

  test('crash recovery preserves an uncertain superseded publication for interrupted-publish reconciliation', async () => {
    jest.resetModules();
    const approvalClaimedAt = new Date('2026-09-27T01:30:00Z');
    const outsideWheres = [];
    const updates = [];
    const trx = jest.fn((table) => {
      const q = {
        where: jest.fn((...args) => { outsideWheres.push({ table, args }); return q; }),
        whereRaw: jest.fn(() => q),
        first: jest.fn(async () => (table === 'autonomous_runs' ? { reviewer_notes: 'approved' } : null)),
        update: jest.fn(async (patch) => { updates.push({ table, patch }); return 1; }),
      };
      return q;
    });
    const dbMock = jest.fn((table) => {
      const q = {
        where: jest.fn((...args) => { outsideWheres.push({ table, args }); return q; }),
        whereNull: jest.fn(() => q),
        first: jest.fn(async () => ({ id: 'run-current', reviewer_notes: 'approved' })),
      };
      return q;
    });
    dbMock.transaction = jest.fn(async (callback) => callback(trx));
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();

    const result = await runner._retireSupersededStuckApprovals([{
      id: 'opp-cite', bucket: 'citability_backfill', claim_id: 'claim-current', claimed_at: approvalClaimedAt,
      signal_metadata: { page_edit_superseded: { ordinary_dedupe_key: 'ordinary:1' } },
    }], 'crash recovery');

    expect(result).toEqual({ ids: [], runs: 0, opps: 0 });
    expect(outsideWheres).toContainEqual({ table: 'autonomous_runs', args: ['queue_claim_id', 'claim-current'] });
    // The caller's ordinary stuck-publish path now parks both records at
    // named_competitor_publish_interrupted. No terminal write here may hide
    // an external PR/live side effect whose URL was not persisted.
    expect(updates).toEqual([]);
  });

  test('crash recovery restores a persisted current-claim PR park for supersession retirement', async () => {
    jest.resetModules();
    const approvalClaimedAt = new Date('2026-09-27T01:35:00Z');
    const updates = [];
    const dbMock = jest.fn((table) => {
      const filters = {};
      const q = {
        where: jest.fn((a, b) => { if (typeof a === 'object') Object.assign(filters, a); else filters[a] = b; return q; }),
        whereIn: jest.fn(() => q), whereNotNull: jest.fn(() => q), whereNull: jest.fn(() => q), whereRaw: jest.fn(() => q),
        first: jest.fn(async () => (table === 'autonomous_runs' && filters.outcome === 'completed_pending_review'
          ? { id: 'run-pr', skip_reason: 'astro_pr_pending_merge', astro_pr_url: 'https://github.com/waves/pull/42' }
          : null)),
        update: jest.fn(async (patch) => { updates.push({ table, patch }); return 1; }),
      };
      return q;
    });
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();

    const result = await runner._retireSupersededStuckApprovals([{
      id: 'opp-cite', bucket: 'citability_backfill', claim_id: 'claim-current', claimed_at: approvalClaimedAt,
      signal_metadata: { page_edit_superseded: { ordinary_dedupe_key: 'ordinary:2' } },
    }], 'crash recovery');

    expect(result).toEqual({ ids: ['opp-cite'], runs: 0, opps: 1 });
    expect(updates).toEqual([expect.objectContaining({
      table: 'opportunity_queue',
      patch: expect.objectContaining({ status: 'pending_review', skip_reason: 'astro_pr_pending_merge' }),
    })]);
    expect(updates[0].patch.status).not.toBe('skipped');
  });

  test('a superseded non-PR park atomically retires the current run and queue row', async () => {
    jest.resetModules();
    const claimedAt = new Date('2026-09-27T01:45:00Z');
    const updates = [];
    const locked = {
      id: 'opp-cite', bucket: 'citability_backfill', status: 'claimed', claimed_at: claimedAt,
      claim_id: 'claim-current', signal_metadata: { page_edit_superseded: { ordinary_dedupe_key: 'ordinary:1' } },
    };
    const trx = jest.fn((table) => {
      const q = {
        where: jest.fn(() => q), forUpdate: jest.fn(() => q),
        first: jest.fn(async () => locked),
        update: jest.fn(async (patch) => { updates.push({ table, patch }); return 1; }),
      };
      return q;
    });
    trx.raw = jest.fn(async () => ({}));
    const dbMock = jest.fn();
    dbMock.transaction = jest.fn(async (callback) => callback(trx));
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();
    const queue = {
      getById: jest.fn(async () => locked),
      pendingReview: jest.fn(), skip: jest.fn(),
    };
    const run = {
      id: 'run-current', opportunity_id: 'opp-cite', action_type: 'refresh_existing_page',
      queue_claim_id: 'claim-current', outcome: 'completed_pending_review', skip_reason: 'gate_infrastructure_error',
    };

    await runner._pendingReviewClaimOrThrow(queue, 'opp-cite', 'gate_infrastructure_error', { claimToken: claimedAt }, 'refresh_existing_page', run);

    expect(run).toMatchObject({ outcome: 'skipped_gate_fail', skip_reason: 'superseded_by_ordinary_page_edit' });
    expect(queue.pendingReview).not.toHaveBeenCalled();
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'opportunity_queue', patch: expect.objectContaining({ status: 'skipped' }) }),
      expect.objectContaining({ table: 'autonomous_runs', patch: expect.objectContaining({ outcome: 'skipped_gate_fail' }) }),
    ]));
  });

  test('a superseded current-claim PR stays parked for terminal PR retirement', async () => {
    jest.resetModules();
    const claimedAt = new Date('2026-09-27T01:50:00Z');
    const updates = [];
    const locked = {
      id: 'opp-cite-pr', bucket: 'citability_backfill', status: 'claimed', claimed_at: claimedAt,
      claim_id: 'claim-current', signal_metadata: { page_edit_superseded: { ordinary_dedupe_key: 'ordinary:2' } },
    };
    const trx = jest.fn((table) => {
      const q = {
        where: jest.fn(() => q), forUpdate: jest.fn(() => q),
        first: jest.fn(async () => locked),
        update: jest.fn(async (patch) => { updates.push({ table, patch }); return 1; }),
      };
      return q;
    });
    trx.raw = jest.fn(async () => ({}));
    const dbMock = jest.fn();
    dbMock.transaction = jest.fn(async (callback) => callback(trx));
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();
    const queue = { getById: jest.fn(async () => locked), pendingReview: jest.fn(), skip: jest.fn() };
    const run = {
      id: 'run-current-pr', opportunity_id: 'opp-cite-pr', action_type: 'refresh_existing_page',
      queue_claim_id: 'claim-current', astro_pr_url: 'https://github.com/waves/pull/42',
      outcome: 'completed_pending_review', skip_reason: 'astro_pr_pending_merge',
    };

    await runner._pendingReviewClaimOrThrow(
      queue, 'opp-cite-pr', 'astro_pr_pending_merge', { claimToken: claimedAt }, 'refresh_existing_page', run,
    );

    expect(run).toMatchObject({ outcome: 'completed_pending_review', skip_reason: 'astro_pr_pending_merge' });
    expect(updates).toEqual([
      expect.objectContaining({
        table: 'opportunity_queue',
        patch: expect.objectContaining({ status: 'pending_review', skip_reason: 'astro_pr_pending_merge' }),
      }),
    ]);
    expect(queue.pendingReview).not.toHaveBeenCalled();
  });
});

// R10-5 (Codex): approving an OLD named-competitor run by --id must not publish a
// stale draft once a requeue + re-run has parked a NEWER run for the opportunity.
describe('approveAndPublishNamedCompetitor — stale named-competitor run guard', () => {
  const PARKED = { outcome: 'completed_pending_review', skip_reason: 'named_competitor_review', shadow_mode: false };
  const runA = { id: 1, opportunity_id: 7, ...PARKED, claimed_at: new Date('2026-06-20T00:00:00Z') };
  const runB = { id: 2, opportunity_id: 7, ...PARKED, claimed_at: new Date('2026-06-21T00:00:00Z') };

  // db query builder whose .first() returns successive queued results:
  //   call 1 = lookup-by-id, call 2 = latest-parked lookup.
  function dbReturning(firsts) {
    jest.resetModules();
    const db = require('../models/db');
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    let i = 0;
    const builder = {
      where: () => builder,
      orderBy: () => builder,
      first: () => Promise.resolve(firsts[i++]),
      update: () => Promise.resolve(1),
    };
    db.mockImplementation(() => builder);
    const runner = new AutonomousRunner();
    runner._withEngineLock = (_label, fn) => fn(); // bypass the advisory lock
    return runner;
  }

  test('rejects (409) approving an OLDER runId when a newer parked run exists', async () => {
    const runner = dbReturning([runA, runB]); // by-id → A, latest-parked → B
    await expect(runner.approveAndPublishNamedCompetitor(7, { runId: 1 }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/newer named-competitor review run/i) });
  });

  test('lets the LATEST runId past the guard (fails later as 422 missing-draft, not the 409 stale guard)', async () => {
    const runner = dbReturning([runB, runB]); // by-id → B, latest-parked → B (same)
    await expect(runner.approveAndPublishNamedCompetitor(7, { runId: 2 }))
      .rejects.toMatchObject({ statusCode: 422 }); // got past the stale-run guard
  });

  test('an affiliate_review park is an approvable-publish kind: passes the kind guard (422 missing-draft, not 400) — Codex PR3 r1', async () => {
    const aff = { ...runB, skip_reason: 'affiliate_review' };
    const runner = dbReturning([aff, aff]);
    await expect(runner.approveAndPublishNamedCompetitor(7, { runId: 2 }))
      .rejects.toMatchObject({ statusCode: 422 });
  });

  test('a trust-build park is NOT an approvable-publish kind (400)', async () => {
    const tb = { ...runB, skip_reason: 'trust_build_1_of_3' };
    const runner = dbReturning([tb, tb]);
    await expect(runner.approveAndPublishNamedCompetitor(7, { runId: 2 }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('_countPublishedSince counts publishes IN FLIGHT (audit regression — caps were a no-op for the PR lane)', () => {
  test('counts completed_published OR parked-open-PR runs; asserts the exact pr-pending reasons', async () => {
    // Self-contained module load: earlier loadRunnerWith() calls reset the
    // registry and bind the runner to their own db mocks.
    jest.resetModules();
    const captured = { whereIn: [], where: [] };
    const q = {
      where: jest.fn(function (a, b) {
        if (typeof a === 'function') { a.call(q); return q; }
        captured.where.push([a, b]);
        return q;
      }),
      orWhere: jest.fn(function (a) {
        if (typeof a === 'function') a.call(q);
        return q;
      }),
      whereIn: jest.fn(function (col, vals) {
        captured.whereIn.push([col, vals]);
        return q;
      }),
      whereNotNull: jest.fn(function (col) {
        captured.whereNotNull = captured.whereNotNull || [];
        captured.whereNotNull.push(col);
        return q;
      }),
      count: jest.fn(() => q),
      first: jest.fn(() => Promise.resolve({ count: 4 })),
    };
    jest.doMock('../models/db', () => jest.fn(() => q));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const runner = require('../services/content/autonomous-runner');

    const n = await runner._countPublishedSince('new_supporting_blog', new Date('2026-07-02T04:00:00Z'));

    expect(n).toBe(4);
    // The blog lane never produces completed_published directly — a parked
    // open PR must consume the cap at PR-open time or one batch can open
    // batchLimit PRs the same day and auto-merge them all.
    expect(captured.where).toEqual(expect.arrayContaining([
      ['outcome', 'completed_published'],
      ['outcome', 'completed_pending_review'],
    ]));
    expect(captured.whereIn).toEqual(expect.arrayContaining([
      ['skip_reason', ['astro_pr_pending_merge', 'metadata_pr_pending_merge']],
    ]));
    // Codex round 2: the pending branch must require a REAL PR — a
    // malformed adapter result parks with the pending reason but NO
    // astro_pr_url (routed manually), and counting it would let one bad
    // response consume the whole day/week cap.
    expect(captured.whereNotNull).toEqual(['astro_pr_url']);
  });
});

describe('gate module-load failures fail CLOSED (regression — these silently skipped)', () => {
  const claimedAt = new Date('2026-07-02T13:00:00Z');
  const makeQueue = (oppId) => ({
    claimNext: jest.fn().mockResolvedValue({ id: oppId, action_type: 'new_supporting_blog', claimed_at: claimedAt }),
    complete: jest.fn().mockResolvedValue(true),
    pendingReview: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(true),
  });
  const makeBriefBuilder = () => ({
    compose: jest.fn().mockResolvedValue({
      id: 'brief_gate_unavail',
      action_type: 'new_supporting_blog',
      page_type: 'supporting-blog',
      human_review_required: false,
    }),
  });
  const makeDispatcher = () => ({
    runWithBrief: jest.fn().mockResolvedValue({
      ok: true,
      draft: { url: '/blog/gate-unavailable/', title: 'Gate Unavailable Post', body: 'Benign copy about seasonal ant pressure in Southwest Florida homes.' },
    }),
  });

  test('content-guardrails load failure routes to review instead of skipping the price/brand/FAQ/link P0s', async () => {
    const queue = makeQueue('opp_guardrails_unavail');
    const publisher = { publishOrUpdatePage: jest.fn() };
    const runner = loadRunnerWith({
      queue,
      briefBuilder: makeBriefBuilder(),
      dispatcher: makeDispatcher(),
      publisher,
      contentGuardrails: 'unavailable',
    });
    const result = await runner.runNext();
    expect(result.outcome).toBe('skipped_gate_fail');
    expect(result.skip_reason).toBe('content_guardrails_unavailable');
    expect(result.content_guardrails_result).toMatchObject({ pass: false });
    expect(publisher.publishOrUpdatePage).not.toHaveBeenCalled();
    expect(queue.skip).toHaveBeenCalledWith('opp_guardrails_unavail', 'content_guardrails_unavailable', { claimToken: claimedAt });
  });

  test('comparison-table-gate load failure routes to review instead of skipping the disparagement checks', async () => {
    const queue = makeQueue('opp_comparison_unavail');
    const publisher = { publishOrUpdatePage: jest.fn() };
    const runner = loadRunnerWith({
      queue,
      briefBuilder: makeBriefBuilder(),
      dispatcher: makeDispatcher(),
      publisher,
      comparisonTableGate: 'unavailable',
    });
    const result = await runner.runNext();
    expect(result.outcome).toBe('skipped_gate_fail');
    expect(result.skip_reason).toBe('comparison_table_unavailable');
    expect(result.comparison_table_result).toMatchObject({ pass: false });
    expect(publisher.publishOrUpdatePage).not.toHaveBeenCalled();
    expect(queue.skip).toHaveBeenCalledWith('opp_comparison_unavail', 'comparison_table_unavailable', { claimToken: claimedAt });
  });

  test('claims-ledger-validator load failure on a facts-sufficient draft routes to review', async () => {
    const queue = makeQueue('opp_claims_unavail');
    const publisher = { publishOrUpdatePage: jest.fn() };
    const runner = loadRunnerWith({
      queue,
      briefBuilder: makeBriefBuilder(),
      dispatcher: makeDispatcher(),
      publisher,
      factsSufficiency: {
        check: jest.fn().mockResolvedValue({ applicable: true, sufficient: true, city_id: 'venice', service_id: 'pest', county: 'sarasota' }),
      },
      claimsLedgerValidator: 'unavailable',
    });
    const result = await runner.runNext();
    expect(result.outcome).toBe('skipped_gate_fail');
    expect(result.skip_reason).toBe('claims_ledger_unavailable');
    expect(result.claims_ledger_result).toMatchObject({ pass: false });
    expect(publisher.publishOrUpdatePage).not.toHaveBeenCalled();
    expect(queue.skip).toHaveBeenCalledWith('opp_claims_unavail', 'claims_ledger_unavailable', { claimToken: claimedAt });
  });
});

describe('operator brief text for the comparison gate includes sourcing fields (Codex round 14)', () => {
  const { operatorBriefTextForComparisonGate, OPERATOR_INTERCEPT_BUCKET } = require('../services/content/autonomous-runner')._internals;

  test('required_sources URLs and source_notes authorize the competitor they name', () => {
    // A required https://www.orkin.com/... citation must authorize "orkin"
    // exactly like naming it in the title/outline — otherwise the binding
    // citation itself reads as an unauthorized mention and the run
    // hard-blocks at comparison_table_failed instead of the review path.
    const text = operatorBriefTextForComparisonGate(
      { bucket: OPERATOR_INTERCEPT_BUCKET },
      { voice_constraints: { operator_brief: {
        working_title: 'Cancellation fees explained',
        primary_kw: 'pest control cancellation fee',
        required_sources: ['https://www.orkin.com/plans/cancellation'],
        source_notes: ['Terminix publishes its bond terms in the FAQ'],
      } } }
    );
    expect(text).toContain('orkin.com');
    expect(text).toContain('Terminix');
  });

  test('non-intercept buckets still produce empty text', () => {
    expect(operatorBriefTextForComparisonGate({ bucket: 'mined' }, { voice_constraints: { operator_brief: { required_sources: ['https://www.orkin.com/x'] } } })).toBe('');
  });
});

describe('city-service protected-page paths match the brief builder (Codex P1 on #3372)', () => {
  const { servicePathSlug, cityServicePath } = _internals;
  const { _internals: briefInternals } = require('../services/content/content-brief-builder');

  test('tree-shrub resolves to the REAL route, not the phantom fallthrough', () => {
    // no_content_yet city-service rows carry no page_url and a null
    // target_url, so this map alone decides which path the protected-page
    // guard probes. Without the key the fallthrough builds
    // /tree-shrub-{city}-fl/, which does not exist — the guard would then
    // fail to see the live page it is supposed to protect.
    expect(servicePathSlug('tree-shrub')).toBe('tree-and-shrub-care');
    // The miner canonicalizes 'tree_shrub' → 'tree-shrub', but the raw
    // underscore form must not regress either.
    expect(servicePathSlug('tree_shrub')).toBe('tree-and-shrub-care');
    expect(cityServicePath('tree-shrub', 'Venice')).toBe('/tree-and-shrub-care-venice-fl/');
  });

  test('every service the brief builder can target has the SAME runner slug', () => {
    // The two maps are the same contract expressed twice; a service present
    // in one and missing from the other is exactly how this bug happened.
    const briefMap = briefInternals?.SERVICE_CITY_SLUG;
    expect(briefMap).toBeTruthy();
    for (const [service, slug] of Object.entries(briefMap)) {
      expect([service, servicePathSlug(service)]).toEqual([service, slug]);
    }
  });
});

// Codex r2 on #5216 ("Classify refreshes using the retained live post
// type"): publishRefresh ships the LIVE frontmatter, so the runner hands
// the quality gate that live frontmatter and the gate classifies the
// refresh by it, not by the draft.
describe('refresh quality gate receives the live frontmatter', () => {
  test('ctx.liveFrontmatter is the live page frontmatter on a refresh', async () => {
    const claimedAt = new Date('2026-09-28T10:00:00Z');
    const queue = {
      claimNext: jest.fn().mockResolvedValue({ id: 'opp_refresh_live_type', action_type: 'refresh_existing_page', page_url: '/pest-control/fire-ant-id/', claimed_at: claimedAt }),
      pendingReview: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    };
    const briefBuilder = {
      compose: jest.fn().mockResolvedValue({
        id: 'brief_refresh_live_type',
        action_type: 'refresh_existing_page',
        page_type: 'refresh',
        target_url: '/pest-control/fire-ant-id/',
        human_review_required: false,
      }),
    };
    const dispatcher = { runWithBrief: jest.fn().mockResolvedValue({ ok: true, draft: { body: 'Refreshed body.', frontmatter: {} } }) };
    const liveFm = { post_type: 'diagnostic', _astro_source_path: 'src/content/blog/pest-control/fire-ant-id.mdx', domains: [] };
    const publisher = {
      getLiveFrontmatter: jest.fn().mockResolvedValue(liveFm),
      loadExistingPageBody: jest.fn().mockResolvedValue({ body: 'Live body.' }),
      resolveExistingAstroFileForTarget: jest.fn().mockResolvedValue({ path: 'src/content/blog/pest-control/fire-ant-id.mdx' }),
      isBlogTarget: jest.fn().mockReturnValue(true),
    };
    const qualityGate = { evaluate: jest.fn().mockReturnValue({ ok: false, hard_failures: ['verdict_box_first'], soft_failures: [], total_score: 0, min_total_score: 80 }) };
    const runner = loadRunnerWith({
      queue,
      briefBuilder,
      dispatcher,
      publisher,
      qualityGate,
      factsSufficiency: { check: jest.fn().mockResolvedValue({ applicable: false }) },
      contentGuardrails: { evaluate: jest.fn().mockReturnValue({ pass: true, findings: [] }) },
      uniquenessGate: { evaluate: jest.fn().mockReturnValue({ ok: true, failed_reasons: [] }), evaluateBlog: jest.fn().mockReturnValue({ ok: true, failed_reasons: [] }) },
    });
    await runner.runNext();
    expect(qualityGate.evaluate).toHaveBeenCalled();
    const [, gateBrief, ctx] = qualityGate.evaluate.mock.calls[0];
    expect(gateBrief.action_type).toBe('refresh_existing_page');
    expect(ctx.liveFrontmatter).toMatchObject({ post_type: 'diagnostic' });
    expect(ctx.previousVersion).toEqual({ body: 'Live body.' });
    expect(ctx.liveFrontmatterUnavailable).toBeUndefined();
  });

  test('the quality gate reuses gate 3c\'s live frontmatter snapshot (no read of its own)', async () => {
    const claimedAt = new Date('2026-09-28T10:00:00Z');
    const queue = {
      claimNext: jest.fn().mockResolvedValue({ id: 'opp_refresh_live_fail', action_type: 'refresh_existing_page', page_url: '/pest-control/fire-ant-id/', claimed_at: claimedAt }),
      pendingReview: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    };
    const briefBuilder = { compose: jest.fn().mockResolvedValue({ id: 'b', action_type: 'refresh_existing_page', page_type: 'refresh', target_url: '/pest-control/fire-ant-id/', human_review_required: false }) };
    const dispatcher = { runWithBrief: jest.fn().mockResolvedValue({ ok: true, draft: { body: 'Refreshed body.', frontmatter: {} } }) };
    const publisher = {
      // Each read returns a distinct snapshot: the pre-session self-lint
      // hydration (#5221) reads first, gate 3c second.
      getLiveFrontmatter: jest.fn()
        .mockResolvedValueOnce({ post_type: 'diagnostic', _astro_source_path: 'src/content/blog/pest-control/fire-ant-id.mdx', domains: [], _read: 'self_lint' })
        .mockResolvedValue({ post_type: 'diagnostic', _astro_source_path: 'src/content/blog/pest-control/fire-ant-id.mdx', domains: [], _read: 'gate_3c' }),
      loadExistingPageBody: jest.fn().mockResolvedValue({ body: 'Live body.' }),
      resolveExistingAstroFileForTarget: jest.fn().mockResolvedValue({ path: 'src/content/blog/pest-control/fire-ant-id.mdx' }),
      isBlogTarget: jest.fn().mockReturnValue(true),
    };
    const qualityGate = { evaluate: jest.fn().mockReturnValue({ ok: false, hard_failures: ['verdict_box_first'], soft_failures: [], total_score: 0, min_total_score: 80 }) };
    const runner = loadRunnerWith({
      queue, briefBuilder, dispatcher, publisher, qualityGate,
      factsSufficiency: { check: jest.fn().mockResolvedValue({ applicable: false }) },
      contentGuardrails: { evaluate: jest.fn().mockReturnValue({ pass: true, findings: [] }) },
      uniquenessGate: { evaluate: jest.fn().mockReturnValue({ ok: true, failed_reasons: [] }), evaluateBlog: jest.fn().mockReturnValue({ ok: true, failed_reasons: [] }) },
    });
    await runner.runNext();
    const [, , ctx] = qualityGate.evaluate.mock.calls[0];
    // Self-lint hydration + gate 3c; the quality gate adds no third read.
    expect(publisher.getLiveFrontmatter).toHaveBeenCalledTimes(2);
    expect(ctx.liveFrontmatter).toMatchObject({ post_type: 'diagnostic', _read: 'gate_3c' });
    expect(ctx.liveFrontmatterUnavailable).toBeUndefined();
  });

  // Codex r8 on #5216: the run ledger is the durable customer-question
  // marker — the page carries no page type of its own.
  describe('customer-question ledger lookup', () => {
    const withRuns = (rows, { fail = false } = {}) => {
      const chain = { where: jest.fn(() => chain), whereNotNull: jest.fn(() => chain), select: jest.fn(() => (fail ? Promise.reject(new Error('db down')) : Promise.resolve(rows))) };
      db.mockImplementation((table) => (table === 'autonomous_runs' ? chain : undefined));
      return chain;
    };
    afterEach(() => { db.mockReset(); });

    test('true when a customer-question run published this path (absolute URL vs path)', async () => {
      const chain = withRuns([{ published_url: 'https://www.wavespestcontrol.com/pest-control/can-cockroaches-fly/' }]);
      const r = await _internals.publishedAsCustomerQuestion('/pest-control/can-cockroaches-fly');
      expect(r).toBe(true);
      expect(chain.where).toHaveBeenCalledWith('page_type', 'customer-question');
    });
    test('false for a path no customer-question run published', async () => {
      withRuns([{ published_url: 'https://www.wavespestcontrol.com/pest-control/other/' }]);
      expect(await _internals.publishedAsCustomerQuestion('/pest-control/can-cockroaches-fly/')).toBe(false);
    });
    // Codex r2 on #5272: two fleet domains can carry different posts at one path.
    test('host-aware: a run on another fleet domain at the same path does not count', async () => {
      withRuns([{ published_url: 'https://www.bradentonflpestcontrol.com/pest-control/can-cockroaches-fly/' }]);
      expect(await _internals.publishedAsCustomerQuestion('https://www.wavespestcontrol.com/pest-control/can-cockroaches-fly/')).toBe(false);
      withRuns([{ published_url: 'https://wavespestcontrol.com/pest-control/can-cockroaches-fly/' }]);
      expect(await _internals.publishedAsCustomerQuestion('https://www.wavespestcontrol.com/pest-control/can-cockroaches-fly/')).toBe(true);
    });
    // Codex r3 on #5272: a relative target is the hub's page, never a
    // wildcard across fleet domains.
    test('a relative target matches only a hub run at that path', async () => {
      withRuns([{ published_url: 'https://www.bradentonflpestcontrol.com/pest-control/can-cockroaches-fly/' }]);
      expect(await _internals.publishedAsCustomerQuestion('/pest-control/can-cockroaches-fly/')).toBe(false);
      withRuns([{ published_url: 'https://www.wavespestcontrol.com/pest-control/can-cockroaches-fly/' }]);
      expect(await _internals.publishedAsCustomerQuestion('/pest-control/can-cockroaches-fly/')).toBe(true);
    });
    test('null when the ledger cannot be read', async () => {
      withRuns([], { fail: true });
      expect(await _internals.publishedAsCustomerQuestion('/pest-control/can-cockroaches-fly/')).toBeNull();
    });
  });
});

// Refreshes had no in-loop self-lint (their guard options need the live
// page), so every mechanical miss parked the run at gate 3c. The runner now
// hydrates gate 3c's own options before the session.
describe('W1 in-loop self-lint arms for refreshes with gate 3c options', () => {
  const setup = (publisher) => {
    const queue = {
      claimNext: jest.fn().mockResolvedValue({ id: 'opp_ref', action_type: 'refresh_existing_page', page_url: '/pest-control/signs-of-termites/', claimed_at: new Date('2026-09-28T10:00:00Z') }),
      complete: jest.fn().mockResolvedValue(true),
      pendingReview: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    };
    const brief = {
      id: 'brief_ref', opportunity_id: 'opp_ref', action_type: 'refresh_existing_page', page_type: 'refresh',
      target_url: '/pest-control/signs-of-termites/', target_keyword: 'signs of termites', city: 'Sarasota', service: 'termite',
      human_review_required: false,
    };
    const dispatcher = { runWithBrief: jest.fn().mockResolvedValue({ ok: false, reason: 'test_stop_after_dispatch' }) };
    const factsSufficiency = { check: jest.fn().mockResolvedValue({ applicable: true, sufficient: true, city_id: 'sarasota', service_id: 'termite', county: 'sarasota' }) };
    const runner = loadRunnerWith({ queue, briefBuilder: { compose: jest.fn().mockResolvedValue(brief) }, dispatcher, publisher, factsSufficiency });
    return { runner, dispatcher };
  };

  test('a refresh session gets the hydrated options: live domains, protected metaTitle, live meta, prior body', async () => {
    const publisher = {
      getLiveFrontmatter: jest.fn().mockResolvedValue({
        _astro_source_path: 'src/content/services/pest-control-sarasota-fl.md',
        domains: ['sarasotaflpestcontrol.com'],
        metaTitle: 'Pest Control Near Me | Sarasota',
        metaDescription: 'Live Sarasota meta.',
      }),
      loadExistingPageBody: jest.fn().mockResolvedValue({ body: 'Live prior body.', word_count: 3, frontmatter: {} }),
    };
    const { runner, dispatcher } = setup(publisher);
    await runner.runNext();
    expect(dispatcher.runWithBrief).toHaveBeenCalledTimes(1);
    expect(dispatcher.runWithBrief.mock.calls[0][1].selfLintOptions).toMatchObject({
      isRefresh: true,
      domains: ['sarasotaflpestcontrol.com'],
      liveMetaTitle: 'Pest Control Near Me | Sarasota',
      liveMetaDescription: 'Live Sarasota meta.',
      priorBody: 'Live prior body.',
      targetIsBlog: false,
    });
  });

  test('a hydration failure disarms only the lint: the session still runs and gate 3c stays authoritative', async () => {
    const publisher = {
      getLiveFrontmatter: jest.fn().mockResolvedValue({ _astro_source_path: 'src/content/services/pest-control-sarasota-fl.md', domains: [] }),
      loadExistingPageBody: jest.fn().mockRejectedValue(new Error('github unavailable')),
    };
    const { runner, dispatcher } = setup(publisher);
    await runner.runNext();
    expect(dispatcher.runWithBrief).toHaveBeenCalledTimes(1);
    expect(dispatcher.runWithBrief.mock.calls[0][1].selfLintOptions).toBeNull();
  });

  test('the kill switch disarms the lint for refreshes too', async () => {
    const prev = process.env.AUTONOMOUS_WRITER_SELF_LINT;
    process.env.AUTONOMOUS_WRITER_SELF_LINT = 'false';
    try {
      const publisher = {
        getLiveFrontmatter: jest.fn().mockResolvedValue({ _astro_source_path: 'src/content/services/pest-control-sarasota-fl.md', domains: [] }),
        loadExistingPageBody: jest.fn().mockResolvedValue({ body: 'Live prior body.', word_count: 3, frontmatter: {} }),
      };
      const { runner, dispatcher } = setup(publisher);
      await runner.runNext();
      expect(dispatcher.runWithBrief.mock.calls[0][1].selfLintOptions).toBeNull();
      expect(publisher.loadExistingPageBody).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.AUTONOMOUS_WRITER_SELF_LINT;
      else process.env.AUTONOMOUS_WRITER_SELF_LINT = prev;
    }
  });
});

describe('citability backfill retry feedback — every gate\'s one redraft hears the completion contract', () => {
  const BRIEF = {
    id: 'brief_cb', action_type: 'refresh_existing_page', page_type: 'refresh', target_url: '/termite/ants/',
    gsc_signal: { bucket: 'citability_backfill', citability_gaps: ['named_sources'] },
  };
  function load(publisher) {
    jest.dontMock('../services/content/content-quality-gate');
    return loadRunnerWith({ queue: {}, briefBuilder: {}, dispatcher: {}, publisher });
  }
  function livePublisher() {
    return {
      loadExistingPageBody: jest.fn().mockResolvedValue({ body: 'Experts say ants trail after rain. Wait 14 days.', frontmatter: {}, source_file: 'src/content/blog/termite/ants.mdx' }),
      resolveExistingAstroFileForTarget: jest.fn().mockResolvedValue({ path: 'src/content/blog/termite/ants.mdx' }),
    };
  }
  async function retryData(runner, run, blocking, extra = {}) {
    const bounded = jest.spyOn(runner, '_boundedRetryOrSkip').mockResolvedValue({ outcome: 'deferred_gate_retry' });
    await runner._gateFailRetryOrSkip({}, { id: 'opp_cb' }, run, 0, jest.fn(), {
      claimToken: 't', skipReason: 'content_guardrails_failed', notes: 'n', blocking, ...extra,
    });
    return bounded.mock.calls[0][5].retryData;
  }

  test('an early-gate retry judges the draft against the live page: hard gap finding + signals', async () => {
    const publisher = livePublisher();
    const runner = load(publisher);
    const data = await retryData(runner, {
      citability_backfill_brief: BRIEF,
      draft_payload: { title: 'Ants', body: 'Experts say ants trail after rain.' },
    }, [{ severity: 'P1', code: 'HARDCODED_PRICE', message: 'price' }]);
    expect(publisher.loadExistingPageBody).toHaveBeenCalledWith('/termite/ants/');
    expect(data.findings.map((f) => f.code)).toEqual(['HARDCODED_PRICE', 'CITABILITY_BACKFILL_GAPS_CLEARED']);
    expect(data.findings[1].message).toMatch(/^planned_gaps_unresolved:named_sources\(/);
    // The dropped "14 days" is only visible against the live page.
    expect(data.advisory_messages.map((m) => m.code)).toEqual(expect.arrayContaining(['CITABILITY_NAMED_SOURCES', 'CITABILITY_CONCRETE_SPECIFICS']));
    expect(data.advisory_messages.find((m) => m.code === 'CITABILITY_CONCRETE_SPECIFICS').message).toBe('refresh_dropped_measurements_1_to_0');
  });

  test('after the quality gate ran, its own verdict is reused (no second page load)', async () => {
    const publisher = livePublisher();
    const runner = load(publisher);
    const qualityResult = {
      ok: false,
      hard_failures: [{ name: 'citability_backfill_gaps_cleared', reason: 'citability_traits_regressed:comparison' }],
      soft_failures: [{ name: 'citability_how_to_choose', reason: 'no_how_to_choose_section' }],
    };
    const advisoryMessages = citabilityAdvisoryMessages(qualityResult);
    const data = await retryData(runner, {
      citability_backfill_brief: BRIEF, quality_gate_result: qualityResult, draft_payload: { body: 'x' },
    }, [{ severity: 'P1', code: 'QUALITY_GATE', message: 'failed' }], { advisoryMessages });
    expect(publisher.loadExistingPageBody).not.toHaveBeenCalled();
    expect(data.findings).toEqual([
      { severity: 'P1', code: 'QUALITY_GATE', message: 'failed' },
      { severity: 'P1', code: 'CITABILITY_BACKFILL_GAPS_CLEARED', message: 'citability_traits_regressed:comparison' },
    ]);
    expect(data.advisory_messages).toEqual([{ code: 'CITABILITY_HOW_TO_CHOOSE', message: 'no_how_to_choose_section' }]);
  });

  test('a cleared draft adds nothing; other runs are untouched', async () => {
    const publisher = livePublisher();
    const runner = load(publisher);
    const cleared = await retryData(runner, {
      citability_backfill_brief: BRIEF,
      draft_payload: { body: 'Per UF/IFAS, ants trail after rain. Wait 14 days.' },
    }, [{ severity: 'P1', code: 'HARDCODED_PRICE', message: 'price' }]);
    expect(cleared.findings.map((f) => f.code)).toEqual(['HARDCODED_PRICE']);
    runner._boundedRetryOrSkip.mockRestore();
    publisher.loadExistingPageBody.mockClear();
    const other = await retryData(runner, { draft_payload: { body: 'Experts say.' } }, [{ severity: 'P1', code: 'HARDCODED_PRICE', message: 'price' }]);
    expect(publisher.loadExistingPageBody).not.toHaveBeenCalled();
    expect(other).toEqual({ findings: [{ severity: 'P1', code: 'HARDCODED_PRICE', message: 'price' }], advisory_messages: [] });
  });

  test('an unreadable live page still carries the planned-gap finding (never throws)', async () => {
    const publisher = { loadExistingPageBody: jest.fn().mockRejectedValue(new Error('github down')) };
    const runner = load(publisher);
    const data = await retryData(runner, {
      citability_backfill_brief: BRIEF, draft_payload: { body: 'Experts say ants trail.' },
    }, []);
    expect(data.findings.map((f) => f.code)).toEqual(['CITABILITY_BACKFILL_GAPS_CLEARED']);
  });

  test('the completion finding renders as a binding redraft directive', () => {
    const { GATE_RETRY_INSTRUCTIONS, buildRetryDirectives } = require('../services/content/gate-retry-directives');
    expect(GATE_RETRY_INSTRUCTIONS.CITABILITY_BACKFILL_GAPS_CLEARED).toMatch(/never invent a source or a number/);
    const lines = buildRetryDirectives({ findings: [{ severity: 'P1', code: 'CITABILITY_BACKFILL_GAPS_CLEARED', message: 'planned_gaps_unresolved:comparison(structure_missing)' }] });
    expect(lines[1]).toContain('[Gate reported: planned_gaps_unresolved:comparison(structure_missing)]');
  });
});
