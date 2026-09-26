const {
  classifyPath,
  countsAsPageView,
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

  test('counts post views, entries and onward clicks per view, ignoring reloads', () => {
    const s = summarize(groups);
    expect(s.totals).toEqual({ blogEntries: 190, blogViews: 196, onwardClicks: 9, onwardRate: 9 / 196 });
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

  test('reports per-post rows sorted by views, with internal arrivals counted as views', () => {
    const s = summarize(groups);
    expect(s.posts).toEqual([
      { path: '/pest-control/huntsman/', entries: 150, views: 150, onward: 8, toEstimateOrService: 2, rate: 8 / 150 },
      { path: '/pest-control/bagworm/', entries: 40, views: 40, onward: 1, toEstimateOrService: 1, rate: 1 / 40 },
      { path: '/pest-control/wolf-spider/', entries: 0, views: 6, onward: 0, toEstimateOrService: 0, rate: 0 },
    ]);
  });

  test('a visit that reads two posts is two views, never two clicks against one entry', () => {
    const s = summarize([
      { path: '/pest-control/a/', refererHost: 'www.google.com', refererPath: '/', views: 1 },
      { path: '/pest-control/b/', refererHost: 'www.wavespestcontrol.com', refererPath: '/pest-control/a/', views: 1 },
      { path: '/contact/', refererHost: 'www.wavespestcontrol.com', refererPath: '/pest-control/b/', views: 1 },
    ]);
    expect(s.totals).toEqual({ blogEntries: 1, blogViews: 2, onwardClicks: 2, onwardRate: 1 });
    expect(s.posts.map((p) => [p.path, p.views, p.onward, p.rate])).toEqual([
      ['/pest-control/a/', 1, 1, 1],
      ['/pest-control/b/', 1, 1, 1],
    ]);
    expect(s.destinations.map((d) => [d.cls, d.views])).toEqual([
      ['blog-post', 1],
      ['estimate', 1],
    ]);
  });

  test('only fresh navigations count: reloads, back/forward, restores and in-page jumps are skipped', () => {
    const base = { refererHost: 'www.wavespestcontrol.com', refererPath: '/pest-control/a/' };
    const s = summarize([
      { path: '/pest-control/a/', refererHost: 'www.google.com', refererPath: '/', navigationType: 'navigate', views: 10 },
      { path: '/pest-control/a/', refererHost: 'www.google.com', refererPath: '/', navigationType: 'reload', views: 4 },
      { path: '/contact/', ...base, navigationType: 'navigate', views: 2 },
      { path: '/contact/', ...base, navigationType: 'reload', views: 3 },
      { path: '/contact/', ...base, navigationType: 'back-forward', views: 5 },
      { path: '/contact/', ...base, navigationType: 'restore', views: 6 },
      { path: '/pest-control/b/', ...base, navigationType: 'routing-apis', views: 7 },
      { path: '/pest-control/b/', ...base, navigationType: 'unknown', views: 1 },
    ]);
    expect(s.totals).toEqual({ blogEntries: 10, blogViews: 11, onwardClicks: 3, onwardRate: 3 / 11 });
    expect(countsAsPageView('navigate')).toBe(true);
    expect(countsAsPageView('Navigate')).toBe(true);
    expect(countsAsPageView(undefined)).toBe(true);
    expect(countsAsPageView('prerender')).toBe(false);
  });

  test('handles empty input', () => {
    expect(summarize([])).toEqual({
      totals: { blogEntries: 0, blogViews: 0, onwardClicks: 0, onwardRate: null },
      destinations: [],
      posts: [],
    });
  });

  test('formats a markdown report', () => {
    const md = formatMarkdown(summarize(groups), { start: '2026-09-19', end: '2026-09-25', top: 1 });
    expect(md).toContain('## Blog engagement scorecard, 2026-09-19 to 2026-09-25');
    expect(md).toContain('Blog post views (fresh navigations): 196, of which 190 began a visit');
    expect(md).toContain('Onward page views referred by a post: 9 (4.6% per post view)');
    expect(md).toContain('| Another blog post | 6 |');
    expect(md).toContain('| /pest-control/huntsman/ | 150 | 150 | 8 | 5.3% | 2 |');
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
