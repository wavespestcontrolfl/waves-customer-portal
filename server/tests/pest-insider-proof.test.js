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
const mockValidate = jest.fn(() => ({ errors: [], warnings: [] }));
const mockLockedPrices = jest.fn(async () => []);
const mockRecordAudit = jest.fn(async () => ({ id: 'audit-1' }));

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/newsletter-validator', () => ({
  validateNewsletterDraft: mockValidate,
  lockedPricesForSend: mockLockedPrices,
}));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: mockRecordAudit }));
const mockCountRecipients = jest.fn(async () => 0);
jest.mock('../services/newsletter-sender', () => ({ countSegmentRecipients: mockCountRecipients }));
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
  ['where', 'whereNull', 'whereRaw', 'select', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => overrides.first);
  return q;
}

// newsletter_sends answers with the draft (or nothing); audit_log answers
// with the last recorded proof attempt (or nothing).
function wireDb({ draft, lastAttempt } = {}) {
  const sends = chain({ first: draft });
  const audit = chain({ first: lastAttempt });
  db.mockImplementation((table) => (table === 'audit_log' ? audit : sends));
  return { sends, audit };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockValidate.mockImplementation(() => ({ errors: [], warnings: [] }));
  delete process.env.GATE_PEST_INSIDER_PROOF;
  wireDb({}); // no draft yet this month, no attempt on record
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

  test('gate on — sendNewsletterProof called exactly once for the new draft, and the attempt is recorded', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    const result = await runPestInsiderAutopilot({ now: FIRST_TUESDAY });
    expect(result.skipped).toBe(false);
    expect(mockSendProof).toHaveBeenCalledTimes(1);
    expect(mockSendProof).toHaveBeenCalledWith('send-pi-1');
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'newsletter.pest_insider_proof_attempted', resource_type: 'newsletter_sends', resource_id: 'send-pi-1',
      metadata: { sent: true, reason: null, notified: false },
    }));
  });

  test('a blocked first attempt is recorded with its reason (so the catch-up can compare against it)', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    mockSendProof.mockImplementationOnce(async () => ({ skipped: true, reason: 'validation_failed', notified: true }));
    await runPestInsiderAutopilot({ now: FIRST_TUESDAY });
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ metadata: { sent: false, reason: 'validation_failed', notified: true } }));
  });

  test('a blocked attempt whose owner notice was NOT delivered is recorded as not notified', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    mockSendProof.mockImplementationOnce(async () => ({ skipped: true, reason: 'validation_failed', notified: false }));
    await runPestInsiderAutopilot({ now: FIRST_TUESDAY });
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ metadata: { sent: false, reason: 'validation_failed', notified: false } }));
  });

  test('a failure to record the attempt never masks the proof outcome', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    mockRecordAudit.mockRejectedValueOnce(new Error('audit down'));
    const result = await runPestInsiderAutopilot({ now: FIRST_TUESDAY });
    expect(result.skipped).toBe(false);
    expect(mockSendProof).toHaveBeenCalledTimes(1);
  });

  test('gate on but proof send throws — failure is swallowed, draft result unaffected', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    mockSendProof.mockImplementationOnce(async () => { throw new Error('sendgrid 503'); });
    const result = await runPestInsiderAutopilot({ now: FIRST_TUESDAY });
    expect(result.skipped).toBe(false);
    expect(result.sendId).toBe('send-pi-1');
    expect(mockSendProof).toHaveBeenCalledTimes(1);
  });

  test('a draft that cannot be written is reported to the owner AND fails the job (scheduled-job health sees it)', async () => {
    mockCreateDraft.mockRejectedValueOnce(new Error('fact register is empty: no verified facts to ground the draft'));

    await expect(runPestInsiderAutopilot({ now: FIRST_TUESDAY })).rejects.toThrow(/fact register is empty/);

    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.objectContaining({
      subject: expect.stringContaining('Pest Insider'),
      errors: expect.arrayContaining([expect.stringContaining('fact register is empty')]),
    }));
    expect(mockTrigger).not.toHaveBeenCalledWith('pest_insider_draft', expect.anything());
    expect(mockSendProof).not.toHaveBeenCalled();
  });

  test('a failing draft-failure notification never masks the draft failure — the original error is what the job fails with', async () => {
    mockCreateDraft.mockRejectedValueOnce(new Error('writer down'));
    mockTrigger.mockRejectedValueOnce(new Error('notify down'));

    await expect(runPestInsiderAutopilot({ now: FIRST_TUESDAY })).rejects.toThrow('writer down');
  });
});

