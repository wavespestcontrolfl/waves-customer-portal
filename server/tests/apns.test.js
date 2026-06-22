const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { signProviderToken, buildApnsPayload, classifyApnsResponse } = require('../services/apns');

describe('apns provider token', () => {
  // Real ES256 keypair so we can verify the signature the way Apple would.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

  test('signs an ES256 JWT with kid header and team iss/iat', () => {
    const iat = 1700000000;
    const token = signProviderToken({ signingKey: privPem, keyId: 'ABC1234567', teamId: 'TEAM123456', iat });

    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64').toString('utf8'));
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe('ABC1234567');

    const decoded = jwt.verify(token, pubPem, { algorithms: ['ES256'] });
    expect(decoded.iss).toBe('TEAM123456');
    expect(decoded.iat).toBe(iat);
  });
});

describe('buildApnsPayload', () => {
  test('maps title/body/url/badge into aps + top-level data', () => {
    const p = buildApnsPayload({ title: 'Visit complete', body: 'Your report is ready', url: '/reports/123', badge: 2 });
    expect(p.aps.alert).toEqual({ title: 'Visit complete', body: 'Your report is ready' });
    expect(p.aps.sound).toBe('default');
    expect(p.aps.badge).toBe(2);
    expect(p.url).toBe('/reports/123');
  });

  test('defaults the title, omits url + badge when absent', () => {
    const p = buildApnsPayload({ body: 'hi' });
    expect(p.aps.alert.title).toBe('Waves Pest Control');
    expect(p.url).toBeUndefined();
    expect(p.aps.badge).toBeUndefined();
  });

  test('passes through extra data keys but never a caller-supplied aps', () => {
    const p = buildApnsPayload({ body: 'x', serviceId: 'abc', aps: { hacked: true } });
    expect(p.serviceId).toBe('abc');
    expect(p.aps.hacked).toBeUndefined();
  });
});

describe('classifyApnsResponse', () => {
  test('200 → ok', () => {
    expect(classifyApnsResponse(200, null)).toEqual({ ok: true });
  });
  test('410 Unregistered → expired (deactivate)', () => {
    const r = classifyApnsResponse(410, 'Unregistered');
    expect(r.ok).toBe(false);
    expect(r.expired).toBe(true);
  });
  test('400 BadDeviceToken → expired', () => {
    expect(classifyApnsResponse(400, 'BadDeviceToken').expired).toBe(true);
  });
  test('transient server error → failed, not expired', () => {
    const r = classifyApnsResponse(503, 'ServiceUnavailable');
    expect(r.ok).toBe(false);
    expect(r.expired).toBe(false);
    expect(r.reason).toBe('ServiceUnavailable');
  });
});
