'use strict';

// Phone-identity fix (incident 2026-09-10): a customer created from call
// extraction can get a caller-ID landline as customers.phone — SMS to that
// number (including the login code) silently never arrives. After the
// customer row is created, call-recording-processor runs this line-type
// check on that phone: a non-mobile line stamps customers.line_type (ONLY
// if the row still has that same phone — codex PR #4341 r1 P1) and fires an
// ops notification; a mobile line does neither; any lookup error, or a
// lookup that never settles within the deadline (codex r1 P1), fails open.
//
// Mocks the messaging validators' line-type module as a black box (its own
// cache/lookup logic is covered by messaging-line-type-validator.test.js) —
// mirrors the mocking style of that suite and of voicemail-lead-sms.test.js,
// which consume the same module the same way.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/validators/line-type', () => ({
  readCachedLineType: jest.fn(),
  cacheLineType: jest.fn(),
  lookupLineType: jest.fn(),
  NON_SMS_LINE_TYPES: new Set(['landline', 'fixedVoip']),
}));
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: jest.fn().mockResolvedValue({ bellWritten: true }),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const lineTypeModule = require('../services/messaging/validators/line-type');
const { triggerNotification } = require('../services/notification-triggers');
const { flagNonMobileCallCustomer, LINE_TYPE_LOOKUP_TIMEOUT_MS } = require('../services/call-created-customer-line-type');

