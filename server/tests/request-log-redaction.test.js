const {
  isSensitiveQueryKey,
  redactRequestUrl,
} = require('../utils/redact-request-url');

describe('request URL log redaction', () => {
  test.each([
    'token',
    'access_token',
    'refreshToken',
    'jwt',
    'Authorization',
    'x-api-key',
    'client_secret',
    'password',
    'session',
    'nonce',
    'otp',
    'X-Amz-Credential',
    'X-Amz-Signature',
  ])('recognizes %s as a sensitive query key', (key) => {
    expect(isSensitiveQueryKey(key)).toBe(true);
  });

  test('redacts token-like parameters while preserving useful query context', () => {
    expect(redactRequestUrl(
      '/api/admin/call-recordings/audio/RE123?token=staff.jwt.here&force=true&access_token=second',
    )).toBe(
      '/api/admin/call-recordings/audio/RE123?token=[REDACTED]&force=true&access_token=[REDACTED]',
    );
  });

  test('redacts encoded keys and JWT-shaped values even under an unfamiliar key', () => {
    expect(redactRequestUrl(
      'https://portal.example/path?access%5Ftoken=secret&session=eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.signature&days=7#section',
    )).toBe(
      'https://portal.example/path?access%5Ftoken=[REDACTED]&session=[REDACTED]&days=7#section',
    );
  });

  test('does not throw on malformed escapes or alter URLs without a query', () => {
    expect(redactRequestUrl('/api/plain/path')).toBe('/api/plain/path');
    expect(() => redactRequestUrl('/api/path?%E0%A4%A=value&token')).not.toThrow();
    expect(redactRequestUrl('/api/path?%E0%A4%A=value&token')).toBe(
      '/api/path?%E0%A4%A=value&token=[REDACTED]',
    );
  });
});
