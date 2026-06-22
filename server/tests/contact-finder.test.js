const { findContact, _internals } = require('../services/seo/contact-finder');

function mockFetch(map) {
  return async (url) => {
    const html = map[url];
    if (html === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => html };
  };
}

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
