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

// Round 8 (Codex P2): the writer prompt told the writer to emit
// confidence="high"|"moderate"|"situational" on <BottomLineBox>, but the
// synchronized component contract (packages/blog-schema schema.ts
// confidenceEnum) accepts ONLY high|medium|low — a draft following the
// prompt failed component-prop validation in the Astro pipeline. The prompt
// must only ever instruct schema-valid values.
describe('writer-agent-config BottomLineBox confidence values (component contract)', () => {
  const system = WRITER_AGENT_CONFIG.system;

  test('instructs exactly the schema enum values high|medium|low', () => {
    expect(system).toMatch(/confidence="high"\|"medium"\|"low"/);
  });

  test('never suggests values the component contract rejects', () => {
    expect(system).not.toMatch(/"moderate"/);
    expect(system).not.toMatch(/"situational"/);
  });

  test('every quoted confidence value in the prompt is schema-valid', () => {
    const valid = new Set(['high', 'medium', 'low']); // packages/blog-schema schema.ts confidenceEnum
    const mentions = system.match(/confidence="[^"]+"(?:\|"[^"]+")*/g) || [];
    expect(mentions.length).toBeGreaterThan(0);
    for (const mention of mentions) {
      for (const [, value] of mention.matchAll(/"([^"]+)"/g)) {
        expect(valid.has(value)).toBe(true);
      }
    }
  });
});
