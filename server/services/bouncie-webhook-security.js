const crypto = require('crypto');

const SECRET_KEYS = new Set([
  'webhookKey',
  'webhook_key',
  'x-webhook-key',
  'x_bouncie_webhook_key',
  'bouncieWebhookKey',
]);

function timingSafeEqualString(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function verificationMode(env = process.env) {
  const explicit = String(env.BOUNCIE_WEBHOOK_VERIFICATION || '').trim().toLowerCase();
  if (['enforce', 'log', 'disabled'].includes(explicit)) return explicit;
  if (env.BOUNCIE_WEBHOOK_STRICT === 'false') return 'log';
  if (env.BOUNCIE_WEBHOOK_STRICT === 'true') return 'enforce';
  return 'enforce';
}

function inspectBouncieWebhook(req, env = process.env) {
  const expected = env.BOUNCIE_WEBHOOK_SECRET;
  const mode = verificationMode(env);
  if (!expected) {
    return {
      accepted: mode !== 'enforce',
      matched: false,
      mode,
      from: null,
      reason: 'no-secret-configured',
    };
  }

  const candidates = [
    ['header:x-webhook-key', req.get?.('x-webhook-key')],
    ['header:x-bouncie-webhook-key', req.get?.('x-bouncie-webhook-key')],
    ['body:webhookKey', req.body?.webhookKey],
    ['body:webhook_key', req.body?.webhook_key],
  ];
  const match = candidates.find(([, value]) => timingSafeEqualString(value, expected));
  if (match) {
    return {
      accepted: true,
      matched: true,
      mode,
      from: match[0],
      reason: null,
    };
  }
  return {
    accepted: mode !== 'enforce',
    matched: false,
    mode,
    from: null,
    reason: 'mismatch',
  };
}

function redactBouncieWebhookPayload(value) {
  if (Array.isArray(value)) return value.map(redactBouncieWebhookPayload);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = SECRET_KEYS.has(key) ? '[redacted]' : redactBouncieWebhookPayload(entry);
  }
  return out;
}

function stringifyBounciePayload(payload) {
  return JSON.stringify(redactBouncieWebhookPayload(payload || {}));
}

module.exports = {
  inspectBouncieWebhook,
  redactBouncieWebhookPayload,
  stringifyBounciePayload,
  timingSafeEqualString,
  verificationMode,
};
