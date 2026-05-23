jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  buildReviewItem,
  normalizeLimit,
  normalizeStatus,
  parseJsonMaybe,
  summarizeDraft,
} = require('../services/content/autonomous-review-queue');

describe('autonomous-review-queue read model helpers', () => {
  test('normalizes public query controls', () => {
    expect(normalizeStatus('pending_review')).toBe('pending_review');
    expect(normalizeStatus('not-real')).toBe('pending_review');
    expect(normalizeLimit('25')).toBe(25);
    expect(normalizeLimit('500')).toBe(100);
    expect(normalizeLimit('bad')).toBe(50);
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
        quality_gate_result: '{"ok":false,"total_score":50,"min_total_score":54,"hard_failures":[{"name":"title_meta_spam_free"}],"soft_failures":[]}',
        uniqueness_gate_result: '{"ok":true}',
        draft_payload: '{"title":"Draft","body":"Draft body"}',
      },
    });

    expect(item.action_type).toBe('new_supporting_blog');
    expect(item.target_keyword).toBe('lawn pest control service');
    expect(item.brief.serp_signal.dominant_intent).toBe('informational');
    expect(item.run.gate_summary.hard_failures).toEqual(['title_meta_spam_free']);
    expect(item.draft.title).toBe('Draft');
  });
});
