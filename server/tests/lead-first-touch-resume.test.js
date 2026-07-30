/**
 * Release engine for the first_touch_holds ledger (2026-07-30 lane): the
 * pending hold row — not review-card state — is the source of truth. Consent
 * re-checks (do-not-contact → blocked, canonical suppression groups), the
 * held address wins over any stored customer email, DOI delivery failures
 * keep the row retryable, and nothing ever throws into a caller.
 */

let mockHold = null;
let mockHolds = null; // overrides single-hold mode when set
let mockClaimFails = false;
let mockDncRow = null;
let mockSuppressionRow = null;
let mockCustomerRow = { id: 'cust-1', first_name: 'Pat', last_name: 'Sample' };
let mockHoldUpdates = [];
let mockTriageCardRow = null;
let mockMergeFailures = 0;
let mockMergeArgs = [];
jest.mock('../models/db', () => {
  const handler = (table) => {
    const chain = {
      where: jest.fn(() => chain),
      whereIn: jest.fn(() => chain),
      whereRaw: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      select: jest.fn(() => chain),
      insert: jest.fn(() => chain),
      onConflict: jest.fn(() => chain),
      merge: jest.fn(async (patch) => {
        if (table === 'first_touch_holds') {
          if (mockMergeFailures > 0) {
            mockMergeFailures--;
            throw new Error('transient db error');
          }
          mockMergeArgs.push(patch);
        }
        return 1;
      }),
      update: jest.fn(async (patch) => {
        if (table === 'first_touch_holds') {
          if (patch.status === 'releasing' && mockClaimFails) return 0;
          mockHoldUpdates.push(patch);
        }
        return 1;
      }),
      first: jest.fn(async () => {
        if (table === 'first_touch_holds') return mockHold;
        if (table === 'customers') return mockCustomerRow;
        if (table === 'call_log') return mockDncRow;
        if (table === 'triage_items') return mockTriageCardRow;
        if (table === 'automation_templates') return { key: 'new_lead' };
        return null;
      }),
      then: (resolve, reject) => Promise.resolve(
        table === 'email_suppressions' ? (mockSuppressionRow ? [mockSuppressionRow] : [])
          : table === 'first_touch_holds' ? (mockHolds || (mockHold ? [mockHold] : []))
            : []
      ).then(resolve, reject),
    };
    return chain;
  };
  const db = jest.fn(handler);
  db.schema = { hasTable: jest.fn(async () => true) };
  db.raw = jest.fn((x) => x);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockEnroll = jest.fn(async () => ({ enrolled: true }));
jest.mock('../services/automation-runner', () => ({
  enrollCustomer: (...a) => mockEnroll(...a),
  automationSuppressionMatches: (_t, row) => String(row?.suppression_type || '') === 'bounce' || !row?.group_key,
}));

const mockNewsletter = jest.fn(async () => ({ subscribed: true, confirmationEmailSent: true }));
jest.mock('../services/call-recording-processor', () => ({
  resumeNewsletterForCallCustomer: (...a) => mockNewsletter(...a),
}));

const { resumeHeldFirstTouch, recordFirstTouchHold, resumeHeldNewsletterPostCommit } = require('../services/lead-first-touch-resume');
const logger = require('../services/logger');

function baseHold(overrides = {}) {
  return {
    id: 'hold-1', call_log_id: 'call-1', customer_id: 'cust-1',
    held_email: 'confirmed@example.com', held_drip: true, held_newsletter: true,
    released_drip: false, released_newsletter: false, status: 'pending',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHold = baseHold();
  mockHolds = null;
  mockClaimFails = false;
  mockDncRow = null;
  mockSuppressionRow = null;
  mockHoldUpdates = [];
  mockCustomerRow = { id: 'cust-1', first_name: 'Pat', last_name: 'Sample' };
  mockTriageCardRow = null;
  mockMergeFailures = 0;
  mockMergeArgs = [];
});

describe('resumeHeldFirstTouch (ledger release engine)', () => {
  test('releases drip + newsletter to the HELD address, then marks the row released', async () => {
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res.resumed).toBe(true);
    expect(mockEnroll).toHaveBeenCalledWith(expect.objectContaining({
      customer: expect.objectContaining({ email: 'confirmed@example.com', id: 'cust-1' }),
    }));
    expect(mockNewsletter).toHaveBeenCalledWith(expect.objectContaining({ email: 'confirmed@example.com' }));
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'released', released_drip: true, released_newsletter: true });
  });

  test('a corrected email overrides the held address', async () => {
    await resumeHeldFirstTouch({ customerId: 'cust-1', email: 'corrected@example.com' });
    expect(mockEnroll).toHaveBeenCalledWith(expect.objectContaining({
      customer: expect.objectContaining({ email: 'corrected@example.com' }),
    }));
  });

  test('no pending hold → no-op (normally-enrolled customers are untouched)', async () => {
    mockHold = null;
    const res = await resumeHeldFirstTouch({ customerId: 'cust-1' });
    expect(res).toMatchObject({ resumed: false, skipped: 'no_pending_hold' });
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  test('do-not-contact veto blocks the hold terminally', async () => {
    mockDncRow = { id: 'call-1' };
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res).toMatchObject({ resumed: false, skipped: 'do_not_contact' });
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'blocked' });
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  test('a global bounce suppression keeps the hold pending (retryable after correction)', async () => {
    mockSuppressionRow = { id: 'sup-1', suppression_type: 'bounce', group_key: null };
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res).toMatchObject({ resumed: false, skipped: 'email_suppressed' });
    // The claim reverts to pending explicitly — retryable, never released.
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'pending', last_error: 'email_suppressed' });
  });

  test('an unrelated group-scoped suppression does NOT block (canonical group semantics)', async () => {
    mockSuppressionRow = { id: 'sup-2', suppression_type: 'unsubscribe', group_key: 'service_operational' };
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res.enrolled).toBe(true);
  });

  test('invalid held address keeps the row pending for a later correction', async () => {
    mockHold = baseHold({ held_email: 'not-an-email' });
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res).toMatchObject({ resumed: false, skipped: 'invalid_email' });
    expect(mockHoldUpdates.at(-1)).toMatchObject({ last_error: 'invalid_email' });
  });

  test('enroll failure keeps the row pending with last_error (retryable release)', async () => {
    mockEnroll.mockRejectedValueOnce(new Error('automation db down'));
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res).toMatchObject({ resumed: false, skipped: 'enroll_failed' });
    expect(String(mockHoldUpdates.at(-1).last_error)).toContain('enroll_failed');
  });

  test('DOI delivery failure releases the drip but keeps the newsletter retryable', async () => {
    mockNewsletter.mockResolvedValueOnce({ subscribed: true, confirmationEmailSent: false });
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res.enrolled).toBe(true);
    const last = mockHoldUpdates.at(-1);
    expect(last.released_drip).toBe(true);
    expect(last.released_newsletter).toBeUndefined();
    // Claim reverts to pending — the DOI retry stays live.
    expect(last.status).toBe('pending');
    expect(last.last_error).toBe('newsletter_doi_not_confirmed');
  });

  test('deferNewsletter returns the payload instead of sending mid-transaction', async () => {
    const res = await resumeHeldFirstTouch({ customerId: 'cust-1', email: 'corrected@example.com', deferNewsletter: true });
    expect(mockNewsletter).not.toHaveBeenCalled();
    expect(res.newsletterResume).toEqual([expect.objectContaining({ holdId: 'hold-1', email: 'corrected@example.com' })]);
  });

  test('a lost atomic claim skips the hold — no duplicate DOI from racing release paths', async () => {
    mockClaimFails = true;
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res.resumed).toBe(false);
    expect(mockEnroll).not.toHaveBeenCalled();
    expect(mockNewsletter).not.toHaveBeenCalled();
  });

  test('an email correction releases EVERY pending hold for the customer', async () => {
    mockHolds = [
      baseHold({ id: 'hold-1', call_log_id: 'call-1', held_newsletter: true }),
      baseHold({ id: 'hold-2', call_log_id: 'call-2', held_newsletter: false }),
    ];
    const res = await resumeHeldFirstTouch({ customerId: 'cust-1', email: 'corrected@example.com' });
    expect(res.resumed).toBe(true);
    expect(mockEnroll).toHaveBeenCalledTimes(2);
  });

  test('newsletter-only hold with drip already released settles cleanly', async () => {
    mockHold = baseHold({ held_drip: false });
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(mockEnroll).not.toHaveBeenCalled();
    expect(res.resumed).toBe(true);
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'released', released_newsletter: true });
  });
});

