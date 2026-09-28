jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn() }));
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: () => false, sendOne: jest.fn() }));

const {
  normalizeOwnedUrl,
  isOwnedFleetUrl,
  fetchOwnedUrlChain,
  classifyOwnedUrlHealth,
  checkOwnedUrlHealth,
  collectCitedOwnedUrls,
  getCitedUrlHealthDashboard,
  VERDICTS,
  BAD_VERDICTS,
} = require('../services/seo/owned-url-health');

describe('normalizeOwnedUrl', () => {
  test('strips utm_ tracking params and the fragment, lowercases the host', () => {
    expect(normalizeOwnedUrl('https://WWW.BradentonFLPestControl.com/pest-control-costs/?utm_source=chatgpt&utm_medium=ai#pricing'))
      .toBe('https://www.bradentonflpestcontrol.com/pest-control-costs/');
  });

  test('adds a consistent trailing slash to an extension-less path but not to a file path', () => {
    expect(normalizeOwnedUrl('https://wavespestcontrol.com/pest-control-costs')).toBe('https://wavespestcontrol.com/pest-control-costs/');
    expect(normalizeOwnedUrl('https://wavespestcontrol.com/sitemap.xml')).toBe('https://wavespestcontrol.com/sitemap.xml');
  });

  test('rejects a non-http(s) scheme and malformed input', () => {
    expect(normalizeOwnedUrl('javascript:alert(1)')).toBe('');
    expect(normalizeOwnedUrl('not a url')).toBe('');
    expect(normalizeOwnedUrl('')).toBe('');
  });
});

describe('isOwnedFleetUrl (reused fleet allowlist)', () => {
  test('accepts the hub and a spoke domain, rejects an off-fleet host', () => {
    expect(isOwnedFleetUrl('https://www.wavespestcontrol.com/blog/')).toBe(true);
    expect(isOwnedFleetUrl('https://bradentonflpestcontrol.com/pest-control-costs/')).toBe(true);
    expect(isOwnedFleetUrl('https://example.org/pest-control-costs/')).toBe(false);
    expect(isOwnedFleetUrl('https://wavespestcontrol.com.evil.example/')).toBe(false);
  });
});

