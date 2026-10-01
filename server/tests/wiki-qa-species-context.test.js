/**
 * WikiQA species-catalog context (GATE_KB_SPECIES_QA): customer-facing
 * callers never receive tech notes, the gate off leaves WikiQA unchanged,
 * and a catalog hit answers a question the knowledge base has no article for.
 */
const kbRows = [{ path: 'pests/ants.md', title: 'Ants', summary: 's', category: 'pests' }];
jest.mock('../models/db', () => jest.fn((table) => {
  let paths = null;
  const qb = {
    where() { return qb; },
    whereNot() { return qb; },
    whereIn(_col, list) { paths = list; return qb; },
    select() { return qb; },
    orderBy() { return Promise.resolve(table === 'knowledge_base' ? kbRows : []); },
    insert: jest.fn(async () => {}),
    // Awaiting a whereIn().select() chain loads the routed articles.
    then(resolve, reject) {
      const rows = (paths || []).filter((p) => p === 'pests/ants.md').map((p) => ({ path: p, title: 'Ants', content: 'kb ant article' }));
      return Promise.resolve(rows).then(resolve, reject);
    },
  };
  return qb;
}));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/knowledge-index/hybrid-search', () => ({ hybridKnowledgeSearch: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const { hybridKnowledgeSearch } = require('../services/knowledge-index/hybrid-search');
const { gates } = require('../config/feature-gates');
const catalog = require('../services/species-catalog');
const WikiQA = require('../services/knowledge/wiki-qa');

const SLUG = 'spiraling-whitefly';
const techNotes = catalog.getEntry(SLUG).tech_notes;
const env = { ...process.env };

function routeTo(paths) {
  dispatchWithFallback
    .mockResolvedValueOnce({ ok: true, json: { paths } })
    .mockResolvedValueOnce({ ok: true, text: 'the answer' });
}
const answerCall = () => dispatchWithFallback.mock.calls[1][1];

beforeEach(() => {
  jest.clearAllMocks();
  dispatchWithFallback.mockReset();
  hybridKnowledgeSearch.mockReset();
  process.env = { ...env, ANTHROPIC_API_KEY: 'test', GATE_KB_SPECIES_QA: 'true' };
  gates.hybridKnowledge = true; // read at module load in prod; set directly here
  hybridKnowledgeSearch.mockResolvedValue({ results: [{ source: 'species', sourceId: SLUG }] });
});
const hybridAtLoad = gates.hybridKnowledge;
afterAll(() => { process.env = env; gates.hybridKnowledge = hybridAtLoad; });

test('customer-facing caller gets customer copy only, searched on species alone', async () => {
  routeTo([]);
  const result = await WikiQA.query('sticky black coating under my palm', { source: 'ai_assistant' });
  expect(hybridKnowledgeSearch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ sources: ['species'] }));
  expect(answerCall().text).toContain(catalog.getEntry(SLUG).copy.what_it_means);
  expect(answerCall().text).not.toContain(techNotes);
  expect(answerCall().system).toMatch(/SPECIES CATALOG/);
  expect(result.articlesUsed).toEqual([`species:${SLUG}`]);
});

test('an unknown caller is treated as customer-facing', async () => {
  routeTo([]);
  await WikiQA.query('sticky black coating', { source: 'lead_agent' });
  expect(answerCall().text).not.toContain(techNotes);
});

test('staff caller also gets the tech notes', async () => {
  routeTo([]);
  await WikiQA.query('sticky black coating', { source: 'tech_field' });
  expect(hybridKnowledgeSearch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ sources: ['species', 'species_tech'] }));
  expect(answerCall().text).toContain(techNotes);
});

test('knowledge-base paths stay ahead of species refs', async () => {
  routeTo(['pests/ants.md']);
  const result = await WikiQA.query('whitefly and ants', { source: 'ai_assistant' });
  expect(result.articlesUsed).toEqual(['pests/ants.md', `species:${SLUG}`]);
});

test('hybrid off falls back to the catalog name match', async () => {
  gates.hybridKnowledge = false;
  routeTo([]);
  const result = await WikiQA.query('ghost ants in the kitchen', { source: 'ai_assistant' });
  expect(hybridKnowledgeSearch).not.toHaveBeenCalled();
  expect(result.articlesUsed).toEqual(['species:ghost-ant']);
});

test('drafts and unknown slugs are never used', async () => {
  const draft = catalog.listEntries().find((e) => e.review?.status !== 'owner_approved');
  hybridKnowledgeSearch.mockResolvedValue({ results: [{ sourceId: draft.slug }, { sourceId: 'not-a-slug' }] });
  dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { paths: [] } });
  const result = await WikiQA.query('zzz', { source: 'ai_assistant' });
  expect(result.articlesUsed).toEqual([]);
  expect(dispatchWithFallback).toHaveBeenCalledTimes(1); // no answer call on a miss
});

test('gate off: no species search and the prompt is unchanged', async () => {
  delete process.env.GATE_KB_SPECIES_QA;
  routeTo(['pests/ants.md']);
  const result = await WikiQA.query('whitefly', { source: 'ai_assistant' });
  expect(hybridKnowledgeSearch).not.toHaveBeenCalled();
  expect(answerCall().system).not.toMatch(/SPECIES CATALOG/);
  expect(result.articlesUsed).toEqual(['pests/ants.md']);
});
