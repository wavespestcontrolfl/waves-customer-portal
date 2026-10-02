/**
 * WikiQA customer audience (GATE_KB_CUSTOMER_AUDIENCE): customer-facing
 * callers read only the customer-safe knowledge_base categories on every
 * read; staff callers and the gate-off path are unchanged.
 */
const mockWhereIn = [];
const kbRows = [{ path: 'chemicals/price.md', title: 'Wholesale price', summary: 's', category: 'chemicals' }];
const kbArticle = { path: 'chemicals/price.md', title: 'Wholesale price', content: 'WHOLESALE SECRET $42' };
jest.mock('../models/db', () => jest.fn((table) => {
  let paths = null;
  let categories = null; // simulates the DB honoring whereIn('category', ...)
  const qb = {
    where() { return qb; },
    whereNot() { return qb; },
    whereIn(col, list) {
      mockWhereIn.push({ table, col, list });
      if (col === 'path') paths = list;
      if (col === 'category') categories = list;
      return qb;
    },
    whereRaw() { return qb; },
    limit() { return qb; },
    select() { return qb; },
    orderBy() {
      const rows = table === 'knowledge_base' ? kbRows : [];
      return Promise.resolve(categories ? rows.filter((r) => categories.includes(r.category)) : rows);
    },
    insert: jest.fn(async () => {}),
    then(resolve, reject) {
      const rows = (paths || [])
        .filter((p) => p === kbArticle.path && (!categories || categories.includes('chemicals')))
        .map(() => ({ ...kbArticle }));
      return Promise.resolve(rows).then(resolve, reject);
    },
  };
  return qb;
}));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/knowledge-index/hybrid-search', () => ({ hybridKnowledgeSearch: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const { gates } = require('../config/feature-gates');
const { KNOWLEDGE_BASE_CUSTOMER_SAFE_CATEGORIES } = require('../services/knowledge/customer-safe-categories');
const WikiQA = require('../services/knowledge/wiki-qa');

const env = { ...process.env };
const categoryFilters = () => mockWhereIn.filter((c) => c.table === 'knowledge_base' && c.col === 'category');
const allPrompts = () => dispatchWithFallback.mock.calls.map((c) => `${c[1].system || ''}\n${c[1].text || ''}`).join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  dispatchWithFallback.mockReset();
  mockWhereIn.length = 0;
  process.env = { ...env, ANTHROPIC_API_KEY: 'test' };
  delete process.env.GATE_KB_CUSTOMER_AUDIENCE;
  delete process.env.GATE_KB_SPECIES_QA;
  gates.hybridKnowledge = false;
});
const hybridAtLoad = gates.hybridKnowledge;
afterAll(() => { process.env = env; gates.hybridKnowledge = hybridAtLoad; });

function routeTo(paths) {
  dispatchWithFallback
    .mockResolvedValueOnce({ ok: true, json: { paths } })
    .mockResolvedValueOnce({ ok: true, text: 'the answer' });
}

test('the shared allowlist is closed and empty', () => {
  expect(KNOWLEDGE_BASE_CUSTOMER_SAFE_CATEGORIES).toEqual([]);
});

test('(a) gate unset: no category filter on any read, article reaches the prompt', async () => {
  routeTo(['chemicals/price.md']);
  const result = await WikiQA.query('what does it cost', { source: 'ai_assistant' });
  expect(categoryFilters()).toEqual([]);
  expect(allPrompts()).toContain('WHOLESALE SECRET');
  expect(result.articlesUsed).toEqual(['chemicals/price.md']);
});

test('(b) gate on + ai_assistant: every read filtered, no kb text in the prompt, species still answers', async () => {
  process.env.GATE_KB_CUSTOMER_AUDIENCE = 'true';
  process.env.GATE_KB_SPECIES_QA = 'true';
  dispatchWithFallback.mockResolvedValueOnce({ ok: true, text: 'the answer' }); // empty index: no routing call
  const result = await WikiQA.query('ghost ants in the kitchen', { source: 'ai_assistant' });
  expect(categoryFilters().length).toBeGreaterThan(0);
  expect(categoryFilters().every((c) => c.list === KNOWLEDGE_BASE_CUSTOMER_SAFE_CATEGORIES)).toBe(true);
  expect(allPrompts()).not.toContain('WHOLESALE SECRET');
  expect(allPrompts()).not.toContain('chemicals/price.md');
  expect(result.articlesUsed).toEqual(['species:ghost-ant']);
  expect(result.answer).toBe('the answer');
});

test('(b2) a routed path outside the allowlist cannot load (article read is filtered too)', async () => {
  process.env.GATE_KB_CUSTOMER_AUDIENCE = 'true';
  process.env.GATE_KB_SPECIES_QA = 'true';
  // Index is filtered to empty, but if a path were routed the load carries the filter.
  const q = WikiQA.customerAudienceOnly('ai_assistant');
  expect(q).toBe(true);
  dispatchWithFallback.mockResolvedValueOnce({ ok: true, text: 'the answer' });
  await WikiQA.query('ghost ants in the kitchen', { source: 'ai_assistant' });
  expect(mockWhereIn.some((c) => c.col === 'path')).toBe(false);
});

