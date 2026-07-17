jest.mock('../models/db', () => {
  const query = {
    where: jest.fn(() => ({ first: jest.fn(async () => null) })),
    insert: jest.fn(async () => {}),
    whereNotIn: jest.fn(() => ({ del: jest.fn(async () => 0) })),
    orderBy: jest.fn(async () => []),
  };
  const db = jest.fn(() => query);
  db._query = query;
  return db;
});

jest.mock('../services/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

describe('token health meta checks', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      FACEBOOK_ACCESS_TOKEN: 'page-token',
      FACEBOOK_PAGE_ID: '110336442031847',
      INSTAGRAM_ACCOUNT_ID: '17841465266249854',
    };
    global.fetch = jest.fn(async (url) => {
      const text = String(url);
      if (text.includes('/debug_token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { is_valid: true, scopes: ['pages_show_list', 'pages_manage_posts', 'instagram_content_publish'] },
          }),
        };
      }
      if (text.includes('/110336442031847?fields=')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: '110336442031847',
            name: 'Waves Pest Control',
            instagram_business_account: {
              id: '17841465266249854',
              username: 'wavespestcontrol',
            },
          }),
        };
      }
      if (text.includes('/17841465266249854?fields=')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: '17841465266249854',
            username: 'wavespestcontrol',
            name: 'Waves Pest Control',
          }),
        };
      }
      if (text.includes('/17841465266249854/content_publishing_limit')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ quota_usage: 0 }] }),
        };
      }
      throw new Error(`Unexpected fetch URL: ${text}`);
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    delete global.fetch;
  });

  test('facebook health resolves the configured Page and linked Instagram account', async () => {
    const tokenHealth = require('../services/token-health');

    const result = await tokenHealth.checkSingle('facebook');

    expect(result).toMatchObject({
      platform: 'facebook',
      status: 'healthy',
      lastError: null,
      details: {
        pageId: '110336442031847',
        pageName: 'Waves Pest Control',
        linkedInstagramAccountId: '17841465266249854',
        linkedInstagramUsername: 'wavespestcontrol',
      },
    });
    expect(result.details.checks.canCreateContent).toBe(true);
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining('/feed'));
  });

  test('facebook health fails when the Page links a different Instagram account than configured', async () => {
    process.env.INSTAGRAM_ACCOUNT_ID = '17800000000000000'; // page links 17841465266249854
    const tokenHealth = require('../services/token-health');

    const result = await tokenHealth.checkSingle('facebook');

    expect(result.status).toBe('error');
    expect(result.lastError).toMatch(/does not match INSTAGRAM_ACCOUNT_ID/);
    expect(result.details.checks.instagramLinkMatches).toBe(false);
  });

  test('facebook health never requests the invalid `tasks` field on the Page node', async () => {
    // Regression: `tasks` is not a field on a Page node (only on /me/accounts),
    // so requesting it makes the WHOLE Graph call fail with `(#100) Tried
    // accessing nonexisting field (tasks)`. This mock mirrors that real-world
    // behavior — if the check ever asks for `tasks` again, the request errors
    // and the platform false-flags as unhealthy.
    global.fetch = jest.fn(async (url) => {
      const text = String(url);
      if (text.includes('/debug_token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { is_valid: true, scopes: ['pages_manage_posts'] } }),
        };
      }
      if (text.includes('/110336442031847?fields=')) {
        if (text.includes('tasks')) {
          return {
            ok: false,
            status: 400,
            json: async () => ({
              error: {
                message: '(#100) Tried accessing nonexisting field (tasks) on node type (Page)',
                type: 'OAuthException',
                code: 100,
              },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: '110336442031847',
            name: 'Waves Pest Control',
            instagram_business_account: { id: '17841465266249854', username: 'wavespestcontrol' },
          }),
        };
      }
      throw new Error(`Unexpected fetch URL: ${text}`);
    });
    const tokenHealth = require('../services/token-health');

    const result = await tokenHealth.checkSingle('facebook');

    expect(result.status).toBe('healthy');
    expect(result.lastError).toBeNull();
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining('tasks'));
  });

  test('facebook health errors when the token lacks the pages_manage_posts scope', async () => {
    // Page resolves + IG links correctly, but the token cannot publish.
    global.fetch = jest.fn(async (url) => {
      const text = String(url);
      if (text.includes('/debug_token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { is_valid: true, scopes: ['pages_show_list', 'pages_read_engagement'] } }),
        };
      }
      if (text.includes('/110336442031847?fields=')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: '110336442031847',
            name: 'Waves Pest Control',
            instagram_business_account: { id: '17841465266249854', username: 'wavespestcontrol' },
          }),
        };
      }
      throw new Error(`Unexpected fetch URL: ${text}`);
    });
    const tokenHealth = require('../services/token-health');

    const result = await tokenHealth.checkSingle('facebook');

    expect(result.status).toBe('error');
    expect(result.lastError).toMatch(/pages_manage_posts/);
    expect(result.details.checks.canCreateContent).toBe(false);
  });

  test('facebook health treats a granular-only pages_manage_posts grant as publish-capable', async () => {
    // FB may report a permission only under granular_scopes — must not false-flag.
    global.fetch = jest.fn(async (url) => {
      const text = String(url);
      if (text.includes('/debug_token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              is_valid: true,
              scopes: ['pages_show_list'],
              granular_scopes: [{ scope: 'pages_manage_posts', target_ids: ['110336442031847'] }],
            },
          }),
        };
      }
      if (text.includes('/110336442031847?fields=')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: '110336442031847',
            name: 'Waves Pest Control',
            instagram_business_account: { id: '17841465266249854', username: 'wavespestcontrol' },
          }),
        };
      }
      throw new Error(`Unexpected fetch URL: ${text}`);
    });
    const tokenHealth = require('../services/token-health');

    const result = await tokenHealth.checkSingle('facebook');

    expect(result.status).toBe('healthy');
    expect(result.details.checks.canCreateContent).toBe(true);
  });

  test('facebook health errors when pages_manage_posts is granted only for a different Page', async () => {
    // granular_scopes.target_ids is authoritative — a publish grant for another
    // Page must NOT mark the configured Page as publish-capable.
    global.fetch = jest.fn(async (url) => {
      const text = String(url);
      if (text.includes('/debug_token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              is_valid: true,
              scopes: ['pages_show_list', 'pages_manage_posts'],
              granular_scopes: [{ scope: 'pages_manage_posts', target_ids: ['999999999999999'] }],
            },
          }),
        };
      }
      if (text.includes('/110336442031847?fields=')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: '110336442031847',
            name: 'Waves Pest Control',
            instagram_business_account: { id: '17841465266249854', username: 'wavespestcontrol' },
          }),
        };
      }
      throw new Error(`Unexpected fetch URL: ${text}`);
    });
    const tokenHealth = require('../services/token-health');

    const result = await tokenHealth.checkSingle('facebook');

    expect(result.status).toBe('error');
    expect(result.lastError).toMatch(/pages_manage_posts/);
    expect(result.details.checks.canCreateContent).toBe(false);
  });

  test('facebook health stays healthy with unknown capability when scopes are unavailable', async () => {
    // Some token introspection responses omit `scopes` — never false-flag then.
    global.fetch = jest.fn(async (url) => {
      const text = String(url);
      if (text.includes('/debug_token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { is_valid: true } }), // no scopes array
        };
      }
      if (text.includes('/110336442031847?fields=')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: '110336442031847',
            name: 'Waves Pest Control',
            instagram_business_account: { id: '17841465266249854', username: 'wavespestcontrol' },
          }),
        };
      }
      throw new Error(`Unexpected fetch URL: ${text}`);
    });
    const tokenHealth = require('../services/token-health');

    const result = await tokenHealth.checkSingle('facebook');

    expect(result.status).toBe('healthy');
    expect(result.details.checks.canCreateContent).toBeNull();
  });

  test('instagram health requires content publishing access', async () => {
    const tokenHealth = require('../services/token-health');

    const result = await tokenHealth.checkSingle('instagram');

    expect(result).toMatchObject({
      platform: 'instagram',
      status: 'healthy',
      lastError: null,
      details: {
        accountId: '17841465266249854',
        username: 'wavespestcontrol',
        quotaUsage: 0,
        checks: {
          contentPublishingAllowed: true,
        },
      },
    });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/content_publishing_limit'));
  });

  test('meta_ads token is not_configured when its env var is unset', async () => {
    delete process.env.META_ADS_ACCESS_TOKEN;
    const tokenHealth = require('../services/token-health');
    const result = await tokenHealth.checkSingle('meta_ads');
    expect(result).toMatchObject({ platform: 'meta_ads', status: 'not_configured' });
  });

  test('meta_capi with a valid token but NO pixel configured is not_configured (lane cannot run)', async () => {
    process.env.META_CAPI_ACCESS_TOKEN = 'capi-token';
    delete process.env.META_CAPI_PIXEL_ID;
    const tokenHealth = require('../services/token-health');
    const result = await tokenHealth.checkSingle('meta_capi');
    expect(result).toMatchObject({ platform: 'meta_capi', status: 'not_configured' });
    expect(result.lastError).toMatch(/META_CAPI_PIXEL_ID/);
  });

  test('meta_capi healthy requires debug_token AND a pixel-access probe', async () => {
    process.env.META_CAPI_ACCESS_TOKEN = 'capi-token';
    process.env.META_CAPI_PIXEL_ID = '987654321';
    global.fetch = jest.fn(async (url) => {
      const text = String(url);
      if (text.includes('/debug_token')) {
        return { ok: true, status: 200, json: async () => ({ data: { is_valid: true, expires_at: 0 } }) };
      }
      if (text.includes('/987654321?fields=id')) {
        return { ok: true, status: 200, json: async () => ({ id: '987654321' }) };
      }
      throw new Error(`Unexpected fetch URL: ${text}`);
    });
    const tokenHealth = require('../services/token-health');
    const result = await tokenHealth.checkSingle('meta_capi');
    expect(result).toMatchObject({ platform: 'meta_capi', status: 'healthy', lastError: null });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/987654321?fields=id'));
  });

  test('meta_ads: a valid-but-wrong-account token is NOT healthy (lane probe fails)', async () => {
    process.env.META_ADS_ACCESS_TOKEN = 'ads-token';
    process.env.META_ADS_ACCOUNT_ID = '111222333';
    global.fetch = jest.fn(async (url) => {
      const text = String(url);
      if (text.includes('/debug_token')) {
        return { ok: true, status: 200, json: async () => ({ data: { is_valid: true } }) };
      }
      if (text.includes('/act_111222333?fields=')) {
        // Meta permission error: token valid but no access to THIS ad account.
        return { ok: false, status: 403, json: async () => ({ error: { message: '(#200) Ads permission required', code: 200 } }) };
      }
      throw new Error(`Unexpected fetch URL: ${text}`);
    });
    const tokenHealth = require('../services/token-health');
    const result = await tokenHealth.checkSingle('meta_ads');
    expect(result.status).toBe('error');
    expect(result.lastError).toMatch(/ad account read probe failed/);
  });

  test('meta_audiences: valid token without ads_management on the account is NOT healthy', async () => {
    process.env.META_AUDIENCES_ACCESS_TOKEN = 'aud-token';
    process.env.META_ADS_ACCOUNT_ID = 'act_111222333';
    global.fetch = jest.fn(async (url) => {
      const text = String(url);
      if (text.includes('/debug_token')) {
        return { ok: true, status: 200, json: async () => ({ data: { is_valid: true } }) };
      }
      if (text.includes('/act_111222333/customaudiences')) {
        return { ok: false, status: 403, json: async () => ({ error: { message: '(#294) Managing advertisements requires ads_management', code: 294 } }) };
      }
      throw new Error(`Unexpected fetch URL: ${text}`);
    });
    const tokenHealth = require('../services/token-health');
    const result = await tokenHealth.checkSingle('meta_audiences');
    expect(result.status).toBe('error');
    expect(result.lastError).toMatch(/custom audiences access probe failed/);
  });

  test('getAll RETAINS the three Meta ad lane rows (not purged as unknown platforms)', async () => {
    const db = require('../models/db');
    const tokenHealth = require('../services/token-health');
    await tokenHealth.getAll();
    const kept = db._query.whereNotIn.mock.calls[0][1];
    expect(kept).toEqual(expect.arrayContaining(['meta_ads', 'meta_capi', 'meta_audiences']));
  });

  test('meta lane probes use the lane API version (default v23.0), not the social default', async () => {
    process.env.META_ADS_ACCESS_TOKEN = 'ads-token';
    process.env.META_ADS_ACCOUNT_ID = '111222333';
    const urls = [];
    global.fetch = jest.fn(async (url) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => (String(url).includes('/debug_token')
        ? { data: { is_valid: true } }
        : { id: 'act_111222333' }) };
    });
    const tokenHealth = require('../services/token-health');
    const result = await tokenHealth.checkSingle('meta_ads');
    expect(result.status).toBe('healthy');
    expect(urls.every((u) => u.includes('/v23.0/'))).toBe(true);
  });

  test('meta lane probes honor a pinned META_ADS_API_VERSION', async () => {
    process.env.META_ADS_ACCESS_TOKEN = 'ads-token';
    process.env.META_ADS_ACCOUNT_ID = '111222333';
    process.env.META_ADS_API_VERSION = 'v24.0';
    const urls = [];
    global.fetch = jest.fn(async (url) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => (String(url).includes('/debug_token')
        ? { data: { is_valid: true } }
        : { id: 'act_111222333' }) };
    });
    const tokenHealth = require('../services/token-health');
    await tokenHealth.checkSingle('meta_ads');
    expect(urls.every((u) => u.includes('/v24.0/'))).toBe(true);
  });
});
