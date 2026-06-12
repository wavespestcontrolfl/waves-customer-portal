jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));

const SiteAuditor = require('../services/seo/site-auditor');
const CannibalizationDetector = require('../services/seo/cannibalization');
const SeoActionGenerator = require('../services/seo/seo-action-generator');
const UrlIntelligence = require('../services/seo/url-intelligence');
const SearchConsole = require('../services/seo/search-console-v2');
const pageAuditDomainRepair004 = require('../models/migrations/20260526000004_repair_seo_page_audit_domains');
const pageAuditDomainRepair005 = require('../models/migrations/20260526000005_repair_seo_page_audit_domains_without_knex_placeholders');
const db = require('../models/db');

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  db.mockReset();
  delete db.raw;
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('SEO Command Center guards', () => {
  function makeQueryBuilder(result, overrides = {}) {
    const builder = {
      where: jest.fn(() => builder),
      orderBy: jest.fn(() => builder),
      orderByRaw: jest.fn(() => builder),
      limit: jest.fn(() => builder),
      first: jest.fn(() => Promise.resolve(result)),
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
      ...overrides,
    };
    return builder;
  }

  test('site audit rejects unsupported target domains before server-side fetch setup', async () => {
    db.mockClear();

    await expect(SiteAuditor.runSiteAudit({ domain: 'https://127.0.0.1/admin' }))
      .rejects
      .toThrow(/Unsupported SEO audit domain/);
    expect(db).not.toHaveBeenCalled();
  });

  test('site audit dashboard reads page rows using the Eastern audit date', async () => {
    const latestRun = {
      id: 'run-1',
      domain: 'wavespestcontrol.com',
      status: 'completed',
      run_date: new Date('2026-05-24T01:45:18.000Z'),
    };
    const runBuilders = [
      makeQueryBuilder(latestRun),
      makeQueryBuilder([latestRun]),
    ];
    const pagesBuilder = makeQueryBuilder([]);
    const issuesBuilder = makeQueryBuilder([]);

    db.mockImplementation((table) => {
      if (table === 'seo_site_audit_runs') return runBuilders.shift();
      if (table === 'seo_page_audits') return pagesBuilder;
      if (table === 'seo_audit_issue_trends') return issuesBuilder;
      throw new Error(`Unexpected table ${table}`);
    });

    const result = await SiteAuditor.getDashboard('wavespestcontrol.com');

    expect(result.hasData).toBe(true);
    expect(pagesBuilder.where).toHaveBeenCalledWith('audit_date', '2026-05-23');
    expect(pagesBuilder.where).not.toHaveBeenCalledWith('audit_date', '2026-05-24');
  });

  test('cannibalization detector uses countDistinct for page counts', async () => {
    const queryBuilder = makeQueryBuilder([], {
      clone: jest.fn(() => queryBuilder),
      select: jest.fn(() => queryBuilder),
      countDistinct: jest.fn(() => queryBuilder),
      count: jest.fn(() => queryBuilder),
      sum: jest.fn(() => queryBuilder),
      groupBy: jest.fn(() => queryBuilder),
      having: jest.fn(() => queryBuilder),
    });

    db.raw = jest.fn((sql) => ({ sql }));
    db.mockImplementation((table) => {
      expect(table).toBe('gsc_query_page_map');
      return queryBuilder;
    });

    await CannibalizationDetector.detect('wavespestcontrol.com');

    expect(queryBuilder.countDistinct).toHaveBeenCalledWith({ page_count: 'page_url' });
    expect(queryBuilder.count).not.toHaveBeenCalled();
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

  test('site audit recognizes H1 text wrapped in nested hero spans', async () => {
    delete process.env.GOOGLE_API_KEY;

    const audit = await SiteAuditor.auditPage(
      'https://www.wavespestcontrol.com/ant-control-bradenton-fl/',
      `
        <title>Ant Control in Bradenton, FL</title>
        <meta name="description" content="Ant control in Bradenton">
        <h1 class="mobile-critical-heading">
          <span>Ant Control in</span>
          <span class="block">Bradenton, FL</span>
        </h1>
        <h2><span>How Bradenton Ant Treatment Works</span></h2>
        <p>${'Local ant control details. '.repeat(80)}</p>
      `,
      200,
      42,
      null,
      null,
      'service_page',
      'https://www.wavespestcontrol.com/',
    );

    const issues = JSON.parse(audit.issues);
    expect(audit.h1_text).toBe('Ant Control in Bradenton, FL');
    expect(issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'missing_h1' }),
    ]));
  });

  test('site audit recognizes FAQPage in JSON-LD arrays and graphs', async () => {
    delete process.env.GOOGLE_API_KEY;

    const audit = await SiteAuditor.auditPage(
      'https://www.wavespestcontrol.com/lawn-care/core-aeration-in-venice-fl/',
      `
        <title>Core Aeration in Venice, FL</title>
        <meta name="description" content="Core aeration for Venice lawns">
        <h1>Core Aeration in Venice, FL</h1>
        <h2>Frequently Asked Questions</h2>
        <p>${'Core aeration details. '.repeat(80)}</p>
        <script type="application/ld+json">
          [
            {
              "@context": "https://schema.org",
              "@type": "BlogPosting",
              "headline": "Core Aeration in Venice, FL"
            },
            {
              "@context": "https://schema.org",
              "@type": "FAQPage",
              "mainEntity": []
            },
            {
              "@context": "https://schema.org",
              "@graph": [
                { "@type": ["LocalBusiness", "Organization"], "name": "Waves Pest Control" },
                { "@type": "Service", "name": "Core Aeration" }
              ]
            }
          ]
        </script>
      `,
      200,
      42,
      null,
      null,
      'service_page',
      'https://www.wavespestcontrol.com/',
    );

    const issues = JSON.parse(audit.issues);
    expect(JSON.parse(audit.schema_types_found)).toEqual(expect.arrayContaining([
      'BlogPosting',
      'FAQPage',
      'LocalBusiness',
      'Organization',
      'Service',
    ]));
    expect(audit.has_faq_schema).toBe(true);
    expect(issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'missing_faqpage' }),
    ]));
  });

  test('site audit never flags long titles — keyword-rich city-page titles are an intentional SEO play', async () => {
    delete process.env.GOOGLE_API_KEY;

    const longTitle = 'Pest Control Bradenton FL | Exterminator Near Me | ' +
      'Ant, Roach, Rodent & Mosquito Control | '.repeat(10) + 'Waves Pest Control';
    const pageHtml = (title) => `
        <title>${title}</title>
        <meta name="description" content="Pest control in Bradenton">
        <h1>Pest Control in Bradenton, FL</h1>
        <h2>Service Plans</h2>
        <p>${'Local pest control details. '.repeat(80)}</p>
      `;
    const auditOf = (title) => SiteAuditor.auditPage(
      'https://www.wavespestcontrol.com/pest-control-bradenton-fl/',
      pageHtml(title),
      200,
      42,
      null,
      null,
      'service_page',
      'https://www.wavespestcontrol.com/',
    );

    const longAudit = await auditOf(longTitle);
    const shortAudit = await auditOf('Pest Control Bradenton FL');

    const issues = JSON.parse(longAudit.issues);
    expect(issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'title_too_long' }),
    ]));
    expect(longAudit.meta_title_length).toBeGreaterThan(60); // raw length still reported as data
    // The identical page must score the same regardless of title length —
    // the long title is the play, not a defect.
    expect(longAudit.technical_health_score).toBe(shortAudit.technical_health_score);
  });

  test('site audit PageSpeed fetch uses a timeout signal', async () => {
    process.env.GOOGLE_API_KEY = 'test-key';
    process.env.SEO_PAGESPEED_TIMEOUT_MS = '1234';
    const originalFetch = global.fetch;
    const originalTimeout = AbortSignal.timeout;
    const signal = new AbortController().signal;
    global.fetch = jest.fn().mockResolvedValue({ ok: false });
    AbortSignal.timeout = jest.fn(() => signal);

    try {
      const result = await SiteAuditor.getPageSpeedScores('https://www.wavespestcontrol.com/');

      expect(result).toEqual({
        pagespeed_mobile_score: null,
        lcp_ms: null,
        inp_ms: null,
        cls_numeric: null,
        cwv_pass: null,
      });
      expect(AbortSignal.timeout).toHaveBeenCalledWith(1234);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('pagespeedonline/v5/runPagespeed'),
        { signal },
      );
    } finally {
      global.fetch = originalFetch;
      AbortSignal.timeout = originalTimeout;
    }
  });

  test('GSC searchanalytics requests use a timeout option', async () => {
    process.env.GSC_REQUEST_TIMEOUT_MS = '4321';
    const originalWebmasters = SearchConsole.webmasters;
    const query = jest.fn().mockResolvedValue({ data: { rows: [] } });
    SearchConsole.webmasters = { searchanalytics: { query } };

    try {
      await SearchConsole.syncQueries(
        '2026-05-15',
        '2026-05-22',
        'https://www.wavespestcontrol.com/',
      );

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          siteUrl: 'https://www.wavespestcontrol.com/',
          requestBody: expect.objectContaining({
            dimensions: ['query', 'date'],
            rowLimit: 5000,
          }),
        }),
        { timeout: 4321 },
      );

      query.mockClear();
      const controller = new AbortController();
      await SearchConsole.syncQueries(
        '2026-05-15',
        '2026-05-22',
        'https://www.wavespestcontrol.com/',
        { signal: controller.signal },
      );

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          siteUrl: 'https://www.wavespestcontrol.com/',
          requestBody: expect.objectContaining({
            dimensions: ['query', 'date'],
          }),
        }),
        { timeout: 4321, signal: controller.signal },
      );
    } finally {
      SearchConsole.webmasters = originalWebmasters;
    }
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

  test('page audit domain repair migrations recompute protocol-only domains from URL', async () => {
    for (const migration of [pageAuditDomainRepair004, pageAuditDomainRepair005]) {
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

      await migration.up(knex);

      expect(alterTable).not.toHaveBeenCalled();
      const repairSql = raw.mock.calls[0][0];
      expect(repairSql).toContain("lower(trim(domain)) IN ('http:', 'https:')");
      expect(repairSql).toContain("regexp_replace(lower(trim(url)), '^https://', '')");
      expect(repairSql).toContain("'^http://'");
      expect(repairSql).toContain("'^www[.]'");
      expect(repairSql).toContain('split_part(');
      expect(repairSql).not.toContain('?');
      expect(repairSql).toContain("lower(trim(domain)) LIKE 'https:%'");
      expect(raw.mock.calls[1][0]).toContain("regexp_replace(lower(trim(domain)), '^www[.]', '')");
      expect(raw.mock.calls[1][0]).not.toContain('?');
      expect(raw.mock.calls.at(-1)[0]).toContain('CREATE INDEX IF NOT EXISTS seo_page_audits_domain_index');
    }
  });
});
