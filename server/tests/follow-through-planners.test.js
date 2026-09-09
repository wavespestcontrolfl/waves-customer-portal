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
