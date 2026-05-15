const {
  inspectBouncieWebhook,
  redactBouncieWebhookPayload,
  stringifyBounciePayload,
  timingSafeEqualString,
  verificationMode,
} = require('../services/bouncie-webhook-security');

function reqWith({ headers = {}, body = {} } = {}) {
  return {
    body,
    get(name) {
      return headers[String(name).toLowerCase()];
    },
  };
}

describe('bouncie webhook security helpers', () => {
  test('defaults to enforce mode', () => {
    expect(verificationMode({})).toBe('enforce');
    expect(verificationMode({ BOUNCIE_WEBHOOK_STRICT: 'true' })).toBe('enforce');
    expect(verificationMode({ BOUNCIE_WEBHOOK_STRICT: 'false' })).toBe('log');
    expect(verificationMode({ BOUNCIE_WEBHOOK_VERIFICATION: 'disabled' })).toBe('disabled');
  });

  test('rejects missing secret in enforce mode', () => {
    const result = inspectBouncieWebhook(reqWith(), {});
    expect(result).toMatchObject({
      accepted: false,
      matched: false,
      mode: 'enforce',
      reason: 'no-secret-configured',
    });
  });

  test('accepts Bouncie official authorization headers', () => {
    const result = inspectBouncieWebhook(
      reqWith({ headers: { authorization: 'secret' } }),
      { BOUNCIE_WEBHOOK_SECRET: 'secret' }
    );
    expect(result).toMatchObject({
      accepted: true,
      matched: true,
      from: 'header:authorization',
    });

    const fallback = inspectBouncieWebhook(
      reqWith({ headers: { 'x-bouncie-authorization': 'secret' } }),
      { BOUNCIE_WEBHOOK_SECRET: 'secret' }
    );
    expect(fallback).toMatchObject({
      accepted: true,
      matched: true,
      from: 'header:x-bouncie-authorization',
    });
  });

  test('keeps legacy rollout header support', () => {
    const result = inspectBouncieWebhook(
      reqWith({ headers: { 'x-webhook-key': 'secret' } }),
      { BOUNCIE_WEBHOOK_SECRET: 'secret' }
    );
    expect(result).toMatchObject({
      accepted: true,
      matched: true,
      from: 'header:x-webhook-key',
    });
  });

  test('supports log mode without accepting the secret as matched', () => {
    const result = inspectBouncieWebhook(
      reqWith({ headers: { 'x-webhook-key': 'wrong' } }),
      { BOUNCIE_WEBHOOK_SECRET: 'secret', BOUNCIE_WEBHOOK_VERIFICATION: 'log' }
    );
    expect(result).toMatchObject({
      accepted: true,
      matched: false,
      mode: 'log',
      reason: 'mismatch',
    });
  });

  test('uses constant-time comparison for equal-length strings', () => {
    expect(timingSafeEqualString('secret', 'secret')).toBe(true);
    expect(timingSafeEqualString('secret', 'secrex')).toBe(false);
    expect(timingSafeEqualString('secret', 'short')).toBe(false);
  });

  test('redacts webhook secrets before persistence', () => {
    const payload = {
      eventType: 'trip-data',
      Authorization: 'official-secret',
      webhookKey: 'body-secret',
      nested: {
        'X-Bouncie-Authorization': 'official-nested-secret',
        webhook_key: 'nested-secret',
        keep: 'value',
      },
      data: [{ x_bouncie_webhook_key: 'array-secret', lat: 27.1 }],
    };
    expect(redactBouncieWebhookPayload(payload)).toEqual({
      eventType: 'trip-data',
      Authorization: '[redacted]',
      webhookKey: '[redacted]',
      nested: {
        'X-Bouncie-Authorization': '[redacted]',
        webhook_key: '[redacted]',
        keep: 'value',
      },
      data: [{ x_bouncie_webhook_key: '[redacted]', lat: 27.1 }],
    });
    expect(stringifyBounciePayload(payload)).not.toContain('body-secret');
    expect(stringifyBounciePayload(payload)).not.toContain('official-secret');
    expect(stringifyBounciePayload(payload)).not.toContain('official-nested-secret');
    expect(stringifyBounciePayload(payload)).not.toContain('nested-secret');
    expect(stringifyBounciePayload(payload)).not.toContain('array-secret');
  });
});
