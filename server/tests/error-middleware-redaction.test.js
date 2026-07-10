/**
 * Error-middleware PII redaction — the global errorHandler logs req.body on
 * every unhandled error, so a booking/confirm or admin-SMS failure would land
 * a customer's phone/email/address/name/SMS body in the logs raw. The old
 * key-based denylist missed keys like `to`/`body`/`message`/`fromNumber`
 * (admin-communications passes { to, body, ... } to next(err)), so the
 * redactor is now shape-only: every key survives, every string/number value
 * is replaced by a type:length marker — no free text can leak through ANY
 * key, known or unknown. Booleans and null/undefined pass through as
 * debugging signal.
 */
jest.mock('../services/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

const logger = require('../services/logger');
const { errorHandler, redactSensitiveBody } = require('../middleware/errors');

describe('redactSensitiveBody', () => {
  test('masks classic PII keys as type:length markers, keeps keys', () => {
    const body = {
      phone: '941-555-1234',
      email: 'jane@example.com',
      first_name: 'Jane',
      address_line1: '123 Main St',
      cardNumber: '4111111111111111',
      password: 'hunter2',
      gate_code: '4411',
      ssn: '123-45-6789',
    };
    const out = redactSensitiveBody(body);
    expect(Object.keys(out).sort()).toEqual(Object.keys(body).sort());
    for (const key of Object.keys(body)) {
      expect(out[key]).toBe(`[string:${body[key].length}]`);
    }
    // input untouched (the handler must not mutate req.body)
    expect(body.phone).toBe('941-555-1234');
  });

  test('masks the admin-SMS keys the denylist missed: to/body/message/fromNumber', () => {
    const body = {
      to: '+19415551234',
      body: 'Hi Jane, your quarterly pest visit is confirmed for Friday.',
      message: 'call me back at 941-555-1234',
      fromNumber: '+19412030220',
    };
    const out = redactSensitiveBody(body);
    expect(out).toEqual({
      to: '[string:12]',
      body: `[string:${body.body.length}]`,
      message: `[string:${body.message.length}]`,
      fromNumber: '[string:12]',
    });
    // no raw value survives anywhere in the redacted payload
    const flat = JSON.stringify(out);
    for (const val of Object.values(body)) expect(flat).not.toContain(val);
  });

  test('arbitrary unknown keys leak nothing — strings and numbers become markers', () => {
    const out = redactSensitiveBody({
      some_future_key: 'Jane Doe, 123 Main St, Sarasota',
      digits: 9415551234,
      big: 10n,
      payAtVisit: true,
      flag: false,
    });
    expect(out.some_future_key).toBe('[string:31]');
    expect(out.digits).toBe('[number:10]');
    expect(out.big).toBe('[bigint:2]');
    // booleans carry no PII and stay useful for debugging
    expect(out.payAtVisit).toBe(true);
    expect(out.flag).toBe(false);
  });

  test('recurses into nested objects and arrays (the /confirm new_customer shape)', () => {
    const out = redactSensitiveBody({
      new_customer: {
        first_name: 'Jane',
        phone: '9415551234',
        city: 'Sarasota',
      },
      items: [{ email: 'a@b.com', qty: 2 }],
    });
    expect(out.new_customer).toEqual({
      first_name: '[string:4]',
      phone: '[string:10]',
      city: '[string:8]',
    });
    expect(out.items[0]).toEqual({ email: '[string:7]', qty: '[number:1]' });
  });

  test('null/undefined values stay as-is (shape signal preserved)', () => {
    const out = redactSensitiveBody({ phone: null, email: undefined, ok: true });
    expect(out.phone).toBeNull();
    expect(out.email).toBeUndefined();
    expect(out.ok).toBe(true);
  });

  test('non-object bodies and edge cases are safe', () => {
    expect(redactSensitiveBody(undefined)).toBeUndefined();
    expect(redactSensitiveBody(null)).toBeNull();
    // a raw string body is free text too — masked, not passed through
    expect(redactSensitiveBody('raw string body')).toBe('[string:15]');
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

  test('logs a shape-only body — no raw free-text value reaches the logger', () => {
    const req = {
      method: 'POST',
      path: '/api/admin/communications/schedule-sms',
      body: {
        to: '+19415551234',
        body: 'Hi Jane, see you Friday at 9.',
        fromNumber: '+19412030220',
        scheduledFor: '2026-07-11T09:00',
      },
    };
    const err = new Error('boom');
    errorHandler(err, req, mkRes(), jest.fn());

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [msg, meta] = logger.error.mock.calls[0];
    expect(msg).toBe('POST /api/admin/communications/schedule-sms: boom');
    expect(meta.stack).toBe(err.stack);
    expect(meta.body).toEqual({
      to: '[string:12]',
      body: '[string:29]',
      fromNumber: '[string:12]',
      scheduledFor: '[string:16]',
    });
    // nothing the customer typed or any phone number survives in the log call
    const flat = JSON.stringify(meta.body);
    for (const val of Object.values(req.body)) expect(flat).not.toContain(val);
    // and req.body itself was not mutated
    expect(req.body.to).toBe('+19415551234');
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
