// Opus 5.5 always thinks: at the pinned high effort the compiler's articles
// (avg ~9,800 tokens) plus thinking ran into the old 12000 cap and 8 of 27
// prod runs ended anthropic_incomplete. Both compiler calls ask for effort
// 'low' and a 16000 cap, under the SDK's 21,333 non-streaming ceiling.
const mockChain = () => {
  const chain = {};
  for (const m of ['where', 'select', 'orderBy', 'update', 'insert']) chain[m] = jest.fn(() => chain);
  chain.returning = jest.fn().mockResolvedValue([{ id: 'src-1', filename: 'synthetic.md', file_path: 'inline:synthetic.md', file_type: 'md' }]);
  chain.first = jest.fn().mockResolvedValue({ id: 'src-1', filename: 'synthetic.md', file_path: 'synthetic.md', file_type: 'md' });
  chain.then = (resolve) => resolve([]);
  return chain;
};
jest.mock('../models/db', () => jest.fn(() => mockChain()));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/deep', () => ({ createDeepMessage: jest.fn() }));
jest.mock('@anthropic-ai/sdk', () => jest.fn());

const { createDeepMessage } = require('../services/llm/deep');
const compiler = require('../services/knowledge/wiki-compiler');

const SDK_NON_STREAMING_CEILING = 21333;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  createDeepMessage.mockReset();
  // Unparseable output ends each compile right after the request is made.
  createDeepMessage.mockResolvedValue({ content: [{ text: 'not json' }] });
});

function expectBudget() {
  const params = createDeepMessage.mock.calls[0][1];
  expect(params.effort).toBe('low');
  expect(params.max_tokens).toBe(16000);
  expect(params.max_tokens).toBeLessThan(SDK_NON_STREAMING_CEILING);
}

test('compileSource requests effort low and a 16000 cap', async () => {
  jest.spyOn(compiler, 'readSourceFile').mockResolvedValue('synthetic source content about a pest');
  await expect(compiler.compileSource('src-1')).rejects.toThrow(/not valid JSON/);
  expectBudget();
});

test('compileFromContent requests effort low and a 16000 cap', async () => {
  await expect(compiler.compileFromContent({ content: 'synthetic inline content', filename: 'synthetic.md', fileType: 'md' })).rejects.toThrow(/not valid JSON/);
  expectBudget();
});
