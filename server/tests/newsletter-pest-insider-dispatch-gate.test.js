/**
 * Dispatcher kill switches. A proof-approved Pest Insider issue stays queued
 * while GATE_PEST_INSIDER_PROOF is off, and an issue the auto-send switch
 * queued stays queued while GATE_NEWSLETTER_AUTO_SEND is off. Both checks sit
 * before any per-row work in processScheduledSends, so the lineup validator
 * being called is the signal that a row was allowed through.
 * A planned Waves Pest Insider issue the switch queued follows
 * GATE_PEST_INSIDER_AUTO_SEND instead, and goes out only from its planned
 * issue row, at its own Thursday 7:00 AM ET, inside the 7:00-10:00 AM window.
 */
const mockValidateEventSelection = jest.fn(async () => ({ valid: true, errors: [], flagship: false, events: [] }));
const mockTrigger = jest.fn(async () => ({ bellWritten: true }));

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/newsletter-event-selection', () => ({
  validateFlagshipEventSelection: mockValidateEventSelection,
  parseLockedEventIds: jest.fn(() => []),
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: mockTrigger }));

const db = require('../models/db');
const { processScheduledSends } = require('../services/newsletter-sender');

function wireDue(rows, { updated = 0 } = {}) {
  const updates = [];
  db.mockImplementation((table) => {
    const q = {};
    ['where', 'whereNull', 'whereIn', 'whereRaw', 'orderBy', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.limit = jest.fn(async () => rows);
    q.first = jest.fn(async () => undefined);
    q.update = jest.fn(async (patch) => { updates.push({ table, patch }); return updated; });
    return q;
  });
  return updates;
}

const APPROVED_INSIDER = {
  id: 'send-pi-1', status: 'scheduled', newsletter_type: 'pest-insider-monthly',
  scheduled_for: new Date('2026-09-03T14:00:00Z'), proof_approved_at: new Date('2026-09-03T14:00:00Z'),
  // Approved by an APPROVED reply: email-sync always passes the stored email row.
  proof_approval_email_id: 'email-1',
};
// Queued by the auto-send switch: approved with no approving email.
const AUTO_QUEUED_WEEKLY = {
  id: 'send-1', status: 'scheduled', newsletter_type: 'local-weekly-fresh-events', subject: 'Bubbles & Sea Lions',
  scheduled_for: new Date('2026-09-08T10:00:00Z'), proof_approved_at: new Date('2026-09-07T11:00:00Z'),
  proof_approval_email_id: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_NEWSLETTER_PROOF_APPROVAL = 'true';
  delete process.env.GATE_PEST_INSIDER_PROOF;
  delete process.env.GATE_NEWSLETTER_AUTO_SEND;
});

afterAll(() => {
  delete process.env.GATE_NEWSLETTER_PROOF_APPROVAL;
  delete process.env.GATE_PEST_INSIDER_PROOF;
  delete process.env.GATE_NEWSLETTER_AUTO_SEND;
  delete process.env.GATE_PEST_INSIDER_AUTO_SEND;
});

describe('processScheduledSends: Pest Insider kill switch', () => {
  test('gate off: a proof-approved Pest Insider issue is left scheduled', async () => {
    wireDue([APPROVED_INSIDER]);

    await processScheduledSends();

    expect(mockValidateEventSelection).not.toHaveBeenCalled();
  });

  test('gate on: the same issue goes through to dispatch', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    wireDue([APPROVED_INSIDER]);

    await processScheduledSends();

    expect(mockValidateEventSelection).toHaveBeenCalledTimes(1);
  });

  test('gate off: a Pest Insider issue scheduled by hand (no proof approval) is not held', async () => {
    wireDue([{ ...APPROVED_INSIDER, proof_approved_at: null }]);

    await processScheduledSends();

    expect(mockValidateEventSelection).toHaveBeenCalledTimes(1);
  });

  test('gate off: a proof-approved weekly flagship is not held by the Pest Insider switch', async () => {
    wireDue([{ ...APPROVED_INSIDER, id: 'send-1', newsletter_type: 'local-weekly-fresh-events' }]);

    await processScheduledSends();

    expect(mockValidateEventSelection).toHaveBeenCalledTimes(1);
  });
});

