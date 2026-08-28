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
function makeDb({ updateRows = 1 } = {}) {
  const updates = [];
  db.mockImplementation(() => {
    const b = { wheres: [], raws: [], nulls: [] };
    for (const m of ['whereIn', 'whereNotIn', 'orWhere', 'orderBy', 'orderByRaw']) b[m] = jest.fn(() => b);
    b.where = jest.fn((...a) => { b.wheres.push(a); return b; });
    b.whereRaw = jest.fn((sql) => { b.raws.push(sql); return b; });
    b.whereNull = jest.fn((c) => { b.nulls.push(c); return b; });
    b.limit = jest.fn(() => Promise.resolve([]));   // reconcileFromProfile → no active row
    b.first = jest.fn(() => Promise.resolve(null)); // reconcileByDomain → no active row
    b.select = jest.fn(() => Promise.resolve([]));
    b.update = jest.fn((p) => { updates.push({ patch: p, wheres: b.wheres, raws: b.raws, nulls: b.nulls }); return Promise.resolve(updateRows); });
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
    expect(updates[0].patch).not.toHaveProperty('status');
    expect(updates[0].patch).toHaveProperty('last_live_check');
  });

  test('live row + bot-challenge crawl → stays live', async () => {
    const updates = makeDb();
    fetchPage.mockResolvedValue({ status: 200, html: '<html><title>Just a moment...</title><body>cf-challenge</body></html>', contentType: 'text/html', truncated: false });
    expect(await Verifier.verifyOne(live)).toBe('unverified');
    expect(updates[0].patch).not.toHaveProperty('status');
  });

  test('live row + fetch failure (redirect budget / DNS / SSRF-blocked) → stays live', async () => {
    const updates = makeDb();
    fetchPage.mockResolvedValue({ status: 0, html: '', error: 'too_many_redirects', blocked: false, truncated: false });
    expect(await Verifier.verifyOne(live)).toBe('unverified');
    expect(updates[0].patch).not.toHaveProperty('status');
    fetchPage.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await Verifier.verifyOne(live)).toBe('unverified');
    expect(updates[1].patch).not.toHaveProperty('status');
  });

  test('live row + COMPLETE 2xx HTML without the link + domain miss → lost (definitive)', async () => {
    const updates = makeDb();
    fetchPage.mockResolvedValue({ status: 200, html: '<html><body><p>No links to Waves here at all.</p></body></html>', contentType: 'text/html', truncated: false });
    expect(await Verifier.verifyOne(live)).toBe('lost');
    expect(updates[0].patch).toEqual(expect.objectContaining({ status: 'lost' }));
  });

  test('live row + 404 → lost (definitive)', async () => {
    const updates = makeDb();
    fetchPage.mockResolvedValue({ status: 404, html: '<html><body>Not found</body></html>', contentType: 'text/html', truncated: false });
    expect(await Verifier.verifyOne(live)).toBe('lost');
    expect(updates[0].patch).toEqual(expect.objectContaining({ status: 'lost' }));
  });

  test('a never-live "placed" row on an unverifiable crawl is just pending (unchanged behaviour)', async () => {
    const updates = makeDb();
    fetchPage.mockResolvedValue({ status: 200, html: '<html><body>x</body></html>', contentType: 'text/html', truncated: true });
    expect(await Verifier.verifyOne({ ...live, status: 'placed' })).toBe('pending');
    expect(updates[0].patch).not.toHaveProperty('status');
  });
});

describe('markLive on an un-pitched prospect (lost-link recovery row under daily verification)', () => {
  const PAGE = '<html><body><a href="https://wavespestcontrol.com/x/">Waves</a></body></html>';
  const recoveryRow = { ...live, status: 'prospect', source: 'lost_recovery', outreach_status: 'drafted' };
  beforeEach(() => { fetchPage.mockReset(); });

  test('crawl finds the link → promoted live ONLY via the unsent-state guard, draft withdrawn', async () => {
    const updates = makeDb();
    fetchPage.mockResolvedValue({ status: 200, html: PAGE, contentType: 'text/html', truncated: false });
    expect(await Verifier.verifyOne(recoveryRow)).toBe('live');
    const u = updates[0];
    expect(u.patch).toEqual(expect.objectContaining({ status: 'live', outreach_status: 'none', outreach_send_token: null, claimed_at: null, claimed_by: null }));
    expect(u.wheres).toEqual(expect.arrayContaining([[{ id: 'p1' }], [{ status: 'prospect' }]]));
    expect(u.raws.join(' ')).toMatch(/outreach_status.*'none', 'drafted'/);
    expect(u.nulls).toContain('outreach_sent_at');
  });

  test('send in flight (guard matches 0 rows) → row untouched, left for reconciliation, no indexing push', async () => {
    const updates = makeDb({ updateRows: 0 });
    fetchPage.mockResolvedValue({ status: 200, html: PAGE, contentType: 'text/html', truncated: false });
    expect(await Verifier.verifyOne({ ...recoveryRow, outreach_status: 'sending' })).toBe('pending');
    expect(updates).toHaveLength(1); // the guarded update only — nothing else written
  });

  test('an already-live row is NOT guarded (re-verify path unchanged)', async () => {
    const updates = makeDb();
    fetchPage.mockResolvedValue({ status: 200, html: PAGE, contentType: 'text/html', truncated: false });
    expect(await Verifier.verifyOne(live)).toBe('live');
    expect(updates[0].wheres).toEqual([[{ id: 'p1' }]]);
    expect(updates[0].patch).not.toHaveProperty('outreach_status');
  });
});

describe('verifier reconcile evidence is scan-tracked only', () => {
  test('reconcileFromProfile and reconcileByDomain both exclude GSC-export rows (historical, cannot prove liveness) via the shared scanTrackedOnly predicate', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'seo', 'link-prospect-verifier.js'), 'utf8');
    expect(src).toMatch(/const scanTrackedOnly = \(qb\) => qb\.whereNull\('discovery_source'\)\.orWhere\('discovery_source', 'dataforseo'\);/);
    const fromProfile = src.slice(src.indexOf('async function reconcileFromProfile'), src.indexOf('async function reconcileByDomain'));
    const byDomain = src.slice(src.indexOf('async function reconcileByDomain'), src.indexOf('const OMEGA_MAX_ATTEMPTS'));
    for (const block of [fromProfile, byDomain]) {
      const iStatus = block.indexOf(".where({ status: 'active' })");
      const iTracked = block.indexOf('.where(scanTrackedOnly)');
      expect(iStatus).toBeGreaterThan(-1);
      expect(iTracked).toBeGreaterThan(iStatus);
    }
  });
});
