const {
  addReadDepth,
  blogPostLoads,
  classifyPath,
  classifyTrafficSource,
  countsAsPageView,
  formatMarkdown,
  isInternalHost,
  normalizePath,
  summarize,
  parseArgs,
  resolveWindow,
} = require('../../ops/agents/blog-engagement-scorecard');

describe('blog scorecard path classes', () => {
  test.each([
    ['/', 'home'],
    ['/pest-control/florida-huntsman-spider/', 'blog-post'],
    ['/lawn-care/fertilizer-blackout-manatee-county', 'blog-post'],
    ['/pest-control/', 'blog-category'],
    ['/lawn-care/', 'blog-category'],
    ['/pest-control/page/2/', 'blog-category'],
    ['/pest-control/florida-huntsman-spider/extra/', 'other'],
    ['/blog/', 'blog-index'],
    ['/blog/category/pest-control/', 'blog-category'],
    ['/blog/category/lawn-care/?utm_source=blog#posts', 'blog-category'],
    ['/pest-control-calculator/', 'estimate'],
    ['/pest-control-quote-sarasota-fl/', 'estimate'],
    ['/estimate/pest-control/', 'estimate'],
    ['/contact/', 'estimate'],
    ['/pest-control-bradenton-fl/', 'service'],
    ['/pest-control-services/', 'service'],
    ['/pest-inspection/', 'service'],
    ['/cockroach-control/', 'service'],
    ['/mosquito-misting-systems/', 'service'],
    ['/waves-lawn-care/', 'service'],
    ['/sarasota-lawn-weed-control/', 'service'],
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

  test.each([
    ['google.com', 'google'],
    ['www.google.com', 'google'],
    ['google.co.uk', 'google'],
    ['news.google.com', 'google'],
    ['GOOGLE.COM', 'google'],
    [' google.com ', 'google'],
    ['facebook.com', 'facebook'],
    ['www.facebook.com', 'facebook'],
    ['m.facebook.com', 'facebook'],
    ['l.facebook.com', 'facebook'],
    ['lm.facebook.com', 'facebook'],
    ['fb.me', 'facebook'],
    ['FB.ME', 'facebook'],
    ['', 'direct'],
    [null, 'direct'],
    [undefined, 'direct'],
    ['www.bing.com', 'other'],
    ['notgoogle.com', 'other'],
    ['googleusercontent.com', 'other'],
    ['google.example.com', 'other'],
    ['google.com.evil.example', 'other'],
    ['google.evil.example.com', 'other'],
    ['facebook.com.evil.example', 'other'],
    ['fb.me.example.com', 'other'],
  ])('classifies referrer host %s as %s', (host, expected) => {
    expect(classifyTrafficSource(host)).toBe(expected);
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

  test('breaks landings down by traffic source, volume and share only', () => {
    const s = summarize(groups);
    // huntsman got 100 views from google and 50 with no referrer (direct);
    // bagworm got 40 from bing (other); 190 external landings in all.
    expect(s.sources).toEqual([
      { source: 'google', label: 'Google', views: 100, share: 100 / 190 },
      { source: 'facebook', label: 'Facebook', views: 0, share: 0 },
      { source: 'other', label: 'Other', views: 40, share: 40 / 190 },
      { source: 'direct', label: 'Direct/none', views: 50, share: 50 / 190 },
    ]);
  });

  test('never reports a per-source engagement rate', () => {
    const s = summarize([
      { path: '/pest-control/a/', refererHost: 'www.google.com', refererPath: '/', views: 10 },
      { path: '/contact/', refererHost: 'www.wavespestcontrol.com', refererPath: '/pest-control/a/', views: 4 },
      { path: '/pest-control/b/', refererHost: 'm.facebook.com', refererPath: '/', views: 5 },
    ]);
    for (const src of s.sources) expect(src).not.toHaveProperty('rate');
    expect(s.totals).not.toHaveProperty('googleOnwardRate');
    expect(s.sources).toContainEqual({ source: 'google', label: 'Google', views: 10, share: 10 / 15 });
    expect(s.sources).toContainEqual({ source: 'facebook', label: 'Facebook', views: 5, share: 5 / 15 });
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
      { path: '/pest-control/a/', refererHost: 'www.google.com', refererPath: '/', navigationType: 'reload-cache', views: 4 },
      { path: '/contact/', ...base, navigationType: 'navigate', views: 2 },
      { path: '/contact/', ...base, navigationType: 'reload', views: 3 },
      { path: '/contact/', ...base, navigationType: 'back-forward', views: 5 },
      { path: '/contact/', ...base, navigationType: 'back-forward-cache', views: 5 },
      { path: '/contact/', ...base, navigationType: 'restore', views: 6 },
      { path: '/pest-control/b/', ...base, navigationType: 'routing-apis', views: 7 },
      { path: '/pest-control/b/', ...base, navigationType: 'soft-navigation', views: 7 },
      { path: '/pest-control/b/', ...base, navigationType: 'unknown', views: 1 },
    ]);
    expect(s.totals).toEqual({ blogEntries: 10, blogViews: 11, onwardClicks: 3, onwardRate: 3 / 11 });
  });

  test('cached, prefetched and prerendered link clicks count as fresh navigations', () => {
    const base = { refererHost: 'www.wavespestcontrol.com', refererPath: '/pest-control/a/' };
    const s = summarize([
      { path: '/pest-control/a/', refererHost: 'www.google.com', refererPath: '/', navigationType: 'navigate-cache', views: 3 },
      { path: '/pest-control/a/', refererHost: 'www.google.com', refererPath: '/', navigationType: 'prerender', views: 2 },
      { path: '/pest-control/b/', ...base, navigationType: 'navigate-prefetch-cache', views: 1 },
      { path: '/pest-control-quote/', ...base, navigationType: 'navigate_prefetch', views: 1 },
      { path: '/contact/', ...base, navigationType: 'Navigate Cache', views: 1 },
    ]);
    expect(s.totals).toEqual({ blogEntries: 5, blogViews: 6, onwardClicks: 3, onwardRate: 3 / 6 });
    expect(countsAsPageView('navigate')).toBe(true);
    expect(countsAsPageView('Navigate Prefetch Cache')).toBe(true);
    expect(countsAsPageView('navigate_cache')).toBe(true);
    expect(countsAsPageView('navigate_prefetch')).toBe(true);
    expect(countsAsPageView('Navigate Prefetch')).toBe(true);
    expect(countsAsPageView(undefined)).toBe(true);
    expect(countsAsPageView('reload-cache')).toBe(false);
    expect(countsAsPageView('soft-navigation')).toBe(false);
  });

  test('handles empty input', () => {
    expect(summarize([])).toEqual({
      totals: { blogEntries: 0, blogViews: 0, onwardClicks: 0, onwardRate: null },
      destinations: [],
      posts: [],
      sources: [
        { source: 'google', label: 'Google', views: 0, share: null },
        { source: 'facebook', label: 'Facebook', views: 0, share: null },
        { source: 'other', label: 'Other', views: 0, share: null },
        { source: 'direct', label: 'Direct/none', views: 0, share: null },
      ],
    });
  });

  test('formats a markdown report', () => {
    const md = formatMarkdown(summarize(groups), { start: '2026-09-19', end: '2026-09-25', top: 1 });
    expect(md).toContain('## Blog engagement scorecard, 2026-09-19 to 2026-09-25');
    expect(md).toContain('Blog post views (fresh navigations): 196, of which 190 began a visit');
    expect(md).toContain('Onward page views referred by a post: 9 (4.6% per post view)');
    expect(md).toContain('Blog landings from Google: 100 (52.6% of blog landings)');
    expect(md).not.toContain('Onward rate, Google');
    expect(md).toContain('| Another blog post | 6 |');
    expect(md).toContain('### Traffic source (blog-post landings)');
    expect(md).toContain('| Source | Page loads | Share |');
    expect(md).toContain('| Google | 100 | 52.6% |');
    expect(md).toContain('| Facebook | 0 | 0.0% |');
    expect(md).toContain('| Other | 40 | 21.1% |');
    expect(md).toContain('| Direct/none | 50 | 26.3% |');
    expect(md).toContain('| /pest-control/huntsman/ | 150 | 150 | 8 | 5.3% | 2 |');
    expect(md).not.toContain('/pest-control/bagworm/ |');
  });
});

describe('read depth', () => {
  const groups = [
    { path: '/pest-control/huntsman/', refererHost: 'www.google.com', refererPath: '/', views: 150 },
    // a reload re-runs the counter: not a fresh view, but a load
    { path: '/pest-control/huntsman/', refererHost: 'www.wavespestcontrol.com', refererPath: '/pest-control/huntsman/', navigationType: 'reload', views: 50 },
    // a bfcache restore and an in-page route change run nothing new
    { path: '/pest-control/huntsman/', refererHost: '', refererPath: '', navigationType: 'back-forward-cache', views: 7 },
    { path: '/pest-control/huntsman/', refererHost: '', refererPath: '', navigationType: 'routing-apis', views: 5 },
    { path: '/pest-control/bagworm/', refererHost: 'www.google.com', refererPath: '/', views: 40 },
    { path: '/pest-control-sarasota-fl/', refererHost: 'www.google.com', refererPath: '/', views: 70 },
  ];
  const summary = summarize(groups);
  const loads = blogPostLoads(groups);
  const depthRows = [
    { path: '/pest-control/huntsman/', milestone: '25', count: 60 },
    { path: '/pest-control/huntsman/', milestone: '50', count: 30 },
    { path: '/pest-control/huntsman/', milestone: '100', count: 12 },
    { path: '/pest-control/huntsman/', milestone: 'next', count: 9 },
    { path: '/pest-control/bagworm', milestone: '50', count: '4' }, // pg may hand back strings; no trailing slash
    { path: '/pest-control/unsampled/', milestone: '50', count: 5 }, // Cloudflare never sampled it
    { path: '/pest-control/huntsman/', milestone: 'bogus', count: 3 },
    { path: '/pest-control/huntsman/', milestone: '75', count: 0 },
  ];

  test('page loads that run the counter: reloads and back/forward count, bfcache restores and route changes do not', () => {
    const l = blogPostLoads([
      { path: '/pest-control/a/', navigationType: 'navigate', views: 10 },
      { path: '/pest-control/a/', navigationType: 'reload', views: 3 },
      { path: '/pest-control/a/', navigationType: 'back-forward', views: 2 },
      { path: '/pest-control/a/', navigationType: 'restore', views: 1 },
      { path: '/pest-control/a/', navigationType: 'back-forward-cache', views: 4 },
      { path: '/pest-control/a/', navigationType: 'routing-apis', views: 5 },
      { path: '/pest-control/a/', navigationType: 'soft-navigation', views: 6 },
      { path: '/pest-control-sarasota-fl/', navigationType: 'reload', views: 9 },
    ]);
    expect(l.byPath.get('/pest-control/a/')).toBe(16);
    expect(l.total).toBe(16);
  });

  test('joins counts onto the posts, with rates per page load', () => {
    const rd = addReadDepth(summary, depthRows, { start: '2026-09-28', end: '2026-10-05', loads });
    expect(rd.coverage).toBe('full');
    expect(rd.posts[0]).toEqual({
      path: '/pest-control/huntsman/', loads: 200, r25: 60, r50: 30, r75: 0, r100: 12, next: 9, halfRate: 0.15, nextRate: 0.045,
    });
    expect(rd.posts[1]).toMatchObject({ path: '/pest-control/bagworm/', loads: 40, r50: 4, halfRate: 0.1, nextRate: 0 });
    // the unsampled post reaches the count totals (39 at 50%) but not the
    // rates, whose denominator has none of its loads: (30 + 4) / 240
    expect(rd.totals).toMatchObject({ r25: 60, r50: 39, r75: 0, r100: 12, next: 9, loads: 240 });
    expect(rd.totals.halfRate).toBeCloseTo(34 / 240);
    expect(rd.totals.nextRate).toBeCloseTo(9 / 240);
  });

  test('coverage follows the window: none before counting began, partial across it, full after', () => {
    const none = addReadDepth(summary, depthRows, { start: '2026-09-20', end: '2026-09-27', loads });
    expect(none).toEqual({ liveSince: '2026-09-27', coverage: 'none', totals: null, posts: [] });
    expect(addReadDepth(summary, [], { start: '2026-09-21', end: '2026-09-28', loads }).coverage).toBe('partial');
    expect(addReadDepth(summary, [], { start: '2026-09-27', end: '2026-10-04', loads }).coverage).toBe('partial');
    expect(addReadDepth(summary, [], { start: '2026-09-28', end: '2026-10-05', loads }).coverage).toBe('full');
  });

  test('no loads means no rate, never a divide-by-zero', () => {
    const rd = addReadDepth(summarize([]), depthRows, { start: '2026-10-01', end: '2026-10-08', loads: blogPostLoads([]) });
    expect(rd.totals.halfRate).toBeNull();
    expect(rd.posts).toEqual([]);
  });

  test('a window spanning the first counted day gets counts but no rates', () => {
    const rd = addReadDepth(summary, depthRows, { start: '2026-09-21', end: '2026-09-28', loads });
    expect(rd.coverage).toBe('partial');
    expect(rd.totals).toMatchObject({ r50: 39, halfRate: null, nextRate: null });
    expect(rd.posts[0]).toMatchObject({ r50: 30, halfRate: null, nextRate: null });
    const md = formatMarkdown(summary, { start: '2026-09-21', end: '2026-09-27', top: 1, readDepth: rd });
    expect(md).toContain('Counting began 2026-09-27 (Eastern), partway through this window: counts cover only the days since, and rates are left out.');
    expect(md).not.toContain('Half-read:');
    expect(md).toContain('| /pest-control/huntsman/ | 200 | 60 | 30 | 0 | 12 | 9 | — | — |');
  });

  test('a fully covered window shows every milestone and the rates, labelled as page loads', () => {
    const readDepth = addReadDepth(summary, depthRows, { start: '2026-09-28', end: '2026-10-05', loads });
    const md = formatMarkdown(summary, { start: '2026-09-28', end: '2026-10-04', top: 1, readDepth });
    expect(md).toContain('### Read depth (cookie-free counts, hub)');
    expect(md).not.toContain('Counting began');
    expect(md).toContain('Page loads reaching 25 / 50 / 75 / 100% of a post: 60 / 39 / 0 / 12; reaching the keep-reading row: 9 (loads, not people: a reload counts again)');
    expect(md).toContain('Half-read: 14.2% of 240 post loads; reached keep reading: 3.8% (over the posts Cloudflare sampled, so approximate)');
    expect(md).toContain('| Post (top 1 by views) | Loads | 25% | 50% | 75% | 100% | Keep reading | Half-read | Reached keep reading |');
    expect(md).toContain('| /pest-control/huntsman/ | 200 | 60 | 30 | 0 | 12 | 9 | 15.0% | 4.5% |');
    expect(md).not.toContain('| /pest-control/bagworm/ | 40 |');
    expect(md).not.toMatch(/Readers/);
  });

  test('a window before counting says so instead of printing zeros; unavailable and not-asked stay distinct', () => {
    const before = addReadDepth(summary, depthRows, { start: '2026-09-19', end: '2026-09-26', loads });
    const md = formatMarkdown(summary, { start: '2026-09-19', end: '2026-09-25', readDepth: before });
    expect(md).toContain('Read depth: none for this window (counting began 2026-09-27, Eastern).');
    expect(md).not.toContain('### Read depth');
    expect(formatMarkdown(summary, { start: 'a', end: 'b', readDepth: null })).toContain('Read depth: not included (needs DATABASE_PUBLIC_URL');
    expect(formatMarkdown(summary, { start: 'a', end: 'b' })).not.toContain('Read depth');
  });
});

describe('script arguments', () => {
  test('parses flags with and without values', () => {
    expect(parseArgs(['--days', '14', '--json', '--end=2026-09-25'])).toEqual({ days: '14', json: true, end: '2026-09-25' });
  });

  test('windows run Eastern midnight to Eastern midnight, across DST', () => {
    const w = resolveWindow({ days: 3, end: '2026-11-03' });
    expect(w.startStr).toBe('2026-10-31');
    expect(w.lastDayStr).toBe('2026-11-02');
    expect(w.slices).toHaveLength(1);
    expect(w.slices[0].from.toISOString()).toBe('2026-10-31T04:00:00.000Z'); // EDT
    expect(w.slices[0].to.toISOString()).toBe('2026-11-03T05:00:00.000Z'); // EST
  });

  test('long windows split into consecutive 7-day slices with no gaps', () => {
    const w = resolveWindow({ days: 16, end: '2026-09-26' });
    expect(w.startStr).toBe('2026-09-10');
    expect(w.slices.map((s) => s.fromStr)).toEqual(['2026-09-10', '2026-09-17', '2026-09-24']);
    for (let i = 1; i < w.slices.length; i += 1) {
      expect(w.slices[i].from.getTime()).toBe(w.slices[i - 1].to.getTime());
    }
    expect(w.slices[2].to.toISOString()).toBe('2026-09-26T04:00:00.000Z');
  });

  test('defaults the end to today in Eastern time', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-27T02:30:00.000Z')); // 10:30 PM ET on Sept 26
    try {
      expect(resolveWindow({ days: 7 }).endStr).toBe('2026-09-26');
    } finally {
      jest.useRealTimers();
    }
  });

  test('accepts leap days', () => {
    expect(resolveWindow({ days: 1, end: '2024-02-29' }).lastDayStr).toBe('2024-02-28');
    expect(resolveWindow({ days: 1, end: '2000-02-29' }).startStr).toBe('2000-02-28');
  });

  test.each([
    '09/25/2026',
    '2026-00-15',
    '2026-13-01',
    '2026-01-00',
    '2026-04-31',
    '2026-02-29',
    '1900-02-29',
    true,
  ])('rejects an impossible or malformed --end (%s)', (value) => {
    expect(() => resolveWindow({ days: 7, end: value })).toThrow('--end must be a valid calendar date');
  });
});