describe('verdict classification', () => {
  test('a fetch failure classifies as fetch_blocked, never not_found', () => {
    expect(VERDICTS).toContain('fetch_blocked');
    const result = classifyOwnedUrlHealth('https://wavespestcontrol.com/x/', { fetchError: 'timeout', hops: [] });
    expect(result.verdict).toBe('fetch_blocked');
    expect(result.verdict).not.toBe('not_found');
    expect(result.httpStatus).toBeNull();
    expect(result.detail.reason).toBe('timeout');
  });

  test('a disallowed-host block classifies as fetch_blocked with the block reason', () => {
    const result = classifyOwnedUrlHealth('https://wavespestcontrol.com/x/', { blockedReason: 'disallowed_host', hops: [] });
    expect(result).toMatchObject({ verdict: 'fetch_blocked', detail: { reason: 'disallowed_host' } });
  });

  test('a real 404 classifies as not_found', () => {
    const result = classifyOwnedUrlHealth('https://wavespestcontrol.com/gone/', {
      finalUrl: 'https://wavespestcontrol.com/gone/', status: 404, headers: {}, body: '', hops: [{ url: 'https://wavespestcontrol.com/gone/', status: 404 }],
    });
    expect(result.verdict).toBe('not_found');
  });

  test('a 5xx classifies as server_error', () => {
    const result = classifyOwnedUrlHealth('https://wavespestcontrol.com/x/', {
      finalUrl: 'https://wavespestcontrol.com/x/', status: 503, headers: {}, body: '', hops: [{ url: 'https://wavespestcontrol.com/x/', status: 503 }],
    });
    expect(result.verdict).toBe('server_error');
  });

  test('a 403 classifies as challenge', () => {
    const result = classifyOwnedUrlHealth('https://wavespestcontrol.com/x/', {
      finalUrl: 'https://wavespestcontrol.com/x/', status: 403, headers: {}, body: '', hops: [{ url: 'https://wavespestcontrol.com/x/', status: 403 }],
    });
    expect(result.verdict).toBe('challenge');
  });

  test('a Cloudflare-style interstitial on a 2xx classifies as challenge', () => {
    const body = '<html><head><title>Just a moment...</title></head><body>Checking your browser before access.</body></html>';
    const result = classifyOwnedUrlHealth('https://wavespestcontrol.com/x/', {
      finalUrl: 'https://wavespestcontrol.com/x/', status: 200, headers: {}, body, hops: [{ url: 'https://wavespestcontrol.com/x/', status: 200 }],
    });
    expect(result.verdict).toBe('challenge');
  });

  // Seeded soft-404 fixture: a real Astro spoke's 404.astro renders exactly
  // this shape (BaseLayout title + noindex,nofollow meta robots) with an
  // HTTP 200 — e.g. served from a stale cache/edge fallback instead of the
  // site's real 404 status.
  test('a 2xx page rendering the fleet 404 template classifies as soft_404', () => {
    const body = [
      '<html><head>',
      '<title>Page Not Found &mdash; Waves Pest Control</title>',
      '<meta name="robots" content="noindex,nofollow">',
      '<link rel="canonical" href="https://bradentonflpestcontrol.com/404">',
      '</head><body><h1>Page Not Found</h1></body></html>',
    ].join('');
    const result = classifyOwnedUrlHealth('https://bradentonflpestcontrol.com/pest-control-costs/', {
      finalUrl: 'https://bradentonflpestcontrol.com/pest-control-costs/', status: 200, headers: {}, body,
      hops: [{ url: 'https://bradentonflpestcontrol.com/pest-control-costs/', status: 200 }],
    });
    expect(result.verdict).toBe('soft_404');
    expect(result.detail.title).toMatch(/page not found/i);
  });

  test('meta robots noindex on an otherwise-fine 2xx classifies as noindex', () => {
    const body = '<html><head><title>Pest control costs</title><meta name="robots" content="noindex"></head><body>ok</body></html>';
    const result = classifyOwnedUrlHealth('https://wavespestcontrol.com/x/', {
      finalUrl: 'https://wavespestcontrol.com/x/', status: 200, headers: {}, body, hops: [{ url: 'https://wavespestcontrol.com/x/', status: 200 }],
    });
    expect(result.verdict).toBe('noindex');
  });

  test('an X-Robots-Tag header noindex classifies as noindex even with clean HTML', () => {
    const body = '<html><head><title>Pest control costs</title></head><body>ok</body></html>';
    const result = classifyOwnedUrlHealth('https://wavespestcontrol.com/x/', {
      finalUrl: 'https://wavespestcontrol.com/x/', status: 200, headers: { 'x-robots-tag': 'noindex' }, body,
      hops: [{ url: 'https://wavespestcontrol.com/x/', status: 200 }],
    });
    expect(result.verdict).toBe('noindex');
  });

  test('a canonical pointing elsewhere classifies as canonical_elsewhere', () => {
    const body = '<html><head><title>Pest control costs</title><link rel="canonical" href="https://wavespestcontrol.com/other-page/"></head><body>ok</body></html>';
    const result = classifyOwnedUrlHealth('https://wavespestcontrol.com/x/', {
      finalUrl: 'https://wavespestcontrol.com/x/', status: 200, headers: {}, body, hops: [{ url: 'https://wavespestcontrol.com/x/', status: 200 }],
    });
    expect(result.verdict).toBe('canonical_elsewhere');
  });

  const PAGE_BODY = '<html><head><title>Pest control costs</title></head><body><h1>Pest control costs in Southwest Florida</h1><p>What drives the price of a quarterly plan, and what each visit includes.</p></body></html>';

  test('a 301 chain landing on a clean ok page classifies as redirect_ok', () => {
    const body = PAGE_BODY;
    const result = classifyOwnedUrlHealth('https://wavespestcontrol.com/old/', {
      finalUrl: 'https://wavespestcontrol.com/new/', status: 200, headers: {}, body,
      hops: [{ url: 'https://wavespestcontrol.com/old/', status: 301 }, { url: 'https://wavespestcontrol.com/new/', status: 200 }],
    });
    expect(result.verdict).toBe('redirect_ok');
  });

  test('a clean, directly-served 2xx page classifies as ok', () => {
    const body = PAGE_BODY;
    const result = classifyOwnedUrlHealth('https://wavespestcontrol.com/x/', {
      finalUrl: 'https://wavespestcontrol.com/x/', status: 200, headers: {}, body, hops: [{ url: 'https://wavespestcontrol.com/x/', status: 200 }],
    });
    expect(result.verdict).toBe('ok');
  });

  // Local audit P1 (PR #5123): challenge detection needs interstitial-specific
  // evidence — generic words in a healthy page's HTML must not flag it.
  test.each([
    ['a CAPTCHA form widget', '<div id="captcha" class="g-recaptcha"></div>'],
    ['"access denied" in ordinary copy', '<p>Roof rats can find access denied to them elsewhere, so they move into attics.</p>'],
    ['Cloudflare JavaScript Detections script', '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>'],
  ])('a healthy page with %s stays ok', (_label, extra) => {
    const body = PAGE_BODY.replace('</body>', `${extra}</body>`);
    const result = classifyOwnedUrlHealth('https://wavespestcontrol.com/x/', {
      finalUrl: 'https://wavespestcontrol.com/x/', status: 200, headers: {}, body, hops: [{ url: 'https://wavespestcontrol.com/x/', status: 200 }],
    });
    expect(result.verdict).toBe('ok');
  });

  test('interstitial-only Cloudflare markup classifies as challenge even with a normal title', () => {
    const body = '<html><head><title>Pest control costs</title><script>window._cf_chl_opt={cvId:"3"};</script></head><body><form id="challenge-form"></form></body></html>';
    const result = classifyOwnedUrlHealth('https://wavespestcontrol.com/x/', {
      finalUrl: 'https://wavespestcontrol.com/x/', status: 200, headers: {}, body, hops: [{ url: 'https://wavespestcontrol.com/x/', status: 200 }],
    });
    expect(result.verdict).toBe('challenge');
  });

  // Codex r1 (PR #5123): a broken deploy or edge rule serving a blank page
  // must never read as healthy.
  test.each([
    ['a blank 200', 200, ''],
    ['a 204 No Content', 204, ''],
    ['a script-only 200 with no visible text', 200, '<html><head><title></title><script>var a = 1;</script></head><body>  </body></html>'],
  ])('%s classifies as soft_404 (empty_body), never ok', (_label, status, body) => {
    const result = classifyOwnedUrlHealth('https://wavespestcontrol.com/x/', {
      finalUrl: 'https://wavespestcontrol.com/x/', status, headers: {}, body, hops: [{ url: 'https://wavespestcontrol.com/x/', status }],
    });
    expect(result.verdict).toBe('soft_404');
    expect(result.detail.reason).toBe('empty_body');
    expect(BAD_VERDICTS.has(result.verdict)).toBe(true);
  });

  // codex pre-push audit finding: a truncated 2xx body must never be
  // classified as healthy — the soft-404/noindex/canonical markers it would
  // otherwise be checked for can live past the cutoff point.
  test('a truncated 2xx response (size cap tripped) classifies as fetch_blocked, not ok', () => {
    const body = '<html><head><title>Pest control';  // cut mid-title
    const result = classifyOwnedUrlHealth('https://wavespestcontrol.com/x/', {
      finalUrl: 'https://wavespestcontrol.com/x/', status: 200, headers: {}, body, truncated: true,
      hops: [{ url: 'https://wavespestcontrol.com/x/', status: 200 }],
    });
    expect(result.verdict).toBe('fetch_blocked');
    expect(result.detail.reason).toBe('response_truncated');
  });

  // codex pre-push audit finding: noindex and challenge must count as
  // actionable (bad) results — neither is a confirmed-healthy page, and
  // neither may silently retire a standing FIX alert on a clean run.
  test('noindex and challenge are both bad verdicts, not clean', () => {
    expect(BAD_VERDICTS.has('noindex')).toBe(true);
    expect(BAD_VERDICTS.has('challenge')).toBe(true);
    expect(BAD_VERDICTS.has('ok')).toBe(false);
    expect(BAD_VERDICTS.has('redirect_ok')).toBe(false);
  });
});

