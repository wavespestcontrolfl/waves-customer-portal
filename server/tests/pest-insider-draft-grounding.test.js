/**
 * The Pest Insider writer is grounded in the email fact register: the
 * verified facts are part of its system prompt, the weekly flagship's prompt
 * is unchanged, and a draft that cannot load its facts is never written.
 */
const mockDispatch = jest.fn();
const mockFactsBlock = jest.fn();

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: mockDispatch }));
jest.mock('../services/email-division/fact-register', () => ({
  factsPromptBlock: mockFactsBlock,
  findUnverifiedClaims: jest.fn(() => []),
  listFacts: jest.fn(async () => []),
}));

const db = require('../models/db');
const { createNewsletterDraft } = require('../services/newsletter-draft');

const STOP = new Error('stop after the prompt is built');

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(() => {
    const q = {};
    ['where', 'whereIn', 'whereNull', 'whereNotNull', 'whereRaw', 'select', 'orderBy', 'orderByRaw', 'limit', 'leftJoin']
      .forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => undefined);
    q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return q;
  });
  mockDispatch.mockImplementation(async () => { throw STOP; });
  mockFactsBlock.mockResolvedValue('\n\nVERIFIED FACTS — test marker');
});

describe('Pest Insider draft grounding', () => {
  test('the verified facts are part of the Pest Insider system prompt', async () => {
    await expect(createNewsletterDraft({
      prompt: 'Monthly Pest Insider for September.',
      newsletterType: 'pest-insider-monthly',
    })).rejects.toBe(STOP);

    expect(mockFactsBlock).toHaveBeenCalledTimes(1);
    const [, args] = mockDispatch.mock.calls[0];
    expect(args.system).toContain('You write "Pest Insider"');
    expect(args.system.endsWith('VERIFIED FACTS — test marker')).toBe(true);
  });

  test('a draft that cannot load its facts is never sent to the writer', async () => {
    mockFactsBlock.mockRejectedValue(new Error('fact register is empty: no verified facts to ground the draft'));

    await expect(createNewsletterDraft({
      prompt: 'Monthly Pest Insider for September.',
      newsletterType: 'pest-insider-monthly',
    })).rejects.toThrow(/fact register is empty/);

    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
