/**
 * job-status.js#previewCancellationNoticeVerdict — the read-only mirror of
 * processCancelNoticeClaim's UNCONDITIONAL suppression conditions.
 * appointment-cancel-impact.js uses this to disclose (never silently
 * suppress) the Intelligence Bar cancel_appointment card's customer-notice
 * outcome (Codex round-1 P1 on the ib-cancel-appointment-live lane: the
 * card must never claim "no customer message is sent" when the existing
 * GATE_CANCEL_NOTICE_HOOK fix can still text one — that hook exists on
 * purpose, 2026-08-05, and this lane must not silently reverse it).
 *
 * Round-2 P1: a "merged-slot survivor" is MUTABLE — it can appear or
 * disappear before commit, so it was removed as a 'none' condition.
 * Round-3 P1: the `appointment_reminders`-row check is ALSO mutable — the
 * reminder self-healer can insert a missing row for this visit between any
 * read here and the hook's own in-transaction claim, so "no row right now"
 * is not proof the hook has nothing to claim at commit time. The ONLY
 * remaining condition is the gate itself (a process-level value that
 * cannot change mid-transaction): 'none' only when it's off, 'may_send'
 * otherwise — no DB read at all. Synthetic ids throughout — no real
 * customer data.
 */

const mockIsEnabled = jest.fn();
jest.mock('../config/feature-gates', () => ({ isEnabled: (...a) => mockIsEnabled(...a) }));

// No DB mock needed — the function reads nothing but the gate. A stray
// db() call would throw here (no mock registered for '../models/db'),
// which is itself proof the function stays DB-free.
jest.mock('../models/db', () => {
  const err = () => { throw new Error('previewCancellationNoticeVerdict must never query the database — every DB-backed condition is mutable before commit'); };
  const db = jest.fn(err);
  return db;
});

const { previewCancellationNoticeVerdict } = require('../services/job-status');

describe('previewCancellationNoticeVerdict', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('gate off: none', async () => {
    mockIsEnabled.mockReturnValue(false);
    const verdict = await previewCancellationNoticeVerdict('svc-1');
    expect(verdict).toBe('none');
    expect(mockIsEnabled).toHaveBeenCalledWith('cancelNoticeHook');
  });

  test('gate on: may_send — never claims to know WHEN, and reads nothing else', async () => {
    mockIsEnabled.mockReturnValue(true);
    await expect(previewCancellationNoticeVerdict('svc-1')).resolves.toBe('may_send');
  });

  // Codex round-3 P1: even with NO appointment_reminders row for this
  // visit right now, the self-healer can insert one before commit — the
  // verdict must still be may_send with the gate on. Proven by never
  // reading the DB at all (the mock throws on any db() call).
  test('gate on resolves to may_send with no DB read at all — a row appearing later cannot be missed', async () => {
    mockIsEnabled.mockReturnValue(true);
    const verdict = await previewCancellationNoticeVerdict('svc-with-no-reminders-row-yet');
    expect(verdict).toBe('may_send');
  });
});
