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

const { classifyListing, candidatesFor, normalizeStreet, streetOfAddress, STATES } = auditor._internals;
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

  test('a wrong visible address next to the right name and phone is NOT verified (no JSON-LD)', () => {
    const r = classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p><p>99 Old Rd, Tampa, FL 33601</p>`), candidatesFor({}));
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatchObject({ reason: 'address_unconfirmed', seen: '99 Old Rd' });
  });

  test('a sidebar of other businesses\' addresses is not a mismatch — it stays unverified unless JSON-LD says so', () => {
    const r = classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p><aside>Nearby: 410 Main Street, Bradenton; 22 Palm Avenue, Sarasota</aside>`), candidatesFor({}));
    expect(r.status).toBe('unverified');
    expect(r.detail.reason).toBe('address_unconfirmed');
    expect(r.detail.seen).toBe('410 Main Street');
  });

  test('our address anywhere on the page confirms it even beside other addresses', () => {
    const r = classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p><aside>410 Main Street, Bradenton</aside><footer>${BRAND.address}</footer>`), candidatesFor({}));
    expect(r.status).toBe('verified');
    expect(r.detail.address_checked).toBe(true);
  });

  test('a brand row must match the address of the office whose phone matched', () => {
    const r = classifyListing(page(`<h1>Waves Pest Control</h1><p>${PARRISH.phone}</p><p>${BRAND.address}</p>`), candidatesFor({}));
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatchObject({ reason: 'address_unconfirmed', office: 'parrish' });
  });

  test('no address-like string at all: name + phone decide', () => {
    expect(classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p><p>Serving Manatee and Sarasota counties since 2019.</p>`), candidatesFor({})).status).toBe('verified');
  });

  describe('street matching is on the FULL normalized street, never a partial', () => {
    const SARASOTA = WAVES_LOCATIONS.find((l) => l.id === 'sarasota');
    const VENICE = WAVES_LOCATIONS.find((l) => l.id === 'venice');
    const forOffice = (loc, addressText) => classifyListing(page(`<h1>Waves Pest Control</h1><p>${loc.phone}</p><p>${addressText}</p>`), candidatesFor({ location_id: loc.id }));

    test('expected streets normalize to number + full name + suffix (+ directional)', () => {
      expect(WAVES_LOCATIONS.map((l) => streetOfAddress(l.address))).toEqual([
        '13649 luxe avenue', '5155 115th circle east', '1450 pine warbler place', '1978 south tamiami trail',
      ]);
      expect(normalizeStreet('1978 S. Tamiami Trl #10, Venice')).toBe('1978 south tamiami trail venice');
      expect(normalizeStreet('13649 Luxe Ave Suite 110')).toBe('13649 luxe avenue');
    });

    test('"1450 Pine Street, Tampa" is NOT confirmed against 1450 Pine Warbler PL', () => {
      const r = forOffice(SARASOTA, '1450 Pine Street, Tampa, FL');
      expect(r.status).toBe('unverified');
      expect(r.detail).toMatchObject({ reason: 'address_unconfirmed', seen: '1450 Pine Street' });
    });

    test.each(['1450 Pine Warbler Pl, Sarasota, FL 34240', '1450 PINE WARBLER PLACE', '1450 pine warbler pl.'])('%s is confirmed', (text) => {
      const r = forOffice(SARASOTA, text);
      expect(r.status).toBe('verified');
      expect(r.detail.address_checked).toBe(true);
    });

    test('a number that merely ends in ours does not confirm (11450 Pine Warbler Pl)', () => {
      expect(forOffice(SARASOTA, '11450 Pine Warbler Pl').status).toBe('unverified');
    });

    test.each(['1978 S Tamiami Trl #10', '1978 South Tamiami Trail', '1978 S. Tamiami Trail, Suite 10'])('%s matches 1978 South Tamiami Trail', (text) => {
      expect(forOffice(VENICE, text).status).toBe('verified');
    });

    test('a directional-less variant is ambiguous, so unconfirmed (never confirmed)', () => {
      expect(forOffice(VENICE, '1978 Tamiami Trail').status).toBe('unverified');
    });
  });

  describe('only the Waves JSON-LD entity is evidence', () => {
    const bizLd = (address) => ({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: BRAND.phone, address });
    const publisher = { '@type': 'Organization', name: 'Local Directory Inc', telephone: '(813) 555-0100', address: { streetAddress: '1 Directory Way', addressLocality: 'Tampa' } };
    const withLd = (graph, extra = '') => classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p>${extra}${ld({ '@graph': graph })}`), candidatesFor({}));

    test('a publisher Organization listed before our LocalBusiness causes no false mismatch', () => {
      const r = withLd([publisher, bizLd({ streetAddress: '13649 Luxe Ave #110', addressLocality: 'Bradenton' })]);
      expect(r.status).toBe('verified');
      expect(r.detail.address_checked).toBe(true);
    });

    test('the Waves entity with a wrong street is mismatched, even after a publisher node', () => {
      const r = withLd([publisher, bizLd({ streetAddress: '99 Old Rd', addressLocality: 'Tampa' })]);
      expect(r.status).toBe('mismatched');
      expect(r.detail.mismatches).toEqual([{ field: 'address', expected: BRAND.address, seen: '99 Old Rd, Tampa' }]);
    });

    test('the Waves entity is also recognised by one of our office phones alone', () => {
      const r = withLd([publisher, { '@type': 'LocalBusiness', name: 'Bradenton Office', telephone: PARRISH.phone, address: { streetAddress: '9 Wrong St' } }]);
      expect(r.status).toBe('mismatched');
      expect(r.detail.mismatches[0]).toMatchObject({ field: 'address', seen: '9 Wrong St' });
    });

    test('no Waves entity: JSON-LD contributes nothing (no address mismatch, no phone evidence)', () => {
      const r = withLd([publisher, { '@type': 'LocalBusiness', name: 'Acme Bug Co', telephone: '(941) 555-0142', address: { streetAddress: '7 Acme Blvd' } }]);
      expect(r.status).toBe('verified');
      expect(r.detail.address_checked).toBe(false);
      expect(r.nap.nap_phone).toBe(BRAND.phone);
    });

    test('a JSON-LD-only phone from another business is not our phone evidence', () => {
      const r = classifyListing(page(`<h1>Waves Pest Control</h1>${ld({ '@graph': [publisher] })}`), candidatesFor({}));
      expect(r).toMatchObject({ status: 'fetch-blocked', detail: { reason: 'phone_not_found' } });
    });
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
  const T0 = new Date('2026-09-29T12:00:00.000Z');
  const rows = (list) => list.map((r) => ({ location_id: null, updated_at: T0, ...r }));
  // In-memory seo_citations: supports just the calls the auditor makes, and evaluates the
  // conditional UPDATE's WHERE against the LIVE store so a test can edit a row mid-sweep.
  beforeEach(() => {
    updates = [];
    db.mockImplementation((table) => {
      expect(table).toBe('seo_citations');
      const filters = [];
      const q = {
        where: (o) => { filters.push((r) => Object.entries(o).every(([k, v]) => (r[k] ?? null) === (v ?? null))); return q; },
        whereNot: (col, val) => { filters.push((r) => r[col] !== val); return q; },
        whereNull: (col) => { filters.push((r) => r[col] == null); return q; },
        whereRaw: (_sql, [ms]) => { filters.push((r) => r.updated_at != null && Math.abs(new Date(r.updated_at).getTime() - ms) < 1); return q; },
        then: (resolve, reject) => Promise.resolve(store.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }))).then(resolve, reject),
        update: async (patch) => {
          const hit = store.filter((r) => filters.every((f) => f(r)));
          hit.forEach((r) => { updates.push({ id: r.id, patch }); Object.assign(r, patch); });
          return hit.length;
        },
      };
      return q;
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
    store = rows([
      { id: 'ok', listing_url: 'https://ok.example/l', location_id: 'venice', status: 'unverified' },
      { id: 'bad', listing_url: 'https://bad.example/l', status: 'unverified' },
      { id: 'yelp', listing_url: 'https://yelp.example/l', status: 'unverified' },
      { id: 'redir', listing_url: 'https://redir.example/l', status: 'active' },
      { id: 'inner', listing_url: 'https://inner.example/l', status: 'unchecked' },
      { id: 'none', listing_url: null, status: 'unchecked' },
      { id: 'human', listing_url: 'https://human.example/l', status: 'missing' },
    ]);
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
    expect(result).toEqual({ total: 6, skipped: 0, unverified: 1, verified: 1, mismatched: 1, 'fetch-blocked': 3, missing: 0 });
  });

  test('a throwing check lands fetch-blocked and does not stop the sweep', async () => {
    store = rows([{ id: 'a', listing_url: 'https://a.example/l', status: 'unverified' }, { id: 'b', listing_url: 'https://b.example/l', status: 'unverified' }]);
    const spy = jest.spyOn(require('../services/seo/contact-finder')._internals, 'fetchPage')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p>`));
    const result = await auditor.audit();
    spy.mockRestore();
    expect(updates.map((u) => u.patch.status)).toEqual(['fetch-blocked', 'verified']);
    expect(result['fetch-blocked']).toBe(1);
  });

  describe('a staff edit made between the read and the write wins', () => {
    const goodPage = `<h1>Waves Pest Control</h1><p>${BRAND.phone}</p>`;
    const run = async (edit) => {
      store = rows([{ id: 'r', listing_url: 'https://old.example/l', status: 'unverified' }]);
      const fetchOld = async () => {
        edit(store[0]); // staff act while the fetch is in flight
        return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => `<html><head><title>x</title></head><body>${goodPage}${filler}</body></html>` };
      };
      const result = await auditor.audit({ fetchFn: fetchOld, resolveHostFn: async () => true });
      return { result, row: store[0] };
    };

    test.each([
      ['marked missing', (r) => { r.status = 'missing'; r.updated_at = new Date(T0.getTime() + 5000); }],
      ['URL changed', (r) => { r.listing_url = 'https://new.example/l'; r.status = 'unverified'; r.updated_at = new Date(T0.getTime() + 5000); }],
      ['office changed', (r) => { r.location_id = 'venice'; r.updated_at = new Date(T0.getTime() + 5000); }],
      ['any edit that only moves updated_at', (r) => { r.updated_at = new Date(T0.getTime() + 5000); }],
    ])('%s: the stale result is discarded, not written over it', async (_label, edit) => {
      const { result, row } = await run(edit);
      expect(updates).toEqual([]);
      expect(row.status).not.toBe('verified');
      expect(result).toMatchObject({ total: 0, skipped: 1 });
      expect(require('../services/logger').warn).toHaveBeenCalledWith(expect.stringContaining('changed during the sweep'));
    });

    test('an untouched row is written, matching a microsecond-precision updated_at within a millisecond', async () => {
      const { result, row } = await run((r) => { r.updated_at = new Date(T0.getTime() + 0.4); });
      expect(row.status).toBe('verified');
      expect(result).toMatchObject({ total: 1, skipped: 0, verified: 1 });
    });
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
      expect(patches[0].updated_at).toBeInstanceOf(Date); // the sweep's conditional write keys on it
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
