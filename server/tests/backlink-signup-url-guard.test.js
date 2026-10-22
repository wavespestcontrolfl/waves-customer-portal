/**
 * GATE_BACKLINK_SIGNUP_URL_GUARD (security audit run 2, 2026-10-22): the
 * backlink signup worker's browser is locked to the queued site — its host is
 * pinned to verified public IPv4 up front, every other host is aborted at the
 * context route, service workers are blocked and WebSockets closed.
 */

const mockLaunch = jest.fn();
jest.mock('playwright', () => ({ chromium: { launch: (...a) => mockLaunch(...a) } }));
const mockDbUpdates = [];
jest.mock('../models/db', () => jest.fn(() => ({
  where: () => ({ update: async (row) => { mockDbUpdates.push(row); } }),
})));
jest.mock('../services/llm/call', () => ({
  dispatchWithFallback: jest.fn(async () => ({ ok: true, json: { has_signup: true, signup_url: 'https://evil.example/join' } })),
}));
jest.mock('dns', () => {
  const actual = jest.requireActual('dns');
  const table = {
    'directory.example': ['93.184.216.34'],
    'www.directory.example': ['93.184.216.34'],
    'internal.example': ['10.0.0.5'],
  };
  return {
    ...actual,
    promises: {
      ...actual.promises,
      lookup: jest.fn(async (host) => {
        if (!table[host]) throw new Error('ENOTFOUND');
        return table[host].map((address) => ({ address, family: 4 }));
      }),
    },
  };
});

const { processSignup, _internals } = require('../services/backlink-agent/signup-worker');

const { buildSignupPins, signupRequestAllowed, httpHostOf } = _internals;

afterEach(() => {
  delete process.env.GATE_BACKLINK_SIGNUP_URL_GUARD;
  mockLaunch.mockReset();
  mockDbUpdates.length = 0;
});

describe('buildSignupPins', () => {
  test('pins the queued host and its www sibling to public IPv4', async () => {
    const pins = await buildSignupPins('https://directory.example/listing');
    expect([...pins.pinned].sort()).toEqual(['directory.example', 'www.directory.example']);
    expect(pins.rules).toContain('MAP directory.example 93.184.216.34');
  });

  test('refuses non-http schemes, loopback, metadata and private-resolving hosts', async () => {
    await expect(buildSignupPins('file:///etc/passwd')).resolves.toBeNull();
    await expect(buildSignupPins('http://127.0.0.1:8080/')).resolves.toBeNull();
    await expect(buildSignupPins('http://169.254.169.254/latest/meta-data/')).resolves.toBeNull();
    await expect(buildSignupPins('http://localhost/')).resolves.toBeNull();
    await expect(buildSignupPins('https://internal.example/')).resolves.toBeNull();
    await expect(buildSignupPins('not a url')).resolves.toBeNull();
  });
});

test('hosts outside the strict DNS grammar are refused before any lookup (no ; , * or IP literals)', async () => {
  const resolveHostIps = jest.fn(async () => ['93.184.216.34']);
  for (const url of ['http://x;127.0.0.1;*.attacker.example/', 'http://*.attacker.example/', 'http://a,b.example/', 'http://93.184.216.34/']) {
    await expect(buildSignupPins(url, { resolveHostIps })).resolves.toBeNull();
  }
  expect(resolveHostIps).not.toHaveBeenCalled();
});

test('a resolver that never answers times out instead of holding the queue', async () => {
  jest.useFakeTimers();
  try {
    const p = buildSignupPins('https://directory.example/', { resolveHostIps: () => new Promise(() => {}) });
    await jest.advanceTimersByTimeAsync(20000);
    await expect(p).resolves.toBeNull();
  } finally { jest.useRealTimers(); }
});

test('route guard allows only pinned hosts (redirects, sub-resources, private-resolving names all abort)', () => {
  const pinned = new Set(['directory.example', 'www.directory.example']);
  expect(signupRequestAllowed('https://directory.example/app.js', pinned)).toBe(true);
  expect(signupRequestAllowed('https://internal.example/', pinned)).toBe(false);
  expect(signupRequestAllowed('https://cdn.other.example/x.js', pinned)).toBe(false);
  expect(signupRequestAllowed('http://10.1.2.3/', pinned)).toBe(false);
  expect(signupRequestAllowed('http://169.254.169.254/', pinned)).toBe(false);
});

test('httpHostOf returns a host only for http(s)', () => {
  expect(httpHostOf('https://Directory.Example/x')).toBe('directory.example');
  expect(httpHostOf('javascript:alert(1)')).toBe('');
});

function fakeBrowser() {
  const calls = { contextOpts: null, route: null, ws: null, gotos: [], current: null };
  const page = {
    goto: jest.fn(async (url) => { calls.gotos.push(url); calls.current = url; }),
    url: () => calls.current || 'about:blank',
    waitForTimeout: jest.fn(async () => {}),
    screenshot: jest.fn(async () => Buffer.from('png')),
  };
  const context = {
    route: jest.fn(async (pattern, fn) => { calls.route = fn; }),
    routeWebSocket: jest.fn(async (pattern, fn) => { calls.ws = fn; }),
    newPage: jest.fn(async () => page),
  };
  const browser = {
    newContext: jest.fn(async (opts) => { calls.contextOpts = opts; return context; }),
    close: jest.fn(async () => {}),
  };
  return { browser, calls };
}

describe('processSignup with the gate on', () => {
  beforeEach(() => { process.env.GATE_BACKLINK_SIGNUP_URL_GUARD = 'true'; });

  test('a private target never launches a browser', async () => {
    const r = await processSignup({ id: 'q1', url: 'https://internal.example/' });
    expect(r).toEqual({ success: false, reason: 'url_not_allowed' });
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  test('pins DNS, blocks service workers, routes the context, closes sockets, refuses an off-site signup_url', async () => {
    const { browser, calls } = fakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    const r = await processSignup({ id: 'q2', url: 'https://directory.example/listing' });
    const launchArgs = mockLaunch.mock.calls[0][0].args;
    expect(launchArgs.some((a) => a.startsWith('--host-resolver-rules=MAP directory.example 93.184.216.34'))).toBe(true);
    expect(launchArgs).toContain('--proxy-server=http://127.0.0.1:9');
    expect(launchArgs.find((a) => a.startsWith('--proxy-bypass-list='))).toMatch(/^--proxy-bypass-list=<-loopback>;/);
    expect(calls.contextOpts.serviceWorkers).toBe('block');
    expect(calls.contextOpts.proxy).toBeUndefined();
    expect(typeof calls.route).toBe('function');
    expect(typeof calls.ws).toBe('function');
    expect(calls.gotos).toEqual(['https://directory.example/listing']);
    expect(r).toEqual({ success: false, reason: 'signup_url_not_allowed' });
  });
});

test('gate off: no pinning, no context route, navigation as before', async () => {
  const { browser, calls } = fakeBrowser();
  mockLaunch.mockResolvedValue(browser);
  await processSignup({ id: 'q3', url: 'https://directory.example/listing' }).catch(() => {});
  const launchArgs = mockLaunch.mock.calls[0][0].args;
  expect(launchArgs.some((a) => a.startsWith('--host-resolver-rules'))).toBe(false);
  expect(calls.route).toBeNull();
  expect(calls.contextOpts.serviceWorkers).toBeUndefined();
});
