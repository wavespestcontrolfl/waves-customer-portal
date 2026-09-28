jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn() }));
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: () => false, sendOne: jest.fn() }));

const {
  normalizeOwnedUrl,
  isOwnedFleetUrl,
  mapSharedResultToVerdict,
  checkOwnedUrlHealth,
  collectCitedOwnedUrls,
  getCitedUrlHealthDashboard,
  VERDICTS,
  BAD_VERDICTS,
} = require('../services/seo/owned-url-health');

// Same fetch-mock shape content-registry-live-status.test.js uses — this
// module's fetch/redirect/allowlist mechanism IS that module's
// checkUrlLiveStatus (AGENTS.md: one shared fetcher/classifier), so its
// integration tests are exercised the same way.
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

describe('normalizeOwnedUrl', () => {
  test('strips utm_ tracking params and the fragment, lowercases the host', () => {
    expect(normalizeOwnedUrl('https://WWW.BradentonFLPestControl.com/pest-control-costs/?utm_source=chatgpt&utm_medium=ai#pricing'))
      .toBe('https://www.bradentonflpestcontrol.com/pest-control-costs/');
  });

  // Codex r4 on #5123: the identity is also what gets probed, so the cited
  // path is never rewritten — /page and /page/ are different requests.
  test('keeps the cited path exactly as cited — no trailing slash is added or removed', () => {
    expect(normalizeOwnedUrl('https://wavespestcontrol.com/pest-control-costs')).toBe('https://wavespestcontrol.com/pest-control-costs');
    expect(normalizeOwnedUrl('https://wavespestcontrol.com/pest-control-costs/')).toBe('https://wavespestcontrol.com/pest-control-costs/');
    expect(normalizeOwnedUrl('http://wavespestcontrol.com/pest-control-costs?utm_source=chatgpt.com')).toBe('https://wavespestcontrol.com/pest-control-costs');
  });

  test('rejects a non-http(s) scheme and malformed input', () => {
    expect(normalizeOwnedUrl('javascript:alert(1)')).toBe('');
    expect(normalizeOwnedUrl('not a url')).toBe('');
    expect(normalizeOwnedUrl('')).toBe('');
  });

  // Codex r3 on #5123: a nonstandard port is a different destination — it is
  // rejected, never rewritten to the default-port page.
  test('rejects a nonstandard port instead of rewriting it; keeps an explicit default port', () => {
    expect(normalizeOwnedUrl('https://wavespestcontrol.com:8443/page')).toBe('');
    expect(normalizeOwnedUrl('https://wavespestcontrol.com:443/page')).toBe('https://wavespestcontrol.com/page');
  });
});

