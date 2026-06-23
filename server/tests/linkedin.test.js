const linkedin = require('../services/linkedin');

const { parseJsonObject, SCOPES, API_VERSION } = linkedin._test;

describe('linkedin service config', () => {
  test('API_VERSION is a current YYYYMM (not the stale placeholder)', () => {
    expect(API_VERSION).toMatch(/^20\d{4}$/);
    // LinkedIn sunsets monthly versions; guard against regressing to an old one.
    expect(Number(API_VERSION)).toBeGreaterThanOrEqual(202507);
  });

  test('SCOPES request ORGANIZATION posting, not member', () => {
    expect(SCOPES).toContain('w_organization_social');
    expect(SCOPES).not.toContain('w_member_social');
  });

  test('parseJsonObject tolerates objects, strings, and garbage', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject({ a: 1 })).toEqual({ a: 1 });
    expect(parseJsonObject('not json')).toEqual({});
    expect(parseJsonObject(null)).toEqual({});
    expect(parseJsonObject('[1,2]')).toEqual({}); // arrays are not token records
  });
});

describe('linkedin service surface', () => {
  test('exposes the OAuth + posting methods', () => {
    for (const m of ['getAuthUrl', 'handleCallback', 'storeTokens', 'getStatus', 'createPost', 'verifyOrgAccess']) {
      expect(typeof linkedin[m]).toBe('function');
    }
  });

  test('getAuthUrl builds a LinkedIn consent URL with our scopes + redirect', () => {
    // getAuthUrl needs a client id; only assert when configured (env-dependent).
    if (!linkedin.clientId) return;
    const url = linkedin.getAuthUrl('abc123');
    expect(url).toContain('https://www.linkedin.com/oauth/v2/authorization');
    expect(url).toContain('response_type=code');
    expect(url).toContain('state=abc123');
    expect(url).toContain(encodeURIComponent('w_organization_social'));
    expect(url).toContain(encodeURIComponent('/api/admin/settings/linkedin/callback'));
  });
});
