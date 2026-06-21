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
    const r = await findContact('news.com', { fetchFn });
    expect(r.contact_email).toBe('editor@news.com');
    expect(r.has_contact_path).toBe(true);
    expect(r.contact_url).toBe('https://news.com/');
  });

  test('prefers an on-domain role inbox over a personal one', async () => {
    const fetchFn = mockFetch({
      'https://x.com/': 'reach jdoe@x.com or editor@x.com anytime',
    });
    const r = await findContact('x.com', { fetchFn });
    expect(r.contact_email).toBe('editor@x.com');
  });

  test('falls back to a contact FORM when no email is exposed', async () => {
    const fetchFn = mockFetch({
      'https://site.com/': '<p>no email here</p>',
      'https://site.com/contact': '<form action="/send"><input name="email"></form>',
    });
    const r = await findContact('site.com', { fetchFn });
    expect(r.contact_email).toBeNull();
    expect(r.has_contact_path).toBe(true);
    expect(r.contact_url).toBe('https://site.com/contact');
  });

  test('no contact path → has_contact_path false (the gate trips)', async () => {
    const fetchFn = mockFetch({ 'https://dead.com/': '<p>nothing useful</p>' });
    const r = await findContact('dead.com', { fetchFn });
    expect(r.has_contact_path).toBe(false);
    expect(r.contact_email).toBeNull();
  });

  test('never throws when fetch rejects', async () => {
    const fetchFn = async () => { throw new Error('ECONNRESET'); };
    const r = await findContact('flaky.com', { fetchFn });
    expect(r.has_contact_path).toBe(false);
    expect(r.domain).toBe('flaky.com');
  });

  test('ignores asset/placeholder junk that looks like an email', async () => {
    const fetchFn = mockFetch({ 'https://img.com/': 'logo sprite-2x@2x.png and noreply@img.com' });
    const r = await findContact('img.com', { fetchFn });
    expect(r.contact_email).toBeNull(); // no-reply + .png filtered
  });

  test('normalizes www + scheme', () => {
    expect(_internals.normalizeDomain('https://www.Foo.com/path')).toBe('foo.com');
  });
});
