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
let mockSubscriberFirstError = null; // thrown by newsletter_subscribers.first()
let mockDoiMarkerRow = null; // result of the coalesced resend-marker lookup (r23)
let mockDenyMarkerRow = null; // result of the coalesced deny-veto lookup (r25)
let mockDoiMarkerError = null; // thrown by that lookup
let mockSubscriberUpdates = [];
let mockSubscriberUpdateError = null;
let mockOnFirstTouchClaim = null; // fires when a claim update lands (race simulation)
let mockHoldFirstQueue = null; // shift per first_touch_holds.first(); an Error value throws
let mockTriageFirstQueue = null; // shift per triage_items.first()
let mockReleasedSettleZeroOnce = false; // next released-settle matches 0 rows (mid-send retarget)
let mockRepenGuardZeroTimes = 0; // next N guarded re-pends match 0 rows (deny stamp landed)
let mockEnrollmentUpdates = []; // automation_enrollments update() patches
let mockClaimStampById = {}; // claim fence stamps recorded per hold id (r27)
let mockClaimLost = false; // fence reads report the claim as reclaimed (r27)
let mockRenewLostIds = new Set(); // per-hold lease-renewal refusals (r28)
jest.mock('../models/db', () => {
  const handler = (table) => {
    let markerFilter = false; // this chain filters on the resend marker
    let denyFilter = false; // this chain filters on the deny stamp
    let whereId = null; // the chain's {id} filter (fence stamp bookkeeping)
    const chain = {
      where: jest.fn((arg) => {
        if (arg && arg.last_error === 'newsletter_doi_not_confirmed') markerFilter = true;
        if (arg && arg.last_error === 'email_denied_await_correction') denyFilter = true;
        if (arg && arg.id !== undefined) whereId = arg.id;
        return chain;
      }),
      whereIn: jest.fn(() => chain),
      whereRaw: jest.fn(() => chain),
      whereNotNull: jest.fn(() => chain),
      whereNull: jest.fn(() => chain),
      whereNot: jest.fn(() => chain),
      orWhereNot: jest.fn(() => chain),
      whereExists: jest.fn(() => chain),
      whereNotExists: jest.fn(() => chain),
      forUpdate: jest.fn(() => chain),
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
          // A landing claim's updated_at is its fence stamp (r27) —
          // remember it per hold so the fence reads below can echo it.
          if (patch.status === 'releasing' && patch.updated_at && whereId != null) {
            mockClaimStampById[whereId] = patch.updated_at;
          }
          // Lease renewal (r28): the CAS bump is the only updated_at-only
          // write. Refuse when the claim was reclaimed; otherwise record
          // the fresh stamp — it is NOT a settle, so it never lands in
          // mockHoldUpdates.
          if (patch.updated_at && Object.keys(patch).length === 1) {
            if (mockClaimLost || mockRenewLostIds.has(whereId)) return 0;
            if (whereId != null) mockClaimStampById[whereId] = patch.updated_at;
            return 1;
          }
          if (patch.status === 'released' && mockReleasedSettleZeroOnce) {
            mockReleasedSettleZeroOnce = false;
            return 0; // conditional settle: target no longer matches
          }
          if (patch.status === 'pending' && patch.last_error && mockRepenGuardZeroTimes > 0) {
            mockRepenGuardZeroTimes--;
            return 0; // guarded write refused: deny stamp / target mismatch
          }
          mockHoldUpdates.push(patch);
          if (patch.status === 'releasing' && mockOnFirstTouchClaim) mockOnFirstTouchClaim();
        }
        if (table === 'newsletter_subscribers') {
          if (mockSubscriberUpdateError) throw mockSubscriberUpdateError;
          mockSubscriberUpdates.push(patch);
        }
        if (table === 'automation_enrollments') {
          mockEnrollmentUpdates.push(patch);
        }
        return 1;
      }),
      first: jest.fn(async (...cols) => {
        if (table === 'first_touch_holds') {
          if (denyFilter) {
            if (mockDoiMarkerError) throw mockDoiMarkerError;
            return mockDenyMarkerRow;
          }
          if (markerFilter) {
            if (mockDoiMarkerError) throw mockDoiMarkerError;
            return mockDoiMarkerRow;
          }
          if (mockHoldFirstQueue && mockHoldFirstQueue.length) {
            const next = mockHoldFirstQueue.shift();
            if (next instanceof Error) throw next;
            // The pre-send re-read carries the fence fields since r27 —
            // supply a passing fence unless the row overrides them.
            if (next && cols.length === 4 && cols[0] === 'held_email') {
              return mockClaimLost
                ? { status: 'pending', updated_at: new Date(0), ...next }
                : { status: 'releasing', updated_at: mockClaimStampById[whereId], ...next };
            }
            return next;
          }
          if (mockHold && cols.length === 4 && cols[0] === 'held_email') {
            return mockClaimLost
              ? { ...mockHold, status: 'pending', updated_at: new Date(0) }
              : { ...mockHold, status: 'releasing', updated_at: mockClaimStampById[whereId] };
          }
          return mockHold;
        }
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
        if (table === 'newsletter_subscribers') {
          if (mockSubscriberFirstError) throw mockSubscriberFirstError;
          return mockSubscriberRow;
        }
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
  db.raw = jest.fn((sql, bindings) => (bindings === undefined ? sql : { sql, bindings }));
  // The r29 enroll validation wraps creation in a transaction (a savepoint
  // on trx handles) — the stub hands back the same connection.
  db.transaction = jest.fn(async (fn) => fn(db));
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
  // Default: the subscriber still carries the attempted address, so the
  // r25 send-failure verify arms the genuine force-resend marker.
  mockSubscriberRow = { id: 'sub-1' };
  mockSubscriberUpdates = [];
  mockSubscriberUpdateError = null;
  mockSubscriberFirstError = null;
  mockDoiMarkerRow = null;
  mockDenyMarkerRow = null;
  mockDoiMarkerError = null;
  mockOnFirstTouchClaim = null;
  mockHoldFirstQueue = null;
  mockTriageFirstQueue = null;
  mockReleasedSettleZeroOnce = false;
  mockRepenGuardZeroTimes = 0;
  mockEnrollmentUpdates = [];
  mockClaimStampById = {};
  mockClaimLost = false;
  mockRenewLostIds = new Set();
});

// The merge's held_email is a bound CASE since r20 (an ACTIVE claim's target
// is preserved over a fresh extraction guess; with runStartedAt the r30
// released-during-run branch adds a leading timestamp binding) — the
// fallback address is always the LAST binding.
function mergedHeldEmail(mergeArg) {
  const v = mergeArg.held_email;
  return typeof v === 'string' ? v : v.bindings[v.bindings.length - 1];
}

describe('resumeHeldFirstTouch (ledger release engine)', () => {
  test('releases drip + newsletter to the HELD address, then marks the row released', async () => {
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res.resumed).toBe(true);
    expect(mockEnroll).toHaveBeenCalledWith(expect.objectContaining({
      customer: expect.objectContaining({ email: 'confirmed@example.com', id: 'cust-1' }),
    }));
    expect(mockNewsletter).toHaveBeenCalledWith(expect.objectContaining({ email: 'confirmed@example.com' }));
    // The drip settlement commits WITH the enrollment (Codex #3084 r30):
    // a deny landing after the enroll transaction always finds the release
    // durably recorded, never an active enrollment with no ledger trace.
    expect(mockHoldUpdates[1]).toMatchObject({ released_drip: true, held_email: 'confirmed@example.com' });
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

  test('a claim reclaimed by the sweep fences the suspended worker out before any send', async () => {
    // The worker suspended past the stale-claim window; the sweep reclaimed
    // the row (its claim bumped updated_at). The resumed worker's pre-send
    // fence check sees the changed stamp and walks away without sending OR
    // writing — the reclaimer owns both (Codex #3084 r27).
    mockClaimLost = true;
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res).toMatchObject({ resumed: false, skipped: 'claim_lost' });
    expect(mockEnroll).not.toHaveBeenCalled();
    expect(mockNewsletter).not.toHaveBeenCalled();
    // The only ledger write is this worker's own claim — no settle, no
    // re-pend touches the reclaimer's row.
    expect(mockHoldUpdates).toHaveLength(1);
    expect(mockHoldUpdates[0]).toMatchObject({ status: 'releasing' });
  });

  test('a claim lost after the enroll transaction never sends the DOI', async () => {
    // In prod the enroll transaction's row lock + in-trx renewal make a
    // mid-enroll reclaim impossible (r29/r30) — this exercises the
    // defensive path where the lease is lost between the committed enroll
    // and the DOI: the claim-time skipDedupe marker would bypass the
    // dedupe guard on a blind resume, so the pre-DOI renewal refuses and
    // the worker abandons with the drip release already durably recorded.
    mockHold = baseHold({ last_error: 'newsletter_doi_not_confirmed' });
    mockEnroll.mockImplementationOnce(async () => {
      mockClaimLost = true;
      return { enrolled: true };
    });
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res.skipped).toBe('claim_lost');
    expect(mockNewsletter).not.toHaveBeenCalled();
    // The claim, then the in-trx drip settlement (r30) — nothing after.
    expect(mockHoldUpdates).toHaveLength(2);
    expect(mockHoldUpdates[1]).toMatchObject({ released_drip: true });
  });

  test('a post-commit callback that lost its claims abandons the deferred DOI', async () => {
    // The deferred payload carries the claim's fence stamp; a callback
    // delayed past the stale-claim window finds every grouped hold
    // reclaimed and abandons the send — the sweep's own release owns it
    // (Codex #3084 r27).
    const res = await resumeHeldFirstTouch({ customerId: 'cust-1', email: 'corrected@example.com', deferNewsletter: true });
    expect(res.newsletterResume).toEqual([expect.objectContaining({ holdId: 'hold-1', claimStamp: expect.any(Date) })]);
    mockClaimLost = true;
    const outcome = await resumeHeldNewsletterPostCommit(res.newsletterResume);
    expect(outcome).toEqual([{ skipped: 'claim_lost' }]);
    expect(mockNewsletter).not.toHaveBeenCalled();
  });

  test('one reclaimed sibling abandons the whole coalesced post-commit send', async () => {
    // The DOI is shared across the group: a sibling lost to the sweep's
    // reclaim means the reclaimer may already own that exact send, and the
    // group's skipDedupe marker could bypass the dedupe guard — one lost
    // lease abandons the send and re-pends the still-owned siblings for
    // the sweep's guarded retry (Codex #3084 r28).
    mockHolds = [
      baseHold({ id: 'hold-1', held_drip: false }),
      baseHold({ id: 'hold-2', call_log_id: 'call-2', held_drip: false }),
    ];
    const res = await resumeHeldFirstTouch({ customerId: 'cust-1', email: 'corrected@example.com', deferNewsletter: true });
    expect(res.newsletterResume).toHaveLength(2);
    mockRenewLostIds.add('hold-2');
    const outcome = await resumeHeldNewsletterPostCommit(res.newsletterResume);
    expect(outcome).toEqual([{ skipped: 'claim_lost' }]);
    expect(mockNewsletter).not.toHaveBeenCalled();
    const repens = mockHoldUpdates.filter((u) => u.last_error === 'claim_lost');
    expect(repens.length).toBeGreaterThanOrEqual(1); // owned sibling re-pends (lost one is fenced out in prod)
  });

  test('a deny stamped before the enroll lock creates no enrollment at all', async () => {
    // The denial's updated_at bump invalidates the lease and preserves the
    // target (Codex #3084 r28); with creation and validation atomic under
    // the row lock (r29), the deny is seen BEFORE enrollCustomer — no
    // immediately-due enrollment ever exists for the scheduler to pick up,
    // and the stamp survives untouched. A deny landing DURING the enroll
    // is impossible: its stamp write blocks on the same row lock until the
    // validated enrollment commits.
    mockEnroll.mockResolvedValueOnce({ enrolled: true, enrollmentId: 'enr-new' });
    mockHold = baseHold({ held_newsletter: false });
    mockHoldFirstQueue = [
      { held_email: 'confirmed@example.com', last_error: null }, // pre-send re-read
      // locked validation: deny landed — its bump broke the fence
      { held_email: 'confirmed@example.com', last_error: 'email_denied_await_correction', status: 'releasing', updated_at: new Date(0) },
    ];
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res.skipped).toBe('email_denied');
    expect(mockEnroll).not.toHaveBeenCalled();
    expect(mockEnrollmentUpdates).toHaveLength(0);
    expect(mockHoldUpdates).toHaveLength(1); // the claim only — the stamp survives untouched
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
    expect(mergedHeldEmail(mockMergeArgs.at(-1))).toBe('guess@example.com');
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
    expect(mergedHeldEmail(mockMergeArgs.at(-1))).toBe('reviewed@example.com');
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
    expect(mergedHeldEmail(mockMergeArgs.at(-1))).toBe('confirmed@example.com');
    // The adoption is ATOMIC in the conflict expression too (Codex #3084
    // r30): a correction committing between the pre-merge read and the
    // upsert is inspected on the CURRENT row — the CASE carries a
    // released-during-run branch keyed on released_at, bound to this
    // run's start.
    const heldEmailCase = mockMergeArgs.at(-1).held_email;
    expect(String(heldEmailCase.sql)).toContain('first_touch_holds.released_at >= ?');
    expect(heldEmailCase.bindings[0]).toBe(runStartedAt);
  });

  test('a hold released in an EARLIER cycle re-pends normally with the fresh address', async () => {
    const runStartedAt = new Date();
    mockHold = baseHold({ status: 'released', released_at: new Date(Date.now() - 3_600_000), held_email: 'old@example.com' });
    await recordFirstTouchHold({
      callLogId: 'call-1', customerId: 'cust-1',
      heldEmail: 'fresh@example.com', heldDrip: true, runStartedAt,
    });
    expect(mergedHeldEmail(mockMergeArgs.at(-1))).toBe('fresh@example.com');
  });

  test('Step 8 keeps the during-run corrected address even after Step 6 re-pended the marker', async () => {
    // Correction-before-Step-6 leaves a released marker; Step 6 adopts its
    // address and re-pends the row. Step 8's later call must keep adopting
    // the operator-asserted value — the adoption keys on released_at, not
    // status (Codex #3084 r19) — never the stale in-memory newsletter
    // candidate captured before the correction.
    const runStartedAt = new Date(Date.now() - 60_000);
    mockHold = baseHold({ status: 'pending', released_at: new Date(), held_email: 'corrected@example.com' });
    await recordFirstTouchHold({
      callLogId: 'call-1', customerId: 'cust-1',
      heldEmail: 'stale-guess@example.com', heldNewsletter: true, runStartedAt,
    });
    expect(mergedHeldEmail(mockMergeArgs.at(-1))).toBe('corrected@example.com');
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
    expect(String(mockMergeArgs.at(-1).status)).toContain("WHEN first_touch_holds.status IN ('releasing', 'blocked') THEN first_touch_holds.status");
  });

  test("the merge never overwrites an ACTIVE claim's target with a fresh extraction guess", async () => {
    // A force-reprocess merging mid-claim must not swap held_email under a
    // claimant — its pre-send fresh read would adopt the unconfirmed guess
    // as if it were an operator correction and send without read-back
    // (Codex #3084 r20). Only the correction fanout retargets active claims.
    mockHold = null;
    await recordFirstTouchHold({ callLogId: 'call-1', customerId: 'cust-1', heldEmail: 'guess@example.com', heldDrip: true });
    const merged = mockMergeArgs.at(-1).held_email;
    expect(String(merged.sql)).toContain("WHEN first_touch_holds.status = 'releasing' THEN first_touch_holds.held_email");
    expect(merged.bindings[0]).toBe('guess@example.com');
  });

  test("the merge never bumps an ACTIVE claim's updated_at — it IS the fence stamp", async () => {
    // A Step-8 merge landing mid-claim must not rewrite the releasing
    // row's updated_at: the claimant proves ownership against that exact
    // value (Codex #3084 r27), and bumping it would also extend a dead
    // claimant's stale-claim window (the r12 rationale).
    mockHold = null;
    await recordFirstTouchHold({ callLogId: 'call-1', customerId: 'cust-1', heldEmail: 'a@example.com', heldNewsletter: true });
    expect(String(mockMergeArgs.at(-1).updated_at)).toContain(
      "WHEN first_touch_holds.status = 'releasing' THEN first_touch_holds.updated_at",
    );
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

  test('the resend marker is honored from ANY coalesced hold', async () => {
    // A sibling hold's failed send (with a surviving pre-send stamp) must
    // force the actual resend for the whole group (Codex #3084 r23).
    mockHold = { held_drip: false, released_drip: false };
    mockDoiMarkerRow = { id: 'hold-2' };
    mockSubscriberRow = { status: 'pending', confirmation_sent_at: new Date() }; // stale stamp
    await resumeHeldNewsletterPostCommit([
      { holdId: 'hold-1', customerId: 'cust-1', email: 'same@example.com' },
      { holdId: 'hold-2', customerId: 'cust-1', email: 'same@example.com' },
    ]);
    expect(mockNewsletter).toHaveBeenCalledTimes(1); // resent despite the stamp
  });

  test('a deny stamped on a still-releasing hold vetoes the post-commit send', async () => {
    // A force-reprocess verdict can stamp the claimed hold between the
    // correction's defer and this callback with the target unchanged
    // (Codex #3084 r25) — the veto runs BEFORE the send, and the plain
    // re-pend leaves the stamp intact.
    mockDenyMarkerRow = { id: 'hold-1' };
    const outcome = await resumeHeldNewsletterPostCommit({ holdId: 'hold-1', customerId: 'cust-1', email: 'ok@example.com' });
    expect(outcome).toMatchObject({ skipped: 'email_denied' });
    expect(mockNewsletter).not.toHaveBeenCalled();
    const last = mockHoldUpdates.at(-1);
    expect(last).toMatchObject({ status: 'pending' });
    expect(last.last_error).toBeUndefined();
  });

  test('an unverifiable resend-marker lookup re-pends instead of trusting the stamp', async () => {
    mockDoiMarkerError = new Error('pool exhausted');
    const outcome = await resumeHeldNewsletterPostCommit({ holdId: 'hold-1', customerId: 'cust-1', email: 'ok@example.com' });
    expect(outcome).toMatchObject({ skipped: 'target_verify_failed' });
    expect(mockNewsletter).not.toHaveBeenCalled();
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'pending', last_error: 'target_verify_failed' });
  });

  // BOTH outbound vetoes re-run at send time (Codex #3084 r18): the
  // callback fires after the correction transaction committed, and a
  // do-not-contact request or bounce suppression landing in that gap is
  // invisible to the in-transaction check.
  test('a do-not-contact landing after commit blocks instead of sending', async () => {
    mockDncRow = { id: 'call-1' };
    const outcome = await resumeHeldNewsletterPostCommit({ holdId: 'hold-1', customerId: 'cust-1', email: 'ok@example.com' });
    expect(outcome).toMatchObject({ skipped: 'do_not_contact' });
    expect(mockNewsletter).not.toHaveBeenCalled();
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'blocked', last_error: 'do_not_contact' });
  });

  test('a suppression landing after commit re-pends instead of sending', async () => {
    mockSuppressionRow = { suppression_type: 'bounce' };
    const outcome = await resumeHeldNewsletterPostCommit({ holdId: 'hold-1', customerId: 'cust-1', email: 'ok@example.com' });
    expect(outcome).toMatchObject({ skipped: 'email_suppressed' });
    expect(mockNewsletter).not.toHaveBeenCalled();
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'pending', last_error: 'email_suppressed' });
  });
});

