const { buildFcmMessage, classifyFcmResponse } = require('../services/fcm');

describe('buildFcmMessage', () => {
  test('maps title/body into notification and extra keys into string data', () => {
    const m = buildFcmMessage('tok123', {
      title: 'Visit complete', body: 'Your report is ready', url: '/reports/123', badge: 2,
    });
    expect(m.message.token).toBe('tok123');
    expect(m.message.notification).toEqual({ title: 'Visit complete', body: 'Your report is ready' });
    // FCM data values must be strings
    expect(m.message.data.url).toBe('/reports/123');
    expect(m.message.data.badge).toBe('2');
    expect(m.message.android.priority).toBe('high');
    expect(m.message.android.notification.sound).toBe('default');
  });

  test('defaults the title and never leaks title/body into data', () => {
    const m = buildFcmMessage('t', { body: 'hi', foo: 'bar' });
    expect(m.message.notification.title).toBe('Waves');
    expect(m.message.data.title).toBeUndefined();
    expect(m.message.data.body).toBeUndefined();
    expect(m.message.data.foo).toBe('bar');
  });

  test('skips null/undefined data values but keeps falsy strings/zero', () => {
    const m = buildFcmMessage('t', { title: 'T', body: 'B', a: null, b: undefined, c: 0 });
    expect('a' in m.message.data).toBe(false);
    expect('b' in m.message.data).toBe(false);
    expect(m.message.data.c).toBe('0');
  });
});

describe('classifyFcmResponse', () => {
  test.each([[429, 'QUOTA_EXCEEDED'], [500, 'INTERNAL'], [503, 'UNAVAILABLE']])('temporary %s/%s is retryable', (status, reason) => {
    expect(classifyFcmResponse(status, reason)).toMatchObject({ ok: false, expired: false, retryable: true, retryAfterMs: 60000 });
  });
  test('honors Retry-After seconds and dates, with a one-minute floor for absent or invalid hints', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-09T16:00:00Z'));
    try {
      expect(classifyFcmResponse(503, 'UNAVAILABLE', '300').retryAfterMs).toBe(300000);
      expect(classifyFcmResponse(503, 'UNAVAILABLE', 'Wed, 09 Sep 2026 16:05:00 GMT').retryAfterMs).toBe(300000);
      for (const value of [undefined, 'invalid', '0', '10', 'Wed, 09 Sep 2026 15:00:00 GMT']) {
        expect(classifyFcmResponse(429, 'QUOTA_EXCEEDED', value).retryAfterMs).toBe(60000);
      }
    } finally { now.mockRestore(); }
  });
  test.each([[400, 'INVALID_ARGUMENT'], [401, 'UNAUTHENTICATED'], [403, 'SENDER_ID_MISMATCH'],
    [404, 'NOT_FOUND'], [404, 'UNREGISTERED']])('permanent %s/%s is not retried', (status, reason) => {
    expect(classifyFcmResponse(status, reason).retryable).not.toBe(true);
  });
  test('2xx is ok', () => {
    expect(classifyFcmResponse(200).ok).toBe(true);
  });

  test('only the UNREGISTERED detail expires a token (deactivate)', () => {
    expect(classifyFcmResponse(404, 'UNREGISTERED').expired).toBe(true);
    expect(classifyFcmResponse(400, 'UNREGISTERED').expired).toBe(true);
  });

  test('a bare 404 / NOT_FOUND is NOT expiry (could be a project/path misconfig)', () => {
    // FCM returns 404 for both an unregistered token (with UNREGISTERED detail) AND
    // a misconfigured project_id/path — only the former should deactivate the row.
    expect(classifyFcmResponse(404, 'NOT_FOUND').expired).toBe(false);
    expect(classifyFcmResponse(404, null).expired).toBe(false);
  });

  test('auth / quota / payload / server errors are NOT expired (fail soft)', () => {
    // One misconfig (bad service account, wrong project) must never wipe all tokens.
    expect(classifyFcmResponse(401, 'UNAUTHENTICATED').expired).toBe(false);
    expect(classifyFcmResponse(403, 'PERMISSION_DENIED').expired).toBe(false);
    expect(classifyFcmResponse(400, 'INVALID_ARGUMENT').expired).toBe(false);
    expect(classifyFcmResponse(429, 'QUOTA_EXCEEDED').expired).toBe(false);
    expect(classifyFcmResponse(500, 'INTERNAL').expired).toBe(false);
  });
});

describe('buildFcmMessage — tag', () => {
  test('a push tag becomes android.notification.tag (same-tag redelivery replaces the banner)', () => {
    const m = buildFcmMessage('t', { title: 'T', body: 'B', tag: 'waves-customer_email_received-e1' });
    expect(m.message.android.notification.tag).toBe('waves-customer_email_received-e1');
    expect(m.message.android.notification.sound).toBe('default');
  });
  test('no tag = no android tag', () => {
    const m = buildFcmMessage('t', { title: 'T', body: 'B' });
    expect(m.message.android.notification.tag).toBeUndefined();
  });
});


test('perishable advisories cannot queue for an offline Android device', () => {
  expect(buildFcmMessage('synthetic-device', { title: 'Plan', ephemeral: true }).message.android.ttl).toBe('0s');
  expect(buildFcmMessage('synthetic-device', { title: 'Appointment' }).message.android).not.toHaveProperty('ttl');
});
