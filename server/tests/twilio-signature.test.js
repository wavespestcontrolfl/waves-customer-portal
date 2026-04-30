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
    // First valid → INFO breadcrumb (separate from the per-request audit)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('first valid signature'));
  });

  test('first-valid breadcrumb fires only ONCE per (method, path) per process boot', () => {
    const url = 'https://waves-portal.example.com/api/webhooks/twilio/voice';
    const body = { CallSid: 'CA1' };
    const sig = generateSignature(TEST_TOKEN, url, body);

    const req1 = mockReq({ body, headers: { 'X-Twilio-Signature': sig } });
    const req2 = mockReq({ body, headers: { 'X-Twilio-Signature': sig } });
    const next = jest.fn();
    validateTwilioSignature(req1, mockRes(), next);
    validateTwilioSignature(req2, mockRes(), next);

    expect(next).toHaveBeenCalledTimes(2);
    // Audit emits per-request (2 calls). Breadcrumb fires once.
    const breadcrumbCalls = logger.info.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('first valid signature')
    );
    expect(breadcrumbCalls).toHaveLength(1);
    const auditCalls = logger.info.mock.calls.filter(
      (c) => c[0] && c[0].evt === 'twilio_sig_audit'
    );
    expect(auditCalls).toHaveLength(2);
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
    // Audit shape with auth_result=signature_invalid, plus debug breadcrumb
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'twilio_sig_audit', auth_result: 'signature_invalid' })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('INVALID signature reconstruction debug')
    );
  });

  test('forged signature in log mode → next() called, audit logged', () => {
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
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'twilio_sig_audit', auth_result: 'signature_invalid' })
    );
  });

  test('missing signature header in enforce mode → 403', () => {
    const req = mockReq({ body: { CallSid: 'CA1' }, headers: {} });
    const res = mockRes();
    const next = jest.fn();
    validateTwilioSignature(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'twilio_sig_audit', auth_result: 'signature_missing' })
    );
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

  test('does NOT log query-string PII on signature failure (codex review)', () => {
    // /outbound-connect and /outbound-admin-prompt carry caller/admin
    // phone numbers in the query string. The invalid-signature debug
    // breadcrumb must log path only, never the URL with query, or
    // every failed validation in log mode would leak phone PII.
    const req = mockReq({
      method: 'POST',
      originalUrl:
        '/api/webhooks/twilio/outbound-connect?customerNumber=%2B19415551234&callerIdNumber=%2B19413187612&callLogId=abc-123',
      body: { Digits: '1' },
      headers: { 'X-Twilio-Signature': 'forged-sig' },
    });
    validateTwilioSignature(req, mockRes(), jest.fn());
    const allWarnLogs = logger.warn.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : JSON.stringify(c[0])))
      .join('\n');
    // No query-string fragment, no encoded numbers, no decoded numbers
    expect(allWarnLogs).not.toContain('customerNumber');
    expect(allWarnLogs).not.toContain('callerIdNumber');
    expect(allWarnLogs).not.toContain('19415551234');
    expect(allWarnLogs).not.toContain('19413187612');
    expect(allWarnLogs).not.toContain('%2B');
    // path-only is fine and expected
    expect(allWarnLogs).toContain('/api/webhooks/twilio/outbound-connect');
    // and the breadcrumb should announce that a query was present without showing it
    expect(allWarnLogs).toContain('query_present=true');
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