describe('pest-insider proof catch-up', () => {
  // Wed Jun 3, 2026, 2:15pm ET — the day after the first Tuesday.
  const DAY_AFTER = new Date('2026-06-03T18:15:00Z');

  test('re-sends the proof for this month\'s draft when none is on record', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    const { sends } = wireDb({ draft: { id: 'send-pi-1' } });

    const result = await retryPestInsiderProof({ now: DAY_AFTER });

    expect(result).toEqual({ skipped: false, sendId: 'send-pi-1', proofSent: true, reason: null });
    expect(mockSendProof).toHaveBeenCalledWith('send-pi-1');
    // Only an unproofed DRAFT of this type qualifies.
    expect(sends.where).toHaveBeenCalledWith('newsletter_type', 'pest-insider-monthly');
    expect(sends.where).toHaveBeenCalledWith('status', 'draft');
    expect(sends.whereNull).toHaveBeenCalledWith('proof_sent_at');
  });

  test('a second failure is reported, not thrown, so the next day retries', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    wireDb({ draft: { id: 'send-pi-1' } });
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
    wireDb({ draft: { id: 'send-pi-1' } });
    mockSendProof.mockImplementationOnce(async () => ({ skipped: true, reason }));

    const result = await retryPestInsiderProof({ now: DAY_AFTER });

    expect(result).toEqual({ skipped: false, sendId: 'send-pi-1', proofSent: false, reason });
  });

  test('nothing to do when the proof is on record, the issue was sent or deleted, or no draft exists', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    wireDb({});

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

  const DRAFTED_AT = new Date('2026-06-02T11:00:00Z'); // the first-Tuesday 7:00 AM ET creation
  // The autopilot's own proof attempt at creation time, blocked by the validator (owner notified then).
  const FIRST_ATTEMPT = { created_at: new Date('2026-06-02T11:05:00Z'), metadata: { sent: false, reason: 'validation_failed', notified: true } };

  test('the same-day catch-up on a blocked, unedited draft is skipped quietly — the owner was told at the first attempt', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    const draft = { id: 'send-pi-1', subject: 'Pest Insider — June', updated_at: DRAFTED_AT };
    wireDb({ draft, lastAttempt: FIRST_ATTEMPT });
    mockValidate.mockImplementation(() => ({ errors: ['Unverified claim (termite_second_swarm): "..."'], warnings: [] }));

    const result = await retryPestInsiderProof({ now: new Date('2026-06-02T18:15:00Z') });

    expect(result).toEqual({ skipped: true, reason: 'validation_failed', sendId: 'send-pi-1' });
    expect(mockValidate).toHaveBeenCalledWith(draft, expect.objectContaining({ lockedPrices: [] }));
    expect(mockSendProof).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  test('…and so is every later day until someone edits it', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    wireDb({ draft: { id: 'send-pi-1', updated_at: DRAFTED_AT }, lastAttempt: FIRST_ATTEMPT });
    mockValidate.mockImplementation(() => ({ errors: ['still blocked'], warnings: [] }));

    const result = await retryPestInsiderProof({ now: new Date('2026-06-05T18:15:00Z') });

    expect(result.skipped).toBe(true);
    expect(mockSendProof).not.toHaveBeenCalled();
  });

  test('a blocked draft EDITED since the last attempt gets a fresh proof attempt (which reports the outcome)', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    wireDb({ draft: { id: 'send-pi-1', updated_at: new Date('2026-06-03T14:00:00Z') }, lastAttempt: FIRST_ATTEMPT });
    mockValidate.mockImplementation(() => ({ errors: ['still blocked'], warnings: [] }));
    mockSendProof.mockImplementationOnce(async () => ({ skipped: true, reason: 'validation_failed' }));

    const result = await retryPestInsiderProof({ now: DAY_AFTER });

    expect(mockSendProof).toHaveBeenCalledWith('send-pi-1');
    expect(result).toEqual({ skipped: false, sendId: 'send-pi-1', proofSent: false, reason: 'validation_failed' });
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
  });

  test('no attempt on record (the gate was off when the issue was drafted) → attempt, so the owner is told once', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    wireDb({ draft: { id: 'send-pi-1', updated_at: DRAFTED_AT } });
    mockValidate.mockImplementation(() => ({ errors: ['blocked'], warnings: [] }));
    mockSendProof.mockImplementationOnce(async () => ({ skipped: true, reason: 'validation_failed' }));

    const result = await retryPestInsiderProof({ now: DAY_AFTER });

    expect(mockSendProof).toHaveBeenCalledWith('send-pi-1');
    expect(result.reason).toBe('validation_failed');
  });

  test.each([
    ['the shared proof gate was off', 'gate_off'],
    ['no approver was configured', 'no_approvers_configured'],
    ['SendGrid was not configured', 'sendgrid_not_configured'],
    ['the attempt threw before validating', 'threw'],
  ])('an attempt that never reached validation (%s) suppresses nothing: the owner has not been told, so attempt', async (_label, reason) => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    wireDb({ draft: { id: 'send-pi-1', updated_at: DRAFTED_AT }, lastAttempt: { created_at: new Date('2026-06-02T11:05:00Z'), metadata: { sent: false, reason } } });
    mockValidate.mockImplementation(() => ({ errors: ['blocked'], warnings: [] }));
    mockSendProof.mockImplementationOnce(async () => ({ skipped: true, reason: 'validation_failed' }));

    const result = await retryPestInsiderProof({ now: DAY_AFTER });

    expect(mockSendProof).toHaveBeenCalledWith('send-pi-1');
    expect(result.reason).toBe('validation_failed');
  });

  test('a segment that still matches nobody after a notified zero_recipients attempt is skipped quietly', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    mockCountRecipients.mockResolvedValueOnce(0);
    wireDb({ draft: { id: 'send-pi-1', updated_at: DRAFTED_AT, segment_filter: { tag: 'nobody' } }, lastAttempt: { created_at: new Date('2026-06-02T11:05:00Z'), metadata: { sent: false, reason: 'zero_recipients', notified: true } } });

    const result = await retryPestInsiderProof({ now: DAY_AFTER });

    expect(result).toEqual({ skipped: true, reason: 'zero_recipients', sendId: 'send-pi-1' });
    expect(mockCountRecipients).toHaveBeenCalledWith({ tag: 'nobody' });
    expect(mockSendProof).not.toHaveBeenCalled();
  });

  test('…but a grown audience is proofed on the next tick', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    mockCountRecipients.mockResolvedValueOnce(12);
    wireDb({ draft: { id: 'send-pi-1', updated_at: DRAFTED_AT }, lastAttempt: { created_at: new Date('2026-06-02T11:05:00Z'), metadata: { sent: false, reason: 'zero_recipients', notified: true } } });

    const result = await retryPestInsiderProof({ now: DAY_AFTER });

    expect(mockSendProof).toHaveBeenCalledWith('send-pi-1');
    expect(result.skipped).toBe(false);
  });

  test('metadata stored as a JSON string is read the same way', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    wireDb({ draft: { id: 'send-pi-1', updated_at: DRAFTED_AT }, lastAttempt: { created_at: new Date('2026-06-02T11:05:00Z'), metadata: JSON.stringify({ sent: false, reason: 'validation_failed', notified: true }) } });
    mockValidate.mockImplementation(() => ({ errors: ['blocked'], warnings: [] }));

    const result = await retryPestInsiderProof({ now: DAY_AFTER });

    expect(result).toEqual({ skipped: true, reason: 'validation_failed', sendId: 'send-pi-1' });
    expect(mockSendProof).not.toHaveBeenCalled();
  });

  test('a recorded block whose owner notice was never delivered suppresses nothing: the owner has not been told', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    wireDb({ draft: { id: 'send-pi-1', updated_at: DRAFTED_AT }, lastAttempt: { created_at: new Date('2026-06-02T11:05:00Z'), metadata: { sent: false, reason: 'validation_failed', notified: false } } });
    mockValidate.mockImplementation(() => ({ errors: ['blocked'], warnings: [] }));
    mockSendProof.mockImplementationOnce(async () => ({ skipped: true, reason: 'validation_failed', notified: true }));

    const result = await retryPestInsiderProof({ now: DAY_AFTER });

    expect(mockSendProof).toHaveBeenCalledWith('send-pi-1');
    expect(result.reason).toBe('validation_failed');
  });

  test('a transient failure (validation passes now) is retried even with an attempt on record', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    wireDb({ draft: { id: 'send-pi-1', updated_at: DRAFTED_AT }, lastAttempt: FIRST_ATTEMPT });

    const result = await retryPestInsiderProof({ now: DAY_AFTER });

    expect(mockSendProof).toHaveBeenCalledWith('send-pi-1');
    expect(result).toEqual({ skipped: false, sendId: 'send-pi-1', proofSent: true, reason: null });
  });

  test('a pre-check that itself throws fails open to the proof path', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    wireDb({ draft: { id: 'send-pi-1', updated_at: DRAFTED_AT }, lastAttempt: FIRST_ATTEMPT });
    mockValidate.mockImplementation(() => { throw new Error('validator exploded'); });

    const result = await retryPestInsiderProof({ now: DAY_AFTER });

    expect(mockSendProof).toHaveBeenCalledWith('send-pi-1');
    expect(result.skipped).toBe(false);
  });

  describe('after the 10th of the month', () => {
    const LATE = new Date('2026-06-11T18:15:00Z');
    // wireDb answers audit_log with ONE row for both the last-attempt read and
    // the "was a proof ever sent" read; the latter only checks it exists.
    const SENT_PROOF = { id: 'audit-sent', created_at: new Date('2026-06-04T11:05:00Z'), metadata: { sent: true, reason: null, notified: false } };

    test('a corrected draft whose proof was released by a failed approval is re-proofed (codex #5187 follow-up)', async () => {
      process.env.GATE_PEST_INSIDER_PROOF = 'true';
      wireDb({ draft: { id: 'send-pi-1', updated_at: new Date('2026-06-11T14:00:00Z') }, lastAttempt: SENT_PROOF });

      const result = await retryPestInsiderProof({ now: LATE });

      expect(mockValidate).toHaveBeenCalled();
      expect(mockSendProof).toHaveBeenCalledWith('send-pi-1');
      expect(result).toEqual({ skipped: false, sendId: 'send-pi-1', proofSent: true, reason: null });
    });

    test('…but not while it still fails validation (no repeat notices for an uncorrected draft)', async () => {
      process.env.GATE_PEST_INSIDER_PROOF = 'true';
      wireDb({ draft: { id: 'send-pi-1', updated_at: new Date('2026-06-11T14:00:00Z') }, lastAttempt: SENT_PROOF });
      mockValidate.mockImplementation(() => ({ errors: ['still blocked'], warnings: [] }));

      const result = await retryPestInsiderProof({ now: LATE });

      expect(result.skipped).toBe(true);
      expect(mockSendProof).not.toHaveBeenCalled();
    });

    test('…and a draft no proof was ever sent for stays cut off, however clean it is', async () => {
      process.env.GATE_PEST_INSIDER_PROOF = 'true';
      const { audit } = wireDb({ draft: { id: 'send-pi-1' } });

      const result = await retryPestInsiderProof({ now: LATE });

      expect(result.skipped).toBe(true);
      expect(audit.whereRaw).toHaveBeenCalledWith("metadata->>'sent' = 'true'");
      expect(mockSendProof).not.toHaveBeenCalled();
    });

    test('a failure reading the proof history keeps the cutoff', async () => {
      process.env.GATE_PEST_INSIDER_PROOF = 'true';
      const { audit } = wireDb({ draft: { id: 'send-pi-1' }, lastAttempt: SENT_PROOF });
      audit.first.mockRejectedValue(new Error('audit_log down'));

      const result = await retryPestInsiderProof({ now: LATE });

      expect(result.skipped).toBe(true);
      expect(mockSendProof).not.toHaveBeenCalled();
    });

    test('no draft at all is still a quiet skip', async () => {
      process.env.GATE_PEST_INSIDER_PROOF = 'true';
      wireDb({});
      expect((await retryPestInsiderProof({ now: LATE })).skipped).toBe(true);
    });
  });

  test('after the 10th of the month a stale draft is not proofed', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    wireDb({ draft: { id: 'send-pi-1' } });

    const result = await retryPestInsiderProof({ now: new Date('2026-06-11T18:15:00Z') });

    expect(result.skipped).toBe(true);
    expect(mockSendProof).not.toHaveBeenCalled();
  });
});
