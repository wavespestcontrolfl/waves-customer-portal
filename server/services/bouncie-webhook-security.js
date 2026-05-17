const crypto = require('crypto');

const SECRET_KEYS = new Set([
  'Authorization',
  'authorization',
  'X-Bouncie-Authorization',
  'x-bouncie-authorization',
  'x_bouncie_authorization',
  'webhookKey',
  'webhook_key',
  'x-webhook-key',
  'x_webhook_key',
  'x-bouncie-webhook-key',
  'x_bouncie_webhook_key',
  'bouncieWebhookKey',
]);

function cleanSecretValue(value) {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function timingSafeEqualString(a, b) {
  const leftValue = cleanSecretValue(a);
  const rightValue = cleanSecretValue(b);
  if (!leftValue || !rightValue) return false;
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function headerAuthCandidates(label, value) {
  const cleaned = cleanSecretValue(value);
  if (!cleaned) return [];
  const candidates = [[label, cleaned]];
  const bearer = cleaned.match(/^Bearer\s+(.+)$/i);
  if (bearer?.[1]) candidates.push([`${label}:bearer`, bearer[1].trim()]);
  return candidates;
}

function verificationMode(env = process.env) {
  const explicit = String(env.BOUNCIE_WEBHOOK_VERIFICATION || '').trim().toLowerCase();
  if (['enforce', 'log', 'disabled'].includes(explicit)) return explicit;
  if (env.BOUNCIE_WEBHOOK_STRICT === 'false') return 'log';
  if (env.BOUNCIE_WEBHOOK_STRICT === 'true') return 'enforce';
  return 'enforce';
}

function inspectBouncieWebhook(req, env = process.env) {
  const expected = cleanSecretValue(env.BOUNCIE_WEBHOOK_SECRET);
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
    ...headerAuthCandidates('header:authorization', req.get?.('authorization')),
    ['header:x-bouncie-authorization', req.get?.('x-bouncie-authorization')],
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
