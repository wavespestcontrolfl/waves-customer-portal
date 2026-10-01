jest.mock('../models/db', () => jest.fn());

const liveStatus = require('../services/content/content-registry-live-status');
const liveCli = require('../scripts/check-content-registry-live-status');

function response(status, body = '', headers = {}, url = '') {
  return {
    status,
    url,
    headers: {
      get(name) {
        return headers[String(name || '').toLowerCase()] || null;
      },
    },
    text: async () => body,
  };
}

function fetchMap(routes) {
  return async (url) => {
    const value = routes[url];
    if (!value) throw new Error(`Unexpected fetch ${url}`);
    if (value instanceof Error) throw value;
    return value;
  };
}

function fakeDatabase(rows) {
  const updates = [];
  const query = {};
  query.whereIn = jest.fn(() => query);
  query.orderByRaw = jest.fn(() => query);
  query.orderBy = jest.fn(() => query);
  query.limit = jest.fn(async () => rows);
  function database(table) {
    if (table !== 'content_registry') throw new Error(`Unexpected table ${table}`);
    return {
      select: () => query,
      where: (_field, id) => ({
        update: async (payload) => {
          updates.push({ id, payload });
          return 1;
        },
      }),
    };
  }
  database.updates = updates;
  database.query = query;
  return database;
}