test('(c) gate on + lead_agent: filtered', async () => {
  process.env.GATE_KB_CUSTOMER_AUDIENCE = 'true';
  await WikiQA.query('what does it cost', { source: 'lead_agent' });
  expect(categoryFilters()).toEqual([{ table: 'knowledge_base', col: 'category', list: KNOWLEDGE_BASE_CUSTOMER_SAFE_CATEGORIES }]);
  expect(allPrompts()).not.toContain('WHOLESALE SECRET');
});

test('a missing source counts as customer-facing', async () => {
  process.env.GATE_KB_CUSTOMER_AUDIENCE = 'true';
  await WikiQA.query('what does it cost', {});
  expect(categoryFilters().length).toBe(1);
});

test.each(['tech_field', 'admin_manual'])('(d) gate on + %s: NOT filtered, article reaches the prompt', async (source) => {
  process.env.GATE_KB_CUSTOMER_AUDIENCE = 'true';
  routeTo(['chemicals/price.md']);
  const result = await WikiQA.query('what does it cost', { source });
  expect(categoryFilters()).toEqual([]);
  expect(allPrompts()).toContain('WHOLESALE SECRET');
  expect(result.articlesUsed).toEqual(['chemicals/price.md']);
});

test('(e) gate on + customer source, no paths and no species: "couldn\'t find", not "empty"', async () => {
  process.env.GATE_KB_CUSTOMER_AUDIENCE = 'true';
  const result = await WikiQA.query('zzzz qqqq', { source: 'ai_assistant' });
  expect(result.answer).toMatch(/couldn't find relevant articles/);
  expect(result.answer).not.toMatch(/knowledge base is empty/);
  expect(result.articlesUsed).toEqual([]);
  expect(dispatchWithFallback).not.toHaveBeenCalled();
});

test('(e2) gate off: an empty index still gives the staff-facing empty message', async () => {
  kbRows.length = 0;
  try {
    const result = await WikiQA.query('anything', { source: 'ai_assistant' });
    expect(result.answer).toMatch(/knowledge base is empty/);
  } finally {
    kbRows.push({ path: 'chemicals/price.md', title: 'Wholesale price', summary: 's', category: 'chemicals' });
  }
});

test('(f) keyword fallback (no API key) is filtered for a customer source when the gate is on', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.GATE_KB_CUSTOMER_AUDIENCE = 'true';
  const result = await WikiQA.query('wholesale price', { source: 'ai_assistant' });
  expect(categoryFilters().length).toBeGreaterThan(0);
  expect(categoryFilters().every((c) => c.list === KNOWLEDGE_BASE_CUSTOMER_SAFE_CATEGORIES)).toBe(true);
  expect(result.answer).not.toContain('WHOLESALE SECRET');
});

test('(f2) keyword fallback is unfiltered for staff and with the gate off', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.GATE_KB_CUSTOMER_AUDIENCE = 'true';
  await WikiQA.query('wholesale price', { source: 'tech_field' });
  delete process.env.GATE_KB_CUSTOMER_AUDIENCE;
  await WikiQA.query('wholesale price', { source: 'ai_assistant' });
  expect(categoryFilters()).toEqual([]);
});

test('search() with no context object is unchanged even with the gate on', async () => {
  process.env.GATE_KB_CUSTOMER_AUDIENCE = 'true';
  await WikiQA.search('wholesale price');
  expect(categoryFilters()).toEqual([]);
});

test('with a category on the allowlist: index, routing-failure fallback and article load all carry the filter, other categories stay out', async () => {
  process.env.GATE_KB_CUSTOMER_AUDIENCE = 'true';
  KNOWLEDGE_BASE_CUSTOMER_SAFE_CATEGORIES.push('pests');
  kbRows.push({ path: 'pests/ants.md', title: 'Ants', summary: 's', category: 'pests' });
  try {
    // Routing fails -> keyword fallback; then the answer call.
    dispatchWithFallback
      .mockResolvedValueOnce({ ok: false, reason: 'boom' })
      .mockResolvedValueOnce({ ok: true, text: 'the answer' });
    await WikiQA.query('ants wholesale price', { source: 'ai_assistant' });
    const filters = categoryFilters();
    expect(filters.length).toBe(2); // index + fallback (no paths came back, so no article load)
    expect(filters.every((c) => c.list.includes('pests'))).toBe(true);
    expect(allPrompts()).not.toContain('chemicals/price.md');
    expect(allPrompts()).not.toContain('WHOLESALE SECRET');
  } finally {
    KNOWLEDGE_BASE_CUSTOMER_SAFE_CATEGORIES.pop();
    kbRows.pop();
  }
});

test('with a category on the allowlist a routed path loads under the category filter', async () => {
  process.env.GATE_KB_CUSTOMER_AUDIENCE = 'true';
  KNOWLEDGE_BASE_CUSTOMER_SAFE_CATEGORIES.push('pests');
  kbRows.push({ path: 'pests/ants.md', title: 'Ants', summary: 's', category: 'pests' });
  try {
    routeTo(['pests/ants.md']);
    await WikiQA.query('ants', { source: 'ai_assistant' });
    const pathLoad = mockWhereIn.findIndex((c) => c.col === 'path');
    expect(pathLoad).toBeGreaterThan(-1);
    expect(mockWhereIn.slice(pathLoad).some((c) => c.col === 'category' && c.list.includes('pests'))).toBe(true);
  } finally {
    KNOWLEDGE_BASE_CUSTOMER_SAFE_CATEGORIES.pop();
    kbRows.pop();
  }
});
