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
      merge: jest.fn(async () => 1),
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

const { resumeHeldFirstTouch } = require('../services/lead-first-touch-resume');

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
