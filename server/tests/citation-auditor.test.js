/**
 * Directory-listing auditor: the five states, the blocked-fetch-is-never-missing
 * rule, mismatch field reporting, and NAP selection from config/locations.js.
 * No network: classifyListing is pure; audit() runs the REAL contact-finder
 * fetchPage (private-host refusal, redirect re-check) over a mocked fetchFn
 * and a mocked DNS resolver.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const db = require('../models/db');
const auditor = require('../services/seo/citation-auditor');
const { WAVES_LOCATIONS } = require('../config/locations');

const { classifyListing, candidatesFor, STATES } = auditor._internals;
const BRAND = WAVES_LOCATIONS[0];
const PARRISH = WAVES_LOCATIONS.find((l) => l.id === 'parrish');

const filler = ' Licensed pest control company serving the Gulf Coast with quarterly service plans.'.repeat(4);
const page = (body, over = {}) => ({
  status: 200, finalUrl: 'https://dir.example/waves', redirectHops: 0, html: `<html><head><title>Waves Pest Control - Listing</title></head><body>${body}${filler}</body></html>`,
  blocked: false, truncated: false, contentType: 'text/html', error: null, ...over,
});
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

describe('classifyListing', () => {
  const expected = candidatesFor({});

  test('verified: name and phone match, address matched when shown', () => {
    const r = classifyListing(page(`<h1>Waves Pest Control</h1><p>Call (941) 318-7612 - 13649 Luxe Ave #110, Bradenton, FL 34211</p>`), expected);
    expect(r.status).toBe('verified');
    expect(r.detail).toMatchObject({ address_checked: true, office: BRAND.id });
    expect(r.nap).toMatchObject({ nap_name: 'Waves Pest Control', nap_phone: BRAND.phone });
  });

  test('verified without an address when the page shows none', () => {
    const r = classifyListing(page('<h1>Waves Pest Control</h1><a href="tel:+19413187612">call</a>'), expected);
    expect(r.status).toBe('verified');
    expect(r.detail.address_checked).toBe(false);
  });

  test('mismatched phone names the field and the value seen', () => {
    const r = classifyListing(page('<h1>Waves Pest Control</h1><p>(941) 555-0142</p>'), expected);
    expect(r.status).toBe('mismatched');
    expect(r.detail.mismatches).toEqual([{ field: 'phone', expected: WAVES_LOCATIONS.map((l) => l.phone).join(' or '), seen: ['(941) 555-0142'] }]);
    expect(r.nap.nap_phone).toBe('(941) 555-0142');
  });

  test('mismatched structured address reports the address seen', () => {
    const r = classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p>${ld({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: BRAND.phone, address: { streetAddress: '99 Old Rd', addressLocality: 'Tampa', postalCode: '33601' } })}`), expected);
    expect(r.status).toBe('mismatched');
    expect(r.detail.mismatches).toEqual([{ field: 'address', expected: BRAND.address, seen: '99 Old Rd, Tampa, 33601' }]);
  });

  test('mismatched name when a phone is shown but our name is not', () => {
    const r = classifyListing({ ...page('<h1>Acme Bug Co</h1><p>(941) 318-7612</p>'), html: `<html><head><title>Acme Bug Co</title></head><body><h1>Acme Bug Co</h1><p>(941) 318-7612</p>${filler}</body></html>` }, expected);
    expect(r.status).toBe('mismatched');
    expect(r.detail.mismatches.map((m) => m.field)).toEqual(['name']);
    expect(r.detail.mismatches[0].seen).toBe('Acme Bug Co');
  });

  test('an unassigned brand listing may show ANY office and records which one matched', () => {
    for (const loc of WAVES_LOCATIONS) {
      const r = classifyListing(page(`<h1>Waves Pest Control</h1><p>${loc.phone} ${loc.address}</p>`), candidatesFor({}));
      expect(r.status).toBe('verified');
      expect(r.detail.office).toBe(loc.id);
      expect(r.nap.nap_address).toBe(loc.address);
    }
  });

  test('a brand listing pairs the phone with THAT office: another office\'s address is a mismatch', () => {
    const r = classifyListing(page(`<h1>Waves Pest Control</h1><p>${PARRISH.phone}</p>${ld({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: PARRISH.phone, address: { streetAddress: '13649 Luxe Ave' } })}`), candidatesFor({}));
    expect(r.status).toBe('mismatched');
    expect(r.detail.office).toBe('parrish');
    expect(r.detail.mismatches).toEqual([{ field: 'address', expected: PARRISH.address, seen: '13649 Luxe Ave' }]);
  });

  test('a row assigned to an office is judged against that office only', () => {
    const body = `<h1>Waves Pest Control</h1><p>${PARRISH.phone}</p>`;
    expect(classifyListing(page(body), candidatesFor({ location_id: 'parrish' })).status).toBe('verified');
    const other = classifyListing(page(body), candidatesFor({ location_id: 'venice' }));
    expect(other.status).toBe('mismatched');
    expect(other.detail.mismatches[0]).toMatchObject({ field: 'phone', expected: WAVES_LOCATIONS.find((l) => l.id === 'venice').phone });
  });

  test('a cut-off body cannot prove a mismatch', () => {
    const r = classifyListing(page('<h1>Waves Pest Control</h1><p>(941) 555-0142</p>', { truncated: true }), expected);
    expect(r).toMatchObject({ status: 'fetch-blocked', detail: { reason: 'truncated' } });
  });

  test.each([
    [403, 'http_403'], [429, 'http_429'], [500, 'http_500'], [503, 'http_503'],
    [404, 'http_404'], [410, 'http_410'], [401, 'http_401'],
  ])('HTTP %i is fetch-blocked, never missing', (status, reason) => {
    const r = classifyListing({ status, html: null, contentType: 'text/html', error: null, blocked: false }, expected);
    expect(r.status).toBe('fetch-blocked');
    expect(r.detail.reason).toBe(reason);
    expect(r.nap).toBeNull();
  });

  test.each([
    ['timeout / network error', { status: 0, html: null, error: 'aborted' }, 'aborted'],
    ['DNS failure', { status: 0, html: null, error: 'dns_error' }, 'dns_error'],
    ['private host refused', { status: 0, html: null, blocked: true, error: 'blocked_host' }, 'blocked_host'],
    ['bot challenge', { html: '<html><head><title>Just a moment...</title></head><body><div id="cf-chl-widget">x</div></body></html>' }, 'challenge'],
    ['JS-only shell', { html: '<html><body><div id="root"></div><script>app()</script></body></html>' }, 'empty_or_js_only'],
    ['non-HTML body', { html: '{"a":1}', contentType: 'application/json' }, 'non_html'],
    ['no NAP on the page', { html: `<html><body><p>${'Welcome to our directory of local businesses and services. '.repeat(8)}</p></body></html>` }, 'no_nap_found'],
    ['name shown but phone not readable', { html: `<html><body><h1>Waves Pest Control</h1>${filler}</body></html>` }, 'phone_not_found'],
  ])('%s is fetch-blocked', (_label, over, reason) => {
    const r = classifyListing({ status: 200, finalUrl: 'https://dir.example/x', contentType: 'text/html', truncated: false, blocked: false, error: null, ...over }, expected);
    expect(r.status).toBe('fetch-blocked');
    expect(r.detail.reason).toBe(reason);
  });

  test('no fetch outcome ever classifies as missing or verified-by-default', () => {
    const outcomes = [403, 404, 429, 500, 0].map((status) => classifyListing({ status, html: null, error: status ? null : 'aborted' }, expected).status);
    expect(outcomes.every((s) => s === 'fetch-blocked')).toBe(true);
    expect(STATES).toContain('missing'); // reachable only through updateCitation
  });
});

describe('audit()', () => {
  let store;
  let updates;
  beforeEach(() => {
    updates = [];
    db.mockImplementation((table) => {
      expect(table).toBe('seo_citations');
      return {
        whereNot: async (col, val) => store.filter((r) => r[col] !== val),
        where: (col, id) => ({ update: async (patch) => { updates.push({ id, patch }); } }),
        orderBy: () => ({ orderBy: async () => store }),
      };
    });
  });
  const fetchFn = (routes) => async (url) => {
    const r = routes[url];
    if (!r) throw new Error(`unexpected fetch ${url}`);
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => (r.headers || {})[k] || null }, text: async () => r.body || '' };
  };
  const html = (status, body, headers = { 'content-type': 'text/html' }) => ({ status, body: `<html><head><title>x</title></head><body>${body}${filler}</body></html>`, headers });

  test('writes each state; rows with no URL stay unverified and are never fetched; human "missing" rows are skipped', async () => {
    store = [
      { id: 'ok', listing_url: 'https://ok.example/l', location_id: 'venice', status: 'unverified' },
      { id: 'bad', listing_url: 'https://bad.example/l', status: 'unverified' },
      { id: 'yelp', listing_url: 'https://yelp.example/l', status: 'unverified' },
      { id: 'redir', listing_url: 'https://redir.example/l', status: 'active' },
      { id: 'inner', listing_url: 'https://inner.example/l', status: 'unchecked' },
      { id: 'none', listing_url: null, status: 'unchecked' },
      { id: 'human', listing_url: 'https://human.example/l', status: 'missing' },
    ];
    const routes = {
      'https://ok.example/l': html(200, `<h1>Waves Pest Control</h1><p>${WAVES_LOCATIONS.find((l) => l.id === 'venice').phone}</p>`),
      'https://bad.example/l': html(200, '<h1>Waves Pest Control</h1><p>(941) 555-0142</p>'),
      'https://yelp.example/l': { status: 403, headers: {} },
      'https://redir.example/l': { status: 301, headers: { location: 'http://127.0.0.1/admin' } },
      'https://inner.example/l': new Error('socket hang up'),
    };
    const resolveHostFn = async (host) => host !== '127.0.0.1';
    const result = await auditor.audit({ fetchFn: fetchFn(routes), resolveHostFn });
    const byId = Object.fromEntries(updates.map((u) => [u.id, u.patch]));

    expect(byId.ok).toMatchObject({ status: 'verified', nap_consistent: true });
    expect(byId.bad).toMatchObject({ status: 'mismatched', nap_consistent: false, nap_phone: '(941) 555-0142' });
    expect(JSON.parse(byId.bad.status_detail).mismatches[0]).toMatchObject({ field: 'phone', seen: ['(941) 555-0142'] });
    expect(byId.yelp).toMatchObject({ status: 'fetch-blocked', nap_consistent: null });
    expect(JSON.parse(byId.yelp.status_detail)).toMatchObject({ reason: 'http_403', http_status: 403 });
    // a redirect to a loopback address is refused, and a refusal is a blocked fetch
    expect(byId.redir.status).toBe('fetch-blocked');
    expect(JSON.parse(byId.redir.status_detail).reason).toBe('blocked_host');
    expect(byId.inner.status).toBe('fetch-blocked');
    expect(byId.none).toMatchObject({ status: 'unverified' });
    expect(JSON.parse(byId.none.status_detail)).toEqual({ reason: 'no_listing_url' });
    expect(byId.human).toBeUndefined();
    expect(Object.values(byId).map((p) => p.status)).not.toContain('missing');
    expect(result).toEqual({ total: 6, unverified: 1, verified: 1, mismatched: 1, 'fetch-blocked': 3, missing: 0 });
  });

  test('a throwing check lands fetch-blocked and does not stop the sweep', async () => {
    store = [{ id: 'a', listing_url: 'https://a.example/l', status: 'unverified' }, { id: 'b', listing_url: 'https://b.example/l', status: 'unverified' }];
    const spy = jest.spyOn(require('../services/seo/contact-finder')._internals, 'fetchPage')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p>`));
    const result = await auditor.audit();
    spy.mockRestore();
    expect(updates.map((u) => u.patch.status)).toEqual(['fetch-blocked', 'verified']);
    expect(result['fetch-blocked']).toBe(1);
  });
});

describe('getDashboard() and updateCitation()', () => {
  test('dashboard counts all five states and carries the NAP from locations.js', async () => {
    const rows = ['unverified', 'verified', 'verified', 'mismatched', 'fetch-blocked', 'missing'].map((status) => ({ status, priority: 'high' }));
    db.mockImplementation(() => ({ orderBy: () => ({ orderBy: async () => rows }) }));
    const d = await auditor.getDashboard();
    expect(d.byStatus).toEqual({ unverified: 1, verified: 2, mismatched: 1, 'fetch-blocked': 1, missing: 1 });
    expect(d.canonicalNAP).toMatchObject({ phone: BRAND.phone, address: BRAND.address, name: 'Waves Pest Control' });
    expect(d.locations.map((l) => l.id)).toEqual(WAVES_LOCATIONS.map((l) => l.id));
  });

  describe('updateCitation', () => {
    let patches;
    beforeEach(() => {
      patches = [];
      db.mockImplementation(() => ({ where: () => ({ update: async (p) => { patches.push(p); } }) }));
    });

    test('only a human can record "missing"; verified/mismatched/fetch-blocked are refused', async () => {
      await auditor.updateCitation('1', { status: 'missing' });
      expect(patches[0]).toMatchObject({ status: 'missing', status_detail: null });
      for (const status of ['verified', 'mismatched', 'fetch-blocked', 'active']) {
        await expect(auditor.updateCitation('1', { status })).rejects.toMatchObject({ code: 'INVALID_CITATION_UPDATE' });
      }
      expect(patches).toHaveLength(1);
    });

    test('changing the URL or office resets the row to unverified for the next audit', async () => {
      await auditor.updateCitation('1', { listing_url: 'https://dir.example/waves', location_id: 'parrish' });
      expect(patches[0]).toMatchObject({ listing_url: 'https://dir.example/waves', location_id: 'parrish', status: 'unverified', nap_consistent: null });
    });

    test('the fields the editor sends: URL is trimmed, blank clears it, priority is validated', async () => {
      await auditor.updateCitation('1', { listing_url: '  https://dir.example/waves  ' });
      expect(patches[0].listing_url).toBe('https://dir.example/waves');
      await auditor.updateCitation('1', { listing_url: '', location_id: '' });
      expect(patches[1]).toMatchObject({ listing_url: null, location_id: null, status: 'unverified' });
      await expect(auditor.updateCitation('1', { listing_url: 'https://a b' })).rejects.toMatchObject({ code: 'INVALID_CITATION_UPDATE' });
      await expect(auditor.updateCitation('1', { priority: 'urgent' })).rejects.toMatchObject({ code: 'INVALID_CITATION_UPDATE' });
    });

    test('rejects an unknown office and a non-http URL; ignores unknown fields', async () => {
      await expect(auditor.updateCitation('1', { location_id: 'tampa' })).rejects.toMatchObject({ code: 'INVALID_CITATION_UPDATE' });
      await expect(auditor.updateCitation('1', { listing_url: 'javascript:alert(1)' })).rejects.toMatchObject({ code: 'INVALID_CITATION_UPDATE' });
      await auditor.updateCitation('1', { priority: 'low', nap_consistent: true, directory_name: 'x' });
      expect(patches[0]).not.toHaveProperty('nap_consistent');
      expect(patches[0]).not.toHaveProperty('directory_name');
    });
  });
});
