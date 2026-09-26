/**
 * Writer-prompt ↔ quality-gate parity for the citability nudges (2026-09-25).
 *
 * The four weight-0 supporting-blog checks (citability_*) are only useful if
 * the writer is told the same rules under the same codes, so the redraft
 * feedback ("quality nudges (non-blocking): citability_comparison") maps to
 * an instruction it has already read. This pins that parity and the two
 * guardrails the section must never loosen: no stat quota, no invented
 * sources.
 */

jest.mock('../models/db', () => jest.fn());

const { WRITER_AGENT_CONFIG } = require('../services/content/agents/writer-agent-config');
const { PAGE_TYPE_CHECKS } = require('../services/content/content-quality-gate')._internals;

describe('writer-agent-config CITABILITY section', () => {
  const system = WRITER_AGENT_CONFIG.system;

  test('carries a CITABILITY block with every gate nudge code', () => {
    expect(system).toContain('CITABILITY');
    const codes = PAGE_TYPE_CHECKS['supporting-blog']
      .filter((c) => c.name.startsWith('citability_'))
      .map((c) => `[${c.name.toUpperCase()}]`);
    expect(codes).toHaveLength(4);
    for (const code of codes) expect(system).toContain(code);
  });

  test('keeps the no-quota and no-invented-source guardrails explicit', () => {
    expect(system).toMatch(/This is not a quota/);
    expect(system).toMatch(/There is NO quota for statistics/);
    expect(system).toMatch(/Never invent an\s+agency, publication, program, or business/);
    expect(system).toMatch(/never a dollar amount/);
  });

  test('ties the comparison and how-to-choose rules to the ComparisonTable CATEGORY mode', () => {
    expect(system).toMatch(/render ONE <ComparisonTable> in CATEGORY mode/);
    expect(system).toMatch(/H2 that reads\s+"How to choose/);
    expect(system).toMatch(/Do NOT bolt a generic "DIY vs pro" table/);
  });
});
