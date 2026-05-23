jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));

const SiteAuditor = require('../services/seo/site-auditor');
const SeoActionGenerator = require('../services/seo/seo-action-generator');
const UrlIntelligence = require('../services/seo/url-intelligence');
const pageAuditDomainRepair = require('../models/migrations/20260526000004_repair_seo_page_audit_domains');
const db = require('../models/db');

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('SEO Command Center guards', () => {
  test('site audit rejects unsupported target domains before server-side fetch setup', async () => {
    db.mockClear();

    await expect(SiteAuditor.runSiteAudit({ domain: 'https://127.0.0.1/admin' }))
      .rejects
      .toThrow(/Unsupported SEO audit domain/);
    expect(db).not.toHaveBeenCalled();
  });

  test('site audit counts requested spoke-domain links as internal', async () => {
    delete process.env.GOOGLE_API_KEY;

    const audit = await SiteAuditor.auditPage(
      'https://bradentonflpestcontrol.com/',
      `
        <title>Bradenton Pest Control</title>
        <meta name="description" content="Pest control in Bradenton">
        <h1>Bradenton Pest Control</h1>
        <h2>Service Area</h2>
        <a href="/pest-control/">Pest control</a>
        <a href="https://www.bradentonflpestcontrol.com/contact/">Contact</a>
        <a href="https://bradentonflpestcontrol.com?utm_source=nav">Home</a>
        <a href="https://wavespestcontrol.com/pest-control-bradenton-fl/">Hub page</a>
      `,
      200,
      42,
      null,
      null,
      'service_page',
      'https://bradentonflpestcontrol.com/',
    );

    expect(audit.internal_links_count).toBe(3);
    expect(audit.external_links_count).toBe(1);
    expect(JSON.parse(audit.internal_link_targets)).toEqual([
      '/pest-control/',
      'https://www.bradentonflpestcontrol.com/contact/',
      'https://bradentonflpestcontrol.com',
    ]);
  });

  test('canonical conflict helper rejects spoke-spoke and hub-hub pairs', () => {
    const { hubSpokeConflictPair } = UrlIntelligence._internals;

    expect(hubSpokeConflictPair(
      'https://wavespestcontrol.com/pest-control-bradenton-fl/',
      'https://parrishpestcontrol.com/pest-control/',
    )).toEqual({ spokeIsA: false, hubIsA: true });

    expect(hubSpokeConflictPair(
      'https://parrishpestcontrol.com/pest-control/',
      'https://veniceflpestcontrol.com/pest-control/',
    )).toBeNull();

    expect(hubSpokeConflictPair(
      'https://wavespestcontrol.com/pest-control/',
      'https://waveslawncare.com/lawn-care/',
    )).toBeNull();
  });

  test('SEO action dedupe keys hash normalized URLs instead of storing raw URL text', () => {
    const { buildActionDedupeKey, buildLegacyActionDedupeKey } = SeoActionGenerator._internals;
    const longUrl = `https://www.wavespestcontrol.com/${'very-long-path-segment/'.repeat(20)}?utm_source=test`;

    const key = buildActionDedupeKey('refresh_content', longUrl);

    expect(key).toMatch(/^refresh_content:[a-f0-9]{64}$/);
    expect(key.length).toBeLessThanOrEqual(140);
    expect(key).toBe(buildActionDedupeKey('refresh_content', longUrl.toUpperCase()));
    expect(key).not.toContain('very-long-path-segment');
    expect(buildLegacyActionDedupeKey('refresh_content', longUrl)).toBe(`refresh_content:${longUrl}`);
  });

  test('page audit domain repair migration recomputes protocol-only domains from URL', async () => {
    const raw = jest.fn().mockResolvedValue();
    const alterTable = jest.fn().mockResolvedValue();
    const knex = {
      schema: {
        hasTable: jest.fn().mockResolvedValue(true),
        hasColumn: jest.fn().mockResolvedValue(true),
        alterTable,
      },
      raw,
    };

    await pageAuditDomainRepair.up(knex);

    expect(alterTable).not.toHaveBeenCalled();
    const repairSql = raw.mock.calls[0][0];
    expect(repairSql).toContain("lower(trim(domain)) IN ('http:', 'https:')");
    expect(repairSql).toContain("regexp_replace(lower(trim(url)), '^https?://(www\\.)?', '')");
    expect(repairSql).toContain("lower(trim(domain)) LIKE 'https:%'");
    expect(raw.mock.calls.at(-1)[0]).toContain('CREATE INDEX IF NOT EXISTS seo_page_audits_domain_index');
  });
});