describe('processScheduledSends: auto-send kill switch (owner 2026-10-30, option A)', () => {
  test('switch off: an issue the switch queued is left scheduled, unsent', async () => {
    wireDue([AUTO_QUEUED_WEEKLY]);

    await processScheduledSends();

    expect(mockValidateEventSelection).not.toHaveBeenCalled();
  });

  test('switch off: a check-in email the switch queued is held too', async () => {
    wireDue([{ ...AUTO_QUEUED_WEEKLY, id: 'wb-1', newsletter_type: 'reengagement', scheduled_for: new Date('2026-09-07T11:30:00Z') }]);

    await processScheduledSends();

    expect(mockValidateEventSelection).not.toHaveBeenCalled();
  });

  test('switch on: the same issue goes through to the send-time checks', async () => {
    process.env.GATE_NEWSLETTER_AUTO_SEND = 'true';
    wireDue([AUTO_QUEUED_WEEKLY]);

    await processScheduledSends();

    expect(mockValidateEventSelection).toHaveBeenCalledTimes(1);
  });

  test('a send-time check that fails puts the issue back to draft and raises one alert that says why', async () => {
    process.env.GATE_NEWSLETTER_AUTO_SEND = 'true';
    mockValidateEventSelection.mockResolvedValueOnce({ valid: false, errors: ['Sea Lion Splash is cancelled'], flagship: true, events: [] });
    const updates = wireDue([AUTO_QUEUED_WEEKLY], { updated: 1 });

    await processScheduledSends();

    expect(updates).toEqual([
      { table: 'newsletter_sends', patch: expect.objectContaining({ status: 'draft', scheduled_for: null, proof_approved_at: null }) },
      { table: 'newsletter_calendar', patch: expect.objectContaining({ status: 'drafted' }) },
    ]);
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', {
      sendId: 'send-1',
      subject: 'Bubbles & Sea Lions',
      errors: ['Stopped at send time: Sea Lion Splash is cancelled'],
    });
  });

  test('no alert when another tick already reverted the row', async () => {
    process.env.GATE_NEWSLETTER_AUTO_SEND = 'true';
    mockValidateEventSelection.mockResolvedValueOnce({ valid: false, errors: ['Sea Lion Splash is cancelled'], flagship: true, events: [] });
    wireDue([AUTO_QUEUED_WEEKLY], { updated: 0 });

    await processScheduledSends();

    expect(mockTrigger).not.toHaveBeenCalled();
  });
});

