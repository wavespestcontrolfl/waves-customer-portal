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
let mockCustomerFirstQueue = null; // shift per customers.first(); an Error value throws
let mockSubscriberRow = null; // newsletter_subscribers.first() (DOI dedupe guard)
let mockSubscriberUpdates = [];
let mockOnFirstTouchClaim = null; // fires when a claim update lands (race simulation)
let mockTriageFirstQueue = null; // shift per triage_items.first()
jest.mock('../models/db', () => {
  const handler = (table) => {
    const chain = {
      where: jest.fn(() => chain),
      whereIn: jest.fn(() => chain),
      whereRaw: jest.fn(() => chain),
      whereNotNull: jest.fn(() => chain),
      whereNull: jest.fn(() => chain),
      whereNot: jest.fn(() => chain),
      orWhereNot: jest.fn(() => chain),
      whereExists: jest.fn(() => chain),
      whereNotExists: jest.fn(() => chain),
      from: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      limit: jest.fn(() => chain),
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
          if (patch.status === 'releasing' && mockOnFirstTouchClaim) mockOnFirstTouchClaim();
        }
        if (table === 'newsletter_subscribers') mockSubscriberUpdates.push(patch);
        return 1;
      }),
      first: jest.fn(async () => {
        if (table === 'first_touch_holds') return mockHold;
        if (table === 'customers') {
          if (mockCustomerFirstQueue && mockCustomerFirstQueue.length) {
            const next = mockCustomerFirstQueue.shift();
            if (next instanceof Error) throw next;
            return next;
          }
          return mockCustomerRow;
        }
        if (table === 'call_log') return mockDncRow;
        if (table === 'triage_items') {
          if (mockTriageFirstQueue && mockTriageFirstQueue.length) return mockTriageFirstQueue.shift();
          return mockTriageCardRow;
        }
        if (table === 'newsletter_subscribers') return mockSubscriberRow;
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

const {
  resumeHeldFirstTouch,
  recordFirstTouchHold,
  resumeHeldNewsletterPostCommit,
  sweepAbandonedFirstTouchHolds,
} = require('../services/lead-first-touch-resume');
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
  mockCustomerFirstQueue = null;
  mockSubscriberRow = null;
  mockSubscriberUpdates = [];
  mockOnFirstTouchClaim = null;
  mockTriageFirstQueue = null;
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

  test('a release stamps held_email with the address it actually targeted', async () => {
    await resumeHeldFirstTouch({ customerId: 'cust-1', email: 'corrected@example.com' });
    expect(mockHoldUpdates.at(-1)).toMatchObject({ held_email: 'corrected@example.com', status: 'released' });
  });

  test('a released settle re-pends when newsletter work merged during the claim', async () => {
    // Step 8 merges held_newsletter=true while a drip-only release is in
    // flight (the merge preserves the 'releasing' claim). The claimant's
    // stale snapshot would settle 'released' and bury the newsletter — the
    // post-settle re-read flips the row back to pending.
    mockHold = baseHold({ held_newsletter: false });
    mockEnroll.mockImplementationOnce(async () => {
      mockHold = { ...mockHold, held_newsletter: true, released_drip: true, status: 'released' };
      return { enrolled: true };
    });
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res.enrolled).toBe(true);
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'pending', last_error: 'work_merged_during_release' });
  });

  test('a thrown direct newsletter resume re-pends the claim and logs only sanitized codes', async () => {
    const dbErr = new Error('duplicate key value violates unique constraint — (email)=(secret@example.com)');
    dbErr.code = '23505';
    mockNewsletter.mockRejectedValueOnce(dbErr);
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    // Drip released, newsletter undelivered → retryable, never stranded
    // 'releasing' with the card already resolved.
    expect(res.enrolled).toBe(true);
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'pending', last_error: 'newsletter_doi_not_confirmed' });
    for (const call of logger.warn.mock.calls) {
      expect(String(call[0])).not.toContain('secret@example.com');
    }
  });

  test('a lost atomic claim skips the hold — no duplicate DOI from racing release paths', async () => {
    mockClaimFails = true;
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res.resumed).toBe(false);
    expect(mockEnroll).not.toHaveBeenCalled();
    expect(mockNewsletter).not.toHaveBeenCalled();
  });

  test('a mid-loop failure re-pends EVERY outstanding deferred claim, not just the in-flight one', async () => {
    // Hold-1 defers its newsletter (claim stays 'releasing', payload
    // accumulated); the customer lookup for hold-2 then throws. The error
    // return discards hold-1's payload — its claim must be restored too,
    // or the DOI is stranded 'releasing' with nothing left to execute.
    mockHolds = [
      baseHold({ id: 'hold-1', call_log_id: 'call-1' }),
      baseHold({ id: 'hold-2', call_log_id: 'call-2' }),
    ];
    const dbErr = new Error('connection reset');
    dbErr.code = 'ECONNRESET';
    mockCustomerFirstQueue = [{ id: 'cust-1', first_name: 'Pat', last_name: 'Sample' }, dbErr];
    const res = await resumeHeldFirstTouch({ customerId: 'cust-1', email: 'corrected@example.com', deferNewsletter: true });
    expect(res.skipped).toBe('error');
    expect(res.newsletterResume).toBeNull();
    const repens = mockHoldUpdates.filter((u) => u.status === 'pending' && String(u.last_error || '').startsWith('resume_failed'));
    expect(repens).toHaveLength(2);
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

  test('a hold RELEASED during this run re-pends against the address that release confirmed', async () => {
    // The release stamps held_email with the address it actually targeted —
    // corrected value after a correction, unchanged after an as-is accept.
    // The stored customer email is NEVER used when the row carries one: for
    // a matched existing customer it can be a stale address the operator
    // did not confirm.
    const runStartedAt = new Date(Date.now() - 60_000);
    mockHold = baseHold({ status: 'released', released_at: new Date(), held_email: 'confirmed@example.com' });
    mockCustomerRow = { id: 'cust-1', email: 'stale@stored.com' };
    await recordFirstTouchHold({
      callLogId: 'call-1', customerId: 'cust-1',
      heldEmail: 'original@example.com', heldNewsletter: true, runStartedAt,
    });
    expect(mockMergeArgs.at(-1).held_email).toBe('confirmed@example.com');
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

  test('payloads for the same recipient coalesce into ONE DOI that settles every hold', async () => {
    mockHold = { held_drip: false, released_drip: false };
    const outcomes = await resumeHeldNewsletterPostCommit([
      { holdId: 'hold-1', customerId: 'cust-1', email: 'same@example.com' },
      { holdId: 'hold-2', customerId: 'cust-1', email: 'same@example.com' },
    ]);
    expect(mockNewsletter).toHaveBeenCalledTimes(1);
    expect(outcomes).toHaveLength(1);
    const settles = mockHoldUpdates.filter((u) => u.released_newsletter === true);
    expect(settles).toHaveLength(2);
  });
});

describe('deny-stamped holds and dedupe hardening (r14)', () => {
  test('a deny-stamped hold never releases via automated triggers', async () => {
    mockHold = baseHold({ last_error: 'email_denied_await_correction' });
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res.skipped).toBe('email_denied');
    expect(mockEnroll).not.toHaveBeenCalled();
    expect(mockNewsletter).not.toHaveBeenCalled();
    // Claim released back to pending; the stamp itself is untouched.
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'pending' });
    expect(mockHoldUpdates.at(-1).last_error).toBeUndefined();
  });

  test('an explicit correction releases a deny-stamped hold', async () => {
    mockHold = baseHold({ last_error: 'email_denied_await_correction' });
    const res = await resumeHeldFirstTouch({ customerId: 'cust-1', email: 'corrected@example.com' });
    expect(res.enrolled).toBe(true);
  });

  test('a deny stamp landing AFTER the claim is still honored (fresh pre-send re-read)', async () => {
    // The verdict's bulk resolve precedes its stamp upsert — a claim in
    // that gap sees an unstamped snapshot; the pre-send re-read must catch
    // the stamp that landed since.
    mockHold = baseHold();
    mockOnFirstTouchClaim = () => {
      mockHold = { ...mockHold, last_error: 'email_denied_await_correction' };
    };
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res.skipped).toBe('email_denied');
    expect(mockEnroll).not.toHaveBeenCalled();
    expect(mockNewsletter).not.toHaveBeenCalled();
  });

  test('a hold re-pended for an unconfirmed DOI bypasses the dedupe stamp and re-sends', async () => {
    // The send failed; even if the pre-send stamp survived a failed
    // cleanup, this retry must actually send.
    mockHold = baseHold({ held_drip: false, last_error: 'newsletter_doi_not_confirmed' });
    mockSubscriberRow = { status: 'pending', confirmation_sent_at: new Date() };
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(mockNewsletter).toHaveBeenCalled();
    expect(res.resumed).toBe(true);
  });

  test('the dedupe skip still links an unlinked pending subscriber', async () => {
    mockHold = baseHold({ held_drip: false });
    mockSubscriberRow = { status: 'pending', confirmation_sent_at: new Date() };
    await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(mockNewsletter).not.toHaveBeenCalled();
    expect(mockSubscriberUpdates.at(-1)).toMatchObject({ customer_id: 'cust-1' });
  });

  test('post-commit re-pends when a superseded target is suppressed', async () => {
    mockHold = { held_drip: false, released_drip: false, held_email: 'superseded@example.com', last_error: null };
    mockSuppressionRow = { id: 'sup-1', suppression_type: 'bounce', group_key: null };
    const outcome = await resumeHeldNewsletterPostCommit({ holdId: 'hold-1', customerId: 'cust-1', email: 'original@example.com' });
    expect(outcome).toMatchObject({ skipped: 'email_suppressed' });
    expect(mockNewsletter).not.toHaveBeenCalled();
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'pending', last_error: 'email_suppressed' });
  });

  test('recordFirstTouchHold coerces a missing address to an inert empty string', async () => {
    // Email demoted at intake: the hold still records (NOT NULL satisfied
    // by ''), stays send-safe behind the invalid-address guard, and waits
    // for the correction fanout.
    mockHold = null;
    const ok = await recordFirstTouchHold({ callLogId: 'call-1', customerId: 'cust-1', heldEmail: null, heldNewsletter: true });
    expect(ok).toBe(true);
    expect(mockMergeArgs.at(-1).held_email).toBe('');
  });
});

