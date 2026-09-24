/**
 * Contract for autonomous writer quality: visuals and factual detail must be
 * article-specific and traceable instead of quota-driven template filler.
 */

jest.mock('../models/db', () => jest.fn());

const { WRITER_AGENT_CONFIG } = require('../services/content/agents/writer-agent-config');

describe('writer-agent-config editorial evidence policy', () => {
  const prompt = WRITER_AGENT_CONFIG.system;

  test('preserves autonomous affiliate publishing and approval boundaries', () => {
    expect(prompt).toMatch(/autonomous supporting blogs need\nno per-post owner approval/);
    expect(prompt).toMatch(/Other content lanes\nretain their approval requirements/);
    expect(prompt).not.toContain('every affiliate post is held');
  });

  test('requires supported numeric claims without manufacturing a statistics quota', () => {
    expect(prompt).toContain('There is NO quota for statistics');
    expect(prompt).toMatch(/numeric factual claim only when[\s\S]*directly supports/);
    expect(prompt).toMatch(/date or study period[\s\S]*relevant scope/);
    expect(prompt).toContain('never write that it was "verified," "confirmed," or');
    expect(prompt).toContain('A paraphrased customer_signal is a topic clue');
    expect(prompt).toMatch(/WHEN those\n  details are supplied in the evidence or verified/);
    expect(prompt).toContain('A facts_pack may omit source metadata: never invent');
    expect(prompt).toMatch(/missing context\n  is essential.*omit the numeric claim/);
  });

  test('makes visuals evidence-driven and forbids generic component defaults', () => {
    expect(prompt).toContain('There is NO visual quota');
    expect(prompt).toMatch(/Every factual claim in a label[\s\S]*comparison cell must be supported/);
    expect(prompt).toMatch(/<SeasonalPressureChart \/>[\s\S]*NEVER emit it bare/);
    expect(prompt).toMatch(/<HomeZoneMap \/>[\s\S]*NEVER emit it bare/);
    expect(prompt).toMatch(/<PestEvidenceGrid \/>[\s\S]*NEVER emit it bare/);
    expect(prompt).not.toContain('aim for 1–3 per post');
    expect(prompt).not.toContain('prefer it BARE');
  });

  test('requires useful listicle tradeoffs without fabricated testing claims', () => {
    expect(prompt).toMatch(/For a listicle or comparison[\s\S]*criterion[\s\S]*limitation or[\s\S]*tradeoff/);
    expect(prompt).toMatch(/Researching\s+public sources is not product testing/);
    expect(prompt).toMatch(/Never imply Waves tested the options[\s\S]*documented comparison methodology/);
  });

  test('permits a category buying checklist without inventing provider attributes', () => {
    expect(prompt).toMatch(/Neutral editorial criteria and questions to ask[\s\S]*without provider-specific evidence/);
    expect(prompt).toMatch(/Without evidence for a category's attributes,[\s\S]*cells are questions or verification steps/);
    expect(prompt).toContain('never unsupported yes/no claims, ratings,');
    expect(prompt).toMatch(/factual category attributes still require the evidence/);
    expect(prompt).not.toContain('Needs no special data');
  });

  test('allows mandated secondary evidence while preserving attribution and claim limits', () => {
    expect(prompt).toMatch(/Explicitly brief-mandated secondary sources are also permitted[\s\S]*link the exact allowed page/);
    expect(prompt).toMatch(/attribute its reporting or consumer[\s\S]*allegations to that source/);
    expect(prompt).toMatch(/without presenting allegations as established[\s\S]*facts/);
    expect(prompt).toContain('If no\n  allowed source or brief fact supports a claim, omit the claim');
    expect(prompt).not.toContain('If no permitted primary-source URL');
  });

  test('describes the outbound-link guard and primary-source verification accurately', () => {
    expect(prompt).toMatch(/exact source URL supplied by the brief \/ facts[\s\S]*\.gov, ufl\.edu/);
    expect(prompt).toContain('web-search discovery\n  by itself as approval');
    expect(prompt).toMatch(/Prefer primary sources[\s\S]*responsible government[\s\S]*original study/);
    expect(prompt).toContain('a search result is discovery, not verification');
  });
});
