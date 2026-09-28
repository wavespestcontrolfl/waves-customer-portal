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
const { runPestInsiderAutopilot } = require('../services/pest-insider-autopilot');

// Tue Jun 2, 2026, 7:05am ET — the first Tuesday of the month, matching the
// cron guard tests in pest-insider.test.js.
const FIRST_TUESDAY = new Date('2026-06-02T11:05:00Z');

function chain(overrides = {}) {
  const q = {};
  ['where', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
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
