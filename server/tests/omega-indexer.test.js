const omega = require('../services/seo/omega-indexer');

describe('omega-indexer submit', () => {
  const KEY = process.env.OMEGA_INDEXER_API_KEY;
  afterEach(() => {
    if (KEY === undefined) delete process.env.OMEGA_INDEXER_API_KEY;
    else process.env.OMEGA_INDEXER_API_KEY = KEY;
  });

  test('no-ops (skipped) when the API key is absent — never calls the paid API', async () => {
    delete process.env.OMEGA_INDEXER_API_KEY;
    let called = false;
    const res = await omega.submit('example.com', ['https://example.com/x'], {
      fetchFn: async () => { called = true; return { ok: true, status: 200, text: async () => 'ok' }; },
    });
    expect(called).toBe(false);
    expect(res.skipped).toBe(true);
    expect(res.ok).toBe(false);
  });

  test('no-ops (skipped) when there are no urls', async () => {
    process.env.OMEGA_INDEXER_API_KEY = 'test-key';
    let called = false;
    const res = await omega.submit('example.com', [], {
      fetchFn: async () => { called = true; return { ok: true, status: 200, text: async () => 'ok' }; },
    });
    expect(called).toBe(false);
    expect(res.skipped).toBe(true);
  });

  test('posts urlencoded apikey + pipe-joined urls + dripfeed to the Omega endpoint', async () => {
    process.env.OMEGA_INDEXER_API_KEY = 'sekret';
    let captured = null;
    const res = await omega.submit('showmysites.com', [
      'https://www.showmysites.com/wavespestcontrol/a/',
      'https://www.showmysites.com/wavespestcontrol/b/',
    ], {
      fetchFn: async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200, text: async () => 'Campaign created' }; },
    });
    expect(res.ok).toBe(true);
    expect(captured.url).toBe(omega.OMEGA_ENDPOINT);
    expect(captured.opts.method).toBe('POST');
    expect(captured.opts.headers['Content-Type']).toMatch(/x-www-form-urlencoded/);
    // Parse the form body back — every field must round-trip exactly.
    const form = new URLSearchParams(captured.opts.body);
    expect(form.get('apikey')).toBe('sekret');
    expect(form.get('dripfeed')).toBe('2');
    expect(form.get('urls')).toBe('https://www.showmysites.com/wavespestcontrol/a/|https://www.showmysites.com/wavespestcontrol/b/');
  });

  test('encodes an apikey containing form-reserved chars (+, &, =, %) without corruption', async () => {
    process.env.OMEGA_INDEXER_API_KEY = 'a+b&c=d%e';
    let body = null;
    await omega.submit('x.com', ['https://x.com/real'], {
      fetchFn: async (_u, o) => { body = o.body; return { ok: true, status: 200, text: async () => '' }; },
    });
    const form = new URLSearchParams(body);
    expect(form.get('apikey')).toBe('a+b&c=d%e'); // exact round-trip, not split into extra fields
    expect(form.get('urls')).toBe('https://x.com/real');
  });

  test('filters falsy urls before submitting', async () => {
    process.env.OMEGA_INDEXER_API_KEY = 'k';
    let body = null;
    await omega.submit('x.com', [null, '', 'https://x.com/real', undefined], {
      fetchFn: async (_u, o) => { body = o.body; return { ok: true, status: 200, text: async () => '' }; },
    });
    const form = new URLSearchParams(body);
    expect(form.get('urls')).toBe('https://x.com/real'); // single url, no pipe separator
  });

  test('returns ok:false (not skipped) on a network error', async () => {
    process.env.OMEGA_INDEXER_API_KEY = 'k';
    const res = await omega.submit('x.com', ['https://x.com/y'], {
      fetchFn: async () => { throw new Error('boom'); },
    });
    expect(res.ok).toBe(false);
    expect(res.skipped).toBeUndefined();
    expect(res.error).toBe('boom');
  });
});
