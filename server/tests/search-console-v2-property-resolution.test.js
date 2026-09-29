/**
 * SearchConsoleService.resolveAccessibleProperty — the live GSC property
 * resolution submit_gsc_sitemap now pins its preview to (codex r3 P1 on
 * #5275): a domain the fleet registry tracks is not necessarily a property
 * THIS service account can reach, and a URL-prefix property
 * ("https://domain/") and a domain property ("sc-domain:domain") are
 * different Search Console properties — only sites.list can say which one
 * (if either) this account actually holds.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ENV_KEYS = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GSC_SITE_URL'];
const savedEnv = {};

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

// Loads a fresh instance with googleapis stubbed to a fake auth + a
// caller-supplied sites.list implementation, so no real network call is ever
// possible from this suite.
function loadWithSitesList(sitesList) {
  jest.resetModules();
  jest.doMock('googleapis', () => ({
    google: {
      auth: { GoogleAuth: jest.fn().mockImplementation(() => ({})) },
      searchconsole: jest.fn(() => ({ sites: { list: sitesList } })),
    },
  }));
  return require('../services/seo/search-console-v2');
}

describe('resolveAccessibleProperty', () => {
  test('GOOGLE_SERVICE_ACCOUNT_JSON unset refuses without ever calling sites.list', async () => {
    const list = jest.fn();
    const svc = loadWithSitesList(list);
    const result = await svc.resolveAccessibleProperty('bradentonflpestcontrol.com');
    expect(result.error).toMatch(/not configured/);
    expect(list).not.toHaveBeenCalled();
  });

  test('matches the URL-prefix property when that is what is verified', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    const list = jest.fn().mockResolvedValue({
      data: { siteEntry: [{ siteUrl: 'https://bradentonflpestcontrol.com/', permissionLevel: 'siteOwner' }] },
    });
    const svc = loadWithSitesList(list);
    const result = await svc.resolveAccessibleProperty('bradentonflpestcontrol.com');
    expect(result).toEqual({ siteUrl: 'https://bradentonflpestcontrol.com/', permissionLevel: 'siteOwner' });
  });

  test('matches the sc-domain: property when that is what is verified instead', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    const list = jest.fn().mockResolvedValue({
      data: { siteEntry: [{ siteUrl: 'sc-domain:bradentonflpestcontrol.com', permissionLevel: 'siteFullUser' }] },
    });
    const svc = loadWithSitesList(list);
    const result = await svc.resolveAccessibleProperty('bradentonflpestcontrol.com');
    expect(result).toEqual({ siteUrl: 'sc-domain:bradentonflpestcontrol.com', permissionLevel: 'siteFullUser' });
  });

  test('matching is case-insensitive on the property identifier', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    const list = jest.fn().mockResolvedValue({
      data: { siteEntry: [{ siteUrl: 'HTTPS://BradentonFLPestControl.com/', permissionLevel: 'siteOwner' }] },
    });
    const svc = loadWithSitesList(list);
    const result = await svc.resolveAccessibleProperty('bradentonflpestcontrol.com');
    expect(result.siteUrl).toBe('HTTPS://BradentonFLPestControl.com/');
  });

  test('neither representation accessible refuses and names both forms it checked', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    const list = jest.fn().mockResolvedValue({
      data: { siteEntry: [{ siteUrl: 'https://some-other-site.com/', permissionLevel: 'siteOwner' }] },
    });
    const svc = loadWithSitesList(list);
    const result = await svc.resolveAccessibleProperty('bradentonflpestcontrol.com');
    expect(result.error).toBe('not_accessible');
    expect(result.checked).toEqual(['https://bradentonflpestcontrol.com/', 'sc-domain:bradentonflpestcontrol.com']);
  });

  test('an empty site list refuses the same way as no match', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    const list = jest.fn().mockResolvedValue({ data: { siteEntry: [] } });
    const svc = loadWithSitesList(list);
    const result = await svc.resolveAccessibleProperty('bradentonflpestcontrol.com');
    expect(result.error).toBe('not_accessible');
  });

  test('a sites.list failure surfaces as a caught error, never a thrown exception', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    const list = jest.fn().mockRejectedValue(new Error('boom'));
    const svc = loadWithSitesList(list);
    const result = await svc.resolveAccessibleProperty('bradentonflpestcontrol.com');
    expect(result.error).toMatch(/Could not list Search Console properties: boom/);
  });

  test('the hub domain resolves against its www URL-prefix default (siteUrlForDomain\'s DEFAULT_SITE_URL)', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    const list = jest.fn().mockResolvedValue({
      data: { siteEntry: [{ siteUrl: 'https://www.wavespestcontrol.com/', permissionLevel: 'siteOwner' }] },
    });
    const svc = loadWithSitesList(list);
    const result = await svc.resolveAccessibleProperty('wavespestcontrol.com');
    expect(result.siteUrl).toBe('https://www.wavespestcontrol.com/');
  });

  test('a property listed without submit permission is not accessible; the permitted representation wins', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    const onlyUnverified = jest.fn().mockResolvedValue({
      data: { siteEntry: [{ siteUrl: 'https://bradentonflpestcontrol.com/', permissionLevel: 'siteUnverifiedUser' }] },
    });
    expect((await loadWithSitesList(onlyUnverified).resolveAccessibleProperty('bradentonflpestcontrol.com')).error).toBe('not_accessible');

    const both = jest.fn().mockResolvedValue({
      data: { siteEntry: [
        { siteUrl: 'https://bradentonflpestcontrol.com/', permissionLevel: 'siteRestrictedUser' },
        { siteUrl: 'sc-domain:bradentonflpestcontrol.com', permissionLevel: 'siteFullUser' },
      ] },
    });
    expect((await loadWithSitesList(both).resolveAccessibleProperty('bradentonflpestcontrol.com')).siteUrl).toBe('sc-domain:bradentonflpestcontrol.com');
  });

  test('the property lookup is bounded by the configured GSC request timeout (Codex r4 on #5275)', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    const list = jest.fn().mockResolvedValue({ data: { siteEntry: [] } });
    const svc = loadWithSitesList(list);
    await svc.resolveAccessibleProperty('bradentonflpestcontrol.com');
    expect(list).toHaveBeenCalledWith({}, expect.objectContaining({ timeout: expect.any(Number) }));
  });
});
