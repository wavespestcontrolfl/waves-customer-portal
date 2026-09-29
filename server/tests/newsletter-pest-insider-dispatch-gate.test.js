/**
 * A proof-approved Pest Insider issue stays queued while
 * GATE_PEST_INSIDER_PROOF is off. The check sits before any per-row work in
 * processScheduledSends, so the lineup validator being called is the signal
 * that a row was allowed through.
 */
const mockValidateEventSelection = jest.fn(async () => ({ valid: true, errors: [], flagship: false, events: [] }));

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/newsletter-event-selection', () => ({
  validateFlagshipEventSelection: mockValidateEventSelection,
  parseLockedEventIds: jest.fn(() => []),
}));

const db = require('../models/db');
const { processScheduledSends } = require('../services/newsletter-sender');

function wireDue(rows) {
  db.mockImplementation(() => {
    const q = {};
    ['where', 'whereNull', 'whereIn', 'whereRaw', 'orderBy', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.limit = jest.fn(async () => rows);
    q.first = jest.fn(async () => undefined);
    q.update = jest.fn(async () => 0);
    return q;
  });
}

const APPROVED_INSIDER = {
  id: 'send-pi-1', status: 'scheduled', newsletter_type: 'pest-insider-monthly',
  scheduled_for: new Date('2026-09-03T14:00:00Z'), proof_approved_at: new Date('2026-09-03T14:00:00Z'),
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_NEWSLETTER_PROOF_APPROVAL = 'true';
  delete process.env.GATE_PEST_INSIDER_PROOF;
});

afterAll(() => {
  delete process.env.GATE_NEWSLETTER_PROOF_APPROVAL;
  delete process.env.GATE_PEST_INSIDER_PROOF;
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
