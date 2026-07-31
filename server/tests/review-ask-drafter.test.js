// Personalized review-ask drafter: verification rules + fallback contract.
// The lane AUTO-SENDS (owner ruling 2026-07-30), so the deterministic verifier
// is the last line between a bad draft and a customer — every rule gets a test.
const mockDispatch = jest.fn();
const mockGates = { reviewAskPersonalized: false };
const mockGetRecentCalls = jest.fn(async () => []);

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...a) => mockDispatch(...a) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: (g) => !!mockGates[g], gates: mockGates }));
jest.mock('../services/context-aggregator', () => {
  const mod = { getRecentCalls: (...a) => mockGetRecentCalls(...a) };
  mod.redactAccessCodes = (s) => s;
  return mod;
});

const db = require('../models/db');
const Drafter = require('../services/review-ask-drafter');

const CUSTOMER = { id: 'cust-1', first_name: 'Aaron', last_name: 'Boss' };
const CLEAN_BODY = 'Hi Aaron, Adam here with Waves. Hope the centipedes are backing off at the entryway — if we earned it, a quick Google review would mean a lot: {review_url}. Anything off, just reply here.';

function mockDb(smsRows = []) {
  db.mockImplementation(() => ({
    where() { return this; },
    orderBy() { return this; },
    limit() { return this; },
    async select() { return smsRows; },
  }));
}

beforeEach(() => {
  mockDispatch.mockReset();
  mockGetRecentCalls.mockReset().mockResolvedValue([]);
  mockGates.reviewAskPersonalized = true;
  mockDb();
});

describe('verifyDraftBody — the auto-send safety net', () => {
  const verify = (body) => Drafter.verifyDraftBody(body, { firstName: 'Aaron' });

  test('a clean grounded draft passes', () => {
    expect(verify(CLEAN_BODY)).toBeNull();
  });

  test('rejects empty and over-length bodies', () => {
    expect(verify('')).toBe('empty');
    expect(verify(`Aaron {review_url} ${'x'.repeat(430)}`)).toBe('too_long');
  });

  test('requires the {review_url} placeholder exactly once', () => {
    expect(verify('Hi Aaron, thanks for having us out! Reply here anytime.')).toBe('missing_link');
    expect(verify('Hi Aaron {review_url} and also {review_url}')).toBe('duplicate_link');
  });

  test('rejects emojis', () => {
    expect(verify('Hi Aaron 🎉 review us: {review_url}')).toBe('emoji');
  });

  test('rejects dollar amounts, incentives, and rating coaching', () => {
    expect(verify('Hi Aaron, your $209 service — {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, leave a review for a free treatment: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, give us 5 stars: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, we guarantee results: {review_url}')).toBe('banned_phrase');
  });

  test('rejects site-compliance language (safe / non-toxic / EPA)', () => {
    expect(verify('Hi Aaron, our safe treatments: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, non-toxic barrier: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, EPA approved: {review_url}')).toBe('banned_phrase');
  });

  test('"feel free to reply" is NOT an incentive', () => {
    expect(verify('Hi Aaron, feel free to reply here — {review_url}')).toBeNull();
  });

  test('rejects unrendered placeholders other than the link', () => {
    expect(verify('Hi Aaron ({first}), review us: {review_url}')).toBe('stray_placeholder');
  });

  test('requires the customer first name', () => {
    expect(verify('Hey there, quick review? {review_url}')).toBe('missing_name');
  });
});

describe('draftAskBody — gating + fallback contract', () => {
  test('gate off → null, and no model call is made', async () => {
    mockGates.reviewAskPersonalized = false;
    expect(await Drafter.draftAskBody({ customer: CUSTOMER })).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('gate on → grounded draft comes back verified, with history in the prompt', async () => {
    mockGetRecentCalls.mockResolvedValue([
      { direction: 'inbound', call_summary: 'Aaron called about centipedes and millipedes swarming the front entry.', transcript: 'Caller: they are all over the driveway…' },
    ]);
    mockDb([{ direction: 'outbound', message_body: 'Your estimate is ready', created_at: new Date() }]);
    mockDispatch.mockResolvedValue({ ok: true, text: CLEAN_BODY });

    const body = await Drafter.draftAskBody({
      customer: CUSTOMER,
      serviceType: 'Quarterly Pest Control',
      techName: 'Adam',
      sequenceStep: 1,
      serviceDate: new Date(Date.now() - 3 * 86400000),
    });

    expect(body).toBe(CLEAN_BODY);
    const prompt = mockDispatch.mock.calls[0][1].text;
    expect(prompt).toContain('centipedes and millipedes swarming');
    expect(prompt).toContain('NEWEST CALL TRANSCRIPT');
    expect(prompt).toContain('follow-up review ask');
    // The policy is the two-provider customerCopy lane.
    expect(mockDispatch.mock.calls[0][0]).toBe(require('../config/models').TEXT_POLICIES.customerCopy);
  });

  test('a draft that fails verification falls back to null (template sends instead)', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: 'Hi Aaron! 🎉 {review_url}' });
    expect(await Drafter.draftAskBody({ customer: CUSTOMER })).toBeNull();
  });

  test('both providers down → null, never a throw', async () => {
    mockDispatch.mockResolvedValue({ ok: false, reason: 'unavailable' });
    expect(await Drafter.draftAskBody({ customer: CUSTOMER })).toBeNull();
  });

  test('an unexpected error inside drafting → null, never a throw', async () => {
    mockGetRecentCalls.mockRejectedValue(new Error('pg down'));
    expect(await Drafter.draftAskBody({ customer: CUSTOMER })).toBeNull();
  });
});
