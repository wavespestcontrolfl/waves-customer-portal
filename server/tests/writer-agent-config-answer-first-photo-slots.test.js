/**
 * The writer's system prompt must carry the C2 ("answer first, pitch
 * second") and C3 ("licensed photo slots only") rules from the 2026-09-28
 * blog work order:
 *   - every identification (post_type "diagnostic") or customer-question
 *     draft opens on the verdict box (BottomLineBox), with the early
 *     estimate/quote CTA moved to AFTER it;
 *   - frontmatter.next_steps / .related_posts are optional, closed-set,
 *     never a minimum-link quota;
 *   - an identification brief's pest/sign/look-alike photo slots may ONLY
 *     be filled from the brief's licensed photo library, never AI art, and
 *     a slot with no match is omitted rather than backfilled.
 */
jest.mock('../models/db', () => jest.fn());

const { WRITER_AGENT_CONFIG } = require('../services/content/agents/writer-agent-config');

const PROMPT = JSON.stringify(WRITER_AGENT_CONFIG);

describe('C2: answer first, pitch second', () => {
  test('BottomLineBox is required as the literal first block for diagnostic + customer-question', () => {
    expect(PROMPT).toContain('ANSWER FIRST, PITCH SECOND');
    expect(PROMPT).toContain('BottomLineBox as the FIRST block in the body');
    expect(PROMPT).toContain('LITERAL FIRST BLOCK');
    expect(PROMPT).toContain('Is it dangerous?');
    expect(PROMPT).toContain('What to do now');
  });

  test('the early CTA is moved to AFTER the verdict box, not before it', () => {
    expect(PROMPT).toMatch(/CTA[\s\S]{0,200}comes[\s\S]{0,20}AFTER this box/);
    expect(PROMPT).toContain('never squeezed in before it');
  });

  test('customer-question standard points at the verdict box instead of a plain first paragraph', () => {
    expect(PROMPT).toContain('BottomLineBox is the first block of');
    expect(PROMPT).toContain('a plain first paragraph does not');
  });

  test('supporting-blog early-CTA rule carries the diagnostic exception', () => {
    expect(PROMPT).toMatch(/EXCEPT[\s\S]{0,20}post_type \\"diagnostic\\"/);
    expect(PROMPT).toContain('the one that comes');
  });

  test('next_steps and related_posts frontmatter fields are documented as optional, closed-set, no minimum', () => {
    expect(PROMPT).toContain('FRONTMATTER: NEXT STEPS + RELATED POSTS');
    expect(PROMPT).toContain('frontmatter.related_posts');
    expect(PROMPT).toContain('frontmatter.next_steps');
    expect(PROMPT).toContain('there is NO');
    expect(PROMPT).toContain('minimum-link requirement');
    expect(PROMPT).toContain('#5062');
    expect(PROMPT).toContain('hard-caps this at 4');
  });
});

describe('C3: licensed photo slots only', () => {
  test('photo slots section is present and binding', () => {
    expect(PROMPT).toContain('PHOTO SLOTS');
    expect(PROMPT).toContain('voice_constraints.photo_slots');
  });

  test('AI-generated art is explicitly banned from the identification slots', () => {
    expect(PROMPT).toMatch(/NEVER an[\s\S]{0,10}AI-generated image/);
  });

  test('a slot with no verified photo is omitted, never backfilled', () => {
    expect(PROMPT).toContain('OMIT that');
    expect(PROMPT).toContain('no placeholder');
  });

  test('license/credit must be linked, not just printed as text (Codex P1: CC BY/BY-SA requires a license link)', () => {
    expect(PROMPT).toContain('EXACTLY as');
    expect(PROMPT).toMatch(/Photo: \[\{credit\}\]\(\{photo.source_page\}\)/);
    expect(PROMPT).toContain('never a bare credit/license STRING with no link');
  });
});
