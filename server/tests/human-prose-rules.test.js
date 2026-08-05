/**
 * HUMAN PROSE RULES — owner-authored anti-AI-tell style block (2026-07-30).
 *
 * The contract these tests pin: the block reaches every LONG-FORM
 * customer-facing prose prompt (blog writer, content refresher, all four
 * service-report narratives, social/GBP captions incl. the campaign studio),
 * declares itself style-only (never overriding compliance/grounding rules),
 * and the cached narrative lanes bumped their PROMPT_VERSION so stale
 * pre-rules copy regenerates. Deliberately NOT injected: newsletter share
 * captions (hype-on-purpose lane) and the meta rewriter (PR #3063 contract).
 */
const { HUMAN_PROSE_RULES } = require('../services/llm/human-prose-rules');

describe('HUMAN_PROSE_RULES — the block itself', () => {
  test('carries the owner list and the style-only supremacy clause', () => {
    expect(HUMAN_PROSE_RULES).toContain('HUMAN PROSE RULES');
    expect(HUMAN_PROSE_RULES).toMatch(/never override safety, compliance, grounding/i);
    for (const marker of [
      'No antithesis', 'No rule of three', 'No em dashes',
      'No summary beats', 'setup/payoff', 'Vary sentence length unpredictably',
      'No filler intensifiers', 'No nominalization', 'spoken voice',
      'No performed enthusiasm', 'No parataxis', 'No paragraph pinning',
    ]) {
      expect(HUMAN_PROSE_RULES).toContain(marker);
    }
  });
});

describe('injection — every long-form prose prompt carries the block', () => {
  test('blog writer + content refresher system prompts', () => {
    const { WRITER_AGENT_CONFIG } = require('../services/content/agents/writer-agent-config');
    const { REFRESH_AGENT_CONFIG } = require('../services/content/agents/refresh-agent-config');
    expect(WRITER_AGENT_CONFIG.system).toContain('HUMAN PROSE RULES');
    expect(REFRESH_AGENT_CONFIG.system).toContain('HUMAN PROSE RULES');
  });

  test('service-report narratives, with PROMPT_VERSION bumps (cached lanes must regenerate)', () => {
    const visit = require('../services/service-report/visit-summary-narrative');
    const lawn = require('../services/service-report/lawn-report-narrative');
    const rodent = require('../services/service-report/rodent-report-narrative');
    const treatment = require('../services/service-report/treatment-narrative');

    expect(visit._test.PROMPT_VERSION).toBe('pest_visit_summary_narrative_v2');
    expect(visit._test.SYSTEM_PROMPT).toContain('HUMAN PROSE RULES');
    expect(lawn._test.PROMPT_VERSION).toBe('lawn_report_v2_narrative_v4');
    expect(lawn._test.SYSTEM_PROMPT).toContain('HUMAN PROSE RULES');
    expect(rodent._test.PROMPT_VERSION).toBe('typed_report_narrative_v4');
    expect(rodent._test.SYSTEM_PROMPT).toContain('HUMAN PROSE RULES');
    expect(treatment.PROMPT_VERSION).toBe('treatment_narrative_v3');
    expect(treatment.buildTreatmentNarrativePrompt({ serviceLine: 'pest', products: [], findingsText: '', photoSummary: '' }))
      .toContain('HUMAN PROSE RULES');
  });

  test('social/GBP caption prompts (autonomous GBP posts route through generateContent)', () => {
    const src = require('fs').readFileSync(require.resolve('../services/social-media'), 'utf8');
    // one injection at the generateContent compose point, one in the campaign studio
    expect((src.match(/HUMAN_PROSE_RULES/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  test('legacy/scheduled blog path + field-photo captions carry the block too (codex r1)', () => {
    const blogWriter = require('fs').readFileSync(require.resolve('../services/content/blog-writer'), 'utf8');
    const techCaption = require('fs').readFileSync(require.resolve('../services/tech-social-caption'), 'utf8');
    expect(blogWriter).toContain('HUMAN_PROSE_RULES');
    expect(techCaption).toContain('HUMAN_PROSE_RULES');
  });

  test('deliberate NON-injections stay clean: newsletter captions + meta rewriter', () => {
    const scheduler = require('fs').readFileSync(require.resolve('../services/content-scheduler'), 'utf8');
    const meta = require('fs').readFileSync(require.resolve('../services/content/agents/meta-rewriter-config'), 'utf8');
    expect(scheduler).not.toContain('HUMAN_PROSE_RULES');
    expect(meta).not.toContain('HUMAN_PROSE_RULES');
  });
});
