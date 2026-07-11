const crypto = require('crypto');
const logger = require('../services/logger');

// req.body is logged on every unhandled error, and a key-based denylist kept
// leaking PII through keys it didn't anticipate — admin SMS payloads
// ({ to, body, fromNumber, message }) reach this handler via next(err) and
// would log the recipient phone and the full SMS body raw (AGENTS.md non-card
// PII rule). So instead of guessing which keys are sensitive, keep only the
// body's SHAPE: every string/number value is replaced by a type:length marker
// (e.g. '[string:34]') — no free text or number can leak through ANY key,
// while the log still shows what was posted and roughly how big. Booleans and
// null/undefined carry no PII and pass through as debugging signal.
// Depth-capped and cycle-safe (a crafted body must not be able to crash the
// error handler). (The content pii-redactor in services/content is a
// free-TEXT scrubber for publishing surfaces — this is the structured,
// shape-only counterpart for log payloads.)
//
// KEYS are content too: a payload like { "jane@example.com": true } would put
// an email in the logs even with every value masked. So a key only passes
// through verbatim when it is a known structural field name (ids, enum
// discriminators, dates/times, pagination, the booking-flow containers —
// nothing a route treats as free text). Every other key is replaced by a
// '[key:string:<len>:<hash8>]' marker: the length keeps the shape readable
// and the short one-way sha256 prefix keeps repeated shapes correlatable
// across log lines (and distinct keys from colliding) without exposing the
// key text itself.
const SAFE_LOG_KEYS = new Set([
  // ids / references
  'id', 'ids', 'uuid',
  'estimate_id', 'estimateid', 'customer_id', 'customerid',
  'invoice_id', 'invoiceid', 'service_id', 'serviceid',
  'slot_id', 'slotid', 'session_id', 'sessionid',
  'booking_id', 'bookingid', 'visit_id', 'visitid',
  'pricing_estimate_id',
  // enum discriminators
  'type', 'service_type', 'servicetype', 'status', 'state',
  'action', 'mode', 'source', 'kind', 'code', 'version',
  // dates / times / scheduling
  'date', 'dates', 'time', 'start', 'end',
  'start_date', 'startdate', 'end_date', 'enddate',
  'scheduled_for', 'scheduledfor', 'duration_minutes', 'durationminutes',
  'capture_client_ts',
  // pagination / quantities
  'page', 'limit', 'offset', 'count', 'qty', 'quantity', 'amount', 'total',
  // structural containers the booking/confirm flow posts
  'new_customer', 'newcustomer', 'items',
  'selected_frequency', 'selectedfrequency',
  'payment_preference', 'paymentpreference',
]);

function redactKey(key) {
  const name = String(key);
  if (SAFE_LOG_KEYS.has(name.toLowerCase())) return name;
  const hash = crypto.createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `[key:string:${name.length}:${hash}]`;
}

function redactSensitiveBody(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return value;
  const type = typeof value;
  if (type === 'boolean') return value;
  if (type === 'string' || type === 'number' || type === 'bigint') {
    return `[${type}:${String(value).length}]`;
  }
  if (type !== 'object') return `[${type}]`;
  if (depth > 8) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactSensitiveBody(v, depth + 1, seen));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[redactKey(key)] = redactSensitiveBody(val, depth + 1, seen);
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