describe('DOI dedupe guard and ledger sweep', () => {
  test('a pending subscriber with a RECENT confirmation skips the resend and settles', async () => {
    // The DOI already went out (e.g. a settle failure re-pended the hold
    // after a successful send) — the retry must settle without a second
    // confirmation email.
    mockSubscriberRow = { status: 'pending', confirmation_sent_at: new Date() };
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(mockNewsletter).not.toHaveBeenCalled();
    expect(res.resumed).toBe(true);
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'released', released_newsletter: true });
  });

  test('the sweep releases an abandoned hold whose review question is answered', async () => {
    mockHolds = [baseHold()];
    // live-card check → none; resolved-card check → answered.
    mockTriageFirstQueue = [null, { id: 'resolved-1' }];
    const swept = await sweepAbandonedFirstTouchHolds({});
    expect(swept).toMatchObject({ examined: 1, released: 1 });
    expect(mockEnroll).toHaveBeenCalled();
  });

  test('the sweep never releases a hold that is still under review or never reviewed', async () => {
    mockHolds = [baseHold(), baseHold({ id: 'hold-2', call_log_id: 'call-2' })];
    mockTriageFirstQueue = [
      { id: 'live-1' }, // hold 1: card still live → skip
      null, null, // hold 2: no live card AND no resolved card → never reviewed → skip
    ];
    const swept = await sweepAbandonedFirstTouchHolds({});
    expect(swept).toMatchObject({ examined: 2, released: 0 });
    expect(mockEnroll).not.toHaveBeenCalled();
  });
});