describe('content registry live status helpers', () => {
  test('builds absolute Waves URLs from registry paths', () => {
    expect(liveStatus.buildAbsoluteUrl('/blog/test/')).toBe('https://www.wavespestcontrol.com/blog/test/');
    expect(liveStatus.buildAbsoluteUrl('blog/test')).toBe('https://www.wavespestcontrol.com/blog/test');
    expect(liveStatus.buildAbsoluteUrl('https://example.com/x')).toBe('https://example.com/x');
  });

  test('extracts canonical and robots attributes independent of HTML order', () => {
    const html = `
      <link href="/canonical-first/" data-x="1" rel="preload canonical">
      <meta content="noindex,nofollow" name="robots">
    `;
    expect(liveStatus.extractCanonical(html, 'https://www.wavespestcontrol.com/source/'))
      .toBe('https://www.wavespestcontrol.com/canonical-first/');
    expect(liveStatus.extractRobots(html)).toBe('noindex,nofollow');
    expect(liveStatus.isNoindex(html)).toBe(true);
  });

  test('prefers an absolute spoke canonical over a relative Astro live route', () => {
    expect(liveStatus.targetUrlForRow({
      live_url: '/termite/spoke-post/',
      canonical_url: 'https://www.sarasotaflpestcontrol.com/different-canonical/',
    })).toBe('https://www.sarasotaflpestcontrol.com/termite/spoke-post/');
  });

  test('refuses initial and redirected live checks outside the content fleet', async () => {
    const initialFetch = jest.fn();
    await expect(liveStatus.checkRegistryRowLiveStatus(
      { id: 'off-fleet', live_url: 'http://169.254.169.254/latest/meta-data/' },
      { fetchImpl: initialFetch },
    )).resolves.toEqual(expect.objectContaining({
      live_status: 'unknown',
      error: 'No URL available for registry row',
    }));
    expect(initialFetch).not.toHaveBeenCalled();

    const redirectFetch = jest.fn(fetchMap({
      'https://www.wavespestcontrol.com/redirect-out/': response(302, '', {
        location: 'http://127.0.0.1/admin',
      }),
    }));
    await expect(liveStatus.checkRegistryRowLiveStatus(
      { id: 'redirect-out', canonical_url_normalized: '/redirect-out/' },
      { fetchImpl: redirectFetch },
    )).resolves.toEqual(expect.objectContaining({
      live_status: 'error',
      error: expect.stringMatching(/outside the content fleet/),
    }));
    expect(redirectFetch).toHaveBeenCalledTimes(1);
  });

  test('classifies direct canonicalized pages', async () => {
    const result = await liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-1', canonical_url_normalized: '/old/' },
      {
        fetchImpl: fetchMap({
          'https://www.wavespestcontrol.com/old/': response(
            200,
            '<html><head><link rel="canonical" href="https://www.wavespestcontrol.com/new/" /></head></html>',
            {},
            'https://www.wavespestcontrol.com/old/',
          ),
        }),
        sitemapPaths: new Set(['/new/']),
      },
    );

    expect(result).toEqual(expect.objectContaining({
      http_status: '200',
      live_status: 'canonicalized',
      canonical_target_url: 'https://www.wavespestcontrol.com/new/',
      sitemap_present: true,
      sitemap_status: 'present',
    }));
  });

  test('classifies legacy redirects and captures final canonical signal', async () => {
    const result = await liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-2', canonical_url_normalized: '/legacy/' },
      {
        fetchImpl: fetchMap({
          'https://www.wavespestcontrol.com/legacy/': response(301, '', { location: '/new/' }),
          'https://www.wavespestcontrol.com/new/': response(
            200,
            '<html><head><link rel="canonical" href="/canonical/" /></head></html>',
            {},
            'https://www.wavespestcontrol.com/new/',
          ),
        }),
        sitemapPaths: new Set(['/canonical/']),
      },
    );

    expect(result).toEqual(expect.objectContaining({
      http_status: '301',
      live_status: 'redirected',
      redirect_target_url: 'https://www.wavespestcontrol.com/new/',
      canonical_target_url: 'https://www.wavespestcontrol.com/canonical/',
      sitemap_present: true,
    }));
  });

  test('classifies redirects by final target health', async () => {
    await expect(liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-redirect-missing', canonical_url_normalized: '/legacy-missing/' },
      {
        fetchImpl: fetchMap({
          'https://www.wavespestcontrol.com/legacy-missing/': response(301, '', { location: '/gone/' }),
          'https://www.wavespestcontrol.com/gone/': response(404, '', {}, 'https://www.wavespestcontrol.com/gone/'),
        }),
      },
    )).resolves.toEqual(expect.objectContaining({
      http_status: '301',
      live_status: 'missing',
      redirect_target_url: 'https://www.wavespestcontrol.com/gone/',
    }));
  });

  test('marks redirect target fetch failures as errors', async () => {
    const result = await liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-redirect-error', canonical_url_normalized: '/legacy-error/' },
      {
        fetchImpl: fetchMap({
          'https://www.wavespestcontrol.com/legacy-error/': response(302, '', { location: '/timeout/' }),
          'https://www.wavespestcontrol.com/timeout/': new Error('timeout'),
        }),
      },
    );

    expect(result).toEqual(expect.objectContaining({
      http_status: '302',
      live_status: 'error',
      redirect_target_url: 'https://www.wavespestcontrol.com/timeout/',
      error: 'Redirect target check failed: timeout',
    }));
  });

  test('classifies missing and noindex pages', async () => {
    await expect(liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-3', canonical_url_normalized: '/missing/' },
      { fetchImpl: fetchMap({ 'https://www.wavespestcontrol.com/missing/': response(404) }) },
    )).resolves.toEqual(expect.objectContaining({
      http_status: '404',
      live_status: 'missing',
    }));

    await expect(liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-4', canonical_url_normalized: '/hidden/' },
      {
        fetchImpl: fetchMap({
          'https://www.wavespestcontrol.com/hidden/': response(
            200,
            '<html><head><meta name="robots" content="noindex,nofollow" /></head></html>',
          ),
        }),
      },
    )).resolves.toEqual(expect.objectContaining({
      http_status: '200',
      live_status: 'noindex',
      noindex_detected: true,
    }));
  });

  // codex pre-push audit finding: the documented health contract covers
  // meta robots OR the X-Robots-Tag header — a header-only noindex (no meta
  // tag at all) must not be reported as healthy, on a direct response or on
  // a redirect's landed page.
  test('an X-Robots-Tag header noindex is detected even with no meta tag at all', async () => {
    await expect(liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-header-noindex', canonical_url_normalized: '/header-hidden/' },
      {
        fetchImpl: fetchMap({
          'https://www.wavespestcontrol.com/header-hidden/': response(200, '<html></html>', { 'x-robots-tag': 'noindex' }),
        }),
      },
    )).resolves.toEqual(expect.objectContaining({
      http_status: '200',
      live_status: 'noindex',
      noindex_detected: true,
    }));
  });

  test('an X-Robots-Tag header noindex on a redirect\'s landed page is detected too', async () => {
    await expect(liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-redirect-header-noindex', canonical_url_normalized: '/legacy-header-hidden/' },
      {
        fetchImpl: fetchMap({
          'https://www.wavespestcontrol.com/legacy-header-hidden/': response(301, '', { location: '/header-hidden/' }),
          'https://www.wavespestcontrol.com/header-hidden/': response(200, '<html></html>', { 'x-robots-tag': 'noindex' }, 'https://www.wavespestcontrol.com/header-hidden/'),
        }),
      },
    )).resolves.toEqual(expect.objectContaining({
      http_status: '301',
      live_status: 'noindex',
      noindex_detected: true,
    }));
  });

  test('a 5xx classifies as server_error, distinct from a generic checker error', async () => {
    await expect(liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-5xx', canonical_url_normalized: '/down/' },
      { fetchImpl: fetchMap({ 'https://www.wavespestcontrol.com/down/': response(503) }) },
    )).resolves.toEqual(expect.objectContaining({
      http_status: '503',
      live_status: 'server_error',
    }));
  });

  // Shared body-aware detection (owner finding 2026-09-27, dedup'd with
  // owned-url-health.js): a registry row now benefits from the same
  // soft-404/challenge signals a bare HTTP status cannot see.
  test('a 2xx page rendering a not-found template classifies as soft_404, not live', async () => {
    await expect(liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-soft-404', canonical_url_normalized: '/ghost/' },
      {
        fetchImpl: fetchMap({
          'https://www.wavespestcontrol.com/ghost/': response(200, '<html><head><title>Page Not Found — Waves Pest Control</title></head><body>Page Not Found</body></html>'),
        }),
      },
    )).resolves.toEqual(expect.objectContaining({
      http_status: '200',
      live_status: 'soft_404',
    }));
  });

  // Codex r3 on #5123: a chain that ends on another 3xx (no Location on the
  // last hop) never reached a page, so it must not read as "redirected".
  test('a redirect chain ending on a 3xx without Location classifies as error, not redirected', async () => {
    await expect(liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-redirect-dead-end', canonical_url_normalized: '/legacy-dead-end/' },
      {
        fetchImpl: fetchMap({
          'https://www.wavespestcontrol.com/legacy-dead-end/': response(301, '', { location: '/hop/' }),
          'https://www.wavespestcontrol.com/hop/': response(302, '', {}, 'https://www.wavespestcontrol.com/hop/'),
        }),
      },
    )).resolves.toEqual(expect.objectContaining({
      http_status: '301',
      live_status: 'error',
    }));
  });

  // Codex r3 on #5123: challenge detection is the shared page-body
  // classifier's strict mode — Cloudflare's JavaScript Detections script on
  // an ordinary page is not a challenge; the interstitial's own markup is.
  test('the JS Detections script on an ordinary page stays live; interstitial markup is a challenge', async () => {
    const page = '<html><head><title>Ghost ants</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head><body><p>Ghost ants are tiny pale ants common in Southwest Florida kitchens.</p></body></html>';
    await expect(liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-jsd', canonical_url_normalized: '/ghost-ants/' },
      { fetchImpl: fetchMap({ 'https://www.wavespestcontrol.com/ghost-ants/': response(200, page) }) },
    )).resolves.toEqual(expect.objectContaining({ live_status: 'live' }));
    const wall = '<html><head><title>Ghost ants</title><script>window._cf_chl_opt={cvId:"3"};</script></head><body></body></html>';
    await expect(liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-wall', canonical_url_normalized: '/ghost-ants/' },
      { fetchImpl: fetchMap({ 'https://www.wavespestcontrol.com/ghost-ants/': response(200, wall) }) },
    )).resolves.toEqual(expect.objectContaining({ live_status: 'challenge' }));
  });

  // Codex r5 on #5123: the response's real Content-Type reaches the shared
  // classifier — a 200 JSON error or image at a page URL is not the page,
  // directly or at the end of a redirect; an HTML page stays live.
  test('a 200 non-HTML payload at a page URL classifies as soft_404, never live or redirected', async () => {
    await expect(liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-json', canonical_url_normalized: '/ghost/' },
      { fetchImpl: fetchMap({ 'https://www.wavespestcontrol.com/ghost/': response(200, '{"error":"not_found","message":"No document exists at this address any longer."}', { 'content-type': 'application/json; charset=utf-8' }) }) },
    )).resolves.toEqual(expect.objectContaining({ http_status: '200', live_status: 'soft_404' }));
    await expect(liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-image', canonical_url_normalized: '/legacy-ghost/' },
      {
        fetchImpl: fetchMap({
          'https://www.wavespestcontrol.com/legacy-ghost/': response(301, '', { location: '/ghost.png' }),
          'https://www.wavespestcontrol.com/ghost.png': response(200, 'PNG-bytes', { 'content-type': 'image/png' }, 'https://www.wavespestcontrol.com/ghost.png'),
        }),
      },
    )).resolves.toEqual(expect.objectContaining({ http_status: '301', live_status: 'soft_404' }));
    await expect(liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-html', canonical_url_normalized: '/ghost-ants/' },
      { fetchImpl: fetchMap({ 'https://www.wavespestcontrol.com/ghost-ants/': response(200, '<html><head><title>Ghost ants</title></head><body><p>Ghost ants are tiny pale ants.</p></body></html>', { 'content-type': 'text/html; charset=utf-8' }) }) },
    )).resolves.toEqual(expect.objectContaining({ live_status: 'live' }));
  });

  test('a redirect landing on a soft-404 template classifies as soft_404, not redirected', async () => {
    await expect(liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-redirect-soft-404', canonical_url_normalized: '/legacy-ghost/' },
      {
        fetchImpl: fetchMap({
          'https://www.wavespestcontrol.com/legacy-ghost/': response(301, '', { location: '/ghost/' }),
          'https://www.wavespestcontrol.com/ghost/': response(200, '<html><head><title>Page Not Found</title></head></html>', {}, 'https://www.wavespestcontrol.com/ghost/'),
        }),
      },
    )).resolves.toEqual(expect.objectContaining({
      http_status: '301',
      live_status: 'soft_404',
    }));
  });

  test('an interstitial-only Cloudflare challenge classifies as challenge, never a generic error', async () => {
    const body = '<html><head><title>Just a moment...</title></head><body>Checking your browser before access.</body></html>';
    await expect(liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-challenge', canonical_url_normalized: '/blocked/' },
      { fetchImpl: fetchMap({ 'https://www.wavespestcontrol.com/blocked/': response(200, body) }) },
    )).resolves.toEqual(expect.objectContaining({
      http_status: '200',
      live_status: 'challenge',
    }));
  });

  test('a healthy page mentioning captcha/access in its own copy is never misread as a challenge', async () => {
    const body = '<html><head><title>Report a Break-In or Access Denied Area</title></head><body>Our CAPTCHA-protected contact form keeps spam out, and our technicians never deny access to a scheduled visit.</body></html>';
    await expect(liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-safe-words', canonical_url_normalized: '/faq/' },
      { fetchImpl: fetchMap({ 'https://www.wavespestcontrol.com/faq/': response(200, body) }) },
    )).resolves.toEqual(expect.objectContaining({
      http_status: '200',
      live_status: 'live',
    }));
  });

  test('fetch errors keep sitemap signal from loaded sitemap paths', async () => {
    const result = await liveStatus.checkRegistryRowLiveStatus(
      { id: 'row-fetch-error', canonical_url_normalized: '/known-in-sitemap/' },
      {
        sitemapPaths: new Set(['/known-in-sitemap/']),
        fetchImpl: fetchMap({
          'https://www.wavespestcontrol.com/known-in-sitemap/': new Error('timeout'),
        }),
      },
    );

    expect(result).toEqual(expect.objectContaining({
      http_status: 'error',
      live_status: 'error',
      sitemap_present: true,
      sitemap_status: 'present',
    }));
  });

  test('bounded loads prioritize never and least recently checked rows', async () => {
    const database = fakeDatabase([]);

    await liveStatus.loadRegistryRows(database, { statuses: ['astro_only'], limit: 300 });

    expect(database.query.orderByRaw).toHaveBeenNthCalledWith(1, 'live_status_checked_at ASC NULLS FIRST');
    expect(database.query.limit).toHaveBeenCalledWith(300);
  });

  test('commit mode advances the rotation watermark when live fields are unchanged', async () => {
    const database = fakeDatabase([{
      id: 'row-stable', canonical_url_normalized: '/stable/', http_status: '200', live_status: 'live',
      redirect_target_url: null, canonical_target_url: null, noindex_detected: false,
      sitemap_present: null, sitemap_status: 'unknown', live_status_checked_at: null,
    }]);
    const now = new Date('2026-09-27T02:45:00Z');

    const result = await liveStatus.runContentRegistryLiveStatusCheck({
      database, commit: true, statuses: ['astro_only'], useSitemap: false, now,
      fetchImpl: fetchMap({
        'https://www.wavespestcontrol.com/stable/': response(200, '<html></html>', {}, 'https://www.wavespestcontrol.com/stable/'),
      }),
    });

    expect(result.summary.updated_count).toBe(0);
    expect(database.updates).toHaveLength(1);
    expect(database.updates[0].payload.live_status_checked_at).toEqual(now);
  });

  test('commit mode updates only changed registry mirror fields', async () => {
    const database = fakeDatabase([{
      id: 'row-5',
      canonical_url_normalized: '/legacy/',
      http_status: 'unknown',
      live_status: 'unknown',
      redirect_target_url: null,
      canonical_target_url: null,
      noindex_detected: false,
      sitemap_present: null,
      sitemap_status: 'unknown',
    }]);

    const result = await liveStatus.runContentRegistryLiveStatusCheck({
      database,
      commit: true,
      statuses: ['db_published_missing_astro'],
      useSitemap: false,
      fetchImpl: fetchMap({
        'https://www.wavespestcontrol.com/legacy/': response(301, '', { location: '/new/' }),
        'https://www.wavespestcontrol.com/new/': response(200, '<html></html>', {}, 'https://www.wavespestcontrol.com/new/'),
      }),
      now: new Date('2026-05-23T12:00:00Z'),
    });

    expect(result.summary).toEqual(expect.objectContaining({
      checked_count: 1,
      updated_count: 1,
      error_count: 0,
      by_live_status: { redirected: 1 },
    }));
    expect(database.updates).toHaveLength(1);
    expect(database.updates[0].payload).toEqual(expect.objectContaining({
      http_status: '301',
      live_status: 'redirected',
      redirect_target_url: 'https://www.wavespestcontrol.com/new/',
    }));
    expect(database.updates[0].payload).not.toHaveProperty('registry_hash');
  });

  test('liveUpdatePayload preserves sitemap fields when sitemap was not checked', () => {
    const payload = liveStatus.liveUpdatePayload(
      { sitemap_present: true, sitemap_status: 'present' },
      {
        http_status: '200',
        live_status: 'live',
        sitemap_present: null,
        sitemap_status: 'unknown',
      },
      new Date('2026-05-23T12:00:00Z'),
    );

    expect(payload).toEqual(expect.objectContaining({
      sitemap_present: true,
      sitemap_status: 'present',
    }));
  });

  test('fetchSitemapPaths recurses sitemap indexes instead of treating child sitemaps as pages', async () => {
    const paths = await liveStatus.fetchSitemapPaths({
      fetchImpl: fetchMap({
        'https://www.wavespestcontrol.com/sitemap.xml': response(200, `
          <sitemapindex>
            <sitemap><loc>https://www.wavespestcontrol.com/blog-sitemap.xml</loc></sitemap>
          </sitemapindex>
        `),
        'https://www.wavespestcontrol.com/blog-sitemap.xml': response(200, `
          <urlset>
            <url><loc>https://www.wavespestcontrol.com/blog/live-post/</loc></url>
          </urlset>
        `),
      }),
    });

    expect(paths.has('/blog/live-post/')).toBe(true);
    expect(paths.has('/blog-sitemap.xml/')).toBe(false);
  });

  test('loads and applies the sitemap for each checked fleet host', async () => {
    const database = fakeDatabase([
      { id: 'hub', canonical_url_normalized: '/hub-post/' },
      {
        id: 'spoke',
        live_url: '/spoke-post/',
        canonical_url: 'https://www.sarasotaflpestcontrol.com/spoke-post/',
      },
    ]);
    const fetchImpl = jest.fn(fetchMap({
      'https://www.wavespestcontrol.com/sitemap.xml': response(200, `
        <urlset><url><loc>https://www.wavespestcontrol.com/hub-post/</loc></url></urlset>
      `),
      'https://www.sarasotaflpestcontrol.com/sitemap.xml': response(200, `
        <urlset><url><loc>https://www.sarasotaflpestcontrol.com/spoke-post/</loc></url></urlset>
      `),
      'https://www.wavespestcontrol.com/hub-post/': response(200, '<html></html>'),
      'https://www.sarasotaflpestcontrol.com/spoke-post/': response(200, '<html></html>'),
    }));

    const result = await liveStatus.runContentRegistryLiveStatusCheck({ database, fetchImpl });

    expect(result.rows).toEqual([
      expect.objectContaining({ id: 'hub', sitemap_status: 'present' }),
      expect.objectContaining({ id: 'spoke', sitemap_status: 'present' }),
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://www.sarasotaflpestcontrol.com/sitemap.xml',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  test('does not follow off-fleet sitemap entries or redirects', async () => {
    const fetchImpl = jest.fn(fetchMap({
      'https://www.wavespestcontrol.com/sitemap.xml': response(200, `
        <sitemapindex><sitemap><loc>http://169.254.169.254/sitemap.xml</loc></sitemap></sitemapindex>
      `),
    }));

    await expect(liveStatus.fetchSitemapPaths({ fetchImpl }))
      .rejects.toThrow(/outside the content fleet/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('status normalization preserves default, all, and empty semantics', async () => {
    expect(liveStatus.normalizeStatuses(undefined)).toEqual(liveStatus.DEFAULT_STATUSES);
    expect(liveStatus.normalizeStatuses(null)).toBe(null);
    expect(liveStatus.normalizeStatuses('all')).toBe(null);
    expect(liveStatus.normalizeStatuses('')).toEqual([]);

    const result = await liveStatus.runContentRegistryLiveStatusCheck({
      database: fakeDatabase([{ id: 'row-skipped', canonical_url_normalized: '/should-not-fetch/' }]),
      statuses: '',
      useSitemap: false,
      fetchImpl: async () => {
        throw new Error('fetch should not be called for empty status filter');
      },
    });

    expect(result.summary.checked_count).toBe(0);
  });

  test('CLI args preserve values and parse boolean flags', () => {
    expect(liveCli.parseArgs([
      '--status=db_published_missing_astro,conflict',
      '--limit',
      '25',
      '--base-url=https://www.wavespestcontrol.com',
      '--commit',
    ])).toEqual({
      status: 'db_published_missing_astro,conflict',
      limit: '25',
      'base-url': 'https://www.wavespestcontrol.com',
      commit: true,
    });
    expect(liveCli.boolFlag('yes')).toBe(true);
    expect(liveStatus.normalizeStatuses('all')).toBe(null);
  });
});

describe('soft-404 heading detector (shared with the citation auditor)', () => {
  const { notFoundHeading, computeBodySignals } = liveStatus;
  test('reads <title>/<h1> only, decoded, ignoring markup that never renders', () => {
    expect(notFoundHeading('<title>Page&nbsp;Not&nbsp;Found</title>')).toBe(true);
    expect(notFoundHeading("<h1>Sorry, we couldn't find this page</h1>")).toBe(true);
    expect(notFoundHeading('<h1>Pest control in Bradenton</h1><p>404 reviews</p>')).toBe(false);
    expect(notFoundHeading('<title>Why Termites Were Not Found During Inspection</title>')).toBe(false);
    expect(notFoundHeading('<h1>Rodents not found after exclusion</h1>')).toBe(false);
    for (const h of ['404 Not Found', 'Not Found', 'Oops! Not found', 'The page you requested was not found', 'Listing not found', 'Error 404']) {
      expect(notFoundHeading(`<title>${h}</title>`)).toBe(true);
    }
    expect(notFoundHeading('<script type="text/template"><h1>Page not found</h1></script><!-- <h1>Not found</h1> -->')).toBe(false);
  });
  test('stays linear on malformed or unclosed tags (600 KB fetch cap)', () => {
    const junks = ['<template>', '<h1>', '<h1 class="x"', '<a <b <c', '<!-- ', '</h1><title>', '<template></template>',
      '<h1><template></template>', '<template><template></template>', '<div>', '<li><ul>', '<b><i>', '<table><td>',
      '<script>', '<style>', '</template>', '<h1><!--', '<title><script></script>', '<<<<', '<!---->', '<p><h1>'];
    for (const junk of junks) {
      const started = Date.now();
      notFoundHeading(junk.repeat(Math.ceil(600000 / junk.length)));
      expect(Date.now() - started).toBeLessThan(500);
    }
    // deep nesting, then the matching closes (the exhausted-search case)
    const started = Date.now();
    notFoundHeading(`${'<template>'.repeat(30000)}${'</template>'.repeat(30000)}`);
    expect(Date.now() - started).toBeLessThan(500);
  });
  test('a heading left open runs to the end of the document', () => {
    expect(notFoundHeading('<html><body><h1>Page not found')).toBe(true);
    expect(notFoundHeading('<h1>Page <!-- x --> not found')).toBe(true);
    expect(notFoundHeading('<h1>Waves Pest Control')).toBe(false);
  });
  test('inert markup inside a heading, and nested templates, contribute no heading text', () => {
    expect(notFoundHeading('<h1>Waves Pest Control<template>Not found</template></h1>')).toBe(false);
    expect(notFoundHeading('<h1>Waves<!-- Not found --> Pest Control</h1>')).toBe(false);
    expect(notFoundHeading('<template><template></template><h1>Page not found</h1></template><h1>Waves</h1>')).toBe(false);
    expect(notFoundHeading('<h1>Page <script>x()</script>not found</h1>')).toBe(true);
    expect(notFoundHeading('<template></template><h1>Page not found</h1>')).toBe(true);
    expect(notFoundHeading('<template><!-- </template> --><h1>Not found</h1></template><h1>Waves Pest Control</h1>')).toBe(false);
    expect(notFoundHeading('<template><script>"</template>"</script><h1>Not found</h1></template><h1>Waves</h1>')).toBe(false);
    expect(notFoundHeading('<template><style>/* </template> */</style></template><h1>Page not found</h1>')).toBe(true);
  });
  test('matches tags case-insensitively and only the exact tag name', () => {
    expect(notFoundHeading('<H1 class="t">Page Not Found</H1>')).toBe(true);
    expect(notFoundHeading('<h1x>Page not found</h1x>')).toBe(false);
    expect(notFoundHeading('<h1>Pest <span>control</span></h1><h1>Not found</h1>')).toBe(true); // every h1 is read
  });
  test('owned-page body signals flag the same headings', () => {
    expect(computeBodySignals('<html><head><title>x</title></head><body><h1>We could not find that page</h1></body></html>', 'text/html').softNotFound).toBe(true);
    expect(computeBodySignals('<html><head><title>Lawn care</title></head><body><h1>Lawn care</h1></body></html>', 'text/html').softNotFound).toBe(false);
  });
});
