/**
 * Error-middleware PII redaction — the global errorHandler logs req.body on
 * every unhandled error, so a booking/confirm failure would land a
 * customer's phone/email/address/name/code in the logs raw. The redactor
 * must mask sensitive VALUES while preserving the body's shape (keys +
 * non-sensitive values survive) so the log stays useful for debugging.
 */
jest.mock('../services/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

const logger = require('../services/logger');
const { errorHandler, redactSensitiveBody } = require('../middleware/errors');

const REDACTED = '[REDACTED]';

describe('redactSensitiveBody', () => {
  test('masks phone/email/address/name/card/token/password/code variants, keeps keys', () => {
    const body = {
      phone: '941-555-1234',
      email: 'jane@example.com',
      first_name: 'Jane',
      last_name: 'Doe',
      address_line1: '123 Main St',
      cardNumber: '4111111111111111',
      capture_token: 'abc.def',
      password: 'hunter2',
      confirmation_code: 'WPC-ABCD',
      gate_code: '4411',
      ssn: '123-45-6789',
    };
    const out = redactSensitiveBody(body);
    expect(Object.keys(out).sort()).toEqual(Object.keys(body).sort());
    for (const key of Object.keys(body)) expect(out[key]).toBe(REDACTED);
    // input untouched (the handler must not mutate req.body)
    expect(body.phone).toBe('941-555-1234');
  });

  test('non-sensitive values pass through unchanged (log stays useful)', () => {
    const out = redactSensitiveBody({
      slot_date: '2026-07-10',
      slot_start: '09:00',
      duration_minutes: 60,
      service_type: 'General Pest Control',
      recurring_pattern: 'quarterly',
      payAtVisit: true,
    });
    expect(out).toEqual({
      slot_date: '2026-07-10',
      slot_start: '09:00',
      duration_minutes: 60,
      service_type: 'General Pest Control',
      recurring_pattern: 'quarterly',
      payAtVisit: true,
    });
  });

  test('recurses into nested objects and arrays (the /confirm new_customer shape)', () => {
    const out = redactSensitiveBody({
      slot_date: '2026-07-10',
      new_customer: {
        first_name: 'Jane',
        phone: '9415551234',
        email: 'jane@example.com',
        address_line1: '123 Main St',
        city: 'Sarasota',
      },
      items: [{ email: 'a@b.com', qty: 2 }],
    });
    expect(out.new_customer.first_name).toBe(REDACTED);
    expect(out.new_customer.phone).toBe(REDACTED);
    expect(out.new_customer.email).toBe(REDACTED);
    expect(out.new_customer.address_line1).toBe(REDACTED);
    expect(out.new_customer.city).toBe('Sarasota');
    expect(out.items[0]).toEqual({ email: REDACTED, qty: 2 });
    expect(out.slot_date).toBe('2026-07-10');
  });

  test('a sensitive key holding an object masks the whole subtree', () => {
    const out = redactSensitiveBody({ address: { line1: '123 Main St', zip: '34236' } });
    expect(out.address).toBe(REDACTED);
  });

  test('null/undefined sensitive values stay as-is (shape signal preserved)', () => {
    const out = redactSensitiveBody({ phone: null, email: undefined, notes: 'hi' });
    expect(out.phone).toBeNull();
    expect(out.email).toBeUndefined();
    expect(out.notes).toBe('hi');
  });

  test('non-object bodies and edge cases are safe', () => {
    expect(redactSensitiveBody(undefined)).toBeUndefined();
    expect(redactSensitiveBody(null)).toBeNull();
    expect(redactSensitiveBody('raw string body')).toBe('raw string body');
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    expect(redactSensitiveBody(cyclic).self).toBe('[Circular]');
  });
});

describe('errorHandler', () => {
  const mkRes = () => {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  };

  beforeEach(() => jest.clearAllMocks());

  test('logs a REDACTED body — phone/email masked, non-sensitive fields intact', () => {
    const req = {
      method: 'POST',
      path: '/api/booking/confirm',
      body: { phone: '9415551234', email: 'jane@example.com', slot_date: '2026-07-10' },
    };
    const err = new Error('boom');
    errorHandler(err, req, mkRes(), jest.fn());

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [msg, meta] = logger.error.mock.calls[0];
    expect(msg).toBe('POST /api/booking/confirm: boom');
    expect(meta.stack).toBe(err.stack);
    expect(meta.body).toEqual({ phone: REDACTED, email: REDACTED, slot_date: '2026-07-10' });
    // and req.body itself was not mutated
    expect(req.body.phone).toBe('9415551234');
  });

  test('response envelopes are unchanged: operational error → its status/code', () => {
    const res = mkRes();
    const err = Object.assign(new Error('That time slot was just taken. Please pick another.'), {
      isOperational: true, statusCode: 409, code: 'SLOT_TAKEN',
    });
    errorHandler(err, { method: 'POST', path: '/x', body: {} }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: err.message, code: 'SLOT_TAKEN' });
  });

  test('response envelopes are unchanged: unknown error → 500', () => {
    const res = mkRes();
    errorHandler(new Error('kaput'), { method: 'GET', path: '/y', body: undefined }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
