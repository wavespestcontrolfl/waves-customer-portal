/**
 * Technician visibility audit (pack 2a): B3 / B19 / A route reach - the REST
 * knowledge routes return field categories only for a TECHNICIAN login (list,
 * get, search, article, query). An admin login keeps every category and the
 * stored text.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const ROWS = [
  { id: 1, path: 'kb/chemicals/product-sample-herbicide.md', title: 'Sample Herbicide', category: 'chemicals', summary: 'Pre-emergent', content: '**Sample Herbicide**\nBest Price: $139.50 (Test Vendor)\nSignal Word: Caution', tags: '[]', backlinks: '[]', source_documents: '[]' },
  { id: 2, path: 'kb/pricing/cogs-lawn.md', title: 'Lawn COGS Breakdown', category: 'pricing', summary: 'Unit costs', content: 'cost_per_unit $0.42', tags: '[]', backlinks: '[]', source_documents: '[]' },
  { id: 3, path: 'wiki/techs/technician-profiles.md', title: 'Technician Profile', category: 'techs', summary: 'Revenue per route hour', content: 'Upsell rate 31%', tags: '[]', backlinks: '[]', source_documents: '[]' },
  { id: 4, path: 'wiki/_summaries.md', title: 'Summaries', category: 'index', summary: 's', content: 'every article', tags: '[]', backlinks: '[]', source_documents: '[]' },
];
const mockQuery = jest.fn();

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/knowledge/wiki-compiler', () => ({}));
jest.mock('../services/knowledge/wiki-linter', () => ({}));
jest.mock('../services/knowledge/knowledge-gaps-weekly', () => ({ withoutSavedGaps: (q) => q }));
jest.mock('../services/knowledge/wiki-qa', () => {
  const actual = jest.requireActual('../services/knowledge/wiki-qa');
  actual.query = (...args) => mockQuery(...args);
  return actual;
});
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../models/db', () => jest.fn((table) => {
  let categories = null;
  let id = null;
  let pathEq = null;
  const visible = () => ROWS.filter((r) => (!categories || categories.includes(r.category))
    && (id == null || String(r.id) === String(id)) && (pathEq == null || r.path === pathEq));
  const qb = {
    where(a, b) {
      if (a === 'id') id = b;
      if (a === 'path') pathEq = b;
      return qb;
    },
    whereNot() { return qb; },
    whereIn(col, list) { if (col === 'category') categories = list; return qb; },
    whereRaw() { return qb; },
    select() { return qb; },
    groupBy() { return qb; },
    orderBy() { return qb; },
    count() { return qb; },
    first() { return Promise.resolve(visible()[0] ? { ...visible()[0] } : undefined); },
    then(resolve, reject) { return Promise.resolve(table === 'knowledge_base' ? visible().map((r) => ({ ...r })) : []).then(resolve, reject); },
  };
  return qb;
}));
jest.mock('../services/knowledge-base', () => ({
  search: jest.fn(async (q, opts) => ROWS.filter((r) => !opts.categories || opts.categories.includes(r.category)).map((r) => ({ ...r }))),
  list: jest.fn(async (opts) => {
    const entries = ROWS.filter((r) => !opts.categories || opts.categories.includes(r.category)).map((r) => ({ ...r }));
    return { entries, total: entries.length };
  }),
  getById: jest.fn(async (id) => { const r = ROWS.find((x) => String(x.id) === String(id)); return r ? { ...r } : undefined; }),
  getAudits: jest.fn(async () => [{ findings: 'quotes Best Price $139.50' }]),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Admin authentication required' });
    req.techRole = token;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).end()),
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).end()),
}));

const express = require('express');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/kb', require('../routes/admin-kb'));
  // index.js mounts this router behind the staff auth; the router has none of its own.
  const auth = require('../middleware/admin-auth');
  app.use('/knowledge', auth.adminAuthenticate, auth.requireTechOrAdmin, require('../routes/knowledge'));
  app.use('/admin-knowledge', require('../routes/admin-knowledge'));
  app.use('/tech-knowledge', require('../routes/tech-knowledge'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const get = async (baseUrl, path, role) => {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${role}` } });
  return { status: res.status, body: await res.json() };
};

beforeEach(() => { jest.clearAllMocks(); mockQuery.mockResolvedValue({ answer: 'a', articlesUsed: [] }); });

describe('/kb (admin-kb)', () => {
  test('a technician list, search and get return field categories only, with the vendor price removed', async () => {
    await withServer(async (baseUrl) => {
      const list = await get(baseUrl, '/kb', 'technician');
      expect(list.body.entries.map((e) => e.category)).toEqual(['chemicals']);
      expect(JSON.stringify(list.body)).not.toMatch(/Best Price|Test Vendor/);
      const search = await get(baseUrl, '/kb/search?q=herbicide', 'technician');
      expect(search.body.results.map((e) => e.category)).toEqual(['chemicals']);
      const field = await get(baseUrl, '/kb/1', 'technician');
      expect(field.body.entry.content).toBe('**Sample Herbicide**\nSignal Word: Caution');
      expect(field.body.audits).toEqual([]);
      for (const hidden of [2, 3, 4]) expect((await get(baseUrl, `/kb/${hidden}`, 'technician')).status).toBe(404);
    });
  });

  test('an admin gets every category and the stored text', async () => {
    await withServer(async (baseUrl) => {
      const list = await get(baseUrl, '/kb', 'admin');
      expect(list.body.entries).toHaveLength(4);
      expect((await get(baseUrl, '/kb/1', 'admin')).body.entry.content).toContain('Best Price: $139.50');
      expect((await get(baseUrl, '/kb/2', 'admin')).status).toBe(200);
      expect((await get(baseUrl, '/kb/1', 'admin')).body.audits).toHaveLength(1);
    });
  });
});

describe('/knowledge (dispatch module)', () => {
  test('a technician cannot list, fetch or open a non-field article', async () => {
    await withServer(async (baseUrl) => {
      expect((await get(baseUrl, '/knowledge?category=pricing', 'technician')).body).toEqual([]);
      expect((await get(baseUrl, '/knowledge', 'technician')).body.map((r) => r.category)).toEqual(['chemicals']);
      expect((await get(baseUrl, '/knowledge/article?path=kb/pricing/cogs-lawn.md', 'technician')).status).toBe(404);
      expect((await get(baseUrl, '/knowledge/article?path=wiki/techs/technician-profiles.md', 'technician')).status).toBe(404);
      const field = await get(baseUrl, '/knowledge/article?path=kb/chemicals/product-sample-herbicide.md', 'technician');
      expect(field.body.content).not.toMatch(/Best Price|Test Vendor/);
    });
  });

  test('an admin still opens any article as stored', async () => {
    await withServer(async (baseUrl) => {
      expect((await get(baseUrl, '/knowledge/article?path=kb/pricing/cogs-lawn.md', 'admin')).status).toBe(200);
      expect((await get(baseUrl, '/knowledge/article?path=kb/chemicals/product-sample-herbicide.md', 'admin')).body.content).toContain('Best Price');
    });
  });

  test('a technician question carries the technician audience whatever the body says; an admin body passes through', async () => {
    await withServer(async (baseUrl) => {
      const ask = (role, body) => fetch(`${baseUrl}/knowledge/query`, {
        method: 'POST', headers: { Authorization: `Bearer ${role}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      await ask('technician', { question: 'q', context: { source: 'admin_manual', audience: 'admin' } });
      expect(mockQuery).toHaveBeenLastCalledWith('q', { source: 'tech_field', audience: 'technician' });
      await ask('admin', { question: 'q', context: { source: 'admin_manual' } });
      expect(mockQuery).toHaveBeenLastCalledWith('q', { source: 'admin_manual' });
    });
  });
});

describe('/admin/knowledge', () => {
  test('a technician list and article read return field categories only; wiki/_summaries.md is a 404', async () => {
    await withServer(async (baseUrl) => {
      const list = await get(baseUrl, '/admin-knowledge', 'technician');
      expect(list.body.articles.map((a) => a.category)).toEqual(['chemicals']);
      expect(Object.keys(list.body.categoryCounts)).toEqual(['chemicals']);
      expect((await get(baseUrl, '/admin-knowledge/article/4', 'technician')).status).toBe(404);
      expect((await get(baseUrl, '/admin-knowledge/article/2', 'technician')).status).toBe(404);
      const field = await get(baseUrl, '/admin-knowledge/article/1', 'technician');
      expect(field.body.article.content).not.toMatch(/Best Price/);
    });
  });

  test('an admin reads every article, including the summaries file', async () => {
    await withServer(async (baseUrl) => {
      expect((await get(baseUrl, '/admin-knowledge/article/4', 'admin')).status).toBe(200);
      expect((await get(baseUrl, '/admin-knowledge/article/1', 'admin')).body.article.content).toContain('Best Price');
    });
  });

  test('a technician query carries the technician audience; an admin query does not', async () => {
    await withServer(async (baseUrl) => {
      const ask = (role) => fetch(`${baseUrl}/admin-knowledge/query`, {
        method: 'POST', headers: { Authorization: `Bearer ${role}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'q', source: 'ai_assistant' }),
      });
      await ask('technician');
      expect(mockQuery).toHaveBeenLastCalledWith('q', { source: 'tech_field', audience: 'technician' });
      await ask('admin');
      expect(mockQuery).toHaveBeenLastCalledWith('q', { source: 'ai_assistant' });
    });
  });
});
