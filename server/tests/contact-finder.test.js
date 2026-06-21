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
});
