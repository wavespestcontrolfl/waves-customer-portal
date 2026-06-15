jest.mock('../models/db', () => {
  const query = {
    where: jest.fn(() => ({ first: jest.fn(async () => null) })),
    insert: jest.fn(async () => {}),
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
});
