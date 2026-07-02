/**
 * AI-call-pipeline lead conversion on phone booking.
 *
 * Pins the contract that closed the Adam Pitts gap: when the call pipeline
 * books a confirmed appointment it converts the call's lead to won on the
 * SAME transaction (savepoint-nested so a conversion failure can never doom
 * the booking commit). Every other booking path (admin lead row, admin
 * schedule, public self-booking) already converted; the phone path silently
 * left leads at `new` with a booked appointment.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const logger = require('../services/logger');
const { _test } = require('../services/call-recording-processor');
const { convertCallLeadOnPhoneBooking } = _test;

// Inner (savepoint) db stub: routes table calls to configurable results and
// records update/insert payloads.
function makeInner({ convertible = { id: 'lead-1' }, failOn = null } = {}) {
  const writes = { updates: [], inserts: [] };
  const inner = jest.fn((table) => {
    const b = {
      where: jest.fn(() => b),
      whereNotIn: jest.fn(() => b),
      first: jest.fn(async () => {
        if (failOn === 'first') throw new Error('boom');
        return table === 'leads' ? convertible : null;
      }),
      update: jest.fn(async (payload) => {
        if (failOn === 'update') throw new Error('boom');
        writes.updates.push({ table, payload });
        return 1;
      }),
      insert: jest.fn(async (payload) => {
        if (failOn === 'insert') throw new Error('boom');
        writes.inserts.push({ table, payload });
        return [1];
      }),
    };
    return b;
  });
  inner._writes = writes;
  return inner;
}

// Outer trx stub: trx.transaction(fn) invokes fn(inner) like knex's
// savepoint-nested transaction; rejects if fn rejects.
function makeTrx(inner) {
  return { transaction: jest.fn(async (fn) => fn(inner)) };
}

const ARGS = {
  leadId: 'lead-1',
  customerId: 'cust-1',
  scheduledServiceId: 'svc-1',
  callSid: 'CAtest',
};

beforeEach(() => jest.clearAllMocks());

describe('convertCallLeadOnPhoneBooking', () => {
  test('converts an open lead: won + converted_at + is_qualified + activity row, in the nested txn', async () => {
    const inner = makeInner();
    const trx = makeTrx(inner);

    const converted = await convertCallLeadOnPhoneBooking(trx, ARGS);

    expect(converted).toBe(true);
    expect(trx.transaction).toHaveBeenCalledTimes(1); // savepoint, not the outer txn raw
    const update = inner._writes.updates.find((w) => w.table === 'leads');
    expect(update.payload).toMatchObject({
      status: 'won',
      customer_id: 'cust-1',
      is_qualified: true,
    });
    expect(update.payload.converted_at).toBeInstanceOf(Date);
    const activity = inner._writes.inserts.find((w) => w.table === 'lead_activities');
    expect(activity.payload).toMatchObject({
      lead_id: 'lead-1',
      activity_type: 'converted',
      performed_by: 'system',
    });
    expect(JSON.parse(activity.payload.metadata)).toMatchObject({
      triggerSource: 'appointment_booked',
      scheduledServiceId: 'svc-1',
      callSid: 'CAtest',
    });
  });

  test('no leadId (existing-customer caller, no lead) → no-op, no queries', async () => {
    const inner = makeInner();
    const trx = makeTrx(inner);

    const converted = await convertCallLeadOnPhoneBooking(trx, { ...ARGS, leadId: null });

    expect(converted).toBe(false);
    expect(trx.transaction).not.toHaveBeenCalled();
  });

  test('already-won/duplicate lead (whereNotIn filter returns nothing) → skip without writes', async () => {
    const inner = makeInner({ convertible: null });
    const trx = makeTrx(inner);

    const converted = await convertCallLeadOnPhoneBooking(trx, ARGS);

    expect(converted).toBe(false);
    expect(inner._writes.updates).toHaveLength(0);
    expect(inner._writes.inserts).toHaveLength(0);
    // The open-status filter is the idempotency/duplicate guard.
    const b = inner.mock.results[0].value;
    expect(b.whereNotIn).toHaveBeenCalledWith('status', ['won', 'duplicate']);
  });

  test('conversion failure is contained: returns false, never throws (booking must still commit)', async () => {
    const inner = makeInner({ failOn: 'update' });
    const trx = makeTrx(inner);

    await expect(convertCallLeadOnPhoneBooking(trx, ARGS)).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Lead conversion on phone booking failed'),
    );
  });
});
