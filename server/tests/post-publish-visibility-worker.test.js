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

function makeDbMock() {
  const calls = [];
  db.mockImplementation((table) => {
    const chain = {
      table,
      where: jest.fn(() => chain),
      whereIn: jest.fn(() => chain),
      count: jest.fn(() => chain),
      first: jest.fn(async () => (table === 'content_internal_link_tasks' ? { count: 1 } : null)),
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
  });
});
