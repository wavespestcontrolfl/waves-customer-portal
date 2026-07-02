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
// records update/insert payloads. where(fn) invokes the closure against the
// same builder (mirroring knex) so the ownership-guard predicate is recorded.
function makeInner({
  convertible = { id: 'lead-1' },
  customer = { id: 'cust-1', pipeline_stage: 'new_lead', member_since: null, active: true, churned_at: null },
  failOn = null,
  leadUpdateCount = 1,
} = {}) {
  const writes = { updates: [], inserts: [] };
  const chains = [];
  const inner = jest.fn((table) => {
    const b = {
      _table: table,
      where: jest.fn((arg) => {
        if (typeof arg === 'function') arg(b);
        return b;
      }),
      whereNull: jest.fn(() => b),
      orWhere: jest.fn(() => b),
      whereNotIn: jest.fn(() => b),
      first: jest.fn(async () => {
        if (failOn === 'first') throw new Error('boom');
        if (table === 'leads') return convertible;
        if (table === 'customers') return customer;
        return null;
      }),
      update: jest.fn(async (payload) => {
        if (failOn === 'update') throw new Error('boom');
        writes.updates.push({ table, payload });
        return table === 'leads' ? leadUpdateCount : 1;
      }),
      insert: jest.fn(async (payload) => {
        if (failOn === 'insert') throw new Error('boom');
        writes.inserts.push({ table, payload });
        return [1];
      }),
    };
    chains.push(b);
    return b;
  });
  inner._writes = writes;
  inner._chains = chains;
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

  test('ownership guard on read AND write: only an unclaimed lead or one already owned by the booked customer converts', async () => {
    const inner = makeInner();
    const trx = makeTrx(inner);

    await convertCallLeadOnPhoneBooking(trx, ARGS);

    // leadId can come from the phone-only existing-lead lookup, and a caller
    // phone can be shared across leads — booking one customer must never
    // steal another customer's lead. The predicate is repeated in the UPDATE
    // so a concurrent claim between read and write can't slip through.
    const leadChains = inner._chains.filter((b) => b._table === 'leads');
    expect(leadChains).toHaveLength(2); // read + update
    for (const b of leadChains) {
      expect(b.whereNull).toHaveBeenCalledWith('customer_id');
      expect(b.orWhere).toHaveBeenCalledWith('customer_id', 'cust-1');
    }
  });

  test('update raced to zero rows → returns false, no activity row, no promotion', async () => {
    const inner = makeInner({ leadUpdateCount: 0 });
    const trx = makeTrx(inner);

    const converted = await convertCallLeadOnPhoneBooking(trx, ARGS);

    expect(converted).toBe(false);
    expect(inner._writes.inserts).toHaveLength(0);
    expect(inner._writes.updates.filter((w) => w.table === 'customers')).toHaveLength(0);
  });

  test('promotes a new_lead customer to won with member_since + reactivation (mirrors admin schedule-appointment)', async () => {
    const inner = makeInner();
    const trx = makeTrx(inner);

    const converted = await convertCallLeadOnPhoneBooking(trx, ARGS);

    expect(converted).toBe(true);
    const custUpdate = inner._writes.updates.find((w) => w.table === 'customers');
    expect(custUpdate).toBeTruthy();
    expect(custUpdate.payload).toMatchObject({
      pipeline_stage: 'won',
      active: true,
      churned_at: null,
      churn_reason: null,
    });
    // A lead's intake member_since is overwritten with today's ET date.
    expect(custUpdate.payload.member_since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('customer already in a live stage and active → no customer write', async () => {
    const inner = makeInner({
      customer: { id: 'cust-1', pipeline_stage: 'active_customer', member_since: '2024-05-01', active: true, churned_at: null },
    });
    const trx = makeTrx(inner);

    const converted = await convertCallLeadOnPhoneBooking(trx, ARGS);

    expect(converted).toBe(true);
    expect(inner._writes.updates.filter((w) => w.table === 'customers')).toHaveLength(0);
  });

  test('churned customer re-booking: real start date preserved, row reactivated', async () => {
    const inner = makeInner({
      customer: { id: 'cust-1', pipeline_stage: 'churned', member_since: '2024-05-01', active: false, churned_at: new Date('2026-01-01') },
    });
    const trx = makeTrx(inner);

    const converted = await convertCallLeadOnPhoneBooking(trx, ARGS);

    expect(converted).toBe(true);
    const custUpdate = inner._writes.updates.find((w) => w.table === 'customers');
    expect(custUpdate.payload).toMatchObject({
      pipeline_stage: 'won',
      member_since: '2024-05-01',
      active: true,
      churned_at: null,
    });
  });

  test('customer row missing → lead still converts, no customer write, no throw', async () => {
    const inner = makeInner({ customer: null });
    const trx = makeTrx(inner);

    const converted = await convertCallLeadOnPhoneBooking(trx, ARGS);

    expect(converted).toBe(true);
    expect(inner._writes.updates.filter((w) => w.table === 'customers')).toHaveLength(0);
    expect(inner._writes.inserts).toHaveLength(1);
  });
});
