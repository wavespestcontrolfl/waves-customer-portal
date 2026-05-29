const Gate = require('../services/content/ai-visibility-gate');

const GOOD_HTML = `
  <html>
    <head>
      <link rel="canonical" href="https://www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida/">
      <script type="application/ld+json">{"@type":"BlogPosting","publisher":{"@type":"Organization","name":"Waves Pest Control"}}</script>
    </head>
    <body>
      <main>
        <p>Ghost ants in Southwest Florida kitchens usually follow moisture, crumbs, and small exterior entry points after rain. Homeowners can reduce food access, dry the sink area, and watch whether trails return before scheduling service.</p>
        <p>When trails keep coming back, call Waves for an inspection and a pest control quote.</p>
        <h2>Key takeaways</h2>
        <ul><li>Rain and irrigation can push activity indoors.</li><li>Lakewood Ranch homes often see trails near sinks.</li><li>Recurring trails need a professional inspection.</li></ul>
        <h2>What Waves sees locally</h2>
        <p>Technician observations around Bradenton, Sarasota, and Lakewood Ranch often connect ant pressure with moisture and exterior gaps.</p>
        <h2>Frequently Asked Questions</h2>
        <h3>Why do ghost ants come inside?</h3>
        <p>They follow moisture and food access, especially after rain.</p>
        <p>Reviewed by Waves Pest Control. Last reviewed May 28, 2026.</p>
      </main>
    </body>
  </html>
`;

describe('ai-visibility-gate', () => {
  test('passes crawlable, canonical, answer-first local content', () => {
    const result = Gate.evaluate({
      url: 'https://www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida/',
      html: GOOD_HTML,
      robotsTxt: 'User-agent: *\nAllow: /',
      internalInboundLinks: 1,
      targetKeyword: 'why are ghost ants in my kitchen',
    });

    expect(result.passed).toBe(true);
    expect(result.summary.p0).toBe(0);
  });

  test('blocks noindex, bot disallow, canonical mismatch, and missing inbound link', () => {
    const result = Gate.evaluate({
      url: 'https://www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida/',
      html: '<html><head><meta name="robots" content="noindex"><link rel="canonical" href="https://www.wavespestcontrol.com/blog/ants/"></head><body>Thin page.</body></html>',
      robotsTxt: 'User-agent: OAI-SearchBot\nDisallow: /blog/',
      internalInboundLinks: 0,
    });

    expect(result.passed).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'P0_PAGE_NOINDEX' }),
      expect.objectContaining({ code: 'P0_BOT_BLOCKED_BY_ROBOTS' }),
      expect.objectContaining({ code: 'P0_CANONICAL_POINTS_ELSEWHERE' }),
      expect.objectContaining({ code: 'P0_NO_CRAWLABLE_INBOUND_INTERNAL_LINK' }),
    ]));
  });

  test('does not require FAQPage schema for visible FAQ content', () => {
    const result = Gate.evaluate({
      url: 'https://www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida/',
      html: GOOD_HTML.replace('BlogPosting', 'Article'),
      robotsTxt: '',
      internalInboundLinks: 1,
      targetKeyword: 'why are ghost ants in my kitchen',
    });

    expect(result.findings.some((item) => /FAQPage/.test(item.code))).toBe(false);
  });
});

describe('ai-visibility-gate.evaluateStatic (pre-publish subset)', () => {
  test('passes a good draft and ignores live-only checks (no inbound links / robots.txt)', () => {
    const result = Gate.evaluateStatic({
      url: 'https://www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida/',
      html: GOOD_HTML,
      // deliberately NO robotsTxt and NO internalInboundLinks — the subset
      // must not block a draft that simply isn't live yet.
    });
    expect(result.passed).toBe(true);
    expect(result.summary.p0).toBe(0);
    expect(result.findings.some((f) => f.code === 'P0_NO_CRAWLABLE_INBOUND_INTERNAL_LINK')).toBe(false);
    expect(result.findings.some((f) => f.code === 'P0_BOT_BLOCKED_BY_ROBOTS')).toBe(false);
  });

  test('blocks a noindex draft', () => {
    const html = GOOD_HTML.replace('<head>', '<head><meta name="robots" content="noindex, nofollow">');
    const result = Gate.evaluateStatic({ url: 'https://www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida/', html });
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.code === 'P0_PAGE_NOINDEX')).toBe(true);
  });

  test('blocks a canonical that points elsewhere', () => {
    const result = Gate.evaluateStatic({
      url: 'https://www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida/',
      html: GOOD_HTML,
      canonicalUrl: 'https://www.wavespestcontrol.com/some-other-page/',
    });
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.code === 'P0_CANONICAL_POINTS_ELSEWHERE')).toBe(true);
  });

  test('blocks an empty / unrendered body', () => {
    const result = Gate.evaluateStatic({ url: 'https://www.wavespestcontrol.com/x/', html: '<html><body></body></html>' });
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.code === 'P0_MAIN_CONTENT_NOT_RENDERED')).toBe(true);
  });

  test('blocks schema describing hidden content', () => {
    const result = Gate.evaluateStatic({
      url: 'https://www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida/',
      html: GOOD_HTML,
      schemaMatchesVisibleContent: false,
    });
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.code === 'P0_SCHEMA_DESCRIBES_HIDDEN_CONTENT')).toBe(true);
  });
});
