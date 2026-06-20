/**
 * Generator-side title/meta anti-spam policy tests (Bucket B).
 *
 * Bug: the autonomous writer-agent-config prompt gave the writer no guidance
 * about the title/meta spam gate beyond length, so it would naturally emit
 * marketing-shaped titles ("Best Exterminator Near Me…", stacked adjectives,
 * repeated keywords). The content-quality-gate HARD check `title_meta_spam_free`
 * (title-meta-spam-gate.evaluateTitleMetaSpam) then hard-fails the WHOLE draft
 * on EVERY page type — the generation is wasted exactly like a length overflow.
 *
 * Fix: the prompt now interpolates the SAME exported term lists the gate checks
 * (HYPE_TERMS / COMMERCIAL_TERMS) plus the explicit one-off rules, so the
 * writer's instructions can never drift from publish-time enforcement.
 */

jest.mock('../models/db', () => jest.fn());

const { HYPE_TERMS, COMMERCIAL_TERMS } = require('../services/content/title-meta-spam-gate');
const { WRITER_AGENT_CONFIG } = require('../services/content/agents/writer-agent-config');

describe('writer-agent-config title/meta anti-spam policy (autonomous drafts)', () => {
  const system = WRITER_AGENT_CONFIG.system;

  test('system prompt carries a binding TITLE + META ANTI-SPAM block', () => {
    expect(system).toContain('TITLE + META ANTI-SPAM');
    expect(system).toMatch(/hard-fails the\s+WHOLE draft/);
  });

  test('lists every HYPE_TERM from the gate verbatim (single source of truth)', () => {
    expect(system).toContain(HYPE_TERMS.join(', '));
    for (const term of HYPE_TERMS) {
      expect(system).toContain(term);
    }
  });

  test('lists every COMMERCIAL_TERM from the gate verbatim (single source of truth)', () => {
    expect(system).toContain(COMMERCIAL_TERMS.join(', '));
    for (const term of COMMERCIAL_TERMS) {
      expect(system).toContain(term);
    }
  });

  test('spells out the one-off hard fails the gate enforces (the best / near me / pipes)', () => {
    expect(system).toMatch(/"the best"/);
    expect(system).toMatch(/"near me"/);
    expect(system).toMatch(/ONE "\|" pipe/);
  });

  test('warns against repeating keyword/commercial terms (title_repeats_term / title_repeats_phrase)', () => {
    expect(system).toMatch(/repeat the primary keyword, city, service, or target keyword/);
    expect(system).toMatch(/repeat a commercial phrase/);
  });

  test('FAQ schema must match visible content (P0_FAQ_SCHEMA_WITHOUT_VISIBLE_FAQ)', () => {
    expect(system).toMatch(/never emit FAQPage \/ faqPage structured\s+data unless/);
  });
});