// customers.line_type write shape: where(id) -> whereRaw(phone-still-matches) -> update(...)
function wireCustomersUpdate({ updated = 1 } = {}) {
  const update = jest.fn().mockResolvedValue(updated);
  const whereRaw = jest.fn(() => ({ update }));
  const where = jest.fn(() => ({ whereRaw }));
  db.mockImplementation((table) => {
    expect(table).toBe('customers');
    return { where };
  });
  return { where, whereRaw, update };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe('flagNonMobileCallCustomer', () => {
  test('mobile line: no stamp, no notification', async () => {
    lineTypeModule.readCachedLineType.mockResolvedValue({ state: 'miss' });
    lineTypeModule.lookupLineType.mockResolvedValue('mobile');
    const { where, update } = wireCustomersUpdate();

    const result = await flagNonMobileCallCustomer({
      customerId: 'cust-1', phone: '+19415550111', name: 'Jamie Cell',
    });

    expect(result).toEqual({ checked: true, lineType: 'mobile', flagged: false });
    expect(lineTypeModule.cacheLineType).toHaveBeenCalledWith('+19415550111', 'mobile');
    expect(where).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('landline: stamps customers.line_type (guarded by the still-current phone) and fires the ops notification', async () => {
    lineTypeModule.readCachedLineType.mockResolvedValue({ state: 'miss' });
    lineTypeModule.lookupLineType.mockResolvedValue('landline');
    const { where, whereRaw, update } = wireCustomersUpdate();

    const result = await flagNonMobileCallCustomer({
      customerId: 'cust-2', phone: '+19415550202', name: 'Pat Landline',
    });

    expect(result).toEqual({ checked: true, lineType: 'landline', flagged: true });
    expect(lineTypeModule.cacheLineType).toHaveBeenCalledWith('+19415550202', 'landline');
    expect(where).toHaveBeenCalledWith({ id: 'cust-2' });
    expect(whereRaw).toHaveBeenCalledWith(expect.stringContaining('RIGHT(regexp_replace'), ['9415550202']);
    expect(update).toHaveBeenCalledWith({ line_type: 'landline' });
    expect(triggerNotification).toHaveBeenCalledWith('customer_landline_from_call', {
      customerId: 'cust-2', name: 'Pat Landline', phone: '+19415550202',
    });
  });

  test('a cached fixedVoip result also stamps and notifies, with no second Lookup', async () => {
    lineTypeModule.readCachedLineType.mockResolvedValue({ state: 'hit', lineType: 'fixedVoip' });
    const { update } = wireCustomersUpdate();

    const result = await flagNonMobileCallCustomer({ customerId: 'cust-3', phone: '+19415550303' });

    expect(result).toEqual({ checked: true, lineType: 'fixedVoip', flagged: true });
    expect(lineTypeModule.lookupLineType).not.toHaveBeenCalled();
    expect(lineTypeModule.cacheLineType).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ line_type: 'fixedVoip' });
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  // codex PR #4341 r1 P1: an admin corrected customers.phone while the
  // lookup was in flight — the stale number's verdict must not land on the
  // corrected row, and staff must not be pointed at a number that's no
  // longer this customer's.
  test('phone changed under the lookup (0-row update): no stamp survives, no notification', async () => {
    lineTypeModule.readCachedLineType.mockResolvedValue({ state: 'hit', lineType: 'landline' });
    const { update } = wireCustomersUpdate({ updated: 0 });

    const result = await flagNonMobileCallCustomer({ customerId: 'cust-9', phone: '+19415550909' });

    expect(result).toEqual({ checked: true, lineType: 'landline', flagged: false, phoneChanged: true });
    expect(update).toHaveBeenCalledWith({ line_type: 'landline' });
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('lookup throws: fails open, no throw, no stamp, no notification', async () => {
    lineTypeModule.readCachedLineType.mockRejectedValue(new Error('Lookup service unavailable'));
    wireCustomersUpdate();

    await expect(flagNonMobileCallCustomer({
      customerId: 'cust-4', phone: '+19415550404',
    })).resolves.toEqual({ checked: false, error: 'Lookup service unavailable' });

    expect(db).not.toHaveBeenCalled();
    expect(triggerNotification).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('cust-4'));
  });

  test('the customers.line_type write throwing is also fail-open', async () => {
    lineTypeModule.readCachedLineType.mockResolvedValue({ state: 'hit', lineType: 'landline' });
    db.mockImplementation(() => ({
      where: () => ({ whereRaw: () => ({ update: () => { throw new Error('db unavailable'); } }) }),
    }));

    await expect(flagNonMobileCallCustomer({
      customerId: 'cust-5', phone: '+19415550505',
    })).resolves.toEqual({ checked: false, error: 'db unavailable' });
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a cache read error leaves lineType unresolved — no lookup fallback spend, no stamp', async () => {
    lineTypeModule.readCachedLineType.mockResolvedValue({ state: 'error' });
    const { update } = wireCustomersUpdate();

    const result = await flagNonMobileCallCustomer({ customerId: 'cust-6', phone: '+19415550606' });

    expect(result).toEqual({ checked: true, lineType: null, flagged: false });
    expect(lineTypeModule.lookupLineType).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('missing customerId or phone short-circuits without touching the cache/db', async () => {
    await expect(flagNonMobileCallCustomer({ phone: '+19415550707' })).resolves.toEqual({ checked: false });
    await expect(flagNonMobileCallCustomer({ customerId: 'cust-7' })).resolves.toEqual({ checked: false });
    expect(lineTypeModule.readCachedLineType).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  // codex PR #4341 r1 P1: the Twilio Lookup call has no timeout of its own,
  // and processRecording awaits this whole helper — a stalled lookup must
  // not leave the call in `processing` forever.
  test('a lookup that never settles resolves unflagged within the deadline, without blocking the caller', async () => {
    jest.useFakeTimers();
    // Never resolves/rejects — simulates a stalled Twilio Lookup.
    lineTypeModule.readCachedLineType.mockReturnValue(new Promise(() => {}));
    wireCustomersUpdate();

    const pending = flagNonMobileCallCustomer({ customerId: 'cust-8', phone: '+19415550808' });

    await jest.advanceTimersByTimeAsync(LINE_TYPE_LOOKUP_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({ checked: false, timedOut: true });
    expect(db).not.toHaveBeenCalled();
    expect(triggerNotification).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('cust-8'));
  });
});
