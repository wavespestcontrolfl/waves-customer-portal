/**
 * job-status.js#previewCancellationNoticeVerdict — the read-only mirror of
 * processCancelNoticeClaim's UNCONDITIONAL, evidence-independent suppression
 * conditions. appointment-cancel-impact.js uses this to disclose (never
 * silently suppress) the Intelligence Bar cancel_appointment card's
 * customer-notice outcome (Codex round-1 P1 on the ib-cancel-appointment-live
 * lane: the card must never claim "no customer message is sent" when the
 * existing GATE_CANCEL_NOTICE_HOOK fix can still text one — that hook exists
 * on purpose, 2026-08-05, and this lane must not silently reverse it).
 * Synthetic ids throughout — no real customer data.
 */

const mockIsEnabled = jest.fn();
jest.mock('../config/feature-gates', () => ({ isEnabled: (...a) => mockIsEnabled(...a) }));

let mockReminderRow = null;
let mockSurvivorRow = null;
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    if (table !== 'appointment_reminders') throw new Error(`unexpected table in this suite: ${table}`);
    return {
      where: () => ({
        first: async () => mockReminderRow,
        whereNot: () => ({
          first: async () => mockSurvivorRow,
        }),
      }),
    };
  });
  return db;
});

const { previewCancellationNoticeVerdict } = require('../services/job-status');

describe('previewCancellationNoticeVerdict', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReminderRow = { customer_id: 'cust-1', appointment_time: '2026-10-05T13:00:00.000Z' };
    mockSurvivorRow = null;
  });

  test('gate off: none, without reading anything else', async () => {
    mockIsEnabled.mockReturnValue(false);
    const verdict = await previewCancellationNoticeVerdict('svc-1');
    expect(verdict).toBe('none');
    expect(mockIsEnabled).toHaveBeenCalledWith('cancelNoticeHook');
  });

  test('gate on, no appointment_reminders row for this visit: none (the real hook has nothing to claim)', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockReminderRow = null;
    const verdict = await previewCancellationNoticeVerdict('svc-1');
    expect(verdict).toBe('none');
  });

  test('gate on, row exists, no live merged-slot survivor: may_send — never claims to know WHEN', async () => {
    mockIsEnabled.mockReturnValue(true);
    const verdict = await previewCancellationNoticeVerdict('svc-1');
    expect(verdict).toBe('may_send');
  });

  test('gate on, row exists, a live survivor at the same customer + slot: none (terminally suppressed, matching the real in-trx/sweep classification)', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockSurvivorRow = { id: 'sibling-reminder-1' };
    const verdict = await previewCancellationNoticeVerdict('svc-1');
    expect(verdict).toBe('none');
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
});
