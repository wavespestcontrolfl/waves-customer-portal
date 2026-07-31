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
const CLEAN_BODY = 'Hi Aaron, Adam here with Waves. Hope the centipedes are backing off at the entryway. If we earned it, a quick review means a lot: {review_url}. Anything off, just reply here.';

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
    expect(verify('Hi Aaron, your $209 service: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, leave a review for a free treatment: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, give us 5 stars: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, we guarantee results: {review_url}')).toBe('banned_phrase');
  });

  test('rejects every incentive flavor, not just "free" (Google policy)', () => {
    expect(verify("Hi Aaron, leave a review and we'll send a gift card: {review_url}")).toBe('banned_phrase');
    expect(verify('Hi Aaron, review us for a reward: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, a review earns account credit: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, complimentary treatment for a review: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, review us in exchange for goodies: {review_url}')).toBe('banned_phrase');
  });

  test('rejects fixed drying / re-entry time claims (site-compliance)', () => {
    expect(verify('Hi Aaron, hope everything dried well: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, you can re-enter anytime: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, all set after 30 minutes: {review_url}')).toBe('banned_phrase');
    expect(verify('Hi Aaron, wait 2 hours then enjoy the yard: {review_url}')).toBe('banned_phrase');
  });

  test('rejects any raw URL beyond the {review_url} placeholder', () => {
    expect(verify('Hi Aaron, see https://example.com and {review_url}')).toBe('raw_url');
    expect(verify('Hi Aaron, visit www.wavespest.com or {review_url}')).toBe('raw_url');
    expect(verify('Hi Aaron, check wavespestcontrol.com then {review_url}')).toBe('raw_url');
  });

  test('rejects a rendered body over the 2-segment policy cap', () => {
    // 278 chars pre-render passes the char ceiling, but with the ~43-char
    // rendered link it exceeds two GSM segments (306 chars) — reject.
    const filler = 'We really appreciate you welcoming our crew and trusting the process from day one. '.repeat(4);
    const body = `Hi Aaron, ${filler.slice(0, 255)} {review_url}`;
    expect(body.length).toBeLessThanOrEqual(280);
    expect(verify(body)).toBe('too_many_segments');
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

  test('gate on → grounded draft comes back verified; rules in SYSTEM, history in text, bounded timeout', async () => {
    mockGetRecentCalls.mockResolvedValue([
      { direction: 'inbound', call_summary: 'Aaron called about centipedes and millipedes swarming the front entry.', transcript: 'Caller: they are all over the driveway…' },
    ]);
    mockDb([{ direction: 'outbound', message_body: 'Your estimate is ready', created_at: new Date() }]);
    mockDispatch.mockResolvedValue({ ok: true, text: CLEAN_BODY });

    const body = await Drafter.draftAskBody({
      customer: CUSTOMER,
      recipientFirstName: 'Aaron',
      serviceType: 'Quarterly Pest Control',
      techName: 'Adam',
      sequenceStep: 1,
      serviceDate: new Date(Date.now() - 3 * 86400000),
    });

    expect(body).toBe(CLEAN_BODY);
    const payload = mockDispatch.mock.calls[0][1];
    // Untrusted history rides ONLY the user text; the fixed rules ride system.
    expect(payload.text).toContain('centipedes and millipedes swarming');
    expect(payload.text).toContain('NEWEST CALL TRANSCRIPT');
    expect(payload.text).not.toContain('RULES (all mandatory)');
    expect(payload.system).toContain('follow-up text a few days after service');
    expect(payload.system).toContain('RULES (all mandatory)');
    expect(payload.timeoutMs).toBe(45000);
    // The policy is the two-provider customerCopy lane.
    expect(mockDispatch.mock.calls[0][0]).toBe(require('../config/models').TEXT_POLICIES.customerCopy);
  });

  test('smart punctuation is normalized to GSM before verification', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: 'Hi Aaron — hope the ants are gone… If so: {review_url}. Anything off, just reply here.' });
    const body = await Drafter.draftAskBody({ customer: CUSTOMER, recipientFirstName: 'Aaron' });
    expect(body).toBe('Hi Aaron - hope the ants are gone... If so: {review_url}. Anything off, just reply here.');
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
