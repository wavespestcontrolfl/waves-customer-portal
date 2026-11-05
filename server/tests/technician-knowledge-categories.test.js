/**
 * Technician visibility audit (pack 2a): B3 / B19 - every knowledge read for a
 * TECHNICIAN returns field categories only, with vendor price lines and dollar
 * tokens removed. An admin read is unchanged.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const ROWS = [
  { id: 1, path: 'kb/chemicals/product-sample-herbicide.md', title: 'Sample Herbicide', category: 'chemicals', summary: 'Pre-emergent', content: '**Sample Herbicide**\nBest Price: $139.50 (Test Vendor)\nSignal Word: Caution', tags: [] },
  { id: 2, path: 'kb/pricing/cogs-lawn.md', title: 'Lawn COGS Breakdown', category: 'pricing', summary: 'Unit costs', content: 'cost_per_unit $0.42', tags: [] },
  { id: 3, path: 'wiki/techs/technician-profiles.md', title: 'Technician Profile', category: 'techs', summary: 'Revenue per route hour', content: 'Upsell rate 31%', tags: [] },
  { id: 4, path: 'wiki/_summaries.md', title: 'Summaries', category: 'index', summary: 's', content: 'every article', tags: [] },
  { id: 5, path: 'kb/protocols/protocol-pest.md', title: 'Pest Program', category: 'protocols', summary: 'Quarterly', content: 'Visit 1: Demand CS ($2.18)\nOPTIONAL if requested - $15', tags: [] },
];
const mockWhereInCalls = [];

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/knowledge-index/hybrid-search', () => ({ hybridKnowledgeSearch: jest.fn() }));
jest.mock('../models/db', () => jest.fn((table) => {
  let categories = null;
  let paths = null;
  const visible = () => ROWS.filter((r) => (!categories || categories.includes(r.category)) && (!paths || paths.includes(r.path)));
  const qb = {
    where() { return qb; },
    whereNot() { return qb; },
    whereIn(col, list) {
      mockWhereInCalls.push({ table, col, list });
      if (col === 'category') categories = list;
      if (col === 'path') paths = list;
      return qb;
    },
    whereRaw() { return qb; },
    orWhere() { return qb; },
    limit() { return qb; },
    select() { return qb; },
    groupBy() { return qb; },
    count() { return Promise.resolve(visible().map((r) => ({ category: r.category, count: '1' }))); },
    first() { return Promise.resolve(visible()[0]); },
    insert: jest.fn(async () => {}),
    orderBy() { return qb; },
    then(resolve, reject) { return Promise.resolve(table === 'knowledge_base' ? visible().map((r) => ({ ...r })) : []).then(resolve, reject); },
  };
  return qb;
}));

const { dispatchWithFallback } = require('../services/llm/call');
const WikiQA = require('../services/knowledge/wiki-qa');
const {
  TECHNICIAN_KNOWLEDGE_CATEGORIES, technicianKnowledgeRow, technicianKnowledgeRows, knowledgeAudience,
} = require('../services/knowledge/technician-categories');

const TECH_CONTEXT = { source: 'tech_field', audience: 'technician' };
const prompts = () => dispatchWithFallback.mock.calls.map((c) => `${c[1].system || ''}\n${c[1].text || ''}`).join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  dispatchWithFallback.mockReset();
  mockWhereInCalls.length = 0;
  process.env.ANTHROPIC_API_KEY = 'test';
});

describe('the technician category allow-list', () => {
  test('names field categories only: no pricing, strategy, operations, credentials, integrations or techs', () => {
    expect(TECHNICIAN_KNOWLEDGE_CATEGORIES).toEqual(expect.arrayContaining(['protocols', 'chemicals']));
    for (const internal of ['pricing', 'business-strategy', 'operations', 'credentials', 'integrations', 'techs', 'customers', 'services', 'competitive']) {
      expect(TECHNICIAN_KNOWLEDGE_CATEGORIES).not.toContain(internal);
    }
  });

  test('a product page loses its vendor price line; a pricing row and a row with no category are withheld', () => {
    const page = technicianKnowledgeRow(ROWS[0]);
    expect(page.content).toBe('**Sample Herbicide**\nSignal Word: Caution');
    expect(technicianKnowledgeRow(ROWS[1])).toBeNull();
    expect(technicianKnowledgeRow(ROWS[2])).toBeNull();
    expect(technicianKnowledgeRow({ id: 9, content: 'x' })).toBeNull();
    expect(technicianKnowledgeRows(ROWS).map((r) => r.id)).toEqual([1, 5]);
  });

  test('priced protocol lines lose their dollar tokens', () => {
    const { content } = technicianKnowledgeRow(ROWS[4]);
    expect(content).not.toMatch(/\$/);
    expect(content).toContain('Demand CS');
  });

  test('only a technician request gets an audience; an admin gets none', () => {
    expect(knowledgeAudience({ techRole: 'technician' })).toEqual(TECH_CONTEXT);
    expect(knowledgeAudience({ techRole: 'admin' })).toBeNull();
  });
});

describe('WikiQA for a technician', () => {
  function routeTo(paths) {
    dispatchWithFallback
      .mockResolvedValueOnce({ ok: true, json: { paths } })
      .mockResolvedValueOnce({ ok: true, text: 'the answer' });
  }

  test('the model sees only field-category articles, with vendor prices removed', async () => {
    routeTo(['kb/chemicals/product-sample-herbicide.md', 'kb/pricing/cogs-lawn.md']);
    const result = await WikiQA.query('what herbicide', TECH_CONTEXT);
    const categoryFilters = mockWhereInCalls.filter((c) => c.col === 'category');
    expect(categoryFilters.length).toBeGreaterThanOrEqual(2); // index and article read
    expect(categoryFilters.every((c) => c.list === TECHNICIAN_KNOWLEDGE_CATEGORIES)).toBe(true);
    expect(prompts()).toContain('Signal Word: Caution');
    expect(prompts()).not.toMatch(/Best Price|Test Vendor|139\.50/);
    expect(prompts()).not.toContain('cost_per_unit');
    expect(prompts()).not.toContain('technician-profiles');
    expect(result.articlesUsed).toEqual(['kb/chemicals/product-sample-herbicide.md']);
  });

  test('an admin question reads every category and keeps the article as stored', async () => {
    routeTo(['kb/chemicals/product-sample-herbicide.md']);
    await WikiQA.query('what herbicide', { source: 'tech_field' });
    expect(mockWhereInCalls.filter((c) => c.col === 'category')).toEqual([]);
    expect(prompts()).toContain('Best Price: $139.50 (Test Vendor)');
  });

  test('lookup, search, category and list reads are limited for a technician', async () => {
    expect(await WikiQA.lookup('herbicide', TECH_CONTEXT)).toBe('**Sample Herbicide**\nSignal Word: Caution');
    const found = await WikiQA.search('herbicide', 20, TECH_CONTEXT);
    expect(found.map((r) => r.category)).toEqual(['chemicals', 'protocols']);
    expect(found[0].summary).toBe('Pre-emergent');
    const listed = await WikiQA.listAll(TECH_CONTEXT);
    expect(listed.map((r) => r.category)).toEqual(['chemicals', 'protocols']);
    expect(await WikiQA.getCategory('pricing', TECH_CONTEXT)).toEqual([]);
  });

  test('lookup, search and list for an admin return every category', async () => {
    const listed = await WikiQA.listAll(null);
    expect(listed.map((r) => r.category)).toEqual(['chemicals', 'pricing', 'techs', 'index', 'protocols']);
    expect(await WikiQA.lookup('herbicide')).toContain('Best Price: $139.50');
  });
});
