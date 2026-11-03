/**
 * Drive audit 2026-11-02 (finding B): the blog pipeline had no stock-AI-phrase
 * list. content-guardrails.evaluate() now nudges (P2 AI_TELL_PHRASES, never a
 * blocker) on ~27 multi-word tells from the owner's Banned-AI-Words sheet.
 */
jest.mock('../models/db', () => jest.fn());

const guardrails = require('../services/content/content-guardrails');

const CLEAN = 'Fire ants build mounds in sunny turf after summer rain. Look for the raised soil and the swarming workers when disturbed. Call us if the mound comes back.';

function run(body, frontmatter = {}) {
  return guardrails.evaluate({ body, frontmatter }, { targetIsBlog: true });
}
function tell(body, frontmatter) {
  return run(body, frontmatter).findings.find((f) => f.code === 'AI_TELL_PHRASES');
}

describe('AI_TELL_PHRASES (P2 warning)', () => {
  test('fires on a draft containing a phrase, names it, severity P2', () => {
    const f = tell(`${CLEAN}\n\nLet us delve into ant biology.`);
    expect(f).toBeTruthy();
    expect(f.severity).toBe('P2');
    expect(f.message).toContain('"delve into"');
  });

  test('lists every phrase found, once each', () => {
    const f = tell(`${CLEAN}\n\nLook no further. We've got you covered. Look no further!`);
    expect(f.message).toContain('"look no further"');
    expect(f.message).toContain('"we\'ve got you covered"');
    expect(f.message.match(/look no further/g)).toHaveLength(1);
  });

  test('does not fire on clean copy', () => {
    expect(tell(CLEAN)).toBeUndefined();
    expect(run(CLEAN).findings.map((f) => f.code)).not.toContain('AI_TELL_PHRASES');
  });

  test('never blocks: it adds no P0/P1 and does not flip pass', () => {
    const base = run(CLEAN);
    const withTell = run(`${CLEAN}\n\nRest easy, it's important to note the peace of mind.`);
    expect(tell(`${CLEAN}\n\nPeace of mind.`)).toBeTruthy();
    expect(withTell.pass).toBe(base.pass);
    expect(withTell.findings.filter((f) => f.code === 'AI_TELL_PHRASES').every((f) => f.severity === 'P2')).toBe(true);
    expect(withTell.findings.filter((f) => f.severity === 'P0' || f.severity === 'P1'))
      .toEqual(base.findings.filter((f) => f.severity === 'P0' || f.severity === 'P1'));
  });

  test('case-insensitive', () => {
    expect(tell(`${CLEAN}\n\nPEACE OF MIND comes standard.`)).toBeTruthy();
    expect(tell(`${CLEAN}\n\nDelve Into the soil.`)).toBeTruthy();
  });

  test('word boundaries: near-miss words do not match', () => {
    expect(tell(`${CLEAN}\n\nThe peace of minds of owners vary.`)).toBeUndefined();
    expect(tell(`${CLEAN}\n\nUndelve into nothing; redive into it.`)).toBeUndefined();
    expect(tell(`${CLEAN}\n\nHer tapestry offered nothing.`)).toBeUndefined();
  });

  test('a phrase split across a line break or double space still matches', () => {
    expect(tell(`${CLEAN}\n\nWe offer peace of\nmind on every plan.`)).toBeTruthy();
    expect(tell(`${CLEAN}\n\nLook   no\n further for ant help.`)).toBeTruthy();
  });

  test('curly apostrophe, hyphen variants and "breaking the bank"', () => {
    expect(tell(`${CLEAN}\n\nIt’s important to note the mound.`)).toBeTruthy();
    expect(tell(`${CLEAN}\n\nTop notch service.`).message).toContain('"top-notch"');
    expect(tell(`${CLEAN}\n\nNo need for breaking the bank.`).message).toContain('"breaking the bank"');
  });

  test('ignores code fences, HTML comments and link destinations', () => {
    expect(tell(`${CLEAN}\n\n\`\`\`\ndelve into\n\`\`\``)).toBeUndefined();
    expect(tell(`${CLEAN}\n\n<!-- look no further -->`)).toBeUndefined();
    expect(tell(`${CLEAN}\n\nSee [our ant guide](/ant-control/look-no-further/).`)).toBeUndefined();
  });

  test('also flags a phrase in the title or meta description', () => {
    const f = tell(CLEAN, { title: 'Ants? Look no further' });
    expect(f).toBeTruthy();
    expect(f.message).toContain('"look no further"');
  });

  test('exports the phrase list for reuse', () => {
    expect(guardrails._internals.AI_TELL_PHRASES.length).toBeGreaterThanOrEqual(25);
    expect(guardrails._internals.AI_TELL_PHRASES).toEqual(expect.arrayContaining(['delve into', 'peace of mind']));
  });
});
