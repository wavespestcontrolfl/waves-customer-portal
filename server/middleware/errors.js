const logger = require('../services/logger');

// Keys whose values are PII/secrets and must never land in error logs raw
// (req.body is logged on every unhandled error). Substring match, biased to
// redact: `name` catches first_name/last_name, `address` catches
// address_line1/2, `code` catches gate_code/confirmation_code, `token`
// catches capture/estimate/share tokens. (The content pii-redactor in
// services/content is a free-TEXT scrubber for publishing surfaces — this is
// the structured, key-based counterpart for log payloads.)
const SENSITIVE_BODY_KEY_RE = /phone|e-?mail|address|name|card|token|password|passwd|pwd|secret|code|ssn/i;
const REDACTED = '[REDACTED]';

// Recursively mask sensitive values in a request body while preserving its
// shape: every key survives, only matched values are replaced — so the log
// still shows WHAT was posted without leaking the contents. Depth-capped and
// cycle-safe (a crafted body must not be able to crash the error handler).
function redactSensitiveBody(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return value;
  if (depth > 8) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactSensitiveBody(v, depth + 1, seen));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE_BODY_KEY_RE.test(key)
      ? (val == null ? val : REDACTED)
      : redactSensitiveBody(val, depth + 1, seen);
  }
  return out;
}

function errorHandler(err, req, res, next) {
  logger.error(`${req.method} ${req.path}: ${err.message}`, {
    stack: err.stack,
    body: redactSensitiveBody(req.body),
  });

  // Known operational errors
  if (err.isOperational) {
    return res.status(err.statusCode || 400).json({
      error: err.message,
      code: err.code,
    });
  }

  // Joi validation errors
  if (err.isJoi) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.details.map(d => d.message),
    });
  }

  // Default server error
  res.status(500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
}

function notFound(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
}

module.exports = { errorHandler, notFound, redactSensitiveBody };
