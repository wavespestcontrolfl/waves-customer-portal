const {
  classifyPath,
  formatMarkdown,
  isInternalHost,
  normalizePath,
  summarize,
  parseArgs,
  utcMidnight,
} = require('../../ops/agents/blog-engagement-scorecard');

describe('blog scorecard path classes', () => {
  test.each([
    ['/', 'home'],
    ['/pest-control/florida-huntsman-spider/', 'blog-post'],
    ['/lawn-care/fertilizer-blackout-manatee-county', 'blog-post'],
    ['/pest-control/', 'blog-category'],
    ['/lawn-care/', 'blog-category'],
    ['/blog/', 'blog-index'],
    ['/pest-control-calculator/', 'estimate'],
    ['/pest-control-quote-sarasota-fl/', 'estimate'],
    ['/estimate/pest-control/', 'estimate'],
    ['/contact/', 'estimate'],
    ['/pest-control-bradenton-fl/', 'service'],
    ['/pest-control-services/', 'service'],
    ['/waveguard-memberships/', 'service'],
    ['/pest-library/', 'pest-library'],
    ['/pest-identifier/huntsman-spider/', 'pest-identifier'],
    ['/tools/pest-pressure-forecast/', 'tools'],
    ['/about/authors/adam-benetti/', 'other'],
  ])('%s -> %s', (path, cls) => {
    expect(classifyPath(path)).toBe(cls);
  });

  test('normalizes query strings, hashes and slashes', () => {
    expect(normalizePath('/pest-control/x?utm=1#top')).toBe('/pest-control/x/');
    expect(normalizePath('')).toBe('/');
    expect(normalizePath(null)).toBe('/');
  });

  test('only the hub hosts count as internal', () => {
    expect(isInternalHost('www.wavespestcontrol.com')).toBe(true);
    expect(isInternalHost('WavesPestControl.com ')).toBe(true);
    expect(isInternalHost('www.google.com')).toBe(false);
    expect(isInternalHost('')).toBe(false);
    expect(isInternalHost('portal.wavespestcontrol.com')).toBe(false);
  });
});

describe('summarize', () => {
  const groups = [
    { path: '/pest-control/huntsman/', refererHost: 'www.google.com', refererPath: '/', views: 100 },
    { path: '/pest-control/huntsman/', refererHost: '', refererPath: '', views: 50 },
    { path: '/pest-control/bagworm/', refererHost: 'www.bing.com', refererPath: '/', views: 40 },
    { path: '/pest-control/wolf-spider/', refererHost: 'www.wavespestcontrol.com', refererPath: '/pest-control/huntsman/', views: 6 },
    { path: '/pest-control-calculator/', refererHost: 'www.wavespestcontrol.com', refererPath: '/pest-control/huntsman/', views: 2 },
    { path: '/pest-control-bradenton-fl/', refererHost: 'wavespestcontrol.com', refererPath: '/pest-control/bagworm', views: 1 },
    // reload of the same post: not an onward click
    { path: '/pest-control/huntsman/', refererHost: 'www.wavespestcontrol.com', refererPath: '/pest-control/huntsman/', views: 9 },
    // internal navigation that did not start on a post
    { path: '/pest-control-calculator/', refererHost: 'www.wavespestcontrol.com', refererPath: '/pest-control-sarasota-fl/', views: 30 },
    // entries to non-blog pages are not blog entries
    { path: '/pest-control-sarasota-fl/', refererHost: 'www.google.com', refererPath: '/', views: 70 },
    { path: '/pest-control/bagworm/', refererHost: 'www.google.com', refererPath: '/', views: 0 },
  ];

  test('counts blog entries and onward clicks, ignoring self-referrals', () => {
    const s = summarize(groups);
    expect(s.totals).toEqual({ blogEntries: 190, onwardClicks: 9, onwardRate: 9 / 190 });
  });

  test('breaks down destinations by class', () => {
    const s = summarize(groups);
    expect(s.destinations.map((d) => [d.cls, d.views])).toEqual([
      ['blog-post', 6],
      ['estimate', 2],
      ['service', 1],
    ]);
    expect(s.destinations[0].label).toBe('Another blog post');
  });

  test('reports per-post rows sorted by entries', () => {
    const s = summarize(groups);
    expect(s.posts).toEqual([
      { path: '/pest-control/huntsman/', entries: 150, onward: 8, toEstimateOrService: 2, rate: 8 / 150 },
      { path: '/pest-control/bagworm/', entries: 40, onward: 1, toEstimateOrService: 1, rate: 1 / 40 },
    ]);
  });

  test('handles empty input', () => {
    expect(summarize([])).toEqual({
      totals: { blogEntries: 0, onwardClicks: 0, onwardRate: null },
      destinations: [],
      posts: [],
    });
  });

  test('formats a markdown report', () => {
    const md = formatMarkdown(summarize(groups), { start: '2026-09-19', end: '2026-09-25', top: 1 });
    expect(md).toContain('## Blog engagement scorecard, 2026-09-19 to 2026-09-25');
    expect(md).toContain('Onward clicks from posts to another page: 9 (4.7%)');
    expect(md).toContain('| Another blog post | 6 |');
    expect(md).toContain('| /pest-control/huntsman/ | 150 | 8 | 5.3% | 2 |');
    expect(md).not.toContain('/pest-control/bagworm/ |');
  });
});

describe('script arguments', () => {
  test('parses flags with and without values', () => {
    expect(parseArgs(['--days', '14', '--json', '--end=2026-09-25'])).toEqual({ days: '14', json: true, end: '2026-09-25' });
  });

  test('utcMidnight validates the date format', () => {
    expect(utcMidnight('2026-09-25').toISOString()).toBe('2026-09-25T00:00:00.000Z');
    expect(() => utcMidnight('09/25/2026')).toThrow('--end must be YYYY-MM-DD');
  });
});
