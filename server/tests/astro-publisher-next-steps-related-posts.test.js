/**
 * next_steps / related_posts survive normalization + serialization
 * (Codex P2, 2026-09-28). normalizeAutonomousBlogFrontmatter rebuilds
 * frontmatter from an explicit field list — without carrying these two
 * through, a writer draft with a valid, gate-approved frontmatter.next_steps
 * / .related_posts (matching packages/blog-schema/schema.json's own field
 * names) was silently dropped before the Astro file was ever committed.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({
  createBranch: jest.fn(),
  getFile: jest.fn(),
  putFile: jest.fn(),
  createPr: jest.fn(),
  createIssueComment: jest.fn(),
}));

const fm = require('../services/content-astro/frontmatter');
const pub = require('../services/content-astro/astro-publisher');
const { normalizeAutonomousBlogFrontmatter } = pub._internals;

const BRIEF = { target_keyword: 'fire ant identification', service: 'pest' };

function writerFrontmatter(overrides = {}) {
  return {
    title: 'Fire Ant Identification in Florida',
    meta_description: 'A'.repeat(120),
    primary_keyword: 'fire ant identification',
    post_type: 'diagnostic',
    next_steps: [
      { label: 'Found a live one?', href: '/pest-control-calculator/' },
      { label: 'Seeing the mound, not the ant?', href: '/lawn-care-sarasota-fl/' },
    ],
    related_posts: ['/pest-control/dangerous-ants-in-florida/', '/pest-control/how-to-spot-fire-ant-mounds/'],
    ...overrides,
  };
}

const BODY = 'Fire ants build loose sandy mounds in open, sunny Florida yards.';

describe('normalizeAutonomousBlogFrontmatter — next_steps / related_posts', () => {
  test('a valid next_steps + related_posts survives normalization', () => {
    const data = normalizeAutonomousBlogFrontmatter(writerFrontmatter(), BRIEF, BODY, { slug: 'fire-ant-identification', canonical: 'https://www.wavespestcontrol.com/pest-control/fire-ant-identification/' });
    expect(data.next_steps).toEqual([
      { label: 'Found a live one?', href: '/pest-control-calculator/' },
      { label: 'Seeing the mound, not the ant?', href: '/lawn-care-sarasota-fl/' },
    ]);
    expect(data.related_posts).toEqual([
      '/pest-control/dangerous-ants-in-florida/',
      '/pest-control/how-to-spot-fire-ant-mounds/',
    ]);
  });

  test('end-to-end: writer output survives normalization AND YAML serialization + re-parse', () => {
    const data = normalizeAutonomousBlogFrontmatter(writerFrontmatter(), BRIEF, BODY, { slug: 'fire-ant-identification', canonical: 'https://www.wavespestcontrol.com/pest-control/fire-ant-identification/' });
    const markdown = fm.stringify(data, `${BODY}\n`);
    const reparsed = fm.parse(markdown);
    expect(reparsed.data.next_steps).toEqual(data.next_steps);
    expect(reparsed.data.related_posts).toEqual(data.related_posts);
  });

  test('an absent next_steps/related_posts on the draft produces NO key at all (never an empty array)', () => {
    const data = normalizeAutonomousBlogFrontmatter(writerFrontmatter({ next_steps: undefined, related_posts: undefined }), BRIEF, BODY, { slug: 'fire-ant-identification', canonical: 'https://www.wavespestcontrol.com/pest-control/fire-ant-identification/' });
    expect('next_steps' in data).toBe(false);
    expect('related_posts' in data).toBe(false);
  });

  test('next_steps is capped at 4 even if the draft somehow carries more', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ label: `Step ${i}`, href: '/contact/' }));
    const data = normalizeAutonomousBlogFrontmatter(writerFrontmatter({ next_steps: many }), BRIEF, BODY, { slug: 'fire-ant-identification', canonical: 'https://www.wavespestcontrol.com/pest-control/fire-ant-identification/' });
    expect(data.next_steps).toHaveLength(4);
  });

  test('a malformed next_steps entry (missing href) is dropped, not published broken', () => {
    const data = normalizeAutonomousBlogFrontmatter(
      writerFrontmatter({ next_steps: [{ label: 'No href here' }, { label: 'Good one', href: '/contact/' }] }),
      BRIEF, BODY,
      { slug: 'fire-ant-identification', canonical: 'https://www.wavespestcontrol.com/pest-control/fire-ant-identification/' },
    );
    expect(data.next_steps).toEqual([{ label: 'Good one', href: '/contact/' }]);
  });

  test('a non-string related_posts entry is dropped, not published broken', () => {
    const data = normalizeAutonomousBlogFrontmatter(
      writerFrontmatter({ related_posts: ['/pest-control/real-post/', { not: 'a string' }, 42] }),
      BRIEF, BODY,
      { slug: 'fire-ant-identification', canonical: 'https://www.wavespestcontrol.com/pest-control/fire-ant-identification/' },
    );
    expect(data.related_posts).toEqual(['/pest-control/real-post/']);
  });
});
