/**
 * WikiQA.recordSearchMiss: the IB route logs a search_field_intelligence
 * call that found nothing as a knowledge gap (for the weekly email); every
 * other tool, a failure, or a search with any hit logs nothing.
 */
jest.mock('../models/db', () => jest.fn());

const WikiQA = require('../services/knowledge/wiki-qa');

const recordKnowledgeSearchMiss = (...args) => WikiQA.recordSearchMiss(...args);
jest.spyOn(WikiQA, 'logQuery').mockImplementation(async () => {});

const empty = { fieldIntelligence: [], knowledgeBase: [] };

beforeEach(() => WikiQA.logQuery.mockClear());

test('an empty knowledge search is logged as a gap', () => {
  expect(recordKnowledgeSearchMiss('search_field_intelligence', { query: ' door sweeps ' }, empty, false)).toBe(true);
  expect(WikiQA.logQuery).toHaveBeenCalledWith('door sweeps', null, [], 'intelligence_bar', 'none');
});

test.each([
  ['another tool', 'lookup_customer', { query: 'x' }, empty, false],
  ['a failed call', 'search_field_intelligence', { query: 'x' }, empty, true],
  ['an error result', 'search_field_intelligence', { query: 'x' }, { error: 'query is required' }, false],
  ['a wiki hit', 'search_field_intelligence', { query: 'x' }, { ...empty, fieldIntelligence: [{ slug: 'a' }] }, false],
  ['a knowledge-base hit', 'search_field_intelligence', { query: 'x' }, { ...empty, knowledgeBase: [{ slug: 'a' }] }, false],
  ['an operational hit', 'search_field_intelligence', { query: 'x' }, { ...empty, operationalKnowledge: [{ ref: 'a' }] }, false],
  ['a blank query', 'search_field_intelligence', { query: '  ' }, empty, false],
])('%s logs nothing', (_label, tool, input, result, failed) => {
  expect(recordKnowledgeSearchMiss(tool, input, result, failed)).toBe(false);
  expect(WikiQA.logQuery).not.toHaveBeenCalled();
});
