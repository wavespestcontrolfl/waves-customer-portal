/**
 * Licensed identification photos in content-guardrails (C3; Codex r3 on
 * #5216). Photos are licensed-library files already committed in the Astro
 * repo and embedded by LOCAL path, so the image itself is never an
 * outbound link. Only the attribution line's source-page and license-deed
 * links need an allowance: evaluate() derives it from the library photos
 * the rendered body actually shows (licensed-photo-library.libraryPhotoBySrc)
 * — the same answer for a new post, a refresh and a remediation
 * revalidation, with nothing threaded from the brief.
 */

jest.mock('../models/db', () => jest.fn());

const { deriveSyncGuardrailOptions } = require('../services/content/guardrail-options');
const { evaluate } = require('../services/content/content-guardrails');
const { PHOTO_LIBRARY, photoAttributionLine } = require('../services/content/licensed-photo-library');

const HUB = { publishHosts: ['wavespestcontrol.com'] };
function bodyWith(entry, { attribution = photoAttributionLine(entry), image = true } = {}) {
  return [
    '<BottomLineBox verdict="Yes." recommendation="Call a pro." />',
    '',
    'Some identifying prose about the pest in Florida yards.',
    '',
    image ? `![${entry.alt}](${entry.src})` : '',
    '',
    attribution,
  ].join('\n');
}
const external = (result) => result.findings.filter((f) => f.code === 'DISALLOWED_EXTERNAL_LINK');

describe('library photo attribution links', () => {
  test('every library photo + its exact attribution clears DISALLOWED_EXTERNAL_LINK (incl. encoded-paren source pages)', () => {
    for (const entry of PHOTO_LIBRARY) {
      expect(external(evaluate({ frontmatter: { post_type: 'diagnostic' }, body: bodyWith(entry) }, HUB))).toEqual([]);
    }
  });

  test('works on a refresh with no brief data at all', () => {
    const entry = PHOTO_LIBRARY[0];
    const body = bodyWith(entry);
    const r = evaluate({ frontmatter: {}, body: `${body}\n\nA new paragraph.` }, { ...HUB, isRefresh: true, priorBody: body });
    expect(external(r)).toEqual([]);
  });

  test('without the library image in the rendered body, the attribution links are NOT allowed', () => {
    const entry = PHOTO_LIBRARY[0];
    expect(external(evaluate({ frontmatter: {}, body: bodyWith(entry, { image: false }) }, HUB)).length).toBeGreaterThan(0);
    const commented = bodyWith(entry).replace(`![${entry.alt}](${entry.src})`, `<!-- ![${entry.alt}](${entry.src}) -->`);
    expect(external(evaluate({ frontmatter: {}, body: commented }, HUB)).length).toBeGreaterThan(0);
  });

  test("one photo does not license another photo's links", () => {
    const [a, b] = PHOTO_LIBRARY;
    const body = `${bodyWith(a)}\n\n${photoAttributionLine(b)}`;
    expect(external(evaluate({ frontmatter: {}, body }, HUB)).length).toBeGreaterThan(0);
  });

  test('deriveSyncGuardrailOptions no longer carries a brief-derived photo allowance', () => {
    const opts = deriveSyncGuardrailOptions(
      { id: 'opp-1', bucket: 'customer_need' },
      { action_type: 'new_supporting_blog', page_type: 'supporting-blog', voice_constraints: { photo_slots: [{ slot: 'pest', photo: { src: PHOTO_LIBRARY[0].src } }] } },
    );
    expect(opts.photoAllowedUrls).toBeUndefined();
    expect(opts.requiredSourceUrls).toEqual([]);
  });

  test('a post with no photos is never penalized for skipping the slots', () => {
    const body = 'Fire ants build loose sandy mounds in open, sunny Florida yards. Learn more on the Waves blog.';
    const result = evaluate({ frontmatter: { post_type: 'decision' }, body }, HUB);
    expect(result.findings.filter((f) => /photo|MISSING_SOURCE|REQUIRED_SOURCE/i.test(`${f.code} ${f.message}`))).toEqual([]);
  });
});
