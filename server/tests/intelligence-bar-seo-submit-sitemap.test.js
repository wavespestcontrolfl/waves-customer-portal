/**
 * submit_gsc_sitemap — the one outside-write tool in seo-tools.js (IB scope
 * expansion item 1, owner ruling 2026-09-28). Structurally two-step
 * (write-gates.js OUTSIDE_WRITE_TOOL_NAMES), full-access-only gating lives
 * in the ROUTE (getToolsForContext, intelligence-bar-full-access-tool-
 * offering.test.js), not here. These tests cover the module contract:
 * missing-token refusal, a human-readable preview naming the real
 * fleet_sites row (not just the typed domain string), and the commit
 * path's refusal.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ENV_KEYS = ['GOOGLE_SERVICE_ACCOUNT_JSON'];
const savedEnv = {};

function makeDbMock(rows) {
  const builder = {
    whereILike: () => builder,
    first: async () => rows[0],
  };
  return jest.fn(() => builder);
}

let executeSeoTool;

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
  jest.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
});

function load(rows) {
  const dbMock = makeDbMock(rows);
  jest.doMock('../models/db', () => dbMock);
  ({ executeSeoTool } = require('../services/intelligence-bar/seo-tools'));
  return dbMock;
}

describe('submit_gsc_sitemap (preview only)', () => {
  test('unconfigured state is benign — no error field, no DB call', async () => {
    const dbMock = load([]);
    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'bradentonflpestcontrol.com' });
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/GOOGLE_SERVICE_ACCOUNT_JSON/);
    expect(dbMock).not.toHaveBeenCalled();
  });

  test('unconfirmed: names the real fleet_sites row, not just the typed domain', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    load([{ domain: 'bradentonflpestcontrol.com', name: 'Bradenton Pest Control', area: 'Bradenton' }]);

    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'bradentonflpestcontrol.com' });
    expect(result.error).toBeUndefined();
    expect(result.preview).toBe(true);
    expect(result.site).toEqual({ domain: 'bradentonflpestcontrol.com', name: 'Bradenton Pest Control', area: 'Bradenton' });
    expect(result.sitemap_url).toBe('https://bradentonflpestcontrol.com/sitemap-index.xml');
    expect(result.note).toContain('Bradenton Pest Control');
  });

  test('a custom sitemap_path overrides the @astrojs/sitemap default', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    load([{ domain: 'wavespestcontrol.com', name: 'Hub', area: 'Hub' }]);

    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'wavespestcontrol.com', sitemap_path: '/sitemap.xml' });
    expect(result.error).toBeUndefined();
    expect(result.sitemap_url).toBe('https://wavespestcontrol.com/sitemap.xml');
  });

  test('a domain not in the tracked fleet list still previews, flagged for a double-check', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    load([]);

    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'unknown-site.com' });
    expect(result.error).toBeUndefined();
    expect(result.site).toEqual({ domain: 'unknown-site.com', name: null, area: null });
    expect(result.note).toMatch(/not in the tracked fleet_sites list/);
  });

  test('missing domain refuses before any DB call', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    const dbMock = load([]);

    const result = await executeSeoTool('submit_gsc_sitemap', {});
    expect(result.error).toMatch(/domain/);
    expect(dbMock).not.toHaveBeenCalled();
  });

  test('confirmed:true refuses — the commit path is not built in this PR', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    const dbMock = load([{ domain: 'wavespestcontrol.com', name: 'Hub', area: 'Hub' }]);

    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'wavespestcontrol.com', confirmed: true });
    expect(result.error).toMatch(/not enabled yet/);
    expect(result.code).toBe('not_yet_implemented');
    expect(dbMock).not.toHaveBeenCalled();
  });
});
