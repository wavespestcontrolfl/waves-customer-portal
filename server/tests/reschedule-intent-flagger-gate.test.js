/**
 * GATE_RESCHEDULE_INTENT_FLAGS (owner ruling 2026-08-15): with the gate off
 * — the default in every environment — the real-time reschedule-intent
 * flagger writes NO flag row and rings NO bell; the inbound message is
 * otherwise unaffected. With the gate on, the lane runs unchanged.
 */

const mockIsEnabled = jest.fn();
jest.mock('../config/feature-gates', () => ({ isEnabled: (key) => mockIsEnabled(key) }));

const mockDbCall = jest.fn();
const mockTransaction = jest.fn();
jest.mock('../models/db', () => {
  const db = (...args) => { mockDbCall(...args); throw new Error('stop-here'); };
  db.transaction = (...args) => mockTransaction(...args);
  db.raw = jest.fn();
  return db;
});

const { flagInboundRescheduleIntent } = require('../services/reschedule-intent-flagger');

beforeEach(() => jest.clearAllMocks());

describe('reschedule-intent flagger gate', () => {
  it('gate off: returns gate_off without touching the database', async () => {
    mockIsEnabled.mockReturnValue(false);
    const res = await flagInboundRescheduleIntent({
      customer: { id: '00000000-0000-4000-8000-0000000000c1', first_name: 'Test', last_name: 'Only' },
      phone: '+15550000001',
      body: 'can we reschedule to Friday?',
      smsLogId: null,
      messageSid: 'SMtest',
    });
    expect(res).toEqual({ flagged: false, reason: 'gate_off' });
    expect(mockIsEnabled).toHaveBeenCalledWith('rescheduleIntentFlags');
    expect(mockDbCall).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('gate on: proceeds past the gate into the flag path', async () => {
    mockIsEnabled.mockReturnValue(true);
    const res = await flagInboundRescheduleIntent({
      customer: { id: '00000000-0000-4000-8000-0000000000c1', first_name: 'Test', last_name: 'Only' },
      phone: '+15550000001',
      body: 'can we reschedule to Friday?',
      smsLogId: null,
      messageSid: 'SMtest',
    });
    // fail-soft contract: the induced downstream error is swallowed, and the
    // outcome proves the gate did NOT short-circuit the lane.
    expect(mockIsEnabled).toHaveBeenCalledWith('rescheduleIntentFlags');
    expect(res.flagged).toBe(false);
    expect(res.reason).toBe('error');
    expect(res.reason).not.toBe('gate_off');
  });
});
