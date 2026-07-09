/**
 * Unit tests for indexnow-submit + index-status-monitor + sitemap-manager.
 * All fetch calls mocked.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { IndexNowSubmitter, _internals: indexNowInternals } = require('../services/seo/indexnow-submit');
const { IndexStatusMonitor, _internals: monitorInternals } = require('../services/seo/index-status-monitor');
const { SitemapManager, _internals: sitemapInternals } = require('../services/seo/sitemap-manager');

const { classifyResponse } = indexNowInternals;
const { parseInspection, canonicalsMatch, normalizeCanonical } = monitorInternals;
const { extractUrls, normalize, MAX_SITEMAPS } = sitemapInternals;

function ok(body, contentType = 'application/json') {
  return Promise.resolve({
    ok: true, status: 200,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    json: () => Promise.resolve(typeof body === 'string' ? {} : body),
  });
}
function err(status, body = '') {
  return Promise.resolve({
    ok: false, status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve({}),
  });
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  for (const k of ['INDEXNOW_KEY', 'INDEXNOW_HOST', 'GSC_SITE_URL', 'SITEMAP_URL']) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
});

// ═══════════════════════════════════════════════════════════════════
// indexnow-submit
// ═══════════════════════════════════════════════════════════════════

describe('classifyResponse (indexnow)', () => {
  test.each([
    [200, { ok: true, status: 'ok' }],
    [202, { ok: true, status: 'ok' }],
    [400, { ok: false, status: 'rejected' }],
    [403, { ok: false, status: 'rejected' }],
    [422, { ok: false, status: 'rejected' }],
    [429, { ok: false, status: 'rate_limited' }],
    [500, { ok: false, status: 'error' }],
    [503, { ok: false, status: 'error' }],
  ])('status %d → %j', (status, expected) => {
    const r = classifyResponse(status, 'body');
    expect(r.ok).toBe(expected.ok);
    expect(r.status).toBe(expected.status);
  });
});

describe('IndexNowSubmitter.submit', () => {
  // Submissions are host-gated (#1772): off-host URLs skip before the key
  // check or any fetch, so these use the configured wavespestcontrol host.
  test('rejects when INDEXNOW_KEY missing', async () => {
    delete process.env.INDEXNOW_KEY;
    const s = new IndexNowSubmitter();
    const r = await s.submit('https://www.wavespestcontrol.com/a', { fetchFn: jest.fn() });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('rejected');
    expect(r.error).toMatch(/INDEXNOW_KEY/);
  });
  test('rejects invalid url', async () => {
    process.env.INDEXNOW_KEY = 'abc';
    const s = new IndexNowSubmitter();
    expect((await s.submit(null)).ok).toBe(false);
    expect((await s.submit(123)).ok).toBe(false);
  });
  test('200 response → ok', async () => {
    process.env.INDEXNOW_KEY = 'abc';
    const fetchFn = jest.fn().mockReturnValue(ok(''));
    const s = new IndexNowSubmitter();
    const r = await s.submit('https://www.wavespestcontrol.com/test/', { fetchFn });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('ok');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Verify POST body shape
    const [, options] = fetchFn.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      host: expect.any(String),
      key: 'abc',
      keyLocation: expect.stringContaining('abc.txt'),
      urlList: ['https://www.wavespestcontrol.com/test/'],
    });
  });
  test('429 → rate_limited', async () => {
    process.env.INDEXNOW_KEY = 'abc';
    const fetchFn = jest.fn().mockReturnValue(err(429, 'too many'));
    const s = new IndexNowSubmitter();
    const r = await s.submit('https://www.wavespestcontrol.com/a', { fetchFn });
    expect(r.status).toBe('rate_limited');
  });
  test('403 (key rejected) → rejected with error', async () => {
    process.env.INDEXNOW_KEY = 'abc';
    const fetchFn = jest.fn().mockReturnValue(err(403, 'key not valid'));
    const s = new IndexNowSubmitter();
    const r = await s.submit('https://www.wavespestcontrol.com/a', { fetchFn });
    expect(r.status).toBe('rejected');
    expect(r.error).toMatch(/403/);
  });
});

describe('IndexNowSubmitter.submitMany', () => {
  test('aggregates per-URL results', async () => {
    process.env.INDEXNOW_KEY = 'abc';
    const fetchFn = jest.fn()
      .mockReturnValueOnce(ok(''))
      .mockReturnValueOnce(err(429))
      .mockReturnValueOnce(ok(''));
    const s = new IndexNowSubmitter();
    const result = await s.submitMany(['u1', 'u2', 'u3'], { fetchFn });
    expect(result.submitted).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results.length).toBe(3);
  });
  test('empty list returns ok+0', async () => {
    const s = new IndexNowSubmitter();
    expect(await s.submitMany([])).toEqual({ ok: true, submitted: 0, results: [] });
  });
});

// ═══════════════════════════════════════════════════════════════════
// index-status-monitor
// ═══════════════════════════════════════════════════════════════════

describe('parseInspection', () => {
  test('extracts coverage + indexing + canonical + verdict', () => {
    const fixture = {
      inspectionResult: {
        indexStatusResult: {
          coverageState: 'Submitted and indexed',
          indexingState: 'INDEXING_ALLOWED',
          googleCanonical: 'https://www.wavespestcontrol.com/pest-control-bradenton-fl/',
          verdict: 'PASS',
        },
      },
    };
    const r = parseInspection('https://www.wavespestcontrol.com/pest-control-bradenton-fl/', fixture);
    expect(r.ok).toBe(true);
    expect(r.coverage_state).toBe('Submitted and indexed');
    expect(r.indexing_state).toBe('INDEXING_ALLOWED');
    expect(r.canonical_matches).toBe(true);
    expect(r.verdict).toBe('PASS');
  });
  test('flags canonical mismatch', () => {
    const fixture = {
      inspectionResult: {
        indexStatusResult: {
          googleCanonical: 'https://www.wavespestcontrol.com/pest-control-services/',
          coverageState: 'Page with redirect',
        },
      },
    };
    const r = parseInspection('https://www.wavespestcontrol.com/pest-control-bradenton-fl/', fixture);
    expect(r.canonical_matches).toBe(false);
  });
  test('userCanonical from inspection wins over requested URL', () => {
    // Requested URL is a slash variant; the page's declared canonical
    // matches Google's. Should NOT flag mismatch.
    const fixture = {
      inspectionResult: {
        indexStatusResult: {
          userCanonical: 'https://www.wavespestcontrol.com/pest-control-bradenton-fl/',
          googleCanonical: 'https://www.wavespestcontrol.com/pest-control-bradenton-fl/',
        },
      },
    };
    const r = parseInspection('https://www.wavespestcontrol.com/pest-control-bradenton-fl', fixture);
    expect(r.canonical_matches).toBe(true);
  });
  test('returns ok=false when no inspectionResult', () => {
    const r = parseInspection('https://x.com/', {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_inspection_result');
  });
});

describe('canonicalsMatch + normalizeCanonical', () => {
  test('case + trailing slash + query stripped', () => {
    expect(canonicalsMatch(
      'https://www.wavespestcontrol.com/pest-control-bradenton-fl/?utm_src=gbp',
      'http://wavespestcontrol.com/pest-control-bradenton-fl'
    )).toBe(true);
  });
  test('different paths → no match', () => {
    expect(canonicalsMatch(
      'https://www.wavespestcontrol.com/a/',
      'https://www.wavespestcontrol.com/b/'
    )).toBe(false);
  });
  test('handles null', () => {
    expect(canonicalsMatch(null, 'x')).toBe(false);
    expect(canonicalsMatch('x', null)).toBe(false);
  });
});

describe('IndexStatusMonitor.inspect', () => {
  test('returns error when no access token', async () => {
    const m = new IndexStatusMonitor();
    m._getAccessToken = async () => null;
    const r = await m.inspect('https://x.com/', { fetchFn: jest.fn() });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_access_token');
  });
  test('returns parsed result on 200', async () => {
    const m = new IndexStatusMonitor();
    m._getAccessToken = async () => 'tok-123';
    const fetchFn = jest.fn().mockReturnValue(ok({
      inspectionResult: {
        indexStatusResult: {
          coverageState: 'Submitted and indexed',
          indexingState: 'INDEXING_ALLOWED',
          googleCanonical: 'https://x.com/test/',
          verdict: 'PASS',
        },
      },
    }));
    const r = await m.inspect('https://x.com/test/', { fetchFn });
    expect(r.ok).toBe(true);
    expect(r.coverage_state).toBe('Submitted and indexed');
  });
  test('returns error on non-2xx', async () => {
    const m = new IndexStatusMonitor();
    m._getAccessToken = async () => 'tok-123';
    const fetchFn = jest.fn().mockReturnValue(err(429, 'rate limit'));
    const r = await m.inspect('https://x.com/test/', { fetchFn });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/429/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// sitemap-manager
// ═══════════════════════════════════════════════════════════════════

const SAMPLE_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.wavespestcontrol.com/</loc></url>
  <url><loc>https://www.wavespestcontrol.com/pest-control-bradenton-fl/</loc></url>
  <url><loc>https://www.wavespestcontrol.com/lawn-care-sarasota-fl/</loc></url>
  <url><loc>https://www.wavespestcontrol.com/blog/get-rid-of-ghost-ants/</loc></url>
</urlset>`;

describe('extractUrls', () => {
  test('parses <loc> tags from urlset', () => {
    const urls = extractUrls(SAMPLE_SITEMAP);
    expect(urls.size).toBe(4);
    expect(urls.has(normalize('https://www.wavespestcontrol.com/pest-control-bradenton-fl/'))).toBe(true);
  });
  test('handles whitespace inside <loc>', () => {
    const xml = `<urlset><url><loc>
      https://x.com/a
    </loc></url></urlset>`;
    const urls = extractUrls(xml);
    expect(urls.has(normalize('https://x.com/a'))).toBe(true);
  });
  test('returns empty Set for no urls', () => {
    expect(extractUrls('<urlset></urlset>').size).toBe(0);
  });
});

describe('normalize', () => {
  test.each([
    ['https://www.wavespestcontrol.com/a/', 'wavespestcontrol.com/a'],
    ['http://wavespestcontrol.com/a?utm=x', 'wavespestcontrol.com/a'],
    ['https://X.com/PATH#frag', 'x.com/path'],
  ])('%s → %s', (input, expected) => {
    expect(normalize(input)).toBe(expected);
  });
});

describe('SitemapManager.hasUrl', () => {
  test('present in sitemap → present=true', async () => {
    const m = new SitemapManager();
    const fetchFn = jest.fn().mockReturnValue(ok(SAMPLE_SITEMAP, 'application/xml'));
    const r = await m.hasUrl('https://www.wavespestcontrol.com/pest-control-bradenton-fl/', { fetchFn });
    expect(r.present).toBe(true);
    expect(r.total_urls).toBe(4);
  });
  test('not present → present=false', async () => {
    const m = new SitemapManager();
    const fetchFn = jest.fn().mockReturnValue(ok(SAMPLE_SITEMAP, 'application/xml'));
    const r = await m.hasUrl('https://www.wavespestcontrol.com/new-page-not-yet-deployed/', { fetchFn });
    expect(r.present).toBe(false);
  });
  test('fetch failure → error not present=false', async () => {
    const m = new SitemapManager();
    const fetchFn = jest.fn().mockReturnValue(err(503));
    const r = await m.hasUrl('https://x.com/', { fetchFn });
    expect(r.present).toBe(false);
    expect(r.error).toMatch(/HTTP 503/);
  });
  test('cache: second call within TTL doesn\'t re-fetch', async () => {
    const m = new SitemapManager();
    const fetchFn = jest.fn().mockReturnValue(ok(SAMPLE_SITEMAP, 'application/xml'));
    await m.hasUrl('https://www.wavespestcontrol.com/a/', { fetchFn });
    await m.hasUrl('https://www.wavespestcontrol.com/b/', { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  test('invalidate() forces re-fetch on next hasUrl', async () => {
    const m = new SitemapManager();
    const fetchFn = jest.fn().mockReturnValue(ok(SAMPLE_SITEMAP, 'application/xml'));
    await m.hasUrl('https://x.com/a/', { fetchFn });
    m.invalidate();
    await m.hasUrl('https://x.com/a/', { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('SitemapManager.listUrls', () => {
  test('returns raw <loc> values with www preserved', async () => {
    const m = new SitemapManager();
    const fetchFn = jest.fn().mockReturnValue(ok(SAMPLE_SITEMAP, 'application/xml'));
    const list = await m.listUrls({ fetchFn });
    expect(list).toContain('https://www.wavespestcontrol.com/pest-control-bradenton-fl/');
    // www-stripped form should NOT appear — that was the original bug
    expect(list).not.toContain('wavespestcontrol.com/pest-control-bradenton-fl');
  });
  test('limit option caps the result length', async () => {
    const m = new SitemapManager();
    const fetchFn = jest.fn().mockReturnValue(ok(SAMPLE_SITEMAP, 'application/xml'));
    const list = await m.listUrls({ limit: 2, fetchFn });
    expect(list).toHaveLength(2);
  });
  test('recurses sitemap indexes and returns leaf page URLs', async () => {
    const m = new SitemapManager();
    const responses = {
      'https://www.wavespestcontrol.com/sitemap.xml': `<?xml version="1.0"?>
        <sitemapindex>
          <sitemap><loc>https://www.wavespestcontrol.com/sitemap-0.xml</loc></sitemap>
        </sitemapindex>`,
      'https://www.wavespestcontrol.com/sitemap-0.xml': `<?xml version="1.0"?>
        <urlset>
          <url><loc>https://www.wavespestcontrol.com/</loc></url>
          <url><loc>https://www.wavespestcontrol.com/pest-control-bradenton-fl/</loc></url>
        </urlset>`,
    };
    const fetchFn = jest.fn((url) => ok(responses[url] || '<urlset></urlset>', 'application/xml'));

    const list = await m.listUrls({
      sitemapUrl: 'https://www.wavespestcontrol.com/sitemap.xml',
      fetchFn,
    });

    expect(list).toEqual([
      'https://www.wavespestcontrol.com/',
      'https://www.wavespestcontrol.com/pest-control-bradenton-fl/',
    ]);
    expect(list).not.toContain('https://www.wavespestcontrol.com/sitemap-0.xml');
    expect(fetchFn).toHaveBeenCalledWith('https://www.wavespestcontrol.com/sitemap.xml');
    expect(fetchFn).toHaveBeenCalledWith('https://www.wavespestcontrol.com/sitemap-0.xml');
  });
  test('does not recurse sitemap index children on other hosts', async () => {
    const m = new SitemapManager();
    const responses = {
      'https://wavespestcontrol.com/sitemap.xml': `<?xml version="1.0"?>
        <sitemapindex>
          <sitemap><loc>https://www.wavespestcontrol.com/sitemap-0.xml</loc></sitemap>
          <sitemap><loc>http://169.254.169.254/latest/meta-data/</loc></sitemap>
        </sitemapindex>`,
      'https://www.wavespestcontrol.com/sitemap-0.xml': `<?xml version="1.0"?>
        <urlset>
          <url><loc>https://www.wavespestcontrol.com/</loc></url>
        </urlset>`,
    };
    const fetchFn = jest.fn((url) => ok(responses[url] || '<urlset></urlset>', 'application/xml'));

    const list = await m.listUrls({
      sitemapUrl: 'https://wavespestcontrol.com/sitemap.xml',
      fetchFn,
    });

    expect(list).toEqual(['https://www.wavespestcontrol.com/']);
    expect(fetchFn).toHaveBeenCalledWith('https://wavespestcontrol.com/sitemap.xml');
    expect(fetchFn).toHaveBeenCalledWith('https://www.wavespestcontrol.com/sitemap-0.xml');
    expect(fetchFn).not.toHaveBeenCalledWith('http://169.254.169.254/latest/meta-data/');
  });
  test('throws instead of returning partial results when sitemap index cap is exceeded', async () => {
    const m = new SitemapManager();
    const childLocs = Array.from({ length: MAX_SITEMAPS + 1 }, (_, idx) =>
      `<sitemap><loc>https://www.wavespestcontrol.com/sitemap-${idx}.xml</loc></sitemap>`
    ).join('');
    const fetchFn = jest.fn((url) => {
      if (url === 'https://www.wavespestcontrol.com/sitemap.xml') {
        return ok(`<sitemapindex>${childLocs}</sitemapindex>`, 'application/xml');
      }
      return ok('<urlset><url><loc>https://www.wavespestcontrol.com/page/</loc></url></urlset>', 'application/xml');
    });

    await expect(m.listUrls({
      sitemapUrl: 'https://www.wavespestcontrol.com/sitemap.xml',
      fetchFn,
    })).rejects.toThrow(/Sitemap index limit exceeded/);
  });
  test('allows exactly the configured number of child sitemap files', async () => {
    const m = new SitemapManager();
    const childLocs = Array.from({ length: MAX_SITEMAPS }, (_, idx) =>
      `<sitemap><loc>https://www.wavespestcontrol.com/sitemap-${idx}.xml</loc></sitemap>`
    ).join('');
    const fetchFn = jest.fn((url) => {
      if (url === 'https://www.wavespestcontrol.com/sitemap.xml') {
        return ok(`<sitemapindex>${childLocs}</sitemapindex>`, 'application/xml');
      }
      return ok('<urlset><url><loc>https://www.wavespestcontrol.com/page/</loc></url></urlset>', 'application/xml');
    });

    await expect(m.listUrls({
      sitemapUrl: 'https://www.wavespestcontrol.com/sitemap.xml',
      fetchFn,
    })).resolves.toEqual(['https://www.wavespestcontrol.com/page/']);
  });
});
