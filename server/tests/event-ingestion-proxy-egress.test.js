/**
 * Contract for the per-source residential-proxy opt-in
 * (scrape_config.proxy, 2026-08-04 event-source repairs).
 *
 * The stakes: resolveProxyConfig runs at the top of every RSS and scrape
 * pull. A wrong throw fails HEALTHY direct sources; a silently-wrong null
 * would mask an explicit misconfig. So pin the three-way contract:
 * proxy-less sources resolve to null without touching env; an
 * unprovisioned gateway (env missing) degrades to a DIRECT pull with a
 * warning — never worse than pre-opt-in; an explicit misconfig (unknown
 * mode, unparseable gateway URL) throws loudly.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../models/db', () => jest.fn());

const { resolveProxyConfig } = require('../services/event-ingestion');

describe('resolveProxyConfig', () => {
  const OLD_URL = process.env.EVENT_PULL_PROXY_URL;
  afterEach(() => {
    if (OLD_URL === undefined) delete process.env.EVENT_PULL_PROXY_URL;
    else process.env.EVENT_PULL_PROXY_URL = OLD_URL;
  });

  it('returns null when the source opts out (no scrape_config / no proxy key)', () => {
    delete process.env.EVENT_PULL_PROXY_URL;
    expect(resolveProxyConfig({})).toBeNull();
    expect(resolveProxyConfig({ scrape_config: null })).toBeNull();
    expect(resolveProxyConfig({ scrape_config: { userAgent: 'x' } })).toBeNull();
  });

  it('splits the gateway URL into the Playwright proxy shape', () => {
    process.env.EVENT_PULL_PROXY_URL = 'http://group-res:s3cret@gate.vendor.example:8000';
    expect(resolveProxyConfig({ scrape_config: { proxy: 'residential' } })).toEqual({
      server: 'http://gate.vendor.example:8000',
      username: 'group-res',
      password: 's3cret',
    });
  });

  it('handles a credential-less gateway (IP-allowlisted vendors)', () => {
    process.env.EVENT_PULL_PROXY_URL = 'http://gate.vendor.example:8000';
    expect(resolveProxyConfig({ scrape_config: { proxy: 'residential' } })).toEqual({
      server: 'http://gate.vendor.example:8000',
    });
  });

  it('decodes percent-encoded credentials (vendors issue passwords with URL-reserved chars)', () => {
    process.env.EVENT_PULL_PROXY_URL = 'http://user:p%40ss%2Fword@gate.vendor.example:8000';
    expect(resolveProxyConfig({ scrape_config: { proxy: 'residential' } }).password).toBe('p@ss/word');
  });

  it('degrades to a direct pull (null) with a warning while the gateway env is unprovisioned', () => {
    delete process.env.EVENT_PULL_PROXY_URL;
    const logger = require('../services/logger');
    logger.warn.mockClear();
    expect(resolveProxyConfig({ name: 'Visit Sarasota County — Events', scrape_config: { proxy: 'residential' } }))
      .toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('EVENT_PULL_PROXY_URL is not set'));
  });

  it('throws when the gateway env is not a URL', () => {
    process.env.EVENT_PULL_PROXY_URL = 'not a url';
    expect(() => resolveProxyConfig({ scrape_config: { proxy: 'residential' } }))
      .toThrow(/not a parseable URL/);
  });

  it('throws on an unknown proxy mode instead of guessing', () => {
    process.env.EVENT_PULL_PROXY_URL = 'http://gate.vendor.example:8000';
    expect(() => resolveProxyConfig({ scrape_config: { proxy: 'apify-residential' } }))
      .toThrow(/Unknown scrape_config\.proxy/);
  });
});
