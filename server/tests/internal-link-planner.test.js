/**
 * Unit tests for internal-link-planner pure helpers.
 *
 * The async loadAstroCorpus reads files from disk — exercised by the
 * CLI smoke test, not jest.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const planner = require('../services/content/internal-link-planner');
const {
  anchorCandidates,
  maskExcludedRegions,
  findFirstUnlinkedOccurrence,
  isInsideLink,
  snippetAround,
  pageAlreadyLinksTo,
  stripHost,
  sameUrl,
  deriveUrlFromFile,
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
  test('de-dupes case-insensitively', () => {
    const out = anchorCandidates({ keyword: 'Pest Control', title: 'pest control' });
    expect(out.length).toBe(1);
  });
  test('handles minimal input', () => {
    expect(anchorCandidates({ url: '/x/' })).toEqual([]);
    expect(anchorCandidates({ url: '/x/', service: 'pest' })).toEqual([]); // no city → no phrase
    expect(anchorCandidates({ url: '/x/', city: 'Bradenton' })).toEqual([]);
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
  test('masks HTML comments', () => {
    const src = '<!-- pest control bradenton --> real pest control bradenton';
    const masked = maskExcludedRegions(src);
    expect(masked.indexOf('<!--')).toBe(-1);
    expect(masked.indexOf('real')).toBe(src.indexOf('real'));
  });
});

// ── isInsideLink ────────────────────────────────────────────────────

describe('isInsideLink', () => {
  test('detects markdown link inner text', () => {
    const t = 'See [our pest control bradenton page](/pest-control-bradenton-fl/) for details';
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
  test('case-insensitive match, preserves source casing in snippet', () => {
    const t = 'Pest Control Bradenton service area.';
    const r = findFirstUnlinkedOccurrence(t, 'pest control bradenton');
    expect(t.slice(r.index, r.index + r.length)).toBe('Pest Control Bradenton');
  });
  test('returns null for empty inputs', () => {
    expect(findFirstUnlinkedOccurrence('', 'x')).toBeNull();
    expect(findFirstUnlinkedOccurrence('x', '')).toBeNull();
  });
});

// ── pageAlreadyLinksTo ──────────────────────────────────────────────

describe('pageAlreadyLinksTo', () => {
  test('detects markdown link to target', () => {
    expect(pageAlreadyLinksTo('[x](/pest-control-bradenton-fl/)', '/pest-control-bradenton-fl/')).toBe(true);
  });
  test('detects href= to target', () => {
    expect(pageAlreadyLinksTo('<a href="/pest-control-bradenton-fl/">x</a>', '/pest-control-bradenton-fl/')).toBe(true);
  });
  test('returns false when no link to target', () => {
    expect(pageAlreadyLinksTo('[other](/lawn-care/)', '/pest-control-bradenton-fl/')).toBe(false);
  });
  test('matches across host', () => {
    expect(pageAlreadyLinksTo(
      '[x](https://www.wavespestcontrol.com/pest-control-bradenton-fl/)',
      'https://other.host/pest-control-bradenton-fl/'
    )).toBe(true);
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
  test('deriveUrlFromFile', () => {
    expect(deriveUrlFromFile('blog', 'foo.md')).toBe('/blog/foo/');
    expect(deriveUrlFromFile('services', 'pest-control-bradenton-fl.md')).toBe('/pest-control-bradenton-fl/');
    expect(deriveUrlFromFile('locations', 'siesta-key.mdx')).toBe('/siesta-key/');
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
  test('never links page to itself', () => {
    const c = [{ file: 'src/content/services/pest-control-bradenton-fl.md', body: 'pest control bradenton here', url: '/pest-control-bradenton-fl/' }];
    expect(planner.planForTarget(target, { corpus: c })).toEqual([]);
  });
  test('returns [] for target with no anchor candidates', () => {
    expect(planner.planForTarget({ url: '/x/' }, { corpus })).toEqual([]);
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
});
