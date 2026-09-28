/**
 * Pest Insider proof wiring (GATE_PEST_INSIDER_PROOF).
 *
 * Mirrors newsletter-proof.test.js's mocking shape: sendNewsletterProof
 * itself is mocked (its own idempotency/gate behavior is covered there),
 * and this pins that pest-insider-autopilot.js calls it exactly once when
 * the gate is on, and never at all when it's off (today's behavior — draft
 * + notification only, kill switch = unset).
 */

const mockCreateDraft = jest.fn(async () => ({
  send: { id: 'send-pi-1', subject: 'Pest Insider — June' },
  draft: { voiceWarnings: [] },
}));
const mockTrigger = jest.fn(async () => ({ ok: true }));
const mockSendProof = jest.fn(async () => ({ sent: true, token: 'abcd1234' }));

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/newsletter-draft', () => ({
  createNewsletterDraft: mockCreateDraft,
}));
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: mockTrigger,
}));
jest.mock('../services/newsletter-proof', () => ({
  sendNewsletterProof: mockSendProof,
}));

const db = require('../models/db');
const { runPestInsiderAutopilot, retryPestInsiderProof } = require('../services/pest-insider-autopilot');

// Tue Jun 2, 2026, 7:05am ET — the first Tuesday of the month, matching the
// cron guard tests in pest-insider.test.js.
const FIRST_TUESDAY = new Date('2026-06-02T11:05:00Z');

function chain(overrides = {}) {
  const q = {};
  ['where', 'whereNull', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => overrides.first);
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_PEST_INSIDER_PROOF;
  db.mockImplementation(() => chain({ first: undefined })); // no draft yet this month
});

afterAll(() => {
  delete process.env.GATE_PEST_INSIDER_PROOF;
});

describe('pest-insider proof gate', () => {
  test('gate off (unset) — draft + notification only, sendNewsletterProof never called', async () => {
    const result = await runPestInsiderAutopilot({ now: FIRST_TUESDAY });
    expect(result.skipped).toBe(false);
    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith('pest_insider_draft', expect.objectContaining({ sendId: 'send-pi-1' }));
    expect(mockSendProof).not.toHaveBeenCalled();
  });

  test('gate explicitly false — same as unset, no proof call', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'false';
    await runPestInsiderAutopilot({ now: FIRST_TUESDAY });
    expect(mockSendProof).not.toHaveBeenCalled();
  });

  test('gate on — sendNewsletterProof called exactly once for the new draft', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    const result = await runPestInsiderAutopilot({ now: FIRST_TUESDAY });
    expect(result.skipped).toBe(false);
    expect(mockSendProof).toHaveBeenCalledTimes(1);
    expect(mockSendProof).toHaveBeenCalledWith('send-pi-1');
  });

  test('gate on but proof send throws — failure is swallowed, draft result unaffected', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    mockSendProof.mockImplementationOnce(async () => { throw new Error('sendgrid 503'); });
    const result = await runPestInsiderAutopilot({ now: FIRST_TUESDAY });
    expect(result.skipped).toBe(false);
    expect(result.sendId).toBe('send-pi-1');
    expect(mockSendProof).toHaveBeenCalledTimes(1);
  });
});

describe('pest-insider proof catch-up', () => {
  // Wed Jun 3, 2026, 2:15pm ET — the day after the first Tuesday.
  const DAY_AFTER = new Date('2026-06-03T18:15:00Z');

  test('re-sends the proof for this month\'s draft when none is on record', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    const q = chain({ first: { id: 'send-pi-1' } });
    db.mockImplementation(() => q);

    const result = await retryPestInsiderProof({ now: DAY_AFTER });

    expect(result).toEqual({ skipped: false, sendId: 'send-pi-1', proofSent: true, reason: null });
    expect(mockSendProof).toHaveBeenCalledWith('send-pi-1');
    // Only an unproofed DRAFT of this type qualifies.
    expect(q.where).toHaveBeenCalledWith('newsletter_type', 'pest-insider-monthly');
    expect(q.where).toHaveBeenCalledWith('status', 'draft');
    expect(q.whereNull).toHaveBeenCalledWith('proof_sent_at');
  });

  test('a second failure is reported, not thrown, so the next day retries', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    db.mockImplementation(() => chain({ first: { id: 'send-pi-1' } }));
    mockSendProof.mockImplementationOnce(async () => { throw new Error('sendgrid 503'); });

    const result = await retryPestInsiderProof({ now: DAY_AFTER });

    expect(result).toEqual({ skipped: false, sendId: 'send-pi-1', proofSent: false, reason: 'threw' });
  });

  test.each([
    ['a SendGrid failure', 'proof_send_failed'],
    ['a draft the validator blocked', 'validation_failed'],
    ['the shared proof gate being off', 'gate_off'],
  ])('%s is a RESULT, not an exception, and is never reported as sent', async (_label, reason) => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    db.mockImplementation(() => chain({ first: { id: 'send-pi-1' } }));
    mockSendProof.mockImplementationOnce(async () => ({ skipped: true, reason }));

    const result = await retryPestInsiderProof({ now: DAY_AFTER });

    expect(result).toEqual({ skipped: false, sendId: 'send-pi-1', proofSent: false, reason });
  });

  test('nothing to do when the proof is on record, the issue was sent or deleted, or no draft exists', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    db.mockImplementation(() => chain({ first: undefined }));

    const result = await retryPestInsiderProof({ now: DAY_AFTER });

    expect(result.skipped).toBe(true);
    expect(mockSendProof).not.toHaveBeenCalled();
  });

  test('gate off — never queries, never proofs', async () => {
    const result = await retryPestInsiderProof({ now: DAY_AFTER });

    expect(result).toEqual({ skipped: true, reason: 'proof gate off' });
    expect(db).not.toHaveBeenCalled();
    expect(mockSendProof).not.toHaveBeenCalled();
  });

  test('after the 10th of the month a stale draft is not proofed', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    db.mockImplementation(() => chain({ first: { id: 'send-pi-1' } }));

    const result = await retryPestInsiderProof({ now: new Date('2026-06-11T18:15:00Z') });

    expect(result.skipped).toBe(true);
    expect(mockSendProof).not.toHaveBeenCalled();
  });
});
