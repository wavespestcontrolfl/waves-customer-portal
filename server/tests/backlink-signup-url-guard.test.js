/**
 * GATE_BACKLINK_SIGNUP_URL_GUARD (security audit run 2, 2026-10-22): the
 * backlink signup worker only opens public http(s) URLs, keeps the model's
 * signup_url on the queued site, and aborts requests to non-public hosts.
 */

jest.mock('playwright', () => ({ chromium: { launch: jest.fn() } }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('dns', () => {
  const actual = jest.requireActual('dns');
  const table = {
    'directory.example': ['93.184.216.34'],
    'signup.directory.example': ['93.184.216.34'],
    'other.example': ['93.184.216.35'],
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

const { _internals } = require('../services/backlink-agent/signup-worker');

const { signupUrlAllowed, requestHostBlocked, sameSiteHost } = _internals;

describe('signupUrlAllowed', () => {
  test('a public http(s) site is allowed', async () => {
    await expect(signupUrlAllowed('https://directory.example/listing')).resolves.toBe(true);
  });

  test('non-http schemes, loopback, metadata and private-resolving hosts are refused', async () => {
    await expect(signupUrlAllowed('file:///etc/passwd')).resolves.toBe(false);
    await expect(signupUrlAllowed('http://127.0.0.1:8080/')).resolves.toBe(false);
    await expect(signupUrlAllowed('http://169.254.169.254/latest/meta-data/')).resolves.toBe(false);
    await expect(signupUrlAllowed('http://localhost/')).resolves.toBe(false);
    await expect(signupUrlAllowed('https://internal.example/')).resolves.toBe(false);
    await expect(signupUrlAllowed('not a url')).resolves.toBe(false);
  });

  test('signup_url must stay on the queued site', async () => {
    const base = 'https://directory.example/listing';
    await expect(signupUrlAllowed('https://signup.directory.example/join', { baseUrl: base })).resolves.toBe(true);
    await expect(signupUrlAllowed('https://other.example/join', { baseUrl: base })).resolves.toBe(false);
  });
});

describe('requestHostBlocked (route guard)', () => {
  test('blocks private and metadata literals, IPv6 literals and odd schemes', () => {
    expect(requestHostBlocked('http://10.1.2.3/x')).toBe(true);
    expect(requestHostBlocked('http://169.254.169.254/')).toBe(true);
    expect(requestHostBlocked('http://[::1]/')).toBe(true);
    expect(requestHostBlocked('http://localhost:3000/')).toBe(true);
    expect(requestHostBlocked('file:///etc/hosts')).toBe(true);
  });

  test('lets public hosts and inline data through', () => {
    expect(requestHostBlocked('https://directory.example/app.js')).toBe(false);
    expect(requestHostBlocked('http://93.184.216.34/')).toBe(false);
    expect(requestHostBlocked('data:image/png;base64,AAAA')).toBe(false);
  });
});

test('sameSiteHost accepts the host, its sub-domains and its parent only', () => {
  expect(sameSiteHost('a.directory.example', 'directory.example')).toBe(true);
  expect(sameSiteHost('directory.example', 'www.directory.example')).toBe(true);
  expect(sameSiteHost('evildirectory.example', 'directory.example')).toBe(false);
});