describe('fetchOwnedUrlChain — host allowlist and redirect-hop revalidation', () => {
  test('a start URL off the owned fleet is blocked before any fetch is attempted', async () => {
    const getImpl = jest.fn();
    const result = await fetchOwnedUrlChain('https://example.org/x/', { getImpl });
    expect(result.blockedReason).toBe('disallowed_host');
    expect(getImpl).not.toHaveBeenCalled();
  });

  test('a redirect hop that leaves the owned fleet is blocked BEFORE it is fetched — the malicious/misconfigured hop is never requested', async () => {
    const getImpl = jest.fn()
      .mockResolvedValueOnce({ status: 301, headers: { location: 'https://attacker.example/steal' } });
    const result = await fetchOwnedUrlChain('https://wavespestcontrol.com/old/', { getImpl });
    expect(result.blockedReason).toBe('disallowed_host');
    expect(getImpl).toHaveBeenCalledTimes(1); // only the first (owned) hop was ever fetched
    expect(result.hops).toEqual([{ url: 'https://wavespestcontrol.com/old/', status: 301 }]);
  });

  test('a redirect chain that stays on owned fleet hosts is followed and every hop is revalidated', async () => {
    const getImpl = jest.fn()
      .mockResolvedValueOnce({ status: 301, headers: { location: 'https://bradentonflpestcontrol.com/pest-control-costs/' } })
      .mockResolvedValueOnce({ status: 200, headers: {}, body: '<title>Pest control costs</title>' });
    const result = await fetchOwnedUrlChain('https://wavespestcontrol.com/old/', { getImpl });
    expect(getImpl).toHaveBeenCalledTimes(2);
    expect(result.finalUrl).toBe('https://bradentonflpestcontrol.com/pest-control-costs/');
    expect(result.status).toBe(200);
    expect(result.hops).toHaveLength(2);
  });

  test('a redirect with no Location header is blocked, not silently treated as ok', async () => {
    const getImpl = jest.fn().mockResolvedValueOnce({ status: 302, headers: {} });
    const result = await fetchOwnedUrlChain('https://wavespestcontrol.com/old/', { getImpl });
    expect(result.blockedReason).toBe('redirect_without_location');
  });

  test('an excessive redirect chain is bounded rather than followed forever', async () => {
    const getImpl = jest.fn().mockResolvedValue({ status: 301, headers: { location: 'https://wavespestcontrol.com/next/' } });
    const result = await fetchOwnedUrlChain('https://wavespestcontrol.com/loop/', { getImpl });
    expect(result.blockedReason).toBe('redirect_budget_exceeded');
    expect(getImpl.mock.calls.length).toBeLessThan(20);
  });

  test('a network-level failure surfaces as a fetchError, not a fabricated status', async () => {
    const getImpl = jest.fn().mockResolvedValueOnce({ error: 'timeout' });
    const result = await fetchOwnedUrlChain('https://wavespestcontrol.com/x/', { getImpl });
    expect(result.fetchError).toBe('timeout');
  });
});

