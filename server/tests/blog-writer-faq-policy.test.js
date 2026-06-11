/**
 * Generator-side FAQ policy tests.
 *
 * Bug: blog-writer's generatePost prompt unconditionally required a final
 * "Frequently Asked Questions" section, while content-guardrails P0-blocks
 * any FAQ section on FAQ-blocked services at publish ("Rodents"→rodent,
 * "Termites"→termite, "Spiders"→spider, "Bed Bugs"→bed-bug, …). Every
 * generated post in those tags was deterministically unpublishable
 * (BLOG_GUARDRAILS_FAILED → publish_failed).
 *
 * Fix: the generator conditions its FAQ instruction on the SAME exported
 * helper/blocklist the guardrail enforces (content-guardrails
 * isFaqBlockedService / FAQ_BLOCKED_SERVICES) — single source of truth, the
 * two sides can never drift. Same conditionality applies to the autonomous
 * writer-agent-config supporting-blog instructions.
 */

jest.mock('../models/db', () => jest.fn());

const guardrails = require('../services/content/content-guardrails');
const { _internals } = require('../services/content/blog-writer');
const { WRITER_AGENT_CONFIG } = require('../services/content/agents/writer-agent-config');

const {
  faqFormatInstruction,
  FAQ_SECTION_INSTRUCTION,
  NO_FAQ_SECTION_INSTRUCTION,
  BLOG_TAGS,
} = _internals;

describe('blog-writer faqFormatInstruction', () => {
  test('emits the NO-FAQ instruction for every FAQ-blocked service id', () => {
    for (const id of guardrails.FAQ_BLOCKED_SERVICES) {
      expect(faqFormatInstruction(id)).toBe(NO_FAQ_SECTION_INSTRUCTION);
    }
  });

  test('emits the NO-FAQ instruction for the four blocked display tags via [category, tag]', () => {
    for (const tag of ['Rodents', 'Termites', 'Spiders', 'Bed Bugs']) {
      const instruction = faqFormatInstruction(['pest-control', tag]);
      expect(instruction).toBe(NO_FAQ_SECTION_INSTRUCTION);
      expect(instruction).toMatch(/Do NOT include any FAQ section/);
      expect(instruction).toMatch(/Frequently Asked Questions/);
    }
  });

  test('keeps the FAQ requirement for non-blocked tags', () => {
    for (const tag of ['Mosquitoes', 'Ants', 'Roaches', 'Pest Control', 'Lawn Care', 'Lawn Disease', 'Fleas & Ticks']) {
      const instruction = faqFormatInstruction(['pest-control', tag]);
      expect(instruction).toBe(FAQ_SECTION_INSTRUCTION);
      expect(instruction).toMatch(/Include a final "Frequently Asked Questions" section/);
    }
  });

  test('can never drift from the publish guard: agrees with isFaqBlockedService for every blog tag', () => {
    for (const tag of BLOG_TAGS) {
      const fields = ['pest-control', tag];
      const expected = guardrails.isFaqBlockedService(fields)
        ? NO_FAQ_SECTION_INSTRUCTION
        : FAQ_SECTION_INSTRUCTION;
      expect(faqFormatInstruction(fields)).toBe(expected);
    }
  });
});

describe('writer-agent-config FAQ policy (autonomous supporting blogs)', () => {
  const system = WRITER_AGENT_CONFIG.system;

  test('system prompt carries a binding FAQ POLICY block', () => {
    expect(system).toContain('FAQ POLICY');
    expect(system).toContain('must contain NO FAQ section');
  });

  test('FAQ POLICY lists every blocked service id from content-guardrails (single source of truth)', () => {
    for (const id of guardrails.FAQ_BLOCKED_SERVICES) {
      expect(system).toContain(id);
    }
  });

  test('supporting-blog FAQ requirement is conditional on the policy, not unconditional', () => {
    expect(system).toMatch(/UNLESS the FAQ POLICY below blocks it[\s\S]*Frequently Asked Questions/);
  });

  test('city-service FAQ instruction is also subject to the policy', () => {
    expect(system).toMatch(/FAQ from customer_signal \(subject to the FAQ\s+POLICY below\)/);
  });
});