describe('recordFirstTouchHold (durable hold ledger writes)', () => {
  test('records the held address as given when no prior row complicates it', async () => {
    mockHold = null;
    const ok = await recordFirstTouchHold({
      callLogId: 'call-1', customerId: 'cust-1',
      heldEmail: 'Guess@Example.com', heldDrip: true, runStartedAt: new Date(),
    });
    expect(ok).toBe(true);
    expect(mockMergeArgs.at(-1).held_email).toBe('guess@example.com');
  });

  test('a live card from an EARLIER run keeps the address the operator is reviewing', async () => {
    // Force-reprocess: triage inserts retain the old card via
    // onConflict-ignore, so resolving it must release the address it shows —
    // never a newer unreviewed extraction.
    mockHold = baseHold({ held_email: 'reviewed@example.com', status: 'pending' });
    mockTriageCardRow = { id: 'card-old' };
    await recordFirstTouchHold({
      callLogId: 'call-1', customerId: 'cust-1',
      heldEmail: 'newguess@example.com', heldDrip: true, runStartedAt: new Date(),
    });
    expect(mockMergeArgs.at(-1).held_email).toBe('reviewed@example.com');
  });

  test('a hold RELEASED during this run re-pends against the settled (corrected) address', async () => {
    // Operator corrected the email mid-run: the fanout released the drip and
    // wrote the corrected address to the customer row. The later newsletter
    // hold must target that, never the stale pre-correction candidate.
    const runStartedAt = new Date(Date.now() - 60_000);
    mockHold = baseHold({ status: 'released', released_at: new Date(), held_email: 'original@example.com' });
    mockCustomerRow = { id: 'cust-1', email: 'corrected@example.com' };
    await recordFirstTouchHold({
      callLogId: 'call-1', customerId: 'cust-1',
      heldEmail: 'original@example.com', heldNewsletter: true, runStartedAt,
    });
    expect(mockMergeArgs.at(-1).held_email).toBe('corrected@example.com');
  });

  test('a hold released in an EARLIER cycle re-pends normally with the fresh address', async () => {
    const runStartedAt = new Date();
    mockHold = baseHold({ status: 'released', released_at: new Date(Date.now() - 3_600_000), held_email: 'old@example.com' });
    await recordFirstTouchHold({
      callLogId: 'call-1', customerId: 'cust-1',
      heldEmail: 'fresh@example.com', heldDrip: true, runStartedAt,
    });
    expect(mockMergeArgs.at(-1).held_email).toBe('fresh@example.com');
  });

  test('retries a transient write failure and succeeds', async () => {
    mockHold = null;
    mockMergeFailures = 1;
    const ok = await recordFirstTouchHold({
      callLogId: 'call-1', customerId: 'cust-1', heldEmail: 'a@example.com', heldDrip: true,
    });
    expect(ok).toBe(true);
    expect(mockMergeArgs).toHaveLength(1);
  });

  test('returns null only after exhausting every attempt', async () => {
    mockHold = null;
    mockMergeFailures = 99;
    const ok = await recordFirstTouchHold({
      callLogId: 'call-1', customerId: 'cust-1', heldEmail: 'a@example.com', heldDrip: true,
    });
    expect(ok).toBeNull();
    expect(mockMergeArgs).toHaveLength(0);
  });

  test('the merge never demotes an active releasing claim back to pending', async () => {
    // A triage accept / correction mid-release must keep its claim — a
    // demotion would let a second release path claim the row and send a
    // duplicate DOI.
    mockHold = null;
    await recordFirstTouchHold({ callLogId: 'call-1', customerId: 'cust-1', heldEmail: 'a@example.com', heldDrip: true });
    expect(String(mockMergeArgs.at(-1).status)).toContain("WHEN first_touch_holds.status = 'releasing' THEN 'releasing'");
  });
});

