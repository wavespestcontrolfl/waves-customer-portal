/**
 * The draft writer and the email fact register: the weekly flagship's prompt
 * carries the live verified facts and still drafts without them, and the
 * writer refuses a Waves Pest Insider issue (services/pest-insider builds
 * those) before any facts load or paid call.
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
const { createNewsletterDraft, persistNewsletterDraft } = require('../services/newsletter-draft');

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

describe('draft writer grounding', () => {
  test('the weekly flagship gets the same live facts block (codex round 14 P1)', async () => {
    await expect(createNewsletterDraft({
      prompt: 'Weekend events for Bradenton.',
      newsletterType: 'local-weekly-fresh-events',
    })).rejects.toBe(STOP);
    const [, args] = mockDispatch.mock.calls[0];
    expect(args.system).toContain('SWFL SEASONAL CONTEXT');
    expect(args.system.endsWith('VERIFIED FACTS — test marker')).toBe(true);
  });

  test('the weekly flagship prompt asks for the short format: one sentence per event, 3 points, one joke each in subject and opening line (owner 2026-11-26)', async () => {
    await expect(createNewsletterDraft({
      prompt: 'Weekend events for Bradenton.',
      newsletterType: 'local-weekly-fresh-events',
    })).rejects.toBe(STOP);
    const [, args] = mockDispatch.mock.calls[0];
    expect(args.system).toContain('HUMOR BUDGET');
    expect(args.system).toContain('"weekendPoints"');
    expect(args.system).toContain('"why"');
    expect(args.system).not.toMatch(/gifSearchTerm|proTip|closingChecklist|scoopLabel|P\.S\. JOKE/);
  });

  test('the weekly flagship still drafts when the register is empty or unreachable — without pest facts (pre-push audit P1 on e0dd938596)', async () => {
    mockFactsBlock.mockRejectedValue(new Error('fact register is empty: no verified facts to ground the draft'));
    await expect(createNewsletterDraft({
      prompt: 'Weekend events for Bradenton.',
      newsletterType: 'local-weekly-fresh-events',
    })).rejects.toBe(STOP);
    const [, args] = mockDispatch.mock.calls[0];
    // the prompt's own rule still names the block; the block itself is absent
    expect(args.system).not.toContain('VERIFIED FACTS — test marker');
    expect(args.system).toContain('SWFL SEASONAL CONTEXT');
  });

  test.each([
    ['saved', {}],
    ['not saved', { persist: false }],
  ])('a Waves Pest Insider draft (%s) is refused before any facts load or paid writer call', async (_label, extra) => {
    await expect(createNewsletterDraft({
      prompt: 'Waves Pest Insider for September.',
      newsletterType: 'pest-insider-monthly',
      ...extra,
    })).rejects.toThrow(/built by its planner/);

    expect(mockFactsBlock).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('the draft writer refuses a Waves Pest Insider issue: it saves no planned audience, and the sender sends none without one', async () => {
    const knex = jest.fn();

    await expect(persistNewsletterDraft({
      draft: { subject: 'Waves Pest Insider', htmlBody: '<p>Body</p>', textBody: 'Body' },
      prompt: 'Pest Insider.',
      newsletterType: 'pest-insider-monthly',
      knex,
    })).rejects.toThrow(/planned audience/);

    expect(knex).not.toHaveBeenCalled();
  });
});
