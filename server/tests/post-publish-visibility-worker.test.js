jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const Worker = require('../services/content/post-publish-visibility-worker');

function ok(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  });
}

function html() {
  return `
    <html>
      <head>
        <link rel="canonical" href="https://www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida/">
        <script type="application/ld+json">{"@type":"BlogPosting","publisher":{"@type":"Organization","name":"Waves"}}</script>
      </head>
      <body>
        <p>Ghost ants in Southwest Florida kitchens usually follow moisture, crumbs, and entry points after rain. Homeowners can dry the sink area, reduce food access, and check whether trails return.</p>
        <p>When the issue keeps returning, call Waves for an inspection and quote.</p>
        <h2>Key takeaways</h2><p>Lakewood Ranch, Bradenton, and Sarasota homes often see ant pressure after rain.</p>
        <h2>What Waves sees locally</h2><p>Technician observations connect activity with moisture and exterior gaps.</p>
        <h2>Frequently Asked Questions</h2><p>Reviewed by Waves Pest Control.</p>
      </body>
    </html>
  `;
}

function makeDbMock({ linkTaskCount = 1 } = {}) {
  const calls = [];
  db.mockImplementation((table) => {
    const chain = {
      table,
      where: jest.fn(() => chain),
      whereIn: jest.fn(() => chain),
      count: jest.fn(() => chain),
      first: jest.fn(async () => (table === 'content_internal_link_tasks' ? { count: linkTaskCount } : null)),
      insert: jest.fn(async (row) => { calls.push({ table, op: 'insert', row }); return [row]; }),
      update: jest.fn(async (row) => { calls.push({ table, op: 'update', row }); return 1; }),
    };
    return chain;
  });
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return calls;
}

describe('post-publish-visibility-worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('records live visibility snapshot into content_index_status and registry', async () => {
    const calls = makeDbMock();
    const fetchFn = jest.fn((url) => {
      if (String(url).endsWith('/robots.txt')) return ok('User-agent: *\nAllow: /');
      return ok(html());
    });
    const sitemap = { invalidate: jest.fn(), hasUrl: jest.fn().mockResolvedValue({ present: true }) };
    const indexNow = { submit: jest.fn().mockResolvedValue({ ok: true, status: 'ok' }) };

    const result = await Worker.runForPost({
      id: 'post_1',
      astro_live_url: 'https://www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida/',
      title: 'Why are ghost ants in my kitchen?',
      target_keyword: 'why are ghost ants in my kitchen',
    }, { fetchFn, sitemap, indexNow });

    expect(result.ok).toBe(true);
    expect(result.snapshot.sitemap_present).toBe(true);
    expect(result.snapshot.indexnow_status).toBe('ok');
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'content_index_status', op: 'insert' }),
      expect.objectContaining({ table: 'content_registry', op: 'update' }),
    ]));
    const linkTaskQuery = db.mock.results
      .map((result) => result.value)
      .find((chain) => chain.table === 'content_internal_link_tasks');
    expect(linkTaskQuery.whereIn).toHaveBeenCalledWith('target_url', expect.arrayContaining([
      'https://www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida/',
      'www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida',
      '/blog/ghost-ants-kitchen-florida/',
      '/blog/ghost-ants-kitchen-florida',
    ]));
    expect(linkTaskQuery.whereIn).toHaveBeenCalledWith('status', ['pending', 'queued', 'patch_candidate', 'approved', 'applied']);
  });

  test('counts a crawlable live blog index link when link tasks have not applied', async () => {
    makeDbMock({ linkTaskCount: 0 });
    const fetchFn = jest.fn((url) => {
      if (String(url).endsWith('/robots.txt')) return ok('User-agent: *\nAllow: /');
      if (String(url).endsWith('/blog/')) {
        return ok('<html><body><a href="/blog/ghost-ants-kitchen-florida/">Ghost ants in Florida kitchens</a></body></html>');
      }
      return ok(html());
    });
    const sitemap = { invalidate: jest.fn(), hasUrl: jest.fn().mockResolvedValue({ present: true }) };
    const indexNow = { submit: jest.fn().mockResolvedValue({ ok: true, status: 'ok' }) };

    const result = await Worker.runForPost({
      id: 'post_1',
      astro_live_url: 'https://www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida/',
      title: 'Why are ghost ants in my kitchen?',
      target_keyword: 'why are ghost ants in my kitchen',
    }, { fetchFn, sitemap, indexNow });

    expect(result.ok).toBe(true);
    expect(result.snapshot.internal_inbound_links).toBe(1);
    expect(result.snapshot.ai_visibility.findings.some((f) => f.code === 'P0_NO_CRAWLABLE_INBOUND_INTERNAL_LINK')).toBe(false);
  });

  test('builds inbound-link target variants for relative planner paths', () => {
    expect(Worker._internals.inboundLinkTargetVariants('https://www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida/')).toEqual(expect.arrayContaining([
      'https://www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida/',
      'www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida',
      '/blog/ghost-ants-kitchen-florida/',
      '/blog/ghost-ants-kitchen-florida',
    ]));
  });
});
