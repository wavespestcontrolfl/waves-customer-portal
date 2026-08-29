/**
 * Legacy Hermes worker-auth helpers.
 *
 * The hermesAuth middleware itself was replaced by
 * middleware/link-worker-auth.js (per-provider HMAC request signing with a
 * bounded bearer transition — docs/design/backlink-manager-plan.md §12/§1);
 * the bearer semantics live on inside that module until the §14 step-1b
 * retirement. This file keeps only the constant-time comparator, which other
 * machine-auth routes (mcp.js) still use.
 */
const crypto = require('crypto');

function safeEqual(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = { safeEqual };
