/**
 * job-status.js#previewCancellationNoticeVerdict — the read-only mirror of
 * processCancelNoticeClaim's UNCONDITIONAL, evidence-independent suppression
 * conditions. appointment-cancel-impact.js uses this to disclose (never
 * silently suppress) the Intelligence Bar cancel_appointment card's
 * customer-notice outcome (Codex round-1 P1 on the ib-cancel-appointment-live
 * lane: the card must never claim "no customer message is sent" when the
 * existing GATE_CANCEL_NOTICE_HOOK fix can still text one — that hook exists
 * on purpose, 2026-08-05, and this lane must not silently reverse it).
 *
 * Round-2 P1: a "merged-slot survivor" (a live sibling visit for the same
 * customer/time) is a MUTABLE condition — another admin can cancel that
 * sibling between this preview and the moment THIS visit's own transition
 * commits, and the real hook would then text. The function must never
 * resolve to 'none' on a condition that can flip before commit, so it no
 * longer even queries for a survivor. Synthetic ids throughout — no real
 * customer data.
 */

const mockIsEnabled = jest.fn();
jest.mock('../config/feature-gates', () => ({ isEnabled: (...a) => mockIsEnabled(...a) }));

let mockReminderRow = null;
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    if (table !== 'appointment_reminders') throw new Error(`unexpected table in this suite: ${table}`);
    return {
      where: () => ({
        first: async () => mockReminderRow,
        // A re-introduced survivor query (Codex round-2 P1: that condition
        // is mutable and must never resolve to 'none') would throw here.
        whereNot: () => {
          throw new Error('previewCancellationNoticeVerdict must never query a merged-slot survivor — that condition can change before commit');
        },
      }),
    };
  });
  return db;
});

const { previewCancellationNoticeVerdict } = require('../services/job-status');

describe('previewCancellationNoticeVerdict', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReminderRow = { id: 'reminder-1' };
  });

  test('gate off: none, without reading anything else', async () => {
    mockIsEnabled.mockReturnValue(false);
    const verdict = await previewCancellationNoticeVerdict('svc-1');
    expect(verdict).toBe('none');
    expect(mockIsEnabled).toHaveBeenCalledWith('cancelNoticeHook');
  });

  test('gate on, no appointment_reminders row for this visit: none (the real hook has nothing to claim, and this cannot change before commit)', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockReminderRow = null;
    const verdict = await previewCancellationNoticeVerdict('svc-1');
    expect(verdict).toBe('none');
  });

  test('gate on, row exists: may_send — never claims to know WHEN, and never queries a survivor', async () => {
    mockIsEnabled.mockReturnValue(true);
    await expect(previewCancellationNoticeVerdict('svc-1')).resolves.toBe('may_send');
  });

  test('never returns none from delivery evidence alone — the function does not even look at it', async () => {
    // The real hook's evidence check (messaging_audit_log / customer_interactions
    // / legacy sms_log correlation) only decides WHEN a 'may_send' claim
    // actually sends — never whether the claim exists in the first place.
    // This suite's db mock never stubs those tables at all; if the function
    // tried to read them it would throw "unexpected table in this suite".
    mockIsEnabled.mockReturnValue(true);
    await expect(previewCancellationNoticeVerdict('svc-1')).resolves.toBe('may_send');
  });

  // Codex round-2 P1: a merged-slot survivor is MUTABLE — it can appear or
  // disappear between this preview and the real transition's commit, so a
  // currently-live survivor must NOT resolve to 'none'. Proven by the mock
  // above throwing if the function ever re-queries one.
  test('a live merged-slot survivor existing right now still resolves to may_send (the condition can change before commit)', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockReminderRow = { id: 'reminder-1' };
    await expect(previewCancellationNoticeVerdict('svc-1')).resolves.toBe('may_send');
  });
});
