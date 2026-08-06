/**
 * Unit tests for internal-link-planner pure helpers.
 *
 * The async loadAstroCorpus reads files from disk — exercised by the
 * CLI smoke test, not jest.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({
  listDir: jest.fn(),
  getFile: jest.fn(),
}));

const planner = require('../services/content/internal-link-planner');
const GitHubClient = require('../services/content-astro/github-client');
const {
  anchorCandidates,
  maskExcludedRegions,
  maskNonContentRegions,
  findFirstUnlinkedOccurrence,
  isInsideMarkdownHeading,
  isInsideLink,
  snippetAround,
  pageAlreadyLinksTo,
  stripHost,
  sameUrl,
  canonicalInternalPath,
  deriveUrlFromFile,
  deriveUrlFromSourceFile,
  extractFrontmatterSlug,
  serviceAnchorPhrase,
  keywordSegments,
} = planner._internals;

// ── anchorCandidates ────────────────────────────────────────────────

describe('anchorCandidates', () => {
  test('priority order: keyword > "service in city" > "city service" > title', () => {
    const out = anchorCandidates({
      url: '/pest-control-bradenton-fl/',
      keyword: 'pest control bradenton',
      city: 'Bradenton',
      service: 'pest control',
      title: 'Pest Control in Bradenton, FL',
    });
    expect(out[0].phrase).toBe('pest control bradenton');
    expect(out.map((c) => c.phrase)).toEqual(expect.arrayContaining([
      'pest control bradenton',
      'pest control in Bradenton',
      'Bradenton pest control',
    ]));
  });
  test('expands service aliases before generating city anchors', () => {
    const out = anchorCandidates({
      url: '/pest-control-bradenton-fl/',
      city: 'Bradenton',
      service: 'pest',
    });
    expect(out.map((c) => c.phrase)).toEqual([
      'pest control in Bradenton',
      'Bradenton pest control',
    ]);
    expect(out.map((c) => c.phrase)).not.toContain('Bradenton pest');
    expect(serviceAnchorPhrase('lawn')).toBe('lawn care');
    expect(serviceAnchorPhrase('tree-shrub')).toBe('tree and shrub care');
  });
  test('de-dupes case-insensitively', () => {
    const out = anchorCandidates({ keyword: 'Pest Control', title: 'pest control' });
    expect(out.length).toBe(1);
  });
  test('handles minimal input', () => {
    expect(anchorCandidates({ url: '/x/' })).toEqual([]);
    expect(anchorCandidates({ url: '/x/', service: 'pest' })).toEqual([]); // no city → no phrase
    expect(anchorCandidates({ url: '/x/', city: 'Bradenton' })).toEqual([]);
  });
  test('long-tail keywords contribute multi-word segment candidates below city anchors', () => {
    const out = anchorCandidates({
      url: '/blog/bed-bug-bites-vs-flea-bites/',
      keyword: 'bed bug bites vs flea bites',
      title: 'Bed Bug and Flea Bite Comparison',
    });
    expect(out[0]).toEqual({ phrase: 'bed bug bites vs flea bites', priority: 10 });
    expect(out).toEqual(expect.arrayContaining([
      { phrase: 'bed bug bites', priority: 7 },
      { phrase: 'flea bites', priority: 7 },
    ]));
    // Full keyword outranks its segments; segments outrank the title.
    const phrases = out.map((c) => c.phrase);
    expect(phrases.indexOf('bed bug bites')).toBeGreaterThan(phrases.indexOf('bed bug bites vs flea bites'));
    expect(phrases.indexOf('bed bug bites')).toBeLessThan(phrases.indexOf('Bed Bug and Flea Bite Comparison'));
  });
  test('drops candidates the executor anchor policy would reject, so they cannot shadow segments', () => {
    const out = anchorCandidates({
      url: '/blog/roof-rat-vs-norway-rat/',
      keyword: 'roof rat vs norway rat in florida attics and garages tonight',
      title: 'Roof Rat vs Norway Rat: Which Rodent Is in Your Florida Attic Right Now?',
    });
    const phrases = out.map((c) => c.phrase);
    // 11-word keyword → anchor_too_long; title → anchor_sentence. Both would
    // be queued then rejected downstream, wasting the page's one match.
    expect(phrases).not.toContain('roof rat vs norway rat in florida attics and garages tonight');
    expect(phrases).not.toContain('Roof Rat vs Norway Rat: Which Rodent Is in Your Florida Attic Right Now?');
    expect(phrases).toEqual(expect.arrayContaining(['roof rat', 'norway rat']));
  });
});

describe('keywordSegments', () => {
  test('splits on comparison and connective separators', () => {
    expect(keywordSegments('bed bug bites vs flea bites')).toEqual(['bed bug bites', 'flea bites']);
    expect(keywordSegments('roof rat vs. norway rat')).toEqual(['roof rat', 'norway rat']);
    expect(keywordSegments('sugar ants versus carpenter ants')).toEqual(['sugar ants', 'carpenter ants']);
  });
  test('drops single-word segments and the full keyword itself', () => {
    // "in" split leaves "kitchen identification" (kept, 2 words) and the
    // 2-word head; nothing equals the original keyword.
    expect(keywordSegments('tiny ants in kitchen identification')).toEqual(['tiny ants', 'kitchen identification']);
    expect(keywordSegments('ants in kitchen')).toEqual([]); // both segments single-word
    expect(keywordSegments('sand fleas')).toEqual([]); // no separator → no segments
  });
  test('handles punctuation separators and empty input', () => {
    expect(keywordSegments('lawn grubs: identification signs')).toEqual(['lawn grubs', 'identification signs']);
    expect(keywordSegments('bed bug bites? flea bite identification')).toEqual(['bed bug bites', 'flea bite identification']);
    expect(keywordSegments('stop lawn fungus! treatment timing')).toEqual(['stop lawn fungus', 'treatment timing']);
    expect(keywordSegments('')).toEqual([]);
    expect(keywordSegments(null)).toEqual([]);
  });
  test('preserves numeric punctuation inside quantities', () => {
    expect(keywordSegments('pest control for 2,500-square-foot homes')).toEqual(['pest control', '2,500-square-foot homes']);
    expect(keywordSegments('mosquito control for 1/2 acre lots')).toEqual(['mosquito control', '1/2 acre lots']);
    expect(keywordSegments('lawn grubs, chinch bugs')).toEqual(['lawn grubs', 'chinch bugs']); // word-adjacent comma still splits
  });
  test('drops stopword-only segments', () => {
    expect(keywordSegments('what is in my attic')).toEqual(['my attic']); // "what is" carries no topical token
  });
});

// ── maskExcludedRegions ─────────────────────────────────────────────

describe('maskExcludedRegions', () => {
  test('masks frontmatter at top', () => {
    const src = `---
title: hi
---
Bradenton pest control here.`;
    const masked = maskExcludedRegions(src);
    expect(masked.length).toBe(src.length);
    expect(masked.indexOf('Bradenton')).toBe(src.indexOf('Bradenton')); // offset preserved
    expect(masked.indexOf('title:')).toBe(-1);
  });
  test('masks fenced code blocks', () => {
    const src = 'before\n```js\nconst x = "pest control bradenton";\n```\nafter pest control bradenton';
    const masked = maskExcludedRegions(src);
    expect(masked.length).toBe(src.length);
    expect(masked.indexOf('const x')).toBe(-1);
    expect(masked.lastIndexOf('pest control bradenton')).toBe(src.lastIndexOf('pest control bradenton'));
  });
  test('masks tilde fenced code blocks', () => {
    const src = 'before\n~~~md\npest control bradenton\n~~~\nafter pest control bradenton';
    const masked = maskExcludedRegions(src);
    expect(masked.length).toBe(src.length);
    expect(masked.indexOf('~~~')).toBe(-1);
    expect(masked.lastIndexOf('pest control bradenton')).toBe(src.lastIndexOf('pest control bradenton'));
  });
  test('masks HTML comments', () => {
    const src = '<!-- pest control bradenton --> real pest control bradenton';
    const masked = maskExcludedRegions(src);
    expect(masked.indexOf('<!--')).toBe(-1);
    expect(masked.indexOf('real')).toBe(src.indexOf('real'));
  });
  test('masks HTML anchor regions', () => {
    const src = '<a href="/pest-control-bradenton-fl/">pest control bradenton</a> real pest control bradenton';
    const masked = maskExcludedRegions(src);
    expect(masked.indexOf('<a')).toBe(-1);
    expect(masked.indexOf('real')).toBe(src.indexOf('real'));
    expect(masked.indexOf('pest control bradenton')).toBe(src.lastIndexOf('pest control bradenton'));
  });
  test('masks MDX/HTML tag attributes but leaves surrounding text offsets intact', () => {
    const src = '<ServiceCard title="pest control bradenton" href="/pest-control-bradenton-fl/" />\nreal pest control bradenton';
    const masked = maskExcludedRegions(src);
    expect(masked.indexOf('ServiceCard')).toBe(-1);
    expect(masked.indexOf('title=')).toBe(-1);
    expect(masked.indexOf('real')).toBe(src.indexOf('real'));
  });
  test('does not mask later markdown thematic blocks as frontmatter', () => {
    const src = `Intro
---
Pest control bradenton appears inside normal content.
---
Outro`;
    const masked = maskExcludedRegions(src);
    expect(masked.indexOf('Pest control bradenton')).toBe(src.indexOf('Pest control bradenton'));
  });
});

// ── isInsideLink ────────────────────────────────────────────────────

describe('isInsideLink', () => {
  test('detects markdown link inner text', () => {
    const t = 'See [our pest control bradenton page](/pest-control-bradenton-fl/) for details';
    const idx = t.indexOf('pest control bradenton');
    expect(isInsideLink(t, idx, idx + 'pest control bradenton'.length)).toBe(true);
  });
  test('detects reference-style markdown link inner text', () => {
    const t = 'See [our pest control bradenton page][pest-ref] for details\n\n[pest-ref]: /pest-control-bradenton-fl/';
    const idx = t.indexOf('pest control bradenton');
    expect(isInsideLink(t, idx, idx + 'pest control bradenton'.length)).toBe(true);
  });
  test('not inside link when outside brackets', () => {
    const t = 'Pest control bradenton — see [more](/x/) here';
    const idx = t.indexOf('Pest control bradenton');
    expect(isInsideLink(t, idx, idx + 22)).toBe(false);
  });
  test('detects HTML anchor inner text', () => {
    const t = 'See <a href="/x/">pest control bradenton</a> here';
    const idx = t.indexOf('pest control bradenton');
    expect(isInsideLink(t, idx, idx + 22)).toBe(true);
  });
});

// ── findFirstUnlinkedOccurrence ─────────────────────────────────────

describe('findFirstUnlinkedOccurrence', () => {
  test('finds first plain-text occurrence', () => {
    const t = 'I need pest control bradenton tomorrow.';
    const r = findFirstUnlinkedOccurrence(t, 'pest control bradenton');
    expect(r.index).toBe(t.indexOf('pest control bradenton'));
    expect(r.snippet).toMatch(/pest control bradenton/);
  });
  test('skips occurrence inside a markdown link, finds the next plain one', () => {
    const t = `[click pest control bradenton here](/x/) and later pest control bradenton mentioned`;
    const r = findFirstUnlinkedOccurrence(t, 'pest control bradenton');
    expect(r.index).toBe(t.indexOf('later pest control bradenton') + 'later '.length);
  });
  test('returns null when all occurrences are linked', () => {
    const t = `[pest control bradenton](/a/) and [pest control bradenton](/b/)`;
    expect(findFirstUnlinkedOccurrence(t, 'pest control bradenton')).toBeNull();
  });
  test('skips reference-style markdown links, finds next plain occurrence', () => {
    const t = `[pest control bradenton][pest-ref] and later pest control bradenton\n\n[pest-ref]: /pest-control-bradenton-fl/`;
    const r = findFirstUnlinkedOccurrence(t, 'pest control bradenton');
    expect(r.index).toBe(t.indexOf('later pest control bradenton') + 'later '.length);
  });
  test('skips HTML anchor text, finds next plain occurrence', () => {
    const t = '<a href="/pest-control-bradenton-fl/">pest control bradenton</a> and later pest control bradenton';
    const r = findFirstUnlinkedOccurrence(t, 'pest control bradenton');
    expect(r.index).toBe(t.indexOf('later pest control bradenton') + 'later '.length);
  });
  test('skips matches inside MDX component props', () => {
    const t = '<ServiceCard title="pest control bradenton" /> and later pest control bradenton';
    const r = findFirstUnlinkedOccurrence(t, 'pest control bradenton');
    expect(r.index).toBe(t.indexOf('later pest control bradenton') + 'later '.length);
  });
  test('skips matches inside existing markdown href destinations', () => {
    const t = '[details](/termite-control-sarasota/) and termite service details';
    const r = findFirstUnlinkedOccurrence(t, 'termite');
    expect(r.index).toBe(t.indexOf('termite service'));
  });
  test('skips matches inside markdown href destinations with balanced parentheses', () => {
    const t = '[details](/foo(bar)termite-control-sarasota/) and termite service details';
    const r = findFirstUnlinkedOccurrence(t, 'termite');
    expect(r.index).toBe(t.indexOf('termite service'));
  });
  test('skips matches inside reference definition destinations', () => {
    const t = '[details][termite-ref]\n\n[termite-ref]: /termite-control-sarasota/';
    expect(findFirstUnlinkedOccurrence(t, 'termite')).toBeNull();
  });
  test('case-insensitive match, preserves source casing in snippet', () => {
    const t = 'Pest Control Bradenton service area.';
    const r = findFirstUnlinkedOccurrence(t, 'pest control bradenton');
    expect(t.slice(r.index, r.index + r.length)).toBe('Pest Control Bradenton');
  });
  test('returns null for empty inputs', () => {
    expect(findFirstUnlinkedOccurrence('', 'x')).toBeNull();
    expect(findFirstUnlinkedOccurrence('x', '')).toBeNull();
  });
  test('word-boundary: short keyword does not match inside larger word', () => {
    // 'ant' must not match inside 'plant' or 'pleasant'.
    expect(findFirstUnlinkedOccurrence('The plant is pleasant.', 'ant')).toBeNull();
    // But matches a standalone occurrence.
    const t = 'I saw an ant today.';
    const r = findFirstUnlinkedOccurrence(t, 'ant');
    expect(r.index).toBe(t.indexOf('ant today'));
  });
  test('word-boundary: pest does not match inside pesticide', () => {
    expect(findFirstUnlinkedOccurrence('Apply pesticide carefully.', 'pest')).toBeNull();
  });
  test('matches phrase candidates that end with punctuation', () => {
    const t = 'Do termites fly? Learn what to do next.';
    const r = findFirstUnlinkedOccurrence(t, 'Do termites fly?');
    expect(r.index).toBe(0);
    expect(r.length).toBe('Do termites fly?'.length);
  });
  test('skips heading occurrences and finds body text', () => {
    const t = '  ## Bradenton Pest Concerns\n\nBody copy mentions Bradenton pest pressure after rain.';
    const r = findFirstUnlinkedOccurrence(t, 'Bradenton pest');
    expect(r.index).toBe(t.indexOf('Bradenton pest pressure'));
    expect(isInsideMarkdownHeading(t, t.indexOf('Bradenton Pest Concerns'))).toBe(true);
  });
});

// ── pageAlreadyLinksTo ──────────────────────────────────────────────

describe('pageAlreadyLinksTo', () => {
  test('detects markdown link to target', () => {
    expect(pageAlreadyLinksTo('[x](/pest-control-bradenton-fl/)', '/pest-control-bradenton-fl/')).toBe(true);
  });
  test('detects markdown link to target when link has a title', () => {
    expect(pageAlreadyLinksTo(
      '[x](/pest-control-bradenton-fl/ "Pest Control Bradenton")',
      '/pest-control-bradenton-fl/'
    )).toBe(true);
  });
  test('detects reference definition to target', () => {
    expect(pageAlreadyLinksTo(
      '[x][pest-ref]\n\n[pest-ref]: /pest-control-bradenton-fl/ "Pest Control Bradenton"',
      '/pest-control-bradenton-fl/'
    )).toBe(true);
  });
  test('detects href= to target', () => {
    expect(pageAlreadyLinksTo('<a href="/pest-control-bradenton-fl/">x</a>', '/pest-control-bradenton-fl/')).toBe(true);
  });
  test('does not count non-anchor component href props as existing links', () => {
    expect(pageAlreadyLinksTo(
      '<ServiceCard href="/pest-control-bradenton-fl/" title="Pest Control Bradenton" />',
      '/pest-control-bradenton-fl/'
    )).toBe(false);
  });
  test('returns false when no link to target', () => {
    expect(pageAlreadyLinksTo('[other](/lawn-care/)', '/pest-control-bradenton-fl/')).toBe(false);
  });
  test('matches across host', () => {
    expect(pageAlreadyLinksTo(
      '[x](https://www.wavespestcontrol.com/pest-control-bradenton-fl/)',
      'https://other.host/pest-control-bradenton-fl/'
    )).toBe(false);
    expect(pageAlreadyLinksTo(
      '[x](https://www.wavespestcontrol.com/pest-control-bradenton-fl/)',
      'https://www.wavespestcontrol.com/pest-control-bradenton-fl/'
    )).toBe(true);
  });
  test('external same-path links do not count as internal target links', () => {
    expect(pageAlreadyLinksTo(
      '[x](https://example.com/pest-control-bradenton-fl/)',
      '/pest-control-bradenton-fl/'
    )).toBe(false);
    expect(pageAlreadyLinksTo(
      '<a href="https://example.com/pest-control-bradenton-fl/">x</a>',
      '/pest-control-bradenton-fl/'
    )).toBe(false);
    expect(pageAlreadyLinksTo(
      '[x][pest-ref]\n\n[pest-ref]: https://example.com/pest-control-bradenton-fl/',
      '/pest-control-bradenton-fl/'
    )).toBe(false);
  });
  test('matches across trailing slash + hash + query (normalized)', () => {
    // Existing link with no trailing slash + hash, target with slash.
    expect(pageAlreadyLinksTo(
      '[faq](/pest-control-bradenton-fl#faq)',
      '/pest-control-bradenton-fl/'
    )).toBe(true);
    // Existing link with query, target without.
    expect(pageAlreadyLinksTo(
      '[gbp](/pest-control-bradenton-fl/?utm_src=gbp)',
      '/pest-control-bradenton-fl/'
    )).toBe(true);
  });
  test('superstring URL should NOT match (avoid false dedupe)', () => {
    // /pest-control-bradenton-fl-area should not be treated as matching
    // /pest-control-bradenton-fl — the old includes() let that through.
    expect(pageAlreadyLinksTo(
      '[x](/pest-control-bradenton-fl-area/)',
      '/pest-control-bradenton-fl/'
    )).toBe(false);
  });
  test('ignores markdown links inside fenced code and comments', () => {
    expect(pageAlreadyLinksTo(
      '```md\n[x](/pest-control-bradenton-fl/)\n```',
      '/pest-control-bradenton-fl/'
    )).toBe(false);
    expect(pageAlreadyLinksTo(
      '~~~md\n[x](/pest-control-bradenton-fl/)\n~~~',
      '/pest-control-bradenton-fl/'
    )).toBe(false);
    expect(pageAlreadyLinksTo(
      '<!-- [x](/pest-control-bradenton-fl/) -->',
      '/pest-control-bradenton-fl/'
    )).toBe(false);
  });
  test('keeps real links visible after non-content masking', () => {
    const src = '```md\n[x](/other/)\n```\n[real](/pest-control-bradenton-fl/)';
    const masked = maskNonContentRegions(src);
    expect(masked).toContain('[real](/pest-control-bradenton-fl/)');
    expect(pageAlreadyLinksTo(src, '/pest-control-bradenton-fl/')).toBe(true);
  });
});

// ── url helpers ─────────────────────────────────────────────────────

describe('stripHost / sameUrl / deriveUrlFromFile', () => {
  test('stripHost', () => {
    expect(stripHost('https://www.wavespestcontrol.com/a/')).toBe('/a/');
    expect(stripHost('/a/')).toBe('/a/');
  });
  test('sameUrl normalizes trailing slash + case + host', () => {
    expect(sameUrl('https://www.wavespestcontrol.com/A/', '/a')).toBe(true);
    expect(sameUrl('/a/', '/b/')).toBe(false);
  });
  test('sameUrl normalizes query and hash variants', () => {
    expect(sameUrl('/pest-control-bradenton-fl/#faq', '/pest-control-bradenton-fl/')).toBe(true);
    expect(sameUrl('/pest-control-bradenton-fl?utm_source=gbp', '/pest-control-bradenton-fl/')).toBe(true);
  });
  test('canonicalInternalPath strips query/hash and keeps a trailing slash', () => {
    expect(canonicalInternalPath('https://www.wavespestcontrol.com/Pest-Control-Bradenton-FL/?utm=x#faq')).toBe('/pest-control-bradenton-fl/');
  });
  test('canonicalInternalPath rejects unsafe or external targets', () => {
    expect(canonicalInternalPath('javascript:alert(1)')).toBe('');
    expect(canonicalInternalPath('//evil.example/path')).toBe('');
    expect(canonicalInternalPath('https://evil.example/pest-control/')).toBe('');
    expect(canonicalInternalPath('/bad path/')).toBe('');
    expect(canonicalInternalPath('/bad)path/')).toBe('');
    expect(canonicalInternalPath('/safe-path/')).toBe('/safe-path/');
  });
  test('deriveUrlFromFile', () => {
    expect(deriveUrlFromFile('blog', 'foo.md')).toBe('/blog/foo/');
    expect(deriveUrlFromFile('blog', 'sub/foo.md')).toBe('/blog/sub/foo/');
    expect(deriveUrlFromFile('services', 'pest-control-bradenton-fl.md')).toBe('/pest-control-bradenton-fl/');
    expect(deriveUrlFromFile('locations', 'siesta-key.mdx')).toBe('/siesta-key/');
  });
  test('deriveUrlFromFile prefers frontmatter slug when present', () => {
    const body = `---
title: Get Rid of Treehoppers
slug: "/tree-shrub/get-rid-of-treehoppers/" # canonical Astro route
---
Body`;
    expect(extractFrontmatterSlug(body)).toBe('/tree-shrub/get-rid-of-treehoppers/');
    expect(deriveUrlFromFile('blog', 'get-rid-of-treehoppers.md', body)).toBe('/tree-shrub/get-rid-of-treehoppers/');
  });
  test('deriveUrlFromSourceFile infers collection URLs from Astro paths', () => {
    expect(deriveUrlFromSourceFile('src/content/blog/foo.md')).toBe('/blog/foo/');
    expect(deriveUrlFromSourceFile('src/content/services/pest-control-bradenton-fl.md')).toBe('/pest-control-bradenton-fl/');
    expect(deriveUrlFromSourceFile('src/content/locations/siesta-key.mdx')).toBe('/siesta-key/');
  });
  test('loadAstroCorpus recurses through collection subdirectories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-link-corpus-'));
    try {
      const nested = path.join(root, 'src', 'content', 'blog', 'sub');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, 'nested.md'), 'Nested pest control bradenton mention.');
      const corpus = planner.loadAstroCorpus(root, { collections: ['blog'] });
      expect(corpus).toEqual([expect.objectContaining({
        file: 'src/content/blog/sub/nested.md',
        url: '/blog/sub/nested/',
        body: 'Nested pest control bradenton mention.',
      })]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  test('loadAstroCorpusFromGitHub recurses through Astro content directories', async () => {
    GitHubClient.listDir.mockImplementation(async (dir) => {
      if (dir === 'src/content/blog') return [{ type: 'dir', path: 'src/content/blog/ants', name: 'ants' }];
      if (dir === 'src/content/blog/ants') return [{ type: 'file', path: 'src/content/blog/ants/ghost-ants.md', name: 'ghost-ants.md' }];
      if (dir === 'src/content/services') return [{ type: 'file', path: 'src/content/services/pest-control-bradenton-fl.md', name: 'pest-control-bradenton-fl.md' }];
      return [];
    });
    GitHubClient.getFile.mockImplementation(async (file) => ({
      path: file,
      content: file.includes('ghost-ants')
        ? '---\nslug: /pest-control/ghost-ants/\n---\nGhost ant body'
        : 'Pest control Bradenton body',
    }));

    const corpus = await planner.loadAstroCorpusFromGitHub({ collections: ['blog', 'services'] });

    expect(corpus).toEqual([
      expect.objectContaining({
        file: 'src/content/blog/ants/ghost-ants.md',
        url: '/pest-control/ghost-ants/',
        body: expect.stringContaining('Ghost ant body'),
      }),
      expect.objectContaining({
        file: 'src/content/services/pest-control-bradenton-fl.md',
        url: '/pest-control-bradenton-fl/',
      }),
    ]);
  });
});

// ── snippetAround ───────────────────────────────────────────────────

describe('snippetAround', () => {
  test('adds ellipsis at edges + collapses whitespace', () => {
    const t = 'X'.repeat(60) + ' pest control bradenton ' + 'Y'.repeat(60);
    const s = snippetAround(t, 60, 24, 30);
    expect(s).toMatch(/…X{30,}/);
    expect(s).toMatch(/pest control bradenton/);
  });
});

// ── planForTarget integration ───────────────────────────────────────

describe('planForTarget', () => {
  const corpus = [
    {
      file: 'src/content/blog/post-a.md',
      body: '# Post A\n\nI live in Bradenton and need pest control bradenton next week.',
      url: '/blog/post-a/',
    },
    {
      file: 'src/content/blog/post-b.md',
      body: 'See [our pest control bradenton page](/pest-control-bradenton-fl/) for info.',
      url: '/blog/post-b/',
    },
    {
      file: 'src/content/blog/post-c.md',
      body: '# Post C\n\nUnrelated lawn care content for Sarasota homeowners.',
      url: '/blog/post-c/',
    },
  ];
  const target = {
    url: '/pest-control-bradenton-fl/',
    keyword: 'pest control bradenton',
    city: 'Bradenton',
    service: 'pest control',
  };

  test('plans link for post-a (unlinked mention), skips post-b (already links to target), skips post-c (no match)', () => {
    const tasks = planner.planForTarget(target, { corpus });
    expect(tasks.length).toBe(1);
    expect(tasks[0].source_file).toBe('src/content/blog/post-a.md');
    expect(tasks[0].target_url).toBe('/pest-control-bradenton-fl/');
    expect(tasks[0].anchor_text.toLowerCase()).toBe('pest control bradenton');
  });
  test('respects cap', () => {
    const big = Array.from({ length: 10 }, (_, i) => ({
      file: `src/content/blog/p${i}.md`,
      body: `Pest control bradenton mentioned in post ${i}.`,
      url: `/blog/p${i}/`,
    }));
    const tasks = planner.planForTarget(target, { corpus: big, cap: 3 });
    expect(tasks.length).toBe(3);
  });
  test('fills the cap best-first: a relevant late page beats weak earlier matches', () => {
    // Three weak matches (segment occurs, but frontmatter shares no topical
    // tokens with the target) come FIRST in corpus order; a topically
    // aligned page comes last. With cap=2 the aligned page must win a slot —
    // corpus-order capping would have burned both slots on weak matches.
    const weak = (i) => ({
      file: `src/content/blog/weak-${i}.md`,
      body: [
        '---',
        `title: Pool Cage Repairs Part ${i}`,
        'category: home-maintenance',
        'primary_keyword: pool cage repair',
        '---',
        'One reader mentioned bed bug bites while asking about screens.',
      ].join('\n'),
      url: `/blog/weak-${i}/`,
    });
    // "flea" sits >50 chars after the matched anchor: inside the paragraph
    // the executor scores, but OUTSIDE the old ±50-char snippet window —
    // ranking must use the same paragraph context as the gate to see it.
    const relevant = {
      file: 'src/content/blog/bed-bug-signs.md',
      body: [
        '---',
        'title: Early Signs of Bed Bugs',
        'category: pest-control',
        'primary_keyword: bed bug signs',
        '---',
        'Waking up with bed bug bites is the classic first sign homeowners notice in the morning, though a careful look can still reveal that flea bites look similar.',
      ].join('\n'),
      url: '/blog/bed-bug-signs/',
    };
    const tasks = planner.planForTarget(
      { url: '/pest-control/bed-bug-bites-vs-flea-bites/', keyword: 'bed bug bites vs flea bites' },
      { corpus: [weak(1), weak(2), weak(3), relevant], cap: 2 }
    );
    // The weak matches score below the 0.75 gate floor and are not planned
    // at all; the aligned page wins regardless of corpus position.
    expect(tasks.length).toBe(1);
    expect(tasks[0].source_file).toBe('src/content/blog/bed-bug-signs.md');
  });
  test('never plans a match whose paragraph already has a link (executor would skip it)', () => {
    const linked = {
      file: 'src/content/blog/linked-paragraph.md',
      body: [
        '---',
        'title: Bed Bug Basics',
        'category: pest-control',
        'primary_keyword: bed bug basics',
        '---',
        'If you notice bed bug bites, see [our prevention guide](/pest-control/bed-bug-prevention/) for next steps.',
      ].join('\n'),
      url: '/blog/linked-paragraph/',
    };
    const clean = {
      file: 'src/content/blog/clean-paragraph.md',
      body: [
        '---',
        'title: Overnight Itching Causes',
        'category: pest-control',
        'primary_keyword: overnight itching',
        '---',
        'Bed bug bites that appear overnight are worth a closer look, especially compared with flea bites.',
      ].join('\n'),
      url: '/blog/clean-paragraph/',
    };
    // cap=1: without the plan-time paragraph check, the linked page's higher
    // token overlap could take the only slot and then skip at execution.
    const tasks = planner.planForTarget(
      { url: '/pest-control/bed-bug-bites-vs-flea-bites/', keyword: 'bed bug bites vs flea bites' },
      { corpus: [linked, clean], cap: 1 }
    );
    expect(tasks.length).toBe(1);
    expect(tasks[0].source_file).toBe('src/content/blog/clean-paragraph.md');
  });
  test('skips occurrences that split a commercial phrase in context (executor would reject)', () => {
    const splitting = {
      file: 'src/content/blog/tree-shrub-program.md',
      body: [
        '---',
        'title: Palm and Hedge Program',
        'category: tree-shrub',
        'primary_keyword: shrub care program',
        '---',
        '',
        'Our tree and shrub care program covers palms and hedges year round.',
      ].join('\n'),
      url: '/blog/tree-shrub-program/',
    };
    const clean = {
      file: 'src/content/blog/hedge-health.md',
      body: [
        '---',
        'title: Hedge Health Basics',
        'category: tree-shrub',
        'primary_keyword: hedge health',
        '---',
        '',
        'Regular shrub care keeps Florida yards dense and healthy through summer.',
      ].join('\n'),
      url: '/blog/hedge-health/',
    };
    // "shrub care" inside "tree and shrub care" splits a commercial phrase —
    // the executor rejects it (anchor_splits_service_phrase); the standalone
    // occurrence on the second page is the only plannable match.
    const tasks = planner.planForTarget(
      { url: '/tree-shrub/shrub-care-guide/', keyword: 'shrub care for florida yards' },
      { corpus: [splitting, clean], cap: 1 }
    );
    expect(tasks.length).toBe(1);
    expect(tasks[0].source_file).toBe('src/content/blog/hedge-health.md');
  });
  test('excludes noindex sources before the cap (executor would skip source_not_indexable)', () => {
    const noindexPage = {
      file: 'src/content/blog/noindex-page.md',
      body: [
        '---',
        'title: Bed Bug Bite Photos',
        'category: pest-control',
        'primary_keyword: bed bug bites vs flea bites',
        'robots: noindex, follow',
        '---',
        '',
        'Compare bed bug bites vs flea bites in the gallery below.',
      ].join('\n'),
      url: '/blog/noindex-page/',
    };
    const indexable = {
      file: 'src/content/blog/indexable-page.md',
      body: [
        '---',
        'title: Overnight Itching Causes',
        'category: pest-control',
        'primary_keyword: overnight itching',
        '---',
        '',
        'Bed bug bites that appear overnight are worth a closer look, especially compared with flea bites.',
      ].join('\n'),
      url: '/blog/indexable-page/',
    };
    // The noindex page even matches the full keyword (priority 10) — it must
    // still lose to the indexable page rather than burn the only slot.
    const tasks = planner.planForTarget(
      { url: '/pest-control/bed-bug-bites-vs-flea-bites/', keyword: 'bed bug bites vs flea bites' },
      { corpus: [noindexPage, indexable], cap: 1 }
    );
    expect(tasks.length).toBe(1);
    expect(tasks[0].source_file).toBe('src/content/blog/indexable-page.md');
  });
  test('excludes canonical-mismatch and link-saturated sources before the cap', () => {
    const mismatch = {
      file: 'src/content/blog/canonical-elsewhere.md',
      body: [
        '---',
        'title: Bed Bug FAQ',
        'category: pest-control',
        'primary_keyword: bed bug bites vs flea bites',
        'canonical: https://www.wavespestcontrol.com/pest-library/bed-bugs/',
        '---',
        '',
        'People ask about bed bug bites vs flea bites constantly.',
      ].join('\n'),
      url: '/blog/canonical-elsewhere/',
    };
    const saturated = {
      file: 'src/content/blog/saturated.md',
      body: [
        '---',
        'title: Mega Pest Index',
        'category: pest-control',
        'primary_keyword: pest index',
        '---',
        '',
        Array.from({ length: 31 }, (_, i) => `[entry ${i}](/pest-library/entry-${i}/)`).join(' '),
        '',
        'Bed bug bites vs flea bites confusion is common among readers.',
      ].join('\n'),
      url: '/blog/saturated/',
    };
    const clean = {
      file: 'src/content/blog/clean-source.md',
      body: [
        '---',
        'title: Overnight Itching Causes',
        'category: pest-control',
        'primary_keyword: overnight itching',
        '---',
        '',
        'Bed bug bites that appear overnight are worth a closer look, especially compared with flea bites.',
      ].join('\n'),
      url: '/blog/clean-source/',
    };
    // Both ineligible pages match at higher relevance/priority; the executor
    // would reject them (source_canonical_mismatch, source_link_density_high)
    // so neither may take the only slot.
    const tasks = planner.planForTarget(
      { url: '/pest-control/bed-bug-bites-vs-flea-bites/', keyword: 'bed bug bites vs flea bites' },
      { corpus: [mismatch, saturated, clean], cap: 1 }
    );
    expect(tasks.length).toBe(1);
    expect(tasks[0].source_file).toBe('src/content/blog/clean-source.md');
  });
  test('scans past an early ineligible occurrence to a later clean paragraph', () => {
    const page = {
      file: 'src/content/blog/two-mentions.md',
      body: [
        '---',
        'title: Bite Comparisons',
        'category: pest-control',
        'primary_keyword: bite comparisons',
        '---',
        '',
        'As covered in [our overview](/pest-library/), bed bug bites are common calls.',
        '',
        'Standalone paragraph: bed bug bites and flea bites are easy to confuse.',
      ].join('\n'),
      url: '/blog/two-mentions/',
    };
    const tasks = planner.planForTarget(
      { url: '/pest-control/bed-bug-bites-vs-flea-bites/', keyword: 'bed bug bites vs flea bites' },
      { corpus: [page], cap: 1 }
    );
    // The first "bed bug bites" sits in a linked paragraph; the second is
    // clean and must be chosen (offset beyond the first paragraph).
    expect(tasks.length).toBe(1);
    expect(page.body.slice(tasks[0].source_offset, tasks[0].source_offset + tasks[0].anchor_text.length)).toBe('bed bug bites');
    expect(page.body.slice(0, tasks[0].source_offset)).toContain('Standalone paragraph');
  });
  test('scans past a low-relevance occurrence to a richer paragraph of the same phrase', () => {
    const page = {
      file: 'src/content/blog/two-clean-mentions.md',
      body: [
        '---',
        'title: Reader Questions',
        'category: home-maintenance',
        'primary_keyword: reader questions',
        '---',
        '',
        'A reader mentioned bed bug bites in passing last month.',
        '',
        'For pest-control purposes, bed bug bites and flea bites in Florida homes deserve a professional look.',
      ].join('\n'),
      url: '/blog/two-clean-mentions/',
    };
    const tasks = planner.planForTarget(
      { url: '/pest-control/bed-bug-bites-vs-flea-bites/', keyword: 'bed bug bites vs flea bites' },
      { corpus: [page], cap: 1 }
    );
    // Both paragraphs are clean placements; the first scores below the floor
    // (no flea/pest support) and must not discard the phrase — the second,
    // richer paragraph is selected and its offset persisted.
    expect(tasks.length).toBe(1);
    expect(page.body.slice(0, tasks[0].source_offset)).toContain('in passing last month');
    // The persisted context is the FULL scored paragraph (drift relocation
    // compares paragraphs), not a ±50-char snippet.
    expect(tasks[0].context_snippet).toBe('For pest-control purposes, bed bug bites and flea bites in Florida homes deserve a professional look.');
  });
  test('placementForTask honors the planned offset and falls back on drift', () => {
    const { placementForTask } = planner._internals;
    const body = [
      'First bed bug bites mention here.',
      '',
      'Second bed bug bites mention with more context.',
    ].join('\n');
    const secondIdx = body.indexOf('bed bug bites', body.indexOf('Second'));
    const task = { anchor_text: 'bed bug bites', source_offset: secondIdx };
    // Honors the recorded (second) occurrence even though the first is
    // eligible too.
    expect(placementForTask(body, task).index).toBe(secondIdx);
    // Drifted file without persisted context → first eligible occurrence.
    const drifted = `X${body}`;
    expect(placementForTask(drifted, task).index).toBe(drifted.indexOf('bed bug bites'));
    // Drifted file WITH persisted context → relocates to the occurrence
    // whose surroundings match the planned context, not the thin first one.
    const contextTask = {
      anchor_text: 'bed bug bites',
      source_offset: secondIdx, // stale after the drift
      context_snippet: 'Second bed bug bites mention with more context.',
    };
    expect(placementForTask(drifted, contextTask).index).toBe(drifted.indexOf('bed bug bites', drifted.indexOf('Second')));
  });
  test('keeps the highest-scoring passing occurrence, not the first over the floor', () => {
    const page = {
      file: 'src/content/blog/two-passing-mentions.md',
      body: [
        '---',
        'title: Bite Notes',
        'category: pest-control',
        'primary_keyword: bite notes',
        '---',
        '',
        'Flea bites and bed bug bites both itch.',
        '',
        'Pest experts compare bed bug bites with flea bites in Florida homes for identification.',
      ].join('\n'),
      url: '/blog/two-passing-mentions/',
    };
    const tasks = planner.planForTarget(
      { url: '/pest-control/bed-bug-bites-vs-flea-bites/', keyword: 'bed bug bites vs flea bites' },
      { corpus: [page], cap: 1 }
    );
    // Both paragraphs clear the floor; the second covers the full core set
    // (adds the pest token) and must win even though the first passes.
    expect(tasks.length).toBe(1);
    expect(page.body.slice(0, tasks[0].source_offset)).toContain('both itch');
  });
  test('nonnumeric relevance env falls back to the 0.75 default instead of disabling planning', () => {
    const prev = process.env.AUTONOMOUS_INTERNAL_LINK_MIN_TOPICAL_RELEVANCE;
    process.env.AUTONOMOUS_INTERNAL_LINK_MIN_TOPICAL_RELEVANCE = 'banana';
    try {
      const page = {
        file: 'src/content/blog/env-guard.md',
        body: [
          '---',
          'title: Env Guard',
          'category: pest-control',
          'primary_keyword: bed bug bites vs flea bites',
          '---',
          '',
          'Comparing bed bug bites vs flea bites is a common pest question.',
        ].join('\n'),
        url: '/blog/env-guard/',
      };
      const tasks = planner.planForTarget(
        { url: '/pest-control/bed-bug-bites-vs-flea-bites/', keyword: 'bed bug bites vs flea bites' },
        { corpus: [page], cap: 1 }
      );
      expect(tasks.length).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.AUTONOMOUS_INTERNAL_LINK_MIN_TOPICAL_RELEVANCE;
      else process.env.AUTONOMOUS_INTERNAL_LINK_MIN_TOPICAL_RELEVANCE = prev;
    }
  });
  test('an unchanged offset with changed context falls through to relocation', () => {
    const { placementForTask } = planner._internals;
    const planned = 'Hotel luggage seams and inspection tips often reveal bed bug bites after trips.';
    // Same byte offset for the anchor, but the paragraph around it was
    // rewritten (supporting terms removed); the planned paragraph now lives
    // later in the file.
    const body = [
      'Some padding text goes here first so offsets line up cleanly, ok.',
      '',
      'A note about bed bug bites.',
      '',
      planned,
    ].join('\n');
    const staleOffset = body.indexOf('bed bug bites'); // in the rewritten thin paragraph
    const task = { anchor_text: 'bed bug bites', source_offset: staleOffset, context_snippet: planned };
    expect(placementForTask(body, task).index).toBe(body.indexOf('bed bug bites', body.indexOf('Hotel')));
  });
  test('a matching primary canonical is not disqualified by a stale secondary field', () => {
    const page = {
      file: 'src/content/blog/dual-canonical.md',
      body: [
        '---',
        'title: Bite Comparison Notes',
        'category: pest-control',
        'primary_keyword: bed bug bites vs flea bites',
        'canonical: https://www.wavespestcontrol.com/blog/dual-canonical/',
        'canonical_url: https://www.wavespestcontrol.com/old-path/',
        '---',
        '',
        'Comparing bed bug bites vs flea bites is a common pest question.',
      ].join('\n'),
      url: '/blog/dual-canonical/',
    };
    const tasks = planner.planForTarget(
      { url: '/pest-control/bed-bug-bites-vs-flea-bites/', keyword: 'bed bug bites vs flea bites' },
      { corpus: [page], cap: 1 }
    );
    // Executor precedence: canonical (first valid) wins; the stale
    // canonical_url must not exclude the source at plan time.
    expect(tasks.length).toBe(1);
  });
  test('relocation ranks with the inferred cluster term, not the keyword alone', () => {
    const { placementForTask } = planner._internals;
    const body = [
      'Attic noises at night worry homeowners across the region every winter.',
      '',
      'Attic noises usually mean rodent activity in the insulation.',
    ].join('\n');
    const task = {
      anchor_text: 'Attic noises',
      source_offset: 9999, // stale — forces relocation
      target_keyword: 'attic noises',
      target_file: 'src/content/blog/rodent-attic-noises.md',
      context_snippet: 'Attic noises at night worry homeowners every winter season.',
    };
    // Both paragraphs carry the keyword tokens equally; only the second has
    // the inferred cluster term (rodent), which the gate scores — context
    // overlap alone would keep the first.
    expect(placementForTask(body, task).index).toBe(body.indexOf('Attic noises usually'));
  });
  test('relocation prefers occurrences that keep the target keyword terms', () => {
    const { placementForTask } = planner._internals;
    // The old planned paragraph was edited in place: it keeps incidental
    // wording from the persisted context (reader, mentioned, month) but
    // lost the target terms; the later paragraph carries them.
    const body = [
      'A reader mentioned bed bug bites to us last month again.',
      '',
      'Comparing bed bug bites against flea bites helps homeowners.',
    ].join('\n');
    const task = {
      anchor_text: 'bed bug bites',
      source_offset: 9999, // stale — forces relocation
      target_keyword: 'bed bug bites vs flea bites',
      context_snippet: 'A reader mentioned bed bug bites and flea bites to us last month.',
    };
    // Raw context overlap favors the first (edited) paragraph; the keyword
    // ranking sees "flea"/"bites" support only in the second.
    expect(placementForTask(body, task).index).toBe(body.indexOf('bed bug bites', body.indexOf('Comparing')));
  });
  test('drift relocation compares full paragraphs, not just snippet windows', () => {
    const { placementForTask } = planner._internals;
    const body = [
      'Bed bug bites at the hotel happen.',
      '',
      'Bed bug bites after long trips usually trace back to hotel luggage seams, and inspection tips help travelers check them.',
    ].join('\n');
    const task = {
      anchor_text: 'Bed bug bites',
      source_offset: 9999, // stale — forces relocation
      context_snippet: 'hotel luggage seams inspection tips travelers check bed bug bites',
    };
    // Both occurrences' ±50-char snippets tie on shared tokens (bed, bug,
    // bites, hotel); only the second paragraph's tail carries luggage/
    // seams/inspection/tips — a snippet-level comparison would keep the
    // thin first mention.
    expect(placementForTask(body, task).index).toBe(body.indexOf('Bed bug bites after'));
  });
  test('hidden comment tokens do not lift relevance over the floor', () => {
    const page = {
      file: 'src/content/blog/comment-inflated.md',
      body: [
        '---',
        'title: Pool Cage Screens',
        'category: home-maintenance',
        'primary_keyword: pool cage screens',
        '---',
        '',
        'One reader mentioned bed bug bites while asking about screens. <!-- flea bites pest-control -->',
      ].join('\n'),
      url: '/blog/comment-inflated/',
    };
    const tasks = planner.planForTarget(
      { url: '/pest-control/bed-bug-bites-vs-flea-bites/', keyword: 'bed bug bites vs flea bites' },
      { corpus: [page], cap: 1 }
    );
    // Visible copy only supports "bed bug bites"; the comment's extra tokens
    // are masked out of the excerpt, so the match stays below the floor.
    expect(tasks).toEqual([]);
  });
  test('merges the supplied keyword into corpus target facts when frontmatter has none', () => {
    const legacyTarget = {
      file: 'src/content/services/bed-bug-treatment.md',
      body: [
        '---',
        'title: Professional Bed Bug Treatment for Southwest Florida Homes and Rentals',
        'category: pest-control',
        '---',
        '',
        'Treatment overview.',
      ].join('\n'),
      url: '/bed-bug-treatment/',
    };
    const source = {
      file: 'src/content/blog/bite-signs.md',
      body: [
        '---',
        'title: Early Bite Signs',
        'category: pest-control',
        'primary_keyword: bed bug treatment signs',
        '---',
        '',
        'Persistent bites usually mean it is time for bed bug treatment.',
      ].join('\n'),
      url: '/blog/bite-signs/',
    };
    const tasks = planner.planForTarget(
      { url: '/bed-bug-treatment/', keyword: 'bed bug treatment' },
      { corpus: [legacyTarget, source], cap: 1 }
    );
    // Without the merge the target's long descriptive title floods the core
    // denominator and nothing passes the floor; with it the source plans and
    // the keyword is persisted for the executor.
    expect(tasks.length).toBe(1);
    expect(tasks[0].source_file).toBe('src/content/blog/bite-signs.md');
    expect(tasks[0].target_keyword).toBe('bed bug treatment');
  });
  test('uses service alias anchors instead of partial service fragments', () => {
    const tasks = planner.planForTarget({
      url: '/pest-control-bradenton-fl/',
      city: 'Bradenton',
      service: 'pest',
    }, {
      corpus: [{
        file: 'src/content/services/pest-control-quote-bradenton-fl.md',
        body: 'Call for your free Bradenton pest control quote today.',
        url: '/pest-control-quote-bradenton-fl/',
      }],
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0].anchor_text).toBe('Bradenton pest control');
  });
  test('never links page to itself', () => {
    const c = [{ file: 'src/content/services/pest-control-bradenton-fl.md', body: 'pest control bradenton here', url: '/pest-control-bradenton-fl/' }];
    expect(planner.planForTarget(target, { corpus: c })).toEqual([]);
  });
  test('never links page to itself when corpus omits url', () => {
    const c = [{ file: 'src/content/services/pest-control-bradenton-fl.md', body: 'pest control bradenton here' }];
    expect(planner.planForTarget(target, { corpus: c })).toEqual([]);
  });
  test('never links page to itself when target has query/hash variant', () => {
    const variantTarget = { ...target, url: '/pest-control-bradenton-fl/?utm_source=gbp#faq' };
    const c = [{ file: 'src/content/services/pest-control-bradenton-fl.md', body: 'pest control bradenton here', url: '/pest-control-bradenton-fl/' }];
    expect(planner.planForTarget(variantTarget, { corpus: c })).toEqual([]);
  });
  test('never links blog target to itself when corpus URL came from frontmatter slug', () => {
    const blogTarget = {
      url: '/tree-shrub/get-rid-of-treehoppers/',
      keyword: 'treehoppers',
    };
    const c = [{
      file: 'src/content/blog/get-rid-of-treehoppers.md',
      body: 'treehoppers can damage ornamental plants.',
      url: '/tree-shrub/get-rid-of-treehoppers/',
    }];
    expect(planner.planForTarget(blogTarget, { corpus: c })).toEqual([]);
  });
  test('never links blog target to itself when url is derived from file or frontmatter', () => {
    expect(planner.planForTarget({ url: '/blog/post-a/', keyword: 'pest control bradenton' }, {
      corpus: [{ file: 'src/content/blog/post-a.md', body: 'pest control bradenton here' }],
    })).toEqual([]);

    const body = `---
slug: "/tree-shrub/get-rid-of-treehoppers/"
---
treehoppers can damage ornamental plants.`;
    expect(planner.planForTarget({ url: '/tree-shrub/get-rid-of-treehoppers/', keyword: 'treehoppers' }, {
      corpus: [{ file: 'src/content/blog/get-rid-of-treehoppers.md', body }],
    })).toEqual([]);
  });
  test('returns [] for target with no anchor candidates', () => {
    expect(planner.planForTarget({ url: '/x/' }, { corpus })).toEqual([]);
  });
  test('returns [] for unsafe target URL', () => {
    expect(planner.planForTarget({ url: 'javascript:alert(1)', keyword: 'pest control bradenton' }, { corpus })).toEqual([]);
  });
  test('stamps target_file from the corpus so the executor never guesses the collection', () => {
    const withTarget = [
      ...corpus,
      {
        file: 'src/content/services/pest-control-bradenton-fl.md',
        body: '---\ntitle: Pest Control Bradenton\n---\nService page body.',
        url: '/pest-control-bradenton-fl/',
      },
    ];
    const tasks = planner.planForTarget(target, { corpus: withTarget });
    expect(tasks.length).toBe(1);
    expect(tasks[0].target_file).toBe('src/content/services/pest-control-bradenton-fl.md');
  });
  test('stamps target_file for a root-slug blog target', () => {
    const c = [
      {
        file: 'src/content/blog/venice-dollar-spot-guide.md',
        body: '---\nslug: /venice-dollar-spot-guide/\n---\nDollar spot guide body.',
        url: '/venice-dollar-spot-guide/',
      },
      {
        file: 'src/content/blog/post-a.md',
        body: 'Lawns showing venice dollar spot rings need fungicide timing.',
        url: '/blog/post-a/',
      },
    ];
    const tasks = planner.planForTarget({ url: '/venice-dollar-spot-guide/', keyword: 'venice dollar spot' }, { corpus: c });
    expect(tasks.length).toBe(1);
    expect(tasks[0].target_file).toBe('src/content/blog/venice-dollar-spot-guide.md');
  });
  test('target_file is null when the target page is not in the corpus', () => {
    const tasks = planner.planForTarget(target, { corpus });
    expect(tasks.length).toBe(1);
    expect(tasks[0].target_file).toBeNull();
  });
});

// ── spoke-source guard ──────────────────────────────────────────────

describe('spoke-source guard', () => {
  const target = {
    url: '/pest-control-bradenton-fl/',
    keyword: 'pest control bradenton',
  };
  const matchingBody = (frontmatterLines) => [
    '---',
    'title: Source Page',
    ...frontmatterLines,
    '---',
    'Homeowners searching pest control bradenton deserve straight answers.',
  ].join('\n');

  test('skips sources whose domains frontmatter names a spoke', () => {
    const c = [{ file: 'src/content/services/x.md', body: matchingBody(['domains:', '  - veniceflpestcontrol.com']), url: '/x/' }];
    expect(planner.planForTarget(target, { corpus: c })).toEqual([]);
  });
  test('skips sources that render on hub AND a spoke', () => {
    const c = [{ file: 'src/content/services/x.md', body: matchingBody(['domains:', '  - wavespestcontrol.com', '  - sarasotaflpestcontrol.com']), url: '/x/' }];
    expect(planner.planForTarget(target, { corpus: c })).toEqual([]);
  });
  test('keeps hub-only domains sources', () => {
    const c = [{ file: 'src/content/services/x.md', body: matchingBody(['domains:', '  - wavespestcontrol.com']), url: '/x/' }];
    expect(planner.planForTarget(target, { corpus: c })).toHaveLength(1);
  });
  test('keeps sources without domains frontmatter (hub-only by default)', () => {
    const c = [{ file: 'src/content/services/x.md', body: matchingBody([]), url: '/x/' }];
    expect(planner.planForTarget(target, { corpus: c })).toHaveLength(1);
  });
  test('skips spoke-canonical sources', () => {
    const c = [{ file: 'src/content/services/x.md', body: matchingBody(['canonical: https://sarasotafllawncare.com/lawn-care-sarasota/']), url: '/x/' }];
    expect(planner.planForTarget(target, { corpus: c })).toEqual([]);
  });
  test('keeps hub-canonical sources', () => {
    const c = [{ file: 'src/content/services/x.md', body: matchingBody(['canonical: https://www.wavespestcontrol.com/x/']), url: '/x/' }];
    expect(planner.planForTarget(target, { corpus: c })).toHaveLength(1);
  });
});

// ── applyTaskToBody integration ─────────────────────────────────────

describe('applyTaskToBody', () => {
  test('replaces first unlinked occurrence with markdown link', () => {
    const body = 'I need pest control bradenton next week.';
    const task = { anchor_text: 'pest control bradenton', target_url: '/pest-control-bradenton-fl/' };
    const out = planner.applyTaskToBody(body, task);
    expect(out).toBe('I need [pest control bradenton](/pest-control-bradenton-fl/) next week.');
  });
  test('preserves source casing of the matched span', () => {
    const body = 'I need Pest Control Bradenton next week.';
    const task = { anchor_text: 'pest control bradenton', target_url: '/pest-control-bradenton-fl/' };
    const out = planner.applyTaskToBody(body, task);
    expect(out).toContain('[Pest Control Bradenton](/pest-control-bradenton-fl/)');
  });
  test('no-op when the phrase isn\'t present', () => {
    const body = 'Different topic entirely.';
    const task = { anchor_text: 'pest control bradenton', target_url: '/x/' };
    expect(planner.applyTaskToBody(body, task)).toBe(body);
  });
  test('no-op for unsafe task target URL', () => {
    const body = 'I need pest control bradenton next week.';
    const task = { anchor_text: 'pest control bradenton', target_url: 'javascript:alert(1)' };
    expect(planner.applyTaskToBody(body, task)).toBe(body);
  });
  test('no-op for markdown-unsafe internal task target URL', () => {
    const body = 'I need pest control bradenton next week.';
    const task = { anchor_text: 'pest control bradenton', target_url: '/pest-control)bradenton/' };
    expect(planner.applyTaskToBody(body, task)).toBe(body);
  });
  test('does not write markdown into MDX component props', () => {
    const body = '<ServiceCard title="pest control bradenton" />\nI need pest control bradenton next week.';
    const task = { anchor_text: 'pest control bradenton', target_url: '/pest-control-bradenton-fl/' };
    const out = planner.applyTaskToBody(body, task);
    expect(out).toBe('<ServiceCard title="pest control bradenton" />\nI need [pest control bradenton](/pest-control-bradenton-fl/) next week.');
  });
  test('re-checks existing target links before applying stale tasks', () => {
    const body = 'I need pest control bradenton next week. [Already linked](/pest-control-bradenton-fl/#faq)';
    const task = { anchor_text: 'pest control bradenton', target_url: '/pest-control-bradenton-fl/' };
    expect(planner.applyTaskToBody(body, task)).toBe(body);
  });
});