// Codex r1/r3 on #5123: a cited URL is "checked" only by a RECENT health row —
// no row, or a stale one, leaves it unchecked so the panel never reads clean.
describe('getCitedUrlHealthDashboard', () => {
  function twoTableDb({ mentions, health }) {
    return jest.fn((table) => {
      if (table === 'seo_llm_mentions') {
        const b = { where: () => b, whereNotNull: () => b, select: async () => mentions };
        return b;
      }
      let since = null;
      const b = {
        whereIn: () => b,
        where: (col, op, value) => { if (col === 'checked_on' && op === '>=') since = value; return b; },
        orderBy: async () => health.filter((r) => !since || String(r.checked_on) >= since),
      };
      return b;
    });
  }
  const MEASURED = { measurement_version: 2, answer_available: true, citations_complete: true };
  const cited = (urls) => ({ ...MEASURED, waves_cited_urls: JSON.stringify(urls) });

  test('counts URLs without a recent health row as unchecked, not clean', async () => {
    const database = twoTableDb({
      mentions: [cited(['https://wavespestcontrol.com/checked/', 'https://wavespestcontrol.com/new-citation/', 'https://wavespestcontrol.com/stale/'])],
      health: [
        { url: 'https://wavespestcontrol.com/checked/', checked_on: '2026-09-27', verdict: 'ok' },
        { url: 'https://wavespestcontrol.com/stale/', checked_on: '2026-09-10', verdict: 'ok' },
      ],
    });
    const result = await getCitedUrlHealthDashboard({ database, now: new Date('2026-09-27T12:00:00Z') });
    expect(result).toMatchObject({ candidates: 3, checked: 1, unchecked: 2, bad: 0 });
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

// Pure mapping tests: the shared checker's (now body-aware) live_status
// vocabulary -> this module's own richer verdicts.
describe('mapSharedResultToVerdict', () => {
  function shared(overrides = {}) {
    return {
      target_url: 'https://wavespestcontrol.com/x/',
      final_url: 'https://wavespestcontrol.com/x/',
      http_status: '200',
      final_http_status: null,
      live_status: 'live',
      redirect_target_url: null,
      canonical_target_url: null,
      noindex_detected: false,
      page_title: 'Pest control costs',
      visible_text_length: 2000,
      truncated: false,
      error: null,
      ...overrides,
    };
  }

  test('a fetch failure classifies as fetch_blocked, never not_found', () => {
    expect(VERDICTS).toContain('fetch_blocked');
    const result = mapSharedResultToVerdict(shared({ live_status: 'error', http_status: 'error', final_url: null, error: 'timeout' }));
    expect(result.verdict).toBe('fetch_blocked');
    expect(result.verdict).not.toBe('not_found');
    expect(result.httpStatus).toBeNull();
    expect(result.detail.reason).toBe('timeout');
  });

  test('an off-fleet/unresolved host classifies as fetch_blocked', () => {
    const result = mapSharedResultToVerdict(shared({ live_status: 'unknown', http_status: 'unknown', final_url: null, error: 'Live-check URL is outside the content fleet' }));
    expect(result).toMatchObject({ verdict: 'fetch_blocked' });
    expect(result.detail.reason).toMatch(/outside the content fleet/);
  });

  test('a real 404 classifies as not_found', () => {
    const result = mapSharedResultToVerdict(shared({ live_status: 'missing', http_status: '404' }));
    expect(result.verdict).toBe('not_found');
  });

  test('a 5xx classifies as server_error', () => {
    const result = mapSharedResultToVerdict(shared({ live_status: 'server_error', http_status: '503' }));
    expect(result.verdict).toBe('server_error');
  });

  test('a 403 (shared "blocked") classifies as challenge', () => {
    const result = mapSharedResultToVerdict(shared({ live_status: 'blocked', http_status: '403' }));
    expect(result.verdict).toBe('challenge');
  });

  test('a 429 (shared generic "error") is surfaced as challenge, not a bare fetch_blocked', () => {
    const result = mapSharedResultToVerdict(shared({ live_status: 'error', http_status: '429' }));
    expect(result.verdict).toBe('challenge');
    expect(result.detail.reason).toBe('rate_limited');
  });

  test('a shared "challenge" (interstitial body evidence) classifies as challenge', () => {
    const result = mapSharedResultToVerdict(shared({ live_status: 'challenge', page_title: 'Just a moment...' }));
    expect(result.verdict).toBe('challenge');
  });

  // Seeded soft-404 fixture: the shared checker flags this from the fleet's
  // own 404.astro template shape (title + noindex meta) under an HTTP 200.
  test('a shared "soft_404" (2xx not-found template) classifies as soft_404', () => {
    const result = mapSharedResultToVerdict(shared({ live_status: 'soft_404', page_title: 'Page Not Found' }));
    expect(result.verdict).toBe('soft_404');
  });

  test('a shared "noindex" classifies as noindex', () => {
    const result = mapSharedResultToVerdict(shared({ live_status: 'noindex', noindex_detected: true }));
    expect(result.verdict).toBe('noindex');
  });

  test('a shared "canonicalized" classifies as canonical_elsewhere, carrying the canonical target', () => {
    const result = mapSharedResultToVerdict(shared({ live_status: 'canonicalized', canonical_target_url: 'https://wavespestcontrol.com/other-page/' }));
    expect(result).toMatchObject({ verdict: 'canonical_elsewhere', detail: { canonicalUrl: 'https://wavespestcontrol.com/other-page/' } });
  });

  test('a truncated response (shared size cap tripped) classifies as fetch_blocked, not ok', () => {
    const result = mapSharedResultToVerdict(shared({ truncated: true }));
    expect(result.verdict).toBe('fetch_blocked');
    expect(result.detail.reason).toBe('response_truncated');
  });

  test('a 2xx with no visible text (or a 204) classifies as soft_404, never ok', () => {
    expect(mapSharedResultToVerdict(shared({ visible_text_length: 0 })).verdict).toBe('soft_404');
    expect(mapSharedResultToVerdict(shared({ http_status: '204', final_http_status: null, visible_text_length: 0 })).verdict).toBe('soft_404');
  });

  test('a 301/308 chain landing on a clean page classifies as redirect_ok', () => {
    const result = mapSharedResultToVerdict(shared({
      live_status: 'redirected', http_status: '301', final_http_status: '200',
      redirect_target_url: 'https://wavespestcontrol.com/new/', final_url: 'https://wavespestcontrol.com/new/',
    }));
    expect(result.verdict).toBe('redirect_ok');
  });

  test('a 302 (temporary) redirect landing on a clean page classifies as ok, not redirect_ok', () => {
    const result = mapSharedResultToVerdict(shared({
      live_status: 'redirected', http_status: '302', final_http_status: '200',
      redirect_target_url: 'https://wavespestcontrol.com/new/', final_url: 'https://wavespestcontrol.com/new/',
    }));
    expect(result.verdict).toBe('ok');
  });

  // codex pre-push audit finding: the shared redirect classifier does not
  // itself reclassify on a canonical mismatch (registry rows keep that as
  // 'redirected' — a content-registry test pins it), so this module must
  // check canonical_target_url itself before calling a redirect healthy.
  test('a redirect landing clean but self-declaring a DIFFERENT canonical classifies as canonical_elsewhere, not redirect_ok', () => {
    const result = mapSharedResultToVerdict(shared({
      live_status: 'redirected', http_status: '301', final_http_status: '200',
      redirect_target_url: 'https://wavespestcontrol.com/new/', final_url: 'https://wavespestcontrol.com/new/',
      canonical_target_url: 'https://wavespestcontrol.com/other-page/',
    }));
    expect(result).toMatchObject({ verdict: 'canonical_elsewhere', detail: { canonicalUrl: 'https://wavespestcontrol.com/other-page/' } });
  });

  test('a redirect landing clean with a canonical matching the landed URL is still redirect_ok', () => {
    const result = mapSharedResultToVerdict(shared({
      live_status: 'redirected', http_status: '301', final_http_status: '200',
      redirect_target_url: 'https://wavespestcontrol.com/new/', final_url: 'https://wavespestcontrol.com/new/',
      canonical_target_url: 'https://wavespestcontrol.com/new/',
    }));
    expect(result.verdict).toBe('redirect_ok');
  });

  test('a clean, directly-served 2xx page classifies as ok', () => {
    expect(mapSharedResultToVerdict(shared()).verdict).toBe('ok');
  });

  test('an unrecognized shared live_status defensively classifies as fetch_blocked, never ok', () => {
    const result = mapSharedResultToVerdict(shared({ live_status: 'something_new' }));
    expect(result.verdict).toBe('fetch_blocked');
    expect(result.detail.reason).toBe('unmapped_live_status_something_new');
  });
});

// Integration: checkOwnedUrlHealth calls the SHARED checkUrlLiveStatus, so
// these exercise the real fetch/redirect-walk/allowlist path end to end —
// the same fetchImpl contract content-registry-live-status.test.js uses.
describe('checkOwnedUrlHealth (shared checker, injected fetchImpl)', () => {
  test('a disallowed host never reaches the fetcher and reports fetch_blocked', async () => {
    const fetchImpl = jest.fn();
    const result = await checkOwnedUrlHealth('https://example.org/x/', { fetchImpl });
    expect(result).toMatchObject({ verdict: 'fetch_blocked' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a redirect hop that leaves the owned fleet is blocked before it is fetched', async () => {
    const fetchImpl = jest.fn(fetchMap({
      'https://wavespestcontrol.com/old/': response(301, '', { location: 'https://attacker.example/steal' }),
    }));
    const result = await checkOwnedUrlHealth('https://wavespestcontrol.com/old/', { fetchImpl });
    expect(result.verdict).toBe('fetch_blocked');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // the off-fleet hop itself was never requested
  });

  test('a redirect chain that stays on owned fleet hosts resolves to redirect_ok', async () => {
    const fetchImpl = jest.fn(fetchMap({
      'https://wavespestcontrol.com/old/': response(301, '', { location: 'https://bradentonflpestcontrol.com/pest-control-costs/' }),
      'https://bradentonflpestcontrol.com/pest-control-costs/': response(200, '<html><head><title>Pest control costs</title></head><body>Real content here, plenty of it, well past the minimum visible length this module enforces for a clean page.</body></html>', {}, 'https://bradentonflpestcontrol.com/pest-control-costs/'),
    }));
    const result = await checkOwnedUrlHealth('https://wavespestcontrol.com/old/', { fetchImpl });
    expect(result.verdict).toBe('redirect_ok');
    expect(result.finalUrl).toBe('https://bradentonflpestcontrol.com/pest-control-costs/');
  });

  // The motivating case: a 301 landing on the fleet's own soft-404 template.
  test('the motivating case — a 301 landing on a soft-404 template is flagged, not read as healthy', async () => {
    const fetchImpl = jest.fn(fetchMap({
      'https://bradentonflpestcontrol.com/pest-control-costs/': response(301, '', { location: 'https://bradentonflpestcontrol.com/404' }),
      'https://bradentonflpestcontrol.com/404': response(200, '<html><head><title>Page Not Found &mdash; Waves Pest Control</title><meta name="robots" content="noindex,nofollow"></head><body>Page Not Found</body></html>', {}, 'https://bradentonflpestcontrol.com/404'),
    }));
    const result = await checkOwnedUrlHealth('https://bradentonflpestcontrol.com/pest-control-costs/', { fetchImpl });
    expect(result.verdict).toBe('soft_404');
  });

  test('a redirect landing clean but self-declaring a different canonical is flagged end to end', async () => {
    const fetchImpl = jest.fn(fetchMap({
      'https://wavespestcontrol.com/old/': response(301, '', { location: 'https://wavespestcontrol.com/new/' }),
      'https://wavespestcontrol.com/new/': response(
        200,
        '<html><head><title>Pest control costs</title><link rel="canonical" href="https://wavespestcontrol.com/other-page/"></head><body>Real content here, plenty of it, well past the minimum visible length this module enforces.</body></html>',
        {},
        'https://wavespestcontrol.com/new/',
      ),
    }));
    const result = await checkOwnedUrlHealth('https://wavespestcontrol.com/old/', { fetchImpl });
    expect(result.verdict).toBe('canonical_elsewhere');
  });

  // Codex r4 on #5123: the cited slash-less form is what gets fetched — a
  // healthy /page/ must not stand in for a broken cited /page.
  test('probes the cited path as cited, not a trailing-slash rewrite of it', async () => {
    const fetchImpl = jest.fn(fetchMap({
      'https://wavespestcontrol.com/pest-control-costs': response(404, 'Not found', {}, 'https://wavespestcontrol.com/pest-control-costs'),
      'https://wavespestcontrol.com/pest-control-costs/': response(200, '<html><head><title>Pest control costs</title></head><body>Real content here, plenty of it, well past the minimum visible length this module enforces for a clean page.</body></html>'),
    }));
    const result = await checkOwnedUrlHealth('https://wavespestcontrol.com/pest-control-costs?utm_source=chatgpt.com', { fetchImpl });
    expect(result).toMatchObject({ url: 'https://wavespestcontrol.com/pest-control-costs', verdict: 'not_found' });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://wavespestcontrol.com/pest-control-costs');
  });

  test('a redirect landing on /page with a /page/ canonical is the same page, still redirect_ok', async () => {
    const fetchImpl = jest.fn(fetchMap({
      'https://wavespestcontrol.com/old/': response(301, '', { location: 'https://wavespestcontrol.com/new' }),
      'https://wavespestcontrol.com/new': response(
        200,
        '<html><head><title>Pest control costs</title><link rel="canonical" href="https://wavespestcontrol.com/new/"></head><body>Real content here, plenty of it, well past the minimum visible length this module enforces.</body></html>',
        {},
        'https://wavespestcontrol.com/new',
      ),
    }));
    const result = await checkOwnedUrlHealth('https://wavespestcontrol.com/old/', { fetchImpl });
    expect(result.verdict).toBe('redirect_ok');
  });

  // Codex r5 on #5123: an HTTPS -> HTTP downgrade is never a clean verdict.
  test('a redirect that downgrades to http:// is fetch_blocked, never redirect_ok', async () => {
    const fetchImpl = jest.fn(fetchMap({
      'https://wavespestcontrol.com/old/': response(301, '', { location: 'http://bradentonflpestcontrol.com/pest-control-costs/' }),
      'http://bradentonflpestcontrol.com/pest-control-costs/': response(200, '<html><head><title>Pest control costs</title></head><body>Real content here, plenty of it, well past the minimum visible length this module enforces for a clean page.</body></html>', {}, 'http://bradentonflpestcontrol.com/pest-control-costs/'),
    }));
    const result = await checkOwnedUrlHealth('https://wavespestcontrol.com/old/', { fetchImpl });
    expect(result).toMatchObject({ verdict: 'fetch_blocked', detail: { reason: 'insecure_redirect' } });
  });

  // Codex r5 on #5123: the real Content-Type reaches the shared classifier.
  test('a 200 JSON error at a cited page URL is soft_404, never ok', async () => {
    const fetchImpl = jest.fn(fetchMap({
      'https://wavespestcontrol.com/pest-control-costs/': response(200, JSON.stringify({ error: 'not_found', message: 'The requested resource could not be located on this server.' }), { 'content-type': 'application/json' }),
    }));
    const result = await checkOwnedUrlHealth('https://wavespestcontrol.com/pest-control-costs/', { fetchImpl });
    expect(result).toMatchObject({ verdict: 'soft_404', detail: { contentType: 'application/json' } });
  });

  test('a network-level failure surfaces as fetch_blocked', async () => {
    const fetchImpl = jest.fn(fetchMap({
      'https://wavespestcontrol.com/x/': new Error('timeout'),
    }));
    const result = await checkOwnedUrlHealth('https://wavespestcontrol.com/x/', { fetchImpl });
    expect(result.verdict).toBe('fetch_blocked');
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

  const measuredRow = (waves_cited_urls) => ({
    waves_cited_urls, measurement_version: 2, answer_available: true, citations_complete: true,
  });

  test('dedupes tracking-param variants, counts one citation credit per row, and drops non-owned URLs', async () => {
    const database = fakeDb([
      measuredRow([
        'https://wavespestcontrol.com/pest-control-costs/?utm_source=chatgpt',
        'https://wavespestcontrol.com/pest-control-costs/?utm_source=gemini', // same page, different tracking param, same row
        'https://example.org/not-owned/',
      ]),
      measuredRow(['https://wavespestcontrol.com/pest-control-costs/']),
      measuredRow([]),
    ]);
    const result = await collectCitedOwnedUrls({ database, now: new Date('2026-09-27T12:00:00Z') });
    expect(result).toEqual([{ url: 'https://wavespestcontrol.com/pest-control-costs/', citationCount: 2 }]);
  });

  test('keeps the slash and no-slash forms of a cited path as separate candidates', async () => {
    const database = fakeDb([
      measuredRow(['https://wavespestcontrol.com/pest-control-costs']),
      measuredRow(['https://wavespestcontrol.com/pest-control-costs/']),
    ]);
    const result = await collectCitedOwnedUrls({ database, now: new Date('2026-09-27T12:00:00Z') });
    expect(result.map((r) => r.url).sort()).toEqual([
      'https://wavespestcontrol.com/pest-control-costs',
      'https://wavespestcontrol.com/pest-control-costs/',
    ]);
  });

  test('an empty window returns an empty list', async () => {
    const database = fakeDb([]);
    const result = await collectCitedOwnedUrls({ database, now: new Date('2026-09-27T12:00:00Z') });
    expect(result).toEqual([]);
  });

  test('a legacy (non-attributable) row contributes no candidates', async () => {
    const database = fakeDb([
      { waves_cited_urls: ['https://wavespestcontrol.com/pest-control-costs/'], measurement_version: null, answer_available: true, citations_complete: true },
    ]);
    const result = await collectCitedOwnedUrls({ database, now: new Date('2026-09-27T12:00:00Z') });
    expect(result).toEqual([]);
  });
});

describe('BAD_VERDICTS', () => {
  test('noindex and challenge are bad; ok and redirect_ok are not', () => {
    expect(BAD_VERDICTS.has('noindex')).toBe(true);
    expect(BAD_VERDICTS.has('challenge')).toBe(true);
    expect(BAD_VERDICTS.has('ok')).toBe(false);
    expect(BAD_VERDICTS.has('redirect_ok')).toBe(false);
  });
});