describe('processScheduledSends: a planned Waves Pest Insider issue (GATE_PEST_INSIDER_AUTO_SEND)', () => {
  // Thursday, December 3, 2026 at 7:00 AM EST.
  const ISSUE_SEND_AT = new Date('2026-12-03T12:00:00Z');
  const AUTO_QUEUED_INSIDER = {
    id: 'send-pi-2', status: 'scheduled', newsletter_type: 'pest-insider-monthly', subject: 'Native termites can swarm in winter',
    scheduled_for: ISSUE_SEND_AT, proof_approved_at: new Date('2026-12-02T12:05:00Z'), proof_approval_email_id: null,
  };
  const PLANNED = { id: 'issue-1', issue_date: '2026-12-03', status: 'scheduled', send_id: 'send-pi-2' };

  function wireInsider(rows, { issue = PLANNED, updated = 1 } = {}) {
    const updates = [];
    db.mockImplementation((table) => {
      const q = {};
      ['where', 'whereNull', 'whereIn', 'whereRaw', 'orderBy', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.limit = jest.fn(async () => rows);
      q.first = jest.fn(async () => (table === 'pest_insider_issues' ? issue : undefined));
      q.update = jest.fn(async (patch) => { updates.push({ table, patch }); return updated; });
      return q;
    });
    return updates;
  }

  const at = (iso) => jest.useFakeTimers().setSystemTime(new Date(iso));

  beforeEach(() => {
    process.env.GATE_PEST_INSIDER_AUTO_SEND = 'true';
    at('2026-12-03T12:01:00Z');
  });
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.GATE_PEST_INSIDER_AUTO_SEND;
  });

  test('switch on: its planned issue at 7:01 AM goes through, with the weekly switch off', async () => {
    const updates = wireInsider([AUTO_QUEUED_INSIDER]);

    await processScheduledSends();

    expect(mockValidateEventSelection).toHaveBeenCalledTimes(1);
    expect(updates.some(({ patch }) => patch.status === 'draft')).toBe(false);
    expect(updates.some(({ table }) => table === 'pest_insider_issues')).toBe(false);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  test('switch off: the queued issue is left scheduled, even with the weekly switch on', async () => {
    delete process.env.GATE_PEST_INSIDER_AUTO_SEND;
    process.env.GATE_NEWSLETTER_AUTO_SEND = 'true';
    const updates = wireInsider([AUTO_QUEUED_INSIDER]);

    await processScheduledSends();

    expect(mockValidateEventSelection).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test.each([
    ['no planned issue is linked', { issue: null }, null, 'no planned Waves Pest Insider issue is linked to this send'],
    ['its planned issue is not scheduled', { issue: { ...PLANNED, status: 'drafted' } }, null, 'its planned issue is drafted, not scheduled'],
    ['the send time was moved off its issue Thursday 7:00 AM', {}, new Date('2026-12-03T13:00:00Z'), 'scheduled_for is not its issue Thursday (2026-12-03) at 7:00 AM ET'],
  ])('%s: stopped for good, the issue row fails, and one notice says why', async (_label, wiring, scheduledFor, reason) => {
    at('2026-12-03T13:01:00Z');
    const row = scheduledFor ? { ...AUTO_QUEUED_INSIDER, scheduled_for: scheduledFor } : AUTO_QUEUED_INSIDER;
    const updates = wireInsider([row], wiring);

    await processScheduledSends();

    expect(mockValidateEventSelection).not.toHaveBeenCalled();
    expect(updates).toEqual([
      { table: 'newsletter_sends', patch: expect.objectContaining({ status: 'draft', scheduled_for: null, proof_approved_at: null }) },
      { table: 'newsletter_calendar', patch: expect.objectContaining({ status: 'drafted' }) },
      { table: 'pest_insider_issues', patch: expect.objectContaining({ status: 'failed', reason: `stopped at send time: ${reason}` }) },
    ]);
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', {
      sendId: 'send-pi-2',
      subject: 'Native termites can swarm in winter',
      errors: [`Stopped at send time: ${reason}`],
    });
  });

  test('10:00 AM ET or later: the issue missed its window and does not go out', async () => {
    at('2026-12-03T15:00:00Z');
    const updates = wireInsider([AUTO_QUEUED_INSIDER]);

    await processScheduledSends();

    expect(mockValidateEventSelection).not.toHaveBeenCalled();
    expect(updates.find(({ table }) => table === 'pest_insider_issues').patch).toMatchObject({
      status: 'failed', reason: 'stopped at send time: missed the 2026-12-03 7:00-10:00 AM ET send window',
    });
  });

  test('a send that fails before its claim marks its planned issue failed (nothing went out)', async () => {
    const updates = [];
    db.mockImplementation((table) => {
      const q = { conds: [] };
      ['whereNull', 'whereIn', 'whereRaw', 'orderBy', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.where = jest.fn((cond) => { q.conds.push(cond); return q; });
      q.limit = jest.fn(async () => [AUTO_QUEUED_INSIDER]);
      q.first = jest.fn(async () => (table === 'pest_insider_issues' ? PLANNED : undefined));
      // Nothing claimed the row: it is still scheduled, not sending.
      q.update = jest.fn(async (patch) => {
        updates.push({ table, patch, conds: q.conds });
        return q.conds.some((cond) => cond && cond.status === 'sending') ? 0 : 1;
      });
      return q;
    });

    // sendCampaign throws before its claim here (no SendGrid in tests, and no row to read).
    await processScheduledSends();

    expect(updates.map(({ table, patch }) => ({ table, patch }))).toEqual([
      { table: 'newsletter_sends', patch: { status: 'failed' } },
      { table: 'newsletter_sends', patch: expect.objectContaining({ status: 'failed' }) },
      { table: 'pest_insider_issues', patch: expect.objectContaining({ status: 'failed', reason: expect.stringMatching(/^send failed before it started: /) }) },
    ]);
    // The 'sending' flip is bound to this tick's own claim token: never another worker's send.
    expect(updates[0].conds).toContainEqual({ id: 'send-pi-2', status: 'sending', sending_claim_token: expect.any(String) });
  });

  test('a planned issue that cannot be read is left scheduled for the next tick: no failure, no alert', async () => {
    const updates = wireInsider([AUTO_QUEUED_INSIDER]);
    const base = db.getMockImplementation();
    db.mockImplementation((table) => {
      const q = base(table);
      if (table === 'pest_insider_issues') q.first = jest.fn(async () => { throw new Error('connection reset'); });
      return q;
    });

    await processScheduledSends();

    expect(mockValidateEventSelection).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  test('9:59 AM ET is still inside the window', async () => {
    at('2026-12-03T14:59:00Z');
    wireInsider([AUTO_QUEUED_INSIDER]);

    await processScheduledSends();

    expect(mockValidateEventSelection).toHaveBeenCalledTimes(1);
  });

  test('a Pest Insider issue approved by an APPROVED reply still follows GATE_PEST_INSIDER_PROOF, not this switch', async () => {
    const updates = wireInsider([{ ...AUTO_QUEUED_INSIDER, proof_approval_email_id: 'email-1' }]);

    await processScheduledSends();

    expect(mockValidateEventSelection).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});