describe('checkOwnedUrlHealth end-to-end (injected getImpl, no real network)', () => {
  test('a disallowed host never reaches the fetcher and reports fetch_blocked', async () => {
    const getImpl = jest.fn();
    const result = await checkOwnedUrlHealth('https://example.org/x/', { getImpl });
    expect(result).toMatchObject({ verdict: 'fetch_blocked' });
    expect(getImpl).not.toHaveBeenCalled();
  });

  test('a soft-404 owned page is flagged even though the HTTP status is 200', async () => {
    const body = '<title>Page Not Found</title><meta name="robots" content="noindex,nofollow">';
    const getImpl = jest.fn().mockResolvedValueOnce({ status: 200, headers: {}, body });
    const result = await checkOwnedUrlHealth('https://bradentonflpestcontrol.com/pest-control-costs/', { getImpl });
    expect(result.verdict).toBe('soft_404');
    expect(result.url).toBe('https://bradentonflpestcontrol.com/pest-control-costs/');
  });
});

describe('collectCitedOwnedUrls', () => {
  function fakeDb(rows) {
    const builder = {
      where: () => builder,
      whereNotNull: () => builder,
      select: async () => rows,
    };
    return jest.fn(() => builder);
  }

  const MEASURED = { measurement_version: 2, answer_available: true, citations_complete: true };

  test('dedupes tracking-param variants, counts one citation credit per row, and drops non-owned URLs', async () => {
    const database = fakeDb([
      { ...MEASURED, waves_cited_urls: JSON.stringify([
        'https://wavespestcontrol.com/pest-control-costs/?utm_source=chatgpt',
        'https://wavespestcontrol.com/pest-control-costs/?utm_source=gemini', // same page, different tracking param, same row
        'https://example.org/not-owned/',
      ]) },
      { ...MEASURED, waves_cited_urls: JSON.stringify(['https://wavespestcontrol.com/pest-control-costs/']) },
      { ...MEASURED, waves_cited_urls: '[]' },
    ]);
    const result = await collectCitedOwnedUrls({ database, now: new Date('2026-09-27T12:00:00Z') });
    expect(result).toEqual([{ url: 'https://wavespestcontrol.com/pest-control-costs/', citationCount: 2 }]);
  });

  // Codex r1 (PR #5123): only attributable V2 answers are citation evidence —
  // legacy rows mixed search results and prose URLs into waves_cited_urls.
  test('ignores legacy, unanswered and incomplete-citation rows', async () => {
    const database = fakeDb([
      { measurement_version: 1, answer_available: true, citations_complete: true, waves_cited_urls: JSON.stringify(['https://wavespestcontrol.com/legacy-pool-url/']) },
      { measurement_version: 2, answer_available: false, citations_complete: true, waves_cited_urls: JSON.stringify(['https://wavespestcontrol.com/no-answer/']) },
      { measurement_version: 2, answer_available: true, citations_complete: false, waves_cited_urls: JSON.stringify(['https://wavespestcontrol.com/unresolved/']) },
      { ...MEASURED, waves_cited_urls: JSON.stringify(['https://wavespestcontrol.com/real-citation/']) },
    ]);
    const result = await collectCitedOwnedUrls({ database, now: new Date('2026-09-27T12:00:00Z') });
    expect(result).toEqual([{ url: 'https://wavespestcontrol.com/real-citation/', citationCount: 1 }]);
  });

  test('an empty window returns an empty list', async () => {
    const database = fakeDb([]);
    const result = await collectCitedOwnedUrls({ database, now: new Date('2026-09-27T12:00:00Z') });
    expect(result).toEqual([]);
  });
});

