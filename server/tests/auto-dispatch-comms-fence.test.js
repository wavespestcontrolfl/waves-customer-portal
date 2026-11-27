/**
 * W06 reminder-send race fence in apply.js (makeMoveGuard):
 * Non-blocking pg_try_advisory_xact_lock via tryLockCustomerComms serializes
 * auto-dispatch moves against in-flight 72h/24h reminder deliveries
 * (appointment-reminders.js withReminderSendFence holds lockCustomerComms).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/auto-dispatch/told-visits', () => ({ loadToldVisitIds: jest.fn(async () => new Set()) }));
jest.mock('../services/auto-dispatch/eligibility', () => ({
  isEligibleForAutoDispatch: jest.fn(() => ({ eligible: true })),
  isRecurringPlanActive: jest.fn(async () => ({ active: true })),
  isPersonPlacedVisit: jest.fn(async () => ({ placed: false })),
}));
jest.mock('../services/auto-dispatch/reminder-off', () => ({ assertRemindersOn: jest.fn(async () => {}) }));
jest.mock('../services/auto-dispatch/preferences', () => ({
  assertDestinationClear: jest.fn(async () => {}),
  assertUnitDestinationClear: jest.fn(async () => {}),
}));
jest.mock('../services/auto-dispatch/south-day-kept', () => ({ assertDestinationClear: jest.fn(async () => {}) }));
jest.mock('../services/technician-capabilities', () => ({ assertCapabilitiesActive: jest.fn(async () => {}) }));

const { makeMoveGuard } = require('../services/auto-dispatch/apply');
const { loadToldVisitIds } = require('../services/auto-dispatch/told-visits');

const SERVICE = {
  id: 'svc-1',
  customer_id: 'cust-1',
  technician_id: 'tech-1',
  scheduled_date: '2026-12-10',
  window_start: '09:00',
  window_end: '10:00',
  service_type: 'General Pest Control',
};
const BEST = { date: '2026-12-12', start_time: '10:00', end_time: '11:00', technician_id: 'tech-1' };

function makeTx({ locked = true, rawCalls = [] } = {}) {
  const trx = jest.fn(() => ({
    where() { return this; },
    whereIn() { return this; },
    whereRaw() { return this; },
    forShare() { return this; },
    select: async () => [],
    first: async () => null,
  }));
  trx.isTransaction = true;
  trx.raw = jest.fn(async (sql, bindings) => {
    rawCalls.push({ sql, bindings });
    return { rows: [{ locked }] };
  });
  return trx;
}

describe('apply.js makeMoveGuard customer-comms fence (W06 reminder race)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('acquires non-blocking customer-comms advisory lock before checking told-visits', async () => {
    const rawCalls = [];
    const trx = makeTx({ locked: true, rawCalls });
    const guard = makeMoveGuard({ service: SERVICE, best: BEST, config: { bounceCooldownDays: 0, maxAutoMovesPerVisit: 0 } });

    await expect(guard({ trx, technicianId: 'tech-1', service: SERVICE })).resolves.toBeUndefined();

    expect(rawCalls).toEqual([{
      sql: 'SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0)) AS locked',
      bindings: ['customer-comms:cust-1'],
    }]);
    expect(loadToldVisitIds).toHaveBeenCalledTimes(1);
    expect(trx.raw.mock.invocationCallOrder[0]).toBeLessThan(loadToldVisitIds.mock.invocationCallOrder[0]);
  });

  test('refuses the move (409) without checking told-visits when a reminder send holds the customer comms lock', async () => {
    const trx = makeTx({ locked: false });
    const guard = makeMoveGuard({ service: SERVICE, best: BEST, config: { bounceCooldownDays: 0, maxAutoMovesPerVisit: 0 } });

    await expect(guard({ trx, technicianId: 'tech-1', service: SERVICE }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('reminder or comms send in progress') });
    expect(loadToldVisitIds).not.toHaveBeenCalled();
  });

  test('skips the advisory lock safely when customer_id is absent or outside a transaction mock', async () => {
    const trx = makeTx({ locked: false });
    const guardNoCust = makeMoveGuard({ service: { ...SERVICE, customer_id: null }, best: BEST, config: { bounceCooldownDays: 0, maxAutoMovesPerVisit: 0 } });
    await expect(guardNoCust({ trx, technicianId: 'tech-1', service: { ...SERVICE, customer_id: null } })).resolves.toBeUndefined();
    expect(trx.raw).not.toHaveBeenCalled();

    const nonTx = makeTx({ locked: false });
    nonTx.isTransaction = false;
    const guard = makeMoveGuard({ service: SERVICE, best: BEST, config: { bounceCooldownDays: 0, maxAutoMovesPerVisit: 0 } });
    await expect(guard({ trx: nonTx, technicianId: 'tech-1', service: SERVICE })).resolves.toBeUndefined();
    expect(nonTx.raw).not.toHaveBeenCalled();
  });
});
