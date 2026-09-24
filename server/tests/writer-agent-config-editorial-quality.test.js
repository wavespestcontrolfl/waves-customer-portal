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
  });

  test('makes visuals evidence-driven and forbids generic component defaults', () => {
    expect(prompt).toContain('There is NO visual quota');
    expect(prompt).toMatch(/Every label, level, zone, item, caption, and comparison cell[\s\S]*must be supported/);
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

  test('describes the outbound-link guard and primary-source verification accurately', () => {
    expect(prompt).toMatch(/exact source URL supplied by the brief \/ facts[\s\S]*\.gov, ufl\.edu/);
    expect(prompt).toContain('web-search discovery\n  by itself as approval');
    expect(prompt).toMatch(/Prefer primary sources[\s\S]*responsible government[\s\S]*original study/);
    expect(prompt).toContain('a search result is discovery, not verification');
  });
});
