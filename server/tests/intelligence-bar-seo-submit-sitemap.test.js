/**
 * submit_gsc_sitemap — the one outside-write tool in seo-tools.js (IB scope
 * expansion item 1, owner ruling 2026-09-28). Structurally two-step
 * (write-gates.js OUTSIDE_WRITE_TOOL_NAMES), full-access-only gating lives
 * in the ROUTE (getToolsForContext, intelligence-bar-full-access-tool-
 * offering.test.js), not here. These tests cover the module contract:
 * missing-token refusal, a human-readable preview naming the real
 * fleet_sites row (not just the typed domain string), EXACT matching only
 * (pre-push audit #5275 — no substring, no SQL wildcard widening, refuse on
 * ambiguity), the live Search Console property resolution (codex r3 P1 on
 * #5275 — a synthesized siteUrl is never trusted), and the commit path's
 * refusal.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ENV_KEYS = ['GOOGLE_SERVICE_ACCOUNT_JSON'];
const savedEnv = {};

// The real code now does `db('fleet_sites').select(...)` (no whereILike, no
// first()) and filters for an exact match in JS — the mock just needs to
// resolve the seeded rows.
function makeDbMock(rows) {
  const builder = { select: () => Promise.resolve(rows) };
  return jest.fn(() => builder);
}

const mockResolveAccessibleProperty = jest.fn();

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
  // Default: the property is accessible in its plain URL-prefix form — most
  // tests below are about fleet-domain resolution, not GSC property
  // resolution, so this keeps them focused on what they assert.
  mockResolveAccessibleProperty.mockReset().mockImplementation(async (domain) => ({ siteUrl: `https://${domain}/`, permissionLevel: 'siteOwner' }));
});

function load(rows) {
  const dbMock = makeDbMock(rows);
  jest.doMock('../models/db', () => dbMock);
  jest.doMock('../services/seo/search-console-v2', () => ({
    resolveAccessibleProperty: (...args) => mockResolveAccessibleProperty(...args),
  }));
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

  test('unconfirmed: exact match names the real fleet_sites row, not just the typed domain', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    load([
      { domain: 'bradentonflpestcontrol.com', name: 'Bradenton Pest Control', area: 'Bradenton' },
      { domain: 'bradenton-lawn-care.com', name: 'Bradenton Lawn Care', area: 'Bradenton' },
    ]);

    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'bradentonflpestcontrol.com' });
    expect(result.error).toBeUndefined();
    expect(result.preview).toBe(true);
    // The pinned canonical site — never a different row that merely shares
    // a substring (both rows above contain "bradenton").
    expect(result.site).toEqual({ domain: 'bradentonflpestcontrol.com', name: 'Bradenton Pest Control', area: 'Bradenton' });
    expect(result.sitemap_url).toBe('https://bradentonflpestcontrol.com/sitemap-index.xml');
    // The pinned live Search Console property, resolved (not synthesized).
    expect(result.property).toBe('https://bradentonflpestcontrol.com/');
    expect(mockResolveAccessibleProperty).toHaveBeenCalledWith('bradentonflpestcontrol.com');
    expect(result.note).toContain('Bradenton Pest Control');
  });

  test('the match is case-insensitive but still exact — a mixed-case domain resolves the same row', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    load([
      { domain: 'bradentonflpestcontrol.com', name: 'Bradenton Pest Control', area: 'Bradenton' },
      { domain: 'bradenton-lawn-care.com', name: 'Bradenton Lawn Care', area: 'Bradenton' },
    ]);

    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'BradentonFLPestControl.COM' });
    expect(result.error).toBeUndefined();
    expect(result.site.domain).toBe('bradentonflpestcontrol.com');
  });

  test('hub domains resolve against the canonical network-domain registry — fleet_sites is spoke-only and has no hub row', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    // fleet_sites (the renamed wordpress_sites table) is deliberately empty:
    // a real fleet_sites has no wavespestcontrol.com/waveslawncare.com rows
    // at all, and the hub path must never depend on one existing.
    const dbMock = load([]);

    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'wavespestcontrol.com' });
    expect(result.error).toBeUndefined();
    expect(result.preview).toBe(true);
    expect(result.site).toEqual({ domain: 'wavespestcontrol.com', name: 'Waves Pest Control (hub)', area: 'hub' });
    expect(result.sitemap_url).toBe('https://wavespestcontrol.com/sitemap-index.xml');
    expect(dbMock).not.toHaveBeenCalled();
  });

  // Codex r4 on #5275: a URL-prefix property only accepts sitemaps under its
  // own origin — when the hub resolves to its www property the feed URL must
  // be built from it, not from the bare canonical domain.
  test('a www URL-prefix property builds the sitemap URL on its own origin', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    load([]);
    mockResolveAccessibleProperty.mockResolvedValueOnce({ siteUrl: 'https://www.wavespestcontrol.com/', permissionLevel: 'siteOwner' });
    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'wavespestcontrol.com' });
    expect(result.error).toBeUndefined();
    expect(result.property).toBe('https://www.wavespestcontrol.com/');
    expect(result.sitemap_url).toBe('https://www.wavespestcontrol.com/sitemap-index.xml');
  });

  test('the other hub domain also resolves with no fleet_sites row', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    load([]);

    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'waveslawncare.com' });
    expect(result.error).toBeUndefined();
    expect(result.site).toEqual({ domain: 'waveslawncare.com', name: 'Waves Lawn Care (hub)', area: 'hub' });
  });

  test('a substring is never enough — a partial phrase does not resolve to a fleet site it merely contains', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    load([{ domain: 'bradentonflpestcontrol.com', name: 'Bradenton Pest Control', area: 'Bradenton' }]);

    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'bradenton' });
    // No row named exactly "bradenton" — refused, with the fuller domain
    // offered as a close match, never silently picked.
    expect(result.error).toMatch(/not a tracked site/);
    expect(result.error).toMatch(/Close matches: bradentonflpestcontrol\.com/);
    expect(result.site).toBeUndefined();
  });

  test('wildcard characters in the input are literal, never SQL/LIKE wildcards — they never widen the match', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    load([
      { domain: 'bradentonflpestcontrol.com', name: 'Bradenton Pest Control', area: 'Bradenton' },
      { domain: 'sarasotaflpestcontrol.com', name: 'Sarasota Pest Control', area: 'Sarasota' },
    ]);

    // Under the old `%${domain}%` substring query, "%.com" would have been
    // interpreted as a LIKE pattern matching every row ending in ".com".
    const result = await executeSeoTool('submit_gsc_sitemap', { domain: '%.com' });
    expect(result.error).toMatch(/not a tracked site/);
    expect(result.error).not.toMatch(/Close matches/);
    expect(result.site).toBeUndefined();
  });

  test('several tracked rows exactly sharing a domain is a refusal, never an arbitrary pick', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    // A spoke domain: hub domains no longer query fleet_sites at all, so the
    // ambiguity guard is exercised on a spoke row instead.
    load([
      { domain: 'bradentonflpestcontrol.com', name: 'Bradenton Pest Control (dup 1)', area: 'Bradenton' },
      { domain: 'BradentonFLPestControl.com', name: 'Bradenton Pest Control (dup 2)', area: 'Bradenton' },
    ]);

    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'bradentonflpestcontrol.com' });
    expect(result.error).toMatch(/Multiple tracked sites share the domain/);
  });

  test('a custom sitemap_path overrides the @astrojs/sitemap default', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    load([]);

    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'wavespestcontrol.com', sitemap_path: '/sitemap.xml' });
    expect(result.error).toBeUndefined();
    expect(result.sitemap_url).toBe('https://wavespestcontrol.com/sitemap.xml');
  });

  test('a domain not in the tracked fleet list is refused — no card for an untracked target', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    load([]);

    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'unknown-site.com' });
    expect(result.error).toMatch(/"unknown-site\.com" is not a tracked site/);
    expect(result.site).toBeUndefined();
  });

  test('missing domain refuses before any DB call', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    const dbMock = load([]);

    const result = await executeSeoTool('submit_gsc_sitemap', {});
    expect(result.error).toMatch(/domain/);
    expect(dbMock).not.toHaveBeenCalled();
  });

  test('the property is resolved in its sc-domain: form when that is what is actually verified', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    load([{ domain: 'bradentonflpestcontrol.com', name: 'Bradenton Pest Control', area: 'Bradenton' }]);
    mockResolveAccessibleProperty.mockResolvedValue({ siteUrl: 'sc-domain:bradentonflpestcontrol.com', permissionLevel: 'siteOwner' });

    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'bradentonflpestcontrol.com' });
    expect(result.error).toBeUndefined();
    expect(result.property).toBe('sc-domain:bradentonflpestcontrol.com');
    // The feedpath (sitemap_url) is still a real crawlable URL, independent
    // of which property form Search Console verified.
    expect(result.sitemap_url).toBe('https://bradentonflpestcontrol.com/sitemap-index.xml');
    expect(result.note).toContain('sc-domain:bradentonflpestcontrol.com');
  });

  test('a domain the fleet registry tracks but this service account cannot reach in EITHER property form is refused, never a synthesized URL', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    load([{ domain: 'bradentonflpestcontrol.com', name: 'Bradenton Pest Control', area: 'Bradenton' }]);
    mockResolveAccessibleProperty.mockResolvedValue({ error: 'not_accessible', checked: ['https://bradentonflpestcontrol.com/', 'sc-domain:bradentonflpestcontrol.com'] });

    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'bradentonflpestcontrol.com' });
    expect(result.error).toMatch(/is accessible to this service account/);
    expect(result.error).toContain('https://bradentonflpestcontrol.com/');
    expect(result.error).toContain('sc-domain:bradentonflpestcontrol.com');
    expect(result.preview).toBeUndefined();
    expect(result.property).toBeUndefined();
  });

  test('a GSC init/list failure surfaces as a refusal, never a synthesized property', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    load([]);
    mockResolveAccessibleProperty.mockResolvedValue({ error: 'Google Search Console is not configured or failed to initialize.' });

    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'wavespestcontrol.com' });
    expect(result.error).toMatch(/failed to initialize/);
    expect(result.preview).toBeUndefined();
  });

  test('missing GOOGLE_SERVICE_ACCOUNT_JSON stays the existing configured:false refusal and never reaches property resolution', async () => {
    const dbMock = load([]);
    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'wavespestcontrol.com' });
    expect(result.configured).toBe(false);
    expect(dbMock).not.toHaveBeenCalled();
    expect(mockResolveAccessibleProperty).not.toHaveBeenCalled();
  });

  test('confirmed:true refuses — the commit path is not built in this PR', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
    const dbMock = load([]);

    const result = await executeSeoTool('submit_gsc_sitemap', { domain: 'wavespestcontrol.com', confirmed: true });
    expect(result.error).toMatch(/not enabled yet/);
    expect(result.code).toBe('not_yet_implemented');
    expect(dbMock).not.toHaveBeenCalled();
  });
});
