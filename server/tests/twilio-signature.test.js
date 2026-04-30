/**
 * Tests for server/middleware/twilio-signature.js
 *
 * Twilio signs (URL + concat-of-sorted-params) with HMAC-SHA1 keyed by
 * the auth token. We compute expected signatures inline rather than
 * depend on the twilio library's internal API surface (which has shifted
 * across major versions). Failing here means production webhooks would
 * either reject real Twilio traffic (false positives in enforce mode)
 * or accept forged callbacks (false negatives in any mode).
 *
 * Coverage matrix (per docs/call-triage-discovery.md §14):
 *   - valid signature → next() in any mode
 *   - forged signature → reject in enforce, log in log-mode
 *   - missing X-Twilio-Signature → reject in enforce, log in log-mode
 *   - proxy HTTPS mismatch (req.protocol='http' but X-Forwarded-Proto='https') → reconstruct correctly, validate
 *   - new/unknown Twilio parameter (forward-compat) → still validates
 *   - missing TWILIO_AUTH_TOKEN → 500 in enforce, log+next in log-mode
 *   - GET request with no body → validates against URL only
 */

const crypto = require('crypto');

// Mock the logger so test output isn't polluted with [twilio-sig] lines.
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const logger = require('../services/logger');
const {
  validateTwilioSignature,
  reconstructUrl,
  getMode,
  __resetSeen,
} = require('../middleware/twilio-signature');

const TEST_TOKEN = 'test_auth_token_12345';

// Twilio signature: HMAC-SHA1(authToken, URL + sortedKey1+value1 + ...)
// then base64. Match the library exactly.
function generateSignature(authToken, url, params) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return crypto
    .createHmac('sha1', authToken)
    .update(Buffer.from(data, 'utf-8'))
    .digest('base64');
}

