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
