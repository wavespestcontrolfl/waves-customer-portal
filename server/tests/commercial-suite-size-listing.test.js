/**
 * Listing suite size (address-match PR 5b, GATE_LOOKUP_LISTING_SIZE): plain
 * code reads a size for THIS suite off search-result snippets and fetchable
 * pages; LoopNet / Crexi pages are never fetched; a neighbor's suite, a range,
 * a conflict, the gate off and a missing street number all yield nothing.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { resolveViaListing, SOURCE, _private: P } = require('../services/commercial-suite-size/listing-size');

const ADDRESS = { street: '14617 SR 70 E', unit: '103', city: 'Bradenton', zip: '34202' };
const savedGate = process.env.GATE_LOOKUP_LISTING_SIZE;

function serpWith(items) {
  return jest.fn(async () => ({ tasks: [{ result: [{ items }] }] }));
}
const organic = (url, title, description) => ({ type: 'organic', url, title, description });

beforeEach(() => { process.env.GATE_LOOKUP_LISTING_SIZE = 'true'; });
afterEach(() => {
  if (savedGate === undefined) delete process.env.GATE_LOOKUP_LISTING_SIZE; else process.env.GATE_LOOKUP_LISTING_SIZE = savedGate;
});

describe('extractSuiteSizes — a figure counts only beside THIS suite', () => {
  const a = P.addressAnchors(ADDRESS);
  test('route roads anchor on the route number; the suite\'s own figure is read, the neighbor\'s is not', () => {
    expect(a.streetWord).toBe('70');
    expect(P.extractSuiteSizes('14617 SR 70 E, Bradenton, FL 34202 - Retail for Lease | LoopNet. Suite 103 … 1,350 SF available; Suite 105 2,000 SF', a)).toEqual([1350]);
    expect(P.extractSuiteSizes('14617 State Road 70 E Suite 103 Bradenton FL — 1,350 sq ft', a)).toEqual([1350]);
    expect(P.extractSuiteSizes('Ste. 103, 14617 FL-70 E: 1,350 SF retail', a)).toEqual([1350]);
  });
  test('a range, another street number, a missing suite mention, or an implausible figure never count', () => {
    expect(P.extractSuiteSizes('14617 SR 70 E Bradenton retail 1,200 - 2,400 SF suite 103', a)).toEqual([]);
    expect(P.extractSuiteSizes('14617 SR 70 E Bradenton retail suite 103 1,200–2,400 SF', a)).toEqual([]);
    // Units on both endpoints: neither endpoint is the suite's size.
    expect(P.extractSuiteSizes('14617 SR 70 E Suite 103 1,200 SF - 2,400 SF', a)).toEqual([]);
    expect(P.extractSuiteSizes('14617 SR 70 E Suite 103 1,200 sq ft to 2,400 sq ft', a)).toEqual([]);
    expect(P.extractSuiteSizes('14617 SR 70 E Suite 103: 1,200 SF TO 2,400 SF', a)).toEqual([]);
    expect(P.extractSuiteSizes('14617 SR 70 E Suite 103: 1,200 SF To 2,400 SF', a)).toEqual([]);
    // A bound or an estimate is not the area; a split digit group is not a figure.
    expect(P.extractSuiteSizes('14617 SR 70 E Suite 103: up to 2,400 SF', a)).toEqual([]);
    expect(P.extractSuiteSizes('14617 SR 70 E Suite 103: from 1,350 SF', a)).toEqual([]);
    expect(P.extractSuiteSizes('14617 SR 70 E Suite 103: approx. 1,350 SF', a)).toEqual([]);
    expect(P.extractSuiteSizes('14617 SR 70 E Suite 103: 1&nbsp;350 SF', a)).toEqual([1350]);
    expect(P.extractSuiteSizes('14619 SR 70 E Suite 103: 1,350 SF', a)).toEqual([]);
    expect(P.extractSuiteSizes('14617 SR 70 E Bradenton plaza 1,350 SF available', a)).toEqual([]);
    expect(P.extractSuiteSizes('14617 SR 70 E Suite 103: 90 SF', a)).toEqual([]);
    expect(P.extractSuiteSizes('14617 SR 70 E Suite 103: 250,000 SF', a)).toEqual([]);
  });
  test('the figure must follow THIS property\'s address block: another property\'s suite 103 on the same page never counts', () => {
    expect(P.extractSuiteSizes('14617 SR 70 E. Other properties: 9900 Other Street Suite 103 2,000 SF', a)).toEqual([]);
    expect(P.extractSuiteSizes('Suite 103 1,350 SF … 14617 SR 70 E', a)).toEqual([]); // address only after the figure
    expect(P.extractSuiteSizes('14617 SR 70 E, Bradenton. Suite 101 1,800 SF. Suite 103 1,350 SF. 9900 Other St Suite 103 2,000 SF', a)).toEqual([1350]);
    expect(P.extractSuiteSizes(`14617 SR 70 E ${'plaza '.repeat(90)}Suite 103 1,350 SF`, a)).toEqual([]); // beyond reach
    // Ownership is judged inside the figure's own block: a neighbor's figure after a rejected range is the neighbor's.
    const st = P.addressAnchors({ street: '4400 Test St', unit: '103', city: 'Bradenton' });
    expect(P.extractSuiteSizes('4400 Test St Suite 103: 1,200 SF to 2,400 SF; 3,000 SF Suite 105', st)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test St Suite 103: 1,350 SF; 3,000 SF Suite 105', st)).toEqual([1350]);
    // A block naming two suites is nobody's.
    expect(P.extractSuiteSizes('4400 Test St Suite 103 and Suite 105 share 3,000 SF', st)).toEqual([]);
    // List items and table cells are their own blocks.
    expect(P.extractSuiteSizes('<ul><li>4400 Test St</li><li>Suite 101 — 1,800 SF</li><li>Suite 103 — 1,350 SF</li></ul>', st)).toEqual([1350]);
    // The same number on another street, with this street named elsewhere: not this address.
    const c = P.addressAnchors({ street: '4400 Test Commons Pkwy', unit: '103', city: 'Bradenton' });
    expect(P.extractSuiteSizes('4400 Other Street Suite 103 2,000 SF. Also available on Test Commons Pkwy.', c)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103 2,000 SF', c)).toEqual([2000]);
    // The whole street must match, suffix spelling aside; another ZIP with no mention of ours is another locality.
    expect(P.extractSuiteSizes('4400 Test Avenue, Sarasota FL Suite 103 2,000 SF', c)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Parkway, Bradenton FL 34202 — Suite 103 2,000 SF', c)).toEqual([2000]);
    const z = P.addressAnchors({ street: '4400 Test Commons Pkwy', unit: '103', city: 'Bradenton', zip: '34202' });
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy, Bradenton FL 34205 Suite 103 2,000 SF', z)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy, Bradenton FL 34202 Suite 103 2,000 SF', z)).toEqual([2000]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy, Bradenton FL 34205-1234 Suite 103 2,000 SF', z)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy, Bradenton FL 34202-1234 Suite 103 2,000 SF', z)).toEqual([2000]);
    // The ZIP is judged on the figure's own anchoring block, not the page.
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Bradenton FL 34202. Other properties: 4400 Test Commons Pkwy Sarasota FL 34205 Suite 103 2,000 SF', z)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103 2,000 SF, Tampa FL 33602', z)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103 2,000 SF, Bradenton FL 34202', z)).toEqual([2000]);
    // A bare five-digit figure is a size, not a ZIP; this number on another street in between is another address.
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103 12000 SF', z)).toEqual([12000]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy. 4400 Other Street Suite 103 2,000 SF', c)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy. 4400 Test Commons Pkwy Suite 103 2,000 SF', c)).toEqual([2000]);
    // A numbered street in between is another address too.
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy. Other properties: 9900 51st St Suite 103 2,000 SF', c)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy. Other properties: 9900 9th Ave E Suite 103 2,000 SF', c)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy. Other properties: 9900 N Other St Suite 103 2,000 SF', c)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy. Other properties: 1 Main Street Suite 103 2,000 SF', c)).toEqual([]);
    // A stated direction must be the typed one; an omitted one is fine.
    const e = P.addressAnchors({ street: '4400 Test St E', unit: '103', city: 'Bradenton' });
    expect(P.extractSuiteSizes('4400 Test St W Suite 103 2,000 SF', e)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test St Suite 103 2,000 SF', e)).toEqual([2000]);
    expect(P.extractSuiteSizes('4400 Test St E Suite 103 2,000 SF', e)).toEqual([2000]);
    const noDir = P.addressAnchors({ street: '4400 Test St', unit: '103', city: 'Bradenton' });
    expect(P.extractSuiteSizes('4400 Test St W Suite 103 2,000 SF', noDir)).toEqual([]);
    // The street words must be contiguous after the number.
    expect(P.extractSuiteSizes('4400 Test Other St Suite 103 2,000 SF', noDir)).toEqual([]);
    expect(P.extractSuiteSizes('4400 N Test St Suite 103 2,000 SF', noDir)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Street, Suite 103 2,000 SF', noDir)).toEqual([2000]);
    // A combined suite's figure is the combined area, never one suite's.
    expect(P.extractSuiteSizes('4400 Test St E Suite 103/104: 3,000 SF', e)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test St E Suites 103 & 104 — 3,000 SF', e)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test St E Suite 103-104 3,000 SF', e)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test St E Suite 103 and 104 3,000 SF', e)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test St E Suites 103, 104: 3,000 SF', e)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test St E Suite 103 + 104: 3,000 SF', e)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test St E Suite 103/104: 3,000 SF; Suite 103 alone: 1,350 SF', e)).toEqual([1350]);
    // A dash before the figure is a separator, not a combined suite.
    expect(P.extractSuiteSizes('4400 Test St E Suite 103 - 1,350 SF', e)).toEqual([1350]);
    expect(P.extractSuiteSizes('4400 Test St E Suite 103 – 1,350 SF', e)).toEqual([1350]);
    expect(P.extractSuiteSizes('4400 Test St E Suite 103-1350 SF', e)).toEqual([1350]);
    expect(P.extractSuiteSizes('4400 Test St E Suite 103-104 1,350 SF', e)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test St E Suites 103—104: 3,000 SF', e)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test St E Suites 103 to 104: 3,000 SF', e)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test St E Suite 103 — 1,350 SF', e)).toEqual([1350]);
    // A building, lot or site total is never the suite's size.
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103. Building Size 25,000 SF.', c)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103 — 25,000 SF total building area', c)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103 — 1,350 SF retail space', c)).toEqual([1350]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy, Oak Plaza Suite 103 — 1,350 SF retail space in a plaza', c)).toEqual([1350]);
    // Prose about the surroundings is a total, not the suite.
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103 is located in a 25,000 SF shopping center', c)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103, part of a 60,000 SF retail center', c)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103 within the 25,000 SF plaza', c)).toEqual([]);
    // However many modifiers precede the center noun.
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103 at Oak Plaza — 25,000 SF grocery anchored neighborhood shopping center', c)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103 — 1,350 SF available now', c)).toEqual([1350]);
    // An approximation mark between the number and the unit is an estimate.
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103 1,350 ± SF', c)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103 1,350 +/- SF', c)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103 1,350+ SF', c)).toEqual([]);
    // The same qualifiers after the figure.
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103: 1,350 SF (approx.)', c)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103: 1,350 SF +/-', c)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103: 1,350 SF minimum', c)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103: 1,350 SF or more', c)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103. Total 25,000 SF plaza; Suite 103 1,350 SF', c)).toEqual([1350]);
  });

  test('with no suite typed there is no listing size at all, with or without a business name', () => {
    const b = P.addressAnchors({ street: '5805 Gentle Current Wy', city: 'Parrish' });
    expect(b.streetWord).toBe('Gentle');
    expect(P.extractSuiteSizes('5805 Gentle Current Way, Parrish FL — 2,314 sq ft', b)).toEqual([]);
    const c = P.addressAnchors({ street: '4400 Test Commons Pkwy', city: 'Bradenton' });
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy. Example Salon, Suite 105 — 2,000 SF', c)).toEqual([]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy. Cavalli Pizza — 2,000 SF retail space', c)).toEqual([]);
    expect(P.addressAnchors({ street: 'Gentle Current Wy' })).toBeNull();
  });

  test('settleSizes: agreeing figures are one size, differing ones are a conflict', () => {
    expect(P.settleSizes([{ value: 1350, url: 'a' }, { value: 1400, url: 'b' }])).toEqual({ value: 1350, url: 'a', count: 2 });
    expect(P.settleSizes([{ value: 1350, url: 'a' }, { value: 2000, url: 'b' }])).toEqual({ conflict: 2 });
    expect(P.settleSizes([])).toBeNull();
  });
  test('queries quote the street number and the suite, leave the street spelling open, and target the listing sites first', () => {
    const q = P.buildQueries(a);
    expect(q[0]).toBe('"14617" SR 70 E "suite 103" Bradenton FL site:loopnet.com');
    expect(q[1]).toContain('site:crexi.com');
    expect(q[2]).not.toContain('site:');
  });
});

describe('defaultFetchText — untrusted search-result URLs', () => {
  const html = (body, headers = {}) => ({ status: 200, headers: { get: (n) => ({ 'content-type': 'text/html; charset=utf-8', ...headers })[n.toLowerCase()] ?? null }, text: async () => body, truncated: false });

  test('refuses non-http(s) and credentialed URLs before any request, and hands http(s) to the pinned fetcher', async () => {
    const fetchImpl = jest.fn(async () => html('<p>14617 SR 70 E Suite 103 1,350 SF</p>'));
    expect(await P.defaultFetchText('ftp://broker.example/x', 1000, { fetchImpl })).toBeNull();
    expect(await P.defaultFetchText('file:///etc/passwd', 1000, { fetchImpl })).toBeNull();
    expect(await P.defaultFetchText('https://user:pw@broker.example/x', 1000, { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await P.defaultFetchText('https://broker.example/x', 1000, { fetchImpl })).toContain('1,350 SF');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ maxBytes: expect.any(Number), headers: expect.any(Object) });
    expect(fetchImpl.mock.calls[0][1].signal).toBeDefined();
  });

  test('follows one redirect only, through the same validation; non-HTML, truncated and error responses read as nothing', async () => {
    const redirect = (to) => ({ status: 302, headers: { get: (n) => (n.toLowerCase() === 'location' ? to : null) }, text: async () => '', truncated: false });
    const once = jest.fn()
      .mockResolvedValueOnce(redirect('/final'))
      .mockResolvedValueOnce(html('<p>ok 14617</p>'));
    expect(await P.defaultFetchText('https://broker.example/x', 1000, { fetchImpl: once })).toContain('ok');
    expect(once.mock.calls[1][0]).toBe('https://broker.example/final');
    const twice = jest.fn().mockResolvedValue(redirect('https://broker.example/again'));
    expect(await P.defaultFetchText('https://broker.example/x', 1000, { fetchImpl: twice })).toBeNull();
    expect(twice).toHaveBeenCalledTimes(2);
    expect(await P.defaultFetchText('https://broker.example/x', 1000, { fetchImpl: async () => html('%PDF', { 'content-type': 'application/pdf' }) })).toBeNull();
    expect(await P.defaultFetchText('https://broker.example/x', 1000, { fetchImpl: async () => ({ ...html('x'), truncated: true }) })).toBeNull();
    expect(await P.defaultFetchText('https://broker.example/x', 1000, { fetchImpl: async () => ({ ...html('x'), status: 403 }) })).toBeNull();
  });

  test('private IP literals, localhost, intranet names and a redirect to any of them are refused before a request is made', async () => {
    const fetchImpl = jest.fn(async () => html('<p>never</p>'));
    for (const u of ['http://127.0.0.1/x', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'http://[::1]/', 'http://localhost/x', 'http://intranet/x']) {
      expect(await P.defaultFetchText(u, 1000, { fetchImpl })).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    const redirectToMeta = jest.fn(async () => ({ status: 302, headers: { get: (n) => (n.toLowerCase() === 'location' ? 'http://169.254.169.254/latest/' : null) }, text: async () => '', truncated: false }));
    expect(await P.defaultFetchText('https://broker.example/x', 1000, { fetchImpl: redirectToMeta })).toBeNull();
    expect(redirectToMeta).toHaveBeenCalledTimes(1);
    expect(redirectToMeta.mock.calls[0][0]).toBe('https://broker.example/x');
  });
});

describe('the production address parser\'s unit form', () => {
  const { suiteAddressParts } = require('../services/commercial-suite-size/address-parts');
  test('"Suite 103", "#12b", "Unit B" compare on the value alone and query once', () => {
    const a = P.addressAnchors(suiteAddressParts('14617 SR 70 E Suite 103, Bradenton, FL 34202'));
    expect(a.unit).toBe('103');
    expect(P.buildQueries(a)[0]).toContain('"suite 103"');
    expect(P.buildQueries(a)[0]).not.toMatch(/suite suite/i);
    expect(P.extractSuiteSizes('14617 SR 70 E, Bradenton, FL 34202. Suite 103 — 1,350 SF; Suite 105 2,000 SF', a)).toEqual([1350]);
    expect(P.addressAnchors(suiteAddressParts('4400 Test Commons Pkwy #12B, Bradenton, FL 34202')).unit).toBe('12B');
    const b = P.addressAnchors(suiteAddressParts('4400 Test Commons Pkwy Unit B, Bradenton, FL 34202'));
    expect(b.unit).toBe('B');
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy, Unit B — 1,100 SF', b)).toEqual([1100]);
  });

  test('a typed combined unit matches only the same combination, never one of its suites', () => {
    const combo = P.addressAnchors(suiteAddressParts('4400 Test Commons Pkwy Ste 103-104, Bradenton, FL'));
    expect(combo.unit).toBe('103-104');
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103-104: 3,000 SF', combo)).toEqual([3000]);
    expect(P.extractSuiteSizes('4400 Test Commons Pkwy Suite 103: 1,350 SF', combo)).toEqual([]);
  });
});

describe('resolveViaListing', () => {
  test('reads a LoopNet snippet without ever fetching LoopNet, and returns the listing source with the link', async () => {
    const serp = serpWith([
      organic('https://www.loopnet.com/Listing/14617-SR-70-E-Bradenton-FL/123/', '14617 SR 70 E, Bradenton, FL 34202 - Retail for Lease', 'Suite 103 — 1,350 SF retail space in a plaza, available now.'),
      organic('https://www.google.com/maps/place/x', 'map', 'Suite 103 9,999 SF'),
    ]);
    const fetchText = jest.fn(async () => { throw new Error('must not fetch'); });
    const out = await resolveViaListing({ address: ADDRESS }, { serp, fetchText });
    expect(out).toMatchObject({ value: 1350, source: SOURCE, confidence: 'medium', url: 'https://www.loopnet.com/Listing/14617-SR-70-E-Bradenton-FL/123/' });
    expect(out.evidence[0]).toMatchObject({ source: SOURCE, url: out.url });
    expect(out.evidence[0].detail).toContain('suite 103');
    expect(out.evidence[0].detail).toContain('1,350 sq ft');
    expect(fetchText).not.toHaveBeenCalled();
    // The open query is not spent once a listing site answered.
    expect(serp).toHaveBeenCalledTimes(2);
    // Every vendor call carries an abort signal tied to the leg's deadline.
    expect(serp.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  test('a vendor call still running at the deadline is aborted, and the leg returns nothing', async () => {
    let seen = null;
    const serp = jest.fn((q, { signal }) => new Promise((resolve) => { seen = signal; signal.addEventListener('abort', () => resolve(null)); }));
    const out = await resolveViaListing({ address: ADDRESS }, { serp, fetchText: jest.fn(), timeoutMs: 1600 });
    expect(out).toBeNull();
    expect(seen.aborted).toBe(true);
  });

  test('fetches a broker page (HTML only, bounded) when the listing sites have nothing, and reads the suite there', async () => {
    const serp = jest.fn(async (q) => (q.includes('site:') ? { tasks: [{ result: [{ items: [] }] }] }
      : { tasks: [{ result: [{ items: [organic('https://broker.example/plaza', 'Plaza leasing', 'Retail suites available at 14617 SR 70 E')] }] }] }));
    const fetchText = jest.fn(async () => '<html><body><h1>14617 SR 70 E</h1><ul><li>Suite 101 &mdash; 1,800 SF</li><li>Suite 103 &mdash; 1,350 SF</li></ul></body></html>');
    const out = await resolveViaListing({ address: ADDRESS }, { serp, fetchText });
    expect(out).toMatchObject({ value: 1350, url: 'https://broker.example/plaza' });
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(fetchText.mock.calls[0][0]).toBe('https://broker.example/plaza');
    expect(serp).toHaveBeenCalledTimes(3);
  });

  test('two different sizes for the same suite are a conflict: no size', async () => {
    const serp = serpWith([
      organic('https://www.loopnet.com/a', '14617 SR 70 E Bradenton', 'Suite 103 1,350 SF'),
      organic('https://www.crexi.com/b', '14617 SR 70 E Bradenton', 'Suite 103 2,200 SF'),
    ]);
    expect(await resolveViaListing({ address: ADDRESS }, { serp, fetchText: jest.fn() })).toBeNull();
  });

  test('no suite typed: no search at all', async () => {
    const serp = serpWith([organic('https://www.loopnet.com/a', '14617 SR 70 E', 'Example Salon 1,350 SF')]);
    expect(await resolveViaListing({ address: { ...ADDRESS, unit: null }, businessNameHint: 'Example Salon' }, { serp, fetchText: jest.fn() })).toBeNull();
    expect(serp).not.toHaveBeenCalled();
  });

  test('gate off, no street number, a vendor failure, or no budget: null with no search and no fetch', async () => {
    const serp = serpWith([organic('https://www.loopnet.com/a', '14617 SR 70 E', 'Suite 103 1,350 SF')]);
    const fetchText = jest.fn();
    delete process.env.GATE_LOOKUP_LISTING_SIZE;
    expect(await resolveViaListing({ address: ADDRESS }, { serp, fetchText })).toBeNull();
    expect(serp).not.toHaveBeenCalled();
    process.env.GATE_LOOKUP_LISTING_SIZE = 'true';
    expect(await resolveViaListing({ address: { street: 'SR 70 E', unit: '103' } }, { serp, fetchText })).toBeNull();
    expect(serp).not.toHaveBeenCalled();
    const failing = jest.fn(async () => { throw new Error('vendor down'); });
    expect(await resolveViaListing({ address: ADDRESS }, { serp: failing, fetchText })).toBeNull();
    expect(await resolveViaListing({ address: ADDRESS }, { serp, fetchText, deadlineAt: Date.now() + 500 })).toBeNull();
    expect(fetchText).not.toHaveBeenCalled();
  });
});