function mockReq({
  method = 'POST',
  protocol = 'https',
  host = 'waves-portal.example.com',
  originalUrl = '/api/webhooks/twilio/voice',
  body = {},
  headers = {},
} = {}) {
  return {
    method,
    protocol,
    originalUrl,
    body,
    path: originalUrl.split('?')[0],
    get(h) {
      const k = h.toLowerCase();
      if (k === 'host') return host;
      const found = Object.keys(headers).find((kk) => kk.toLowerCase() === k);
      return found ? headers[found] : undefined;
    },
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.type = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.end = jest.fn().mockReturnValue(res);
  return res;
}

let savedToken, savedMode;
beforeEach(() => {
  savedToken = process.env.TWILIO_AUTH_TOKEN;
  savedMode = process.env.TWILIO_SIGNATURE_VALIDATION;
  process.env.TWILIO_AUTH_TOKEN = TEST_TOKEN;
  process.env.TWILIO_SIGNATURE_VALIDATION = 'enforce';
  __resetSeen();
  jest.clearAllMocks();
});
afterEach(() => {
  process.env.TWILIO_AUTH_TOKEN = savedToken;
  process.env.TWILIO_SIGNATURE_VALIDATION = savedMode;
});

describe('reconstructUrl', () => {
  test('uses req.protocol + Host header when no X-Forwarded-Proto', () => {
    const req = mockReq({ protocol: 'https', host: 'h.example.com', originalUrl: '/x?y=1' });
    expect(reconstructUrl(req)).toBe('https://h.example.com/x?y=1');
  });

  test('prefers X-Forwarded-Proto over req.protocol (Railway proxy)', () => {
    const req = mockReq({
      protocol: 'http', // internal hop sees plain http
      host: 'h.example.com',
      originalUrl: '/x',
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    expect(reconstructUrl(req)).toBe('https://h.example.com/x');
  });

  test('handles X-Forwarded-Proto with multiple values (chain proxy)', () => {
    const req = mockReq({
      protocol: 'http',
      host: 'h.example.com',
      originalUrl: '/x',
      headers: { 'X-Forwarded-Proto': 'https, http' },
    });
    expect(reconstructUrl(req)).toBe('https://h.example.com/x');
  });
});

describe('getMode', () => {
  test('defaults to log when env unset', () => {
    delete process.env.TWILIO_SIGNATURE_VALIDATION;
    expect(getMode()).toBe('log');
  });
  test('honors enforce', () => {
    process.env.TWILIO_SIGNATURE_VALIDATION = 'enforce';
    expect(getMode()).toBe('enforce');
  });
  test('honors disabled', () => {
    process.env.TWILIO_SIGNATURE_VALIDATION = 'disabled';
    expect(getMode()).toBe('disabled');
  });
  test('unknown value falls back to log', () => {
    process.env.TWILIO_SIGNATURE_VALIDATION = 'pretend';
    expect(getMode()).toBe('log');
  });
});

describe('validateTwilioSignature — valid signature', () => {
  test('passes through to next() when signature matches (enforce mode)', () => {
    const url = 'https://waves-portal.example.com/api/webhooks/twilio/voice';
    const body = { CallSid: 'CA1', From: '+19415551234', To: '+19413187612' };
    const sig = generateSignature(TEST_TOKEN, url, body);

    const req = mockReq({ body, headers: { 'X-Twilio-Signature': sig } });
    const res = mockRes();
    const next = jest.fn();

    validateTwilioSignature(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    // First valid → INFO log
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('first valid signature'));
  });

  test('logs first-valid only ONCE per endpoint per process boot', () => {
    const url = 'https://waves-portal.example.com/api/webhooks/twilio/voice';
    const body = { CallSid: 'CA1' };
    const sig = generateSignature(TEST_TOKEN, url, body);

    const req1 = mockReq({ body, headers: { 'X-Twilio-Signature': sig } });
    const req2 = mockReq({ body, headers: { 'X-Twilio-Signature': sig } });
    const next = jest.fn();
    validateTwilioSignature(req1, mockRes(), next);
    validateTwilioSignature(req2, mockRes(), next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  test('validates after Railway proxy URL reconstruction', () => {
    // Simulate Railway: internal req.protocol=http but Twilio called https.
    const publicUrl = 'https://waves-portal.example.com/api/webhooks/twilio/recording-status';
    const body = { CallSid: 'CA1', RecordingSid: 'RE1' };
    const sig = generateSignature(TEST_TOKEN, publicUrl, body);

    const req = mockReq({
      method: 'POST',
      protocol: 'http',
      originalUrl: '/api/webhooks/twilio/recording-status',
      host: 'waves-portal.example.com',
      body,
      headers: { 'X-Twilio-Signature': sig, 'X-Forwarded-Proto': 'https' },
    });
    const res = mockRes();
    const next = jest.fn();

    validateTwilioSignature(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('validates a payload with a previously-unseen Twilio parameter (forward-compat)', () => {
    const url = 'https://waves-portal.example.com/api/webhooks/twilio/transcription';
    const body = {
      CallSid: 'CA1',
      TranscriptionText: 'hello',
      // Hypothetical new Twilio field — must be included in signature input
      // because Twilio signs over WHATEVER it sends, not a fixed allowlist.
      NewTwilioField: 'experimental_value',
    };
    const sig = generateSignature(TEST_TOKEN, url, body);
    const req = mockReq({
      originalUrl: '/api/webhooks/twilio/transcription',
      body,
      headers: { 'X-Twilio-Signature': sig },
    });
    const next = jest.fn();
    validateTwilioSignature(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('GET request validates against URL only (empty params)', () => {
    const url = 'https://waves-portal.example.com/api/webhooks/twilio/voice';
    const sig = generateSignature(TEST_TOKEN, url, {});
    const req = mockReq({
      method: 'GET',
      body: { ignored: 'should-not-be-signed' },
      headers: { 'X-Twilio-Signature': sig },
    });
    const next = jest.fn();
    validateTwilioSignature(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });
});

describe('validateTwilioSignature — invalid / missing signature', () => {
  test('forged signature in enforce mode → 403, no next()', () => {
    const req = mockReq({
      body: { CallSid: 'CA1' },
      headers: { 'X-Twilio-Signature': 'ZmFrZS1zaWc=' },
    });
    const res = mockRes();
    const next = jest.fn();
    validateTwilioSignature(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('INVALID signature'));
  });

  test('forged signature in log mode → next() called, warning logged', () => {
    process.env.TWILIO_SIGNATURE_VALIDATION = 'log';
    const req = mockReq({
      body: { CallSid: 'CA1' },
      headers: { 'X-Twilio-Signature': 'ZmFrZS1zaWc=' },
    });
    const res = mockRes();
    const next = jest.fn();
    validateTwilioSignature(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('INVALID signature'));
  });

  test('missing signature header in enforce mode → 403', () => {
    const req = mockReq({ body: { CallSid: 'CA1' }, headers: {} });
    const res = mockRes();
    const next = jest.fn();
    validateTwilioSignature(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing X-Twilio-Signature'));
  });

  test('missing signature header in log mode → next()', () => {
    process.env.TWILIO_SIGNATURE_VALIDATION = 'log';
    const req = mockReq({ body: { CallSid: 'CA1' }, headers: {} });
    const next = jest.fn();
    validateTwilioSignature(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('does NOT log req.body content (PII protection)', () => {
    const req = mockReq({
      body: { CallSid: 'CA1', From: '+19415551234', TranscriptionText: 'PII secret transcript' },
      headers: { 'X-Twilio-Signature': 'ZmFrZQ==' },
    });
    validateTwilioSignature(req, mockRes(), jest.fn());
    const logCalls = logger.warn.mock.calls.map((c) => c[0]).join('\n');
    expect(logCalls).not.toContain('+19415551234');
    expect(logCalls).not.toContain('PII secret transcript');
  });

  test('disabled mode bypasses validation entirely', () => {
    process.env.TWILIO_SIGNATURE_VALIDATION = 'disabled';
    const req = mockReq({ body: { CallSid: 'CA1' }, headers: {} });
    const next = jest.fn();
    validateTwilioSignature(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('validateTwilioSignature — auth token misconfig', () => {
  test('missing TWILIO_AUTH_TOKEN in enforce mode → 500', () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const req = mockReq({ body: { CallSid: 'CA1' }, headers: { 'X-Twilio-Signature': 'x' } });
    const res = mockRes();
    const next = jest.fn();
    validateTwilioSignature(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('missing TWILIO_AUTH_TOKEN in log mode → next() with error log', () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    process.env.TWILIO_SIGNATURE_VALIDATION = 'log';
    const req = mockReq({ body: { CallSid: 'CA1' }, headers: { 'X-Twilio-Signature': 'x' } });
    const next = jest.fn();
    validateTwilioSignature(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('TWILIO_AUTH_TOKEN not configured'));
  });
});
