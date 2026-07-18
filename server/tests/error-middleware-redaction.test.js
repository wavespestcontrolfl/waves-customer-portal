/**
 * Error-middleware PII redaction — the global errorHandler logs req.body on
 * every unhandled error, so a booking/confirm or admin-SMS failure would land
 * a customer's phone/email/address/name/SMS body in the logs raw. The old
 * key-based denylist missed keys like `to`/`body`/`message`/`fromNumber`
 * (admin-communications passes { to, body, ... } to next(err)), so the
 * redactor is shape-only: every string/number VALUE is replaced by a
 * type:length marker — no free text can leak through ANY key, known or
 * unknown. Booleans and null/undefined pass through as debugging signal.
 *
 * Keys are content too: { "jane@example.com": true } would still write an
 * email into the logs with only values masked. So only allowlisted structural
 * key NAMES (ids, enum discriminators, dates, pagination, booking-flow
 * containers) survive verbatim; every other key becomes a
 * '[key:string:<len>:<hash8>]' marker (short one-way sha256 prefix keeps
 * shapes correlatable and distinct keys from colliding without exposing the
 * key text).
 */
jest.mock('../services/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

const crypto = require('crypto');
const logger = require('../services/logger');
const { errorHandler, redactSensitiveBody } = require('../middleware/errors');

// Mirrors redactKey in middleware/errors.js — expected marker for a
// non-allowlisted key.
const keyMarker = (k) =>
  `[key:string:${k.length}:${crypto.createHash('sha256').update(k).digest('hex').slice(0, 8)}]`;

describe('redactSensitiveBody', () => {
  test('masks classic PII values as type:length markers; non-structural keys become key markers', () => {
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
    expect(Object.keys(out)).toHaveLength(Object.keys(body).length);
    for (const [key, val] of Object.entries(body)) {
      expect(out[keyMarker(key)]).toBe(`[string:${val.length}]`);
    }
    // no raw key name or value survives anywhere in the redacted payload
    const flat = JSON.stringify(out);
    for (const [key, val] of Object.entries(body)) {
      expect(flat).not.toContain(`"${key}"`);
      expect(flat).not.toContain(val);
    }
    // input untouched (the handler must not mutate req.body)
    expect(body.phone).toBe('941-555-1234');
  });

  test('PII-looking KEYS never reach the logs: {"jane@example.com": true}', () => {
    const out = redactSensitiveBody({
      'jane@example.com': true,
      '941-555-1234': 'call me',
    });
    const flat = JSON.stringify(out);
    expect(flat).not.toContain('jane@example.com');
    expect(flat).not.toContain('941-555-1234');
    const keys = Object.keys(out);
    expect(keys).toHaveLength(2); // distinct hashes — no marker collision
    for (const k of keys) expect(k).toMatch(/^\[key:string:\d+:[0-9a-f]{8}\]$/);
    // boolean value survives as shape signal; string value is masked
    expect(out[keyMarker('jane@example.com')]).toBe(true);
    expect(out[keyMarker('941-555-1234')]).toBe('[string:7]');
  });

  test('allowlisted structural keys pass through verbatim (values still masked)', () => {
    const out = redactSensitiveBody({
      estimate_id: 'abc123',
      slotId: 42,
      status: 'pending',
      scheduled_for: '2026-07-11T09:00',
      page: 2,
      source: 'book_page',
    });
    expect(Object.keys(out).sort()).toEqual(
      ['estimate_id', 'page', 'scheduled_for', 'slotId', 'source', 'status'].sort(),
    );
    expect(out.estimate_id).toBe('[string:6]');
    expect(out.slotId).toBe('[number:2]');
    expect(out.status).toBe('[string:7]');
    expect(out.scheduled_for).toBe('[string:16]');
    expect(out.page).toBe('[number:1]');
  });

  test('masks the admin-SMS payload the denylist missed: to/body/message/fromNumber', () => {
    const body = {
      to: '+19415551234',
      body: 'Hi Jane, your quarterly pest visit is confirmed for Friday.',
      message: 'call me back at 941-555-1234',
      fromNumber: '+19412030220',
    };
    const out = redactSensitiveBody(body);
    expect(out).toEqual({
      [keyMarker('to')]: '[string:12]',
      [keyMarker('body')]: `[string:${body.body.length}]`,
      [keyMarker('message')]: `[string:${body.message.length}]`,
      [keyMarker('fromNumber')]: '[string:12]',
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
    });
    expect(out[keyMarker('some_future_key')]).toBe('[string:31]');
    expect(out[keyMarker('digits')]).toBe('[number:10]');
    expect(out[keyMarker('big')]).toBe('[bigint:2]');
    // booleans carry no PII and stay useful for debugging
    expect(out[keyMarker('payAtVisit')]).toBe(true);
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
    // container keys are structural and survive; inner PII keys do not
    expect(out.new_customer).toEqual({
      [keyMarker('first_name')]: '[string:4]',
      [keyMarker('phone')]: '[string:10]',
      [keyMarker('city')]: '[string:8]',
    });
    expect(out.items[0]).toEqual({ [keyMarker('email')]: '[string:7]', qty: '[number:1]' });
  });

  test('null/undefined values stay as-is (shape signal preserved)', () => {
    const out = redactSensitiveBody({ status: null, date: undefined, ok: true });
    expect(out.status).toBeNull();
    expect(out.date).toBeUndefined();
    expect(out[keyMarker('ok')]).toBe(true);
  });

  test('non-object bodies and edge cases are safe', () => {
    expect(redactSensitiveBody(undefined)).toBeUndefined();
    expect(redactSensitiveBody(null)).toBeNull();
    // a raw string body is free text too — masked, not passed through
    expect(redactSensitiveBody('raw string body')).toBe('[string:15]');
    const cyclic = { id: 1 };
    cyclic.self = cyclic;
    expect(redactSensitiveBody(cyclic)[keyMarker('self')]).toBe('[Circular]');
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

  test('logs a shape-only body — no raw value OR non-structural key reaches the logger', () => {
    const req = {
      method: 'POST',
      path: '/api/admin/communications/schedule-sms',
      body: {
        to: '+19415551234',
        body: 'Hi Jane, see you Friday at 9.',
        fromNumber: '+19412030220',
        scheduledFor: '2026-07-11T09:00',
        'jane@example.com': true,
      },
    };
    const err = new Error('boom');
    errorHandler(err, req, mkRes(), jest.fn());

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [msg, meta] = logger.error.mock.calls[0];
    expect(msg).toBe('POST /api/admin/communications/schedule-sms: boom');
    expect(meta.stack).toBe(err.stack);
    expect(meta.body).toEqual({
      [keyMarker('to')]: '[string:12]',
      [keyMarker('body')]: '[string:29]',
      [keyMarker('fromNumber')]: '[string:12]',
      scheduledFor: '[string:16]', // allowlisted structural key survives
      [keyMarker('jane@example.com')]: true,
    });
    // nothing the customer typed, no phone number, and no PII-bearing key
    // survives in the log call
    const flat = JSON.stringify(meta.body);
    for (const val of Object.values(req.body)) {
      if (typeof val === 'string') expect(flat).not.toContain(val);
    }
    expect(flat).not.toContain('jane@example.com');
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
