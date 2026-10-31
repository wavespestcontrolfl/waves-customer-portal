/**
 * Dispatcher kill switches. A proof-approved Pest Insider issue stays queued
 * while GATE_PEST_INSIDER_PROOF is off, and an issue the auto-send switch
 * queued stays queued while GATE_NEWSLETTER_AUTO_SEND is off. Both checks sit
 * before any per-row work in processScheduledSends, so the lineup validator
 * being called is the signal that a row was allowed through.
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
