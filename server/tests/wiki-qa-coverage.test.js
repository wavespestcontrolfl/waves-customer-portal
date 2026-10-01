/**
 * WikiQA coverage line: the answer model's final "COVERAGE: …" line is
 * recorded on knowledge_queries and never reaches the caller.
 */
const mockInserts = [];
jest.mock('../models/db', () => jest.fn((table) => {
  let paths = null;
  const qb = {
    where() { return qb; },
    whereNot() { return qb; },
    whereIn(_c, list) { paths = list; return qb; },
    select() { return qb; },
    orderBy() { return Promise.resolve(table === 'knowledge_base' ? [{ path: 'pests/ants.md', title: 'Ants', summary: 's', category: 'pests' }] : []); },
    insert: jest.fn(async (row) => { mockInserts.push(row); }),
    then(resolve, reject) {
      return Promise.resolve((paths || []).map((p) => ({ path: p, title: 'Ants', content: 'kb ant article' }))).then(resolve, reject);
    },
  };
  return qb;
}));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const WikiQA = require('../services/knowledge/wiki-qa');

const env = { ...process.env };
beforeEach(() => {
  mockInserts.length = 0;
  dispatchWithFallback.mockReset();
  process.env = { ...env, ANTHROPIC_API_KEY: 'test' };
  delete process.env.GATE_KB_SPECIES_QA;
});
afterAll(() => { process.env = env; });

describe('splitCoverage', () => {
  test.each([
    ['Use bait.\n\nCOVERAGE: full', 'Use bait.', 'full'],
    ['Partly.\nCOVERAGE: partial.', 'Partly.', 'partial'],
    ['Not here.\n**COVERAGE: None**', 'Not here.', 'none'],
    ['No line at all.', 'No line at all.', null],
    ['COVERAGE: maybe', 'COVERAGE: maybe', null],
  ])('%j', (text, answer, coverage) => {
    expect(WikiQA.splitCoverage(text)).toEqual({ answer, coverage });
  });
});

test('query strips the coverage line and logs it', async () => {
  dispatchWithFallback
    .mockResolvedValueOnce({ ok: true, json: { paths: ['pests/ants.md'] } })
    .mockResolvedValueOnce({ ok: true, text: 'Ants answer.\nCOVERAGE: partial' });
  const result = await WikiQA.query('ants in the pantry', { source: 'lead_agent' });
  expect(result.answer).toBe('Ants answer.');
  expect(dispatchWithFallback.mock.calls[1][1].system).toMatch(/COVERAGE: full/);
  expect(mockInserts[0]).toMatchObject({ answer: 'Ants answer.', asked_by: 'lead_agent', coverage: 'partial' });
});

test('no routed article logs coverage none', async () => {
  dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { paths: [] } });
  await WikiQA.query('door sweeps', { source: 'brief_driven_agent' });
  expect(mockInserts[0]).toMatchObject({ coverage: 'none', asked_by: 'brief_driven_agent' });
});

test('a missing coverage line logs no coverage', async () => {
  dispatchWithFallback
    .mockResolvedValueOnce({ ok: true, json: { paths: ['pests/ants.md'] } })
    .mockResolvedValueOnce({ ok: true, text: 'Ants answer.' });
  await WikiQA.query('ants', { source: 'lead_agent' });
  expect(mockInserts[0]).not.toHaveProperty('coverage');
});