describe('mid-send races (r19)', () => {
  test('a released settle is conditional — a mid-send retarget re-pends instead of burying the newer address', async () => {
    // Correction B retargets the row's held_email after the pre-send read;
    // the terminal settle matches 0 rows and the hold re-pends
    // 'superseded_during_send' (NOT the send-failed marker), so the sweep
    // retries to B's address with the dedupe guard intact.
    mockReleasedSettleZeroOnce = true;
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res.resumed).toBe(true); // the sends to the observed target did go out
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'pending', last_error: 'superseded_during_send' });
  });

  test('an already-active enrollment is retargeted to the released address before the drip settles', async () => {
    // enrollCustomer's already-enrolled outcome leaves the ACTIVE row's
    // denormalized email untouched, and the scheduler sends to the ROW's
    // email — a retry after a superseded settle must retarget it before
    // marking the drip released (Codex #3084 r20).
    mockEnroll.mockResolvedValueOnce({ enrolled: false, reason: 'already enrolled', enrollmentId: 'enr-1' });
    mockHold = baseHold({ held_newsletter: false });
    await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(mockEnrollmentUpdates).toHaveLength(1);
    expect(mockEnrollmentUpdates[0]).toMatchObject({ email: 'confirmed@example.com' });
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'released', released_drip: true });
  });

  test('a correction landed before the enroll lock re-pends as superseded — no stale enrollment is ever created', async () => {
    // Correction B commits between the pre-send re-read and the enroll
    // transaction's row lock (Codex #3084 r26, atomic since r29): the
    // locked validation sees B's target BEFORE enrollCustomer runs, so no
    // enrollment for the superseded address ever exists — the scheduler
    // has nothing stale to pick up. The hold re-pends for the sweep's
    // retry, which re-runs every check against B's address.
    mockEnroll.mockResolvedValueOnce({ enrolled: true, enrollmentId: 'enr-new' });
    mockHold = baseHold({ held_newsletter: false });
    mockHoldFirstQueue = [
      { held_email: 'confirmed@example.com', last_error: null }, // pre-send re-read: unchanged
      { held_email: 'newer@example.com' },                        // locked validation: B landed
    ];
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res.skipped).toBe('superseded_during_send');
    expect(mockEnroll).not.toHaveBeenCalled();
    expect(mockEnrollmentUpdates).toHaveLength(0);
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'pending', last_error: 'superseded_during_send' });
  });

  test('an empty (correction-only) hold target at the enroll lock re-pends without enrolling', async () => {
    // held_email '' is the inert marker — with nothing valid to release
    // to, the locked validation refuses before any enrollment exists
    // (Codex #3084 r26/r29).
    mockEnroll.mockResolvedValueOnce({ enrolled: true, enrollmentId: 'enr-new' });
    mockHold = baseHold({ held_newsletter: false });
    mockHoldFirstQueue = [
      { held_email: 'confirmed@example.com', last_error: null },
      { held_email: '' },
    ];
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res.skipped).toBe('superseded_during_send');
    expect(mockEnroll).not.toHaveBeenCalled();
    expect(mockEnrollmentUpdates).toHaveLength(0);
  });

  test('a deny stamp landing mid-send blocks the terminal settle and survives the re-pend', async () => {
    // The claim-safe merge preserves held_email, so the target CAS alone
    // would pass — the settle's deny guard refuses instead (Codex #3084
    // r21), and the deny-preserving re-pend leaves the stamp untouched.
    mockReleasedSettleZeroOnce = true; // terminal CAS refuses (deny landed)
    mockRepenGuardZeroTimes = 1; // guarded re-pend refuses too (stamp present)
    await resumeHeldFirstTouch({ callLogId: 'call-1' });
    const last = mockHoldUpdates.at(-1);
    expect(last).toMatchObject({ status: 'pending' });
    expect(last.last_error).toBeUndefined();
  });

  test('a live review card minted after the pre-claim check blocks the release', async () => {
    // A force-reprocess can insert a NEW email card and re-pend the row
    // between a caller's pre-claim check and the claim (Codex #3084 r22) —
    // the in-claim re-check refuses to send the back-under-review address.
    mockTriageCardRow = { id: 'card-live' };
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res.skipped).toBe('email_review_live');
    expect(mockEnroll).not.toHaveBeenCalled();
    expect(mockNewsletter).not.toHaveBeenCalled();
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'pending' });
    expect(mockHoldUpdates.at(-1).last_error).toBeUndefined();
  });

  test('an explicit correction proceeds past a live review card', async () => {
    // The operator's asserted address supersedes the open question (r8
    // decision: the fanout release is ungated on card state).
    mockTriageCardRow = { id: 'card-live' };
    const res = await resumeHeldFirstTouch({ customerId: 'cust-1', email: 'corrected@example.com' });
    expect(res.resumed).toBe(true);
    expect(mockEnroll).toHaveBeenCalled();
  });

  test('a DOI-failure re-pend never buries a mid-send deny stamp', async () => {
    // Retryable settles are deny-preserving too (Codex #3084 r22): the
    // guarded write refuses (a deny landed), and the fallback re-pends
    // without touching last_error.
    mockNewsletter.mockResolvedValueOnce({ subscribed: true, confirmationEmailSent: false });
    mockRepenGuardZeroTimes = 2; // the r23 conditional settle AND settleHold's guard both refuse
    await resumeHeldFirstTouch({ callLogId: 'call-1' });
    const last = mockHoldUpdates.at(-1);
    expect(last).toMatchObject({ status: 'pending' });
    expect(last.last_error).toBeUndefined();
  });

  test('a send failure to a rotated-away address never arms the force-resend marker', async () => {
    // Correction B rotated the subscriber away from the attempted address
    // mid-send — B's own callback owns delivery, and arming the
    // force-resend (skipDedupe) here would double-mail it (Codex #3084
    // r25). The superseded marker keeps the retry's dedupe guard intact.
    mockNewsletter.mockResolvedValueOnce({ subscribed: true, confirmationEmailSent: false });
    mockSubscriberRow = null; // no subscriber row carries the attempted address
    await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'pending', last_error: 'superseded_during_send' });
  });

  test('an unverifiable DOI-dedupe lookup fails closed instead of sending', async () => {
    // A delivered DOI whose hold settle failed must not double-mail when
    // the guard read errors (Codex #3084 r22): no send, retryable re-pend,
    // and NOT the send-failed marker (skipDedupe stays false).
    mockSubscriberFirstError = new Error('pool exhausted');
    await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(mockNewsletter).not.toHaveBeenCalled();
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'pending', last_error: 'doi_state_unverified' });
  });

  test('a retryable settle never writes the observed target back over a mid-attempt retarget', async () => {
    // Correction B retargets the claimed row while the DOI attempt runs
    // and the attempt fails retryably (Codex #3084 r23): the retryable
    // settle's target CAS refuses, and the fallback re-pends WITHOUT
    // held_email — B's address survives for the sweep's retry.
    mockNewsletter.mockResolvedValueOnce({ subscribed: true, confirmationEmailSent: false });
    mockRepenGuardZeroTimes = 1; // conditional settle: target no longer matches
    await resumeHeldFirstTouch({ callLogId: 'call-1' });
    const last = mockHoldUpdates.at(-1);
    expect(last).toMatchObject({ status: 'pending', last_error: 'newsletter_doi_not_confirmed' });
    expect(last.held_email).toBeUndefined();
  });

  test('the merged-work re-pend never buries a mid-settle deny stamp', async () => {
    // Step 8 merges work during the claim AND a deny stamps between the
    // released settle and the merged-work re-pend (Codex #3084 r24): the
    // guarded write refuses and the fallback re-pends without a marker.
    mockHold = baseHold({ held_newsletter: false });
    mockHoldFirstQueue = [
      // pre-send target re-read — fence fields (status/updated_at) come
      // from the mock's live-claim defaults (r27); only the target rides.
      { held_email: 'confirmed@example.com', last_error: null },
      { held_email: 'confirmed@example.com', last_error: null }, // enroll-lock validation (r29)
      { status: 'released', held_drip: true, released_drip: false, held_newsletter: true, released_newsletter: false }, // merged-work re-read
    ];
    mockRepenGuardZeroTimes = 1;
    await resumeHeldFirstTouch({ callLogId: 'call-1' });
    const last = mockHoldUpdates.at(-1);
    expect(last).toMatchObject({ status: 'pending' });
    expect(last.last_error).toBeUndefined();
  });

  test('a failed pre-send re-read never buries a freshly-landed deny stamp', async () => {
    // The re-read failed, so deny state is unknown — the guarded re-pend
    // matches 0 rows (a deny stamp landed since the claim) and the recovery
    // write re-pends WITHOUT touching last_error.
    mockHoldFirstQueue = [new Error('db down')];
    mockRepenGuardZeroTimes = 1;
    await resumeHeldFirstTouch({ callLogId: 'call-1' });
    const last = mockHoldUpdates.at(-1);
    expect(last).toMatchObject({ status: 'pending' });
    expect(last.last_error).toBeUndefined();
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

  test('a failed dedupe linkage keeps the hold retryable — without a resend marker', async () => {
    // The deduped release must not go terminal while the subscriber is
    // unlinked, and the re-pend marker must NOT be the send-failed one
    // (that would skipDedupe into a duplicate confirmation on retry).
    mockHold = baseHold({ held_drip: false });
    mockSubscriberRow = { status: 'pending', confirmation_sent_at: new Date() };
    const dbErr = new Error('link write failed');
    dbErr.code = 'ECONNRESET';
    mockSubscriberUpdateError = dbErr;
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(mockNewsletter).not.toHaveBeenCalled();
    expect(res.resumed).toBe(false);
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'pending', last_error: 'dedupe_linkage_failed' });
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
    expect(mergedHeldEmail(mockMergeArgs.at(-1))).toBe('');
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
    // live-card check → none; latest-cycle check → resolved.
    mockTriageFirstQueue = [null, { status: 'resolved' }];
    const swept = await sweepAbandonedFirstTouchHolds({});
    expect(swept).toMatchObject({ examined: 1, released: 1 });
    expect(mockEnroll).toHaveBeenCalled();
  });

  test('the sweep never releases a hold that is still under review or never reviewed', async () => {
    mockHolds = [baseHold(), baseHold({ id: 'hold-2', call_log_id: 'call-2' })];
    mockTriageFirstQueue = [
      { id: 'live-1' }, // hold 1: card still live → skip
      null, null, // hold 2: no live card AND no card at all → never reviewed → skip
    ];
    const swept = await sweepAbandonedFirstTouchHolds({});
    expect(swept).toMatchObject({ examined: 2, released: 0 });
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  test('the sweep recovers rows stranded released with unreleased merged work', async () => {
    // A transient failure in the merged-work re-pend leaves the row
    // 'released' with a held flag uncovered — the fenced outer recovery
    // needs status 'releasing' and the main sweep only scans
    // pending/stale rows, so this pre-pass is the only path back
    // (Codex #3084 r29). Deny-safe CAS on exactly that inconsistent state.
    mockHolds = []; // no sweep candidates — only the recovery pass runs
    await sweepAbandonedFirstTouchHolds({});
    expect(mockHoldUpdates[0]).toMatchObject({ status: 'pending' });
    // The marker is a CASE since r30: deny-stamped inconsistent rows
    // re-pend KEEPING their stamp (the correction path clears it); every
    // other row gets the merged-work marker.
    expect(String(mockHoldUpdates[0].last_error)).toContain("'work_merged_during_release'");
    expect(String(mockHoldUpdates[0].last_error)).toContain('email_denied_await_correction');
  });

  test('the sweep never releases when the LATEST review cycle was dismissed', async () => {
    // Force-reprocess: an old resolved card sits next to a newer dismissed
    // one — dismissal is "not actionable", never a confirmation.
    mockHolds = [baseHold()];
    mockTriageFirstQueue = [null, { status: 'dismissed' }];
    const swept = await sweepAbandonedFirstTouchHolds({});
    expect(swept).toMatchObject({ examined: 1, released: 0 });
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  test('a failed pre-send target re-read re-pends instead of sending on a stale guess', async () => {
    const dbErr = new Error('read timeout');
    dbErr.code = 'ETIMEDOUT';
    mockHoldFirstQueue = [dbErr]; // the pre-send re-read is the first .first() on the ledger
    const res = await resumeHeldFirstTouch({ callLogId: 'call-1' });
    expect(res.skipped).toBe('target_verify_failed');
    expect(mockEnroll).not.toHaveBeenCalled();
    expect(mockNewsletter).not.toHaveBeenCalled();
    expect(mockHoldUpdates.at(-1)).toMatchObject({ status: 'pending', last_error: 'target_verify_failed' });
  });
});
