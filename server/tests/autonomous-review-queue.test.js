jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  appendReviewerNote,
  buildReviewItem,
  isTrustBuildRun,
  normalizeDecision,
  normalizeLimit,
  normalizeStatus,
  parseJsonMaybe,
  reviewActions,
  isNamedCompetitorReviewRun,
  summarizeDraft,
  summarizeGates,
  summarizeSeoCompletion,
} = require('../services/content/autonomous-review-queue');

describe('autonomous-review-queue read model helpers', () => {
  test('normalizes public query controls', () => {
    expect(normalizeStatus('pending_review')).toBe('pending_review');
    expect(normalizeStatus('not-real')).toBe('pending_review');
    expect(normalizeDecision('requeue')).toBe('requeue');
    expect(() => normalizeDecision('publish_now')).toThrow(/decision must be one of/);
    expect(normalizeLimit('25')).toBe(25);
    expect(normalizeLimit('500')).toBe(100);
    expect(normalizeLimit('bad')).toBe(50);
  });

  test('surfaces comparison-table gate findings in the gate summary', () => {
    const cmp = {
      pass: false,
      findings: [{ severity: 'P0', code: 'COMPARISON_UNKNOWN_COMPETITOR', message: 'Names "Hulett", ...' }],
    };
    const summary = summarizeGates({ ok: true }, { ok: true }, cmp);
    expect(summary.comparison_ok).toBe(false);
    expect(summary.comparison_findings).toEqual([
      { severity: 'P0', code: 'COMPARISON_UNKNOWN_COMPETITOR', message: 'Names "Hulett", ...' },
    ]);
  });

  test('comparison_ok is null when the comparison gate did not run', () => {
    expect(summarizeGates({ ok: true }, { ok: true }, {}).comparison_ok).toBeNull();
    expect(summarizeGates({ ok: true }, { ok: true }).comparison_ok).toBeNull();
  });

  test('named-competitor review runs are approve-and-publish, not trust-build credit', () => {
    const named = { outcome: 'completed_pending_review', shadow_mode: false, skip_reason: 'named_competitor_review' };
    expect(isNamedCompetitorReviewRun(named)).toBe(true);
    expect(isTrustBuildRun(named)).toBe(false); // must NOT be approvable via trust-build (that wouldn't publish)

    const trust = { outcome: 'completed_pending_review', shadow_mode: false, skip_reason: 'trust_build_1_of_3' };
    expect(isNamedCompetitorReviewRun(trust)).toBe(false);
    expect(isTrustBuildRun(trust)).toBe(true);

    // Shadow / wrong-outcome runs are not approvable.
    expect(isNamedCompetitorReviewRun({ ...named, shadow_mode: true })).toBe(false);
  });

  test('reviewActions exposes can_approve_named_competitor only for those pending runs', () => {
    const opp = { status: 'pending_review' };
    const named = { outcome: 'completed_pending_review', shadow_mode: false, skip_reason: 'named_competitor_review' };
    const a = reviewActions({ opportunity: opp, run: named });
    expect(a.can_approve_named_competitor).toBe(true);
    expect(a.can_approve_trust_build).toBe(false);

    const trust = { outcome: 'completed_pending_review', shadow_mode: false, skip_reason: 'trust_build_1_of_3' };
    const b = reviewActions({ opportunity: opp, run: trust });
    expect(b.can_approve_named_competitor).toBe(false);
    expect(b.can_approve_trust_build).toBe(true);
  });

  test('parses JSON columns with fallback', () => {
    expect(parseJsonMaybe('{"ok":true}', {})).toEqual({ ok: true });
    expect(parseJsonMaybe('{bad json', { ok: false })).toEqual({ ok: false });
    expect(parseJsonMaybe({ already: 'object' }, {})).toEqual({ already: 'object' });
  });

  test('summarizes drafts without returning full body by default', () => {
    const draft = summarizeDraft({
      title: 'Draft title',
      slug: 'draft-title',
      url: '/blog/draft-title/',
      body: 'x'.repeat(900),
    });
    expect(draft.title).toBe('Draft title');
    expect(draft.body_length).toBe(900);
    expect(draft.body_preview).toHaveLength(700);
    expect(Object.prototype.hasOwnProperty.call(draft, 'body')).toBe(true);
    expect(draft.body).toBeUndefined();
  });

  test('buildReviewItem merges queue, latest brief, latest run, gates, and draft', () => {
    const item = buildReviewItem({
      opportunity: {
        id: 'opp-1',
        status: 'pending_review',
        bucket: 'local_gap',
        action_type: 'new_supporting_blog',
        query: 'lawn pest control service',
        page_url: null,
        city: 'Bradenton',
        service: 'lawn',
        score: 48,
        score_breakdown: '{"intent":20}',
        signal_metadata: '{"source":"gsc"}',
        skip_reason: 'shadow_would_gate',
      },
      brief: {
        id: 'brief-1',
        version: 1,
        opportunity_id: 'opp-1',
        action_type: 'new_supporting_blog',
        target_keyword: 'lawn pest control service',
        target_url: '/blog/lawn-pest-control-service/',
        page_type: 'supporting-blog',
        final_score: 52,
        human_review_required: false,
        serp_signal: '{"dominant_intent":"informational"}',
        gsc_signal: '{"impressions":300}',
        required_sections: '["FAQ"]',
        internal_links_to_add: '[]',
      },
      run: {
        id: 'run-1',
        outcome: 'skipped_shadow_mode',
        shadow_mode: true,
        skip_reason: 'shadow_would_gate',
        quality_gate_result: '{"ok":false,"total_score":50,"min_total_score":54,"hard_failures":[{"name":"title_meta_spam_free"}],"soft_failures":[],"seo_completion":{"passed":true,"score":88,"summary":{"p0":0,"p1":1,"p2":0},"findings":[{"severity":"P1","code":"P1_MISSING_SERVICE_LINK","message":"Missing service link"}],"contract":{"internalLinks":[],"internalLinkRecommendations":[{"url":"/contact/","anchorText":"request a quote","reason":"conversion","required":true}],"breadcrumbs":[{"name":"Home","url":"/"},{"name":"Waves Blog","url":"/blog/"},{"name":"Draft","url":"/draft/"}],"faq":[{"question":"Q?","answer":"Answer"}],"schema":{"article":true,"breadcrumb":true,"faqPage":true},"reviewFlags":["missing_service_link"]}}}',
        uniqueness_gate_result: '{"ok":true}',
        draft_payload: '{"title":"Draft","body":"Draft body","seo_contract":{"internalLinks":[{"url":"/contact/","anchorText":"request a quote","reason":"conversion","required":true}]}}',
      },
    });

    expect(item.action_type).toBe('new_supporting_blog');
    expect(item.target_keyword).toBe('lawn pest control service');
    expect(item.brief.serp_signal.dominant_intent).toBe('informational');
    expect(item.run.gate_summary.hard_failures).toEqual(['title_meta_spam_free']);
    expect(item.run.gate_summary.seo_completion_ok).toBe(true);
    expect(item.run.seo_completion).toMatchObject({
      available: true,
      p0: 0,
      p1: 1,
      recommended_links: [expect.objectContaining({ url: '/contact/' })],
    });
    expect(item.draft.title).toBe('Draft');
    expect(item.review_actions).toMatchObject({
      can_requeue: true,
      can_dismiss: true,
      can_approve_trust_build: false,
    });
  });

  test('recognizes live trust-build runs as approvable', () => {
    expect(isTrustBuildRun({
      outcome: 'completed_pending_review',
      shadow_mode: false,
      skip_reason: 'trust_build_2_of_3',
    })).toBe(true);
    expect(isTrustBuildRun({
      outcome: 'completed_pending_review',
      shadow_mode: true,
      skip_reason: 'trust_build_2_of_3',
    })).toBe(false);
    expect(isTrustBuildRun({
      outcome: 'completed_pending_review',
      shadow_mode: false,
      skip_reason: 'gate_fail',
    })).toBe(false);
  });

  test('appends bounded reviewer trail notes', () => {
    const note = appendReviewerNote('Existing note', {
      decision: 'dismiss',
      reviewer: 'adam',
      note: 'not worth doing',
      now: new Date('2026-05-24T12:00:00Z'),
    });
    expect(note).toContain('Existing note');
    expect(note).toContain('[2026-05-24T12:00:00.000Z] adam: dismiss');
    expect(note).toContain('not worth doing');
  });

  test('summarizes SEO completion from a persisted gate result', () => {
    const summary = summarizeSeoCompletion({
      passed: false,
      score: 40,
      summary: { p0: 1, p1: 2, p2: 1 },
      findings: [{ severity: 'P0', code: 'P0_FAQ_SCHEMA_WITHOUT_VISIBLE_FAQ' }],
      contract: {
        internalLinks: [{ url: '/contact/', anchorText: 'request a quote', reason: 'conversion', required: true }],
        faq: [],
        breadcrumbs: [],
        schema: { article: true, breadcrumb: true, faqPage: true },
        reviewFlags: ['faq_schema_without_visible_faq'],
      },
    });

    expect(summary).toMatchObject({
      available: true,
      passed: false,
      score: 40,
      p0: 1,
      p1: 2,
      p2: 1,
      recommended_links: [expect.objectContaining({ url: '/contact/' })],
      review_flags: ['faq_schema_without_visible_faq'],
    });
  });

  test('preserves SEO gate failures that do not include a contract', () => {
    const summary = summarizeSeoCompletion({
      passed: false,
      score: 0,
      summary: { p0: 1, p1: 0, p2: 0 },
      findings: [{
        severity: 'P0',
        code: 'P0_SEO_COMPLETION_GATE_UNAVAILABLE',
        message: 'SEO completion gate is unavailable.',
      }],
    });

    expect(summary).toMatchObject({
      available: true,
      passed: false,
      score: 0,
      p0: 1,
      findings: [expect.objectContaining({ code: 'P0_SEO_COMPLETION_GATE_UNAVAILABLE' })],
    });
  });
});
