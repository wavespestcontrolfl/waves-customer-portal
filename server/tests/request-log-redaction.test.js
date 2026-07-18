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

  test('redacts bearer tokens riding the PATH (hex tokens, JWTs, booking codes)', () => {
    const hex64 = 'a'.repeat(64);
    const hex32 = '0123456789abcdef0123456789abcdef';
    expect(redactRequestUrl(`/api/pay/${hex64}`)).toBe('/api/pay/[REDACTED]');
    expect(redactRequestUrl(`/api/reports/${hex32}/events`)).toBe('/api/reports/[REDACTED]/events');
    expect(redactRequestUrl(`/api/receipt/${hex64}/pdf?download=1`)).toBe('/api/receipt/[REDACTED]/pdf?download=1');
    expect(redactRequestUrl('/api/booking/status/WPC-ABCDEFGH23')).toBe('/api/booking/status/[REDACTED]');
    expect(redactRequestUrl('/estimate/eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.sig')).toBe('/estimate/[REDACTED]');
  });

  test('redacts base64url bearer tokens (contract + service-outline, 43-char)', () => {
    // crypto.randomBytes(32).toString('base64url') → 43 chars [A-Za-z0-9_-]
    const b64url = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MFFXRVJUWVVJT1A_-x';
    expect(redactRequestUrl(`/api/contracts/${b64url}`)).toBe('/api/contracts/[REDACTED]');
    expect(redactRequestUrl(`/api/service-outlines/${b64url}/cta-click`)).toBe('/api/service-outlines/[REDACTED]/cta-click');
  });

  test('keeps non-credential path segments (row-id UUIDs, invoice numbers, short ids)', () => {
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    expect(redactRequestUrl(`/api/admin/customers/${uuid}`)).toBe(`/api/admin/customers/${uuid}`);
    expect(redactRequestUrl('/api/admin/invoices/WPC-2026-0001')).toBe('/api/admin/invoices/WPC-2026-0001');
    expect(redactRequestUrl('/api/admin/call-recordings/audio/RE123')).toBe('/api/admin/call-recordings/audio/RE123');
    // …but a UUID directly after a newsletter bearer prefix IS the credential.
    expect(redactRequestUrl(`/api/public/newsletter/unsubscribe/${uuid}`)).toBe('/api/public/newsletter/unsubscribe/[REDACTED]');
  });
});
