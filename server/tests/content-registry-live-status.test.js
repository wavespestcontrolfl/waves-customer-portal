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
  function database(table) {
    if (table !== 'content_registry') throw new Error(`Unexpected table ${table}`);
    const query = {
      whereIn: () => query,
      orderByRaw: () => query,
      orderBy: () => query,
      limit: async () => rows,
    };
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
  return database;
}

describe('content registry live status helpers', () => {
  test('builds absolute Waves URLs from registry paths', () => {
    expect(liveStatus.buildAbsoluteUrl('/blog/test/')).toBe('https://www.wavespestcontrol.com/blog/test/');
    expect(liveStatus.buildAbsoluteUrl('blog/test')).toBe('https://www.wavespestcontrol.com/blog/test');
    expect(liveStatus.buildAbsoluteUrl('https://example.com/x')).toBe('https://example.com/x');
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
      registry_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
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