describe('resumeHeldNewsletterPostCommit failure paths', () => {
  test('re-pends the hold when the resume throws — and logs only a sanitized code', async () => {
    const dbErr = new Error('duplicate key value violates unique constraint "newsletter_subscribers_email_unique" — (email)=(private@example.com)');
    dbErr.code = '23505';
    mockNewsletter.mockRejectedValueOnce(dbErr);
    const outcome = await resumeHeldNewsletterPostCommit({ holdId: 'hold-1', customerId: 'cust-1', email: 'private@example.com' });
    expect(outcome).toBeNull();
    // Retryable state restored — the claim must not linger 'releasing'.
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'pending' });
    expect(String(mockHoldUpdates.at(-1).last_error)).toContain('newsletter_resume_failed: 23505');
    // No raw error message (which can echo the subscriber email) in logs.
    for (const call of logger.warn.mock.calls) {
      expect(String(call[0])).not.toContain('private@example.com');
    }
  });

  test('a successful post-commit resume settles the hold as released', async () => {
    mockHold = { held_drip: false, released_drip: false };
    const outcome = await resumeHeldNewsletterPostCommit({ holdId: 'hold-1', customerId: 'cust-1', email: 'ok@example.com' });
    expect(outcome).toMatchObject({ subscribed: true });
    expect(mockHoldUpdates.at(-1)).toMatchObject({ released_newsletter: true, status: 'released' });
  });
});