// Codex r1 (PR #5123): a cited URL with no health row yet is unverified —
// the dashboard must report it so the panel never reads it as clean.
describe('getCitedUrlHealthDashboard', () => {
  function twoTableDb({ mentions, health }) {
    return jest.fn((table) => {
      if (table === 'seo_llm_mentions') {
        const b = { where: () => b, whereNotNull: () => b, select: async () => mentions };
        return b;
      }
      const b = { whereIn: () => b, orderBy: async () => health };
      return b;
    });
  }
  const MEASURED = { measurement_version: 2, answer_available: true, citations_complete: true };

  test('counts cited URLs without a health row as unchecked, not clean', async () => {
    const database = twoTableDb({
      mentions: [{ ...MEASURED, waves_cited_urls: JSON.stringify(['https://wavespestcontrol.com/checked/', 'https://wavespestcontrol.com/new-citation/']) }],
      health: [{ url: 'https://wavespestcontrol.com/checked/', checked_on: '2026-09-27', verdict: 'ok', final_url: null, http_status: '200' }],
    });
    const result = await getCitedUrlHealthDashboard({ database, now: new Date('2026-09-27T12:00:00Z') });
    expect(result).toMatchObject({ candidates: 2, checked: 1, unchecked: 1, bad: 0 });
  });
});