describe('validateTwilioSignature — structured audit telemetry (per ChatGPT v3 review)', () => {
  function findAuditCall(spy) {
    return spy.mock.calls.find((c) => c[0] && c[0].evt === 'twilio_sig_audit');
  }

  test('valid signature emits audit with auth_result=signature_valid + presence flags', () => {
    const url = 'https://waves-portal.example.com/api/webhooks/twilio/recording-status';
    const body = {
      AccountSid: 'AC123',
      CallSid: 'CA1',
      RecordingSid: 'RE1',
      RecordingStatus: 'completed',
      // PII fields the audit MUST NOT echo
      From: '+19415551234',
      RecordingUrl: 'https://api.twilio.com/.../RE1',
    };
    const sig = generateSignature(TEST_TOKEN, url, body);
    const req = mockReq({
      originalUrl: '/api/webhooks/twilio/recording-status',
      body,
      headers: { 'X-Twilio-Signature': sig, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    validateTwilioSignature(req, mockRes(), jest.fn());
    const audit = findAuditCall(logger.info);
    expect(audit).toBeDefined();
    expect(audit[0]).toMatchObject({
      evt: 'twilio_sig_audit',
      auth_result: 'signature_valid',
      method: 'POST',
      path: '/api/webhooks/twilio/recording-status',
      content_type: 'application/x-www-form-urlencoded',
      has_x_twilio_signature: true,
      account_sid_present: true,
      call_sid_present: true,
      recording_sid_present: true,
      recording_status: 'completed',
    });
    // PII must never appear in any field
    const audited = JSON.stringify(audit[0]);
    expect(audited).not.toContain('+19415551234');
    expect(audited).not.toContain('RecordingUrl');
    expect(audited).not.toContain('api.twilio.com');
  });

  test('invalid signature emits audit with auth_result=signature_invalid', () => {
    const req = mockReq({
      body: { CallSid: 'CA1' },
      headers: { 'X-Twilio-Signature': 'forged' },
    });
    validateTwilioSignature(req, mockRes(), jest.fn());
    const audit = findAuditCall(logger.warn);
    expect(audit).toBeDefined();
    expect(audit[0].auth_result).toBe('signature_invalid');
  });

  test('missing signature emits audit with auth_result=signature_missing', () => {
    const req = mockReq({ body: { CallSid: 'CA1' }, headers: {} });
    validateTwilioSignature(req, mockRes(), jest.fn());
    const audit = findAuditCall(logger.warn);
    expect(audit).toBeDefined();
    expect(audit[0].auth_result).toBe('signature_missing');
    expect(audit[0].has_x_twilio_signature).toBe(false);
  });

  test('disabled mode emits audit with auth_result=disabled', () => {
    process.env.TWILIO_SIGNATURE_VALIDATION = 'disabled';
    const req = mockReq({ body: { CallSid: 'CA1' }, headers: {} });
    validateTwilioSignature(req, mockRes(), jest.fn());
    const audit = findAuditCall(logger.info);
    expect(audit).toBeDefined();
    expect(audit[0].auth_result).toBe('disabled');
  });

  test('source_guess=studio_http_widget when User-Agent contains "studio"', () => {
    const url = 'https://waves-portal.example.com/api/webhooks/twilio/recording-status';
    const body = { CallSid: 'CA1', RecordingSid: 'RE1', RecordingStatus: 'completed' };
    const sig = generateSignature(TEST_TOKEN, url, body);
    const req = mockReq({
      originalUrl: '/api/webhooks/twilio/recording-status',
      body,
      headers: {
        'X-Twilio-Signature': sig,
        'User-Agent': 'TwilioStudio/1.0 (https://www.twilio.com/studio)',
      },
    });
    validateTwilioSignature(req, mockRes(), jest.fn());
    const audit = findAuditCall(logger.info);
    expect(audit[0].source_guess).toBe('studio_http_widget');
  });

  test('source_guess=standard_callback when AccountSid present and Twilio User-Agent', () => {
    const url = 'https://waves-portal.example.com/api/webhooks/twilio/recording-status';
    const body = { AccountSid: 'AC123', CallSid: 'CA1', RecordingSid: 'RE1' };
    const sig = generateSignature(TEST_TOKEN, url, body);
    const req = mockReq({
      originalUrl: '/api/webhooks/twilio/recording-status',
      body,
      headers: {
        'X-Twilio-Signature': sig,
        'User-Agent': 'TwilioProxy/1.1',
      },
    });
    validateTwilioSignature(req, mockRes(), jest.fn());
    const audit = findAuditCall(logger.info);
    expect(audit[0].source_guess).toBe('standard_callback');
  });

  test('source_guess=unknown when no AccountSid and no Twilio User-Agent', () => {
    const req = mockReq({
      body: { foo: 'bar' },
      headers: { 'X-Twilio-Signature': 'forged', 'User-Agent': 'curl/8.0' },
    });
    validateTwilioSignature(req, mockRes(), jest.fn());
    const audit = findAuditCall(logger.warn);
    expect(audit[0].source_guess).toBe('unknown');
  });

  test('preserves URL-encoded query string verbatim (no decode/re-encode)', () => {
    // Per ChatGPT v3 pre-merge review: Twilio webhook security requires
    // the EXACT URL be used in the signing input, including query
    // string encoding. If our middleware decoded "%20" to a space or
    // "%2B" to "+" before reconstructing the URL, the signature would
    // mismatch and prod calls would 403 in enforce mode. Express's
    // req.originalUrl preserves the raw, encoded path+query exactly
    // as the client sent it — this test pins that contract so a future
    // refactor can't silently break it.
    //
    // We sign over the raw-encoded URL (matching what Twilio would
    // sign) and then mock req.originalUrl with the same raw-encoded
    // path. If reconstructUrl() decoded anywhere, the signature would
    // not match.
    const path = '/api/webhooks/twilio/status?message=hello%20world&type=test%2Bvalue&note=foo%26bar';
    const signedUrl = 'https://waves-portal.example.com' + path;
    const body = { CallSid: 'CA1', SmsStatus: 'delivered' };
    const sig = generateSignature(TEST_TOKEN, signedUrl, body);

    const req = mockReq({
      method: 'POST',
      originalUrl: path,
      host: 'waves-portal.example.com',
      body,
      headers: { 'X-Twilio-Signature': sig },
    });
    const next = jest.fn();
    validateTwilioSignature(req, mockRes(), next);

    expect(next).toHaveBeenCalled();
    expect(reconstructUrl(req)).toBe(signedUrl);
    expect(reconstructUrl(req)).toContain('%20');
    expect(reconstructUrl(req)).toContain('%2B');
    expect(reconstructUrl(req)).toContain('%26');
  });

  test('rejects when query string is decoded by middleware (defense against future regression)', () => {
    // Belt-and-suspenders: if a future refactor accidentally decodes
    // %20 to a space before reconstructing, the signature for the
    // raw-encoded URL would no longer match. We verify that signing
    // against a DECODED URL while presenting the encoded request fails
    // — proving the middleware is keying on the raw form.
    const rawPath = '/api/webhooks/twilio/status?message=hello%20world';
    const decodedUrl = 'https://waves-portal.example.com/api/webhooks/twilio/status?message=hello world';
    const body = { CallSid: 'CA1' };
    const sigOverDecoded = generateSignature(TEST_TOKEN, decodedUrl, body);

    const req = mockReq({
      method: 'POST',
      originalUrl: rawPath, // raw-encoded — what Twilio actually sends
      host: 'waves-portal.example.com',
      body,
      headers: { 'X-Twilio-Signature': sigOverDecoded },
    });
    const res = mockRes();
    const next = jest.fn();
    validateTwilioSignature(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('proxy_proto_match=false when X-Forwarded-Proto disagrees with req.protocol', () => {
    const url = 'https://waves-portal.example.com/api/webhooks/twilio/voice';
    const body = { CallSid: 'CA1' };
    const sig = generateSignature(TEST_TOKEN, url, body);
    const req = mockReq({
      protocol: 'http', // internal hop sees plain http
      body,
      headers: { 'X-Twilio-Signature': sig, 'X-Forwarded-Proto': 'https' },
    });
    validateTwilioSignature(req, mockRes(), jest.fn());
    const audit = findAuditCall(logger.info);
    expect(audit[0].proxy_proto_match).toBe(false);
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
