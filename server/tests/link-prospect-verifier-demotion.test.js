jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/seo/omega-indexer', () => ({}));
jest.mock('../services/seo/contact-finder', () => ({ fetchPage: jest.fn() }));

const db = require('../models/db');
const { fetchPage } = require('../services/seo/contact-finder');
const Verifier = require('../services/seo/link-prospect-verifier');

// Only a definitive crawl may demote a live/indexed prospect: DataForSEO absence
// is temporary churn, and a crawl that could not read the page proves nothing.
function makeDb() {
  const updates = [];
  db.mockImplementation(() => {
    const b = {};
    for (const m of ['where', 'whereRaw', 'whereIn', 'whereNotIn', 'whereNull', 'orWhere', 'orderBy', 'orderByRaw']) b[m] = jest.fn(() => b);
    b.limit = jest.fn(() => Promise.resolve([]));   // reconcileFromProfile → no active row
    b.first = jest.fn(() => Promise.resolve(null)); // reconcileByDomain → no active row
    b.select = jest.fn(() => Promise.resolve([]));
    b.update = jest.fn((p) => { updates.push(p); return Promise.resolve(1); });
    return b;
  });
  db.raw = jest.fn((sql, bind) => ({ __raw: sql, bind }));
  return updates;
}

const live = { id: 'p1', status: 'live', live_url: 'https://blog.example/post', target_domain: 'blog.example', target_page: 'https://wavespestcontrol.com/x/', quality_signals: null };

describe('crawlProvesAbsence', () => {
  const f = Verifier.crawlProvesAbsence;
  test('definitive: 404/410, or a complete 2xx HTML body without the link', () => {
    expect(f({ found: false, status: 404 })).toBe(true);
    expect(f({ found: false, status: 410 })).toBe(true);
    expect(f({ found: false, status: 200, truncated: false, blocked: false, error: null })).toBe(true);
  });
  test('not definitive: truncated / challenge / non-HTML / empty / blocked / errored / 403 / 429 / 5xx / found', () => {
    expect(f({ found: false, status: 200, truncated: true })).toBe(false);
    expect(f({ found: false, status: 200, unverifiable: 'challenge' })).toBe(false);
    expect(f({ found: false, status: 200, unverifiable: 'non_html' })).toBe(false);
    expect(f({ found: false, status: 200, unverifiable: 'empty' })).toBe(false);
    expect(f({ found: false, status: 0, blocked: true, error: 'ssrf_blocked' })).toBe(false);
    expect(f({ found: false, status: 0, error: 'fetch_failed' })).toBe(false);
    expect(f({ found: false, status: 403 })).toBe(false);
    expect(f({ found: false, status: 429 })).toBe(false);
    expect(f({ found: false, status: 503 })).toBe(false);
    expect(f({ found: false, status: 200, error: 'redirect_budget' })).toBe(false);
    expect(f({ found: true, status: 200 })).toBe(false);
    expect(f(null)).toBe(false);
  });
});

describe('verifyOne demotion guard', () => {
  beforeEach(() => { fetchPage.mockReset(); });

  test('live row + profile miss + TRUNCATED crawl + domain miss → stays live (touched, "unverified")', async () => {
    const updates = makeDb();
    fetchPage.mockResolvedValue({ status: 200, html: '<html><body>long page, link past the cap</body></html>', contentType: 'text/html', truncated: true });
    expect(await Verifier.verifyOne(live)).toBe('unverified');
    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty('status');
    expect(updates[0]).toHaveProperty('last_live_check');
  });

  test('live row + bot-challenge crawl → stays live', async () => {
    const updates = makeDb();
    fetchPage.mockResolvedValue({ status: 200, html: '<html><title>Just a moment...</title><body>cf-challenge</body></html>', contentType: 'text/html', truncated: false });
    expect(await Verifier.verifyOne(live)).toBe('unverified');
    expect(updates[0]).not.toHaveProperty('status');
  });

  test('live row + fetch failure (redirect budget / DNS / SSRF-blocked) → stays live', async () => {
    const updates = makeDb();
    fetchPage.mockResolvedValue({ status: 0, html: '', error: 'too_many_redirects', blocked: false, truncated: false });
    expect(await Verifier.verifyOne(live)).toBe('unverified');
    expect(updates[0]).not.toHaveProperty('status');
    fetchPage.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await Verifier.verifyOne(live)).toBe('unverified');
    expect(updates[1]).not.toHaveProperty('status');
  });

  test('live row + COMPLETE 2xx HTML without the link + domain miss → lost (definitive)', async () => {
    const updates = makeDb();
    fetchPage.mockResolvedValue({ status: 200, html: '<html><body><p>No links to Waves here at all.</p></body></html>', contentType: 'text/html', truncated: false });
    expect(await Verifier.verifyOne(live)).toBe('lost');
    expect(updates[0]).toEqual(expect.objectContaining({ status: 'lost' }));
  });

  test('live row + 404 → lost (definitive)', async () => {
    const updates = makeDb();
    fetchPage.mockResolvedValue({ status: 404, html: '<html><body>Not found</body></html>', contentType: 'text/html', truncated: false });
    expect(await Verifier.verifyOne(live)).toBe('lost');
    expect(updates[0]).toEqual(expect.objectContaining({ status: 'lost' }));
  });

  test('a never-live "placed" row on an unverifiable crawl is just pending (unchanged behaviour)', async () => {
    const updates = makeDb();
    fetchPage.mockResolvedValue({ status: 200, html: '<html><body>x</body></html>', contentType: 'text/html', truncated: true });
    expect(await Verifier.verifyOne({ ...live, status: 'placed' })).toBe('pending');
    expect(updates[0]).not.toHaveProperty('status');
  });
});
