const { findContact, _internals } = require('../services/seo/contact-finder');

function mockFetch(map) {
  return async (url) => {
    const html = map[url];
    if (html === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => html };
  };
}

describe('fetchPage DNS preflight', () => {
  test('a host lookup that never answers is bounded by the fetch timeout → dns_error, the fetch never starts (hung investigator sweep 2026-09-02)', async () => {
    const { fetchPage } = require('../services/seo/contact-finder');
    const fetchFn = jest.fn();
    const started = Date.now();
    const r = await fetchPage('https://slow-dns.example/join', { fetchFn, timeoutMs: 50, resolveHostFn: () => new Promise(() => {}) });
    expect(r).toMatchObject({ status: 0, blocked: false, error: 'dns_error', html: null });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('a lookup that rejects is dns_error too, and a fast public answer still fetches', async () => {
    const { fetchPage } = require('../services/seo/contact-finder');
    const rejecting = await fetchPage('https://x.example/', { fetchFn: jest.fn(), timeoutMs: 50, resolveHostFn: async () => { throw new Error('EAI_AGAIN'); } });
    expect(rejecting.error).toBe('dns_error');
    const fetchFn = jest.fn(async () => ({ status: 200, headers: { get: (n) => (n === 'content-type' ? 'text/html' : null) }, body: null, text: async () => '<html>ok</html>' }));
    const ok = await fetchPage('https://x.example/', { fetchFn, timeoutMs: 500, resolveHostFn: async () => true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(ok.status).toBe(200);
  });
});

describe('contact-finder', () => {
  test('extracts a mailto email from the homepage and marks contactable', async () => {
    const fetchFn = mockFetch({
      'https://news.com/': '<a href="mailto:editor@news.com">email us</a>',
    });
    const r = await findContact('news.com', { fetchFn, resolveHostFn: async () => true });
    expect(r.contact_email).toBe('editor@news.com');
    expect(r.has_contact_path).toBe(true);
    expect(r.contact_url).toBe('https://news.com/');
  });

  test('prefers an on-domain role inbox over a personal one', async () => {
    const fetchFn = mockFetch({
      'https://x.com/': 'reach jdoe@x.com or editor@x.com anytime',
    });
    const r = await findContact('x.com', { fetchFn, resolveHostFn: async () => true });
    expect(r.contact_email).toBe('editor@x.com');
  });

  test('falls back to a contact FORM when no email is exposed', async () => {
    const fetchFn = mockFetch({
      'https://site.com/': '<p>no email here</p>',
      'https://site.com/contact': '<form action="/send"><input name="email"></form>',
    });
    const r = await findContact('site.com', { fetchFn, resolveHostFn: async () => true });
    expect(r.contact_email).toBeNull();
    expect(r.has_contact_path).toBe(true);
    expect(r.contact_url).toBe('https://site.com/contact');
  });

  test('a "write for us" page persists a reachable contact_url even without an email', async () => {
    const fetchFn = mockFetch({
      'https://blog.com/': '<p>home</p>',
      'https://blog.com/contact': '<p>no form, no email</p>',
      'https://blog.com/write-for-us': '<h1>Write for us</h1><p>pitch your guest post</p>',
    });
    const r = await findContact('blog.com', { fetchFn, resolveHostFn: async () => true });
    expect(r.has_contact_path).toBe(true);
    expect(r.contributor_path).toBe('https://blog.com/write-for-us');
    expect(r.contact_url).toBe('https://blog.com/write-for-us'); // worker has something to act on
  });

  test('no contact path → has_contact_path false (the gate trips)', async () => {
    const fetchFn = mockFetch({ 'https://dead.com/': '<p>nothing useful</p>' });
    const r = await findContact('dead.com', { fetchFn, resolveHostFn: async () => true });
    expect(r.has_contact_path).toBe(false);
    expect(r.contact_email).toBeNull();
  });

  test('never throws when fetch rejects', async () => {
    const fetchFn = async () => { throw new Error('ECONNRESET'); };
    const r = await findContact('flaky.com', { fetchFn, resolveHostFn: async () => true });
    expect(r.has_contact_path).toBe(false);
    expect(r.domain).toBe('flaky.com');
  });

  test('ignores asset/placeholder junk that looks like an email', async () => {
    const fetchFn = mockFetch({ 'https://img.com/': 'logo sprite-2x@2x.png and noreply@img.com' });
    const r = await findContact('img.com', { fetchFn, resolveHostFn: async () => true });
    expect(r.contact_email).toBeNull(); // no-reply + .png filtered
  });

  test('normalizes www + scheme', () => {
    expect(_internals.normalizeDomain('https://www.Foo.com/path')).toBe('foo.com');
  });

  test('SSRF: blocks localhost / private IP / metadata host without fetching', async () => {
    let called = false;
    const fetchFn = async () => { called = true; return { ok: true, text: async () => 'x' }; };
    for (const bad of ['localhost', '127.0.0.1', '10.0.0.5', '169.254.169.254', 'router.internal']) {
      const r = await findContact(bad, { fetchFn });
      expect(r.has_contact_path).toBe(false);
    }
    expect(called).toBe(false); // never issued a request to an internal host
  });

  test('SSRF: a redirect to a private host is not followed', async () => {
    const fetchFn = async () => ({ status: 302, ok: false, headers: { get: () => 'http://169.254.169.254/latest/meta-data' }, text: async () => '' });
    const r = await findContact('news.com', { fetchFn, resolveHostFn: async (h) => h === 'news.com' });
    expect(r.has_contact_path).toBe(false); // redirect target rejected
  });

  test('isBlockedHostname classifies hosts', () => {
    expect(_internals.isBlockedHostname('localhost')).toBe(true);
    expect(_internals.isBlockedHostname('10.1.2.3')).toBe(true);
    expect(_internals.isBlockedHostname('8.8.8.8')).toBe(false);
    expect(_internals.isBlockedHostname('example.com')).toBe(false);
  });

  test('isPrivateIp catches IPv4-mapped IPv6 in BOTH dotted and hex forms', () => {
    const p = _internals.isPrivateIp;
    expect(p('::ffff:127.0.0.1')).toBe(true);          // dotted loopback
    expect(p('::ffff:7f00:1')).toBe(true);             // hex loopback (127.0.0.1)
    expect(p('::ffff:a9fe:a9fe')).toBe(true);          // hex metadata (169.254.169.254)
    expect(p('0:0:0:0:0:ffff:7f00:1')).toBe(true);     // expanded hex loopback
    expect(p('::1')).toBe(true);
    expect(p('::ffff:808:808')).toBe(false);           // 8.8.8.8 — public
    expect(p('2606:4700:4700::1111')).toBe(false);     // public v6
  });

  test('isPrivateIp blocks the full fe80::/10 link-local range', () => {
    const p = _internals.isPrivateIp;
    expect(p('fe80::1')).toBe(true);
    expect(p('fe90::1')).toBe(true);
    expect(p('fea0::1')).toBe(true);
    expect(p('febf::1')).toBe(true);
    expect(p('fec0::1')).toBe(false); // outside link-local
  });
});

describe('fetchPage finalUrl / resolveOnly (step-2 resolver contract)', () => {
  const { fetchPage } = _internals;
  const okRes = (html, extra = {}) => ({ ok: true, status: 200, headers: { get: (k) => (k === 'content-type' ? 'text/html' : null) }, text: async () => html, ...extra });
  const redirectTo = (loc) => ({ ok: false, status: 301, headers: { get: (k) => (k === 'location' ? loc : null) }, text: async () => '' });

  test('direct 200 → finalUrl is the request URL, redirectHops 0', async () => {
    const fetchFn = async () => okRes('<p>hi</p>');
    const r = await fetchPage('https://news.com/page', { fetchFn, resolveHostFn: async () => true });
    expect(r).toEqual({ status: 200, finalUrl: 'https://news.com/page', redirectHops: 0, html: '<p>hi</p>', blocked: false, truncated: false, contentType: 'text/html', error: null });
  });

  test('two redirects → finalUrl is the LAST hop, redirectHops 2, body from the last hop', async () => {
    const seen = [];
    const fetchFn = async (url) => {
      seen.push(url);
      if (url === 'https://t.co/abc') return redirectTo('https://short.io/x');
      if (url === 'https://short.io/x') return redirectTo('/final?ok=1'); // relative → resolved against the hop
      return okRes('<p>final</p>');
    };
    const r = await fetchPage('https://t.co/abc', { fetchFn, resolveHostFn: async () => true });
    expect(seen).toEqual(['https://t.co/abc', 'https://short.io/x', 'https://short.io/final?ok=1']);
    expect(r.finalUrl).toBe('https://short.io/final?ok=1');
    expect(r.redirectHops).toBe(2);
    expect(r.status).toBe(200);
    expect(r.html).toBe('<p>final</p>');
  });

  test('blocked hop mid-chain → finalUrl null, blocked true, the private host is never fetched', async () => {
    const seen = [];
    const fetchFn = async (url) => { seen.push(url); return redirectTo('http://169.254.169.254/latest/meta-data'); };
    const r = await fetchPage('https://news.com/', { fetchFn, resolveHostFn: async (h) => h === 'news.com' });
    expect(seen).toEqual(['https://news.com/']);
    expect(r.finalUrl).toBeNull();
    expect(r.blocked).toBe(true);
    expect(r.error).toBe('blocked_host');
    expect(r.redirectHops).toBe(1);
  });

  test('resolveOnly: returns status + finalUrl with html null and never calls res.text()', async () => {
    let textCalls = 0;
    let cancelled = false;
    const fetchFn = async (url, opts) => {
      expect(opts.resolveOnly).toBe(true);
      if (url === 'https://t.co/abc') return redirectTo('https://blog.example.com/post');
      return okRes('<p>never read</p>', { text: async () => { textCalls++; return '<p>never read</p>'; }, body: { cancel: async () => { cancelled = true; } } });
    };
    const r = await fetchPage('https://t.co/abc', { fetchFn, resolveHostFn: async () => true, resolveOnly: true });
    expect(r).toEqual({ status: 200, finalUrl: 'https://blog.example.com/post', redirectHops: 1, html: null, blocked: false, truncated: false, contentType: 'text/html', error: null });
    expect(textCalls).toBe(0);
    expect(cancelled).toBe(true);
  });

  test('a failed DNS lookup is dns_error (retryable), never the blocked_host private-address verdict', async () => {
    const fetchFn = jest.fn();
    const r = await fetchPage('https://flaky-dns.example/', { fetchFn, resolveHostFn: async () => null, resolveOnly: true });
    expect(r).toEqual(expect.objectContaining({ status: 0, finalUrl: null, blocked: false, error: 'dns_error' }));
    expect(fetchFn).not.toHaveBeenCalled();
    const b = await fetchPage('https://intranet.example/', { fetchFn, resolveHostFn: async () => false, resolveOnly: true });
    expect(b).toEqual(expect.objectContaining({ blocked: true, error: 'blocked_host' }));
  });

  test('resolveOnly: a 404 at the final URL still resolves (finalUrl set, status 404)', async () => {
    const fetchFn = async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => { throw new Error('must not read body'); } });
    const r = await fetchPage('https://gone.example.com/old', { fetchFn, resolveHostFn: async () => true, resolveOnly: true });
    expect(r.status).toBe(404);
    expect(r.finalUrl).toBe('https://gone.example.com/old');
    expect(r.html).toBeNull();
    expect(r.error).toBeNull();
  });

  test('resolveOnly: a fetcher whose body cancel throws still resolves cleanly', async () => {
    const fetchFn = async () => okRes('', { body: { cancel: async () => { throw new Error('stream already closed'); } } });
    const r = await fetchPage('https://news.com/', { fetchFn, resolveHostFn: async () => true, resolveOnly: true });
    expect(r.finalUrl).toBe('https://news.com/');
    expect(r.error).toBeNull();
  });

  test('redirect_budget_exhausted → finalUrl null, redirectHops = maxRedirects + 1', async () => {
    let n = 0;
    const fetchFn = async () => redirectTo(`https://loop.example.com/${++n}`);
    const r = await fetchPage('https://loop.example.com/0', { fetchFn, resolveHostFn: async () => true, maxRedirects: 2 });
    expect(r.error).toBe('redirect_budget_exhausted');
    expect(r.finalUrl).toBeNull();
    expect(r.redirectHops).toBe(3);
    expect(r.status).toBe(0);
  });

  test('network error → finalUrl null, existing status-0 shape kept', async () => {
    const fetchFn = async () => { throw new Error('ECONNRESET'); };
    const r = await fetchPage('https://flaky.com/', { fetchFn, resolveHostFn: async () => true });
    expect(r).toEqual({ status: 0, finalUrl: null, redirectHops: 0, html: null, blocked: false, truncated: false, contentType: null, error: 'ECONNRESET' });
  });
});

describe('fetchPage carryCookies (EDIS redirects through ask.ifas.ufl.edu)', () => {
  const { fetchPage } = _internals;
  const hdrs = (map, setCookie) => ({ get: (k) => { const key = String(k).toLowerCase(); return key === 'set-cookie' ? (setCookie === undefined ? null : setCookie) : (map[key] ?? null); } });
  const redir = (status, loc, setCookie) => ({ ok: false, status, headers: hdrs({ location: loc }, setCookie), text: async () => '' });
  const page = (html) => ({ ok: true, status: 200, headers: hdrs({ 'content-type': 'text/html' }), text: async () => html });

  test('EDIS-shaped chain resolves with carryCookies and exhausts the budget without it', async () => {
    // A 301 -> B; B 307 -> /en/p with cookies; /en/p loops to itself until the
    // locale cookie comes back, then 307 -> /p; /p answers 200. B's /p is the
    // same URL that first 307s, so key its answer off the Cookie header.
    const seen = [];
    const fetchFn = async (url, opts) => {
      seen.push({ url, cookie: opts.headers.Cookie });
      if (url === 'https://edis.example.edu/publication/IG080') return redir(301, 'https://ask.example.edu/publication/IG080');
      if (url === 'https://ask.example.edu/publication/IG080') {
        if (opts.headers.Cookie) return page('<h1>Fire ants</h1>');
        return redir(307, '/en/publication/IG080', ['NEXT_LOCALE=en; Path=/; Secure', 'TS01823c9d=abc123; Path=/; HttpOnly']);
      }
      if (url === 'https://ask.example.edu/en/publication/IG080') {
        const ok = /(^|; )NEXT_LOCALE=en(;|$)/.test(opts.headers.Cookie || '');
        return redir(307, ok ? '/publication/IG080' : '/en/publication/IG080');
      }
      return null;
    };
    const r = await fetchPage('https://edis.example.edu/publication/IG080', { fetchFn, resolveHostFn: async () => true, maxRedirects: 3, carryCookies: true });
    expect(r.status).toBe(200);
    expect(r.html).toBe('<h1>Fire ants</h1>');
    expect(r.error).toBeNull();
    expect(r.finalUrl).toBe('https://ask.example.edu/publication/IG080');
    expect(r.redirectHops).toBe(3);
    expect(seen[0].cookie).toBeUndefined(); // edis host never set a cookie
    expect(seen[1].cookie).toBeUndefined();
    expect(seen[2].cookie).toBe('NEXT_LOCALE=en; TS01823c9d=abc123');
    expect(seen[3].cookie).toBe('NEXT_LOCALE=en; TS01823c9d=abc123');

    const off = await fetchPage('https://edis.example.edu/publication/IG080', { fetchFn: async (u, o) => {
      if (o.headers.Cookie) throw new Error('Cookie sent with the option off');
      return fetchFn(u, o);
    }, resolveHostFn: async () => true, maxRedirects: 3 });
    expect(off.error).toBe('redirect_budget_exhausted');
    expect(off.html).toBeNull();
  });

  test('a cookie set by host A is never sent to host B', async () => {
    const seen = [];
    const fetchFn = async (url, opts) => {
      seen.push({ url, cookie: opts.headers.Cookie });
      if (url === 'https://a.example.com/') return redir(302, 'https://b.example.com/', ['sid=secret; Path=/; Domain=example.com']);
      if (url === 'https://b.example.com/') return redir(302, 'https://a.example.com/back');
      return page('ok');
    };
    const r = await fetchPage('https://a.example.com/', { fetchFn, resolveHostFn: async () => true, maxRedirects: 3, carryCookies: true });
    expect(r.status).toBe(200);
    expect(seen.map((s) => s.cookie)).toEqual([undefined, undefined, 'sid=secret']);
  });

  test('a cookie set over https is not sent to the same host over http', async () => {
    const seen = [];
    const fetchFn = async (url, opts) => {
      seen.push(opts.headers.Cookie);
      if (url === 'https://a.example.com/') return redir(302, 'http://a.example.com/plain', ['sid=secret; Path=/; Secure']);
      return page('ok');
    };
    const r = await fetchPage('https://a.example.com/', { fetchFn, resolveHostFn: async () => true, maxRedirects: 3, carryCookies: true });
    expect(r.status).toBe(200);
    expect(seen).toEqual([undefined, undefined]);
  });

  test('option off: no request carries a Cookie header even when a redirect sets one', async () => {
    const seen = [];
    const fetchFn = async (url, opts) => {
      seen.push(opts.headers);
      if (url === 'https://a.example.com/') return redir(302, 'https://a.example.com/next', ['sid=secret; Path=/']);
      return page('ok');
    };
    const r = await fetchPage('https://a.example.com/', { fetchFn, resolveHostFn: async () => true, maxRedirects: 3 });
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(2);
    for (const h of seen) expect(Object.keys(h)).toEqual(['User-Agent']);
  });

  test('a bad cookie name or a CR/LF/; in the value is dropped; getSetCookie() and a single string both work', async () => {
    const seen = [];
    const fetchFn = async (url, opts) => {
      seen.push(opts.headers.Cookie);
      if (url === 'https://a.example.com/') {
        return { ok: false, status: 302, headers: { get: (k) => (k === 'location' ? '/next' : null), getSetCookie: () => ['good=1; Path=/', 'bad name=2', 'inj=a\r\nX-Evil: 1', 'ctl=a\nb', '=novalue', 'also_good=3'] }, text: async () => '' };
      }
      if (url === 'https://a.example.com/next') return redir(302, '/last', 'single=9; Path=/');
      return page('ok');
    };
    const r = await fetchPage('https://a.example.com/', { fetchFn, resolveHostFn: async () => true, maxRedirects: 3, carryCookies: true });
    expect(r.status).toBe(200);
    expect(seen).toEqual([undefined, 'good=1; also_good=3', 'good=1; also_good=3; single=9']);
  });

  test('a cookie goes only to paths its Path covers; with no Path it takes the directory of the URL that set it', async () => {
    const seen = [];
    const fetchFn = async (url, opts) => {
      seen.push(opts.headers.Cookie);
      if (url === 'https://a.example.com/dir/start') return redir(302, '/b', ['p=1; Path=/a', 'root=1; Path=/', 'dirc=1']);
      if (url === 'https://a.example.com/b') return redir(302, '/a/x');
      if (url === 'https://a.example.com/a/x') return redir(302, '/abc');
      if (url === 'https://a.example.com/abc') return redir(302, '/dir/other');
      return page('ok');
    };
    const r = await fetchPage('https://a.example.com/dir/start', { fetchFn, resolveHostFn: async () => true, maxRedirects: 5, carryCookies: true });
    expect(r.status).toBe(200);
    expect(seen).toEqual([undefined, 'root=1', 'p=1; root=1', 'root=1', 'dirc=1; root=1']);
  });

  test('Max-Age=0 or a past Expires clears a cookie, and a Secure cookie set over http is ignored', async () => {
    const seen = [];
    const fetchFn = async (url, opts) => {
      seen.push(opts.headers.Cookie);
      if (url === 'https://a.example.com/') return redir(302, '/two', ['k=1; Path=/', 'old=1; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'keep=1; Path=/; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
      if (url === 'https://a.example.com/two') return redir(302, '/three', ['k=; Path=/; Max-Age=0']);
      if (url === 'https://a.example.com/three') return redir(302, 'http://b.example.com/');
      if (url === 'http://b.example.com/') return redir(302, '/next', ['s=1; Path=/; Secure', 'plain=1; Path=/']);
      return page('ok');
    };
    const r = await fetchPage('https://a.example.com/', { fetchFn, resolveHostFn: async () => true, maxRedirects: 5, carryCookies: true });
    expect(r.status).toBe(200);
    expect(seen).toEqual([undefined, 'k=1; keep=1', 'keep=1', undefined, 'plain=1']);
  });

  test('an oversized cookie is skipped, so a small locale cookie after it still goes out', async () => {
    const seen = [];
    const fetchFn = async (url, opts) => {
      seen.push(opts.headers.Cookie);
      if (url === 'https://a.example.com/') return redir(302, '/next', ['big=' + 'x'.repeat(5000) + '; Path=/', 'NEXT_LOCALE=en; Path=/']);
      return page('ok');
    };
    const r = await fetchPage('https://a.example.com/', { fetchFn, resolveHostFn: async () => true, maxRedirects: 3, carryCookies: true });
    expect(r.status).toBe(200);
    expect(seen).toEqual([undefined, 'NEXT_LOCALE=en']);
  });

  test('caps: 20 cookies per origin and a 4096-character Cookie header', async () => {
    const seen = [];
    const many = Array.from({ length: 30 }, (_, i) => `c${i}=v`);
    const big = ['a=' + 'x'.repeat(3000), 'b=' + 'y'.repeat(3000)];
    const fetchFn = async (url, opts) => {
      seen.push(opts.headers.Cookie);
      if (url === 'https://a.example.com/') return redir(302, '/two', many);
      if (url === 'https://a.example.com/two') return redir(302, 'https://c.example.com/', null);
      if (url === 'https://c.example.com/') return redir(302, '/three', big);
      return page('ok');
    };
    const r = await fetchPage('https://a.example.com/', { fetchFn, resolveHostFn: async () => true, maxRedirects: 5, carryCookies: true });
    expect(r.status).toBe(200);
    expect(seen[1].split('; ')).toHaveLength(20);
    expect(seen[1]).toContain('c19=v');
    expect(seen[1]).not.toContain('c20=v');
    expect(seen[3].length).toBeLessThanOrEqual(4096);
    expect(seen[3].startsWith('a=')).toBe(true);
    expect(seen[3]).not.toContain('b=');
  });
});
