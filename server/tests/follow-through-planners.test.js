jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { staffedDeadline } = require('../services/callback-cards');

describe('callback rollout policy', () => {
  const { gates } = require('../config/feature-gates');
  const originalCardGate = process.env.GATE_CALLBACK_CARD;
  const originalCommitmentsGate = gates.callCommitments;
  afterEach(() => {
    if (originalCardGate === undefined) delete process.env.GATE_CALLBACK_CARD;
    else process.env.GATE_CALLBACK_CARD = originalCardGate;
    gates.callCommitments = originalCommitmentsGate;
  });
  test.each([[false, false], [true, false], [false, true], [true, true]])(
    'card gate %s, commitment gate %s use one availability and deadline policy', (cardGate, commitmentGate) => {
      process.env.GATE_CALLBACK_CARD = String(cardGate);
      gates.callCommitments = commitmentGate;
      expect(require('../services/callback-cards').enabled()).toBe(cardGate && commitmentGate);
      const row = { kind: 'callback', party: 'waves', source: 'human', created_at: '2026-09-09T12:00:00Z' };
      const { normalizeRow } = require('../services/call-commitments');
      const callbackDue = '2026-09-09T20:00:00Z';
      expect(normalizeRow({ ...row, due_at: null, callback_due_at: callbackDue })).toMatchObject({
        due_at: null, effective_due_at: cardGate && commitmentGate ? callbackDue : null,
      });
      expect(normalizeRow({ ...row, due_at: '2026-09-10T20:00:00Z', callback_due_at: callbackDue }).effective_due_at)
        .toBe('2026-09-10T20:00:00Z');
      expect(normalizeRow({ ...row, party: 'customer', callback_due_at: callbackDue }).effective_due_at).toBeNull();
      // A retained snooze is projected only while the card policy honours it.
      const snoozed = normalizeRow({ ...row, due_at: '2020-01-01T00:00:00Z', callback_due_at: callbackDue, snoozed_until: '2099-01-01T00:00:00Z', status: 'open' });
      expect(snoozed.snoozed_until).toBe(cardGate && commitmentGate ? '2099-01-01T00:00:00Z' : null);
      expect(require('../services/call-commitments').isOverdue(snoozed)).toBe(!(cardGate && commitmentGate));
      const deadline = require('../services/call-commitments').implicitDueAt(row);
      expect(deadline?.toISOString() || null).toBe(cardGate && commitmentGate ? null : '2026-09-10T04:00:00.000Z');
    },
  );
});

describe('callback working deadlines', () => {
  test('carries the remaining staffed hours over a weekend and a closure', () => {
    const calendar = { start: '08:00', end: '17:00', closed: new Set(['2026-09-12', '2026-09-13', '2026-09-14']) };
    expect(staffedDeadline(new Date('2026-09-11T15:00:00-04:00'), calendar).toISOString()).toBe('2026-09-15T14:00:00.000Z');
  });
  test('uses Eastern wall time across the fall DST change', () => {
    const calendar = { start: '08:00', end: '17:00', closed: new Set(['2026-10-31', '2026-11-01']) };
    expect(staffedDeadline(new Date('2026-10-30T16:00:00-04:00'), calendar).toISOString()).toBe('2026-11-02T16:00:00.000Z');
  });
});
